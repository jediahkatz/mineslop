import * as THREE from "three";
import { BLOCK_LIGHT_GAIN } from "./block-light-field.js";

export const BLOCK_LIGHT_DECLARATIONS = `
uniform float uBlockLightEnabled, uBlockLightGain;
uniform highp sampler2DArray uBlockLightAtlas;
uniform sampler2D uBlockLightValid;
uniform vec3 uBlockLightField;
uniform vec2 uBlockLightOrigin;
vec3 blockLightAt(vec3 point) {
  #ifdef MINESLOP_EXTERIOR_DAYLIGHT
    return vec3(0.0);
  #else
    if (uBlockLightEnabled < 0.5) return vec3(0.0);
    float y = floor(point.y) - uBlockLightField.x;
    vec2 column = clamp(floor(point.xz / 16.0), uBlockLightOrigin,
      uBlockLightOrigin + uBlockLightField.z - 1.0);
    vec2 local = floor(point.xz) - column * 16.0 + 2.0;
    if (y < 0.0 || y >= uBlockLightField.y || any(lessThan(local, vec2(0.0))) ||
      any(greaterThanEqual(local, vec2(20.0)))) return vec3(0.0);
    float slot = mod(column.y, uBlockLightField.z) * uBlockLightField.z + mod(column.x, uBlockLightField.z);
    vec2 validUV = (vec2(slot, floor(y / 16.0)) + 0.5)
      / vec2(uBlockLightField.z * uBlockLightField.z, uBlockLightField.y / 16.0);
    if (texture2D(uBlockLightValid, validUV).r < 0.99) return vec3(0.0);
    float index = y * 400.0 + local.y * 20.0 + local.x;
    vec2 uv = (vec2(mod(index, 80.0), floor(index / 80.0)) + 0.5)
      / vec2(80.0, uBlockLightField.y * 5.0);
    return texture(uBlockLightAtlas, vec3(uv, slot)).rgb * uBlockLightGain;
  #endif
}
`;

export function blockLightUniforms(field) {
  return {
    uBlockLightEnabled: { value: 0 },
    uBlockLightGain: { value: BLOCK_LIGHT_GAIN },
    uBlockLightAtlas: { value: field.texture },
    uBlockLightValid: { value: field.validTexture },
    uBlockLightField: { value: new THREE.Vector3() },
    uBlockLightOrigin: { value: new THREE.Vector2() },
  };
}

export function updateBlockLightUniforms(field, uniforms, fullbright) {
  uniforms.uBlockLightEnabled.value = Number(!!field.world && !field.disposed && !fullbright);
  uniforms.uBlockLightAtlas.value = field.texture;
  uniforms.uBlockLightValid.value = field.validTexture;
  uniforms.uBlockLightField.value.set(field.spec?.minY ?? 0, field.height, field.tiles);
  uniforms.uBlockLightOrigin.value.set((field.cx ?? 0) - field.radius, (field.cz ?? 0) - field.radius);
}
