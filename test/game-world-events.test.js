import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { bindWorldServiceEvents } from "../src/game-world-events.js";
import { VoxelGame } from "../src/game.js";
import { GameRenderer } from "../src/renderer.js";
import { BlockLightField } from "../src/block-light-field.js";
import { churnWorld } from "./block-light-churn-fixture.js";
import { settleLight } from "./block-light-fixture.js";
import { fluidServicesFixture } from "./game-fluid-services-fixture.js";

test("unbinding revokes retained callbacks even when the same World and service remain active", (t) => {
  const f = fluidServicesFixture(t);
  let saves = 0;
  f.game.scheduleSave = () => saves++;
  const unbind = bindWorldServiceEvents(f.game);
  t.after(unbind);
  const mutation = f.world.onMutation;
  const admission = f.world.onChunkAdmitted;
  const before = f.service.serialize();
  unbind();
  assert.equal(f.world.onMutation, undefined);
  assert.equal(f.world.onChunkAdmitted, undefined);
  assert.equal(
    f.service.active,
    true,
    "the binder does not dispose supplied owners"
  );
  let published;
  const replacement = (event) => {
    published = event;
  };
  f.world.onMutation = replacement;
  f.put(8, 1, 8, BLOCK.WATER);
  assert.ok(published && Object.isFrozen(published));
  mutation(published);
  admission(f.admission());
  unbind();
  assert.equal(
    f.world.onMutation,
    replacement,
    "cleanup does not erase a later observer"
  );
  assert.equal(saves, 0);
  assert.deepEqual(
    f.service.serialize(),
    before,
    "revoked callbacks cannot enqueue work"
  );
});

test("an old unbinder cannot detach a replacement and old callbacks cannot duplicate delivery", (t) => {
  const f = fluidServicesFixture(t);
  let deliveries = 0;
  let saves = 0;
  let published;
  const original = f.service.onMutation.bind(f.service);
  t.mock.method(f.service, "onMutation", (world, event) => {
    deliveries++;
    published = event;
    return original(world, event);
  });
  f.game.scheduleSave = () => saves++;
  const oldUnbind = bindWorldServiceEvents(f.game);
  const oldMutation = f.world.onMutation;
  const unbind = bindWorldServiceEvents(f.game);
  t.after(unbind);
  const current = f.world.onMutation;
  oldUnbind();
  assert.equal(f.world.onMutation, current);
  f.put(8, 1, 8, BLOCK.WATER);
  assert.equal(deliveries, 1);
  assert.equal(saves, 1);
  const queued = f.service.serialize();
  oldMutation(published);
  assert.equal(deliveries, 1);
  assert.equal(saves, 1);
  assert.deepEqual(f.service.serialize(), queued);
});

function host(t, { early = false } = {}) {
  const calls = [];
  const world = { epoch: 1, dimension: "overworld",
    chunks: new Map([["0,0", { cx: 0, cz: 0, incarnation: 1, revision: 0 }]]), _disposed: false };
  const graphics = { world, onWorldMutation(owner, event) {
    assert.equal(this, graphics);
    assert.equal(owner, world);
    calls.push(`graphics:${event.revision}`);
  } };
  const game = {
    world, graphics: early ? undefined : graphics,
    fluidServices: { active: true, onMutation(_world, event) { calls.push(`service:${event.revision}`); },
      onChunkLoaded() { calls.push("admission"); } },
    scheduleSave() { calls.push("save"); },
  };
  VoxelGame.prototype.bindWorldServiceEvents.call(game);
  assert.deepEqual(calls.splice(0), ["admission"], "initial replay never invokes graphics");
  t.after(() => game.unbindWorldEvents?.());
  const event = (revision = 1, changes = {}) => Object.freeze({
    epoch: world.epoch, dimension: world.dimension, revision, changes: Object.freeze([]), ...changes,
  });
  return { world, graphics, game, calls, event };
}

test("Game binding delivers once and first to already-installed or late initial graphics, never admissions", (t) => {
  for (const early of [false, true]) {
    const f = host(t, { early });
    f.world.onChunkAdmitted(f.event());
    assert.deepEqual(f.calls.splice(0), ["admission"]);
    if (early) {
      f.world.onMutation(f.event());
      assert.deepEqual(f.calls.splice(0), ["service:1", "save"]);
      f.game.graphics = f.graphics;
    }
    f.world.onMutation(f.event(2));
    assert.deepEqual(f.calls, ["graphics:2", "service:2", "save"]);
  }
});

test("renderer and service failures are isolated and aggregated in delivery order", (t) => {
  const f = host(t), rendering = new Error("renderer"), service = new Error("service"), save = new Error("save");
  f.graphics.onWorldMutation = () => { f.calls.push("graphics"); throw rendering; };
  f.game.fluidServices.onMutation = () => { f.calls.push("service"); throw service; };
  f.game.scheduleSave = () => { f.calls.push("save"); throw save; };
  assert.throws(() => f.world.onMutation(f.event()), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [rendering, service, save]);
    return true;
  });
  assert.deepEqual(f.calls, ["graphics", "service", "save"]);
});

test("async renderer callbacks are rejected before invocation and rejected returned promises are handled", async (t) => {
  const f = host(t);
  let invoked = false;
  f.graphics.onWorldMutation = async () => { invoked = true; };
  assert.throws(() => f.world.onMutation(f.event()), (error) =>
    error instanceof AggregateError && /synchronous/.test(error.errors[0].message));
  assert.equal(invoked, false);
  assert.deepEqual(f.calls.splice(0), ["service:1", "save"]);
  f.graphics.onWorldMutation = () => Promise.reject(new Error("not a synchronous observer"));
  assert.throws(() => f.world.onMutation(f.event()), AggregateError);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(f.calls, ["service:1", "save"]);
});

test("service reentrancy cannot deliver an obsolete outer event to graphics", (t) => {
  const f = host(t);
  f.game.fluidServices.onMutation = (_world, event) => {
    f.calls.push(`service:${event.revision}`);
    if (event.revision === 1) f.world.onMutation(f.event(2));
  };
  f.world.onMutation(f.event());
  assert.deepEqual(f.calls, ["graphics:1", "service:1", "graphics:2", "service:2", "save", "save"]);
});

test("current epoch/dimension delivery survives in-place travel but rejects stale events and retired owners", (t) => {
  const f = host(t), callback = f.world.onMutation, old = f.event();
  callback(f.event(1, { epoch: 0 }));
  callback(f.event(1, { dimension: "end" }));
  assert.deepEqual(f.calls, []);
  f.world.epoch++;
  f.world.dimension = "nether";
  callback(old);
  callback(f.event(2));
  assert.deepEqual(f.calls.splice(0), ["graphics:2", "service:2", "save"]);
  f.game.world = {};
  callback(f.event());
  f.game.world = f.world;
  f.world._disposed = true;
  callback(f.event());
  assert.deepEqual(f.calls, []);
});

test("replacement graphics require rebinding and superseded bindings revoke retained callbacks without stacking", (t) => {
  const f = host(t), oldMutation = f.world.onMutation, oldAdmission = f.world.onChunkAdmitted;
  const oldUnbind = f.game.unbindWorldEvents;
  const next = { world: f.world, onWorldMutation() { f.calls.push("replacement"); } };
  f.game.graphics = next;
  oldMutation(f.event());
  assert.deepEqual(f.calls.splice(0), ["service:1", "save"]);
  // Direct rebinding also supersedes the old callbacks, without needing the
  // caller to have remembered its old unbinder.
  const unbind = bindWorldServiceEvents(f.game);
  t.after(unbind);
  assert.deepEqual(f.calls.splice(0), ["admission"]);
  oldMutation(f.event()); oldAdmission(f.event());
  assert.deepEqual(f.calls, []);
  oldUnbind();
  f.world.onMutation(f.event());
  assert.deepEqual(f.calls.splice(0), ["replacement", "service:1", "save"]);
  const current = f.world.onMutation;
  unbind();
  current(f.event());
  assert.deepEqual(f.calls, []);
});

test("wrong-world graphics and older renderers without a hook do not affect services", (t) => {
  const f = host(t);
  f.graphics.world = {};
  f.world.onMutation(f.event());
  assert.deepEqual(f.calls.splice(0), ["service:1", "save"]);
  f.graphics.world = f.world;
  delete f.graphics.onWorldMutation;
  f.world.onMutation(f.event());
  assert.deepEqual(f.calls, ["service:1", "save"]);
});

test("reentrant epoch changes and unbinding revoke the rest of an old dispatch", (t) => {
  for (const action of ["epoch", "unbind"]) {
    const f = host(t);
    f.game.fluidServices.onMutation = () => {
      f.calls.push("service");
      if (action === "epoch") f.world.epoch++;
      else f.game.unbindWorldEvents();
    };
    f.world.onMutation(f.event());
    assert.deepEqual(f.calls, ["graphics:1", "service"], "retired dispatch must not schedule a save");
  }
});

test("canonical Game binding carries real native mutations to lighting and disposal disables the borrower", (t) => {
  t.mock.method(performance, "now", () => 0);
  const fixture = churnWorld(), world = fixture.world, field = new BlockLightField();
  const graphics = Object.assign(Object.create(GameRenderer.prototype), { world, blockLight: field });
  const game = { world, graphics };
  VoxelGame.prototype.bindWorldServiceEvents.call(game);
  t.after(() => { game.unbindWorldEvents(); field.dispose(); fixture.dispose(); });
  settleLight(field, world, fixture.position, 1);
  const expected = fixture.points.map((point) => field.sample(point));
  const editsBefore = world._editRevision;
  fixture.mutate(0);
  assert.equal(world._editRevision, editsBefore + 1, "graphics must not publish another mutation");
  field.update(world, fixture.position, 1);
  assert.deepEqual(fixture.points.map((point) => field.sample(point)), expected);
  assert.equal(field.stats.benignCells, 2);
  assert.equal(field.stats.scans + field.stats.visits + field.stats.stampChecks, 0);
  field.dispose();
  fixture.mutate(1);
  assert.equal(field.revisions.semantic.size, 0);
  game.unbindWorldEvents();
  assert.equal(world.onMutation, undefined);
});
