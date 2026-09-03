import * as THREE from "three";
import { AudioEngine } from "./audio-engine.js";
import { BLOCKS } from "./blocks.js";
import {
  createHeldItemView,
  disposeHeldItemView,
  selectHeldItem,
  updateHeldItemView,
} from "./held-item.js";
import { createAtlas } from "./textures.js";

/** Recycled particles and quiet, synthesized effects: no downloaded assets. */
export class Effects {
  constructor(scene, camera) {
    this.scene = scene;
    this.camera = camera;
    this.audioEngine = new AudioEngine();
    this.audioListener = {
      position: new THREE.Vector3(),
      right: new THREE.Vector3(),
    };
    this.soundEnabled = true;
    this.audio = null;
    this.particles = [];
    this.arrows = [];
    this.arrowGeometry = new THREE.BoxGeometry(0.035, 0.035, 0.55);
    this.arrowMaterial = new THREE.MeshBasicMaterial({ color: "#e4d5b1" });
    this.geometry = new THREE.BoxGeometry(0.075, 0.075, 0.075);
    this.material = new THREE.MeshLambertMaterial();
    this.mesh = new THREE.InstancedMesh(this.geometry, this.material, 160);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    scene.add(this.mesh);
    this.matrix = new THREE.Object3D();
    this.color = new THREE.Color();
    this.atlas = createAtlas();
    this.itemTextures = new Map();
    Object.assign(
      this,
      createHeldItemView(camera, this.atlas, this.itemTextures)
    );
    this.offhand = createHeldItemView(
      camera,
      this.atlas,
      this.itemTextures,
      true
    );
    scene.add(camera);
  }

  get soundEnabled() {
    return this._soundEnabled;
  }

  set soundEnabled(enabled) {
    this._soundEnabled = Boolean(enabled);
    this.audioEngine?.setEnabled(this._soundEnabled);
  }

  unlockAudio() {
    if (this._disposed || !this.soundEnabled) return Promise.resolve(false);
    const ready = this.audioEngine?.unlock() ?? Promise.resolve(false);
    this.audio = this.audioEngine?.context ?? null;
    return ready;
  }

  /** See AUDIO.md: animal/species and horse-step/block accept position or distance/pan. */
  sound(kind = "mine", id = 3, options = {}) {
    if (this._disposed || !this.soundEnabled) return false;
    let listener = null;
    if (options?.position !== undefined) {
      this.camera.getWorldPosition(this.audioListener.position);
      this.audioListener.right.setFromMatrixColumn(this.camera.matrixWorld, 0);
      listener = this.audioListener;
    }
    return this.audioEngine?.play(kind, id, options, listener) ?? false;
  }

  audioDiagnostics() {
    return this.audioEngine?.diagnostics();
  }

  select(id) {
    selectHeldItem(this, id);
  }

  selectOffhand(id) {
    selectHeldItem(this.offhand, id);
  }

  burst(hit) {
    const base = new THREE.Color(BLOCKS[hit.id]?.color ?? "#aaa");
    for (let i = 0; i < 20; i++) {
      if (this.particles.length >= 160) this.particles.shift();
      this.particles.push({
        x: hit.x + Math.random(),
        y: hit.y + Math.random(),
        z: hit.z + Math.random(),
        vx: (Math.random() - 0.5) * 3.5,
        vy: Math.random() * 3 + 1,
        vz: (Math.random() - 0.5) * 3.5,
        life: 0.65 + Math.random() * 0.3,
        color: base.clone().multiplyScalar(0.7 + Math.random() * 0.5),
      });
    }
    this.swing = 1;
  }

  shoot(origin, destination) {
    if (this.arrows.length >= 16) {
      this.scene.remove(this.arrows.shift().mesh);
    }
    const start = new THREE.Vector3(origin.x, origin.y - 0.12, origin.z);
    const end = new THREE.Vector3(destination.x, destination.y, destination.z);
    const mesh = new THREE.Mesh(this.arrowGeometry, this.arrowMaterial);
    mesh.position.copy(start);
    mesh.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 0, -1),
      end.clone().sub(start).normalize()
    );
    this.scene.add(mesh);
    this.arrows.push({
      mesh,
      start,
      end,
      age: 0,
      duration: Math.max(0.1, start.distanceTo(end) / 45),
    });
    this.swing = 1;
  }

  update(dt, elapsed, moving, visible, use) {
    this.mesh.position
      .copy(this.camera.position)
      .divideScalar(16)
      .floor()
      .multiplyScalar(16);
    updateHeldItemView(this, dt, elapsed, moving, visible, use);
    if (this.offhand)
      updateHeldItemView(this.offhand, dt, elapsed, moving, visible, use);
    this.arrows = this.arrows.filter((arrow) => {
      arrow.age += dt;
      if (arrow.age > arrow.duration + 0.15) {
        this.scene.remove(arrow.mesh);
        return false;
      }
      arrow.mesh.position.lerpVectors(
        arrow.start,
        arrow.end,
        Math.min(1, arrow.age / arrow.duration)
      );
      return true;
    });
    this.particles = this.particles.filter((particle) => {
      particle.life -= dt;
      return particle.life > 0;
    });
    this.particles.forEach((p, i) => {
      p.vy -= 11 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      this.matrix.position.set(
        p.x - this.mesh.position.x,
        p.y - this.mesh.position.y,
        p.z - this.mesh.position.z
      );
      this.matrix.rotation.set(p.life * 5, p.life * 7, p.life * 3);
      this.matrix.scale.setScalar(Math.min(1, p.life * 4));
      this.matrix.updateMatrix();
      this.mesh.setMatrixAt(i, this.matrix.matrix);
      this.mesh.setColorAt(i, p.color);
    });
    this.mesh.count = this.particles.length;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this.audioEngine?.dispose();
    this.audio = null;
    for (const arrow of this.arrows) this.scene.remove(arrow.mesh);
    this.arrowGeometry.dispose();
    this.arrowMaterial.dispose();
    this.scene.remove(this.mesh);
    this.mesh.dispose();
    this.geometry.dispose();
    this.material.dispose();
    disposeHeldItemView(this);
    if (this.offhand) disposeHeldItemView(this.offhand);
    for (const texture of this.itemTextures.values()) texture.dispose();
    this.atlas.texture.dispose();
    this.atlas.emissiveTexture.dispose();
  }
}
