import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

const budgetVariables = {
  frameP95Ms: "VOXELCRAFT_MAX_FRAME_P95_MS",
  frameP99Ms: "VOXELCRAFT_MAX_FRAME_P99_MS",
  inputP95Ms: "VOXELCRAFT_MAX_INPUT_P95_MS",
  mouseP95Ms: "VOXELCRAFT_MAX_MOUSE_P95_MS",
  minimumFps: "VOXELCRAFT_MIN_FPS",
  jank100Fraction: "VOXELCRAFT_MAX_JANK_100_FRACTION",
};

function number(value, name, minimum, maximum) {
  const parsed = Number(value);
  if (
    value === "" ||
    !Number.isFinite(parsed) ||
    parsed < minimum ||
    parsed > maximum
  )
    throw new Error(
      `${name} must be a number between ${minimum} and ${maximum}`
    );
  return parsed;
}

export function readConfig(args = process.argv.slice(2), env = process.env) {
  const { values } = parseArgs({
    args,
    options: {
      duration: { type: "string" },
      quality: { type: "string" },
      output: { type: "string" },
      seed: { type: "string" },
      screenshot: { type: "string" },
      width: { type: "string" },
      height: { type: "string" },
      "pixel-ratio": { type: "string" },
      "skip-fixture": { type: "boolean", default: false },
      "skip-survival": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) return { help: true };
  const quality = values.quality ?? env.VOXELCRAFT_TEST_QUALITY ?? "medium";
  if (!["low", "medium", "high"].includes(quality))
    throw new Error("--quality must be low, medium, or high");
  const seed = values.seed ?? env.VOXELCRAFT_TEST_SEED ?? "cedar-valley";
  if (!seed || seed.length > 80)
    throw new Error("Seed must contain 1–80 characters");
  // Intentional local Vite test server, not a service credential.
  const base = new URL(env.VOXELCRAFT_TEST_URL ?? "http://127.0.0.1:5173"); // pragma: allowlist secret
  if (
    !["http:", "https:"].includes(base.protocol) ||
    base.username ||
    base.password
  )
    throw new Error(
      "VOXELCRAFT_TEST_URL must be an HTTP(S) URL without credentials"
    );
  const url = new URL("/test/realtime/index.html", base);
  url.searchParams.set("quality", quality);
  url.searchParams.set("seed", seed);
  const pixelRatio =
    values["pixel-ratio"] === undefined
      ? null
      : number(values["pixel-ratio"], "--pixel-ratio", 0.4, 2);
  if (pixelRatio !== null)
    url.searchParams.set("pixelRatio", String(pixelRatio));
  const budgets = {};
  for (const [name, variable] of Object.entries(budgetVariables))
    if (env[variable] !== undefined)
      budgets[name] = number(
        env[variable],
        variable,
        0,
        name === "jank100Fraction" ? 1 : 1_000_000
      );
  const timestamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
  return {
    url: url.href,
    seed,
    quality,
    durationSeconds: number(
      values.duration ?? env.VOXELCRAFT_TEST_DURATION ?? "55",
      "--duration",
      5,
      300
    ),
    tickMs: number(
      env.VOXELCRAFT_BOT_TICK_MS ?? "40",
      "bot tick interval",
      16,
      250
    ),
    timeoutMs: number(
      env.VOXELCRAFT_CONTROL_TIMEOUT_MS ?? "20000",
      "control timeout",
      1000,
      120000
    ),
    output: resolve(
      values.output ??
        `/opt/cursor/artifacts/voxelcraft_realtime_${timestamp}.json`
    ),
    screenshot: values.screenshot ? resolve(values.screenshot) : null,
    syntheticControls: !values["skip-fixture"],
    naturalSurvival: !values["skip-survival"],
    requireNativeMouse: env.VOXELCRAFT_REQUIRE_NATIVE_MOUSE === "1",
    chromeBin: env.CHROME_BIN ?? null,
    viewport: {
      width: Math.round(number(values.width ?? "1280", "--width", 320, 3840)),
      height: Math.round(number(values.height ?? "720", "--height", 240, 2160)),
    },
    pixelRatioOverride: pixelRatio,
    budgets,
  };
}

/** Filesystem discovery, never shelling out or using a shared browser profile. */
export async function chromeExecutable(configured) {
  const candidates = configured
    ? [configured]
    : [
        "/usr/local/bin/google-chrome",
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/opt/google/chrome/chrome",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "/opt/chromium/chrome",
      ];
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next documented installation location.
    }
  }
  throw new Error(
    configured
      ? `CHROME_BIN is not executable: ${configured}`
      : "Installed Chrome not found. Set CHROME_BIN to its executable path."
  );
}

export const usage = `Usage: node test/realtime/run.mjs [options]
  --duration <seconds>   Continuous generated-terrain traversal (default 55)
  --quality <level>      low, medium, or high (default medium)
  --seed <seed>          Generator seed (default cedar-valley)
  --output <file.json>   JSON report, including failures
  --screenshot <file>    Optional generated-terrain capture AFTER measurement
  --width <pixels>       Browser viewport width (default 1280)
  --height <pixels>      Browser viewport height (default 720)
  --pixel-ratio <ratio>  Explicit resolution-only experiment, recorded in the report
  --skip-fixture        Omit the separately labeled synthetic Survival checks
  --skip-survival       Omit the natural-tree gathering/crafting/save flow

Requires an already-running Vite server, playwright, and installed Chrome.
VOXELCRAFT_TEST_URL selects the server; CHROME_BIN selects Chrome.
Performance budgets are opt-in. See test/realtime/README.md.`;
