// Automated GPU fixture, not a visual gallery or a substitute for in-world QA.
// It imports the production rigs, material, and Wildlife batch unchanged.
import * as THREE from "three";
import { createMobModel } from "../src/mob-models.js";
import {
  createMobSkinResources,
  MAX_GEL_INSTANCES,
  MOB_GEL_OPACITY,
} from "../src/mob-skin-atlas.js";
import { paintMobSkinFace } from "../src/mob-skins.js";
import { MAX_MOBS, MOB_SPECIES } from "../src/mob-species.js";
import { Wildlife } from "../src/wildlife.js";
import { flatWorld } from "./mob-fixtures.js";

function probeSlimeLayers(
  renderer,
  scene,
  ambient,
  camera,
  pixels,
  render,
  sampleStats
) {
  const wildlife = new Wildlife(scene, flatWorld(), { autoSpawn: false });
  const difference = (a, b) =>
    a.reduce(
      (max, value, index) => Math.max(max, Math.abs(value - b[index])),
      0
    );
  try {
    const slime = wildlife.spawn("slime", { x: 0, y: 9, z: 0 });
    slime.root.rotation.y = 0;
    const view = (z, targetZ = 0) => {
      camera.left = camera.bottom = -0.8;
      camera.right = camera.top = 0.8;
      camera.far = 30;
      camera.updateProjectionMatrix();
      camera.up.set(0, 1, 0);
      camera.position.set(0, 9.57, z);
      camera.lookAt(0, 9.57, targetZ);
      camera.updateMatrixWorld(true);
      wildlife.hasPlayer = true;
      wildlife.player.copy(camera.position);
      Object.assign(wildlife.context.playerEye, camera.position);
      wildlife.context.playerForward = camera.getWorldDirection(
        new THREE.Vector3()
      );
    };
    const sample = (point) => {
      const projected = point.clone().project(camera);
      const x = Math.max(
        0,
        Math.min(127, Math.floor((projected.x * 0.5 + 0.5) * 128))
      );
      const y = Math.max(
        0,
        Math.min(127, Math.floor((projected.y * 0.5 + 0.5) * 128))
      );
      return [...pixels.subarray((y * 128 + x) * 4, (y * 128 + x) * 4 + 3)];
    };
    view(4);
    wildlife.render(0);
    const nucleus = slime.model.parts.find((part) => part.role === "gel");
    const face = paintMobSkinFace(nucleus.skin, "front");
    let eye;
    for (let y = 0; y < face.height / 2 && !eye; y++) {
      for (let x = 0; x < face.width; x++) {
        const i = (y * face.width + x) * 4;
        if (face.data[i] === 0x35 && face.data[i + 1] === 0x57) {
          eye = new THREE.Vector3(
            (x + 0.5) / face.width - 0.5,
            0.5 - (y + 0.5) / face.height,
            0.5
          ).applyMatrix4(nucleus.node.matrixWorld);
          break;
        }
      }
    }
    if (!eye) throw new Error("The slime nucleus has no inset eye pixels");
    const frame = () => {
      const calls = render();
      return {
        calls,
        edge: sample(new THREE.Vector3(0.43, 9.57, 0)),
        core: sample(new THREE.Vector3(0, 9.57, 0)),
        eye: sample(eye),
        background: sample(new THREE.Vector3(0.7, 9.57, 0)),
        max: sampleStats().max,
      };
    };
    const budget = () => ({
      calls: render(),
      textures: renderer.info.memory.textures,
      geometries: renderer.info.memory.geometries,
      opaqueParts: wildlife.mesh.count,
      gelParts: wildlife.gelMesh?.count ?? 0,
      sharedAtlas:
        !wildlife.gelMesh ||
        wildlife.gelResources.texture === wildlife.skinResources.texture,
    });
    ambient.intensity = Math.PI;
    scene.background.set("#2030e0");
    const litA = frame();
    scene.background.set("#df8020");
    const litB = frame();
    const measuredOpacity =
      1 -
      (litB.edge[0] - litA.edge[0]) / (litB.background[0] - litA.background[0]);
    wildlife.gelMesh.visible = false;
    const bareCore = frame();
    wildlife.gelMesh.visible = true;
    const litBudget = budget();

    scene.background.set(0);
    ambient.intensity = 0;
    const dark = frame();
    slime.hitFlash = 0.2;
    wildlife.render(0);
    const darkDamage = frame();
    ambient.intensity = Math.PI;
    const damage = frame();

    // Two differently tinted, overlapping shells must compose in view-depth
    // order. Reversing spawn order must not change a single rendered pixel.
    const rear = wildlife.spawn("slime", { x: 0, y: 9, z: -2 });
    rear.root.rotation.y = 0;
    wildlife.render(0);
    const overlap = frame();
    const orderedPixels = new Uint8Array(pixels);
    wildlife.entities.reverse();
    wildlife.render(0);
    frame();
    const spawnOrderError = difference(orderedPixels, pixels);

    // A deliberately wrong upload is a negative control, proving that this
    // pixel assertion actually detects alpha-order mistakes, not just metadata.
    for (let i = 0; i < wildlife.gelCount; i++) {
      const record = wildlife.gelInstances[wildlife.gelCount - i - 1];
      wildlife.uploadMobPart(
        wildlife.gelMesh,
        wildlife.gelResources,
        i,
        record.part,
        record.flash,
        record.hitFlash
      );
    }
    wildlife.gelMesh.instanceMatrix.needsUpdate = true;
    wildlife.gelMesh.instanceColor.needsUpdate = true;
    wildlife.gelResources.update();
    const unsorted = frame();
    const unsortedOverlapDifference = difference(overlap.edge, unsorted.edge);
    view(-6, -1);
    wildlife.render(0);
    frame();
    const reverseViewPixels = new Uint8Array(pixels);
    wildlife.entities.reverse();
    wildlife.render(0);
    frame();
    const reverseViewOrderError = difference(reverseViewPixels, pixels);

    view(4);
    slime.hitFlash = 0;
    const cycles = [];
    for (let i = 0; i < 3; i++) {
      for (const mob of wildlife.entities) mob.dormant = true;
      wildlife.render(0);
      const hidden = budget();
      for (const mob of wildlife.entities) mob.dormant = false;
      wildlife.render(0);
      const visible = budget();
      cycles.push({ hidden, visible });
    }
    const gelMesh = wildlife.gelMesh;
    const gelResources = wildlife.gelResources;
    for (let i = wildlife.entities.length; i < MAX_MOBS; i++)
      wildlife.spawn("slime", { x: 4 + i * 1.25, y: 9, z: 0 });
    wildlife.render(0);
    const population = {
      ...budget(),
      count: wildlife.entities.length,
      capacity: wildlife.gelMesh.instanceMatrix.count,
      expectedCapacity: MAX_GEL_INSTANCES,
      sameBatch:
        gelMesh === wildlife.gelMesh && gelResources === wildlife.gelResources,
    };

    // Returning to sulfur-only rendering must free the gel geometry and leave
    // sulfur fully opaque even though gel_cap and the atlas are shared roles.
    for (const mob of [...wildlife.entities]) wildlife.remove(mob);
    const sulfur = wildlife.spawn("sulfur_cube", { x: 0, y: 9, z: 0 });
    sulfur.root.rotation.y = 0;
    wildlife.render(0);
    scene.background.set("#2030e0");
    const sulfurA = frame();
    scene.background.set("#df8020");
    const sulfurB = frame();
    const sulfurBudget = budget();
    return {
      litA,
      litB,
      bareCore,
      litBudget,
      measuredOpacity,
      expectedOpacity: MOB_GEL_OPACITY,
      dark,
      darkDamage,
      damage,
      spawnOrderError,
      reverseViewOrderError,
      unsortedOverlapDifference,
      cycles,
      population,
      sulfurA,
      sulfurB,
      sulfurBudget,
    };
  } finally {
    wildlife.dispose();
    scene.background.set(0);
    ambient.intensity = Math.PI;
  }
}

function probe() {
  const renderer = new THREE.WebGLRenderer({
    antialias: false,
    preserveDrawingBuffer: true,
  });
  renderer.setPixelRatio(1);
  renderer.setSize(128, 128);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0);
  const ambient = new THREE.AmbientLight(0xffffff, Math.PI);
  scene.add(ambient);
  const camera = new THREE.OrthographicCamera(-0.5, 0.5, 0.5, -0.5, 0.1, 10);
  const resources = createMobSkinResources(1);
  const mesh = new THREE.InstancedMesh(
    resources.geometry,
    resources.material,
    1
  );
  mesh.setMatrixAt(0, new THREE.Matrix4());
  mesh.setColorAt(0, new THREE.Color(0xffffff));
  mesh.frustumCulled = false;
  scene.add(mesh);
  const gl = renderer.getContext();
  const pixels = new Uint8Array(128 * 128 * 4);
  const render = () => {
    renderer.render(scene, camera);
    gl.readPixels(0, 0, 128, 128, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    return renderer.info.render.calls;
  };
  const aim = (position, up = [0, 1, 0]) => {
    camera.position.set(...position);
    camera.up.set(...up);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);
  };
  const useSkin = (skin, flash = 0, color = 0xffffff) => {
    resources.write(0, skin, flash);
    resources.update();
    mesh.setColorAt(0, new THREE.Color(color));
    mesh.instanceColor.needsUpdate = true;
  };
  const sampleStats = () => {
    let sum = 0,
      max = 0,
      lit = 0;
    const channels = [0, 0, 0];
    for (let i = 0; i < pixels.length; i += 4) {
      const value =
        pixels[i] * 0.2126 + pixels[i + 1] * 0.7152 + pixels[i + 2] * 0.0722;
      sum += value;
      max = Math.max(max, pixels[i], pixels[i + 1], pixels[i + 2]);
      if (value > 8) lit++;
      for (let channel = 0; channel < 3; channel++)
        channels[channel] += pixels[i + channel];
    }
    return {
      mean: sum / (pixels.length / 4),
      max,
      litFraction: lit / (pixels.length / 4),
      rgb: channels.map((value) => value / (pixels.length / 4)),
    };
  };
  let fixtureDisposed = false;
  try {
    const creeper = createMobModel("creeper").parts.find(
      (part) => part.role === "head"
    ).skin;
    useSkin(creeper);
    let maxTexelError = 0;
    const faceResults = [];
    for (const [face, [position, up]] of [
      [[3, 0, 0]],
      [[-3, 0, 0]],
      [
        [0, 3, 0],
        [0, 0, -1],
      ],
      [
        [0, -3, 0],
        [0, 0, 1],
      ],
      [[0, 0, 3]],
      [[0, 0, -3]],
    ].entries()) {
      aim(position, up);
      const calls = render();
      const expected = paintMobSkinFace(creeper, face);
      for (let y = 0; y < expected.height; y++) {
        for (let x = 0; x < expected.width; x++) {
          const sx = Math.floor(((x + 0.5) / expected.width) * 128);
          const sy = Math.floor((1 - (y + 0.5) / expected.height) * 128);
          for (let channel = 0; channel < 3; channel++) {
            const actual = pixels[(sy * 128 + sx) * 4 + channel];
            const value = expected.data[(y * expected.width + x) * 4 + channel];
            maxTexelError = Math.max(maxTexelError, Math.abs(actual - value));
          }
        }
      }
      faceResults.push({ face, calls, ...sampleStats() });
    }
    aim([0, 0, 3]);
    useSkin(creeper);
    render();
    const lit = sampleStats();
    useSkin(creeper, 0.8, "#fff4de");
    render();
    const fuse = sampleStats();
    useSkin(creeper, 0.7, "#ff7c70");
    render();
    const damage = sampleStats();
    ambient.intensity = 0;
    useSkin(creeper);
    render();
    const dark = sampleStats();
    useSkin(creeper, 0.8, "#fff4de");
    render();
    const darkFuse = sampleStats();
    const enderman = createMobModel("enderman").parts.find(
      (part) => part.role === "head"
    ).skin;
    useSkin(enderman);
    render();
    const eyes = sampleStats();
    aim([0, 0, -3]);
    render();
    const back = sampleStats();

    scene.remove(mesh);
    mesh.dispose();
    resources.dispose();
    fixtureDisposed = true;
    ambient.intensity = Math.PI;
    const species = [];
    for (const [kind, spec] of Object.entries(MOB_SPECIES)) {
      const dimension = Array.isArray(spec.dimension)
        ? spec.dimension[0]
        : spec.dimension;
      const wildlife = new Wildlife(scene, flatWorld({ dimension }), {
        autoSpawn: false,
      });
      try {
        const mob = wildlife.spawn(
          kind,
          { x: 0, y: 9, z: 0 },
          { restoring: true }
        );
        if (!mob) throw new Error(`Failed to create ${kind} for the GPU probe`);
        mob.root.rotation.y = 0;
        mob.moving = true;
        wildlife.render(0.1);
        const extent = Math.max(mob.model.pickRadius, spec.height * 0.6);
        camera.left = camera.bottom = -extent;
        camera.right = camera.top = extent;
        camera.far = 30;
        camera.updateProjectionMatrix();
        camera.position.set(3, 9 + spec.height * 0.6, 4);
        camera.up.set(0, 1, 0);
        camera.lookAt(0, 9 + spec.height * 0.5, 0);
        const calls = render();
        species.push({
          kind,
          calls,
          parts: wildlife.mesh.count + (wildlife.gelMesh?.count ?? 0),
          opaqueParts: wildlife.mesh.count,
          gelParts: wildlife.gelMesh?.count ?? 0,
          texturedPixels: sampleStats().litFraction,
          textures: renderer.info.memory.textures,
          geometries: renderer.info.memory.geometries,
        });
      } finally {
        wildlife.dispose();
      }
    }
    const gel = probeSlimeLayers(
      renderer,
      scene,
      ambient,
      camera,
      pixels,
      render,
      sampleStats
    );
    return {
      maxTexelError,
      faceResults,
      lit,
      fuse,
      damage,
      dark,
      darkFuse,
      eyes,
      back,
      species,
      gel,
      remainingTextures: renderer.info.memory.textures,
      remainingGeometries: renderer.info.memory.geometries,
      atlasSize: resources.atlas.size,
      skinCount: resources.atlas.entries.size,
      atlasUsedHeight: resources.atlas.usedHeight,
    };
  } finally {
    scene.remove(mesh);
    if (!fixtureDisposed) mesh.dispose();
    resources.dispose();
    renderer.dispose();
  }
}

try {
  globalThis.__mobSkinGpuProbe = { result: probe(), error: null };
} catch (error) {
  globalThis.__mobSkinGpuProbe = {
    result: null,
    error: error.stack ?? String(error),
  };
}
