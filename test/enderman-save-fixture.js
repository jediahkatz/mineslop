import assert from "node:assert/strict";
import { Pickups } from "../src/pickups.js";
import { Player } from "../src/player.js";
import { InputElement } from "./control-fixture.js";

const stageKeys = [
  "weatherServices", "gravityServices", "vehicleServices", "mobIntegration",
  "progressionIntegration", "explorationServices", "projectileServices",
  "fluidServices", "buildingServices", "fuses", "overflow", "settlement",
  "gameplay", "world",
];

/** Real import/initialize/prepareWorld and real owner activation; only the
 * renderer-facing installPreparedWorld boundary and browser storage are
 * replaced. No adoption, parsing, base loading or transaction method is faked.
 */
export function endermanImportHarness(t, f) {
  const writes = [], stages = [];
  const globals = {
    document: f.document,
    window: Object.assign(f.document.defaultView, { confirm: () => true }),
    requestAnimationFrame: (callback) => { queueMicrotask(() => callback(0)); return 1; },
  };
  for (const [key, value] of Object.entries(globals)) {
    const before = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    t.after(() => {
      if (before) Object.defineProperty(globalThis, key, before);
      else delete globalThis[key];
    });
  }
  f.game.archive.storage = { async save(data) { writes.push(structuredClone(data)); } };
  t.mock.method(f.game, "installPreparedWorld", async function (stage, saved) {
    stages.push(stage);
    this.unbindWorldEvents?.();
    this.unbindControls?.();
    this.player.onInputReset = null;
    this.player.dispose();
    this.pickups.dispose();
    for (const key of stageKeys) {
      this[key]?.dispose();
      this[key] = null;
    }
    const player = new Player(this.graphics.camera, stage.world, new InputElement(f.document), {
      inputMode: "remote",
    });
    const pickups = new Pickups(this.graphics.scene, stage.world, {
      coordinator: stage.world.coordinator, context: stage.context,
    });
    t.after(() => {
      player.onInputReset = null;
      player.dispose();
      pickups.dispose();
      for (const key of stageKeys) stage[key]?.dispose();
    });
    player.setPosition(stage.pose.position);
    player.yaw = stage.pose.yaw;
    player.pitch = stage.pose.pitch;
    assert.equal(pickups.load(saved.pickups, { context: stage.context }), true, "load imported pickups");
    Object.assign(this, {
      world: stage.world, worldContext: stage.context, coordinator: stage.world.coordinator,
      gameplay: this.bindGameplay(stage.gameplay), settlement: stage.settlement,
      overflow: stage.overflow, fuses: stage.fuses, player, pickups,
      currentTime: stage.buildingServices.worldClock.time,
      quality: stage.quality, soundEnabled: saved.soundEnabled,
    });
    assert.equal(stage.mobIntegration.install(this, stage.vehicleServices), true, "install imported mob owners");
    const vehicles = stage.vehicleServices.activate(this, { headless: true });
    assert.equal(vehicles.ok, true, vehicles.reason);
    for (const key of ["buildingServices", "fluidServices", "projectileServices"])
      assert.equal(stage[key].activate(this).ok, true, `activate imported ${key}`);
    assert.equal(stage.progressionIntegration.activate(this, { headless: true }).ok, true, "activate imported progression");
    if (stage.explorationServices) assert.equal(stage.explorationServices.activate(this).ok, true, "activate imported exploration");
    assert.equal(stage.mobIntegration.activate(), true, "activate imported ecology");
    // Weather/gravity are staged real owners, irrelevant to mob adoption.
    // Archive their unchanged data without introducing any simulation tick.
    this.weatherServices = stage.weatherServices;
    this.building = false;
  });
  return { writes, stages };
}
