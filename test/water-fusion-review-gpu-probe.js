import * as THREE from "three";
import { WaterFusionOwner, waterFusionBudget } from "../src/water-fusion.js";
import { waterFusionDecoder } from "../src/water-fusion-geometry.js";
import { authoredWaterScene } from "./water-pull-fixture.js";
import { waterFusionGLTrace } from "./water-fusion-gl-trace.js";

const check = (ok, message) => { if (!ok) throw new Error(message); };
const difference = (a, b) => a.reduce((n, value, i) => n + Number(value !== b[i]), 0);

export function runWaterFusionReviewGPU() {
  const renderers = [];
  const makeRenderer = () => {
    const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
    renderer.setSize(128, 128); renderer.setPixelRatio(1);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.info.autoReset = false;
    renderer.shadowMap.enabled = true;
    document.body.append(renderer.domElement);
    renderers.push(renderer);
    return renderer;
  };
  let renderer = makeRenderer(), trace = waterFusionGLTrace(renderer);
  const f = authoredWaterScene(), mesh = f.water[0], source = f.materials.water;
  f.scene.background = new THREE.Color("#172029");
  f.scene.add(new THREE.AmbientLight(0xffffff, 1.5));
  const sun = new THREE.DirectionalLight(0xffe9c5, 2);
  sun.position.set(-20, 20, -5); sun.target.position.set(...f.target);
  sun.castShadow = true; sun.shadow.mapSize.set(128, 128);
  Object.assign(sun.shadow.camera, { left: -20, right: 20, top: 20, bottom: -20, near: 0.5, far: 100 });
  f.scene.add(sun, sun.target);
  const owner = new WaterFusionOwner({ enabled: true });
  const referenceGeometry = mesh.geometry.clone(), sourceBefore = mesh.onBeforeRender;
  referenceGeometry.computeBoundingBox();
  const camera = new THREE.PerspectiveCamera(65, 1, 0.05, 512);
  camera.position.set(...f.views[0][1]); camera.lookAt(...f.target);
  const report = { pairs: [], frames: [], gpuDebits: [], gates: {} };
  globalThis.waterFusionReviewProgress = report;
  const capture = () => {
    const gl = renderer.getContext();
    renderer.info.reset(); trace.draws.length = 0;
    trace.state.scope = "render";
    renderer.render(f.scene, camera);
    const image = new Uint8Array(128 * 128 * 4);
    gl.readPixels(0, 0, 128, 128, gl.RGBA, gl.UNSIGNED_BYTE, image);
    check(gl.getError() === gl.NO_ERROR, "review render GL error");
    check(trace.draws.length === renderer.info.render.calls, "actual versus Three draw count");
    return { image, draws: [...trace.draws] };
  };
  const reference = () => {
    const saved = [mesh.geometry, mesh.material, mesh.onBeforeRender];
    mesh.geometry = referenceGeometry; mesh.material = source; mesh.onBeforeRender = sourceBefore;
    try { return capture(); }
    finally { [mesh.geometry, mesh.material, mesh.onBeforeRender] = saved; }
  };
  const pair = name => {
    const a = reference(), b = capture();
    const expanded = b.draws.flatMap(draw => draw.id === mesh.id && draw.method === "drawElementsInstanced"
      ? [draw.id, draw.id] : [draw.id]);
    check(JSON.stringify(expanded) === JSON.stringify(a.draws.map(draw => draw.id)), `${name}: object order`);
    const differingBytes = difference(a.image, b.image);
    check(differingBytes === 0, `${name}: ${differingBytes} differing bytes`);
    mesh.visible = false;
    const withoutOwned = capture().image;
    mesh.visible = true;
    const ownedVisibleBytes = difference(b.image, withoutOwned);
    check(ownedVisibleBytes > 0, `${name}: owned source must affect pixels`);
    report.pairs.push({ name, differingBytes, ownedVisibleBytes,
      referenceCalls: a.draws.length, actualCalls: b.draws.length });
    return b.image;
  };
  const step = () => {
    const budget = waterFusionBudget({ operations: 1 });
    const start = trace.operations.length;
    trace.state.scope = "water-step";
    owner.step(renderer, budget);
    const operations = trace.operations.slice(start);
    const actual = operations.reduce((n, op) => n + op.workBytes, 0);
    const gpuDebit = budget.work.filter(op => op.kind.startsWith("gpu-")).reduce((n, op) => n + op.bytes, 0);
    check(actual <= gpuDebit, `GPU-only debit ${actual}/${gpuDebit}; CPU debit cannot mask a GPU miss`);
    check(budget.usedBytes <= 1048576 && budget.work.length <= 1, "shared one-operation budget");
    check(operations.every(op => op.workBytes <= 1048576), "individual GPU transfer cap");
    report.gpuDebits.push({ actual, gpuDebit, cpuAndGpuDebit: budget.usedBytes, work: budget.work,
      operations: operations.map(({ handle, ...op }) => op) });
  };
  const pump = () => {
    for (let i = 0; i < 2000 && owner.pending.size; i++) step();
    check(!owner.pending.size, "review GPU build did not drain");
    check(owner.status(mesh).ready, "review source not ready");
  };
  try {
    reference();
    check(owner.request(mesh, { exclusiveGeometry: true, current: () => true,
      reviewedHooks: new Set([source.onBeforeCompile]) }).state === "pending", "review source admission");
    pump();
    // The other two real sources remain conventional and use this SAME source
    // material. No manual version emulation in this GPU control.
    const initialMaterial = mesh.material, publications = owner.stats.publications;
    for (let frame = 0; frame < 4; frame++) {
      const beforeVersion = source.version;
      pair(`mixed-frame-${frame}`);
      owner.refresh(mesh); pump();
      report.frames.push({ frame, beforeVersion, afterVersion: source.version,
        stableClone: mesh.material === initialMaterial, publications: owner.stats.publications });
      check(mesh.material === initialMaterial && owner.stats.publications === publications, "mixed rendering material churn");
    }
    source.needsUpdate = true;
    owner.refresh(mesh); pump();
    check(mesh.material !== initialMaterial, "explicit version-only update must still publish");
    report.gates.explicitVersionRefresh = true;
    pair("explicit-version-refresh");
    Object.assign(source, {
      blending: THREE.CustomBlending, blendSrc: THREE.ConstantColorFactor,
      blendDst: THREE.OneMinusConstantColorFactor, blendSrcAlpha: THREE.ConstantAlphaFactor,
      blendDstAlpha: THREE.OneMinusConstantAlphaFactor,
      blendEquation: THREE.AddEquation, blendEquationAlpha: THREE.AddEquation, blendAlpha: 0.25,
    });
    source.blendColor.setRGB(0.2, 0.3, 0.4);
    owner.refresh(mesh); pump();
    const beforeBlend = pair("constant-blend-before");
    const beforeVersion = source.version;
    source.blendColor.setRGB(0.7, 0.6, 0.5); source.blendAlpha = 0.75;
    owner.refresh(mesh); pump();
    check(source.version === beforeVersion, "blend mutation control must not request recompilation explicitly");
    const afterBlend = pair("constant-blend-after");
    report.gates.blendChangedPixels = difference(beforeBlend, afterBlend);
    check(report.gates.blendChangedPixels > 0, "constant blend update must change visible pixels");
    // Move the camera to the mirrored owned source, and prove that specific
    // source contributes pixels (not merely other unmirrored water).
    mesh.scale.x = -1; mesh.updateMatrixWorld(true);
    const center = referenceGeometry.boundingBox.getCenter(new THREE.Vector3()).applyMatrix4(mesh.matrixWorld);
    camera.position.copy(center).add(new THREE.Vector3(4, 6, 8)); camera.lookAt(center);
    pair("mirrored-owned-visible");
    mesh.scale.x = 1;
    camera.position.set(...f.views[0][1]); camera.lookAt(...f.target);
    source.needsUpdate = true;
    owner.refresh(mesh);
    check(owner.pending.size === 1, "create a pending fused material replacement");
    mesh.castShadow = true;
    pump();
    check(owner.records.get(mesh).mode === "original", "live shadow requirement must supersede pending fused replacement");
    pair("pending-replacement-live-shadow-fallback");
    mesh.castShadow = false;
    owner.refresh(mesh); pump();
    const beforeRebind = pair("before-renderer-rebind");
    const r = owner.records.get(mesh), data = r.data, indices = r.indices, decoder = waterFusionDecoder(mesh);
    renderer = makeRenderer();
    trace = waterFusionGLTrace(renderer);
    step(); pump();
    check(r.data === data && r.indices === indices && waterFusionDecoder(mesh) === decoder, "renderer rebind canonical identities");
    const afterRebind = pair("after-renderer-rebind");
    check(difference(beforeRebind, afterRebind) === 0, "renderer rebind exact pixels");
    report.gates.rendererRebind = true;
    report.gates.pendingLiveShadowFallback = true;
    report.machine = renderer.getContext().getParameter(renderer.getContext().RENDERER);
    return report;
  } finally {
    owner.dispose();
    referenceGeometry.dispose();
    for (const r of renderers) r.dispose();
  }
}
