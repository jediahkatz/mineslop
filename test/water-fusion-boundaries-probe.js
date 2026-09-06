import * as THREE from "three";
import { WaterFusionOwner } from "../src/water-fusion.js";
import { boundaryFixture, bankHandle, bankMarker } from "./water-pull-boundaries-fixture.js";

const check = (ok, message) => { if (!ok) throw new Error(message); };
const diff = (a, b) => a.reduce((n, v, i) => n + Number(v !== b[i]), 0);

// Reuses the independently reviewed physical-bank inputs, without changing the
// original prototype suite. Large out-of-cap sources are explicitly rejected.
export function runWaterFusionBoundaries() {
  const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
  renderer.setSize(96, 96); renderer.setPixelRatio(1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05;
  const gl = renderer.getContext(), report = { pairs: [], controls: [], oracles: [], rejected: [], programs: [] };
  globalThis.waterFusionBoundaryProgress = report;
  let calls = [];
  const seen = new Set();
  for (const name of ["drawElements", "drawElementsInstanced"]) {
    const original = gl[name].bind(gl);
    gl[name] = (...args) => {
      calls.push({ method: name, count: args[1], type: args[2], instances: args[4] ?? 1 });
      const p = gl.getParameter(gl.CURRENT_PROGRAM);
      if (!seen.has(p)) {
        seen.add(p);
        const attributes = [], samplers = [];
        for (let i = 0; i < gl.getProgramParameter(p, gl.ACTIVE_ATTRIBUTES); i++) {
          const a = gl.getActiveAttrib(p, i); attributes.push({ name: a.name, location: gl.getAttribLocation(p, a.name) });
        }
        for (let i = 0; i < gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS); i++) {
          const u = gl.getActiveUniform(p, i);
          if ([gl.SAMPLER_2D, gl.SAMPLER_2D_ARRAY, gl.UNSIGNED_INT_SAMPLER_2D].includes(u.type)) samplers.push(u.name);
        }
        report.programs.push({ attributes, samplers });
      }
      return original(...args);
    };
  }
  const read = () => {
    const pixels = new Uint8Array(96 * 96 * 4);
    gl.readPixels(0, 0, 96, 96, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    check(gl.getError() === gl.NO_ERROR, "boundary GL error");
    return pixels;
  };
  const open = options => {
    const f = boundaryFixture(options);
    if (options.boundedRow) {
      // Keep the SAME visible high-address fixture quads, rebased by 16384
      // vertices to fit the unchanged per-allocation cap. Vertex 16469 still
      // straddles a 256-texel row. This is NOT the prototype's 65713 proof.
      for (const a of Object.values(f.geometry.attributes)) {
        a.array = a.array.slice(16384 * a.itemSize); a.count = a.array.length / a.itemSize;
      }
      f.geometry.index.array = f.geometry.index.array.map(v => v - 16384);
    }
    const reference = f.geometry.clone(), before = f.mesh.onBeforeRender;
    const owner = new WaterFusionOwner({ enabled: true });
    const status = owner.request(f.mesh, { current: () => true, exclusiveGeometry: true,
      reviewedHooks: new Set([f.material.onBeforeCompile]) });
    check(status.state === "pending", JSON.stringify(status));
    for (let i = 0; i < 10000 && owner.pending.size; i++) owner.step(renderer);
    check(!owner.pending.size && owner.status(f.mesh).ready, "boundary build readiness");
    const capture = fused => {
      const saved = [f.mesh.geometry, f.mesh.material, f.mesh.onBeforeRender];
      if (!fused) { f.mesh.geometry = reference; f.mesh.material = f.material; f.mesh.onBeforeRender = before; }
      calls = [];
      try {
        renderer.render(f.scene, f.camera);
        const pixels = read();
        check(calls.length === (fused ? 1 : 2), "water-only physical draws");
        check(calls.every(c => c.count === reference.index.count && c.instances === (fused ? 2 : 1)), "complete ordered phases");
        return pixels;
      } finally { [f.mesh.geometry, f.mesh.material, f.mesh.onBeforeRender] = saved; }
    };
    const pair = name => {
      f.mesh.visible = false; renderer.render(f.scene, f.camera); const background = read(); f.mesh.visible = true;
      const reference = capture(false), fused = capture(true);
      const differingBytes = diff(reference, fused), waterBytes = diff(reference, background);
      check(differingBytes === 0 && waterBytes > 100, `${name}: differences=${differingBytes} water=${waterBytes}`);
      report.pairs.push({ name, differingBytes, waterBytes });
      return { reference, fused };
    };
    return { f, owner, pair, close() { owner.dispose(); reference.dispose(); f.dispose(); } };
  };
  const contrast = (name, a, b) => {
    const referenceBytes = diff(a.reference, b.reference), fusedBytes = diff(a.fused, b.fused);
    check(referenceBytes > 100 && fusedBytes > 100, `${name}: paired contrast`);
    report.controls.push({ name, referenceBytes, fusedBytes });
  };
  const oracle = (name, a, b) => {
    const referenceBytes = diff(a.reference, b.reference), fusedBytes = diff(a.fused, b.fused);
    check(referenceBytes === 0 && fusedBytes === 0, `${name}: constant oracle`);
    report.oracles.push({ name, referenceBytes, fusedBytes });
  };
  try {
    const h = open({});
    try {
      const { f, pair } = h;
      for (const kind of ["Block", "Surface"]) {
        f.reset(kind);
        const table = kind === "Block" ? f.block : f.surface;
        for (let bank = 0; bank < f.banks[kind].length; bank++) for (const back of [false, true]) {
          f.aim(back);
          const name = `${kind}/bank-${bank}/${back ? "BACK-y7" : "FRONT-y8"}`;
          table.image.data[0] = bankHandle(kind, bank); f.dirty();
          const physical = pair(`${name}/physical`);
          table.image.data[0] = bankMarker(kind, bank, back ? 7 : 8) + 2; f.dirty();
          const expected = pair(`${name}/constant`);
          oracle(name, physical, expected);
          table.image.data[0] = bankMarker(kind, bank, back ? 8 : 7) + 2; f.dirty();
          contrast(`${name}/adjacent-cell`, physical, pair(`${name}/wrong-side`));
        }
        f.aim(false); table.image.data[0] = bankHandle(kind, 0); f.dirty();
        const on = pair(`${kind}/on`);
        f.u[`u${kind === "Block" ? "BlockLight" : "Daylight"}Enabled`].value = 0;
        contrast(`${kind}/toggle`, on, pair(`${kind}/off`));
        f.u[`u${kind === "Block" ? "BlockLight" : "Daylight"}Enabled`].value = 1;
        table.image.data[0] = 0; f.dirty();
        contrast(`${kind}/availability`, on, pair(`${kind}/missing`));
      }
      f.reset("Surface"); f.aim(false); f.surface.image.data[0] = 1; f.dirty();
      const roofed = pair("sky/roofed");
      f.sky.image.data.fill(0); f.dirty(); const exposed = pair("sky/exposed");
      contrast("sky/roof", roofed, exposed);
      f.surface.image.data[25] = 0; f.dirty(); const invalid = pair("sky/invalid");
      oracle("sky/unavailable", invalid, roofed); contrast("sky/validity", exposed, invalid);
      f.reset("Surface"); f.scene.fog = new THREE.Fog("#5aabd0", 0, 8); f.u.uDaylightFogEnabled.value = 1;
      const cave = pair("fog/cave");
      f.u.uDaylightFogEnabled.value = 0; const ordinary = pair("fog/ordinary");
      contrast("fog/cave-mix", cave, ordinary);
      f.scene.fog.color.set("#164e38"); f.scene.fog.near = 0.2; f.scene.fog.far = 6;
      const underwater = pair("fog/underwater");
      contrast("fog/underwater-policy", ordinary, underwater);
      f.scene.fog = null; contrast("fog/off", underwater, pair("fog/off"));
    } finally { h.close(); }
    const edge = open({ edge: true });
    try {
      const { f, pair } = edge;
      for (const kind of ["Block", "Surface"]) {
        f.reset(kind); const table = kind === "Block" ? f.block : f.surface;
        table.image.data[0] = 0; table.image.data[1] = bankHandle(kind, 1); f.dirty();
        const neighbor = pair(`${kind}/neighbor`);
        table.image.data[0] = bankMarker(kind, 1, 8) + 2; f.dirty();
        oracle(`${kind}/apron`, neighbor, pair(`${kind}/owner-constant`));
        table.image.data[0] = table.image.data[1] = 0; f.dirty();
        contrast(`${kind}/neighbor-availability`, neighbor, pair(`${kind}/both-missing`));
      }
    } finally { edge.close(); }
    let rowImage;
    for (const boundedRow of [true, false]) {
      const h = open({ addressMode: boundedRow ? "high" : "compact", boundedRow });
      try {
        h.f.reset("Block"); h.f.block.image.data[0] = 122; h.f.dirty();
        const image = h.pair(boundedRow ? "address/bounded-row" : "address/compact");
        if (boundedRow) {
          rowImage = image;
          const r = h.owner.records.get(h.f.mesh);
          check((16469 * 3) % r.plan.width === 255, "actual row crossing");
          report.rowAddress = { vertex: 16469, width: r.plan.width, textureBytes: r.plan.textureBytes };
        } else oracle("address/bounded-row-vs-compact", rowImage, image);
      } finally { h.close(); }
    }
    const high = boundaryFixture({ addressMode: "high" }), owner = new WaterFusionOwner({ enabled: true });
    const original = high.mesh.geometry;
    const status = owner.request(high.mesh, { current: () => true, exclusiveGeometry: true,
      reviewedHooks: new Set([high.material.onBeforeCompile]) });
    check(status.reason === "single-allocation-limit" && high.mesh.geometry === original, "oversize original fallback");
    calls = []; renderer.render(high.scene, high.camera); read();
    check(calls.length === 2 && calls.every(c => c.method === "drawElements"), "oversize source keeps original two calls");
    report.rejected.push({ reason: status.reason, vertices: original.attributes.position.count, originalCalls: calls.length });
    owner.dispose(); high.dispose();
    for (const p of report.programs.filter(p => p.samplers.includes("uWaterFusion"))) {
      check(p.attributes.every(a => a.location === -1), "no active user attributes");
      check(p.samplers.length <= 16, "conservative sampler ceiling");
    }
    return report;
  } finally { renderer.dispose(); }
}
