#export is_equalf
#export identity qrot rotation_x rotation_y rotation_z mat3_transpose
#export vertex 
#export tbn_norm

float FLOAT_EQUALITY_EPS = .000001;

struct vertex 
{
    vec3 position;
    vec3 center;
    vec3 tangent;
    vec3 binormal;
    vec3 normal;
    vec3 color;
};

bool is_equalf(float a, float b) {
    return abs(a - b) < FLOAT_EQUALITY_EPS;
}

vec3 qrot(in vec4 q, in vec3 v) 
{
    return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v);
}

/*
vec3 qrot(in vec4 quat, in vec3 vec) 
{
    float x = vec[0], y = vec[1], z = vec[2],
        qx = quat[0], qy = quat[1], qz = quat[2], qw = quat[3];

    // calculate quat * vec
    float ix = qw * x + qy * z - qz * y;
    float iy = qw * y + qz * x - qx * z;
    float iz = qw * z + qx * y - qy * x;
    float iw = -qx * x - qy * y - qz * z;

    vec3 dest;

    // calculate result * inverse quat
    dest[0] = ix * qw + iw * -qx + iy * -qz - iz * -qy;
    dest[1] = iy * qw + iw * -qy + iz * -qx - ix * -qz;
    dest[2] = iz * qw + iw * -qz + ix * -qy - iy * -qx;

    return dest;
}
*/

mat3 mat3_transpose(mat3 m) {
    mat3 m_out = m;
    m_out[0][1] = m[1][0];
    m_out[0][2] = m[2][0];
    m_out[1][0] = m[0][1];
    m_out[1][2] = m[2][1];
    m_out[2][0] = m[0][2];
    m_out[2][1] = m[1][2];
    return m_out;
}

mat4 identity() {
    return mat4(1.0, 0.0, 0.0, 0.0, 
                0.0, 1.0, 0.0, 0.0, 
                0.0, 0.0, 1.0, 0.0, 
                0.0, 0.0, 0.0, 1.0);
}

mat4 rotation_x(float angle) {
    return mat4(1.0, 0.0, 0.0, 0.0, 
                0.0, cos(angle),-sin(angle), 0.0, 
                0.0, sin(angle), cos(angle), 0.0, 
                0.0, 0.0, 0.0, 1.0);
}

mat4 rotation_y(float angle) {
    return mat4(cos(angle), 0.0, sin(angle), 0.0, 
                0.0, 1.0, 0.0, 0.0, 
               -sin(angle), 0.0, cos(angle), 0.0, 
                0.0, 0.0, 0.0, 1.0);
}

mat4 rotation_z(float angle) {
    return mat4(cos(angle),-sin(angle), 0.0, 0.0, 
                sin(angle), cos(angle), 0.0, 0.0, 
                0.0, 0.0, 1.0, 0.0, 
                0.0, 0.0, 0.0, 1.0);
}

vertex tbn_norm(in vertex v) {
    return vertex(v.position, v.center, normalize(v.tangent),
            normalize(v.binormal), normalize(v.normal), v.color);
}
