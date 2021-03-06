"use strict";

/**
 * Batch internal API.
 * @name batch
 * @namespace
 * @exports exports as batch
 */
b4w.module["__batch"] = function(exports, require) {

var boundings  = require("__boundings");
var config     = require("__config");
var m_print    = require("__print");
var extensions = require("__extensions");
var geometry   = require("__geometry");
var m_graph    = require("__graph");
var nodemat    = require("__nodemat");
var particles  = require("__particles");
var primitives = require("__primitives");
var scenegraph = require("__scenegraph");
var shaders    = require("__shaders");
var m_textures = require("__textures");
var m_tsr      = require("__tsr");
var util       = require("__util");

var m_vec3 = require("vec3");
var m_quat = require("quat");

var cfg_def = config.defaults;
var cfg_scs = config.scenes;

var DEBUG_SAVE_SUBMESHES = false;
var DEBUG_KEEP_BUFS_DATA_ARRAYS = false;

var BATCH_TYPES_DEBUG_SPHERE = ["MAIN", "NODES", "SHADELESS"];
var STREE_CELL_COUNT = 20;

/**
 * Create abstract batch
 * @param type Batch type: MAIN, SHADOW,...
 */
function init_batch(type) {

    var batch = {
        type: type,

        textures: [],
        texture_names: [],
        common_attributes: [],
        uv_maps_usage: {},

        // mandatory
        shaders_info: null,
        node_elements: null,

        num_vertices: 0,
        num_triangles: 0,
        color_mask: true,
        depth_mask: true,
        use_backface_culling: false,

        // ?
        draw_mode: geometry.DM_DEFAULT,
        
        // not mandatory
        blend: false,
        diffuse_color: new Float32Array([0,0,0,1]),
        zsort_type: geometry.ZSORT_DISABLED
    }

    batch.vertex_colors_usage = {};
    return batch;
}

/**
 * Generate object batches for graph subscenes.
 */
exports.generate_main_batches = function(graph, grid_size, scene_objects, bpy_data) {

    for (var i = 0; i < scene_objects.length; i++) {
        var sobj = scene_objects[i];

        if (sobj._render.type == "DYNAMIC") {

            var render = sobj._render;

            // local/world bounding box
            var bb_local = bb_bpy_to_b4w(sobj["data"]["b4w_bounding_box"]);
            render.bb_local = bb_local;

            var cyl_radius = sobj["data"]["b4w_bounding_cylinder_radius"];
            set_local_cylinder_capsule(render, cyl_radius, cyl_radius, bb_local);
            
            var bb_world = boundings.bounding_box_transform(bb_local, 
                    render.world_matrix);
            render.bb_world = bb_world;

            // bounding sphere
            var bs_local = {
                radius: sobj["data"]["b4w_bounding_sphere_radius"],
                center: sobj["data"]["b4w_bounding_sphere_center"]
            };
            render.bs_local = bs_local;

            var bs_world = boundings.bounding_sphere_transform(bs_local,
                    render.world_matrix);
            render.bs_world = bs_world;

            // bounding ellipsoid
            var be_axes = sobj["data"]["b4w_bounding_ellipsoid_axes"];
            var be_local = {
                axis_x: new Float32Array([be_axes[0], 0, 0]),
                axis_y: new Float32Array([0, be_axes[1], 0]),
                axis_z: new Float32Array([0, 0, be_axes[2]]),
                center: sobj["data"]["b4w_bounding_ellipsoid_center"]
            };
            render.be_local = be_local;

            var be_world = boundings.bounding_ellipsoid_transform(be_local, render.tsr);
            render.be_world = be_world;

            var batch_slots = make_dynamic_batches(sobj, sobj._render, graph, true);
            sobj._batch_slots = batch_slots;

            // generate debug volumes
            if (cfg_def.wireframe_debug) {
                var add_debug_sphere = false;
                for (var j = 0; j < sobj._batch_slots.length; j++) {
                    var obj_batch = sobj._batch_slots[j].batch;
                    if (BATCH_TYPES_DEBUG_SPHERE.indexOf(obj_batch.type) > -1) {
                        add_debug_sphere = true;
                        break;
                    }
                }
                if (add_debug_sphere) {
                    var slot = {};
                    var batch = create_bounding_ellipsoid_batch(render.be_local, sobj, true);
                    batch.debug_sphere_dynamic = true;
                    update_batch_render(batch, render);

                    slot.batch = batch;
                    sobj._batch_slots.push(slot);
                }
            }
            //prepare_line_batches(sobj);
        }
    }

    // prepare batches for static objects

    var scene_batch_objects = [];
    for (var i = 0; i < scene_objects.length; i++) {
        var sobj = scene_objects[i];
        if (sobj._render.type == "STATIC")
            scene_batch_objects.push(sobj);
    }

    var baskets = create_batch_object_baskets(scene_batch_objects, grid_size);
    var meshes = bpy_data["meshes"];

    for (var i = 0; i < baskets.length; i++) {
        var render = baskets[i].render;
        var objs = baskets[i].objects;

        make_static_batches(objs, render, meshes, graph);

        // assign new static object render
        for (var j = 0; j < objs.length; j++) {
            // save
            objs[j]._dyn_render = objs[j]._render;
            // replace
            objs[j]._render = render;
        }
    }
}

/** 
 * Update local cylinder and capsule boundings
 */
function set_local_cylinder_capsule(render, cyl_radius, cap_radius, bb_local) {
    render.bcyl_local = boundings.create_bounding_cylinder(cyl_radius, bb_local);
    render.bcap_local = boundings.create_bounding_capsule(cap_radius, bb_local);
    render.bcon_local = boundings.create_bounding_cone(cyl_radius, bb_local);
}

exports.wb_angle_to_amp = wb_angle_to_amp;
function wb_angle_to_amp(angle, bbox, scale) {
    if (bbox) {
        var height = scale * (bbox.max_y - bbox.min_y);
    } else {
        var height = 1;
        throw "No bounding box for mesh";
    }

    if (height == 0)
        return 0;

    var delta = height * Math.tan(angle/180 * Math.PI);

    // root for equation: delta = (amp+1)^4 - (amp+1)^2
    var amp = Math.sqrt(2*Math.sqrt(4*delta+1)+2) / 2 - 1;

    return 0.5 * amp / height; // moved 0.5 from shader
}


exports.bb_bpy_to_b4w = bb_bpy_to_b4w;
function bb_bpy_to_b4w(bpy_bb) {

    var max_x = bpy_bb["max_x"];
    var max_y = bpy_bb["max_y"];
    var max_z = bpy_bb["max_z"];
    var min_x = bpy_bb["min_x"];
    var min_y = bpy_bb["min_y"];
    var min_z = bpy_bb["min_z"];

    var bb = {
        max_x: max_x,
        min_x: min_x,
        max_y: max_y,
        min_y: min_y,
        max_z: max_z,
        min_z: min_z
    };

    return bb;
}

/**
 * Create all possible batches for dynamic object
 * slots actually
 */
function make_dynamic_batches(obj, render, graph, process_geometry) {
    var slots = [];

    // perform some object culling
    
    if (obj["b4w_do_not_render"])
        return slots;

    var render_id = calc_render_id(render);
    
    var mesh = obj["data"];
    var materials = mesh["materials"];

    var batch_types = get_batch_types(graph, render);

    // NOTE: generate all batches and select unique
    var batches = {};
    for (var i = 0; i < batch_types.length; i++) {
        var type = batch_types[i];

        if (type === "COLOR_ID" && !render.selectable)
            continue;

        // j == submesh index == material index != batch slot index
        for (var j = 0; j < materials.length; j++) {
            if (geometry.has_empty_submesh(mesh, j))
                continue;
            var batch = init_batch(type);
            var material = materials[j];
            if (!update_batch_material(batch, material, true))
                continue;

            batch.draw_mode = mesh.draw_mode || geometry.DM_DEFAULT;
            if (type === "COLOR_ID")
                batch.color_id = new Float32Array(obj._color_id);

            update_batch_render(batch, render);
            update_batch_particle_systems(batch, obj["particle_systems"]);

            if (process_geometry) {
                batch.odd_id_prop = obj["uuid"];
                update_batch_id(batch, render_id);

                if (!batches[batch.id])
                    batches[batch.id] = {
                        batch: batch,
                        submesh_indices: []
                    };
                batches[batch.id].submesh_indices.push(j);
            } else {
                update_batch_id(batch, render_id);
                slots.push(create_slot(batch, j));
            }
        }
    }

    // NOTE: preserve batch submesh for particle transforms and wind 
    // bending inheritance
    var psystems = obj["particle_systems"];
    var preserve_batch_submesh = false;
    for (var i = 0; i < psystems.length; i++) {
        var psys = psystems[i];

        if (psys["transforms"].length == 0 
                || psys["settings"]["b4w_wind_bend_inheritance"] == "PARENT"
                || (psys["settings"]["b4w_vcol_from_name"] 
                && psys["settings"]["b4w_vcol_to_name"])) {
            preserve_batch_submesh = true;
            break; 
        }
    }

    if (process_geometry) {
        // join submeshes for unique batches
        for (var batch_id in batches) {
            var submeshes = [];
            var batch = batches[batch_id].batch;
            var attr_names = batch.common_attributes;
            var bone_pointers = batch.bone_pointers;
            var first_submesh_index = batches[batch_id].submesh_indices[0];

            for (var j in batches[batch_id].submesh_indices) {
                var submesh_index = batches[batch_id].submesh_indices[j];
                var submesh = geometry.extract_submesh(mesh, submesh_index, 
                        attr_names, bone_pointers, batch.vertex_colors_usage, 
                        batch.uv_maps_usage);
                submeshes.push(submesh);
            }

            if (submeshes.length > 1) {
                var submesh = geometry.submesh_list_join(submeshes);
                slots.push(create_slot(batch));
            } else {
                var submesh = submeshes[0];
                slots.push(create_slot(batch, first_submesh_index));
            }
            
            if (materials[first_submesh_index]["name"] == "LENS_FLARES") {
                // NOTE: there is a standard way to do so:
                // generate submesh and assign through update_batch_geometry()
                var bufs_data = particles.prepare_lens_flares(submesh);
                batch.bufs_data = bufs_data;
            } else if (particles.has_hair_particles(obj)) {
                update_batch_geometry(batch, submesh);
                // NOTE: needed submesh for particle transforms, and wind 
                // bending inheritance
                if (preserve_batch_submesh)
                    batch.submesh = submesh;
            } else if (batch.type == "PHYSICS") {
                batch.submesh = submesh;
            } else
                update_batch_geometry(batch, submesh);
        }
    }

    // process particle system batches

    if (psystems.length > 0 && slots.length) {

        if (!process_geometry)
            throw "Particle systems require geometry processing";

        // check if emitter rendering needed
        var not_render_emitter = true;
        for (var i = 0; i < psystems.length; i++) {
            var psys = psystems[i];
            if (psys["settings"]["use_render_emitter"]) {
                not_render_emitter = false;
                break; 
            }
        }

        var slots_old = slots;

        var slots_new;
        if (not_render_emitter)
            slots_new = [];
        else
            slots_new = slots;

        for (var i = 0; i < psystems.length; i++) {
            var psys = psystems[i];
            var pset = psys["settings"];

            var seed = util.init_rand_r_seed(psys["seed"]);

            if (pset["type"] == "EMITTER") {
                var batch = init_batch("MAIN");
                update_batch_particles_emitter(batch, mesh, psys, 
                        obj._render.world_matrix);
                update_batch_render(batch, render);

                batch.odd_id_prop = pset["uuid"];
                update_batch_id(batch, render_id);

                slots_new.push(create_slot(batch, -1, psys));

            } else if (pset["type"] == "HAIR") {

                // disable frustum culling for dynamic grass (only)
                if (pset["b4w_dynamic_grass"])
                    render.do_not_cull = true;

                // NOTE: assume single-material emitter
                var batch = slots_old[0].batch;

                if (psys["transforms"].length) {
                    var ptrans = psys["transforms"];
                } else {
                    var points = geometry.geometry_random_points(batch.submesh,
                            pset["count"], false, seed);

                    var ptrans = new Float32Array(points.length * 4);
                    for (var j = 0; j < points.length; j++) {
                        // NOTE: +/- 25%
                        var scale = 0.75 + 0.5 * util.rand_r(seed);
                        ptrans[j * 4] = points[j][0];
                        ptrans[j * 4 + 1] = points[j][1];
                        ptrans[j * 4 + 2] = points[j][2];
                        ptrans[j * 4 + 3] = scale;
                    }
                }

                var use_grass_map = scenegraph.find_subs(graph, "GRASS_MAP") ? true : false;

                if (pset["render_type"] == "OBJECT") {
                    var particles_batch_types = [get_batch_types(graph, 
                            pset["dupli_object"]._render)];

                    var slots = make_hair_particles_batches(obj, batch, 
                            [pset["dupli_object"]], particles_batch_types, [ptrans], pset, 
                            psys, use_grass_map, seed, false);

                    slots_new = slots_new.concat(slots);

                } else if (pset["render_type"] == "GROUP") {
                    var dg_objs = pset["dupli_group"]["objects"];
                    var ptrans_dist;
                    var reset_seed = false;

                    var particles_batch_types = [];
                    for (var j = 0; j < dg_objs.length; j++) {
                        var btypes = get_batch_types(graph, 
                                pset["dupli_group"]["objects"][j]._render);
                        particles_batch_types.push(btypes);
                    }

                    if (pset["use_whole_group"]) {
                        ptrans_dist = distribute_ptrans_group(ptrans, dg_objs);
                        reset_seed = true;
                    } else if (pset["use_group_count"]) {
                        ptrans_dist = distribute_ptrans_by_dupli_weights(ptrans,
                                dg_objs, pset["dupli_weights"], seed);
                    } else {
                        ptrans_dist = distribute_ptrans_equally(ptrans, dg_objs, seed);
                    }

                    var slots = make_hair_particles_batches(obj, batch, dg_objs, 
                             particles_batch_types, ptrans_dist, pset, psys,
                             use_grass_map, seed, reset_seed);
                    slots_new = slots_new.concat(slots);
                }

                // NOTE: prevent wind bending for emitter by checking option
                if (pset["b4w_wind_bend_inheritance"] == "INSTANCE")
                    render.wind_bending_amp = 0;
            } else
                throw "Unknown particle settings type";
        }

        slots = slots_new;
    }
    return slots;
}

function exclude_batch_types(batch_types, unwanted_types) {
    
    for (var i = 0; i < unwanted_types.length; i++) {
        var index = batch_types.indexOf(unwanted_types[i]);
        if (index !== -1)
            batch_types.splice(index, 1);
    }

    return batch_types;
}

function get_batch_types(graph, render) {
    var batch_types = ["SHADELESS", "MAIN", "NODES"];

    if (scenegraph.find_subs(graph, "COLOR_PICKING") ||
            scenegraph.find_subs(graph, "GLOW_MASK"))
        batch_types.push("COLOR_ID");

    if (scenegraph.find_subs(graph, "WIREFRAME"))
        batch_types.push("WIREFRAME");

    // NOTE: need condition
    batch_types.push("PHYSICS");

    if (scenegraph.find_subs(graph, "DEPTH") ||
            scenegraph.find_subs(graph, "SHADOW_CAST"))
        batch_types.push("DEPTH");

    if (scenegraph.find_subs(graph, "GRASS_MAP"))
        batch_types.push("GRASS_MAP");


    if (render.shadow_cast_only || render.reflexible_only) {
        var unwanted_types = null;

        if (render.shadow_cast_only)
            unwanted_types = ["SHADELESS", "MAIN", "NODES", "COLOR_ID", 
                    "PHYSICS", "WIREFRAME"];
        if (render.reflexible_only) {
            var types = ["COLOR_ID", "PHYSICS", "DEPTH", "WIREFRAME"];
            if (unwanted_types !== null)
                unwanted_types = util.array_intersect(unwanted_types, types);
            else
                unwanted_types = types;
        }

        batch_types = exclude_batch_types(batch_types, unwanted_types);
    }

    return batch_types;
}

exports.update_batch_material = update_batch_material;
/**
 * Init batch according to blender material
 * @param batch Batch object
 * @param material Blender material object
 * @param update_tex_color Keep texture images (do not update by colors)
 */
function update_batch_material(batch, material, update_tex_color) {

    var ret;
    switch (batch.type) {
    case "SHADELESS":
        ret = update_batch_material_shadeless(batch, material, update_tex_color);
        break;
    case "MAIN":
        ret = update_batch_material_main(batch, material, update_tex_color);
        break;
    case "NODES":
        ret = update_batch_material_nodes(batch, material);
        break;
    case "DEPTH":
        ret = update_batch_material_depth(batch, material);
        break;
    case "PHYSICS":
        ret = update_batch_material_physics(batch, material);
        break;
    case "COLOR_ID":
        ret = update_batch_material_color_id(batch, material);
        break;
    case "GRASS_MAP":
        ret = update_batch_material_grass_map(batch, material);
        break;
    case "WIREFRAME":
        ret = update_batch_material_wireframe(batch, material);
        break;
    default:
        throw "Wrong batch type: " + batch.type;
    }

    return ret;
}

function update_batch_material_shadeless(batch, material, update_tex_color) {
    if (material["b4w_collision"])
        return false;

    if (!material["use_shadeless"])
        return false;

    if (material["use_nodes"])
        return false;

    apply_shader(batch, "shadeless.glslv", "shadeless.glslf");

    var alpha_blend = material["game_settings"]["alpha_blend"];
    set_batch_directive(batch, "ALPHA", (alpha_blend === "OPAQUE") ? 0 : 1);
    set_batch_directive(batch, "ALPHA_CLIP", (alpha_blend === "CLIP") ? 1 : 0);

    set_batch_c_attr(batch, "a_position");

    var texture_slots = material["texture_slots"];

    var colormap0 = find_valid_textures("use_map_color_diffuse", true, texture_slots)[0];
    var colormap1 = find_valid_textures("use_map_color_diffuse", true, texture_slots)[1];
    var stencil0  = find_valid_textures("use_rgb_to_intensity", true, texture_slots)[0] &&
                    find_valid_textures("use_stencil", true, texture_slots)[0];

    var diffuse_color = new Float32Array([
            material["diffuse_color"][0],
            material["diffuse_color"][1],
            material["diffuse_color"][2],
            material["alpha"]]);

    batch.diffuse_color = diffuse_color;

    if (colormap0) {
        set_batch_directive(batch, "TEXTURE_COLOR", 1);

        switch (colormap0["blend_type"]) {
        case "MIX":
            set_batch_directive(batch, "TEXTURE_BLEND_TYPE", "TEXTURE_BLEND_TYPE_MIX");
            break;
        case "MULTIPLY":
            set_batch_directive(batch, "TEXTURE_BLEND_TYPE", "TEXTURE_BLEND_TYPE_MULTIPLY");
            break;
        }

        set_batch_c_attr(batch, "a_texcoord");

        if (colormap0["texture"]._render.source == "IMAGE" && update_tex_color)
            var tex_col = [diffuse_color[0], diffuse_color[1], diffuse_color[2], 1];
        else if (colormap0["texture"]._render.source == "ENVIRONMENT_MAP" && update_tex_color)
            var tex_col = [0.8, 0.8, 0.8, 1];
        else
            var tex_col = null;

        var tex = get_batch_texture(colormap0, tex_col);
        append_texture(batch, tex, "u_colormap0");

        batch.diffuse_color_factor = colormap0["diffuse_color_factor"];
        batch.colormap0_uv_velocity =
                new Float32Array(colormap0["texture"]["b4w_uv_velocity_trans"]);
        batch.texture_scale = new Float32Array(colormap0["scale"]);
    }

    // TEXTURE_STENCIL_ALPHA_MASK
    if (colormap0 && colormap1 && stencil0) {
        set_batch_directive(batch, "TEXTURE_STENCIL_ALPHA_MASK", 1);

        var tex_col = update_tex_color ? [0.8, 0.8, 0.8, 1] : null;
        var tex = get_batch_texture(colormap1, tex_col);
        append_texture(batch, tex, "u_colormap1");

        var tex_col = update_tex_color ? [0.5, 0.5, 0.5, 1] : null;
        var tex = get_batch_texture(stencil0, tex_col);
        append_texture(batch, tex, "u_stencil0");
    }

    if (material["use_vertex_color_paint"]) {
        set_batch_directive(batch, "VERTEX_COLOR", 1);
        set_batch_c_attr(batch, "a_color");
    } else
        set_batch_directive(batch, "VERTEX_COLOR", 0);

    batch.offset_z = material["offset_z"];

    update_batch_game_settings(batch, material);

    return true;
}

function update_batch_material_main(batch, material, update_tex_color) {
    if (material["b4w_collision"])
        return false;

    if (material["use_shadeless"])
        return false;

    if (material["use_nodes"])
        return false;

    batch.colormap0_uv_velocity = new Float32Array([0.0, 0.0]);
    batch.normalmap_uv_velocities = new Array(4);
    for (var i = 0; i < 4; i++) {
        batch.normalmap_uv_velocities[i] = new Float32Array([0.0, 0.0]);
        // 4 ones are used in water
        // in other materials only one is being used
    }

    update_batch_game_settings(batch, material);

    batch.offset_z = material["offset_z"];

    // NOTE: for multitexturing storage of 5 vec3's is used instead
    batch.texture_scale = new Float32Array([1, 1, 1]);

    var texture_slots = material["texture_slots"];

    var diffuse_color = new Float32Array([
            material["diffuse_color"][0],
            material["diffuse_color"][1],
            material["diffuse_color"][2],
            material["alpha"]]);

    switch (material["name"]) {
    case "LENS_FLARES":
        apply_shader(batch, "special_lens_flares.glslv", "special_lens_flares.glslf");
        set_batch_c_attr(batch, "a_position");
        set_batch_c_attr(batch, "a_texcoord");

        var tex_col = update_tex_color ? [1, 1, 1, 0] : null;
        var tex = get_batch_texture(texture_slots[0], tex_col);
        append_texture(batch, tex);
        break;
    case "PARTICLES":
        if (texture_slots.length == 0) {
            apply_shader(batch, "particles_color.glslv", "particles_color.glslf");
        } else {
            apply_shader(batch, "particles_texture.glslv", "particles_texture.glslf");
            var tex = get_batch_texture(texture_slots[0]);
            if (tex)
                append_texture(batch, tex);
        }
        break;
    default:
        apply_shader(batch, "main.glslv", "main.glslf");

        // find which one is color map, spec map etc
        var colormap0  = find_valid_textures("use_map_color_diffuse", true, texture_slots)[0];
        var specmap0   = find_valid_textures("use_map_color_spec", true, texture_slots)[0];
        var normalmap0 = find_valid_textures("use_map_normal", true, texture_slots)[0];
        var mirrormap0 = find_valid_textures("use_map_mirror", true, texture_slots)[0];

        var colormap1 = find_valid_textures("use_map_color_diffuse", true, texture_slots)[1];
        var stencil0  = find_valid_textures("use_rgb_to_intensity", true, texture_slots)[0] &&
                        find_valid_textures("use_stencil", true, texture_slots)[0];

        if (colormap0) {
            switch (colormap0["blend_type"]) {
            case "MIX":
                set_batch_directive(batch, "TEXTURE_BLEND_TYPE", "TEXTURE_BLEND_TYPE_MIX");
                break;
            case "MULTIPLY":
                set_batch_directive(batch, "TEXTURE_BLEND_TYPE", "TEXTURE_BLEND_TYPE_MULTIPLY");
                break;
            }

            if (colormap0["texture"]._render.source == "IMAGE" && update_tex_color)
                var tex_col = [diffuse_color[0], diffuse_color[1], diffuse_color[2], 1];
            else if (colormap0["texture"]._render.source == "ENVIRONMENT_MAP" && update_tex_color)
                var tex_col = [0.8, 0.8, 0.8, 1];
            else
                var tex_col = null;

            var tex = get_batch_texture(colormap0, tex_col);
            append_texture(batch, tex, "u_colormap0");

            // assumed there is only one color texture per material
            batch.diffuse_color_factor = colormap0["diffuse_color_factor"];
            batch.colormap0_uv_velocity =
                    new Float32Array(colormap0["texture"]["b4w_uv_velocity_trans"]);
            batch.texture_scale = new Float32Array(colormap0["scale"]);
        }

        // specular color can be packed into the alpha channel of a color map
        var alpha_as_spec = colormap0 && (colormap0 == specmap0);

        if (specmap0) {
            if (!alpha_as_spec) {
                var tex_col = update_tex_color ? [0.5, 0.5, 0.5, 1] : null;
                var tex = get_batch_texture(specmap0, tex_col);
                append_texture(batch, tex, "u_specmap");
            }
            batch.specular_color_factor = specmap0["specular_color_factor"];
        }

        if (normalmap0) {
            var tex_col = update_tex_color ? [0.5, 0.5, 1, 1] : null;
            var tex = get_batch_texture(normalmap0, tex_col); 
            append_texture(batch, tex, "u_normalmap0");
            batch.normal_factor = normalmap0["normal_factor"];
            batch.normalmap_uv_velocities[0].set(normalmap0["texture"]["b4w_uv_velocity_trans"]);
        }

        if (mirrormap0) {
            var tex_col = update_tex_color ? [0, 0, 0.5, 1] : null;
            var tex = get_batch_texture(mirrormap0, tex_col);
            append_texture(batch, tex, "u_mirrormap");
            batch.mirror_factor = mirrormap0["mirror_factor"];
        } else
            // NOTE: check it
            batch.mirror_factor = 0.0;
        
        var TEXTURE_STENCIL_ALPHA_MASK = colormap0 && colormap1 && stencil0 ? 1 : 0;
        
        if (TEXTURE_STENCIL_ALPHA_MASK) {
            var tex_col = update_tex_color ? [0.8, 0.8, 0.8, 1] : null;
            var tex = get_batch_texture(colormap1, tex_col);
            append_texture(batch, tex, "u_colormap1");

            var tex_col = update_tex_color ? [0.5, 0.5, 0.5, 1] : null;
            var tex = get_batch_texture(stencil0, tex_col);
            append_texture(batch, tex, "u_stencil0");
        }
        
        // setup texture scale using one of available textures
        var some_tex = colormap0 || specmap0 || normalmap0;
        if (some_tex)
            batch.texture_scale.set(some_tex["scale"]);

        // assign directives
        set_batch_directive(batch, "TEXTURE_COLOR", colormap0 == undefined ? 0 : 1);
        set_batch_directive(batch, "TEXTURE_SPEC", specmap0 == undefined ? 0 : 1);
        set_batch_directive(batch, "TEXTURE_NORM", normalmap0 == undefined ? 0 : 1);
        set_batch_directive(batch, "TEXTURE_MIRROR", mirrormap0 == undefined ? 0 : 1);
        set_batch_directive(batch, "ALPHA_AS_SPEC", alpha_as_spec ? 1 : 0);
        set_batch_directive(batch, "TEXTURE_STENCIL_ALPHA_MASK", TEXTURE_STENCIL_ALPHA_MASK);

        set_batch_c_attr(batch, "a_position");
        set_batch_c_attr(batch, "a_normal");

        if (normalmap0) {
            set_batch_c_attr(batch, "a_normal");
            set_batch_c_attr(batch, "a_tangent");
        
            var nm0tex = normalmap0["texture"];
            if (nm0tex["b4w_use_map_parallax"] && cfg_def.parallax) {
                var steps = shaders.glsl_value(nm0tex["b4w_parallax_steps"]);
                set_batch_directive(batch, "PARALLAX", 1);
                set_batch_directive(batch, "PARALLAX_STEPS", steps);
                batch.parallax_scale = nm0tex["b4w_parallax_scale"];
            }
        }

        if (colormap0 || specmap0 || normalmap0)
            set_batch_c_attr(batch, "a_texcoord");

        if (material["b4w_water"]) {
            var rslt = init_water_material(material, batch)
            // NOTE: override
            batch.shaders_info = rslt.shaders_info;
            batch.common_attributes = rslt.common_attributes;
        }

        if (material["b4w_skydome"]) {
            apply_shader(batch, "special_skydome.glslv", "special_skydome.glslf");

            if (material["b4w_procedural_skydome"]) {
                batch.procedural_sky = true;
            } else {
                var tex_col = update_tex_color ? [0.07, 0.13, 0.58, 1] : null;
                var tex = get_batch_texture(texture_slots[0], tex_col);
                append_texture(batch, tex, "u_sky");
                batch.procedural_sky = false;
            }
            set_batch_c_attr(batch, "a_position");
            // render last
            batch.offset_z = 99999;
        }
        
        if (material["type"] === "HALO") {
            var mat_halo = material["halo"];
            apply_shader(batch, "halo.glslv", "halo.glslf");

            set_batch_directive(batch, "NUM_RINGS", mat_halo["ring_count"])
            set_batch_directive(batch, "NUM_LINES", mat_halo["line_count"])
            set_batch_directive(batch, "NUM_STARS", mat_halo["star_tip_count"])
            set_batch_directive(batch, "SKY_STARS", material["b4w_halo_sky_stars"] ? 1 : 0);
                               
            batch.common_attributes = ["a_position"];

            batch.halo_size = mat_halo["size"];
            // NOTE: hardness works not similiar to blender's one
            batch.halo_hardness = mat_halo["hardness"] / 20;
            batch.halo_rings_color = mat_halo["b4w_halo_rings_color"];
            batch.halo_lines_color = mat_halo["b4w_halo_lines_color"];
            batch.halo_stars_blend = 1.0 / material["b4w_halo_stars_blend_height"];
            batch.halo_stars_height = material["b4w_halo_stars_min_height"];
            batch.halo = true;
        } else {
            batch.halo = false;
        }

        if (colormap0 && colormap0["texture_coords"] == "NORMAL" ||  
                TEXTURE_STENCIL_ALPHA_MASK && colormap1["texture_coords"] == "NORMAL") 
            set_batch_directive(batch, "TEXTURE_COORDS", "TEXTURE_COORDS_NORMAL");
        else if (colormap0 && colormap0["texture_coords"] == "UV")
            set_batch_directive(batch, "TEXTURE_COORDS", "TEXTURE_COORDS_UV");
        else
            set_batch_directive(batch, "TEXTURE_COORDS", 0);

        break;  // end of default
    }
    batch.diffuse_color = diffuse_color;

    var alpha_blend = material["game_settings"]["alpha_blend"];
    set_batch_directive(batch, "ALPHA", (alpha_blend === "OPAQUE") ? 0 : 1);
    set_batch_directive(batch, "ALPHA_CLIP", (alpha_blend === "CLIP") ? 1 : 0);

    set_batch_directive(batch, "DOUBLE_SIDED_LIGHTING",
            (material["b4w_double_sided_lighting"]) ? 1 : 0);

    if (material["use_vertex_color_paint"]) {
        set_batch_directive(batch, "VERTEX_COLOR", 1);
        set_batch_c_attr(batch, "a_color");
    } else
        set_batch_directive(batch, "VERTEX_COLOR", 0);

    batch.ambient = material["ambient"];
    batch.diffuse_intensity = material["diffuse_intensity"];
    batch.emit = material["emit"];
    batch.specular_color = new Float32Array(material["specular_color"]);

    var spec_param;
    switch (material["specular_shader"]) {
    case "PHONG":
    case "COOKTORR":
        set_batch_directive(batch, "SPECULAR_SHADER", "SPECULAR_PHONG");
        spec_param = material["specular_hardness"];
        break;
    case "WARDISO":
        set_batch_directive(batch, "SPECULAR_SHADER", "SPECULAR_WARDISO");
        spec_param = material["specular_slope"];
        break;
    default:
        m_print.error("B4W Error: unsupported specular shader: " + 
            material["specular_shader"] + " (material \"" + 
            material["name"] + "\")");
        spec_param = material["specular_hardness"];
        break;
    }
    batch.specular_params = new Float32Array([material["specular_intensity"], 
                                              spec_param]);

    switch (material["diffuse_shader"]) {
    case "LAMBERT":
        set_batch_directive(batch, "DIFFUSE_SHADER", "DIFFUSE_LAMBERT");
        batch.diffuse_params = [0.0, 0.0];
        break;
    case "OREN_NAYAR":
        set_batch_directive(batch, "DIFFUSE_SHADER", "DIFFUSE_OREN_NAYAR");
        batch.diffuse_params = [material["roughness"], 0.0];
        break;
    case "FRESNEL":
        set_batch_directive(batch, "DIFFUSE_SHADER", "DIFFUSE_FRESNEL");
        batch.diffuse_params = [material["diffuse_fresnel"], 
                material["diffuse_fresnel_factor"]];
        break;
    default:
        m_print.error("B4W Error: unsupported diffuse shader: " + 
            material["diffuse_shader"] + " (material \"" + 
            material["name"] + "\")");
        batch.diffuse_params = [0.0, 0.0];
        break;
    }

    if (material["b4w_wettable"]) {
        set_batch_directive(batch, "WETTABLE", 1);
    } else
        set_batch_directive(batch, "WETTABLE", 0);

    update_batch_fresnel_params(batch, material);

    return true;
}

/**
 * Common for all batch types
 */
function update_batch_game_settings(batch, material) {
    var gs = material["game_settings"];

    switch (gs["alpha_blend"]) {
    case "ALPHA_SORT":  // Alpha Sort       sort            blend
        batch.blend = true;
        batch.zsort_type = geometry.ZSORT_BACK_TO_FRONT;
        batch.depth_mask = true;
        break;
    case "ALPHA":       // Alpha Blend      don't sort      blend
        batch.blend = true;
        batch.zsort_type = geometry.ZSORT_DISABLED;
        batch.depth_mask = true;
        break;
    case "CLIP":        // Alpha Clip       don't sort      discard
        batch.blend = false;
        batch.zsort_type = geometry.ZSORT_DISABLED;
        batch.depth_mask = true;
        break;
    case "ADD":         // Add              don't sort      blend, depthMask(false)
        batch.blend = true;
        batch.zsort_type = geometry.ZSORT_DISABLED;
        batch.depth_mask = false;
        break;
    case "OPAQUE":      // Opaque           don't sort      don't blend
        batch.blend = false;
        batch.zsort_type = geometry.ZSORT_DISABLED;
        //batch.zsort_type = geometry.ZSORT_FRONT_TO_BACK;
        batch.depth_mask = true;
        break;
    default:
        throw new Error("Unknown alpha blend mode: " + alpha_blend);
    }

    batch.use_backface_culling = gs["use_backface_culling"];
}

/**
 * Extract b4w texture from slot and apply color
 * @param texture_slot Texture slot
 * @param {vec4} [color=null] Default texture color
 */
function get_batch_texture(texture_slot, color) {

    var bpy_texture = texture_slot["texture"];

    var render = bpy_texture._render;
    var filepath = bpy_texture["image"]["filepath"];

    if (render && color)
        m_textures.update_texture(render, color,
                                  bpy_texture["image"]._is_dds, filepath);

    return render;
}

/**
 * Return array of valid textures
 */
function find_valid_textures(key, value, array) {
    var results = [];

    var len = array.length;
    for (var i = 0; i < len; i++) {
        var obj = array[i];
        if (obj[key] == value && obj["texture"] && obj["texture"]._render)
            results.push(obj);
    }
    return results;
}

function init_water_material(material, batch) {

    batch.water = true;
    batch.water_shore_smoothing = material["b4w_water_shore_smoothing"];
    batch.water_dynamic         = material["b4w_water_dynamic"];
    var texture_slots = material["texture_slots"];

    apply_shader(batch, "special_water.glslv", "special_water.glslf");
    set_batch_c_attr(batch, "a_position");
    set_batch_c_attr(batch, "a_texcoord");
    set_batch_c_attr(batch, "a_normal");
    set_batch_c_attr(batch, "a_tangent");

    var normalmaps = find_valid_textures("use_map_normal", true, texture_slots);

    var mirrormap0 = find_valid_textures("use_map_mirror", true, texture_slots)[0];
    var alphamap0  = find_valid_textures("use_map_alpha", true, texture_slots)[0];

    if (normalmaps.length) {
        var tex_nm = get_batch_texture(normalmaps[0]);
        append_texture(batch, tex_nm, "u_normalmap0");
    }

    set_batch_directive(batch, "NUM_NORMALMAPS", normalmaps.length);
    batch.normalmap_scales = new Array(normalmaps.length);

    for (var i = 0; i < normalmaps.length; i++) {
        batch.normalmap_uv_velocities[i].set(normalmaps[i]["texture"]["b4w_uv_velocity_trans"]);
        batch.normalmap_scales[i] = new Float32Array(2);
        batch.normalmap_scales[i].set([normalmaps[i]["scale"][0], normalmaps[i]["scale"][1]]);
    }

    if (mirrormap0) {
        set_batch_directive(batch, "TEXTURE_MIRROR", 1);
        var tex_mm0 = get_batch_texture(mirrormap0);
        append_texture(batch, tex_mm0, "u_mirrormap");
        batch.mirror_factor = mirrormap0["mirror_factor"];
    } else {
        set_batch_directive(batch, "TEXTURE_MIRROR", 0);
        batch.mirror_factor = 0.0;
    }

    // alpha map for old-fashioned water material
    if (alphamap0) {
        set_batch_directive(batch, "ALPHA_MAP", 1);
        var tex_am0 = get_batch_texture(alphamap0);
        append_texture(batch, tex_am0, "u_alphamap");
    } else {
        set_batch_directive(batch, "ALPHA_MAP", 0);
    }

    var foam = null;
    for (var i = 0; i < texture_slots.length; i++) {
        // find first foam texture
        var texture = texture_slots[i];
        if (texture["texture"]["b4w_water_foam"] === true) {
           foam = texture;
           break;
        }
    }

    if (foam && cfg_def.foam) {
        set_batch_directive(batch, "FOAM", 1);

        var tex_foam = get_batch_texture(foam);
        append_texture(batch, tex_foam, "u_foam");

        batch.foam_factor = material["b4w_foam_factor"];
        batch.foam_uv_freq = foam["texture"]["b4w_foam_uv_freq"];
        batch.foam_mag = foam["texture"]["b4w_foam_uv_magnitude"];
        // vec3 -> vec2
        batch.foam_scale = new Float32Array([foam["scale"][0], foam["scale"][1]]);

        // check normalmaps foam influence
        if (normalmaps.length) {
            for (var i = 0; i < normalmaps.length; i++) {
                var nmap = normalmaps[i]
                if (nmap["texture"]["b4w_affect_foam"])
                    set_batch_directive(batch, "NORM_FOAM" + String(i), 1);
                else
                    set_batch_directive(batch, "NORM_FOAM" + String(i), 0);
            }
        }
    } else {
        set_batch_directive(batch, "FOAM", 0);
    }

    for (var i = 0; i < texture_slots.length; i++) {
        // find first shore distance texture
        var texture = texture_slots[i];
        if (texture["texture"]["b4w_shore_dist_map"] === true) {
            var shore_dist_map = texture; 
            break;
        }
    }

    if (shore_dist_map) {
        var tex_shr0 = get_batch_texture(shore_dist_map);
        append_texture(batch, tex_shr0, "u_shore_dist_map");
        set_batch_directive(batch, "SHORE_PARAMS", 1);

        var sh_bounds = texture["texture"]["b4w_shore_boundings"];

        set_batch_directive(batch, "MAX_SHORE_DIST", shaders.glsl_value(
                                    texture["texture"]["b4w_max_shore_dist"]));

        set_batch_directive(batch, "SHORE_MAP_SIZE_X", shaders.glsl_value(
                                    sh_bounds[0] - sh_bounds[1]));

        set_batch_directive(batch, "SHORE_MAP_SIZE_Z", shaders.glsl_value(
                                    sh_bounds[2] - sh_bounds[3]));

        set_batch_directive(batch, "SHORE_MAP_CENTER_X",shaders.glsl_value(
                                    (sh_bounds[0] + sh_bounds[1]) / 2));

        set_batch_directive(batch, "SHORE_MAP_CENTER_Z", shaders.glsl_value(
                                    (sh_bounds[2] + sh_bounds[3]) / 2));
    } else {
        set_batch_directive(batch, "SHORE_PARAMS", 0);
    }
    if (material["b4w_generated_mesh"] && cfg_def.deferred_rendering) {
        set_batch_directive(batch, "GENERATED_MESH", 1);
        batch.water_generated_mesh = true;
        batch.water_num_cascads    = material["b4w_water_num_cascads"];
        batch.water_subdivs        = material["b4w_water_subdivs"];
        batch.water_detailed_dist  = material["b4w_water_detailed_dist"];
    } else {
        set_batch_directive(batch, "GENERATED_MESH", 0);
        batch.water_generated_mesh = false;
    }

    if (material["b4w_water_dynamic"]) {

        // setup dynamic water params
        var dst_noise_scale0  = shaders.glsl_value(material["b4w_water_dst_noise_scale0"]);
        var dst_noise_scale1  = shaders.glsl_value(material["b4w_water_dst_noise_scale1"]);
        var dst_noise_freq0   = shaders.glsl_value(material["b4w_water_dst_noise_freq0"]);
        var dst_noise_freq1   = shaders.glsl_value(material["b4w_water_dst_noise_freq1"]);
        var dir_min_shore_fac = shaders.glsl_value(material["b4w_water_dir_min_shore_fac"]);
        var dir_freq          = shaders.glsl_value(material["b4w_water_dir_freq"]);
        var dir_noise_scale   = shaders.glsl_value(material["b4w_water_dir_noise_scale"]);
        var dir_noise_freq    = shaders.glsl_value(material["b4w_water_dir_noise_freq"]);
        var dir_min_noise_fac = shaders.glsl_value(material["b4w_water_dir_min_noise_fac"]);
        var dst_min_fac       = shaders.glsl_value(material["b4w_water_dst_min_fac"]);
        var waves_hor_fac     = shaders.glsl_value(material["b4w_water_waves_hor_fac"]);

        set_batch_directive(batch, "DST_NOISE_SCALE_0", dst_noise_scale0);
        set_batch_directive(batch, "DST_NOISE_SCALE_1", dst_noise_scale1);
        set_batch_directive(batch, "DST_NOISE_FREQ_0",  dst_noise_freq0);
        set_batch_directive(batch, "DST_NOISE_FREQ_1",  dst_noise_freq1);
        set_batch_directive(batch, "DIR_MIN_SHR_FAC",   dir_min_shore_fac);
        set_batch_directive(batch, "DIR_FREQ",          dir_freq);
        set_batch_directive(batch, "DIR_NOISE_SCALE",   dir_noise_scale);
        set_batch_directive(batch, "DIR_NOISE_FREQ",    dir_noise_freq);
        set_batch_directive(batch, "DIR_MIN_NOISE_FAC", dir_min_noise_fac);
        set_batch_directive(batch, "DST_MIN_FAC",       dst_min_fac);
        set_batch_directive(batch, "WAVES_HOR_FAC",     waves_hor_fac);
    }

    var spec_param;
    switch (material["specular_shader"]) {
    case "PHONG":
    case "COOKTORR":
        set_batch_directive(batch, "SPECULAR_SHADER", "SPECULAR_PHONG");
        spec_param = material["specular_hardness"];
        break;
    case "WARDISO":
        set_batch_directive(batch, "SPECULAR_SHADER", "SPECULAR_WARDISO");
        spec_param = material["specular_slope"];
        break;
    }
    batch.specular_params = new Float32Array([material["specular_intensity"], 
                                              spec_param]);

    switch (material["diffuse_shader"]) {
    case "LAMBERT":
        set_batch_directive(batch, "DIFFUSE_SHADER", "DIFFUSE_LAMBERT");
        batch.diffuse_params = [0.0, 0.0];
        break;
    case "OREN_NAYAR":
        set_batch_directive(batch, "DIFFUSE_SHADER", "DIFFUSE_OREN_NAYAR");
        batch.diffuse_params = [material["roughness"], 0.0];
        break;
    case "FRESNEL":
        set_batch_directive(batch, "DIFFUSE_SHADER", "DIFFUSE_FRESNEL");
        batch.diffuse_params = [material["diffuse_fresnel"], 
                material["diffuse_fresnel_factor"]];
        break;
    }

    batch.shallow_water_col     = material["b4w_shallow_water_col"];
    batch.shore_water_col       = material["b4w_shore_water_col"];
    batch.shallow_water_col_fac = material["b4w_shallow_water_col_fac"];
    batch.shore_water_col_fac   = material["b4w_shore_water_col_fac"];

    set_batch_directive(batch, "ABSORB", 
                       shaders.glsl_value(material["b4w_water_absorb_factor"]));
    set_batch_directive(batch, "SSS_STRENGTH",
                       shaders.glsl_value(material["b4w_water_sss_strength"]));
    set_batch_directive(batch, "SSS_WIDTH",
                       shaders.glsl_value(material["b4w_water_sss_width"]));

    return {shaders_info: batch.shaders_info, common_attributes: batch.common_attributes};
}

function update_batch_fresnel_params(batch, material) {
    batch.fresnel_params = new Float32Array(4);

    var rt = material["raytrace_transparency"];
    // used for transparent reflective objects (e.g. water)
    batch.fresnel_params[0] = rt["fresnel"];
    // map [1.0 - 5.0] to [0.0 - 0.8]
    batch.fresnel_params[1] = 1 - rt["fresnel_factor"] / 5;

    var rm = material["raytrace_mirror"];
    // used for non-transparent reflective objects
    batch.reflect_factor = rm["reflect_factor"]; 
    batch.fresnel_params[2] = rm["fresnel"];
    // map [0.0 - 5.0] to [0.0 - 1.0]
    batch.fresnel_params[3] = 1 - rm["fresnel_factor"] / 5;
}


function update_batch_material_nodes(batch, material) {
    if (!material["use_nodes"])
        return false;

    var node_tree = material["node_tree"];

    var nmat_graph = nodemat.compose_nmat_graph(node_tree, material["uuid"]);
    if (!nmat_graph) {
        m_print.error("Failed to create node graph for material " +
                material["name"] + ", disable nodes");
        update_batch_material_debug(batch, material);
        return true;
    }

    apply_shader(batch, "nodes.glslv", "nodes.glslf");

    // some common stuff

    var alpha_blend = material["game_settings"]["alpha_blend"];
    set_batch_directive(batch, "ALPHA", (alpha_blend === "OPAQUE") ? 0 : 1);
    set_batch_directive(batch, "ALPHA_CLIP", (alpha_blend === "CLIP") ? 1 : 0);
    set_batch_directive(batch, "DOUBLE_SIDED_LIGHTING",
            (material["b4w_double_sided_lighting"]) ? 1 : 0);

    set_batch_c_attr(batch, "a_position");

    update_batch_game_settings(batch, material);
    batch.offset_z = material["offset_z"];

    batch.diffuse_color = new Float32Array([
            material["diffuse_color"][0],
            material["diffuse_color"][1],
            material["diffuse_color"][2],
            material["alpha"]]);

    batch.emit = material["emit"];
    batch.ambient = material["ambient"];
    update_batch_fresnel_params(batch, material);

    if (material["b4w_wettable"]) {
        set_batch_directive(batch, "WETTABLE", 1);
    } else
        set_batch_directive(batch, "WETTABLE", 0);

    batch.node_elements = nodemat.compose_node_elements(nmat_graph);

    m_graph.traverse(nmat_graph, function(node, attr) {
        switch (attr.type) {
        case "GEOMETRY_UV":
            var name = attr.data.name;
            var uv_layer = attr.data.value;
            // NOTE: will fail in case of multiple names for single uv layer
            if (uv_layer)
                batch.uv_maps_usage[uv_layer] = name;
            else
                m_print.error("Missing UV layer in node ", attr.name, "for material ", material["name"]);
            break;
        case "GEOMETRY_VC":
        case "GEOMETRY_VC1":
        case "GEOMETRY_VC2":
        case "GEOMETRY_VC3":
            var name = attr.data.name;
            var vc_layer = attr.data.value;
            // NOTE: will fail in case of multiple names for single vc layer
            if (vc_layer) {
                batch.vertex_colors_usage[name] = {
                    generate_buffer: true,
                    src: [{ name: vc_layer}]
                };

                var mask = 0;
                if (attr.type == "GEOMETRY_VC")
                    mask = 7;
                else {
                    for (var i = 0; i < attr.outputs.length; i++) {
                        var index = "RGB".indexOf(attr.outputs[i].identifier);
                        if (index > -1)
                            mask |= 1 << (2 - index);
                    }
                }
                batch.vertex_colors_usage[name].src[0].mask = mask;
            }
            else
                m_print.error("Missing vertex color layer in node ", attr.name, "for material ", material["name"]);
            break;
        case "GEOMETRY_NO":
            set_batch_c_attr(batch, "a_normal");
            break;
        case "MATERIAL":
        case "MATERIAL_EXT":
            var mat = attr.data.value;
            set_batch_directive(batch, "SHADED", 1);
            set_batch_c_attr(batch, "a_normal");
            set_batch_directive(batch, "DIFFUSE_SHADER", "DIFFUSE_" + mat["diffuse_shader"]);
            set_batch_directive(batch, "SPECULAR_SHADER", "SPECULAR_" + mat["specular_shader"]);
            break;
        case "TEXTURE_COLOR":
        case "TEXTURE_COLOR2":
        case "TEXTURE_COLOR3":
        case "TEXTURE_ENVIRONMENT":
        case "PARALLAX":
            var name = attr.data.name;
            var tex = attr.data.value;

            if (tex) {
                if (tex._render.allow_node_dds !== false)
                    if (attr.type != "TEXTURE_ENVIRONMENT")
                        tex._render.allow_node_dds = true;
                    else
                        tex._render.allow_node_dds = false;

                append_texture(batch, tex._render, name);
            } else
                m_print.error("Missing texture in node ", attr.name, "for material ", material["name"]);

            break;
        case "TEXTURE_NORMAL":
        case "TEXTURE_NORMAL2":
        case "TEXTURE_NORMAL3":
            set_batch_directive(batch, "CALC_TBN_SPACE", 1);
            set_batch_c_attr(batch, "a_normal");
            set_batch_c_attr(batch, "a_tangent");

            var name = attr.data.name;
            var tex = attr.data.value;

            if (tex) {
                tex._render.allow_node_dds = false;
                append_texture(batch, tex._render, name);
            } else
                m_print.error("Missing texture in node ", attr.name, "for material ", material["name"]);

            break;
        }
    });

    return true;
}

function update_batch_material_debug(batch, material) {

    apply_shader(batch, "shadeless.glslv", "shadeless.glslf");

    var alpha_blend = material["game_settings"]["alpha_blend"];
    set_batch_directive(batch, "ALPHA", (alpha_blend === "OPAQUE") ? 0 : 1);
    set_batch_directive(batch, "ALPHA_CLIP", (alpha_blend === "CLIP") ? 1 : 0);

    set_batch_c_attr(batch, "a_position");

    batch.diffuse_color = new Float32Array([1,0,1,1]);

    set_batch_directive(batch, "VERTEX_COLOR", 0);

    batch.offset_z = material["offset_z"];

    update_batch_game_settings(batch, material);

    return true;
}

function update_batch_material_depth(batch, material) {

    if (material["name"] === "LENS_FLARES" ||
            material["name"] === "PARTICLES" ||
            material["b4w_water"] ||
            material["b4w_skydome"] ||
            material["b4w_collision"] ||
            material["type"] === "HALO")
        return false;

    update_batch_game_settings(batch, material);

    if (batch.blend)
        return false;

    apply_shader(batch, "depth.glslv", "depth.glslf");
    set_batch_c_attr(batch, "a_position");

    var alpha_blend = material["game_settings"]["alpha_blend"];

    var alpha = (alpha_blend === "OPAQUE") ? 0 : 1;
    set_batch_directive(batch, "ALPHA", alpha);

    //set_batch_directive(batch, "ALPHA_CLIP", alpha_clip);

    batch.texture_scale = new Float32Array([1, 1, 1]);

    var texture_slots = material["texture_slots"];

    var colormap0 = find_valid_textures("use_map_color_diffuse", true, texture_slots)[0];
    var alpha_clip = (alpha_blend === "CLIP") ? 1 : 0;

    if (colormap0 && alpha_clip) {
        batch.texture_scale.set(colormap0["scale"]);
        set_batch_directive(batch, "TEXTURE_COLOR", 1);
        set_batch_c_attr(batch, "a_texcoord");

        batch.colormap0_uv_velocity = new Float32Array([0.0, 0.0]);

        if (colormap0["texture"]._render.source == "IMAGE" ||
                colormap0["texture"]._render.source == "ENVIRONMENT_MAP") {
            var tex = get_batch_texture(colormap0);
            append_texture(batch, tex, "u_colormap0");
            batch.colormap0_uv_velocity.set(colormap0["texture"]["b4w_uv_velocity_trans"]);
        }

        // for texture rendering
        if (colormap0["texture"]._render.source == "NONE") {
            var tex = get_batch_texture(colormap0);
            append_texture(batch, tex, "u_colormap0");
            batch.colormap0_uv_velocity.set(colormap0["texture"]["b4w_uv_velocity_trans"]);
        }
    } else
        set_batch_directive(batch, "TEXTURE_COLOR", 0);

    return true;
}

function update_batch_material_physics(batch, material) {
    if (material["b4w_collision"]) {
        batch.use_ghost = material["b4w_use_ghost"];
        batch.collision_id = material["b4w_collision_id"];
        batch.collision_group = material["b4w_collision_group"];
        batch.collision_mask = material["b4w_collision_mask"];
        batch.friction = material["physics"]["friction"];
        batch.elasticity = material["physics"]["elasticity"];

        return true;
    } else if (material["b4w_water"]) {
        // setup dynamic water params
        batch.water = true;
        batch.water_dynamics    = material["b4w_water_dynamic"];
        batch.dst_noise_scale0  = material["b4w_water_dst_noise_scale0"];
        batch.dst_noise_scale1  = material["b4w_water_dst_noise_scale1"];
        batch.dst_noise_freq0   = material["b4w_water_dst_noise_freq0"];
        batch.dst_noise_freq1   = material["b4w_water_dst_noise_freq1"];
        batch.dir_min_shore_fac = material["b4w_water_dir_min_shore_fac"];
        batch.dir_freq          = material["b4w_water_dir_freq"];
        batch.dir_noise_scale   = material["b4w_water_dir_noise_scale"];
        batch.dir_noise_freq    = material["b4w_water_dir_noise_freq"];
        batch.dir_min_noise_fac = material["b4w_water_dir_min_noise_fac"];
        batch.dst_min_fac       = material["b4w_water_dst_min_fac"];
        batch.waves_hor_fac     = material["b4w_water_waves_hor_fac"];
        return true;
    }
    else
        return false;
}

function update_batch_material_color_id(batch, material) {
    if (material["name"] === "LENS_FLARES" ||
            material["name"] === "PARTICLES" ||
            material["b4w_skydome"] ||
            material["b4w_collision"] ||
            material["type"] === "HALO")
        return false;

    update_batch_game_settings(batch, material);
    // blend allowed but rendered as non-blend
    batch.blend = false;

    apply_shader(batch, "color_id.glslv", "color_id.glslf");
    set_batch_c_attr(batch, "a_position");

    var alpha_blend = material["game_settings"]["alpha_blend"];

    var alpha = (alpha_blend === "OPAQUE") ? 0 : 1;
    set_batch_directive(batch, "ALPHA", alpha);

    batch.texture_scale = new Float32Array([1, 1, 1]);

    var texture_slots = material["texture_slots"];

    var colormap0 = find_valid_textures("use_map_color_diffuse", true, texture_slots)[0];
    var alpha_clip = (alpha_blend === "CLIP") ? 1 : 0;

    if (colormap0 && alpha_clip) {
        batch.texture_scale.set(colormap0["scale"]);
        set_batch_directive(batch, "TEXTURE_COLOR", 1);
        set_batch_c_attr(batch, "a_texcoord");

        batch.colormap0_uv_velocity = new Float32Array([0.0, 0.0]);

        if (colormap0["texture"]._render.source == "IMAGE" ||
                colormap0["texture"]._render.source == "ENVIRONMENT_MAP") {
            var tex = get_batch_texture(colormap0);
            append_texture(batch, tex, "u_colormap0");
            batch.colormap0_uv_velocity.set(colormap0["texture"]["b4w_uv_velocity_trans"]);
        }

        // for texture rendering
        if (colormap0["texture"]._render.source == "NONE") {
            var tex = get_batch_texture(colormap0);
            append_texture(batch, tex, "u_colormap0");
            batch.colormap0_uv_velocity.set(colormap0["texture"]["b4w_uv_velocity_trans"]);
        }
    } else
        set_batch_directive(batch, "TEXTURE_COLOR", 0);

    return true;
}

function update_batch_material_wireframe(batch, material) {
    if (material["name"] === "LENS_FLARES" ||
            material["name"] === "PARTICLES" ||
            material["b4w_water"] ||
            material["b4w_skydome"] ||
            material["b4w_collision"] ||
            material["type"] === "HALO")
        return false;
            
    apply_shader(batch, "wireframe.glslv", "wireframe.glslf");
    set_batch_c_attr(batch, "a_position");
    set_batch_c_attr(batch, "a_normal");
    set_batch_c_attr(batch, "a_polyindex");

    batch.depth_mask = true;

    batch.wireframe_mode = 0;
    batch.wireframe_edge_color = [0, 0, 0];

    return true;
}

function update_batch_material_grass_map(batch, material) {
    if (!material["b4w_terrain"])
        return false;

    update_batch_game_settings(batch, material);
    // override some gs
    batch.blend = false;
    batch.zsort_type = geometry.ZSORT_DISABLED;
    batch.depth_mask = true;

    apply_shader(batch, "grass_map.glslv", "grass_map.glslf");
    set_batch_c_attr(batch, "a_position");

    if (material["b4w_dynamic_grass_size"])
        var vc_usage_gr_size = material["b4w_dynamic_grass_size"];
    else
        var vc_usage_gr_size = null;
    if (material["b4w_dynamic_grass_color"])
        var vc_usage_gr_color = material["b4w_dynamic_grass_color"];
    else
        var vc_usage_gr_color = null;

    batch.vertex_colors_usage["a_grass_size"] = {
        generate_buffer: true,
        src: []
    }
    if (vc_usage_gr_size) {
        batch.vertex_colors_usage["a_grass_size"].src.push({ 
                name: vc_usage_gr_size, mask: 4 });
        set_batch_directive(batch, "DYNAMIC_GRASS_SIZE", 1);
    } else
        set_batch_directive(batch, "DYNAMIC_GRASS_SIZE", 0);

    batch.vertex_colors_usage["a_grass_color"] = {
        generate_buffer: true,
        src: []
    }
    if (vc_usage_gr_color) {
        batch.vertex_colors_usage["a_grass_color"].src.push({ 
                name: vc_usage_gr_color, mask: 7 });
        set_batch_directive(batch, "DYNAMIC_GRASS_COLOR", 1);
    } else
        set_batch_directive(batch, "DYNAMIC_GRASS_COLOR", 0);

    return true;
}

/**
 * Update batch from object render
 */
function update_batch_render(batch, render) {

    if (batch.type === "PHYSICS")
        return;

    if (render.type == "DYNAMIC") {
        if (render.is_hair_particles)
            set_batch_directive(batch, "AU_QUALIFIER", "attribute");
        else
            set_batch_directive(batch, "AU_QUALIFIER", "uniform");
        set_batch_directive(batch, "STATIC_BATCH", 0);
    } else {
        set_batch_directive(batch, "AU_QUALIFIER", "attribute");
        set_batch_directive(batch, "STATIC_BATCH", 1);
    }

    if (batch.type == "WIREFRAME") {
        if (extensions.get_standard_derivatives())
            set_batch_directive(batch, "WIREFRAME_QUALITY", 1);
        else
            set_batch_directive(batch, "WIREFRAME_QUALITY", 0);
        
        if (batch.debug_sphere) {
            set_batch_directive(batch, "DEBUG_SPHERE", 1);
            if (batch.debug_sphere_dynamic)
                set_batch_directive(batch, "DEBUG_SPHERE_DYNAMIC", 1);
            else
                set_batch_directive(batch, "DEBUG_SPHERE_DYNAMIC", 0);
        } else
            set_batch_directive(batch, "DEBUG_SPHERE", 0);

        set_batch_directive(batch, "ALPHA", 1);
    }

    if (render.wind_bending) {
        if (render.main_bend_col !== "") {

            batch.vertex_colors_usage["a_bending_col_main"] = {
                generate_buffer: true,
                src: [{ name: render.main_bend_col, mask: 4 }]
            }

            set_batch_c_attr(batch, "a_bending_col_main");

            if (render.detail_bend_col.leaves_stiffness      !== "" &&
                    render.detail_bend_col.leaves_phase      !== "" &&
                    render.detail_bend_col.overall_stiffness !== "") {

                batch.vertex_colors_usage["a_bending_col_detail"] = {
                    generate_buffer: true,
                    src: [
                        { name: render.detail_bend_col.leaves_stiffness, mask: 4 }, 
                        { name: render.detail_bend_col.leaves_phase, mask: 2 }, 
                        { name: render.detail_bend_col.overall_stiffness, mask: 1 }
                    ]
                }
                set_batch_c_attr(batch, "a_bending_col_detail");
                set_batch_c_attr(batch, "a_normal");

                set_batch_directive(batch, "DETAIL_BEND", 1);
            } else 
                set_batch_directive(batch, "DETAIL_BEND", 0);

            set_batch_directive(batch, "MAIN_BEND_COL", 1);
        } else
            set_batch_directive(batch, "MAIN_BEND_COL", 0);

        set_batch_directive(batch, "WIND_BEND", 1);
    } else
        set_batch_directive(batch, "WIND_BEND", 0);

    if (render.bend_center_only)
        set_batch_directive(batch, "BEND_CENTER_ONLY", 1);
    else
        set_batch_directive(batch, "BEND_CENTER_ONLY", 0);

    if (render.hair_billboard)
        set_batch_directive(batch, "HAIR_BILLBOARD", 1);
    else
        set_batch_directive(batch, "HAIR_BILLBOARD", 0);

    if (render.hair_billboard_spherical === false)
        set_batch_directive(batch, "HAIR_BILLBOARD_SPHERICAL", 0);
    else
        set_batch_directive(batch, "HAIR_BILLBOARD_SPHERICAL", 1);

    switch (render.hair_billboard_type) {
    case "RANDOM":
        set_batch_directive(batch, "HAIR_BILLBOARD_RANDOM", 1);
        set_batch_directive(batch, "HAIR_BILLBOARD_JITTERED", 0);
        break;
    case "JITTERED":
        set_batch_directive(batch, "HAIR_BILLBOARD_RANDOM", 0);
        set_batch_directive(batch, "HAIR_BILLBOARD_JITTERED", 1);
        break;
    default:
        set_batch_directive(batch, "HAIR_BILLBOARD_RANDOM", 0);
        set_batch_directive(batch, "HAIR_BILLBOARD_JITTERED", 0);
        break;
    }

    if (render.dynamic_grass)
        set_batch_directive(batch, "DYNAMIC_GRASS", 1);
    else
        set_batch_directive(batch, "DYNAMIC_GRASS", 0);
    // set flag to recognize it during subs addition
    // maybe should analize directive instead
    batch.dynamic_grass = render.dynamic_grass;
    batch.shadow_cast = render.shadow_cast;
    batch.shadow_cast_only = render.shadow_cast_only;
    batch.shadow_receive = render.shadow_receive;

    batch.reflexible = render.reflexible;
    batch.reflexible_only = render.reflexible_only;
    batch.reflective = render.reflective;

    if (render.is_skinning) {
        set_batch_c_attr(batch, "a_influence");
        set_batch_directive(batch, "SKINNED", 1);

        if (render.frames_blending) {
            set_batch_directive(batch, "FRAMES_BLENDING", 1);
            set_batch_directive(batch, "MAX_BONES", cfg_def.max_bones);
        } else {
            set_batch_directive(batch, "FRAMES_BLENDING", 0);
            set_batch_directive(batch, "MAX_BONES", cfg_def.max_bones_no_blending);
        }
    } else {
        set_batch_directive(batch, "SKINNED", 0);
        set_batch_directive(batch, "FRAMES_BLENDING", 0);
    }

    if (render.vertex_anim)
        set_batch_directive(batch, "VERTEX_ANIM", 1);
    else
        set_batch_directive(batch, "VERTEX_ANIM", 0);

    if (render.is_skinning && render.vertex_anim)
        throw "Skinning and vertex animation are mutually exlusive";

    if (render.disable_fogging)
        set_batch_directive(batch, "DISABLE_FOG", 1);
    else
        set_batch_directive(batch, "DISABLE_FOG", 0);

    if (render.bone_pointers)
        batch.bone_pointers = render.bone_pointers;
}

function update_batch_particle_systems(batch, psystems) {
    for (var i = 0; i < psystems.length; i++) {
        var emitter_col_name = psystems[i]["settings"]["b4w_vcol_from_name"];
        var particle_col_name = psystems[i]["settings"]["b4w_vcol_to_name"];

        if (emitter_col_name !== "" && particle_col_name !== "")
            batch.vertex_colors_usage[emitter_col_name] = {
                generate_buffer: false,
                src: [{ name: emitter_col_name, mask: 7 }]
            }
    }
}

/**
 * Assign directives for shadow receive batch.
 * @param {String} shadow_source One of SHADOW_SOURCE_MAP, SHADOW_SOURCE_MASK, 
 * SHADOW_SOURCE_NONE
 */
exports.assign_shadow_receive_dirs = function(batch, csm_borders) {
    set_batch_directive(batch, "CSM_SECTION0", 0);
    set_batch_directive(batch, "CSM_SECTION1", 0);
    set_batch_directive(batch, "CSM_SECTION2", 0);
    set_batch_directive(batch, "CSM_SECTION3", 0);

    for (var i = 0; i < csm_borders.length; i++) {
        set_batch_directive(batch, "CSM_SECTION" + String(i), 1);
        set_batch_directive(batch, "CSM_SECTION_DIST" + String(i), csm_borders[i]);
    }

    var name = "PCF_TEXEL_SIZE";
    var value = 1 / cfg_scs.shadow_tex_size;
    set_batch_directive(batch, name, value);
}

/**
 * For convenience
 */
function set_batch_c_attr(batch, name) {
    var cattrs = batch.common_attributes;

    if (cattrs.indexOf(name) == -1)
        cattrs.push(name);
}

exports.set_batch_directive = set_batch_directive;
/**
 * Set batch directive.
 * @methodOf batch
 */
function set_batch_directive(batch, name, value) {
    shaders.set_directive(batch.shaders_info, name, value);
}

exports.get_batch_directive = get_batch_directive;
/**
 * Get batch directive.
 * @methodOf batch
 */
function get_batch_directive(batch, name) {
    return shaders.get_directive(batch.shaders_info, name);
}

/**
 * Return vertex anim locations arrays or null
 * TODO: implement averaging for vertex anim
 */
function prepare_vertex_anim_locations(obj) {

    var render = obj._render;

    if (!render.vertex_anim)
        return null;

    // compose anim_locs frames from all animations

    if (obj["data"]["b4w_vertex_anim"].length)
        var va = obj["data"]["b4w_vertex_anim"];
    else
        var va = [];

    var anim_locs = [];

    for (var i = 0; i < va.length; i++) {

        var frames = va[i]["frames"];
        var flen = frames.length;

        var av_int_start = Math.max(0, flen - va[i]["averaging_interval"]);

        for (var j = 0; j < flen; j++) {

            var frame = frames[j];

            if (va[i]["averaging"] && va[i]["averaging_interval"] > 1
                    && j >= av_int_start) {

                // mix coefficient, quadratic averaging
                var a = (j - av_int_start) / (flen - 1 - av_int_start);
                a *= a;

                for (var k = 0; k < frame.length; k++)
                    frame[k] = (1 - a) * frame[k] + 
                            a * frames[frames.length - j - 1][k];
            }

            anim_locs.push(frame);
        }
    }

    return anim_locs;
}

/**
 * Update batch geometry from submesh
 */
function update_batch_geometry(batch, submesh) {
    var zsort_type = batch.zsort_type;
    var draw_mode = batch.draw_mode;
       
    if (batch.halo)
        var submesh = geometry.extract_halo_submesh(submesh);

    if (batch.water_generated_mesh) {
        var num_cascads   = batch.water_num_cascads;
        var subdivs       = batch.water_subdivs;
        var detailed_dist = batch.water_detailed_dist;
        var submesh = primitives.generate_multigrid(num_cascads,
                                                    subdivs, detailed_dist);
    }

    var bufs_data = geometry.submesh_to_bufs_data(submesh, zsort_type, draw_mode,
            batch.vertex_colors_usage);
    // remove unneeded arrays to save memory, keep them only for z-sorted 
    // geometry (bufs for dynamic particles are not here)
    if (!(DEBUG_KEEP_BUFS_DATA_ARRAYS || bufs_data.info_for_z_sort_updates)) {
        delete bufs_data.ibo_array;
        delete bufs_data.vbo_array;
    }
    batch.bufs_data = bufs_data;

    var frames = submesh.va_frames.length;

    batch.num_vertices = submesh.base_length * frames;

    // NOTE: only triangle batches counted
    if (is_triangle_batch(batch)) {
        if (geometry.is_indexed(submesh))
            batch.num_triangles = submesh.indices.length / 3 * frames;
        else
            batch.num_triangles = submesh.base_length / 3 * frames;
    } else
        batch.num_triangles = 0;

    if (DEBUG_SAVE_SUBMESHES)
        batch.submesh = submesh;
}

function is_triangle_batch(batch) {
    switch(batch.draw_mode) {
    case geometry.DM_DEFAULT:
    case geometry.DM_TRIANGLES:
    case geometry.DM_DYNAMIC_TRIANGLES:
        return true;
    default:
        return false;
    }
}


/**
 * Update batch from EMITTER particle system/settings
 */
function update_batch_particles_emitter(batch, mesh, psystem, world_matrix) {

    // TODO need total rewrite

    // from 1
    var mat_index = psystem["settings"]["material"] - 1;
    var material = mesh["materials"][mat_index];

    var pmaterial = {"name" : "PARTICLES"};

    // some params from mesh material
    if (material["type"] === "HALO") {
        pmaterial["halo"] = material["halo"];
        pmaterial["texture_slots"] = [];
    } else {
        pmaterial["texture_slots"] = material["texture_slots"];
    }

    pmaterial["offset_z"] = material["offset_z"];

    pmaterial["diffuse_color"] = material["diffuse_color"];
    pmaterial["diffuse_shader"] = material["diffuse_shader"];
    pmaterial["specular_color"] = material["specular_color"];
    pmaterial["specular_shader"] = material["specular_shader"];
    pmaterial["diffuse_intensity"] = material["diffuse_intensity"];
    pmaterial["alpha"] = material["alpha"];
    pmaterial["game_settings"] = material["game_settings"];

    pmaterial["raytrace_transparency"] = material["raytrace_transparency"];
    pmaterial["raytrace_mirror"] = material["raytrace_mirror"];

    update_batch_material(batch, pmaterial, true);
    // restore possible "STRAND" texture slots
    pmaterial["texture_slots"] = material["texture_slots"];

    var pbufs_data = particles.generate_buffers(batch, mesh, psystem, 
            pmaterial, world_matrix);

    batch.texture_slots = pmaterial["texture_slots"];
    batch.bufs_data = pbufs_data;

    switch(psystem["settings"]["b4w_billboard_align"]) {
    case "VIEW":
        set_batch_directive(batch, "BILLBOARD_ALIGN", "BILLBOARD_ALIGN_VIEW");
        break;
    case "XY":
        set_batch_directive(batch, "BILLBOARD_ALIGN", "BILLBOARD_ALIGN_XY");
        break;
    case "YZ":
        set_batch_directive(batch, "BILLBOARD_ALIGN", "BILLBOARD_ALIGN_YZ");
        break;
    case "ZX":
        set_batch_directive(batch, "BILLBOARD_ALIGN", "BILLBOARD_ALIGN_ZX");
        break;
    default:
        throw "Wrong billboard align value";
        break;
    }
}

/**
 * Create all possible batch slots for object and clone it by ptrans array
 */
function make_hair_particles_batches(em_obj, em_batch, objs, batch_types_arr, objs_ptrans,
        pset, psys, use_grass_map, seed, reset_seed) {

    var slots = [];

    var inst_inherit_bend = pset["b4w_wind_bend_inheritance"] == "INSTANCE";
    var inst_inherit_shadow = pset["b4w_shadow_inheritance"] == "INSTANCE";
    var inst_inherit_reflection = pset["b4w_reflection_inheritance"] == "INSTANCE";

    // do not render dynamic grass if grass map was not requested
    var dyn_grass = pset["b4w_dynamic_grass"];
    if (!use_grass_map && dyn_grass)
        return slots;


    // prepare hair_render arrays and tsr_arrays
    // for objects which particle system composed from
    var objs_hair_render = [];
    var objs_tsr_array = [];

    for (var i = 0; i < objs.length; i++) {
        var obj = objs[i];

        // NOTE: partially override emmiter's render
        var hair_render = util.clone_object_nr(em_obj._render);
        hair_render.hair_billboard = pset["b4w_hair_billboard"];
        hair_render.hair_billboard_type = pset["b4w_hair_billboard_type"];
        hair_render.dynamic_grass = dyn_grass;
        hair_render.hair_billboard_spherical = 
                pset["b4w_hair_billboard_geometry"] == "SPHERICAL";
        hair_render.is_hair_particles = true;

        if (inst_inherit_bend) {
            hair_render.wind_bending = obj._render.wind_bending;
            hair_render.wind_bending_angle = obj._render.wind_bending_angle;
            hair_render.wind_bending_freq = obj._render.wind_bending_freq;
            hair_render.detail_bending_freq = obj._render.detail_bending_freq;
            hair_render.main_bend_col = obj._render.main_bend_col;
            hair_render.detail_bending_amp = obj._render.detail_bending_amp;
            hair_render.branch_bending_amp = obj._render.branch_bending_amp;
            // by link, doesn't matter  
            hair_render.detail_bend_col = obj._render.detail_bend_col;
            hair_render.bend_center_only = false;
            // NOTE: get bounding box from object, because render doesn't contain it
            hair_render.bb_local =  bb_bpy_to_b4w(obj["data"]["b4w_bounding_box"]);
        } else
            hair_render.bend_center_only = true;

        if (inst_inherit_shadow) {
            hair_render.shadow_cast = obj._render.shadow_cast;
            hair_render.shadow_cast_only = obj._render.shadow_cast_only;
            hair_render.shadow_receive = obj._render.shadow_receive;
        }
            
        if (inst_inherit_reflection) {
            hair_render.reflexible = obj._render.reflexible;
            hair_render.reflexible_only = obj._render.reflexible_only;
            hair_render.reflective = obj._render.reflective;
        }

        objs_hair_render.push(hair_render);

        var ptrans = objs_ptrans[i];
        if (!ptrans)
            ptrans = new Float32Array();

        if (reset_seed) 
            util.init_rand_r_seed(psys["seed"], seed);

        var trans = new Float32Array(3);
        var quat = new Float32Array([0, 0, 0, 1]);
        var tsr_array = [];

        for (var j = 0; j < ptrans.length; j+=4) {
            trans[0] = ptrans[j];
            trans[1] = ptrans[j+1];
            trans[2] = ptrans[j+2];
            var scale = ptrans[j+3];

            if (pset["b4w_initial_rand_rotation"]) {
                switch (pset["b4w_rotation_type"]) {
                case "XYZ":
                    var axis = new Float32Array([util.rand_r(seed), util.rand_r(seed), 
                            util.rand_r(seed)]);
                    m_vec3.normalize(axis, axis);
                    break;
                case "Z":
                    var axis = new Float32Array([0, 1, 0]);
                    break;
                default:
                    throw "Unsupported random rotation type: "
                             + pset["b4w_rotation_type"];
                    break;
                }
                var strength = pset["b4w_rand_rotation_strength"];
                m_quat.setAxisAngle(axis, strength * (2 * Math.PI 
                        * util.rand_r(seed) - Math.PI), quat);
            }

            var tsr = m_tsr.create_sep(trans, scale, quat);

            // in object space
            tsr_array.push(tsr);
        }
        objs_tsr_array.push(tsr_array);
    }

    // compose unique batches
    var batches = {};
    for (var i = 0; i < objs.length; i++) {
        var btypes = batch_types_arr[i];
        var hair_render = objs_hair_render[i];
        var hair_render_id = calc_render_id(hair_render);
        var tsr_array = objs_tsr_array[i];

        if (!tsr_array.length)
            continue

        var mesh = objs[i]["data"]
        var materials = mesh["materials"];

        for (var j = 0; j < materials.length; j++) {
            if (geometry.has_empty_submesh(mesh, j))
                continue;

            for (var k = 0; k < btypes.length; k++) {
                var type = btypes[k];
                if (type === "COLOR_ID")
                    continue;

                var batch = init_batch(type);
                var material = materials[j];
                if (!update_batch_material(batch, material, true))
                    continue;
                batch.draw_mode = mesh.draw_mode || geometry.DM_DEFAULT;
                update_batch_render(batch, hair_render);

                batch.odd_id_prop = pset["uuid"];
                update_batch_id(batch, hair_render_id);

                if (!batches[batch.id])
                    batches[batch.id] = {
                        batch: batch,
                        obj_mat_ind: []
                    };
                batches[batch.id].obj_mat_ind.push([i, j]);
            }
        }
    }

    // write batch jitter parameters
    if (pset["b4w_hair_billboard_type"] == "JITTERED")
        for (var i in batches) {
            batches[i].batch.jitter_amp = pset["b4w_hair_billboard_jitter_amp"];
            batches[i].batch.jitter_freq = pset["b4w_hair_billboard_jitter_freq"];
        }

    // spatial tree object for searching nearest emitter vertices
    // will be calculated only once
    var spatial_tree = {};

    // join submeshes for unique batches
    for (var batch_id in batches) {
        var submeshes = [];
        var short_submeshes = [];
        var batch = batches[batch_id].batch;

        for (var i in batches[batch_id].obj_mat_ind) {
            var obj_index = batches[batch_id].obj_mat_ind[i][0];
            var submesh_index = batches[batch_id].obj_mat_ind[i][1];

            var instance = make_hair_instance(objs[obj_index], submesh_index, 
                    objs_tsr_array[obj_index], objs_hair_render[obj_index]);

            if (!inst_inherit_bend) {
                delete batch.vertex_colors_usage["a_bending_col_main"];
                delete batch.vertex_colors_usage["a_bending_col_detail"];
            }

            var submesh = geometry.make_clone_submesh(instance, 
                    batch.common_attributes, batch.vertex_colors_usage, 
                    batch.uv_maps_usage, objs_tsr_array[obj_index]);
            submesh = fill_submesh_center_pos(submesh, objs_tsr_array[obj_index]);

            var particle_inherited_attrs = get_particle_inherited_attrs(pset["b4w_vcol_from_name"], 
                    pset["b4w_vcol_to_name"], batch, em_batch, 
                    !inst_inherit_bend, instance.mesh);
            submesh = make_particle_inherited_vcols(submesh, objs_tsr_array[obj_index], 
                    em_obj, em_batch, particle_inherited_attrs, 
                    batch.vertex_colors_usage, spatial_tree);

            if (!geometry.is_long_submesh(submesh))
                short_submeshes.push(i);

            submeshes.push(submesh);
        }

        if (short_submeshes.length < submeshes.length)
            for (var index in short_submeshes)
                geometry.submesh_drop_indices(submeshes[index]);
        var submesh = geometry.submesh_list_join(submeshes);

        if (batch.type === "PHYSICS")
            batch.submesh = submesh;
        else
            update_batch_geometry(batch, submesh);

        slots.push(create_slot(batch));
    }

    return slots;
}

function make_spatial_tree(spatial_tree, obj_bb_local, positions) {
    spatial_tree.cell_size = new Float32Array(3);
    spatial_tree.base_point = new Float32Array(3);
    spatial_tree.verts_indices = new Uint32Array(positions.length / 3);
    spatial_tree.octs_indices = new Uint32Array(positions.length / 3);

    spatial_tree.cell_size[0] = (obj_bb_local.max_x - obj_bb_local.min_x) / STREE_CELL_COUNT;
    spatial_tree.cell_size[1] = (obj_bb_local.max_y - obj_bb_local.min_y) / STREE_CELL_COUNT;
    spatial_tree.cell_size[2] = (obj_bb_local.max_z - obj_bb_local.min_z) / STREE_CELL_COUNT;

    spatial_tree.base_point[0] = obj_bb_local.min_x;
    spatial_tree.base_point[1] = obj_bb_local.min_y;
    spatial_tree.base_point[2] = obj_bb_local.min_z;

    for (var i = 0; i < positions.length / 3; i++) {
        var x = positions[i * 3];
        var y = positions[i * 3 + 1];
        var z = positions[i * 3 + 2];

        var num_x = util.trunc((x - spatial_tree.base_point[0]) / spatial_tree.cell_size[0]);
        var num_y = util.trunc((y - spatial_tree.base_point[1]) / spatial_tree.cell_size[1]);
        var num_z = util.trunc((z - spatial_tree.base_point[2]) / spatial_tree.cell_size[2]);

        num_x = util.clamp(num_x, 0, STREE_CELL_COUNT - 1)
        num_y = util.clamp(num_y, 0, STREE_CELL_COUNT - 1)
        num_z = util.clamp(num_z, 0, STREE_CELL_COUNT - 1)

        spatial_tree.verts_indices[i] = i;
        spatial_tree.octs_indices[i] = num_z * Math.pow(STREE_CELL_COUNT, 2) 
                + num_y * STREE_CELL_COUNT + num_x;
    }

    geometry.sort_two_arrays(spatial_tree.octs_indices, spatial_tree.verts_indices, 1);

    spatial_tree.verts_offsets = new Uint32Array(Math.pow(STREE_CELL_COUNT, 3));
    for (var i = 0; i < spatial_tree.octs_indices.length; i++) {
        var index = spatial_tree.octs_indices[i];
        spatial_tree.verts_offsets[index]++;
    }
    delete spatial_tree.octs_indices;

    for (var i = 1; i < spatial_tree.verts_offsets.length; i++)
        spatial_tree.verts_offsets[i] += spatial_tree.verts_offsets[i - 1];

    return spatial_tree;
}


function get_particle_inherited_attrs(vc_name_from, vc_name_to, batch, em_batch, 
        bend_inheritance, particle_mesh) {
    var inherited_attrs = [];

    // vertex color inheritance
    if (vc_name_from !== "" && vc_name_to !== "") {

        var col_usage_data = get_vcol_usage_data_by_name(vc_name_to, 
                batch.vertex_colors_usage);

        if (col_usage_data.length > 0)
            for (var i = 0; i < col_usage_data.length; i += 3)
                inherited_attrs.push({
                    emitter_attr: vc_name_from,
                    emitter_mask: 7,
                    particle_attr: col_usage_data[i],
                    particle_mask: col_usage_data[i + 1],
                    dst_channel_offset: col_usage_data[i + 2]
                });
        else
            if (geometry.has_attr(batch.common_attributes, "a_color"))
                if (vc_name_to == particle_mesh["active_vcol_name"])
                    inherited_attrs.push({
                        emitter_attr: vc_name_from,
                        emitter_mask: 7,
                        particle_attr: "a_color",
                        particle_mask: 7,
                        dst_channel_offset: 0
                    })
    }

    // bending inheritance
    if (bend_inheritance) {
        if ("a_bending_col_main" in em_batch.vertex_colors_usage)
            inherited_attrs.push({
                emitter_attr: "a_bending_col_main",
                emitter_mask: 4,
                particle_attr: "a_bending_col_main",
                particle_mask: 4,
                dst_channel_offset: 0
            });
        if ("a_bending_col_detail" in em_batch.vertex_colors_usage)
            inherited_attrs.push({
                emitter_attr: "a_bending_col_detail",
                emitter_mask: 7,
                particle_attr: "a_bending_col_detail",
                particle_mask: 7,
                dst_channel_offset: 0
            });
    }

    return inherited_attrs;
}

function get_vcol_usage_data_by_name(color_name, vc_usage) {
    var data = [];

    for (var attr_name in vc_usage) {
        var src_colors = vc_usage[attr_name].src;
        var dst_channel_offset = 0;
        for (var i = 0; i < src_colors.length; i++) {
            var mask = src_colors[i].mask;
            if (color_name == src_colors[i].name)
                data.push(attr_name, mask, dst_channel_offset);
            dst_channel_offset += util.rgb_mask_get_channels_count(mask);
        }
    }

    return data;
}

function fill_submesh_center_pos(submesh, transforms) {
    submesh.va_common["au_center_pos"] = new Float32Array(submesh.base_length * 3);

    var t_count = transforms.length;
    var base_length = submesh.base_length / t_count;
    for (var i = 0; i < t_count; i++) {
        var transform = transforms[i];
        var v_offset = base_length * 3 * i;

        for (var j = 0; j < base_length; j++) {
            submesh.va_common["au_center_pos"][v_offset + j*3] = transform[0];
            submesh.va_common["au_center_pos"][v_offset + j*3 + 1] = transform[1];
            submesh.va_common["au_center_pos"][v_offset + j*3 + 2] = transform[2];
        }
    }

    return submesh;
}

function make_particle_inherited_vcols(submesh, transforms, emitter, em_batch, 
        inherited_attrs, vc_usage, spatial_tree) {

    var calc_nearest = false;
    for (var i = 0; i < inherited_attrs.length; i++) {
        var em_attr = inherited_attrs[i].emitter_attr;
        var cols = em_batch.submesh.va_common[em_attr];
        if (cols && cols.length > 0) {
            calc_nearest = true;
            break;
        }
    }

    if (calc_nearest) {
        var nearest_points = calc_emitter_nearest_points(emitter._render.bb_local, 
                em_batch.submesh.va_frames[0]["a_position"], transforms, spatial_tree);
        var particle_verts_count = submesh.base_length / transforms.length;

        for (var i = 0; i < inherited_attrs.length; i++) {
            var p_attr = inherited_attrs[i].particle_attr;
            var p_mask = inherited_attrs[i].particle_mask;
            var em_attr = inherited_attrs[i].emitter_attr;
            var em_mask = inherited_attrs[i].emitter_mask;


            var cols = em_batch.submesh.va_common[em_attr];
            switch (p_attr) {
            // NOTE: bending colors may be missed on particles
            case "a_bending_col_main":
                var p_attr_channels_total = 1;
                break;
            case "a_bending_col_detail":
                var p_attr_channels_total = 3;
                break;
            // a_color may be missed in vc_usage
            case "a_color":
                var p_attr_channels_total = 3;
                break;
            default:
                var p_attr_channels_total = 0;
                for (var j = 0; j < vc_usage[p_attr].src.length; j++)
                    p_attr_channels_total += util.rgb_mask_get_channels_count(
                            vc_usage[p_attr].src[j].mask);
                break;
            }
            
            if (cols && cols.length > 0) {
                var emitter_comp_count = util.rgb_mask_get_channels_count(em_mask);
                var particle_comp_count = util.rgb_mask_get_channels_count(p_mask);

                var mask_from = em_mask & p_mask;
                var channel_presence_from = util.rgb_mask_get_channels_presence(mask_from);
                if (mask_from != p_mask)
                    m_print.error("Wrong color extraction from " 
                        + em_attr + " to " + p_attr + ".");

                // NOTE: bending buffers can be uninitialized, overwrite them anyway
                // if there is an inherited color, it's already have initialized buffer
                if (p_attr == "a_bending_col_main" || p_attr == "a_bending_col_detail") 
                    submesh.va_common[p_attr] = new Float32Array(
                            submesh.base_length * particle_comp_count);

                for (var j = 0; j < transforms.length; j++) {
                    var nearest_index = nearest_points[j];
                    var em_vert_offset = nearest_index * emitter_comp_count;
                    var p_offset = j * particle_verts_count * p_attr_channels_total;
                    if (nearest_index != -1)
                        for (var k = 0; k < particle_verts_count; k++) {
                            var p_vert_offset = k * p_attr_channels_total;
                            for (var l = 0; l < channel_presence_from.length; l++)
                                if (channel_presence_from[l]) {
                                    var em_channel_offset = util.rgb_mask_get_channel_presence_index(em_mask, l);
                                    var p_channel_offset = inherited_attrs[i].dst_channel_offset 
                                            + util.rgb_mask_get_channel_presence_index(p_mask, l);
                                    submesh.va_common[p_attr][p_offset 
                                            + p_vert_offset + p_channel_offset] 
                                            = cols[em_vert_offset + em_channel_offset];
                                }
                        }
                }
            } else
                submesh.va_common[p_attr] = new Float32Array(0);
        }

    }

    return submesh;
}

function calc_emitter_nearest_points(em_bb_local, em_positions, transforms, spatial_tree) {

    var particle_cen = new Float32Array(3);
    var em_vert = new Float32Array(3);
    var nearest_points = new Uint32Array(transforms.length);

    if (!("verts_indices" in spatial_tree))
        make_spatial_tree(spatial_tree, em_bb_local, em_positions);

    for (var i = 0; i < transforms.length; i++) {
        particle_cen[0] = transforms[i][0];
        particle_cen[1] = transforms[i][1];
        particle_cen[2] = transforms[i][2];

        var min_dist = 1e+10;
        var min_index = -1;

        // use spatial tree for faster search nearest vertex
        var num_x = util.trunc((particle_cen[0] 
                - spatial_tree.base_point[0]) / spatial_tree.cell_size[0]);
        var num_y = util.trunc((particle_cen[1] 
                - spatial_tree.base_point[1]) / spatial_tree.cell_size[1]);
        var num_z = util.trunc((particle_cen[2] 
                - spatial_tree.base_point[2]) / spatial_tree.cell_size[2]);

        num_x = util.clamp(num_x, 0, STREE_CELL_COUNT - 1)
        num_y = util.clamp(num_y, 0, STREE_CELL_COUNT - 1)
        num_z = util.clamp(num_z, 0, STREE_CELL_COUNT - 1)

        var oct_index = num_z * Math.pow(STREE_CELL_COUNT, 2) 
                + num_y * STREE_CELL_COUNT + num_x;

        var from_index = (oct_index == 0) ? 0 : spatial_tree.verts_offsets[oct_index - 1];
        var to_index = spatial_tree.verts_offsets[oct_index];

        for (var j = from_index; j < to_index; j++) {
            var index = spatial_tree.verts_indices[j];

            em_vert[0] = em_positions[index * 3];
            em_vert[1] = em_positions[index * 3 + 1];
            em_vert[2] = em_positions[index * 3 + 2];

            m_vec3.sub(em_vert, particle_cen, em_vert);
            var sq_len = m_vec3.sqrLen(em_vert);
            if (sq_len <= min_dist) {
                min_dist = sq_len;
                min_index = index;
            }        
        }

        // standard search for nearest vertex
        if (min_index == -1) {
            for (var j = 0; j < em_positions.length / 3; j++) {
                em_vert[0] = em_positions[j * 3];
                em_vert[1] = em_positions[j * 3 + 1];
                em_vert[2] = em_positions[j * 3 + 2];

                m_vec3.sub(em_vert, particle_cen, em_vert);
                var sq_len = m_vec3.sqrLen(em_vert);
                if (sq_len <= min_dist) {
                    min_dist = sq_len;
                    min_index = j;
                }
            }
        }

        nearest_points[i] = min_index;
    }

    return nearest_points;
}

/**
 * Fair distribution among dupli_objects
 */
function distribute_ptrans_equally(ptrans, dupli_objects, seed) {

    var objs_count = dupli_objects.length;
    var ptrans_dist = {};

    for (var i = 0; i < ptrans.length; i+=4) {
        var index = Math.floor(objs_count * util.rand_r(seed));
        var robj_name = dupli_objects[index]["name"];

        ptrans_dist[index] = ptrans_dist[index] || [];
        ptrans_dist[index].push(ptrans[i], ptrans[i+1], ptrans[i+2], ptrans[i+3]);
    }

    for (var index in ptrans_dist)
        ptrans_dist[index] = new Float32Array(ptrans_dist[index]);

    return ptrans_dist;
}

function distribute_ptrans_group(ptrans, dupli_objects) {
    var ptrans_dist = {};

    for (var i = 0; i < ptrans.length; i+=4) {
        for (var j = 0; j < dupli_objects.length; j++) {
            var obj_name = dupli_objects[j]["name"];

            var obj_trans = m_vec3.create();
            m_vec3.scale(dupli_objects[j]._render.trans, dupli_objects[j]._render.scale, obj_trans);

            var res_trans = m_vec3.clone([ptrans[i], ptrans[i+1], ptrans[i+2]]);
            m_vec3.add(res_trans, obj_trans, res_trans);

            if (!ptrans_dist[j])
                ptrans_dist[j] = new Float32Array(ptrans.length);

            ptrans_dist[j][i] = res_trans[0];
            ptrans_dist[j][i + 1] = res_trans[1];
            ptrans_dist[j][i + 2] = res_trans[2];
            ptrans_dist[j][i + 3] = ptrans[i + 3];
        }
    }

    return ptrans_dist;
}

function distribute_ptrans_by_dupli_weights(ptrans, dupli_objects,
        dupli_weights, seed) {

    var ptrans_dist = {};

    function rand_obj_index_by_weights(dupli_weights) {

        var weight_sum_array = [0];
        for (var i = 0; i < dupli_weights.length; i++) {
            var weight = dupli_weights[i];
            weight_sum_array[i+1] = weight_sum_array[i] + weight["count"];
        }

        var last = weight_sum_array[weight_sum_array.length-1];
        var weight_sum_rand = last * util.rand_r(seed);
        var weight_index = 0;

        for (var i = 0; i < weight_sum_array.length; i++) {
            if (weight_sum_rand >= weight_sum_array[i] && 
                    weight_sum_rand < weight_sum_array[i+1]) {
                weight_index = i;
                break;
            }
        }

        //var weight_name = dupli_weights[weight_index]["name"];
        return weight_index;
        //return weight_name.split(": ")[0];
    }

    var dupli_weights_sorted = [];

    for (var i = 0; i < dupli_objects.length; i++) {
        var dg_obj = dupli_objects[i];
        var name = dg_obj["origin_name"] || dg_obj["name"];

        for (var j = 0; j < dupli_weights.length; j++) {
            var weight = dupli_weights[j];
            if (name == weight["name"].split(": ")[0])
                dupli_weights_sorted.push(weight);
        }
    }

    if (dupli_weights.length != dupli_weights_sorted.length)
        m_print.error("B4W Error: dupli weights match failed");

    for (var i = 0; i < ptrans.length; i+=4) {
        var index = rand_obj_index_by_weights(dupli_weights_sorted);
        ptrans_dist[index] = ptrans_dist[index] || [];
        ptrans_dist[index].push(ptrans[i], ptrans[i+1], ptrans[i+2], ptrans[i+3]);
    }

    for (var index in ptrans_dist)
        ptrans_dist[index] = new Float32Array(ptrans_dist[index]);

    return ptrans_dist;
}

function prepare_line_batches(obj) {
    var slot = {};
    var batch = exports.create_line_batch();

    slot.batch = batch;
    obj._batch_slots.push(slot);

    obj._line = {};
}

/**
 * Create baskets for static objects, calc boundings
 * basket: {render: render, objects: objects}
 * some params separate batches
 * some params go to vertex attributes
 */
function create_batch_object_baskets(batch_objects, grid_size) {

    var baskets = [];

    var basket_ids = {};

    for (var i = 0; i < batch_objects.length; i++) {
        var bobj = batch_objects[i];
        var bobj_render = bobj._render;

        // this params will divide batches
        var render_props = {};
        render_props.shadow_cast = bobj_render.shadow_cast;
        render_props.shadow_cast_only = bobj_render.shadow_cast_only;
        render_props.shadow_receive = bobj_render.shadow_receive;

        render_props.selectable = bobj_render.selectable;
        render_props.origin_selectable = bobj_render.origin_selectable;
        render_props.glow_anim_settings = bobj_render.glow_anim_settings;

        render_props.reflexible = bobj_render.reflexible;
        render_props.reflexible_only = bobj_render.reflexible_only;
        render_props.reflective = bobj_render.reflective;
        render_props.caustics = bobj_render.caustics;

        render_props.wind_bending = bobj_render.wind_bending;
        render_props.main_bend_col = bobj_render.main_bend_col;
        // by link, doesn't matter
        render_props.detail_bend_col = bobj_render.detail_bend_col;

        render_props.hair_billboard = bobj_render.hair_billboard;
        render_props.hair_billboard_type = bobj_render.hair_billboard_type;

        render_props.dynamic_grass = bobj_render.dynamic_grass;
        render_props.do_not_cull = bobj_render.do_not_cull;
        render_props.disable_fogging = bobj_render.disable_fogging;

        render_props.grid_id = calc_grid_id(grid_size, bobj_render.trans);

        render_props.lod_dist_max = bobj_render.lod_dist_max;
        render_props.lod_dist_min = bobj_render.lod_dist_min;

        var id = JSON.stringify(render_props);
        basket_ids[id] = basket_ids[id] || [];
        basket_ids[id].push(bobj);
    }

    for (var key in basket_ids) {

        var render_props = JSON.parse(key);
        var objects = basket_ids[key];

        var render = util.create_render("STATIC");
        for (var prop in render_props)
            render[prop] = render_props[prop];

        render.wind_bending_amp = 0;
        render.wind_bending_freq = 0;
        render.detail_bending_freq = 0;
        render.detail_bending_amp = 0;
        render.branch_bending_amp = 0;
        render.hide = false;

        // calculate bounding box/sphere
        for (var i = 0; i < objects.length; i++) {
            var obj = objects[i];

            // bounding box            
            var bb_local = bb_bpy_to_b4w(obj["data"]["b4w_bounding_box"]);
                    
            var bb_world = boundings.bounding_box_transform(bb_local, 
                    obj._render.world_matrix);

            // do not expand for first object 
            if (i == 0)
                render.bb_world = bb_world;
            else
                boundings.expand_bounding_box(render.bb_world, bb_world);

            var bs_local = {
                radius: obj["data"]["b4w_bounding_sphere_radius"],
                center: obj["data"]["b4w_bounding_sphere_center"]
            };

            var bs_world = boundings.bounding_sphere_transform(bs_local, 
                    obj._render.world_matrix);
            
            // do not expand for first object 
            if (i == 0)
                render.bs_world = bs_world;
            else
                boundings.expand_bounding_sphere(render.bs_world, bs_world);

            // bounding ellipsoid
            var be_axes = obj["data"]["b4w_bounding_ellipsoid_axes"];
            var be_local = {
                axis_x: new Float32Array([be_axes[0], 0, 0]),
                axis_y: new Float32Array([0, be_axes[1], 0]),
                axis_z: new Float32Array([0, 0, be_axes[2]]),
                center: obj["data"]["b4w_bounding_ellipsoid_center"]
            };
            render.be_local = be_local;

            var be_world = boundings.bounding_ellipsoid_transform(be_local, render.tsr);
            render.be_world = be_world;
            // TODO: add bounding ellipsoid expand
        }
        
        // same as world because initial batch has identity tranform
        render.bb_local = util.clone_object_r(render.bb_world);
        render.bs_local = util.clone_object_r(render.bs_world);

        var basket = {render: render, objects: objects};
        baskets.push(basket);
    }


    return baskets;
}
/**
 * grid id - [cell_num_x, cell_num_z]
 */
function calc_grid_id(grid_size, position) {
    if (grid_size == 0)
        return [0, 0];

    var base_point = [0, 0, 0];

    var id_x = Math.floor(position[0] / grid_size);
    var id_z = Math.floor(position[2] / grid_size);

    return [id_x, id_z];
}

/**
 * batch slots actually
 */
function make_static_batches(objects, render, meshes, graph) {

    for (var i = 0; i < objects.length; i++) {
        var obj = objects[i];

        var batch_slots = make_dynamic_batches(obj, render, graph, false);
        obj._batch_slots = batch_slots;

        for (var j = 0; j < batch_slots.length; j++)
            batch_slots[j].used = false;
    }

    // parts: [instances0, instances1, instances2...]
    // instances: [[obj,index], [obj,index], ...]
    var parts = [];

    for (var i = 0; i < objects.length; i++) {
        var obj0 = objects[i];
        var batch_slots0 = obj0._batch_slots;

        for (var j = 0; j < batch_slots0.length; j++) {
            var slot0 = batch_slots0[j];

            if (slot0.used)
                continue;

            var instances = [];


            instances.push(make_instance(obj0, slot0.submesh_index,
                    tsr_from_render(obj0._render), render));
            slot0.used = true;

            var batch0 = slot0.batch;

            // batch is a reference batch (first one)
            parts.push({batch: batch0, instances:instances});

            for (var ii = i; ii < objects.length; ii++) {
                var obj = objects[ii];
                var batch_slots = obj._batch_slots;

                for (var jj = 0; jj < batch_slots.length; jj++) {
                    var slot = batch_slots[jj];

                    if (slot.used)
                        continue;

                    var batch = slot.batch;

                    if (batch0.id == batch.id) {
                        instances.push(make_instance(obj, slot.submesh_index,
                                tsr_from_render(obj._render), render));
                        slot.used = true;
                    }
                }
            }
        }
    }


    var batch_slot_sphere = null;
    for (var i = 0; i < parts.length; i++) {

        var part = parts[i];
        var batch = part.batch;

        var instances = part.instances;

        var submesh = geometry.make_batch_submesh(instances, 
                batch.common_attributes, batch.vertex_colors_usage,
                batch.uv_maps_usage);

        if (batch.type === "PHYSICS")
            batch.submesh = submesh;
        else
            update_batch_geometry(batch, submesh);

        for (var j = 0; j < instances.length; j++) {
            var obj = instances[j].obj;

            // generate debug sphere 
            if (cfg_def.wireframe_debug && batch_slot_sphere === null) {
                var add_debug_sphere = false;
                for (var k = 0; k < obj._batch_slots.length; k++) {
                    var obj_batch = obj._batch_slots[k].batch;
                    if (BATCH_TYPES_DEBUG_SPHERE.indexOf(obj_batch.type) > -1) {
                        add_debug_sphere = true;
                        break;
                    }
                }
                if (add_debug_sphere) {
                    batch_slot_sphere = {};
                    batch_slot_sphere.batch = create_bounding_ellipsoid_batch(render.bs_local, obj, false);
                    batch_slot_sphere.batch.debug_sphere_dynamic = false;
                    update_batch_render(batch_slot_sphere.batch, render);
                    append_batch_slot(obj, batch_slot_sphere);
                }
            }

            for (var k = 0; k < obj._batch_slots.length; k++) {
                var slot = obj._batch_slots[k];

                if (slot.batch.id == batch.id)
                    slot.batch = batch;
            }
        }

    }

}

function tsr_from_render(render) {
    return m_tsr.create_sep(render.trans, render.scale, render.quat);
}

function update_batch_id(batch, render_id) {
    delete batch.id;

    // batch copy, will be JSON.stringified
    var batch_cp = {};

    for (var prop in batch) {
        if (batch[prop] && (typeof batch[prop] == "object")) {
            if (util.is_arr_buf_view(batch[prop]))
                batch_cp[prop] = batch[prop];
            else if (batch[prop] instanceof Array && batch[prop][0] &&
                    typeof batch[prop][0] == "object")
                batch_cp[prop] = ["NA"];
            else if (batch[prop] instanceof Array)
                batch_cp[prop] = batch[prop];
            else
                batch_cp[prop] = {"N":"A"};
        } else
            batch_cp[prop] = batch[prop];
    }

    // objects which can be safely JSON.stringify-ed
    batch_cp.shaders_info = batch.shaders_info;
    batch_cp.node_elements = batch.node_elements;
    batch_cp.vertex_colors_usage = batch.vertex_colors_usage;
    batch_cp.uv_maps_usage = batch.uv_maps_usage;

    batch_cp.textures = [];
    for (var i = 0; i < batch.textures.length; i++) {
        var texture = batch.textures[i];
        batch_cp.textures.push(m_textures.calc_texture_id(texture));
    }

    batch.id = JSON.stringify(batch_cp) + render_id;
}

function calc_render_id(render) {
    return JSON.stringify(render);
}

/**
 * Create instance.
 * for typical use cases, allows world matrix and render override.
 */
function make_instance(obj, submesh_index, transform_tsr, over_render) {
    var transform_tsr = transform_tsr || tsr_from_render(over_render);
    
    // params: {"a_name": [values], ...}}  
    var instance = {
        obj: obj,
        transform: transform_tsr,
        params: {},
        mesh: obj["data"],
        submesh_index: submesh_index
    };

    // possible center position
    if (over_render.type == "STATIC" && over_render.wind_bending) {
        var values = [];
        values.push(transform_tsr[0], transform_tsr[1], transform_tsr[2]);
        instance.params["au_center_pos"] = values; 

        var angle = obj["b4w_wind_bending_angle"];
        var bbox = bb_bpy_to_b4w(obj["data"]["b4w_bounding_box"]);
        var amp = wb_angle_to_amp(angle, bbox, obj["scale"][0]);
        instance.params["au_wind_bending_amp"] = [amp];

        instance.params["au_wind_bending_freq"] = [obj["b4w_wind_bending_freq"]];
        instance.params["au_detail_bending_amp"] = [obj["b4w_detail_bending_amp"]];
        instance.params["au_detail_bending_freq"] = [obj["b4w_detail_bending_freq"]];
        instance.params["au_branch_bending_amp"] = [obj["b4w_branch_bending_amp"]];
    }
    return instance;
}

function make_hair_instance(obj, submesh_index, transform_tsr, over_render) {
    var transform_tsr = transform_tsr || tsr_from_render(over_render);
    
    // params: {"a_name": [values], ...}}  
    var instance = {
        obj: obj,
        transform: transform_tsr,
        params: {},
        mesh: obj["data"],
        submesh_index: submesh_index
    };

    // possible center position
    if (over_render.wind_bending || over_render.dynamic_grass 
            || over_render.hair_billboard) {
        var angle = over_render.wind_bending_angle;
        var amp = wb_angle_to_amp(angle, over_render.bb_local, obj["scale"][0]);
        instance.params["au_wind_bending_amp"] = [amp];

        instance.params["au_wind_bending_freq"] = [over_render.wind_bending_freq];
        instance.params["au_detail_bending_freq"] = [over_render.detail_bending_freq];
        instance.params["au_detail_bending_amp"] = [over_render.detail_bending_amp];
        instance.params["au_branch_bending_amp"] = [over_render.branch_bending_amp];
    }
    return instance;
}

exports.create_slot = create_slot;
/**
 * Create batch slot
 * @param batch Batch object
 * @param [submesh_index=-1] Submesh index for geometry extraction
 * @param [psys] Particle system for particle batch
 */
function create_slot(batch, submesh_index, psys) {
    var slot = {
        batch: batch,
        submesh_index: (typeof submesh_index == "number") ? submesh_index : -1,
        particle_system: psys || null,
        // used for static batch calculation
        used: false
    }

    return slot;
}

/**
 * Append slot to object with 
 * NOTE: unique batch needed (?)
 */
function append_batch_slot(obj, new_slot) {

    for (var i = 0; i < obj._batch_slots.length; i++) {
        var slot = obj._batch_slots[i];

        if (slot.batch == new_slot.batch)
            return
    }

    obj._batch_slots.push(new_slot);
}

/**
 * Create special batch for bounding ellipsoid debug rendering
 */
function create_bounding_ellipsoid_batch(bv, obj, ellipsoid) {

    var batch = init_batch("WIREFRAME");

    apply_shader(batch, "wireframe.glslv", "wireframe.glslf");

    batch.wireframe_mode = 0;
    batch.debug_sphere = true;

    batch.depth_mask = true;
    batch.odd_id_prop = obj.name;

    if (ellipsoid) {
        var submesh = primitives.generate_uv_sphere(16, 8, 1, bv.center,
                                                    false, false);
        var scale = [bv.axis_x[0], bv.axis_y[1], bv.axis_z[2]];
        geometry.scale_submesh_xyz(submesh, scale, bv.center)
    } else
        var submesh = primitives.generate_uv_sphere(16, 8, bv.radius, bv.center,
                                                    false, false);

    geometry.submesh_drop_indices(submesh, 1, true);
    submesh.va_common["a_polyindex"] = geometry.extract_polyindices(submesh);

    update_batch_geometry(batch, submesh);
    update_batch_id(batch, calc_render_id(obj._render));
    return batch;
}

function apply_shader(batch, vert, frag) {
    batch.shaders_info = {
        vert: vert,
        frag: frag,
        directives: []
    };
    
    shaders.set_default_directives(batch.shaders_info);
}

exports.append_texture = append_texture;
/**
 * Append texture to batch.
 * @methodOf batch
 * @param texture Texture ID
 * @param [name] Uniform name for appended texture
 */
function append_texture(batch, texture, name) {
    // NOTE: special one-texture case
    if (batch.textures.length == 1 && batch.texture_names.length == 0)
        batch.texture_names.push("default0");

    name = name || "default" + String(batch.textures.length)

    // unique only
    if (batch.texture_names.indexOf(name) == -1) {
        batch.textures.push(texture);
        batch.texture_names.push(name);
    }
}

exports.replace_texture = function(batch, texture, name) {
    var index = batch.texture_names.indexOf(name);
    if (index > -1)
        batch.textures[index] = texture;
}

/**
 * Create special shadeless batch for submesh debugging purposes
 * alpha is optional
 */
exports.create_shadeless_batch = function(submesh, color, alpha) {

    var batch = init_batch("SHADELESS");

    apply_shader(batch, "shadeless.glslv", "shadeless.glslf");
    update_shader(batch);

    if (alpha === 0 || alpha) {
        batch.blend = true;
        batch.diffuse_color = new Float32Array([color[0], color[1], color[2], 
                alpha]);
        batch.depth_mask = false;
    } else {
        batch.blend = false;
        batch.diffuse_color = new Float32Array([color[0], color[1], color[2], 1]);
        batch.depth_mask = true;
    }

    batch.zsort_type = geometry.ZSORT_DISABLED;
    batch.depth_mask = true;

    batch.draw_mode = geometry.DM_TRIANGLES;

    update_batch_geometry(batch, submesh);

    return batch;
}

exports.update_shader = update_shader;
/**
 * Update shader id for batch
 * @methodOf batch
 */
function update_shader(batch) {
    if (!batch.shaders_info)
        throw "No shaders info for batch " + batch.name;

    batch.shader = shaders.get_compiled_shader(batch.shaders_info,
                                               batch.node_elements);
}

/**
 * Check if batch's shader has permanent uniform setter with given name
 */
exports.check_batch_perm_uniform = function(batch, uniform_name) {
    var uni_setters = batch.shader.permanent_uniform_setters;

    if (!uni_setters)
        return false;

    if (uni_setters[uniform_name])
        return true;

    return false;
}

/**
 * Create depth batch based on main batch
 */
exports.fork_depth_batch = function(batch_src, shadow_source, shadow_destination) {

    var batch = init_batch("DEPTH");

    batch.blend = false;

    apply_shader(batch, "depth.glslv", "depth.glslf");
    
    var shaders_info = batch.shaders_info;
    shaders.inherit_directives(shaders_info, batch_src.shaders_info);
    shaders.set_directive(shaders_info, "SHADOW_SRC", shadow_source);
    shaders.set_directive(shaders_info, "SHADOW_DST", shadow_destination);

    // NOTE: do not update here to save some time
    //update_shader(batch);

    batch.use_backface_culling = batch_src.use_backface_culling;

    batch.texture_scale = batch_src.texture_scale;

    batch.dynamic_grass = batch_src.dynamic_grass;

    //batch.diffuse_color.set(batch_src.diffuse_color); 

    // NOTE: buffers by link
    batch.bufs_data = batch_src.bufs_data;

    // NOTE: for proper batch culling (see is_have_batch())
    batch.id = batch_src.id;

    // NOTE: possible single sampler required
    if (batch_src.textures.length) {
        batch.textures[0] = batch_src.textures[0];
        batch.texture_names[0] = batch_src.texture_names[0];
    }

    batch.colormap0_uv_velocity = batch_src.colormap0_uv_velocity;
    batch.common_attributes = batch_src.common_attributes;
    batch.jitter_amp = batch_src.jitter_amp;
    batch.jitter_freq = batch_src.jitter_freq;

    // NOTE: properties for debugging
    batch.num_triangles = batch_src.num_triangles;
    batch.num_vertices = batch_src.num_vertices;
    batch.odd_id_prop = batch_src.odd_id_prop;

    // NOTE: access to forked batches from source batch for material inheritance
    if (!batch_src.childs)
        batch_src.childs = [];
    batch_src.childs.push(batch);

    return batch;
}

exports.create_depth_pack_batch = function(tex) {

    var batch = init_batch("DEPTH_PACK");

    apply_shader(batch, "postprocessing/postprocessing.glslv", 
            "postprocessing/depth_pack.glslf");
    update_shader(batch);

    batch.use_backface_culling = true;
    batch.blend = false;
    batch.depth_mask = false;

    var submesh = primitives.generate_billboard();
    update_batch_geometry(batch, submesh);

    return batch;
}

exports.create_hud_batch = function() {
    var batch = init_batch("HUD");

    apply_shader(batch, "postprocessing/postprocessing.glslv", 
            "postprocessing/postprocessing.glslf");
    update_shader(batch);

    batch.use_backface_culling = true;

    batch.blend = true;
    batch.zsort_type = geometry.ZSORT_DISABLED;
    batch.depth_mask = false;

    batch.texel_size = new Float32Array([0,0]);
    batch.texel_mask = new Float32Array([1,1]);
    batch.texel_size_multipler = 1;

    var submesh = primitives.generate_billboard();
    update_batch_geometry(batch, submesh);

    return batch;
}

exports.create_postprocessing_batch = function(post_effect) {

    var batch = init_batch("POSTPROCESSING");

    apply_shader(batch, "postprocessing/postprocessing.glslv",
            "postprocessing/postprocessing.glslf");
    
    switch(post_effect) {
    case "NONE":
        set_batch_directive(batch, "POST_EFFECT", "POST_EFFECT_NONE");
        batch.texel_mask = new Float32Array([1,1]);
        break;
    case "GRAYSCALE":
        set_batch_directive(batch, "POST_EFFECT", "POST_EFFECT_GRAYSCALE");
        batch.texel_mask = new Float32Array([1,1]);
        break;
    case "X_BLUR":
        set_batch_directive(batch, "POST_EFFECT", "POST_EFFECT_X_BLUR");
        batch.texel_mask = new Float32Array([1,0]);
        break;
    case "Y_BLUR":
        set_batch_directive(batch, "POST_EFFECT", "POST_EFFECT_Y_BLUR");
        batch.texel_mask = new Float32Array([0,1]);
        break;
    case "X_EXTEND":
        set_batch_directive(batch, "POST_EFFECT", "POST_EFFECT_X_EXTEND");
        batch.texel_mask = new Float32Array([1,0]);
        break;
    case "Y_EXTEND":
        set_batch_directive(batch, "POST_EFFECT", "POST_EFFECT_Y_EXTEND");
        batch.texel_mask = new Float32Array([0,1]);
        break;
    default:
        throw "Wrong postprocessing effect: " + post_effect;
        break;
    }

    update_shader(batch);

    batch.texel_size = new Float32Array([0,0]);
    batch.texel_size_multipler = 1;

    batch.use_backface_culling = true;
    batch.blend = false;
    batch.depth_mask = false;

    var submesh = primitives.generate_billboard();
    update_batch_geometry(batch, submesh);

    return batch;
}

/**
 * @deprecated Unused
 */
exports.create_edge_batch = function(texture) {
    var batch = init_batch("EDGE");

    apply_shader(batch, "postprocessing/postprocessing.glslv", 
            "postprocessing/edge.glslf");
    update_shader(batch);

    batch.depth_mask = false;
    batch.use_backface_culling = true;

    batch.texel_size = new Float32Array([0,0]);
    batch.texel_mask = new Float32Array([1,1]);
    batch.texel_size_multipler = 1;

    var submesh = primitives.generate_billboard();
    update_batch_geometry(batch, submesh);

    return batch;
}

exports.create_ssao_batch = function(ssao_samples) {

    var batch = init_batch("SSAO");

    apply_shader(batch, "postprocessing/postprocessing.glslv", 
            "postprocessing/ssao.glslf");

    set_batch_directive(batch, "SSAO_QUALITY", "SSAO_QUALITY_" + ssao_samples);

    update_shader(batch);

    batch.depth_mask = false;
    batch.use_backface_culling = true;

    batch.texel_size = new Float32Array([0,0]);
    batch.texel_mask = new Float32Array([1,1]);
    batch.texel_size_multipler = 1;

    var submesh = primitives.generate_billboard();
    update_batch_geometry(batch, submesh);

    return batch;
}

exports.create_dof_batch = function() {

    var batch = init_batch("DOF");

    apply_shader(batch, "postprocessing/postprocessing.glslv", 
            "postprocessing/dof.glslf");
    set_batch_directive(batch, "DEPTH_RGBA", 1);
    update_shader(batch);

    batch.depth_mask = false;
    batch.use_backface_culling = true;

    batch.texel_size = new Float32Array([0,0]);
    batch.texel_mask = new Float32Array([1,1]);
    batch.texel_size_multipler = 1;

    var submesh = primitives.generate_billboard();
    update_batch_geometry(batch, submesh);

    return batch;
}

exports.create_glow_batch = function() {

    var batch = init_batch("GLOW");

    apply_shader(batch, "postprocessing/postprocessing.glslv", 
            "postprocessing/glow.glslf");

    update_shader(batch);

    batch.depth_mask = false;
    batch.use_backface_culling = true;

    batch.texel_size = new Float32Array([0,0]);
    batch.texel_mask = new Float32Array([1,1]);
    batch.texel_size_multipler = 1;

    var submesh = primitives.generate_billboard();
    update_batch_geometry(batch, submesh);

    return batch;
}

exports.create_god_rays_batch = function(tex_input, pack, water, steps) {

    var batch = init_batch("GOD_RAYS");

    apply_shader(batch, "postprocessing/god_rays.glslv", 
            "postprocessing/god_rays.glslf");
    set_batch_directive(batch, "DEPTH_RGBA", pack);
    set_batch_directive(batch, "WATER_EFFECTS", water);
    set_batch_directive(batch, "STEPS_PER_PASS", shaders.glsl_value(steps, 1));
    update_shader(batch);

    batch.depth_mask = false;
    batch.use_backface_culling = true;

    batch.texel_size = new Float32Array([0,0]);
    batch.texel_mask = new Float32Array([1,1]);
    batch.texel_size_multipler = 1;

    var submesh = primitives.generate_billboard();
    update_batch_geometry(batch, submesh);

    return batch;
}

exports.create_god_rays_combine_batch = function(tex_main, tex_god_rays) {

    var batch = init_batch("GOD_RAYS_COM");

    apply_shader(batch, "postprocessing/postprocessing.glslv", 
            "postprocessing/god_rays_combine.glslf");
    update_shader(batch);

    batch.depth_mask = false;
    batch.use_backface_culling = true;

    batch.texel_size = new Float32Array([0,0]);
    batch.texel_mask = new Float32Array([1,1]);
    batch.texel_size_multipler = 1;

    var submesh = primitives.generate_billboard();
    update_batch_geometry(batch, submesh);

    return batch;
}

exports.create_sky_batch = function() {

    var batch = init_batch("SKY");

    apply_shader(batch, "procedural_skydome.glslv", 
            "procedural_skydome.glslf");
    set_batch_directive(batch, "NUM_LIGHTS", 1);
    set_batch_directive(batch, "WATER_EFFECTS", 1);
    update_shader(batch);

    batch.depth_mask = false;
    batch.use_backface_culling = true;

    batch.texel_size = new Float32Array([0,0]);
    batch.texel_mask = new Float32Array([1,1]);
    batch.texel_size_multipler = 1;

    var submesh = primitives.generate_cube();
    update_batch_geometry(batch, submesh);

    return batch;
}

exports.create_blur_depth_batch = function(orient) {

    var batch = init_batch("BLUR_DEPTH");

    apply_shader(batch, "postprocessing/postprocessing.glslv", 
            "postprocessing/blur_depth.glslf");
    update_shader(batch);

    batch.depth_mask = false;
    batch.use_backface_culling = true;

    batch.texel_size = new Float32Array([0,0]);
    var texel_mask = (orient === "X" ? [1, 0] : [0, 1]);    
    batch.texel_mask = new Float32Array(texel_mask);
    batch.texel_size_multipler = 1;

    var submesh = primitives.generate_billboard();
    update_batch_geometry(batch, submesh);

    return batch;
}

exports.create_antialiasing_batch = function() {
    var batch = init_batch("ANTIALIASING");

    apply_shader(batch, "postprocessing/postprocessing.glslv",
            "postprocessing/antialiasing.glslf");

    set_batch_directive(batch, "AA_METHOD", "AA_METHOD_FXAA_QUALITY");

    update_shader(batch);

    batch.depth_mask = false;
    batch.use_backface_culling = true;

    batch.texel_size = new Float32Array([0,0]);
    batch.texel_mask = new Float32Array([1,1]);
    batch.texel_size_multipler = 1;

    var submesh = primitives.generate_billboard();
    update_batch_geometry(batch, submesh);

    return batch;
}

exports.create_smaa_batch = function(type) {
    var batch = init_batch("SMAA");

    apply_shader(batch, "postprocessing/smaa.glslv",
            "postprocessing/smaa.glslf");

    set_batch_directive(batch, "AA_METHOD", "AA_METHOD_SMAA_HIGH");
    set_batch_directive(batch, "SMAA_PASS", type);

    update_shader(batch);

    batch.depth_mask = false;
    batch.use_backface_culling = true;

    batch.texel_size = new Float32Array([0,0]);
    batch.texel_mask = new Float32Array([1,1]);
    batch.texel_size_multipler = 1 / cfg_def.resolution_factor;

    var submesh = primitives.generate_billboard();
    update_batch_geometry(batch, submesh);

    return batch;
}

exports.create_lanczos_batch = function(type) {
    var batch = init_batch("LANCZOS");

    apply_shader(batch, "postprocessing/postprocessing.glslv",
            "postprocessing/lanczos.glslf");

    update_shader(batch);

    batch.depth_mask = false;
    batch.use_backface_culling = true;

    batch.texel_size = new Float32Array([0,0]);
    batch.texel_size_multipler = 1 / cfg_def.resolution_factor;

    if (type == "LANCZOS_X")
        batch.texel_mask = new Float32Array([1,0]);
    else if (type == "LANCZOS_Y")
        batch.texel_mask = new Float32Array([0,1]);

    var submesh = primitives.generate_billboard();
    update_batch_geometry(batch, submesh);

    return batch;
}

exports.create_compositing_batch = function() {
    var batch = init_batch("COMPOSITING");

    apply_shader(batch, "postprocessing/postprocessing.glslv", 
            "postprocessing/compositing.glslf");

    update_shader(batch);

    batch.depth_mask = false;
    batch.use_backface_culling = true;

    batch.texel_size = new Float32Array([0,0]);
    batch.texel_mask = new Float32Array([1,1]);
    batch.texel_size_multipler = 1;

    var submesh = primitives.generate_billboard();
    update_batch_geometry(batch, submesh);

    return batch;
}

exports.create_motion_blur_batch = function(decay_threshold) {

    var batch = init_batch("MOTION_BLUR");

    apply_shader(batch, "postprocessing/postprocessing.glslv", 
            "postprocessing/motion_blur.glslf");
    set_batch_directive(batch, "BLUR_DECAY_THRESHOLD", 
            shaders.glsl_value(decay_threshold));
    update_shader(batch);

    batch.use_backface_culling = true;
    batch.blend = false;
    batch.depth_mask = false;

    var submesh = primitives.generate_billboard();
    update_batch_geometry(batch, submesh);

    return batch;
}

exports.create_anaglyph_batch = function(post_effect) {

    var batch = init_batch("ANAGLYPH");

    apply_shader(batch, "postprocessing/postprocessing.glslv", 
            "postprocessing/anaglyph.glslf");
    update_shader(batch);

    batch.use_backface_culling = true;
    batch.blend = false;
    batch.depth_mask = false;

    var submesh = primitives.generate_billboard();
    update_batch_geometry(batch, submesh);

    return batch;
}

/**
 * @deprecated Unused
 */
exports.create_line_batch = function() {

    var batch = init_batch("MAIN", "LINE");

    apply_shader(batch, "line.glslv", "line.glslf");
    set_batch_directive(batch, "NUM_POINTS", 2);
    update_shader(batch);

    batch.use_backface_culling = false;
    batch.blend = false;
    batch.depth_mask = false;

    batch.diffuse_color = new Float32Array([0, 1, 0, 1]);
    batch.draw_mode = geometry.DM_LINES;

    batch.line_points = new Float32Array([0,0,0, 1,1,1]);


    var submesh = primitives.generate_lines(1);
    update_batch_geometry(batch, submesh);

    return batch;
}

exports.create_luminance_batch = function() {

    var batch = init_batch("LUMINANCE");

    apply_shader(batch, "postprocessing/postprocessing.glslv", 
            "postprocessing/luminance.glslf");
    update_shader(batch);

    batch.depth_mask = false;
    batch.use_backface_culling = true;

    batch.texel_size = new Float32Array([0,0]);
    batch.texel_mask = new Float32Array([1,1]);
    batch.texel_size_multipler = 1;

    var submesh = primitives.generate_billboard();
    update_batch_geometry(batch, submesh);

    return batch;
}

exports.create_average_luminance_batch = function() {

    var batch = init_batch("LUMINANCE");

    apply_shader(batch, "postprocessing/postprocessing.glslv", 
            "postprocessing/luminance_av.glslf");
    update_shader(batch);

    batch.depth_mask = false;
    batch.use_backface_culling = true;

    batch.texel_size = new Float32Array([0,0]);
    batch.texel_mask = new Float32Array([1,1]);
    batch.texel_size_multipler = 1;

    var submesh = primitives.generate_billboard();
    update_batch_geometry(batch, submesh);

    return batch;
}

exports.create_luminance_trunced_batch = function() {

    var batch = init_batch("LUMINANCE_X_BLUR");

    apply_shader(batch, "postprocessing/luminance_trunced.glslv", 
            "postprocessing/luminance_trunced.glslf");
    update_shader(batch);

    batch.depth_mask = false;
    batch.use_backface_culling = true;

    batch.texel_size = new Float32Array([0,0]);
    batch.texel_mask = new Float32Array([1,1]);
    batch.texel_size_multipler = 1;

    var submesh = primitives.generate_billboard();
    update_batch_geometry(batch, submesh);

    return batch;
}

exports.create_bloom_blur_batch = function(post_effect) {

    var batch = init_batch("POSTPROCESSING");

    apply_shader(batch, "postprocessing/postprocessing.glslv",
            "postprocessing/bloom_blur.glslf");

    switch(post_effect) {
    case "X_BLUR":
        batch.texel_mask = new Float32Array([1,0]);
        break;
    case "Y_BLUR":
        batch.texel_mask = new Float32Array([0,1]);
        break;
    default:
        throw "Wrong postprocessing effect for bloom blur: " + post_effect;
        break;
    }

    update_shader(batch);

    batch.texel_size = new Float32Array([0,0]);
    batch.texel_size_multipler = 1;

    batch.use_backface_culling = true;
    batch.blend = false;
    batch.depth_mask = false;

    var submesh = primitives.generate_billboard();
    update_batch_geometry(batch, submesh);

    return batch;
}

exports.create_bloom_combine_batch = function() {

    var batch = init_batch("BLOOM");

    apply_shader(batch, "postprocessing/postprocessing.glslv", 
            "postprocessing/bloom_combine.glslf");
    update_shader(batch);

    batch.depth_mask = false;
    batch.use_backface_culling = true;

    batch.texel_size = new Float32Array([0,0]);
    batch.texel_mask = new Float32Array([1,1]);
    batch.texel_size_multipler = 1;

    var submesh = primitives.generate_billboard();
    update_batch_geometry(batch, submesh);

    return batch;
}

/**
 * Set batch texel size
 */
exports.set_texel_size = function(batch, size_x, size_y) {

    var mult = batch.texel_size_multipler;
    batch.texel_size[0] = size_x * batch.texel_mask[0] * mult;
    batch.texel_size[1] = size_y * batch.texel_mask[1] * mult;
}

/**
 * Set batch texel size multiplier.
 * Use set_texel_size() to update shader uniforms
 */
exports.set_texel_size_mult = function(batch, mult) {
    batch.texel_size_multipler = mult;
}

/**
 * Delete all GL objects from the batch
 */
exports.clear_batch = function(batch) {

    var textures = batch.textures;

    for (var i = 0; i < textures.length; i++) {
        var tex = textures[i];
        m_textures.delete_texture(tex.w_texture);
    }

    geometry.cleanup_bufs_data(batch.bufs_data);
}

}
