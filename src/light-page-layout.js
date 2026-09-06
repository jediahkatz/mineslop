// Lighting's capacity contract is independent of quality presets.
export const LIGHT_MAX_RADIUS = 12;
export const LIGHT_MAX_SECTIONS = 24;
export const LIGHT_UPLOAD_BYTES = 128 * 1024;
export const LIGHT_UPLOAD_COPIES = 16;
// Constant handles cost no page bytes, but their CPU publication still needs
// a shared bound. This is additional backpressure, not a higher upload quota.
export const LIGHT_UPLOAD_PUBLICATIONS = 256;
export const LIGHT_PHYSICAL_HANDLE = 258;
export const BLOCK_PAGE_LAYOUT = Object.freeze({ width: 80, height: 80, across: 8, down: 8, layers: 64, banks: 4 });
// R8 first: preserves all seventeen values, including direct sky in aprons.
// Packing nibbles requires a separately verified ceiling reconstruction.
export const SURFACE_PAGE_LAYOUT = Object.freeze({ width: 72, height: 72, across: 8, down: 4, layers: 256, banks: 2 });

export function lightLayout(radius) {
  if (!Number.isInteger(radius) || radius < 0 || radius > LIGHT_MAX_RADIUS)
    throw new RangeError(`Lighting radius must be in 0..${LIGHT_MAX_RADIUS}`);
  const tiles = 2 * radius + 1;
  return { radius, tiles, chunks: tiles ** 2, sourceChunks: (tiles + 2) ** 2, spareChunks: (tiles + 4) ** 2 };
}

export function lightUploadBudget() {
  return { bytes: LIGHT_UPLOAD_BYTES, copies: LIGHT_UPLOAD_COPIES, publications: LIGHT_UPLOAD_PUBLICATIONS,
    uploadedBytes: 0, pageCopies: 0, mappingBytes: 0 };
}

/** Dimensional compatibility only. Bank allocation still checks real GL errors;
 * these limits make no claim about available device memory.
 */
export function validateLightCapabilities(gl, height, radius) {
  lightLayout(radius);
  if (!Number.isInteger(height) || height < 16 || height > 384 || height % 16)
    throw new RangeError("Unsupported lighting height");
  if (!gl || gl.isContextLost()) throw new Error("Lighting requires a live WebGL2 context");
  const size = gl.getParameter(gl.MAX_TEXTURE_SIZE), layers = gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS);
  const samplers = gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS);
  if (!Number.isFinite(size) || !Number.isFinite(layers) || !Number.isFinite(samplers) ||
    size < 2048 || layers < 256 || samplers < 16)
    throw new RangeError("Lighting requires WebGL2 limits of 2048 texels, 256 array layers and 16 fragment samplers");
  return radius;
}
