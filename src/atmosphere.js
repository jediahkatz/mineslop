import * as THREE from "three";
import { FLUID, isWaterFluid } from "./block-state.js";
import { sampleOutdoorLighting } from "./environment-lighting.js";
import { createFluidQueryView } from "./fluid-query-view.js";
import { createFluidSample, sampleFluidAtPoint } from "./fluid-sampling.js";
import { geometryWorldSpec } from "./geometry-world.js";
import { WORLD_HEIGHT } from "./terrain.js";

const INSPECTION_FOG_LIFT = new THREE.Color("#b8c4bd");

export class Atmosphere {
  constructor(scene, world) {
    this.scene = scene;
    this.world = world;
    this.timeOfDay = 0.3;
    this.dimension = "overworld";
    this.cloudsEnabled = true;
    this.underground = false;
    this.fullbrightInspection = false;
    this.cameraFluid = createFluidSample();
    this.cameraMediumKnown = true;
    this.underwater = false;
    this.inLava = false;
    this._fluidWorld = world;
    this._fluidQuery = createFluidQueryView(world);
    this._cameraPoint = new THREE.Vector3();
    this.sky = new THREE.Mesh(
      new THREE.SphereGeometry(384, 16, 12),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        uniforms: {
          zenith: { value: new THREE.Color("#6bafcf") },
          horizon: { value: new THREE.Color("#d6e6d5") },
          dusk: { value: new THREE.Color("#ecc5a0") },
          warmth: { value: 0.2 },
          sunDirection: { value: new THREE.Vector3(0.5, 0.3, -0.7) },
        },
        vertexShader: `
          varying vec3 vDirection;
          void main() {
            vDirection = normalize(position);
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }`,
        fragmentShader: `
          uniform vec3 zenith, horizon, dusk, sunDirection;
          uniform float warmth;
          varying vec3 vDirection;
          void main() {
            vec3 dir = normalize(vDirection);
            float height = pow(max(dir.y, 0.0), 0.55);
            vec3 color = mix(horizon, zenith, height);
            float glow = pow(max(dot(dir, sunDirection), 0.0), 8.0);
            color = mix(color, dusk, glow * warmth * (1.0 - height * 0.5));
            gl_FragColor = vec4(color, 1.0);
            #include <tonemapping_fragment>
            #include <colorspace_fragment>
          }`,
      })
    );
    this.sky.renderOrder = -100;
    this.sky.frustumCulled = false;
    scene.add(this.sky);
    this.hemi = new THREE.HemisphereLight("#d3e3fb", "#958671", 1.48);
    this.sunlight = new THREE.DirectionalLight("#fff6e7", 2.65);
    this.inspectionLight = new THREE.AmbientLight("#ffffff", 0);
    const shadow = this.sunlight.shadow;
    shadow.mapSize.set(768, 768);
    Object.assign(shadow.camera, {
      left: -35,
      right: 35,
      top: 35,
      bottom: -35,
      near: 1,
      far: 180,
    });
    shadow.camera.updateProjectionMatrix();
    shadow.bias = -0.00015;
    shadow.normalBias = 0.025;
    shadow.autoUpdate = false;
    scene.add(
      this.hemi,
      this.sunlight,
      this.sunlight.target,
      this.inspectionLight
    );

    const glowCanvas = document.createElement("canvas");
    glowCanvas.width = glowCanvas.height = 64;
    const ctx = glowCanvas.getContext("2d");
    const glow = ctx.createRadialGradient(32, 32, 1, 32, 32, 32);
    glow.addColorStop(0, "rgba(255,243,192,.5)");
    glow.addColorStop(0.25, "rgba(255,223,142,.13)");
    glow.addColorStop(1, "rgba(255,223,142,0)");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, 64, 64);
    this.glowTexture = new THREE.CanvasTexture(glowCanvas);
    this.glowTexture.colorSpace = THREE.SRGBColorSpace;
    this.sunGlow = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: this.glowTexture,
        transparent: false,
        opacity: 0.2,
        depthTest: false,
        depthWrite: false,
        fog: false,
        toneMapped: false,
        blending: THREE.AdditiveBlending,
      })
    );
    // The sun already has a square face; keep its halo subordinate to that face.
    this.sunGlow.scale.setScalar(24);
    this.sunGlow.renderOrder = -90;
    this.sun = new THREE.Mesh(
      new THREE.PlaneGeometry(10, 10),
      new THREE.MeshBasicMaterial({
        color: "#fff7d9",
        fog: false,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
      })
    );
    this.moon = new THREE.Mesh(
      new THREE.PlaneGeometry(7, 7),
      new THREE.MeshBasicMaterial({
        color: "#dce9eb",
        fog: false,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
      })
    );
    this.sun.renderOrder = this.moon.renderOrder = -80;
    scene.add(this.sun, this.sunGlow, this.moon);

    const starPositions = [];
    let seed = 492;
    const rand = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    for (let i = 0; i < 320; i++) {
      const azimuth = rand() * Math.PI * 2;
      const y = rand() * 0.92 + 0.05;
      const radius = Math.sqrt(1 - y * y);
      starPositions.push(
        Math.cos(azimuth) * radius * 300,
        y * 300,
        Math.sin(azimuth) * radius * 300
      );
    }
    const starGeometry = new THREE.BufferGeometry();
    starGeometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(starPositions, 3)
    );
    this.stars = new THREE.Points(
      starGeometry,
      new THREE.PointsMaterial({
        color: "#e0ebff",
        size: 0.55,
        transparent: false,
        blending: THREE.AdditiveBlending,
        opacity: 0,
        depthTest: false,
        depthWrite: false,
        fog: false,
      })
    );
    // Keep celestial art in the early opaque queue. Additive materials still
    // blend, but no late transparent sprite can cover terrain beyond 290/300m.
    // This is one render pass, independent of the expanded terrain horizon.
    this.stars.renderOrder = -95;
    scene.add(this.stars);

    this.clouds = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshLambertMaterial({ color: "#fff8e9", flatShading: true }),
      108
    );
    const transform = new THREE.Object3D();
    for (let i = 0; i < 108; i++) {
      const cluster = Math.floor(i / 3);
      const x = (cluster % 6) * 47 - 120;
      const z = Math.floor(cluster / 6) * 47 - 120;
      transform.position.set(
        x + rand() * 15,
        WORLD_HEIGHT + 12 + (cluster % 4) * 3 + (i % 3) * 0.35,
        z + rand() * 12
      );
      transform.scale.set(
        10 + rand() * 18,
        1.3 + rand() * 1.1,
        7 + rand() * 12
      );
      transform.updateMatrix();
      this.clouds.setMatrixAt(i, transform.matrix);
    }
    this.clouds.instanceMatrix.needsUpdate = true;
    this.clouds.frustumCulled = false;
    scene.add(this.clouds);
    this.sunDirection = new THREE.Vector3();
    this.lightDirection = new THREE.Vector3();
    this.outdoorLighting = {};
    this.dayZenith = new THREE.Color("#65a6d4");
    this.nightZenith = new THREE.Color("#0c1532");
    this.dayHorizon = new THREE.Color("#d6e1cf");
    this.nightHorizon = new THREE.Color("#24334e");
    this.warmHorizon = new THREE.Color("#e6c29b");
    this.dayAmbient = new THREE.Color("#d3e3fb");
    this.nightAmbient = new THREE.Color("#a5bce8");
    this.duskAmbient = new THREE.Color("#c5bad7");
    this.dayGround = new THREE.Color("#958671");
    this.nightGround = new THREE.Color("#4b5875");
    this.daySun = new THREE.Color("#fff6e7");
    this.duskSun = new THREE.Color("#ffb66e");
    this.moonLight = new THREE.Color("#b7caff");
    this.daySunDisc = new THREE.Color("#fff7d9");
    this.duskSunDisc = new THREE.Color("#ffd27a");
    this.cloudDay = new THREE.Color("#fff8e9");
    this.cloudNight = new THREE.Color("#7c8ca5");
    this.dimensionZenith = new THREE.Color("#1a142b");
    this.dimensionHorizon = new THREE.Color("#292334");
    this.inspectionFog = new THREE.Color();
    this.waterFog = new THREE.Color("#448f9e");
    this.lavaFog = new THREE.Color("#d66629");
    this.setBiome(null);
  }

  setBiome(biome) {
    this.dimension = biome?.dimension ?? "overworld";
    this.underground = biome?.category === "cave";
    this.waterFog.set(biome?.waterColor ?? "#448f9e");
    const fog = biome?.fogColor;
    this.dayHorizon.set(fog ?? "#d6e1cf");
    this.dayZenith.set("#65a6d4");
    if (this.dimension === "overworld") {
      const temperature = THREE.MathUtils.clamp(
        biome?.temperature ?? 0.6,
        0,
        1
      );
      this.dayZenith
        .set("#609bd1")
        .lerp(new THREE.Color("#79b2d4"), temperature);
      if (biome?.category === "swamp") this.dayZenith.set("#80a7a8");
      if (this.underground) {
        this.dimensionHorizon.set(fog ?? "#36444d").multiplyScalar(0.12);
        this.dimensionZenith.copy(this.dimensionHorizon).multiplyScalar(0.55);
      }
      this.dayGround
        .set("#958671")
        .lerp(new THREE.Color(biome?.grassColor ?? "#7c754a"), 0.16);
      this.hemi.color.copy(this.dayAmbient);
      this.hemi.groundColor.copy(this.dayGround);
    } else {
      this.dimensionHorizon.set(
        fog ?? (this.dimension === "nether" ? "#6a302c" : "#292334")
      );
      this.dimensionZenith
        .copy(this.dimensionHorizon)
        .multiplyScalar(this.dimension === "nether" ? 0.6 : 0.42);
      this.hemi.color.set(this.dimension === "nether" ? "#dfb3a1" : "#c5b8dc");
      this.hemi.groundColor.set(
        this.dimension === "nether" ? "#643a38" : "#68627a"
      );
    }
    this.inspectionFog.copy(
      this.dimension === "overworld" ? this.dayHorizon : this.dimensionHorizon
    );
    if (this.underground) this.inspectionFog.set(fog ?? "#36444d");
    if (this.underground || this.dimension !== "overworld")
      this.inspectionFog.lerp(INSPECTION_FOG_LIFT, 0.25);
  }

  /** Render camera only: never the player's feet or unbobbed physical eye. */
  sampleCameraFluid(camera) {
    if (this._fluidWorld !== this.world) {
      this._fluidWorld = this.world;
      this._fluidQuery = createFluidQueryView(this.world);
    }
    camera.getWorldPosition(this._cameraPoint);
    const sample = sampleFluidAtPoint(
      this._fluidQuery,
      this._cameraPoint,
      this.cameraFluid
    );
    this.cameraMediumKnown = sample.valid && sample.loaded;
    this.underwater = this.cameraMediumKnown && isWaterFluid(sample.fluid);
    this.inLava = this.cameraMediumKnown && sample.fluid === FLUID.LAVA_SOURCE;
    return sample;
  }

  update(_dt, elapsed, position, camera) {
    const angle = (this.timeOfDay - 0.25) * Math.PI * 2;
    this.sunDirection
      .set(Math.cos(angle) * 0.72, Math.sin(angle), -Math.cos(angle) * 0.69)
      .normalize();
    const lighting = sampleOutdoorLighting(
      this.sunDirection.y,
      this.outdoorLighting
    );
    const { daylight, warmth } = lighting;
    const uniforms = this.sky.material.uniforms;
    const overworldSky = this.dimension === "overworld" && !this.underground;
    this.lightDirection
      .copy(this.sunDirection)
      .multiplyScalar(overworldSky ? lighting.keySign : 1);
    if (overworldSky) {
      uniforms.zenith.value
        .copy(this.nightZenith)
        .lerp(this.dayZenith, daylight);
      uniforms.horizon.value
        .copy(this.nightHorizon)
        .lerp(this.dayHorizon, daylight)
        .lerp(this.warmHorizon, warmth * 0.3);
    } else {
      uniforms.zenith.value.copy(this.dimensionZenith);
      uniforms.horizon.value.copy(this.dimensionHorizon);
    }
    if (this.fullbrightInspection && this.underground) {
      // The underground backdrop is the fog boundary, not a night sky. Keep
      // it matched so inspection doesn't reveal a black band at the draw edge.
      uniforms.zenith.value.copy(this.inspectionFog);
      uniforms.horizon.value.copy(this.inspectionFog);
    }
    uniforms.warmth.value = overworldSky ? warmth * 0.65 : 0;
    uniforms.sunDirection.value.copy(this.sunDirection);
    this.scene.fog.color.copy(
      this.fullbrightInspection ? this.inspectionFog : uniforms.horizon.value
    );
    this.sky.position.copy(camera.position);
    this.stars.position.copy(camera.position);
    this.stars.material.opacity = overworldSky
      ? (1 - daylight) * 0.85
      : this.dimension === "end"
        ? 0.65
        : 0;
    this.sun.position
      .copy(camera.position)
      .addScaledVector(this.sunDirection, 290);
    this.sun.quaternion.copy(camera.quaternion);
    this.sun.material.color
      .copy(this.daySunDisc)
      .lerp(this.duskSunDisc, lighting.sunWarmth * 0.6);
    this.sunGlow.position.copy(this.sun.position);
    this.sunGlow.material.opacity = 0.16 + warmth * 0.1;
    this.sun.visible = this.sunGlow.visible =
      overworldSky && this.sunDirection.y > -0.08;
    this.moon.position
      .copy(camera.position)
      .addScaledVector(this.sunDirection, -290);
    this.moon.quaternion.copy(camera.quaternion);
    this.moon.visible = overworldSky && this.sunDirection.y < 0.1;
    this.sunlight.position
      .set(position.x, position.y, position.z)
      .addScaledVector(this.lightDirection, 90);
    this.sunlight.target.position.set(position.x, position.y, position.z);
    this.sunlight.intensity = overworldSky
      ? lighting.keyIntensity
      : this.underground
        ? 0
        : 0.35;
    if (overworldSky) {
      if (lighting.keySign > 0)
        this.sunlight.color
          .copy(this.daySun)
          .lerp(this.duskSun, lighting.sunWarmth);
      else this.sunlight.color.copy(this.moonLight);
      this.hemi.color
        .copy(this.nightAmbient)
        .lerp(this.dayAmbient, daylight)
        .lerp(this.duskAmbient, warmth * 0.28);
      this.hemi.groundColor
        .copy(this.nightGround)
        .lerp(this.dayGround, daylight);
    } else this.sunlight.color.set("#d7c4ce");
    this.hemi.intensity = overworldSky
      ? lighting.hemisphereIntensity
      : this.underground
        ? 0.05
        : 1.55;
    // Lambert divides irradiance by pi: white pi lights every face at its
    // albedo, without directional shading or changing the world clock.
    this.inspectionLight.intensity = this.fullbrightInspection ? Math.PI : 0;
    if (this.fullbrightInspection) {
      this.sunlight.intensity = 0;
      this.hemi.intensity = 0;
    }
    this.clouds.visible = this.cloudsEnabled && overworldSky;
    this.clouds.position.x = camera.position.x + ((elapsed * 0.3) % 47) - 23;
    this.clouds.position.y =
      geometryWorldSpec(this.world, this.dimension).maxY - WORLD_HEIGHT;
    this.clouds.position.z = camera.position.z + Math.sin(elapsed * 0.004) * 5;
    this.clouds.material.color
      .copy(this.cloudNight)
      .lerp(this.cloudDay, daylight);
    this.sampleCameraFluid(camera);
    if (this.underwater || this.inLava)
      this.scene.fog.color.copy(this.inLava ? this.lavaFog : this.waterFog);
    if (this.underwater || this.inLava || !this.cameraMediumKnown) {
      // Renderer owns fog distances/LOD. Match the backdrop and hide celestial
      // art even in inspection mode; an unknown column is not known open sky.
      uniforms.zenith.value.copy(this.scene.fog.color);
      uniforms.horizon.value.copy(this.scene.fog.color);
      uniforms.warmth.value = 0;
      this.sun.visible = this.sunGlow.visible = this.moon.visible = false;
      this.clouds.visible = false;
      this.stars.material.opacity = 0;
    }
  }

  dispose() {
    for (const object of [
      this.sky,
      this.sun,
      this.moon,
      this.sunGlow,
      this.stars,
      this.clouds,
    ]) {
      object.dispose?.();
      object.geometry?.dispose();
      object.material.dispose();
      this.scene.remove(object);
    }
    this.glowTexture.dispose();
    this.sunlight.dispose();
    this.hemi.dispose();
    this.inspectionLight.dispose();
    this.scene.remove(
      this.hemi,
      this.sunlight,
      this.sunlight.target,
      this.inspectionLight
    );
  }
}
