#include <precision_statement.glslf>
#include <depth_fetch.glslf>
#include <procedural.glslf>

#var STEPS_PER_PASS 0.0

uniform float u_time;
uniform float u_radial_blur_step;

uniform vec3 u_sun_intensity;
uniform sampler2D u_input;

#if DEPTH_RGBA
uniform vec2 u_camera_range;
# if WATER_EFFECTS
varying float v_underwater;
varying vec2 v_texture_offset;
# endif
#endif

varying vec2 v_texcoord;
varying vec4 v_sun_pos_clip;

void main(void) {

    vec3 lcolorint = u_sun_intensity;
    // delta from current pixel to sun position
    vec2 delta = (v_sun_pos_clip.xy - v_texcoord);
    float dist = length(delta);

    // Step vector (uv space)
    vec2 stepv = u_radial_blur_step * delta/dist;
    // Number of iterations between pixel and sun
    float iters = dist/u_radial_blur_step;

    //Correction for near the sun positions
    stepv *= min(iters, STEPS_PER_PASS) / STEPS_PER_PASS;
    iters = max(iters, STEPS_PER_PASS);
    
    vec2 uv = v_texcoord;
    float col = 0.0;

    for (float i = 0.0; i < STEPS_PER_PASS; i += 1.0 ) {
        
        if (i <= iters) {
            //On the first iteration Depth map is being unpacked and blurred.
            //On further iterations only performs blur of the given texture.
#if DEPTH_RGBA
            float depth = depth_fetch(u_input, uv, u_camera_range);
            col += (1.0 - pow(dist, 0.3)) * depth; //brighter at center
#else
            col += texture2D(u_input, uv).r;
#endif
        }
        uv += stepv;
    }

#if DEPTH_RGBA && WATER_EFFECTS
    vec2 texcoord = v_texcoord + v_texture_offset;
    float noise =
        cellular2x2(
            vec2(2.5 * (texcoord.x),
                 2.5 * (texcoord.y) + 1.0 * u_time)
        ).x

        + 0.75 * cellular2x2(
            vec2(5.0 * (texcoord.x) - 0.66 * u_time,
                 5.0 * (texcoord.y) + 0.66 * u_time)
        ).x

        + 0.5 * snoise(
            vec2(7.5 * (texcoord.x) + 0.33 * u_time,
                 7.5 * (texcoord.y) - 0.33 * u_time)
        );

    noise *= clamp(1.2 - sqrt(0.2 * dist), 0.0, 1.0) * v_underwater;
    col = max(noise, col);
#endif

    gl_FragColor = vec4(col / STEPS_PER_PASS * clamp(lcolorint, 0.4, 0.8), 1.0);
}
