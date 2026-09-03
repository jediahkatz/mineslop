import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { buildIdentity, ROOT } from "./source-fingerprint.mjs";

// Separate authored review entry. Nothing imports the normal game entry or a save.
export default defineConfig(async () => ({
  root: ROOT,
  base: "./",
  define: {
    __MINESLOP_BLOCK_ART_BUILD__: JSON.stringify(await buildIdentity()),
  },
  server: { host: "127.0.0.1", port: 5176, strictPort: true },
  preview: { host: "127.0.0.1", port: 5176, strictPort: true },
  build: {
    outDir: "dist-art-review",
    emptyOutDir: true,
    rolldownOptions: {
      input: fileURLToPath(new URL("./index.html", import.meta.url)),
    },
  },
}));
