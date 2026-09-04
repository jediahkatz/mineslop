import { BLOCK } from "./blocks.js";
import { cellsEqual, isValidCell } from "./block-state.js";
import { CONTAINER_BLOCKS } from "./container-kinds.js";
import { physicalEye } from "./game-use-actions.js";
import { cloneStack, insertStack, isValidStack } from "./inventory-slots.js";
import { sameStackKind } from "./item-stack-data.js";
import { getItem, ITEM } from "./items.js";
import { CHUNK_SIZE } from "./terrain.js";

/** Bridges owned-stack transactions to real world/container actions. */
export class GameInventoryActions {
  constructor(game) {
    this.game = game;
  }

  changed() {
    this.game.refreshHud();
    this.game.scheduleSave();
  }

  action(action) {
    const game = this.game;
    game.useActions?.reset();
    if (
      ["fillRecipe", "takeCraftResult"].includes(action?.type) &&
      game.gameplay.getState().craftingSize === 3 &&
      !this.stationValid()
    )
      return {
        ok: false,
        message: "The crafting table is no longer available.",
      };
    const result = game.gameplay.inventoryAction(action, {
      prepareDrops: (stacks) => this.preparePlayerDrops(stacks),
    });
    if (result.ok) this.changed();
    return result;
  }

  swapHands() {
    const game = this.game;
    if (!game.active) return false;
    game.resetActions();
    const changed = game.gameplay.swapHands({
      // F is an explicit Creative copy action. Palette, hands and displaced
      // finite loot publish together, including when the backpack is full.
      creativeCopy: true,
      prepareDrops: (stacks) => this.preparePlayerDrops(stacks),
    });
    if (changed) this.changed();
    return changed;
  }

  pickBlock() {
    const game = this.game;
    if (!game.active || !game.target) return false;
    game.useActions?.reset();
    game.miningKey = "";
    game.miningProgress = 0;
    const hotbar = game.gameplay.hotbar;
    const existing = hotbar.indexOf(game.target.id);
    const picked =
      existing >= 0
        ? game.gameplay.select(existing)
        : game.gameplay.pickBlock(game.target.id);
    if (picked) this.changed();
    return picked;
  }

  dropSelected(wholeStack = false) {
    const game = this.game;
    if (!game.active) return false;
    game.resetActions();
    const gameplay = game.gameplay;
    const stack = gameplay.getHandStack("main");
    if (!stack) return false;
    const owned = gameplay.getState().slots[gameplay.selected];
    const virtual = gameplay.mode === "creative" && owned?.id !== stack.id;
    const dropped = virtual
      ? this.retainPlayerDrops([
          { ...stack, count: wholeStack ? stack.count : 1 },
        ])
      : gameplay.dropSelected({
          wholeStack: Boolean(wholeStack),
          prepareDrops: (stacks) => this.preparePlayerDrops(stacks),
        });
    if (dropped) this.changed();
    return dropped;
  }

  /** Pure preparation. Flushing/saving/toasting happen only after joint commit. */
  preparePlayerDrops(stacks) {
    const game = this.game;
    if (!game.world || !game.player || !game.overflow) return null;
    const player = game.player;
    if (!player.eyePosition && !game.graphics?.camera?.position) return null;
    const eye = physicalEye(game);
    const forward = player.forward;
    if (!eye || !forward) return null;
    const participant = this.prepareDropItems(
      stacks,
      { x: eye.x, y: eye.y - 0.3, z: eye.z },
      {
        pickupDelay: 2,
        velocity: {
          x: forward.x * 3.5,
          y: forward.y * 3.5 + 1.5,
          z: forward.z * 3.5,
        },
      }
    );
    return (
      participant &&
      Object.freeze({
        ...participant,
        validate: () => game.player === player && participant.validate(),
      })
    );
  }

  retainPlayerDrops(stacks) {
    const participant = this.preparePlayerDrops(stacks);
    return (
      participant !== null &&
      this.game.overflow.coordinator.commit([participant]).ok
    );
  }

  /** Prepared arbitrary-position loot sink for World/Settlement transactions. */
  prepareDropItems(drops, position, options = {}) {
    const game = this.game;
    const { world, overflow, pickups, gameplay } = game;
    if (
      !world ||
      !overflow ||
      !gameplay ||
      overflow.coordinator !== gameplay.coordinator ||
      (pickups && pickups.coordinator !== gameplay.coordinator)
    )
      return null;
    const dimension = world.dimension;
    const epoch = world.epoch;
    const participant = overflow.prepareEnqueue(
      drops,
      position,
      dimension,
      options
    );
    if (!participant) return null;
    return Object.freeze({
      ...participant,
      validate: () =>
        game.world === world &&
        game.overflow === overflow &&
        game.pickups === pickups &&
        game.gameplay === gameplay &&
        world.dimension === dimension &&
        world.epoch === epoch &&
        overflow.coordinator === gameplay.coordinator &&
        (!pickups || pickups.coordinator === gameplay.coordinator) &&
        participant.validate(),
      notify: () => {
        try {
          participant.notify?.();
        } finally {
          if (game.world === world && game.overflow === overflow) {
            if (pickups) overflow.flush(world, pickups);
            if (overflow.size && game.elapsed - game.lastOverflowToast > 3) {
              game.lastOverflowToast = game.elapsed;
              game.ui.toast(
                "Extra drops are saved and will appear as pickup space opens"
              );
            }
            game.scheduleSave();
          }
        }
      },
    });
  }

  dropItems(drops, position, options = {}) {
    const participant = this.prepareDropItems(drops, position, options);
    const ok =
      participant !== null &&
      this.game.overflow.coordinator.commit([participant]).ok;
    if (!ok) this.game.ui.toast("Could not retain this item drop");
    return ok;
  }

  /**
   * worldParticipant is an already-prepared World mutation, never an eager
   * changeWorld callback. Omit it ONLY for a no-world-write use (evaporation);
   * null means preparation refused and must not consume/replace the hand.
   */
  swapHandItem(hand, to, worldParticipant, options = {}) {
    const game = this.game;
    const gameplay = game.gameplay;
    const world = game.world;
    if (
      !options ||
      typeof options !== "object" ||
      Array.isArray(options) ||
      !["main", "offhand"].includes(hand)
    )
      return false;
    const held = gameplay.getHandStack(hand);
    const expected = options.stack ?? held;
    const handRevision = options.handRevision ?? gameplay.getHandRevision(hand);
    const reads = options.reads ?? [];
    const item = getItem(to);
    if (
      !held ||
      !isValidStack(expected, gameplay.context) ||
      !sameStackKind(held, expected, gameplay.context) ||
      gameplay.getHandRevision(hand) !== handRevision ||
      !Array.isArray(reads) ||
      !world ||
      (options.world !== undefined && options.world !== world) ||
      (options.gameplay !== undefined && options.gameplay !== gameplay) ||
      !reads.every(
        (read) =>
          read &&
          [read.x, read.y, read.z].every(Number.isSafeInteger) &&
          (read.before === null || isValidCell(read.before))
      ) ||
      world.coordinator !== gameplay.coordinator ||
      !item ||
      item.durability ||
      (worldParticipant !== undefined &&
        (!worldParticipant || typeof worldParticipant !== "object"))
    )
      return false;
    const dimension = world?.dimension;
    const epoch = world?.epoch;
    const worldRevision = world?._editRevision;
    const guardedReads = reads.map((read) => {
      const key = `${Math.floor(read.x / CHUNK_SIZE)},${Math.floor(read.z / CHUNK_SIZE)}`;
      const chunk = world.chunks?.get(key);
      return { ...read, key, chunk, incarnation: chunk?.incarnation };
    });
    let source;
    if (gameplay.mode === "creative" && hand === "main") {
      // Creative pouring keeps its source bucket; collecting fills an empty one.
      source =
        held.id === ITEM.BUCKET
          ? gameplay.prepareAssignSlot(gameplay.selected, to)
          : gameplay.prepareInventory(() => true);
    } else if (gameplay.mode === "creative" && held.id === ITEM.WATER_BUCKET) {
      source = gameplay.prepareInventory(() => true);
    } else {
      source = gameplay.prepareInventory((draft) => {
        const source =
          hand === "main" ? draft.slots[gameplay.selected] : draft.offhand;
        if (!sameStackKind(source, held, gameplay.context) || source.count < 1)
          return false;
        // Preserve applicable decoration; an ineligible transformed payload
        // rejects preparation instead of silently deleting metadata.
        const result = cloneStack(
          {
            id: to,
            count: 1,
            ...(held.data === undefined ? {} : { data: held.data }),
          },
          gameplay.context
        );
        if (source.count === 1) {
          if (hand === "main") draft.slots[gameplay.selected] = result;
          else draft.offhand = result;
        } else {
          const rest = { ...source, count: source.count - 1 };
          if (hand === "main") draft.slots[gameplay.selected] = rest;
          else draft.offhand = rest;
          if (insertStack(draft.slots, result)) return false;
        }
        return true;
      });
    }
    const changed =
      source !== null &&
      gameplay.coordinator.commit([
        {
          ...source,
          validate: () =>
            game.gameplay === gameplay &&
            game.world === world &&
            world?.dimension === dimension &&
            world?.epoch === epoch &&
            world?._editRevision === worldRevision &&
            gameplay.getHandRevision(hand) === handRevision &&
            guardedReads.every(
              (read) =>
                world.chunks?.get(read.key) === read.chunk &&
                read.chunk?.incarnation === read.incarnation &&
                cellsEqual(world.getCell(read.x, read.y, read.z), read.before)
            ) &&
            source.validate(),
        },
        ...(worldParticipant === undefined ? [] : [worldParticipant]),
      ]).ok;
    if (!changed) {
      game.ui.toast("Make room in your inventory first");
      return false;
    }
    game.graphics.rebuildDirty(4);
    game.effects.sound("place", BLOCK.WATER);
    this.changed();
    return true;
  }

  openStation(hit) {
    const game = this.game;
    const { world, gameplay, settlement, player } = game;
    if (
      !game.active ||
      !hit ||
      !world || !gameplay || !settlement || !player ||
      (hit.world !== undefined && hit.world !== world) ||
      (hit.dimension !== undefined && hit.dimension !== world.dimension) ||
      !game.world.isLoaded(hit.x, hit.z) ||
      game.world.get(hit.x, hit.y, hit.z) !== hit.id
    )
      return false;
    if (hit.id === BLOCK.CRAFTING_TABLE) {
      if (
        !game.gameplay.setCraftingSize(3, {
          prepareDrops: (stacks) => this.preparePlayerDrops(stacks),
        })
      )
        return false;
      game.stationOverride = {
        x: hit.x,
        y: hit.y,
        z: hit.z,
        dimension: game.world.dimension,
      };
      game.refreshHud();
      game.ui.openInventory({ screen: "crafting", size: 3 });
      game.scheduleSave();
      return true;
    }
    if (!CONTAINER_BLOCKS.has(hit.id)) return false;
    hit = { ...hit };
    const { dimension, epoch } = world;
    const validate = () => {
      if (game.world !== world || game.gameplay !== gameplay ||
          game.settlement !== settlement || game.player !== player) return false;
      const eye = physicalEye(game);
      return !gameplay.dead && world.dimension === dimension && world.epoch === epoch &&
        world.isLoaded(hit.x, hit.z) && world.get(hit.x, hit.y, hit.z) === hit.id &&
        eye && Math.hypot(eye.x - hit.x - 0.5, eye.y - hit.y - 0.5, eye.z - hit.z - 0.5) <= 5.5;
    };
    if (!validate()) return false;
    const exploration = game.explorationServices?.openContainer(hit);
    if (exploration?.handled && !exploration.ok) {
      game.ui.toast(
        exploration.message ?? "Could not safely open this container."
      );
      return false;
    }
    return game.containerUI.open(
      game.world,
      hit,
      game.gameplay,
      game.settlement,
      { validate }
    );
  }

  plant(hand, hit) {
    const game = this.game;
    const planted = game.settlement.plant(game.world, hit, game.gameplay, {
      hand,
    });
    if (planted) {
      game.graphics.rebuildDirty(4);
      this.changed();
    }
    return planted;
  }

  stationValid() {
    const game = this.game;
    const hit = game.stationOverride;
    if (
      !hit ||
      !game.world ||
      !game.player ||
      hit.dimension !== game.world.dimension ||
      !game.world.isLoaded(hit.x, hit.z) ||
      game.world.get(hit.x, hit.y, hit.z) !== BLOCK.CRAFTING_TABLE
    )
      return false;
    const eye = physicalEye(game);
    return (
      Math.hypot(
        eye.x - hit.x - 0.5,
        eye.y - hit.y - 0.5,
        eye.z - hit.z - 0.5
      ) <= 5.5
    );
  }
}
