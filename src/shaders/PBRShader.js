const vertex = `#version 300 es
precision highp float;
precision highp int;

in vec3 position;
in vec2 uv;
in vec3 normal;

uniform mat3 normalMatrix;
uniform mat4 modelMatrix;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;

out vec2 vUv;
out vec3 vNormal;
out vec3 vMPos;

void main() {
    vUv = uv;
    vNormal = normal;//normalize(normalMatrix * normal);
    vec4 mPos = modelMatrix * vec4(position, 1.0);
    vMPos = position;//mPos.xyz / mPos.w;

    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const fragment = `#version 300 es
precision highp float;
precision highp int;

uniform vec3 cameraPosition;
uniform mat4 viewMatrix;

uniform vec3 uBaseColor;

uniform sampler2D tRMO;
uniform float uMetallic;
uniform float uRoughness;
uniform float uOcclusion;

uniform sampler2D tNormal;
uniform float uNormalScale;
uniform float uNormalUVScale;

uniform sampler2D tLUT;
uniform sampler2D tEnvDiffuse;
uniform sampler2D tEnvSpecular;
uniform float uEnvSpecular;

uniform float uInputType;

uniform vec3 uLightDirection;
uniform vec3 uLightColor;

in vec2 vUv;
in vec3 vNormal;
in vec3 vMPos;

out vec4 FragColor;

const float PI = 3.14159265359;
const float RECIPROCAL_PI = 0.31830988618;
const float RECIPROCAL_PI2 = 0.15915494;
const float LN2 = 0.6931472;

const float ENV_LODS = 6.0;

vec2 g_uv0;
vec2 g_uv1;

vec4 SRGBtoLinear(vec4 srgb) {
    vec3 linOut = pow(srgb.xyz, vec3(2.2));
    return vec4(linOut, srgb.w);
}

vec3 linearToSRGB(vec3 color) {
    return pow(color, vec3(1.0 / 2.2));
}

vec4 RGBEToLinear(vec4 value) {
    return vec4(value.rgb * exp2(value.a * 255.0 - 128.0), 1.0);
}

vec4 RGBMToLinear(vec4 value) {
    float maxRange = 6.0;
    return vec4(value.xyz * value.w * maxRange, 1.0);
}

vec4 RGBDToLinear(vec4 value) {
    float maxRange = 6.0;
    return vec4(value.rgb * ((maxRange / 255.0) / value.a), 1.0);
}

vec3 getNormal() {
    vec3 pos_dx = dFdx(vMPos.xyz);
    vec3 pos_dy = dFdy(vMPos.xyz);
    vec2 tex_dx = dFdx(vUv);
    vec2 tex_dy = dFdy(vUv);

    vec3 t = normalize(pos_dx * tex_dy.t - pos_dy * tex_dx.t);
    vec3 b = normalize(-pos_dx * tex_dy.s + pos_dy * tex_dx.s);
    mat3 tbn = mat3(t, b, normalize(vNormal));

    vec3 n = texture(tNormal, vUv * uNormalUVScale).rgb * 2.0 - 1.0;
    n.xy *= uNormalScale;
    vec3 normal = normalize(tbn * n);

    // Get world normal from view normal (normalMatrix * normal)
    return normalize((vec4(normal, 0.0) * viewMatrix).xyz);
}

vec3 specularReflection(vec3 specularEnvR0, vec3 specularEnvR90, float VdH) {
    return specularEnvR0 + (specularEnvR90 - specularEnvR0) * pow(clamp(1.0 - VdH, 0.0, 1.0), 5.0);
}

float geometricOcclusion(float NdL, float NdV, float roughness) {
    float r = roughness;

    float attenuationL = 2.0 * NdL / (NdL + sqrt(r * r + (1.0 - r * r) * (NdL * NdL)));
    float attenuationV = 2.0 * NdV / (NdV + sqrt(r * r + (1.0 - r * r) * (NdV * NdV)));
    return attenuationL * attenuationV;
}

float microfacetDistribution(float roughness, float NdH) {
    float roughnessSq = roughness * roughness;
    float f = (NdH * roughnessSq - NdH) * NdH + 1.0;
    return roughnessSq / (PI * f * f);
}

vec2 cartesianToPolar(vec3 n) {
    vec2 uv;
    uv.x = atan(n.z, n.x) * RECIPROCAL_PI2 + 0.5;
    uv.y = asin(n.y) * RECIPROCAL_PI + 0.5;
    return uv;
}

void getIBLContribution(inout vec3 diffuse, inout vec3 specular, float NdV, float roughness, vec3 n, vec3 reflection, vec3 diffuseColor, vec3 specularColor) {
    vec3 brdf = SRGBtoLinear(texture(tLUT, vec2(NdV, roughness))).rgb;
    
    // Sample 2 levels and mix between to get smoother degradation
    float blend = roughness * ENV_LODS;
    float level0 = floor(blend);
    float level1 = min(ENV_LODS, level0 + 1.0);
    blend -= level0;
    
    // Sample the specular env map atlas depending on the roughness value
    vec2 uvSpec = cartesianToPolar(reflection);
    uvSpec.y /= 2.0;
    
    vec2 uv0 = uvSpec;
    vec2 uv1 = uvSpec;
    
    uv0 /= pow(2.0, level0);
    uv0.y += 1.0 - exp(-LN2 * level0);
    
    uv1 /= pow(2.0, level1);
    uv1.y += 1.0 - exp(-LN2 * level1);

    vec3 diffuseLight;
    vec3 specular0;
    vec3 specular1;
    
    // 'If else' statements caused the strangest gpu bug
    // if (uInputType < 0.5) {
    //    
    //     // sRGB == 0
    //     diffuseLight = SRGBToLinear(texture(tEnvDiffuse, cartesianToPolar(n))).rgb;
    //     specular0 = SRGBToLinear(texture(tEnvSpecular, uv0)).rgb;
    //     specular1 = SRGBToLinear(texture(tEnvSpecular, uv1)).rgb;
    // } else if (uInputType < 1.5) {
    //    
    //     // RGBE == 1
    //     diffuseLight = RGBEToLinear(texture(tEnvDiffuse, cartesianToPolar(n))).rgb;
    //     specular0 = RGBEToLinear(texture(tEnvSpecular, uv0)).rgb;
    //     specular1 = RGBEToLinear(texture(tEnvSpecular, uv1)).rgb;
    // } else if (uInputType < 2.5) {
    //    
    //     // RGBM == 2
    //     diffuseLight = RGBMToLinear(texture(tEnvDiffuse, cartesianToPolar(n))).rgb;
    //     specular0 = RGBMToLinear(texture(tEnvSpecular, uv0)).rgb;
    //     specular1 = RGBMToLinear(texture(tEnvSpecular, uv1)).rgb;
    // } else if (uInputType < 3.5) {
    //    
    //     // RGBD == 3
    //     diffuseLight = RGBDToLinear(texture(tEnvDiffuse, cartesianToPolar(n))).rgb;
    //     specular0 = RGBDToLinear(texture(tEnvSpecular, uv0)).rgb;
    //     specular1 = RGBDToLinear(texture(tEnvSpecular, uv1)).rgb;
    // }


    // sRGB == 0
    diffuseLight = SRGBtoLinear(texture(tEnvDiffuse, cartesianToPolar(n))).rgb;
    specular0 = SRGBtoLinear(texture(tEnvSpecular, uv0)).rgb;
    specular1 = SRGBtoLinear(texture(tEnvSpecular, uv1)).rgb;
        
    // RGBE == 1
    float mixRGBE = clamp(1.0 - abs(uInputType - 1.0), 0.0, 1.0);
    diffuseLight = mix(diffuseLight, RGBEToLinear(texture(tEnvDiffuse, cartesianToPolar(n))).rgb, mixRGBE);
    specular0 = mix(specular0, RGBEToLinear(texture(tEnvSpecular, uv0)).rgb, mixRGBE);
    specular1 = mix(specular1, RGBEToLinear(texture(tEnvSpecular, uv1)).rgb, mixRGBE);

    // RGBM == 2
    float mixRGBM = clamp(1.0 - abs(uInputType - 2.0), 0.0, 1.0);
    diffuseLight = mix(diffuseLight, RGBMToLinear(texture(tEnvDiffuse, cartesianToPolar(n))).rgb, mixRGBM);
    specular0 = mix(specular0, RGBMToLinear(texture(tEnvSpecular, uv0)).rgb, mixRGBM);
    specular1 = mix(specular1, RGBMToLinear(texture(tEnvSpecular, uv1)).rgb, mixRGBM);
        
    // RGBD == 3
    float mixRGBD = clamp(1.0 - abs(uInputType - 3.0), 0.0, 1.0);
    diffuseLight = mix(diffuseLight, RGBDToLinear(texture(tEnvDiffuse, cartesianToPolar(n))).rgb, mixRGBD);
    specular0 = mix(specular0, RGBDToLinear(texture(tEnvSpecular, uv0)).rgb, mixRGBD);
    specular1 = mix(specular1, RGBDToLinear(texture(tEnvSpecular, uv1)).rgb, mixRGBD);

    g_uv0 = uv0;
    g_uv1 = uv1;
    
    vec3 specularLight = mix(specular0, specular1, blend);

    diffuse = diffuseLight * diffuseColor;
    
    // Bit of extra reflection for smooth materials
    float reflectivity = pow((1.0 - roughness), 2.0) * 0.05;
    specular = specularLight * (specularColor * brdf.x + brdf.y + reflectivity);
    specular *= uEnvSpecular;
}

void main() {
    vec3 baseColor = uBaseColor;

    // RMO map packed as rgb = [roughness, metallic, occlusion]
    vec4 rmaSample = texture(tRMO, vUv);
    float roughness = 0.0;//clamp(rmaSample.r * uRoughness, 0.04, 1.0);
    float metallic = 1.0;//clamp(rmaSample.g * uMetallic, 0.04, 1.0);

    vec3 f0 = vec3(0.04);
    vec3 diffuseColor = baseColor * (vec3(1.0) - f0) * (1.0 - metallic);
    vec3 specularColor = mix(f0, baseColor, metallic);

    vec3 specularEnvR0 = specularColor;
    vec3 specularEnvR90 = vec3(clamp(max(max(specularColor.r, specularColor.g), specularColor.b) * 25.0, 0.0, 1.0));

    vec3 N = normalize(vNormal);//getNormal();
    vec3 V = normalize(cameraPosition - vMPos);
    vec3 L = normalize(uLightDirection);
    vec3 H = normalize(L + V);
    vec3 reflection = normalize(reflect(-V, N));

    float NdL = clamp(dot(N, L), 0.001, 1.0);
    float NdV = clamp(abs(dot(N, V)), 0.001, 1.0);
    float NdH = clamp(dot(N, H), 0.0, 1.0);
    float LdH = clamp(dot(L, H), 0.0, 1.0);
    float VdH = clamp(dot(V, H), 0.0, 1.0);

    vec3 F = specularReflection(specularEnvR0, specularEnvR90, VdH);
    float G = geometricOcclusion(NdL, NdV, roughness);
    float D = microfacetDistribution(roughness, NdH);

    vec3 diffuseContrib = (1.0 - F) * (diffuseColor / PI);
    vec3 specContrib = F * G * D / (4.0 * NdL * NdV);
    
    // Shading based off lights
    vec3 color = NdL * uLightColor * (diffuseContrib + specContrib);

    // Calculate IBL lighting
    vec3 diffuseIBL;
    vec3 specularIBL;
    getIBLContribution(diffuseIBL, specularIBL, NdV, roughness, N, reflection, diffuseColor, specularColor);

    // Add IBL on top of color
    color += diffuseIBL + specularIBL;

    // Multiply occlusion
    color = mix(color, color * rmaSample.b, uOcclusion);

    // Convert to sRGB to display //
    FragColor.rgb = linearToSRGB(color);//reflection;/////
    FragColor.a = 1.0;
}
`;

export default {vertex, fragment};