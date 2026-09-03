import * as THREE from "three";
import { MAX_ACTIVE_BOATS } from "./boat-definitions.js";
import { EXPANSION_WOOD_PALETTES } from "./expansion-art-common.js";

export const MAX_BOAT_RENDER_PARTS = 22;
const hull = Object.freeze([
  [0, 0.09, 0, 1.05, 0.18, 1.3, 2],
  [-0.57, 0.31, 0, 0.14, 0.44, 1.3, 2],
  [0.57, 0.31, 0, 0.14, 0.44, 1.3, 3],
  [0, 0.28, -0.65, 1.05, 0.38, 0.12, 3],
  [0, 0.28, 0.65, 1.05, 0.38, 0.12, 1],
  [0, 0.33, -0.27, 1.03, 0.12, 0.19, 4],
  [0, 0.33, 0.27, 1.03, 0.12, 0.19, 3],
  [-0.575, 0.5, 0, 0.15, 0.045, 1.32, 4],
  [0.575, 0.5, 0, 0.15, 0.045, 1.32, 4],
  [0, 0.47, -0.65, 1.08, 0.04, 0.14, 4],
  [-0.57, 0.29, -0.3, 0.151, 0.025, 0.42, 0],
  [0.57, 0.29, 0.3, 0.151, 0.025, 0.42, 0],
  [0, 0.19, 0, 0.025, 0.015, 1.1, 0],
]);
const raft = Object.freeze([
  ...[-0.48, -0.24, 0, 0.24, 0.48].map((x) => [
    x,
    0.15,
    0,
    0.225,
    0.3,
    1.36,
    2,
  ]),
  [0, 0.325, -0.38, 1.18, 0.055, 0.08, 0],
  [0, 0.325, 0.38, 1.18, 0.055, 0.08, 0],
  ...[-0.48, -0.24, 0, 0.24, 0.48].map((x) => [
    x,
    0.304,
    0.04,
    0.09,
    0.015,
    1.18,
    4,
  ]),
  [0, 0.37, -0.27, 0.96, 0.08, 0.18, 3],
  [0, 0.37, 0.27, 0.96, 0.08, 0.18, 3],
]);

/** One unit-box geometry/material/draw, bounded across every wood and boat. */
export class BoatRenderer {
  constructor(scene) {
    this.scene = scene;
    this.geometry = new THREE.BoxGeometry(1, 1, 1);
    this.material = new THREE.MeshLambertMaterial();
    this.mesh = new THREE.InstancedMesh(
      this.geometry,
      this.material,
      MAX_ACTIVE_BOATS * MAX_BOAT_RENDER_PARTS
    );
    this.mesh.name = "boats-and-rafts";
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.palettes = Object.fromEntries(
      Object.entries(EXPANSION_WOOD_PALETTES).map(([wood, colors]) => [
        wood,
        colors.map((color) => new THREE.Color(color)),
      ])
    );
    this.base = new THREE.Object3D();
    this.part = new THREE.Object3D();
    this.matrix = new THREE.Matrix4();
    this._disposed = false;
    try {
      scene.add(this.mesh);
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  _part(boat, values, rotation = 0) {
    const [x, y, z, sx, sy, sz, shade] = values;
    this.part.position.set(x, y, z);
    this.part.scale.set(sx, sy, sz);
    this.part.rotation.set(0, 0, rotation);
    this.part.updateMatrix();
    this.matrix.multiplyMatrices(this.base.matrix, this.part.matrix);
    this.mesh.setMatrixAt(this.mesh.count, this.matrix);
    this.mesh.setColorAt(this.mesh.count++, this.palettes[boat.wood][shade]);
  }

  render(boats, viewer) {
    if (this._disposed) return;
    this.mesh.count = 0;
    if (!viewer) return;
    this.mesh.position.set(
      Math.floor(viewer.x / 16) * 16,
      Math.floor(viewer.y / 16) * 16,
      Math.floor(viewer.z / 16) * 16
    );
    for (const boat of boats.slice(0, MAX_ACTIVE_BOATS)) {
      this.base.position.set(
        boat.x - this.mesh.position.x,
        boat.y - this.mesh.position.y,
        boat.z - this.mesh.position.z
      );
      this.base.rotation.set(
        0,
        boat.yaw,
        Math.sin(boat.paddlePhase * 2) * (boat.bubbleTime ? 0.025 : 0)
      );
      this.base.updateMatrix();
      for (const part of boat.wood === "bamboo" ? raft : hull)
        this._part(boat, part);
      for (const side of [-1, 1]) {
        const phase = boat.paddlePhase + side * boat.turnVelocity * 0.4;
        const z = Math.sin(phase) * 0.3;
        const tilt = side * (0.48 + Math.cos(phase) * 0.15);
        this._part(boat, [side * 0.76, 0.39, z, 0.62, 0.055, 0.055, 3], tilt);
        this._part(boat, [side * 1.03, 0.22, z, 0.26, 0.06, 0.19, 4], tilt);
      }
    }
    if (this.mesh.count) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.mesh.instanceColor.needsUpdate = true;
    }
  }

  diagnostics() {
    return {
      draws: this._disposed ? 0 : 1,
      materials: this._disposed ? 0 : 1,
      geometries: this._disposed ? 0 : 1,
      textures: 0,
      visibleParts: this.mesh.count,
      capacity: MAX_ACTIVE_BOATS * MAX_BOAT_RENDER_PARTS,
    };
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this.scene.remove(this.mesh);
    this.mesh.dispose();
    this.geometry.dispose();
    this.material.dispose();
    this.mesh.count = 0;
  }
}
