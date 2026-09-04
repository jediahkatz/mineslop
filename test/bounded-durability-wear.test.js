import assert from "node:assert/strict";
import test from "node:test";
import { boundedDurabilityWear, MAX_WEAR_DURABILITY } from "../src/bounded-durability-wear.js";

// Independent exact integer reference: probabilities have denominator base^n.
function exactMasses(n, numerator, base = 4) {
  let choose = 1n;
  return Array.from({ length: n + 1 }, (_, k) => {
    if (k) choose = choose * BigInt(n - k + 1) / BigInt(k);
    return choose * BigInt(numerator) ** BigInt(k) *
      BigInt(base - numerator) ** BigInt(n - k);
  });
}

test("small-N enumerated discrete CDF has the exact capped binomial distribution", () => {
  for (let n = 1; n <= 7; n++) for (const numerator of [1, 2, 3]) {
    const mass = exactMasses(n, numerator).map(Number), denominator = 4 ** n;
    for (const cap of new Set([1, Math.min(3, n), n])) {
      const expected = mass.slice(0, cap);
      expected.push(mass.slice(cap).reduce((a, b) => a + b, 0));
      const observed = Array(cap + 1).fill(0);
      for (let i = 0; i < denominator; i++)
        observed[boundedDurabilityWear(n, numerator / 4, cap, (i + 0.5) / denominator)]++;
      assert.deepEqual(observed, expected, `n=${n}, p=${numerator}/4, cap=${cap}`);
    }
  }
});

test("log CDF recovers after initial PMF underflow, against exact BigInt quantiles", () => {
  for (const [n, numerator, base] of [
    [2000, 1, 4], [2000, 2, 4], [2000, 3, 4], [2000, 7, 10],
    [2000, 4, 5], [2000, 11, 15], [5000, 1, 4], [8000, 1, 4],
  ]) {
    const cap = Math.min(n, MAX_WEAR_DURABILITY);
    const mass = exactMasses(n, numerator, base), denominator = BigInt(base) ** BigInt(n);
    for (const word of [0, 1, 12345, 0x7fffffff, 0x80000000, 0xfffffffe, 0xffffffff]) {
      let cdf = 0n, expected = cap;
      for (let k = 0; k < cap; k++) {
        cdf += mass[k];
        if (cdf * (1n << 33n) > (2n * BigInt(word) + 1n) * denominator) {
          expected = k; break;
        }
      }
      assert.equal(boundedDurabilityWear(n, numerator / base, cap, word / 2 ** 32), expected,
        `n=${n}, p=${numerator}/${base}, word=${word}`);
    }
  }
});

test("deterministic probabilities, endpoint bins and cap boundary", () => {
  for (const n of [0, 1, 256, 1000, Number.MAX_SAFE_INTEGER, Number.MAX_VALUE]) {
    assert.equal(boundedDurabilityWear(n, 1, 165), Math.min(n, 165));
    assert.equal(boundedDurabilityWear(n, 0, 165), 0);
    assert.equal(boundedDurabilityWear(n, 0.7, 0), 0);
  }
  assert.equal(boundedDurabilityWear(1, 0.5, 1, 0), 0);
  assert.equal(boundedDurabilityWear(1, 0.5, 1, 0.5 - 2 ** -32), 0);
  assert.equal(boundedDurabilityWear(1, 0.5, 1, 0.5), 1);
  assert.equal(boundedDurabilityWear(1, 0.5, 1, 1 - Number.EPSILON), 1);
  // P(X < 2) for Binomial(4, 1/2) is 5/16; the remaining tail breaks the stack.
  assert.equal(boundedDurabilityWear(4, 0.5, 2, 5 / 16 - 2 ** -32), 1);
  assert.equal(boundedDurabilityWear(4, 0.5, 2, 5 / 16), 2);
  assert.equal(boundedDurabilityWear(2000, 0.5, 2, 0), 2, "no spurious zero-endpoint tail");
});

test("extreme counts have slot-durability-bounded work and no implicit randomness", (t) => {
  t.mock.method(Math, "random", () => assert.fail("implicit random draw"));
  const log = Math.log;
  let logarithms = 0;
  t.mock.method(Math, "log", (value) => { logarithms++; return log(value); });
  for (const n of [1e12, Number.MAX_VALUE / 4, Number.MAX_VALUE]) {
    for (const p of [0.25, 0.7, 0.999999]) for (const roll of [0, 1 - 2 ** -32]) {
      logarithms = 0;
      assert.equal(boundedDurabilityWear(n, p, MAX_WEAR_DURABILITY, roll), MAX_WEAR_DURABILITY);
      assert.ok(logarithms <= 2 * MAX_WEAR_DURABILITY + 2);
    }
  }
});

test("invalid counts, probabilities, caps and uniforms reject without unbounded work", () => {
  for (const n of [-1, NaN, Infinity, 1.5])
    assert.throws(() => boundedDurabilityWear(n, 0.7, 10), RangeError);
  for (const p of [-0.1, 1.1, NaN, Infinity])
    assert.throws(() => boundedDurabilityWear(1000, p, 10), RangeError);
  for (const cap of [-1, 1.5, MAX_WEAR_DURABILITY + 1, Infinity])
    assert.throws(() => boundedDurabilityWear(1000, 0.7, cap), RangeError);
  for (const roll of [-1, 1, NaN, Infinity])
    assert.throws(() => boundedDurabilityWear(1000, 0.7, 10, roll), RangeError);
});
