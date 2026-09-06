import { LIGHT_PHYSICAL_HANDLE } from "./light-page-layout.js";

// Named samplers (not dynamic sampler-array indexing) link on minimum WebGL2.
export function pageDeclarations(name, layout) {
  const { width, height, across, down, layers, banks } = layout;
  return `
uniform highp usampler2D u${name}Pages;
${Array.from({ length: banks }, (_, i) => `uniform highp sampler2DArray u${name}Bank${i};`).join("\n")}
float ${name}Value(uint handle, float cell) {
  if (handle == 1u) return 0.0;
  if (handle < ${LIGHT_PHYSICAL_HANDLE}u) return float(handle - 2u);
  float physical = float(handle - ${LIGHT_PHYSICAL_HANDLE}u);
  float bank = floor(physical / ${across * down * layers}.0);
  float layer = mod(floor(physical / ${across * down}.0), ${layers}.0);
  vec2 origin = vec2(mod(physical, ${across}.0),
    mod(floor(physical / ${across}.0), ${down}.0)) * vec2(${width}.0, ${height}.0);
  vec2 pixel = origin + vec2(mod(cell, ${width}.0), floor(cell / ${width}.0));
  vec3 uv = vec3((pixel + 0.5) / vec2(${width * across}.0, ${height * down}.0), layer);
  ${Array.from({ length: banks - 1 }, (_, i) => `if (bank < ${i + 0.5}) return floor(texture(u${name}Bank${i}, uv).r * 255.0 + 0.5);`).join("\n")}
  return floor(texture(u${name}Bank${banks - 1}, uv).r * 255.0 + 0.5);
}`;
}

export function pageUniforms(name, store) {
  return { [`u${name}Pages`]: { value: store.table },
    ...Object.fromEntries(store.banks.map((texture, i) => [`u${name}Bank${i}`, { value: texture }])) };
}

export function updatePageUniforms(name, store, uniforms) {
  uniforms[`u${name}Pages`].value = store.table;
  store.banks.forEach((texture, i) => { uniforms[`u${name}Bank${i}`].value = texture; });
}
