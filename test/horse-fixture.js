import assert from "node:assert/strict";
import * as THREE from "three";
import { BLOCK } from "../src/blocks.js";
import { normalizeCell } from "../src/block-state.js";
import { DropOverflow } from "../src/drop-overflow.js";
import { ExperienceOrbs } from "../src/experience-orbs.js";
import { Gameplay } from "../src/gameplay.js";
import { Horses } from "../src/horses.js";
import { getItem, ITEM } from "../src/items.js";
import { Wildlife } from "../src/wildlife.js";
import { createWorldContext } from "../src/world-spec.js";
import { authoredEcologyWorld } from "./ecology-host-fixture.js";

export const horseRecord = (id = "horse:one", overrides = {}) => ({
  id, dimension: "overworld", alive: true, tamed: false, temper: 0,
  failedAttempts: 0, saddle: null, rider: null, tamingTicksLeft: 60, motion: null, ...overrides,
});

/** Real World ingestion/mutations + Wildlife + Gameplay + retained drops + XP.
 * Flat authored terrain is intentional; this is not browser/Survival evidence.
 */
export function horseFixture(t, {
  saved, hooks = {}, maxEntities, overflowEntries, bind = true,
  seed = saved?.horses?.seed ?? "horse-ownership-fixture",
  generatorVersion = saved?.horses?.generatorVersion ?? 4, floor = 0,
} = {}) {
  const { world, generated } = authoredEcologyWorld({
    seed, generatorVersion, floor, water: floor, biomeId: "plains",
  });
  const context = createWorldContext(world), coordinator = world.coordinator, scene = new THREE.Scene();
  if (saved) assert.equal(world.loadEdits(saved.world), true);
  const gameplay = new Gameplay({ coordinator, context, mode: "survival" });
  const overflow = new DropOverflow({ coordinator, context, ...(overflowEntries ? { maxEntries: overflowEntries } : {}) });
  const experience = new ExperienceOrbs(scene, world, {
    context, coordinator, prepareCollect: (amount) => gameplay.prepareExperience(amount),
  });
  const actor = { position: saved?.actor?.position ?? { x: 8.5, y: floor + 1, z: 12.5 },
    dimension: "overworld", dead: false, targetKey: "player:horse-test-life" };
  const f = { world, generated, context, coordinator, scene, gameplay, overflow, experience, actor,
    events: [], crossMountAllowed: true, frameId: 0, elapsed: 0, changes: 0 };
  const wildlife = new Wildlife(scene, world, {
    context, maxEntities, autoSpawn: false,
    onDrop: () => assert.fail("Horse resources must never enter the legacy drop path"),
  });
  f.wildlife = wildlife;
  f.readOwner = () => ({ ...actor, position: { ...actor.position },
    eye: { ...actor.position, y: actor.position.y + 1.62 },
    dead: actor.dead || gameplay.dead, dimension: actor.dimension });
  f.horses = new Horses(null, world, {
    gameplay, context, coordinator, overflow, experienceOrbs: experience,
    readOwner: () => f.readOwner(),
    canMount: () => f.crossMountAllowed,
    onEvent: (event) => { f.events.push(event); },
    onChange: () => { f.changes++; },
    ...hooks,
  });
  if (saved) {
    assert.equal(gameplay.load(saved.gameplay, { context, notify: false }), true);
    assert.equal(overflow.load(saved.overflow, { context }), true);
    assert.equal(experience.load(saved.experience, { context }), true);
    assert.equal(f.horses.load(saved.horses), true);
    assert.equal(wildlife.load(saved.mobs, { context, horses: saved.horses }), true);
  }
  if (bind) assert.equal(f.horses.bindWildlife(wildlife), true);
  wildlife.update(0, 0, actor.position, { mode: "survival", health: 20, timeOfDay: 0.5 });
  let authoredId = 0;
  Object.assign(f, {
    spawn(id = `horse:${authoredId++}`, position = { x: 8.5, y: floor + 1, z: 8.5 }) {
      const mob = wildlife.spawn("horse", position, { id });
      assert.ok(mob, `Existing Wildlife horse required: ${id}`);
      return mob;
    },
    hold(name, { count = 1, hand = "main", data } = {}) {
      const item = name === null ? null : getItem(ITEM[name] ?? BLOCK[name]);
      if (name !== null) assert.ok(item, `Parent checkpoint must register real ${name}`);
      const stack = item ? { id: item.id, count,
        ...(item.durability ? { durability: item.durability } : {}),
        ...(data ? { data } : {}) } : null;
      assert.equal(gameplay.inventoryTransaction((draft) => {
        if (hand === "main") draft.slots[gameplay.selected] = stack;
        else draft.offhand = stack;
        return true;
      }, { notify: false }), true);
      return stack;
    },
    put(changes) {
      assert.equal(world.applyCells(changes.map(([x, y, z, id]) => ({
        x, y, z, before: world.getCell(x, y, z), after: normalizeCell({ id }),
      }))), true);
    },
    ring(id = BLOCK.STONE) {
      const changes = [];
      for (let y = floor + 1; y <= floor + 5; y++)
        for (let x = 6; x <= 10; x++)
          for (let z = 6; z <= 10; z++)
            if (x === 6 || x === 10 || z === 6 || z === 10) changes.push([x, y, z, id]);
      f.put(changes);
    },
    tick(count = 1, controls = {}, dt = 0.05) {
      let result;
      for (let index = 0; index < count; index++) {
        result = f.horses.update(dt, { viewer: actor.position, controls: { player: controls }, frameId: ++f.frameId });
        const pose = f.horses.riderPose() ?? f.horses.takeExitPose();
        if (pose) actor.position = { ...pose.position };
        f.elapsed += dt;
        wildlife.update(dt, f.elapsed, actor.position, {
          mode: gameplay.mode, health: gameplay.health, timeOfDay: 0.5,
          playerEye: { ...actor.position, y: actor.position.y + 1.62 },
        });
      }
      return result;
    },
    tame(mob) {
      f.hold("WHEAT", { count: 40 });
      while ((f.horses.state(mob.id)?.temper ?? 0) < 100)
        assert.equal(f.horses.feed(mob.id).ok, true);
      assert.equal(f.horses.state(mob.id).tamed, false, "food never instantly tames");
      f.hold(null);
      assert.equal(f.horses.mount(mob.id).ok, true);
      f.tick(60);
      assert.equal(f.horses.state(mob.id).tamed, true);
      return mob;
    },
    saddle(mob, name = "Trail saddle") {
      const stack = f.hold("SADDLE", { data: { version: 1, name } });
      assert.equal(f.horses.slotAction(mob.id, {
        type: "quickMove", area: "inventory", index: gameplay.selected,
      }).ok, true);
      assert.deepEqual(f.horses.state(mob.id).saddle, stack);
      return stack;
    },
    snapshot: () => ({
      world: world.serialize(), mobs: wildlife.serialize(), horses: f.horses.serialize(),
      gameplay: gameplay.serialize(), overflow: overflow.serialize(), experience: experience.serialize(),
      actor: structuredClone(actor),
    }),
    ownership: () => ({ ...f.snapshot(), bytes: coordinator.budget.totalBytes }),
    totals: () => ({
      drops: overflow.serialize().entries,
      xp: experience.serialize().orbs.reduce((sum, orb) => sum + orb.amount, 0),
    }),
  });
  t.after(() => {
    if (f.horses.mountFor()) f.horses.releasePassenger("player", { travelling: true });
    f.horses.dispose();
    wildlife.dispose();
    experience.dispose();
    overflow.dispose();
    gameplay.dispose();
    world.dispose();
  });
  return f;
}

export function horseVeto(t, coordinator) {
  const owner = {};
  assert.equal(coordinator.register(owner, 0), true);
  t.after(() => coordinator.release(owner));
  return { owner, beforeBytes: 0, afterBytes: 0, validate: () => false,
    publish: () => assert.fail("A refused transaction must publish nothing") };
}
