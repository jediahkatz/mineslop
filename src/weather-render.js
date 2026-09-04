import * as THREE from "three";
import { BIOMES } from "./biomes.js";
import { WeatherExposure } from "./weather-exposure.js";
import { precipitationPolicy, weatherHash } from "./weather-state.js";

export const RAIN_PARTICLES = 200;
export const SILENT_WEATHER = Object.freeze({ event: "rain", level: 0 });

// getBiome() samples procedural terrain even for an admitted column. The
// resident byte plane already records its surface biome, including borders.
// Missing/malformed planes are unknown, never an invitation to generate.
function surfaceBiome(world, x, z) {
  if (world._disposed || !world.isLoaded?.(x, z)) return null;
  const cx = Math.floor(x / 16), cz = Math.floor(z / 16);
  const biomes = world.chunks?.get(`${cx},${cz}`)?.biomes;
  if (!(biomes instanceof Uint8Array) || biomes.length !== 256) return null;
  return BIOMES[biomes[(z - cz * 16) * 16 + x - cx * 16]] ?? null;
}

/** One fixed line pool. No textures, timers, audio contexts, or world writes. */
export class WeatherRender {
  constructor(scene) {
    this.scene = scene;
    this.exposure = new WeatherExposure();
    this.positions = new Float32Array(RAIN_PARTICLES * 6);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    geometry.setDrawRange(0, 0);
    this.object = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({
      color: "#b6cedb", transparent: true, opacity: 0.45, depthWrite: false,
    }));
    this.object.frustumCulled = false;
    this.object.visible = false;
    this.disposed = false;
    scene.add(this.object);
  }

  update(world, camera, weather, { mediumKnown = true, submerged = false } = {}) {
    if (this.disposed || !mediumKnown || submerged ||
        world.dimension !== "overworld" || !(weather.intensity > 0) ||
        ![camera?.x, camera?.y, camera?.z, weather.elapsed].every(Number.isFinite))
      return this.hide();
    this.exposure.beginFrame(world);
    const x0 = Math.floor(camera.x), z0 = Math.floor(camera.z);
    const rainAt = (x, z) => precipitationPolicy(surfaceBiome(world, x, z), world.dimension) === "rain";
    const center = rainAt(x0, z0) ? this.exposure.roof(x0, z0) : null;
    const audible = center?.known && center.y + 1 <= camera.y;
    this.object.position.set(x0, camera.y, z0);
    let count = 0;
    for (let column = 0; column < 25; column++) {
      const x = x0 + (column % 5 - 2) * 3;
      const z = z0 + (Math.floor(column / 5) - 2) * 3;
      if (!rainAt(x, z)) continue;
      const roof = this.exposure.roof(x, z);
      if (!roof.known) continue;
      const bottom = Math.max(camera.y - 8, roof.y + 1);
      const height = camera.y + 10 - bottom;
      if (height < 1) continue;
      for (let drop = 0; drop < 8; drop++) {
        const random = (channel) => weatherHash(`${world.seed}:drop:${x},${z}:${drop}:${channel}`);
        const phase = ((random(0) - weather.elapsed * 0.9) % 1 + 1) % 1;
        const px = x - x0 + 0.15 + random(1) * 0.7;
        const pz = z - z0 + 0.15 + random(2) * 0.7;
        const py = bottom - camera.y + phase * (height - 0.7);
        const index = count++ * 6;
        this.positions[index] = px;
        this.positions[index + 1] = py;
        this.positions[index + 2] = pz;
        this.positions[index + 3] = px - 0.08;
        this.positions[index + 4] = py + 0.7;
        this.positions[index + 5] = pz;
      }
    }
    this.object.geometry.setDrawRange(0, count * 2);
    this.object.geometry.attributes.position.needsUpdate = true;
    this.object.material.opacity = Math.min(1, weather.intensity) * 0.45;
    this.object.visible = count > 0;
    return { event: "rain", level: audible ? Math.min(1, weather.intensity) * 0.35 : 0 };
  }

  hide() {
    this.object.visible = false;
    this.object.geometry.setDrawRange(0, 0);
    return SILENT_WEATHER;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.scene.remove(this.object);
    this.object.geometry.dispose();
    this.object.material.dispose();
    this.exposure.clear();
  }
}
