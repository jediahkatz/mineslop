import { getBiomeById } from "./biomes.js";
import { isSafeRespawnPosition } from "./bed-spawn.js";
import { BED_STATE_VERSION, normalizeBedSnapshot } from "./bed-system.js";
import { TransactionInvariantError } from "./transactions.js";
import { createReturnPortal, findSafeLanding } from "./world-interactions.js";
import { createWorldContext } from "./world-spec.js";

export const RESPAWN_LOAD_RADIUS = 1;

/** All world-changing operations share the game's pre-await transition gate. */
export class GameTravel {
  constructor(game) {
    this.game = game;
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
        createReturnPortal(
          game.world,
          game.player.position,
          from === "end" || dimension === "end"
        );
        game.graphics.rebuildDirty(8);
        await game.save();
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

  /** Inspect one bed footprint, then World's bounded spawn fallback if needed. */
  async _respawnLanding(world) {
    const game = this.game;
    if (game.world !== world || world._disposed)
      throw new Error("World changed before respawn inspection");
    const beds = game.beds ?? game.buildingActions?.beds;
    const { seed, generatorVersion } = world;
    const saved = normalizeBedSnapshot(
      {
        version: BED_STATE_VERSION,
        spawn: beds?.getRespawn?.() ?? null,
      },
      createWorldContext(world)
    );
    world.setDimension("overworld");
    const epoch = world.epoch ?? world._epoch;
    const ensure = async (position) => {
      await world.ensureArea(position, RESPAWN_LOAD_RADIUS);
      if (
        game.world !== world ||
        world._disposed ||
        world.seed !== seed ||
        world.generatorVersion !== generatorVersion ||
        world.dimension !== "overworld" ||
        (world.epoch ?? world._epoch) !== epoch
      )
        throw new Error("World changed during respawn inspection");
    };
    if (saved?.spawn) {
      await ensure(saved.spawn);
      const landing = beds.findRespawn(world);
      if (landing && isSafeRespawnPosition(world, landing))
        return { ...landing, fromBed: true };
    }
    // World.getSpawn already searches geometry without modifying terrain.
    // Do not use findSafeLanding's portal-platform fallback for a respawn.
    const spawn = world.getSpawn();
    await ensure(spawn);
    if (!isSafeRespawnPosition(world, spawn))
      throw new Error("No unobstructed standing space at the world spawn");
    return {
      ...spawn,
      dimension: "overworld",
      fromBed: false,
      missingBed: !!saved?.spawn,
    };
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
    if ((!destination && !respawn) || game.building) return false;
    const previous = {
      world: game.world,
      player: game.player,
      gameplay: game.gameplay,
      dimension: game.world.dimension,
      position: game.player.position.clone(),
      yaw: game.player.yaw,
      pitch: game.player.pitch,
      flying: game.player.flying,
    };
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
    if (
      respawn &&
      (game.world !== previous.world ||
        game.player !== previous.player ||
        game.gameplay !== previous.gameplay)
    )
      return {
        ok: false,
        message: "Respawn owners were replaced before inspection",
      };
    game.projectileServices?.cancel("travel");
    game.building = true;
    game.overlayOpen = false;
    game.player.unlock();
    game.ui.setLoading(0.3, "Discovering new terrain");
    let playerMoved = false;
    let respawnCommitted = false;
    let safe;
    const observerErrors = [];
    const observe = (work) => {
      try {
        return work();
      } catch (error) {
        if (!respawnCommitted || error instanceof TransactionInvariantError)
          throw error;
        observerErrors.push(error);
      }
    };
    try {
      game.mobStates[game.world.dimension] = game.wildlife.serialize?.();
      if (respawn) {
        safe = await this._respawnLanding(previous.world);
        if (
          game.world !== previous.world ||
          game.player !== previous.player ||
          game.gameplay !== previous.gameplay
        )
          throw new Error("Respawn owners were replaced during inspection");
      } else {
        if (
          destination.dimension &&
          destination.dimension !== game.world.dimension
        )
          game.world.setDimension(destination.dimension);
        await game.world.ensureArea(
          destination,
          game.graphics.renderRadius + 1
        );
        safe = findSafeLanding(game.world, destination, {
          allowFlying: game.gameplay.mode === "creative",
        });
      }
      if (!safe) throw new Error("No safe destination was found");
      const departure = game.vehicleServices?.detachForTravel();
      if (departure && !departure.ok)
        throw new Error(
          `Could not safely leave the vehicle: ${departure.reason}`
        );
      game.player.setPosition(safe);
      playerMoved = true;
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
      }
      if (safe.flying) game.player.flying = true;
      game.player.pitch = -0.12;
      observe(() =>
        game.player.update(respawn ? 0 : 0.001, {
          recoverFromVoid: game.gameplay.mode === "creative",
        })
      );
      observe(() => game.graphics.rebuildDirty(Infinity));
      observe(() => game.wildlife.dispose());
      observe(() =>
        game.createWildlife(game.mobStates[game.world.dimension], {
          safeSpawn: respawn,
        })
      );
      game.portalCooldown = 4;
      game.building = false;
      observe(() => game.ui.ready());
      observe(() => game.ui.showMenu("pause"));
      observe(() => game.refreshHud());
      try {
        await game.save();
      } catch (error) {
        if (!respawnCommitted || error instanceof TransactionInvariantError)
          throw error;
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
        ...(respawn ? { fromBed: safe.fromBed, observerErrors } : {}),
      };
    } catch (error) {
      if (respawn && error instanceof TransactionInvariantError) throw error;
      if (
        respawn &&
        (game.world !== previous.world ||
          game.player !== previous.player ||
          game.gameplay !== previous.gameplay)
      )
        return {
          ok: false,
          message: "Respawn owners were replaced during inspection",
        };
      if (respawnCommitted) {
        // A save/render observer cannot send a now-living player back into the
        // old dimension or make the completed respawn look retryable.
        game.building = false;
        observerErrors.push(error);
        return { ok: true, fromBed: safe?.fromBed, observerErrors };
      }
      game.world.setDimension(previous.dimension);
      if (!respawn || playerMoved) game.player.setPosition(previous.position);
      game.player.yaw = previous.yaw;
      game.player.pitch = previous.pitch;
      game.player.flying = previous.flying;
      if (!respawn || playerMoved)
        game.player.update(respawn ? 0 : 0.001, {
          recoverFromVoid: game.gameplay.mode === "creative",
        });
      game.world.updateStreaming(previous.position, game.graphics.renderRadius);
      game.building = false;
      game.ui.ready();
      game.ui.showMenu("pause");
      game.ui.toast(`Travel failed: ${error.message}`);
      return { ok: false, message: error.message };
    }
  }
}
