import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { BLOCK } from "../src/blocks.js";
import { normalizeGeneratedChunk, readChunkCell } from "../src/chunk-data.js";
import { stageWorld } from "../src/game-world-stage.js";
import { createGenerator } from "../src/terrain.js";
import { browserJob, sameNativeChunk, v7BrowserCases } from "./terrain-v7-browser-contract.js";
import { assertV7BrowserBuild, readV7BrowserHost, v7BuiltScripts, V7_BROWSER_SOURCE } from "./terrain-v7-browser-host.js";
import { runV7NativeStaging } from "./terrain-v7-browser-staging.js";

test("v7 browser prerequisite guard requires frozen source, label, compiled assets and fresh origin", () => {
  const base = readV7BrowserHost("http://127.0.0.1:6550/");
  const build = { fixture: "terrain-v7-worker", production: true, development: false,
    hmr: false, source: V7_BROWSER_SOURCE, label: "v7-source-verified" };
  assert.doesNotThrow(() => assertV7BrowserBuild(build, V7_BROWSER_SOURCE, build.label));
  for (const patch of [{ source: "main" }, { label: null }, { hmr: true },
    { development: true }, { production: false }, { fixture: "game" }])
    assert.throws(() => assertV7BrowserBuild({ ...build, ...patch }));
  assert.throws(() => assertV7BrowserBuild(build, V7_BROWSER_SOURCE, "different-build"));
  for (const address of [undefined, "http://localhost:6550", "http://127.0.0.1:5173", "https://example.com:6550"])
    assert.throws(() => readV7BrowserHost(address));
  const meta = '<meta name="voxelcraft-test-fixture" content="terrain-v7-worker">';
  const script = '<script type="module" src="/assets/v7-native-123.js"></script>';
  assert.deepEqual(v7BuiltScripts(meta + script, base), [`${base.origin}/assets/v7-native-123.js`]);
  for (const html of [
    meta, script, `${meta}<script type="module" src="/@vite/client"></script>`,
    `${meta}<script type="module" src="/src/terrain.js"></script>`,
    `${meta}<script type="module" src="https://example.com/assets/a.js"></script>`,
    `<base href="/"> ${meta}${script}`, `${meta}<script type="module">alert(1)</script>`,
    readFileSync(new URL("./terrain-v7-worker.html", import.meta.url), "utf8"),
  ]) assert.throws(() => v7BuiltScripts(html, base));
});

test("exactly five browser cases contain real pillar, bowl and native structure cells", () => {
  const cases = v7BrowserCases();
  assert.deepEqual(cases.map(({ label }) => label), ["pillar0", "pillar5", "bowl", "shipwreck", "nether_fortress"]);
  let stateful = false;
  for (const entry of cases) {
    const gen = createGenerator(entry.seed, entry.dimension, 7);
    const job = browserJob(entry.seed, entry.dimension, 7, entry.cx, entry.cz, 1);
    const raw = gen.generateChunk(entry.cx, entry.cz), chunk = normalizeGeneratedChunk(raw, job);
    sameNativeChunk(chunk, normalizeGeneratedChunk(gen.generateChunk(entry.cx, entry.cz), job));
    stateful ||= [...chunk.sections.values()].some((section) => section.states);
    const at = (x, y, z) => (y - chunk.minY) * 256 + (z - entry.cz * 16) * 16 + x - entry.cx * 16;
    if (entry.pillar) {
      assert.equal(readChunkCell(chunk, at(entry.x, entry.pillar.top, entry.z)).id, BLOCK.OBSIDIAN);
      assert.equal(readChunkCell(chunk, at(entry.x, entry.pillar.cap.y, entry.z)).id, BLOCK.GLOWSTONE);
    }
    if (entry.structureId) {
      assert.ok(chunk.structures.some(({ id }) => id === entry.structureId));
      const p = entry.marker.position;
      assert.equal(readChunkCell(chunk, at(p.x, p.y, p.z)).id, BLOCK[entry.marker.block]);
    }
    if (entry.label === "bowl") {
      const col = gen.sampleColumn(entry.x, entry.z);
      assert.ok(col.top - col.bottom >= 16);
      assert.equal(readChunkCell(chunk, at(entry.x, col.top, entry.z)).id, BLOCK.END_STONE);
    }
    const changed = structuredClone(chunk); changed.blocks[0] = BLOCK.DIRT;
    assert.throws(() => sameNativeChunk(changed, chunk), /blocks/);
    for (const plane of ["states", "fluids"]) {
      const section = [...chunk.sections.values()].find((value) => value[plane]);
      if (!section) continue;
      const changedPlane = structuredClone(chunk);
      changedPlane.sections.get(section.sy)[plane][0] ^= 1;
      assert.throws(() => sameNativeChunk(changedPlane, chunk), new RegExp(plane));
    }
    const declaration = structuredClone(chunk); declaration.structures = [];
    if (entry.structureId) assert.throws(() => sameNativeChunk(declaration, chunk), /declarations/);
  }
  assert.ok(stateful, "native cases exercise auxiliary state planes");
});

test("actual Game staging uses native Node fallback and preserves saved1–6 plus explicit7", { timeout: 120000 }, async () => {
  assert.equal(typeof globalThis.Worker, "undefined", "this is Node fallback proof, not a browser run");
  const rows = await runV7NativeStaging({ expectWorker: false, indexedDB: new IDBFactory() });
  assert.deepEqual(rows.map(({ version }) => version), [3, 7, 1, 2, 3, 4, 5, 6, 7]);
  assert.ok(rows.every((row) => row.chunks === 49 && row.worker === false));
  assert.deepEqual(rows.slice(0, 2).map((row) => [row.dimension, row.spec.minY, row.spec.maxY]),
    [["overworld", 0, 96], ["overworld", -64, 320]]);
  assert.ok(rows.slice(2).every((row) => row.saved && row.restored && row.edits === 1));
  console.log(JSON.stringify({ proof: "native-Game-stageWorld-Node-fallback-only", browserGateRun: false, rows }));
  await assert.rejects(stageWorld({
    seed: "cedar-valley", dimension: "end", generatorVersion: 8, quality: "low",
  }), /version/);
});

test("parent-run browser entry, fixture and build config parse without executing a browser", () => {
  for (const file of ["terrain-v7-browser-fixture.js", "terrain-v7-worker.browser.integration.mjs", "terrain-v7-browser.vite.config.mjs"])
    execFileSync(process.execPath, ["--check", fileURLToPath(new URL(`./${file}`, import.meta.url))]);
});
