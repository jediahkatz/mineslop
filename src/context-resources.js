function invalidateContextUpload(texture) {
  if (!texture.isDataArrayTexture) return;
  // A fresh Three backend can allocate empty array storage, then honor only
  // layerUpdates. Keep ALL layers dirty until the next real upload consumes
  // the set; partial streaming while lost must not narrow that first upload.
  for (let layer = 0; layer < texture.image.depth; layer++) texture.addLayerUpdate(layer);
  texture.needsUpdate = true;
}

/**
 * Three rebuilds its GL caches on restoration, but resource dispose listeners
 * can still close over the previous caches. Release those handles while the
 * context is lost (deletion is a no-op), not on a later chunk eviction.
 * CPU geometry, texture pixels, scene membership and world state stay intact.
 */
export function releaseLostContextResources(renderer, scene, extraResources = [], owners = []) {
  if (!renderer.getContext().isContextLost()) return;
  const resources = new Set();
  const texture = (value) => {
    if (value?.isTexture) collect(value);
    else if (Array.isArray(value)) value.forEach(texture);
  };
  const collect = (value) => {
    if (Array.isArray(value)) return value.forEach(collect);
    if (!value || resources.has(value)) return;
    if (value.isInstancedMesh) {
      resources.add(value);
      collect(value.geometry);
      collect(value.material);
      texture(value.morphTexture);
    } else if (value.isMaterial) {
      resources.add(value);
      for (const field of Object.values(value)) texture(field);
      for (const uniform of Object.values(value.uniforms ?? {})) texture(uniform.value);
    } else if (value.isTexture || value.isBufferGeometry || value.isRenderTarget) {
      resources.add(value);
    }
  };
  collect(extraResources);
  // Explicit owners enumerate their finite retained pools, not arbitrary
  // object graphs or a world scan. Shared scene/owner resources release once.
  for (const owner of owners) collect(owner.contextResources());
  texture(scene.background);
  texture(scene.environment);
  scene.traverse((object) => {
    collect(object.geometry);
    if (object.isInstancedMesh) collect(object);
    collect(object.shadow?.map);
    collect(object.shadow?.mapPass);
    collect(object.material);
  });
  for (const resource of resources) {
    if (resource.isInstancedMesh) {
      // The dispose method also deletes CPU morph data; only release GL state.
      resource.dispatchEvent({ type: "dispose" });
    } else resource.dispose();
    invalidateContextUpload(resource);
  }
}
