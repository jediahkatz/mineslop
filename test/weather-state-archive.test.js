import assert from "node:assert/strict";
import test from "node:test";
import { normalizeWeatherArchive } from "../src/weather-state.js";

test("pure archive normalization preserves absent, explicit undefined and detached valid weather", () => {
  for (const saved of [undefined, null, {}, { weather: undefined }])
    assert.deepEqual(normalizeWeatherArchive(saved), { weather: { version: 1, elapsed: 0 } });
  const saved = { weather: { version: 1, elapsed: 1000 } };
  const normalized = normalizeWeatherArchive(saved);
  assert.deepEqual(normalized, saved);
  assert.notEqual(normalized.weather, saved.weather);
  saved.weather.elapsed = 5;
  assert.equal(normalized.weather.elapsed, 1000);
});

test("pure archive normalization rejects malformed weather and never invokes accessors", () => {
  for (const saved of [false, 1, "weather", []]) assert.equal(normalizeWeatherArchive(saved), null);
  for (const weather of [null, false, [], {}, { version: 2, elapsed: 1 },
    { version: 1, elapsed: -1 }, { version: 1, elapsed: Infinity },
    { version: 1, elapsed: 1e13 }, { version: 1, elapsed: 1, extra: true }])
    assert.equal(normalizeWeatherArchive({ weather }), null);
  let reads = 0;
  const getter = () => { reads++; throw new Error("getter must not run"); };
  assert.equal(normalizeWeatherArchive(Object.defineProperty({}, "weather", { get: getter })), null);
  for (const key of ["version", "elapsed"])
    assert.equal(normalizeWeatherArchive({
      weather: Object.defineProperty({ version: 1, elapsed: 0 }, key, { get: getter }),
    }), null);
  assert.equal(reads, 0);
});
