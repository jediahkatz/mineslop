// Detail distance is independent of quality effects. Six is experimental;
// quality presets remain 2/3/4 until native readiness and GPU acceptance.
export const MAX_RENDER_RADIUS = 6;

export function renderDistanceLayout(radius) {
  if (!Number.isInteger(radius) || radius < 0 || radius > MAX_RENDER_RADIUS)
    throw new RangeError(`Expected render radius 0–${MAX_RENDER_RADIUS}`);
  return Object.freeze({
    radius,
    tiles: radius * 2 + 1,
    visibleChunks: (radius * 2 + 1) ** 2,
    sourceChunks: (radius * 2 + 3) ** 2,
    spareChunks: (radius * 2 + 5) ** 2,
  });
}

export function validateRenderDistanceOverride(radius, gl, height) {
  if (radius === null) return null;
  const layout = renderDistanceLayout(radius);
  if (radius < 2) throw new RangeError("Expected render distance override 2–6 or null");
  if (!gl || gl.isContextLost())
    throw new Error("Render distance requires a live WebGL2 context");
  const layers = gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS);
  const size = gl.getParameter(gl.MAX_TEXTURE_SIZE);
  if (!Number.isFinite(layers) || !Number.isFinite(size) ||
      layers < layout.visibleChunks || size < Math.max(layout.tiles * 16, height * 5))
    throw new RangeError("Render distance exceeds GPU texture limits");
  return radius;
}
