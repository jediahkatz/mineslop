import * as THREE from "three";
import { createMobState } from "../src/mob-ai.js";
import { flatWorld } from "./mob-fixtures.js";

export { flatWorld };

/** No models, renderers, saves or live owner installation are needed for AI. */
export function animalMob(kind = "sheep", position = { x: 0.5, y: 9, z: 0.5 }) {
  const root = new THREE.Object3D();
  root.position.copy(position);
  return Object.assign(createMobState(kind, () => 0.5), {
    id: `animal-test:${kind}`,
    root,
    position: root.position,
    home: root.position.clone(),
    groundY: position.y,
  });
}

export function animalContext(world = flatWorld(), changes = {}) {
  return {
    world,
    dimension: world.dimension,
    random: () => 0.5,
    mode: "survival",
    health: 20,
    player: new THREE.Vector3(8, 9, 0.5),
    playerEye: { x: 8, y: 10.62, z: 0.5 },
    timeOfDay: 0,
    time: 0,
    spawnProtected: false,
    wolfTarget: () => null,
    isLookingAt: () => false,
    relocate: () => false,
    cull: (mob) => { mob.dead = true; },
    hurt: () => {},
    damagePlayer: () => {},
    shoot: () => {},
    explodeMob: () => {},
    ...changes,
  };
}
