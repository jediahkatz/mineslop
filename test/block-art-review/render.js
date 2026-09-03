import * as THREE from "three";
import { Atmosphere } from "../../src/atmosphere.js";
import { BLOCK } from "../../src/blocks.js";
import { buildChunkGeometry } from "../../src/chunk-mesh.js";
import {
  createHeldItemView,
  disposeHeldItemView,
  selectHeldItem,
  updateHeldItemView,
  usesHeldSprite,
} from "../../src/held-item.js";
import { createChunkMaterials } from "../../src/renderer.js";
import { createAtlas, itemIcon } from "../../src/textures.js";
import { casesFor, fixtureWorld } from "./cases.js";

const UPPER = new THREE.Vector3(3, 2.6, -4).normalize();
const LOWER = new THREE.Vector3(-3, -2.2, 4).normalize();
const WORLD_SIZE = { width: 216, height: 176 };
const HELD_SIZE = { width: 480, height: 270 };
const HELD_CROP = { x: 240, y: 120, width: 240, height: 150 };
const times = { day: 0.4, shadow: 0.4, night: 0.9 };

function canvasCopy(source, crop = null) {
  const canvas = document.createElement("canvas");
  canvas.width = crop?.width ?? source.width;
  canvas.height = crop?.height ?? source.height;
  const context = canvas.getContext("2d");
  context.imageSmoothingEnabled = false;
  if (crop) context.drawImage(source, crop.x, crop.y, crop.width, crop.height,
    0, 0, crop.width, crop.height);
  else context.drawImage(source, 0, 0);
  return canvas;
}

function meshGroup(world, atlas, materials) {
  const group = new THREE.Group();
  const batches = buildChunkGeometry(world, 0, 0, atlas);
  for (const [name, geometry] of Object.entries(batches)) {
    if (!geometry) continue;
    for (const attribute of Object.values(geometry.attributes))
      if (!attribute.array.every(Number.isFinite)) throw new Error("Non-finite mesh attribute");
    const mesh = new THREE.Mesh(geometry, materials[name]);
    mesh.castShadow = name !== "water" && name !== "glass";
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  group.userData.batches = Object.entries(batches).filter(([, value]) => value)
    .map(([name, geometry]) => ({
      name,
      vertices: geometry.getAttribute("position").count,
      triangles: geometry.index.count / 3,
    }));
  return group;
}

function releaseGroup(scene, group) {
  scene.remove(group);
  group.traverse((object) => object.geometry?.dispose());
}

/** One real GPU context, shared atlas/materials, no game loop, workers or saves. */
export function createReviewRenderer(canvas) {
  const renderer = new THREE.WebGLRenderer({
    canvas, antialias: false, alpha: false, preserveDrawingBuffer: true,
  });
  renderer.setPixelRatio(1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.shadowMap.autoUpdate = false;
  const atlas = createAtlas();
  const materials = createChunkMaterials(atlas);
  const roofMaterial = materials.opaque.clone();
  roofMaterial.colorWrite = false;
  roofMaterial.depthWrite = false;
  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog("#c6ced0", 100, 200);
  const emptyWorld = fixtureWorld(casesFor(BLOCK.AIR)[0]).world;
  const atmosphere = new Atmosphere(scene, emptyWorld);
  atmosphere.cloudsEnabled = false;
  atmosphere.fullbrightInspection = false;
  atmosphere.sunlight.castShadow = true;
  // A smaller shadow frustum resolves one review object, not a whole play area.
  Object.assign(atmosphere.sunlight.shadow.camera, {
    left: -7, right: 7, top: 7, bottom: -7,
  });
  atmosphere.sunlight.shadow.camera.updateProjectionMatrix();
  const camera = new THREE.PerspectiveCamera(35, WORLD_SIZE.width / WORLD_SIZE.height, 0.05, 200);
  const heldCamera = new THREE.PerspectiveCamera(75, HELD_SIZE.width / HELD_SIZE.height, 0.05, 200);
  heldCamera.position.set(0, 2, 0);
  scene.add(heldCamera);
  const itemTextures = new Map();
  const heldView = createHeldItemView(heldCamera, atlas, itemTextures);
  let disposed = false;

  function lighting(light, position, view, world) {
    atmosphere.world = world;
    atmosphere.timeOfDay = times[light];
    atmosphere.setBiome(null);
    atmosphere.update(0, 0, position, view);
    // Neutral review plates deliberately omit world scenery, not material light.
    for (const key of ["sky", "stars", "sun", "sunGlow", "moon", "clouds"])
      atmosphere[key].visible = false;
    scene.background = new THREE.Color(light === "night" ? "#172239" : "#c6ced0");
    scene.fog.color.copy(scene.background);
    atmosphere.sunlight.shadow.needsUpdate = true;
    renderer.shadowMap.needsUpdate = true;
  }

  function draw(view, size) {
    renderer.setSize(size.width, size.height, false);
    view.updateProjectionMatrix();
    view.updateMatrixWorld(true);
    renderer.render(scene, view);
    const gl = renderer.getContext();
    const error = gl.getError();
    const failedPrograms = renderer.info.programs.filter(
      (program) => program.diagnostics?.runnable === false,
    ).length;
    if (gl.isContextLost() || error || failedPrograms)
      throw new Error(`GPU failure: lost=${gl.isContextLost()} error=${error} shaders=${failedPrograms}`);
    return {
      triangles: renderer.info.render.triangles,
      calls: renderer.info.render.calls,
      glError: error,
      contextLost: false,
      failedPrograms,
      width: size.width,
      height: size.height,
    };
  }

  return {
    async renderCase(reviewCase, light) {
      if (disposed) throw new Error("Review renderer disposed");
      if (!Object.hasOwn(times, light)) throw new RangeError("Unknown light preset");
      const { world } = fixtureWorld(reviewCase);
      const group = meshGroup(world, atlas, materials);
      scene.add(group);
      const bounds = new THREE.Box3().setFromObject(group);
      if (bounds.isEmpty()) bounds.set(
        new THREE.Vector3(8, 4, 8), new THREE.Vector3(9, 5, 9),
      );
      const center = bounds.getCenter(new THREE.Vector3());
      const span = bounds.getSize(new THREE.Vector3()).length();
      const distance = Math.max(1, span) / (2 * Math.tan(THREE.MathUtils.degToRad(35 / 2))) * 1.25;
      let roof = null;
      const frames = [];
      const images = [];
      try {
        if (light === "shadow") {
          // Actual stone roof casts a GPU shadow. Main-pass color/depth writes
          // are disabled; the shadow depth pass uses the unchanged stone map.
          // Its absence from the plate is declared fixture staging.
          const cells = [];
          for (let x = -2; x <= 2; x++)
            for (let z = -2; z <= 2; z++)
              cells.push({
                id: BLOCK.STONE, state: 0, fluid: 0,
                offset: [x + 2, 4, z - 2], role: "context",
              });
          roof = meshGroup(fixtureWorld({ cells }).world, atlas, {
            ...materials, opaque: roofMaterial,
          });
          scene.add(roof);
        }
        for (const [index, direction] of [UPPER, LOWER].entries()) {
          camera.position.copy(center).addScaledVector(direction, distance);
          camera.lookAt(center);
          camera.updateMatrixWorld(true);
          lighting(light, center, camera, world);
          const frame = draw(camera, WORLD_SIZE);
          frames.push({ ...frame, view: index === 0 ? "upper-north-east" : "lower-south-west" });
          images.push(canvasCopy(canvas));
        }
        group.visible = false;
        if (roof) roof.visible = false;
        if (usesHeldSprite(reviewCase.id) && !itemTextures.has(reviewCase.id)) {
          const texture = await new THREE.TextureLoader().loadAsync(itemIcon(reviewCase.id));
          texture.colorSpace = THREE.SRGBColorSpace;
          texture.magFilter = texture.minFilter = THREE.NearestFilter;
          texture.generateMipmaps = false;
          itemTextures.set(reviewCase.id, texture);
        }
        selectHeldItem(heldView, reviewCase.id);
        updateHeldItemView(heldView, 1, 0, false, true);
        lighting(light, heldCamera.position, heldCamera, emptyWorld);
        // The held crop has no world roof. Its shadow preset explicitly samples
        // production ambient light only; never claim it proves cast hand shadows.
        if (light === "shadow") atmosphere.sunlight.intensity = 0;
        frames.push({ ...draw(heldCamera, HELD_SIZE), view: "held",
          crop: HELD_CROP, shadowMode: light === "shadow" ? "ambient-only" : "none" });
        images.push(canvasCopy(canvas, HELD_CROP));
        heldView.hand.visible = false;
        return {
          images,
          frames,
          batches: group.userData.batches,
          atlasSize: { width: atlas.canvas.width, height: atlas.canvas.height },
          resources: { ...renderer.info.memory },
          shadowCaster: roof ? "25 production stone cells; main-pass color/depth writes disabled" : null,
          heldRepresentation: reviewCase.id === BLOCK.AIR ? "empty-hand"
            : usesHeldSprite(reviewCase.id) ? "production-sprite" : "production-held-cube",
        };
      } finally {
        heldView.hand.visible = false;
        releaseGroup(scene, group);
        if (roof) releaseGroup(scene, roof);
        // No cross-page, unbounded texture cache.
        for (const texture of itemTextures.values()) texture.dispose();
        itemTextures.clear();
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      disposeHeldItemView(heldView);
      for (const texture of itemTextures.values()) texture.dispose();
      for (const material of Object.values(materials)) material.dispose();
      roofMaterial.dispose();
      atmosphere.dispose();
      atlas.texture.dispose();
      atlas.emissiveTexture.dispose();
      renderer.dispose();
    },
  };
}
