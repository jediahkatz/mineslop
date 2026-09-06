import { waterPullGLTrace } from "./water-pull-gl-trace.js";

/** CPU reads/copies cannot pay for GPU initialization or transfers. */
export function assertWaterGPUWork(work, operations) {
  const allocationDebit = work.filter(w => /^gpu-.*-zero-allocation$/.test(w.kind)).reduce((n, w) => n + w.bytes, 0);
  const uploadDebit = work.filter(w => /^gpu-.*-upload$/.test(w.kind)).reduce((n, w) => n + w.bytes, 0);
  let allocationWork = 0, uploadWork = 0;
  for (const operation of operations) {
    if (operation.method === "bufferData" || operation.method === "texStorage2D") {
      allocationWork += operation.bytes;
      uploadWork += operation.workBytes - operation.bytes;
    } else if (operation.method === "bufferSubData" || operation.method === "texSubImage2D") {
      uploadWork += operation.workBytes;
    } else throw new Error(`Unclassified water GPU work: ${operation.method}`);
  }
  if (allocationWork > allocationDebit || uploadWork > uploadDebit)
    throw new Error(`GPU-specific debit exceeded: ${JSON.stringify({ allocationWork, allocationDebit, uploadWork, uploadDebit })}`);
  return { allocationWork, allocationDebit, uploadWork, uploadDebit };
}

/** Independent actual-GL census, including numeric zero allocations. */
export function waterFusionGLTrace(renderer) {
  const trace = waterPullGLTrace(renderer), gl = renderer.getContext();
  const buffers = new Map(), textures = new Map(), bound = new Map(), operations = [];
  const state = { scope: "outside", failNextRows: false };
  let active = gl.TEXTURE0;
  const textureBindings = new Map();
  const wrap = (name, callback) => {
    const original = gl[name].bind(gl);
    gl[name] = (...args) => callback(original, args);
  };
  wrap("bindBuffer", (call, a) => { bound.set(a[0], a[1]); return call(...a); });
  wrap("bufferData", (call, a) => {
    const bytes = typeof a[1] === "number" ? a[1] : a[1].byteLength;
    const handle = bound.get(a[0]);
    buffers.set(handle, bytes);
    operations.push({ scope: state.scope, method: "bufferData", handle, bytes,
      workBytes: bytes * (typeof a[1] === "number" ? 1 : 2) });
    return call(...a);
  });
  wrap("bufferSubData", (call, a) => {
    operations.push({ scope: state.scope, method: "bufferSubData", handle: bound.get(a[0]),
      bytes: a[2].byteLength, workBytes: a[2].byteLength });
    return call(...a);
  });
  wrap("deleteBuffer", (call, a) => { buffers.delete(a[0]); return call(...a); });
  wrap("activeTexture", (call, a) => { active = a[0]; return call(...a); });
  wrap("bindTexture", (call, a) => { textureBindings.set(`${active}/${a[0]}`, a[1]); return call(...a); });
  wrap("texStorage2D", (call, a) => {
    const handle = textureBindings.get(`${active}/${a[0]}`);
    const bytes = a[3] * a[4] * (a[2] === gl.RGBA32F ? 16 : 4);
    textures.set(handle, { bytes, levels: a[1], format: a[2], width: a[3], height: a[4] });
    operations.push({ scope: state.scope, method: "texStorage2D", handle, bytes, workBytes: bytes });
    return call(...a);
  });
  wrap("texSubImage2D", (call, a) => {
    const data = a.find(ArrayBuffer.isView), bytes = data?.byteLength ?? 0;
    operations.push({ scope: state.scope, method: "texSubImage2D",
      handle: textureBindings.get(`${active}/${a[0]}`), bytes, workBytes: bytes });
    if (state.failNextRows && state.scope === "water-step") {
      state.failNextRows = false;
      // Actual GL failure, consumed/reported by the production checked boundary.
      return call(gl.TEXTURE_3D, ...a.slice(1));
    }
    return call(...a);
  });
  wrap("deleteTexture", (call, a) => { textures.delete(a[0]); return call(...a); });
  return { ...trace, buffers, textures, operations, state };
}
