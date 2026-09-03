import { createHash } from "node:crypto";

const digest = (value) =>
  createHash("sha256").update(value).digest("hex");

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonical(value[key])])
    );
  return value;
}

export const goldenDataDigest = (value) =>
  digest(JSON.stringify(canonical(value)));

/**
 * Hash effective full-height cell state/fluid planes, not just sparse sections.
 * The caller supplies its own source tree's default-fluid implementation, so
 * capturing a deployed fixture never depends on the development block table.
 * Explicit LE encoding makes the constants independent of native byte order.
 */
export function goldenChunkDigest(chunk, defaultFluidFor) {
  const minY = chunk.minY ?? 0;
  const states = new Uint16Array(chunk.blocks.length);
  const fluids = Uint8Array.from(chunk.blocks, defaultFluidFor);
  for (const section of chunk.sections ?? []) {
    const start = (section.sy * 16 - minY) * 256;
    if (section.states) states.set(section.states, start);
    if (section.fluids) fluids.set(section.fluids, start);
  }
  const u16 = (values) => {
    const buffer = Buffer.alloc(values.length * 2);
    for (let i = 0; i < values.length; i++)
      buffer.writeUInt16LE(values[i], i * 2);
    return digest(buffer);
  };
  const parts = {
    blocks: u16(chunk.blocks),
    biomes: digest(chunk.biomes),
    states: u16(states),
    fluids: digest(fluids),
    structures: goldenDataDigest(chunk.structures ?? []),
    envelope: goldenDataDigest({
      cx: chunk.cx, cz: chunk.cz, minY: chunk.minY, maxY: chunk.maxY,
      encoding: chunk.encoding,
      // Also freeze the sparse representation, including empty/absent planes.
      sections: (chunk.sections ?? []).map(({ sy, states, fluids }) => ({
        sy, states: states ? u16(states) : null,
        fluids: fluids ? digest(fluids) : null,
      })),
    }),
  };
  return { ...parts, all: goldenDataDigest(parts) };
}
