// Opt-in, after checkpoint only. Requires a fresh frozen test/realtime build on
// an explicit numeric-loopback port. Never starts a server, imports a save, uses
// a persistent browser profile, or connects to protected/shared development ports.
import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { isSourceWater } from "../src/block-state.js";
import {
  fluidPlayConfig,
  installFluidPlayFixture,
} from "./fluid-play.browser-fixture.mjs";
import { chromeExecutable } from "./realtime/config.mjs";

if (!process.env.VOXELCRAFT_TEST_URL)
  throw new Error(
    "Set VOXELCRAFT_TEST_URL to a fresh isolated frozen realtime server"
  );
const base = new URL(process.env.VOXELCRAFT_TEST_URL);
const protectedPorts = new Set([
  "5173",
  "5280",
  "5290",
  "5297",
  "5311",
  "5352",
]);
if (
  !["http:", "https:"].includes(base.protocol) ||
  !["127.0.0.1", "[::1]"].includes(base.hostname) ||
  base.username ||
  base.password ||
  !base.port ||
  protectedPorts.has(base.port)
)
  throw new Error(
    "Require an explicit numeric-loopback port; never use 5173/5280/5290/5297/5311/5352"
  );
const url = new URL("/test/realtime/index.html", base);
url.searchParams.set("quality", "low");
url.searchParams.set("seed", "cedar-valley");
const { ids, cells, fluid } = fluidPlayConfig;
const coordinate = ({ x, y, z }) => `${x},${y},${z}`;
const cellOnly = ({ id, state, fluid }) => ({ id, state, fluid });
const owned = (state, name) => state.ownership[name].total;
const bucketTotal = (state) =>
  owned(state, "bucket") + owned(state, "waterBucket");
const near = (a, b, label) =>
  assert.ok(Math.abs(a - b) < 0.002, `${label}: ${a} versus ${b}`);

// Admissions continue while paused, legitimately restarting scans/adding regions.
// Storage and cold reload must preserve the *entire* pending cell queue and
// simulation clock/debt. Scan incarnations are conservatively reseeded on load.
const fluidReplay = (snapshot) => ({
  version: snapshot.fluids.version,
  seed: snapshot.fluids.seed,
  generatorVersion: snapshot.fluids.generatorVersion,
  dimensions: snapshot.fluids.dimensions.map((work) => ({
    dimension: work.dimension,
    clock: work.clock,
    accumulator: work.accumulator,
    queue: work.queue,
  })),
});

test("finite real-input water flow, waterlogging, kelp, sponge retention and saved replay", {
  timeout: 300000,
}, async (t) => {
  const browser = await chromium.launch({
    executablePath: await chromeExecutable(process.env.CHROME_BIN),
    headless: true,
    args: [
      "--disable-dev-shm-usage",
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
    ],
  });
  t.after(() => browser.close());
  const context = await browser.newContext({
    viewport: { width: 1100, height: 760 },
    serviceWorkers: "block",
  });
  const blocked = [];
  await context.route("**/*", (route) => {
    const requested = new URL(route.request().url());
    if (
      ["http:", "https:"].includes(requested.protocol) &&
      requested.origin !== url.origin
    ) {
      if (blocked.length < 8) blocked.push(requested.origin);
      return route.abort("blockedbyclient");
    }
    return route.continue();
  });
  await context.routeWebSocket("**/*", (socket) => {
    if (blocked.length < 8) blocked.push(socket.url());
    socket.close();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  const recordError = (error) => {
    if (errors.length < 24) errors.push(String(error));
  };
  page.on("pageerror", (error) => recordError(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") recordError(message.text());
  });
  let phase = "frozen host startup";
  let manifest;
  const read = () => page.evaluate(() => window.__voxelFluidPlay.read());
  const begin = (label) =>
    page.evaluate((value) => window.__voxelFluidPlay.begin(value), label);
  const ready = async () => {
    await page.waitForFunction(
      () => window.__voxelBot?.ready || window.__voxelBot?.error,
      undefined,
      { timeout: 60000 }
    );
    const state = await page.evaluate(() =>
      window.__voxelBot.state({ renderer: true })
    );
    assert.equal(new URL(page.url()).origin, url.origin);
    assert.equal(state.error, null);
    assert.equal(
      state.build.production,
      true,
      "require a frozen build, never HMR"
    );
    assert.equal(
      state.paused,
      true,
      "boot/load is inspected before simulation"
    );
    assert.equal(state.renderer.contextLost, false);
    assert.ok(state.view.visibleChunkGroups > 0);
    assert.deepEqual(errors, []);
    return state;
  };
  const draws = async (count = 2) => {
    const frame = await page.evaluate(
      () => window.__voxelBot.game.graphics.renderer.info.render.frame
    );
    await page.waitForFunction(
      ({ frame, count }) =>
        window.__voxelBot.game.graphics.renderer.info.render.frame >=
        frame + count,
      { frame, count }
    );
  };
  const pause = async () => {
    if (!(await page.evaluate(() => window.__voxelBot.game.paused)))
      await page.keyboard.press("Escape");
    await page.waitForFunction(() => {
      const game = window.__voxelBot.game;
      return game.paused && !game.player.enabled && !game.closingScreens;
    });
    await draws();
  };
  const enter = async () => {
    await page.locator(".play-button").click();
    await page.waitForFunction(() => {
      const game = window.__voxelBot.game;
      return (
        game.active &&
        !game.playing &&
        game.player.enabled &&
        game.player.grounded
      );
    });
  };
  const select = async (index) => {
    await page.keyboard.press(String(index + 1));
    await draws(1);
    assert.equal((await read()).selected, index);
  };

  function assertAim(state, name) {
    const expected = manifest.stances[name].hit;
    assert.equal(state.active, true);
    assert.equal(state.mode, "survival");
    assert.equal(state.grounded, true);
    assert.equal(state.mobTarget, false, "no entity may steal the use action");
    assert.ok(state.target, "the real current-frame physical-eye ray must hit");
    assert.equal(
      coordinate(state.target),
      coordinate(expected),
      "exact clicked cell"
    );
    assert.deepEqual(
      state.target.normal,
      expected.normal,
      "exact initial face"
    );
    assert.deepEqual(
      cellOnly(state.target),
      state.targetCell,
      "current ID/state/fluid"
    );
    const target = manifest.stances[name].aim;
    assert.ok(
      Math.hypot(
        target.x - state.eye.x,
        target.y - state.eye.y,
        target.z - state.eye.z
      ) <= 4.5,
      "all actions use the physical Survival reach"
    );
  }

  async function aim(name) {
    const target = manifest.stances[name].aim;
    // Real Remote RMB drags only. The 8px detour guarantees a recognized drag
    // even for a tiny correction; releasing it can never become a placement tap.
    for (let attempt = 0; attempt < 16; attempt++) {
      const state = await read();
      assert.equal(state.inputMode, "remote");
      assert.equal(state.sensitivity, 1);
      const dx = target.x - state.eye.x;
      const dy = target.y - state.eye.y;
      const dz = target.z - state.eye.z;
      const wantedYaw = Math.atan2(-dx, -dz);
      const wantedPitch = Math.atan2(dy, Math.hypot(dx, dz));
      const yawError = Math.atan2(
        Math.sin(state.yaw - wantedYaw),
        Math.cos(state.yaw - wantedYaw)
      );
      const pitchError = state.pitch - wantedPitch;
      if (Math.abs(yawError) < 0.003 && Math.abs(pitchError) < 0.003) {
        await draws(1); // Game.updateTarget, never an injected/forced hit.
        const aimed = await read();
        assertAim(aimed, name);
        return aimed;
      }
      const x = Math.max(-360, Math.min(360, yawError / 0.002));
      const y = Math.max(-200, Math.min(200, pitchError / 0.002));
      await page.mouse.move(550, 300);
      await page.mouse.down({ button: "right" });
      await page.mouse.move(558, 300);
      await page.mouse.move(550 + x, 300 + y);
      await page.mouse.up({ button: "right" });
      await draws(1);
    }
    throw new Error(`Physical aim did not converge for ${name}`);
  }

  async function start(name, slot) {
    await pause();
    const setup = await page.evaluate(
      (value) => window.__voxelFluidPlay.relocate(value),
      name
    );
    t.diagnostic(`AUTHORED STANCE ${JSON.stringify(setup)}`);
    await begin(phase);
    await enter();
    await select(slot);
    return aim(name);
  }

  async function use(name, { pauseImmediately = false } = {}) {
    await page.waitForFunction(() => {
      const game = window.__voxelBot.game;
      return game.active && game.elapsed - game.useActions.lastUse >= 0.21;
    });
    await draws(1);
    const before = await read();
    assertAim(before, name);
    await page.keyboard.press("v");
    if (pauseImmediately) await page.keyboard.press("Escape");
    const after = await read();
    assert.ok(
      after.lastUse > before.lastUse,
      "trusted V must reach the real use handler, even for a rejected action"
    );
    return before;
  }

  async function waitCell(name, expected) {
    await page.waitForFunction(
      ({ name, expected }) => {
        const helper = window.__voxelFluidPlay;
        const error = helper.error;
        if (error) throw new Error(error);
        const cell = helper.read().cells[name];
        return (
          cell &&
          Object.entries(expected).every(([key, value]) => cell[key] === value)
        );
      },
      { name, expected },
      { timeout: 45000 }
    );
  }
  const ticks = async (count) => {
    const clock = (await read()).fluid.clock;
    await page.waitForFunction(
      ({ clock, count }) => {
        const helper = window.__voxelFluidPlay;
        const error = helper.error;
        if (error) throw new Error(error);
        return helper.read().fluid.clock >= clock + count;
      },
      { clock, count },
      { timeout: 45000 }
    );
  };
  async function finish(details = {}) {
    await pause();
    const result = await page.evaluate(() => window.__voxelFluidPlay.end());
    assert.equal(result.error, null);
    assert.ok(result.frames > 0, "observe real rendered frames");
    assert.ok(
      result.inputs.length > 0 && result.inputs.every((input) => input.trusted)
    );
    assert.equal(result.current.mode, "survival");
    assert.equal(result.current.gpu.contextLost, false);
    assert.equal(result.current.gpu.badPrograms, 0);
    assert.equal(
      bucketTotal(result.current),
      3,
      "finite bucket ownership is conserved"
    );
    assert.ok(
      result.current.fluid.queued <= result.current.fluid.limits.maxQueued
    );
    t.diagnostic(
      `OBSERVED ${phase} ${JSON.stringify({
        frames: result.frames,
        transitions: result.changes.length,
        clocks: [result.initial.fluid.clock, result.current.fluid.clock],
        queued: result.current.fluid.queued,
        cells: result.current.cells,
        ownership: result.current.ownership,
        ...details,
      })}`
    );
    return result;
  }
  const inspectVolume = async () => {
    const volume = await page.evaluate(() => window.__voxelFluidPlay.volume());
    assert.equal(volume.reads, 504);
    assert.equal(
      volume.guardsIntact,
      true,
      "authored walls/floors/support stay intact"
    );
    const allowed = new Set(manifest.channel.map(coordinate));
    assert.ok(volume.water.every((cell) => allowed.has(coordinate(cell))));
    assert.ok(
      volume.water.length <= 8,
      "the authored channel has eight wettable cells"
    );
    return volume;
  };

  try {
    await page.goto(url.href, { waitUntil: "load", timeout: 60000 });
    const host = await ready();
    t.diagnostic(
      `FROZEN HOST ${JSON.stringify({
        origin: url.origin,
        build: host.build,
        renderer: host.renderer.renderer,
      })}`
    );
    await page.locator(".settings-toggle").click();
    await page.locator(".controls-settings-button").click();
    await page.locator("#input-mode-setting").selectOption("remote");
    await page.locator(".menu-back-button").click();
    await page.locator(".menu-back-button").click();
    await page.evaluate(installFluidPlayFixture, { config: fluidPlayConfig });
    manifest = await page.evaluate(() => window.__voxelFluidPlay.prepare());
    assert.ok(manifest.authoredCells <= fluidPlayConfig.limits.authoredCells);
    assert.ok(manifest.setupReads <= fluidPlayConfig.limits.setupReads);
    t.diagnostic(
      `AUTHORED SETUP ONLY ${JSON.stringify({
        label: manifest.label,
        provenance: manifest.provenance,
        origin: manifest.origin,
        bounds: manifest.bounds,
        naturalColumns: manifest.naturalColumns,
        authoredCells: manifest.authoredCells,
        setupReads: manifest.setupReads,
        supplies: fluidPlayConfig.supplies,
      })}`
    );
    assert.deepEqual(
      (await read()).hotbar.slice(0, 7),
      fluidPlayConfig.supplies
    );
    assert.equal(
      (await inspectVolume()).water.length,
      0,
      "no setup water/plant flow"
    );

    phase =
      "trusted pour -> source -> bounded lateral and downward normal ticks";
    const beforePour = await start("source", 0);
    assert.ok(beforePour.channel.every((cell) => cell.id === ids.air));
    await use("source");
    const poured = await read();
    assert.equal(poured.cells.source.id, ids.water);
    assert.equal(poured.cells.source.fluid, fluid.WATER_SOURCE);
    assert.deepEqual(poured.hotbar[0], { id: ids.bucket, count: 1 });
    await waitCell("lateral", { id: ids.water, fluid: fluid.WATER_1 });
    await waitCell("falling", { id: ids.water, fluid: fluid.WATER_FALLING });
    await waitCell("end", { id: ids.water, fluid: fluid.WATER_2 });
    const flow = await finish();
    const lateral = flow.changes.find(
      (entry) => entry.cells.lateral.fluid === fluid.WATER_1
    );
    const falling = flow.changes.find(
      (entry) => entry.cells.falling.fluid === fluid.WATER_FALLING
    );
    assert.ok(
      lateral && falling,
      "capture both genuine propagation transitions"
    );
    assert.ok(
      falling.clock > lateral.clock,
      "downstream water requires later simulation ticks"
    );
    assert.ok(
      flow.current.fluid.total.changedCells >
        flow.initial.fluid.total.changedCells
    );
    assert.equal((await inspectVolume()).water.length, 6);

    phase =
      "lateral flowing water refuses kelp without spending the finite stack";
    const lateralBefore = await start("lateral", 1);
    assert.equal(lateralBefore.cells.lateral.fluid, fluid.WATER_1);
    await use("lateral");
    await ticks(2);
    const lateralRefused = (await finish()).current;
    assert.deepEqual(lateralRefused.hotbar[1], lateralBefore.hotbar[1]);
    assert.equal(lateralRefused.handRevision, lateralBefore.handRevision);
    assert.deepEqual(lateralRefused.cells.lateral, lateralBefore.cells.lateral);
    assert.equal(owned(lateralRefused, "kelp"), 4);

    phase = "one finite kelp placed into real supported falling water";
    const beforeFalling = await start("falling", 1);
    assert.equal(beforeFalling.cells.falling.fluid, fluid.WATER_FALLING);
    await use("falling");
    await waitCell("falling", cells.kelp);
    const plantedFalling = (await finish()).current;
    assert.equal(plantedFalling.hotbar[1].count, 3);
    assert.deepEqual(
      plantedFalling.hotbar[1].data,
      fluidPlayConfig.supplies[1].data
    );
    assert.equal(owned(plantedFalling, "kelp"), 3);

    phase =
      "second finite kelp placed into source water without metadata replacement";
    const beforeSource = await start("source", 1);
    assert.equal(beforeSource.cells.source.fluid, fluid.WATER_SOURCE);
    await use("source");
    await waitCell("source", cells.kelp);
    const plantedSource = (await finish()).current;
    assert.equal(plantedSource.hotbar[1].count, 2);
    assert.deepEqual(
      plantedSource.hotbar[1].data,
      fluidPlayConfig.supplies[1].data
    );
    assert.equal(owned(plantedSource, "kelp"), 2);

    phase =
      "fill/scoop a real top slab, preserve ID/state and exchange one bucket";
    const beforeHost = await start("partial", 3);
    assert.deepEqual(beforeHost.cells.partial, cells.partial);
    await use("partial");
    await waitCell("partial", { ...cells.partial, fluid: fluid.WATER_SOURCE });
    const filled = await read();
    assert.deepEqual(filled.hotbar[3], { id: ids.bucket, count: 1 });
    assert.equal(bucketTotal(filled), 3);
    await use("partial");
    await waitCell("partial", cells.partial);
    const scooped = (
      await finish({
        hostBefore: beforeHost.cells.partial,
        hostFilled: filled.cells.partial,
      })
    ).current;
    assert.deepEqual(scooped.hotbar[3], fluidPlayConfig.supplies[3]);
    assert.deepEqual(scooped.cells.partial, beforeHost.cells.partial);

    phase =
      "real unsupported-source kelp refusal, then finite seagrass planting";
    await start("end", 3);
    await use("end");
    await waitCell("end", { id: ids.water, fluid: fluid.BUBBLE_DOWN });
    assert.deepEqual((await read()).hotbar[3], { id: ids.bucket, count: 1 });
    await select(1);
    const unsupported = await use("end");
    assert.equal(
      unsupported.target.id,
      cells.magma.id,
      "actual invalid support was clicked"
    );
    assert.ok(isSourceWater(unsupported.cells.end.fluid));
    await ticks(2);
    const refused = await read();
    assert.deepEqual(refused.hotbar[1], unsupported.hotbar[1]);
    assert.equal(refused.handRevision, unsupported.handRevision);
    assert.deepEqual(refused.cells.end, unsupported.cells.end);
    assert.equal(owned(refused, "kelp"), owned(unsupported, "kelp"));
    await select(2);
    await use("end");
    await waitCell("end", cells.seagrass);
    const grass = (await finish()).current;
    assert.equal(grass.hotbar[2], null);
    assert.equal(owned(grass, "seagrass"), 0);
    assert.deepEqual(grass.cells.falling, cells.kelp);
    assert.deepEqual(grass.cells.source, cells.kelp);

    phase =
      "finite dry sponge -> wet center, absorption and exactly-once real retention";
    const beforeSponge = await start("sponge", 4);
    assert.equal(beforeSponge.cells.sponge.id, ids.water);
    assert.equal(beforeSponge.cells.source.id, ids.kelp);
    assert.equal(beforeSponge.cells.falling.id, ids.kelp);
    assert.equal(beforeSponge.cells.end.id, ids.seagrass);
    await use("sponge");
    await waitCell("sponge", {
      id: ids.wetSponge,
      state: 0,
      fluid: fluid.NONE,
    });
    const absorbed = await read();
    assert.equal(absorbed.hotbar[4], null, "the one real sponge is consumed");
    for (const name of ["source", "falling", "end"])
      assert.deepEqual(absorbed.cells[name], cells.air);
    assert.equal(owned(absorbed, "kelp"), owned(beforeSponge, "kelp") + 2);
    // Fluid plant removal deliberately yields no seagrass loot. It must not
    // manufacture the otherwise placeable item during absorption or replay.
    assert.equal(owned(absorbed, "seagrass"), 0);
    await ticks(6);
    const retained = (
      await finish({
        kelpBefore: beforeSponge.ownership.kelp,
        kelpAfter: absorbed.ownership.kelp,
        seagrassDisposition:
          "removed once; no loot under the real fluid plant rules",
      })
    ).current;
    assert.equal(
      owned(retained, "kelp"),
      4,
      "rechecks cannot duplicate retained plants"
    );
    assert.equal(owned(retained, "seagrass"), 0);
    assert.deepEqual(retained.hotbar[1], beforeSponge.hotbar[1]);
    assert.equal((await inspectVolume()).water.length, 0);

    phase =
      "ordinary placement into the player's real body refuses without spending";
    const beforeCollision = await start("collision", 5);
    assert.deepEqual(beforeCollision.cells.collision, cells.air);
    await use("collision");
    await ticks(2);
    const collision = (await finish()).current;
    assert.deepEqual(collision.hotbar[5], beforeCollision.hotbar[5]);
    assert.equal(collision.handRevision, beforeCollision.handRevision);
    assert.deepEqual(collision.cells.collision, cells.air);
    near(
      collision.position.x,
      beforeCollision.position.x,
      "physical collision stance x"
    );
    near(
      collision.position.y,
      beforeCollision.position.y,
      "physical collision stance y"
    );
    near(
      collision.position.z,
      beforeCollision.position.z,
      "physical collision stance z"
    );

    phase = "a third real finite pour leaves work for Save World/reload";
    await start("source", 6);
    // No intervening polling or simulation writes: real V then real Escape.
    // Require actual unfinished propagation; never manufacture pending work if
    // this input pair misses the intended checkpoint on a particular host.
    await use("source", { pauseImmediately: true });
    const checkpoint = (await finish()).current;
    assert.deepEqual(checkpoint.hotbar[6], { id: ids.bucket, count: 1 });
    assert.equal(checkpoint.cells.source.id, ids.water);
    assert.equal(checkpoint.cells.source.fluid, fluid.WATER_SOURCE);
    assert.equal(
      checkpoint.cells.falling.id,
      ids.air,
      "downward replay is still pending"
    );
    const beforeSave = await page.evaluate(() =>
      window.__voxelFluidPlay.snapshot()
    );
    const work = beforeSave.fluids.dimensions.find(
      (entry) => entry.dimension === manifest.dimension
    );
    assert.ok(
      work?.queue.some(([x, y, z]) =>
        manifest.channel.some(
          (position) => coordinate(position) === `${x},${y},${z}`
        )
      ),
      "real local queued work, not a fabricated scheduler entry"
    );

    phase = "trusted Save World and real storage readback while paused";
    await page.locator(".world-settings-button").click();
    const previousArchiveRevision = await page.evaluate(
      () => window.__voxelBot.game.archive.storage.revision
    );
    await page.locator(".save-button").click();
    await page.waitForFunction(
      (revision) =>
        !document.querySelector(".save-button").disabled &&
        window.__voxelBot.game.storageStatus === "Saved on this device" &&
        window.__voxelBot.game.archive.storage.revision !== revision,
      previousArchiveRevision,
      { timeout: 30000 }
    );
    assert.notEqual(
      await page.locator(".storage-status").getAttribute("data-state"),
      "error"
    );
    const saved = await page.evaluate(() => window.__voxelFluidPlay.stored());
    assert.deepEqual(saved.inventory, beforeSave.inventory);
    assert.deepEqual(saved.world, beforeSave.world);
    assert.deepEqual(saved.pickups, beforeSave.pickups);
    assert.deepEqual(saved.overflow, beforeSave.overflow);
    assert.deepEqual(fluidReplay(saved), fluidReplay(beforeSave));
    t.diagnostic(
      `PASS real archive ${JSON.stringify({
        edits: saved.world.edits.length,
        selected: saved.inventory.selected,
        clock: work.clock,
        accumulator: work.accumulator,
        queued: work.queue.length,
        pickups: saved.pickups.items.length,
        overflow: saved.overflow.entries.length,
      })}`
    );
    await page.evaluate(() => window.__voxelFluidPlay.dispose());
    await page.reload({ waitUntil: "load", timeout: 60000 });
    await ready();
    await page.evaluate(installFluidPlayFixture, {
      config: fluidPlayConfig,
      manifest,
    });
    const restored = await page.evaluate(() =>
      window.__voxelFluidPlay.snapshot()
    );
    assert.deepEqual(restored.inventory, saved.inventory);
    assert.deepEqual(restored.world, saved.world);
    assert.deepEqual(restored.pickups, saved.pickups);
    assert.deepEqual(restored.overflow, saved.overflow);
    assert.deepEqual(fluidReplay(restored), fluidReplay(saved));
    const loaded = await read();
    assert.deepEqual(loaded.cells, checkpoint.cells);
    assert.equal(owned(loaded, "kelp"), 4);
    assert.equal(bucketTotal(loaded), 3);
    await draws(4);
    const stillPaused = await read();
    assert.equal(stillPaused.fluid.clock, loaded.fluid.clock);
    assert.deepEqual(stillPaused.hotbar, loaded.hotbar);
    assert.deepEqual(stillPaused.cells, loaded.cells);

    phase =
      "Play resumes restored pending water work without new items or duplicate loot";
    await begin(phase);
    await enter(); // No setup, repositioning, queue injection or method call after load.
    await waitCell("lateral", { id: ids.water, fluid: fluid.WATER_1 });
    await waitCell("falling", { id: ids.water, fluid: fluid.WATER_FALLING });
    const replay = (await finish()).current;
    assert.ok(replay.fluid.clock > loaded.fluid.clock);
    assert.ok(replay.fluid.total.evaluated > loaded.fluid.total.evaluated);
    assert.ok(
      replay.fluid.total.changedCells > loaded.fluid.total.changedCells
    );
    // Real pickup after resuming may fill an empty slot. Compare stable finite
    // supplies and total ownership across inventory + pickups + overflow instead.
    for (const slot of [0, 1, 3, 5, 6])
      assert.deepEqual(replay.hotbar[slot], loaded.hotbar[slot]);
    assert.equal(owned(replay, "kelp"), 4);
    assert.equal(owned(replay, "seagrass"), 0);
    assert.equal(replay.cells.sponge.id, ids.wetSponge);
    await inspectVolume();
    const inputs = await page.evaluate(() => window.__voxelBot.state().inputs);
    assert.ok(inputs.trusted > 0);
    assert.equal(inputs.untrusted, 0);
    assert.deepEqual(blocked, []);
    assert.deepEqual(errors, []);
    t.diagnostic(
      "PASS: real finite pour/flow, slab fill/scoop, falling/source kelp, lateral/support/body refusals, sponge retention, actual storage and normal queued reload replay."
    );
  } catch (error) {
    const diagnostic = await page
      .evaluate(() => {
        const helper = window.__voxelFluidPlay;
        const observed = helper?.observations();
        return {
          hostError: window.__voxelBot?.error,
          state: helper?.read(),
          observationError: observed?.error,
          transitions: observed?.changes.slice(-3),
        };
      })
      .catch(() => null);
    t.diagnostic(
      `FAILED ${phase} ${JSON.stringify({ errors, blocked, diagnostic })}`
    );
    throw error;
  } finally {
    await page
      .evaluate(() => window.__voxelFluidPlay?.dispose())
      .catch(() => {});
  }
});
