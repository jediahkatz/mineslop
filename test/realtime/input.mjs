import { setTimeout as delay } from "node:timers/promises";
import { DOUBLE_TAP_MS } from "../../src/player.js";

export async function bounded(promise, milliseconds, description) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(`${description} timed out after ${milliseconds} ms`)
            ),
          milliseconds
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const clamp = (value, minimum, maximum) =>
  Math.max(minimum, Math.min(maximum, value));

/** All controls enter through Chromium's trusted Playwright/CDP input path. */
export class RealInputs {
  constructor(page, config) {
    this.page = page;
    this.config = config;
    this.held = new Set();
    this.buttons = new Set();
    this.lastSpacePressAt = -Infinity;
    this.cursor = {
      x: config.viewport.width / 2,
      y: config.viewport.height / 2,
    };
    this.lookMode = "native-mouse";
    this.counts = {
      keydown: 0,
      keyup: 0,
      mousemove: 0,
      mousedown: 0,
      mouseup: 0,
      clicks: 0,
      clippedMouseMoves: 0,
      byKey: {},
    };
  }

  state(options) {
    return bounded(
      this.page.evaluate((value) => window.__voxelBot.state(value), options),
      this.config.timeoutMs,
      "Reading live game state"
    );
  }

  async until(predicate, description, timeout = this.config.timeoutMs) {
    const deadline = performance.now() + timeout;
    let state;
    do {
      state = await this.state();
      if (state.error || state.failed)
        throw new Error(state.error ?? "The game failed");
      if (predicate(state)) return state;
      await delay(30);
    } while (performance.now() < deadline);
    throw new Error(
      `${description} timed out; last state: ${JSON.stringify(state)}`
    );
  }

  async frames(count = 2) {
    const before = await this.state();
    return this.until(
      (state) => state.frame >= before.frame + count,
      "Animation frames"
    );
  }

  async down(key, { flight = false } = {}) {
    if (this.held.has(key)) return;
    if (flight && key === "Space") {
      const remaining =
        DOUBLE_TAP_MS + 50 - (performance.now() - this.lastSpacePressAt);
      if (remaining > 0) await delay(remaining);
    }
    await this.page.keyboard.down(key);
    this.held.add(key);
    if (key === "Space") this.lastSpacePressAt = performance.now();
    this.counts.keydown++;
    this.counts.byKey[key] = (this.counts.byKey[key] ?? 0) + 1;
  }

  async up(key) {
    if (!this.held.has(key)) return;
    await this.page.keyboard.up(key);
    this.held.delete(key);
    this.counts.keyup++;
  }

  async press(key) {
    await this.up(key);
    await this.down(key);
    await this.up(key);
  }

  async doubleTap(key) {
    // Two real press/release pairs, never a repeated keydown or DOM dispatch.
    await this.press(key);
    await this.press(key);
  }

  async setHeld(keys, { flight = false } = {}) {
    const wanted = new Set(keys);
    // Altitude correction is a hold, not an intentional flight toggle. Wait
    // in wall-clock control ticks before re-pressing Space after a short gap.
    if (
      flight &&
      wanted.has("Space") &&
      !this.held.has("Space") &&
      performance.now() - this.lastSpacePressAt <= DOUBLE_TAP_MS + 50
    )
      wanted.delete("Space");
    for (const key of this.held) if (!wanted.has(key)) await this.up(key);
    for (const key of wanted) await this.down(key);
  }

  async release() {
    await this.setHeld([]);
    for (const button of this.buttons) await this.mouseUp(button);
  }

  async click(selector) {
    const locator = this.page.locator(selector);
    await locator.waitFor({ state: "visible" });
    const box = await locator.boundingBox();
    await locator.click();
    if (box)
      this.cursor = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    this.counts.clicks++;
    this.counts.mousedown++;
    this.counts.mouseup++;
  }

  async mouseDown(button = "left") {
    if (this.buttons.has(button)) return;
    await this.page.mouse.down({ button });
    this.buttons.add(button);
    this.counts.mousedown++;
  }

  async mouseUp(button = "left") {
    if (!this.buttons.has(button)) return;
    await this.page.mouse.up({ button });
    this.buttons.delete(button);
    this.counts.mouseup++;
  }

  async moveTo(x, y) {
    const next = {
      x: clamp(x, 25, this.config.viewport.width - 25),
      y: clamp(y, 25, this.config.viewport.height - 25),
    };
    if (next.x !== x || next.y !== y) this.counts.clippedMouseMoves++;
    if (
      Math.abs(next.x - this.cursor.x) + Math.abs(next.y - this.cursor.y) <
      0.1
    )
      return;
    await this.page.mouse.move(next.x, next.y);
    this.cursor = next;
    this.counts.mousemove++;
  }

  moveBy(x, y) {
    return this.moveTo(this.cursor.x + x, this.cursor.y + y);
  }

  async steer(state, yaw, pitch) {
    if (this.lookMode === "native-mouse") {
      await this.moveBy(
        clamp((state.yaw - yaw) / 0.002, -18, 18),
        clamp((state.pitch - pitch) / 0.002, -12, 12)
      );
      return [];
    }
    // Reported fallback only: these are still trusted keyboard inputs.
    const keys = [];
    if (state.yaw < yaw - 0.045) keys.push("ArrowLeft");
    if (state.yaw > yaw + 0.045) keys.push("ArrowRight");
    if (state.pitch < pitch - 0.045) keys.push("ArrowUp");
    if (state.pitch > pitch + 0.045) keys.push("ArrowDown");
    return keys;
  }
}

/** Read-only terrain planning; altitude is reached with Space/Shift. */
export function traversalPlan(state, seconds, anchorYaw) {
  const samples = state.planning?.samples ?? [];
  if (!samples.length)
    throw new Error("Traversal needs real terrain-height samples");
  const targetAltitude = Math.min(
    state.planning.worldHeight + 4,
    Math.max(
      (state.planning.waterLevel ?? -Infinity) + 6,
      ...samples.map((sample) =>
        Math.max(sample.terrainHeight + 8, (sample.topSolid ?? -Infinity) + 3)
      )
    )
  );
  const keys = ["KeyW"];
  if (Math.floor(seconds / 6) % 3 !== 2) keys.push("ControlLeft");
  const strafePhase = Math.floor(seconds / 4) % 4;
  if (strafePhase === 0) keys.push("KeyA");
  if (strafePhase === 2) keys.push("KeyD");
  const predictedY = state.position.y + state.velocity.y * 0.15;
  if (predictedY < targetAltitude - 0.65) keys.push("Space");
  if (predictedY > targetAltitude + 0.65) keys.push("ShiftLeft");
  return {
    keys,
    targetAltitude,
    yaw: anchorYaw + Math.sin(seconds / 3.5) * 0.32,
    pitch: -0.42 + Math.sin(seconds / 3) * 0.035,
  };
}
