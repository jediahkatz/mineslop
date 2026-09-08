// Read-only allocation census, exclusively for correctness captures.
// Backing ArrayBuffers are identity-deduplicated, not summed by view/range.
const external = new Set(["parent", "world", "_world", "generator", "_generator", "renderer",
  "scene", "camera", "material", "materials", "_terrainMaterial", "_waterMaterial",
  "identity", "request", "atlas", "_atlas"]);
const bytes = set => [...set].reduce((n, buffer) => n + buffer.byteLength, 0);
const gpuBytes = allocations => [...allocations.values()].reduce((n, size) => n + size, 0);
const numericBytes = set => [...set].reduce((n, array) => n + array.length * 8, 0);
const minus = (a, b) => new Set([...a].filter(value => !b.has(value)));
const union = (...sets) => new Set(sets.flatMap(set => [...set]));

const validBytes = value => Number.isFinite(value) && value >= 0;

function reconcileCounter(ledger, field, distantFields, nativeBacking, additionalBacking, peak) {
  const total = validBytes(ledger[field]) ? ledger[field] : 0;
  const components = distantFields.map(key => ledger.distant?.[key]);
  // The returned breakdown is the inclusion capability. A resources() method
  // alone does not establish that an older caller added its values to totals.
  const included = validBytes(ledger[field]) && components.every(validBytes)
    ? components.reduce((sum, value) => sum + value, 0) : null;
  const credit = included !== null && Number.isFinite(included) && included <= total ? included : null;
  const native = Math.max(nativeBacking, total - (credit ?? 0));
  const current = native + additionalBacking;
  // With an inclusion breakdown, production admission peaks are combined
  // totals (including replacement reservations). Preserve those peaks intact:
  // never subtract TODAY's distant usage from a HISTORICAL peak. Only add
  // independently observed backing not represented by the production counter.
  // Native-only/ambiguous ledgers still need the entire distant overlap added.
  const peakSupplement = credit === null ? additionalBacking : Math.max(0, additionalBacking - credit);
  return {
    bytes: Math.max(total, current, (validBytes(peak) ? peak : 0) + peakSupplement),
    nativeCurrentBytes: native,
    includedDistantBytes: credit,
    peakSupplementBytes: peakSupplement,
    peakScope: credit === null ? "native-only-or-ambiguous" : "combined-ledger",
  };
}

export function backingSets(roots) {
  const buffers = new Set(), gpu = new Map(), numericArrays = new Set(), seen = new Set(), meshes = new Set();
  const attribute = a => {
    const array = a?.array ?? a?.data?.array;
    // WebGL caches uploads by BufferAttribute/InterleavedBuffer identity, not
    // ArrayBuffer: two separate attributes borrowing one CPU buffer upload twice.
    if (ArrayBuffer.isView(array)) gpu.set(a.isInterleavedBufferAttribute ? a.data : a, array.byteLength);
  };
  function visit(value) {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (ArrayBuffer.isView(value)) { buffers.add(value.buffer); return; }
    if (value instanceof ArrayBuffer) { buffers.add(value); return; }
    if (value.isTexture) {
      const array = value.image?.data;
      if (ArrayBuffer.isView(array)) {
        buffers.add(array.buffer);
        gpu.set(value, array.byteLength);
      }
      return;
    }
    if (value.isMaterial) return; // shared atlas/material uniforms are not owned LOD allocations
    if (value.isMesh) {
      if (!value.userData?.sectionSource && value.geometry) {
        meshes.add(value);
        for (const a of Object.values(value.geometry.attributes ?? {})) attribute(a);
        attribute(value.geometry.index);
        attribute(value.instanceMatrix); attribute(value.instanceColor);
      }
      visit(value.geometry);
      visit(value.instanceMatrix); visit(value.instanceColor);
      for (const child of value.children ?? []) visit(child);
      return;
    }
    if (value.isObject3D) {
      for (const child of value.children ?? []) visit(child);
      // Section/page metadata owns CPU-only source and staging allocations.
      visit(value.userData);
      return;
    }
    if (value instanceof Map) { for (const item of value.values()) visit(item); return; }
    if (value instanceof Set) { for (const item of value) visit(item); return; }
    if (Array.isArray(value)) {
      if (value.length && typeof value[0] === "number") numericArrays.add(value);
      else for (const item of value) visit(item);
      return;
    }
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (external.has(key) || !("value" in descriptor)) continue;
      visit(descriptor.value);
    }
  }
  for (const root of roots) visit(root);
  return { buffers, gpu, numericArrays, meshes };
}

export function combinedBackingResources(renderer, nativeLedger) {
  const native = backingSets([
    renderer.chunks, renderer.sectionRegions, renderer.sectionJobs, renderer.sectionCompaction,
    renderer.geometryPalette, renderer.sectionWater, renderer.distant?.detailMask,
  ]);
  const distant = renderer.distant ?? {};
  const live = backingSets([distant._active, distant._vegetation, distant._landmarks,
    distant._samples, distant._treeSamples, distant._seams]);
  const pending = backingSets([distant._job, distant._vegetationJob]);
  const additional = minus(union(live.buffers, pending.buffers), native.buffers);
  const additionalGpu = new Map([...live.gpu, ...pending.gpu].filter(([key]) => !native.gpu.has(key)));
  const pendingOnly = minus(pending.buffers, union(native.buffers, live.buffers));
  const numberArrays = minus(union(live.numericArrays, pending.numericArrays), native.numericArrays);
  const pendingNumbers = minus(pending.numericArrays, union(native.numericArrays, live.numericArrays));
  const cpu = reconcileCounter(nativeLedger, "combinedCpuBytes", ["cpuBytes", "stagingBytes"],
    bytes(native.buffers), bytes(additional) + numericBytes(numberArrays), renderer.meshStats?.peakCombinedCpuBytes);
  const gpu = reconcileCounter(nativeLedger, "gpuBytes", ["gpuBytes"],
    gpuBytes(native.gpu), gpuBytes(additionalGpu), renderer.meshStats?.peakReservedGpuBytes);
  const staging = reconcileCounter(nativeLedger, "stagingBytes", ["stagingBytes"],
    0, bytes(pendingOnly) + numericBytes(pendingNumbers), renderer.meshStats?.peakStagingBytes);
  const distantDraws = [...union(live.meshes, pending.meshes)].reduce((n, mesh) =>
    n + (Array.isArray(mesh.material) ? mesh.geometry.groups.length : 1), 0);
  return {
    includesDistantBacking: true,
    independentBackingBytes: bytes(union(native.buffers, live.buffers, pending.buffers)),
    gpuBytes: gpu.bytes,
    combinedCpuBytes: cpu.bytes,
    stagingBytes: staging.bytes,
    drawCalls: (nativeLedger.drawCalls ?? 0) + distantDraws,
    nativeLedger: { gpuBytes: nativeLedger.gpuBytes, combinedCpuBytes: nativeLedger.combinedCpuBytes,
      stagingBytes: nativeLedger.stagingBytes, drawCalls: nativeLedger.drawCalls },
    ledgerReconciliation: { cpu, gpu, staging },
    distant: { liveBackingBytes: bytes(live.buffers), pendingBackingBytes: bytes(pending.buffers),
      additionalUniqueBackingBytes: bytes(additional), additionalGpuBackingBytes: gpuBytes(additionalGpu),
      numericArrayPayloadBytes: numericBytes(numberArrays) },
    scope: "Explicit ledger.distant breakdown reconciled with independent backing; combined admission peaks retained plus unaccounted backing, native-only peaks plus full distant overlap. CPU deduplicates by ArrayBuffer; GPU by attribute/interleaved-buffer/texture identity. JS numeric payload charged at 8 bytes/element. Boundary-sampled owned backing, not engine heap capacity/object headers or driver VRAM.",
  };
}
