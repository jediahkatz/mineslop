import * as THREE from "three";

const states = ["side", "transparent", "forceSinglePass", "opacity", "vertexColors",
  "depthTest", "depthWrite", "depthFunc", "colorWrite", "blending", "blendSrc", "blendDst",
  "blendEquation", "blendSrcAlpha", "blendDstAlpha", "blendEquationAlpha", "blendAlpha",
  "premultipliedAlpha", "flatShading", "wireframe", "alphaTest", "alphaHash", "alphaToCoverage",
  "stencilWrite", "polygonOffset", "normalMap", "bumpMap", "displacementMap", "envMap",
  "lightMap", "aoMap", "alphaMap", "specularMap", "emissiveMap", "map", "clippingPlanes",
  "emissiveIntensity", "toneMapped", "dithering", "fog", "visible", "onBeforeCompile",
  "customProgramCacheKey", "onBeforeRender"];

const versions = new WeakMap();

// Observe the complete Three two-pass protocol, not a guessed even version
// delta. Explicit needsUpdate at DoubleSide (including +2) remains semantic.
// Raw Three versions still increment normally; only our snapshot discounts
// BACK/update, FRONT/update, DOUBLE restoration with no intervening mutation.
export function retainWaterMaterial(material) {
  let tracked = versions.get(material);
  if (!tracked) {
    const sideDescriptor = Object.getOwnPropertyDescriptor(material, "side");
    const updateDescriptor = Object.getOwnPropertyDescriptor(material, "needsUpdate");
    let prototype = material, setter;
    while (prototype && !setter) {
      setter = Object.getOwnPropertyDescriptor(prototype, "needsUpdate")?.set;
      prototype = Object.getPrototypeOf(prototype);
    }
    let side = material.side, phase = 0, start = 0;
    tracked = { refs: 0, rendererBumps: 0 };
    const getSide = () => side;
    const setSide = next => {
      if (phase === 4 && next === THREE.DoubleSide && material.version === start + 2)
        tracked.rendererBumps += 2;
      if (phase === 2 && next === THREE.FrontSide && material.version === start + 1) phase = 3;
      else if (side === THREE.DoubleSide && next === THREE.BackSide) { phase = 1; start = material.version; }
      else phase = 0;
      side = next;
    };
    const setUpdate = value => {
      const before = material.version;
      setter.call(material, value);
      if (value === true && before === start && phase === 1 &&
          side === THREE.BackSide && material.version === before + 1) phase = 2;
      else if (value === true && before === start + 1 && phase === 3 &&
          side === THREE.FrontSide && material.version === before + 1) phase = 4;
      else phase = 0;
    };
    Object.defineProperty(material, "side", { configurable: true, enumerable: true, get: getSide, set: setSide });
    Object.defineProperty(material, "needsUpdate", { configurable: true, set: setUpdate });
    tracked.restore = () => {
      if (Object.getOwnPropertyDescriptor(material, "side")?.get === getSide)
        Object.defineProperty(material, "side", { ...sideDescriptor, value: side });
      if (Object.getOwnPropertyDescriptor(material, "needsUpdate")?.set === setUpdate) {
        if (updateDescriptor) Object.defineProperty(material, "needsUpdate", updateDescriptor);
        else delete material.needsUpdate;
      }
      versions.delete(material);
    };
    versions.set(material, tracked);
  }
  tracked.refs++;
  return () => { if (--tracked.refs === 0) tracked.restore(); };
}

const semanticVersion = material => material.version - (versions.get(material)?.rendererBumps ?? 0);

export function waterMaterialState(material) {
  return [semanticVersion(material), ...states.map(key => material[key])].concat(
    material.blendColor?.toArray() ?? [], material.color?.toArray() ?? [],
    material.emissive?.toArray() ?? [], material.customProgramCacheKey());
}

/** A rejected feature stays on a conventional, counted material path. */
export function waterMaterialUnsupported(mesh, material, reviewedHooks) {
  if (!material?.isMeshLambertMaterial || !material.transparent ||
      material.side !== THREE.DoubleSide || material.forceSinglePass ||
      material.depthWrite || !material.vertexColors) return "material-contract";
  if (mesh.castShadow || mesh.receiveShadow || mesh.customDepthMaterial || mesh.customDistanceMaterial)
    return "water-shadow-state";
  for (const name of ["flatShading", "wireframe", "alphaTest", "alphaHash", "alphaToCoverage",
    "stencilWrite", "polygonOffset", "normalMap", "bumpMap", "displacementMap", "envMap",
    "lightMap", "aoMap", "alphaMap", "specularMap", "emissiveMap"])
    if (material[name]) return name;
  if (material.clippingPlanes?.length) return "local-clipping";
  if (material.onBeforeRender !== THREE.Material.prototype.onBeforeRender) return "material-render-hook";
  if (material.onBeforeCompile !== THREE.Material.prototype.onBeforeCompile &&
      !reviewedHooks.has(material.onBeforeCompile)) return "unreviewed-shader-hook";
  return null;
}

/**
 * One owned clone; every atlas/light texture and live uniform is borrowed.
 * Instance 0 emits the complete original BACK stream, instance 1 the FRONT
 * stream. This is core WebGL2 instancing, not multi-draw or cross-source fusion.
 */
export function createWaterFusionMaterial(source, texture, width) {
  const material = source.clone(), compile = source.onBeforeCompile;
  const key = source.customProgramCacheKey.call(source), version = semanticVersion(source);
  material.forceSinglePass = true;
  material.onBeforeCompile = (shader, renderer) => {
    compile.call(source, shader, renderer);
    shader.uniforms.uWaterFusion = { value: texture };
    shader.vertexShader = `
uniform highp sampler2D uWaterFusion;
flat varying int vWaterFusionPhase;
vec3 waterPosition, waterNormal, waterColor;
vec2 waterUv;
#define position waterPosition
#define normal waterNormal
#define color waterColor
#define uv waterUv
#undef DOUBLE_SIDED
#undef FLIP_SIDED
vec4 waterVertexTexel(int address) {
  return texelFetch(uWaterFusion, ivec2(address % ${width}, address / ${width}), 0);
}
${shader.vertexShader}`.replace("void main() {", `void main() {
  vWaterFusionPhase = gl_InstanceID;
  vec4 a = waterVertexTexel(gl_VertexID * 3);
  vec4 b = waterVertexTexel(gl_VertexID * 3 + 1);
  vec4 c = waterVertexTexel(gl_VertexID * 3 + 2);
  waterPosition = a.xyz;
  waterNormal = vec3(a.w, b.xy);
  waterUv = b.zw;
  waterColor = c.xyz;`)
      .replace("#include <defaultnormal_vertex>", `#include <defaultnormal_vertex>
  if (vWaterFusionPhase == 0) transformedNormal = -transformedNormal;`);
    shader.fragmentShader = `
flat varying int vWaterFusionPhase;
#undef DOUBLE_SIDED
#undef FLIP_SIDED
${shader.fragmentShader}`
      .replace("#include <normal_fragment_begin>", THREE.ShaderChunk.normal_fragment_begin
        .replace("float faceDirection = gl_FrontFacing ? 1.0 : - 1.0;", "float faceDirection = 1.0;"))
      .replace("#include <dithering_fragment>", `#include <dithering_fragment>
  if ((vWaterFusionPhase == 0) == gl_FrontFacing) discard;`);
  };
  // Snapshot both values for THIS publication. A later explicit needsUpdate
  // produces a new key even while another source still retains the old program.
  material.customProgramCacheKey = () => `${key}:water-fusion-instance-1:${width}:${version}`;
  return material;
}
