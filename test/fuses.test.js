import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { Fuses } from "../src/fuses.js";
import { TransactionCoordinator } from "../src/transactions.js";

function world() {
  const cells = new Map([["1,20,2", BLOCK.TNT]]);
  const coordinator = new TransactionCoordinator();
  const fixture = {
    dimension: "overworld",
    coordinator,
    epoch: 1,
    revision: 0,
    loaded: true,
    cells,
    isLoaded() {
      return this.loaded;
    },
    get: (x, y, z) => cells.get(`${x},${y},${z}`) ?? 0,
    getCell(x, y, z) {
      return this.loaded ? { id: this.get(x, y, z), state: 0, fluid: 0 } : null;
    },
    prepareMutation(changes) {
      const { revision, epoch, dimension } = this;
      const beforeBytes = coordinator.usage(this);
      return {
        owner: this,
        beforeBytes,
        afterBytes: beforeBytes,
        validate: () =>
          this.loaded &&
          this.revision === revision &&
          this.epoch === epoch &&
          this.dimension === dimension &&
          changes.every(
            ({ x, y, z, before }) => this.get(x, y, z) === before.id
          ),
        publish: () => {
          for (const { x, y, z, after } of changes)
            cells.set(`${x},${y},${z}`, after.id);
          this.revision++;
        },
      };
    },
  };
  coordinator.register(fixture, 0);
  return fixture;
}

test("a primed Overworld TNT fuse cannot explode at matching Nether coordinates", () => {
  const w = world();
  const fuses = new Fuses({ coordinator: w.coordinator });
  assert.equal(fuses.prime(w, { x: 1, y: 20, z: 2 }), true);
  w.dimension = "nether";
  w.cells.set("1,20,2", BLOCK.DIAMOND_ORE);
  let explosions = 0;
  fuses.update(5, w, () => explosions++);
  assert.equal(explosions, 0);
  assert.equal(w.get(1, 20, 2), BLOCK.DIAMOND_ORE);
  assert.equal(fuses.entries[0].remaining, 2);
  w.dimension = "overworld";
  fuses.update(2, w, () => explosions++);
  assert.equal(explosions, 1);
  fuses.update(2, w, () => explosions++);
  assert.equal(explosions, 1);
});

test("unloaded fuses survive save/reload and resume when their terrain returns", () => {
  const w = world();
  const first = new Fuses({ coordinator: w.coordinator });
  first.prime(w, { x: 1, y: 20, z: 2 });
  first.update(0.5, w, () => assert.fail("Too early"));
  w.loaded = false;
  first.update(3, w, () => assert.fail("Unloaded"));
  const resumed = new Fuses({ coordinator: w.coordinator });
  assert.equal(
    resumed.load(JSON.parse(JSON.stringify(first.serialize()))),
    true
  );
  assert.equal(resumed.entries[0].remaining, 1.5);
  w.loaded = true;
  let blast;
  resumed.update(1.5, w, (position) => {
    blast = position;
  });
  assert.deepEqual(blast, { x: 1.5, y: 20.5, z: 2.5 });
});

test("invalid fuse saves are rejected without replacing pending explosives", () => {
  const w = world();
  const fuses = new Fuses({ coordinator: w.coordinator });
  fuses.prime(w, { x: 1, y: 20, z: 2 });
  const before = fuses.serialize();
  for (const patch of [
    { dimension: "moon" },
    { remaining: -1 },
    { x: Infinity },
    { y: 0 },
  ]) {
    assert.equal(
      fuses.load({ version: 1, entries: [{ ...before.entries[0], ...patch }] }),
      false
    );
    assert.deepEqual(fuses.serialize(), before);
  }
});
