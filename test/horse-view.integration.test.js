import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { isMobPartVisible, MAX_PARTS_PER_MOB } from "../src/mob-models.js";
import { MAX_MOBS, MAX_PROJECTILES } from "../src/mob-species.js";
import { horseFixture, horseVeto } from "./horse-fixture.js";

const view = (extra = {}) => ({
  tamed: false, saddled: false, ridden: false, grounded: true, swimming: false, ...extra,
});
const assertView = (horse, expected, message) => {
  assert.deepEqual(horse.horseView, expected, message);
  assert.equal(Object.isFrozen(horse.horseView), true);
  assert.equal(horse.tamed, false, "horse ownership never repurposes the wolf tame flag");
};
const visibleCount = (horse) => horse.model.parts.filter((part) => isMobPartVisible(part, horse)).length;

test("tracking and untamed bareback mounting publish frozen owner-derived views immediately", (t) => {
  const f = horseFixture(t), horse = f.spawn();
  f.hold("SADDLE");
  horse.horseSaddled = true;
  horse.heldItem = { name: "Saddle" };
  f.wildlife.render(0);
  assert.equal(horse.horseView, null, "an untracked held saddle grants no presentation state");
  const bare = visibleCount(horse);
  assert.ok(bare < horse.model.parts.length);
  assert.equal(f.horses.track(horse.id).ok, true);
  assertView(horse, view());
  f.hold(null);
  const plan = f.horses.prepareMount(horse.id), before = horse.horseView;
  assert.equal(plan.ok, true);
  assert.equal(horse.horseView, before);
  const veto = horseVeto(t, f.coordinator);
  assert.equal(f.coordinator.commit([...plan.participants, veto]).ok, false);
  assert.equal(horse.horseView, before);
  assert.equal(f.horses.commit(plan).ok, true);
  assertView(horse, view({ ridden: true }));
  assert.equal(visibleCount(horse), bare);
  assert.throws(() => { horse.horseView.saddled = true; }, TypeError);
  assert.equal(f.horses.releasePassenger("player", { travelling: true }).ok, true);
  assertView(horse, view());
});

test("committed tack drives native batching and picking; preparation, veto and held items never do", (t) => {
  const f = horseFixture(t), horse = f.tame(f.spawn());
  horse.root.rotation.y = horse.targetYaw = 0;
  assertView(horse, view({ tamed: true, ridden: true }));
  const saddle = f.hold("SADDLE", { data: { version: 1, name: "Visible only after commit" } });
  f.wildlife.render(0);
  const bare = visibleCount(horse), mesh = f.wildlife.mesh, resources = f.wildlife.skinResources;
  const buffers = [resources.rects.array, resources.sizes.array, resources.flashes.array];
  assert.equal(mesh.count, bare);
  assert.equal(mesh.instanceMatrix.count, MAX_MOBS * MAX_PARTS_PER_MOB + MAX_PROJECTILES * 3);
  const origin = { x: 10.5, y: 2.45, z: 8.38 }, direction = { x: -1, y: 0, z: 0 };
  const bareHit = f.wildlife.raycast(origin, direction, 3);
  assert.equal(bareHit?.entity, horse);
  const plan = f.horses.prepareSlotAction(horse.id, {
    type: "quickMove", area: "inventory", index: f.gameplay.selected,
  });
  assert.equal(plan.ok, true);
  const before = horse.horseView, veto = horseVeto(t, f.coordinator);
  assert.equal(f.coordinator.commit([...plan.participants, veto]).ok, false);
  assert.equal(horse.horseView, before);
  assert.deepEqual(f.gameplay.getHandStack(), saddle);
  assert.equal(visibleCount(horse), bare);
  let seen;
  const inventory = plan.participants.find((part) => part.owner === f.gameplay);
  const observedInventory = { ...inventory, notify: () => { seen = horse.horseView; } };
  const committed = f.coordinator.commit([
    observedInventory, ...plan.participants.filter((part) => part !== inventory),
  ]);
  assert.equal(committed.ok, true);
  assert.deepEqual(committed.observerErrors, []);
  assert.equal(seen, horse.horseView, "projection installs before even an earlier owner's observer");
  assertView(horse, view({ tamed: true, saddled: true, ridden: true }));
  assert.deepEqual(seen, horse.horseView);
  assert.equal(f.gameplay.getHandStack(), null);
  const saddleHit = f.wildlife.raycast(origin, direction, 3);
  assert.equal(saddleHit?.entity, horse);
  assert.ok(saddleHit.distance < bareHit.distance - 0.02, "native picking includes the equipped flap");
  f.wildlife.render(0);
  assert.equal(mesh.count, horse.model.parts.length);
  assert.equal(f.horses.slotAction(horse.id, {
    type: "click", area: "container", index: 0, button: 0,
  }).ok, true);
  assertView(horse, view({ tamed: true, ridden: true }));
  assert.deepEqual(f.gameplay.cursor, saddle);
  assert.equal(f.horses.getHorse(horse.id).controlled, false);
  assert.equal(f.wildlife.raycast(origin, direction, 3).distance, bareHit.distance);
  f.wildlife.render(0);
  assert.equal(mesh.count, bare);
  assert.equal(f.wildlife.mesh, mesh);
  assert.equal(f.wildlife.skinResources, resources);
  assert.equal(f.wildlife.gelMesh, null);
  assert.ok([resources.rects.array, resources.sizes.array, resources.flashes.array]
    .every((buffer, index) => buffer === buffers[index]));
  assert.equal(f.horses.dismount().ok, true);
  assertView(horse, view({ tamed: true }));
  for (const record of [...f.wildlife.serialize().entities, ...f.horses.serialize().entries])
    assert.equal(Object.hasOwn(record, "horseView"), false, "the view is never another saved owner");
  assert.equal(f.horses.hurt(horse, 999).ok, true);
  assert.equal(horse.horseView, null);
});

test("bind, detach, validated restore and waking refresh the same retained horse without reallocating batches", (t) => {
  const f = horseFixture(t), horse = f.tame(f.spawn());
  f.saddle(horse);
  assert.equal(f.horses.dismount().ok, true);
  const expected = view({ tamed: true, saddled: true });
  assertView(horse, expected);
  assert.equal(f.horses.suspend(), true);
  assert.equal(horse.horseView, null);
  f.wildlife.render(0);
  assert.equal(horse.horseView, null, "detached display must not recreate an old saddle");
  assert.equal(f.horses.bindWildlife(f.wildlife), true);
  assertView(horse, expected);
  const restored = horseFixture(t, { saved: f.snapshot(), bind: false });
  const retained = restored.wildlife.byId.get(horse.id);
  assertView(retained, expected, "validated base restore is presentable before host binding");
  assert.equal(restored.horses.bindWildlife(restored.wildlife), true);
  assertView(retained, expected);
  const mesh = restored.wildlife.mesh, resources = restored.wildlife.skinResources;
  const position = retained.position.clone(), generated = restored.generated();
  restored.world._removeChunk("0,0", restored.world.chunks.get("0,0"));
  restored.tick();
  assert.equal(restored.wildlife.dormantHorses.get(retained.id), retained);
  assertView(retained, { ...expected, grounded: false });
  assert.equal(restored.generated(), generated, "view sampling cannot request missing chunks");
  restored.world._generateSync(0, 0);
  restored.wildlife._wakeHorses();
  assertView(retained, expected);
  assert.equal(restored.wildlife.entities.includes(retained), true);
  assert.deepEqual(retained.position, position);
  assert.equal(restored.wildlife.mesh, mesh);
  assert.equal(restored.wildlife.skinResources, resources);
});

test("bounded motion publishes grounded state before rendering; picking refreshes actual fluid state", (t) => {
  const f = horseFixture(t), horse = f.tame(f.spawn());
  f.saddle(horse);
  f.tick();
  f.tick(20, { jump: true });
  const bytes = f.horses.reservedBytes, generated = f.generated();
  for (const owner of [f.horses, f.wildlife, f.gameplay, f.overflow, f.experience, f.world])
    t.mock.method(owner, "serialize", () => assert.fail("presentation/motion cannot serialize complete owners"));
  const result = f.horses.update(0.05, {
    controls: { player: { jump: false } }, frameId: ++f.frameId,
  });
  assert.equal(result.steps, 1);
  assertView(horse, view({ tamed: true, saddled: true, ridden: true, grounded: false }));
  assert.equal(f.horses.reservedBytes, bytes);
  t.mock.restoreAll();
  f.put([1, 2].flatMap((y) => [7, 8, 9].flatMap((x) => [7, 8, 9].map((z) => [x, y, z, BLOCK.WATER]))));
  assert.equal(horse.horseView.swimming, false, "the old view remains immutable until refreshed");
  f.wildlife.raycast({ x: 10.5, y: 2.45, z: 8.38 }, { x: -1, y: 0, z: 0 }, 3);
  assertView(horse, view({ tamed: true, saddled: true, ridden: true, grounded: false, swimming: true }));
  f.wildlife.render(0);
  assert.equal(horse.model.horseMotion.grounded, false);
  assert.equal(horse.model.horseMotion.moving, false);
  assert.equal(f.generated(), generated);
});
