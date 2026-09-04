import * as THREE from "three";
import { BLOCK_LIGHT_GAIN } from "./block-light-field.js";

export const BLOCK_LIGHT_DECLARATIONS = `
uniform float uBlockLightEnabled, uBlockLightGain;
uniform highp sampler2DArray uBlockLightAtlas;
uniform sampler2D uBlockLightValid;
uniform vec3 uBlockLightField;
uniform vec2 uBlockLightOrigin;
vec4 blockLightPage(vec2 cell, float y, vec2 column) {
  if (any(lessThan(column, uBlockLightOrigin)) ||
    any(greaterThanEqual(column, uBlockLightOrigin + uBlockLightField.z))) return vec4(0.0);
  vec2 local = cell - column * 16.0 + 2.0;
  if (any(lessThan(local, vec2(0.0))) || any(greaterThanEqual(local, vec2(20.0)))) return vec4(0.0);
  float slot = mod(column.y, uBlockLightField.z) * uBlockLightField.z + mod(column.x, uBlockLightField.z);
  vec2 validUV = (vec2(slot, floor(y / 16.0)) + 0.5)
    / vec2(uBlockLightField.z * uBlockLightField.z, uBlockLightField.y / 16.0);
  float ready = texture2D(uBlockLightValid, validUV).r;
  if (ready < 0.25) return vec4(0.0);
  if (ready < 0.99) return vec4(0.0, 0.0, 0.0, 1.0);
  float index = y * 400.0 + local.y * 20.0 + local.x;
  vec2 uv = (vec2(mod(index, 80.0), floor(index / 80.0)) + 0.5)
    / vec2(80.0, uBlockLightField.y * 5.0);
  return vec4(texture(uBlockLightAtlas, vec3(uv, slot)).rgb, 1.0);
}
vec3 blockLightAt(vec3 point) {
  #ifdef MINESLOP_EXTERIOR_DAYLIGHT
    return vec3(0.0);
  #else
    if (uBlockLightEnabled < 0.5) return vec3(0.0);
    float y = floor(point.y) - uBlockLightField.x;
    if (y < 0.0 || y >= uBlockLightField.y) return vec3(0.0);
    vec2 cell = floor(point.xz), owner = floor(point.xz / 16.0);
    vec2 column = clamp(owner, uBlockLightOrigin,
      uBlockLightOrigin + uBlockLightField.z - 1.0);
    vec4 light = blockLightPage(cell, y, column);
    // A cold re-entering owner must not hide a still-valid apron copy.
    vec2 local = cell - owner * 16.0;
    bvec2 edge = bvec2(local.x < 2.0 || local.x >= 14.0, local.y < 2.0 || local.y >= 14.0);
    vec2 neighbor = owner + vec2(local.x < 2.0 ? -1.0 : 1.0, local.y < 2.0 ? -1.0 : 1.0);
    if (light.a < 0.5 && edge.x) light = blockLightPage(cell, y, vec2(neighbor.x, owner.y));
    if (light.a < 0.5 && edge.y) light = blockLightPage(cell, y, vec2(owner.x, neighbor.y));
    if (light.a < 0.5 && edge.x && edge.y) light = blockLightPage(cell, y, neighbor);
    return light.rgb * uBlockLightGain;
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
