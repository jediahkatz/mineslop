// Native-world GPU acceptance and optional visual captures. Run explicitly:
// TMPDIR=/dev/shm LOD_SURFACE_VERSION=7 node --test test/distant-surface-diagnostic.mjs
// LOD_SURFACE_BIOME=badlands covers native strata; the default is plains.
// Uses the existing realtime host, without production substitutions or edits.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { chromium } from "playwright";
import { chromeExecutable } from "./realtime/config.mjs";

test("native LOD atlas handoff, shared-material variants and bounded world captures", {
  timeout: 300000,
}, async (t) => {
const base = new URL(process.env.VOXELCRAFT_TEST_URL ?? "http://127.0.0.1:5394/mineslop/");
const output = process.env.LOD_SURFACE_OUTPUT ?? `/opt/cursor/artifacts/lod-surface-diagnostic-${Date.now()}`;
const version = Number(process.env.LOD_SURFACE_VERSION ?? 3);
const biomeId = process.env.LOD_SURFACE_BIOME ?? "plains";
const requireAtlas = process.env.LOD_SURFACE_REQUIRE_ATLAS !== "0";
const radius = process.env.LOD_SURFACE_RADIUS === undefined ? null : Number(process.env.LOD_SURFACE_RADIUS);
const quality = process.env.LOD_SURFACE_QUALITY ?? "medium";
assert.ok(["low", "medium", "high"].includes(quality));
assert.ok(radius === null || (Number.isInteger(radius) && radius >= 2 && radius <= 6));
mkdirSync(output, { recursive: true });
const profile = mkdtempSync("/dev/shm/lod-surface-browser-");
let context;
t.after(async () => {
  try { await context?.close(); }
  finally { rmSync(profile, { recursive: true, force: true }); }
});
context = await chromium.launchPersistentContext(profile, {
  executablePath: await chromeExecutable(process.env.CHROME_BIN),
  headless: true, viewport: { width: 800, height: 500 },
  handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false,
  args: ["--enable-unsafe-swiftshader", "--remote-debugging-port=0"],
});
const page = context.pages()[0];
page.setDefaultTimeout(120000);
const errors = [], sourceHashes = {}, pendingSources = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
page.on("response", (r) => {
  if (/\/src\/(?:distant-surface-material|distant-terrain|distant-terraces|renderer|section-renderer|section-pages|mesh-geometry|mesh-snapshot|shape-mesh|resolved-mesh|textures|daylight-material)\.js(?:\?|$)/.test(r.url())) {
    const pending = r.body().then((body) => {
      sourceHashes[new URL(r.url()).pathname] = createHash("sha256").update(body).digest("hex");
    });
    // Observe immediately; Promise.all below still fails on a missing body.
    pending.catch(() => {});
    pendingSources.push(pending);
  }
});
const report = { version, biomeId, radius, quality, profile, url: base.href, scenarios: [], sourceHashes, errors };
try {
  await page.goto(new URL("test/realtime/index.html?quality=medium&seed=cedar-valley&pixelRatio=1", base).href);
  await page.waitForFunction(() => window.__voxelBot?.ready || window.__voxelBot?.error);
  assert.equal(await page.evaluate(() => window.__voxelBot.error), null);
  for (const dimension of ["overworld", "end"]) {
    const result = await page.evaluate(async ({ dimension, version, biomeId, requireAtlas, radius, quality }) => {
      const game = window.__voxelBot.game;
      cancelAnimationFrame(game.animation);
      await game.initialize("cedar-valley", null, { mode: "creative", dimension, generatorVersion: version });
      cancelAnimationFrame(game.animation);
      const { BLOCKS } = await import("../../src/blocks.js");
      const { BIOME_PROFILES } = await import("../../src/biomes.js");
      const { graphics: g, world, player } = game;
      g.setQuality(quality);
      if (radius !== null) g.setRenderDistanceOverride(radius);
      const lod = g.distant;
      // Separate newly initialized world only. No changes to loaded voxel data,
      // coverage ownership, lighting mode or fog configuration.
      const position = dimension === "end"
        ? { x: 0.5, z: 48.5 }
        : world.generator.locateBiome(biomeId, { x: 0, z: 0 });
      if (!position) throw new Error(`Native biome ${biomeId} not found`);
      position.y = world.generator.terrainHeight(Math.floor(position.x), Math.floor(position.z)) + 9;
      player.setPosition(position);
      player.flying = true;
      player.yaw = 0;
      player.pitch = dimension === "end" ? -0.25 : -0.45;
      player._syncCamera(0);
      // Admit real native detail at the diagnostic pose; no teleport landing
      // platform, synthetic terrain, forced cutout or unbounded mesh rebuild.
      await world.ensureArea(position, radius === null ? Math.min(2, g.renderRadius) : radius + 1);
      for (let tick = 0; tick < 2400 && (world.dirtyChunks.size || g.sectionJobs?.size); tick++) {
        g.rebuildDirty(2);
        if (tick % 32 === 0) await new Promise(requestAnimationFrame);
      }
      g.setBiome(world.getBiome(Math.floor(position.x), Math.floor(position.z)));
      g.renderer.setPixelRatio(1);
      g.renderer.setSize(800, 500, false);
      g.camera.aspect = 800 / 500;
      g.camera.updateProjectionMatrix();
      g.setTime(0.5);
      let ticks = 0;
      for (; ticks < 2400; ticks++) {
        lod.update(position, { radius: g.renderRadius, quality, outdoors: true,
          dimension, coverage: g.detailCoverage(), budgetMs: 4 });
        if (lod.ready && !lod._job && !lod._vegetationJob) break;
        if (ticks % 64 === 0) await new Promise(requestAnimationFrame);
      }
      if (!lod.ready || lod._job) throw new Error(`LOD did not settle for ${dimension} after ${ticks} bounded slices`);
      const active = lod._active, data = active.data, emitted = data.terraces;
      const walls = [];
      for (const cell of data.cells) {
        if (!cell.valid || walls.length >= 6) continue;
        const owner = cell.anchor ?? cell.ring[0];
        const wx = data.originX + data.positions[owner * 3];
        const wz = data.originZ + data.positions[owner * 3 + 2];
        const biome = world.generator.getBiome(wx, wz);
        if (dimension === "overworld" && biome.category === "badlands") continue;
        const profile = BIOME_PROFILES[biome.id];
        for (let i = cell.terraceStart + cell.count;
          i < cell.terraceStart + cell.terraceCount && walls.length < 6; i += 6) {
          const ids = [...emitted.indices.subarray(i, i + 6)];
          const ys = ids.map((id) => emitted.positions[id * 3 + 1]);
          const high = Math.max(...ys), low = Math.min(...ys);
          if (high - low < 1) continue;
          const native = world.generator.generateRegion(wx, wz, 1, 1);
          walls.push({ owner: { x: wx, z: wz }, biome: biome.id, high, low,
            profile: { surface: profile?.surface, soil: profile?.soil, rock: profile?.rock },
            nativeTopLayers: [0, 1, 2, 3, 4].map((depth) => {
              const y = high - 1 - depth;
              const id = native.blocks[y - world.spec.minY];
              return { y, id, color: BLOCKS[id]?.color };
            }),
            vertexColors: ids.map((id) => [...emitted.colors.subarray(id * 3, id * 3 + 3)]),
            metadata: ids.map((id) => [...emitted.surfaceData.subarray(id * 3, id * 3 + 3)]),
            blockIds: emitted.blockData
              ? ids.map((id) => [...emitted.blockData.subarray(id * 3, id * 3 + 3)]) : null,
          });
        }
      }
      for (let tick = 0; tick < 120; tick++)
        g.update(1 / 60, 1 + tick / 60, player.position);
      const shaderVariants = requireAtlas
        ? (await import("../distant-surface-variants.browser.js")).auditDistantSurfaceVariants(g) : [];
      g.render();
      const gl = g.renderer.getContext();
      const pixels = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
      gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      let sum = 0, squared = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        const value = (pixels[i] + pixels[i + 1] + pixels[i + 2]) / 3;
        sum += value; squared += value * value;
      }
      const count = pixels.length / 4;
      const material = (m) => ({ type: m.type, map: !!m.map,
        mapColorSpace: m.map?.colorSpace, vertexColors: m.vertexColors,
        cacheKey: m.customProgramCacheKey(), defines: m.defines });
      const program = g.renderer.properties.get(lod._terrainMaterial).currentProgram;
      const activeUniforms = program ? Array.from(
        { length: gl.getProgramParameter(program.program, gl.ACTIVE_UNIFORMS) },
        (_, i) => gl.getActiveUniform(program.program, i).name) : [];
      return {
        dimension, version, ticks, position, biome: world.generator.getBiome(position.x, position.z).id,
        materials: { near: material(g.materials.opaque), far: material(lod._terrainMaterial),
          attributes: Object.keys(active.terrain.geometry.attributes),
          compiled: !!program, shaderUsesAtlas: activeUniforms.includes("uLodAtlas"),
          activeSurfaceUniforms: activeUniforms.filter((name) => name.startsWith("uLod")),
          sharedAtlasBound: !!g.renderer.properties.get(lod._terrainMaterial).uniforms?.uLodAtlas &&
            g.renderer.properties.get(lod._terrainMaterial).uniforms.uLodAtlas.value === g.atlas.texture },
        walls, shaderVariants,
        state: { ready: lod.ready, visible: lod.group.visible, radius: g.renderRadius,
          skySize: g.skyColumns.size, surfaceLayers: g.skyColumns.surfaceLight.tiles ** 2,
          blockLayers: g.blockLight.tiles ** 2,
          surfacePending: g.skyColumns.surfaceLight.pending,
          blockUnavailable: g.blockLight.valid.reduce((sum, value) => sum + Number(value === 0), 0),
          dirtyColumns: world.dirtyChunks.size,
          dirtySections: world.dirtySectionRevisions?.size ?? 0,
          sectionJobs: g.sectionJobs?.size ?? 0,
          meshStats: { ...g.meshStats },
          fog: { near: g.scene.fog.near, far: g.scene.fog.far },
          fullbright: g.fullbrightInspection, coverage: g.detailCoverage().size,
          vertices: active.terrain.geometry.attributes.position.count,
          drawnIndices: active.terrain.geometry.drawRange.count, loadedChunks: world.chunks.size,
          edits: world.edits?.size ?? null },
        gpu: { glError: gl.getError(), contextLost: gl.isContextLost(),
          failedPrograms: g.renderer.info.programs.filter((p) => p.diagnostics?.runnable === false).length,
          mean: sum / count, variance: squared / count - (sum / count) ** 2 },
        png: g.renderer.domElement.toDataURL("image/png"),
      };
    }, { dimension, version, biomeId, requireAtlas, radius, quality });
    writeFileSync(`${output}/${dimension}.png`, Buffer.from(result.png.split(",")[1], "base64"));
    delete result.png;
    report.scenarios.push(result);
    assert.equal(result.gpu.glError, 0);
    assert.equal(result.gpu.contextLost, false);
    assert.equal(result.gpu.failedPrograms, 0);
    assert.equal(result.state.ready, true, "native terrain and vegetation must be ready");
    assert.equal(result.state.visible, true, "capture must render the native LOD");
    assert.ok(result.state.coverage > 0, "capture must include native detail ownership");
    assert.ok(result.state.drawnIndices > 0, "capture must include distant terrain");
    assert.ok(result.gpu.variance > 0, "capture must not be an empty framebuffer");
    if (radius !== null) {
      assert.equal(result.state.radius, radius);
      assert.equal(result.state.skySize, (radius * 2 + 1) * 16);
      assert.equal(result.state.surfaceLayers, (radius * 2 + 1) ** 2);
      assert.equal(result.state.blockLayers, (radius * 2 + 1) ** 2);
      assert.equal(result.state.coverage, (radius * 2 + 1) ** 2, "all configured detail columns must render");
      // This bounded material capture is not a steady-state lighting/FPS gate.
      // Keep unavailable page counts visible; the performance harness waits
      // for genuine completion instead of treating them as verified darkness.
    }
    if (requireAtlas) {
      assert.equal(result.materials.shaderUsesAtlas, true, "linked shader must actively sample the LOD atlas");
      assert.equal(result.materials.sharedAtlasBound, true, "LOD must bind the renderer's existing atlas");
      for (const variant of result.shaderVariants) {
        assert.equal(variant.linked, true, variant.name);
        assert.equal(variant.glError, 0, variant.name);
        assert.ok(variant.pixel.slice(0, 3).some((value) => value > 0), `${variant.name} must draw`);
        if (variant.name.includes("vegetation")) {
          assert.equal(variant.lodBlocksEnabled, false, variant.name);
          assert.deepEqual(variant.lodBlocksDefault, [0, 0, 0], variant.name);
        } else assert.equal(variant.lodBlocksEnabled, true, variant.name);
      }
      assert.notEqual(result.shaderVariants[0].programId, result.shaderVariants[1].programId,
        "RGB and RGBA use distinct Three program variants");
      assert.equal(result.shaderVariants[0].programId, result.shaderVariants.at(-1).programId,
        "returning to RGB terrain reuses its valid program");
    }
    t.diagnostic(JSON.stringify({ dimension, ticks: result.ticks, gpu: result.gpu, output }));
  }
  await Promise.all(pendingSources);
  assert.deepEqual(errors, []);
} catch (e) {
  report.failure = e.stack ?? String(e);
  throw e;
} finally {
  await Promise.allSettled(pendingSources);
  writeFileSync(`${output}/report.json`, JSON.stringify(report, null, 2) + "\n");
  t.diagnostic(JSON.stringify({ output, profile, failure: report.failure ?? null }));
  // Test teardown closes only the context created here, never an existing
  // inspection browser. Native acceptance does not patch production methods.
}
});
