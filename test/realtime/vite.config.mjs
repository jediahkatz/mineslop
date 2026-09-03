import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// Freeze the real game and harness together: editing source cannot reload a run.
export default defineConfig({
  root: fileURLToPath(new URL("../../", import.meta.url)),
  build: {
    outDir: "dist-realtime",
    emptyOutDir: true,
    rolldownOptions: {
      input: {
        realtime: fileURLToPath(new URL("./index.html", import.meta.url)),
        nativeWorker: fileURLToPath(
          new URL("../native-v4-worker.html", import.meta.url)
        ),
      },
    },
  },
});
