"use strict";

/**
 * Animation API.
 * @module animation
 */
b4w.module["animation"] = function(exports, require) {

var animation     = require("__animation");
var m_constraints = require("__constraints");
var physics       = require("__physics");
var util          = require("__util");

/**
 * Animation behavior: cyclic.
 * @const module:animation.AB_CYCLIC
 */
exports["AB_CYCLIC"] = animation.AB_CYCLIC;
/**
 * Animation behavior: reset to zero frame after finish.
 * @const module:animation.AB_FINISH_RESET
 */
exports["AB_FINISH_RESET"] = animation.AB_FINISH_RESET;
/**
 * Animation behavior: stop animation after finish.
 * @const module:animation.AB_FINISH_STOP
 */
exports["AB_FINISH_STOP"] = animation.AB_FINISH_STOP;

var _vec4_tmp = new Float32Array(4);

/**
 * Check if object is currently animated
 * @method module:animation.is_animated
 * @param obj Object ID
 */
exports["is_animated"] = function(obj) {
    return animation.is_animated(obj);
}

/**
 * Return all available action names
 * @method module:animation.get_actions
 */
exports["get_actions"] = function() {
    var anames = [];
    var actions = animation.get_all_actions();
    for (var i = 0; i < actions.length; i++)
        anames.push(actions[i]["name"]);

    return anames;
}

/**
 * Return applied action name
 * @method module:animation.get_current_action
 * @param obj Object ID
 */
exports["get_current_action"] = function(obj) {
    return animation.get_current_action(obj);
}

/**
 * Apply given animation to object
 * @method module:animation.apply
 * @param obj Object ID
 * @param {String} name Action name
 */
exports["apply"] = function(obj, name) {
    animation.apply(obj, name);
}

/**
 * Remove animation from object
 * @method module:animation.remove
 * @param obj Object ID
 */
exports["remove"] = function(obj) {
    animation.remove(obj);
}

/**
 * Apply default (specified in blender) animation to object
 * @method module:animation.apply_def
 * @param obj Object ID
 */
exports["apply_def"] = function(obj) {
    animation.apply_def(obj);
}

/**
 * Play object animation.
 * @method module:animation.play
 * @param obj Object ID
 * @param [finish_callback] Callback to execute on finished animation
 * @param [offset=0] Offset in seconds
 */
exports["play"] = function(obj, finish_callback, offset) {
    animation.play(obj, finish_callback, offset);
    animation.update_object_animation(obj);
}
/**
 * Stop object animation
 * @method module:animation.stop
 * @param obj Object ID
 */
exports["stop"] = function(obj) {
    animation.stop(obj);
}
/**
 * Check if object is playing one
 * @method module:animation.is_play
 * @param obj Object ID
 */
exports["is_play"] = function(obj) {
    return animation.is_play(obj);
}
/**
 * Set current frame
 * @method module:animation.set_current_frame_float
 * @param obj Object ID
 * @param {Number} cff Current frame
 * @deprecated Replaced by set_frame
 */
exports["set_current_frame_float"] = function(obj, cff) {
    animation.set_current_frame_float(obj, cff);
}
/**
 * @method module:animation.get_current_frame_float
 * @param obj Object ID
 * @deprecated Replaced by get_frame
 */
exports["get_current_frame_float"] = function(obj) {
    return animation.get_current_frame_float(obj);
}

/**
 * Set current frame and update object animation.
 * @method module:animation.set_frame
 * @param obj Object ID.
 * @param {Number} frame Current frame (float).
 */
exports["set_frame"] = function(obj, frame) {
    animation.set_current_frame_float(obj, frame);
    animation.update_object_animation(obj, 0);
}
/**
 * Get current frame.
 * @method module:animation.get_frame
 * @param obj Object ID
 */
exports["get_frame"] = function(obj) {
    return animation.get_current_frame_float(obj);
}

/**
 * @method module:animation.get_frame_range
 * @param obj Object ID
 */
exports["get_frame_range"] = function(obj) {
    if (obj._anim)
        return obj._anim.action_frame_range;
    else
        return null;
}

/**
 * Get animation length in frames
 * @method module:animation.get_anim_length
 * @param obj Object ID
 */
exports["get_anim_length"] = function(obj) {
    if (obj._anim)
        return obj._anim.length;
    else
        return -1;
}

/**
 * Perform cyclic animation play or not
 * @method module:animation.cyclic
 * @param obj Object ID
 * @param {Boolean} cyclic_flag
 * @deprecated Use set_behavior() instead.
 */
exports["cyclic"] = function(obj, cyclic_flag) {
    animation.cyclic(obj, cyclic_flag);
}
/**
 * Check if animation is cyclic
 * @method module:animation.is_cyclic
 * @param obj Object ID
 * @deprecated Use get_behavior() instead.
 */
exports["is_cyclic"] = function(obj) {
    return animation.is_cyclic(obj);
}

/**
 * Set animation behavior.
 * @method module:animation.set_behavior
 * @param obj Object ID
 * @param behavior Behavior enum
 */
exports["set_behavior"] = function(obj, behavior) {
    animation.set_behavior(obj, behavior);
}

/**
 * Get animation behavior.
 * @method module:animation.get_behavior
 * @param obj Object ID
 * @returns Behavior enum
 */
exports["get_behavior"] = function(obj) {
    return animation.get_behavior(obj);
}

/**
 * Apply smoothing. 
 * apply zero periods to disable
 * @method module:animation.apply_smoothing
 * @param obj Object ID
 * @param [trans_period=0] Translation smoothing period
 * @param [quat_period=0] Rotation smoothing period
 */
exports["apply_smoothing"] = function(obj, trans_period, quat_period) {
    animation.apply_smoothing(obj, trans_period, quat_period);
}

/**
 * Update object animation (set pose)
 * @method module:animation.update_object_animation
 * @param obj Object ID
 * @param {Number} elapsed Animation delay
 */
exports["update_object_animation"] = function(obj, elapsed) {
    animation.update_object_animation(obj, elapsed);
}

/**
 * Convert frame to second
 * @method module:animation.frame_to_sec
 * @param frame
 */
exports["frame_to_sec"] = function(frame) {
    return animation.frame_to_sec(frame);
}

/**
 * Switch collision detection flag
 * @method module:animation.detect_collisions
 * @param obj Object ID
 * @param {Boolean} use Detect collisions
 * @deprecated Use physics.enable_simulation/physics.disable_simulation.
 */
exports["detect_collisions"] = function(obj, use) {
    if (use)
        physics.enable_simulation(obj);
    else
        physics.disable_simulation(obj);
}
/**
 * Get detect collisions flag
 * @method module:animation.is_detect_collisions_used
 * @param obj Object ID
 * @returns {Boolean} Detect collision usage flag
 * @deprecated Use physics.has_simulated_physics().
 */
exports["is_detect_collisions_used"] = function(obj) {
    return physics.has_simulated_physics(obj);
}

/**
 * Get bone translation for object with skeletal animation.
 * @method module:animation.get_bone_translation
 */
exports["get_bone_translation"] = function(armobj, bone_name, dest) {
    if (!util.is_armature(armobj))
        return null;

    if (!dest)
        var dest = new Float32Array(3);

    var trans_scale = _vec4_tmp;
    m_constraints.get_bone_pose(armobj, bone_name, false, trans_scale, null);

    dest[0] = trans_scale[0];
    dest[1] = trans_scale[1];
    dest[2] = trans_scale[2];

    return dest;
}

exports["update_object_transform"] = function(obj) {
    throw("Deprecated method execution");
}
exports["set_translation"] = function(obj, x, y, z) {
    throw("Deprecated method execution");
}
exports["set_translation_v"] = function(obj, trans) {
    throw("Deprecated method execution");
}
exports["set_translation_rel"] = function(obj, x, y, z, obj_parent) {
    throw("Deprecated method execution");
}
exports["get_translation"] = function(obj, dest) {
    throw("Deprecated method execution");
}
exports["set_rotation_quat"] = function(obj, x, y, z, w) {
    throw("Deprecated method execution");
}
exports["set_rotation_quat_v"] = function(obj, quat) {
    throw("Deprecated method execution");
}
exports["get_rotation_quat"] = function(obj, dest) {
    throw("Deprecated method execution");
}
exports["set_rotation_euler"] = function(obj, x, y, z) {
    throw("Deprecated method execution");
}
exports["set_rotation_euler_v"] = function(obj, euler) {
    throw("Deprecated method execution");
}
exports["set_scale"] = function(obj, scale) {
    throw("Deprecated method execution");
}
exports["empty_reset_transform"] = function(obj) {
    throw("Deprecated method execution");
}

}
