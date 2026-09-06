import assert from "node:assert/strict";
import { isSafeRespawnPosition } from "../src/bed-spawn.js";
import { BLOCK } from "../src/blocks.js";
import { ContainerUI } from "../src/settlement-ui.js";
import { normalizeWorldComponents } from "../src/save-preflight.js";
import { exportWorldFile, parseWorldFile } from "../src/storage.js";
import { gameMobFixture } from "./game-mob-integration-fixture.js";

export function assertExactWorldEdits(actual, expected) {
  // IndexedDB stores one record per chunk and reads them in key order. Ordering
  // is not world ownership: compare every complete edit, not merely counts/IDs.
  const canonical = world => {
    assert.equal(new Set(world.edits.map(edit => JSON.stringify(edit.slice(0, 4)))).size,
      world.edits.length, "no duplicate edited coordinates");
    return { ...world, edits: [...world.edits].sort((a, b) =>
      JSON.stringify(a).localeCompare(JSON.stringify(b))) };
  };
  assert.deepEqual(canonical(actual), canonical(expected));
}

export function nativeCells(world, ids, center) {
  const chunks = [...world.chunks.values()].filter(chunk => !center || (
    Math.abs(chunk.cx - Math.floor(center.x / 16)) <= 3 &&
    Math.abs(chunk.cz - Math.floor(center.z / 16)) <= 3
  ));
  assert.ok(chunks.length <= 49, "fixed per-window native planning budget");
  const cells = [];
  for (const chunk of chunks)
    for (let index = 0; index < chunk.blocks.length; index++) {
      const id = chunk.blocks[index];
      if (!ids.includes(id)) continue;
      cells.push({
        x: chunk.cx * 16 + index % 16,
        y: chunk.minY + Math.floor(index / 256),
        z: chunk.cz * 16 + Math.floor(index / 16) % 16,
        id,
      });
    }
  return cells;
}

/** Scripted approach only: real dry collision-safe body and unobstructed Game ray. */
export function approachResource(f, at, { collectible = false } = {}) {
  for (const radius of [1, 1.5, 2])
    for (const dy of [0, -1, 1])
      for (let side = 0; side < 8; side++) {
        const angle = side * Math.PI / 4;
        const position = {
          x: at.x + 0.5 + radius * Math.sin(angle),
          y: at.y + dy,
          z: at.z + 0.5 + radius * Math.cos(angle),
        };
        if (collectible && Math.hypot(
          position.x - at.x - 0.5, position.y - at.y - 0.5, position.z - at.z - 0.5,
        ) > 1.6) continue;
        if (!isSafeRespawnPosition(f.world, position)) continue;
        f.player.setPosition(position);
        f.aim({ position: { x: at.x + 0.5, y: at.y + 0.5, z: at.z + 0.5 } });
        f.game.updateTarget();
        const hit = f.game.target;
        if (hit?.x === at.x && hit.y === at.y && hit.z === at.z && !f.game.meleeTarget)
          return hit;
      }
  return null;
}

export async function reloadResourceStage(t, f) {
  assert.equal(f.gameplay.cursor, null);
  const saved = f.snapshot();
  const parsed = parseWorldFile(exportWorldFile(saved));
  assert.deepEqual(parsed.world, saved.world, "every native harvest edit survives file export");
  assert.deepEqual(normalizeWorldComponents(parsed).gameplay, saved.gameplay);
  const restored = await gameMobFixture(t, {
    saved: parsed, generatorFactory: null, admissionRadius: 3,
  });
  assert.deepEqual(restored.world.serialize(), saved.world);
  assert.deepEqual(restored.gameplay.serialize(), saved.gameplay);
  assert.deepEqual(restored.game.settlement.serialize(), saved.settlement);
  return restored;
}

/** Only DOM presentation is headless; use the production session/payment controller. */
export function attachResourceContainer(f) {
  const ui = Object.assign(Object.create(ContainerUI.prototype), {
    document: { activeElement: null },
    element: { hidden: true, dataset: {}, contains: () => false },
    closeButton: { focus() {} },
    _session: null,
    _interactions: { busy: false, reset() {} },
    _setStatus() {},
    refresh() { return true; },
    onOpenChange() {},
    onToast() {},
    onChange() { f.game.scheduleSave(); },
    prepareDrops: stacks => f.game.preparePlayerDrops(stacks),
    prepareExperience: amount => f.game.harvestActions.prepareExperience(amount, f.player.position),
  });
  f.game.containerUI = ui;
  return ui;
}

export function insertResourceCount(f, ui, id, amount, containerIndex) {
  const original = f.gameplay.countPlain(id);
  for (let moved = 0; moved < amount; moved++) {
    const index = f.gameplay.slots.findIndex(stack => stack?.id === id);
    assert.ok(index >= 0, "only already-owned native resources may be inserted");
    assert.equal(ui._action({ type: "click", area: "inventory", index, button: 0 }).ok, true);
    assert.equal(ui._action({ type: "click", area: "container", index: containerIndex, button: 2 }).ok, true);
    if (f.gameplay.cursor)
      assert.equal(ui._action({ type: "click", area: "inventory", index, button: 0 }).ok, true);
  }
  assert.equal(f.gameplay.cursor, null);
  assert.equal(f.gameplay.countPlain(id), original - amount);
}

export function mineResource(t, f, at, outputId) {
  assert.ok(approachResource(f, at, { collectible: true }), `No physical approach to ${JSON.stringify(at)}`);
  const before = f.gameplay.countPlain(outputId);
  const tool = f.gameplay.getHandStack();
  assert.ok(tool?.durability);
  const commit = t.mock.method(f.game.harvestActions, "commit");
  let frames = 0;
  f.game.heldAction = "mine";
  for (; frames < 80 && f.world.get(at.x, at.y, at.z) === at.id; frames++) {
    f.game.updateTarget();
    assert.deepEqual(
      [f.game.target?.x, f.game.target?.y, f.game.target?.z],
      [at.x, at.y, at.z],
      "every mining step targets the actual reachable native cell",
    );
    f.frame();
  }
  f.game.heldAction = null;
  assert.equal(f.world.get(at.x, at.y, at.z), BLOCK.AIR, "bounded physical Game mining completes");
  assert.equal(f.gameplay.getHandStack().durability, tool.durability - 1);
  const results = commit.mock.calls.map(call => call.result).filter(result => result?.ok);
  commit.mock.restore();
  assert.equal(results.length, 1, "exactly one successful harvest receipt");
  const produced = results[0].drops.filter(stack => stack.id === outputId)
    .reduce((sum, stack) => sum + stack.count, 0);
  assert.ok(produced > 0);
  for (let step = 0; step < 40 && f.gameplay.countPlain(outputId) < before + produced; step++) {
    // Walk/teleport approach is authored, but collection is the actual Game
    // frame's nearby pickup transaction, never an inventory grant or take sink.
    const drops = f.game.pickups.serialize().items.filter(stack => stack.id === outputId);
    for (const drop of drops) {
      let approached = false;
      for (const radius of [0, 0.5, 1, 1.5]) {
        if (approached) break;
        for (const dy of [0, -1, 1]) {
          if (approached) break;
          for (let side = 0; side < 8; side++) {
            const position = {
              x: drop.x + radius * Math.sin(side * Math.PI / 4),
              y: Math.floor(drop.y) + dy,
              z: drop.z + radius * Math.cos(side * Math.PI / 4),
            };
            if (Math.hypot(position.x - drop.x, position.y - drop.y, position.z - drop.z) >= 1.8 ||
                !isSafeRespawnPosition(f.world, position)) continue;
            f.player.setPosition(position);
            approached = true;
            break;
          }
        }
      }
    }
    f.frame();
    frames++;
  }
  assert.equal(f.gameplay.countPlain(outputId), before + produced,
    `every natural drop is physically picked up: ${JSON.stringify({
      at, player: f.player.position, pickups: f.game.pickups.serialize(), overflow: f.overflow.serialize(),
    })}`);
  return { frames, produced };
}
