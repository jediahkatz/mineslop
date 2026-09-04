// TEST ONLY: real WebGL material readbacks on authored resident columns.
// No Game, save, generator, input controls, RAF loop, or native GUI is involved.
import * as THREE from "three";
import { BLOCK } from "../src/blocks.js";
import { CaveDaylight } from "../src/cave-daylight.js";
import { sampleDaylightAt } from "../src/daylight-material.js";
import { localLightStyle } from "../src/local-lighting.js";
import { buildChunkGeometry, GameRenderer } from "../src/renderer.js";
import { ENTRANCE_SURFACES, surfaceAirPoint, surfaceTunnel } from "./daylight-surface-fixture.js";

const SIZE = 65; // Odd size: the center pixel's ray passes through the exact probe point.
const READBACK_ZOOM = 16; // Magnify only the point sampler, never the lighting observer.
const MAX_READBACKS = 320;
const luma = (rgba) => rgba[0] * 0.2126 + rgba[1] * 0.7152 + rgba[2] * 0.0722;
const summarize = (points) => {
  const values = points.map((point) => point.encodedLuma).sort((a, b) => a - b);
  return { count: values.length, min: values[0], median: values[Math.floor(values.length / 2)], max: values.at(-1), mean: values.reduce((a, b) => a + b, 0) / values.length };
};

export function runSurfaceLightingProbe({ fullDepth = true } = {}) {
  const fixture = surfaceTunnel(fullDepth);
  const deepX = fullDepth ? 50.5 : 32.5;
  const g = new GameRenderer(document.querySelector("#surface-probe"), fixture.world);
  const ray = new THREE.Raycaster();
  const view = g.camera.clone();
  const pixel = new Uint8Array(4);
  let readbacks = 0, maxDrawCalls = 0, frame = 0;
  let lastWork = {}, renderMs = 0;
  const geometry = [];
  const worldSignature = () => JSON.stringify({
    version: fixture.world.generatorVersion,
    epoch: fixture.world.epoch,
    chunks: [...fixture.world.chunks].map(([key, chunk]) => [key, chunk.revision, chunk.incarnation, chunk.blocks.length]),
  });
  const meshColumn = (key) => {
    g.removeChunk(key);
    const [cx, cz] = key.split(",").map(Number);
    const group = new THREE.Group();
    group.position.set(cx * 16, 0, cz * 16);
    group.userData = { cx, cz, meshed: true, emitters: [] };
    for (const [batch, data] of Object.entries(buildChunkGeometry(fixture.world, cx, cz, g.atlas))) {
      if (!data) continue;
      const mesh = new THREE.Mesh(data, g.materials[batch]);
      group.add(mesh);
    }
    g.chunks.set(key, group);
    g.scene.add(group);
  };
  try {
    g.setQuality("medium");
    g.setTime(0.5);
    g.renderer.setPixelRatio(1);
    g.renderer.setSize(SIZE, SIZE);
    g.camera.aspect = 1;
    g.camera.updateProjectionMatrix();
    // Controlled material lane: remove fog as a confound, not as a proposed fix.
    // The native walk separately exercises production fog/streaming.
    for (const material of Object.values(g.materials)) material.fog = false;
    for (const key of fixture.world.chunks.keys()) meshColumn(key);
    fixture.world.dirtyChunks.clear();
    g.scene.updateMatrixWorld(true);
    for (const group of g.chunks.values())
      group.traverse((mesh) => { if (mesh.isMesh) geometry.push(mesh.geometry.uuid); });
    const gl = g.renderer.getContext();
    const debug = gl.getExtension("WEBGL_debug_renderer_info");
    const settings = {
      fixtureOnly: true, fixtureVersion: fixture.world.generatorVersion, residentColumns: fixture.world.chunks.size,
      outputColorSpace: g.renderer.outputColorSpace, toneMapping: g.renderer.toneMapping,
      toneMappingExposure: g.renderer.toneMappingExposure, fog: false,
      width: gl.drawingBufferWidth, height: gl.drawingBufferHeight, maxReadbacks: MAX_READBACKS,
      renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
      softwareRendering: g.softwareRendering, readbackZoom: READBACK_ZOOM, fullDepth, deepX,
    };
    const signatureBefore = worldSignature();
    const observer = (x, cold = false) => {
      g.setFullbrightInspection(false);
      g.camera.position.copy(fixture.position(x));
      g.camera.lookAt(2.53125, 11, 2.53125);
      if (cold && g.skyColumns) g.caveDaylight = new CaveDaylight(g.skyColumns);
      const started = performance.now(), totals = {}, peak = {};
      let frames = 0;
      do {
        g.update(0, ++frame, { x, y: 8, z: 2.5 });
        frames++;
        for (const [key, value] of Object.entries(g.skyColumns.stats)) {
          totals[key] = (totals[key] ?? 0) + value;
          peak[key] = Math.max(peak[key] ?? 0, value);
        }
        if (frames > 81) throw new Error("Surface lighting failed to settle within the fixed tile budget");
      } while (g.skyColumns.surfaceLight?.pending > 0);
      lastWork = { frames, updateMs: performance.now() - started, totals, peak };
      // The longer route crosses the renderer's hidden retention ring. Restore
      // its authored resident meshes just as the normal dirty queue would.
      for (const key of fixture.world.chunks.keys()) {
        const [cx, cz] = key.split(",").map(Number);
        if (Math.abs(cx - Math.floor(x / 16)) <= g.renderRadius &&
            Math.abs(cz) <= g.renderRadius && !g.chunks.has(key)) meshColumn(key);
      }
    };
    const readPoint = (surface) => {
      if (++readbacks > MAX_READBACKS) throw new Error("Authored probe exceeded its fixed readback budget");
      view.copy(g.camera);
      view.lookAt(surface.point.x, surface.point.y, surface.point.z);
      // At grazing angles a whole stone texel can occupy <1/256 of a raster
      // pixel. Magnify around the identical center ray so subpixel triangle
      // rounding cannot swap texels as the observer moves. Fullbright controls
      // below must still prove that every station reads the same albedo.
      view.zoom = READBACK_ZOOM;
      view.updateProjectionMatrix();
      view.updateMatrixWorld(true);
      g.scene.updateMatrixWorld(true);
      ray.setFromCamera(new THREE.Vector2(0, 0), view);
      const meshes = [];
      for (const group of g.chunks.values())
        if (group.visible) group.traverse((mesh) => { if (mesh.isMesh) meshes.push(mesh); });
      const hit = ray.intersectObjects(meshes, false)[0];
      const target = new THREE.Vector3(surface.point.x, surface.point.y, surface.point.z);
      if (!hit || hit.point.distanceTo(target) > 0.0001)
        throw new Error(`Probe ${surface.name} does not hit its fixed terrain face at observer x=${view.position.x}`);
      const position = hit.object.geometry.attributes.position;
      const color = hit.object.geometry.attributes.color;
      const ids = [hit.face.a, hit.face.b, hit.face.c];
      const triangle = ids.map((id) => new THREE.Vector3().fromBufferAttribute(position, id));
      const bary = THREE.Triangle.getBarycoord(hit.object.worldToLocal(hit.point.clone()), ...triangle, new THREE.Vector3());
      const weights = bary.toArray();
      const vertexColor = [0, 1, 2].map((channel) =>
        ids.reduce((sum, id, index) => sum + color.array[id * 3 + channel] * weights[index], 0));
      const started = performance.now();
      g.renderer.render(g.scene, view);
      gl.readPixels((SIZE - 1) / 2, (SIZE - 1) / 2, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
      renderMs += performance.now() - started;
      maxDrawCalls = Math.max(maxDrawCalls, g.renderer.info.render.calls);
      const error = gl.getError();
      if (error || gl.isContextLost()) throw new Error(`WebGL readback failed: ${error}`);
      return {
        name: surface.name, point: hit.point.toArray(), normal: hit.face.normal.toArray(),
        uv: hit.uv.toArray(), vertexColor, rgba: [...pixel], encodedLuma: luma(pixel),
        mask: sampleDaylightAt(g.skyColumns, surfaceAirPoint(surface)),
      };
    };
    const readPoints = (surfaces) => surfaces.map(readPoint);
    const state = () => ({
      camera: g.camera.position.toArray(), exposure: g.skyAccess.exposure, directSky: g.skyAccess.directSky,
      known: g.skyAccess.known, skyVisible: g.skyAccess.skyVisible, apertureDistance: g.skyAccess.apertureDistance,
      cameraDiagnostics: {
        anchors: g.caveDaylight.anchors.map((point) => ({ ...point })),
        sources: g.skyAccess.sources.map((point) => ({ ...point })),
      },
      floorSky: g.daylightMaterial.uniforms.uCaveSky.value.toArray(),
      floorGround: g.daylightMaterial.uniforms.uCaveGround.value.toArray(),
      field: g.daylightMaterial.uniforms.uSkyField.value.toArray(),
      work: {
        ...g.skyColumns.stats, rays: g.skyAccess.rays, bytes: g.skyColumns.data.byteLength,
        cache: g.skyColumns.cache.size, ...lastWork,
        surface: g.skyColumns.surfaceLight?.resources(),
      },
    });
    const station = (x, cold = false) => {
      observer(x, cold);
      const result = { ...state(), natural: readPoints(ENTRANCE_SURFACES) };
      g.setFullbrightInspection(true);
      result.fullbright = readPoints(ENTRANCE_SURFACES);
      g.setFullbrightInspection(false);
      return result;
    };
    const outside = [-28.5, -16.5, -8.5, -0.5].map((x) => station(x, true));
    const walking = [4.5, 8.5, 12.5, 15.5, 16, 16.5, 24.5, 32.5, ...(fullDepth ? [40.5, 50.5] : [])].map((x) => station(x));
    const coldDeep = station(deepX, true);
    const returned = station(4.5);

    observer(deepX, true);
    const deepAccess = state();
    const swatches = [];
    for (const [row, v] of [0.15625, 0.53125, 0.84375].entries())
      for (const [column, u] of [0.15625, 0.53125, 0.84375].entries()) {
        swatches.push({ name: `roof-${row}-${column}`, point: { x: Math.floor(deepX) + u, y: 11, z: 2 + v }, normal: { x: 0, y: -1, z: 0 } });
        swatches.push({ name: `wall-${row}-${column}`, point: { x: Math.floor(deepX) + u, y: 9 + v, z: 1 }, normal: { x: 0, y: 0, z: 1 } });
        swatches.push({ name: `floor-${row}-${column}`, point: { x: Math.floor(deepX) + u, y: 8, z: 2 + v }, normal: { x: 0, y: 1, z: 0 } });
      }
    const lanes = {};
    const capture = (name) => {
      const points = readPoints(swatches);
      lanes[name] = {
        points, all: summarize(points),
        faces: Object.fromEntries(["roof", "wall", "floor"].map((face) => [face, summarize(points.filter((point) => point.name.startsWith(face)))])),
      };
    };
    capture("default");
    // TEST-ONLY A/B diagnostics, restored before every behavioral assertion.
    g.renderer.toneMapping = THREE.NoToneMapping;
    capture("withoutToneMapping");
    g.renderer.toneMapping = settings.toneMapping;
    g.materials.opaque.vertexColors = false;
    g.materials.opaque.needsUpdate = true;
    capture("withoutVertexShade");
    g.materials.opaque.map = null;
    g.materials.opaque.needsUpdate = true;
    capture("whiteWithoutVertexShade");
    g.materials.opaque.map = g.atlas.texture;
    g.materials.opaque.vertexColors = true;
    g.materials.opaque.needsUpdate = true;
    g.setFullbrightInspection(true);
    capture("fullbright");
    g.setFullbrightInspection(false);
    const torch = g.localLights[0];
    const style = localLightStyle(BLOCK.TORCH);
    torch.visible = true;
    torch.position.set(deepX, 9.7, 2.5);
    torch.color.set(style.color);
    torch.intensity = style.intensity;
    torch.distance = style.distance;
    capture("fixtureTorch");
    torch.intensity = 0;
    capture("restored");
    const signatureAfterPhotometry = worldSignature();
    const restoredSettings = {
      toneMapping: g.renderer.toneMapping, outputColorSpace: g.renderer.outputColorSpace,
      toneMappingExposure: g.renderer.toneMappingExposure, vertexColors: g.materials.opaque.vertexColors,
      atlasRestored: g.materials.opaque.map === g.atlas.texture, fullbright: g.fullbrightInspection,
      localIntensities: g.localLights.map((light) => light.intensity),
    };

    fixture.close();
    meshColumn("-1,0");
    const closed = station(4.5);
    fixture.close(false);
    meshColumn("-1,0");
    const reopened = station(4.5);

    g.camera.position.set(-4.5, 14, 2.5);
    g.update(0, ++frame, { x: -4.5, y: 12.38, z: 2.5 });
    const topFace = { name: "exposed-stone", point: { x: 2.53125, y: 12, z: 2.53125 }, normal: { x: 0, y: 1, z: 0 } };
    const exterior = readPoint(topFace);
    g.daylightMaterial.uniforms.uDaylightEnabled.value = 0;
    const originalExterior = readPoint(topFace);
    g.daylightMaterial.uniforms.uDaylightEnabled.value = 1;

    fixture.close();
    meshColumn("-1,0");
    // A nearby opaque addition consumes the near-camera rebuild slots. A
    // stone-to-dirt wall swap is now correctly light-irrelevant. Keep this
    // blocker outside the sampled rays so the remote entrance must clear
    // before its tile can be rebuilt, without hiding the measured faces.
    fixture.world.put(Math.floor(deepX), 9, 8, BLOCK.DIRT);
    meshColumn(`${Math.floor(deepX / 16)},0`);
    g.camera.position.copy(fixture.position(deepX));
    g.update(0, ++frame, { x: deepX, y: 8, z: 2.5 });
    const closedFirstFrame = {
      natural: readPoints(ENTRANCE_SURFACES), work: { ...g.skyColumns.stats },
      pending: g.skyColumns.surfaceLight?.pending,
      entranceTilePending: g.skyColumns.surfaceLight?.waiting.has("0,0"),
    };
    fixture.close(false);
    for (let x = 1; x <= 5; x++)
      for (let z = 5; z <= 8; z++)
        for (let y = 7; y <= 11; y++)
          if (x === 1 || x === 5 || z === 5 || z === 8 || y === 7 || y === 11)
            fixture.world.put(x, y, z, BLOCK.STONE);
    meshColumn("0,0");
    meshColumn("-1,0");
    g.camera.position.set(2.5, 9.62, 6.5);
    g.update(0, ++frame, { x: 2.5, y: 8, z: 6.5 });
    const roomFace = { name: "sealed-room", point: { x: 2.53125, y: 9.53125, z: 6 }, normal: { x: 0, y: 0, z: 1 } };
    const sealedRoom = readPoint(roomFace);
    g.setFullbrightInspection(true);
    const roomFullbright = readPoint(roomFace);
    g.setFullbrightInspection(false);
    return {
      settings, outside, walking, coldDeep, returned, deepAccess, lanes, closed, reopened,
      signatureBefore, signatureAfterPhotometry, restoredSettings, geometry,
      exterior, originalExterior, closedFirstFrame, sealedRoom, roomFullbright,
      torchFixture: { kind: "canonical torch PointLight only; not gameplay placement", ...style },
      readbacks, maxDrawCalls, renderMs, programs: g.renderer.info.programs.length,
      resources: { ...g.renderer.info.memory, surface: g.skyColumns.surfaceLight?.resources() },
      failedPrograms: g.renderer.info.programs.filter((program) => program.diagnostics?.runnable === false).length,
      contextLost: gl.isContextLost(), glError: gl.getError(),
    };
  } finally {
    g.dispose();
  }
}
