import * as THREE from "three";
import {
  ecologyCanTarget,
  ecologyDistance,
  ecologyEye,
  ecologyLineOfSight,
  ecologyPoint,
} from "./aquatic-ai.js";
import { sweepCameraDistance } from "./collision.js";
import { finitePosition, footprintLoaded, insideWorld, rayBoxDistance } from "./mob-navigation.js";

export const ECOLOGY_ATTACK_LIMITS = Object.freeze({ beams: 8, projectiles: 12 });
const forward = new THREE.Vector3(0, 0, 1);
const capacity = ECOLOGY_ATTACK_LIMITS.beams + ECOLOGY_ATTACK_LIMITS.projectiles;
const validCharge = (charge) => Number.isFinite(charge) && charge >= 0 && charge <= 1;

/** One lazily allocated, fixed-size batch for beam segments and small blaze
 * fireballs. No textures, point lights, per-shot geometry or ghast explosions.
 * Publication into an earlier render batch is required before damage.
 */
export class EcologyAttackRenderer {
  constructor(group, context) {
    this.group = group;
    this.context = context;
    this.beams = new Map();
    this.projectiles = [];
    this.mesh = null;
    this._disposed = false;
    this._frame = 0;
    this._object = new THREE.Object3D();
    this._direction = new THREE.Vector3();
    this._color = new THREE.Color();
  }

  _ensureResources() {
    if (this.mesh) return true;
    if (this._disposed || !this.group?.isObject3D) return false;
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const material = new THREE.MeshBasicMaterial({ vertexColors: true });
    let mesh;
    try {
      mesh = new THREE.InstancedMesh(geometry, material, capacity);
      mesh.name = "Bounded guardian beams and blaze fireballs";
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.setColorAt(0, this._color);
      mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      mesh.count = 0;
      this.group.add(mesh);
      this.mesh = mesh;
      return true;
    } catch (error) {
      mesh?.dispose();
      geometry.dispose();
      material.dispose();
      throw error;
    }
  }

  _source(mob) {
    return !this._disposed && !!mob && this.context.getMob?.(mob.id) === mob &&
      footprintLoaded(this.context.world, mob.position.x, mob.position.z, mob.spec.radius) &&
      ecologyCanTarget(mob, this.context);
  }

  beam(mob, event) {
    if (event?.phase === "cancel") {
      this.beams.delete(mob.id);
      return true;
    }
    const ctx = this.context;
    if (!["guardian", "elder_guardian"].includes(mob?.kind) ||
      !this._source(mob) || !["charge", "fire"].includes(event?.phase) ||
      !validCharge(event.charge) || !finitePosition(event.from) || !finitePosition(event.to) ||
      ecologyDistance(event.from, event.to) < 2.5 ||
      ecologyDistance(event.from, event.to) > mob.spec.reach ||
      ecologyDistance(event.from, ecologyEye(mob)) > 0.01 ||
      ecologyDistance(event.to, ctx.playerEye) > 0.01 ||
      !ecologyLineOfSight(ctx.world, event.from, event.to)) return false;
    let beam = this.beams.get(mob.id);
    if (event.phase === "fire") {
      // "renderedCharge" was uploaded on a PREVIOUS render, not this update.
      if (event.charge !== 1 || !beam || beam.target !== ctx.playerTargetKey || beam.renderedCharge < 0.9 ||
        beam.renderedFrame < 0 || beam.fired) return false;
      beam.fired = true;
      beam.charge = 1;
      return true;
    }
    if (!beam || beam.target !== ctx.playerTargetKey || beam.fired) {
      if (!beam && this.beams.size >= ECOLOGY_ATTACK_LIMITS.beams) return false;
      if (!this._ensureResources()) return false;
      beam = {
        mob, target: ctx.playerTargetKey, renderedCharge: 0, renderedFrame: -1,
        fired: false, from: ecologyPoint(event.from), to: ecologyPoint(event.to),
      };
      this.beams.set(mob.id, beam);
    }
    beam.from = ecologyPoint(event.from);
    beam.to = ecologyPoint(event.to);
    beam.charge = event.charge;
    return true;
  }

  shootBlaze(mob, shot) {
    const ctx = this.context;
    if (mob?.kind !== "blaze" || !this._source(mob) ||
      this.projectiles.length >= ECOLOGY_ATTACK_LIMITS.projectiles ||
      shot?.kind !== "blaze_fireball" || shot.explosive !== false ||
      shot.speed !== 9 || shot.damage !== mob.spec.damage || shot.fireSeconds !== 4 ||
      shot.lifetime !== 3 || shot.radius !== 0.15 ||
      !finitePosition(shot.from) || !finitePosition(shot.target) ||
      ecologyDistance(shot.from, ecologyEye(mob)) > 0.01 ||
      ecologyDistance(shot.target, ctx.playerEye) > 0.01 ||
      ecologyDistance(shot.from, shot.target) > mob.spec.reach ||
      !ecologyLineOfSight(ctx.world, shot.from, shot.target) || !this._ensureResources())
      return false;
    const distance = ecologyDistance(shot.from, shot.target);
    if (distance < 0.01) return false;
    this.projectiles.push({
      mob, target: ctx.playerTargetKey, position: ecologyPoint(shot.from),
      direction: {
        x: (shot.target.x - shot.from.x) / distance,
        y: (shot.target.y - shot.from.y) / distance,
        z: (shot.target.z - shot.from.z) / distance,
      },
      age: 0, presented: false, damage: shot.damage,
    });
    return true;
  }

  update(dt) {
    const ctx = this.context;
    if (this._disposed || !Number.isFinite(dt) || dt <= 0) return;
    const step = Math.min(dt, 0.1);
    for (const [id, beam] of this.beams) {
      if (!this._source(beam.mob) || beam.target !== ctx.playerTargetKey ||
        !ecologyLineOfSight(ctx.world, beam.from, ctx.playerEye) ||
        (beam.fired && beam.renderedCharge === 1)) this.beams.delete(id);
    }
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const shot = this.projectiles[i];
      if (!this._source(shot.mob) || shot.target !== ctx.playerTargetKey ||
        !insideWorld(shot.position, ctx.world) ||
        !footprintLoaded(ctx.world, shot.position.x, shot.position.z, 0.15)) {
        this.projectiles.splice(i, 1);
        continue;
      }
      // A shot born during one of Wildlife's substeps must first be displayed.
      if (!shot.presented) continue;
      shot.age += step;
      const travel = 9 * step, from = shot.position;
      const wall = sweepCameraDistance(ctx.world, from, shot.direction, travel, 0.15);
      const hit = rayBoxDistance(from, shot.direction, {
        x: ctx.player.x, y: ctx.player.y - 0.15, z: ctx.player.z,
      }, 0.36 + 0.15, ctx.playerHeight + 0.3, travel);
      const playerFirst = hit !== null && hit <= wall + 1e-6;
      if (shot.age >= 3 || wall < travel - 1e-6 || playerFirst) {
        if (shot.age < 3 && playerFirst) ctx.damagePlayer(shot.damage, "Blaze fireball", shot.mob, {
          kind: "blaze_fireball", position: ecologyPoint(from), fireSeconds: 4, explosive: false,
        });
        this.projectiles.splice(i, 1);
      } else {
        from.x += shot.direction.x * travel;
        from.y += shot.direction.y * travel;
        from.z += shot.direction.z * travel;
      }
    }
  }

  _write(index, position, scale, direction, color, anchor) {
    const object = this._object;
    object.position.set(position.x - anchor.x, position.y, position.z - anchor.z);
    object.scale.set(scale.x, scale.y, scale.z);
    object.quaternion.setFromUnitVectors(forward, this._direction.copy(direction).normalize());
    object.updateMatrix();
    this.mesh.setMatrixAt(index, object.matrix);
    this.mesh.setColorAt(index, this._color.set(color));
  }

  render(anchor) {
    if (!this.mesh || this._disposed) return;
    this._frame++;
    anchor = finitePosition(anchor) ? anchor : { x: 0, y: 0, z: 0 };
    const origin = { x: Math.floor(anchor.x / 16) * 16, z: Math.floor(anchor.z / 16) * 16 };
    this.mesh.position.set(origin.x, 0, origin.z);
    let index = 0;
    for (const [id, beam] of this.beams) {
      if (!this._source(beam.mob) || beam.target !== this.context.playerTargetKey ||
        !ecologyLineOfSight(this.context.world, beam.from, beam.to)) {
        this.beams.delete(id);
        continue;
      }
      const length = ecologyDistance(beam.from, beam.to);
      const thickness = 0.025 + beam.charge * 0.07;
      this._write(index++, {
        x: (beam.from.x + beam.to.x) / 2,
        y: (beam.from.y + beam.to.y) / 2,
        z: (beam.from.z + beam.to.z) / 2,
      }, { x: thickness, y: thickness, z: length }, {
        x: beam.to.x - beam.from.x, y: beam.to.y - beam.from.y, z: beam.to.z - beam.from.z,
      }, beam.fired ? "#f2ffa2" : "#64d7c9", origin);
      beam.renderedCharge = beam.charge;
      beam.renderedFrame = this._frame;
    }
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const shot = this.projectiles[i];
      if (!this._source(shot.mob) || shot.target !== this.context.playerTargetKey ||
        !insideWorld(shot.position, this.context.world) ||
        !footprintLoaded(this.context.world, shot.position.x, shot.position.z, 0.15)) {
        this.projectiles.splice(i, 1);
        continue;
      }
      this._write(index++, shot.position, { x: 0.3, y: 0.3, z: 0.3 },
        shot.direction, "#ffd165", origin);
      shot.presented = true;
    }
    this.mesh.count = index;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.instanceColor.needsUpdate = true;
  }

  clearSource(id) {
    this.beams.delete(id);
    this.projectiles = this.projectiles.filter((shot) => shot.mob.id !== id);
  }
  clear() {
    this.beams.clear();
    this.projectiles.length = 0;
    if (this.mesh) this.mesh.count = 0;
  }
  dispose() {
    if (this._disposed) return;
    this.clear();
    this._disposed = true;
    if (!this.mesh) return;
    this.group.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.mesh.dispose();
    this.mesh = null;
  }
}
