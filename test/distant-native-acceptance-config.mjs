export function acceptanceConfig(env = process.env) {
  const integer = (key, fallback, min) => {
    const value = Number(env[key] ?? fallback);
    if (!Number.isSafeInteger(value) || value < min) throw new RangeError(`Invalid ${key}`);
    return value;
  };
  const base = new URL(env.VOXELCRAFT_TEST_URL ?? "http://127.0.0.1:5173/mineslop/");
  if (!base.pathname.endsWith("/")) base.pathname += "/";
  base.search = ""; base.hash = "";
  const qualities = (env.LOD_GPU_QUALITIES ?? "low,high").split(",");
  if (!qualities.every((q) => ["low", "medium", "high"].includes(q))) throw new RangeError("Invalid LOD_GPU_QUALITIES");
  const scenarios = (env.LOD_GPU_SCENARIOS ?? "end-v7,badlands-v3,end-v3,end-v4").split(",");
  const catalogue = {
    "end-v7": { dimension: "end", version: 7 },
    "end-v3": { dimension: "end", version: 3 },
    "end-v4": { dimension: "end", version: 4 },
    "end-v5": { dimension: "end", version: 5 },
    "end-v6": { dimension: "end", version: 6 },
    "badlands-v3": { dimension: "overworld", version: 3, biome: "eroded_badlands" },
    "badlands-v7": { dimension: "overworld", version: 7, biome: "eroded_badlands" },
  };
  if (!scenarios.every((name) => catalogue[name])) throw new RangeError("Invalid LOD_GPU_SCENARIOS");
  return {
    url: new URL("test/realtime/index.html?quality=low&seed=cedar-valley", base).href,
    coverageURL: new URL("test/distant-native-coverage.mjs", base).href,
    landmarksURL: new URL("src/distant-landmarks.js", base).href,
    qualities, scenarios: scenarios.map((name) => ({ name, ...catalogue[name] })),
    seed: env.LOD_GPU_SEED ?? "cedar-valley",
    settleFrames: integer("LOD_GPU_SETTLE_FRAMES", 45, 3),
    sweepFrames: integer("LOD_GPU_SWEEP_FRAMES", 90, 3),
    timeoutMs: integer("LOD_GPU_TIMEOUT_MS", 1200000, 1000),
    readyTimeoutMs: integer("LOD_GPU_READY_TIMEOUT_MS", 180000, 1000),
    // Wall wait allowance is independent of measured frame intervals.
    runLabel: env.LOD_GPU_LABEL ?? String(Date.now()),
  };
}
