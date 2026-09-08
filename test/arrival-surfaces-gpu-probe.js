import { VoxelGame } from "../src/game.js";
import { GameRenderer } from "../src/renderer.js";
import { surfaceCensus } from "./render-benchmark/surface-oracle.js";
import { arrivalMeshesReady } from "../src/renderer-arrival.js";

const state = window.arrivalSurfaceProof = { started: performance.now(), firstDraw: null, firstFrame: null };
const start = VoxelGame.prototype.start;
VoxelGame.prototype.start = async function (...args) {
  state.game = this;
  await start.apply(this, args);
  state.readyMs = performance.now() - state.started;
};
const draw = GameRenderer.prototype.render;
GameRenderer.prototype.render = function (...args) {
  const result = draw.apply(this, args);
  if (!state.firstDraw && state.game?.graphics === this) {
    state.firstDraw = { ms: performance.now() - state.started, surfaces: surfaceCensus(state.game),
      ready: arrivalMeshesReady(this, this.camera.position), camera: this.camera.position.toArray() };
  }
  return result;
};
const frame = VoxelGame.prototype.frame;
VoxelGame.prototype.frame = function (...args) {
  const result = frame.apply(this, args);
  if (!state.firstFrame && !this.building && this.graphics) {
    state.firstFrame = { ms: performance.now() - state.started, surfaces: surfaceCensus(this),
      ready: arrivalMeshesReady(this.graphics, this.graphics.camera.position),
      fog: { near: this.graphics.scene.fog.near, far: this.graphics.scene.fog.far },
      nativeColumns: this.graphics.chunks.size, radius: this.graphics.renderRadius };
  }
  return result;
};
