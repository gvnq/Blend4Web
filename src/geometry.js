"use strict";

/**
 * Geometry internal API.
 * Don't forget to register GL context by setup_context() function.
 * @name geometry
 * @namespace
 * @exports exports as geometry
 */
b4w.module["__geometry"] = function(exports, require) {

var m_print = require("__print");
var m_tsr   = require("__tsr");
var m_util  = require("__util");
var m_ext   = require("__extensions");

var m_vec3 = require("vec3");

var MAX_SUBMESH_LENGTH = 256*256;

var COMB_SORT_JUMP_COEFF = 1.247330950103979;

// numbers of components per attribute
var POS_NUM_COMP = 3;
var NOR_NUM_COMP = 3;
var TAN_NUM_COMP = 4;
var COL_NUM_COMP = 3;

// deprecated
var INFLUENCE_NUM_COMP = 4;

// z-sort types
exports.ZSORT_DISABLED      = 10;
exports.ZSORT_BACK_TO_FRONT = 20;
exports.ZSORT_FRONT_TO_BACK = 30;

// draw modes
exports.DM_TRIANGLES         = 10;
exports.DM_POINTS            = 20;
exports.DM_DYNAMIC_TRIANGLES = 30;
exports.DM_DYNAMIC_POINTS    = 40;
exports.DM_LINES             = 50;

exports.DM_DEFAULT = exports.DM_TRIANGLES;

var gl;

/**
 * Setup WebGL context
 * @param ctx webgl context
 */
exports.setup_context = function(ctx) {
    gl = ctx;
}

/**
 * not used so far
 */
exports.delete_buffers = function(geometry_id) {
    var buffers = _buffers[geometry_id];
    gl.deleteBuffer(buffers.ibo);
    gl.deleteBuffer(buffers.vbo);
    delete _buffers[geometry_id];
}


/**
 * Convert mesh/material object to gl buffer data
 */
exports.submesh_to_bufs_data = function(submesh, zsort_type, draw_mode, vc_usage) {

    if (is_long_submesh(submesh) && is_indexed(submesh)) {
        submesh_drop_indices(submesh);
    }

    var indices = submesh.indices;
    var base_length = submesh.base_length;
    var va_frames = submesh.va_frames;
    
    var va_common = {};
    for (var attr_name in submesh.va_common)
        if (!(attr_name in vc_usage) || vc_usage[attr_name].generate_buffer)
            va_common[attr_name] = submesh.va_common[attr_name];

    var bufs_data = generate_bufs_data_arrays(indices, va_frames, va_common, base_length);
    update_draw_mode(bufs_data, draw_mode);
    update_gl_buffers(bufs_data);

    // NOTE: Z-sorting is possible only for indexed buffers
    if (zsort_type != exports.ZSORT_DISABLED && is_indexed(submesh)) {
        // object is movable and/or animatable so we cannot precalc 
        // world space triangle medians as for batches; so just save sources

        // NOTE: temporary
        var positions = va_frames[0]["a_position"];
        
        bufs_data.info_for_z_sort_updates = {
            // caching is possible because count does not change
            // length = indices.length / 3 * 3
            median_cache: new Float32Array(indices.length),
            median_world_cache: new Float32Array(indices.length),
            dist_cache: new Float32Array(indices.length/3),
            type: zsort_type
        };
    }

    return bufs_data;
}

exports.is_long_submesh = is_long_submesh;
/**
 * Check is given submesh is too long to have indices.
 * Max index value is 
 * @methodOf geometry
 */
function is_long_submesh(submesh) {

    var base_length = submesh.base_length;

    if (base_length > MAX_SUBMESH_LENGTH) {

        if (m_ext.get_elem_index_uint())
            return false;

        return true;
    }

    return false;
}

exports.is_indexed = is_indexed;
/**
 * Check if submesh is indexed one
 */
function is_indexed(submesh) {
    if (submesh.indices.length > 0)
        return true;
    else
        return false;
}

exports.submesh_drop_indices = submesh_drop_indices;
/**
 * Drop indices from long submesh and recalculate all VAs
 */
function submesh_drop_indices(submesh, count, is_manually_dropped) {

    count = count || 1;

    if (!is_manually_dropped)
    m_print.log("%cDEBUG max vertices exceeded for indexed submesh \"" +
            submesh.name + "\": " + submesh.base_length * count +
            ", will use drawArrays", "color: #aa0");

    var indices = submesh.indices;
    var base_length = submesh.base_length;
    var va_common = submesh.va_common;
    var va_frames = submesh.va_frames;

    for (var name in va_common) {
        var arr = va_common[name];
        var nc = num_comp(arr, base_length);

        va_common[name] = expand_vertex_array_i(indices, arr, nc);
    }

    for (var i = 0; i < va_frames.length; i++) {
        var va_frame = va_frames[i];

        for (var name in va_frame) {
            
            var arr = va_frame[name];
            var nc = num_comp(arr, base_length);

            va_frame[name] = expand_vertex_array_i(indices, arr, nc);
        }
    }

    submesh.base_length = indices.length;
    submesh.indices = new Uint16Array(0);

    return submesh;
}

/**
 * Create a new vertex array value for each index
 */
function expand_vertex_array_i(indices, vertex_array, num_comp) {

    if (vertex_array.length == 0)
        return new Float32Array(0);

    var len = indices.length * num_comp;
    var new_vertex_array = new Float32Array(len);

    for (var i = 0; i < indices.length; i++) {
        var index = indices[i];

        for (var j = 0; j < num_comp; j++)
            new_vertex_array[num_comp*i + j] = 
                    vertex_array[num_comp*index + j];
    }

    return new_vertex_array;
}

/**
 * Initialize attribute buffer data
 *
 * count specified for POINTS rendering
 * indices specified for TRIANGLES rendering (Uint16Array)
 *
 * 1. Optional index buffer object (IBO)
 * 2. Vertex buffer object (VBO)
 * 3. for each attribute:
 *     - attribute name
 *     - number of components
 *     - offset
 *     - length
 *     - number of frames (vertex anim)
 * 4. draw mode
 * 5. count
 */
exports.create_bufs_data = function(draw_mode, indices, count) {

    var bufs_data = {
        vbo_array: [], 
        pointers: {}
    };

    update_draw_mode(bufs_data, draw_mode);

    if (bufs_data.mode == gl.TRIANGLES) {
        bufs_data.count = indices.length;
        bufs_data.ibo_array = indices;

        if (bufs_data.count <= MAX_SUBMESH_LENGTH)
            bufs_data.ibo_type = gl.UNSIGNED_SHORT;
        else
            bufs_data.ibo_type = gl.UNSIGNED_INT;

    } else if (bufs_data.mode == gl.POINTS) {
        bufs_data.count = count;
        bufs_data.ibo_array = null;
    }

    return bufs_data;
}

/**
 * Append or replace attribute array
 * array must be of type Float32Array
 */
exports.update_bufs_data_array = function(bufs_data, attrib_name, num_comp, array) {

    var vbo_array = bufs_data.vbo_array;
    var pointers = bufs_data.pointers;

    var pointer = pointers[attrib_name];

    if (pointer) {
        // replace attribute data
     
        if (pointer.num_comp != num_comp)
            throw "Error: invalid num_comp for \"" + attrib_name + "\"";

        vbo_array.set(array, pointer.offset);
    } else {
        // append new attribute data

        // create new vbo_array 
        var len = vbo_array.length;
        var vbo_array_new = new Float32Array(len + array.length);

        // write old and new data
        vbo_array_new.set(bufs_data.vbo_array);
        vbo_array_new.set(array, len);

        // save
        bufs_data.vbo_array = vbo_array_new;

        // append new pointer
        pointers[attrib_name] = {
            num_comp: num_comp, 
            offset: len
        };
    }

    update_gl_buffers(bufs_data);
    return bufs_data;
}

/**
 * Get VBO buffer view by attribute name.
 * @methodOf geometry
 * @returns Link to VBO subarray
 */
function extract_array(bufs_data, name) {
    var vbo_array = bufs_data.vbo_array;
    var pointers = bufs_data.pointers;

    var pointer = pointers[name];
    if (pointer)
        return vbo_array.subarray(pointer.offset, pointer.offset + pointer.length);
    else
        throw "extract_array() failed; invalid name: " + name;
}

/**
 * Update GL mode (affects draw operations) and GL usage (affects buffers update)
 * @methodOf geometry
 */
function update_draw_mode(bufs_data, draw_mode) {

    var mode;
    var usage;

    switch (draw_mode) {
    case exports.DM_DEFAULT:
    case exports.DM_TRIANGLES:
        mode = gl.TRIANGLES;
        usage = gl.STATIC_DRAW;
        break;
    case exports.DM_POINTS:
        mode = gl.POINTS;
        usage = gl.STATIC_DRAW;
        break;
    case exports.DM_DYNAMIC_TRIANGLES:
        mode = gl.TRIANGLES;
        usage = gl.DYNAMIC_DRAW;
        break;
    case exports.DM_DYNAMIC_POINTS:
        mode = gl.POINTS;
        usage = gl.DYNAMIC_DRAW;
        break;
    case exports.DM_LINES:
        mode = gl.LINES; 
        usage = gl.STATIC_DRAW;
        break;
    default:
        throw "Wrong draw_mode";
    }

    bufs_data.mode = mode;
    bufs_data.usage = usage;

}

exports.make_static = function(bufs_data) {
    bufs_data.usage = gl.STATIC_DRAW;
}

exports.make_dynamic = function(bufs_data) {
    bufs_data.usage = gl.DYNAMIC_DRAW;
}

function generate_bufs_data_arrays(indices, va_frames, va_common, base_length) {

    if (indices.length) {
        var count = indices.length;
        if (base_length <= MAX_SUBMESH_LENGTH) {
            // NOTE: possible transform from Uint32Array, affects performance
            var ibo_array = new Uint16Array(indices);
            var ibo_type = gl.UNSIGNED_SHORT;
        } else {
            var ibo_array = new Uint32Array(indices);;
            var ibo_type = gl.UNSIGNED_INT;
        }
    } else {
        var count = base_length;
        var ibo_array = null;
    }

    var vbo_array_length = calc_vbo_length(va_frames, va_common);
    var vbo_array = new Float32Array(vbo_array_length);

    var offset = 0; // in elements
    var pointers = {};

    for (var name in va_common) {

        var arr = va_common[name];
        var len = arr.length;

        if (!len)
            continue;

        // copy src arrays to vbo
        vbo_array.set(arr, offset);

        pointers[name] = {
            attribute_name: name,
            num_comp: num_comp(arr, base_length),
            offset: offset,
            frames: 1,
            length: len
        };

        offset += len;
    }

    var frames_count = va_frames.length;
    for (var name in va_frames[0]) {
        
        var arr0 = va_frames[0][name];
        var len = arr0.length;
        var ncomp = num_comp(arr0, base_length);

        if (!len)
            continue;

        pointers[name] = {
            num_comp: ncomp,
            offset: offset,
            frames: frames_count,
            length: len
        };

        if (frames_count > 1) {
            pointers[name + "_next"] = {
                num_comp: ncomp,
                offset: offset + len,
                frames: frames_count,
                length: len
            };
        }

        for (var i = 0; i < frames_count; i++) {

            var va_frame = va_frames[i];
            var arr = va_frame[name];

            // copy src arrays to vbo
            vbo_array.set(arr, offset);
            
            offset += len;
        }
    }

    return {
        count     : count,
        ibo_array : ibo_array,
        vbo_array : vbo_array, 
        ibo_type  : ibo_type,
        pointers  : pointers       
    }
}

/**
 * Calculate vbo length (in elements) needed to store vertex arrays
 */
function calc_vbo_length(va_frames, va_common) {

    var len = 0;
    var frames_count = va_frames.length;

    for (var name in va_frames[0]) {
        var arr = va_frames[0][name];
        len += arr.length * frames_count;
    }

    for (var name in va_common) {
        var arr = va_common[name];
        len += arr.length;
    }

    return len;
}

function update_gl_buffers(bufs_data) {

    // index buffer object
    if (bufs_data.ibo_array) {

        if (!bufs_data.ibo)
            bufs_data.ibo = gl.createBuffer();

        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, bufs_data.ibo);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, bufs_data.ibo_array, bufs_data.usage);

        bufs_data.debug_ibo_bytes = bufs_data.ibo_array.byteLength;
    } else
        bufs_data.debug_ibo_bytes = 0;

    // vertex buffer object
    if (!bufs_data.vbo)
        bufs_data.vbo = gl.createBuffer();

    gl.bindBuffer(gl.ARRAY_BUFFER, bufs_data.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, bufs_data.vbo_array, bufs_data.usage);

    bufs_data.debug_vbo_bytes = bufs_data.vbo_array.byteLength;
}

/**
 * Delete GL Buffer Objects
 */
exports.cleanup_bufs_data = function(bufs_data) {
    if (bufs_data.ibo)
        gl.deleteBuffer(bufs_data.ibo);
    if (bufs_data.vbo)
        gl.deleteBuffer(bufs_data.vbo);
}

/**
 * Check if submesh given by index is empty
 */
exports.has_empty_submesh = function(mesh, index) {
    var bsub = mesh["submeshes"][index];

    if (bsub["base_length"])
        return false;
    else
        return true;
}

/**
 * Create a new mesh from the parts with given submesh index
 */
exports.make_batch_submesh = function(instances, attr_names,
        vertex_colors_usage, uv_maps_usage) {

    var submeshes = [];
    for (var i = 0; i < instances.length; i++) {
        var instance = instances[i];
        var mesh = instance.mesh;
        var submesh = extract_submesh(mesh, instance.submesh_index, 
                attr_names, null, vertex_colors_usage, uv_maps_usage);
        // ignore empty submeshes
        if (submesh.base_length) {
            submesh_apply_instance(submesh, instance);
            submeshes.push(submesh);
        }
    }

    if (submeshes.length == 0)
        var batch_submesh = m_util.create_empty_submesh("EMPTY");
    else if (submeshes.length == 1)
        var batch_submesh = submeshes[0];
    else
        var batch_submesh = submesh_list_join(submeshes);

    return batch_submesh;
}

/**
 * Clone mesh for each instance and return a new mesh
 * Also create and save mesh.vertices.center_locs
 */
function submesh_apply_instance(submesh, instance) {

    var base_length = submesh.base_length;

    var transform = instance.transform;

    // positions/normals/tangents
    for (var f = 0; f < submesh.va_frames.length; f++) {
        var positions = submesh.va_frames[f]["a_position"];
        m_tsr.transform_vectors(positions, transform, positions, 0);

        var normals = submesh.va_frames[f]["a_normal"];
        if (normals.length > 0)
            m_tsr.transform_dir_vectors(normals, transform, normals, 0);

        var tangents = submesh.va_frames[f]["a_tangent"];
        if (tangents.length > 0)
            m_tsr.transform_tangents(tangents, transform, tangents, 0);
    }

    // indices, influences, vertex colors, texcoords not affected

    // additional params
    var params = instance.params;

    for (var param in params) {
        var param_len = params[param].length;
        var len = params[param].length * base_length;
        submesh.va_common[param] = new Float32Array(param_len * base_length);

        for (var i = 0; i < base_length; i++)
            for (var j = 0; j < param_len; j++)
                submesh.va_common[param][i*param_len + j] = params[param][j];
    }
}

/**
 * Generate new vertex array buffer from source by
 * copyng source data length times
 */
function gen_buf_clone_source(source, n) {

    var len = source.length;
    var new_buf = new Float32Array(len * n);

    for (var i = 0; i < n; i++)
        for (var j = 0; j < len; j++)
            new_buf[i*len + j] = source[j]; 

    return new_buf;
}

exports.submesh_list_join = submesh_list_join;
/**
 * Join submeshes list
 */
function submesh_list_join(submeshes) {

    var submesh0 = submeshes[0];
    var new_submesh = submesh_list_join_prepare_dest(submeshes);

    // indices
    var i_offset = 0;
    var v_ind_offset = 0;
    for (var i = 0; i < submeshes.length; i++) {
        var submesh = submeshes[i];

        var indices = submesh.indices;
        var base_length = submesh.base_length;
        var va_common = submesh.va_common;
        var va_frames = submesh.va_frames;

        // indices
        for (var j = 0; j < indices.length; j++) {
            var ind = indices[j];
            new_submesh.indices[i_offset + j] = ind + v_ind_offset;
        }
        i_offset += indices.length;

        for (var param_name in va_common) {
            var arr = va_common[param_name];

            var offset = v_ind_offset * num_comp(arr, base_length);
            new_submesh.va_common[param_name].set(arr, offset);
        }

        for (var j = 0; j < submesh.va_frames.length; j++) {

            var va_frame = submesh.va_frames[j];
            var new_va_frame = new_submesh.va_frames[j];

            for (var param_name in va_frame) {

                var arr = va_frame[param_name];

                var offset = v_ind_offset * num_comp(arr, base_length);
                new_va_frame[param_name].set(arr, offset);
            }
        }
        v_ind_offset += base_length;
    }

    return new_submesh;
}

function submesh_list_join_prepare_dest(submeshes) {

    var new_submesh = m_util.create_empty_submesh("JOIN_" + submeshes.length 
            + "_SUBMESHES");

    var len = 0;

    for (var i = 0; i < submeshes.length; i++)
        len += submeshes[i].indices.length;
    new_submesh.indices = new Uint32Array(len);

    len = 0;
    for (var i = 0; i < submeshes.length; i++)
        len += submeshes[i].base_length;
    new_submesh.base_length = len;

    var submesh0 = submeshes[0];

    for (var param_name in submesh0.va_common) {

        len = 0;
        for (var i = 0; i < submeshes.length; i++)
            len += submeshes[i].va_common[param_name].length;

        new_submesh.va_common[param_name] = new Float32Array(len);
    }

    for (var param_name in submesh0.va_frames[0]) {

        len = 0;
        for (var i = 0; i < submeshes.length; i++)
            len += submeshes[i].va_frames[0][param_name].length;

        for (var i = 0; i < submesh0.va_frames.length; i++) {
            new_submesh.va_frames[i] = new_submesh.va_frames[i] || {};
            new_submesh.va_frames[i][param_name] = new Float32Array(len);
        }
    }

    return new_submesh;
}

/**
 * Extract and clone submesh by given transforms.
 * well-suited for hair particles
 * ignore transform/center positions specified in instance
 */
exports.make_clone_submesh = function(instance, attr_names, vertex_colors_usage,
        uv_maps_usage, transforms) {

    var submesh = extract_submesh(instance.mesh, instance.submesh_index,
            attr_names, null, vertex_colors_usage, uv_maps_usage);

    // ignore empty submeshes
    if (!submesh.base_length)
        return m_util.create_empty_submesh("EMPTY");

    var count = transforms.length;
    if (submesh.base_length * count > MAX_SUBMESH_LENGTH
           && !m_ext.get_elem_index_uint())
        submesh_drop_indices(submesh, count);

    // for cloned submesh
    var indices = submesh.indices;
    var base_length = submesh.base_length;
    var va_common = submesh.va_common;
    var va_frames = submesh.va_frames;

    // store additional params in extracted submesh
    var params = instance.params;
    for (var param in params) {
        var param_len = params[param].length;
        var len = param_len * base_length;
        va_common[param] = new Float32Array(len);

        for (var i = 0; i < base_length; i++)
            for (var j = 0; j < param_len; j++)
                va_common[param][i*param_len + j] = params[param][j];
    }

    // create new submesh
    var new_submesh = m_util.create_empty_submesh("CLONE_"+count+"_SUBMESHES");
    new_submesh.base_length = base_length * count;

    new_submesh.indices = new Uint32Array(indices.length * count);

    for (var i = 0; i < count; i++) {
        var i_offset = indices.length * i;
        var v_offset = base_length * i;

        // indices
        for (var j = 0; j < indices.length; j++) {
            var ind = indices[j];
            new_submesh.indices[i_offset + j] = ind + v_offset;
        }
    }

    for (var param_name in va_common) {
        var arr = va_common[param_name];
        var len = arr.length * count;
        var ncomp = num_comp(arr, base_length);

        new_submesh.va_common[param_name] = new Float32Array(len);

        for (var i = 0; i < count; i++) {
            var v_offset = base_length * ncomp * i;
            new_submesh.va_common[param_name].set(arr, v_offset);
        }
    }

    for (var param_name in va_frames[0]) {
        for (var i = 0; i < va_frames.length; i++) {
            var arr = va_frames[i][param_name];
            var len = arr.length * count;
            var ncomp = num_comp(arr, base_length);

            new_submesh.va_frames[i] = new_submesh.va_frames[i] || {};
            new_submesh.va_frames[i][param_name] = new Float32Array(len);

            for (var j = 0; j < count; j++) {
                var transform = transforms[j];
                var v_offset = base_length * ncomp * j;

                switch(param_name) {
                case "a_position":
                    m_tsr.transform_vectors(arr, transform,
                            new_submesh.va_frames[i][param_name], v_offset);
                    break;
                case "a_normal":
                    m_tsr.transform_dir_vectors(arr, transform,
                            new_submesh.va_frames[i][param_name], v_offset);
                    break;
                case "a_tangent":
                    m_tsr.transform_tangents(arr, transform,
                            new_submesh.va_frames[i][param_name], v_offset);
                    break;
                default:
                    throw "Wrong attribute name: " + param_name;
                    break;
                }
            }
        }
    }

    return new_submesh;
}


exports.extract_submesh = extract_submesh;
/**
 * Extract submesh from mesh with given material index
 * @methodOf geometry
 */
function extract_submesh(mesh, material_index, attr_names, bone_pointers, 
        vertex_colors_usage, uv_maps_usage) {

    // TODO: implement caching
    // TODO: handle cases when submesh can't provide requested attribute name

    var submesh = m_util.create_empty_submesh("SUBMESH_" + mesh["name"] + "_" + 
            material_index);

    var bsub = mesh["submeshes"][material_index];
    var base_length = bsub["base_length"];

    submesh.base_length = base_length;

    // TEXTURE COORDS
    if (has_attr(attr_names, "a_texcoord"))
        var texcoords = new Float32Array(bsub["texcoord"]);
    else
        var texcoords = new Float32Array(0);

    // INFLUENCES (SKINNING)
    var influences = extract_influences(attr_names, base_length, bone_pointers, 
            bsub["group"]);


    // VERTEX COLORS

    // if usage was not specified but vertex colors were requested - just use
    // the one that is not being used by wind bending/dynamic grass

    if (vertex_colors_usage)
        var submesh_vc_usage = m_util.clone_object_r(vertex_colors_usage);
    else
        var submesh_vc_usage = {};
    submesh_vc_usage["a_color"] = { generate_buffer: true };

    if (has_attr(attr_names, "a_color") && mesh["active_vcol_name"])
        submesh_vc_usage["a_color"].src = [
            { name: mesh["active_vcol_name"], mask: 7 }
        ];
    else
        submesh_vc_usage["a_color"].src = [];

    var va_common = {
        "a_texcoord": texcoords,
        "a_influence": influences
    }

    extract_vcols(va_common, submesh_vc_usage, bsub["vertex_colors"], 
            bsub["color"], base_length);

    assign_node_uv_maps(mesh["uv_textures"], bsub["texcoord"],
            bsub["texcoord2"], uv_maps_usage, base_length, va_common, 
            mesh.name);

    submesh.va_common = va_common;
    submesh.indices = new Uint32Array(bsub["indices"]);

    // POSITION/NORMAL/TANGENT

    var frames = bsub["position"].length / base_length / POS_NUM_COMP;

    // position always needed?

    if (has_attr(attr_names, "a_normal") && bsub["normal"].length)
        var use_normal = true;
    else
        var use_normal = false;

    if (use_normal && has_attr(attr_names, "a_tangent") && bsub["tangent"].length)
        var use_tangent = true;
    else
        var use_tangent = false;

    for (var i = 0; i < frames; i++) {
        var va_frame = {};

        var pos_arr = new Float32Array(base_length * POS_NUM_COMP);
        var nor_arr = new Float32Array(use_normal ? base_length * NOR_NUM_COMP : 0);
        var tan_arr = new Float32Array(use_tangent ? base_length * TAN_NUM_COMP : 0);

        var from_index = i * base_length * POS_NUM_COMP;
        var to_index = from_index + base_length * POS_NUM_COMP;
        pos_arr.set(bsub["position"].subarray(from_index, to_index), 0);

        if (use_normal) {
            var from_index = i * base_length * NOR_NUM_COMP;
            var to_index = from_index + base_length * NOR_NUM_COMP;
            nor_arr.set(bsub["normal"].subarray(from_index, to_index), 0);
        }

        if (use_tangent) {
            var from_index = i * base_length * TAN_NUM_COMP;
            var to_index = from_index + base_length * TAN_NUM_COMP;
            tan_arr.set(bsub["tangent"].subarray(from_index, to_index), 0);
        }

        va_frame["a_position"] = pos_arr;
        va_frame["a_normal"] = nor_arr;
        va_frame["a_tangent"] = tan_arr;

        submesh.va_frames.push(va_frame);
    }

    // store first frame copy for possible cyclic vertex anim
    if (frames > 1) {
        var va_frame0 = submesh.va_frames[0];
        var va_frame = {};

        for (var prop in va_frame0)
            va_frame[prop] = new Float32Array(va_frame0[prop]);

        submesh.va_frames.push(va_frame);
    }

    if (has_attr(attr_names, "a_polyindex")) {
        submesh_drop_indices(submesh, 1, true);
        submesh.va_common["a_polyindex"] = extract_polyindices(submesh);
    }

    return submesh;
}

function extract_vcols(va_common, vc_usage, submesh_vc, bsub_color, base_length) {

    var submesh_vc_names = submesh_vc_get_names(submesh_vc);
    for (var attr_name in vc_usage) {

        var colors_data = vc_usage[attr_name].src;
        if (colors_data.length) {
            var dst_channels_count = 0
            for (var i = 0; i < colors_data.length; i++)
                dst_channels_count += m_util.rgb_mask_get_channels_count(colors_data[i].mask);

            va_common[attr_name] = new Float32Array(dst_channels_count * base_length);

            var dst_channel_index_offset = 0;
            for (var i = 0; i < colors_data.length; i++) {
                var color_name = colors_data[i].name;
                var color_mask = colors_data[i].mask;
                var channels_presence = m_util.rgb_mask_get_channels_presence(color_mask);
                var color_name_index = submesh_vc_names.indexOf(color_name);

                if (color_name_index == -1)
                    throw "B4W Error: vertex color \"" + color_name + "\" not found";
                
                var mask_exported = submesh_vc[color_name_index]["mask"];
                var exported_channels_count = m_util.rgb_mask_get_channels_count(mask_exported);

                if ((color_mask & mask_exported) !== color_mask)
                    m_print.error("B4W Error: Wrong color extraction from " 
                        + color_name + " to " + attr_name + ".");
                              
                var exported_colors_offset = submesh_vc_get_offset(submesh_vc, 
                        color_name_index, base_length);

                for (var j = 0; j < base_length; j++)
                    for (var k = 0; k < COL_NUM_COMP; k++)
                        if (channels_presence[k]) {
                            var dst_channel_index = dst_channel_index_offset 
                                    + m_util.rgb_mask_get_channel_presence_index(color_mask, 
                                    k);
                            var exported_channel_index = 
                                    m_util.rgb_mask_get_channel_presence_index(mask_exported, 
                                    k);
                            
                            va_common[attr_name][j * dst_channels_count 
                                    + dst_channel_index] 
                                    = bsub_color[exported_colors_offset 
                                    + j * exported_channels_count 
                                    + exported_channel_index];
                        }
                dst_channel_index_offset += exported_channels_count;
            }
        } else
            va_common[attr_name] = new Float32Array(0);
    }
}

function submesh_vc_get_names(submesh_vc) {
    var submesh_vc_names = [];
    for (var i = 0; i < submesh_vc.length; i++)
        submesh_vc_names.push(submesh_vc[i]["name"]);

    return submesh_vc_names;
}

function submesh_vc_get_offset(submesh_vc, vc_index, base_length) {
    var offset = 0;
    for (var i = 0; i < vc_index; i++)
        offset += m_util.rgb_mask_get_channels_count(submesh_vc[i]["mask"]);
    return offset * base_length;
}

function assign_node_uv_maps(mesh_uvs, bsub_texcoord, bsub_texcoord2,
        uv_maps_usage, base_length, va_common, mesh_name) {

    if (!uv_maps_usage)
        return;

    for (var uv_name in uv_maps_usage) {

        var uv_map_index = mesh_uvs.indexOf(uv_name);
        if (uv_map_index == -1)
            throw "B4W Error: uv map \"" + uv_name + 
                  "\" for mesh \"" + mesh_name + "\" not found";

        if (uv_map_index == 0)
            var uv_node_arr = new Float32Array(bsub_texcoord);
        else if (uv_map_index == 1)
            var uv_node_arr = new Float32Array(bsub_texcoord2);

        va_common[uv_maps_usage[uv_name]] = uv_node_arr;
    }
}

/**
 * Extract halo submesh
 */
exports.extract_halo_submesh = function(submesh) {
    
    var base_length = submesh.base_length;
    var position_in = submesh.va_frames[0]["a_position"];

    var pos_arr      = new Float32Array(12 * base_length);
    var bb_vert_arr  = new Float32Array(8 * base_length);
    var indices_out  = new Uint16Array (4 * submesh.indices.length);

    for (var i = 0; i < base_length; i++) {
        // generate positions
        pos_arr[12 * i]      =  position_in[3 * i];
        pos_arr[12 * i + 1]  =  position_in[3 * i + 1];
        pos_arr[12 * i + 2]  =  position_in[3 * i + 2];

        pos_arr[12 * i + 3]  =  position_in[3 * i];
        pos_arr[12 * i + 4]  =  position_in[3 * i + 1];
        pos_arr[12 * i + 5]  =  position_in[3 * i + 2];

        pos_arr[12 * i + 6]  =  position_in[3 * i];
        pos_arr[12 * i + 7]  =  position_in[3 * i + 1];
        pos_arr[12 * i + 8]  =  position_in[3 * i + 2];

        pos_arr[12 * i + 9]  =  position_in[3 * i];
        pos_arr[12 * i + 10] =  position_in[3 * i + 1];
        pos_arr[12 * i + 11] =  position_in[3 * i + 2];

        // generate billboard vertices
        bb_vert_arr[8 * i]     = -0.5;
        bb_vert_arr[8 * i + 1] = -0.5;
        bb_vert_arr[8 * i + 2] = -0.5;
        bb_vert_arr[8 * i + 3] =  0.5;
        bb_vert_arr[8 * i + 4] =  0.5;
        bb_vert_arr[8 * i + 5] =  0.5;
        bb_vert_arr[8 * i + 6] =  0.5;
        bb_vert_arr[8 * i + 7] = -0.5;
        
        // generate indices
        indices_out[6 * i]       =  4 * i + 2;
        indices_out[6 * i + 1]   =  4 * i + 1;
        indices_out[6 * i + 2]   =  4 * i;
        indices_out[6 * i + 3]   =  4 * i + 2;
        indices_out[6 * i + 4]   =  4 * i;
        indices_out[6 * i + 5]   =  4 * i + 3;
    }

    var halo_submesh = m_util.create_empty_submesh("HALO");
    halo_submesh.va_frames = [];
    halo_submesh.va_frames[0] = {};

    halo_submesh.base_length = 4 * base_length;
    halo_submesh.va_frames[0]["a_position"]    = pos_arr;
    halo_submesh.va_common["a_halo_bb_vertex"] = bb_vert_arr;
    halo_submesh.indices                       = indices_out;

    return halo_submesh;
}

/**
 * Convenience method for attribute name check
 */
exports.has_attr = has_attr;
function has_attr(attr_names, name) {
    if (attr_names.indexOf(name) > -1)
        return true;
    else
        return false;
}

/**
 * Extract all materials.
 * Called from particles.js
 */
exports.extract_submesh_all_mats = function(mesh, attr_names) {

    var submeshes = [];

    for (var i = 0; i < mesh["submeshes"].length; i++) {
        var submesh = extract_submesh(mesh, i, attr_names, null, null, null);
        if (submesh.base_length)
            submeshes.push(submesh);
    }

    if (submeshes.length == 0)
        var submesh_all = m_util.create_empty_submesh("EMPTY");
    else if (submeshes.length == 1)
        var submesh_all = submeshes[0];
    else
        var submesh_all = submesh_list_join(submeshes);

    return submesh_all;
}

function extract_influences(attr_names, base_length, bone_pointers, 
        groups) {
    if (has_attr(attr_names, "a_influence") && bone_pointers) {

            var influences = new Float32Array(base_length * INFLUENCE_NUM_COMP);
            var groups_num = groups.length/base_length;
            // bones corresponding to vertex group
            var deform_bone_indices = get_deform_bone_indices(bone_pointers, groups_num);

            // NOTE: create buffers outside vertices cycle
            var buf_length = groups_num > 3 ? groups_num: 4;
            var weights_buf = new Float32Array(buf_length);
            var bones_buf = new Uint32Array(buf_length);
            var res_buf = new Float32Array(INFLUENCE_NUM_COMP);

            var zero_weights = new Float32Array(buf_length);
            var zero_bones = new Uint32Array(buf_length);
            var zero_res = new Float32Array(INFLUENCE_NUM_COMP);

            for (var i = 0; i < base_length; i++) {
                weights_buf.set(zero_weights);
                bones_buf.set(zero_bones);
                res_buf.set(zero_res);
                influences.set(get_vertex_influences(groups, groups_num, i, base_length, 
                        deform_bone_indices, weights_buf, bones_buf, res_buf), 
                        i * INFLUENCE_NUM_COMP);
            }
    } else
        var influences = new Float32Array(0);

    return influences;
}

function get_deform_bone_indices(bone_pointers, groups_num) {
    var deform_bone_indices = new Float32Array(groups_num);

    for (var i = 0; i < groups_num; i++) {
        deform_bone_indices[i] = -1;
        for (var j in bone_pointers) {
            var bone_pointer = bone_pointers[j];
            if (bone_pointer.vgroup_index === i) {
                deform_bone_indices[i] = bone_pointer.deform_bone_index;
                break;
            }
        }
    }

    return deform_bone_indices;
}

function get_vertex_influences(vertex_groups, groups_num, vert_index, base_length, 
        deform_bone_indices, weights_buf, bones_buf, res_buf) {

    var precision = 0.01;
    var no_weights = true;

    for (var i = 0; i < groups_num; i++) {
        var weight = vertex_groups[i * base_length + vert_index];

        if (weight !== -1) {
            var bone_index = deform_bone_indices[i];
            // vertex can be assigned to non-bone group
            if (bone_index !== -1) {
                weights_buf[i] = weight;
                bones_buf[i] = bone_index;
                no_weights = false;
            }
        }
    }

    if (no_weights)
        return res_buf;

    // sort in descending order by weights
    sort_two_arrays(weights_buf, bones_buf);

    // normalize weights (in case they were not normalized by author)
    var sum_weights = 0;
    for (var i = 0; i < INFLUENCE_NUM_COMP; i++) 
        sum_weights += weights_buf[i];
    if (sum_weights < precision)
        return res_buf;
    for (var i = 0; i < INFLUENCE_NUM_COMP; i++) 
        weights_buf[i] /= sum_weights;

    // pack to one vector; use a group index in integer part and 
    // a bone weight in fractional part of a number
    if (Math.abs(weights_buf[0] - 1.0) < precision)
        // single group case
        res_buf[0] = bones_buf[0] + 1.0;
    else
        // multi group case
        for (var i = 0; i < INFLUENCE_NUM_COMP; i++)
            res_buf[i] = bones_buf[i] + weights_buf[i];

    return res_buf;
}

/**
 * This function works only for non-animated arrays
 */
function num_comp(array, base_length) {

    if (base_length == 0)
        return 0;
    var array_length = array.length;

    var factor = array_length / base_length;

    if (factor != Math.floor(factor))
        throw "Array size mismatch during geometry calculation: array length=" + 
            array_length + ", base length=" + base_length;

    return factor;
}


/**
 * Sort triangles and update index buffers when camera moves.
 */
exports.update_buffers_movable = function(bufs_data, world_matrix, eye) {

    // retrieve data required for update
    var indices = bufs_data.ibo_array;
    var positions = extract_array(bufs_data, "a_position"); 

    var zinfo = bufs_data.info_for_z_sort_updates;

    var median_cache = zinfo.median_cache;
    var median_world_cache = zinfo.median_world_cache;
    var dist_cache = zinfo.dist_cache;
    var sort_back_to_front = zinfo.sort_back_to_front;

    // get positions to world space and calc medians
    // note: skinning ignored
    compute_triangle_medians(indices, positions, median_cache);
    m_util.positions_multiply_matrix(median_cache, world_matrix, median_world_cache);

    compute_triangle_dists(median_cache, eye, dist_cache);
    var indices = sort_triangles(dist_cache, indices);

    // bind and update IBO 
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, bufs_data.ibo);    
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.DYNAMIC_DRAW);
}

/**
 * Store medians to preallocated Float32Array
 */
function compute_triangle_medians(indices, positions, medians) {
            
    var num_faces = indices.length / 3;

    for (var i = 0; i < num_faces; i++) {
        var index0 = indices[3 * i];
        var index1 = indices[3 * i + 1];
        var index2 = indices[3 * i + 2];

        // vertex coordinate
        var pos00 = positions[3 * index0];
        var pos01 = positions[3 * index0 + 1];
        var pos02 = positions[3 * index0 + 2];

        var pos10 = positions[3 * index1];
        var pos11 = positions[3 * index1 + 1];
        var pos12 = positions[3 * index1 + 2];

        var pos20 = positions[3 * index2];
        var pos21 = positions[3 * index2 + 1];
        var pos22 = positions[3 * index2 + 2];

        medians[3*i] = (pos00 + pos10 + pos20) / 3;
        medians[3*i + 1] = (pos01 + pos11 + pos21) / 3;
        medians[3*i + 2] = (pos02 + pos12 + pos22) / 3;
    }

    return medians;
}

/**
 * Store square dists to preallocated Float32Array
 */
function compute_triangle_dists(medians, eye, dists) {

    var len = medians.length/3;

    for (var i = 0; i < len; i++) {

        var dx = medians[3*i] - eye[0];
        var dy = medians[3*i + 1] - eye[1];
        var dz = medians[3*i + 2] - eye[2];

        dists[i] = dx*dx + dy*dy + dz*dz;
    }

    return dists;
}

/** 
 * Using comb sort
 * currently supported BACK_TO_FRONT sort (discending order)
 */
function sort_triangles(dists, indices) {

    var dlen = dists.length;

    if (dlen < 2)
        return indices;

    var gap = dlen;
    var swapped = false;
    var t;
 
    while ((gap > 1) || swapped) {
        if (gap > 1) {
            gap = Math.floor(gap / COMB_SORT_JUMP_COEFF);
        }
 
        swapped = false;
 
        for (var i = 0; gap + i < dlen; i++) {
            if (dists[i] - dists[i + gap] < 0) {

                t = dists[i]; 
                dists[i] = dists[i+gap]; 
                dists[i+gap] = t;

                swap_indices(indices, i, i+gap);
                swapped = true;
            }
        }
    }

    return indices;
}

exports.sort_two_arrays = sort_two_arrays;
function sort_two_arrays(main_arr, extra_arr, ascending) {
    var arr_length = main_arr.length;
    var gap = arr_length;
    var swapped = false;
    var tmp;

    var order_factor = (ascending == 1) ? -1 : 1;
 
    while (gap > 1 || swapped) {
        if (gap > 1)
            gap = Math.floor(gap / COMB_SORT_JUMP_COEFF);
 
        swapped = false;
 
        for (var i = 0; gap + i < arr_length; i++) {
            if (order_factor * (main_arr[i] - main_arr[i + gap]) < 0) {

                tmp = main_arr[i]; 
                main_arr[i] = main_arr[i + gap]; 
                main_arr[i + gap] = tmp;

                tmp = extra_arr[i]; 
                extra_arr[i] = extra_arr[i + gap]; 
                extra_arr[i + gap] = tmp;

                swapped = true;
            }
        }
    }
    
}

/**
 * pos1 <->  pos2
 */
function swap_indices(indices, pos1, pos2) {

    var t0 = indices[3*pos1];
    var t1 = indices[3*pos1 + 1];
    var t2 = indices[3*pos1 + 2];

    indices[3*pos1] = indices[3*pos2];
    indices[3*pos1 + 1] = indices[3*pos2 + 1];
    indices[3*pos1 + 2] = indices[3*pos2 + 2];

    indices[3*pos2] = t0;
    indices[3*pos2 + 1] = t1;
    indices[3*pos2 + 2] = t2;
}


/**
 * Perform normals calculation
 *
 * shared indices required in case of normals smoothing
 * @methodOf geometry
 */
exports.calc_normals = function(indices, positions, shared_indices) {

    // TODO: rewrite to match new submesh architecture (drop explicit binormals)
    var num_vertices = positions.length / POS_NUM_COMP;
    var num_faces = indices.length / 3; // FACE === TRIANGLE

    // init storage (destination)
    var normals = [];

    var pos0 = new Array(3);
    var pos1 = new Array(3);
    var pos2 = new Array(3);

    // for each face perform normals calculation
    for (var i = 0; i < num_faces; i++) {
        var index0 = indices[3 * i];
        var index1 = indices[3 * i + 1];
        var index2 = indices[3 * i + 2];

        for (var j = 0; j < POS_NUM_COMP; j++) {
            pos0[j] = positions[POS_NUM_COMP * index0 + j];
            pos1[j] = positions[POS_NUM_COMP * index1 + j];
            pos2[j] = positions[POS_NUM_COMP * index2 + j];
        }

        if (shared_indices) {
            // calculate angles to use as weights for averaging
            var angle0 = angle(pos0, pos1, pos2);
            var angle1 = angle(pos1, pos2, pos0);
            var angle2 = Math.PI - angle0 - angle1;
        } else {
            var angle0 = 1;
            var angle1 = 1;
            var angle2 = 1;
        }

        calc_normal_for_face(index0, index1, index2, pos0, pos1, pos2, 
                angle0, angle1, angle2, normals);
    }

    // perform normals smoothing
    if (shared_indices)
        smooth_normals(shared_indices, normals); 

    // normalize normals
    for (var i = 0; i < num_vertices; i++)
        normalize_normal(i, normals)

    return normals;
}

function angle(pos, pos1, pos2) {
    var vec1 = [];
    var vec2 = [];
    m_vec3.subtract(pos1, pos, vec1);
    m_vec3.subtract(pos2, pos, vec2);

    m_vec3.normalize(vec1, vec1);
    m_vec3.normalize(vec2, vec2);
    
    return Math.acos(m_vec3.dot(vec1, vec2));
}

function calc_normal_for_face(index0, index1, index2, pos0, pos1, pos2, 
        angle0, angle1, angle2, dest) {

    // calculate a face normal (same for all 3 vertices in a triangle)
    var normal = calc_normal_by_pos(pos0, pos1, pos2);

    // sum normals for vertices with the same coords
    for (var i = 0; i < NOR_NUM_COMP; i++) {
        var i0 = NOR_NUM_COMP * index0 + i;
        var i1 = NOR_NUM_COMP * index1 + i;
        var i2 = NOR_NUM_COMP * index2 + i;
    
        dest[i0] = angle0 * normal[i];
        dest[i1] = angle1 * normal[i];
        dest[i2] = angle2 * normal[i];
    }
}

function calc_normal_by_pos(pos0, pos1, pos2) {

    var vec1 = [], vec2 = [], normal = [];

    m_vec3.subtract(pos1, pos0, vec1);
    m_vec3.subtract(pos2, pos0, vec2);
    m_vec3.cross(vec1, vec2, normal);
    m_vec3.normalize(normal, normal); // required

    return normal;
}

function smooth_normals(shared_indices, normals) {

    for (var i in shared_indices) {
        var indices = shared_indices[i];

        for (var j = 0; j < NOR_NUM_COMP; j++) {
            var offset0 = NOR_NUM_COMP * indices[0] + j;
            // smooth
            for (var k = 1; k < indices.length; k++) {
                var offset = NOR_NUM_COMP * indices[k] + j;
                normals[offset0] += normals[offset];
            }
            // copy
            for (var k = 1; k < indices.length; k++) {
                var offset = NOR_NUM_COMP * indices[k] + j;
                normals[offset] = normals[offset0];
            }
        }
    }
}

function normalize_normal(i, normals) {
    var normal = new Float32Array(NOR_NUM_COMP);

    for (var j = 0; j < NOR_NUM_COMP; j++) {
        var index = NOR_NUM_COMP * i + j;
        normal[j] = normals[index];
    }
    m_vec3.normalize(normal, normal);
    for (var j = 0; j < NOR_NUM_COMP; j++) {
        var index = NOR_NUM_COMP * i + j;
        normals[index] = normal[j];
    }
}

exports.calc_shared_indices = calc_shared_indices;
/**
 * Calculate shared indices - indices of vertices having same locations
 * @methodOf geometry
 */
function calc_shared_indices(indices, shared_locations, locations) {

    var sh_loc_set = {};
    var len = shared_locations.length / 3;
    for (var i = 0; i < len; i++) {
        var key = 
                String(shared_locations[3*i]) +
                String(shared_locations[3*i + 1]) +
                String(shared_locations[3*i + 2]);
        sh_loc_set[key] = [];
    }

    var len = indices.length;
    for (var i = 0; i < len; i++) {
        var index = indices[i];
        var key = 
                String(locations[3 * index]) +
                String(locations[3 * index + 1]) +
                String(locations[3 * index + 2]);

        if (key in sh_loc_set)
            sh_loc_set[key].push(index);
    }
    return sh_loc_set;
}

/**
 * Return n points uniformly distributed on geometry
 * point is Array of Float32Arrays of coords
 */
exports.geometry_random_points = function(submesh, n, process_normals, seed) {

    var triangles = extract_triangles(submesh, null, false);

    if (process_normals)
        var triangles_n = extract_triangles(submesh, null, true);

    var tnum = triangles.length;
    var areas = new Float32Array(tnum);

    for (var i = 0; i < tnum; i++) {
        var tri = triangles[i];
        areas[i] = triangle_area(tri);
    }

    var cumulative_areas = new Float32Array(tnum);

    cumulative_areas[0] = areas[0];

    for (var i = 1; i < tnum; i++)
        cumulative_areas[i] = cumulative_areas[i-1] + areas[i];

    var geom_area = cumulative_areas[areas.length - 1];

    var points = [];

    // distribute points
    for (var i = 0; i < n; i++) {
        var area = geom_area * m_util.rand_r(seed);

        var tri_index = m_util.binary_search_max(cumulative_areas, area, 0, 
                cumulative_areas.length - 1);

        if (process_normals)
            var tri = triangles_n[tri_index];
        else
            var tri = triangles[tri_index];

        points[i] = triangle_random_point(tri, seed);
    }

    return points;
}


exports.extract_triangles = extract_triangles;
/**
 * <p>Return Array of triangles.
 * <p>triangle is a Float32Array of 9 cooords
 * <p>NOTE: Uses only first frame for vertex-animated meshes
 * @methodOf geometry
 */
function extract_triangles(submesh, dest, process_normals) {

    if (!dest)
        var dest = [];

    if (process_normals)
        var positions = submesh.va_frames[0]["a_normal"];
    else
        var positions = submesh.va_frames[0]["a_position"];

    if (is_indexed(submesh)) {
        var indices = submesh.indices;
        
        var tnum = indices.length / 3;
        for (var i = 0; i < tnum; i++) {
            var tri = new Float32Array(9);

            var i0 = indices[3*i];
            tri[0] = positions[3*i0];
            tri[1] = positions[3*i0 + 1];
            tri[2] = positions[3*i0 + 2];

            var i1 = indices[3*i + 1];
            tri[3] = positions[3*i1];
            tri[4] = positions[3*i1 + 1];
            tri[5] = positions[3*i1 + 2];

            var i2 = indices[3*i + 2];
            tri[6] = positions[3*i2];
            tri[7] = positions[3*i2 + 1];
            tri[8] = positions[3*i2 + 2];

            dest[i] = tri;
        }
    } else {
        
        var tnum = positions.length / 9;
        for (var i = 0; i < positions.length; i++) {
            var tri = new Float32Array(9);

            tri[0] = positions[9*i];
            tri[1] = positions[9*i + 1];
            tri[2] = positions[9*i + 2];

            tri[3] = positions[9*i + 3];
            tri[4] = positions[9*i + 4];
            tri[5] = positions[9*i + 5];

            tri[6] = positions[9*i + 6];
            tri[7] = positions[9*i + 7];
            tri[8] = positions[9*i + 8];

            dest[i] = tri;
        }
    }

    return dest;
}

exports.extract_polyindices = extract_polyindices;
/**
 * <p>Return Array of vertex polygone index.
 * @methodOf geometry
 */
function extract_polyindices(submesh) {
    var polyindices = new Float32Array(submesh.base_length);

    for (var i = 0; i < submesh.base_length; i++)
        polyindices[i] = i % 3;

    return polyindices;
}

/**
 * Calculate triangle area using Heron's formula
 * @methodOf geometry
 */
function triangle_area(triangle) {

    // NOTE: unoptimizied
    var pos0 = new Float32Array([triangle[0], triangle[1], triangle[2]]);
    var pos1 = new Float32Array([triangle[3], triangle[4], triangle[5]]);
    var pos2 = new Float32Array([triangle[6], triangle[7], triangle[8]]);

    var a = m_vec3.dist(pos0, pos1);
    var b = m_vec3.dist(pos0, pos2);
    var c = m_vec3.dist(pos1, pos2);

    var s = (a + b + c) / 2;

    var t = Math.sqrt(s * (s - a) * (s - b) * (s - c)); 

    return t;
}

/**
 * Get random point within triangle
 * @methodOf geometry
 */
function triangle_random_point(triangle, seed, dest) {

    if (!dest)
        var dest = new Float32Array(3);

    var x0 = triangle[0];
    var y0 = triangle[1];
    var z0 = triangle[2];

    var x1 = triangle[3];
    var y1 = triangle[4];
    var z1 = triangle[5];

    var x2 = triangle[6];
    var y2 = triangle[7];
    var z2 = triangle[8];

    // barycentric coords
    var w1 = m_util.rand_r(seed);
    var w2 = m_util.rand_r(seed);

    if ((w1 + w2) > 1) {
        w1 = 1 - w1;
        w2 = 1 - w2;
    }

    var w0 = 1 - w1 - w2;

    var x = w0 * x0 + w1 * x1 + w2 * x2;
    var y = w0 * y0 + w1 * y1 + w2 * y2;
    var z = w0 * z0 + w1 * z1 + w2 * z2;

    dest[0] = x;
    dest[1] = y;
    dest[2] = z;

    return dest;
}

exports.scale_submesh_xyz = function(submesh, scale, center) {
    var positions = submesh.va_frames[0]["a_position"];
    for (var i = 0; i < positions.length; i += 3) {
        positions[i]     = (positions[i]     - center[0]) * scale[0] + center[0];
        positions[i + 1] = (positions[i + 1] - center[1]) * scale[1] + center[1];
        positions[i + 2] = (positions[i + 2] - center[2]) * scale[2] + center[2];
    }
}

}
