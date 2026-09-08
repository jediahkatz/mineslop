import { defineConfig } from "vite";

export default defineConfig({
  root: new URL("../..", import.meta.url).pathname,
  base: "/mineslop/",
  server: {
    hmr: false,
    watch: { ignored: ["**/dist*/**", "**/coverage/**", "**/test-results/**"] },
  },
  build: {
    outDir: "dist-render-benchmark",
    rolldownOptions: { input: new URL("./index.html", import.meta.url).pathname },
  },
});
