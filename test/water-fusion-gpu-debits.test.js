import assert from "node:assert/strict";
import test from "node:test";
import { assertWaterGPUWork } from "./water-fusion-gl-trace.js";

test("GPU proof rejects uncharged allocation/upload even with abundant CPU or opposite-domain debit", () => {
  const allocation = [{ method: "texStorage2D", bytes: 64, workBytes: 64 }];
  const upload = [{ method: "texSubImage2D", bytes: 64, workBytes: 64 }];
  const cpu = [{ kind: "cpu-read-and-copy", bytes: 1048576 }];
  assert.throws(() => assertWaterGPUWork(cpu, allocation), /GPU-specific debit exceeded/);
  assert.throws(() => assertWaterGPUWork(cpu, upload), /GPU-specific debit exceeded/);
  assert.throws(() => assertWaterGPUWork([{ kind: "gpu-row-upload", bytes: 64 }], allocation), /GPU-specific/);
  assert.throws(() => assertWaterGPUWork([{ kind: "gpu-texture-zero-allocation", bytes: 64 }], upload), /GPU-specific/);
  assert.deepEqual(assertWaterGPUWork([
    { kind: "gpu-texture-zero-allocation", bytes: 64 }, { kind: "gpu-row-upload", bytes: 64 },
  ], [...allocation, ...upload]), {
    allocationWork: 64, allocationDebit: 64, uploadWork: 64, uploadDebit: 64,
  });
});
