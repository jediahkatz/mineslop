import * as THREE from "three";
import { BLOCK_LIGHT_GAIN } from "./block-light-field.js";
import { BLOCK_PAGE_LAYOUT } from "./light-page-layout.js";
import { pageDeclarations, pageUniforms, updatePageUniforms } from "./light-page-material.js";

export const BLOCK_LIGHT_DECLARATIONS = `
uniform float uBlockLightEnabled, uBlockLightGain;
${pageDeclarations("BlockLight", BLOCK_PAGE_LAYOUT)}
uniform sampler2D uBlockLightPalette;
uniform vec3 uBlockLightField;
uniform vec2 uBlockLightOrigin;
vec4 blockLightPage(vec2 cell, float y, vec2 column) {
  if (any(lessThan(column, uBlockLightOrigin)) ||
    any(greaterThanEqual(column, uBlockLightOrigin + uBlockLightField.z))) return vec4(0.0);
  vec2 local = cell - column * 16.0 + 2.0;
  if (any(lessThan(local, vec2(0.0))) || any(greaterThanEqual(local, vec2(20.0)))) return vec4(0.0);
  float slot = mod(column.y, uBlockLightField.z) * uBlockLightField.z + mod(column.x, uBlockLightField.z);
  uint handle = texelFetch(uBlockLightPages, ivec2(int(slot), int(floor(y / 16.0))), 0).r;
  if (handle == 0u) return vec4(0.0);
  float index = mod(y, 16.0) * 400.0 + local.y * 20.0 + local.x;
  float code = BlockLightValue(handle, index);
  return vec4(texture2D(uBlockLightPalette, vec2((code + 0.5) / 256.0, 0.5)).rgb, 1.0);
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
    ...pageUniforms("BlockLight", field.store),
    uBlockLightPalette: { value: field.paletteTexture },
    uBlockLightField: { value: new THREE.Vector3() },
    uBlockLightOrigin: { value: new THREE.Vector2() },
  };
}

export function updateBlockLightUniforms(field, uniforms, fullbright) {
  uniforms.uBlockLightEnabled.value = Number(!!field.world && !field.disposed && !fullbright);
  updatePageUniforms("BlockLight", field.store, uniforms);
  uniforms.uBlockLightPalette.value = field.paletteTexture;
  uniforms.uBlockLightField.value.set(field.spec?.minY ?? 0, field.height, field.tiles);
  uniforms.uBlockLightOrigin.value.set((field.cx ?? 0) - field.radius, (field.cz ?? 0) - field.radius);
}
