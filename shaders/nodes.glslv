#var AU_QUALIFIER uniform
#var MAX_BONES 0
#var PRECISION lowp

/*============================================================================
                                  INCLUDES
============================================================================*/
#include <std_enums.glsl>

#include <math.glslv>
#include <to_world.glslv>

/*============================================================================
                                  ATTRIBUTES
============================================================================*/

attribute vec3 a_position;

#if SHADED || USE_NODE_GEOMETRY_NO
attribute vec3 a_normal;
# if CALC_TBN_SPACE
attribute vec4 a_tangent;
# endif
#endif

#if SKINNED
attribute vec4 a_influence;
#endif

#if WIND_BEND
    #if MAIN_BEND_COL
        attribute float a_bending_col_main;
        #if DETAIL_BEND
            attribute vec3 a_bending_col_detail;
            AU_QUALIFIER float au_detail_bending_amp;
            AU_QUALIFIER float au_branch_bending_amp;
            AU_QUALIFIER float au_detail_bending_freq;
        #endif
    #endif
    AU_QUALIFIER float au_wind_bending_amp;
    AU_QUALIFIER float au_wind_bending_freq;
#endif // WIND_BEND

#if WIND_BEND || HAIR_BILLBOARD
    AU_QUALIFIER vec3 au_center_pos;
#endif

#if VERTEX_ANIM
attribute vec3 a_position_next;
# if SHADED
attribute vec3 a_normal_next;
#  if CALC_TBN_SPACE
attribute vec4 a_tangent_next;
#  endif
# endif
#endif  // VERTEX_ANIM

/*============================================================================
                                   UNIFORMS
============================================================================*/

#if STATIC_BATCH
const mat4 u_model_matrix = mat4(1.0);
#else
uniform mat4 u_model_matrix;
#endif

uniform mat4 u_view_matrix;
uniform mat4 u_proj_matrix;
# if HAIR_BILLBOARD
uniform vec3 u_camera_eye;
# endif

#if SKINNED
uniform vec4 u_quatsb[MAX_BONES];
uniform vec4 u_transb[MAX_BONES];

# if FRAMES_BLENDING
uniform vec4 u_quatsa[MAX_BONES];
uniform vec4 u_transa[MAX_BONES];
// near 0 if before, near 1 if after
uniform float u_frame_factor;
# endif
#endif // SKINNED


#if WIND_BEND
#if HAIR_BILLBOARD_JITTERED
uniform float u_jitter_amp;
uniform float u_jitter_freq;
#endif
uniform vec3 u_wind;
uniform PRECISION float u_time;
#endif

#if VERTEX_ANIM
uniform float u_va_frame_factor;
#endif

#if SHADOW_SRC != SHADOW_SRC_MASK && SHADOW_SRC != SHADOW_SRC_NONE
uniform mat4 u_v_light_matrix;
// bias light matrix
uniform mat4 u_b_light_matrix;
uniform mat4 u_p_light_matrix0;

# if CSM_SECTION1
uniform mat4 u_p_light_matrix1;
# endif

# if CSM_SECTION2
uniform mat4 u_p_light_matrix2;
# endif

# if CSM_SECTION3
uniform mat4 u_p_light_matrix3;
# endif
#endif


/*============================================================================
                                   VARYINGS
============================================================================*/

//varying vec3 v_eye_dir;
varying vec3 v_pos_world;
varying vec4 v_pos_view;

#if SHADED || USE_NODE_GEOMETRY_NO
varying vec3 v_normal;
# if CALC_TBN_SPACE
varying vec4 v_tangent;
# endif
#endif

#if SHADOW_SRC != SHADOW_SRC_MASK && SHADOW_SRC != SHADOW_SRC_NONE
varying vec4 v_shadow_coord0;
# if CSM_SECTION1
varying vec4 v_shadow_coord1;
#endif
# if CSM_SECTION2
varying vec4 v_shadow_coord2;
#endif
# if CSM_SECTION3
varying vec4 v_shadow_coord3;
# endif
#endif

#if REFLECTIVE || SHADOW_SRC == SHADOW_SRC_MASK
varying vec3 v_tex_pos_clip;
#endif

/*============================================================================
                                  INCLUDES
============================================================================*/

#include <shadow.glslv>
#include <skin.glslv>
#include <wind_bending.glslv>

#node GEOMETRY_UV
    #node_param attribute vec2 a_uv
    #node_param varying vec2 v_uv
    v_uv = a_uv;
#endnode

#node GEOMETRY_VC
    #node_param attribute vec3 a_vertex_color
    #node_param varying vec3 v_vertex_color
    v_vertex_color = a_vertex_color;
#endnode

#node GEOMETRY_VC1
    #node_param attribute float a_vertex_color
    #node_param varying float v_vertex_color
    v_vertex_color = a_vertex_color;
#endnode

#node GEOMETRY_VC2
    #node_param attribute vec2 a_vertex_color
    #node_param varying vec2 v_vertex_color
    v_vertex_color = a_vertex_color;
#endnode

#node GEOMETRY_VC3
    #node_param attribute vec3 a_vertex_color
    #node_param varying vec3 v_vertex_color
    v_vertex_color = a_vertex_color;
#endnode

#nodes_global

/*============================================================================
                                    MAIN
============================================================================*/

void main(void) {

    vec3 position = a_position;
#if SHADED
    vec3 normal = a_normal;
# if CALC_TBN_SPACE
    vec3 tangent = vec3(a_tangent);
    vec3 binormal = a_tangent[3] * cross(normal, tangent);
# else
    vec3 tangent = vec3(0.0);
    vec3 binormal = vec3(0.0);
# endif

#elif USE_NODE_GEOMETRY_NO
    vec3 normal = a_normal;
#else   // SHADED
    vec3 normal = vec3(0.0);
#endif  // SHADED

#if VERTEX_ANIM
    position = mix(position, a_position_next, u_va_frame_factor);
# if SHADED
    normal = mix(normal, a_normal_next, u_va_frame_factor);
#  if CALC_TBN_SPACE
    vec3 tangent_next = vec3(a_tangent);
    vec3 binormal_next = a_tangent_next[3] * cross(a_normal_next, tangent_next);
    tangent = mix(tangent, tangent_next, u_va_frame_factor);
    binormal = mix(binormal, binormal_next, u_va_frame_factor);
#  endif
# endif
#endif

#if SKINNED
    skin(position, tangent, binormal, normal);
#endif

// apply detailed wind bending (branches and leaves)

#if WIND_BEND || HAIR_BILLBOARD
    vec3 center = au_center_pos;
#else
    vec3 center = vec3(0.0);
#endif

#if CALC_TBN_SPACE
# if HAIR_BILLBOARD
    vec3 wcen = (u_model_matrix * vec4(center, 1.0)).xyz;
    mat4 model_matrix = billboard_matrix(u_camera_eye, wcen, u_view_matrix);
#  if WIND_BEND && HAIR_BILLBOARD_JITTERED
    vec3 vec_seed = (u_model_matrix * vec4(center, 1.0)).xyz;
    model_matrix = model_matrix * bend_jitter_matrix(u_wind, u_time, 
            u_jitter_amp, u_jitter_freq, vec_seed);
#  endif
    vertex world = to_world(position - center, center, tangent, binormal, normal,
            model_matrix);
    world.center = wcen;
# else
    vertex world = to_world(position, center, tangent, binormal, normal,
            u_model_matrix);
# endif

    // calculate handedness as described in Math for 3D GP and CG, page 185
    float m = (dot(cross(world.normal, world.tangent),
        world.binormal) < 0.0) ? -1.0 : 1.0;

    v_tangent = vec4(world.tangent, m);
#else
# if HAIR_BILLBOARD
    vec3 wcen = (u_model_matrix * vec4(center, 1.0)).xyz;
    mat4 model_matrix = billboard_matrix(u_camera_eye, wcen, u_view_matrix);
#  if WIND_BEND && HAIR_BILLBOARD_JITTERED
    vec3 vec_seed = (u_model_matrix * vec4(center, 1.0)).xyz;
    model_matrix = model_matrix * bend_jitter_matrix(u_wind, u_time, 
            u_jitter_amp, u_jitter_freq, vec_seed);
#  endif
    vertex world = to_world(position - center, center, vec3(0.0), vec3(0.0), normal,
            model_matrix);
    world.center = wcen;
# else
    vertex world = to_world(position, center, vec3(0.0), vec3(0.0), normal,
            u_model_matrix);
# endif
#endif

#if WIND_BEND
    bend_vertex(world.position, world.center, normal);
#endif

    v_pos_world = world.position;

#if SHADED || USE_NODE_GEOMETRY_NO
    v_normal = world.normal;
#endif

    v_pos_view = u_view_matrix * vec4(world.position, 1.0);

    vec4 pos_clip = u_proj_matrix * v_pos_view;

#if SHADOW_SRC == SHADOW_SRC_MASK
    get_shadow_coords(pos_clip);
#elif SHADOW_SRC != SHADOW_SRC_NONE
    get_shadow_coords(world.position);
#endif

#if REFLECTIVE
    float xc = pos_clip.x;
    float yc = pos_clip.y;
    float wc = pos_clip.w;

    v_tex_pos_clip.x = (xc + wc) / 2.0;
    v_tex_pos_clip.y = (yc + wc) / 2.0;
    v_tex_pos_clip.z = wc;
#endif

    #nodes_main

    gl_Position = pos_clip;
}
