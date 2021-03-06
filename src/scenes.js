"use strict";

/**
 * Scene internal API.
 * @name scenes
 * @namespace
 * @exports exports as scenes
 */
b4w.module["__scenes"] = function(exports, require) {

var m_batch      = require("__batch");
var m_bounds     = require("__boundings");
var m_cam        = require("__camera");
var m_cfg        = require("__config");
var m_dbg        = require("__debug");
var m_geom       = require("__geometry");
var m_graph      = require("__graph");
var m_hud        = require("__hud");
var m_particles  = require("__particles");
var m_prerender  = require("__prerender");
var m_primitives = require("__primitives");
var m_print      = require("__print");
var m_render     = require("__renderer");
var m_scgraph    = require("__scenegraph");
var m_sfx        = require("__sfx");
var m_shaders    = require("__shaders");
var m_tex        = require("__textures");
var m_util       = require("__util");

var m_vec3 = require("vec3");

var cfg_def = m_cfg.defaults;
var cfg_scs = m_cfg.scenes;

/* subscene types for different aspects of processing */

var VALID_OBJ_TYPES = ["ARMATURE", "CAMERA", "CURVE", "EMPTY", "LAMP", "MESH", "SPEAKER"];

// add objects
var OBJECT_SUBSCENE_TYPES = ["GRASS_MAP", "SHADOW_CAST", "MAIN_OPAQUE", "MAIN_BLEND",
    "MAIN_REFLECT", "COLOR_PICKING", "DEPTH", "GLOW_MASK", "WIREFRAME"];
// need light update
var LIGHT_SUBSCENE_TYPES = ["MAIN_OPAQUE", "MAIN_BLEND", "MAIN_REFLECT", "GOD_RAYS",
                            "SKY", "LUMINANCE_TRUNCED"];
var FOG_SUBSCENE_TYPES = ["MAIN_OPAQUE", "SSAO", "MAIN_BLEND", "MAIN_REFLECT"];
// need time update
var TIME_SUBSCENE_TYPES = ["SHADOW_CAST", "MAIN_OPAQUE", "MAIN_BLEND",
    "MAIN_REFLECT", "COLOR_PICKING", "DEPTH", "GOD_RAYS", "GLOW_MASK", "WIREFRAME"];

// need camera water distance update
var MAIN_SUBSCENE_TYPES = ["MAIN_OPAQUE", "MAIN_BLEND", "MAIN_REFLECT"];

var SHORE_DIST_COMPAT = 100;

var MAX_BATCH_TEXTURES = 8;

var _active_scene = null;
var _scenes = [];
var _glow_anim_objs = [];
var _tex_glow_input = null;

var _canvas_width;
var _canvas_height;

var MAX_SHADER_VARYING_COUNT = 10;

var GRASS_MAP_MARGIN = 1E-4;

var _vec2_tmp = new Float32Array(2);
var _vec3_tmp = new Float32Array(3);
var _vec4_tmp = new Float32Array(4);
var _vec4_tmp2 = new Float32Array(4);
var _quat4_tmp = new Float32Array(4);
var _frustum_corners_tmp = new Float32Array(24);

var _bb_tmp = m_bounds.zero_bounding_box();
var _bb_tmp2 = m_bounds.zero_bounding_box();
var _bb_tmp3 = m_bounds.zero_bounding_box();

/**
 * Set given scene as active
 */
exports.set_active = function(scene) {
    _active_scene = scene;
    m_sfx.set_active_scene(scene);
}

/**
 * Prepare given scene for rendering.
 * Executed after all objects added to scene.
 */
exports.prepare_rendering = function(scene) {

    if (!scene._render_to_texture) {
        var render = scene._render;

        var queue = m_scgraph.create_rendering_queue(render.graph);
        // attach to existing (may already containt RTT queue)
        for (var i = 0; i < queue.length; i++)
            render.queue.push(queue[i]);

        setup_scene_dim(scene, _canvas_width,
                               _canvas_height, false);
    }

    var wind = m_particles.wind();
    var subs_arr = subs_array(scene, TIME_SUBSCENE_TYPES);
    for (i = 0; i < subs_arr.length; i++) {
        var subs = subs_arr[i];
        subs.wind = wind;
    }
}


exports.get_active = get_active;
/**
 * @methodOf scenes
 */
function get_active() {
    if (!_active_scene)
        throw("no active scene");
    return _active_scene;
}

exports.check_active = check_active;
function check_active() {
    if (_active_scene)
        return true;
    else
        return false;
}

exports.get_all_scenes = function() {
    return _scenes;
}

exports.append_scene = append_scene;
/**
 * Update scene._render
 * prepare camera before execution
 * @methodOf scenes
 */ 
function append_scene(bpy_scene) {

    bpy_scene._objects = {"ALL" : []};
    bpy_scene._appended_objects = {"ALL" : []};

    for (var i in VALID_OBJ_TYPES) {
        var type = VALID_OBJ_TYPES[i];
        var objs = combine_scene_objects(bpy_scene, type);

        bpy_scene._objects[type] = objs;

        for (var j = 0; j < objs.length; j++)
            bpy_scene._objects["ALL"].push(objs[j]);

        bpy_scene._appended_objects[type] = [];
    }

    bpy_scene._render = bpy_scene._render || {};
    var render = bpy_scene._render;
    var cam_render = bpy_scene["camera"]._render;

    var shs  = bpy_scene["world"]["b4w_shadow_settings"];
    var rshs = render.shadow_params = {};

    rshs.csm_near                  = shs["csm_near"];
    rshs.csm_far                   = shs["csm_far"];
    rshs.csm_num                   = shs["csm_num"];
    rshs.csm_lambda                = shs["csm_lambda"];
    rshs.blur_depth_size_mult      = shs["blur_depth_size_mult"];
    rshs.blur_depth_edge_size      = shs["blur_depth_edge_size"];
    rshs.blur_depth_diff_threshold = shs["blur_depth_diff_threshold"] / 1000;
    rshs.visibility_falloff        = shs["visibility_falloff"];

    var fog_color = bpy_scene["world"]["b4w_fog_color"];
    var fog_dens  = bpy_scene["world"]["b4w_fog_density"];

    render.fog_color_density = new Float32Array([fog_color[0],
                                                 fog_color[1],
                                                 fog_color[2],
                                                 fog_dens]);

    if (!cfg_def.deferred_rendering) {
        render.sky_params        = extract_sky_params(bpy_scene);
        render.world_light_set   = get_world_light_set(bpy_scene);
        render.ssao_params       = extract_ssao_params(bpy_scene);
        render.lamps_number      = get_scene_objs(bpy_scene, "LAMP").length;
        render.procedural_sky    = check_procedural_sky(bpy_scene);
        render.water_params      = get_water_params(bpy_scene);
        render.dynamic_grass     = false;
        render.selectability     = check_selectable_objects(bpy_scene);
        render.graph = m_scgraph.create_rendering_graph_compat(cam_render, render);
    } else {
        var rtt = bpy_scene._render_to_texture;

        render.render_shadows  = check_render_shadows(bpy_scene);
        render.fog_color       = bpy_scene["world"]["b4w_fog_color"];
        render.shore_smoothing = check_shore_smoothing(bpy_scene);
        render.refl_planes     = check_render_reflections(bpy_scene);
        render.water_params    = get_water_params(bpy_scene);
        render.procedural_sky  = check_procedural_sky(bpy_scene);
        render.sky_params      = extract_sky_params(bpy_scene);
        render.ssao_params     = extract_ssao_params(bpy_scene);
        render.bloom_params    = extract_bloom_params(bpy_scene);
        render.mb_params       = extract_mb_params(bpy_scene);
        render.cc_params       = extract_cc_params(bpy_scene);
        render.god_rays_params = extract_god_rays_params(bpy_scene);
        render.glow_params     = extract_glow_params(bpy_scene);
        render.world_light_set = get_world_light_set(bpy_scene);    
        render.dynamic_grass   = check_dynamic_grass(bpy_scene);
        render.motion_blur     = (cfg_def.motion_blur && bpy_scene["b4w_enable_motion_blur"]);
        render.compositing     = (cfg_def.compositing && bpy_scene["b4w_enable_color_correction"]);
        render.antialiasing    = (cfg_def.antialiasing && bpy_scene["b4w_enable_antialiasing"]);
        render.lamps_number    = get_scene_objs(bpy_scene, "LAMP").length;    
        render.bloom           = (cfg_def.bloom && bpy_scene["b4w_enable_bloom"]);
        render.ssao            = (cfg_def.ssao && bpy_scene["b4w_enable_ssao"]);
        render.god_rays        = (cfg_def.god_rays && bpy_scene["b4w_enable_god_rays"]);
        render.refractions     = (cfg_def.refractions && bpy_scene["b4w_render_refractions"]);
        render.selectability   = check_selectable_objects(bpy_scene);

        render.graph = m_scgraph.create_rendering_graph(rtt, render, cam_render);
    }
    render.queue = [];

    render.need_shadow_update = false;
    render.need_grass_map_update = false;

    _scenes.push(bpy_scene);
}

exports.combine_scene_objects = combine_scene_objects;
/**
 * Combine all bpy objects from the scene.
 */
function combine_scene_objects(scene, type) {
    if (!type)
        type = "ALL";

    var scene_objs_arr = [];
    combine_scene_objects_iter(scene["objects"], type, scene_objs_arr);
    return scene_objs_arr;
}

function combine_scene_objects_iter(objects, type, dest) {
    // search in dupli groups
    for (var i = 0; i < objects.length; i++) {
        var obj = objects[i];

        if (type == "ALL" || type == obj["type"])
            dest.push(obj);
    
        var dupli_group = obj["dupli_group"];
        if (dupli_group) {
            var dg_objects = dupli_group["objects"];
            combine_scene_objects_iter(dg_objects, type, dest);
        }
    }
}

function check_render_shadows(bpy_scene) {
    if (cfg_def.shadows == "NONE" || !bpy_scene["b4w_render_shadows"])
        return false;

    var has_casters = false;
    var has_receivers = false;

    var objects = get_scene_objs(bpy_scene, "MESH");
    for (var i = 0; i < objects.length; i++) {
        var obj = objects[i];

        if (obj["b4w_shadow_cast"])
            has_casters = true;

        if (obj["b4w_shadow_receive"])
            has_receivers = true;

        if (has_casters && has_receivers)
            return true;
    }

    // no casters, no receivers
    return false;
}

/**
 * Check if shore smoothing required for given scene.
 * Shore smoothing required if we have shore smoothing flag 
 * enabled for water materials
 */
function check_shore_smoothing(bpy_scene) {

    if (!cfg_def.shore_smoothing)
        return false;

    var mats = get_scene_materials(bpy_scene);

    for (var i = 0; i < mats.length; i++) {
        var mat = mats[i];

        if (mat["b4w_water"] && mat["b4w_water_shore_smoothing"])
            return true;
    }

    return false;
}

/**
 * Check water parameters on a given scene 
 */
function get_water_params(bpy_scene) {

    var mats = get_scene_materials(bpy_scene);
    var water_params = [];
    var objects = get_scene_objs(bpy_scene, "MESH");

    for (var i = 0; i < mats.length; i++) {
        var mat = mats[i];

        if (mat["b4w_water"]) {

            var wp = {};
            // set water level as obect's first vertex y coord
            for (var j = 0; j < objects.length; j++) {
                var obj = objects[j];
                var mesh = obj["data"];
                var mesh_mats = mesh["materials"];
                for (var k = 0; k < mesh_mats.length; k++) {
                    var mesh_mat = mesh_mats[k];
                    if (mesh_mat == mat) {
                        var first_vert_y_pos = mesh["submeshes"][0]["position"][1];
                        wp.water_level = obj["location"][1] + first_vert_y_pos;
                    }
                }
            }

            if (!cfg_def.deferred_rendering) {
                // set "heavy" params to 0 for compatibility mode
                wp.waves_height        = 0.0;
                wp.waves_length        = 0.0;
                wp.caustic_scale       = null;
                wp.caustic_brightness  = null;
                wp.caustic_speed       = null;
                wp.fog_color_density   = null;
                wp.dynamic             = false;
                water_params.push(wp);
                continue;
            }

            // fog stuff
            wp.fog_color_density = mat["b4w_water_fog_color"].slice(0);
            wp.fog_color_density.push( mat["b4w_water_fog_density"] );


            // dynamics stuff
            if (mat["b4w_water_dynamic"]) {
                wp.dynamic           = true;
                wp.waves_height      = mat["b4w_waves_height"];
                wp.waves_length      = mat["b4w_waves_length"];
                wp.dst_noise_scale0  = mat["b4w_water_dst_noise_scale0"];
                wp.dst_noise_scale1  = mat["b4w_water_dst_noise_scale1"];
                wp.dst_noise_freq0   = mat["b4w_water_dst_noise_freq0"];
                wp.dst_noise_freq1   = mat["b4w_water_dst_noise_freq1"];
                wp.dir_min_shore_fac = mat["b4w_water_dir_min_shore_fac"];
                wp.dir_freq          = mat["b4w_water_dir_freq"];
                wp.dir_noise_scale   = mat["b4w_water_dir_noise_scale"];
                wp.dir_noise_freq    = mat["b4w_water_dir_noise_freq"];
                wp.dir_min_noise_fac = mat["b4w_water_dir_min_noise_fac"];
                wp.dst_min_fac       = mat["b4w_water_dst_min_fac"];
                wp.waves_hor_fac     = mat["b4w_water_waves_hor_fac"];
            } else {
                wp.dynamic      = false;
                wp.waves_height = 0.0;
                wp.waves_length = 0.0;
            }

            wp.caustic_scale       = null;
            wp.caustic_brightness  = null;
            wp.caustic_speed       = new Float32Array(2);

            wp.shoremap_image  = null;

            var texture_slots = mat["texture_slots"];

            for (var j = 0; j < texture_slots.length; j++) {
                var texture = texture_slots[j]["texture"];
                if (texture["type"] == "VORONOI") {
                    // caustics stuff
                    wp.caustic_scale      = texture["noise_scale"];
                    wp.caustic_speed      = texture["b4w_uv_velocity_trans"];
                    wp.caustic_brightness = texture["noise_intensity"];
                }
                if (texture["b4w_shore_dist_map"] === true) {
                    // shoremap
                    wp.shoremap_image    = texture["image"];
                    wp.shoremap_tex_size = texture["image"]["size"][0];
                    wp.shore_boundings   = texture["b4w_shore_boundings"];
                    wp.max_shore_dist    = texture["b4w_max_shore_dist"];
                }
            }

            water_params.push(wp);
        }
    }

    if (water_params.length > 0) {
        var wp = water_params[0];
        if (!wp.dynamic)
            // set water params from water with "dynamic" property
            for (var i = 0; i < water_params.length; i++)
                if (water_params[i].dynamic)
                    wp = water_params[i];

        return wp;
    } else
        return null;
}

/**
 * Check if reflections are required for given scene.
 * Returns an array of reflection planes on a scene. 
 */
function check_render_reflections(bpy_scene) {

    if (!cfg_def.reflections || !bpy_scene["b4w_render_reflections"])
        return false;

    var reflective_planes = [];

    var objects = get_scene_objs(bpy_scene, "MESH");
    for (var i = 0; i < objects.length; i++) {
        var obj = objects[i];

        if (obj["b4w_reflective"]) {
            var refl_plane_obj = get_reflection_plane(obj);
            if (!refl_plane_obj)
                continue;

            // reflection plane is located after LODs constraints
            var trans = refl_plane_obj["location"];
            var quat  = refl_plane_obj._render.quat;

            var refl_plane = new Float32Array(4);
            m_util.trans_quat_to_plane(trans, quat, m_util.AXIS_Y, refl_plane);

            reflective_planes.push(refl_plane);
        }
    }
    return reflective_planes;
}

function get_reflection_plane(bpy_obj) {
    var constraints = bpy_obj["constraints"];
    var lods_num = bpy_obj["b4w_lods_num"];
    var num = 0;

    for (var i = 0; i < constraints.length; i++) {
        var cons = constraints[i];
        if (cons["type"] == "LOCKED_TRACK") {
            if (num == lods_num)
                return cons["target"];

            num++;
        }
    }

    return null;
}

/**
 * Check if there is dynamic skydome on the scene
 */
function check_procedural_sky(bpy_scene) {

    var objects = get_scene_objs(bpy_scene, "MESH");
    for (var i = 0; i < objects.length; i++) {
        var obj = objects[i];
        var materials = obj["data"]["materials"];
        for (var j = 0; j < materials.length; j++) {
            var mat = materials[j];
            if (mat["b4w_skydome"] && mat["b4w_procedural_skydome"])
                return true;
        }
    }
    return false;
}

/**
 * Check dynamic sky parameters
 */
function extract_sky_params(bpy_scene) {
    var sky_params = {};
    var world = bpy_scene["world"]; 
    var sky_settings = bpy_scene["world"]["b4w_sky_settings"];

    sky_params.sky_color                 = sky_settings["color"];
    sky_params.rayleigh_brightness       = sky_settings["rayleigh_brightness"];
    sky_params.mie_brightness            = sky_settings["mie_brightness"];
    sky_params.spot_brightness           = sky_settings["spot_brightness"];
    sky_params.scatter_strength          = sky_settings["scatter_strength"];
    sky_params.rayleigh_strength         = sky_settings["rayleigh_strength"];
    sky_params.mie_strength              = sky_settings["mie_strength"];
    sky_params.rayleigh_collection_power = sky_settings["rayleigh_collection_power"];
    sky_params.mie_collection_power      = sky_settings["mie_collection_power"];
    sky_params.mie_distribution          = sky_settings["mie_distribution"];

    return sky_params;
}

/**
 * Extract ssao parameters
 */
function extract_ssao_params(bpy_scene) {
    var ssao_params   = {};
    var ssao_settings = bpy_scene["world"]["b4w_ssao_settings"];
    
    ssao_params.radius_increase         = ssao_settings["radius_increase"];
    ssao_params.dithering_amount        = ssao_settings["dithering_amount"];
    ssao_params.gauss_center            = ssao_settings["gauss_center"];
    ssao_params.gauss_width_square      = ssao_settings["gauss_width"] * ssao_settings["gauss_width"];
    ssao_params.gauss_width_left_square = ssao_settings["gauss_width_left"] * ssao_settings["gauss_width_left"];
    ssao_params.influence               = ssao_settings["influence"];
    ssao_params.dist_factor             = ssao_settings["dist_factor"];
    ssao_params.samples                 = ssao_settings["samples"];

    return ssao_params;
}

/**
 * Extract bloom parameters
 */
function extract_bloom_params(bpy_scene) {

    var bloom_params   = {};
    var bloom_settings = bpy_scene["world"]["b4w_bloom_settings"];

    bloom_params.blur     = bloom_settings["blur"];
    bloom_params.edge_lum = bloom_settings["edge_lum"];
    bloom_params.key      = bloom_settings["key"];

    return bloom_params;
}

/**
 * Extract motion blur parameters
 */
function extract_mb_params(bpy_scene) {

    var mb_params   = {};
    var mb_settings = bpy_scene["world"]["b4w_motion_blur_settings"];

    mb_params.mb_decay_threshold = mb_settings["motion_blur_decay_threshold"];
    mb_params.mb_factor          = mb_settings["motion_blur_factor"];

    return mb_params;
}

/**
 * Extract color correction parameters
 */
function extract_cc_params(bpy_scene) {

    var cc_params   = {};
    var cc_settings = bpy_scene["world"]["b4w_color_correction_settings"];

    cc_params.brightness = cc_settings["brightness"];
    cc_params.contrast   = cc_settings["contrast"];
    cc_params.exposure   = cc_settings["exposure"];
    cc_params.saturation = cc_settings["saturation"];

    return cc_params;
}

/**
 * Extract god rays parameters
 */
function extract_god_rays_params(bpy_scene) {

    var god_rays_params   = {};
    var god_rays_settings = bpy_scene["world"]["b4w_god_rays_settings"];

    god_rays_params.intensity      = god_rays_settings["intensity"];
    god_rays_params.max_ray_length = god_rays_settings["max_ray_length"];
    god_rays_params.steps_per_pass = god_rays_settings["steps_per_pass"];

    return god_rays_params;
}

/**
 * Extract glow parameters
 */
function extract_glow_params(bpy_scene) {

    var glow_params   = {};
    var glow_settings = bpy_scene["world"];

    glow_params.glow_color  = glow_settings["b4w_glow_color"];
    glow_params.glow_factor = glow_settings["b4w_glow_factor"];

    return glow_params;
}
/**
 * Get world lights setting
 */
function get_world_light_set(bpy_scene) {

    // get some world settings
    var world = bpy_scene["world"];
    // default black values
    var hor = [0,0,0];
    var zen = [0,0,0];

    var wls = bpy_scene["world"]["light_settings"];
    
    if (wls["use_environment_light"]) {

        if (wls["environment_color"] == "SKY_COLOR") {
            // make copy of bpy arrays to prevent their overriding by scale
            hor = bpy_scene["world"]["horizon_color"].slice(0);
            zen = world["zenith_color"].slice(0);
        } else if (wls["environment_color"] == "PLAIN") {
            // white
            hor = [1, 1, 1];
            zen = [1, 1, 1];
        } else
            throw "Unsupported world environment color" + 
                    wls["environment_color"];
    }

    var wls_params = {};

    wls_params.environment_energy = wls["environment_energy"];
    wls_params.horizon_color      = hor;
    wls_params.zenith_color       = zen;  

    return wls_params;
}

/**
 * To render dynamic grass following conditions must be met:
 * enabled global setting
 * at least one terrain material
 * at least one HAIR particle system (settings) with dynamic grass enabled
 */
function check_dynamic_grass(bpy_scene) {
    if (!cfg_def.dynamic_grass)
        return false;

    var has_terrain = false;
    var has_dyn_grass = false;

    var objects = get_scene_objs(bpy_scene, "MESH");
    for (var i = 0; i < objects.length; i++) {
        var obj = objects[i];
        var materials = obj["data"]["materials"];
        for (var j = 0; j < materials.length; j++) {
            var mat = materials[j];
            if (mat["b4w_terrain"])
                has_terrain = true;
        }

        var psystems = obj["particle_systems"];
        for (var j = 0; j < psystems.length; j++) {
            var pset = psystems[j]["settings"];
            if (pset["type"] == "HAIR" && pset["b4w_dynamic_grass"])
                has_dyn_grass = true;
        }

        if (has_terrain && has_dyn_grass)
            return true;
    }

    return false;
}

function check_selectable_objects(bpy_scene) {
    var objects = get_scene_objs(bpy_scene, "MESH");
    for (var i = 0; i < objects.length; i++) { 
        var obj = objects[i];
        if (obj._render.selectable)
            return true;
    }
    return false;
}

exports.get_graph = function(scene) {
    return scene._render.graph;
}

/**
 * Generate non-object batches for graph subscenes
 */
exports.generate_auxiliary_batches = function(graph) {

    m_graph.traverse(graph, function(node, attr) {
        var subs = attr;

        var batch = null;

        switch(subs.type) {
        case "POSTPROCESSING":
            batch = m_batch.create_postprocessing_batch(subs.pp_effect);
            break;
        case "SSAO":
            batch = m_batch.create_ssao_batch(subs.ssao_samples);

            break;
        case "DEPTH_PACK":
            batch = m_batch.create_depth_pack_batch();

            break;
        case "BLUR_DEPTH":
            batch = m_batch.create_blur_depth_batch(subs.orientation);
            m_batch.set_texel_size_mult(batch, subs.blur_depth_size_mult);
            break;
        case "REFRACT":
        case "SCREEN":
            batch = m_batch.create_postprocessing_batch("NONE");
            break;

        case "GOD_RAYS":
            var subs_input = m_scgraph.find_input(graph, subs, "WIREFRAME") ||
                             m_scgraph.find_input(graph, subs, "MAIN_BLEND") ||
                             m_scgraph.find_input(graph, subs, "GOD_RAYS");

            var tex_input = subs_input.camera.color_attachment;
            var pack = subs.pack ? 1 : 0;

            if (subs.reflection_plane && subs.water)
                var water = 1; // needed for special underwater god rays
            else
                var water = 0;

            var steps = subs.steps_per_pass;
            batch = m_batch.create_god_rays_batch(tex_input, pack, water, steps);

            break;

        case "GOD_RAYS_COMBINE":

            var subs_input = m_scgraph.find_input(graph, subs, "WIREFRAME") ||
                            m_scgraph.find_input(graph, subs, "MAIN_BLEND");

            var subs_god_rays = m_scgraph.find_input(graph, subs, "GOD_RAYS");

            var tex_main = subs_input.camera.color_attachment;
            var tex_god_rays = subs_god_rays.camera.color_attachment;

            batch = m_batch.create_god_rays_combine_batch(tex_main, tex_god_rays);

            break;

        case "MOTION_BLUR":
            batch = m_batch.create_motion_blur_batch(subs.mb_decay_threshold);
            break;

        case "DOF":
            batch = m_batch.create_dof_batch();
            m_batch.set_texel_size_mult(batch, subs.camera.dof_power);

            var subs_pp1 = m_scgraph.find_input(graph, subs, "POSTPROCESSING");
            var subs_pp2 = m_scgraph.find_input(graph, subs_pp1, "POSTPROCESSING");
            var subs_in = [subs_pp1, subs_pp2];
            for (var i = 0; i < subs_in.length; i++) {
                var bundles = subs_in[i].bundles;
                var batch_i = bundles[0].batch;
                if (batch_i && batch_i.texel_size)
                    m_batch.set_texel_size_mult(batch_i, subs.camera.dof_power);
            }

            break;

        case "GLOW":
            var subs_glow_blur_y = m_scgraph.find_input(graph, subs,
                    "POSTPROCESSING");
            var subs_glow_blur_x = m_scgraph.find_input(graph, subs_glow_blur_y,
                    "POSTPROCESSING");
            var subs_glow_extend_y = m_scgraph.find_input(graph, subs_glow_blur_x,
                    "POSTPROCESSING");
            var subs_glow_extend_x = m_scgraph.find_input(graph, subs_glow_extend_y,
                    "POSTPROCESSING");

            batch = m_batch.create_glow_batch();

            // set blur strength for 2 subscenes
            var subs_in = [subs_glow_blur_x, subs_glow_blur_y];
            for (var i = 0; i < subs_in.length; i++) {
                var bundles = subs_in[i].bundles;
                var batch_in = bundles[0].batch;
                if (batch_in && batch_in.texel_size) {
                    m_batch.set_texel_size_mult(batch_in,
                            subs.blur_texel_size_mult);
                }
            }

            // set extend strength for 2 subscenes
            var subs_in = [subs_glow_extend_x, subs_glow_extend_y];
            for (var i = 0; i < subs_in.length; i++) {
                var bundles = subs_in[i].bundles;
                var batch_in = bundles[0].batch;
                if (batch_in && batch_in.texel_size) {
                    m_batch.set_texel_size_mult(batch_in,
                            subs.ext_texel_size_mult * subs.glow_factor);
                }
            }

            break;

        case "COMPOSITING":
            batch = m_batch.create_compositing_batch();

            break;

        case "ANTIALIASING":
            batch = m_batch.create_antialiasing_batch();
            break;

        case "LANCZOS":
            batch = m_batch.create_lanczos_batch(subs.lanczos_type);
            break;

        case "SMAA":
            batch = m_batch.create_smaa_batch(subs.smaa_pass);
            break;

        case "ANAGLYPH":
            batch = m_batch.create_anaglyph_batch();
            break;

        case "HUD":

            batch = m_batch.create_hud_batch();

            var texture = m_tex.create_texture_canvas("HUD", 1, 1);
            m_batch.append_texture(batch, texture);

            break;

        case "SKY":

            batch = m_batch.create_sky_batch();
            m_batch.set_texel_size(batch, 1/subs.camera.width, 1/subs.camera.height);

            break;
        case "LUMINANCE":
            batch = m_batch.create_luminance_batch();

            break;
        case "AVERAGE_LUMINANCE":

            batch = m_batch.create_average_luminance_batch();

            break;
        case "LUMINANCE_TRUNCED":
            batch = m_batch.create_luminance_trunced_batch();

            break;
        case "BLOOM_BLUR":
            batch = m_batch.create_bloom_blur_batch(subs.pp_effect);
            m_batch.set_texel_size(batch, 1/subs.camera.width, 1/subs.camera.height);

            break;
        case "BLOOM":

            var subs_blur_y = m_scgraph.find_input(graph, subs, "BLOOM_BLUR");
            var subs_blur_x = m_scgraph.find_input(graph, subs_blur_y, "BLOOM_BLUR"); 

            // set blur strength for 2 subscenes
            var subs_in = [subs_blur_x, subs_blur_y];
            for (var i = 0; i < subs_in.length; i++) {
                var bundles = subs_in[i].bundles;
                var batch_in = bundles[0].batch;
                if (batch_in && batch_in.texel_size) {
                    m_batch.set_texel_size_mult(batch_in, subs.bloom_blur);
                }
            }

            batch = m_batch.create_bloom_combine_batch();

            break;
        }

        if (batch) {
            var rb = {
                do_render: true,
                obj_render: m_util.create_render("NONE"),
                batch: batch
            };

            validate_batch(batch);
            subs.bundles.push(rb);
            connect_textures(graph, subs, batch);
            check_batch_textures_number(batch);
        }
    });

}

function connect_textures(graph, subs, batch) {

    var id = m_graph.node_by_attr(graph, subs);

    // release unused textures from previous subscenes
    m_graph.traverse_inputs(graph, id, function(id_in, attr_in,
            attr_edge) {
        var slink = attr_edge;
        var subs_in = attr_in;

        if (!slink.active)
            return;

        switch (slink.from) {
        case "COLOR":
        case "CUBEMAP":
            var tex = subs_in.camera.color_attachment;
            break;
        case "DEPTH":
            var tex = subs_in.camera.depth_attachment;
            break;
        case "SCREEN":
            var tex = null;
            break;
        default:
            throw "Wrong slink";
        }

        switch (slink.to) {
        case "COLOR":
        case "CUBEMAP":
        case "DEPTH":
        case "NONE":
        case "SCREEN":
            // nothing
            break;
        default:

            if (!tex)
                throw "Connection of SCREEN is forbidden";

            var bundles = subs.bundles;
            for (var k = 0; k < bundles.length; k++) {
                var batch = bundles[k].batch;

                if (m_shaders.check_uniform(batch.shader, slink.to))
                    m_batch.append_texture(batch, tex, slink.to);
            }

            break;
        }
    });

    for (var i = 0; i < subs.slinks_internal.length; i++) {
        var slink = subs.slinks_internal[i];
        var tex = subs.textures_internal[i];

        switch (slink.to) {
        case "COLOR":
        case "CUBEMAP":
        case "DEPTH":
        case "NONE":
        case "SCREEN":
            // nothing
            break;
        default:
            var bundles = subs.bundles;
            for (var j = 0; j < bundles.length; j++) {
                var batch = bundles[j].batch;

                if (m_shaders.check_uniform(batch.shader, slink.to))
                    m_batch.append_texture(batch, tex, slink.to);
            }
            break;
        }
    }
}


/**
 * Extract batches from the object and add to subscenes
 * @methodOf scenes
 */
exports.append_object = function(scene, obj) {
    var type = obj["type"];

    var objs_type = scene._appended_objects[type];
    if (!objs_type) {
        m_print.error("B4W Error - add object(): unsupported object type", type);
        return;
    }

    // prevent add more than once
    if (objs_type.indexOf(obj) != -1) {
        m_print.error("B4W Error - add object(): already added");
        return;
    }

    scene._appended_objects[type].push(obj);
    scene._appended_objects["ALL"].push(obj);

    switch (type) {
    case "MESH":
        var graph = scene._render.graph;
        var obj_render = obj._render;
        
        if (!m_scgraph.find_subs(graph, "SHADOW_CAST") && obj_render.shadow_receive)
            obj_render.shadow_receive = false;

        var subs_arr = subs_array(scene, OBJECT_SUBSCENE_TYPES);
        for (var i = 0; i < subs_arr.length; i++) {
            var subs = subs_arr[i];
            add_object_sub(subs, obj, graph, scene);
        }

        break;
    case "LAMP":
        increase_subs_num_lights(scene);
        update_lamp_scene(obj, scene);
        break;
    default:
        break;
    }
}

/**
 * Increase lights number on all light subscenes
 */
function increase_subs_num_lights(scene) {
    var subs_arr = subs_array(scene, LIGHT_SUBSCENE_TYPES);
    for (var i = 0; i < subs_arr.length; i++) {
        var subs = subs_arr[i];
        subs.num_lights ++;
    }
}

/**
 * Filter batch to pass given subscene
 */
function add_object_sub(subs, obj, graph, bpy_scene) {
    switch(subs.type) {
    case "MAIN_OPAQUE":
        add_object_subs_main(subs, obj, graph, "OPAQUE", bpy_scene);
        break;
    case "MAIN_BLEND":
        add_object_subs_main(subs, obj, graph, "BLEND", bpy_scene);
        break;
    case "MAIN_REFLECT":
        add_object_subs_reflect(subs, obj, graph);
        break;
    case "DEPTH":
        add_object_subs_depth(subs, obj, graph, bpy_scene);
        break;
    case "SHADOW_CAST":
        add_object_subs_shadow(subs, obj, graph, bpy_scene);
        break;
    case "COLOR_PICKING":
        add_object_subs_color_picking(subs, obj);
        break;
    case "GRASS_MAP":
        add_object_subs_grass_map(subs, obj);
        break;
    case "GLOW_MASK":
        add_object_subs_glow_mask(subs, obj);
        break;
    case "WIREFRAME":
        add_object_subs_wireframe(subs, obj, graph);
        break;
    default:
        break;
    }
}

/**
 * Add object to main scene
 */
function add_object_subs_main(subs, obj, graph, main_type, bpy_scene) {
    var obj_render = obj._render;

    // divide obj by batches
    var batch_slots = obj._batch_slots;
    
    for (var i = 0; i < batch_slots.length; i++) {

        var batch = batch_slots[i].batch;

        if (batch.shadow_cast_only || batch.reflexible_only)
            continue;

        if ((batch.type != "SHADELESS" && batch.type != "MAIN" &&
                    batch.type != "NODES") || has_batch(subs, batch))
            continue;

        if (main_type === "OPAQUE") {
            if (batch.blend)
                continue;

            // disable unnecessary depth write
            //if (m_scgraph.find_subs(graph, "DEPTH"))
            //    batch.depth_mask = false;

            if (m_scgraph.find_subs(graph, "SHADOW_CAST") &&
                    batch.shadow_receive)
                var shadow_source = "SHADOW_SRC_MASK";
            else
                var shadow_source = "SHADOW_SRC_NONE";

        } else if (main_type === "BLEND") {
            if (!batch.blend)
                continue;

            if (m_scgraph.find_subs(graph, "SHADOW_CAST") &&
                    batch.shadow_receive) {
                switch(cfg_def.shadows) {
                case "RGBA":
                    var shadow_source = "SHADOW_SRC_RGBA";
                    break;
                case "RGBA_PCF":
                    var shadow_source = "SHADOW_SRC_RGBA_PCF";
                    break;
                case "DEPTH":
                    var shadow_source = "SHADOW_SRC_DEPTH";
                    break;
                case "VSM":
                    var shadow_source = "SHADOW_SRC_VSM";
                    break;
                default:
                    throw "Wrong shadows type";
                    break;
                }
            } else
                var shadow_source = "SHADOW_SRC_NONE";
        } else
            throw "Wrong main subscene type";
        
        var shaders_info = batch.shaders_info;
        m_shaders.set_directive(shaders_info, "SHADOW_SRC", shadow_source);
        m_batch.assign_shadow_receive_dirs(batch, get_csm_borders(bpy_scene));
        
        m_shaders.set_directive(shaders_info, "NUM_LIGHTS", subs.num_lights);
        
        if (m_shaders.get_fname(shaders_info) == "special_skydome.glslf")
            m_shaders.set_directive(shaders_info, "REFLECTION_PASS", 0);
        m_shaders.set_directive(shaders_info, "SSAO_ONLY", 0);

        if (subs.water_params && subs.water_fog_color_density) {
            m_shaders.set_directive(shaders_info, "WATER_EFFECTS", 1);
        } else {
            m_shaders.set_directive(shaders_info, "WATER_EFFECTS", 0);
        }

        if (subs.water_params && subs.caustics && obj_render.caustics) {
            m_shaders.set_directive(shaders_info, "CAUSTICS", 1);
            m_shaders.set_directive(shaders_info, "CAUST_SCALE", subs.caust_scale);
            m_shaders.set_directive(shaders_info, "CAUST_SPEED", m_shaders.glsl_value(subs.caust_speed, 2));
            m_shaders.set_directive(shaders_info, "CAUST_BRIGHT", subs.caust_brightness);
        } else
            m_shaders.set_directive(shaders_info, "CAUSTICS", 0);

        if (subs.water_params) {
            m_shaders.set_directive(shaders_info, "WAVES_HEIGHT", m_shaders.glsl_value(subs.water_waves_height));
            m_shaders.set_directive(shaders_info, "WAVES_LENGTH", m_shaders.glsl_value(subs.water_waves_length));
            m_shaders.set_directive(shaders_info, "WATER_LEVEL", m_shaders.glsl_value(subs.water_level));
        }

        if (batch.reflective && m_scgraph.find_subs(graph, "MAIN_REFLECT") &&
                batch.texture_names.indexOf("u_mirrormap") === -1) {
            m_shaders.set_directive(shaders_info, "REFLECTIVE", 1);
        } else {
            m_shaders.set_directive(shaders_info, "REFLECTIVE", 0);
        }

        var subs_sky = m_scgraph.find_subs(graph, "SKY");
        if (subs_sky) {
            if (batch.procedural_sky) {
                var tex = subs_sky.camera.color_attachment;
                m_batch.append_texture(batch, tex, "u_sky");
            } else if (cfg_def.procedural_fog && 
                  (subs.type === "MAIN_OPAQUE" || subs.type === "MAIN_BLEND")) {
                batch.cube_fog = subs_sky.cube_fog;
                m_shaders.set_directive(shaders_info, "PROCEDURAL_FOG", 1);
            } else {
                m_shaders.set_directive(shaders_info, "PROCEDURAL_FOG", 0);
            }
        } else {
            m_shaders.set_directive(shaders_info, "PROCEDURAL_FOG", 0);
        }

        if (batch.dynamic_grass) {
            var subs_grass_map = m_scgraph.find_subs(graph, "GRASS_MAP");
            if (subs_grass_map)
                prepare_dynamic_grass_batch(batch, subs_grass_map, obj_render);
        }

        if (batch.water) {
            if (m_scgraph.find_subs(graph, "REFRACT")) {
                m_shaders.set_directive(shaders_info, "REFRACTIVE", 1);
            } else 
                m_shaders.set_directive(shaders_info, "REFRACTIVE", 0);

            if (batch.water_shore_smoothing && m_scgraph.find_subs(graph, "DEPTH"))
                m_shaders.set_directive(shaders_info, "SHORE_SMOOTHING", 1);
            else
                m_shaders.set_directive(shaders_info, "SHORE_SMOOTHING", 0);

            if (batch.water_dynamic && subs.water_params && subs.water_waves_height) 
                m_shaders.set_directive(shaders_info, "DYNAMIC", 1);
            else
                m_shaders.set_directive(shaders_info, "DYNAMIC", 0);

        }

        // check for textures used in offscreen rendering
        // NOTE: create and attach subgraph, it's possible to do so here
        // because we have only one texture for each subscene
        if (main_type === "OPAQUE" || main_type === "BLEND") {
            var textures = batch.textures;

            for (var j = 0; j < textures.length; j++) {
                var tex = textures[j];

                var src = tex.offscreen_scene;
                if (src) {
                    var src_graph = src._render.graph;

                    var subs_tex = null;
                    var slink_tex = null;
                    
                    m_graph.traverse_edges(src_graph, function(id1, id2, attr) {
                        var slink = attr;

                        if (slink.from == "SCREEN") {
                            subs_tex = m_graph.get_node_attr(src_graph, id1);
                            slink_tex = slink;
                            return true;
                        }
                    });

                    if (!subs_tex || !slink_tex)
                        throw "Failed to assign RTT";

                    m_tex.set_filters(tex, m_tex.TF_LINEAR, m_tex.TF_LINEAR);

                    slink_tex.texture = tex;

                    var cam_tex = subs_tex.camera;
                    cam_tex.color_attachment = tex;
                    cam_tex.framebuffer = m_render.render_target_create(tex, null);

                    var o_width = cfg_scs.offscreen_tex_size;
                    var o_height = cfg_scs.offscreen_tex_size;

                    setup_scene_dim(src, o_width, o_height, true);

                    var queue_tex = m_scgraph.create_rendering_queue(src_graph);
                    for (var k = queue_tex.length-1; k >= 0; k--) {
                        var subs_k = queue_tex[k];
                        var cam_k = subs_k.camera;

                        m_cam.set_projection(cam_k, 1);
                        bpy_scene._render.queue.unshift(subs_k);
                    }
                }
            }
        }

        prepare_shadow_receive_batch(graph, subs, shadow_source);

        m_batch.update_shader(batch);

        var rb = {
            do_render: true,
            obj_render: obj_render,
            batch: batch
        };
        
        validate_batch(batch);

        subs.bundles.push(rb);
        connect_textures(graph, subs, batch);
        check_batch_textures_number(batch);
    }
   
    // first sort by blend then by offset_z
    var sort_fun = function(a, b) {
        if (a == b) return 0;
        return a > b ? 1 : -1;
    }
    var sort_fun_double = function(a, b) {
        if (a.batch && b.batch)
            return sort_fun(a.batch.blend, b.batch.blend) ||
                   sort_fun(a.batch.offset_z, b.batch.offset_z);
        else 
            return 0;
    }
    subs.bundles.sort(sort_fun_double);

    //m_print.log("Added: " + obj.name + ". Total " + subs.bundles.length);
    //debug_report_order(subs.bundles);
}

function validate_batch(batch) {
    var shader = batch.shader;
    var attributes = shader.attributes;
    var bufs_data = batch.bufs_data;
    var pointers = bufs_data.pointers;

    for (var attr in attributes) {

        var p = pointers[attr];

        if (!p)
            throw "B4W Error: missing data for \"" + attr + "\" attribute";
    }

    if (batch.type == "MAIN")
        check_main_varyings_count(batch);
    if (batch.type == "NODES")
        check_nodes_varyings_count(batch);

}

function check_batch_textures_number(batch) {
    if (batch.textures.length > MAX_BATCH_TEXTURES)
        m_print.warn("B4W Warning: too many textures used - " +
            batch.textures.length + " (max " + MAX_BATCH_TEXTURES +
            "), material \"" + find_material_name_by_batch(batch) + "\"");
}

function check_main_varyings_count(batch) {
    // v_eye_dir, v_pos_world, v_normal, v_pos_view mandatory varyings
    var total = 4;

    var attr_names_for_varyings = ["a_color", "a_tangent", "a_texcoord"];    
    total += get_shader_units_presence_count(batch.shader.attributes, 
            attr_names_for_varyings);

    var unif_names_for_varyings = ["u_shadow_map0", "u_shadow_map1", 
            "u_shadow_map2", "u_shadow_map3", "u_shadow_mask"];
    total += get_shader_units_presence_count(batch.shader.uniforms, 
            unif_names_for_varyings);

    if (total > MAX_SHADER_VARYING_COUNT)
        m_print.warn("B4W Warning: Varying limit exceeded for main shader - " 
                + total + ", material \"" 
                + find_material_name_by_batch(batch) + "\"");
}

function check_nodes_varyings_count(batch) {
    // v_pos_world, v_pos_view mandatory varyings
    var total = 2;
    var used_uv = 0;
    var used_vc = 0;

    if (batch.uv_maps_usage) {
        used_uv += m_util.get_dict_length(batch.uv_maps_usage);
        total += used_uv;
    }
    if (batch.vertex_colors_usage) {
        used_vc += m_util.get_dict_length(batch.vertex_colors_usage);
        total += used_vc;
    }

    var attr_names_for_varyings = ["a_color", "a_normal", "a_tangent"];    
    total += get_shader_units_presence_count(batch.shader.attributes, 
            attr_names_for_varyings);

    var unif_names_for_varyings = ["u_shadow_map0", "u_shadow_map1", 
            "u_shadow_map2", "u_shadow_map3", "u_shadow_mask"];    
    total += get_shader_units_presence_count(batch.shader.uniforms, 
            unif_names_for_varyings);

    if (total > MAX_SHADER_VARYING_COUNT)
        m_print.warn("B4W Warning: Varying limit exceeded for node shader - " 
                + total + ", uv: " + used_uv + ", vc: " + used_vc 
                + ", material \"" + find_material_name_by_batch(batch) + "\"");
}

function get_shader_units_presence_count(storage, names) {
    var count = 0;
    for (var i = 0; i < names.length; i++)
        if (names[i] in storage)
            count++;
    return count;
}

function find_material_name_by_batch(batch) {

    for (var i = 0; i < _scenes.length; i++) {
        var objects = get_scene_objs(_scenes[i], "MESH");

        for (var j = 0; j < objects.length; j++) {
            var obj = objects[j];

            if (!obj._batch_slots)
                continue;

            var mats = obj["data"]["materials"];

            for (var k = 0; k < obj._batch_slots.length; k++) {
                var slot = obj._batch_slots[k];

                if (slot.batch == batch &&
                        slot.submesh_index > -1) {
                    return mats[slot.submesh_index]["name"];
                }
            }
        }
    }

    return null;
}

function prepare_shadow_receive_batch(graph, subs, shadow_source) {

    var csm_index = 0;
    var subs_inputs = m_scgraph.get_inputs(graph, subs);

    for (var i = 0; i < subs_inputs.length; i++) {

        var input = subs_inputs[i];

        // shadow map with optional blurring
        if ((shadow_source == "SHADOW_SRC_RGBA" ||
                shadow_source == "SHADOW_SRC_RGBA_PCF" ||
                shadow_source == "SHADOW_SRC_DEPTH" ||
                shadow_source == "SHADOW_SRC_VSM") &&
                (input.type == "SHADOW_CAST" || input.type == "POSTPROCESSING")) {

            // assign textures

            if (shadow_source == "SHADOW_SRC_DEPTH")
                var tex = input.camera.depth_attachment;
            else
                var tex = input.camera.color_attachment;

            // assign uniforms from cast camera

            var cam_cast = m_scgraph.find_upper_subs(graph, input, "SHADOW_CAST").camera;

            // by link
            subs.v_light_matrix = cam_cast.view_matrix;

            // moving from unit cube [-1,1] to [0,1]
            subs.b_light_matrix = new Float32Array([
                0.5, 0.0, 0.0, 0.0, 
                0.0, 0.5, 0.0, 0.0,
                0.0, 0.0, 0.5, 0.0,
                0.5, 0.5, 0.5, 1.0]);

            subs.p_light_matrix = subs.p_light_matrix || new Array();
            // by link
            subs.p_light_matrix[csm_index] = cam_cast.proj_matrix;

            csm_index++;
        }
    }
}

function prepare_dynamic_grass_batch(batch, subs_grass_map, obj_render) {
    // by link
    batch.grass_map_dim = subs_grass_map.grass_map_dim;

    var low = subs_grass_map.grass_map_dim[0];
    var high = subs_grass_map.grass_map_dim[1];
    var size = subs_grass_map.grass_map_dim[2];

    var bb = obj_render.bb_local;
    var bb_max_size = Math.max(bb.max_x - bb.min_x, bb.max_z - bb.min_z);

    if (size == 0)
        size = bb_max_size;
    else
        size = Math.max(size, bb_max_size);

    // store back, affects batch and subs grass map
    subs_grass_map.grass_map_dim[2] = size;

    // update grass map camera
    var cam = subs_grass_map.camera;
    m_cam.set_frustum(cam, size/2, -high, -low, size/2);
    m_cam.set_projection(cam);

    var bsize = batch.grass_size || 0;
    if (bsize == 0)
        bsize = bb_max_size;
    else
        bsize = Math.max(bsize, bb_max_size);
    batch.grass_size = bsize;
}

exports.has_batch = has_batch;
/**
 * All batches among bundles must be unique
 * we use id value to determine uniqueness
 */
function has_batch(subscene, batch) {
    var sbundles = subscene.bundles;

    for (var i = 0; i < sbundles.length; i++) {
        var sbundle = sbundles[i];
        var sbatch = sbundle.batch;

        if (sbatch && sbatch.id == batch.id)
            return true;
    }

    return false;
}

function debug_report_order(bundles) {
    var names = [];
    for (var i = 0; i < bundles.length; i++) {

        var batch = bundles[i].batch;
        
        if (batch)
            names.push(batch.name.split("*")[2]);
        else
            names.push("NULL");
    }

    m_print.log(names);
}

/**
 * Add object to main scene
 */
function add_object_subs_depth(subs, obj, graph, bpy_scene) {

    var obj_render = obj._render;

    // divide obj by batches
    var batch_slots = obj._batch_slots;

    for (var i = 0; i < batch_slots.length; i++) {
        var batch_src = batch_slots[i].batch;

        if (batch_src.type != "DEPTH" || has_batch(subs, batch_src) 
                || batch_src.shadow_cast_only)
            continue;

        if (m_scgraph.has_upper_subs(graph, subs, "SHADOW_CAST")) {
            if (batch_src.shadow_receive) {

                switch(cfg_def.shadows) {
                case "RGBA":
                    var shadow_src = "SHADOW_SRC_RGBA";
                    var shadow_dst = "SHADOW_DST_MASK";
                    break;
                case "RGBA_PCF":
                    var shadow_src = "SHADOW_SRC_RGBA_PCF";
                    var shadow_dst = "SHADOW_DST_MASK";
                    break;
                case "DEPTH":
                    var shadow_src = "SHADOW_SRC_DEPTH";
                    var shadow_dst = "SHADOW_DST_MASK";
                    break;
                case "VSM":
                    var shadow_src = "SHADOW_SRC_VSM";
                    var shadow_dst = "SHADOW_DST_MASK";
                    break;
                default:
                    throw "Wrong shadows type";
                    break;
                }

                var batch = m_batch.fork_depth_batch(batch_src, shadow_src, shadow_dst);
                m_batch.assign_shadow_receive_dirs(batch, get_csm_borders(bpy_scene));
                var subs_inputs = m_scgraph.get_inputs(graph, subs);
                prepare_shadow_receive_batch(graph, subs, shadow_src);
            } else {
                var batch = m_batch.fork_depth_batch(batch_src, "SHADOW_SRC_NONE",
                        "SHADOW_DST_MASK");
                // prevent non-shadow-receivers from cluttering color texture
                //batch.color_mask = false;
            }
        } else {
            var batch = m_batch.fork_depth_batch(batch_src, 
                    "SHADOW_SRC_NONE", "SHADOW_DST_NONE");
        }

        if (batch.dynamic_grass) {
            var subs_grass_map = m_scgraph.find_subs(graph, "GRASS_MAP");
            if (subs_grass_map)
                prepare_dynamic_grass_batch(batch, subs_grass_map, obj_render);
        }

        m_batch.update_shader(batch);

        var rb = {
            do_render: true,
            obj_render: obj_render,
            batch: batch
        };

        validate_batch(batch);

        subs.bundles.push(rb);
        connect_textures(graph, subs, batch);
        check_batch_textures_number(batch);
    }
}

function add_object_subs_shadow(subs, obj, graph, bpy_scene) {
    var update_needed = false;
    var obj_render = obj._render;
    var batch_slots = obj._batch_slots;

    for (var i = 0; i < batch_slots.length; i++) {
        var batch_src = batch_slots[i].batch;

        if (!(batch_src.shadow_cast || batch_src.shadow_receive))
            continue;
        update_needed = true;

        if (batch_src.type != "DEPTH" || has_batch(subs, batch_src))
            continue;

        if (batch_src.shadow_cast) {

            switch(cfg_def.shadows) {
            case "RGBA":
            case "RGBA_PCF":
                var shadow_dst = "SHADOW_DST_RGBA";
                break;
            case "DEPTH":
                var shadow_dst = "SHADOW_DST_DEPTH";
                break;
            case "VSM":
                var shadow_dst = "SHADOW_DST_VSM";
                break;
            default:
                throw "Wrong shadows type";
                break;
            }

            var batch = m_batch.fork_depth_batch(batch_src, "SHADOW_SRC_NONE", shadow_dst);

            if (batch.dynamic_grass) {
                var subs_grass_map = m_scgraph.find_subs(graph, "GRASS_MAP");
                if (subs_grass_map)
                    prepare_dynamic_grass_batch(batch, subs_grass_map, obj_render);
            }

            m_batch.update_shader(batch);

            var rb = {
                do_render: true,
                obj_render: obj_render,
                batch: batch
            };

            validate_batch(batch);

            subs.bundles.push(rb);
        }
    }

    if (update_needed)
        update_subs_shadow(subs, m_scgraph.find_subs(graph, "MAIN_OPAQUE"),
                subs.bundles, bpy_scene);
}

function add_object_subs_reflect(subs, obj, graph) {
    var obj_render = obj._render;

    var batch_slots = obj._batch_slots;

    for (var i = 0; i < batch_slots.length; i++) {

        var batch = batch_copy_wo_bufs(batch_slots[i].batch);

        if ((batch.type != "SHADELESS" && batch.type != "MAIN" &&
                    batch.type != "NODES") || has_batch(subs, batch))
            continue;

        if (batch.blend)
            continue;

        if (batch.reflexible) {

            var shaders_info = batch.shaders_info;

            m_shaders.set_directive(shaders_info, "DISABLE_FOG", 0);

            m_shaders.set_directive(shaders_info, "WATER_EFFECTS", 0);

            if (m_shaders.get_fname(shaders_info) == "special_skydome.glslf")
                m_shaders.set_directive(shaders_info, "REFLECTION_PASS", 1);

            m_shaders.set_directive(shaders_info, "SHADOW_SRC", "SHADOW_SRC_NONE");
            
            // disable normalmapping in shader for optimization purposes
            m_shaders.set_directive(shaders_info, "TEXTURE_NORM", 0);

            m_batch.update_shader(batch);

            var rb = {
                do_render: true,
                obj_render: obj_render,
                batch: batch
            };

            validate_batch(batch);

            subs.bundles.push(rb);
        }
    }
}

exports.schedule_shadow_update = schedule_shadow_update;
/**
 * Schedule update of shadow subscenes on given bpy scene.
 * @methodOf scenes
 */
function schedule_shadow_update(bpy_scene) {
    bpy_scene._render.need_shadow_update = true;
}

/**
 * Update all shadow subscenes on active scene
 */
function update_shadow_subscenes(bpy_scene) {

    // also update shadow subscene camera
    var subs_main = get_subs(bpy_scene, "MAIN_OPAQUE");

    var graph = bpy_scene._render.graph;

    m_graph.traverse(graph, function(node, attr) {
        var subs = attr;
        if (subs.type === "SHADOW_CAST")
            update_subs_shadow(subs, subs_main, subs.bundles, bpy_scene);
    });
}

/**
 * Update shadow subscene camera based on main subscene light
 * @methodOf scenes
 */
function update_subs_shadow(subs, subs_main, cast_bundles, bpy_scene) {

    if (cast_bundles.length == 0)
        return;

    var cam = subs.camera;

    var cam_main = subs_main.camera;
    var lamps = get_appended_objs(bpy_scene, "LAMP");

    // light view matrix
    var lamp = find_first_lamp_with_shadows(lamps) || lamps[0];
    var lamp_render = lamp._render;
    m_cam.set_view_trans_quat(cam, lamp_render.trans, lamp_render.quat);

    // NOTE: inherit light camera eye from main camera (used in LOD calculations)
    m_vec3.copy(cam_main.eye, cam.eye);

    var near = cam_main.near;
    var far = csm_far_plane(bpy_scene, cam_main, subs.csm_index);

    var bb_view_slice = _bb_tmp;
    shadow_volume_from_camera(cam_main, cam, near, far, bb_view_slice);

    var bb_view = _bb_tmp2;
    // NOTE: temporary solution when no intersection is found
    m_bounds.zero_bounding_box(bb_view);
    shadow_volume_intersect(cast_bundles, cam.view_matrix, bb_view_slice, bb_view);

    var max_z = bb_view.max_z;  // save (do not shrink) near plane
    m_bounds.shrink_bounding_box(bb_view, bb_view_slice, bb_view);
    bb_view.max_z = max_z;  // restore near plane

    // remove shadow flickering by expanding light volume to maximum value
    // proptionally to camera frustum far plane

    // TODO: proper max volume calculation
    var MAX_BOUNDING_FAC = 2.0;

    var size_x = bb_view.max_x - bb_view.min_x;
    var size_y = bb_view.max_y - bb_view.min_y;

    var scale_x = size_x / (MAX_BOUNDING_FAC*far);
    var scale_y = size_y / (MAX_BOUNDING_FAC*far);

    var QUANTIZER = 64;
    scale_x = (QUANTIZER / Math.ceil(QUANTIZER / scale_x));
    scale_y = (QUANTIZER / Math.ceil(QUANTIZER / scale_y));

    var size_x_new = scale_x * MAX_BOUNDING_FAC*far;
    var size_y_new = scale_y * MAX_BOUNDING_FAC*far;

    bb_view.min_x = bb_view.min_x - 0.5 * (size_x_new - size_x);
    bb_view.max_x = bb_view.max_x + 0.5 * (size_x_new - size_x);

    bb_view.min_y = bb_view.min_y - 0.5 * (size_y_new - size_y);
    bb_view.max_y = bb_view.max_y + 0.5 * (size_y_new - size_y);

    var met_pix_x = (bb_view.max_x - bb_view.min_x) / cfg_scs.shadow_tex_size;
    var met_pix_y = (bb_view.max_y - bb_view.min_y) / cfg_scs.shadow_tex_size;

    bb_view.min_x = Math.floor(bb_view.min_x / met_pix_x) * met_pix_x;
    bb_view.max_x = Math.floor(bb_view.max_x / met_pix_x) * met_pix_x;
    bb_view.min_y = Math.floor(bb_view.min_y / met_pix_y) * met_pix_y;
    bb_view.max_y = Math.floor(bb_view.max_y / met_pix_y) * met_pix_y;

    m_cam.set_frustum_asymmetric(cam, bb_view.min_x, bb_view.max_x, 
            bb_view.min_y, bb_view.max_y, -bb_view.max_z, -bb_view.min_z);

    m_cam.set_projection(cam);

    m_util.extract_frustum_planes(cam.view_proj_matrix, cam.frustum_planes);
}

function find_first_lamp_with_shadows(lamps) {
    for (var i = 0; i < lamps.length; i++) {
        var lamp = lamps[i];
        if (lamp["data"]["b4w_generate_shadows"])
            return lamp;
    }
    return false;
}


function csm_far_plane(scene, cam, csm_index) {
    var shs = scene._render.shadow_params;
    var n = shs.csm_near; 
    var f = shs.csm_far;
    var N = shs.csm_num; 
    var lambda = shs.csm_lambda;

    var far = get_csm_border(csm_index + 1, n, f, N, lambda);

    // clamp to camera far plane
    if (far > cam.far)
        return cam.far;
    else
        return far;
}

exports.get_csm_borders = get_csm_borders;
/**
 * @methodOf scenes
 */
function get_csm_borders(scene) {

    var shs = scene._render.shadow_params;

    var n = shs.csm_near; 
    var f = shs.csm_far;
    var N = shs.csm_num; 
    var lambda = shs.csm_lambda;

    var rslt = new Array();
    
    for (var i = 1; i <= N; i++) {

        var b = get_csm_border(i, n, f, N, lambda);

        // floats requred for glsl defines
        if (b === Math.round(b))
            b += 0.0001;
                    
        rslt.push(b);
    }

    return rslt;
}

/**
 * Cascaded Shadow Maps Rouslan Dimitrov NVIDIA Corporation
 * zi = λn(f / n) ^ (i / N) + (1 − λ)(n + (i / N)(f − n))
 */
function get_csm_border(index, near, far, num, lambda) {
    return (lambda * near * Math.pow(far/near, index/num) +
            (1 - lambda) * (near + index/num * (far - near)));
}

/**
 * Generate shadow volume based on camera frustum
 * translate shadow volume to second camera view space
 * uses _frustum_corners_tmp
 */
function shadow_volume_from_camera(cam_from, cam_to, near, far, dest) {

    var corners = _frustum_corners_tmp;

    m_cam.extract_frustum_corners(cam_from, near, far, corners);

    m_util.positions_multiply_matrix(corners, cam_to.view_matrix, corners, 0);

    m_bounds.bb_from_coords(corners, dest);
}

/**
 * Generate shadow volume which embraces given set of shadow cast bundles.
 * uses _bb_tmp3
 */
function shadow_volume_intersect(cast_bundles, view_matrix, bb_int_view, dest) {

    var dest_init_flag = false;

    for (var i = 0; i < cast_bundles.length; i++) {

        // not all casters will be unique
        var render = cast_bundles[i].obj_render;

        var bb_obj = render.bb_world;

        var bb_obj_view = m_bounds.bounding_box_transform(bb_obj, view_matrix,
                _bb_tmp3);

        if (!m_bounds.check_bb_intersection(bb_obj_view, bb_int_view))
            continue;

        if (dest_init_flag) {
            m_bounds.expand_bounding_box(dest, bb_obj_view);
        } else {
            m_bounds.copy_bb(bb_obj_view, dest);
            dest_init_flag = true;
        }
    }
}

function add_object_subs_color_picking(subs, obj) {

    var obj_render = obj._render;

    var batch_slots = obj._batch_slots;

    for (var i = 0; i < batch_slots.length; i++) {
        var batch = batch_slots[i].batch;

        if (batch.type != "COLOR_ID" || has_batch(subs, batch))
            continue;
        
        m_batch.set_batch_directive(batch, "USE_GLOW", 0);
        m_batch.update_shader(batch);

        var rb = {
            do_render: true,
            obj_render: obj_render,
            batch: batch
        };

        validate_batch(batch);

        subs.bundles.push(rb);
    }
}

function add_object_subs_wireframe(subs, obj, graph) {

    var obj_render = obj._render;
    var batch_slots = obj._batch_slots;

    for (var i = 0; i < batch_slots.length; i++) {
        var batch = batch_slots[i].batch;

        if (batch.type != "WIREFRAME" || has_batch(subs, batch))
            continue;

        if (batch.dynamic_grass) {
            var subs_grass_map = m_scgraph.find_subs(graph, "GRASS_MAP");
            if (subs_grass_map)
                prepare_dynamic_grass_batch(batch, subs_grass_map, obj_render);
        }

        m_batch.update_shader(batch);

        var rb = {
            do_render: true,
            obj_render: obj_render,
            batch: batch
        };

        validate_batch(batch);

        subs.bundles.push(rb);
        connect_textures(graph, subs, batch);
        check_batch_textures_number(batch);
    }

}

/**
 * Add object to depth map scene
 */
function add_object_subs_grass_map(subs, obj) {

    var obj_render = obj._render;

    // divide obj by batches
    var batch_slots = obj._batch_slots;

    for (var i = 0; i < batch_slots.length; i++) {
        var batch = batch_slots[i].batch;

        if (batch.type != "GRASS_MAP" || has_batch(subs, batch))
            continue;

        m_batch.update_shader(batch);

        var rb = {
            do_render: true,
            obj_render: obj_render,
            batch: batch
        };

        validate_batch(batch);

        subs.bundles.push(rb);

        // recalculate scene camera

        var cam = subs.camera;
        var bb = obj_render.bb_world;

        var low = subs.grass_map_dim[0];
        var high = subs.grass_map_dim[1];
        var size = subs.grass_map_dim[2];

        if (low == 0 && high == 0) {
            // initial exec
            low = bb.min_y;
            high = bb.max_y;
        } else {
            low = Math.min(low, bb.min_y);
            high = Math.max(high, bb.max_y);
        }

        // NOTE: issue for partially plain meshes near top or bottom
        var map_margin = (high - low) * GRASS_MAP_MARGIN;

        subs.grass_map_dim[0] = low - map_margin;
        subs.grass_map_dim[1] = high + map_margin;
        // subs.grass_map_dim[2] stays intact

        m_cam.set_frustum(cam, size/2, -high, -low, size/2);
        m_cam.set_projection(cam);
    }
}

/**
 * Add object to glow mask scene
 */
function add_object_subs_glow_mask(subs, obj) {

    var obj_render = obj._render;
    var batch_slots = obj._batch_slots;

    for (var i = 0; i < batch_slots.length; i++) {
        var batch_src = batch_slots[i].batch;

        if (batch_src.type != "COLOR_ID" || has_batch(subs, batch_src))
            continue;

        var batch = batch_copy_wo_bufs(batch_src);
        batch.glow_intensity = 0;
        m_batch.set_batch_directive(batch, "USE_GLOW", 1);
        m_batch.update_shader(batch);

        batch_slots.push(m_batch.create_slot(batch, batch_slots[i].submesh_index));

        var rb = {
            do_render: true,
            obj_render: obj_render,
            batch: batch
        };

        validate_batch(batch);

        subs.bundles.push(rb);
    }
}

/**
 * copy everything
 * NOTE: possible issues with webgl objects
 */
function batch_copy_w_bufs(batch) {
    return m_util.clone_object_r(batch);
}

/**
 * copy, bufs by link
 */
function batch_copy_wo_bufs(batch) {

    var batch_copy = m_util.clone_object_nr(batch);
    // special precautions for shaders_info
    batch.shaders_info = JSON.parse(JSON.stringify(batch.shaders_info));

    return batch_copy; 
}

/**
 * Hide object on scene.
 * @methodOf scenes
 */
exports.hide_object = function(scene, obj) {
    obj._render.hide = true;
}

/**
 * Show object on scene.
 * @methodOf scenes
 */
exports.show_object = function(scene, obj) {
    obj._render.hide = false;
}

/**
 * Remove object from scene.
 * NOTE: currently only dynamic mesh objects supported
 * @methodOf scenes
 */
exports.remove_object = function(scene, obj) {
    var render = obj._render;

    if (render.type != "DYNAMIC")
        return false;

    var subscenes = subs_array(scene, OBJECT_SUBSCENE_TYPES);
    for (var i = 0; i < subscenes.length; i++) {
        var bundles = subscenes[i].bundles;

        for (var j = 0; j < bundles.length; j++) {
            var bundle = bundles[j];
            if (bundle.obj_render == render) {
                bundles.splice(j, 1);
                j--;
            }
        }
    }

    var ind = scene._appended_objects["MESH"].indexOf(obj);
    if (ind != -1)
        scene._appended_objects["MESH"].splice(ind, 1);

    var ind = scene._appended_objects["ALL"].indexOf(obj);
    if (ind != -1)
        scene._appended_objects["ALL"].splice(ind, 1);
}

exports.check_object = function(obj, scene) {
    if (scene._appended_objects[obj["type"]] &&
            scene._appended_objects[obj["type"]].indexOf(obj) > -1)
        return true;
    else
        return false;
}


/**
 * NOTE: only main scene supported
 */
function add_bundle(subscene, render, batch) {

    var rb = {
        do_render: true,
        obj_render: render,
        batch: batch
    };

    subscene.bundles.push(rb);
}

/**
 * NOTE: only main scene supported
 */
function remove_bundle(subscene, render) {

    var bundles = subscene.bundles;

    for (var i = 0; i < bundles.length; i++) {
        var bundle = bundles[i];
        if (bundle.obj_render == render) {
            bundles.splice(i, 1);
            i--;
        }
    }
}

exports.update_lamp_scene = update_lamp_scene;
/**
 * Update light parameters on subscenes
 */
function update_lamp_scene(lamp, scene) {
    var subs_arr = subs_array(scene, LIGHT_SUBSCENE_TYPES);

    var light = lamp._light;
    var lamp_render = lamp._render;
    var ind = light.index;

    for (var i = 0; i < subs_arr.length; i++) {
        var subs = subs_arr[i];
        subs.light_positions.set(lamp_render.trans, ind * 3);
        subs.light_directions.set(light.direction, ind * 3);
        subs.light_color_intensities.set(light.color_intensity, ind * 3);

        var light_factor1 = _vec4_tmp;
        light_factor1[0] = 1.0;
        light_factor1[1] = 0.0;
        light_factor1[2] = 0.0;
        light_factor1[3] = 0.0;

        var light_factor2 = _vec4_tmp2;
        light_factor2[0] =-1.0;
        light_factor2[1] =-1.0;
        light_factor2[2] =-1.0;
        light_factor2[3] = 0.0;

        switch (light.type) {
        case "SUN":
            subs.sun_quaternion.set(lamp_render.quat, 0);
            subs.sun_intensity = light.color_intensity;

            if (subs.type === "SKY") {
                var auxilary_vec = _vec3_tmp;
                auxilary_vec[0] = auxilary_vec[1] = auxilary_vec[2] = 1;
                var prev_angle = Math.acos(m_vec3.dot(subs.sun_direction, auxilary_vec));
                var new_angle  = Math.acos(m_vec3.dot(light.direction, auxilary_vec));
                var floor_prev = Math.floor(prev_angle / 0.025);
                var floor_new  = Math.floor(new_angle / 0.025);

                if (floor_prev != floor_new)
                    subs.need_fog_update = true;
                else
                    subs.need_fog_update = false;

                m_vec3.copy(light.direction, subs.sun_direction);

                update_sky(scene, subs);
            } else
                m_vec3.copy(light.direction, subs.sun_direction);

            break;
        case "HEMI":
            light_factor1[0] = 0.5;
            light_factor1[1] = 0.5;
            break;
        case "POINT":
            light_factor2[2] = light.distance;
            break;
        case "SPOT":
            light_factor2[2] = light.distance;
            var sp_size = light_factor2[0] = Math.cos(light.spot_size / 2.0);
            light_factor2[1] = light.spot_blend * (1.0 - sp_size);
            break;
        default:
            // TODO: prevent export of such lamps
            m_print.error("B4W Warning: unknown light type: " + light.type);
            break;
        }
        subs.light_factors1.set(light_factor1, ind * 4);
        subs.light_factors2.set(light_factor2, ind * 4);
        subs.need_perm_uniforms_update = true;
    }
}

/**
 * Update sky fog every 0.05 radians of sun rotattion
 */
function update_sky(scene, subs) {

    m_render.draw(subs);

    if (subs.need_fog_update) {
        // update cube fog uniforms for proper batches
        var main_subs = subs_array(scene, ["MAIN_OPAQUE",
                                           "MAIN_BLEND"]);
        for (var i = 0; i < main_subs.length; i++) {
            var m_subs = main_subs[i];
            var bundles = m_subs.bundles;
            for (var j = 0; j < bundles.length; j++) {
                var bundle = bundles[j];

                if (bundle.do_render) {
                    var batch = bundle.batch;

                    if (m_batch.check_batch_perm_uniform(batch, "u_cube_fog"))
                        m_render.update_batch_permanent_uniform(batch,
                                                                "u_cube_fog");
                }
            }
        }
    }
}

/**
 * Perform module cleanup
 */
exports.cleanup = function() {
    for (var i = 0; i < _scenes.length; i++) {
        var scene = _scenes[i];
        var graph = scene._render.graph;

        m_graph.traverse(graph, function(node, attr) {
            if (!(attr.type == "SINK"))
                clear_subscene(attr);
        });

        scene._render.graph = [];
        scene._render.queue = [];
    }

    _active_scene = null;
    _scenes.length = 0;
    _glow_anim_objs.length = 0;
    _tex_glow_input = null;
}

/**
 * Clear subscene
 */
function clear_subscene(subs) {

    var cam = subs.camera;

    m_render.render_target_cleanup(cam.framebuffer, cam.color_attachment,
            cam.depth_attachment, cam.width, cam.height);

    var bundles = subs.bundles;
    for (var i = 0; i < bundles.length; i++) {
        var batch = bundles[i].batch
        if (batch)
            m_batch.clear_batch(batch);
    }
}


/**
 * Extract frustum from camera, make debug geometry and add to active scene
 * for debug purposes only
 */
exports.make_frustum_shot = function(cam, subscene, color) {
    var corners = m_cam.extract_frustum_corners(cam, cam.near, cam.far, null);
    var submesh = m_primitives.generate_frustum(corners);
    //var submesh = m_primitives.generate_plane(5,5);

    var render = m_util.create_render("DYNAMIC");

    render.bb_world = render.bb_local = m_bounds.big_bounding_box();
    render.bs_world = render.bs_local = m_bounds.big_bounding_sphere();

    var batch = m_batch.create_shadeless_batch(submesh, color, 0.5);

    add_bundle(subscene, render, batch);
}

exports.get_scene_objs = get_scene_objs;
/**
 * Get all objects from the scene.
 * @methodOf scenes
 */
function get_scene_objs(scene, type) {
    if (!scene._objects)
        throw "Access to uninitialized scene";

    if (!type)
        type = "ALL";

    return scene._objects[type];
}

exports.get_appended_objs = get_appended_objs;
/**
 * Get appended objects.
 * @param scene Scene object
 * @param [type="ALL"] Type
 */
function get_appended_objs(scene, type) {
    if (!type)
        type = "ALL";

    return scene._appended_objects[type];
}

/**
 * Get all unuque materials of mesh objects from given scene
 */
function get_scene_materials(scene) {

    var mats = [];

    var objs = get_scene_objs(scene, "MESH");

    for (var i = 0; i < objs.length; i++) {
        var obj = objs[i];
        var mesh = obj["data"];

        for (var j = 0; j < mesh["materials"].length; j++) {
            var mat = mesh["materials"][j];

            if (mats.indexOf(mat) == -1)
                mats.push(mat);
        }
    }

    return mats;
}

/** 
 * Return blender scene timeline's start/end frames
 */
exports.get_scene_timeline = function(scene) {
    var start = scene["frame_start"];
    var end = scene["frame_end"];

    return [start, end];
}


exports.setup_dim = function(width, height) {

    _canvas_width = width;
    _canvas_height = height;

    if (_active_scene)
        setup_scene_dim(_active_scene, width, height, false);
}

/**
 * Setup dimension for specific scene subscenes
 */
function setup_scene_dim(scene, width, height, override_update_dim) {

    var upd_cameras = scene["camera"]._render.cameras;
    for (var i = 0; i < upd_cameras.length; i++) {
        var cam = upd_cameras[i];
        m_cam.set_projection(cam, width/height);
    }

    // NOTE: temporary solution for frustum culling issue
    m_cam.update_camera_transform(scene["camera"]);

    var graph = scene._render.graph;

    m_scgraph.traverse_slinks(graph, function(slink, internal, subs1, subs2) {
        if (!override_update_dim && !slink.update_dim)
            return;

        var tex_width = slink.size_mult * width;
        var tex_height = slink.size_mult * height;

        if (internal) {
            for (var i = 0; i < subs1.slinks_internal.length; i++) {
                var slink_i = subs1.slinks_internal[i];
                if (slink_i == slink) {
                    var tex = subs1.textures_internal[i];
                    m_tex.resize(slink.texture, tex_width, tex_height);
                }
            }
        } else {
            if (m_tex.is_texture(slink.texture))
                m_tex.resize(slink.texture, tex_width, tex_height);

            // NOTE: needed in set_dof_params() and several other places
            var cam = subs1.camera;
            cam.width = tex_width;
            cam.height = tex_height;

            if (subs1.type == "DOF")
                set_dof_params(scene, {"dof_power": subs1.camera.dof_power,
                                        "dof_on": subs1.camera.dof_on});

            if (subs1.type == "ANTIALIASING")
                set_texel_size(subs1, 1/width/cfg_def.resolution_factor, 1/height/cfg_def.resolution_factor);
            else
                set_texel_size(subs1, 1/width, 1/height);
        }
    });
}

exports.set_texel_size = set_texel_size;
/**
 * Set texel size for batches on given subs
 * NOTE: remember about multiplier
 * @methodOf scenes
 */
function set_texel_size(subs, size_x, size_y) {
    var bundles = subs.bundles;

    for (var i = 0; i < bundles.length; i++) {
        var batch = bundles[i].batch;
        if (batch && batch.texel_size)
            m_batch.set_texel_size(batch, size_x, size_y);
    }
}

exports.subs_array = subs_array;
/**
 * Return subscene array matching types array
 * return only existing subscenes
 * @methodOf scenes
 */
function subs_array(scene, types) {
    var subscenes = [];
    var scene_subscenes = scene._render.graph;

    // in strict succession
    for (var i = 0; i < types.length; i++) {
        var type = types[i];

        m_graph.traverse(scene._render.graph, function(node, attr) {
            var subs = attr;

            if (subs.type == type)
                subscenes.push(subs);
        });
    }
    return subscenes;
}

exports.get_subs = get_subs;
/**
 * Return first subscene matching given type
 * @methodOf scenes
 */
function get_subs(scene, type) {
    var graph = scene._render.graph;
    return m_scgraph.find_subs(graph, type);
}

/**
 * Get horizon and zenith colors
 */
exports.get_environment_colors = function(scene) {

    var subs = subs_array(scene, LIGHT_SUBSCENE_TYPES)[0];

    var hor = subs.horizon_color;
    var zen = subs.zenith_color;

    var hor_dest = [];
    var zen_dest = [];

    hor_dest[0] = hor[0];
    hor_dest[1] = hor[1];
    hor_dest[2] = hor[2];

    zen_dest[0] = zen[0];
    zen_dest[1] = zen[1];
    zen_dest[2] = zen[2];

    return [subs.environment_energy, hor_dest, zen_dest];
}

exports.set_environment_colors = set_environment_colors;
/**
 * Set horizon and/or zenith color(s)
 */
function set_environment_colors(scene, opt_environment_energy, 
        opt_horizon_color, opt_zenith_color) {

    var subscenes = subs_array(scene, LIGHT_SUBSCENE_TYPES);
    
    for (var i = 0; i < subscenes.length; i++) {
        var subs = subscenes[i];

        if (!isNaN(opt_environment_energy)) {
            subs.environment_energy = opt_environment_energy;
        }

        if (opt_horizon_color) {
            subs.horizon_color[0] = opt_horizon_color[0];
            subs.horizon_color[1] = opt_horizon_color[1];
            subs.horizon_color[2] = opt_horizon_color[2];
        }

        if (opt_zenith_color) {
            subs.zenith_color[0] = opt_zenith_color[0];
            subs.zenith_color[1] = opt_zenith_color[1];
            subs.zenith_color[2] = opt_zenith_color[2];
        }
        subs.need_perm_uniforms_update = true;
    }
}

/**
 * Get sky params
 */
exports.get_sky_params = function(scene) {
    
    var subs = get_subs(scene, "SKY");
    if (subs) {
        var sky_params = {};
        sky_params["color"] = subs.sky_color;
        sky_params["rayleigh_brightness"] = subs.rayleigh_brightness;
        sky_params["mie_brightness"] = subs.mie_brightness;
        sky_params["spot_brightness"] = subs.spot_brightness;
        sky_params["scatter_strength"] = subs.scatter_strength;
        sky_params["rayleigh_strength"] = subs.rayleigh_strength;
        sky_params["mie_strength"] = subs.mie_strength;
        sky_params["rayleigh_collection_power"] = subs.rayleigh_collection_power;
        sky_params["mie_collection_power"] = subs.mie_collection_power;
        sky_params["mie_distribution"] = subs.mie_distribution;
        return sky_params;
    } else {
        return null;
    }
}

/**
 * Set sky params
 */
exports.set_sky_params = function(scene, sky_params) {

    var sky_subscenes = subs_array(scene, ["SKY"]);
    
    for (var i = 0; i < sky_subscenes.length; i++) {
        var subs = sky_subscenes[i];
        
        if ("color" in sky_params)
            subs.sky_color = sky_params["color"];

        if ("rayleigh_brightness" in sky_params)
            subs.rayleigh_brightness = sky_params["rayleigh_brightness"];

        if ("mie_brightness" in sky_params)
            subs.mie_brightness = sky_params["mie_brightness"];

        if ("spot_brightness" in sky_params)
            subs.spot_brightness = sky_params["spot_brightness"];

        if ("scatter_strength" in sky_params)
            subs.scatter_strength = sky_params["scatter_strength"];

        if ("rayleigh_strength" in sky_params)
            subs.rayleigh_strength = sky_params["rayleigh_strength"];

        if ("mie_strength" in sky_params)
            subs.mie_strength = sky_params["mie_strength"];

        if ("rayleigh_collection_power" in sky_params)
            subs.rayleigh_collection_power = sky_params["rayleigh_collection_power"];

        if ("mie_collection_power" in sky_params)
            subs.mie_collection_power = sky_params["mie_collection_power"];

        if ("mie_distribution" in sky_params)
            subs.mie_distribution = sky_params["mie_distribution"];
        
        subs.need_perm_uniforms_update = true;
        subs.need_fog_update = true;
        update_sky(get_active(), subs);
        m_render.draw(subs);
    }
}

/**
 * Get fog color and density
 */
exports.get_fog_color_density = function(scene, opt_dest) {

    var dest = opt_dest || [];

    var subs = subs_array(scene, FOG_SUBSCENE_TYPES)[0];
    
    var fcd = subs.fog_color_density;

    dest[0] = fcd[0];
    dest[1] = fcd[1];
    dest[2] = fcd[2];
    dest[3] = fcd[3];

    return dest;
}

/**
 * Set fog color and density
 */
exports.set_fog_color_density = function(scene, val) {

    var subscenes = subs_array(scene, FOG_SUBSCENE_TYPES);

    for (var i = 0; i < subscenes.length; i++) {
        var subs = subscenes[i];
        var fcd = subs.fog_color_density;
        fcd[0] = val[0];
        fcd[1] = val[1];
        fcd[2] = val[2];
        fcd[3] = val[3];
        subs.need_perm_uniforms_update = true;
    }
}

/**
 * Get ssao params
 */
exports.get_ssao_params = function(scene) {

    var subs = get_subs(scene, "SSAO");
    if (!subs)
        return null;

    var batch = subs.bundles[0].batch;

    var ssao_params = {};

    ssao_params["ssao_quality"] = m_batch.get_batch_directive(batch, "SSAO_QUALITY")[1];
    ssao_params["radius_increase"] = subs.ssao_radius_increase;
    ssao_params["dithering_amount"] = subs.ssao_dithering_amount;
    ssao_params["gauss_center"] = subs.ssao_gauss_center;
    ssao_params["gauss_width_square"] = subs.ssao_gauss_width_square;
    ssao_params["gauss_width_left_square"] = subs.ssao_gauss_width_left_square;
    ssao_params["influence"] = subs.ssao_influence;
    ssao_params["dist_factor"] = subs.ssao_dist_factor;
    ssao_params["ssao_only"] = subs.ssao_only;
    ssao_params["ssao_white"] = m_batch.get_batch_directive(batch, "SSAO_WHITE")[1];

    return ssao_params;
}

/**
 * Set ssao params
 */
exports.set_ssao_params = function(scene, ssao_params) {
    
    var subs = get_subs(scene, "SSAO");
    if (!subs) {
        m_print.error("SSAO is not enabled on scene");
        return 0;
    }
    
    if ("ssao_quality" in ssao_params) {
        var batch = subs.bundles[0].batch;
        m_batch.set_batch_directive(batch, "SSAO_QUALITY", ssao_params["ssao_quality"]);
        m_batch.update_shader(batch, true);
    }

    if ("ssao_radius_increase" in ssao_params)
        subs.ssao_radius_increase = ssao_params["ssao_radius_increase"];

    if ("ssao_dithering_amount" in ssao_params)
        subs.ssao_dithering_amount = ssao_params["ssao_dithering_amount"];

    if ("ssao_gauss_center" in ssao_params)
        subs.ssao_gauss_center = ssao_params["ssao_gauss_center"];

    if ("ssao_gauss_width_square" in ssao_params)
        subs.ssao_gauss_width_square = ssao_params["ssao_gauss_width_square"];

    if ("ssao_gauss_width_left_square" in ssao_params)
        subs.ssao_gauss_width_left_square = ssao_params["ssao_gauss_width_left_square"];

    if ("ssao_influence" in ssao_params)
        subs.ssao_influence = ssao_params["ssao_influence"];

    if ("ssao_dist_factor" in ssao_params)
        subs.ssao_dist_factor = ssao_params["ssao_dist_factor"];

    if ("ssao_only" in ssao_params) {
        var subs = get_subs(scene, "MAIN_OPAQUE");
        subs.ssao_only = ssao_params["ssao_only"];
        for (var i = 0; i < subs.bundles.length; i++) {
            var batch = subs.bundles[i].batch;
            m_batch.set_batch_directive(batch, "SSAO_ONLY", ssao_params["ssao_only"]);
            m_batch.update_shader(batch, true);
        }
    }

    if ("ssao_white" in ssao_params) {
        var batch = subs.bundles[0].batch;
        m_batch.set_batch_directive(batch, "SSAO_WHITE", ssao_params["ssao_white"]);
        m_batch.update_shader(batch, true);
    }

    subs.need_perm_uniforms_update = true;
}

exports.get_aa_params = function(scene) {

    var subs = get_subs(scene, "ANTIALIASING");
    if (!subs)
        return null;

    var batch = subs.bundles[0].batch;

    var aa_params = {};
    aa_params["aa_method"] = m_batch.get_batch_directive(batch, "AA_METHOD")[1];

    return aa_params;
}

exports.set_aa_params = function(scene, aa_params) {

    var subs = get_subs(scene, "ANTIALIASING");
    if (!subs) {
        m_print.error("AA is not enabled on scene");
        return 0;
    }

    var batch = subs.bundles[0].batch;

    if ("aa_method" in aa_params) {
        m_batch.set_batch_directive(batch, "AA_METHOD", aa_params["aa_method"]);
        m_batch.update_shader(batch, true);
    }
}

exports.get_dof_params = function(scene) {

    var subs = get_subs(scene, "DOF");
    if (!subs)
        return null;

    var dof_params = {};

    dof_params["dof_distance"] = subs.camera.dof_distance;
    dof_params["dof_front"] = subs.camera.dof_front;
    dof_params["dof_rear"] = subs.camera.dof_rear;
    dof_params["dof_power"] = subs.camera.dof_power;

    return dof_params;
}

exports.set_dof_params = set_dof_params;
function set_dof_params(scene, dof_params) {

    var subs = get_subs(scene, "DOF");
    if (!subs) {
        m_print.error("DOF is not enabled on scene. Check camera settings");
        return 0;
    }

    var graph = scene._render.graph;

    if ("dof_on" in dof_params)
        subs.camera.dof_on = parseFloat(dof_params["dof_on"]);
    if ("dof_distance" in dof_params)
        subs.camera.dof_distance = dof_params["dof_distance"];
    if ("dof_front" in dof_params)
        subs.camera.dof_front = dof_params["dof_front"];
    if ("dof_rear" in dof_params)
        subs.camera.dof_rear = dof_params["dof_rear"];
    if ("dof_power" in dof_params) {
        subs.camera.dof_power = dof_params["dof_power"];
        var subs_pp1 = m_scgraph.find_input(graph, subs, "POSTPROCESSING");
        var subs_pp2 = m_scgraph.find_input(graph, subs_pp1, "POSTPROCESSING");
        var subs_in = [subs_pp1, subs_pp2];
        for (var i = 0; i < subs_in.length; i++) {
            var bundles = subs_in[i].bundles;
            var batch = bundles[0].batch;
            if (batch && batch.texel_size) {
                m_batch.set_texel_size_mult(batch, subs.camera.dof_power);
                set_texel_size(subs_in[i], 1/subs.camera.width, 
                                           1/subs.camera.height);
            }
        }
    }
    subs.need_perm_uniforms_update = true;
}

exports.get_god_rays_params = function(scene) {

    var gr_subs = subs_array(scene, ["GOD_RAYS"]);
    var combo_subs = get_subs(scene, "GOD_RAYS_COMBINE");

    if (!gr_subs || !combo_subs)
        return null;

    var god_rays_params = {};

    god_rays_params["god_rays_max_ray_length"] = gr_subs[0].max_ray_length;
    god_rays_params["god_rays_intensity"] = combo_subs.god_rays_intensity;

    var batch = gr_subs[0].bundles[0].batch;
    god_rays_params["god_rays_steps"] = m_batch.get_batch_directive(batch, "STEPS_PER_PASS")[1];

    return god_rays_params;
}

exports.set_god_rays_params = function(scene, god_rays_params) {

    var gr_subs = subs_array(scene, ["GOD_RAYS"]);
    var combo_subs = get_subs(scene, "GOD_RAYS_COMBINE");

    if (!gr_subs || !combo_subs) {
        m_print.error("God Rays are not enabled on scene");
        return 0;
    }

    if ("god_rays_intensity" in god_rays_params)
        combo_subs.god_rays_intensity = god_rays_params["god_rays_intensity"];
    if ("god_rays_max_ray_length" in god_rays_params) {
        var r_length = god_rays_params["god_rays_max_ray_length"];
        for (var i = 0; i < gr_subs.length; i++) {
            gr_subs[i].max_ray_length = r_length;
            gr_subs[i].radial_blur_step = r_length / gr_subs[i].steps_per_pass / (i + 1);
            gr_subs[i].need_perm_uniforms_update = true;
        }
    }
    if ("god_rays_steps" in god_rays_params) {

        var steps = m_shaders.glsl_value(god_rays_params["god_rays_steps"], 1);
        var r_length = gr_subs[0].max_ray_length

        for (var i = 0; i < gr_subs.length; i++) {
            gr_subs[i].steps_per_pass = steps;
            gr_subs[i].radial_blur_step = r_length / steps / (i + 1);
            gr_subs[i].need_perm_uniforms_update = true;

            var batch = gr_subs[i].bundles[0].batch;
            m_batch.set_batch_directive(batch, "STEPS_PER_PASS", steps);
            m_batch.update_shader(batch, true);
        }
    }
    combo_subs.need_perm_uniforms_update = true;
}

exports.get_bloom_params = function(scene) {

    var lum_subs = get_subs(scene, ["LUMINANCE_TRUNCED"]);
    var bloom_subs = get_subs(scene, "BLOOM");

    if (!lum_subs || !bloom_subs) {
        return null;
    }

    var bloom_params = {};

    bloom_params["bloom_key"] = lum_subs.bloom_key;
    bloom_params["bloom_edge_lum"] = lum_subs.bloom_edge_lum;
    bloom_params["bloom_blur"] = bloom_subs.bloom_blur;

    return bloom_params;
}

exports.set_bloom_params = function(scene, bloom_params) {

    var lum_subs = get_subs(scene, "LUMINANCE_TRUNCED");
    var bloom_subs = get_subs(scene, "BLOOM");

    if (!lum_subs || !bloom_subs) {
        m_print.error("Bloom is not enabled on scene");
        return 0;
    }

    if ("bloom_key" in bloom_params) {
        lum_subs.bloom_key = bloom_params["bloom_key"];
        lum_subs.need_perm_uniforms_update = true;
    }
    if ("bloom_edge_lum" in bloom_params) {
        lum_subs.bloom_edge_lum = bloom_params["bloom_edge_lum"];
        lum_subs.need_perm_uniforms_update = true;
    }
    if ("bloom_blur" in bloom_params) {
        var graph = scene._render.graph;
        var subs_blur1 = m_scgraph.find_input(graph, bloom_subs, "BLOOM_BLUR");
        var subs_blur2 = m_scgraph.find_input(graph, subs_blur1, "BLOOM_BLUR");
        var subs_in = [subs_blur1, subs_blur2];
        for (var i = 0; i < subs_in.length; i++) {
            var bundles = subs_in[i].bundles;
            var batch = bundles[0].batch;
            if (batch && batch.texel_size) {
                m_batch.set_texel_size_mult(batch, bloom_params["bloom_blur"]);
                set_texel_size(subs_in[i], 1/bloom_subs.camera.width, 
                                           1/bloom_subs.camera.height);
            }
        }
    }
}

exports.get_wind_params = function() {
    var wind = m_particles.wind();
    var length = m_vec3.length(wind); 

    if (length == 0)
        return null;

    var angle = Math.atan(wind[0]/wind[2]) * 180 / Math.PI;

    var wind_params = {};
    wind_params["wind_dir"] = angle;
    wind_params["wind_strength"] = length;

    return wind_params;
}

exports.set_wind_params = function(scene, wind_params) {

    // get wind object
    var objs = get_scene_objs(scene);
    for (var i = 0; i < objs.length; i++) {
        var obj = objs[i];
        if (obj.type === "EMPTY" && obj["field"] 
                                 && obj["field"]["type"] === "WIND") {
            var wind_obj = obj;
        }
    }

    if (!wind_obj) {
        m_print.error("There is no wind on the scene");
        return 0;
    }

    var wind_render = wind_obj._render;
    if ("wind_dir" in wind_params) {
        var angle =  (wind_params["wind_dir"]) / 180 * Math.PI;

        // New rotation
        _vec3_tmp = [0, angle, -Math.PI / 2];
        m_util.euler_to_quat(_vec3_tmp, _quat4_tmp);

        wind_render.quat[0] = _quat4_tmp[0];
        wind_render.quat[1] = _quat4_tmp[1];
        wind_render.quat[2] = _quat4_tmp[2];
        wind_render.quat[3] = _quat4_tmp[3];
        m_particles.update_force(wind_obj); 
    }

    if ("wind_strength" in wind_params) {
        wind_render.force_strength = wind_params["wind_strength"];
        m_particles.update_force(wind_obj); 
    }
    update_scene_permanent_uniforms(scene);
}

exports.schedule_grass_map_update = schedule_grass_map_update;
/**
 * Schedule update of grass subscenes on given bpy scene.
 * @methodOf scenes
 */
function schedule_grass_map_update(bpy_scene) {
    bpy_scene._render.need_grass_map_update = true;
}

/**
 * Get water surface level
 * @methodOf scenes
 */
exports.get_water_surface_level = function(pos_x, pos_z) {

    var subs = get_subs(_active_scene, "MAIN_OPAQUE");

    if (!subs || !subs.water_params) {
        m_print.error("get_water_surface_level() - no water parameters on this scene");
        return 0;
    }

    var waves_height = subs.water_waves_height;
    var waves_length = subs.water_waves_length;
    var water_level  = subs.water_level;

    var wp = subs.water_params;

    if (!waves_height || !wp.dynamic)
        return wp.water_level;

    var wind_str = m_vec3.length(subs.wind);
    var time = subs.time;
    if (!time)
        time = 0;
    if (wind_str)
        time *= wind_str;

    // small waves
    var cellular_coords = _vec2_tmp;
    cellular_coords[0] = 20.0 / waves_length * (pos_x - 0.25 * time);
    cellular_coords[1] = 20.0 / waves_length * (pos_z - 0.25 * time);
    var cellular1 = m_util.cellular2x2(cellular_coords);
    cellular_coords[0] = 17.0 / waves_length * (pos_z + 0.1  * time);
    cellular_coords[1] = 17.0 / waves_length * (pos_x + 0.1  * time);
    var cellular2 = m_util.cellular2x2(cellular_coords);
    var small_waves = cellular1 + cellular2 - 1;

    // distant waves (only noise)
    var dst_noise_scale0  = wp.dst_noise_scale0;
    var dst_noise_scale1  = wp.dst_noise_scale1;
    var dst_noise_freq0   = wp.dst_noise_freq0;
    var dst_noise_freq1   = wp.dst_noise_freq1;

    var noise_coords = _vec2_tmp;

    noise_coords[0] = dst_noise_scale0 * (pos_x + dst_noise_freq0 * time);
    noise_coords[1] = dst_noise_scale0 * (pos_z + dst_noise_freq0 * time);
    var noise1 = m_util.snoise(noise_coords);

    noise_coords[0] = dst_noise_scale1 * (pos_z - dst_noise_freq1 * time);
    noise_coords[1] = dst_noise_scale1 * (pos_x - dst_noise_freq1 * time);
    var noise2 = m_util.snoise(noise_coords);
    var dist_waves = waves_height * noise1 * noise2;

    if (subs.shoremap_image) {
        // waves moving towards the shore

        // center and size of shore distance field
        var size_x = subs.shoremap_size[0];
        var size_z = subs.shoremap_size[1];
        var center_x = subs.shoremap_center[0];
        var center_z = subs.shoremap_center[1];

        // get uv coords on shore distance map
        var x = (pos_x - center_x) / size_x;
        var z = (center_z + pos_z) / size_z;
        x += 0.5;
        z += 0.5;

        // if position is out of boundings, consider that shore dist = 1
        if (x > 1 || x < 0 || z > 1 || z < 0) {
            var wave_height = dist_waves;
        } else {
            var width = subs.shoremap_tex_size;
            var array = _active_scene._render.shore_distances;
            var shore_dist = m_util.get_array_smooth_value(array, width, x, z);
            var dir_min_shore_fac = wp.dir_min_shore_fac;
            var dir_freq          = wp.dir_freq;
            var dir_noise_scale   = wp.dir_noise_scale;
            var dir_noise_freq    = wp.dir_noise_freq;
            var dir_min_noise_fac = wp.dir_min_noise_fac;
            var dst_min_fac       = wp.dst_min_fac;
            var waves_hor_fac     = wp.waves_hor_fac;

            var max_shore_dist = subs.max_shore_dist;
            var shore_waves_length = waves_length / max_shore_dist / Math.PI;
            // waves moving towards the shore
            var waves_coords = [dir_noise_scale / waves_length * (pos_x + dir_noise_freq * time),
                                dir_noise_scale / waves_length * (pos_z + dir_noise_freq * time)];

            var dist_fact = Math.sqrt(shore_dist);
            var shore_dir_waves = waves_height * Math.max(shore_dist, dir_min_shore_fac)
                    * Math.sin((dist_fact / shore_waves_length + dir_freq * time))
                    * Math.max( m_util.snoise(waves_coords), dir_min_noise_fac );
            // mix two types of waves basing on distance to the shore
            var mix_rate = Math.max(dist_fact, dst_min_fac);
            var wave_height = shore_dir_waves * (1 - mix_rate) + dist_waves * mix_rate;
            small_waves *= shore_dist;
        }
    } else
        var wave_height = dist_waves;

    wave_height += 0.05 * small_waves;
    var cur_water_level = water_level + wave_height;
    return cur_water_level;
}

exports.get_water_mat_params = function(scene, water_params) {

    var subs = get_subs(scene, "MAIN_OPAQUE");

    if (!subs)
        return;

    water_params["waves_height"] = subs.water_waves_height;
    water_params["waves_length"] = subs.water_waves_length;

    if (subs.water_fog_color_density){
        water_params["water_fog_density"] = subs.water_fog_color_density[3];
        var wfc = water_params["water_fog_color"] = [];
        wfc[0]  = subs.water_fog_color_density[0];
        wfc[1]  = subs.water_fog_color_density[1];
        wfc[2]  = subs.water_fog_color_density[2];
    }
}

exports.set_water_params = function(scene, water_params) {

    var subs = get_subs(scene, "MAIN_OPAQUE");

    if (!subs || !subs.water_params) {
        m_print.error("set_water_params() - no water parameters on this scene");
        return null;
    }

    var wp = subs.water_params;

    if ("dst_noise_scale0"    in water_params)
        wp.dst_noise_scale0   = water_params["dst_noise_scale0"];
    if ("dst_noise_scale1"    in water_params)
        wp.dst_noise_scale1   = water_params["dst_noise_scale1"];
    if ("dst_noise_freq0"     in water_params)
        wp.dst_noise_freq0    = water_params["dst_noise_freq0"];
    if ("dst_noise_freq1"     in water_params)
        wp.dst_noise_freq1    = water_params["dst_noise_freq1"];
    if ("dir_min_shore_fac"   in water_params)
        wp.dir_min_shore_fac  = water_params["dir_min_shore_fac"];
    if ("dir_freq"            in water_params)
        wp.dir_freq           = water_params["dir_freq"];
    if ("dir_noise_scale"     in water_params)
        wp.dir_noise_scale    = water_params["dir_noise_scale"];
    if ("dir_noise_freq"      in water_params)
        wp.dir_noise_freq     = water_params["dir_noise_freq"];
    if ("dir_min_noise_fac"   in water_params)
        wp.dir_min_noise_fac  = water_params["dir_min_noise_fac"];
    if ("dst_min_fac"         in water_params)
        wp.dst_min_fac        = water_params["dst_min_fac"];
    if ("waves_hor_fac"       in water_params)
        wp.waves_hor_fac      = water_params["waves_hor_fac"];
    if("water_dynamic"        in water_params)
        wp.dynamic            = water_params["water_dynamic"];

    var subscenes = subs_array(scene, MAIN_SUBSCENE_TYPES);

    for (var i = 0; i < subscenes.length; i++) {
        var sub = subscenes[i];

        if ("water_fog_density" in  water_params && wp.fog_color_density)
            sub.water_fog_color_density[3] = water_params["water_fog_density"];

        if ("water_fog_color" in  water_params && wp.fog_color_density) {
            sub.water_fog_color_density[0] = water_params["water_fog_color"][0];
            sub.water_fog_color_density[1] = water_params["water_fog_color"][1];
            sub.water_fog_color_density[2] = water_params["water_fog_color"][2];
        }

        if ("waves_height" in water_params)
            sub.water_waves_height = water_params["waves_height"];

        if ("waves_length" in water_params)
            sub.water_waves_length = water_params["waves_length"];

        sub.need_perm_uniforms_update = true;
    }
}

exports.get_shore_dist = function(trans, v_dist_mult) {
    var subs = get_subs(_active_scene, "MAIN_OPAQUE");

    if (!subs.shoremap_image)
        return SHORE_DIST_COMPAT;

    // center and size of shore distance field
    var size_x = subs.shoremap_size[0];
    var size_z = subs.shoremap_size[1];
    var center_x = subs.shoremap_center[0];
    var center_z = subs.shoremap_center[1];
    var max_shore_dist = subs.max_shore_dist;

    var water_level = subs.water_level;

    // get uv coords on shore distance map
    var x = (trans[0] - center_x) / size_x;
    var z = (center_z + trans[2]) / size_z;
    x += 0.5;
    z += 0.5;
    
    // if position is out of boundings, consider that shore dist = 1
    if (x > 1 || x < 0 || z > 1 || z < 0) {
        var shore_dist = 1.0;
    } else {
        var width = subs.shoremap_tex_size;
        var array = _active_scene._render.shore_distances;
        var shore_dist_xz = max_shore_dist * m_util.get_array_smooth_value(array, width, x, z);
        var shore_dist_y  = (water_level - trans[1]) * v_dist_mult;

        var shore_dist = Math.sqrt(shore_dist_xz * shore_dist_xz +
                shore_dist_y * shore_dist_y);
        return shore_dist;
    }
}

/**
 * Executed every frame
 * update all scenes
 */
exports.update = function(timeline, elapsed) {

    // update subscene params (uniforms)
    for (var i = 0; i < _scenes.length; i++) {
        var scene = _scenes[i];
        var graph = scene._render.graph;

        if (scene._render.water_params) {
            var camera_render = get_active()["camera"]._render;
            var cam_water_depth = camera_render.trans[1]
                 - exports.get_water_surface_level( camera_render.trans[0],
                                                    camera_render.trans[2]);
        }

        m_graph.traverse(graph, function(node, attr) {
            var subs = attr;
            if (TIME_SUBSCENE_TYPES.indexOf(subs.type) > -1) {
                subs.time = timeline;
            }
            if (MAIN_SUBSCENE_TYPES.indexOf(subs.type) > -1
                    && scene._render.water_params){
                subs.cam_water_depth = cam_water_depth;
            }
        });
    }

    // update glow animation
    if (cfg_def.deferred_rendering) {
        for (var i = 0; i < _glow_anim_objs.length; i++) {
            var obj = _glow_anim_objs[i];
            update_obj_glow_intensity(obj, timeline);
        }
    }

    // rendering
    for (var i = 0; i < _scenes.length; i++) {
        var scene = _scenes[i];
        var render = scene._render;

        // just before rendering
        if (render.need_shadow_update) {
            update_shadow_subscenes(scene);
            render.need_shadow_update = false;
        }

        // just before rendering
        if (render.need_grass_map_update) {
            update_subs_grass_map(scene);
            render.need_grass_map_update = false;
        }

        // check if rendering needed
        if (!render.queue.length)
            continue;

        if (scene["b4w_enable_motion_blur"]) {
            update_motion_blur_subscenes(render.graph, elapsed);
        }

        // render glow animation
        if (cfg_def.deferred_rendering && render.selectability) {
            var subs_glow_mask = get_subs(scene, "GLOW_MASK");
            var bundles = subs_glow_mask.bundles;

            var summ_intensity = 0;
            for (var j = 0; j < bundles.length; j++)
                summ_intensity += bundles[j].batch.glow_intensity;

            m_graph.traverse(scene._render.graph, function(node, attr) {
                if (attr.type === "GLOW")
                    attr.draw_glow_flag = summ_intensity;
            });

        }

        var queue = render.queue;
        var glow_mask_subs_index = null;
        for (var i = 0; i < queue.length; i++)
            if (queue[i].type == "GLOW_MASK") {
                glow_mask_subs_index = i;
                break;
            }

        for (var j = 0; j < queue.length; j++) {
            var qsubs = queue[j];

            if (glow_mask_subs_index !== null)
                optimize_glow_postprocessing(render.graph, qsubs, queue[glow_mask_subs_index])
        }

        for (var j = 0; j < queue.length; j++) {
            var qsubs = queue[j];
            m_prerender.prerender_subs(qsubs);
            m_render.draw(qsubs);
        }
    }

    if (cfg_def.show_hud_debug_info)
        m_hud.show_debug_info(_scenes, elapsed);
}

function optimize_glow_postprocessing(graph, qsubs, glow_mask_subs) {
    if (glow_mask_subs.do_render != qsubs.do_render) {

        if (qsubs.type == "POSTPROCESSING" && qsubs.is_for_glow) {
            qsubs.do_render = glow_mask_subs.do_render;
        } else if (qsubs.type == "GLOW") {
            var id = m_graph.node_by_attr(graph, qsubs);

            var subs_in = null;
            var id_in = null;
            var slink_in = null;

            var subs_out_arr = [];
            var id_out_arr = [];
            var slink_out_arr = [];

            var slink_around_arr = [];

            m_graph.traverse_inputs(graph, id, function(node_in, attr_in, attr_edge) {
                if (attr_in.type != "GLOW_MASK" && !attr_in.is_for_glow) {
                    subs_in = attr_in;
                    id_in = node_in;
                    slink_in = attr_edge;
                    return true;
                }
            });

            m_graph.traverse_outputs(graph, id, function(node_out, attr_out, attr_edge) {
                subs_out_arr.push(attr_out);
                id_out_arr.push(node_out);
                slink_out_arr.push(attr_edge);
            });

            if (!subs_in || !subs_out_arr.length)
                throw "Failed to define glow environment";

            // NOTE: keep GLOW subscene on
            for (var i = 0; i < slink_out_arr.length; i++)
                if (slink_out_arr[i].from == "SCREEN")
                    return;

            for (var i = 0; i < slink_out_arr.length; i++)
                m_graph.traverse_inputs(graph, id_out_arr[i], 
                        function(node_in, attr_in, attr_edge) {
                    if (node_in == id_in) {
                        slink_around_arr.push(attr_edge);
                        return true;
                    }
                });

            qsubs.do_render = glow_mask_subs.do_render;

            if (!_tex_glow_input)
                _tex_glow_input = qsubs.do_render ?
                        subs_in.camera.color_attachment : slink_around_arr[0].texture;

            if (qsubs.do_render) {
                var tex = subs_in.camera.color_attachment;

                slink_in.active = true;

                for (var i = 0; i < slink_out_arr.length; i++) {
                    slink_out_arr[i].active = true;
                    slink_around_arr[i].active = false;
                }

                replace_attachment(graph, id_in, slink_in.from, _tex_glow_input);

                for (var i = 0; i < slink_out_arr.length; i++)
                    replace_texture(graph, id_out_arr[i], slink_out_arr[i].to,
                            slink_out_arr[i].texture);

                _tex_glow_input = tex;
            } else {
                var tex = subs_in.camera.color_attachment;

                slink_in.active = false;
                for (var i = 0; i < slink_out_arr.length; i++) {
                    slink_out_arr[i].active = false;
                    slink_around_arr[i].active = true;
                }

                replace_attachment(graph, id_in, slink_in.from, _tex_glow_input);

                _tex_glow_input = tex;
            }
        }
    }
}

function slink_switch_active(graph, id1, id2, slink, active) {
    if (slink.active == active)
        return;

    if (slink.active) {
        replace_attachment(graph, id1, slink.from, null);
        replace_texture(graph, id2, slink.to, null);
    } else {
        replace_attachment(graph, id1, slink.from, slink.texture);
        replace_texture(graph, id2, slink.to, slink.texture);
    }

    slink.active = active;
}

function replace_attachment(graph, id, type, tex) {
    var subs = m_graph.get_node_attr(graph, id);
    m_cam.set_attachment(subs.camera, type, tex);

    // TODO: assign now, not every frame
    subs.assign_texture = true;

    // replace linked textures
    m_graph.traverse_outputs(graph, id, function(id_out, attr_out,
            attr_edge) {

        var slink = attr_edge;
        if (slink.active && slink.from == type &&
                m_scgraph.check_slink_tex_conn(slink))
            replace_texture(graph, id_out, slink.to, tex);
    });

    // NOTE: bottom-up only
    m_graph.traverse_inputs(graph, id, function(id_in, attr_in,
            attr_edge) {

        var slink = attr_edge;
        if (slink.active && slink.from == type && slink.from == slink.to)
            replace_attachment(graph, id_in, type, tex);
    });
}

function replace_texture(graph, id, name, tex) {
    var subs = m_graph.get_node_attr(graph, id);

    var bundles = subs.bundles;
    for (var i = 0; i < bundles.length; i++) {
        var batch = bundles[i].batch;
        m_batch.replace_texture(batch, tex, name);
    }
}


/**
 * Update position of grass map camera.
 */
function update_subs_grass_map(bpy_scene) {

    var subs_grass_map = get_subs(bpy_scene, "GRASS_MAP");
    if (subs_grass_map) {
        var cam = subs_grass_map.camera;

        var camera_render = bpy_scene["camera"]._render;
        var camera_trans = camera_render.trans;

        // calculate grass map center point position relative to camera position
        var trans = _vec3_tmp;
        trans[0] = 0;
        trans[1] = -subs_grass_map.grass_map_dim[2] / 2;
        trans[2] = 0;
        m_vec3.transformQuat(trans, camera_render.quat, trans);

        // XZ plane
        trans[0] += camera_trans[0];
        trans[1] = 0;
        trans[2] += camera_trans[2];

        // no rotation camera looks down
        var quat = _quat4_tmp;
        quat[0] = 0;
        quat[1] = 0;
        quat[2] = 0;
        quat[3] = 1;

        m_cam.set_view_trans_quat(cam, trans, quat);
    }
}


function update_motion_blur_subscenes(graph, elapsed) {

    m_graph.traverse(graph, function(id, attr) {
        var subs = attr;

        if (subs.type != "MOTION_BLUR")
            return;
        
        if (!subs.slinks_internal[0] || !subs.textures_internal[0])
            throw "Wrong MOTION_BLUR subscene";

        var slink = subs.slinks_internal[0];
        var tex = subs.textures_internal[0];

        subs.textures_internal[0] = subs.camera.color_attachment;

        // next subscene may use same texture as input
        m_graph.traverse_outputs(graph, id, function(id_out, attr_out, attr_edge) {
            var subs_out = attr_out;
            var slink_out = attr_edge;

            if (slink_out.active)
                replace_texture(graph, id_out, slink_out.to, tex);
        });

        replace_attachment(graph, id, slink.from, tex);
        replace_texture(graph, id, slink.to, subs.textures_internal[0]);
        subs.motion_blur_exp = Math.exp(-elapsed/subs.mb_factor);
    });
}

function update_obj_glow_intensity(obj, timeline) {
    var glow_intensity = 0;    
    var ga_settings = obj._glow_anim;
    if (ga_settings.time_start == 0)
        ga_settings.time_start = timeline;

    var dt = timeline - ga_settings.time_start;
    if (ga_settings.relapses && dt / ga_settings.period >= ga_settings.relapses) {
        exports.clear_glow_anim(obj);
        return;
    }

    var periodic_time = dt % ga_settings.period;
    if (periodic_time < ga_settings.glow_time) {
        var glow_time = periodic_time / (ga_settings.glow_time / 5);
        var stage = Math.floor(glow_time);

        switch (stage) {
        case 0:
            glow_intensity = (glow_time - stage) / 2;
            break;
        case 1:
            glow_intensity = (glow_time - stage) / 2 + 0.5;
            break;
        case 2:
            glow_intensity = 1;
            break;
        case 3:
            glow_intensity = 1 - (glow_time - stage) / 2;
            break;
        case 4:
            glow_intensity = 0.5 - (glow_time - stage) / 2;
            break;
        }
    }

    for (var i = 0; i < obj._batch_slots.length; i++) {
        var slot = obj._batch_slots[i];

        if (slot.batch.type == "COLOR_ID" 
                && typeof slot.batch.glow_intensity !== "undefined")
            slot.batch.glow_intensity = glow_intensity;
    }
}

exports.get_all_subscenes = function(scene) {
    var graph = scene._render.graph;

    var subscenes = [];
    m_graph.traverse(graph, function(node, attr) {
        subscenes.push(attr);
    });

    return subscenes;
}

exports.apply_glow_anim = function(obj, tau, T, N) {
    obj._glow_anim = {
        time_start: 0,
        glow_time: tau,
        period: T,
        relapses: N
    }
    _glow_anim_objs.push(obj);
}

exports.clear_glow_anim = function(obj) {
    for (var i = 0; i < obj._batch_slots.length; i++) {
        var slot = obj._batch_slots[i];
        if (slot.batch.type == "COLOR_ID" 
                && typeof slot.batch.glow_intensity !== "undefined")
            slot.batch.glow_intensity = 0;
    }

    var ind = _glow_anim_objs.indexOf(obj);
    if (ind != -1)
        _glow_anim_objs.splice(ind, 1);
}

exports.cleanup_glow_anim = function() {
    _glow_anim_objs = [];
}

exports.get_cam_water_depth = function() {
    var subs = get_subs(_active_scene, "MAIN_BLEND");
    var scene = _active_scene;

    if (!subs && !scene._render.water_params)
        return null;

    return subs.cam_water_depth;
}

exports.update_scene_permanent_uniforms = update_scene_permanent_uniforms;
function update_scene_permanent_uniforms(scene) {
    var graph = scene._render.graph;

    m_graph.traverse(graph, function(node, subs){
        subs.need_perm_uniforms_update = true;
    });
}

exports.set_wireframe_mode = function(subs_wireframe, mode) {
    switch (mode) {
    case "WM_NONE":
        subs_wireframe.do_render = false;
        break;
    case "WM_OPAQUE_WIREFRAME":
    case "WM_TRANSPARENT_WIREFRAME":
    case "WM_FRONT_BACK_VIEW":
    case "WM_DEBUG_SPHERES":
        for (var i = 0; i < subs_wireframe.bundles.length; i++) {
            var batch = subs_wireframe.bundles[i].batch;
            batch.wireframe_mode = m_dbg.WIREFRAME_MODES[mode];
        }
        subs_wireframe.do_render = true;
        break;
    }
    subs_wireframe.blend = (mode == "WM_TRANSPARENT_WIREFRAME");
    subs_wireframe.need_perm_uniforms_update = true;
}

exports.set_wireframe_edge_color = function(subs_wireframe, color) {
    for (var i = 0; i < subs_wireframe.bundles.length; i++) {
        var batch = subs_wireframe.bundles[i].batch;
        batch.wireframe_edge_color = color;
        subs_wireframe.need_perm_uniforms_update = true;
    }
}

}
