import * as THREE from "three";
import { Atmosphere } from "./atmosphere.js";
import { FLUID, isWaterFluid } from "./block-state.js";
import { CaveDaylight } from "./cave-daylight.js";
import { buildChunkGeometry } from "./chunk-mesh.js";
import { fluidAtPoint } from "./collision.js";
import { DaylightMaterial } from "./daylight-material.js";
import { DistantTerrain } from "./distant-terrain.js";
import { geometryEpoch, geometryWorldSpec } from "./geometry-world.js";
import {
  LOCAL_LIGHT_LIMITS,
  localLightStyle,
  selectLocalLightSources,
} from "./local-lighting.js";
import { disposeBatches, geometryBytes } from "./mesh-palette.js";
import {
  captureMeshRevision,
  meshRevisionCurrent,
  sectionYs,
} from "./mesh-snapshot.js";
import { createMiningTextures } from "./mining-art.js";
import { raycast } from "./raycast.js";
import { RenderScaleController } from "./render-scale.js";
import {
  cancelSectionColumn,
  clearSectionJobs,
  DETAIL_MESH_LIMITS,
  detailMeshResources,
  rebuildSectionMeshes,
  sectionColumnCovered,
  usesSectionMeshing,
} from "./section-renderer.js";
import { SkyColumns } from "./sky-columns.js";
import { CHUNK_SIZE, WORLD_MAX, WORLD_MIN } from "./terrain.js";
import { createAtlas } from "./textures.js";

export { buildChunkGeometry } from "./chunk-mesh.js";

export const QUALITY = {
  low: {
    pixelRatio: 0.8,
    renderRadius: 2,
    clouds: false,
    shadows: false,
    localLights: 1,
    ripples: false,
  },
  medium: {
    pixelRatio: 1,
    renderRadius: 3,
    clouds: true,
    shadows: false,
    localLights: 1,
    ripples: false,
  },
  high: {
    pixelRatio: 1.25,
    renderRadius: 4,
    clouds: true,
    shadows: true,
    localLights: 2,
    ripples: true,
  },
};
const TARGET_COLOR = new THREE.Color("#000000");

export function qualityFogDistance(radius) {
  return radius * CHUNK_SIZE - 3;
}

export function hasTerrainRoof(world, position) {
  const { maxY } = geometryWorldSpec(world);
  if (position.y >= maxY) return false;
  const x = Math.floor(position.x),
    z = Math.floor(position.z);
  if (
    (typeof world.get !== "function" && typeof world.getCell !== "function") ||
    (world.isLoaded && !world.isLoaded(x, z)) ||
    (world.chunks &&
      !world.chunks.has(
        `${Math.floor(x / CHUNK_SIZE)},${Math.floor(z / CHUNK_SIZE)}`
      ))
  )
    return true;
  // Cave biome labels can also describe an open ravine. Check the real loaded
  // column (including edits), not the generator's pre-carving surface height.
  return (
    raycast(world, position, { x: 0, y: 1, z: 0 }, maxY - position.y, {
      channel: "occlusion",
    }) !== null
  );
}

export function terrainFogRange(camera, groundHeight, near, far) {
  const forward = camera.getWorldDirection(new THREE.Vector3());
  const horizontal = Math.hypot(forward.x, forward.z);
  const clearance = Number.isFinite(groundHeight)
    ? Math.max(0, camera.position.y - groundHeight)
    : 0;
  // Three fog uses -mvPosition.z. Project the ground plane into that axis;
  // horizontal radii alone fog out even the block directly below high flyers.
  const groundDepth = clearance * Math.max(0, -forward.y);
  const farDepth = Math.max(8, far * horizontal);
  return {
    near: groundDepth + Math.min(farDepth - 1, near * horizontal),
    far: groundDepth + farDepth,
  };
}

export function createChunkMaterials(atlas) {
  const common = { map: atlas.texture, vertexColors: true };
  return {
    opaque: new THREE.MeshLambertMaterial(common),
    foliage: new THREE.MeshLambertMaterial({
      ...common,
      alphaTest: 0.4,
      side: THREE.DoubleSide,
    }),
    berryFoliage: new THREE.MeshLambertMaterial({
      ...common,
      emissive: "#ffffff",
      emissiveMap: atlas.emissiveTexture,
      emissiveIntensity: 0.55,
      alphaTest: 0.4,
      side: THREE.DoubleSide,
    }),
    glass: new THREE.MeshLambertMaterial({
      ...common,
      transparent: true,
      opacity: 0.6,
      depthWrite: false,
    }),
    water: new THREE.MeshLambertMaterial({
      ...common,
      transparent: true,
      opacity: 0.72,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
    emissive: new THREE.MeshBasicMaterial({
      ...common,
      alphaTest: 0.35,
      side: THREE.DoubleSide,
    }),
  };
}

export class GameRenderer {
  constructor(container, world) {
    this.container = container;
    this.world = world;
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog("#d6e1cf", 20, 45);
    this.camera = new THREE.PerspectiveCamera(75, 1, 0.05, 512);
    this.renderer = new THREE.WebGLRenderer({
      antialias: false,
      alpha: false,
      powerPreference: "high-performance",
    });
    this.softwareRendering = false;
    try {
      const gl = this.renderer.getContext();
      const info = gl.getExtension("WEBGL_debug_renderer_info");
      const name = info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : "";
      this.softwareRendering =
        /swiftshader|llvmpipe|softpipe|software rasterizer/i.test(name);
    } catch {
      // Privacy-restricted contexts still adapt using their measured frame times.
    }
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.domElement.classList.add("game-canvas");
    this.renderer.domElement.setAttribute(
      "aria-label",
      "Mineslop game world"
    );
    container.appendChild(this.renderer.domElement);
    this.atlas = createAtlas();
    this.materials = createChunkMaterials(this.atlas);
    this.waterTime = { value: 0 };
    this.materials.water.onBeforeCompile = (shader) => {
      if (!QUALITY[this.quality].ripples) return;
      shader.uniforms.uWaterTime = this.waterTime;
      shader.vertexShader =
        `varying vec3 vWaterPosition;\n${shader.vertexShader}`.replace(
          "#include <begin_vertex>",
          "#include <begin_vertex>\nvWaterPosition = position;"
        );
      shader.fragmentShader =
        `uniform float uWaterTime;\nvarying vec3 vWaterPosition;\n${shader.fragmentShader}`.replace(
          "#include <color_fragment>",
          `#include <color_fragment>
          float ripple = sin(vWaterPosition.x * 1.963495 + uWaterTime * 0.8)
            * sin(vWaterPosition.z * 2.356194 - uWaterTime * 0.65);
          diffuseColor.rgb *= 0.99 + ripple * 0.055;`
        );
    };
    this.materials.water.customProgramCacheKey = () =>
      `water-${QUALITY[this.quality].ripples}`;
    this.chunks = new Map();
    this.viewCenter = null;
    this.dimension = world.dimension;
    this.chunkGenerator = world.generator;
    this.chunkEpoch = geometryEpoch(world);
    this.atmosphere = new Atmosphere(this.scene, world);
    this.distant = new DistantTerrain(this.scene, this.world);
    this.localLights = Array.from(
      { length: LOCAL_LIGHT_LIMITS.maxSources },
      () => {
        const light = new THREE.PointLight("#ffce7e", 0, 9, 1.5);
        this.scene.add(light);
        return light;
      }
    );
    this.lightStats = {};
    this.lastLightTime = -Infinity;
    this.shadowDirty = true;
    this.shadowPosition = new THREE.Vector3();
    this.shadowSunDirection = new THREE.Vector3();
    this.lastShadowTime = -Infinity;
    const targetBox = new THREE.BoxGeometry(1.006, 1.006, 1.006);
    this.target = new THREE.LineSegments(
      new THREE.EdgesGeometry(targetBox),
      new THREE.LineBasicMaterial({
        color: TARGET_COLOR,
        transparent: true,
        opacity: 0.65,
        depthWrite: false,
      })
    );
    this.miningTextures = createMiningTextures();
    this.miningOverlay = new THREE.Mesh(
      targetBox.clone(),
      new THREE.MeshBasicMaterial({
        map: this.miningTextures[0],
        transparent: true,
        alphaTest: 0.05,
        depthWrite: false,
      })
    );
    targetBox.dispose();
    this.target.visible = false;
    this.target.renderOrder = 5;
    this.miningOverlay.visible = false;
    this.miningOverlay.renderOrder = 4;
    this.scene.add(this.target, this.miningOverlay);
    this.quality = "medium";
    this.resizeHandler = () => this.resize();
    window.addEventListener("resize", this.resizeHandler);
    this.setQuality("medium");
    this.setBiome(
      world.getBiome?.(this.camera.position.x, this.camera.position.z)
    );
    this.atmosphere.update(0, 0, this.camera.position, this.camera);
  }

  get timeOfDay() {
    return this.atmosphere.timeOfDay;
  }

  get fullbrightInspection() {
    return this.atmosphere?.fullbrightInspection === true;
  }

  get renderRadius() {
    return QUALITY[this.quality].renderRadius;
  }

  removeChunk(key) {
    cancelSectionColumn(this, key);
    const old = this.chunks.get(key);
    if (!old) return;
    old.traverse((mesh) => mesh.geometry?.dispose());
    this.scene.remove(old);
    this.chunks.delete(key);
    this.meshResourceRevision = (this.meshResourceRevision ?? 0) + 1;
    this.shadowDirty = true;
    this.lastLightTime = -Infinity;
  }

  syncVisibleChunks() {
    const cx = Math.floor(this.camera.position.x / CHUNK_SIZE);
    const cz = Math.floor(this.camera.position.z / CHUNK_SIZE);
    const center = `${cx},${cz}:${this.renderRadius}:${this.world.dimension}`;
    const changedWorld =
      this.dimension !== this.world.dimension ||
      this.chunkGenerator !== this.world.generator ||
      this.chunkEpoch !== geometryEpoch(this.world);
    if (center === this.viewCenter && !changedWorld) return;
    if (changedWorld) {
      clearSectionJobs(this);
      for (const key of this.chunks.keys()) this.removeChunk(key);
      this.dimension = this.world.dimension;
      this.chunkGenerator = this.world.generator;
      this.chunkEpoch = geometryEpoch(this.world);
    }
    for (const [key, group] of this.chunks) {
      const distance = Math.max(
        Math.abs(group.userData.cx - cx),
        Math.abs(group.userData.cz - cz)
      );
      if (distance > this.renderRadius + 1) this.removeChunk(key);
      else group.visible = distance <= this.renderRadius;
    }
    // Never generate a larger detail ring. Retain already-built buffers for
    // one hidden row so reversing direction can reuse them without a rebuild.
    for (const key of this.world.chunks?.keys() ?? []) {
      const [x, z] = key.split(",").map(Number);
      if (
        Math.max(Math.abs(x - cx), Math.abs(z - cz)) <= this.renderRadius &&
        !this.chunks.has(key)
      )
        this.world.dirtyChunks.add(key);
    }
    this.viewCenter = center;
  }

  rebuildDirty(maxChunks = 2) {
    for (const key of this.world.removedChunks ?? []) {
      this.removeChunk(key);
      if (!this.world.chunks?.has(key)) this.world.dirtyChunks.delete(key);
    }
    this.world.removedChunks?.clear();
    this.syncVisibleChunks();
    if (usesSectionMeshing(this.world))
      return rebuildSectionMeshes(this, maxChunks);
    const cameraX = Math.floor(this.camera.position.x / CHUNK_SIZE);
    const cameraZ = Math.floor(this.camera.position.z / CHUNK_SIZE);
    const pending = [];
    for (const key of this.world.dirtyChunks) {
      const [cx, cz] = key.split(",").map(Number);
      if (
        !Number.isInteger(cx) ||
        !Number.isInteger(cz) ||
        (this.world.chunks && !this.world.chunks.has(key))
      ) {
        this.world.dirtyChunks.delete(key);
        this.removeChunk(key);
        continue;
      }
      const distance = Math.max(Math.abs(cx - cameraX), Math.abs(cz - cameraZ));
      if (distance > this.renderRadius) {
        if (distance > this.renderRadius + 1 || !this.chunks.has(key)) {
          this.world.dirtyChunks.delete(key);
          this.removeChunk(key);
        }
        continue;
      }
      pending.push({
        key,
        cx,
        cz,
        distance: (cx - cameraX) ** 2 + (cz - cameraZ) ** 2,
      });
    }
    pending.sort(
      (a, b) =>
        Number(this.chunks.has(a.key)) - Number(this.chunks.has(b.key)) ||
        a.distance - b.distance
    );
    const budget =
      maxChunks === Infinity
        ? Infinity
        : Math.max(0, Number.isFinite(maxChunks) ? Math.floor(maxChunks) : 2);
    const started = performance.now();
    let rebuilt = 0;
    for (const { key, cx, cz } of pending) {
      if (
        rebuilt >= budget ||
        (budget !== Infinity && rebuilt > 0 && performance.now() - started > 8)
      )
        break;
      const stamps = this.world.dirtySectionRevisions
        ? sectionYs(this.world).map((sy) =>
            captureMeshRevision(this.world, cx, cz, sy)
          )
        : [];
      const geometries = buildChunkGeometry(this.world, cx, cz, this.atlas);
      if (stamps.some((stamp) => !meshRevisionCurrent(this.world, stamp))) {
        disposeBatches(geometries);
        continue;
      }
      const resources = detailMeshResources(this);
      const limits = { ...DETAIL_MESH_LIMITS, ...this.meshLimits };
      let oldBytes = 0,
        oldDraws = 0;
      this.chunks.get(key)?.traverse((mesh) => {
        if (!mesh.isMesh) return;
        oldBytes += geometryBytes(mesh.geometry);
        oldDraws++;
      });
      const newBytes = Object.values(geometries).reduce(
        (sum, geometry) => sum + geometryBytes(geometry),
        0
      );
      const newDraws = Object.values(geometries).filter(Boolean).length;
      if (
        resources.gpuBytes - oldBytes + newBytes > limits.maxGpuBytes ||
        resources.drawCalls - oldDraws + newDraws > limits.maxDrawCalls
      ) {
        disposeBatches(geometries);
        this.meshStats ??= {};
        this.meshStats.budgetRejections =
          (this.meshStats.budgetRejections ?? 0) + 1;
        break;
      }
      this.removeChunk(key);
      const group = new THREE.Group();
      group.position.set(cx * CHUNK_SIZE, 0, cz * CHUNK_SIZE);
      group.userData = {
        cx,
        cz,
        meshed: true,
        emitters: Object.values(geometries).flatMap(
          (geometry) => geometry?.userData.emitters ?? []
        ),
      };
      for (const [name, geometry] of Object.entries(geometries)) {
        if (!geometry) continue;
        const mesh = new THREE.Mesh(geometry, this.materials[name]);
        mesh.castShadow =
          name === "opaque" || name === "foliage" || name === "berryFoliage";
        mesh.receiveShadow = mesh.castShadow;
        mesh.renderOrder = name === "water" ? 2 : name === "glass" ? 1 : 0;
        group.add(mesh);
      }
      this.chunks.set(key, group);
      this.scene.add(group);
      for (const stamp of stamps)
        if (stamp.ticket !== undefined)
          this.world.acknowledgeSectionMesh(cx, cz, stamp.sy, stamp.ticket);
      if (
        stamps.every(
          (stamp) =>
            !this.world.dirtySectionRevisions?.has(`${cx},${cz},${stamp.sy}`)
        )
      )
        this.world.dirtyChunks.delete(key);
      this.shadowDirty = true;
      this.lastLightTime = -Infinity;
      rebuilt++;
    }
    this.meshStats = {
      ...this.meshStats,
      ...detailMeshResources(this),
      lastSliceMs: performance.now() - started,
      pendingColumns: this.world.dirtyChunks.size,
      limits: { ...DETAIL_MESH_LIMITS, ...this.meshLimits },
    };
    return rebuilt;
  }

  detailCoverage() {
    const covered = new Set();
    for (const [key, group] of this.chunks) {
      if (!group.visible || group.parent !== this.scene) continue;
      if (group.userData.sections) {
        if (sectionColumnCovered(group)) covered.add(key);
        continue;
      }
      let draws = false;
      group.traverseVisible((object) => {
        if (!object.isMesh || object.material.visible === false) return;
        const geometry = object.geometry;
        const count =
          geometry.index?.count ??
          geometry.getAttribute("position")?.count ??
          0;
        if (geometry.drawRange.count > 0 && geometry.drawRange.start < count)
          draws = true;
      });
      // An authoritative empty chunk is intentional (void or edits). A queued
      // chunk, hidden group, or placeholder with no mesh is not coverage.
      if (draws || (group.userData.meshed && group.children.length === 0))
        covered.add(key);
    }
    return covered;
  }

  streamingFogDistance(position, coverage = this.detailCoverage()) {
    let distance = qualityFogDistance(this.renderRadius);
    if (!this.world.chunks) return distance;
    const cx = Math.floor(position.x / CHUNK_SIZE),
      cz = Math.floor(position.z / CHUNK_SIZE);
    for (let z = cz - this.renderRadius; z <= cz + this.renderRadius; z++) {
      for (let x = cx - this.renderRadius; x <= cx + this.renderRadius; x++) {
        if (
          x * CHUNK_SIZE < WORLD_MIN ||
          x * CHUNK_SIZE >= WORLD_MAX ||
          z * CHUNK_SIZE < WORLD_MIN ||
          z * CHUNK_SIZE >= WORLD_MAX ||
          coverage.has(`${x},${z}`)
        )
          continue;
        const dx = Math.max(
          x * CHUNK_SIZE - position.x,
          0,
          position.x - (x + 1) * CHUNK_SIZE
        );
        const dz = Math.max(
          z * CHUNK_SIZE - position.z,
          0,
          position.z - (z + 1) * CHUNK_SIZE
        );
        distance = Math.min(distance, Math.hypot(dx, dz) - 2);
      }
    }
    return Math.max(2, distance);
  }

  update(dt, time, playerPosition) {
    const position = playerPosition || this.camera.position;
    this.waterTime.value = time;
    this.syncVisibleChunks();
    this.updateDaylight();
    this.atmosphere.update(dt, time, position, this.camera);
    this.daylightMaterial?.update(this.atmosphere);
    if (
      this.skyAccess &&
      this.atmosphere.sunlight.castShadow !== this.naturalShadowsEnabled()
    )
      this.updateLightingMode();
    this.updateShadows(time, position);
    this.updateLocalLights(time, position);
    const spec = geometryWorldSpec(this.world);
    const medium = fluidAtPoint(this.world, this.camera.position);
    const underwater = isWaterFluid(medium);
    const inLava = medium === FLUID.LAVA_SOURCE;
    const outdoors =
      this.world.dimension === "overworld" && this.skyAccess
        ? this.skyAccess.known && this.skyAccess.skyVisible
        : this.biome?.category !== "cave" ||
          !hasTerrainRoof(this.world, this.camera.position);
    const coverage = this.detailCoverage();
    const nearFog = this.streamingFogDistance(this.camera.position, coverage);
    this.distant.update(this.camera.position, {
      radius: this.renderRadius,
      quality: this.quality,
      dimension: this.world.dimension,
      outdoors,
      coverage,
      budgetMs: this.quality === "high" ? 2 : 1,
    });
    const horizonVisible =
      this.distant.ready && !underwater && !inLava &&
      this.atmosphere.cameraMediumKnown !== false;
    this.distant.group.visible = horizonVisible;
    const targetFar = horizonVisible
      ? Math.max(nearFog, this.distant.fogDistance)
      : nearFog;
    const fogDt = Math.max(0, Math.min(0.1, time - (this.lastFogTime ?? time)));
    this.lastFogTime = time;
    this.expandedFog =
      this.expandedFog === undefined || targetFar <= this.expandedFog
        ? targetFar
        : THREE.MathUtils.lerp(
            this.expandedFog,
            targetFar,
            Math.min(1, fogDt * 5)
          );
    const horizontalFar = this.expandedFog;
    const dimensionScale = this.biome?.dimension === "nether" ? 0.8 : 1;
    const horizontalNear = Math.min(
      horizontalFar * 0.38,
      (horizonVisible ? qualityFogDistance(this.renderRadius) : nearFog) * 0.9
    );
    const columnX = Math.floor(this.camera.position.x);
    const columnZ = Math.floor(this.camera.position.z);
    // A ravine can remove the generator's nominal roof. Use the loaded ground
    // (a bounded world-spec scan) so the visible floor, not that old roof,
    // supplies the high-flight depth offset. Unknown columns use native LOD.
    const loadedTop =
      outdoors && this.world.dimension !== "nether"
        ? this.world.surfaceYAt
          ? this.world.surfaceYAt(columnX, columnZ)
          : this.world.heightAt?.(columnX, columnZ)
        : undefined;
    const validLoadedTop =
      Number.isFinite(loadedTop) && (this.world.surfaceYAt || loadedTop >= 0);
    const top = validLoadedTop
      ? loadedTop
      : this.world.generator?.terrainHeight?.(columnX, columnZ);
    const validTop = Number.isFinite(top) && top >= spec.minY;
    const groundHeight = validTop
      ? Math.max(
          top + 1,
          this.world.dimension === "overworld" && Number.isFinite(spec.seaLevel)
            ? spec.seaLevel + 0.88
            : -Infinity
        )
      : undefined;
    const fog =
      outdoors && this.world.dimension !== "nether"
        ? terrainFogRange(
            this.camera,
            groundHeight,
            horizontalNear,
            horizontalFar
          )
        : { near: horizontalNear, far: horizontalFar };
    this.scene.fog.near =
      underwater || inLava ? 0.2 : fog.near * dimensionScale;
    this.scene.fog.far = inLava
      ? 4
      : underwater
        ? Math.min(20, horizontalFar)
        : fog.far * dimensionScale;
    const cameraFar = Math.max(
      512,
      Math.ceil((this.scene.fog.far + spec.maxY - spec.minY) / 128) * 128
    );
    if (this.camera.far !== cameraFar) {
      this.camera.far = cameraFar;
      this.camera.updateProjectionMatrix();
    }
    if (underwater)
      this.scene.fog.color.set(this.biome?.waterColor ?? "#448f9e");
    if (inLava) this.scene.fog.color.set("#d66629");
    // Visibility was fixed before taking the coverage snapshot. Do not cull
    // another detail row by horizontal fog after cutting its fallback away;
    // Three's mesh frustum culling still handles off-screen geometry.
  }

  updateDaylight() {
    if (!this.atmosphere.setSkyAccess) return;
    if (!this.skyColumns) {
      this.skyColumns = new SkyColumns();
      this.caveDaylight = new CaveDaylight(this.skyColumns);
      this.daylightMaterial = new DaylightMaterial(this.skyColumns);
      this.daylightPosition = new THREE.Vector3();
      this.daylightForward = new THREE.Vector3();
      for (const material of Object.values(this.materials))
        this.daylightMaterial.install(material);
      this.distant?.setDaylight?.(this.daylightMaterial);
    }
    this.camera.getWorldPosition(this.daylightPosition);
    this.camera.getWorldDirection(this.daylightForward);
    this.skyColumns.begin(this.world);
    if (this.world.dimension === "overworld")
      this.skyColumns.updateField(this.daylightPosition, this.renderRadius);
    this.skyAccess = this.caveDaylight.sample(
      this.world,
      this.daylightPosition,
      this.daylightForward
    );
    this.atmosphere.setSkyAccess(
      this.skyAccess,
      this.world.dimension === "overworld"
        ? this.world.getBiome?.(
            Math.floor(this.daylightPosition.x),
            Math.floor(this.daylightPosition.z)
          )
        : undefined
    );
  }

  updateLocalLights(time, position) {
    if (
      this.fullbrightInspection ||
      time - this.lastLightTime < LOCAL_LIGHT_LIMITS.refreshSeconds
    )
      return;
    this.lastLightTime = time;
    const count = QUALITY[this.quality].localLights;
    this.lightStats ??= {};
    const sources = selectLocalLightSources(
      this.chunks,
      position,
      count,
      this.localLights.map((light) => light.userData.emitter),
      this.lightStats
    );
    for (let i = 0; i < this.localLights.length; i++) {
      const source = sources[i];
      const light = this.localLights[i];
      const style = source ? localLightStyle(source.id) : null;
      light.userData.emitter = source ?? null;
      light.intensity = style?.intensity ?? 0;
      if (!style) continue;
      light.position.set(source.x, source.y, source.z);
      light.distance = style.distance;
      light.color.set(style.color);
    }
  }

  updateShadows(time, position) {
    if (
      !this.atmosphere.sunlight.castShadow ||
      time - this.lastShadowTime < 0.75
    )
      return;
    const sunlight = this.atmosphere.sunlight;
    const sunDirection =
      this.atmosphere.lightDirection ?? this.atmosphere.sunDirection;
    const moved = this.shadowPosition.distanceToSquared(position) > 9;
    const sunChanged =
      time - this.lastShadowTime >= 5 &&
      this.shadowSunDirection.distanceToSquared(sunDirection) > 0.000001;
    if (!this.shadowDirty && !moved && !sunChanged) return;
    // Refresh the matrix and map together, with a cap even while chunks stream.
    this.shadowPosition.copy(position);
    this.shadowSunDirection.copy(sunDirection);
    this.lastShadowTime = time;
    this.shadowDirty = false;
    sunlight.shadow.needsUpdate = true;
    this.renderer.shadowMap.needsUpdate = true;
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }

  resize({ resetScale = false } = {}) {
    const width = this.container.clientWidth || window.innerWidth;
    const height = this.container.clientHeight || window.innerHeight;
    const maxRatio = Math.min(
      window.devicePixelRatio || 1,
      QUALITY[this.quality].pixelRatio
    );
    const changed =
      width !== this.viewportWidth ||
      height !== this.viewportHeight ||
      maxRatio !== this.ratioCap;
    if (!changed && !resetScale && this.scaleController) return;
    const initialRatio = this.softwareRendering
      ? Math.max(
          Math.min(0.5, maxRatio),
          Math.min(maxRatio, Math.sqrt(750000 / (width * height)))
        )
      : maxRatio;
    const options = { width, height, maxRatio, pixelRatio: initialRatio };
    if (this.scaleController) this.scaleController.reset(options);
    else this.scaleController = new RenderScaleController(options);
    this.viewportWidth = width;
    this.viewportHeight = height;
    this.ratioCap = maxRatio;
    this.renderer.setPixelRatio(this.scaleController.pixelRatio);
    this.camera.aspect = width / Math.max(height, 1);
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  }

  observeFrame(frameMs, state = {}) {
    if (!this.scaleController) return null;
    const change = this.scaleController.observe(frameMs, state);
    if (change) this.renderer.setPixelRatio(change.pixelRatio);
    return change;
  }

  setTime(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return;
    const next = ((numeric % 1) + 1) % 1;
    const difference = Math.abs(next - this.atmosphere.timeOfDay);
    if (Math.min(difference, 1 - difference) > 0.01) this.shadowDirty = true;
    this.atmosphere.timeOfDay = next;
    this.atmosphere.update(
      0,
      this.waterTime.value,
      this.camera.position,
      this.camera
    );
    this.daylightMaterial?.update(this.atmosphere);
  }

  setFullbrightInspection(enabled) {
    const next = enabled === true;
    if (this.fullbrightInspection === next) return next;
    this.atmosphere.fullbrightInspection = next;
    this.updateLightingMode();
    const position = this.atmosphere.sunlight.target.position;
    this.atmosphere.update(0, this.waterTime.value, position, this.camera);
    this.daylightMaterial?.update(this.atmosphere);
    this.updateLocalLights(this.waterTime.value, position);
    return next;
  }

  naturalShadowsEnabled() {
    return (
      !this.fullbrightInspection &&
      QUALITY[this.quality].shadows &&
      this.atmosphere.dimension === "overworld" &&
      (this.skyAccess ? this.skyAccess.exposure > 0 : !this.atmosphere.underground)
    );
  }

  updateLightingMode() {
    const settings = QUALITY[this.quality];
    const sunlight = this.atmosphere.sunlight;
    const shadows = this.naturalShadowsEnabled();
    if (shadows && !sunlight.castShadow) {
      this.shadowDirty = true;
      this.lastShadowTime = -Infinity;
      sunlight.shadow.needsUpdate = true;
      this.renderer.shadowMap.needsUpdate = true;
    } else if (!shadows) {
      sunlight.shadow.needsUpdate = false;
      this.renderer.shadowMap.needsUpdate = false;
    }
    sunlight.castShadow = shadows;
    this.renderer.shadowMap.enabled = shadows;
    this.localLights.forEach((light, index) => {
      light.visible =
        !this.fullbrightInspection && index < settings.localLights;
      if (!light.visible) light.intensity = 0;
    });
    this.lastLightTime = -Infinity;
  }

  setQuality(quality) {
    const hadRipples = QUALITY[this.quality].ripples;
    this.quality = Object.hasOwn(QUALITY, quality) ? quality : "medium";
    const settings = QUALITY[this.quality];
    this.atmosphere.cloudsEnabled = settings.clouds;
    this.updateLightingMode();
    if (hadRipples !== settings.ripples)
      this.materials.water.needsUpdate = true;
    this.scene.fog.near = qualityFogDistance(this.renderRadius) * 0.38;
    this.scene.fog.far = qualityFogDistance(this.renderRadius);
    this.viewCenter = null;
    this.resize({ resetScale: true });
  }

  setBiome(biome) {
    if (
      biome?.category === "cave" &&
      !hasTerrainRoof(this.world, this.camera.position)
    ) {
      const surface = this.world.getBiome?.(
        Math.floor(this.camera.position.x),
        Math.floor(this.camera.position.z)
      );
      if (surface && surface.category !== "cave") biome = surface;
    }
    if (
      this.biome === biome &&
      this.atmosphere.dimension ===
        (biome?.dimension ?? this.world.dimension ?? "overworld")
    )
      return;
    this.biome = biome ?? null;
    this.atmosphere.setBiome(
      biome ?? { dimension: this.world.dimension ?? "overworld" }
    );
    this.updateLightingMode();
  }

  setTarget(hit, miningProgress = 0) {
    this.target.visible = Boolean(hit);
    const progress = THREE.MathUtils.clamp(
      Number.isFinite(miningProgress) ? miningProgress : 0,
      0,
      1
    );
    this.miningOverlay.visible = Boolean(hit) && progress > 0;
    if (!hit) return;
    const position = hit.block || hit.position || hit;
    const bounds =
      Array.isArray(hit.box) && hit.box.length === 6
        ? hit.box
        : [0, 0, 0, 1, 1, 1];
    const center = [0, 1, 2].map(
      (axis) => (bounds[axis] + bounds[axis + 3]) / 2
    );
    this.target.scale.set(
      bounds[3] - bounds[0],
      bounds[4] - bounds[1],
      bounds[5] - bounds[2]
    );
    if (Array.isArray(position))
      this.target.position.set(
        position[0] + center[0],
        position[1] + center[1],
        position[2] + center[2]
      );
    else
      this.target.position.set(
        position.x + center[0],
        position.y + center[1],
        position.z + center[2]
      );
    this.target.material.color.copy(TARGET_COLOR);
    this.target.material.opacity = 0.65;
    this.miningOverlay.position.copy(this.target.position);
    this.miningOverlay.scale.copy(this.target.scale);
    this.miningOverlay.material.map =
      this.miningTextures[Math.min(9, Math.floor(progress * 10))];
  }

  dispose() {
    clearSectionJobs(this);
    this.distant?.dispose();
    this.skyColumns?.dispose();
    window.removeEventListener("resize", this.resizeHandler);
    for (const key of this.chunks.keys()) this.removeChunk(key);
    for (const material of Object.values(this.materials)) material.dispose();
    this.atlas.texture.dispose();
    this.atlas.emissiveTexture.dispose();
    this.target.geometry.dispose();
    this.target.material.dispose();
    this.miningOverlay.geometry.dispose();
    this.miningOverlay.material.dispose();
    for (const texture of this.miningTextures) texture.dispose();
    for (const light of this.localLights) {
      light.dispose();
      this.scene.remove(light);
    }
    this.scene.remove(this.target, this.miningOverlay);
    this.atmosphere.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
