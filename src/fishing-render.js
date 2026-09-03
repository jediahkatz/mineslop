import * as THREE from "three";
import { MAX_FISHING_CASTS } from "./fishing-physics.js";
import { finitePoint } from "./vehicle-water.js";

export const FISHING_LINE_SEGMENTS = 12;
export const MAX_BOBBER_RENDER_PARTS = 7;
export const MAX_FISHING_FEEDBACK = 8;
const FEEDBACK_PARTS = 4;

/** One instanced bobber/bubble draw and one preallocated line-segment draw. */
export class FishingRenderer {
  constructor(scene) {
    this.scene = scene;
    this.geometry = new THREE.BoxGeometry(1, 1, 1);
    this.material = new THREE.MeshBasicMaterial();
    this.bobbers = new THREE.InstancedMesh(
      this.geometry,
      this.material,
      MAX_FISHING_CASTS * MAX_BOBBER_RENDER_PARTS +
        MAX_FISHING_FEEDBACK * FEEDBACK_PARTS
    );
    this.bobbers.name = "fishing-bobbers-and-bite-bubbles";
    this.bobbers.frustumCulled = false;
    this.bobbers.count = 0;
    this.bobbers.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.linePositions = new Float32Array(
      MAX_FISHING_CASTS * FISHING_LINE_SEGMENTS * 2 * 3
    );
    this.lineGeometry = new THREE.BufferGeometry();
    this.lineGeometry.setAttribute(
      "position",
      new THREE.BufferAttribute(this.linePositions, 3).setUsage(
        THREE.DynamicDrawUsage
      )
    );
    this.lineGeometry.setDrawRange(0, 0);
    this.lineMaterial = new THREE.LineBasicMaterial({ color: 0x333b36 });
    this.lines = new THREE.LineSegments(this.lineGeometry, this.lineMaterial);
    this.lines.name = "fishing-lines";
    this.lines.frustumCulled = false;
    this.matrix = new THREE.Object3D();
    this.colors = [0xf4e9d6, 0xce523d, 0x454d45, 0xb9e5ed, 0xb6ed71].map(
      (color) => new THREE.Color(color)
    );
    this._feedback = Array.from({ length: MAX_FISHING_FEEDBACK }, () => ({
      life: 0,
      x: 0,
      y: 0,
      z: 0,
      color: 3,
      dimension: null,
    }));
    this._feedbackCursor = this._feedbackCount = 0;
    this._disposed = false;
    try {
      scene.add(this.bobbers, this.lines);
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  get hasFeedback() {
    return this._feedbackCount > 0;
  }

  event(event) {
    if (
      this._disposed ||
      !finitePoint(event?.position) ||
      !["splash", "bite", "catch", "miss"].includes(event.type)
    )
      return;
    const spark = this._feedback[this._feedbackCursor];
    this._feedbackCursor = (this._feedbackCursor + 1) % MAX_FISHING_FEEDBACK;
    if (spark.life === 0) this._feedbackCount++;
    Object.assign(spark, event.position, {
      life: 0.65,
      dimension: event.dimension,
      color: event.type === "catch" ? 4 : event.type === "miss" ? 2 : 3,
    });
  }

  clearFeedback() {
    for (const spark of this._feedback) spark.life = 0;
    this._feedbackCount = 0;
  }

  _part(x, y, z, sx, sy, sz, color) {
    this.matrix.position.set(
      x - this.bobbers.position.x,
      y - this.bobbers.position.y,
      z - this.bobbers.position.z
    );
    this.matrix.scale.set(sx, sy, sz);
    this.matrix.updateMatrix();
    this.bobbers.setMatrixAt(this.bobbers.count, this.matrix.matrix);
    this.bobbers.setColorAt(this.bobbers.count++, this.colors[color]);
  }

  render(casts, viewer, owners, dt = 0, dimension) {
    if (this._disposed) return;
    this.bobbers.count = 0;
    this.lineGeometry.setDrawRange(0, 0);
    if (!finitePoint(viewer)) return;
    this.bobbers.position.set(
      Math.floor(viewer.x / 16) * 16,
      Math.floor(viewer.y / 16) * 16,
      Math.floor(viewer.z / 16) * 16
    );
    this.lines.position.copy(this.bobbers.position);
    let offset = 0;
    for (const cast of casts.slice(0, MAX_FISHING_CASTS)) {
      const owner = owners.get(cast.ownerId);
      const start = owner?.lineOrigin ?? owner?.eye;
      if (!finitePoint(start)) continue;
      this._part(cast.x, cast.y - 0.025, cast.z, 0.14, 0.09, 0.14, 0);
      this._part(cast.x, cast.y + 0.04, cast.z, 0.14, 0.05, 0.14, 1);
      this._part(cast.x, cast.y + 0.1, cast.z, 0.03, 0.07, 0.03, 2);
      if (cast.phase === "approach") {
        const remaining = cast.remaining / cast.total;
        for (let index = 0; index < 4; index++) {
          const radius = remaining * 2 + index * 0.11;
          const angle =
            cast.approachAngle + Math.sin(remaining * 18 + index) * 0.12;
          this._part(
            cast.x + Math.cos(angle) * radius,
            cast.y + 0.02,
            cast.z + Math.sin(angle) * radius,
            0.045,
            0.015,
            0.045,
            3
          );
        }
      }
      const distance = Math.hypot(
        start.x - cast.x,
        start.y - cast.y,
        start.z - cast.z
      );
      const sag = Math.min(
        0.8,
        distance * (cast.phase === "flying" ? 0.018 : 0.055)
      );
      for (let segment = 0; segment < FISHING_LINE_SEGMENTS; segment++) {
        for (const fraction of [
          segment / FISHING_LINE_SEGMENTS,
          (segment + 1) / FISHING_LINE_SEGMENTS,
        ]) {
          this.linePositions[offset++] =
            start.x + (cast.x - start.x) * fraction - this.lines.position.x;
          this.linePositions[offset++] =
            start.y +
            (cast.y + 0.13 - start.y) * fraction -
            Math.sin(fraction * Math.PI) * sag -
            this.lines.position.y;
          this.linePositions[offset++] =
            start.z + (cast.z - start.z) * fraction - this.lines.position.z;
        }
      }
    }
    if (this.hasFeedback)
      for (const spark of this._feedback) {
        if (!spark.life) continue;
        const step = Number.isFinite(dt) ? Math.max(0, Math.min(0.2, dt)) : 0;
        spark.life = Math.max(0, spark.life - step);
        if (spark.life === 0) {
          this._feedbackCount--;
          continue;
        }
        if (dimension !== undefined && spark.dimension !== dimension) continue;
        const progress = 1 - spark.life / 0.65;
        const radius = 0.1 + progress * 0.55;
        for (let index = 0; index < FEEDBACK_PARTS; index++) {
          const angle = (index * Math.PI) / 2;
          this._part(
            spark.x + Math.cos(angle) * radius,
            spark.y + Math.sin(progress * Math.PI) * 0.35,
            spark.z + Math.sin(angle) * radius,
            0.075 * (1 - progress),
            0.045,
            0.075 * (1 - progress),
            spark.color
          );
        }
      }
    if (this.bobbers.count) {
      this.bobbers.instanceMatrix.needsUpdate = true;
      this.bobbers.instanceColor.needsUpdate = true;
    }
    this.lineGeometry.setDrawRange(0, offset / 3);
    if (offset) this.lineGeometry.attributes.position.needsUpdate = true;
  }

  diagnostics() {
    return {
      draws: this._disposed ? 0 : 2,
      materials: this._disposed ? 0 : 2,
      geometries: this._disposed ? 0 : 2,
      textures: 0,
      visibleParts: this.bobbers.count,
      feedback: this._feedbackCount,
      feedbackCapacity: MAX_FISHING_FEEDBACK,
      lineCapacity: MAX_FISHING_CASTS * FISHING_LINE_SEGMENTS,
    };
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this.scene.remove(this.bobbers, this.lines);
    this.bobbers.dispose();
    this.geometry.dispose();
    this.material.dispose();
    this.lineGeometry.dispose();
    this.lineMaterial.dispose();
    this.bobbers.count = 0;
    this.clearFeedback();
    this.lineGeometry.setDrawRange(0, 0);
  }
}
