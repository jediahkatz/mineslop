import assert from "node:assert/strict";
import test from "node:test";
import { BIOMES } from "../src/biomes.js";
import { BLOCK } from "../src/blocks.js";
import { CONDUIT_LIMITS } from "../src/conduit-index.js";
import { buildConduit, conduitFixture, conduitGenerator, putCell } from "./conduit-fixture.js";

const keyOf = ({ x, y, z }) => `${x},${y},${z}`;
const position = (i) => ({ x: 2 + i % 5 * 6, y: 68 + Math.floor(i / 25) * 6,
  z: 2 + Math.floor(i / 5) % 5 * 6 });

test("123 real sources remain fairly serviced through repeated windows, reordered maps, admission/removal and veto", async (t) => {
  const f = await conduitFixture(t, { generatorFactory(...args) {
    const generator = conduitGenerator(...args);
    return { ...generator, generateChunk(cx, cz) {
      const chunk = generator.generateChunk(cx, cz);
      chunk.biomes.fill(BIOMES.findIndex((biome) => biome.id === "ocean"));
      return chunk;
    } };
  } });
  for (let i = 0; i < 123; i++) buildConduit(f.world, 42, position(i));
  for (let i = 0; i < 128; i++) f.conduit.frame(0);
  assert.equal(f.conduit.index.sources.size, 123);
  assert.equal(f.conduit.index.fallback, null);
  assert.equal(f.conduit.index.queue.size, 0);
  assert.equal(f.conduit.index.needsFallback, false);
  let frame = 0, attempts = 0, periodic = null, minInterval = Infinity, maxInterval = 0;
  const counts = new Map(), last = new Map(), states = new Map();
  const prepare = f.conduit.prepareAttack;
  t.mock.method(f.conduit, "prepareAttack", function (at) {
    const key = keyOf(at), previous = last.get(key);
    if (previous !== undefined) {
      assert.ok(frame - previous >= 20, `source ${key} pulsed faster than two seconds`);
      minInterval = Math.min(minInterval, frame - previous);
      maxInterval = Math.max(maxInterval, frame - previous);
    }
    counts.set(key, (counts.get(key) ?? 0) + 1);
    last.set(key, frame);
    attempts++;
    return Reflect.apply(prepare, this, [at]);
  });
  const run = (length, warmup = 0, reorder = false) => {
    for (let i = 0; i < length; i++) {
      frame++;
      if (reorder && i % 37 === 0)
        f.conduit.index.sources = new Map([...f.conduit.index.sources].reverse());
      const ready = [...f.conduit.cooldowns.values()]
        .filter((entry) => entry.elapsed + 0.1 >= 2 - 1e-9).length;
      const before = attempts;
      f.conduit.frame(0.1);
      assert.equal(attempts - before, Math.min(ready, CONDUIT_LIMITS.attacksPerStep));
      assert.ok(f.conduit.index.lastWork.cells <= CONDUIT_LIMITS.cellsPerStep);
      assert.ok(f.conduit.index.lastWork.columns <= CONDUIT_LIMITS.columnsPerStep);
      assert.ok(f.conduit.cooldowns.size <= CONDUIT_LIMITS.sources);
      // Stronger than "all called once": every continuing 52-frame window
      // must contain service, long after any initial favorable ordering.
      if (i >= warmup)
        for (const key of f.conduit.index.sources.keys())
          assert.ok(last.has(key) && frame - last.get(key) <= 52,
            `source ${key} starved at frame ${frame}; last=${last.get(key)}`);
      if (!reorder && i >= 128 && !periodic) {
        const state = JSON.stringify({
          cursor: f.conduit.attackCursor, order: f.conduit.attackOrder,
          clocks: [...f.conduit.cooldowns].sort(([a], [b]) => a.localeCompare(b))
            .map(([key, entry]) => [key, Math.round(entry.elapsed * 10)]),
        });
        if (states.has(state)) periodic = { start: states.get(state), period: frame - states.get(state) };
        else states.set(state, frame);
      }
    }
  };
  run(3000, 52);
  assert.ok(periodic, "verify fairness through a repeated scheduler state, not just warmup");
  const staticMinimum = Math.min(...counts.values());
  assert.ok(staticMinimum >= 90);

  // Real eligible target plus real transaction veto: failed payment/death must
  // neither retain scheduler priority nor let one source monopolize attempts.
  f.wildlife.endSpawnProtection();
  const structure = { id: "fairness-monument", kind: "ocean_monument", dimension: "overworld",
    origin: { x: 0, y: 65, z: 0 },
    bounds: { minX: 0, minY: 65, minZ: 0, maxX: 32, maxY: 105, maxZ: 32 } };
  // Authored habitat metadata only; admission/damage/payment remain real.
  const getStructure = f.wildlife.context.getStructure;
  t.mock.method(f.wildlife.context, "getStructure", (id) =>
    id === structure.id ? structure : getStructure(id));
  const admission = f.ecology.prepareAdmission("guardian", { x: 2.5, y: 69.5, z: 5.5 }, { structure });
  assert.ok(admission);
  assert.equal(f.ecology.commit(admission).ok, true);
  const guardian = f.wildlife.byId.get(admission.result.id), health = guardian.health;
  let vetoes = 0;
  const commit = f.ecology.commit;
  t.mock.method(f.ecology, "commit", function (plan) {
    vetoes++;
    return Reflect.apply(commit, this, [{ ...plan, participants: plan.participants.map((part, i) =>
      i ? part : { ...part, validate: () => false }) }]);
  });
  for (const i of [0, 17, 122]) putCell(f.world, position(i), BLOCK.WATER);
  for (const i of [0, 123, 124]) {
    buildConduit(f.world, 42, position(i));
    last.delete(keyOf(position(i)));
  }
  assert.equal(f.conduit.index.sources.size, 123);
  run(600, 52, true);
  assert.ok(vetoes > 0, "real prepared ecology hits reached the vetoed commit");
  assert.equal(guardian.health, health);
  t.diagnostic(JSON.stringify({ sources: 123, frames: frame, attempts, periodic, vetoes,
    staticMinimum, minInterval, maxInterval,
    minimumAttempts: Math.min(...[...f.conduit.index.sources.keys()].map((key) => counts.get(key))) }));
});
