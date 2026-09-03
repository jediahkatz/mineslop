import { setTimeout as delay } from "node:timers/promises";
import { BLOCK } from "../../src/blocks.js";
import { getItem, ITEM, LOG_ITEMS, PLANK_ITEMS } from "../../src/items.js";
import { EYE_HEIGHT, PLAYER_HEIGHT, PLAYER_WIDTH } from "../../src/player.js";
import { getRecipe, RECIPES } from "../../src/recipes.js";
import { CHUNK_SIZE, WORLD_HEIGHT } from "../../src/terrain.js";
import { bounded } from "./input.mjs";
import { assertion } from "./scenarios.mjs";

export const survivalPlanningRules = {
  chunkSize: CHUNK_SIZE,
  worldHeight: WORLD_HEIGHT,
  eyeHeight: EYE_HEIGHT,
  playerHeight: PLAYER_HEIGHT,
  playerWidth: PLAYER_WIDTH,
  logIds: LOG_ITEMS,
  // Restrict the short collection corridor to ordinary, level natural ground.
  groundIds: [
    BLOCK.GRASS,
    BLOCK.DIRT,
    BLOCK.PODZOL,
    BLOCK.MYCELIUM,
    BLOCK.MOSS,
    BLOCK.SAND,
    BLOCK.CLAY,
    BLOCK.STONE,
    BLOCK.SNOW,
    BLOCK.SNOW_BLOCK,
  ],
  wearGroundIds: [
    BLOCK.GRASS,
    BLOCK.DIRT,
    BLOCK.PODZOL,
    BLOCK.MYCELIUM,
    BLOCK.STONE,
    BLOCK.SNOW,
    BLOCK.SNOW_BLOCK,
  ],
  tableId: BLOCK.CRAFTING_TABLE,
};

export function wearTargetDrop(id) {
  if (id === BLOCK.STONE) return BLOCK.COBBLESTONE;
  if ([BLOCK.GRASS, BLOCK.DIRT, BLOCK.PODZOL, BLOCK.MYCELIUM].includes(id))
    return BLOCK.DIRT;
  if (id === BLOCK.SNOW || id === BLOCK.SNOW_BLOCK) return id;
  throw new RangeError("Unsupported natural wear-test ground");
}

/**
 * Read-only, bounded planning. Explicit world/origin arguments make this usable
 * with a real generated World in Node tests. The same self-contained function
 * is serialized by Playwright; it imports nothing and writes no browser state.
 */
export function planNaturalTree({ rules, world, origin }) {
  world ??= window.__voxelBot.game.world;
  origin ??= window.__voxelBot.game.player.position;
  const { chunkSize, worldHeight, eyeHeight, playerHeight, playerWidth } =
    rules;
  const logs = new Set(rules.logIds);
  const grounds = new Set(rules.groundIds);
  const wearGrounds = new Set(rules.wearGroundIds);
  const key = ({ x, y, z }) => `${x},${y},${z}`;
  const bases = [];
  for (const chunk of world.chunks.values()) {
    for (let z = 0; z < chunkSize; z++) {
      for (let x = 0; x < chunkSize; x++) {
        for (let y = 1; y < worldHeight - 4; y++) {
          const id = chunk.blocks[y * chunkSize ** 2 + z * chunkSize + x];
          if (!logs.has(id)) continue;
          const wx = chunk.cx * chunkSize + x;
          const wz = chunk.cz * chunkSize + z;
          if (
            !grounds.has(world.get(wx, y - 1, wz)) ||
            world.get(wx, y + 1, wz) !== id ||
            world.get(wx, y + 2, wz) !== id
          )
            continue;
          bases.push({ x: wx, y, z: wz, id });
        }
      }
    }
  }
  bases.sort(
    (a, b) =>
      Math.hypot(a.x + 0.5 - origin.x, a.z + 0.5 - origin.z) -
      Math.hypot(b.x + 0.5 - origin.x, b.z + 0.5 - origin.z)
  );
  // All callers start a fresh world. Never disguise existing player edits as a tree.
  if (world.edits.size)
    throw new Error("Natural-tree setup requires an unedited generated world");
  let inspected = 0;
  for (const base of bases.slice(0, 96)) {
    inspected++;
    const trunk = [2, 1, 0].map((dy) => ({ ...base, y: base.y + dy }));
    const removed = new Set(trunk.map(key));
    const read = (x, y, z, afterMining = false, table = false) => {
      if (!world.isLoaded(x, z)) return -1;
      if (table && x === base.x && y === base.y && z === base.z)
        return rules.tableId;
      if (afterMining && removed.has(`${x},${y},${z}`)) return 0;
      return world.get(x, y, z);
    };
    const clear = (p, afterMining) => {
      const half = playerWidth / 2;
      for (let x = Math.floor(p.x - half); x <= Math.floor(p.x + half); x++) {
        for (let z = Math.floor(p.z - half); z <= Math.floor(p.z + half); z++) {
          if (
            !world.isLoaded(x, z) ||
            !grounds.has(world.get(x, base.y - 1, z))
          )
            return false;
          for (let y = Math.floor(p.y); y < p.y + playerHeight; y++) {
            const id = read(x, y, z, afterMining);
            if (id === -1 || (id !== 0 && world.isSolid(x, y, z))) return false;
          }
        }
      }
      return true;
    };
    // Cardinal sight lines to voxel centers cannot graze an unseen voxel corner.
    const visible = (eye, point, cell, afterMining = false, table = false) => {
      const length = Math.hypot(
        point.x - eye.x,
        point.y - eye.y,
        point.z - eye.z
      );
      if (length > 4.8) return false;
      const steps = Math.ceil(length / 0.025);
      for (let step = 0; step <= steps; step++) {
        const t = step / steps;
        const x = Math.floor(eye.x + (point.x - eye.x) * t);
        const y = Math.floor(eye.y + (point.y - eye.y) * t);
        const z = Math.floor(eye.z + (point.z - eye.z) * t);
        if (read(x, y, z, afterMining, table) !== 0)
          return x === cell.x && y === cell.y && z === cell.z;
      }
      return false;
    };
    for (const distance of [2, 3]) {
      for (const [dx, dz] of [
        [0, 1],
        [1, 0],
        [0, -1],
        [-1, 0],
      ]) {
        const approach = {
          x: base.x + 0.5 + dx * distance,
          y: base.y + 0.01,
          z: base.z + 0.5 + dz * distance,
        };
        if (!clear(approach, false)) continue;
        const pickup = { x: base.x + 0.5, y: approach.y, z: base.z + 0.5 };
        let corridorClear = true;
        for (let step = 1; step <= distance * 4; step++) {
          if (
            !clear(
              {
                x: approach.x - (dx * step) / 4,
                y: approach.y,
                z: approach.z - (dz * step) / 4,
              },
              true
            )
          ) {
            corridorClear = false;
            break;
          }
        }
        if (!corridorClear) continue;
        const eye = { ...approach, y: approach.y + eyeHeight };
        if (
          !trunk.every((cell) =>
            visible(
              eye,
              { x: cell.x + 0.5, y: cell.y + 0.5, z: cell.z + 0.5 },
              cell
            )
          )
        )
          continue;
        const ground = {
          x: base.x,
          y: base.y - 1,
          z: base.z,
          id: world.get(base.x, base.y - 1, base.z),
        };
        const groundAim = {
          x: base.x + 0.5,
          y: base.y - 0.02,
          z: base.z + 0.5,
        };
        if (!visible(eye, groundAim, ground, true)) continue;
        // One extra natural ground block proves NON-PRISTINE tool wear survives reload.
        // It is beside the table, never its support or the player's footing.
        const wearTarget = [-1, 1]
          .map((side) => {
            const x = base.x + dz * side,
              z = base.z - dx * side;
            return { x, y: base.y - 1, z, id: world.get(x, base.y - 1, z) };
          })
          .find(
            (cell) =>
              wearGrounds.has(cell.id) &&
              visible(
                eye,
                { x: cell.x + 0.5, y: cell.y + 0.98, z: cell.z + 0.5 },
                cell,
                true,
                true
              )
          );
        if (!wearTarget) continue;
        return {
          trunk,
          approach,
          pickup,
          ground,
          groundAim,
          wearTarget,
          workPosition: {
            x: base.x + 0.5 + dx * 2,
            y: approach.y,
            z: base.z + 0.5 + dz * 2,
          },
          table: { x: base.x, y: base.y, z: base.z, id: rules.tableId },
          yaw: Math.atan2(dx, dz),
          pitch: Math.atan2(trunk[0].y + 0.5 - eye.y, distance),
          approachDistance: distance,
          loadedChunksInspected: world.chunks.size,
          treeCandidates: bases.length,
          candidatesInspected: inspected,
        };
      }
    }
  }
  throw new Error(
    `No accessible three-log trunk with a level 2–3-block approach in ` +
      `${world.chunks.size} loaded chunks (${bases.length} trunks; ${inspected} inspected). ` +
      "No exploration, terrain edits, or inventory substitution was attempted."
  );
}

export function resourceCounts(entries) {
  const counts = new Map();
  for (const { id, count } of entries)
    counts.set(id, (counts.get(id) ?? 0) + count);
  return [...counts]
    .filter(([, count]) => count !== 0)
    .sort(([a], [b]) => a - b)
    .map(([id, count]) => ({ id, count }));
}

/** One real family recipe per collected log; never combine logs into oak. */
export function planNaturalPlankRecipes(entries) {
  const logs = resourceCounts(entries).filter(({ id }) =>
    LOG_ITEMS.includes(id)
  );
  if (
    logs.some(({ count }) => !Number.isSafeInteger(count) || count < 1) ||
    logs.reduce((total, { count }) => total + count, 0) !== 3
  )
    throw new Error("Natural Survival requires exactly three collected logs");
  return logs.flatMap(({ id, count }) => {
    const recipes = RECIPES.filter(
      (recipe) =>
        recipe.station === "hand" &&
        recipe.duration === 0 &&
        recipe.ingredients.length === 1 &&
        recipe.ingredients[0].id === id &&
        recipe.ingredients[0].count === 1 &&
        !recipe.ingredients[0].alternatives?.length &&
        PLANK_ITEMS.includes(recipe.output.id) &&
        recipe.output.count === 4
    );
    if (recipes.length !== 1)
      throw new Error(
        `Expected one family-specific plank recipe for log ${id}`
      );
    return Array(count).fill(recipes[0].id);
  });
}

/** Expected accounting only; never passed to Gameplay or written to a save. */
export function recipeResources(entries, recipeId) {
  const recipe = getRecipe(recipeId);
  if (!recipe || recipe.duration)
    throw new Error(`Unsupported immediate recipe: ${recipeId}`);
  const counts = new Map(
    resourceCounts(entries).map(({ id, count }) => [id, count])
  );
  for (const ingredient of recipe.ingredients) {
    let remaining = ingredient.count;
    for (const id of [ingredient.id, ...(ingredient.alternatives ?? [])]) {
      const used = Math.min(remaining, counts.get(id) ?? 0);
      counts.set(id, (counts.get(id) ?? 0) - used);
      remaining -= used;
    }
    if (remaining) throw new Error(`Resource ledger cannot afford ${recipeId}`);
  }
  const { id, count } = recipe.output;
  counts.set(id, (counts.get(id) ?? 0) + count);
  return resourceCounts([...counts].map(([id, count]) => ({ id, count })));
}

export function survivalAim(state, point) {
  const dx = point.x - state.eye.x;
  const dy = point.y - state.eye.y;
  const dz = point.z - state.eye.z;
  const desired = Math.atan2(-dx, -dz);
  const difference = Math.atan2(
    Math.sin(desired - state.yaw),
    Math.cos(desired - state.yaw)
  );
  return {
    yaw: state.yaw + difference,
    pitch: Math.atan2(dy, Math.hypot(dx, dz)),
  };
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const cellKey = ({ x, y, z }) => `${x},${y},${z}`;
const hits = (target, cell) => target && cellKey(target) === cellKey(cell);
const center = ({ x, y, z }) => ({ x: x + 0.5, y: y + 0.5, z: z + 0.5 });
const horizontal = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

function observeSurvival(cells) {
  const bot = window.__voxelBot;
  if (!bot?.game)
    throw new Error("The dedicated test host must expose __voxelBot.game");
  const game = bot.game;
  const saved = game.gameplay.serialize();
  const eye = game.player.eyePosition;
  return {
    ...bot.state(),
    eye: { x: eye.x, y: eye.y, z: eye.z },
    inventory: saved.inventory,
    durability: saved.durability,
    hotbar: saved.hotbar,
    selected: saved.selected,
    equipped: saved.hotbar[saved.selected],
    slots: saved.slots,
    cursor: saved.cursor,
    craftingGrid: saved.craftingGrid,
    craftingSize: saved.craftingSize,
    craftingResult: game.gameplay.getState().craftingResult,
    inventoryScreen: document.querySelector(".inventory-panel")?.dataset.screen,
    inventoryBusy:
      document
        .querySelector(".inventory-overlay")
        ?.getAttribute("aria-busy") === "true",
    recipeBookOpen:
      document
        .querySelector(".recipe-book-toggle")
        ?.getAttribute("aria-expanded") === "true",
    station: game.station(),
    pickups: game.pickups.serialize().items,
    overflow: game.overflow.serialize().entries,
    cells: Object.fromEntries(
      cells.map((cell) => [
        `${cell.x},${cell.y},${cell.z}`,
        game.world.get(cell.x, cell.y, cell.z),
      ])
    ),
    edits: game.world.edits.size,
    mobTarget: game.mobTarget?.name ?? null,
    targetMiningSeconds: game.target
      ? game.gameplay.miningDuration(game.target.id)
      : null,
    storageStatus: game.storageStatus,
    storageSaved: game.storageStatus === "Saved on this device",
    storageRevision: game.storage.revision,
    toast: document.querySelector(".toast > span")?.textContent ?? "",
  };
}

/**
 * Natural, finite Survival integration flow. Call after terrain/menu metrics have
 * been snapshotted and BEFORE the synthetic controls fixture. Nothing here is
 * traversal-performance or manual-demo evidence. Setup alone may initialize a
 * fresh world and place the player once; all subsequent actions use RealInputs.
 */
export async function runNaturalSurvival(input, report) {
  const result = (report.survival = {
    label: "integration setup at naturally generated tree",
    status: "running",
    methodology: {
      terrain:
        "Actual generated World; no inventory injection or direct block writes",
      setup:
        "Fresh Survival initializer and one explicitly unmeasured fixture teleport",
      actions:
        "Trusted RealInputs keyboard/mouse and actual inventory/crafting DOM",
      clock:
        "Normal 1200-second day; initializer daylight, no measured clock writes",
      evidenceScope:
        "Resource-flow integration only; not traversal performance or a manual demo",
    },
    assertions: [],
    errors: [],
    mining: [],
    crafting: [],
  });
  report.assertions ??= [];
  report.errors ??= [];
  const started = performance.now();
  let deadline = started + 90000;
  let phase = "setup";
  let tracked = [];
  let last;
  let measuring = false;
  let measuredStart;
  const assert = (name, passed, evidence = {}) => {
    assertion(report, `Natural Survival: ${name}`, passed, evidence);
    result.assertions.push(report.assertions.at(-1));
    if (!passed) throw new Error(`${name}: ${JSON.stringify(evidence)}`);
  };
  const action = (description, run, timeout = 4000) => {
    const remaining = Math.min(timeout, deadline - performance.now());
    if (remaining <= 0)
      throw new Error(
        `Natural Survival deadline reached during ${description}`
      );
    return bounded(run(), remaining, description);
  };
  const read = async (active = false) => {
    last = await action(
      "Read Survival state",
      () => input.page.evaluate(observeSurvival, tracked),
      3000
    );
    if (last.error || last.failed || last.dead || last.hidden)
      throw new Error(
        `Survival stopped: ${
          last.error ??
          (last.dead
            ? "player died"
            : last.hidden
              ? "page hidden"
              : "game failed")
        }`
      );
    if (
      active &&
      (!last.active ||
        !last.enabled ||
        !last.locked ||
        last.flying ||
        last.mode !== "survival" ||
        !last.world.loaded)
    )
      throw new Error(
        `Native Survival controls lost: ${JSON.stringify({
          active: last.active,
          locked: last.locked,
          enabled: last.enabled,
          flying: last.flying,
          mode: last.mode,
          loaded: last.world.loaded,
        })}`
      );
    return last;
  };
  const poll = async (
    description,
    predicate,
    timeout = 3000,
    active = false
  ) => {
    const end = Math.min(deadline, performance.now() + timeout);
    do {
      const state = await read(active);
      if (predicate(state)) return state;
      await delay(35);
    } while (performance.now() < end);
    throw new Error(
      `${description} timed out: ${JSON.stringify({
        position: last?.position,
        target: last?.target,
        mobTarget: last?.mobTarget,
        inventory: last?.inventory,
        cells: last?.cells,
        storageStatus: last?.storageStatus,
      })}`
    );
  };
  const press = (key) => action(`Native ${key}`, () => input.press(key));
  const click = (selector) =>
    action(`Native click ${selector}`, () => input.click(selector));
  const release = () =>
    action("Release native controls", () => input.release());
  const lock = async () => {
    let state = await poll("Active player", (s) => s.active && s.enabled);
    if (!state.locked) {
      // Browsers briefly reject capture immediately after inventory releases it.
      await delay(1200);
      state = await read();
      if (!state.locked) await click("#game canvas");
    }
    return poll(
      "Native pointer lock",
      (s) => s.active && s.enabled && s.locked,
      2500
    );
  };
  const inventory = async (open) => {
    await release();
    const state = await read();
    // Recipe search may own text focus: E must remain text there, while Escape
    // is the real game's unconditional inventory-close control.
    if (state.overlayOpen !== open) await press(open ? "KeyE" : "Escape");
    await poll(
      open ? "E opens inventory" : "Escape closes inventory",
      (s) => s.overlayOpen === open
    );
    if (!open) await lock();
  };
  const recenter = async (look, state) => {
    await inventory(true);
    await action("Recenter unlocked native cursor", () =>
      input.moveTo(
        input.config.viewport.width * (state.yaw > look.yaw ? 0.2 : 0.8),
        input.config.viewport.height * (state.pitch > look.pitch ? 0.15 : 0.85)
      )
    );
    await inventory(false);
  };
  const aim = async (cell, point = center(cell)) => {
    await release();
    const end = Math.min(deadline, performance.now() + 7000);
    let recenters = 0;
    let blocked = 0;
    let checkedFrame = -1;
    while (performance.now() < end) {
      const state = await read(true);
      const look = survivalAim(state, point);
      const yawError = Math.abs(state.yaw - look.yaw);
      const pitchError = Math.abs(state.pitch - look.pitch);
      if (yawError < 0.018 && pitchError < 0.018) {
        if (hits(state.target, cell) && !state.mobTarget) return state;
        if (state.frame !== checkedFrame) {
          checkedFrame = state.frame;
          if (++blocked >= 4)
            throw new Error(
              `Aim is blocked: expected ${cellKey(cell)}, ` +
                `observed ${JSON.stringify(state.target)}, mob ${state.mobTarget}`
            );
        }
      } else blocked = 0;
      const dx = (state.yaw - look.yaw) / 0.002;
      const dy = (state.pitch - look.pitch) / 0.002;
      const { width, height } = input.config.viewport;
      if (
        (dx > 1 && input.cursor.x >= width - 30) ||
        (dx < -1 && input.cursor.x <= 30) ||
        (dy > 1 && input.cursor.y >= height - 30) ||
        (dy < -1 && input.cursor.y <= 30)
      ) {
        if (++recenters > 2)
          throw new Error(
            "Native mouse cannot reach the planned voxel before cursor bounds"
          );
        await recenter(look, state);
        continue;
      }
      await action("Steer native mouse to voxel center", () =>
        input.steer(state, look.yaw, look.pitch)
      );
      await delay(25);
    }
    throw new Error(
      `Native aim timed out at ${cellKey(cell)}; last target ${JSON.stringify(last?.target)}`
    );
  };
  const mine = async (cell, point) => {
    const before = await aim(cell, point);
    assert(
      "mining targets the planned natural voxel",
      before.target.id === cell.id,
      { expected: cell, actual: before.target }
    );
    const expected = before.targetMiningSeconds;
    const start = performance.now();
    let maximumProgress = 0;
    let after;
    try {
      await action("Hold native left mouse", () => input.mouseDown("left"));
      after = await poll(
        `Mine ${cellKey(cell)}`,
        (s) => {
          maximumProgress = Math.max(maximumProgress, s.miningProgress);
          if (s.cells[cellKey(cell)] === BLOCK.AIR) return true;
          if (!hits(s.target, cell) || s.mobTarget)
            throw new Error(
              `Mining target changed before removal: ${JSON.stringify(s.target)}, mob ${s.mobTarget}`
            );
          return false;
        },
        Math.min(8500, Math.max(4000, expected * 1800 + 1000)),
        true
      );
    } finally {
      await action("Release native left mouse", () => input.mouseUp("left"));
    }
    const evidence = {
      cell,
      expectedSimulationSeconds: expected,
      observedSimulationSeconds:
        ((after.timeOfDay - before.timeOfDay + 1) % 1) * 1200,
      wallMs: performance.now() - start,
      maximumProgress,
      afterId: after.cells[cellKey(cell)],
    };
    result.mining.push(evidence);
    assert(
      "held mouse completes timed mining",
      expected > 0 &&
        Number.isFinite(expected) &&
        evidence.observedSimulationSeconds >= expected - 0.11 &&
        maximumProgress > 0,
      evidence
    );
    return after;
  };
  const walk = async (destination, plan, collected = false) => {
    const end = Math.min(deadline, performance.now() + 5000);
    const before = await read(true);
    let best = horizontal(before.position, destination);
    let progressAt = performance.now();
    try {
      while (performance.now() < end) {
        const state = await read(true);
        const d = horizontal(state.position, destination);
        if (
          collected &&
          LOG_ITEMS.reduce(
            (n, id) =>
              n +
              (state.inventory.find((entry) => entry.id === id)?.count ?? 0),
            0
          ) === 3
        )
          return state;
        const dx = destination.x - state.position.x - state.velocity.x / 18;
        const dz = destination.z - state.position.z - state.velocity.z / 18;
        if (Math.hypot(dx, dz) < 0.14) return state;
        const forward = -Math.sin(plan.yaw) * dx - Math.cos(plan.yaw) * dz;
        const side = Math.cos(plan.yaw) * dx - Math.sin(plan.yaw) * dz;
        if (Math.abs(state.yaw - plan.yaw) > 0.035 || Math.abs(side) > 0.35)
          throw new Error(
            "Collection left the prevalidated straight corridor; no random exploration attempted"
          );
        await action("Walk the natural pickup corridor", () =>
          input.setHeld([
            forward > 0 ? "KeyW" : "KeyS",
            ...(Math.abs(side) > 0.09 ? [side > 0 ? "KeyD" : "KeyA"] : []),
          ])
        );
        if (d < best - 0.05) {
          best = d;
          progressAt = performance.now();
        } else if (performance.now() - progressAt > 1300) {
          throw new Error(
            `Walking is blocked at ${JSON.stringify(state.position)}`
          );
        }
        await delay(35);
      }
      throw new Error("Natural pickup corridor traversal exceeded 5000 ms");
    } finally {
      await release();
    }
  };
  const balances = (state, expected, name) => {
    assert(
      name,
      same(resourceCounts(state.inventory), resourceCounts(expected)),
      {
        actual: resourceCounts(state.inventory),
        expected: resourceCounts(expected),
      }
    );
  };
  const openBook = async () => {
    if (!(await read()).recipeBookOpen)
      await click(".inventory-overlay .recipe-book-toggle");
  };
  const craft = async (recipeId, expected) => {
    phase = `craft-${recipeId}`;
    await openBook();
    const recipe = getRecipe(recipeId);
    const selector = `[data-recipe="${recipeId}"]`;
    await action(
      `Enabled ${recipeId} recipe`,
      () =>
        input.page.waitForFunction(
          (value) => {
            const button = document.querySelector(value);
            return (
              button &&
              !button.disabled &&
              !button.classList.contains("is-unavailable") &&
              button.getClientRects().length > 0
            );
          },
          selector,
          { timeout: 2500 }
        ),
      3000
    );
    const next = recipeResources(expected, recipeId);
    await click(selector);
    const filled = await poll(
      `${recipeId} fills the real grid with an unowned result preview`,
      (s) =>
        !s.inventoryBusy &&
        s.craftingResult?.id === recipe.output.id &&
        s.craftingResult.count === recipe.output.count
    );
    balances(
      {
        inventory: [
          ...filled.inventory,
          ...filled.craftingGrid.filter(Boolean),
        ],
      },
      expected,
      `${recipeId} moves ingredients into crafting escrow without consuming them`
    );
    assert(
      `${recipeId} has no carried stack before extraction`,
      filled.cursor === null
    );
    await action("Hold Shift for quick crafting-result transfer", () =>
      input.down("ShiftLeft")
    );
    try {
      await click('.inventory-overlay [data-area="result"][data-index="0"]');
    } finally {
      await action("Release crafting Shift", () => input.up("ShiftLeft"));
    }
    const state = await poll(
      `Taking the ${recipeId} result updates finite owned inventory`,
      (s) =>
        !s.inventoryBusy &&
        s.cursor === null &&
        s.craftingGrid.every((stack) => stack === null) &&
        same(resourceCounts(s.inventory), next)
    );
    balances(
      state,
      next,
      `${recipeId} conserves its real ingredient quantities`
    );
    result.crafting.push({
      recipe: recipeId,
      before: expected,
      grid: filled.craftingGrid,
      preview: filled.craftingResult,
      after: state.inventory,
    });
    return next;
  };
  const equip = async (id) => {
    const before = await read();
    const source = before.slots.findIndex((stack) => stack?.id === id);
    assert("equip uses a real owned slot", source >= 0, { id, source });
    const stack = before.slots[source];
    const slot = (index) =>
      `.inventory-overlay [data-area="inventory"][data-index="${index}"]`;
    if (source !== before.selected) {
      await click(slot(source));
      await poll(
        "Pick up the owned stack",
        (s) =>
          !s.inventoryBusy && same(s.cursor, stack) && s.slots[source] === null
      );
      await click(slot(before.selected));
      const swapped = await poll(
        "Put the stack in the selected hotbar slot",
        (s) =>
          !s.inventoryBusy &&
          same(s.slots[before.selected], stack) &&
          same(s.cursor, before.slots[before.selected])
      );
      if (swapped.cursor) {
        await click(slot(source));
        await poll(
          "Return the displaced stack to its free slot",
          (s) => !s.inventoryBusy && s.cursor === null
        );
      }
    }
    const after = await poll(
      "Selected hotbar equips the owned item",
      (s) => s.equipped === id && s.cursor === null
    );
    balances(after, before.inventory, "Owned-slot equip consumes no resources");
    assert(
      "equipped item is finite and owned",
      after.inventory.some((entry) => entry.id === id && entry.count === 1),
      { id, selected: after.selected, hotbar: after.hotbar }
    );
    await action("Recenter mouse before closing inventory", () =>
      input.moveTo(
        input.config.viewport.width / 2,
        input.config.viewport.height * 0.15
      )
    );
    await inventory(false);
  };
  try {
    input.page.setDefaultTimeout(3500);
    await release();
    await action("End previous metrics before fixture setup", () =>
      input.page.evaluate(() =>
        window.__voxelBot.metrics.results({ stop: true })
      )
    );
    assert(
      "verified native mouse is available",
      input.lookMode === "native-mouse",
      { lookMode: input.lookMode }
    );
    await action(
      "Initialize fresh natural Survival world",
      () =>
        input.page.evaluate(async (seed) => {
          const game = window.__voxelBot?.game;
          if (!game)
            throw new Error(
              "Parent must expose __voxelBot.game only in the dedicated test host"
            );
          await game.initialize(seed, null, { mode: "survival" });
        }, input.config.seed),
      25000
    );
    const initial = await read();
    assert(
      "fresh initializer supplies finite Survival, empty edits, and daylight",
      initial.mode === "survival" &&
        !initial.flying &&
        !initial.allowFlight &&
        initial.edits === 0 &&
        initial.timeOfDay >= 0.25 &&
        initial.timeOfDay <= 0.5 &&
        same(resourceCounts(initial.inventory), [{ id: ITEM.APPLE, count: 4 }]),
      {
        mode: initial.mode,
        timeOfDay: initial.timeOfDay,
        inventory: initial.inventory,
        edits: initial.edits,
      }
    );
    const plan = await action(
      "Find a naturally generated accessible trunk",
      () =>
        input.page.evaluate(planNaturalTree, { rules: survivalPlanningRules }),
      6000
    );
    tracked = [...plan.trunk, plan.ground, plan.wearTarget];
    result.plan = plan;
    await click(".play-button");
    await lock();
    await action("Position physical cursor during unmeasured setup", () =>
      input.moveTo(
        input.config.viewport.width / 2,
        input.config.viewport.height * 0.15
      )
    );
    result.fixtureTeleport = await action(
      "One unmeasured pose at natural tree",
      () =>
        input.page.evaluate((fixture) => {
          const game = window.__voxelBot.game;
          const from = {
            x: game.player.position.x,
            y: game.player.position.y,
            z: game.player.position.z,
          };
          const inventoryBefore = JSON.stringify(
            game.gameplay.serialize().inventory
          );
          const editsBefore = game.world.edits.size;
          game.player.setPosition(fixture.approach);
          game.player.yaw = fixture.yaw;
          game.player.pitch = fixture.pitch;
          game.player.update(0.001);
          return {
            label: "integration setup at naturally generated tree",
            count: 1,
            from,
            to: fixture.approach,
            includedInTraversalPerformance: false,
            includedInDemoClaims: false,
            inventoryUntouched:
              inventoryBefore ===
              JSON.stringify(game.gameplay.serialize().inventory),
            terrainUntouched: editsBefore === 0 && game.world.edits.size === 0,
          };
        }, plan)
    );
    const placed = await poll(
      "Natural approach settles on real ground",
      (s) => s.grounded && !s.colliding,
      3000,
      true
    );
    assert(
      "fixture teleport leaves terrain and inventory untouched",
      result.fixtureTeleport.inventoryUntouched &&
        result.fixtureTeleport.terrainUntouched &&
        placed.edits === 0,
      result.fixtureTeleport
    );
    result.setupElapsedMs = performance.now() - started;
    measuredStart = performance.now();
    deadline = Math.min(deadline, measuredStart + 60000);
    await action("Start separate resource-flow metrics", () =>
      input.page.evaluate(() =>
        window.__voxelBot.metrics.reset(
          "natural-survival-resource-flow; tree setup excluded"
        )
      )
    );
    measuring = true;
    phase = "harvest-three-logs";
    for (const cell of plan.trunk) await mine(cell);
    phase = "collect-real-pickups";
    const collectionStart = await read(true);
    await walk(plan.pickup, plan, true);
    let expected = resourceCounts([
      ...initial.inventory,
      ...plan.trunk.map(({ id }) => ({ id, count: 1 })),
    ]);
    const collected = await poll(
      "Own exactly three real harvested logs",
      (s) => same(resourceCounts(s.inventory), expected),
      3000,
      true
    );
    balances(
      collected,
      expected,
      "three removed natural logs become three owned logs"
    );
    assert(
      "pickups are reached by real walking",
      horizontal(collectionStart.position, collected.position) > 0.1,
      { from: collectionStart.position, to: collected.position }
    );
    result.collected = {
      inventory: collected.inventory,
      remainingPickups: collected.pickups,
    };
    await walk(plan.workPosition, plan);
    await poll(
      "Released walking settles",
      (s) =>
        s.grounded &&
        Math.hypot(s.velocity.x, s.velocity.y, s.velocity.z) < 0.035,
      2000,
      true
    );
    await inventory(true);
    for (const recipe of [
      ...planNaturalPlankRecipes(expected),
      "sticks",
      "crafting_table",
    ])
      expected = await craft(recipe, expected);
    phase = "place-owned-table";
    await equip(BLOCK.CRAFTING_TABLE);
    const atGround = await aim(plan.ground, plan.groundAim);
    assert(
      "table placement targets the real ground top about two blocks away",
      atGround.target.normal.y === 1 &&
        horizontal(atGround.position, center(plan.table)) >= 1.75 &&
        horizontal(atGround.position, center(plan.table)) <= 2.3,
      {
        target: atGround.target,
        position: atGround.position,
        table: plan.table,
      }
    );
    await action("Native right mouse places owned table", () =>
      input.mouseDown("right")
    );
    await action("Release native right mouse", () => input.mouseUp("right"));
    const table = await poll(
      "Table appears in the planned world cell",
      (s) => s.cells[cellKey(plan.table)] === BLOCK.CRAFTING_TABLE,
      2500,
      true
    );
    expected = resourceCounts([
      ...expected,
      { id: BLOCK.CRAFTING_TABLE, count: -1 },
    ]);
    balances(
      table,
      expected,
      "placing the table consumes exactly one owned table"
    );
    assert(
      "table stands on unchanged natural ground",
      table.cells[cellKey(plan.ground)] === plan.ground.id,
      { table: plan.table, ground: plan.ground }
    );
    result.table = {
      ...plan.table,
      support: plan.ground,
      distance: horizontal(table.position, center(plan.table)),
    };
    await inventory(true);
    const personal = await read();
    assert(
      "E remains a personal 2x2 grid beside the placed table",
      personal.craftingSize === 2 &&
        personal.inventoryScreen === "inventory" &&
        !personal.station.includes("table"),
      {
        size: personal.craftingSize,
        screen: personal.inventoryScreen,
        station: personal.station,
      }
    );
    await openBook();
    assert(
      "the personal recipe book cannot fill a 3x3 wooden pickaxe",
      await action("Read personal workbench recipe requirement", () =>
        input.page.locator('[data-recipe="wood_pickaxe"]').isDisabled()
      )
    );
    await inventory(false);
    await aim(plan.table);
    await action("Right-click the real placed crafting table", () =>
      input.mouseDown("right")
    );
    await action("Release table interaction", () => input.mouseUp("right"));
    const workbench = await poll(
      "The placed table opens the actual 3x3 crafting screen",
      (s) =>
        s.overlayOpen &&
        s.craftingSize === 3 &&
        s.inventoryScreen === "crafting"
    );
    assert(
      "3x3 crafting requires the opened real table, not proximity",
      workbench.station.includes("table") &&
        workbench.cells[cellKey(plan.table)] === BLOCK.CRAFTING_TABLE,
      {
        station: workbench.station,
        size: workbench.craftingSize,
        table: plan.table,
      }
    );
    expected = await craft("wood_pickaxe", expected);
    await equip(ITEM.WOOD_PICKAXE);
    phase = "exercise-real-tool-wear";
    const beforeWear = await read(true);
    const afterWear = await mine(plan.wearTarget, {
      x: plan.wearTarget.x + 0.5,
      y: plan.wearTarget.y + 0.98,
      z: plan.wearTarget.z + 0.5,
    });
    const maximum = getItem(ITEM.WOOD_PICKAXE).durability;
    result.toolWear = {
      id: ITEM.WOOD_PICKAXE,
      before: beforeWear.durability[ITEM.WOOD_PICKAXE],
      after: afterWear.durability[ITEM.WOOD_PICKAXE],
      naturalBlockMined: plan.wearTarget,
    };
    assert(
      "owned wooden pickaxe takes one real use of wear",
      same(result.toolWear.before, [maximum]) &&
        same(result.toolWear.after, [maximum - 1]),
      result.toolWear
    );
    const dropId = wearTargetDrop(plan.wearTarget.id);
    const allResources = resourceCounts([
      ...afterWear.inventory,
      ...afterWear.pickups,
      ...afterWear.overflow,
    ]);
    const allExpected = resourceCounts([...expected, { id: dropId, count: 1 }]);
    assert(
      "final inventory plus real loose drops conserves all mined/crafted resources",
      same(allResources, allExpected),
      { actual: allResources, expected: allExpected }
    );
    result.resources = {
      inventory: afterWear.inventory,
      pickups: afterWear.pickups,
      overflow: afterWear.overflow,
      expectedCombined: allExpected,
    };
    phase = "save-while-active";
    const beforeSave = await read(true);
    await press("KeyP");
    const saved = await poll(
      "P finishes a new real storage transaction while active",
      (s) =>
        s.storageSaved &&
        s.storageRevision !== beforeSave.storageRevision &&
        s.toast === "World saved on this device",
      5000,
      true
    );
    result.beforeReload = {
      seed: saved.seed,
      mode: saved.mode,
      dimension: saved.dimension,
      inventory: resourceCounts(saved.inventory),
      slots: saved.slots,
      durability: saved.durability,
      hotbar: saved.hotbar,
      selected: saved.selected,
      cells: saved.cells,
      storageSaved: saved.storageSaved,
      storageRevision: saved.storageRevision,
    };
    assert(
      "P saves while gameplay is active",
      saved.active && saved.enabled && saved.storageSaved,
      {
        active: saved.active,
        storageStatus: saved.storageStatus,
        revision: saved.storageRevision,
      }
    );
    result.metrics = await action(
      "Snapshot resource-flow metrics BEFORE reload",
      () =>
        input.page.evaluate(() =>
          window.__voxelBot.metrics.results({ stop: true })
        )
    );
    measuring = false;
    result.actionElapsedMs = performance.now() - measuredStart;
    assert(
      "resource flow uses trusted inputs and the ordinary advancing day clock",
      result.metrics.inputs.trusted > 0 &&
        result.metrics.inputs.untrusted === 0 &&
        result.metrics.clock.configuredDaySeconds === 1200 &&
        result.metrics.clock.discontinuities === 0 &&
        result.metrics.clock.simulatedSeconds > 0 &&
        result.metrics.clock.simulationRate <= 1.05,
      { inputs: result.metrics.inputs, clock: result.metrics.clock }
    );
    phase = "reload-real-archive";
    // Reload has its own bounded initialization budget, not resource-control timing.
    deadline = Math.min(started + 90000, performance.now() + 25000);
    await action(
      "Reload the real test host",
      () => input.page.reload({ waitUntil: "load", timeout: 20000 }),
      21000
    );
    await action(
      "Wait for real game/archive initialization",
      () =>
        input.page.waitForFunction(
          () => window.__voxelBot?.ready || window.__voxelBot?.error,
          undefined,
          { timeout: 20000 }
        ),
      21000
    );
    const restored = await read();
    result.afterReload = {
      seed: restored.seed,
      mode: restored.mode,
      dimension: restored.dimension,
      inventory: resourceCounts(restored.inventory),
      slots: restored.slots,
      durability: restored.durability,
      hotbar: restored.hotbar,
      selected: restored.selected,
      cells: restored.cells,
    };
    const { storageSaved, storageRevision, ...persisted } = result.beforeReload;
    assert(
      "real reload restores seed, finite inventory, equipped worn tool, and table",
      same(result.afterReload, persisted),
      { before: persisted, after: result.afterReload }
    );
    result.status = "passed";
    return result;
  } catch (error) {
    result.status = "failed";
    const entry = {
      stage: `natural-survival/${phase}`,
      message: error.message,
    };
    result.errors.push(entry);
    if (report.errors.length < 100) report.errors.push(entry);
    result.lastObserved = last;
    throw error;
  } finally {
    if (measuring) {
      try {
        result.metrics = await bounded(
          input.page.evaluate(() =>
            window.__voxelBot.metrics.results({ stop: true })
          ),
          3000,
          "Final Survival metrics"
        );
      } catch (error) {
        result.errors.push({
          stage: "natural-survival/metrics-cleanup",
          message: error.message,
        });
      }
    }
    try {
      await bounded(input.release(), 3000, "Release Survival inputs");
    } catch (error) {
      result.errors.push({
        stage: "natural-survival/input-cleanup",
        message: error.message,
      });
    }
    input.page.setDefaultTimeout(input.config.timeoutMs);
    result.elapsedMs = performance.now() - started;
  }
}
