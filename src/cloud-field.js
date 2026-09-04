import * as THREE from "three";
import { weatherHash } from "./weather-state.js";

const CELL = 47;
const WIDTH = 6;
export const CLOUD_INSTANCES = 108;

/**
 * Borrows Atmosphere's existing 108-box mesh, never its material/lights/lifetime.
 * A stable 6x6 world-cell window, three cuboids each. Only outgoing cells recycle.
 * Small Float32 instance translations + a double-precision Object3D origin keep
 * cloud detail intact near both world borders.
 */
export class CloudField {
  constructor(seed) {
    this.seed = String(seed);
    this.slots = [];
    this.transform = new THREE.Object3D();
  }

  update(mesh, camera, elapsed, spec) {
    if (!mesh || mesh.instanceMatrix.count !== CLOUD_INSTANCES ||
        ![camera?.x, camera?.z, elapsed, spec?.maxY].every(Number.isFinite))
      return false;
    const wind = elapsed * 0.3;
    const cx = Math.floor((camera.x - wind) / CELL);
    const cz = Math.floor(camera.z / CELL);
    const desired = new Map();
    for (let z = cz - 2; z < cz - 2 + WIDTH; z++)
      for (let x = cx - 2; x < cx - 2 + WIDTH; x++)
        desired.set(`${x},${z}`, { x, z });
    const retained = this.slots.filter((slot) => desired.has(slot.key));
    const occupied = new Set(retained.map((slot) => slot.slot));
    for (const slot of retained) desired.delete(slot.key);
    let free = 0;
    for (const [key, cell] of desired) {
      while (occupied.has(free)) free++;
      retained.push({ key, ...cell, slot: free++ });
    }
    this.slots = retained.sort((a, b) => a.slot - b.slot);
    // Three computes modelView in doubles before uploading. No large absolute
    // world positions ever enter the Float32 instance buffer.
    mesh.position.set(cx * CELL + wind, 0, cz * CELL);
    for (const cell of this.slots) {
      for (let piece = 0; piece < 3; piece++) {
        const random = (channel) => weatherHash(`${this.seed}:cloud:${cell.key}:${piece}:${channel}`);
        this.transform.position.set(
          (cell.x - cx) * CELL + random(0) * 15,
          spec.maxY + 12 + Math.floor(random(1) * 4) * 3 + piece * 0.35,
          (cell.z - cz) * CELL + random(2) * 12,
        );
        this.transform.scale.set(10 + random(3) * 18, 1.3 + random(4) * 1.1, 7 + random(5) * 12);
        this.transform.updateMatrix();
        mesh.setMatrixAt(cell.slot * 3 + piece, this.transform.matrix);
      }
    }
    mesh.instanceMatrix.needsUpdate = true;
    return true;
  }
}
