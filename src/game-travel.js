import { getBiomeById } from "./biomes.js";
import {
  installTravelLanding, installTravelPortal, stageTravelDestination,
} from "./game-travel-stage.js";
import { TransactionInvariantError } from "./transactions.js";

export { RESPAWN_LOAD_RADIUS } from "./game-travel-stage.js";
const point = ({ x, y, z }) => ({ x, y, z });

/** All world-changing operations share the game's pre-await transition gate. */
export class GameTravel {
  constructor(game, { worldFactory } = {}) {
    this.game = game;
    this.worldFactory = worldFactory;
  }

  teleport(destination) {
    return this.game.transitionGate.run(() => this.move(destination));
  }

  biome(id, options = {}) {
    return this.game.transitionGate.run(() => this.findAndMove(id, options));
  }

  dimension(dimension, portal = false) {
    return this.game.transitionGate.run(async () => {
      const game = this.game;
      if (!["overworld", "nether", "end"].includes(dimension) || game.building)
        return false;
      const from = game.world.dimension;
      const id =
        dimension === "nether"
          ? "nether_wastes"
          : dimension === "end"
            ? "the_end"
            : "plains";
      const result = await this.findAndMove(id, { allowSurvival: portal });
      if (result?.ok && portal && game.world.dimension === dimension) {
        try {
          const placed = installTravelPortal(
            game.world,
            game.player.position,
            from === "end" || dimension === "end"
          );
          result.returnPortal = placed.ok;
          result.observerErrors.push(...(placed.observerErrors ?? []));
          if (!placed.ok)
            game.ui.toast("Arrived safely; the return portal site is obstructed.");
          else game.graphics.rebuildDirty(8);
          await game.save();
        } catch (error) {
          if (error instanceof TransactionInvariantError) throw error;
          result.observerErrors.push(error);
        }
      }
      return result;
    });
  }

  respawn() {
    return this.game.transitionGate.run(async () => {
      const game = this.game;
      game.paused = true;
      return this.move(null, { respawn: true });
    });
  }

  generate(seed) {
    return this.game.transitionGate.run(async () => {
      const game = this.game;
      if (game.building) return false;
      if (
        game.world &&
        !window.confirm(
          "Generate a new world? Export your current world first if you want to keep it."
        )
      )
        return false;
      if (game.closeScreens && !(await game.closeScreens()))
        return {
          ok: false,
          message: "Close the inventory safely before generating a world.",
        };
      const checkpoint = await game.save();
      if (checkpoint?.code === "STALE_WORLD") {
        game.ui.toast(checkpoint.message);
        return checkpoint;
      }
      const cleanSeed =
        String(seed || "cedar-valley")
          .trim()
          .slice(0, 80) || "cedar-valley";
      try {
        await game.initialize(cleanSeed, null, { mode: game.gameplay.mode });
        await game.save();
        game.ui.toast("A whole world is waiting. B opens the biome atlas.");
        return { ok: true };
      } catch (error) {
        game.showError(error);
        return { ok: false, message: error.message };
      }
    });
  }

  async findAndMove(id, { allowSurvival = false } = {}) {
    const game = this.game;
    if (!game.world || game.building) return false;
    if (game.gameplay.mode !== "creative" && !allowSurvival) {
      game.ui.toast(
        "Atlas travel is a Creative option. Switch modes in World settings."
      );
      return false;
    }
    if (!getBiomeById(id)) return false;
    const destination = game.world.locateBiome(id, game.player.position);
    if (!destination) {
      game.ui.toast(
        "That biome could not be located nearby. Try another seed."
      );
      return false;
    }
    return this.move(destination);
  }

  async move(destination, { respawn = false } = {}) {
    const game = this.game;
    if ((!destination && !respawn) || game.building || !game.world || !game.player)
      return false;
    const vehiclePose = game.vehicleServices?.poseForArchive();
    const previous = {
      world: game.world,
      player: game.player,
      gameplay: game.gameplay,
      vehicles: game.vehicleServices,
      mobs: game.mobIntegration,
      wildlife: game.wildlife,
      progression: game.progressionIntegration,
      projectiles: game.projectileServices,
      dimension: game.world.dimension,
      epoch: game.world.epoch,
      position: point(vehiclePose?.position ?? game.player.position),
      velocity: point(vehiclePose?.velocity ?? game.player.velocity ?? { x: 0, y: 0, z: 0 }),
      grounded: vehiclePose?.grounded ?? game.player.grounded === true,
      yaw: game.player.yaw,
      pitch: game.player.pitch,
      flying: !vehiclePose && game.player.flying,
    };
    // Wildlife changes only through this integration during restore, so it is
    // deliberately absent here. The preparation stage pins the original base.
    const ownersCurrent = () => game.world === previous.world &&
      game.player === previous.player && game.gameplay === previous.gameplay &&
      game.vehicleServices === previous.vehicles && game.mobIntegration === previous.mobs &&
      game.progressionIntegration === previous.progression &&
      game.projectileServices === previous.projectiles &&
      game.player.world === previous.world && !previous.world._disposed;
    game.paused = true;
    game.resetActions?.();
    game.heldAction = null;
    game.player.enabled = false;
    if (game.closeScreens) {
      if (!(await game.closeScreens()))
        return {
          ok: false,
          message: "Close the inventory safely before travelling.",
        };
    } else {
      game.ui.closeInventory();
      game.ui.closeAtlas?.();
      game.containerUI.close();
    }
    if (!ownersCurrent())
      return { ok: false, message: "Travel owners were replaced before inspection" };
    game.building = true;
    game.overlayOpen = false;
    game.player.unlock();
    game.ui.setLoading(0.3, "Discovering new terrain");
    let stage, sourceSnapshot;
    let departed = false, suspended = false, restored = false, arrived = false;
    let respawnCommitted = false;
    const observerErrors = [];
    const observe = (work) => {
      try {
        return work();
      } catch (error) {
        if (error instanceof TransactionInvariantError) throw error;
        observerErrors.push(error);
      }
    };
    try {
      stage = await stageTravelDestination(game, destination, {
        respawn, worldFactory: this.worldFactory,
      });
      if (!stage.current() || !ownersCurrent())
        throw new Error("Travel owners were replaced during inspection");
      // No live source epoch, base owner, cast or progression lifecycle was
      // invalidated by the destination inspection. Begin departure only now.
      const recovery = previous.vehicles?.poseForArchive();
      previous.position = point(recovery?.position ?? game.player.position);
      previous.velocity = point(recovery?.velocity ?? game.player.velocity ?? { x: 0, y: 0, z: 0 });
      previous.grounded = recovery?.grounded ?? game.player.grounded === true;
      previous.flying = !recovery && game.player.flying;
      previous.yaw = game.player.yaw;
      previous.pitch = game.player.pitch;
      const departure = previous.vehicles?.detachForTravel({
        validate: () => stage.current() && ownersCurrent(),
      });
      if (departure && !departure.ok)
        throw new Error(`Could not safely leave the vehicle: ${departure.reason}`);
      departed = true;
      observerErrors.push(...(departure?.observerErrors ?? []));
      if (!ownersCurrent()) throw new Error("Travel owners changed at departure");
      // A refused rider/cast departure must not retire unrelated live pearl or
      // potion state. Failures from here recover the source explicitly unseated.
      const progression = previous.progression?.beforeTravel();
      if (progression && !progression.ok)
        throw new Error("Could not safely preserve progression before travel");
      if (previous.projectiles?.cancel("travel") === false)
        throw new Error("Could not safely retire pending projectiles");
      if (previous.mobs) {
        // capture() happens inside suspend(), AFTER the source rider release.
        if (!previous.mobs.suspend()) throw new Error("Could not suspend source mob borrowers");
        suspended = true;
        sourceSnapshot = game.mobStates[previous.dimension];
      } else {
        // Historical host/fixture compatibility; the real Game always installs
        // GameMobIntegration and never restores an owned actor this way.
        game.mobStates ??= {};
        sourceSnapshot = previous.wildlife.serialize();
        game.mobStates[previous.dimension] = sourceSnapshot;
        if (previous.vehicles && !previous.vehicles.suspendWildlife())
          throw new Error("Could not suspend source horse borrower");
        suspended = true;
      }
      const world = previous.world;
      world.setDimension(stage.dimension);
      const epoch = world.epoch;
      await world.ensureArea(stage.position, stage.radius);
      if (!ownersCurrent() || world.epoch !== epoch || world.dimension !== stage.dimension)
        throw new Error("Destination owners changed during admission");
      if (!installTravelLanding(world, stage))
        throw new Error("The prepared destination is no longer safe");
      const safe = stage.position;
      game.player.setPosition(safe);
      game.player.flying = safe.flying === true && !respawn;
      game.player.pitch = -0.12;
      if (previous.mobs) previous.mobs.restore();
      else {
        if (previous.wildlife.dispose() === false)
          throw new Error("Could not release the source Wildlife");
        game.createWildlife(game.mobStates[stage.dimension]);
        if (previous.vehicles && !previous.vehicles.bindWildlife(game.wildlife))
          throw new Error("Could not bind destination horse borrower");
      }
      restored = true;
      // A dead owner has no rider/cast after departure; the normal rebind gate
      // deliberately stays closed until Gameplay's single respawn publishes.
      if (!game.gameplay.dead) {
        const rebound = previous.vehicles?.rebindPlayer();
        if (rebound && !rebound.ok)
          throw new Error(`Could not rebind destination vehicles: ${rebound.reason}`);
      }
      if (respawn) {
        let accepted;
        try {
          accepted = game.gameplay.respawn() !== false;
        } catch (error) {
          if (error instanceof TransactionInvariantError || game.gameplay.dead)
            throw error;
          accepted = true;
          observerErrors.push(error);
        }
        respawnCommitted = accepted && !game.gameplay.dead;
        if (!respawnCommitted) throw new Error("Player respawn was refused");
        observe(() =>
          game.projectileServices?.cancel("respawn", { advanceLife: true })
        );
        observe(() => game.progressionIntegration?.onRespawn());
        const closed = observe(() =>
          game.gameplay.inventoryAction?.(
            { type: "close" },
            {
              prepareDrops: (stacks) => game.preparePlayerDrops(stacks),
            }
          )
        );
        for (const error of closed?.observerErrors ?? [])
          if (error instanceof TransactionInvariantError) throw error;
        observerErrors.push(...(closed?.observerErrors ?? []));
        game.player.flying = false;
        game.wildlife.protectSpawn(game.player.position);
        if (previous.mobs) previous.mobs.capture();
        else game.mobStates[world.dimension] = game.wildlife.serialize();
      }
      arrived = true;
      game.portalCooldown = 4;
      game.building = false;
      observe(() => game.player.update(0, { recoverFromVoid: false }));
      observe(() => game.graphics.rebuildDirty(Infinity));
      observe(() => game.ui.ready());
      observe(() => game.ui.showMenu("pause"));
      observe(() => game.refreshHud());
      try {
        await game.save();
      } catch (error) {
        if (error instanceof TransactionInvariantError) throw error;
        observerErrors.push(error);
      }
      observe(() =>
        game.ui.toast(
          respawn
            ? safe.fromBed
              ? "Respawned at your bed"
              : safe.missingBed
                ? "Your bed is missing or obstructed — respawned at world spawn"
                : "Respawned at world spawn"
            : `Arrived in ${game.world.getBiome(safe.x, safe.z, safe.y).name}`
        )
      );
      return {
        ok: true,
        observerErrors,
        ...(respawn ? { fromBed: safe.fromBed } : {}),
      };
    } catch (error) {
      if (error instanceof TransactionInvariantError) throw error;
      if (!ownersCurrent())
        return { ok: false, message: "Travel owners were replaced during inspection" };
      if (arrived || respawnCommitted) {
        // A completed arrival/respawn never becomes a retryable movement due
        // to a save/render observer, and never restores an old rider link.
        game.building = false;
        observerErrors.push(error);
        return { ok: true, ...(respawn ? { fromBed: stage?.position.fromBed } : {}), observerErrors };
      }
      if (departed) {
        try {
          if (previous.mobs && suspended && previous.mobs.ecologyServices.wildlife &&
              !previous.mobs.suspend())
            throw new Error("Could not suspend failed destination");
          if (!previous.mobs && previous.vehicles?.horses.wildlife &&
              !previous.vehicles.suspendWildlife())
            throw new Error("Could not suspend failed destination horse borrower");
          const world = previous.world;
          const needsRestore = suspended || restored || world.epoch !== previous.epoch;
          world.setDimension(previous.dimension);
          if (needsRestore) {
            const epoch = world.epoch;
            await world.ensureArea(previous.position, game.graphics.renderRadius + 1);
            if (!ownersCurrent() || world.epoch !== epoch || world.dimension !== previous.dimension)
              throw new Error("Source owners changed during recovery");
          }
          // This is deliberately an UNSEATED recovery. A committed departure
          // is not rolled back to the archived rider, even at the same feet.
          game.player.setPosition(previous.position);
          game.player.yaw = previous.yaw;
          game.player.pitch = previous.pitch;
          game.player.flying = previous.flying;
          game.player.velocity?.copy(previous.velocity);
          game.player.grounded = previous.grounded;
          if (needsRestore) {
            if (previous.mobs) previous.mobs.restore(sourceSnapshot);
            else {
              game.wildlife.dispose();
              game.createWildlife(sourceSnapshot);
              if (previous.vehicles && !previous.vehicles.bindWildlife(game.wildlife))
                throw new Error("Could not bind recovered source horse borrower");
            }
          }
          const rebound = previous.vehicles?.rebindPlayer();
          if (rebound && !rebound.ok && !game.gameplay.dead)
            throw new Error(`Could not rebind source vehicles: ${rebound.reason}`);
          game.player._syncCamera?.(0);
          world.updateStreaming(previous.position, game.graphics.renderRadius);
        } catch (recoveryError) {
          if (recoveryError instanceof TransactionInvariantError) throw recoveryError;
          if (!ownersCurrent())
            return { ok: false, message: "Travel owners changed during recovery" };
          game.building = false;
          game.failed = true;
          return { ok: false, rollbackFailed: true,
            message: `${error.message}; source recovery failed: ${recoveryError.message}` };
        }
      }
      game.building = false;
      observe(() => game.ui.ready());
      observe(() => game.ui.showMenu("pause"));
      observe(() => game.ui.toast(`Travel failed: ${error.message}`));
      return { ok: false, message: error.message, observerErrors };
    } finally {
      stage?.dispose();
    }
  }
}
