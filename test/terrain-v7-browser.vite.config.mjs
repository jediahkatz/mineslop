import { existsSync, readdirSync } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { V7_BROWSER_SOURCE } from "./terrain-v7-browser-host.js";

const outDir = process.env.VOXELCRAFT_NATIVE_V7_OUT_DIR;
if (!outDir || !isAbsolute(outDir) || (existsSync(outDir) && readdirSync(outDir).length))
  throw new Error("Set VOXELCRAFT_NATIVE_V7_OUT_DIR to a fresh empty absolute output directory");
if (process.env.VITE_NATIVE_V7_SOURCE_SHA !== V7_BROWSER_SOURCE || !process.env.VITE_BENCHMARK_LABEL)
  throw new Error("Compile with the frozen shared source SHA and a nonempty unique build label");

export default defineConfig({
  root: fileURLToPath(new URL("../", import.meta.url)),
  worker: { format: "es" },
  build: {
    outDir, emptyOutDir: false,
    rolldownOptions: { input: fileURLToPath(new URL("./terrain-v7-worker.html", import.meta.url)) },
  },
});
