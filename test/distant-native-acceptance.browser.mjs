// Parent-run native GPU gate. No forced fog, synthetic terrain or manual mesh
// publication. Long readiness allowances are not frame-performance evidence.
import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { chromeExecutable } from "./realtime/config.mjs";
import { acceptanceConfig } from "./distant-native-acceptance-config.mjs";

const config = acceptanceConfig();
test("native pillar draw coverage, partial ownership, fog and badlands GPU sweeps", {
  timeout: config.timeoutMs,
}, async (t) => {
  const browser = await chromium.launch({
    executablePath: await chromeExecutable(process.env.CHROME_BIN),
    headless: true, args: ["--disable-dev-shm-usage", "--enable-unsafe-swiftshader"],
  });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(config.readyTimeoutMs);
  const errors = [], failures = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  await page.goto(config.url);
  await page.waitForFunction(() => window.__voxelBot?.ready, undefined, { timeout: config.readyTimeoutMs });
  await page.evaluate(async ({ coverageURL, landmarksURL }) => {
    window.__lodNativeAudit = (await import(coverageURL)).auditPillarDraws;
    window.__lodSections = (await import(landmarksURL)).landmarkDetailSections;
  }, config);

  for (const quality of config.qualities) for (const scenario of config.scenarios) {
    const views = await page.evaluate(async ({ scenario, quality, seed }) => {
      const game = window.__voxelBot.game;
      game.quality = quality;
      await game.initialize(seed, null, {
        mode: "creative", dimension: scenario.dimension, generatorVersion: scenario.version,
      });
      game.graphics.setQuality(quality);
      const target = scenario.biome
        ? game.world.generator.locateBiome(scenario.biome, { x: 0, z: 0 })
        : { x: 0, y: game.world.generator.terrainHeight(0, 0) + 1, z: 0 };
      if (!target) throw new Error("Native biome lookup failed");
      const pillars = game.world.generator.getEndPillars?.() ?? [];
      if (pillars.length) {
        const expanded = scenario.version === 7;
        return [
          { name: "overview", position: { x: 0, y: expanded ? 165 : 105, z: expanded ? 260 : 180 },
            target: { x: 0, y: expanded ? 85 : 40, z: 0 }, allPillars: true },
          ...[0, 5].map((id) => {
            const p = pillars[id], cap = p.cap?.y ?? p.top + 1;
            return { name: `pillar-${id}-handoff`, position: { x: p.x + 24, y: cap + 12, z: p.z + 24 },
              target: { x: p.x, y: (p.base + p.top) / 2, z: p.z }, pillarId: id };
          }),
        ];
      }
      return [["north", 0, 90], ["east", 90, 0], ["transition", 32, 52]].map(([name, dx, dz]) => ({
        name, target, position: {
          x: target.x + dx, z: target.z + dz,
          y: Math.max(target.y + 38, game.world.generator.terrainHeight(target.x + dx, target.z + dz) + 24),
        },
      }));
    }, { scenario, quality, seed: config.seed });
    let observedPartial = false;
    for (const view of views) {
      // Camera placement only. Normal game streaming admits detail, so this
      // does not eagerly rebuild all destination meshes through teleport().
      await page.evaluate(({ position, target }) => {
        const game = window.__voxelBot.game;
        game.player.setPosition(position);
        game.player.flying = true; game.player.enabled = true;
        const dx = target.x - position.x, dz = target.z - position.z;
        game.player.yaw = Math.atan2(-dx, -dz);
        game.player.pitch = Math.atan2(target.y - position.y, Math.hypot(dx, dz));
        game.paused = false; game.overlayOpen = false; game.ui.hideMenu();
      }, view);
      const settled = await page.evaluate(async ({ timeoutMs, settleFrames, observePartial, pillarId }) => {
        const started = performance.now();
        let stable = 0, previousKey = null, lastState = null;
        const partialAudits = [];
        const transitionEvidence = [];
        let observerMs = 0, auditMs = 0, auditAttempts = 0, firstPublishedState = null;
        let previousOwnership = null;
        while (performance.now() - started < timeoutMs) {
          await new Promise(requestAnimationFrame);
          const { graphics, world, player } = window.__voxelBot.game;
          const distant = graphics.distant, landmarks = distant._landmarks;
          const coverage = graphics.detailCoverage(), sections = window.__lodSections(graphics.chunks);
          const coverageKey = [...coverage].sort().join(";");
          const key = coverageKey + "/" + [...sections].sort().join(";");
          const ready = distant.ready && !distant._job && !landmarks?.job && !landmarks?.pendingRebuild &&
            Math.abs(distant._active.data.request.cx - Math.floor(player.position.x / 16)) < 2 &&
            Math.abs(distant._active.data.request.cz - Math.floor(player.position.z / 16)) < 2;
          // Observe published geometry, not completion of a replacement job.
          // Final settlement below deliberately keeps its stricter readiness gate.
          const observerStarted = performance.now();
          const active = distant._active;
          if (observePartial && active && landmarks && auditAttempts < 2 &&
              distant._sameIdentity(active.data.identity) && landmarks.current(landmarks.identity)) {
            const attached = (object) => {
              for (let at = object; at; at = at.parent) {
                if (!at.visible) return false;
                if (at === graphics.scene) return true;
              }
              return false;
            };
            const ownership = [];
            const meshes = [];
            for (const mesh of landmarks.group.children) {
              const source = mesh.userData.landmarkSource, geometry = mesh.geometry;
              const start = geometry.drawRange.start;
              const end = Math.min(geometry.index.count, start + geometry.drawRange.count);
              const drawn = new Set(attached(mesh) && mesh.material.visible !== false
                ? geometry.index.array.subarray(start, end) : []);
              meshes.push({ uuid: mesh.uuid, geometry: geometry.uuid, visible: attached(mesh),
                indexVersion: geometry.index.version, drawStart: start, drawCount: end - start });
              for (const part of source.parts) {
                if (part.invalid || part.pillar !== pillarId) continue;
                const proxy = source.indices.subarray(part.start, part.start + part.count).every((i) => drawn.has(i));
                ownership.push({ section: part.section, low: part.low, high: part.high,
                  detail: coverage.has(part.column) || sections.has(part.section), proxy });
              }
            }
            const sectionOwnership = [...new Map(ownership.map((p) => [JSON.stringify(p), p])).values()];
            const ownershipKey = JSON.stringify(sectionOwnership);
            const state = { ready, terrainJob: !!distant._job, landmarkJob: !!landmarks.job,
              pendingRebuild: !!landmarks.pendingRebuild, sectionJobs: graphics.sectionJobs?.size ?? 0,
              sourceCurrent: distant._sameIdentity(active.data.identity),
              landmarkSourceCurrent: landmarks.current(landmarks.identity),
              activeBounds: active.data.bounds, activeCenter: {cx: active.data.request.cx, cz: active.data.request.cz},
              camera: graphics.camera.position.toArray(), pillarId, meshes, sectionOwnership,
              fog: { expanded: graphics.expandedFog, distance: distant.fogDistance,
                near: graphics.scene.fog.near, far: graphics.scene.fog.far },
              rendererFrame: graphics.renderer.info.render.frame };
            firstPublishedState ??= state;
            if (ownership.some((p) => p.detail) && ownership.some((p) => p.proxy) &&
                ownershipKey !== previousOwnership) {
              auditAttempts++;
              const auditStarted = performance.now();
              const audit = window.__lodNativeAudit(graphics);
              const elapsed = performance.now() - auditStarted;
              auditMs += elapsed;
              transitionEvidence.push({ state, auditMs: elapsed, audit });
              if (audit.mixedOwnershipPillars.length) partialAudits.push(audit);
            }
            previousOwnership = ownershipKey;
          }
          observerMs += performance.now() - observerStarted;
          const native = world.generator.getEndPillars?.().length ?? 0;
          const ownCurrent = !native || (landmarks?.group.children.length === 2 && landmarks.viewKey === key);
          const centerCovered = coverage.has(`${Math.floor(player.position.x / 16)},${Math.floor(player.position.z / 16)}`);
          const fogSettled = graphics.expandedFog >= distant.fogDistance - 1;
          const complete = ready && ownCurrent && centerCovered && fogSettled && !graphics.sectionJobs?.size &&
            distant._active.viewKey === coverageKey;
          lastState = { ready, ownCurrent, centerCovered, fogSettled,
            sectionJobs: graphics.sectionJobs?.size ?? 0, stableFrames: stable };
          stable = complete && key === previousKey ? stable + 1 : 0;
          previousKey = key;
          if (stable >= settleFrames) return { partialAudits, transitionEvidence, firstPublishedState, observerMs, auditMs, auditAttempts, settlingWallMs: performance.now() - started };
        }
        throw new Error(`Native LOD/detail coverage did not settle: ${JSON.stringify(lastState)}`);
      }, { timeoutMs: config.readyTimeoutMs, settleFrames: config.settleFrames, observePartial: view.pillarId !== undefined, pillarId: view.pillarId });
      for (const { audit } of settled.transitionEvidence) {
        observedPartial ||= audit.mixedOwnershipPillars.length > 0;
        failures.push(...audit.errors.map((e) => `${scenario.name}/${quality}/${view.name}/partial: ${e}`));
      }
      const sweep = await page.evaluate(async (frames) => {
        const game = window.__voxelBot.game, yaw = game.player.yaw, deltas = [];
        let before = performance.now();
        for (let i = 0; i < frames; i++) {
          game.player.yaw = yaw - 0.2 + i / (frames - 1) * 0.4;
          await new Promise(requestAnimationFrame);
          const now = performance.now(); deltas.push(now - before); before = now;
        }
        game.player.yaw = yaw;
        await new Promise(requestAnimationFrame);
        deltas.sort((a, b) => a - b);
        return { frames, p95FrameMs: deltas[Math.ceil(frames * 0.95) - 1], worstFrameMs: deltas.at(-1) };
      }, config.sweepFrames);
      const result = await page.evaluate(() => {
        const { graphics, world } = window.__voxelBot.game;
        const gl = graphics.renderer.getContext(), info = gl.getExtension("WEBGL_debug_renderer_info");
        return {
          audit: window.__lodNativeAudit(graphics),
          renderer: info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
          glError: gl.getError(), drawCalls: graphics.renderer.info.render.calls,
          triangles: graphics.renderer.info.render.triangles,
          fog: { near: graphics.scene.fog.near, far: graphics.scene.fog.far },
          nativePillars: world.generator.getEndPillars?.().length ?? 0,
          proxyPillars: graphics.distant._landmarks?.group.userData.renderablePillars ?? 0,
          refinedChunks: graphics.distant._active.data.refinement.size, edits: world.edits.size,
          generatorVersion: world.generatorVersion,
          seed: world.seed,
        };
      });
      failures.push(...result.audit.errors.map((e) => `${scenario.name}/${quality}/${view.name}: ${e}`));
      if (view.allPillars && result.audit.expectedPillars !== 10)
        failures.push(`${scenario.name}/${quality}: overview does not independently observe all ten native pillars`);
      if (view.pillarId !== undefined && !result.audit.pillars.find((p) => p.id === view.pillarId)?.expected)
        failures.push(`${scenario.name}/${quality}: approach never observes pillar ${view.pillarId}`);
      if ([4, 5, 6].includes(scenario.version)) assert.equal(result.proxyPillars, 0);
      if (scenario.biome) assert.ok(result.refinedChunks > 0);
      assert.equal(result.edits, 0);
      assert.equal(result.generatorVersion, scenario.version);
      assert.equal(result.seed, config.seed);
      assert.equal(result.glError, 0);
      await page.screenshot({ path: `/opt/cursor/artifacts/lod_${config.runLabel}_${scenario.name}_${quality}_${view.name}.png` });
      t.diagnostic(JSON.stringify({ seed: config.seed, scenario, quality, view, sweep, settled, result }));
    }
    if (scenario.version === 7 && scenario.dimension === "end" && !observedPartial)
      failures.push(`${scenario.name}/${quality}: no actual mixed detail/proxy pillar handoff observed`);
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(failures, [], "Native draw coverage/readability gates remain open");
});
