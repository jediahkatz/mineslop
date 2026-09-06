// Read one error at each boundary, never drain the context's global error
// queue. A pre-existing error is reported, not silently attributed to this
// upload or discarded to make a later transfer look successful.
export function checkedLightTransfer(renderer, label, transfer) {
  const gl = renderer.getContext();
  if (gl.isContextLost()) throw new Error(`Lighting ${label}: context lost`);
  const prior = gl.getError();
  if (prior !== gl.NO_ERROR) throw new Error(`Lighting ${label}: pre-existing WebGL error ${prior}`);
  transfer();
  if (gl.isContextLost()) throw new Error(`Lighting ${label}: context lost during transfer`);
  const error = gl.getError();
  if (error !== gl.NO_ERROR) throw new Error(`Lighting ${label} failed (WebGL ${error})`);
}
