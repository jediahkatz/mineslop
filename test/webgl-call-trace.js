// TEST ONLY. Install before Game creates a context. Consumes GL errors after
// each operation; assertions must inspect this ledger, not just gl.getError().
// No production behavior, texture values, shader sources or render state change.
export function installWebGLCallTrace() {
  const prototype = WebGL2RenderingContext.prototype;
  const original = Object.fromEntries(
    Object.getOwnPropertyNames(prototype)
      .filter((name) => typeof Object.getOwnPropertyDescriptor(prototype, name).value === "function")
      .map((name) => [name, prototype[name]])
  );
  const ids = new WeakMap(), contexts = new WeakMap(), textures = new WeakMap();
  const sampledPrograms = new WeakSet(), owners = new WeakMap();
  const reports = [];
  let serial = 0;
  const id = (value) => {
    if (value === null || typeof value !== "object") return value;
    if (!ids.has(value)) ids.set(value, ++serial);
    return ids.get(value);
  };
  const canvasEvents = [], canvasEventCounts = {}, seenCanvases = new WeakSet();
  const getContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (...args) {
    const result = getContext.apply(this, args);
    if (result && !seenCanvases.has(this)) {
      seenCanvases.add(this);
      for (const event of args[0] === "2d" ? ["contextlost", "contextrestored"] : ["webglcontextlost", "webglcontextrestored"])
        this.addEventListener(event, () => {
          const key = `${event}:${this.width}x${this.height}`;
          canvasEventCounts[key] = (canvasEventCounts[key] ?? 0) + 1;
          if (event === "webglcontextrestored" && contexts.has(result)) contexts.get(result).epoch++;
          if (canvasEvents.length < 32 && (args[0] !== "2d" || this.width > 64 || this.height > 64))
            canvasEvents.push({ event, id: id(this), width: this.width, height: this.height, at: performance.now() });
        });
    }
    return result;
  };
  const summarize = (value) => {
    if (ArrayBuffer.isView(value))
      return { type: value.constructor.name, length: value.length, bytes: value.byteLength };
    if (value && typeof value === "object")
      return { type: value.constructor.name, id: id(value) };
    return typeof value === "string" ? { stringLength: value.length } : value;
  };
  const call = (gl, name, ...args) => original[name].call(gl, ...args);
  const binding = (gl, target) => call(gl, "getParameter", {
    [gl.TEXTURE_2D]: gl.TEXTURE_BINDING_2D,
    [gl.TEXTURE_2D_ARRAY]: gl.TEXTURE_BINDING_2D_ARRAY,
    [gl.TEXTURE_3D]: gl.TEXTURE_BINDING_3D,
    [gl.TEXTURE_CUBE_MAP]: gl.TEXTURE_BINDING_CUBE_MAP,
  }[target]);
  const describe = (gl, target) => {
    const texture = binding(gl, target);
    return {
      id: id(texture), target, allocation: textures.get(texture) ?? null,
      ...(texture ? Object.fromEntries([
        ["minFilter", gl.TEXTURE_MIN_FILTER], ["magFilter", gl.TEXTURE_MAG_FILTER],
        ["baseLevel", gl.TEXTURE_BASE_LEVEL], ["maxLevel", gl.TEXTURE_MAX_LEVEL],
        ["immutable", gl.TEXTURE_IMMUTABLE_FORMAT],
      ].map(([name, parameter]) => [name, call(gl, "getTexParameter", target, parameter)])) : {}),
    };
  };
  const samplerState = (gl) => {
    const program = call(gl, "getParameter", gl.CURRENT_PROGRAM);
    if (!program) return { program: null, samplers: [] };
    const active = call(gl, "getParameter", gl.ACTIVE_TEXTURE);
    const samplers = [];
    const targets = {
      [gl.SAMPLER_2D]: gl.TEXTURE_2D, [gl.SAMPLER_2D_ARRAY]: gl.TEXTURE_2D_ARRAY,
      [gl.SAMPLER_3D]: gl.TEXTURE_3D, [gl.SAMPLER_CUBE]: gl.TEXTURE_CUBE_MAP,
      [gl.INT_SAMPLER_2D]: gl.TEXTURE_2D, [gl.UNSIGNED_INT_SAMPLER_2D]: gl.TEXTURE_2D,
    };
    for (let i = 0; i < call(gl, "getProgramParameter", program, gl.ACTIVE_UNIFORMS); i++) {
      const info = call(gl, "getActiveUniform", program, i), target = targets[info.type];
      if (!target) continue;
      const location = call(gl, "getUniformLocation", program, info.name);
      const unit = call(gl, "getUniform", program, location);
      if (typeof unit !== "number") continue;
      call(gl, "activeTexture", gl.TEXTURE0 + unit);
      samplers.push({ name: info.name, type: info.type, unit, texture: describe(gl, target) });
    }
    call(gl, "activeTexture", active);
    return { program: id(program), samplers };
  };
  for (const [name, fn] of Object.entries(original)) {
    if (name === "constructor" || name.startsWith("get") || name.startsWith("is") ||
        name.startsWith("check") || name === "clientWaitSync") continue;
    prototype[name] = function (...args) {
      let report = contexts.get(this);
      if (!report) {
        report = { context: id(this), epoch: 0, calls: 0, errors: 0, counts: {}, firstErrors: [], recent: [], uploads: [], uploads2D: [], canvasEvents, canvasEventCounts, contextLosses: [], drawStates: [] };
        contexts.set(this, report);
        reports.push(report);
      }
      report.calls++;
      report.counts[name] = (report.counts[name] ?? 0) + 1;
      if (name.startsWith("draw") && !this.isContextLost() && report.drawStates.length < 64) {
        const program = call(this, "getParameter", this.CURRENT_PROGRAM);
        if (program && !sampledPrograms.has(program)) {
          sampledPrograms.add(program);
          report.drawStates.push({ sequence: report.calls, name, ...samplerState(this) });
        }
      }
      const result = fn.apply(this, args);
      const error = call(this, "getError");
      if (name.startsWith("create") && result && typeof result === "object")
        owners.set(result, { operation: name, context: report.context, epoch: report.epoch });
      const entry = { sequence: report.calls, name, args: args.map(summarize) };
      report.recent.push(entry);
      if (report.recent.length > 32) report.recent.shift();
      if (name === "texStorage2D" || name === "texStorage3D") {
        const texture = binding(this, args[0]);
        if (texture && !error) textures.set(texture, { operation: name, args: args.slice(1) });
      }
      if (/^tex(?:Storage|SubImage|Image)3D$/.test(name) && report.uploads.length < 8)
        report.uploads.push({ ...entry, error, texture: describe(this, args[0]) });
      if (name === "texSubImage2D") {
        report.uploads2D.push({ ...entry, error, texture: describe(this, args[0]) });
        if (report.uploads2D.length > 12) report.uploads2D.shift();
      }
      if (error === this.CONTEXT_LOST_WEBGL) {
        if (report.contextLosses.length < 8) report.contextLosses.push(entry);
      } else if (error) {
        report.errors++;
        if (report.firstErrors.length < 12)
          report.firstErrors.push({
            ...entry, error, activeUnit: call(this, "getParameter", this.ACTIVE_TEXTURE) - this.TEXTURE0,
            epoch: report.epoch, resource: owners.get(args[0]) ?? null,
            unpack: Object.fromEntries([
              ["alignment", this.UNPACK_ALIGNMENT], ["rowLength", this.UNPACK_ROW_LENGTH],
              ["imageHeight", this.UNPACK_IMAGE_HEIGHT], ["skipRows", this.UNPACK_SKIP_ROWS],
              ["skipPixels", this.UNPACK_SKIP_PIXELS], ["skipImages", this.UNPACK_SKIP_IMAGES],
              ["flipY", this.UNPACK_FLIP_Y_WEBGL], ["premultiplyAlpha", this.UNPACK_PREMULTIPLY_ALPHA_WEBGL],
            ].map(([key, parameter]) => [key, call(this, "getParameter", parameter)])),
            ...samplerState(this),
            recent: report.recent.slice(),
            stack: new Error("GL operation failed").stack,
          });
      }
      return result;
    };
  }
  window.__glCallTrace = {
    reports,
    samplers: samplerState,
    texture: (gl, target, unit) => {
      const active = call(gl, "getParameter", gl.ACTIVE_TEXTURE);
      call(gl, "activeTexture", gl.TEXTURE0 + unit);
      const result = describe(gl, target);
      call(gl, "activeTexture", active);
      return result;
    },
    id,
  };
}
