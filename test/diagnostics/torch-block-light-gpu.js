// Serialized into an isolated page. Authored, native-GameRenderer materials,
// geometry, atmosphere and fog; not a native-world or manual-walk claim.
export async function runBlockLightProbe({ mode = "field" } = {}) {
  const load = (path) => import(new URL(path, location.href).href);
  const rendererURL = new URL("../../src/renderer.js", location.href);
  const source = await (await fetch(rendererURL)).text();
  const threePath = source.match(/from\s*["']([^"']*three[^"']*)["']/)?.[1];
  if (!threePath) throw new Error("Cannot resolve renderer Three instance");
  const [THREE, { GameRenderer }, { authoredColumns }, { getWorldSpec }, { BLOCK }, { sampleDaylightAt },
    { blockLightRigs }] =
    await Promise.all([import(new URL(threePath, rendererURL).href), load("../../src/renderer.js"),
      load("../shape-fixture.js"), load("../../src/world-spec.js"), load("../../src/blocks.js"),
      load("../../src/daylight-material.js"), load("../block-light-rig-fixture.js")]);
  const world = authoredColumns([]);
  world.spec = getWorldSpec(3, "overworld");
  world.generatorVersion = 3;
  for (let x = -4; x <= 7; x++) for (let z = -3; z <= 3; z++) world.admit(x, z);
  for (let x = -48; x < 96; x++) for (let z = 0; z <= 4; z++) {
    world.put(x, 7, z, BLOCK.STONE);
    world.put(x, 11, z, BLOCK.STONE);
    if (z === 0 || z === 4 || x === -48 || x === 95)
      for (let y = 8; y <= 10; y++) world.put(x, y, z, BLOCK.STONE);
  }
  // The complete brightness phase has exactly ONE emitter, not one selected
  // emitter out of a multiple-torch world.
  world.put(14, 8, 2, BLOCK.TORCH);
  const cave = { id: "dripstone_caves", category: "cave", dimension: "overworld", fogColor: "#574d47" };
  world.getBiome = () => cave;
  const hash = () => {
    let result = 2166136261;
    for (const chunk of world.chunks.values())
      for (const id of chunk.blocks) result = Math.imul(result ^ id, 16777619);
    return result >>> 0;
  };
  const emitterCount = () => [...world.chunks.values()].reduce((n, c) => n + c.blocks.filter((id) => id === BLOCK.TORCH).length, 0);
  const g = new GameRenderer(document.querySelector("#probe"), world), gl = g.renderer.getContext();
  g.setTime(0.5);
  const errors = [], frames = [], mobs = [], mobResources = [];
  const maxima = { scans: 0, visits: 0, uploadLayers: 0, uploadBytes: 0, updateMs: 0, uploadMs: 0 };
  const receiver = new THREE.Vector3(16.5, 8, 2.5);
  const vec = (p) => ({ x: p.x, y: p.y, z: p.z });
  const luma = (p) => p[0] * 0.2126 + p[1] * 0.7152 + p[2] * 0.0722;
  let clock = 0;
  window.__torchBlockLight = { graphics: g, world, frames, mobs, maxima };
  const check = () => {
    const error = gl.getError();
    if (error) errors.push(error);
    if (gl.isContextLost()) throw new Error("Block-light probe lost GL context");
  };
  const upload = () => {
    if (!g.blockLight) return;
    for (const name of Object.keys(maxima)) maxima[name] = Math.max(maxima[name], g.blockLight.stats[name] ?? 0);
    if (g.blockLight.texture.layerUpdates.size > 2) throw new Error("Pending GPU layer cap exceeded");
    // Drain real texture uploads without drawing the whole scene on every
    // staged CPU slice. This preserves actual per-update transfer accounting.
    const started = performance.now();
    g.renderer.initTexture(g.blockLight.texture);
    g.renderer.initTexture(g.blockLight.validTexture);
    maxima.uploadMs = Math.max(maxima.uploadMs, performance.now() - started);
  };
  const observe = (x, quality = "medium", immediate = false) => {
    window.__torchBlockLight.observer = { x, quality };
    if (g.quality !== quality) g.setQuality(quality);
    g.renderer.setPixelRatio(1); g.renderer.setSize(129, 129);
    g.camera.aspect = 1; g.camera.updateProjectionMatrix();
    const feet = { x, y: 8, z: 2.5 };
    g.camera.position.set(x, 9.62, 2.5);
    g.camera.lookAt(receiver); g.camera.updateMatrixWorld(true);
    g.setBiome(cave);
    for (let i = 0; i < 12000; i++) {
      window.__torchBlockLight.settleTicks = i + 1;
      g.rebuildDirty(2);
      g.update(0, ++clock, feet);
      if (mode === "field" && !g.blockLight) throw new Error("Candidate has no BlockLightField");
      upload();
      if (immediate) return feet;
      const dirty = [...world.dirtyChunks].some((id) => {
        const [cx, cz] = id.split(",").map(Number);
        return Math.max(Math.abs(cx - Math.floor(x / 16)), Math.abs(cz)) <= g.renderRadius;
      });
      if (!dirty && !g.skyColumns.surfaceLight.pending && !g.blockLight?.pending) return feet;
    }
    throw new Error(`Block-light fixture did not converge: ${JSON.stringify(g.blockLight?.stats)}`);
  };
  const read = (point = receiver, normal = new THREE.Vector3(0, 1, 0), targetGroup) => {
    const group = targetGroup ?? g.chunks.get(`${Math.floor(point.x / 16)},${Math.floor((point.z - (normal.z ? normal.z * 0.001 : 0)) / 16)}`);
    if (!group?.visible) throw new Error("Receiver geometry is not visible");
    const camera = g.camera.clone();
    camera.position.copy(point).addScaledVector(normal, 0.5);
    camera.up.set(0, normal.y ? 0 : 1, normal.y ? -1 : 0);
    camera.fov = 20; camera.lookAt(point); camera.updateProjectionMatrix(); camera.updateMatrixWorld(true);
    g.scene.updateMatrixWorld(true);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(), camera);
    const hit = ray.intersectObject(group, true)[0];
    if (!hit || hit.point.distanceTo(point) > 0.001)
      throw new Error(`Fixed native receiver ray missed: ${JSON.stringify({ target: vec(point), hit: hit && vec(hit.point) })}`);
    g.renderer.render(g.scene, camera);
    const rgba = new Uint8Array(4);
    gl.readPixels(64, 64, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    check();
    const depth = -point.clone().applyMatrix4(camera.matrixWorldInverse).z;
    const t = THREE.MathUtils.clamp((depth - g.scene.fog.near) / (g.scene.fog.far - g.scene.fog.near), 0, 1);
    const air = point.clone().addScaledVector(normal, 0.02);
    return { point: vec(point), rgba: [...rgba], luma: luma(rgba), uv: hit.uv?.toArray(),
      fogFactor: t * t * (3 - 2 * t), fogEnabled: hit.object.material.fog,
      daylight: sampleDaylightAt(g.skyColumns, air), field: g.blockLight?.sample(air) };
  };
  const capture = (label, feet, overview = false, immediate = false) => {
    const projected = receiver.clone().project(g.camera);
    const result = { label, quality: g.quality, feet, immediate, point: read(),
      sourceViewerDistance: Math.hypot(feet.x - 14.5, feet.y - 8.7, feet.z - 2.5),
      sourceGroupVisible: g.chunks.get("0,0")?.visible ?? false,
      receiverInFrustum: receiver.clone().applyMatrix4(g.camera.matrixWorldInverse).z < 0 &&
        Math.abs(projected.x) <= 1 && Math.abs(projected.y) <= 1,
      fullbright: g.fullbrightInspection, pending: g.blockLight?.pending ?? 0,
      selected: g.localLights.map((light) => ({ intensity: light.intensity, emitter: light.userData.emitter })),
      resources: g.blockLight?.resources() };
    result.mobs = mobs.map((target) => ({ kind: target.kind, ...read(target.point, target.normal, target.group),
      fieldBound: target.group.children.every((mesh) => /:block-light-[12]:/.test(mesh.material.customProgramCacheKey())) }));
    if (overview) { g.render(); result.png = g.renderer.domElement.toDataURL("image/png"); check(); }
    frames.push(result);
    return result;
  };
  const originalHash = hash(), singleEmitterCount = emitterCount();
  // Actual production opaque and late gel materials, with a nonzero batch
  // anchor. No duplicate atlas or debug material substitutes the live skins.
  observe(12.5);
  const rigs = blockLightRigs(g.scene);
  mobs.push(...rigs.mobs); mobResources.push(...rigs.resources);
  for (const [label, x] of [["near", 12.5], ["inside_old_radius", -3], ["outside_old_radius", -4],
    ["tile_before", 15.99], ["tile_after", 16.01], ["native_source_culled", 64.5]]) {
    if (label === "tile_after" || label === "native_source_culled")
      capture(`${label}_immediate`, observe(x, "medium", true), false, true);
    capture(label, observe(x), label === "near" || label === "native_source_culled");
  }
  observe(12.5);
  const calibration = [];
  for (const horizontalDistance of [2, 4, 6, 8, 10])
    for (const surface of ["floor", "wall"]) {
      const p = new THREE.Vector3(14.5 + horizontalDistance, surface === "floor" ? 8 : 8.5, surface === "floor" ? 2.5 : 4);
      const normal = surface === "floor" ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, -1);
      const sourceVector = new THREE.Vector3(14.5, 8.7, 2.5).sub(p), sourceDistance = sourceVector.length();
      const lit = read(p, normal);
      let unlit = null;
      if (g.blockLight) {
        g.daylightMaterial.uniforms.uBlockLightEnabled.value = 0;
        unlit = read(p, normal);
        g.daylightMaterial.uniforms.uBlockLightEnabled.value = 1;
      }
      calibration.push({ surface, horizontalDistance, sourceDistance,
        incidenceCosine: sourceVector.dot(normal) / sourceDistance, lit, unlit });
    }
  const singleUnchanged = hash() === originalHash;
  // Separate competition phase. All added emitters are beyond the fixed
  // receiver's finite propagation range; their selector competition used to
  // extinguish its nearby torch anyway.
  world.put(30, 8, 1, BLOCK.TORCH);
  world.put(31, 8, 3, BLOCK.TORCH);
  for (let x = 32; x < 45; x++) world.put(x, 8, 1, BLOCK.TORCH);
  const competitionHash = hash(), competingEmitterCount = emitterCount();
  for (const [label, x, quality] of [["competition_medium", 25, "medium"], ["competition_high", 25, "high"]])
    capture(label, observe(x, quality));
  const feet = observe(12.5, "high"), sourceGroup = g.chunks.get("0,0");
  capture("before_hidden", feet);
  sourceGroup.visible = false;
  g.updateLocalLights(++clock, feet);
  capture("hidden_source_bucket", feet);
  sourceGroup.visible = true;
  g.updateLocalLights(++clock, feet);
  capture("restored_source_bucket", feet);
  const normal = read(), mobNormal = mobs.map((m) => read(m.point, m.normal, m.group));
  let mobNoField = null;
  if (g.blockLight) {
    g.daylightMaterial.uniforms.uBlockLightEnabled.value = 0;
    mobNoField = mobs.map((m) => read(m.point, m.normal, m.group));
    g.daylightMaterial.uniforms.uBlockLightEnabled.value = 1;
  }
  const dynamic = new THREE.PointLight("#ffffff", 8, 10);
  dynamic.position.set(16.5, 9, 2.5); g.scene.add(dynamic);
  const dynamicPoint = read();
  g.scene.remove(dynamic); dynamic.dispose();
  g.setFullbrightInspection(true);
  const fullbright = read(), fieldDisabledInFullbright = g.daylightMaterial.uniforms.uBlockLightEnabled?.value === 0;
  g.setFullbrightInspection(false);
  const returned = read();
  const result = { mode, kind: "Authored native-renderer static-light GPU regression",
    frames, calibration, singleEmitterCount, competingEmitterCount, singleUnchanged,
    competitionUnchanged: hash() === competitionHash,
    controls: { normal, dynamicPoint, fullbright, returned, fieldDisabledInFullbright, mobNormal, mobNoField },
    maxima, errors, localLightObjects: g.localLights.length, gain: g.daylightMaterial.uniforms.uBlockLightGain?.value,
    failedPrograms: g.renderer.info.programs.filter((p) => p.diagnostics?.runnable === false).length };
  if (mode === "field") {
    // Separate phase AFTER calibration: a native cow rooted at x=16.2 has a
    // top texel at x=15.98. Unlike a back-facing voxel side, this receiver is
    // genuinely front-facing from the actual observer on both trips.
    const body = mobs.find((mob) => mob.kind === "cow");
    body.group.position.x = -1.3;
    body.point.set(15.98, 9.42, 2.45);
    const boundaryHash = hash(), point = body.point, normal = body.normal;
    const readBoundary = () => {
      const sampled = read(point, normal, body.group);
      const projected = point.clone().project(g.camera);
      const ray = new THREE.Raycaster(g.camera.position, point.clone().sub(g.camera.position).normalize());
      const hit = ray.intersectObject(body.group, true)[0];
      return { ...sampled, observerVisible: !!hit && hit.point.distanceTo(point) < 0.001 &&
        Math.abs(projected.x) <= 1 && Math.abs(projected.y) <= 1 &&
        normal.dot(g.camera.position.clone().sub(point)) > 0 };
    };
    observe(12.5, "medium");
    const initial = readBoundary();
    g.daylightMaterial.uniforms.uBlockLightEnabled.value = 0;
    const unlit = readBoundary();
    g.daylightMaterial.uniforms.uBlockLightEnabled.value = 1;
    observe(64.5, "medium");
    const outside = readBoundary();
    observe(63.99, "medium", true);
    const returned = readBoundary();
    result.boundary = { initial, unlit, outside, returned, unchanged: hash() === boundaryHash,
      ownerValid: g.blockLight.valid[g.blockLight.index(0, 0, 0)],
      neighborValid: g.blockLight.valid[g.blockLight.index(1, 0, 0)] };
    result.failedPrograms = g.renderer.info.programs.filter((p) => p.diagnostics?.runnable === false).length;
  }
  window.__torchBlockLight = { graphics: g, world, result, mobResources, mobs };
  return result;
}
