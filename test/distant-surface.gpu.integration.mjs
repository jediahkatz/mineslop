// Material-only control: native atlas texels versus the LOD shader. This is
// automated shader coverage, not native-world visual acceptance.
import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { chromeExecutable } from "./realtime/config.mjs";

const base = new URL(process.env.VOXELCRAFT_TEST_URL ?? "http://127.0.0.1:5394/mineslop/");
test("LOD atlas matches native face pixels with RGB/RGBA colors and context restoration", {
  timeout: 120000,
}, async (t) => {
  const browser = await chromium.launch({
    executablePath: await chromeExecutable(process.env.CHROME_BIN),
    headless: true, args: ["--enable-unsafe-swiftshader"],
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.route("**/favicon.ico", (route) => route.fulfill({ status: 204 }));
  await page.goto(new URL("test/daylight-surface-probe.html", base).href);
  const result = await page.evaluate(async () => {
    const THREE = await import("../node_modules/three/build/three.module.js");
    const { BLOCK } = await import("../src/blocks.js");
    const { createAtlas } = await import("../src/textures.js");
    const { createChunkMaterials } = await import("../src/renderer.js");
    const { installDistantSurface } = await import("../src/distant-surface-material.js");
    const { getBiomeTint } = await import("../src/mesh-palette.js");
    const { getBiomeById } = await import("../src/biomes.js");
    const { releaseLostContextResources } = await import("../src/context-resources.js");
    const renderer = new THREE.WebGLRenderer({ antialias: false });
    renderer.setSize(32, 32);
    document.body.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    scene.add(new THREE.AmbientLight(0xffffff, 1));
    const camera = new THREE.OrthographicCamera(-0.5, 0.5, 0.5, -0.5, 0.1, 10);
    camera.position.set(0.5, 3, 0.5);
    camera.up.set(0, 0, -1);
    camera.lookAt(0.5, 1, 0.5);
    const atlas = createAtlas();
    const materials = createChunkMaterials(atlas);
    const lod = new THREE.MeshLambertMaterial({ vertexColors: true });
    installDistantSurface(lod, atlas);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute([
      0, 1, 0, 0, 1, 1, 1, 1, 1, 1, 1, 0,
    ], 3));
    geometry.setAttribute("normal", new THREE.Float32BufferAttribute([
      0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0,
    ], 3));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    const mesh = new THREE.Mesh(geometry, lod);
    scene.add(mesh);
    const gl = renderer.getContext();
    const capture = (material) => {
      mesh.material = material;
      renderer.render(scene, camera);
      const pixels = new Uint8Array(32 * 32 * 4);
      gl.readPixels(0, 0, 32, 32, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      return pixels;
    };
    const rows = [];
    let reference;
    const cases = [
      ...[BLOCK.END_STONE, BLOCK.DIRT, BLOCK.GRASS].map((id) => ({ id, face: "top", top: 0, source: id })),
      { id: BLOCK.GRASS, face: "side", top: 0, source: BLOCK.GRASS },
      { id: BLOCK.DIRT, face: "side", top: 3, source: BLOCK.GRASS },
      { id: BLOCK.STONE, face: "side", top: 5, source: BLOCK.GRASS },
    ];
    for (const components of [3, 4]) {
      for (const { id, face, top, source } of cases) {
        const up = face === "top";
        camera.position.set(0.5, up ? 3 : 0.5, up ? 0.5 : 3);
        camera.up.set(0, up ? 0 : 1, up ? -1 : 0);
        camera.lookAt(0.5, up ? 1 : 0.5, up ? 0.5 : 1);
        geometry.setAttribute("position", new THREE.Float32BufferAttribute(up
          ? [0, 1, 0, 0, 1, 1, 1, 1, 1, 1, 1, 0]
          : [0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1], 3));
        geometry.setAttribute("normal", new THREE.Float32BufferAttribute(
          Array(4).fill(up ? [0, 1, 0] : [0, 0, 1]).flat(), 3));
        geometry.computeBoundingSphere();
        const tint = getBiomeTint(id, face, getBiomeById("plains")).map((value) => value * (up ? 1 : 0.9));
        const colors = [];
        for (let vertex = 0; vertex < 4; vertex++)
          colors.push(...tint, ...(components === 4 ? [1] : []));
        geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, components));
        geometry.setAttribute("lodSurface", new THREE.Float32BufferAttribute(Array(4).fill([0, top, 0]).flat(), 3));
        geometry.setAttribute("lodBlocks", new THREE.Uint16BufferAttribute(Array(4).fill([source, BLOCK.DIRT, BLOCK.STONE]).flat(), 3));
        const [u0, v0, u1, v1] = atlas.uvFor(id, face);
        geometry.setAttribute("uv", new THREE.Float32BufferAttribute(up
          ? [u0, v1, u0, v0, u1, v0, u1, v1]
          : [u0, v0, u1, v0, u1, v1, u0, v1], 2));
        materials.opaque.needsUpdate = lod.needsUpdate = true;
        const native = capture(materials.opaque), distant = capture(lod);
        let maximumError = 0, nonblack = 0;
        for (let i = 0; i < native.length; i++) {
          maximumError = Math.max(maximumError, Math.abs(native[i] - distant[i]));
          if (i % 4 < 3 && native[i] > 0) nonblack++;
        }
        rows.push({ id, face, components, maximumError, nonblack, glError: gl.getError() });
        reference = distant;
      }
    }
    // The same material disposal event is used by context recovery, not just
    // final teardown. Its private lookup must remain correctly owned afterward.
    const extension = gl.getExtension("WEBGL_lose_context");
    if (!extension) throw new Error("Context loss extension unavailable");
    const contextEvent = (name) => new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${name}`)), 10000);
      renderer.domElement.addEventListener(name, () => {
        clearTimeout(timeout);
        resolve();
      }, { once: true });
    });
    const lost = contextEvent("webglcontextlost");
    extension.loseContext();
    await lost;
    await new Promise(requestAnimationFrame);
    releaseLostContextResources(renderer, scene, [atlas.texture]);
    const restored = contextEvent("webglcontextrestored");
    extension.restoreContext();
    await restored;
    const recovered = capture(lod);
    let restorationError = 0;
    for (let i = 0; i < recovered.length; i++)
      restorationError = Math.max(restorationError, Math.abs(recovered[i] - reference[i]));
    const texturesBeforeDispose = renderer.info.memory.textures;
    lod.dispose();
    const texturesAfterDispose = renderer.info.memory.textures;
    const glError = gl.getError();
    geometry.dispose();
    Object.values(materials).forEach((material) => material.dispose());
    atlas.texture.dispose();
    atlas.emissiveTexture.dispose();
    renderer.dispose();
    return { rows, restorationError, texturesBeforeDispose, texturesAfterDispose, glError };
  });
  t.diagnostic(JSON.stringify(result));
  assert.deepEqual(errors, []);
  for (const row of result.rows) {
    assert.equal(row.glError, 0);
    assert.ok(row.nonblack > 0);
    assert.ok(row.maximumError <= 1, JSON.stringify(row));
  }
  assert.equal(result.restorationError, 0);
  assert.equal(result.glError, 0);
  assert.equal(result.texturesBeforeDispose, 2);
  assert.equal(result.texturesAfterDispose, 1, "dispose releases the lookup but retains the shared atlas after restoration");
});
