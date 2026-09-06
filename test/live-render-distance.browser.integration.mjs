// Isolated profile, real production main/Game, native generation and real RAF.
// No quality/radius eligibility transforms, readiness drains, or resource overrides.
// VOXELCRAFT_TEST_URL=http://127.0.0.1:6795/mineslop/ node --test test/live-render-distance.browser.integration.mjs
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import test from "node:test";
import { chromium } from "playwright";
import { chromeExecutable } from "./realtime/config.mjs";

const base = new URL(process.env.VOXELCRAFT_TEST_URL ?? "http://127.0.0.1:5173/mineslop/");
const url = new URL("test/live-render-distance.html", base);
const distanceKey = "voxelcraft-render-distance-v1";
const originals = {
  "voxelcraft-controls-v1": '{ "inputMode": "remote", "mouseSensitivity": 1.25 }',
  "voxelcraft-view-v1": '{ "guiScale": "1", "showFps": true, "fullbrightInspection": false }',
  "unrelated-preference": "do not rewrite",
};

test("live default R12, accepted UI settings, progressive native terrain and lifecycle persistence", {
  timeout: 180000,
}, async (t) => {
  const browser = await chromium.launch({
    executablePath: await chromeExecutable(process.env.CHROME_BIN),
    headless: true,
    args: ["--disable-dev-shm-usage", "--enable-unsafe-swiftshader"],
  });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 800, height: 500 }, deviceScaleFactor: 1 });
  assert.deepEqual(await context.storageState({ indexedDB: true }), { cookies: [], origins: [] });
  await context.addInitScript((originals) => {
    for (const [key, value] of Object.entries(originals))
      if (localStorage.getItem(key) === null) localStorage.setItem(key, value);
  }, originals);
  const page = await context.newPage(), errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("dialog", (dialog) => dialog.accept());
  page.setDefaultTimeout(30000);
  const waitReady = async () => {
    await page.waitForFunction(() => window.distanceHost?.ready || window.distanceHost?.error,
      undefined, { timeout: 45000 });
    assert.equal(await page.evaluate(() => window.distanceHost.error), null);
  };
  const inspect = () => page.evaluate(async () => {
    const { meshRevisionCurrent } = await import("../src/mesh-snapshot.js");
    const p = window.distanceHost, g = p.game, r = g.graphics;
    const gl = r.renderer.getContext(), info = gl.getExtension("WEBGL_debug_renderer_info");
    const center = { x: Math.floor(g.player.position.x / 16), z: Math.floor(g.player.position.z / 16) };
    let farSections = 0, farGeometrySections = 0, freshSections = 0;
    for (const [key, column] of r.chunks) {
      const [x, z] = key.split(",").map(Number);
      const far = Math.max(Math.abs(x - center.x), Math.abs(z - center.z)) > 4;
      for (const [sy, section] of column.userData.sections ?? []) {
        if (g.world.dirtySectionRevisions.get(`${key},${sy}`) !== undefined ||
            !meshRevisionCurrent(g.world, { ...section.stamp, ticket: undefined })) continue;
        freshSections++;
        if (far) farSections++;
        if (far && section.bytes > 0) farGeometrySections++;
      }
    }
    return {
      radius: r.renderRadius, override: r.renderDistanceOverride, preference: g.renderDistance,
      saved: localStorage.getItem("voxelcraft-render-distance-v1"),
      quality: g.quality, generator: g.world.generatorVersion, seed: g.world.seed,
      bootstrap: p.bootstrap, streaming: g.world.streamingStatus(),
      limits: r.meshLimits, softwareGPU: r.softwareRendering,
      renderer: info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
      contextLost: gl.isContextLost(), draws: p.draws, submissions: r.renderer.info.render.calls,
      freshSections, farSections, farGeometrySections, unbounded: p.unbounded, maxCompletions: p.maxCompletions,
      stagedCanvasesDetached: p.stagedCanvasesDetached,
      tail: r.meshLimits?.experimentalColdTailSealing === true, water: r.waterFusionEnabled,
      slider: document.querySelector("#render-distance-setting").value,
      label: document.querySelector("#render-distance-value").textContent,
      inputStatus: document.querySelector("#terrain-streaming-status").textContent,
      bytes: Object.fromEntries(Object.keys(localStorage).map((key) => [key, localStorage.getItem(key)])),
    };
  });
  await page.goto(url.href, { waitUntil: "load" });
  await waitReady();
  const initial = await inspect();
  assert.equal(initial.radius, 12);
  assert.equal(initial.override, 12);
  assert.equal(initial.preference, 12);
  assert.equal(initial.saved, null, "startup does not rewrite absent browser storage");
  assert.equal(initial.generator, 3, "default generation is unchanged");
  assert.equal(initial.streaming.demand, 841, "R+2 native inputs, not LOD credit");
  assert.equal(initial.bootstrap[0].chunks, 25);
  assert.deepEqual(initial.limits, { regionalPages: true });
  assert.equal(initial.water, false);
  assert.equal(initial.tail, false);
  assert.equal(initial.slider, "12");
  assert.equal(initial.label, "12 chunks (192 blocks)");

  await page.waitForFunction(async () => {
    const { meshRevisionCurrent } = await import("../src/mesh-snapshot.js");
    const g = window.distanceHost.game, p = g.player.position;
    for (const [dx, dz] of [[3, 0], [-3, 0], [0, 3], [0, -3]]) {
      const at = { x: Math.floor(p.x) + dx, y: Math.floor(p.y) + 1, z: Math.floor(p.z) + dz };
      if (g.world.getCell(at.x, at.y, at.z)?.id !== 0) continue;
      const cx = Math.floor(at.x / 16), cz = Math.floor(at.z / 16), sy = Math.floor(at.y / 16);
      const section = g.graphics.chunks.get(`${cx},${cz}`)?.userData.sections.get(sy);
      if (section?.bytes > 0 && !g.world.dirtySectionRevisions.has(`${cx},${cz},${sy}`) &&
          meshRevisionCurrent(g.world, { ...section.stamp, ticket: undefined })) {
        window.distanceHost.paidEditTarget = { ...at, cx, cz, sy };
        return true;
      }
    }
    return false;
  }, undefined, { timeout: 15000 });
  const paidEdit = await page.evaluate(async () => {
    const { BLOCK } = await import("../src/blocks.js");
    const { meshRevisionCurrent, sectionYs } = await import("../src/mesh-snapshot.js");
    const g = window.distanceHost.game, r = g.graphics, at = window.distanceHost.paidEditTarget;
    const columnKey = `${at.cx},${at.cz}`, key = `${columnKey},${at.sy}`;
    const snapshot = async () => {
      const column = r.chunks.get(columnKey), section = column.userData.sections.get(at.sy), xyz = [];
      for (const source of section.group.children) {
        if (!source.userData.sectionSource) continue;
        const range = column.userData.sectionRanges.get(source), mesh = range.mesh;
        if (mesh.parent !== column.userData.sectionRegion) throw new Error("Physical page is detached");
        const geometry = mesh.geometry, position = geometry.attributes.position, origin = mesh.parent.position;
        for (let i = range.start; i < range.start + range.count; i++) {
          const vertex = geometry.index.array[i];
          xyz.push(position.getX(vertex) + origin.x, position.getY(vertex) + origin.y, position.getZ(vertex) + origin.z);
        }
      }
      const digest = await crypto.subtle.digest("SHA-256", new Float32Array(xyz));
      return { ticket: section.stamp.ticket, indices: xyz.length / 3,
        hash: [...new Uint8Array(digest)].map((v) => v.toString(16).padStart(2, "0")).join("") };
    };
    const before = await snapshot();
    if (!g.gameplay.add(BLOCK.STONE, 2) || !g.gameplay.assignSlot(0, BLOCK.STONE))
      throw new Error("Could not prepare the isolated paid-placement fixture");
    g.gameplay.select(0);
    const stack = g.gameplay.getHandStack("main"), beforeCount = stack.count;
    const cost = g.gameplay.prepareHandCost("main", {
      stack, handRevision: g.gameplay.getHandRevision("main"), count: 1, notify: false,
    });
    const mutation = g.world.prepareMutation([{ x: at.x, y: at.y, z: at.z,
      before: g.world.getCell(at.x, at.y, at.z), after: { id: BLOCK.STONE, state: 0, fluid: 0 } }]);
    if (!cost || !mutation || !g.world.coordinator.commit([mutation, cost]).ok)
      throw new Error("Paid placement was refused");
    const ticket = g.world.dirtySectionRevisions.get(key), started = performance.now();
    let calls = 0;
    const rebuild = r.rebuildDirty;
    r.rebuildDirty = function (...args) { calls++; return rebuild.apply(this, args); };
    const fresh = () => {
      const section = r.chunks.get(columnKey)?.userData.sections.get(at.sy);
      return !g.world.dirtySectionRevisions.has(key) && section?.stamp.ticket === ticket &&
        meshRevisionCurrent(g.world, { ...section.stamp, ticket: undefined });
    };
    try {
      while (!fresh() && calls < 120 && performance.now() - started < 15000)
        await new Promise(requestAnimationFrame);
      if (!fresh()) throw new Error(`Paid near edit remained stale after ${calls} real frame calls`);
    } finally { r.rebuildDirty = rebuild; }
    const elapsedMs = performance.now() - started, after = await snapshot();
    const installed = [...r.chunks.values()].reduce((sum, column) => sum + column.userData.sections.size, 0);
    return { at, ticket, beforeCount, afterCount: g.gameplay.getHandStack("main").count,
      block: g.world.get(at.x, at.y, at.z), calls, elapsedMs, before, after, installed,
      required: (2 * r.renderRadius + 1) ** 2 * sectionYs(g.world).length, streaming: g.world.streamingStatus(),
      sliceBudgetMs: r.meshStats.limits.maxSliceMs, softwareGPU: r.softwareRendering };
  });
  assert.equal(paidEdit.afterCount, paidEdit.beforeCount - 1);
  assert.equal(paidEdit.after.ticket, paidEdit.ticket);
  assert.notEqual(paidEdit.after.hash, paidEdit.before.hash);
  assert.ok(paidEdit.after.indices > 0);
  assert.ok(paidEdit.installed < paidEdit.required, "paid edit publishes before full-detail coverage");
  assert.equal(paidEdit.sliceBudgetMs, 8);

  // Observe bounded real streaming/meshing. Incomplete detail is recorded, never
  // substituted by distant terrain. This is functionality, not an FPS claim.
  await page.waitForFunction(() => {
    const g = window.distanceHost.game, cx = Math.floor(g.player.position.x / 16), cz = Math.floor(g.player.position.z / 16);
    return [...g.graphics.chunks].some(([key, column]) => {
      const [x, z] = key.split(",").map(Number);
      return Math.max(Math.abs(x - cx), Math.abs(z - cz)) > 4 &&
        [...(column.userData.sections?.values() ?? [])].some((section) => section.bytes > 0);
    });
  }, undefined, { timeout: 70000 });
  const progress = await inspect();
  assert.ok(progress.draws > initial.draws);
  assert.ok(progress.submissions > 0);
  assert.ok(progress.streaming.loaded > 25);
  assert.ok(progress.farGeometrySections > 0, "actual nonempty section geometry beyond the former R4 limit");
  assert.equal(progress.contextLost, false);
  assert.equal(progress.unbounded, false);
  assert.equal(progress.maxCompletions, 2);
  await page.locator(".settings-toggle").click();
  await page.locator(".video-settings-button").click();
  const choose = async (radius) => {
    await page.locator("#render-distance-setting").evaluate((slider, value) => {
      slider.value = String(value);
      slider.dispatchEvent(new Event("change", { bubbles: true }));
    }, radius);
    assert.equal((await inspect()).radius, radius);
  };
  await choose(6);
  for (const quality of ["low", "high"]) {
    await page.selectOption("#quality-setting", quality);
    const current = await inspect();
    assert.equal(current.radius, 6);
    assert.equal(current.saved, "6");
  }
  const rejection = await page.evaluate(() => {
    const g = window.distanceHost.game, gl = g.graphics.renderer.getContext();
    const read = gl.getParameter;
    gl.getParameter = () => 0;
    try {
      const slider = document.querySelector("#render-distance-setting");
      slider.value = "12";
      slider.dispatchEvent(new Event("change", { bubbles: true }));
      return { radius: g.graphics.renderRadius, slider: slider.value,
        saved: localStorage.getItem("voxelcraft-render-distance-v1"),
        message: document.querySelector(".toast > span").textContent };
    } finally { gl.getParameter = read; }
  });
  assert.deepEqual({ ...rejection, message: undefined },
    { radius: 6, slider: "6", saved: "6", message: undefined });
  assert.match(rejection.message, /unchanged.*WebGL2 limits/);
  await choose(2);
  await page.reload({ waitUntil: "load" });
  await waitReady();
  assert.equal((await inspect()).radius, 2, "real startup reload reads the browser setting");

  const lifecycle = await page.evaluate(async () => {
    const { exportWorldFile } = await import("../src/storage.js");
    const g = window.distanceHost.game, results = [];
    if (!g.setRenderDistance(12)) throw new Error("Restored host refused R12");
    const record = (name, result) => {
      if (result?.ok === false) throw new Error(`${name}: ${result.message}`);
      results.push({ name, radius: g.graphics.renderRadius, preference: g.renderDistance,
        generator: g.world.generatorVersion, seed: g.world.seed,
        regional: g.graphics.meshLimits.regionalPages, gate: g.transitionGate.busy });
    };
    const bytes = exportWorldFile(g.snapshot());
    if (/"(?:renderDistance|renderDistanceOverride|viewPreferences|controlPreferences)"\s*:/.test(bytes))
      throw new Error("Device settings leaked into portable archive");
    await g.setMode("creative");
    const move = g.teleport({ ...g.player.position, x: g.player.position.x + 80 });
    const duringTravel = g.setRenderDistance(6);
    record("travel", await move);
    const imported = g.importWorld(new File([bytes], "roundtrip.voxelcraft.json", { type: "application/json" }));
    const duringImport = g.setRenderDistance(6);
    record("import", await imported);
    const oldSeed = g.world.seed, oldVersion = g.world.generatorVersion;
    const prepare = g.prepareWorld;
    g.prepareWorld = async () => { throw new Error("injected candidate admission failure"); };
    const rollback = await g.newWorld("rejected-seed");
    g.prepareWorld = prepare;
    if (rollback.ok || g.world.seed !== oldSeed || g.world.generatorVersion !== oldVersion)
      throw new Error("Rejected new world changed the live world");
    record("rollback", { ok: true });
    record("new-world-default", await g.newWorld("cedar-valley"));
    // Explicit supported expanded choice only; never alter the default/version.
    record("new-world-expanded", await g.newWorld("cedar-valley", 7));
    return { results, duringTravel, duringImport, portableBytes: bytes.length };
  });
  assert.equal(lifecycle.duringTravel, false);
  assert.equal(lifecycle.duringImport, false);
  assert.ok(lifecycle.results.every((r) => r.radius === 12 && r.preference === 12 && r.regional));
  assert.equal(lifecycle.results.find((r) => r.name === "new-world-default").generator, 3);
  assert.equal(lifecycle.results.at(-1).generator, 7);
  const final = await inspect();
  assert.equal(final.unbounded, false);
  assert.equal(final.stagedCanvasesDetached, true, "candidate canvases stay private until publication");
  assert.ok(final.bootstrap.every((b) => b.chunks === 25));
  assert.equal(final.saved, "12");
  for (const [key, value] of Object.entries(originals)) assert.equal(final.bytes[key], value);
  assert.deepEqual(errors, []);
  const report = { initial, paidEdit, progress, rejection, lifecycle, final, errors,
    limitations: "Software GPU when reported; partial detail, not full R12 readiness or performance qualification." };
  if (process.env.MINESLOP_DISTANCE_REPORT)
    await writeFile(process.env.MINESLOP_DISTANCE_REPORT, `${JSON.stringify(report, null, 2)}\n`);
  t.diagnostic(JSON.stringify(report));
});

test("startup GPU rejection reports failure without rewriting saved distance or other preference bytes", {
  timeout: 45000,
}, async (t) => {
  const browser = await chromium.launch({
    executablePath: await chromeExecutable(process.env.CHROME_BIN),
    headless: true, args: ["--disable-dev-shm-usage", "--enable-unsafe-swiftshader"],
  });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 800, height: 500 } });
  await context.addInitScript(({ originals, distanceKey }) => {
    for (const [key, value] of Object.entries(originals)) localStorage.setItem(key, value);
    localStorage.setItem(distanceKey, "6");
  }, { originals, distanceKey });
  const page = await context.newPage();
  const rejected = new URL(url); rejected.searchParams.set("rejectStartup", "1");
  await page.goto(rejected.href, { waitUntil: "load" });
  await page.waitForFunction(() => window.distanceHost?.error, undefined, { timeout: 30000 });
  const result = await page.evaluate(() => ({
    error: window.distanceHost.error, ready: window.distanceHost.ready,
    preference: window.distanceHost.game.renderDistance,
    graphics: !!window.distanceHost.game.graphics,
    canvases: document.querySelectorAll(".game-canvas").length,
    bytes: Object.fromEntries(Object.keys(localStorage).map((key) => [key, localStorage.getItem(key)])),
  }));
  assert.match(result.error, /WebGL2 limits/);
  assert.equal(result.ready, false);
  assert.equal(result.graphics, false);
  assert.equal(result.canvases, 0);
  assert.equal(result.preference, 6);
  assert.deepEqual(result.bytes, { ...originals, [distanceKey]: "6" });
  t.diagnostic(JSON.stringify({ startupRejection: result }));
});
