import assert from "node:assert/strict";
import test from "node:test";
import { FLUID } from "../src/block-state.js";
import { BLOCK } from "../src/blocks.js";
import { boatBox, boatRiderPathClear } from "../src/boat-physics.js";
import { bodyBox, boxCollides, supportContacts } from "../src/collision.js";
import { validBodyPosition } from "../src/geometry-world.js";
import { ITEM } from "../src/items.js";
import { PLAYER_HEIGHT, PLAYER_WIDTH } from "../src/player.js";
import { aquaticSweepBounds, loadedAquaticArea } from "../src/vehicle-water.js";
import {
  consumeVehiclePose,
  placeAndMount,
  vehicleHostFixture,
} from "./game-vehicle-services-fixture.js";

test("physical-eye water placement commits exactly one decorated finite boat and never calls eager drops", (t) => {
  const f = vehicleHostFixture(t);
  f.setHand("OAK_BOAT", { data: { version: 1, name: "河口" } });
  f.game.graphics.camera.position.set(1000, 1000, 1000);
  t.mock.method(f.gameplay, "add", () =>
    assert.fail("no eager inventory grant")
  );
  t.mock.method(f.overflow, "enqueue", () =>
    assert.fail("retention must be prepared")
  );
  t.mock.method(f.experienceOrbs, "spawn", () =>
    assert.fail("XP must be prepared")
  );
  const before = f.snapshot(),
    player = f.player.position.clone();
  const plan = f.service.prepareUseHand();
  assert.equal(plan.ok, true);
  assert.deepEqual(
    plan.participants.map((part) => part.owner),
    [f.service.boats, f.gameplay]
  );
  assert.deepEqual(f.snapshot(), before);
  assert.equal(f.service.commit(plan).ok, true);
  assert.equal(f.gameplay.getHandStack(), null);
  const boat = f.service.boats.getBoat(plan.id);
  assert.equal(boat.stack.id, ITEM.OAK_BOAT);
  assert.deepEqual(boat.stack.data, { version: 1, name: "河口" });
  assert.ok(
    boat.z > 8 && boat.z < 11,
    "placement uses the nearby physical eye, not the displaced camera"
  );
  assert.equal(boxCollides(f.world, boatBox(boat)), false);
  assert.ok(
    f.player.position.equals(player),
    "placing does not teleport or auto-mount"
  );
  assert.deepEqual(f.world.serialize(), before.world);
  assert.equal(f.service.commit(plan).ok, false);
  assert.equal(f.service.boats.size, 1);
});

test("a Creative offhand boat is finite and retains decoration without touching the main palette", (t) => {
  const f = vehicleHostFixture(t);
  f.setHand("BAMBOO_RAFT", {
    hand: "offhand",
    data: { version: 1, name: "Finite raft" },
  });
  f.gameplay.setMode("creative");
  const main = f.gameplay.getHandStack();
  const placed = f.service.useHand("offhand");
  assert.equal(placed.ok, true);
  assert.equal(f.gameplay.getHandStack("offhand"), null);
  assert.deepEqual(f.gameplay.getHandStack(), main);
  const boat = f.service.boats.getBoat(placed.id);
  assert.equal(boat.wood, "bamboo");
  assert.equal(boat.stack.id, ITEM.BAMBOO_RAFT);
  assert.equal(boat.stack.data.name, "Finite raft");
  assert.equal(f.service.useHand("offhand"), null);
});

test("world, hand, pose, lifecycle and owner vetoes publish no partial boat ownership", (t) => {
  for (const invalidate of [
    (f) => {
      f.gameplay.select(1);
      f.gameplay.select(0);
    },
    (f) => {
      f.player.yaw += 0.2;
    },
    (f) => {
      f.player.setPosition({
        ...f.player.position,
        x: f.player.position.x + 0.1,
      });
    },
    (f) => {
      f.put(8, 9, 9, BLOCK.STONE);
    },
    (f) => {
      f.game.paused = true;
    },
  ]) {
    const f = vehicleHostFixture(t);
    f.setHand("OAK_BOAT");
    const plan = f.service.prepareUseHand();
    assert.equal(plan.ok, true);
    invalidate(f);
    const before = f.snapshot();
    assert.equal(f.service.commit(plan).ok, false);
    assert.deepEqual(f.snapshot(), before);
  }
  const f = vehicleHostFixture(t);
  f.setHand("OAK_BOAT");
  const plan = f.service.prepareUseHand(),
    before = f.snapshot();
  const parts = [
    plan.participants[0],
    { ...plan.participants[1], validate: () => false },
  ];
  assert.equal(f.coordinator.commit(parts).ok, false);
  assert.deepEqual(f.snapshot(), before);
  const original = f.game.experienceOrbs;
  f.game.experienceOrbs = f.overflow;
  assert.equal(f.service.commit(plan).ok, false);
  f.game.experienceOrbs = original;
  assert.deepEqual(f.snapshot(), before);
});

test("retained drops are exact prepared stacks; a full overflow keeps the boat recoverable", (t) => {
  const f = vehicleHostFixture(t, { maxEntries: 1 });
  const id = placeAndMount(f);
  assert.equal(f.service.dismount().ok, true);
  consumeVehiclePose(f);
  const boat = f.service.boats.getBoat(id);
  f.aimAt({ x: boat.x, y: boat.y + 0.3, z: boat.z });
  const hit = f.service.raycast();
  assert.equal(hit?.type, "boat");
  assert.equal(
    f.overflow.enqueue(
      [{ id: ITEM.STICK, count: 1 }],
      { x: 20, y: 10, z: 20 },
      f.world.dimension
    ),
    true
  );
  const before = f.snapshot();
  assert.equal(f.service.attack(hit).ok, false);
  assert.deepEqual(f.snapshot(), before);
  assert.equal(f.overflow.load({ version: 1, entries: [] }), true);
  assert.equal(f.service.attack(hit).ok, true);
  assert.equal(f.service.boats.size, 0);
  const drop = f.overflow.serialize().entries[0];
  assert.equal(drop.id, boat.stack.id);
  assert.deepEqual(drop.data, boat.stack.data);
  assert.equal(drop.count, 1);
  assert.equal(drop.x, boat.x);
  assert.equal(drop.z, boat.z);
  assert.ok(drop.y > boat.y);
  assert.equal(f.service.attack(hit).ok, false);
  assert.equal(f.overflow.serialize().entries[0].count, 1);
});

test("mounting sweeps the passenger body even when the physical-eye ray clears a low obstacle", (t) => {
  const f = vehicleHostFixture(t);
  f.setHand("OAK_BOAT");
  const placed = f.service.useHand();
  assert.equal(placed.ok, true);
  const boat = f.service.boats.getBoat(placed.id);
  f.put(8, 9, 11, BLOCK.OAK_SLAB);
  f.aimAt({ x: boat.x, y: boat.y + 0.4, z: boat.z });
  const hit = f.service.raycast();
  assert.equal(hit?.type, "boat", "eye can see across the low slab");
  const before = f.snapshot(),
    player = f.player.position.clone();
  const mounted = f.service.interact(hit);
  assert.equal(mounted.reason, "no-seat-clearance");
  assert.deepEqual(f.snapshot(), before);
  assert.ok(f.player.position.equals(player));
  assert.equal(f.service.riderPose(), null);
});

test("archive pose observes the committed seat and exit before Player consumes either", (t) => {
  const f = vehicleHostFixture(t);
  f.setHand("OAK_BOAT");
  const placed = f.service.useHand(),
    original = f.player.position.clone();
  const boat = f.service.boats.getBoat(placed.id);
  f.aimAt({ x: boat.x, y: boat.y + 0.3, z: boat.z });
  assert.equal(f.service.interact(f.service.raycast()).ok, true);
  assert.ok(f.player.position.equals(original));
  assert.deepEqual(f.service.poseForArchive(), f.service.riderPose());
  const exit = f.service.dismount();
  assert.equal(exit.ok, true);
  assert.equal(f.service.riderPose(), null);
  const projected = f.service.poseForArchive();
  assert.deepEqual(projected, exit.exit);
  projected.position.x += 100;
  assert.deepEqual(
    f.service.poseForArchive(),
    exit.exit,
    "archive projections never own a pending pose"
  );
  assert.deepEqual(f.service.takeExitPose(), exit.exit);
  assert.equal(f.service.takeExitPose(), null);
  assert.equal(f.service.poseForArchive(), null);
});

test("A/D hull steering and W/S thrust do not use camera yaw; survival projection remains real", (t) => {
  const a = vehicleHostFixture(t),
    b = vehicleHostFixture(t);
  const aId = placeAndMount(a),
    bId = placeAndMount(b);
  const before = a.service.riderPose();
  a.player.yaw = 1.4;
  b.player.yaw = -1.2;
  a.game.graphics.camera.rotation.y = 2.8;
  b.game.graphics.camera.rotation.y = 0.1;
  const keys = new Set(["KeyW", "KeyD"]);
  for (let i = 0; i < 12; i++) {
    a.service.frame(0.05, { keys });
    b.service.frame(0.05, { keys });
    consumeVehiclePose(a);
    consumeVehiclePose(b);
  }
  assert.deepEqual(a.service.boats.getBoat(aId), b.service.boats.getBoat(bId));
  assert.notDeepEqual(a.service.riderPose().position, before.position);
  assert.ok(a.service.riderPose().hullYaw < 0);
  assert.equal(a.player.yaw, 1.4);
  assert.equal(b.player.yaw, -1.2);
  const vitals = a.gameplay.serialize();
  const environment = a.player.gameplayEnvironment();
  assert.equal(environment.underwater, false);
  assert.equal(environment.moving, false, "paddling is not walking exhaustion");
  assert.deepEqual(
    a.gameplay.serialize(),
    vitals,
    "host does not duplicate Gameplay's survival update"
  );
});

test("Shift dismount finds genuine swimming space without fabricating support", (t) => {
  const open = vehicleHostFixture(t);
  placeAndMount(open);
  const world = open.world.serialize();
  assert.equal(
    open.service.frame(0.05, { keys: new Set(["ShiftLeft"]) }).ok,
    true
  );
  const exit = consumeVehiclePose(open);
  assert.equal(exit.swimming, true);
  assert.equal(exit.grounded, false);
  assert.equal(open.service.riderPose(), null);
  assert.deepEqual(open.world.serialize(), world);
});

for (const roof of [false, true]) {
  test(
    roof
      ? "Shift refuses obstructed fence-top headroom while the occupied seat stays valid"
      : "Shift dismount reaches a clear supported fence top",
    (t) => {
      const f = vehicleHostFixture(t);
      const id = placeAndMount(f),
        boat = f.service.boats.getBoat(id);
      const x0 = Math.floor(boat.x),
        z0 = Math.floor(boat.z);
      for (let dx = -1; dx <= 1; dx++)
        for (let dz = -1; dz <= 1; dz++)
          if (dx || dz)
            f.put(x0 + dx, 8, z0 + dz, {
              id: BLOCK.OAK_FENCE,
              fluid: FLUID.WATER_SOURCE,
            });

      // Ray placement is off-center: the front exit rests on the fence post.
      // A fence ring alone is not an enclosure with obstructed exit headroom.
      const seat = f.service.riderPose(),
        mount = f.service.boats.mountFor(),
        beforePlan = f.snapshot();
      assert.equal(f.service.active, true);
      assert.ok(seat);
      assert.ok(mount);
      assert.equal(seat.id, id);
      assert.equal(mount.id, id);
      assert.deepEqual(boat.passengers, ["player", null]);
      assert.ok(f.player.position.equals(seat.position));
      const plan = f.service.boats.prepareDismount();
      assert.equal(plan.ok, true);
      assert.deepEqual(
        plan.participants.map((part) => part.owner),
        [f.service.boats]
      );
      assert.deepEqual(
        f.snapshot(),
        beforePlan,
        "preparation publishes nothing"
      );
      const exit = plan.exit,
        destination = exit.position;
      assert.equal(exit.grounded, true);
      assert.equal(exit.swimming, false);
      const body = { radius: PLAYER_WIDTH / 2, height: PLAYER_HEIGHT };
      const [support] = supportContacts(f.world, destination, {
        radius: body.radius,
        filter: ({ box }) =>
          destination.x > box[0] &&
          destination.x < box[3] &&
          destination.z > box[2] &&
          destination.z < box[5],
      });
      assert.ok(support, "the exit center has real shape support");
      assert.equal(support.cell.id, BLOCK.OAK_FENCE);
      assert.deepEqual([support.x, support.y, support.z], [x0, 8, z0 - 1]);
      assert.equal(destination.y, support.height + 0.001);
      for (const position of [seat.position, destination]) {
        assert.equal(validBodyPosition(position, f.world, body), true);
        assert.equal(
          boxCollides(f.world, bodyBox(position, body.radius, body.height)),
          false
        );
      }
      assert.equal(
        loadedAquaticArea(
          f.world,
          aquaticSweepBounds(
            seat.position,
            destination,
            body.radius,
            body.height
          )
        ),
        true
      );
      assert.equal(
        boatRiderPathClear(f.world, seat.position, destination),
        true
      );

      if (roof) {
        // y=11 clears the seated body's top (10.78), but blocks the standing
        // fence-top body's head (11.301). Keep the seat and hull unobstructed.
        for (let dx = -1; dx <= 1; dx++)
          for (let dz = -1; dz <= 1; dz++)
            if (dx || dz) f.put(x0 + dx, 11, z0 + dz, BLOCK.STONE);
        assert.ok(seat.position.y + body.height < 11);
        assert.ok(destination.y < 11 && destination.y + body.height > 11);
        assert.equal(
          boxCollides(f.world, bodyBox(destination, body.radius, body.height)),
          true
        );
        assert.equal(
          boatRiderPathClear(f.world, seat.position, destination),
          false
        );
        const refused = f.service.boats.prepareDismount();
        assert.equal(refused.ok, false);
        assert.equal(refused.reason, "no-safe-exit");
      }
      assert.equal(f.service.active, true);
      assert.deepEqual(f.service.boats.mountFor(), mount);
      assert.equal(
        boxCollides(f.world, bodyBox(seat.position, body.radius, body.height)),
        false
      );
      assert.equal(boxCollides(f.world, boatBox(boat, true)), false);
      assert.equal(f.service.takeExitPose(), null);
      const before = f.snapshot(),
        columns = [...f.world.chunks.keys()],
        reservation = f.coordinator.usage(f.service.boats);
      const frame = f.service.frame(0.05, { keys: new Set(["ShiftLeft"]) });
      assert.equal(frame.ok, true);
      assert.deepEqual(frame.boats.observerErrors, []);
      assert.equal(f.service.active, true);
      assert.equal(f.service.boats.size, 1);
      assert.ok(
        f.player.position.equals(seat.position),
        "pose consumption is deferred"
      );
      if (roof) {
        const retained = f.service.riderPose();
        assert.ok(retained, "blocked dismount retains the rider");
        assert.equal(retained.id, id);
        assert.deepEqual(retained.position, seat.position);
        assert.deepEqual(f.service.boats.mountFor(), mount);
        assert.deepEqual(
          f.service.boats.getBoat(id).passengers,
          boat.passengers
        );
        assert.equal(f.service.takeExitPose(), null);
      } else {
        assert.equal(f.service.riderPose(), null);
        assert.equal(f.service.boats.mountFor(), null);
        assert.deepEqual(f.service.boats.getBoat(id).passengers, [null, null]);
        assert.deepEqual(f.service.poseForArchive(), exit);
        assert.deepEqual(consumeVehiclePose(f), exit);
        assert.ok(f.player.position.equals(destination));
        assert.equal(f.service.takeExitPose(), null);
      }
      assert.deepEqual(f.world.serialize(), before.world);
      assert.deepEqual([...f.world.chunks.keys()], columns);
      assert.equal(f.coordinator.budget.totalBytes, before.bytes);
      assert.equal(f.coordinator.usage(f.service.boats), reservation);
    }
  );
}

test("canonical World bubble water reaches the host's real fluid sampler and bounded hull update", (t) => {
  const f = vehicleHostFixture(t);
  const id = placeAndMount(f),
    boat = f.service.boats.getBoat(id);
  const x = Math.floor(boat.x),
    z = Math.floor(boat.z);
  for (let dx = -1; dx <= 1; dx++)
    for (let dz = -1; dz <= 1; dz++)
      for (let y = 4; y <= 8; y++)
        f.put(x + dx, y, z + dz, { id: BLOCK.WATER, fluid: FLUID.BUBBLE_UP });
  t.mock.method(f.world, "ensureArea", () =>
    assert.fail("bubble physics cannot admit terrain")
  );
  let launched = false;
  for (let i = 0; i < 65; i++) {
    assert.equal(f.service.frame(0.05).ok, true);
    consumeVehiclePose(f);
    launched ||= f.service.boats.getBoat(id).vy > 5;
  }
  assert.equal(launched, true);
  assert.equal(
    f.service.boats.mountFor().id,
    id,
    "up bubbles launch instead of ejecting the passenger"
  );
});

test("held-use repetition cannot cast/reel or mount/dismount twice in one gesture", (t) => {
  const f = vehicleHostFixture(t);
  f.setHand("FISHING_ROD");
  assert.equal(f.service.useHand("main", { held: true }).action, "cast");
  const snapshot = f.snapshot();
  for (let i = 0; i < 4; i++)
    assert.equal(f.service.useHand("main", { held: true }).ok, true);
  assert.deepEqual(f.snapshot(), snapshot);
  f.service.resetInput();
  assert.equal(f.service.useHand("main", { held: true }).action, "empty-reel");
  assert.equal(f.gameplay.getHandStack().durability, 64);
});

test("empty and paused hosts do no leaf simulation, geometry work, rendering or save projections", (t) => {
  const f = vehicleHostFixture(t);
  t.mock.method(f.service.boats, "update", () =>
    assert.fail("idle boat update")
  );
  t.mock.method(f.service.fishing, "update", () =>
    assert.fail("idle fishing update")
  );
  t.mock.method(f.world, "getCell", () => assert.fail("idle geometry query"));
  t.mock.method(f.world, "ensureArea", () =>
    assert.fail("frame terrain admission")
  );
  t.mock.method(f.service.boats, "serialize", () =>
    assert.fail("frame save projection")
  );
  t.mock.method(f.service.fishing, "serialize", () =>
    assert.fail("frame save projection")
  );
  t.mock.method(f.service.boats.renderer, "render", () =>
    assert.fail("idle boat draw")
  );
  t.mock.method(f.service.fishing.renderer, "render", () =>
    assert.fail("idle fishing draw")
  );
  const first = f.service.frame(0.05);
  for (let i = 0; i < 5; i++) {
    assert.equal(f.service.frame(0.05), first, "idle result is reused");
    assert.equal(f.service.render(0.05), true);
  }
  f.game.paused = true;
  assert.equal(f.service.frame(10), first);
  assert.deepEqual(f.notifications, []);
});
