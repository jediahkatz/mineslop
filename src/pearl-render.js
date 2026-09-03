import * as THREE from "three";
import { finitePearlVector } from "./pearl-physics.js";
import { MAX_PLAYER_PEARLS } from "./pearl-save.js";

export const PEARL_TRAIL_POINTS = 6;
export const PEARL_TRAIL_SECONDS = 0.35;
export const MAX_PEARL_RENDER_INSTANCES =
  MAX_PLAYER_PEARLS * (1 + PEARL_TRAIL_POINTS);

function material(trail, texture) {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    toneMapped: false,
    uniforms: {
      trail: { value: trail },
      useTexture: { value: !!texture },
      pearlTexture: { value: texture ?? null },
    },
    vertexShader: `
      varying vec2 pearlUv;
      varying float pearlOpacity;
      void main() {
        pearlUv = uv;
        pearlOpacity = length(instanceMatrix[2].xyz);
        vec4 center = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        // Billboard in view space; XY instance columns retain the sprite spin.
        center.xy += mat2(instanceMatrix[0].xy, instanceMatrix[1].xy) * position.xy;
        gl_Position = projectionMatrix * center;
      }
    `,
    fragmentShader: `
      uniform bool trail;
      uniform bool useTexture;
      uniform sampler2D pearlTexture;
      varying vec2 pearlUv;
      varying float pearlOpacity;
      void main() {
        vec4 color;
        if (trail) {
          vec2 p = abs(floor(pearlUv * 5.0) - vec2(2.0));
          if (p.x + p.y > 2.0) discard;
          color = vec4(mix(vec3(0.40, 0.20, 0.61), vec3(0.71, 0.45, 0.91),
            1.0 - (p.x + p.y) / 3.0), pearlOpacity);
        } else if (useTexture) {
          color = texture2D(pearlTexture, pearlUv);
          if (color.a < 0.1) discard;
        } else {
          // Original stepped teal pearl, dark rim and upper-left glint.
          vec2 p = floor(pearlUv * 12.0) - vec2(5.5);
          float edge = max(abs(p.x), abs(p.y));
          float diamond = abs(p.x) + abs(p.y);
          if (edge > 5.0 || diamond > 7.0) discard;
          vec3 rgb = vec3(0.06, 0.22, 0.25);
          if (edge < 4.5 && diamond < 6.5) rgb = vec3(0.10, 0.47, 0.44);
          if (p.y > -2.0 && p.x < 2.0 && diamond < 5.0) rgb = vec3(0.20, 0.68, 0.58);
          if (p.x < -0.5 && p.x > -3.5 && p.y > 0.5 && p.y < 3.5)
            rgb = vec3(0.65, 0.91, 0.78);
          color = vec4(rgb, 1.0);
        }
        gl_FragColor = color;
        #include <colorspace_fragment>
      }
    `,
  });
}

/**
 * Optional Game adapter: two instanced draws, ONE shared quad, two materials,
 * no per-projectile mesh/material/light/texture allocation. `texture` may be
 * the existing borrowed ITEM.ENDER_PEARL texture; otherwise use original art.
 * Call update(domain.projectiles,{dimension,elapsed}) before rendering.
 * Only this adapter touches THREE. Dispose it separately from the data owner.
 */
export class PearlRenderer {
  constructor(scene, { texture = null } = {}) {
    if (
      !scene ||
      typeof scene.add !== "function" ||
      typeof scene.remove !== "function"
    )
      throw new TypeError("PearlRenderer requires a scene");
    this.scene = scene;
    this.geometry = new THREE.PlaneGeometry(1, 1);
    this.pearlMaterial = material(false, texture);
    this.trailMaterial = material(true, null);
    this.pearls = new THREE.InstancedMesh(
      this.geometry,
      this.pearlMaterial,
      MAX_PLAYER_PEARLS
    );
    this.trails = new THREE.InstancedMesh(
      this.geometry,
      this.trailMaterial,
      MAX_PLAYER_PEARLS * PEARL_TRAIL_POINTS
    );
    this.pearls.name = "Thrown ender pearls";
    this.trails.name = "Ender pearl trails";
    this.pearls.count = this.trails.count = 0;
    this.pearls.frustumCulled = this.trails.frustumCulled = false;
    this.pearls.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.trails.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this._matrix = new THREE.Object3D();
    this._history = new Map();
    this._dimension = null;
    this._disposed = false;
    scene.add(this.pearls, this.trails);
  }

  _instance(mesh, index, position, size, angle, opacity = 1) {
    this._matrix.position.set(position.x, position.y, position.z);
    this._matrix.rotation.set(0, 0, angle);
    this._matrix.scale.set(size, size, opacity);
    this._matrix.updateMatrix();
    mesh.setMatrixAt(index, this._matrix.matrix);
  }

  update(projectiles, { dimension, elapsed = 0 } = {}) {
    if (this._disposed) return false;
    if (dimension !== this._dimension) {
      this._history.clear();
      this._dimension = dimension;
    }
    const live = new Set();
    let pearls = 0;
    let trails = 0;
    const entries = Array.isArray(projectiles) ? projectiles : [];
    for (
      let index = 0;
      index < Math.min(entries.length, MAX_PLAYER_PEARLS);
      index++
    ) {
      const projectile = entries[index];
      if (
        projectile?.dimension !== dimension ||
        !finitePearlVector(projectile.position) ||
        !Number.isSafeInteger(projectile.id) ||
        !Number.isFinite(projectile.age) ||
        !Number.isFinite(projectile.spin)
      )
        continue;
      live.add(projectile.id);
      const angle =
        (projectile.spin / 0x100000000) * Math.PI * 2 +
        (Number.isFinite(elapsed) ? elapsed % (Math.PI * 2) : 0) * 2;
      this._instance(this.pearls, pearls++, projectile.position, 0.25, angle);
      let history = this._history.get(projectile.id);
      // A reload can restore a lower age without changing its persisted id.
      if (!history || projectile.age < history[0].age) {
        history = [];
        this._history.set(projectile.id, history);
      }
      const previous = history[0];
      if (
        !previous ||
        previous.x !== projectile.position.x ||
        previous.y !== projectile.position.y ||
        previous.z !== projectile.position.z
      ) {
        history.unshift({ ...projectile.position, age: projectile.age });
        history.length = Math.min(history.length, PEARL_TRAIL_POINTS);
      }
      for (let i = 0; i < history.length; i++) {
        const point = history[i];
        const fade = 1 - (projectile.age - point.age) / PEARL_TRAIL_SECONDS;
        if (fade <= 0 || i === 0) continue;
        this._instance(
          this.trails,
          trails++,
          point,
          0.085 * fade,
          angle + i,
          Math.min(0.65, fade * 0.65)
        );
      }
    }
    for (const id of this._history.keys())
      if (!live.has(id)) this._history.delete(id);
    this.pearls.count = pearls;
    this.trails.count = trails;
    this.pearls.visible = pearls > 0;
    this.trails.visible = trails > 0;
    this.pearls.instanceMatrix.needsUpdate = true;
    this.trails.instanceMatrix.needsUpdate = true;
    return true;
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this.scene.remove(this.pearls, this.trails);
    this.pearls.dispose();
    this.trails.dispose();
    this.geometry.dispose();
    this.pearlMaterial.dispose();
    this.trailMaterial.dispose();
    this._history.clear();
    // The caller owns any borrowed item texture.
  }
}
