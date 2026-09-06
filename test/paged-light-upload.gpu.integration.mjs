import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { chromeExecutable } from "./realtime/config.mjs";

test("Three CPU page copies allocate no bank mirror and upload only subrectangles", { timeout: 60000 }, async (t) => {
  const browser = await chromium.launch({
    executablePath: await chromeExecutable(process.env.CHROME_BIN),
    headless: true, args: ["--disable-dev-shm-usage", "--enable-unsafe-swiftshader"],
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(process.env.MINESLOP_LIGHT_TEST_URL ?? "http://127.0.0.1:6791/mineslop/test/daylight-surface-probe.html");
  const result = await page.evaluate(async () => {
    const T = await import("../node_modules/three/build/three.module.js");
    const canvas = document.createElement("canvas"), gl = canvas.getContext("webgl2");
    const parameter = gl.getParameter.bind(gl);
    gl.getParameter = (p) => p === gl.MAX_TEXTURE_SIZE ? 2048 :
      p === gl.MAX_ARRAY_TEXTURE_LAYERS ? 256 : p === gl.MAX_TEXTURE_IMAGE_UNITS ? 16 : parameter(p);
    const calls = [];
    for (const name of ["texStorage3D", "texSubImage3D", "texImage3D", "texSubImage2D"]) {
      const original = gl[name].bind(gl);
      gl[name] = (...args) => {
        calls.push({ name, args: args.map((a) => ArrayBuffer.isView(a) ? { bytes: a.byteLength } : a) });
        return original(...args);
      };
    }
    const renderer = new T.WebGLRenderer({ canvas, context: gl });
    const bootstrapCalls = calls.splice(0);
    const bank = new T.DataArrayTexture(null, 640, 640, 64);
    bank.format = T.RedFormat;
    bank.source.dataReady = false;
    bank.needsUpdate = true;
    const bytes = new Uint8Array(80 * 80).fill(105);
    const source = new T.DataTexture(bytes, 80, 80, T.RedFormat);
    renderer.copyTextureToTexture(source, bank, null, new T.Vector3(560, 560, 63));
    bytes.fill(71);
    renderer.copyTextureToTexture(source, bank, null, new T.Vector3(0, 0, 63));
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, renderer.properties.get(bank).__webglTexture, 0, 63);
    const read = (x, y) => {
      const value = new Uint8Array(4);
      gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, value);
      return [...value];
    };
    const pixels = [read(560, 560), read(0, 0), read(80, 80)];
    const error = gl.getError(), status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fb);
    source.dispose(); bank.dispose(); renderer.dispose();
    return { calls, bootstrapCalls, pixels, error, status, cpuBankData: bank.image.data,
      revision: T.REVISION, caps: [gl.getParameter(gl.MAX_TEXTURE_SIZE), gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS),
        gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS)] };
  });
  t.diagnostic(JSON.stringify(result));
  assert.equal(result.revision, "185");
  assert.equal(result.error, 0);
  assert.equal(result.status, 36053);
  assert.equal(result.cpuBankData, null);
  assert.deepEqual(result.caps, [2048, 256, 16]);
  assert.deepEqual(result.pixels.map((p) => p[0]), [105, 71, 0]);
  const copies = result.calls.filter((c) => c.name === "texSubImage3D");
  assert.equal(copies.length, 2);
  assert.ok(copies.every((c) => c.args[5] === 80 && c.args[6] === 80 && c.args[7] === 1 && c.args[10].bytes === 6400));
  assert.equal(result.calls.filter((c) => c.name === "texStorage3D").length, 1);
  assert.equal(result.calls.filter((c) => c.name === "texImage3D" || c.name === "texSubImage2D").length, 0);
});
