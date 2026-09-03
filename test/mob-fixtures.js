import * as THREE from "three";
import { BLOCK, isSolid } from "../src/blocks.js";
import { WORLD_HEIGHT } from "../src/terrain.js";
import { Wildlife } from "../src/wildlife.js";

export function flatWorld({
  height = 8,
  biome = "plains",
  dimension = "overworld",
  loaded = () => true,
  terrain = () => height,
  water = () => -1,
} = {}) {
  const edits = new Map();
  return {
    seed: "ecosystem-test",
    dimension,
    edits,
    unloadedReads: 0,
    isLoaded: loaded,
    heightAt: (x, z) => terrain(x, z),
    getBiome: () => ({ id: biome, dimension }),
    get(x, y, z) {
      if (!this.isLoaded(x, z)) {
        this.unloadedReads++;
        return BLOCK.AIR;
      }
      if (y < 0 || y >= WORLD_HEIGHT) return BLOCK.AIR;
      const edit = edits.get(`${x},${y},${z}`);
      if (edit !== undefined) return edit;
      const top = terrain(x, z);
      if (y <= top) return y === top ? BLOCK.GRASS : BLOCK.STONE;
      return y <= water(x, z) ? BLOCK.WATER : BLOCK.AIR;
    },
    isSolid(x, y, z) {
      return isSolid(this.get(x, y, z));
    },
  };
}

export function ecosystem(world = flatWorld(), options = {}) {
  return new Wildlife(new THREE.Scene(), world, {
    autoSpawn: false,
    ...options,
  });
}

export function advance(
  wildlife,
  seconds,
  player = new THREE.Vector3(0, 9, 0),
  environment = {}
) {
  const frames = Math.ceil(seconds / 0.1);
  for (let i = 0; i < frames; i++) {
    const dt = Math.min(0.1, seconds - i * 0.1);
    wildlife.update(dt, wildlife.clock + dt, player, {
      timeOfDay: 0,
      mode: "survival",
      ...environment,
    });
  }
}

export function wall(world, x, bottom = 9, top = 15) {
  for (let y = bottom; y <= top; y++) {
    for (let z = -8; z <= 8; z++)
      world.edits.set(`${x},${y},${z}`, BLOCK.STONE);
  }
}
