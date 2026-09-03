import { preflightWorldComponents } from "./save-preflight.js";
import { MAX_ARCHIVE_BYTES } from "./save-budget.js";
import { exportWorldFile, parseWorldFile, WorldStorage } from "./storage.js";

/** Browser archive UI and persistence, separate from the real-time simulation. */
export class GameArchive {
  constructor(game, storage = new WorldStorage()) {
    this.game = game;
    this.storage = storage;
  }

  snapshot() {
    const game = this.game;
    if (!game.world || !game.player) return null;
    const mobs = game.wildlife.serialize?.();
    const vehiclePose = game.vehicleServices?.poseForArchive();
    const position = vehiclePose?.position ?? game.player.position;
    return {
      version: 3,
      world: game.world.serialize(),
      player: {
        x: position.x,
        y: position.y,
        z: position.z,
        yaw: game.player.yaw,
        pitch: game.player.pitch,
        flying: vehiclePose ? false : game.player.flying,
      },
      gameplay: game.gameplay.serialize(),
      mobs,
      mobStates: { ...game.mobStates, [game.world.dimension]: mobs },
      pickups: game.pickups.serialize(),
      experienceOrbs: game.experienceOrbs?.serialize() ?? {
        version: 1,
        orbs: [],
      },
      overflow: game.overflow.serialize(),
      fuses: game.fuses.serialize(),
      settlement: game.settlement.serialize(),
      time: game.currentTime,
      ...game.buildingServices?.serialize(),
      ...game.fluidServices?.serialize(),
      ...game.projectileServices?.serialize(),
      ...game.progressionIntegration?.serialize(),
      ...game.vehicleServices?.serialize(),
      ...game.explorationServices?.serialize(),
      quality: game.quality,
      soundEnabled: game.soundEnabled,
    };
  }

  scheduleSave() {
    const game = this.game;
    game.storageStatus = "Unsaved changes";
    clearTimeout(game.saveTimer);
    game.saveTimer = setTimeout(() => void this.save(), 900);
  }

  async save(announce = false) {
    const game = this.game;
    if (!game.world || !game.player || game.building)
      return { ok: false, message: "The world is still loading" };
    try {
      game.storageStatus = "Saving…";
      await this.storage.save(this.snapshot());
      game.storageStatus = "Saved on this device";
      game.saveErrorReported = false;
      if (announce) {
        game.ui.toast("World saved on this device");
        void this.storage.requestPersistence();
      }
      return { ok: true };
    } catch (error) {
      game.storageStatus = "Export to keep your progress";
      if (announce || !game.saveErrorReported)
        game.ui.toast(`Could not save: ${error.message}`);
      game.saveErrorReported = true;
      return {
        ok: false,
        message: error.message,
        ...(error.code ? { code: error.code } : {}),
      };
    }
  }

  exportWorld() {
    const game = this.game;
    if (game.building || !game.world)
      return { ok: false, message: "World is still loading" };
    try {
      const data = exportWorldFile(this.snapshot());
      const url = URL.createObjectURL(
        new Blob([data], { type: "application/json" })
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = `${game.world.seed.replace(/[^a-z0-9_-]/gi, "-").slice(0, 60)}.voxelcraft.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      game.ui.toast("World exported. Keep this file as a backup.");
      return { ok: true };
    } catch (error) {
      game.ui.toast(`Export failed: ${error.message}`);
      return { ok: false, message: error.message };
    }
  }

  importWorld(file) {
    return this.game.transitionGate.run(() => this.importFile(file));
  }

  async importFile(file) {
    const game = this.game;
    if (!file || game.building)
      return { ok: false, message: "No world file selected" };
    if (file.size > MAX_ARCHIVE_BYTES) {
      const message = "World file is too large (256 MiB encoded limit)";
      game.ui.toast(message);
      return { ok: false, message };
    }
    try {
      const saved = parseWorldFile(await file.text());
      preflightWorldComponents(saved);
      if (
        !window.confirm(
          "Replace the active world with this imported world? Export your current world first to keep a backup."
        )
      )
        return { ok: false, message: "Import cancelled" };
      if (game.closeScreens && !(await game.closeScreens()))
        return {
          ok: false,
          message: "Close the inventory safely before importing a world.",
        };
      const checkpoint = await this.save();
      if (checkpoint?.code === "STALE_WORLD") return checkpoint;
      await game.initialize(saved.world.seed, saved);
      const result = await this.save();
      if (!result.ok) {
        game.ui.toast(
          "World opened, but browser storage is unavailable. Keep the imported file."
        );
        return result;
      }
      game.ui.toast("World imported");
      return { ok: true };
    } catch (error) {
      game.ui.toast(`Import failed: ${error.message}`);
      return { ok: false, message: error.message };
    }
  }
}
