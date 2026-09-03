import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { bindWorldServiceEvents } from "../src/game-world-events.js";
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
