import * as THREE from "three";
import { BLOCK, BLOCKS } from "./blocks.js";
import { FLUID, isSourceWater, normalizeCell } from "./block-state.js";
import { isBuildingBlock } from "./building-placement.js";
import { placeFluidBlock } from "./game-fluid-block-actions.js";
import { GameMobActions } from "./game-mob-actions.js";
import { EQUIPMENT_SLOTS } from "./inventory-domain.js";
import { canShieldBlock, ItemUse, itemUseKind } from "./item-use.js";
import { stackIdentity } from "./item-stack-data.js";
import { getItem, ITEM } from "./items.js";
import { playerDamageKind } from "./player-damage-kind.js";
import { progressionStationKind } from "./progression-station-state.js";
import { TransactionInvariantError } from "./transactions.js";
import { raycast } from "./world.js";
import {
  bucketPourChange,
  drainedSourceCell,
  findWaterSource,
  prepareIgnitePortal,
} from "./world-interactions.js";

const hands = ["main", "offhand"];
const interactiveBlocks = new Set([
  BLOCK.CHEST,
  BLOCK.FURNACE,
  BLOCK.CRAFTING_TABLE,
]);
const finiteVector = (value) =>
  value && [value.x, value.y, value.z].every(Number.isFinite);

export function physicalEye(game) {
  const pose = game.vehicleServices?.poseForArchive();
  if (pose)
    return { ...pose.position, y: pose.position.y + game.player.eyeHeight };
  return game.player.eyePosition ?? game.graphics.camera.position;
}

/** Right-click priority, held use and physical-eye combat, separate from input transport. */
export class GameUseActions {
  constructor(game) {
    this.game = game;
    this.use = new ItemUse();
    this.held = false;
    this.source = null;
    this.lastUse = -Infinity;
    this.shotEnd = new THREE.Vector3();
    this.observerErrors = [];
  }

  reset() {
    this.held = false;
    this.source = null;
    this.use.cancel();
    this.game.vehicleServices?.resetInput();
  }

  begin(source = "mouse") {
    if (!this.game.active) return false;
    this.held = true;
    this.source = source;
    this.game.updateTarget();
    return this.perform(true);
  }

  end(source = "mouse", cancel = false) {
    if (source !== this.source) return false;
    this.held = false;
    this.source = null;
    this.game.vehicleServices?.resetUse();
    if (cancel) {
      this.use.cancel();
      return false;
    }
    const shot = this.use.release();
    return shot ? this.fireBow(shot) : false;
  }

  tap() {
    if (!this.game.active) return false;
    this.game.updateTarget();
    return this.perform(false);
  }

  update(dt) {
    const game = this.game;
    if (!game.active) {
      this.reset();
      return;
    }
    if (this.use.active) {
      if (
        !this.held ||
        !this.use.matches(
          game.gameplay.getHandStack(this.use.hand),
          game.gameplay.getHandRevision(this.use.hand)
        )
      ) {
        this.reset();
        return;
      }
      if (this.use.advance(dt)) {
        if (this.use.kind === "drink") {
          if (!game.progressionIntegration?.completeDrink(this.use)?.ok)
            this.use.cancel();
        } else if (game.eat(this.use.hand)) this.use.completeFoodCycle();
        else this.use.cancel();
      }
    } else if (
      this.held &&
      game.heldAction !== "mine" &&
      game.elapsed - this.lastUse >= 0.2
    ) {
      this.perform(true);
    }
  }

  perform(held) {
    const game = this.game;
    if (!game.active || this.use.active || game.elapsed - this.lastUse < 0.2)
      return false;
    this.lastUse = game.elapsed;
    if (game.vehicleTarget) {
      const result = game.vehicleServices.interact(game.vehicleTarget, {
        held,
      });
      if (result !== null) return this.finishVehicleAction(result);
    }
    const heldBlock = hands.some((hand) => {
      const stack = game.gameplay.getHandStack(hand);
      return stack && BLOCKS[stack.id] && getItem(stack.id)?.placeable;
    });
    const bypass =
      Boolean(game.player.sneaking || game.player.crouching) && heldBlock;
    if (!game.mobTarget && game.target && !bypass) {
      const building = game.buildingActions?.tryUse(game.target);
      if (building !== null && building !== undefined) {
        if (building.message) game.ui.toast(building.message);
        return building.ok;
      }
      if (interactiveBlocks.has(game.target.id) || progressionStationKind(game.target.id))
        return game.openStation(game.target);
    }

    // Entity interactions take priority over eating the same food.
    if (game.mobTarget) {
      const actions = (game.mobActions ??= new GameMobActions(game));
      const owned = actions.interact(game.mobTarget.entity, { held });
      if (owned !== null) return this.finishVehicleAction(owned);
      for (const hand of hands) {
        const stack = game.gameplay.getHandStack(hand);
        if (!stack || stack.count < 1) continue;
        if (game.wildlife.interact?.(game.mobTarget.entity, stack.id)) {
          game.gameplay.consumeHand(hand, 1);
          game.scheduleSave();
          game.refreshHud();
          return true;
        }
      }
    }
    for (const hand of hands) {
      const stack = game.gameplay.getHandStack(hand);
      if (!stack || stack.count < 1) continue;
      const vehicle = game.vehicleServices?.useHand(hand, { held });
      if (vehicle != null) return this.finishVehicleAction(vehicle);
      const item = getItem(stack.id);
      if (game.progressionIntegration && (item?.emptyBottle || item?.potionForm === "splash")) {
        const result = item.emptyBottle
          ? game.progressionIntegration.fillBottle(hand)
          : game.progressionIntegration.throwPotion(hand);
        if (result.reason === "inventory_full")
          game.ui.toast("Make room for the filled bottle");
        return result.ok === true;
      }
      if (this.useHand(hand, stack, held)) return true;
    }
    return false;
  }

  finishVehicleAction(result) {
    // Ownership has already published. A failed presentation refresh must not
    // turn a paid feed, mount or slot-open into a retryable use failure.
    return this._observeCommitted(result, result?.action === "held-vehicle-use" ? [] : [
      () => this.game.applyVehiclePose(),
      () => this.game.updateTarget(),
      () => this.game.refreshHud(),
    ]);
  }

  _observeCommitted(result, observers) {
    this.observerErrors = (result?.observerErrors ?? []).slice(-16);
    if (result?.ok !== true) return false;
    for (const observe of observers) {
      try { observe(); }
      catch (error) {
        if (error instanceof TransactionInvariantError) throw error;
        this.observerErrors.push(error);
        if (this.observerErrors.length > 16) this.observerErrors.shift();
      }
    }
    return true;
  }

  useHand(hand, stack, held) {
    const game = this.game;
    const { world, gameplay, player } = game;
    const handRevision = gameplay.getHandRevision(hand);
    const item = getItem(stack.id);
    if (!item) return false;
    if (stack.id === ITEM.ENDER_PEARL)
      return game.projectileServices?.throw(hand) ?? false;
    const kind = itemUseKind(item);
    if (kind === "food" && game.gameplay.hunger >= 20) return false;
    if (kind === "bow" && !this.hasArrow(hand)) {
      game.ui.toast("You need arrows for the bow");
      return false;
    }
    if (kind) {
      if (held) this.use.start(kind, hand, stack, handRevision);
      else if (game.player.inputMode === "remote")
        game.ui.toast("Remote controls: hold V to eat, drink, draw a bow or block");
      return true;
    }
    if (EQUIPMENT_SLOTS.includes(item.equipmentSlot)) {
      if (hand === "main" && !gameplay._ownedMainMatchesPalette()) return false;
      const result = game.gameplay.inventoryAction({
        type: hand === "main" ? "swapHotbar" : "swapOffhand",
        area: "equipment",
        index: EQUIPMENT_SLOTS.indexOf(item.equipmentSlot),
        hotbarIndex: game.gameplay.selected,
      });
      if (result.ok) {
        game.refreshHud();
        game.scheduleSave();
      }
      return result.ok;
    }
    if (stack.id === ITEM.BUCKET) {
      const source = findWaterSource(world, physicalEye(game), player.forward);
      const after = drainedSourceCell(source?.cell);
      if (!after) return false;
      const mutation = world.prepareMutation(
        [
          {
            x: source.x,
            y: source.y,
            z: source.z,
            before: source.cell,
            after,
          },
        ],
        { reads: source.reads }
      );
      return game.swapHandItem(hand, ITEM.WATER_BUCKET, mutation, {
        stack,
        handRevision,
        world,
        gameplay,
      });
    }
    if (!game.target || game.mobTarget) return false;
    if (stack.id === ITEM.WATER_BUCKET)
      return this.emptyBucket(hand, { stack, handRevision, world, gameplay });
    if (stack.id === ITEM.SEEDS) return game.plantFromHand(hand, game.target);
    if (stack.id === ITEM.FLINT_AND_STEEL) {
      if (world.coordinator !== gameplay.coordinator) return false;
      const primed =
        game.target.id === BLOCK.TNT
          ? game.fuses.preparePrime(world, game.target)
          : null;
      const portal =
        game.target.id === BLOCK.TNT
          ? null
          : prepareIgnitePortal(world, game.target);
      const participants = primed ?? (portal ? [portal] : null);
      const cost =
        participants &&
        gameplay.prepareHandCost(hand, {
          wear: 1,
          stack,
          handRevision,
        });
      if (
        !cost ||
        !gameplay.coordinator.commit([
          {
            ...cost,
            validate: () =>
              game.world === world &&
              game.gameplay === gameplay &&
              game.player === player &&
              cost.validate(),
          },
          ...participants,
        ]).ok
      )
        return false;
      game.graphics.rebuildDirty(8);
      game.scheduleSave();
      return true;
    }
    if (!item.placeable || !BLOCKS[item.id]) return false;
    return this.place(hand, item.id);
  }

  place(hand, id) {
    const game = this.game;
    const { world, gameplay, player } = game;
    const hit = game.target;
    const fluidPlacement = placeFluidBlock(game, hand, id, hit);
    if (fluidPlacement !== null) return fluidPlacement;
    if (isBuildingBlock(id))
      return game.buildingActions?.place(hand, id, hit) ?? false;
    if (
      !hit?.normal ||
      ![hit.normal.x, hit.normal.y, hit.normal.z].every(Number.isInteger) ||
      Math.abs(hit.normal.x) +
        Math.abs(hit.normal.y) +
        Math.abs(hit.normal.z) !==
        1 ||
      world.coordinator !== gameplay.coordinator
    )
      return false;
    const stack = gameplay.getHandStack(hand);
    const handRevision = gameplay.getHandRevision(hand);
    if (stack?.id !== id || !gameplay.canPlace(id, hand)) return false;
    const clicked = world.getCell(hit.x, hit.y, hit.z);
    if (
      !clicked ||
      clicked.id !== hit.id ||
      (hit.state !== undefined && clicked.state !== hit.state) ||
      (hit.fluid !== undefined && clicked.fluid !== hit.fluid)
    )
      return false;
    const x = hit.x + hit.normal.x;
    const y = hit.y + hit.normal.y;
    const z = hit.z + hit.normal.z;
    const before = world.getCell(x, y, z);
    // Replacing a plant could erase tracked crop ownership or unpaid loot.
    if (
      !before ||
      ![BLOCK.AIR, BLOCK.WATER].includes(before.id) ||
      (BLOCKS[id]?.aquatic && !isSourceWater(before.fluid))
    )
      return false;
    const after = normalizeCell({
      id,
      fluid:
        BLOCKS[id]?.waterloggable && isSourceWater(before.fluid)
          ? FLUID.WATER_SOURCE
          : undefined,
    });
    const changes = [{ x, y, z, before, after }];
    if (player.intersectsPlacement(changes)) return false;
    const mutation = world.prepareMutation(changes, {
      reads: [{ x: hit.x, y: hit.y, z: hit.z, before: clicked }],
    });
    const cost =
      mutation &&
      gameplay.prepareHandCost(hand, {
        count: 1,
        stack,
        handRevision,
      });
    if (
      !cost ||
      !gameplay.coordinator.commit([
        {
          ...cost,
          validate: () =>
            game.world === world &&
            game.gameplay === gameplay &&
            game.player === player &&
            !player.intersectsPlacement(changes) &&
            cost.validate(),
        },
        mutation,
      ]).ok
    )
      return false;
    game.effects.sound("place", id);
    const view = hand === "offhand" ? game.effects.offhand : game.effects;
    if (view) view.swing = 1;
    game.graphics.rebuildDirty(4);
    game.scheduleSave();
    game.updateTarget();
    game.refreshHud();
    return true;
  }

  emptyBucket(hand, options = {}) {
    const game = this.game;
    const world = options.world ?? game.world;
    const gameplay = options.gameplay ?? game.gameplay;
    const player = game.player;
    const stack = options.stack ?? gameplay.getHandStack(hand);
    const handRevision = options.handRevision ?? gameplay.getHandRevision(hand);
    const plan = bucketPourChange(world, game.target);
    if (
      stack?.id !== ITEM.WATER_BUCKET ||
      !plan ||
      player.intersectsPlacement(plan.changes)
    )
      return false;
    if (world.dimension === "nether") {
      const changed = game.swapHandItem(hand, ITEM.BUCKET, undefined, {
        stack,
        handRevision,
        world,
        gameplay,
        reads: plan.reads,
      });
      if (changed) game.ui.toast("Water evaporates in the Nether");
      return changed;
    }
    const mutation = world.prepareMutation(plan.changes, { reads: plan.reads });
    return game.swapHandItem(
      hand,
      ITEM.BUCKET,
      mutation && {
        ...mutation,
        validate: () =>
          game.player === player &&
          !player.intersectsPlacement(plan.changes) &&
          mutation.validate(),
      },
      { stack, handRevision, world, gameplay }
    );
  }

  hasArrow(bowHand) {
    const game = this.game;
    if (
      game.gameplay.mode === "creative" ||
      game.gameplay.countPlain(ITEM.ARROW) > 0
    )
      return true;
    const other = game.gameplay.getHandStack(
      bowHand === "main" ? "offhand" : "main"
    );
    return other?.id === ITEM.ARROW && other.count > 0;
  }

  fireBow(shot) {
    const game = this.game;
    const { world, gameplay, player, wildlife } = game;
    const epoch = world.epoch, dimension = world.dimension;
    const current = () => game.active && game.world === world &&
      game.gameplay === gameplay && game.player === player &&
      game.wildlife === wildlife && !wildlife.disposed &&
      world.epoch === epoch && world.dimension === dimension;
    const {
      hand,
      itemId,
      strength,
      stackIdentity: identity,
      handRevision,
    } = shot ?? {};
    if (
      !hands.includes(hand) ||
      !Number.isFinite(strength) ||
      strength < 0.1 ||
      strength > 1
    )
      return false;
    const stack = gameplay.getHandStack(hand);
    const item = stack && getItem(stack.id);
    const eye = physicalEye(game);
    if (
      !game.active ||
      !stack ||
      stack.id !== itemId ||
      typeof identity !== "string" ||
      stackIdentity(stack, gameplay.context) !== identity ||
      !Number.isSafeInteger(handRevision) ||
      gameplay.getHandRevision(hand) !== handRevision ||
      item?.tool !== "bow" ||
      !finiteVector(eye) ||
      !finiteVector(game.player.forward) ||
      !this.hasArrow(hand)
    )
      return false;
    const cost = gameplay.prepareBowShot(shot);
    if (!cost) return false;
    const origin = new THREE.Vector3().copy(eye);
    const forward = new THREE.Vector3().copy(player.forward);
    const playerPosition = finiteVector(player.position)
      ? new THREE.Vector3().copy(player.position) : null;
    const range = 32 * (0.35 + 0.65 * strength);
    const block = raycast(world, eye, player.forward, range);
    const mob = wildlife.raycast?.(eye, player.forward, range);
    const hit = mob && (!block || mob.distance < block.distance) ? mob : null;
    const targetPosition = hit && finiteVector(hit.entity.position)
      ? new THREE.Vector3().copy(hit.entity.position) : null;
    const targetCurrent = () => current() && !hit.entity.dead && !hit.entity.dormant &&
      (!wildlife.byId || wildlife.byId.get(hit.entity.id) === hit.entity) &&
      (!targetPosition || (finiteVector(hit.entity.position) && targetPosition.equals(hit.entity.position))) &&
      (!playerPosition || (finiteVector(player.position) && playerPosition.equals(player.position))) &&
      finiteVector(physicalEye(game)) && origin.equals(physicalEye(game)) &&
      finiteVector(player.forward) && forward.equals(player.forward);
    const paid = {
      ...cost,
      validate: () => current() && cost.validate(),
    };
    const actions = (game.mobActions ??= new GameMobActions(game));
    const owned = hit && actions.owns(hit.entity);
    const amount = Math.max(1, Math.round((item.damage ?? 6) * strength));
    const result = owned
      ? actions.commit(actions.prepareHit(hit.entity, amount, {
          reach: range, participants: [paid],
        }))
      : gameplay.coordinator.commit([paid]);
    // In particular, an owned target's XP/drop veto cannot consume an arrow.
    if (!result?.ok) return false;
    const distance = hit?.distance ?? block?.distance ?? range;
    this.shotEnd.copy(origin).addScaledVector(forward, distance);
    // Payment notifications may replace owners or invalidate the picked target.
    // Legacy gameplay resolves before optional presentation; owned hits already
    // published damage and rewards atomically with their arrow/wear receipt.
    if (!owned && current()) {
      wildlife.endSpawnProtection?.();
      if (hit && targetCurrent()) {
        const dodged = hit.entity.kind === "enderman" &&
          wildlife.dodgeProjectile?.(hit.entity) === true;
        if (!dodged && targetCurrent()) game.hitMob(hit.entity, amount);
      }
    }
    return this._observeCommitted(result, [
      () => { if (current()) game.effects.shoot(origin, this.shotEnd); },
      () => { if (current()) game.effects.sound("shoot", 5); },
      () => { if (current()) game.scheduleSave(); },
      () => { if (current()) game.refreshHud(); },
    ]);
  }

  damage(amount, cause, source, kind = "melee") {
    const game = this.game;
    const gameplay = game.gameplay;
    const host = gameplay.damageHost;
    const before = gameplay.health;
    kind = playerDamageKind(cause, kind);
    if (!Number.isFinite(amount) || amount <= 0 || gameplay.dead ||
        gameplay.mode === "creative" || (host && !host.running))
      return { health: before, blocked: false, damage: 0 };
    const stack = this.use.active
      ? game.gameplay.getHandStack(this.use.hand)
      : null;
    const blocking =
      this.use.blocking &&
      this.use.matches(stack, game.gameplay.getHandRevision(this.use.hand));
    if (
      blocking &&
      canShieldBlock({
        blocking,
        eye: physicalEye(game),
        forward: game.player.forward,
        source: source?.position ?? source,
        kind,
      })
    ) {
      const hand = this.use.hand;
      const revision = gameplay.getHandRevision(hand);
      const valid = () => game.gameplay === gameplay && this.use.blocking &&
        this.use.hand === hand && gameplay.getHandRevision(hand) === revision &&
        this.use.matches(gameplay.getHandStack(hand), revision);
      const plan = host?.prepareShieldBlock(hand, amount, valid);
      const result = host
        ? plan && host.commit(plan)
        : { ok: gameplay.wearHand(hand, Math.max(1, Math.ceil(amount) + 1)) };
      // A refused block transaction is not permission to deal a different hit.
      if (!result?.ok) return { health: before, blocked: false, damage: 0 };
      this._observeCommitted(result, [
        () => game.effects.sound("block", stack.id),
        () => game.scheduleSave(),
      ]);
      return { health: before, blocked: true, damage: 0 };
    }
    const taken = gameplay.damage(amount, cause, kind);
    return {
      health: gameplay.health,
      blocked: false,
      damage: taken,
    };
  }
}
