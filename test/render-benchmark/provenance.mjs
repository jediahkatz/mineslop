import { createHash } from "node:crypto";

export const digest = value => createHash("sha256").update(value).digest("hex");
export function sealManifest(manifest) {
  return { ...manifest, manifestHash: digest(JSON.stringify(manifest)) };
}
export function verifyManifest(manifest) {
  const { manifestHash, ...body } = manifest;
  if (!manifestHash || digest(JSON.stringify(body)) !== manifestHash)
    throw new Error("Frozen manifest hash mismatch");
  if (!body.sourceIdentity || !body.sourceRef || !body.patchHash || !Object.keys(body.assets ?? {}).length)
    throw new Error("Missing explicit frozen source/ref/patch provenance");
  return body;
}
export async function fetchVerifiedBundle(base, expected, fetcher = fetch) {
  verifyManifest(expected);
  const response = await fetcher(new URL("__benchmark_manifest.json", base));
  if (!response.ok) throw new Error("Frozen static manifest unavailable; Vite/live URLs are not benchmark sources");
  const served = await response.json();
  verifyManifest(served);
  if (served.manifestHash !== expected.manifestHash)
    throw new Error("Served snapshot differs from local frozen manifest");
  const assets = new Map();
  for (const [name, sha] of Object.entries(served.assets)) {
    const resource = await fetcher(new URL(name, base));
    if (!resource.ok) throw new Error(`Missing frozen asset: ${name}`);
    const bytes = Buffer.from(await resource.arrayBuffer());
    if (digest(bytes) !== sha) throw new Error(`Fetched asset hash mismatch: ${name}`);
    assets.set(new URL(name, base).pathname, bytes);
  }
  return { manifest: served, assets };
}

export function fixedSourceGroups(before, after) {
  for (const [label, rows] of [["baseline", before], ["candidate", after]]) {
    const identities = rows.map(r => r.provenance?.sourceIdentity);
    if (!identities.length || identities.some(id => !id) || new Set(identities).size !== 1)
      return { passed: false, reason: `${label}: mixed or missing source identities` };
    const bundles = rows.map(r => r.provenance?.manifestHash);
    if (bundles.some(id => !id) || new Set(bundles).size !== 1)
      return { passed: false, reason: `${label}: mixed or missing frozen bundles` };
  }
  return { passed: true };
}
