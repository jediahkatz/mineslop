import assert from "node:assert/strict";
import { BLOCK } from "../src/blocks.js";
import { cellsEqual, normalizeCell } from "../src/block-state.js";
import { Gameplay } from "../src/gameplay.js";
import { cloneSlots, cloneStack } from "../src/inventory-slots.js";
import { ITEM } from "../src/items.js";
import { encodedBytes } from "../src/save-budget.js";
import { Settlement } from "../src/settlement.js";
import { TransactionCoordinator } from "../src/transactions.js";
import {
  createWorldContext,
  getWorldSpec,
  inWorldBounds,
  isEditablePosition,
} from "../src/world-spec.js";

/** Small loaded-cell participant fixture, not a production terrain generator. */
export class ContainerWorld {
  constructor({
    coordinator = new TransactionCoordinator(),
    seed = "container-unit-test",
    generatorVersion = 3,
  } = {}) {
    this.coordinator = coordinator;
    this.seed = seed;
    this.generatorVersion = generatorVersion;
    this.dimension = "overworld";
    this.epoch = 0;
    this._editRevision = 0;
    this._bytes = 0;
    this._recordBytes = new Map();
    this.cells = new Map();
    this.unloaded = new Set();
    this.blocked = new Set();
    this.dirtyChunks = new Set();
    this.writes = [];
    assert.equal(coordinator.register(this, 0), true);
  }
  get context() {
    return createWorldContext(this);
  }
  key(x, y, z) {
    return `${this.dimension}:${x},${y},${z}`;
  }
  column(x, z) {
    return `${this.dimension}:${Math.floor(x / 16)},${Math.floor(z / 16)}`;
  }
  isLoaded(x, z) {
    return !this.unloaded.has(this.column(x, z));
  }
  get(x, y, z) {
    return this.getCell(x, y, z)?.id ?? BLOCK.AIR;
  }
  getCell(x, y, z) {
    if (
      !this.isLoaded(x, z) ||
      !inWorldBounds(
        x,
        y,
        z,
        getWorldSpec(this.generatorVersion, this.dimension)
      )
    )
      return null;
    return {
      ...(this.cells.get(this.key(x, y, z)) ??
        normalizeCell({ id: BLOCK.AIR })),
    };
  }
  set(x, y, z, id) {
    if (!this.isLoaded(x, z) || this.get(x, y, z) === id) return false;
    const plan = this.prepareMutation([
      { x, y, z, before: this.getCell(x, y, z), after: { id } },
    ]);
    return plan !== null && this.coordinator.commit([plan]).ok;
  }
  prepareMutation(changes, { reads = [] } = {}) {
    const { dimension, seed, generatorVersion, epoch } = this;
    const revision = this._editRevision;
    const beforeBytes = this._bytes;
    const records = [];
    let afterBytes = beforeBytes;
    for (const change of changes) {
      const { x, y, z } = change;
      if (
        !isEditablePosition(x, y, z, generatorVersion, dimension) ||
        !this.isLoaded(x, z) ||
        this.blocked.has(this.key(x, y, z)) ||
        !cellsEqual(this.getCell(x, y, z), change.before)
      )
        return null;
      const before = normalizeCell(change.before);
      const after = normalizeCell(change.after);
      if (cellsEqual(before, after)) continue;
      const key = this.key(x, y, z);
      const bytes =
        after.id === BLOCK.AIR
          ? 0
          : encodedBytes([
              dimension,
              x,
              y,
              z,
              after.id,
              after.state,
              after.fluid,
            ]) + 1;
      afterBytes += bytes - (this._recordBytes.get(key) ?? 0);
      records.push({ x, y, z, key, before, after, bytes });
    }
    if (!records.length) return null;
    let used = false;
    return {
      owner: this,
      beforeBytes,
      afterBytes,
      validate: () =>
        !used &&
        this.dimension === dimension &&
        this.seed === seed &&
        this.generatorVersion === generatorVersion &&
        this.epoch === epoch &&
        this._editRevision === revision &&
        [...records, ...reads].every(
          ({ x, y, z, before }) =>
            this.isLoaded(x, z) && cellsEqual(this.getCell(x, y, z), before)
        ) &&
        records.every(({ key }) => !this.blocked.has(key)),
      publish: () => {
        used = true;
        for (const { x, y, z, key, after, bytes } of records) {
          if (after.id === BLOCK.AIR) {
            this.cells.delete(key);
            this._recordBytes.delete(key);
          } else {
            this.cells.set(key, Object.freeze(after));
            this._recordBytes.set(key, bytes);
          }
          this.writes.push({ dimension, x, y, z, id: after.id });
          this.dirtyChunks.add(this.column(x, z));
        }
        this._bytes = afterBytes;
        this._editRevision++;
      },
      notify: () => this.onMutation?.({ dimension, changes: records }),
    };
  }
  dispose() {
    this.coordinator.release(this);
  }
}

export function containerFixture(kind = "chest", options = {}) {
  const world = new ContainerWorld(options);
  const { coordinator, context } = world;
  const settlement = new Settlement({ coordinator, context });
  const game = new Gameplay({ coordinator, context });
  game.consume(ITEM.APPLE, 4);
  const hit = {
    dimension: world.dimension,
    x: 2,
    y: 20,
    z: 3,
    id: kind === "chest" ? BLOCK.CHEST : BLOCK.FURNACE,
  };
  world.set(hit.x, hit.y, hit.z, hit.id);
  const action = (command, options) =>
    settlement.containerAction(world, hit, game, command, options);
  const state = () => settlement.getContainerState(world, hit, game);
  const snapshot = () => [settlement.serialize(), game.serialize()];
  return {
    world,
    settlement,
    game,
    hit,
    action,
    state,
    snapshot,
    coordinator,
    context,
  };
}

/** Records proposals separately from ownership; rejected plans publish nothing. */
export function dropCollector(
  coordinator,
  { accept = true, validate = () => true, onPrepare, notify } = {}
) {
  const owner = { drops: [], proposals: [], revision: 0, accept };
  assert.equal(coordinator.register(owner, 0), true);
  owner.prepareDrops = (stacks) => {
    owner.proposals.push(cloneSlots(stacks));
    onPrepare?.(stacks);
    if (!owner.accept) return null;
    const revision = owner.revision;
    const beforeBytes = coordinator.usage(owner);
    const next = cloneSlots([...owner.drops, ...stacks]);
    let used = false;
    return {
      owner,
      beforeBytes,
      afterBytes: encodedBytes(next),
      validate: () => !used && owner.revision === revision && validate(),
      publish: () => {
        used = true;
        owner.drops = next;
        owner.revision++;
      },
      notify,
    };
  };
  return owner;
}

export function experienceCollector(
  coordinator,
  { accept = true, validate = () => true, notify } = {}
) {
  const owner = { total: 0, revision: 0, accept };
  assert.equal(coordinator.register(owner, 32), true);
  owner.prepareExperience = (amount) => {
    if (!owner.accept) return null;
    const revision = owner.revision;
    const next = owner.total + amount;
    let used = false;
    return {
      owner,
      beforeBytes: 32,
      afterBytes: 32,
      validate: () => !used && owner.revision === revision && validate(),
      publish: () => {
        used = true;
        owner.total = next;
        owner.revision++;
      },
      notify,
    };
  };
  return owner;
}

/** Test setup uses the same explicit transaction boundary as external domains. */
export function editOwnership(game, edit) {
  const result = game.inventoryTransaction((owned) => {
    edit(owned);
    return true;
  });
  assert.equal(result, true);
}

export function putPlayerStack(game, index, stack) {
  editOwnership(game, (owned) => {
    owned.slots[index] = cloneStack(stack);
  });
}

export function moveIntoContainer(fixture, index, stack) {
  putPlayerStack(fixture.game, 9, stack);
  assert.equal(
    fixture.action({
      type: "click",
      area: "inventory",
      index: 9,
      button: 0,
    }).ok,
    true
  );
  assert.equal(
    fixture.action({
      type: "click",
      area: "container",
      index,
      button: 0,
    }).ok,
    true
  );
}
