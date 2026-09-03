import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { BOAT_ITEM_REQUIREMENTS, boatInput } from "../src/boat-definitions.js";
import { ITEM } from "../src/items.js";
import { MAX_RESERVED_BYTES } from "../src/save-budget.js";
import { aquaticOwners } from "./vehicle-fishing-fixture.js";

test("oak boat requirements preserve the historical planks identity", () => {
  const oak = BOAT_ITEM_REQUIREMENTS.find((item) => item.key === "OAK_BOAT");
  assert.equal(oak.recipe.ingredient, "PLANKS");
  assert.equal(BLOCK[oak.recipe.ingredient], 7);
  assert.equal(BLOCK.OAK_PLANKS, undefined);
});

test("boat placement, two seats, swimming dismount and recovery use actual ownership", (t) => {
  const fixture = aquaticOwners(t);
  fixture.setHand("OAK_BOAT", { data: { version: 1, name: "Estuary" } });
  const boats = fixture.boats();
  const before = fixture.gameplay.serialize();
  const plan = boats.preparePlace(fixture.placement());
  assert.equal(plan.ok, true);
  assert.equal(boats.size, 0);
  assert.deepEqual(fixture.gameplay.serialize(), before);
  const placed = boats.commit(plan);
  assert.equal(placed.ok, true);
  assert.equal(fixture.gameplay.getHandStack(), null);
  assert.equal(boats.size, 1);
  assert.equal(boats.commit(plan).ok, false);
  assert.equal(boats.mount(placed.id).ok, true);
  fixture.actors.set("guest", {
    position: { x: 2.5, y: fixture.world.surface + 0.2, z: 0.5 },
  });
  assert.equal(boats.mount(placed.id, "guest").ok, true);
  assert.equal(boats.riderPose("guest").slot, 1);
  assert.notDeepEqual(
    boats.riderPose().position,
    boats.riderPose("guest").position
  );
  const exit = boats.dismount();
  assert.equal(exit.ok, true);
  assert.equal(exit.exit.swimming, true);
  assert.equal(exit.exit.grounded, false);
  assert.equal(boats.mountFor(), null);
  assert.equal(
    boats.riderPose("guest").slot,
    0,
    "remaining passenger becomes driver"
  );
  assert.equal(boats.break(placed.id, { ownerId: "guest" }).ok, true);
  assert.equal(boats.size, 0);
  assert.equal(fixture.overflow.size, 1);
  const [drop] = fixture.overflow.serialize().entries;
  assert.equal(drop.id, ITEM.OAK_BOAT);
  assert.equal(drop.count, 1);
  assert.equal(drop.data.name, "Estuary");
  assert.equal(boats.break(placed.id).ok, false);
  assert.equal(fixture.overflow.serialize().entries[0].count, 1);
});

test("mounted movement is physical and sneak produces an explicit safe exit", (t) => {
  const fixture = aquaticOwners(t);
  fixture.setHand("BAMBOO_RAFT");
  const boats = fixture.boats();
  const placed = boats.place(fixture.placement());
  assert.equal(placed.ok, true);
  assert.equal(boats.mount(placed.id).ok, true);
  const before = boats.riderPose();
  for (let frame = 0; frame < 10; frame++) {
    boats.update(0.05, {
      viewer: fixture.actors.get("player").position,
      controls: { player: boatInput(new Set(["KeyW", "KeyD"])) },
    });
    fixture.actors.get("player").position = boats.riderPose().position;
  }
  assert.notDeepEqual(boats.riderPose().position, before.position);
  assert.ok(boats.riderPose().hullYaw < 0);
  boats.update(0.05, {
    viewer: fixture.actors.get("player").position,
    controls: { player: boatInput(new Set(["ShiftLeft"])) },
  });
  assert.equal(boats.mountFor(), null);
  assert.equal(
    fixture.events.filter((event) => event.type === "dismount").length,
    1
  );
});

test("prepared seat/exit descriptions do not lend references to physical publication or early observers", (t) => {
  const fixture = aquaticOwners(t);
  fixture.setHand("OAK_BOAT");
  const boats = fixture.boats();
  const placed = boats.place(fixture.placement());
  assert.equal(placed.ok, true);
  const mount = boats.prepareMount(placed.id);
  assert.equal(mount.ok, true);
  const seat = structuredClone(mount.position),
    before = structuredClone(fixture.actors.get("player").position);
  mount.position.x += 100;
  mount.participants[0].notify();
  assert.deepEqual(fixture.actors.get("player").position, before);
  assert.equal(boats.commit(mount).ok, true);
  assert.deepEqual(fixture.actors.get("player").position, seat);
  const dismount = boats.prepareDismount();
  assert.equal(dismount.ok, true);
  const exit = structuredClone(dismount.exit);
  dismount.exit.position.x += 100;
  dismount.exit.velocity.y = 100;
  dismount.participants[0].notify();
  assert.deepEqual(fixture.actors.get("player").position, seat);
  assert.equal(boats.commit(dismount).ok, true);
  assert.deepEqual(fixture.actors.get("player").position, exit.position);
  const count = fixture.events.length;
  dismount.participants[0].notify();
  assert.equal(fixture.events.length, count);
});

test("death/travel release detaches ownership without becoming an unsafe dismount fallback", (t) => {
  const fixture = aquaticOwners(t);
  fixture.setHand("OAK_BOAT");
  const boats = fixture.boats();
  const placed = boats.place(fixture.placement());
  assert.equal(placed.ok, true);
  assert.equal(boats.mount(placed.id).ok, true);
  assert.equal(boats.releasePassenger().reason, "use-safe-dismount");
  fixture.actors.get("player").dead = true;
  assert.equal(boats.releasePassenger().ok, true);
  assert.equal(boats.mountFor(), null);
  assert.equal(boats.size, 1);
  assert.equal(fixture.overflow.size, 0);
  assert.equal(fixture.world.cells.size, 0);
});

test("capacity rejection cannot spend the held boat or advance its persistent ID", (t) => {
  const fixture = aquaticOwners(t);
  fixture.setHand("OAK_BOAT");
  const boats = fixture.boats();
  const blocker = {};
  fixture.coordinator.register(
    blocker,
    MAX_RESERVED_BYTES - fixture.coordinator.budget.totalBytes
  );
  t.after(() => fixture.coordinator.release(blocker));
  const before = boats.serialize(),
    inventory = fixture.gameplay.serialize();
  const plan = boats.preparePlace(fixture.placement());
  assert.equal(plan.ok, true);
  assert.equal(boats.commit(plan).ok, false);
  assert.deepEqual(boats.serialize(), before);
  assert.deepEqual(fixture.gameplay.serialize(), inventory);
  fixture.coordinator.release(blocker);
  assert.equal(
    boats.commit(plan).ok,
    true,
    "aggregate capacity admission is retriable before publication"
  );
});

test("equal-item hand replacement and a changed world stale boat preparations", (t) => {
  const fixture = aquaticOwners(t);
  fixture.setHand("OAK_BOAT");
  const boats = fixture.boats();
  const original = boats.preparePlace(fixture.placement());
  assert.equal(original.ok, true);
  fixture.gameplay.select(1);
  fixture.gameplay.select(0);
  assert.equal(boats.commit(original).ok, false);
  const worldPlan = boats.preparePlace(fixture.placement());
  assert.equal(worldPlan.ok, true);
  fixture.world.setCell(0, 9, 0, { id: BLOCK.STONE });
  assert.equal(boats.commit(worldPlan).ok, false);
  assert.equal(boats.size, 0);
  assert.equal(fixture.gameplay.getHandStack().id, ITEM.OAK_BOAT);
});

test("placement rechecks line of sight beyond the destination's captured cells", (t) => {
  const fixture = aquaticOwners(t);
  fixture.actors.get("player").position.z = 4.8;
  fixture.setHand("OAK_BOAT");
  const boats = fixture.boats();
  const plan = boats.preparePlace(fixture.placement());
  assert.equal(plan.ok, true);
  fixture.world.setCell(0, 10, 3, { id: BLOCK.STONE });
  assert.equal(boats.commit(plan).ok, false);
  assert.equal(boats.size, 0);
  assert.equal(fixture.gameplay.getHandStack().id, ITEM.OAK_BOAT);
});

test("a full retained-drop owner leaves the broken boat recoverable", (t) => {
  const fixture = aquaticOwners(t, { overflowEntries: 1 });
  fixture.setHand("OAK_BOAT");
  const boats = fixture.boats();
  const placed = boats.place(fixture.placement());
  assert.equal(placed.ok, true);
  assert.equal(
    fixture.overflow.enqueue(
      [{ id: ITEM.LEATHER, count: 1 }],
      { x: 12, y: 10, z: 12 },
      fixture.world.dimension
    ),
    true
  );
  const before = boats.serialize(),
    drops = fixture.overflow.serialize();
  assert.equal(boats.break(placed.id).ok, false);
  assert.deepEqual(boats.serialize(), before);
  assert.deepEqual(fixture.overflow.serialize(), drops);
});

test("save/reopen preserves a mount and never recreates an already recovered boat", (t) => {
  const fixture = aquaticOwners(t);
  fixture.setHand("OAK_BOAT");
  const boats = fixture.boats();
  const placed = boats.place(fixture.placement());
  assert.equal(placed.ok, true);
  assert.equal(boats.mount(placed.id).ok, true);
  const snapshot = boats.serialize();
  assert.equal(boats.load(snapshot), true);
  assert.deepEqual(boats.serialize(), snapshot);
  assert.equal(boats.riderPose().id, placed.id);
  assert.equal(boats.break(placed.id).ok, true);
  const recovered = boats.serialize();
  assert.equal(boats.load(recovered), true);
  assert.equal(boats.size, 0);
  assert.equal(boats.break(placed.id).ok, false);
  assert.equal(fixture.overflow.serialize().entries[0].count, 1);
});

test("inactive dimensions and frontiers freeze saved motion and mounting", (t) => {
  const fixture = aquaticOwners(t);
  fixture.setHand("OAK_BOAT");
  const boats = fixture.boats();
  const placed = boats.place(fixture.placement());
  assert.equal(placed.ok, true);
  const before = boats.serialize();
  fixture.world.dimension = "nether";
  boats.update(60, { viewer: { x: 0, y: 10, z: 0 } });
  assert.deepEqual(boats.serialize(), before);
  assert.equal(boats.mount(placed.id).ok, false);
  fixture.world.dimension = "overworld";
  fixture.world.loaded = () => false;
  boats.update(60, { viewer: { x: 0, y: 10, z: 0 } });
  assert.deepEqual(boats.serialize(), before);
  assert.equal(boats.mount(placed.id).ok, false);
});
