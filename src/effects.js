import * as THREE from "three";
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

  unlockAudio() {
    if (!this.soundEnabled) return;
    try {
      this.audio ??= new (window.AudioContext || window.webkitAudioContext)();
      void this.audio.resume();
    } catch {
      // Audio is optional; restrictive autoplay policies must not block play.
    }
  }

  sound(kind = "mine", id = 3) {
    if (!this.audio || !this.soundEnabled) return;
    const context = this.audio;
    if (kind === "xp") {
      const tone = context.createOscillator();
      const gain = context.createGain();
      tone.type = "sine";
      tone.frequency.value = 850 + Math.min(8, Math.max(1, id)) * 45;
      gain.gain.setValueAtTime(0.07, context.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.14);
      tone.connect(gain).connect(context.destination);
      tone.start();
      tone.stop(context.currentTime + 0.15);
      tone.onended = () => {
        tone.disconnect();
        gain.disconnect();
      };
      return;
    }
    const duration = kind === "step" ? 0.08 : 0.14;
    const length = Math.ceil(context.sampleRate * duration);
    const buffer = context.createBuffer(1, length, context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 2;
    }
    const source = context.createBufferSource();
    source.buffer = buffer;
    const filter = context.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value =
      kind === "place" ? 700 : [1, 2, 4, 6].includes(id) ? 1200 : 2500;
    const gain = context.createGain();
    gain.gain.value = kind === "step" ? 0.055 : 0.13;
    source.connect(filter).connect(gain).connect(context.destination);
    source.start();
    source.onended = () => {
      source.disconnect();
      filter.disconnect();
      gain.disconnect();
    };
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
    void this.audio?.close();
  }
}
