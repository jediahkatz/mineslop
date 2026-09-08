// Read existing cache state without invoking its accessor or refreshing it.
export function ownershipWitness(renderer, mask, sectionKey, freshBits, maskBits) {
  const cache = renderer.detailBatchCache;
  const revision = cache?.key?.split(":")[0];
  return {
    kind: "ownership-mask-mismatch", sectionKey, freshBits, maskBits,
    cachedBits: cache?.value?.get ? cache.value.get(sectionKey) ?? 0 : null,
    meshResourceRevision: renderer.meshResourceRevision ?? null,
    cacheKey: cache?.key ?? null,
    cacheRevision: revision !== undefined && Number.isFinite(Number(revision)) ? Number(revision) : null,
    maskRevision: mask.version ?? null,
    maskTextureVersion: mask.texture?.value?.version ?? null,
    interpretation: "Ownership/cache evidence; not a visible-hole classification.",
  };
}
