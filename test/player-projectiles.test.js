import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { ITEM } from "../src/items.js";
import {
  MAX_PEARL_FRONTIER_REQUESTS,
  MAX_PEARL_STEPS_PER_UPDATE,
  PEARL_FRONTIER_TICKET_SECONDS,
  PEARL_TELEPORT_DAMAGE,
} from "../src/player-projectiles.js";
import {
  MAX_PEARL_QUERY_CELLS,
  MAX_PEARL_QUERY_COLUMNS,
  PEARL_COLLISION_OFFSET,
  PEARL_STEP_SECONDS,
} from "../src/pearl-physics.js";
import {
  MAX_PLAYER_PEARLS,
  PEARL_LIFETIME_SECONDS,
  PEARL_RECORD_RESERVED_BYTES,
  pearlReservedBytes,
} from "../src/pearl-save.js";
import { MAX_RESERVED_BYTES } from "../src/save-budget.js";
import {
  TransactionCoordinator,
  TransactionInvariantError,
} from "../src/transactions.js";
import { floorImpact, pearlFixture, pearlRecord } from "./pearl-fixtures.js";

const advance = (pearls, seconds) => {
  for (let remaining = seconds; remaining > 1e-9; remaining -= 0.05)
    pearls.update(Math.min(0.05, remaining));
};
const veto = (coordinator) => {
  const owner = {};
  coordinator.register(owner, 0);
  return {
    owner,
    beforeBytes: 0,
    afterBytes: 0,
    validate: () => false,
    publish() {},
  };
};

test("held pearl, projectile, cooldown and RNG publish together and exactly once", (t) => {
  const f = pearlFixture(t);
  const input = f.shot();
  const before = f.pearls.serialize();
  const hand = f.game.getHandStack();
  const plan = f.pearls.prepareThrow(input);
  assert.ok(plan);
  assert.deepEqual(f.pearls.serialize(), before);
  assert.deepEqual(f.game.getHandStack(), hand);
  assert.equal(f.events.length, 0);
  assert.equal(
    f.coordinator.commit([...plan.participants, veto(f.coordinator)]).ok,
    false
  );
  assert.deepEqual(f.pearls.serialize(), before);
  assert.deepEqual(f.game.getHandStack(), hand);
  input.stack.count = 1;
  input.stack.data.name = "external change";
  f.pearls.onEvent = (event) => {
    assert.equal(event.type, "throw");
    assert.equal(f.pearls.size, 1);
    assert.equal(f.game.getHandStack().count, 15);
    assert.equal(f.coordinator.usage(f.pearls), pearlReservedBytes(1));
  };
  assert.equal(f.coordinator.commit(plan.participants).ok, true);
  assert.equal(f.game.getHandStack().data.name, "Survey pearls");
  assert.equal(f.pearls.cooldown, 1);
  assert.notEqual(f.pearls.serialize().randomState, before.randomState);
  assert.equal(f.coordinator.commit(plan.participants).ok, false);
  assert.equal(f.game.getHandStack().count, 15);
  assert.equal(f.pearls.size, 1);
});

test("Creative is free but still requires the actual held pearl and a prepared cost guard", (t) => {
  const f = pearlFixture(t, { mode: "creative" });
  assert.equal(f.game.assignSlot(0, ITEM.STICK), true);
  const forged = { ...f.shot(), stack: { id: ITEM.ENDER_PEARL, count: 1 } };
  assert.equal(f.pearls.throwPearl(forged), false);
  assert.equal(f.pearls.throwPearl(f.shot()), false);
  assert.equal(f.pearls.size, 0);
  assert.equal(f.game.assignSlot(0, ITEM.ENDER_PEARL), true);
  const hand = f.game.getHandStack();
  assert.equal(f.pearls.throwPearl(f.shot()), true);
  assert.deepEqual(f.game.getHandStack(), hand);
  assert.equal(f.pearls.cooldown, 1);
});

test("unloaded/embedded origins and absent or refusing bridges never charge a pearl", (t) => {
  for (const change of [
    (f) => {
      f.world.chunks.delete("0,0");
    },
    (f) => {
      f.world.put(4, 21, 4, BLOCK.STONE);
    },
    (f) => {
      f.pearls.prepareHeldCost = () => null;
    },
    (f) => {
      f.pearls.prepareHeldCost = () => {
        throw new Error("cost refused");
      };
    },
    (f) => {
      f.pearls.prepareImpact = undefined;
    },
    (f) => {
      f.owner.available = false;
    },
    (f) => {
      f.player.forward.x = NaN;
    },
  ]) {
    const f = pearlFixture(t);
    const before = f.pearls.serialize();
    change(f);
    assert.equal(f.pearls.throwPearl(f.shot()), false);
    assert.equal(f.game.getHandStack().count, 16);
    assert.deepEqual(f.pearls.serialize(), before);
    assert.equal(f.pearls.reservedBytes, pearlReservedBytes(0));
    assert.equal(f.events.length, 0);
    assert.equal(f.tickets.length, 0);
  }
});

test("the one-second cooldown is shared by both hands and survives dimension cancellation", (t) => {
  const f = pearlFixture(t);
  assert.equal(f.pearls.throwPearl(f.shot()), true);
  advance(f.pearls, 0.4);
  assert.equal(f.pearls.throwPearl(f.shot("offhand")), false);
  f.world.dimension = "nether";
  f.world.epoch++;
  f.pearls.update(0);
  assert.equal(f.pearls.size, 0);
  assert.ok(Math.abs(f.pearls.cooldown - 0.6) < 1e-8);
  advance(f.pearls, 0.599);
  assert.equal(f.pearls.throwPearl(f.shot("offhand")), false);
  f.pearls.update(0.001);
  assert.equal(f.pearls.throwPearl(f.shot("offhand")), true);
  assert.equal(f.game.getHandStack("main").count, 15);
  assert.equal(f.game.getHandStack("offhand").count, 15);
  assert.equal(f.pearls.projectiles[0].dimension, "nether");
});

test("hand, metadata, pose, identity, World, admission and timer staleness reject throws", (t) => {
  const changes = {
    hand: (f) =>
      f.game.inventoryTransaction((owned) => {
        owned.slots[0] = { id: ITEM.STICK, count: 1 };
        return true;
      }),
    metadata: (f) =>
      f.game.inventoryTransaction((owned) => {
        owned.slots[0].data.name = "replacement";
        return true;
      }),
    pose: (f) => {
      f.player.position.x += 0.1;
    },
    aim: (f) => {
      f.player.forward.z = 0.1;
    },
    life: (f) => {
      f.owner.life++;
    },
    owner: (f) => {
      f.owner.ref = {};
    },
    world: (f) => {
      f.owner.world = { ...f.world };
    },
    epoch: (f) => {
      f.world.epoch++;
    },
    dimension: (f) => {
      f.world.dimension = "end";
    },
    admission: (f) => {
      f.world.admit(0, 0);
    },
    terrain: (f) => {
      f.world.put(5, 21, 4, BLOCK.STONE);
    },
    generator: (f) => {
      f.world.generatorVersion = 3;
    },
    clock: (f) => {
      f.pearls.update(0.01);
    },
    cancellation: (f) => {
      f.pearls.cancelPending("owner-dead");
    },
    death: (f) => {
      f.game.damage(20, "fall");
    },
  };
  for (const [name, change] of Object.entries(changes)) {
    const f = pearlFixture(t);
    const plan = f.pearls.prepareThrow(f.shot());
    assert.ok(plan, name);
    change(f);
    const state = f.pearls.serialize();
    const hand = f.game.getHandStack();
    assert.equal(f.coordinator.commit(plan.participants).ok, false, name);
    assert.deepEqual(f.pearls.serialize(), state, name);
    assert.deepEqual(f.game.getHandStack(), hand, name);
  }
});

test("pool and shared-byte capacity refuse without cost; a joint release can fund a throw", (t) => {
  const capped = pearlFixture(t);
  capped.stage(
    Array.from({ length: MAX_PLAYER_PEARLS }, (_, i) =>
      pearlRecord({ id: i + 1 })
    )
  );
  const cappedBefore = capped.pearls.serialize();
  assert.equal(capped.pearls.throwPearl(capped.shot()), false);
  assert.equal(capped.game.getHandStack().count, 16);
  assert.deepEqual(capped.pearls.serialize(), cappedBefore);

  const f = pearlFixture(t);
  const filler = {};
  assert.equal(
    f.coordinator.register(
      filler,
      MAX_RESERVED_BYTES - f.coordinator.budget.totalBytes
    ),
    true
  );
  const before = f.pearls.serialize();
  const plan = f.pearls.prepareThrow(f.shot());
  assert.ok(plan);
  assert.equal(f.coordinator.commit(plan.participants).ok, false);
  assert.deepEqual(f.pearls.serialize(), before);
  assert.equal(f.game.getHandStack().count, 16);
  const bytes = f.coordinator.usage(filler);
  assert.equal(
    f.coordinator.commit([
      ...plan.participants,
      {
        owner: filler,
        beforeBytes: bytes,
        afterBytes: bytes - PEARL_RECORD_RESERVED_BYTES,
        validate: () => true,
        publish() {},
      },
    ]).ok,
    true
  );
  assert.equal(f.game.getHandStack().count, 15);
  assert.equal(f.pearls.size, 1);
});

test("prepared callbacks cannot reenter; committing an older plan during preparation cannot overwrite it", (t) => {
  const f = pearlFixture(t);
  const cost = f.pearls.prepareHeldCost;
  f.pearls.prepareHeldCost = (request) => {
    assert.equal(f.pearls.throwPearl(f.shot()), false);
    assert.equal(f.pearls.update(0.05), false);
    assert.equal(f.pearls.cancelPending(), false);
    assert.equal(f.pearls.load(f.pearls.serialize()), false);
    return cost(request);
  };
  const old = f.pearls.prepareThrow(f.shot());
  assert.ok(old);
  f.pearls.prepareHeldCost = (request) => {
    assert.equal(f.coordinator.commit(old.participants).ok, true);
    return cost(request);
  };
  const stale = f.pearls.prepareThrow(f.shot());
  assert.ok(stale);
  assert.equal(f.coordinator.commit(stale.participants).ok, false);
  assert.equal(f.game.getHandStack().count, 15);
  assert.equal(f.pearls.size, 1);
  assert.equal(f.pearls.projectiles[0].id, old.projectileId);
});

test("impact/removal/pose/damage are one transaction with armor-bypass and fall reset", (t) => {
  const f = pearlFixture(t);
  assert.equal(
    f.game.inventoryTransaction((owned) => {
      owned.equipment.head = {
        id: ITEM.IRON_HELMET,
        count: 1,
        durability: 165,
      };
      return true;
    }),
    true
  );
  floorImpact(f);
  const before = f.pearls.serialize();
  const oldPosition = { ...f.player.position };
  const equipment = f.game.getState().equipment;
  const plan = f.pearls.prepareImpactTransaction(1);
  assert.ok(plan);
  assert.equal(plan.request.damage.amount, PEARL_TELEPORT_DAMAGE);
  assert.equal(plan.request.damage.bypassArmor, true);
  assert.equal(plan.request.damage.bypassShield, true);
  assert.equal(plan.request.fallDistance, 0);
  assert.deepEqual(f.player.position, oldPosition);
  assert.equal(f.game.health, 20);
  assert.deepEqual(f.pearls.serialize(), before);
  assert.equal(
    f.coordinator.commit([...plan.participants, veto(f.coordinator)]).ok,
    false
  );
  assert.deepEqual(f.player.position, oldPosition);
  assert.deepEqual(f.pearls.serialize(), before);

  f.pearls.onEvent = (event) => {
    assert.equal(event.type, "impact");
    assert.equal(f.pearls.size, 0);
    assert.equal(f.game.health, 15);
    assert.equal(f.player.fallDistance, 0);
    assert.equal(f.coordinator.usage(f.pearls), pearlReservedBytes(0));
    throw new Error("postcommit observer");
  };
  const filler = {};
  f.coordinator.register(
    filler,
    MAX_RESERVED_BYTES - f.coordinator.budget.totalBytes
  );
  const result = f.coordinator.commit(plan.participants);
  assert.equal(result.ok, true);
  assert.equal(result.observerErrors.length, 1);
  assert.deepEqual(f.player.position, {
    x: 4.5,
    y: 1 + PEARL_COLLISION_OFFSET,
    z: 4.5,
  });
  assert.deepEqual(f.player.velocity, { x: 0, y: 0, z: 0 });
  assert.equal(f.player.jumpQueued, false);
  assert.deepEqual(f.game.getState().equipment, equipment);
  assert.equal(f.coordinator.commit(plan.participants).ok, false);
  advance(f.pearls, 0.2);
  assert.equal(f.game.health, 15);
  assert.equal(f.owner.poseRevision, 1);
});

test("Creative impact still teleports and resets falling without taking damage", (t) => {
  const f = pearlFixture(t, { mode: "creative" });
  floorImpact(f);
  f.pearls.update(0.05);
  assert.equal(f.pearls.size, 0);
  assert.equal(f.game.health, 20);
  assert.equal(f.player.fallDistance, 0);
  assert.equal(f.owner.poseRevision, 1);
});

test("impact vetoes and foreign/invalid bridges keep ownership and do not teleport", (t) => {
  for (const refusal of [
    "null",
    "throw",
    "foreign",
    "duplicate",
    "async",
    "veto",
  ]) {
    const f = pearlFixture(t);
    floorImpact(f);
    const position = { ...f.player.position };
    f.pearls.prepareImpact = (request) => {
      if (refusal === "null") return null;
      if (refusal === "throw") throw new Error("bridge unavailable");
      const effects = f.prepareImpact(request);
      if (refusal === "foreign") {
        const owner = {};
        new TransactionCoordinator().register(owner, 0);
        effects.pose = { ...effects.pose, owner };
      }
      if (refusal === "duplicate") effects.pose = effects.damage;
      if (refusal === "async")
        effects.pose = { ...effects.pose, publish: async () => {} };
      if (refusal === "veto")
        effects.damage = { ...effects.damage, validate: () => false };
      return effects;
    };
    f.pearls.update(0.2);
    assert.equal(f.pearls.size, 1, refusal);
    assert.deepEqual(f.player.position, position, refusal);
    assert.equal(f.game.health, 20, refusal);
    assert.equal(f.player.fallDistance, 18, refusal);
    assert.ok(Math.abs(f.pearls.projectiles[0].age - 0.2) < 1e-8);
    assert.equal(f.events.length, 0);
    assert.ok(
      f.impacts.length <= 1,
      "no repeated impact preparation inside one update"
    );
  }
});

test("publication invariants propagate rather than masquerading as an impact refusal", (t) => {
  const f = pearlFixture(t);
  floorImpact(f);
  f.pearls.prepareImpact = (request) => {
    const effects = f.prepareImpact(request);
    effects.pose = {
      ...effects.pose,
      publish() {
        throw new Error("broken publisher");
      },
    };
    return effects;
  };
  assert.throws(() => f.pearls.update(0.05), TransactionInvariantError);
});

test("detached impacts reject pose, health, world, geometry and same-byte reload staleness", (t) => {
  const changes = [
    (f) => {
      f.player.position.x++;
    },
    (f) => {
      f.game.damage(1, "fall");
    },
    (f) => {
      f.owner.world = { ...f.world };
    },
    (f) => {
      f.owner.ref = {};
    },
    (f) => {
      f.owner.life++;
    },
    (f) => {
      f.world.epoch++;
    },
    (f) => {
      f.world.put(4, 2, 4, BLOCK.STONE);
    },
    (f) => {
      f.world.admit(0, 0);
    },
    (f) => {
      f.world.chunks.delete("0,0");
    },
    (f) => {
      f.pearls.load(f.pearls.serialize());
    },
    (f) => {
      f.pearls.cancelPending("owner-dead");
    },
  ];
  for (const change of changes) {
    const f = pearlFixture(t);
    floorImpact(f);
    const plan = f.pearls.prepareImpactTransaction(1);
    assert.ok(plan);
    change(f);
    const before = f.pearls.serialize();
    const position = { ...f.player.position };
    const health = f.game.health;
    assert.equal(f.coordinator.commit(plan.participants).ok, false);
    assert.deepEqual(f.pearls.serialize(), before);
    assert.deepEqual(f.player.position, position);
    assert.equal(f.game.health, health);
  }
});

test("void, blocked impact and expiration remove an owned attempt without teleport or refund", (t) => {
  for (const reason of ["void", "blocked", "expired"]) {
    const f = pearlFixture(t);
    assert.equal(f.pearls.throwPearl(f.shot()), true);
    if (reason === "void") {
      f.stage([
        pearlRecord({
          position: { x: 4.5, y: f.world.spec.voidY + 0.1, z: 4.5 },
          velocity: { x: 0, y: -30, z: 0 },
        }),
      ]);
    } else {
      floorImpact(
        f,
        reason === "expired" ? { age: PEARL_LIFETIME_SECONDS - 0.01 } : {}
      );
      if (reason === "blocked") f.world.put(4, 2, 4, BLOCK.STONE);
    }
    const position = { ...f.player.position };
    f.pearls.update(0.05);
    assert.equal(f.pearls.size, 0, reason);
    assert.deepEqual(f.player.position, position, reason);
    assert.equal(f.game.health, 20, reason);
    assert.equal(f.game.getHandStack().count, 15, reason);
    assert.equal(f.impacts.length, 0);
    assert.equal(f.pearls.prepareImpactTransaction(1), null);
  }
});

test("death, missing/stale owner and dimension/world replacement clear pending pearls immediately", (t) => {
  for (const change of [
    (f) => {
      f.game.damage(20, "fall");
    },
    (f) => {
      f.owner.available = false;
    },
    (f) => {
      f.owner.ref = {};
    },
    (f) => {
      f.owner.life++;
    },
    (f) => {
      f.owner.world = { ...f.world };
    },
    (f) => {
      f.world.dimension = "nether";
    },
    (f) => {
      f.world.epoch++;
    },
    (f) => {
      f.world._disposed = true;
    },
  ]) {
    const f = pearlFixture(t);
    floorImpact(f);
    change(f);
    const position = { ...f.player.position };
    const health = f.game.health;
    f.pearls.update(0);
    assert.equal(f.pearls.size, 0);
    advance(f.pearls, 0.2);
    assert.deepEqual(f.player.position, position);
    assert.equal(f.game.health, health);
    assert.equal(f.impacts.length, 0);
  }
});

test("a lethal impact cancels other owned pearls and a postcommit spawn waits until the next update", (t) => {
  const f = pearlFixture(t);
  f.world.put(4, 0, 4, BLOCK.STONE);
  f.game.damage(16, "fall");
  f.stage(
    [1, 2].map((id) =>
      pearlRecord({
        id,
        position: { x: 4.5, y: 2, z: 4.5 },
        velocity: { x: 0, y: -30, z: 0 },
      })
    )
  );
  f.pearls.update(0.05);
  assert.equal(f.game.dead, true);
  assert.equal(f.pearls.size, 0);
  assert.equal(f.impacts.length, 1);

  const next = pearlFixture(t);
  floorImpact(next);
  next.pearls.onEvent = (event) => {
    if (event.type !== "impact") return;
    assert.equal(next.pearls.update(0.05), false);
    assert.equal(next.pearls.throwPearl(next.shot()), true);
  };
  next.pearls.update(0.2);
  assert.equal(next.pearls.size, 1);
  assert.equal(next.pearls.projectiles[0].age, 0);
  next.pearls.update(0.05);
  assert.equal(next.pearls.projectiles[0].age, 0.05);
});

test("unavailable frontiers freeze with bounded pin requests and expire safely", (t) => {
  const f = pearlFixture(t);
  f.stage([pearlRecord({ position: { x: 13, y: 20, z: 4.5 } })]);
  f.world.chunks.delete("1,0");
  f.pearls.update(0.05);
  assert.equal(f.pearls.projectiles[0].position.x, 13);
  assert.equal(f.pearls.projectiles[0].wait, 0.05);
  assert.equal(f.tickets.length, 1);
  assert.ok(f.tickets[0].columns.length <= MAX_PEARL_QUERY_COLUMNS);
  assert.equal(f.tickets[0].ttl, PEARL_FRONTIER_TICKET_SECONDS);
  f.world.admit(1, 0);
  f.pearls.update(0.05);
  assert.equal(f.pearls.projectiles[0].position.x, 14.5);
  assert.equal(f.pearls.projectiles[0].wait, 0);
  f.world.chunks.delete("1,0");
  advance(f.pearls, 2);
  assert.equal(f.pearls.size, 0);
  assert.equal(f.impacts.length, 0);
  assert.equal(f.game.health, 20);
});

test("per-frame work, moving reservations, inactive dimensions and disposal stay bounded", (t) => {
  const f = pearlFixture(t);
  f.stage(
    Array.from({ length: MAX_PLAYER_PEARLS }, (_, i) =>
      pearlRecord({
        id: i + 1,
        position: { x: 13, y: 20 + i / 10, z: 4.5 },
      })
    )
  );
  f.world.chunks.delete("1,0");
  const bytes = f.pearls.reservedBytes;
  const stringify = t.mock.method(JSON, "stringify", () => {
    throw new Error("moving pearls may not serialize the pool");
  });
  f.pearls.update(999);
  stringify.mock.restore();
  assert.ok(f.tickets.length <= MAX_PEARL_FRONTIER_REQUESTS);
  assert.equal(f.pearls.reservedBytes, bytes);
  assert.ok(
    f.pearls.projectiles.every(
      (p) => p.age <= PEARL_STEP_SECONDS * MAX_PEARL_STEPS_PER_UPDATE + 1e-9
    )
  );
  f.world.admit(1, 0);
  f.world.reads = 0;
  const movingStringify = t.mock.method(JSON, "stringify", () => {
    throw new Error("flight must keep its fixed reservation without encoding");
  });
  f.pearls.update(0.2);
  movingStringify.mock.restore();
  assert.ok(f.pearls.projectiles.every((p) => p.position.x > 13));
  assert.equal(f.pearls.reservedBytes, bytes);
  assert.ok(
    f.world.reads <=
      MAX_PEARL_QUERY_CELLS * MAX_PLAYER_PEARLS * MAX_PEARL_STEPS_PER_UPDATE
  );
  f.stage([
    pearlRecord({ dimension: "end" }),
    pearlRecord({ id: 2, dimension: "nether" }),
  ]);
  f.pearls.update(0.05);
  assert.equal(f.pearls.size, 0);
  assert.equal(f.impacts.length, 0);
  f.world.admit(1, 0);
  const plan = f.pearls.prepareThrow(f.shot());
  assert.ok(plan);
  assert.equal(f.pearls.dispose(), true);
  assert.equal(f.coordinator.usage(f.pearls), undefined);
  assert.equal(f.coordinator.commit(plan.participants).ok, false);
  assert.equal(f.game.getHandStack().count, 16);
});
