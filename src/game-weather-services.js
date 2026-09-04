import { CloudField } from "./cloud-field.js";
import { audioOperation } from "./audio-lifecycle.js";
import { geometryWorldSpec } from "./geometry-world.js";
import { WeatherRender, SILENT_WEATHER } from "./weather-render.js";
import { normalizeWeatherArchive, WeatherState } from "./weather-state.js";

export { normalizeWeatherArchive } from "./weather-state.js";

/**
 * Detached staging owner installed by Game alongside the other world owners.
 *
 * prepareWorld: construct with {world: staged.world, saved}, add to cleanup
 * owners, return weatherServices. No scene writes until activate(game), after
 * graphics installation. Dispose the OLD owner before replacing graphics/world.
 *
 * preflight: exclude descriptors.weather from the generic structuredClone;
 * normalizeWeatherArchive(originalSaved), reject null, merge canonical result.
 * archive snapshot: spread weatherServices.serialize() at the top level.
 *
 * frame: call frame(dt,{simulating:game.simulating,hidden:document.hidden})
 * even before early hidden/loading returns (silences sound projection). Call
 * render() AFTER graphics.update and BEFORE graphics.render; it overrides only
 * the borrowed cloud transforms, never atmosphere visibility/material/lighting.
 * Atmosphere can remove its legacy cloud transform loop and camera-carried
 * x/y/z assignments once this hook is installed; keep its 108-box mesh/art.
 *
 * GameTravel: retain this owner in ownersCurrent. After setDimension/ensureArea
 * succeeds, call rebindWorldEpoch(); call again AFTER restoring source dimension
 * on rollback. No weather reset/reload on travel or respawn, including Nether/
 * End. Loading freezes the authoritative clock; active other dimensions don't.
 *
 * Audio owner reads desiredAudio once per frame and applies a single bounded
 * rain loop gain, not one sound per drop/frame. Hidden/pause/loading/dead/stale
 * and dispose all project level zero. No live audio implementation lives here.
 *
 * Events: include "weatherServices" in game-world-events.js serviceSlots before
 * binding the new world's consumers. Deliver onMutation(world,event)
 * synchronously after publication, including while paused/hidden. Missed events
 * remain safe but force rescans; onChunkLoaded needs no payload retention.
 */
export class GameWeatherServices {
  constructor({ world, saved } = {}) {
    const snapshot = normalizeWeatherArchive(saved);
    if (!world || !snapshot) throw new Error("Invalid staged weather");
    this.world = world;
    this.seed = world.seed;
    this.generatorVersion = world.generatorVersion;
    this.epoch = world.epoch;
    this.state = new WeatherState(world.seed, snapshot.weather);
    this.clouds = new CloudField(world.seed);
    this.renderer = null;
    this.game = null;
    this.disposed = false;
    this.desiredAudio = SILENT_WEATHER;
    this.running = false;
  }

  get active() {
    return !this.disposed && !this.world._disposed &&
      this.game?.world === this.world && this.game?.weatherServices === this &&
      this.game?.gameplay === this.gameplay && this.game?.player === this.player &&
      this.game?.graphics === this.graphics &&
      this.world.seed === this.seed && this.world.generatorVersion === this.generatorVersion &&
      this.world.epoch === this.epoch;
  }

  activate(game) {
    if (this.game)
      return this.game === game && this.active ? { ok: true }
        : { ok: false, reason: "stale-weather-host" };
    if (this.disposed || this.world._disposed || !game ||
        game.world !== this.world || this.world.epoch !== this.epoch ||
        this.world.seed !== this.seed || this.world.generatorVersion !== this.generatorVersion ||
        (this.game && this.game !== game) ||
        (game.weatherServices && game.weatherServices !== this))
      return { ok: false, reason: "stale-weather-host" };
    this.game = game;
    this.gameplay = game.gameplay;
    this.player = game.player;
    this.graphics = game.graphics;
    game.weatherServices = this;
    return { ok: true };
  }

  onMutation(world, event) {
    if (!this.active || world !== this.world) return false;
    return this.renderer?.exposure.onMutation(world, event) ?? false;
  }

  // Roof access checks resident identity and load state; never retain admissions.
  onChunkLoaded(world, event) {
    return this.active && world === this.world &&
      event?.epoch === this.epoch && event?.dimension === world.dimension;
  }

  canSimulate(hidden = globalThis.document?.hidden === true) {
    const game = this.game;
    return this.active && game.simulating === true && !hidden && !game.hidden &&
      !game.paused && !game.building && !game.failed && !game.gameplay?.dead &&
      !game.gameplay?._disposed;
  }

  frame(dt, { simulating = this.game?.simulating === true,
    hidden = globalThis.document?.hidden === true } = {}) {
    this.running = this.canSimulate(hidden) && simulating &&
      Number.isFinite(dt) && dt >= 0;
    if (!this.running) this.desiredAudio = this.renderer?.hide() ?? SILENT_WEATHER;
    if (!this.active) return { ok: false, reason: "stale-weather-host" };
    if (this.running) this.state.advance(Math.min(dt, 0.1));
    return { ok: true, advanced: this.running, weather: this.state.sample() };
  }

  render() {
    const graphics = this.game?.graphics;
    if (!this.active || !graphics?.camera || !graphics?.scene) {
      this.desiredAudio = this.renderer?.hide() ?? SILENT_WEATHER;
      return this.desiredAudio;
    }
    const atmosphere = graphics.atmosphere;
    this.clouds.update(atmosphere?.clouds, graphics.camera.position,
      this.state.elapsed, geometryWorldSpec(this.world));
    if (!this.running || !this.canSimulate()) {
      this.desiredAudio = this.renderer?.hide() ?? SILENT_WEATHER;
      return this.desiredAudio;
    }
    if (this.renderer && this.renderer.scene !== graphics.scene) this.renderer.dispose();
    if (!this.renderer || this.renderer.disposed) this.renderer = new WeatherRender(graphics.scene);
    this.desiredAudio = this.renderer.update(this.world, graphics.camera.position,
      this.state.sample(), {
        mediumKnown: atmosphere?.cameraMediumKnown !== false,
        submerged: atmosphere?.underwater === true || atmosphere?.inLava === true,
      });
    return this.desiredAudio;
  }

  rebindWorldEpoch() {
    if (this.disposed || this.world._disposed ||
        this.game?.world !== this.world || this.game?.weatherServices !== this ||
        this.game?.gameplay !== this.gameplay || this.game?.player !== this.player ||
        this.game?.graphics !== this.graphics ||
        this.world.seed !== this.seed || this.world.generatorVersion !== this.generatorVersion)
      return { ok: false, reason: "stale-weather-host" };
    this.epoch = this.world.epoch;
    this.renderer?.exposure.clear();
    this.desiredAudio = this.renderer?.hide() ?? SILENT_WEATHER;
    this.running = false;
    return { ok: true };
  }

  serialize() {
    if (this.disposed || this.world._disposed ||
        this.world.seed !== this.seed || this.world.generatorVersion !== this.generatorVersion ||
        this.world.epoch !== this.epoch || (this.game && !this.active))
      throw new Error("Cannot serialize stale weather");
    return { weather: this.state.serialize() };
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.renderer?.dispose();
    this.desiredAudio = SILENT_WEATHER;
    this.running = false;
    if (this.game?.weatherServices === this) {
      audioOperation(this.game.audioEngine, "setRain", 0);
      this.game.weatherServices = null;
    }
    this.game = null;
  }
}
