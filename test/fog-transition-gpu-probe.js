import * as THREE from "three";
import { GameRenderer } from "../src/renderer.js";
import { BLOCK } from "../src/blocks.js";
import { detailMeshResources } from "../src/section-renderer.js";
import { authoredColumns } from "./shape-fixture.js";
import { registerTotalSurface } from "../src/surface-availability.js";
import { WORLD_MIN, WORLD_MAX } from "../src/terrain.js";

const check = (ok, message) => { if (!ok) throw new Error(message); };
const size = 64;

// A deterministic flat authored world isolates coverage from terrain-shape
// approximation. The production section mesher, LOD, fog and mask shaders run
// unchanged. This is a GPU correctness control, not native-world/FPS acceptance.
export async function runFogTransitionGPU({ originX = 0 } = {}) {
  const report = { scope: "Authored flat GPU transition control; not a startup benchmark",
    originX, phases: [], resources: {}, controls: {}, passed: false };
  globalThis.fogTransitionProgress = report;
  let phase = "startup";
  const buffers = new Map(), bufferData = WebGL2RenderingContext.prototype.bufferData;
  const deleteBuffer = WebGL2RenderingContext.prototype.deleteBuffer;
  const liveBufferBytes = () => [...buffers.values()].reduce((a, b) => a + b, 0);
  const peaks = () => report.resources[phase] ??= {
    glBufferBytes: 0, nativeCombinedCpuBytes: 0, nativeStagingBytes: 0,
    nativeAccountedGpuBytes: 0, lodTypedBackingBytes: 0, maskBytes: 0 };
  WebGL2RenderingContext.prototype.bufferData = function (target, data, ...rest) {
    const result = bufferData.call(this, target, data, ...rest);
    const binding = target === this.ARRAY_BUFFER ? this.ARRAY_BUFFER_BINDING :
      target === this.ELEMENT_ARRAY_BUFFER ? this.ELEMENT_ARRAY_BUFFER_BINDING : null;
    if (binding !== null) {
      buffers.set(this.getParameter(binding), typeof data === "number" ? data : data.byteLength);
      peaks().glBufferBytes = Math.max(peaks().glBufferBytes, liveBufferBytes());
    }
    return result;
  };
  WebGL2RenderingContext.prototype.deleteBuffer = function (buffer) {
    buffers.delete(buffer);
    return deleteBuffer.call(this, buffer);
  };
  let g;
  try {
    const world = authoredColumns([]);
    world.seed = "fog-transition-control";
    world.spec = { ...world.spec, minY: 0, maxY: 128, seaLevel: 0 };
    const biome = { id: "plains", category: "grassland", dimension: "overworld",
      color: "#83ac52", grassColor: "#83ac52", waterColor: "#4e9cac", fogColor: "#b4d1ce" };
    world.generator = { terrainHeight: () => 31, getBiome: () => biome, getTrees: () => [] };
    // This authored constant field is total by construction. Unknown/custom
    // samplers are exercised separately without this explicit certificate.
    registerTotalSurface(world.generator,
      { minX: WORLD_MIN, maxX: WORLD_MAX, minZ: WORLD_MIN, maxZ: WORLD_MAX });
    // The camera is in authored open air, not an unknown streaming column.
    // This supplies query knowledge only; native draw ownership still starts
    // empty and is earned by the section publication exercised below.
    const authoredCell = world.getCell;
    world.isLoaded = () => true;
    world.getCell = (x, y, z) => authoredCell(x, y, z) ??
      { id: y === 31 ? BLOCK.GRASS : BLOCK.AIR, state: 0, fluid: 0 };
    world.getBiome = () => biome;
    world.generate = world.ensureArea = () => { throw new Error("No native generation in authored GPU control"); };
    const host = document.createElement("div");
    host.style.cssText = `width:${size}px;height:${size}px`;
    document.body.append(host);
    g = new GameRenderer(host, world);
    g.meshLimits = { regionalPages: true };
    g.setQuality("medium");
    g.setRenderDistanceOverride(12);
    g.renderer.setPixelRatio(1);
    g.renderer.setSize(size, size);
    g.camera.aspect = 1;
    g.camera.updateProjectionMatrix();
    const pose = (x) => {
      g.camera.position.set(originX + x, 96, 80);
      g.camera.lookAt(originX + x, 32, 0);
      g.camera.updateMatrixWorld(true);
    };
    pose(8);
    const target = new THREE.WebGLRenderTarget(size, size);
    const gl = g.renderer.getContext();
    report.raster = { subpixelBits: gl.getParameter(gl.SUBPIXEL_BITS),
      depthBits: gl.getParameter(gl.DEPTH_BITS) };
    let tick = 0;
    const started = performance.now();
    const resources = () => {
      const stats = detailMeshResources(g), peak = peaks(), typed = new Set();
      const add = (object) => {
        for (const value of Object.values(object ?? {}))
          if (ArrayBuffer.isView(value)) typed.add(value.buffer);
      };
      for (const data of [g.distant._active?.data, g.distant._job]) {
        add(data); add(data?.terraces);
      }
      g.distant.group.traverse((object) => {
        for (const attribute of Object.values(object.geometry?.attributes ?? {}))
          typed.add(attribute.array.buffer);
        if (object.geometry?.index) typed.add(object.geometry.index.array.buffer);
      });
      const values = { glBufferBytes: liveBufferBytes(),
        nativeCombinedCpuBytes: stats.combinedCpuBytes, nativeStagingBytes: stats.stagingBytes,
        nativeAccountedGpuBytes: stats.gpuBytes, maskBytes: g.distant.detailMask.resources().gpuBytes,
        lodTypedBackingBytes: [...typed].reduce((sum, buffer) => sum + buffer.byteLength, 0) };
      for (const [key, value] of Object.entries(values)) peak[key] = Math.max(peak[key], value);
      check(stats.combinedCpuBytes <= 256 * 1024 ** 2 && stats.gpuBytes <= 256 * 1024 ** 2 &&
        stats.stagingBytes <= 16 * 1024 ** 2, "native resource ceiling");
      check(g.distant.group.children.filter(c => c.getObjectByName("Distant terrain surface")).length <= 1,
        "two published terrain layers");
      check(performance.now() - started < 60000, "GPU control exceeded 60s");
    };
    const update = (mesh = false) => {
      if (mesh) g.rebuildDirty(2);
      g.update(0, ++tick / 20, g.camera.position);
      resources();
    };
    const capture = (kind) => {
      const visibility = new Map(g.scene.children.map(c => [c, c.visible]));
      const background = g.scene.background;
      const native = new Set([...g.chunks.values(), ...(g.sectionRegions?.values() ?? [])]);
      for (const child of g.scene.children) {
        if (child === g.distant.group) child.visible = kind !== "native" && visibility.get(child);
        else if (native.has(child)) child.visible = kind !== "lod" && visibility.get(child);
        else if (!child.isLight) child.visible = false;
      }
      g.scene.background = null;
      g.renderer.setRenderTarget(target);
      g.renderer.setClearColor(0, 0);
      g.renderer.render(g.scene, g.camera);
      const pixels = new Uint8Array(size * size * 4);
      g.renderer.readRenderTargetPixels(target, 0, 0, size, size, pixels);
      g.renderer.setRenderTarget(null);
      g.scene.background = background;
      for (const [child, visible] of visibility) child.visible = visible;
      check(gl.getError() === gl.NO_ERROR, "GPU error");
      resources();
      return pixels;
    };
    const audit = (label, assertClean = true, horizon = g.distant.fogDistance) => {
      const native = capture("native"), lod = capture("lod"), combined = capture("combined");
      let tested = 0, holes = 0, overlap = 0, nativePixels = 0, lodPixels = 0, occludedNative = 0, combinedHoles = 0;
      const witnesses = [], nativeMeshes = [];
      for (const root of [...g.chunks.values(), ...(g.sectionRegions?.values() ?? [])])
        root.traverseVisible(object => {
          if (object.isMesh && !object.userData.sectionSource) nativeMeshes.push(object);
        });
      const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -32);
      const ray = new THREE.Raycaster(), p = new THREE.Vector3();
      for (let y = 1; y < size - 1; y++) for (let x = 1; x < size - 1; x++) {
        ray.setFromCamera(new THREE.Vector2((x + 0.5) / size * 2 - 1, (y + 0.5) / size * 2 - 1), g.camera);
        if (!ray.ray.intersectPlane(plane, p)) continue;
        if (p.x < WORLD_MIN || p.x >= WORLD_MAX || p.z < WORLD_MIN || p.z >= WORLD_MAX) continue;
        const depth = -p.clone().applyMatrix4(g.camera.matrixWorldInverse).z;
        if (depth >= g.scene.fog.near || Math.hypot(p.x - g.camera.position.x, p.z - g.camera.position.z) >
            horizon - 2) continue;
        const i = (y * size + x) * 4 + 3, rawNative = native[i] > 0, l = lod[i] > 0;
        const hits = rawNative ? ray.intersectObjects(nativeMeshes, false) : [];
        // Isolated native side walls below Y32 can project behind the LOD
        // plane. That is ordinary depth occlusion, not coplanar overlap. Use
        // actual physical native draw geometry to distinguish those pixels;
        // the GPU still decides whether the ownership shader drew the LOD.
        const behindPlane = hits.length && Math.abs(hits[0].point.y - 32) > 1e-4;
        const n = rawNative && !behindPlane;
        occludedNative += Number(rawNative && behindPlane);
        tested++; nativePixels += n; lodPixels += l;
        holes += !n && !l; overlap += n && l;
        if (n && l && witnesses.length < 3)
          witnesses.push({ x, y, plane: p.toArray(),
            nativeHits: hits.slice(0, 3).map(hit => hit.point.toArray()) });
        if (combined[i] === 0) {
          combinedHoles++;
          if (witnesses.length < 3) witnesses.push({ kind: "combined-hole", x, y, plane: p.toArray(),
            alpha: [native[i], lod[i], combined[i]], nativeHits: hits.slice(0, 3).map(hit => hit.point.toArray()),
            lodHits: ray.intersectObject(g.distant._active.terrain, false).slice(0, 2).map(hit => {
              const chunk = hit.object.geometry.attributes.lodDetailChunk;
              return { point: hit.point.toArray(), normal: hit.face.normal.toArray(),
                cpuOwned: g.distant.detailMask.owns(hit.point, hit.face.normal),
                chunks: chunk ? [hit.face.a, hit.face.b, hit.face.c].map(i => [chunk.getX(i), chunk.getY(i)]) : null };
            }),
            batches: g.detailBatchCoverage().get(`${Math.floor(p.x / 16)},${Math.floor(p.z / 16)},1`),
            columnCovered: g.detailCoverage().has(`${Math.floor(p.x / 16)},${Math.floor(p.z / 16)}`) });
        }
      }
      const row = { label, tested, holes, overlap, nativePixels, lodPixels, occludedNative, combinedHoles,
        fogNear: g.scene.fog.near, fogFar: g.scene.fog.far, horizon,
        coarse: g.distant._active?.data.request.bootstrap,
        coveredColumns: g.detailCoverage().size, maskedSections: g.distant.detailMask.coveredSections };
      if (holes || overlap || combinedHoles) report.failedWitness = { ...row, witnesses,
        precision: g.renderer.capabilities.precision,
        shaders: g.renderer.info.programs.filter(program => program.cacheKey.includes("detail-volume"))
          .map(program => gl.getShaderSource(program.fragmentShader).match(/precision [^;]+;|(?:in|varying) [^;]*vDetailPosition;/g)) };
      if (assertClean) {
        check(tested > 100, `${label}: insufficient unfogged pixels`);
        check(combinedHoles === 0, `${label}: combined image has a hole`);
        check(holes === 0 && overlap === 0, `${label}: ${holes} holes / ${overlap} overlapping pixels`);
        report.phases.push(row);
      }
      return row;
    };
    // No native detail is present while the actual coarse layer publishes.
    for (let i = 0; i < 1000 && !g.distant.ready; i++) update();
    report.startup = { sky: g.skyAccess, mediumKnown: g.atmosphere.cameraMediumKnown,
      camera: g.camera.position.toArray(), spec: world.spec, biome: g.biome,
      radius: g.renderRadius, job: g.distant._job?.phase, publication: g.distant.publication.state };
    check(g.distant._active?.data.request.bootstrap, "coarse phase not exercised");
    for (let i = 0; i < 12; i++) update();
    audit("coarse-only");
    phase = "native-handoff";
    for (let z = -2; z <= 2; z++) for (let x = -2; x <= 2; x++) {
      world.admit(originX / 16 + x, z);
      for (let dz = 0; dz < 16; dz++) for (let dx = 0; dx < 16; dx++)
        world.put(originX + x * 16 + dx, 31, z * 16 + dz, BLOCK.GRASS);
    }
    let partial = false, pixelCenterBoundary = false;
    for (let i = 0; i < 400; i++) {
      update(true);
      if (i % 4 === 0 && g.distant.ready) {
        const row = audit(`native-step-${i}`);
        partial ||= row.nativePixels > 0 && row.lodPixels > 0;
        if (partial && !pixelCenterBoundary) {
          const perspective = g.camera;
          const ortho = new THREE.OrthographicCamera(-32.5, 31.5, 31.5, -32.5, 0.05, 512);
          ortho.up.set(0, 0, -1);
          ortho.position.set(originX + 8, 96, 8);
          ortho.lookAt(originX + 8, 32, 8);
          g.camera = ortho;
          try {
            update();
            const tied = audit("pixel-center-unit-boundary");
            check(tied.nativePixels > 0 && tied.lodPixels > 0, "pixel-center boundary control is not mixed");
            pixelCenterBoundary = true;
          } finally { g.camera = perspective; update(); }
        }
      }
      if (g.detailCoverage().size === 25) break;
    }
    check(partial, "mixed native/LOD phase not exercised");
    check(g.detailCoverage().size === 25, "native control did not finish");
    phase = "refinement";
    for (let i = 0; i < 1000 && g.distant._active.data.request.bootstrap; i++) {
      update();
      if (i % 8 === 0) audit(`refine-step-${i}`);
    }
    check(!g.distant._active.data.request.bootstrap, "fine replacement not exercised");
    audit("fine-native");
    phase = "movement-reversal";
    for (const x of [24, 56, 104, 56, 24, 8]) {
      pose(x);
      update();
      audit(`move-${x}`);
    }
    // Positive failure controls prove the GPU oracle rejects both a missing
    // fallback and a broken ownership shader, not just reassuring metadata.
    phase = "negative-controls";
    const active = g.distant._active, mask = g.distant.detailMask;
    const originalMask = mask.data.slice();
    const request = { ...active.data.request, coverage: new Set(), coverageKey: "negative-control" };
    g.distant._cutout(active, request);
    audit("mask-only-ownership");
    mask.data.fill(0); mask.texture.value.needsUpdate = true;
    report.controls.brokenMask = audit("broken-mask", false);
    check(report.controls.brokenMask.overlap > 0, "broken mask escaped overlap oracle");
    mask.data.set(originalMask); mask.texture.value.needsUpdate = true;
    const drawnHorizon = g.distant.fogDistance;
    g.distant.group.visible = false;
    report.controls.missingFallback = audit("missing-fallback", false, drawnHorizon);
    check(report.controls.missingFallback.tested > 100, "missing fallback control must test the drawn footprint");
    check(report.controls.missingFallback.holes > 0, "missing fallback escaped hole oracle");
    g.distant.group.visible = true;
    update();
    audit("restored");
    report.elapsedWallMs = performance.now() - started;
    report.resourceScope = "GL buffer allocations observed directly; native accounting includes mask. LOD typed backing excludes JS object/array overhead and pending canopy JS arrays; GL buffer bytes exclude textures.";
    report.passed = true;
    target.dispose();
    return report;
  } finally {
    g?.dispose();
    WebGL2RenderingContext.prototype.bufferData = bufferData;
    WebGL2RenderingContext.prototype.deleteBuffer = deleteBuffer;
  }
}
