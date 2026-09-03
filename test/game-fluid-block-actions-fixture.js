import assert from "node:assert/strict";
import * as THREE from "three";
import { BLOCK } from "../src/blocks.js";
import { GameUseActions } from "../src/game-use-actions.js";
import { ITEM } from "../src/items.js";
import { Player } from "../src/player.js";
import { raycast } from "../src/world.js";
import { InputElement } from "./control-fixture.js";
import { fluidServicesFixture } from "./game-fluid-services-fixture.js";

export const CENTER = Object.freeze({ x: 8, y: 1, z: 8 });
export const named = (id, count = 3, name = "Wetland reserve") => ({
  id,
  count,
  data: { version: 1, name },
});

export function aimAt(
  f,
  point = { x: 8.5, y: 1, z: 8.5 },
  position = { x: 8.5, y: 1, z: 11.5 },
  reach = f.gameplay.mode === "creative" ? 5 : 4.5
) {
  const { player, game, world } = f;
  player.setPosition(position);
  const dx = point.x - player.eyePosition.x;
  const dy = point.y - player.eyePosition.y;
  const dz = point.z - player.eyePosition.z;
  player.yaw = Math.atan2(-dx, -dz);
  player.pitch = Math.atan2(dy, Math.hypot(dx, dz));
  player._syncCamera(0);
  game.target = raycast(world, player.eyePosition, player.forward, reach);
  return game.target;
}

export function setHand(f, hand, stack) {
  assert.equal(
    f.gameplay.inventoryTransaction((owned) => {
      if (hand === "main")
        owned.slots[f.gameplay.selected] = structuredClone(stack);
      else owned.offhand = structuredClone(stack);
      return true;
    }),
    true
  );
}

/** Authored cells and real World/Player/service/inventory/retention owners. */
export function fluidBlockGame(
  t,
  {
    id = BLOCK.KELP,
    hand = "main",
    mode = "survival",
    initial = [],
    ...options
  } = {}
) {
  const cells = new Map();
  for (const cell of [
    [8, 1, 8, id === BLOCK.KELP ? BLOCK.WATER : BLOCK.AIR],
    ...initial,
  ])
    cells.set(cell.slice(0, 3).join(","), cell);
  const f = fluidServicesFixture(t, {
    base: BLOCK.AIR,
    initial: [...cells.values()],
    ...options,
  });
  const document = new EventTarget();
  document.defaultView = new EventTarget();
  document.pointerLockElement = null;
  const element = new InputElement(document);
  const camera = new THREE.PerspectiveCamera(75);
  const player = new Player(camera, f.world, element, { inputMode: "remote" });
  t.after(() => player.dispose());
  const events = [];
  Object.assign(f.game, {
    active: true,
    elapsed: 1,
    mobTarget: null,
    player,
    effects: {
      swing: 0,
      offhand: { swing: 0 },
      sound: (...args) => events.push(["sound", ...args]),
    },
    graphics: {
      camera,
      rebuildDirty: (count) => events.push(["rebuild", count]),
    },
    scheduleSave: () => events.push(["save"]),
    refreshHud: () => events.push(["hud"]),
    updateTarget() {
      events.push(["target"]);
      this.target = raycast(
        this.world,
        this.player.eyePosition ?? this.graphics.camera.position,
        this.player.forward,
        this.gameplay.mode === "creative" ? 5 : 4.5
      );
    },
  });
  Object.assign(f, { player, camera, element, events, id, hand });
  assert.equal(f.gameplay.setMode(mode), true);
  assert.equal(
    f.gameplay.inventoryTransaction((owned) => {
      owned.slots.fill(null);
      owned.slots[9] = named(ITEM.STICK, 7, "Unrelated supplies");
      owned.slots[0] =
        hand === "main" && mode === "survival"
          ? named(id)
          : named(BLOCK.DIRT, 5, "Unrelated main hand");
      owned.offhand = hand === "offhand" ? named(id) : null;
      return true;
    }),
    true
  );
  if (mode === "creative")
    assert.equal(
      f.gameplay.assignSlot(0, hand === "main" ? id : BLOCK.DIRT),
      true
    );
  f.game.useActions = new GameUseActions(f.game);
  aimAt(f);
  assert.ok(f.game.target, "fixture must start with a real physical-eye hit");
  f.ownership = () => ({
    ...f.snapshot(),
    fluid: f.service.fluids.serialize(),
    bytes: f.coordinator.budget.totalBytes,
    reservations: [
      f.world,
      f.gameplay,
      f.service,
      f.service.fluids,
      f.overflow,
      f.settlement,
    ].map((owner) => f.coordinator.usage(owner)),
    revisions: [
      f.world._editRevision,
      f.gameplay.revision,
      f.gameplay.getHandRevision("main"),
      f.gameplay.getHandRevision("offhand"),
      f.overflow.revision,
      f.settlement.revision,
    ],
    chunks: [...f.world.chunks].map(([key, chunk]) => [
      key,
      chunk.incarnation,
      chunk.revision,
    ]),
  });
  return f;
}

/** Observe the real coordinator; never fabricate a successful commit. */
export function recordCommits(f) {
  const commit = f.coordinator.commit.bind(f.coordinator);
  const calls = [];
  f.coordinator.commit = (participants) => {
    calls.push(participants);
    return commit(participants);
  };
  return calls;
}

export const retainedCounts = (f) => {
  const counts = new Map();
  for (const entry of f.overflow.serialize().entries)
    counts.set(entry.id, (counts.get(entry.id) ?? 0) + entry.count);
  return counts;
};

export function assertNoFeedback(f) {
  assert.deepEqual(f.events, []);
  assert.equal(f.game.effects.swing, 0);
  assert.equal(f.game.effects.offhand.swing, 0);
}
