import * as THREE from "three";

const installed = new WeakMap();

/** Install on a palette-only material, never on a material shared with ordinary
 * RGB attributes. Chains the existing compile/cache hooks and leaves fragment,
 * instance/batching color, alpha-test, displacement and shadow state intact.
 */
export function installGeometryPalette(material, palette) {
  if (installed.get(material)?.palette === palette) return material;
  const old = installed.get(material);
  const previous = old?.previous ?? material.onBeforeCompile;
  const previousSource = previous.toString();
  const cacheKey = old?.cacheKey ?? (material.customProgramCacheKey === THREE.Material.prototype.customProgramCacheKey
    ? () => previousSource : material.customProgramCacheKey.bind(material));
  const uniform = old?.uniform ?? { value: palette.texture };
  uniform.value = palette.texture;
  installed.set(material, { palette, previous, cacheKey, uniform });
  material.onBeforeCompile = function(shader, renderer) {
    previous.call(this, shader, renderer);
    const width = palette.texture.image.width;
    shader.uniforms.uRegionalColors = uniform;
    const colorChunk = THREE.ShaderChunk.color_vertex.replace(
      "vColor.rgb *= color;", "vColor.rgb *= regionalColor(color.r);");
    shader.vertexShader = `uniform highp sampler2D uRegionalColors;
vec3 regionalColor(float encoded) {
  int slot = int(encoded + 0.5);
  return texelFetch(uRegionalColors, ivec2(slot % ${width}, slot / ${width}), 0).rgb;
}
${shader.vertexShader.replace("#include <color_vertex>", colorChunk)}`;
    if (!shader.vertexShader.includes("vColor.rgb *= regionalColor(color.r);"))
      throw new Error("Regional palette requires Three's color_vertex include");
  };
  material.customProgramCacheKey = () => `${cacheKey()}:regional-exact-rgb-v1:${palette.texture.image.width}`;
  material.needsUpdate = true;
  return material;
}

export function regionalPaletteMaterials(renderer) {
  if (renderer.regionalMaterials) return renderer.regionalMaterials;
  const materials = { ...renderer.materials };
  for (const [name, original] of Object.entries(materials)) {
    if (name === "water" || name === "glass") continue;
    const clone = original.clone();
    // Material.clone intentionally omits these callbacks. Delegate with the
    // original receiver so existing lighting/ripple closures retain ownership.
    clone.onBeforeCompile = (shader, gl) => original.onBeforeCompile.call(original, shader, gl);
    clone.customProgramCacheKey = () => original.customProgramCacheKey.call(original);
    materials[name] = installGeometryPalette(clone, renderer.geometryPalette);
  }
  return renderer.regionalMaterials = materials;
}

export function disposeRegionalPaletteMaterials(renderer) {
  for (const [name, material] of Object.entries(renderer.regionalMaterials ?? {}))
    if (material !== renderer.materials[name]) material.dispose();
  renderer.regionalMaterials = null;
}

/** Parent hook for lighting/material changes made AFTER pages were built.
 * Refresh all palette-only clones together; originals/transparency are untouched.
 * Page revision invalidates private plans that captured the previous materials.
 */
export function refreshRegionalPaletteMaterials(renderer) {
  if (!renderer.geometryPalette) return;
  const old = renderer.regionalMaterials;
  renderer.regionalMaterials = null;
  const next = regionalPaletteMaterials(renderer);
  for (const region of renderer.sectionRegions?.values() ?? []) {
    for (const page of region.userData.pageDescriptors) {
      page.mesh.material = next[page.sources[0].userData.batch];
      for (const source of page.sources) source.material = next[source.userData.batch];
    }
    region.userData.pageRevision++;
  }
  for (const [name, material] of Object.entries(old ?? {}))
    if (material !== renderer.materials[name]) material.dispose();
}
