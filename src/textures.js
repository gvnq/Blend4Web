"use strict";

/**
 * Textures internal API.
 * Don't forget to register GL context by setup_context() function.
 * @name textures
 * @namespace
 * @exports exports as textures
 */
b4w.module["__textures"] = function(exports, require) {

var config     = require("__config");
var m_print    = require("__print");
var m_dds        = require("__dds");
var extensions = require("__extensions");
var util       = require("__util");

var cfg_def = config.defaults;

// texture filters, proper values assigned by setup_context()

// mag & min
exports.TF_NEAREST = 0;
exports.TF_LINEAR = 0;
// min only
exports.TF_NEAREST_MIPMAP_NEAREST = 0;
exports.TF_LINEAR_MIPMAP_NEAREST = 0;
exports.TF_NEAREST_MIPMAP_LINEAR = 0;
exports.TF_LINEAR_MIPMAP_LINEAR = 0;

// texture types
exports.TT_RGBA_INT = 10;
exports.TT_RGB_INT = 20;
exports.TT_RGBA_FLOAT = 30;
exports.TT_RGB_FLOAT = 40;
exports.TT_DEPTH = 50;
exports.TT_RENDERBUFFER = 60;

var CHANNEL_SIZE_BYTES_INT = 4;
var CHANNEL_SIZE_BYTES_FLOAT = 16;
var CHANNEL_SIZE_BYTES_DEPTH = 3;
var CHANNEL_SIZE_BYTES_RENDERBUFFER = 2;

var gl;

// texture quality
var LEVELS;

/**
 * Setup WebGL context
 * @param ctx webgl context
 */
exports.setup_context = function(ctx) {
    gl = ctx;
    LEVELS = [
        gl.NEAREST_MIPMAP_NEAREST, 
        gl.NEAREST_MIPMAP_LINEAR,   
        gl.LINEAR_MIPMAP_NEAREST, // better and faster than gl.NEAREST_MIPMAP_LINEAR
        gl.LINEAR_MIPMAP_LINEAR    
    ];

    exports.TF_NEAREST = gl.NEAREST;
    exports.TF_LINEAR = gl.LINEAR;
    // min only
    exports.TF_NEAREST_MIPMAP_NEAREST = gl.NEAREST_MIPMAP_NEAREST;
    exports.TF_LINEAR_MIPMAP_NEAREST = gl.LINEAR_MIPMAP_NEAREST;
    exports.TF_NEAREST_MIPMAP_LINEAR = gl.NEAREST_MIPMAP_LINEAR;
    exports.TF_LINEAR_MIPMAP_LINEAR = gl.LINEAR_MIPMAP_LINEAR;
}

/**
 * Create empty b4w texture.
 * same format as bpy_texture._render
 * @param {String} name Texture name
 * @param type Texture type
 */
exports.create_texture = function(name, type) {

    var texture = {};
    texture.name = name;
    texture.type = type;
    texture.source = "NONE";
    texture.width = 0;
    texture.height = 0;
    texture.compress_ratio = 1;

    if (type == exports.TT_RENDERBUFFER) {
        texture.w_renderbuffer = gl.createRenderbuffer();
    } else {
        var w_target = gl.TEXTURE_2D;
        var w_texture = gl.createTexture();

        gl.bindTexture(w_target, w_texture);

        // NOTE: standard params suitable for POT and NPOT textures
        gl.texParameteri(w_target, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(w_target, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(w_target, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(w_target, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

        gl.bindTexture(w_target, null);

        texture.w_target = w_target;
        texture.w_texture = w_texture; 
    }

    return texture;
}

/**
 * Create cubemap b4w texture.
 * @param {String} name Texture name
 * @param {Number} size Size of texture
 */
exports.create_cubemap_texture = function(name, size) {

    var w_texture = gl.createTexture();

    var w_target = gl.TEXTURE_CUBE_MAP;

    gl.bindTexture(w_target, w_texture);

    // NOTE: standard params suitable for POT and NPOT textures
    gl.texParameteri(w_target, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(w_target, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(w_target, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(w_target, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    var infos = [
        "TEXTURE_CUBE_MAP_POSITIVE_X", 
        "TEXTURE_CUBE_MAP_NEGATIVE_X",
        "TEXTURE_CUBE_MAP_POSITIVE_Y", 
        "TEXTURE_CUBE_MAP_NEGATIVE_Y",
        "TEXTURE_CUBE_MAP_POSITIVE_Z", 
        "TEXTURE_CUBE_MAP_NEGATIVE_Z"
    ];        

    for (var i = 0; i < 6; i++) {
        var info = infos[i];
        gl.texImage2D(gl[info], 0, gl.RGBA,
            size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    }

    gl.bindTexture(w_target, null);

    var texture = {};
    
    texture.name = name;
    texture.type = exports.TT_RGBA_INT;
    texture.source = "NONE";
    texture.width = 3*size;
    texture.height = 2*size;
    texture.compress_ratio = 1;

    texture.w_texture = w_texture; 
    texture.w_target = gl.TEXTURE_CUBE_MAP;

    return texture;
}
/**
 * Set texture MIN/MAG filters (TF_*)
 */
exports.set_filters = function(texture, min_filter, mag_filter) {

    if (texture.type == exports.TT_RENDERBUFFER)
        return;

    var w_target = texture.w_target;
    var w_texture = texture.w_texture;

    gl.bindTexture(w_target, w_texture);

    if (min_filter)
        gl.texParameteri(w_target, gl.TEXTURE_MIN_FILTER, min_filter);

    if (mag_filter)
        gl.texParameteri(w_target, gl.TEXTURE_MAG_FILTER, mag_filter);

    gl.bindTexture(w_target, null);
}

/**
 * Get texture MIN/MAG filters (TF_*)
 */
exports.get_filters = function(texture) {
    
    // consider that renderbuffer has NEAREST filtering
    if (texture.type == exports.TT_RENDERBUFFER) {
        return {
            min: exports.TF_NEAREST,
            mag: exports.TF_NEAREST
        }
    }

    var w_target = texture.w_target;
    var w_texture = texture.w_texture;

    gl.bindTexture(w_target, w_texture);

    var min = gl.getTexParameter(w_target, gl.TEXTURE_MIN_FILTER);
    var mag = gl.getTexParameter(w_target, gl.TEXTURE_MAG_FILTER);

    gl.bindTexture(w_target, null);

    return {
        min: min,
        mag: mag
    }
}

exports.resize = function(texture, width, height) {
    var width = Math.max(width, 1);
    var height = Math.max(height, 1);

    if (texture.width == width && texture.height == height)
        return;

    if (texture.type == exports.TT_RENDERBUFFER) {
        gl.bindRenderbuffer(gl.RENDERBUFFER, texture.w_renderbuffer);
        gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, 
                width, height);
        gl.bindRenderbuffer(gl.RENDERBUFFER, null);
    } else {
        var w_tex = texture.w_texture;
        var w_target = texture.w_target;

        gl.bindTexture(w_target, w_tex);
        var format = get_image2d_format(texture);
        var type = get_image2d_type(texture);
        gl.texImage2D(w_target, 0, format, width, height, 0, format, type, null);

        gl.bindTexture(w_target, null);
    }

    texture.width = width;
    texture.height = height;
}

/**
 * Create b4w texture object with 1-pixel image as placeholder
 * @param bpy_texture b4w texture object
 */
exports.create_texture_bpy = function(bpy_texture, global_af, bpy_scenes) {

    var tex_type = bpy_texture["type"];
    var image_data = new Uint8Array([0.8*255, 0.8*255, 0.8*255, 1*255]);

    var texture = {};
    
    switch(tex_type) {
    case "IMAGE":
        var w_texture = gl.createTexture();
        var w_target = gl.TEXTURE_2D;
        gl.bindTexture(w_target, w_texture);
        gl.texImage2D(w_target, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, image_data);
        break;
    case "NONE":
        // check if texture can be used for offscreen rendering
        if (bpy_texture["b4w_render_scene"]) {

            var name = bpy_texture["b4w_render_scene"];
            var scene = util.keysearch("name", name, bpy_scenes);

            if (scene) {
                // NOTE: temporary hacks
                texture.offscreen_scene = scene;
                scene._render_to_texture = true;

                var w_texture = gl.createTexture();
                var w_target = gl.TEXTURE_2D;
                gl.bindTexture(w_target, w_texture);
                gl.texImage2D(w_target, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, image_data);
            } else
                return null;
        } else
            return null;
        break;
    case "ENVIRONMENT_MAP":
        var w_texture = gl.createTexture();
        var w_target = gl.TEXTURE_CUBE_MAP;
        gl.bindTexture(w_target, w_texture);
        var targets = [
            "POSITIVE_X", "NEGATIVE_X",
            "POSITIVE_Y", "NEGATIVE_Y",
            "POSITIVE_Z", "NEGATIVE_Z"
        ];
        for (var i = 0; i < 6; i++)
            gl.texImage2D(gl["TEXTURE_CUBE_MAP_" + targets[i]], 0, gl.RGBA,
                1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, image_data);
        break;

    case "VORONOI":
    case "BLEND":
        return null;

    default:
        m_print.error("B4W warning: texture \"" + bpy_texture["name"] + 
            "\" has unsupported type \"" + tex_type + "\"");
        return null;
    }

    if (tex_type == "NONE")
        gl.texParameteri(w_target, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    else
        gl.texParameteri(w_target, gl.TEXTURE_MIN_FILTER, LEVELS[cfg_def.texture_min_filter]);

    gl.texParameteri(w_target, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    setup_anisotropic_filtering(bpy_texture, global_af, w_target);

    var tex_extension = bpy_texture["extension"];
    if (tex_extension == "REPEAT" && tex_type != "NONE") {
        gl.texParameteri(w_target, gl.TEXTURE_WRAP_S, gl.REPEAT);
        gl.texParameteri(w_target, gl.TEXTURE_WRAP_T, gl.REPEAT);
    } else {
        gl.texParameteri(w_target, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(w_target, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }
              
    gl.generateMipmap(w_target);
    
    gl.bindTexture(w_target, null);

    texture.name = bpy_texture["name"];
    texture.type = exports.TT_RGBA_INT;
    texture.source = tex_type;
    texture.width = 1;
    texture.height = 1;
    texture.compress_ratio = 1;

    texture.w_texture = w_texture;
    texture.w_target = w_target;

    bpy_texture._render = texture;

    return texture;
}

function setup_anisotropic_filtering(bpy_texture, global_af, w_target) {

    // anisotropic filtering is one of these string params: DEFAULT, OFF, 2x, 4x, 8x, 16x
    var af = bpy_texture["b4w_anisotropic_filtering"];

    // individual textures override global AF value when b4w_anisotropic_filtering is not DEFAULT
    if (af === "DEFAULT")
        af = global_af;

    if (af !== "OFF") {
        var ext_aniso = extensions.get_aniso();
        if (ext_aniso) {
            af = parseFloat(af.split("x")[0]);
            gl.texParameterf(w_target, ext_aniso.TEXTURE_MAX_ANISOTROPY_EXT, af);
        }
    }
}

exports.create_texture_canvas = function(name, width, height) {

    var w_texture = gl.createTexture();
    var w_target = gl.TEXTURE_2D;

    gl.bindTexture(w_target, w_texture);
    // NOTE: standard params suitable for POT and NPOT textures
    gl.texParameteri(w_target, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(w_target, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(w_target, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(w_target, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(w_target, null);

    var canvas = document.createElement("canvas");
    canvas.width  = width;
    canvas.height = height;
    var canvas_context = canvas.getContext("2d");

    var texture = {};

    texture.name = name;
    texture.type = exports.TT_RGBA_INT;
    texture.source = "CANVAS";
    texture.width = width;
    texture.height = height;
    texture.compress_ratio = 1;

    texture.w_texture = w_texture;
    texture.w_target = w_target;
    texture.canvas = canvas;
    texture.canvas_context = canvas_context;

    return texture;
}

exports.resize_texture_canvas = function(texture, width, height) {

    if (texture.source != "CANVAS")
        throw "Wrong texture";

    var width = Math.max(width, 1);
    var height = Math.max(height, 1);

    var canvas = texture.canvas;
    canvas.width = width;
    canvas.height = height;
    update_texture_canvas(texture);
}

function update_texture_canvas(texture) {

    if (texture.source != "CANVAS")
        throw "Wrong texture";

    var w_texture = texture.w_texture;
    var w_target = texture.w_target;

    gl.bindTexture(w_target, w_texture);

    var w_format = get_image2d_format(texture);
    var w_type = get_image2d_type(texture);
    var canvas = texture.canvas;
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(w_target, 0, w_format, w_format, w_type, canvas);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);

    gl.bindTexture(w_target, null);

    texture.width = width;
    texture.height = height;
}

/**
 * Load image data into texture object
 * @param texture texture object
 * @param {vec4|HTMLImageElement} image_data Color or image element to load into
 * texture object
 */
exports.update_texture = function(texture, image_data, is_dds, filepath) {

    var tex_type = texture.source;
    var w_texture = texture.w_texture;
    var w_target = texture.w_target;

    gl.bindTexture(w_target, w_texture);

    if (image_data.length == 4) {
        var update_color = true;
        var image_data = new Uint8Array([
            image_data[0] * 255, 
            image_data[1] * 255, 
            image_data[2] * 255, 
            image_data[3] * 255
        ]);
    }

    if (tex_type == "IMAGE") {
        if (update_color) {
            gl.texImage2D(w_target, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, 
                    image_data);
            texture.width = 1;
            texture.height = 1;
        } else if (is_dds) {
            m_dds.upload_dds_levels(gl, extensions.get_s3tc(), image_data, 
                    true);
            var dds_wh = m_dds.get_width_height(image_data);

            if (is_non_power_of_two(dds_wh.width, dds_wh.height)) {
                m_print.warn("B4W warning: using NPOT-texture", filepath);
                prepare_npot_texture(w_target);
            }

            texture.width = dds_wh.width;
            texture.height = dds_wh.height;
            texture.compress_ratio = m_dds.get_compress_ratio(image_data);
        } else {
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
            //gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);

            gl.texImage2D(w_target, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image_data);

            texture.width = image_data.width;
            texture.height = image_data.height;

            if (is_non_power_of_two(image_data.width, image_data.height)) {
                m_print.warn("B4W warning: using NPOT-texture", filepath);
                prepare_npot_texture(w_target);
            } else
                gl.generateMipmap(w_target);   
        }

    } else if (tex_type == "ENVIRONMENT_MAP") {

        // get six images from Blender-packed environment map
        var infos = [
            ["POSITIVE_X", 2, 0], 
            ["NEGATIVE_X", 0, 0],
            ["POSITIVE_Y", 1, 1], 
            ["NEGATIVE_Y", 0, 1],
            ["POSITIVE_Z", 1, 0], 
            ["NEGATIVE_Z", 2, 1]
        ];        
    
        if (update_color) {
            for (var i = 0; i < 6; i++) {
                var info = infos[i];
                gl.texImage2D(gl["TEXTURE_CUBE_MAP_" + info[0]], 0, gl.RGBA,
                    1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, image_data);
            }

            texture.width = 3;
            texture.height = 2;
        } else {
            if (is_non_power_of_two(image_data.width / 3, image_data.height / 2))
                throw "Warning: Wrong environment map dimensions " + filepath;

            // Restore default OpenGL state in case it was changed earlier
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);

            var dim = image_data.width / 3;

            for (var i = 0; i < 6; i++) {
                var info = infos[i];
            
                var tmpcanvas = document.createElement("canvas");
                tmpcanvas.width = dim;
                tmpcanvas.height = dim;
                var ctx = tmpcanvas.getContext("2d");
                
                // OpenGL ES 2.0 Spec, 3.7.5 Cube Map Texture Selection
                // vertical flip for Y, horizontal flip for X and Z
                if (info[0] == "POSITIVE_Y" || info[0] == "NEGATIVE_Y") {
                    ctx.translate(0, dim);
                    ctx.scale(1, -1);
                } else {
                    ctx.translate(dim, 0);
                    ctx.scale(-1, 1);
                }
                
                ctx.drawImage(image_data, info[1] * dim, info[2] * dim, dim, dim, 
                    0, 0, dim, dim);

                gl.texImage2D(gl["TEXTURE_CUBE_MAP_" + info[0]], 0, gl.RGBA, 
                    gl.RGBA, gl.UNSIGNED_BYTE, tmpcanvas);
            }

            texture.width = 3 * dim;
            texture.height = 2 * dim;

            gl.generateMipmap(w_target);   
        }
    }
    
    gl.bindTexture(w_target, null);
}

function prepare_npot_texture(tex_target) {
    gl.texParameteri(tex_target, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(tex_target, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(tex_target, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(tex_target, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
}

function is_non_power_of_two(width, height) {
    var dims = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384];
    return dims.indexOf(width) == -1 || dims.indexOf(height) == -1;
}

/**
 * Get format for texImage2D()
 */
function get_image2d_format(texture) {

    var format;

    switch (texture.type) {
    case exports.TT_RGBA_INT:
        format = gl.RGBA;
        break;
    case exports.TT_RGB_INT:
        format = gl.RGB;
        break;
    case exports.TT_RGBA_FLOAT:
        format = gl.RGBA;
        break;
    case exports.TT_RGB_FLOAT:
        format = gl.RGB;
        break;
    case exports.TT_DEPTH:
        format = gl.DEPTH_COMPONENT;
        break;
    default:
        throw "Wrong texture type";
        break;
    }

    return format;
}

/**
 * Get type for texImage2D()
 */
function get_image2d_type(texture) {

    var type;

    switch (texture.type) {
    case exports.TT_RGBA_INT:
        type = gl.UNSIGNED_BYTE;
        break;
    case exports.TT_RGB_INT:
        type = gl.UNSIGNED_BYTE;
        break;
    case exports.TT_RGBA_FLOAT:
        type = gl.FLOAT;
        break;
    case exports.TT_RGB_FLOAT:
        type = gl.FLOAT;
        break;
    case exports.TT_DEPTH:
        //type = gl.UNSIGNED_SHORT;
        type = gl.UNSIGNED_INT;
        break;
    default:
        throw "Wrong texture type";
        break;
    }

    return type;
}

exports.delete_texture = function(texture) {
    gl.deleteTexture(texture);
}

/**
 * Check if object is a texture
 */
exports.is_texture = function(tex) {
    if (tex && tex.name && (tex.w_texture || tex.w_renderbuffer))
        return true;
    else
        return false;
}

/**
 * Check if object is a renderbuffer
 */
exports.is_renderbuffer = function(tex) {
    if (tex && tex.name && tex.w_renderbuffer)
        return true;
    else
        return false;
}

exports.is_float = function(tex) {
    if (tex.type == exports.TT_RGBA_FLOAT || tex.type == exports.TT_RGB_FLOAT)
        return true;
    else
        return false;
}

/**
 * Get texture channel size
 */
exports.get_texture_channel_size = function(tex) {
    var size = 0;

    switch (tex.type) {
    case exports.TT_RGBA_INT:
    case exports.TT_RGB_INT:
        size = CHANNEL_SIZE_BYTES_INT;
        break;
    case exports.TT_RGBA_FLOAT:
    case exports.TT_RGB_FLOAT:
        size = CHANNEL_SIZE_BYTES_FLOAT;
        break;
    case exports.TT_DEPTH:
        size = CHANNEL_SIZE_BYTES_DEPTH;
        break;
    case exports.TT_RENDERBUFFER:
        size = CHANNEL_SIZE_BYTES_RENDERBUFFER;
        break;
    }

    return size;
}
/**
 * Calculate texture id
 */
exports.calc_texture_id = function(tex) {

    var tex_cp = {};

    for (var prop in tex)
        tex_cp[prop] = tex[prop];

    delete tex_cp.offscreen_scene;

    return JSON.stringify(tex_cp);
}

}
