import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { chromeExecutable } from "./realtime/config.mjs";

test("production paged lighting links terrain, instanced skins, gel, batching and exterior at 16 samplers", { timeout: 60000 }, async (t) => {
  const browser = await chromium.launch({ executablePath: await chromeExecutable(process.env.CHROME_BIN),
    headless: true, args: ["--disable-dev-shm-usage", "--enable-unsafe-swiftshader"] });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route("**/favicon.ico", (route) => route.fulfill({ status: 204, body: "" }));
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.goto(process.env.MINESLOP_LIGHT_TEST_URL ?? "http://127.0.0.1:6791/mineslop/test/daylight-surface-probe.html");
  const result = await page.evaluate(async () => {
    const T = await import("../node_modules/three/build/three.module.js");
    const { SkyColumns } = await import("../src/sky-columns.js");
    const { DaylightMaterial, DAYLIGHT_DECLARATIONS } = await import("../src/daylight-material.js");
    const { BLOCK_LIGHT_DECLARATIONS, updateBlockLightUniforms } = await import("../src/block-light-material.js");
    const { blockLightPalette } = await import("../src/block-light-palette.js");
    const { createAtlas } = await import("../src/textures.js");
    const { createChunkMaterials } = await import("../src/renderer.js");
    const { createMobSkinResources, createMobGelResources } = await import("../src/mob-skin-atlas.js");
    const { releaseLostContextResources } = await import("../src/context-resources.js");
    const canvas = document.createElement("canvas"), gl = canvas.getContext("webgl2");
    const glErrors = [];
    for (const name of ["deleteTexture", "bindTexture", "texStorage2D", "texStorage3D", "texSubImage2D", "texSubImage3D", "pixelStorei",
      "drawElements", "drawElementsInstanced", "drawArrays", "readPixels", "framebufferTextureLayer"]) {
      const original = gl[name].bind(gl);
      gl[name] = (...args) => {
        const result = original(...args), error = gl.getError();
        if (error && !gl.isContextLost()) glErrors.push({ name, error, stack: new Error().stack });
        return result;
      };
    }
    const parameter = gl.getParameter.bind(gl);
    gl.getParameter = (p) => p === gl.MAX_TEXTURE_SIZE ? 2048 :
      p === gl.MAX_ARRAY_TEXTURE_LAYERS ? 256 : p === gl.MAX_TEXTURE_IMAGE_UNITS ? 16 : parameter(p);
    const renderer = new T.WebGLRenderer({ canvas, context: gl });
    renderer.setSize(8, 8);
    const scene = new T.Scene(), camera = new T.PerspectiveCamera(60, 1, 0.1, 100);
    scene.add(new T.DirectionalLight(), new T.HemisphereLight());
    scene.fog = new T.Fog(0xeeeeff, 10, 90);
    camera.position.z = 5;
    const columns = new SkyColumns(12);
    columns.spec = { minY: -64, maxY: 320 };
    columns.world = { dimension: "overworld" };
    columns.surfaceLight.allocate(384);
    const daylight = new DaylightMaterial(columns, scene);
    daylight.blockLight.allocate(384, 12);
    const atlas = createAtlas(), materials = createChunkMaterials(atlas);
    const skins = createMobSkinResources(1), gel = createMobGelResources(skins);
    const geometry = new T.BoxGeometry();
    geometry.setAttribute("color", new T.BufferAttribute(new Float32Array(geometry.attributes.position.count * 3).fill(1), 3));
    const meshes = [];
    for (const [name, material] of Object.entries(materials)) {
      daylight.install(material);
      const mesh = new T.Mesh(geometry, material); mesh.name = name; meshes.push(mesh); scene.add(mesh);
    }
    for (const [name, resource] of [["skin", skins], ["gel", gel]]) {
      daylight.install(resource.material);
      const mesh = new T.InstancedMesh(resource.geometry, resource.material, 1);
      mesh.setMatrixAt(0, new T.Matrix4()); mesh.name = name; meshes.push(mesh); scene.add(mesh);
    }
    const exterior = new T.MeshLambertMaterial({ map: atlas.texture });
    daylight.install(exterior, true);
    const batch = new T.BatchedMesh(1, 24, 36, exterior);
    batch.addInstance(batch.addGeometry(geometry)); batch.name = "exterior-batched"; meshes.push(batch); scene.add(batch);
    const interior = materials.berryFoliage.clone();
    daylight.install(interior);
    const interiorBatch = new T.BatchedMesh(1, 24, 36, interior);
    interiorBatch.addInstance(interiorBatch.addGeometry(geometry));
    interiorBatch.name = "interior-emissive-batched"; meshes.push(interiorBatch); scene.add(interiorBatch);
    // All lighting banks absent: tiny valid placeholders, never full cold bank uploads.
    const upload = daylight.flush(renderer);
    await renderer.compileAsync(scene, camera);
    renderer.render(scene, camera);
    const programs = renderer.info.programs.map((program) => {
      const count = gl.getProgramParameter(program.program, gl.ACTIVE_UNIFORMS), samplers = [];
      for (let i = 0; i < count; i++) {
        const uniform = gl.getActiveUniform(program.program, i);
        if ([gl.SAMPLER_2D, gl.SAMPLER_2D_ARRAY, gl.UNSIGNED_INT_SAMPLER_2D, gl.SAMPLER_2D_SHADOW].includes(uniform.type))
          samplers.push(uniform.name);
      }
      return { linked: gl.getProgramParameter(program.program, gl.LINK_STATUS), samplers };
    });
    const block = daylight.blockLight.store, surface = columns.surfaceLight.store;
    const before = [block.resources(), surface.resources()];
    // Test production store publication, with actual GL tracing after unrelated
    // art texture initialization. No renderer-owned CPU source texture exists.
    const calls = [], original3D = gl.texSubImage3D.bind(gl), original2D = gl.texSubImage2D.bind(gl);
    gl.texSubImage3D = (...a) => { calls.push({ kind: "page", bytes: a[5] * a[6] * a[7], sourceBytes: a[10]?.byteLength }); return original3D(...a); };
    gl.texSubImage2D = (...a) => {
      const source = a.findLast((v) => ArrayBuffer.isView(v));
      calls.push({ kind: "map", bytes: source?.byteLength ?? 0 }); return original2D(...a);
    };
    const code = blockLightPalette.colors.size - 1;
    const data = new Uint8Array(6400); data[0] = code; data[6399] = 71;
    const ticket = block.claim(0, "synthetic:world:epoch:dependency");
    block.publish(ticket, data);
    const flushed = daylight.flush(renderer);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, renderer.properties.get(block.banks[0]).__webglTexture, 0, 0);
    const pixel = new Uint8Array(4);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.deleteFramebuffer(fb);
    daylight.blockLight.world = {};
    daylight.blockLight.spec = columns.spec;
    daylight.blockLight.cx = daylight.blockLight.cz = 0;
    updateBlockLightUniforms(daylight.blockLight, daylight.uniforms, false);
    const sampleMaterial = new T.ShaderMaterial({ uniforms: daylight.uniforms,
      vertexShader: "void main() { gl_Position = vec4(position.xy, 0., 1.); }",
      fragmentShader: `${BLOCK_LIGHT_DECLARATIONS}\nvoid main() {
        gl_FragColor = vec4(blockLightAt(vec3(-1.5, -63.5, -1.5)), 1.0);
      }` });
    const sampleScene = new T.Scene(), plane = new T.PlaneGeometry(2, 2);
    sampleScene.add(new T.Mesh(plane, sampleMaterial));
    renderer.render(sampleScene, camera);
    const decoded = new Uint8Array(4);
    gl.readPixels(4, 4, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, decoded);
    const publicationCalls = calls.splice(0);
    const surfaceData = new Uint8Array(5184);
    for (let i = 0; i <= 16; i++) surfaceData[i] = i;
    surface.publish(surface.claim(0, "surface:world:epoch:dependency"), surfaceData);
    const surfaceUpload = daylight.flush(renderer);
    daylight.uniforms.uSurfaceField.value.set(-64, 384, 25);
    daylight.uniforms.uSurfaceOrigin.value.set(-12, -12);
    daylight.uniforms.uSkyField.value.set(-208, -208, 432);
    const surfaceMaterial = new T.ShaderMaterial({
      uniforms: { ...daylight.uniforms, samplePoint: { value: new T.Vector3() } },
      vertexShader: "void main() { gl_Position = vec4(position.xy, 0., 1.); }",
      fragmentShader: `${DAYLIGHT_DECLARATIONS}
        uniform vec3 samplePoint;
        void main() { gl_FragColor = vec4(vec3(daylightMask(samplePoint).y), 1.0); }`,
    });
    const surfaceScene = new T.Scene();
    surfaceScene.add(new T.Mesh(plane, surfaceMaterial));
    const surfacePixels = [];
    for (let level = 0; level <= 16; level++) {
      surfaceMaterial.uniforms.samplePoint.value.set(level - 0.5, -63.5, -0.5);
      renderer.render(surfaceScene, camera);
      const value = new Uint8Array(4);
      gl.readPixels(4, 4, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, value);
      surfacePixels.push(value[0]);
    }
    const surfaceCalls = calls.splice(0);
    const skyEntry = { heights: new Float32Array(256).fill(-64), serial: 1, complete: true };
    const skySlot = columns.skySlot(-1, -1);
    columns.skyOwners[skySlot] = "-1,-1";
    columns.cache.set("-1,-1", skyEntry);
    columns.skyUploads.set(skySlot, { key: "-1,-1", x: -1, z: -1, entry: skyEntry, stamp: "-1,-1:1" });
    const skyUpload = daylight.flush(renderer);
    surfaceMaterial.uniforms.samplePoint.value.set(-0.5, -63.5, -0.5);
    renderer.render(surfaceScene, camera);
    const skyPixel = new Uint8Array(4);
    gl.readPixels(4, 4, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, skyPixel);
    surfaceMaterial.uniforms.samplePoint.value.set(15.5, -63.5, -0.5);
    const skyCalls = calls.splice(0);
    const extension = gl.getExtension("WEBGL_lose_context");
    const lost = new Promise((resolve) => canvas.addEventListener("webglcontextlost", resolve, { once: true }));
    extension.loseContext();
    await lost;
    // Match the host contract: ordinary scene resources use its generic
    // releaser; packed lighting banks use their own loss/restoration hook.
    releaseLostContextResources(renderer, scene);
    plane.dispose(); sampleMaterial.dispose(); surfaceMaterial.dispose();
    daylight.restoreGPU();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const restored = new Promise((resolve) => canvas.addEventListener("webglcontextrestored", resolve, { once: true }));
    extension.restoreContext();
    await restored;
    calls.length = 0; // Renderer fallback textures belong to context bootstrap.
    daylight.restoreGPU();
    const staleTicketAccepted = block.publish(ticket, data);
    const unavailableBeforeFlush = block.mapping[0] === 0;
    const restoreFrames = [];
    do {
      restoreFrames.push(daylight.flush(renderer));
    } while ((block.queue.size || surface.queue.size) && restoreFrames.length < 5);
    const restoredUpload = restoreFrames.at(-1);
    renderer.render(sampleScene, camera);
    const restoredPixel = new Uint8Array(4);
    gl.readPixels(4, 4, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, restoredPixel);
    renderer.render(surfaceScene, camera);
    const restoredSurface = new Uint8Array(4);
    gl.readPixels(4, 4, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, restoredSurface);
    sampleMaterial.dispose(); surfaceMaterial.dispose(); plane.dispose();
    const output = { programs, meshes: meshes.map((m) => m.name), upload, flushed, calls: publicationCalls,
      pixel: [...pixel], code, decoded: [...decoded], expected: blockLightPalette.decode(code),
      surfacePixels, surfaceUpload, surfaceCalls, restoredSurface: [...restoredSurface], restoreFrames,
      skyPixel: [...skyPixel], skyUpload, skyCalls,
      staleTicketAccepted, unavailableBeforeFlush, restoredPixel: [...restoredPixel], restoredUpload, restoreCalls: calls,
      handle: block.mapping[0], before, after: block.resources(), error: gl.getError(), glErrors };
    daylight.dispose(); columns.dispose(); skins.dispose(); gel.dispose();
    for (const material of Object.values(materials)) material.dispose();
    exterior.dispose(); interior.dispose(); geometry.dispose(); atlas.texture.dispose(); atlas.emissiveTexture.dispose(); renderer.dispose();
    return output;
  });
  t.diagnostic(JSON.stringify(result));
  assert.deepEqual(errors, []);
  assert.equal(result.error, 0);
  assert.deepEqual(result.glErrors, []);
  assert.ok(result.programs.length >= 7);
  assert.ok(result.programs.every((p) => p.linked && p.samplers.length <= 16));
  assert.equal(Math.max(...result.programs.map((p) => p.samplers.filter((s) => /^u(BlockLight|SurfaceLight|SkyCeilings)/.test(s)).length)), 10);
  assert.equal(result.pixel[0], result.code);
  assert.deepEqual(result.decoded.slice(0, 3), result.expected);
  assert.equal(result.staleTicketAccepted, false);
  assert.equal(result.unavailableBeforeFlush, true);
  assert.deepEqual(result.restoredPixel, result.decoded);
  assert.ok(result.restoredUpload.uploadedBytes <= 131072);
  assert.ok(result.restoreFrames.every((frame) => frame.uploadedBytes <= 131072 && frame.copies >= 0));
  assert.deepEqual(result.surfacePixels, Array.from({ length: 17 }, (_, level) => {
    const t = level / 16;
    return Math.round(255 * t * t * (3 - 2 * t));
  }));
  assert.equal(result.restoredSurface[0], 255);
  assert.equal(result.surfaceCalls.reduce((n, c) => n + c.bytes, 0), result.surfaceUpload.uploadedBytes);
  assert.equal(result.skyPixel[0], 255);
  assert.equal(result.skyCalls.reduce((n, c) => n + c.bytes, 0), result.skyUpload.uploadedBytes);
  assert.ok(result.skyCalls.some((c) => c.bytes === 1024));
  assert.equal(result.handle, 258);
  assert.equal(result.after.cpuBankBytes, 0);
  assert.ok(result.calls.every((c) => c.kind !== "page" || c.bytes === 6400 && c.sourceBytes === 6400));
  assert.equal(result.calls.reduce((n, c) => n + c.bytes, 0), result.flushed.uploadedBytes);
});
