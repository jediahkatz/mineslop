// Opt-in real GPU verification; the preview server remains running.
import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { chromeExecutable } from "./realtime/config.mjs";

const base = new URL(process.env.VOXELCRAFT_TEST_URL ?? "http://127.0.0.1:5173/mineslop/");
if (!base.pathname.endsWith("/")) base.pathname += "/";
const url = new URL("test/realtime/index.html?quality=low&seed=cedar-valley&pixelRatio=0.5", base);

test("cave daylight shaders compile on the real GPU and survive quality/inspection changes", {
  timeout: 180000,
}, async (t) => {
  const browser = await chromium.launch({
    executablePath: await chromeExecutable(process.env.CHROME_BIN),
    headless: true,
    args: ["--disable-dev-shm-usage", "--enable-unsafe-swiftshader"],
  });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1000, height: 720 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && /WebGLProgram|shader|compile|VALIDATE_STATUS/i.test(message.text()))
      errors.push(message.text());
  });
  await page.goto(url.href, { waitUntil: "load", timeout: 90000 });
  await page.waitForFunction(() => window.__voxelBot?.ready || window.__voxelBot?.error,
    undefined, { timeout: 90000 });
  assert.equal(await page.evaluate(() => window.__voxelBot.error), null);

  const states = [];
  for (const [quality, fullbright] of [
    ["low", false], ["medium", false], ["high", false],
    ["high", true], ["high", false], ["low", false],
  ]) {
    const state = await page.evaluate(({ quality, fullbright }) => {
      const { graphics: g, player } = window.__voxelBot.game;
      g.setQuality(quality);
      g.setFullbrightInspection(fullbright);
      g.update(0, g.waterTime.value, player.position);
      g.renderer.render(g.scene, g.camera);
      const gl = g.renderer.getContext();
      return {
        quality,
        fullbright,
        maskEnabled: g.daylightMaterial?.uniforms.uDaylightEnabled.value,
        materials: Object.entries(g.materials)
          .filter(([, material]) => material.isMeshLambertMaterial)
          .map(([name, material]) => ({ name, key: material.customProgramCacheKey() })),
        programCount: g.renderer.info.programs.length,
        failedPrograms: g.renderer.info.programs
          .filter((program) => program.diagnostics?.runnable === false)
          .map((program) => ({
            programLog: program.diagnostics.programLog,
            vertexLog: program.diagnostics.vertexShader?.log,
            fragmentLog: program.diagnostics.fragmentShader?.log,
          })),
        contextLost: gl.isContextLost(),
        glError: gl.getError(),
      };
    }, { quality, fullbright });
    states.push(state);
    t.diagnostic(JSON.stringify(state));
    assert.equal(state.contextLost, false);
    assert.equal(state.glError, 0);
    assert.ok(state.programCount > 0);
    assert.deepEqual(state.failedPrograms, []);
    assert.equal(state.maskEnabled, Number(!fullbright));
    assert.ok(state.materials.length > 0);
    for (const material of state.materials)
      assert.match(material.key, /:daylight-1:/, `${quality} lost the ${material.name} daylight hook`);
    assert.deepEqual(errors, [], "Shader/compiler errors must not hide behind a running game loop");
  }
  assert.equal(states.length, 6);
});
