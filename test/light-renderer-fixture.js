import { lightUploadBudget } from "../src/light-page-layout.js";

export function lightRenderer() {
  const calls = [];
  return { calls, initTexture() {},
    getContext: () => ({ isContextLost: () => false, NO_ERROR: 0, getError: () => 0, MAX_TEXTURE_SIZE: 1,
      MAX_ARRAY_TEXTURE_LAYERS: 2, getParameter: (p) => p === 1 ? 2048 : 256 }),
    copyTextureToTexture(source, target) {
      calls.push({ bytes: source.image.data.byteLength, array: !!target.isDataArrayTexture });
    },
  };
}

export function flushColumns(columns, renderer = lightRenderer()) {
  const budget = lightUploadBudget();
  columns.surfaceLight.store.flushInvalidations(renderer, budget);
  columns.flush(renderer, budget);
  columns.surfaceLight.store.flush(renderer, budget);
  return budget;
}

export function settleColumns(columns, world, position, radius = 4) {
  const renderer = lightRenderer();
  for (let frames = 1; frames <= 4096; frames++) {
    columns.begin(world);
    columns.updateField(position, radius);
    flushColumns(columns, renderer);
    if (!columns.requests.size && !columns.surfaceLight.pending &&
      !columns.surfaceLight.store.queue.size && !columns.skyUploads.size) return frames;
  }
  throw new Error("Resumable lighting did not settle within fixture work bound");
}

export function settleRendererLighting(graphics, feet) {
  for (let frames = 1; frames <= 4096; frames++) {
    graphics.update(0, frames, feet);
    flushRendererLighting(graphics);
    const columns = graphics.skyColumns;
    if (!columns.requests.size && !columns.surfaceLight.pending &&
      !columns.surfaceLight.store.queue.size && !columns.skyUploads.size) return frames;
  }
  throw new Error("Renderer lighting did not settle within fixture work bound");
}

// Real WebGL fixtures exercise the production once-per-update flush latch.
// CPU-only render stubs cannot draw; acknowledge the latch only after a
// successful explicit flush, never grant another budget for the same update.
export function flushRendererLighting(graphics) {
  if (typeof graphics.renderer.render === "function") return graphics.render();
  if (graphics.lightingNeedsFlush === false) return;
  const result = graphics.daylightMaterial.flush(graphics.renderer);
  if (result) graphics.lightingNeedsFlush = false;
  return result;
}

export function lightingFullyReady(graphics) {
  const c = graphics.skyColumns, b = graphics.blockLight;
  return !c.requests.size && !c.surfaceLight.pending && !c.skyUploads.size &&
    !c.surfaceLight.store.queue.size && !b.pending && !b.job && !b.store.queue.size &&
    graphics.daylightMaterial.resources().pendingRequired === 0;
}

// Sparse authored GPU controls qualify their measured receivers, not the
// entire visible field. Each selected handle must be certified by production
// (including its loaded source/shape halo); missing input cannot pass.
export function daylightTargetsReady(columns, points) {
  const light = columns.surfaceLight;
  if (light.store.mappingDirty) return false;
  return points.every((point) => {
    const x = Math.floor(point.x / 16), z = Math.floor(point.z / 16);
    const y = Math.floor(point.y) - columns.spec.minY;
    if (Math.abs(x - columns.cx) > columns.layout.radius ||
      Math.abs(z - columns.cz) > columns.layout.radius || y < 0 || y >= light.height) return false;
    const slot = columns.skySlot(x, z);
    return columns.skyOwners[slot] === `${x},${z}` && columns.skyUploaded[slot] !== null &&
      light.store.mapping[light.index(x, z, Math.floor(y / 16))] !== 0;
  });
}

// Include addressing, constant values and every canonical page, not just
// allocated arrays (constant pages deliberately have no allocated byte buffer).
export function lightingSnapshotArrays(graphics) {
  const c = graphics.skyColumns, b = graphics.blockLight;
  const arrays = [c.data, b.paletteTexture.image.data];
  const text = new TextEncoder();
  for (const store of [b.store, c.surfaceLight.store]) {
    arrays.push(store.mapping);
    for (const [index, page] of [...store.pages].sort(([a], [b]) => a - b)) {
      arrays.push(new Uint32Array([index, page.constant ?? 256, page.values?.length ?? 0]));
      if (page.values) arrays.push(page.values);
    }
  }
  for (const [key, entry] of [...b.cache].sort(([a], [b]) => a.localeCompare(b))) {
    arrays.push(text.encode(key), entry.values ?? Uint8Array.of(0));
  }
  for (const [key, entry] of [...c.surfaceLight.cache].sort(([a], [b]) => a.localeCompare(b))) {
    arrays.push(text.encode(key));
    for (const page of entry.pages) arrays.push(typeof page === "number" ? Uint8Array.of(page) : page);
  }
  return arrays;
}
