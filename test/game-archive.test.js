import assert from "node:assert/strict";
import test from "node:test";
import { GameArchive } from "../src/game-archive.js";
import { TransitionGate } from "../src/transition-gate.js";

function fixture() {
  const messages = [];
  return {
    transitionGate: new TransitionGate(),
    world: {
      dimension: "overworld",
      serialize: () => ({ seed: "archive", edits: [] }),
    },
    player: {
      position: { x: 500, y: 40, z: 200 },
      yaw: 0,
      pitch: 0,
      flying: false,
    },
    gameplay: { serialize: () => ({ mode: "survival" }) },
    wildlife: { serialize: () => ({ mobs: [] }) },
    pickups: { serialize: () => ({ items: [] }) },
    experienceOrbs: {
      serialize: () => ({
        version: 1,
        orbs: [{ amount: 5, x: 500, y: 40, z: 200, dimension: "overworld" }],
      }),
    },
    overflow: { serialize: () => ({ entries: [] }) },
    fuses: { serialize: () => ({ entries: [] }) },
    settlement: { serialize: () => ({ chests: [], crops: [] }) },
    mobStates: { nether: { mobs: ["retained"] } },
    currentTime: 0.5,
    ui: { toast: (text) => messages.push(text) },
    messages,
  };
}

test("save failures return failure to async UI controls, never a success result", async () => {
  const game = fixture();
  const archive = new GameArchive(game, {
    save: async () => {
      throw new Error("Quota exceeded");
    },
  });
  const result = await archive.save(true);
  assert.deepEqual(result, { ok: false, message: "Quota exceeded" });
  assert.ok(game.storageStatus.includes("Export"));
  assert.ok(
    game.messages.every((message) => !message.startsWith("World saved"))
  );
});

test("successful archive save contains all persistent gameplay systems and inactive dimension mobs", async () => {
  const game = fixture();
  let captured;
  const archive = new GameArchive(game, {
    save: async (data) => {
      captured = data;
    },
    requestPersistence: async () => true,
  });
  assert.deepEqual(await archive.save(true), { ok: true });
  assert.deepEqual(captured.mobStates.nether, { mobs: ["retained"] });
  assert.deepEqual(captured.pickups, { items: [] });
  assert.equal(captured.experienceOrbs.orbs[0].amount, 5);
  assert.deepEqual(captured.settlement, { chests: [], crops: [] });
  assert.equal(captured.player.x, 500);
});

test("invalid or oversized imports fail before touching the active world", async () => {
  const game = fixture();
  game.initialize = () => assert.fail("Must not replace the active world");
  const archive = new GameArchive(game, {});
  assert.equal(
    (await archive.importWorld({ size: 100, text: async () => "not JSON" })).ok,
    false
  );
  assert.equal(
    (await archive.importWorld({ size: 49 * 1024 * 1024 })).ok,
    false
  );
});

test("portable world snapshots never include browser input mode or sensitivity", () => {
  const game = fixture();
  game.controlPreferences = { inputMode: "remote", mouseSensitivity: 2 };
  game.player.inputMode = "remote";
  game.player.mouseSensitivity = 2;
  const saved = new GameArchive(game, {}).snapshot();
  assert.equal("controlPreferences" in saved, false);
  assert.equal("inputMode" in saved.player, false);
  assert.equal("mouseSensitivity" in saved.player, false);
  game.controlPreferences = { inputMode: "native", mouseSensitivity: 0.5 };
  assert.deepEqual(new GameArchive(game, {}).snapshot(), saved);
});

test("fullbright inspection never enters a portable save or changes its contents", () => {
  const game = fixture();
  const archive = new GameArchive(game, {});
  const natural = archive.snapshot();
  game.viewPreferences = { fullbrightInspection: true };
  game.graphics = { fullbrightInspection: true };
  const inspection = archive.snapshot();
  assert.equal("viewPreferences" in inspection, false);
  assert.equal("fullbrightInspection" in inspection, false);
  assert.deepEqual(inspection, natural);
  game.viewPreferences.fullbrightInspection = false;
  game.graphics.fullbrightInspection = false;
  assert.deepEqual(archive.snapshot(), natural);
});

test("GUI scale and camera perspective stay outside portable world data", () => {
  const game = fixture();
  const archive = new GameArchive(game, {});
  const original = archive.snapshot();
  game.viewPreferences = { fullbrightInspection: false, guiScale: 3 };
  game.player.perspective = "front";
  assert.deepEqual(archive.snapshot(), original);
});
