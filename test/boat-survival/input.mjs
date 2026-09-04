import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { BLOCK } from "../../src/blocks.js";
import { getRecipe } from "../../src/recipes.js";
import { RealInputs } from "../realtime/input.mjs";
import { recipeResources, resourceCounts, survivalAim } from "../realtime/survival.mjs";
import { cellKey, center, horizontal } from "./planning.js";

export const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export const ownedStacks = (state) => [
  ...state.slots, state.cursor, state.offhand,
  ...Object.values(state.equipment), ...state.craftingGrid,
].filter(Boolean);
export const ownedCounts = (state) => resourceCounts(ownedStacks(state));
export const angular = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));

function compactRoute(route) {
  return route.filter((point, index) => {
    if (index === 0 || index === route.length - 1) return true;
    const before = route[index - 1], after = route[index + 1];
    return before.y !== point.y || after.y !== point.y ||
      Math.sign(point.x - before.x) !== Math.sign(after.x - point.x) ||
      Math.sign(point.z - before.z) !== Math.sign(after.z - point.z);
  });
}

/** Only the action methods of RealInputs are reused, never its mutable bot host. */
export class NativeSurvival {
  constructor(page, report, viewport) {
    this.page = page;
    this.report = report;
    this.input = new RealInputs(page, { viewport, timeoutMs: 10000 });
    this.cells = [];
    this.last = null;
    this.phase = "boot";
  }

  async read(active = false) {
    const state = await this.page.evaluate((cells) => window.__boatSurvival.read(cells), this.cells);
    this.last = state;
    if (state.error || state.failed || state.dead || state.hidden)
      throw new Error(`Native Survival stopped: ${JSON.stringify({
        phase: this.phase, error: state.error, dead: state.dead, hidden: state.hidden,
      })}`);
    if (active) {
      assert.equal(state.active && state.enabled && state.locked, true, "native controls remain captured");
      assert.equal(state.mode, "survival");
      assert.equal(state.inputMode, "native");
      assert.equal(state.flying || state.allowFlight, false, "Survival never gains flight");
    }
    return state;
  }

  async poll(label, predicate, timeout = 7000, active = false) {
    const end = performance.now() + timeout;
    do {
      const state = await this.read(active);
      if (predicate(state)) return state;
      await delay(40);
    } while (performance.now() < end);
    throw new Error(`${label} timed out: ${JSON.stringify({
      phase: this.phase, position: this.last?.position, velocity: this.last?.velocity,
      target: this.last?.target, vehicleTarget: this.last?.vehicleTarget,
      toast: this.last?.toast, inventory: this.last?.inventory,
    })}`);
  }

  check(name, passed, evidence = {}) {
    this.report.checks.push({ name, passed, evidence });
    assert.ok(passed, `${name}: ${JSON.stringify(evidence)}`);
  }

  resources(expected, name, state = this.last) {
    this.check(name, same(ownedCounts(state), resourceCounts(expected)), {
      actual: ownedCounts(state), expected: resourceCounts(expected),
    });
  }

  async stage(name) {
    this.phase = name;
    this.report.phase = name;
    console.log(`Native Survival: ${name}`);
  }

  async lock() {
    let state = await this.poll("Active player", (s) => s.active && s.enabled);
    if (!state.locked) {
      // Ordinary browser recapture cooldown after a real inventory Escape.
      await delay(1200);
      state = await this.read();
      if (!state.locked) await this.input.click("#game canvas");
    }
    return this.poll("Pointer lock", (s) => s.locked && s.enabled && s.active);
  }

  async inventory(open) {
    await this.input.release();
    if ((await this.read()).overlayOpen !== open)
      await this.input.press(open ? "KeyE" : "Escape");
    await this.poll(open ? "Open inventory" : "Close inventory", (s) => s.overlayOpen === open);
    if (!open) await this.lock();
  }

  async look(yaw, pitch) {
    await this.input.release();
    await this.lock();
    let recenters = 0;
    const until = performance.now() + 16000;
    while (performance.now() < until) {
      const state = await this.read(true);
      const dyaw = angular(yaw, state.yaw), dpitch = pitch - state.pitch;
      if (Math.abs(dyaw) < 0.006 && Math.abs(dpitch) < 0.006) {
        await this.input.release();
        const settled = await this.read(true);
        if (Math.abs(angular(yaw, settled.yaw)) < 0.006 &&
          Math.abs(pitch - settled.pitch) < 0.006) return settled;
        continue;
      }
      // Large turns use the game's normal arrow-look keys. The final targeting
      // and the independent boat look check use trusted native mouse movement.
      const keys = [];
      if (Math.abs(dyaw) > 0.35) keys.push(dyaw > 0 ? "ArrowLeft" : "ArrowRight");
      if (Math.abs(dpitch) > 0.3) keys.push(dpitch > 0 ? "ArrowUp" : "ArrowDown");
      await this.input.setHeld(keys);
      if (keys.length) {
        await this.poll("Coarse native look frame", (s) => s.frame > state.frame, 5000, true);
        await this.input.setHeld([]);
        continue;
      }
      const { width, height } = this.input.config.viewport;
      const dx = -dyaw / 0.002, dy = -dpitch / 0.002;
      const cursor = this.input.cursor;
      if ((dx > 0 && cursor.x > width - 40) || (dx < 0 && cursor.x < 40) ||
        (dy > 0 && cursor.y > height - 40) || (dy < 0 && cursor.y < 40)) {
        if (++recenters > 3) throw new Error("Native aim exceeded bounded cursor recaptures");
        await this.inventory(true);
        await this.input.moveTo(width / 2, height / 2);
        await this.inventory(false);
        continue;
      }
      await this.input.steer(state, state.yaw + dyaw, pitch);
      await delay(25);
    }
    throw new Error(`Native look did not converge on yaw=${yaw}, pitch=${pitch}`);
  }

  async aim(point, cell = null) {
    const state = await this.read(true);
    const target = survivalAim(state, point);
    await this.look(target.yaw, target.pitch);
    if (!cell) return this.read(true);
    return this.poll(`Target natural cell ${cellKey(cell)}`, (s) =>
      s.target && cellKey(s.target) === cellKey(cell) && !s.mobTarget, 3000, true);
  }

  async tapRight() {
    await this.input.mouseDown("right");
    await this.input.mouseUp("right");
  }

  async mine(cell) {
    await this.stage(`mine-natural-log-${cellKey(cell)}`);
    const before = await this.aim(center(cell), cell);
    this.check("mining selects the natural matching log", before.target.id === cell.id, { cell });
    let maximumProgress = 0, after;
    try {
      await this.input.mouseDown("left");
      after = await this.poll(`Harvest ${cellKey(cell)}`, (s) => {
        maximumProgress = Math.max(maximumProgress, s.miningProgress);
        if (s.cells[cellKey(cell)] === BLOCK.AIR) return true;
        if (!s.target || cellKey(s.target) !== cellKey(cell) || s.mobTarget)
          throw new Error("Natural log target changed during held-mouse mining");
        return false;
      }, Math.max(12000, before.targetMiningSeconds * 4000), true);
    } finally {
      await this.input.mouseUp("left");
    }
    const simulatedSeconds = (
      after.clock.day + after.clock.time - before.clock.day - before.clock.time
    ) * before.clock.daySeconds;
    this.check("real timed mining removes one log", maximumProgress > 0 &&
      simulatedSeconds >= before.targetMiningSeconds - 0.12, {
      cell, maximumProgress, simulatedSeconds, requiredSeconds: before.targetMiningSeconds,
    });
    this.report.mining.push({ cell, simulatedSeconds, inventory: after.inventory, pickups: after.pickups });
    return after;
  }

  async walk(route, label) {
    await this.stage(label);
    await this.look(0, -0.25);
    const before = await this.read(true);
    const observations = [{ position: before.position, frame: before.frame }];
    for (const destination of compactRoute(route).slice(1)) {
      await this.walkPoint(destination);
      observations.push({ position: this.last.position, frame: this.last.frame });
    }
    this.report.walks.push({ label, planned: route, observed: observations });
    return this.read(true);
  }

  async walkPoint(destination) {
    const end = performance.now() + 35000;
    let best = Infinity, progressAt = performance.now(), jumpAt = -Infinity;
    try {
      while (performance.now() < end) {
        const state = await this.read(true);
        assert.equal(state.seated, false);
        const distance = horizontal(state.position, destination);
        // Account for both ordinary braking and a delivered input crossing a
        // frame boundary on a slow software-rendered browser.
        const dx = destination.x - state.position.x - state.velocity.x * 0.16;
        const dz = destination.z - state.position.z - state.velocity.z * 0.16;
        if (Math.hypot(dx, dz) < 0.14) {
          await this.input.setHeld([]);
          if (distance < 0.23 && Math.abs(state.position.y - destination.y) < 0.12 &&
            state.grounded && Math.hypot(state.velocity.x, state.velocity.z) < 0.08)
            return state;
          await delay(40);
          continue;
        }
        const forward = -Math.sin(state.yaw) * dx - Math.cos(state.yaw) * dz;
        const side = Math.cos(state.yaw) * dx - Math.sin(state.yaw) * dz;
        const keys = [];
        if (Math.abs(forward) > 0.085) keys.push(forward > 0 ? "KeyW" : "KeyS");
        if (Math.abs(side) > 0.085) keys.push(side > 0 ? "KeyD" : "KeyA");
        // Real crouch is a precise approach, not a speed/position override.
        // Never sneak across a down-step: ledge protection would block it.
        if (distance < 2.1 && state.grounded &&
          Math.abs(destination.y - state.position.y) < 0.12)
          keys.push("ShiftLeft");
        if (destination.y > state.position.y + 0.4 && state.grounded &&
          performance.now() - jumpAt > 800) {
          this.check("walking jump is at most one planned block", destination.y - state.position.y < 1.12, {
            from: state.position, destination,
          });
          await this.input.press("Space");
          jumpAt = performance.now();
        }
        await this.input.setHeld(keys);
        if (distance < best - 0.05) {
          best = distance;
          progressAt = performance.now();
        } else if (performance.now() - progressAt > 10000) {
          throw new Error(`Native walking blocked: ${JSON.stringify({ position: state.position, destination })}`);
        }
        await delay(40);
      }
      throw new Error(`Native walking exceeded waypoint budget: ${JSON.stringify(destination)}`);
    } finally {
      await this.input.release();
    }
  }

  async book() {
    if (!(await this.read()).recipeBookOpen)
      await this.input.click(".inventory-overlay .recipe-book-toggle");
  }

  async craft(recipeId, expected) {
    await this.stage(`craft-${recipeId}`);
    await this.book();
    const recipe = getRecipe(recipeId);
    const selector = `.inventory-overlay [data-recipe="${recipeId}"]`;
    await this.page.waitForFunction((value) => {
      const button = document.querySelector(value);
      return button && !button.disabled && !button.classList.contains("is-unavailable");
    }, selector);
    await this.input.click(selector);
    const filled = await this.poll("Real recipe fills the grid", (s) => !s.inventoryBusy &&
      s.craftingResult?.id === recipe.output.id && s.craftingResult.count === recipe.output.count);
    this.resources(expected, `${recipeId}: recipe preview consumes nothing`, filled);
    this.check("crafting begins without a carried stack", filled.cursor === null);
    const next = recipeResources(expected, recipeId);
    await this.input.down("ShiftLeft");
    try {
      await this.input.click('.inventory-overlay [data-area="result"][data-index="0"]');
    } finally {
      await this.input.up("ShiftLeft");
    }
    const crafted = await this.poll("One real recipe extraction consumes exactly its ingredients", (s) =>
      !s.inventoryBusy && s.cursor === null && s.craftingGrid.every((stack) => stack === null) &&
      same(ownedCounts(s), next));
    this.resources(next, `${recipeId}: exact finite recipe accounting`, crafted);
    this.report.crafting.push({ recipe: recipeId, before: expected, grid: filled.craftingGrid, after: next });
    return next;
  }

  async equip(id) {
    const before = await this.read();
    assert.equal(before.overlayOpen, true, "equipping uses the real open inventory");
    const source = before.slots.findIndex((stack) => stack?.id === id);
    this.check("equipping uses an existing owned item", source >= 0, { id, source });
    const slot = (index) => `.inventory-overlay [data-area="inventory"][data-index="${index}"]`;
    if (source !== before.selected) {
      await this.input.click(slot(source));
      await this.poll("Carry owned stack", (s) => !s.inventoryBusy && same(s.cursor, before.slots[source]));
      await this.input.click(slot(before.selected));
      const swapped = await this.poll("Equip owned hotbar stack", (s) =>
        !s.inventoryBusy && same(s.slots[before.selected], before.slots[source]));
      if (swapped.cursor) {
        await this.input.click(slot(source));
        await this.poll("Return displaced stack", (s) => !s.inventoryBusy && s.cursor === null);
      }
    }
    const after = await this.poll("Owned item selected", (s) => s.equipped === id && s.cursor === null);
    this.resources(ownedCounts(before), "equipping preserves every item", after);
    await this.input.moveTo(this.input.config.viewport.width / 2, this.input.config.viewport.height / 2);
    await this.inventory(false);
  }
}
