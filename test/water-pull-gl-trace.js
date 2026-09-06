// Actual calls/allocations for this renderer only. Payload accounting excludes
// driver-private memory, programs, render targets and JS wrapper heap.
export function waterPullGLTrace(renderer) {
  const gl = renderer.getContext(), draws = [], uploads = [], arrays = new Map();
  const buffers = new Map(), textures = new Map(), programInfo = new Map(), programDescriptions = [];
  const boundBuffers = new Map(), boundTextures = new Map();
  let current, activeTexture = gl.TEXTURE0, epoch = 0;
  const wrap = (name, callback) => {
    const original = gl[name].bind(gl);
    gl[name] = (...args) => callback(original, args);
  };
  const direct = renderer.renderBufferDirect.bind(renderer);
  renderer.renderBufferDirect = (...args) => {
    current = { mesh: args[4], geometry: args[2], material: args[3] };
    try { return direct(...args); } finally { current = null; }
  };
  const programs = () => {
    const program = gl.getParameter(gl.CURRENT_PROGRAM);
    if (!programInfo.has(program)) {
      const attributes = [], samplers = [];
      for (let i = 0; i < gl.getProgramParameter(program, gl.ACTIVE_ATTRIBUTES); i++) {
        const name = gl.getActiveAttrib(program, i).name;
        attributes.push({ name, location: gl.getAttribLocation(program, name) });
      }
      for (let i = 0; i < gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS); i++) {
        const u = gl.getActiveUniform(program, i);
        if ([gl.SAMPLER_2D, gl.SAMPLER_2D_ARRAY, gl.UNSIGNED_INT_SAMPLER_2D,
          gl.SAMPLER_2D_SHADOW, gl.SAMPLER_CUBE].includes(u.type))
          samplers.push({ name: u.name, unit: gl.getUniform(program, gl.getUniformLocation(program, u.name)) });
      }
      programInfo.set(program, programDescriptions.length);
      programDescriptions.push({ attributes, samplers });
    }
    return programInfo.get(program);
  };
  for (const name of ["drawElements", "drawArrays", "drawElementsInstanced", "drawArraysInstanced"])
    wrap(name, (original, args) => {
      draws.push({ method: name, id: current?.mesh.id, side: current?.material.side,
        count: args[name.includes("Elements") ? 1 : 2],
        indexType: name.includes("Elements") ? args[2] : null,
        fused: current?.geometry.userData.waterPull === true, program: programs() });
      return original(...args);
    });
  wrap("bindBuffer", (original, args) => { boundBuffers.set(args[0], args[1]); return original(...args); });
  wrap("bufferData", (original, args) => {
    const data = args[1], kind = arrays.get(data?.buffer);
    const size = typeof data === "number" ? data : data?.byteLength ?? 0;
    buffers.set(boundBuffers.get(args[0]), { size, kind });
    if (kind) uploads.push({ epoch, method: "bufferData", kind, bytes: size });
    return original(...args);
  });
  wrap("deleteBuffer", (original, args) => { buffers.delete(args[0]); return original(...args); });
  wrap("activeTexture", (original, args) => { activeTexture = args[0]; return original(...args); });
  wrap("bindTexture", (original, args) => {
    boundTextures.set(`${activeTexture}/${args[0]}`, args[1]);
    return original(...args);
  });
  wrap("texStorage2D", (original, args) => {
    textures.set(boundTextures.get(`${activeTexture}/${args[0]}`),
      { levels: args[1], format: args[2], width: args[3], height: args[4] });
    return original(...args);
  });
  wrap("texSubImage2D", (original, args) => {
    const data = args.find(ArrayBuffer.isView), kind = arrays.get(data?.buffer);
    if (kind) uploads.push({ epoch, method: "texSubImage2D", kind, bytes: data.byteLength });
    return original(...args);
  });
  wrap("deleteTexture", (original, args) => { textures.delete(args[0]); return original(...args); });
  return {
    draws, uploads, programDescriptions,
    register(prototype, label) {
      arrays.set(prototype.data.buffer, `${label}:texture`);
      arrays.set(prototype.indices.buffer, `${label}:index`);
      for (const b of prototype.sourceBuffers) arrays.set(b, `${label}:reference`);
    },
    allocation(prototype, label) {
      const t = textures.get(renderer.properties.get(prototype.texture).__webglTexture);
      const indexBytes = [...buffers.values()].filter(b => b.kind === `${label}:index`).reduce((n, b) => n + b.size, 0);
      const referenceBytes = [...buffers.values()].filter(b => b.kind === `${label}:reference`).reduce((n, b) => n + b.size, 0);
      return { epoch, texture: t ?? null, textureBytes: t ? t.width * t.height * 16 : 0,
        indexBytes, referenceBytes, uploads: uploads.filter(u => u.kind.startsWith(`${label}:`)) };
    },
    resetEpoch() {
      epoch++;
      buffers.clear(); textures.clear(); boundBuffers.clear(); boundTextures.clear(); programInfo.clear();
    },
  };
}
