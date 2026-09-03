import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK as B } from "../src/blocks.js";
import { newV4Counters, V4_SPECS } from "../src/terrain-v4-config.js";
import { createV4Decorators } from "../src/terrain-v4-decorators.js";
import { createV4Writer } from "../src/terrain-v4-writer.js";

const bounds = { minX: 0, minZ: 0, width: 16, depth: 16 };
const context = {
  seed: "authored-decorator-fixture",
  salt: 1,
  dimension: "overworld",
  spec: V4_SPECS.overworld,
  sampleColumn: () => null,
};
const descriptor = {
  kind: "authored-unit-marker",
  bounds: { minX: 0, minY: 64, minZ: 0, maxX: 32, maxY: 65, maxZ: 1 },
};
const marker = {
  id: "authored-unit-marker",
  spacing: 32,
  reach: 0,
  maxWrites: 4,
  describe: () => [descriptor],
  emit: () => {},
};

function emit(entry) {
  const counters = newV4Counters();
  const writer = createV4Writer({ ...bounds, spec: context.spec, counters });
  return createV4Decorators([entry], context, counters)(bounds, writer);
}

test("authored decorator fixture cannot observe the clipped writer's success", () => {
  const results = [];
  const output = emit({
    ...marker,
    emit(data, put) {
      assert.deepEqual(data, descriptor);
      results.push(put(0, 64, 0, B.STONE, { mode: "replace" }));
      results.push(put(31, 64, 0, B.STONE, { mode: "replace" }));
    },
  });
  assert.deepEqual(results, [undefined, undefined]);
  assert.equal(output.length, 1);
  assert.equal(output[0].owner, marker.id);
  assert.equal(output[0].gx, 0);
  assert.equal(output[0].gz, 0);
});

test("authored decorator fixture enforces descriptor ownership and bounded samples/writes", () => {
  assert.throws(
    () =>
      emit({
        ...marker,
        describe: () => [
          { ...descriptor, bounds: { ...descriptor.bounds, minX: -1 } },
        ],
      }),
    /out-of-owner/
  );
  assert.throws(
    () =>
      emit({
        ...marker,
        maxSamples: 1,
        describe({ sampleColumn }) {
          sampleColumn(0, 0);
          sampleColumn(1, 0);
          return [descriptor];
        },
      }),
    /sample budget/
  );
  assert.throws(
    () =>
      emit({
        ...marker,
        maxWrites: 1,
        emit(data, put) {
          put(0, 64, 0, B.STONE);
          put(1, 64, 0, B.STONE);
        },
      }),
    /write budget/
  );
  assert.throws(
    () =>
      emit({
        ...marker,
        emit(data, put) {
          put(32, 64, 0, B.STONE);
        },
      }),
    /outside its descriptor/
  );
  assert.throws(
    () =>
      emit({
        ...marker,
        emit(data, put) {
          put(NaN, 64, 0, B.STONE);
        },
      }),
    /outside its descriptor/
  );
  assert.throws(
    () => createV4Decorators([marker, marker], context, newV4Counters()),
    /Invalid/
  );
});
