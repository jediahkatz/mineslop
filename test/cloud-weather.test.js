import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { CloudField } from "../src/cloud-field.js";
import { WeatherState, normalizeWeatherSnapshot, precipitationPolicy } from "../src/weather-state.js";
import { WeatherExposure } from "../src/weather-exposure.js";
import { WeatherRender, RAIN_PARTICLES } from "../src/weather-render.js";
import { GameWeatherServices, normalizeWeatherArchive } from "../src/game-weather-services.js";
import { World } from "../src/world.js";
import { BLOCK } from "../src/blocks.js";
import { BIOME_INDEX } from "../src/biomes.js";

function world() {
  const chunk = { revision: 0, biomes: new Uint8Array(256).fill(BIOME_INDEX.plains) };
  return {
    seed: "weather-test", epoch: 0, dimension: "overworld",
    spec: { minY: -64, maxY: 320 }, chunks: new Map(),
    loaded: true, roof: -65, reads: 0,
    isLoaded() { return this.loaded; },
    getCell(x, y) { this.reads++; return this.loaded ? { id: y === this.roof ? 1 : 0 } : null; },
    getBiome() { return { category: "plains", temperature: 0.6 }; },
    chunk,
  };
}

test("cloud identities anchor to world, drift independently and recycle only outgoing cells", () => {
  const field = new CloudField("seed");
  const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial(), 108);
  const point = { x: 0, y: 80, z: 0 };
  field.update(mesh, point, 0, { maxY: 320 });
  const old = new Map(field.slots.map((s) => [s.key, { ...s }]));
  const worldX = (slot) => {
    const matrix = new THREE.Matrix4(); mesh.getMatrixAt(slot * 3, matrix);
    return mesh.position.x + matrix.elements[12];
  };
  const oldX = new Map(field.slots.map((s) => [s.key, worldX(s.slot)]));
  field.update(mesh, { ...point, x: 10 }, 0, { maxY: 320 });
  for (const s of field.slots) {
    assert.deepEqual(s, old.get(s.key));
    assert.equal(worldX(s.slot), oldX.get(s.key));
  }
  field.update(mesh, { ...point, x: 47 }, 0, { maxY: 320 });
  assert.equal(field.slots.length, 36);
  assert.equal(field.slots.filter((s) => old.has(s.key)).length, 30);
  for (const s of field.slots) if (old.has(s.key)) {
    assert.equal(s.slot, old.get(s.key).slot);
    assert.ok(Math.abs(worldX(s.slot) - oldX.get(s.key)) < 0.00002);
  }
  const before = new THREE.Matrix4();
  const after = new THREE.Matrix4();
  const surviving = field.slots.find((s) => s.key === "0,0").slot * 3;
  mesh.getMatrixAt(surviving, before);
  const origin = mesh.position.clone();
  field.update(mesh, { ...point, x: 47 }, 1, { maxY: 320 });
  mesh.getMatrixAt(surviving, after);
  assert.ok(Math.abs(after.elements[12] + mesh.position.x - before.elements[12] - origin.x - 0.3) < 1e-5);
  assert.equal(mesh.count, 108);
  assert.ok(after.elements[13] >= 332);
});

test("cloud CPU origins keep signed large coordinates out of Float32 instance translations", () => {
  const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial(), 108);
  for (const x of [-29_999_999.25, 29_999_999.25]) {
    const a = new CloudField("seed"), b = new CloudField("seed");
    a.update(mesh, { x, z: -x }, 157, { maxY: 128 });
    assert.ok(Math.abs(mesh.position.x - x) < 47);
    for (let i = 0; i < 108; i++) {
      const m = new THREE.Matrix4(); mesh.getMatrixAt(i, m);
      assert.ok(Math.abs(m.elements[12]) < 180);
      assert.ok(Math.abs(m.elements[14]) < 180);
    }
    b.update(mesh, { x, z: -x }, 157, { maxY: 128 });
    assert.deepEqual(a.slots, b.slots);
  }
});

test("weather schedule is bounded deterministic, pauses, and restores exactly", () => {
  const a = new WeatherState("seed"), b = new WeatherState("seed");
  a.advance(734);
  b.advance(400); b.advance(334);
  assert.deepEqual(a.sample(), b.sample());
  const saved = a.serialize();
  a.advance(100, false);
  assert.deepEqual(a.serialize(), saved);
  const restored = new WeatherState("seed", saved);
  assert.deepEqual(restored.sample(), a.sample());
  const phases = new Set();
  for (let i = 0; i < 240; i++) {
    restored.advance(10);
    const sample = restored.sample();
    phases.add(sample.phase);
    assert.ok(sample.intensity >= 0 && sample.intensity <= 1);
  }
  assert.deepEqual([...phases].sort(), ["clear", "rain"]);
  assert.deepEqual(normalizeWeatherSnapshot(undefined), { version: 1, elapsed: 0 });
  for (const bad of [null, {}, { version: 2, elapsed: 1 }, { version: 1, elapsed: -1 }, { version: 1, elapsed: Infinity }])
    assert.equal(normalizeWeatherSnapshot(bad), null);
  assert.equal(normalizeWeatherSnapshot({ version: 1, get elapsed() { throw Error("accessor invoked"); } }), null);
  assert.equal(normalizeWeatherArchive({ get weather() { throw Error("accessor invoked"); } }), null);
  assert.equal(normalizeWeatherSnapshot({ version: 1, elapsed: 1e13 }), null);
});

test("precipitation policy explicitly excludes cold, dry and non-Overworld biomes", () => {
  for (const category of ["desert", "badlands", "savanna", "snowy", "cave"])
    assert.equal(precipitationPolicy({ category, temperature: 0.6 }, "overworld"), "none");
  assert.equal(precipitationPolicy({ category: "ocean", temperature: 0 }, "overworld"), "none");
  assert.equal(precipitationPolicy({ category: "forest", temperature: 0.5 }, "nether"), "none");
  assert.equal(precipitationPolicy({ category: "forest", temperature: 0.5 }, "overworld"), "rain");
  assert.equal(precipitationPolicy(null, "overworld"), "none");
});

test("roof scans are loaded-only, bounded and invalidate edits, eviction, epoch and source", () => {
  const w = world(), exposure = new WeatherExposure();
  const key = "0,0"; w.chunks.set(key, w.chunk);
  exposure.beginFrame(w);
  assert.equal(exposure.roof(1, 1).known, true);
  assert.ok(w.reads <= 384);
  w.roof = 100; w.chunk.revision++;
  exposure.beginFrame(w);
  assert.equal(exposure.roof(1, 1).y, 100);
  w.roof = -65; w.chunk.revision++;
  exposure.beginFrame(w);
  assert.equal(exposure.roof(1, 1).y, -65);
  w.loaded = false; w.chunks.delete(key);
  exposure.beginFrame(w); assert.equal(exposure.roof(1, 1).known, false);
  w.loaded = true; w.roof = 120; w.chunks.set(key, { revision: 0 });
  exposure.beginFrame(w); assert.equal(exposure.roof(1, 1).y, 120);
  w.epoch++; w.roof = 110;
  exposure.beginFrame(w); assert.equal(exposure.roof(1, 1).y, 110);
  const other = world(); other.roof = 99; other.chunks.set(key, other.chunk);
  exposure.beginFrame(other); assert.equal(exposure.roof(1, 1).y, 99);
  exposure.beginFrame(other); const before = other.reads;
  for (let i = 0; i < 200; i++) exposure.roof(i, 1);
  assert.ok(other.reads - before <= 2048);
  assert.ok(exposure.cache.size <= 64);
});

test("rain uses a fixed disposable particle pool and never mutates world cells", () => {
  const w = world();
  for (let z = -2; z <= 2; z++) for (let x = -2; x <= 2; x++) w.chunks.set(`${x},${z}`, w.chunk);
  const scene = new THREE.Scene(), render = new WeatherRender(scene);
  const positions = render.positions;
  let result;
  for (let i = 0; i < 20; i++)
    result = render.update(w, { x: 0, y: 80, z: 0 }, { elapsed: i, intensity: 1 });
  assert.ok(render.object.geometry.drawRange.count > 0);
  assert.ok(render.object.geometry.drawRange.count <= RAIN_PARTICLES * 2);
  assert.ok(result.level > 0 && result.level <= 0.35);
  assert.equal(render.positions, positions);
  w.roof = 95; w.chunk.revision++;
  render.update(w, { x: 0, y: 80, z: 0 }, { elapsed: 21, intensity: 1 });
  assert.equal(render.object.geometry.drawRange.count, 0);
  w.dimension = "nether";
  result = render.update(w, { x: 0, y: 80, z: 0 }, { elapsed: 22, intensity: 1 });
  assert.equal(render.object.visible, false);
  assert.equal(result.level, 0);
  render.dispose(); render.dispose();
  assert.equal(scene.children.length, 0);
});

test("detached ownership, pause/hidden/dead gates, epoch travel and rollback preserve schedule", () => {
  const w = world(), scene = new THREE.Scene();
  const game = { world: w, graphics: { scene }, simulating: true, gameplay: {} };
  const service = new GameWeatherServices({ world: w });
  assert.equal(scene.children.length, 0);
  assert.equal(service.frame(0.1).ok, false);
  assert.equal(service.activate(game).ok, true);
  service.frame(0.1);
  assert.equal(service.serialize().weather.elapsed, 0.1);
  for (const flag of ["paused", "building", "failed", "hidden"]) {
    game[flag] = true; service.frame(0.1); game[flag] = false;
  }
  game.gameplay.dead = true; service.frame(0.1); game.gameplay.dead = false;
  assert.equal(service.serialize().weather.elapsed, 0.1);
  game.inventoryOpen = true; service.frame(0.1);
  assert.equal(service.serialize().weather.elapsed, 0.2);
  const before = service.serialize();
  w.dimension = "nether"; w.epoch++;
  assert.equal(service.frame(0.1).ok, false);
  assert.equal(service.rebindWorldEpoch().ok, true);
  service.frame(0.1);
  assert.ok(service.serialize().weather.elapsed > before.weather.elapsed);
  const traveled = service.serialize();
  w.dimension = "overworld"; w.epoch++;
  assert.equal(service.rebindWorldEpoch().ok, true);
  assert.deepEqual(service.serialize(), traveled);
  const candidate = new GameWeatherServices({ world: w, saved: traveled });
  assert.equal(candidate.activate(game).ok, false);
  candidate.dispose();
  assert.deepEqual(service.serialize(), traveled);
  service.dispose(); service.dispose();
  assert.equal(game.weatherServices, null);
  assert.equal(scene.children.length, 0);
  assert.equal(service.frame(0.1).ok, false);
  assert.throws(() => new GameWeatherServices({ world: w, saved: { weather: null } }));
});

test("clouds cross the old wind wrap continuously and their window remains bounded after a teleport", () => {
  const field = new CloudField("wrap");
  const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial(), 108);
  const camera = { x: 12, z: 12 };
  field.update(mesh, camera, 47 / 0.3 - 0.01, { maxY: 128 });
  const slot = field.slots.find((s) => s.key === "0,0").slot * 3;
  const a = new THREE.Matrix4(), b = new THREE.Matrix4();
  mesh.getMatrixAt(slot, a);
  const x = a.elements[12] + mesh.position.x;
  field.update(mesh, camera, 47 / 0.3 + 0.01, { maxY: 128 });
  mesh.getMatrixAt(slot, b);
  assert.ok(Math.abs(b.elements[12] + mesh.position.x - x - 0.006) < 0.00002);
  field.update(mesh, { x: -29_000_000, z: 29_000_000 }, 6000, { maxY: 320 });
  assert.equal(field.slots.length, 36);
  assert.equal(new Set(field.slots.map((s) => s.key)).size, 36);
  assert.equal(new Set(field.slots.map((s) => s.slot)).size, 36);
});

test("loaded real World roof edits and eviction never fall back to air-returning get()", async () => {
  const w = new World("weather-loaded-roof", { useWorker: false, generatorVersion: 4 });
  try {
    await w.ensureArea({ x: 0, z: 0 }, 0);
    const exposure = new WeatherExposure();
    exposure.beginFrame(w);
    const before = exposure.roof(0, 0);
    assert.equal(before.known, true);
    const roofY = w.maxY - 2;
    assert.equal(w.set(0, roofY, 0, BLOCK.GLASS), true);
    exposure.beginFrame(w);
    assert.equal(exposure.roof(0, 0).y, roofY);
    assert.equal(w.set(0, roofY, 0, BLOCK.AIR), true);
    exposure.beginFrame(w);
    assert.deepEqual(exposure.roof(0, 0), before);
    w.chunks.delete("0,0");
    assert.equal(w.get(0, roofY, 0), BLOCK.AIR);
    const chunkCount = w.chunks.size;
    exposure.beginFrame(w);
    assert.equal(exposure.roof(0, 0).known, false);
    assert.equal(w.chunks.size, chunkCount);
  } finally { w.dispose(); }
});

test("pending tall-world scans suppress rain and finish under a hard per-frame budget", () => {
  const w = world(), exposure = new WeatherExposure();
  for (let x = 0; x < 20; x++) w.chunks.set(`${x},0`, w.chunk);
  exposure.beginFrame(w);
  let unknown = 0;
  for (let x = 0; x < 100; x++) if (!exposure.roof(x, 0).known) unknown++;
  assert.ok(unknown > 90);
  assert.equal(exposure.reads, 2048);
  assert.equal(exposure.cache.size, 64);
  for (const entry of exposure.cache.values()) assert.equal("chunk" in entry, false);
  exposure.beginFrame(w);
  assert.equal(exposure.roof(99, 0).known, true);
  assert.ok(exposure.reads <= 384);
});

test("render projections mute same-frame death, unknown water medium and replaced hosts", () => {
  const w = world();
  for (let z = -2; z <= 2; z++) for (let x = -2; x <= 2; x++) w.chunks.set(`${x},${z}`, w.chunk);
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera();
  camera.position.set(0, 80, 0);
  const game = { world: w, graphics: { scene, camera, atmosphere: {} }, simulating: true, gameplay: {} };
  const service = new GameWeatherServices({ world: w, saved: { weather: { version: 1, elapsed: 1000 } } });
  service.activate(game); service.frame(0.1); service.render();
  assert.ok(service.desiredAudio.level > 0);
  game.gameplay.dead = true; service.render();
  assert.equal(service.desiredAudio.level, 0);
  assert.equal(service.renderer.object.visible, false);
  game.gameplay.dead = false; service.frame(0.1);
  game.graphics.atmosphere.cameraMediumKnown = false; service.render();
  assert.equal(service.desiredAudio.level, 0);
  game.graphics.atmosphere.cameraMediumKnown = true;
  game.world = world(); service.render();
  assert.equal(service.desiredAudio.level, 0);
  assert.equal(service.rebindWorldEpoch().ok, false);
  service.dispose();
  assert.equal(scene.children.length, 0);
});
