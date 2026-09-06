import * as THREE from "three";
import { UNKNOWN_SKY_HEIGHT } from "./sky-columns.js";
import { SURFACE_DAYLIGHT_LIMITS } from "./surface-daylight.js";
import { BlockLightField } from "./block-light-field.js";
import { BLOCK_LIGHT_DECLARATIONS, blockLightUniforms, updateBlockLightUniforms } from "./block-light-material.js";
import { visualStrength } from "./player-visual-effects.js";
import { SURFACE_PAGE_LAYOUT, lightUploadBudget } from "./light-page-layout.js";
import { pageDeclarations, pageUniforms, updatePageUniforms } from "./light-page-material.js";
import { checkedLightTransfer } from "./light-transfer.js";

const sceneDaylight = new WeakMap();
const installations = new WeakMap();
let nextBinding = 0;

// Materials may be created lazily (gel), shared by batches, or moved to a
// replacement world. Resolve the renderer's field at draw time, not creation.
export function applySceneDaylight(scene, material) {
  const daylight = sceneDaylight.get(scene);
  if (daylight) return daylight.install(material);
  const old = installations.get(material);
  if (!old) return;
  // A standalone preview or a disposed scene has no spatial field. Do not
  // keep sampling textures owned by the previous renderer.
  old.owner.installed.delete(material);
  material.onBeforeCompile = old.previous;
  material.customProgramCacheKey = old.cacheKey;
  installations.delete(material);
  material.needsUpdate = true;
}

/** CPU equivalent of the shader's mask, for focused geometry regressions. */
export function sampleDaylightAt(columns, point) {
  const x = Math.floor(point.x) - columns.origin.x;
  const z = Math.floor(point.z) - columns.origin.y;
  if (x < 0 || z < 0 || x >= columns.size || z >= columns.size)
    return { direct: 0, ambient: 0 };
  const cx = Math.floor(point.x / 16), cz = Math.floor(point.z / 16);
  const key = `${cx},${cz}`;
  const entry = columns.cache.get(key);
  const top = entry && !columns.requests.has(key) && columns.skyUploaded[columns.skySlot(cx, cz)] === `${key}:${entry.serial}` ?
    entry.heights[((Math.floor(point.z) % 16 + 16) % 16) * 16 + (Math.floor(point.x) % 16 + 16) % 16] :
    UNKNOWN_SKY_HEIGHT;
  const direct = Number(top !== UNKNOWN_SKY_HEIGHT && point.y >= top);
  // Camera access is deliberately not a surface-light input.
  return { direct, ambient: Math.max(direct, columns.surfaceLight.sample(point)) };
}

export const DAYLIGHT_DECLARATIONS = `
varying vec3 vDaylightPosition;
uniform float uDaylightEnabled;
uniform float uDaylightFogEnabled;
uniform float uPlayerVision;
uniform sampler2D uSkyCeilings;
${pageDeclarations("SurfaceLight", SURFACE_PAGE_LAYOUT)}
uniform vec3 uSurfaceField;
uniform vec2 uSurfaceOrigin;
uniform vec3 uSkyField;
uniform vec3 uDaylightKey, uDaylightSky, uDaylightGround;
uniform vec3 uCaveSky, uCaveGround;
uniform vec3 uCaveFog;

vec2 surfacePage(vec2 cell, float y, vec2 column) {
  if (any(lessThan(column, uSurfaceOrigin)) ||
    any(greaterThanEqual(column, uSurfaceOrigin + uSurfaceField.z))) return vec2(0.0);
  vec2 local = cell - column * 16.0 + 1.0;
  if (any(lessThan(local, vec2(0.0))) || any(greaterThanEqual(local, vec2(18.0)))) return vec2(0.0);
  float slot = mod(column.y, uSurfaceField.z) * uSurfaceField.z + mod(column.x, uSurfaceField.z);
  uint handle = texelFetch(uSurfaceLightPages, ivec2(int(slot), int(floor(y / 16.0))), 0).r;
  if (handle == 0u) return vec2(0.0);
  return vec2(SurfaceLightValue(handle, mod(y, 16.0) * 324.0 + local.y * 18.0 + local.x), 1.0);
}

vec2 daylightMask(vec3 point) {
  #ifdef MINESLOP_EXTERIOR_DAYLIGHT
    return vec2(1.0);
  #else
    vec2 cell = floor(point.xz) - uSkyField.xy;
    if (any(lessThan(cell, vec2(0.0))) || any(greaterThanEqual(cell, vec2(uSkyField.z))))
      return vec2(0.0);
    float skyTiles = uSurfaceField.z + 2.0;
    vec2 skyColumn = mod(floor(point.xz / 16.0), skyTiles);
    int skySlot = int(skyColumn.y * skyTiles + skyColumn.x);
    uint skyReady = texelFetch(uSurfaceLightPages, ivec2(skySlot, int(uSurfaceField.y / 16.0)), 0).r;
    vec2 skyPixel = mod(floor(point.xz), uSkyField.z);
    float ceiling = texture2D(uSkyCeilings, (skyPixel + 0.5) / uSkyField.z).r;
    float directSky = skyReady == 1u ? step(ceiling, point.y) : 0.0;
    float fill = directSky;
    float y = floor(point.y) - uSurfaceField.x;
    if (directSky < 0.5 && y >= 0.0 && y < uSurfaceField.y) {
      vec2 chunk = floor(point.xz / 16.0), pixel = floor(point.xz), local = mod(pixel, 16.0);
      vec2 value = surfacePage(pixel, y, chunk);
      vec2 neighbor = chunk + vec2(local.x < 1.0 ? -1.0 : 1.0, local.y < 1.0 ? -1.0 : 1.0);
      bvec2 edge = bvec2(local.x < 1.0 || local.x >= 15.0, local.y < 1.0 || local.y >= 15.0);
      if (value.y < 0.5 && edge.x) value = surfacePage(pixel, y, vec2(neighbor.x, chunk.y));
      if (value.y < 0.5 && edge.y) value = surfacePage(pixel, y, vec2(chunk.x, neighbor.y));
      if (value.y < 0.5 && edge.x && edge.y) value = surfacePage(pixel, y, neighbor);
      float distance = ${SURFACE_DAYLIGHT_LIMITS.radius.toFixed(1)} - value.x;
      fill = 1.0 - smoothstep(0.0, ${SURFACE_DAYLIGHT_LIMITS.radius.toFixed(1)}, distance);
    }
    return vec2(directSky, fill);
  #endif
}
`;

/**
 * Only natural directional/hemisphere irradiance is spatially masked.
 * Dynamic point lights, emissive art, AO, fluid shaders and Fullbright's white
 * ambient term remain in Three's normal pipeline. Exposed LOD is always lit
 * as exterior terrain, irrespective of the camera's cave classification.
 */
export class DaylightMaterial {
  constructor(columns, scene) {
    this.columns = columns;
    this.scene = scene;
    this.binding = ++nextBinding;
    if (scene) sceneDaylight.set(scene, this);
    this.installed = new WeakSet();
    this.blockLight = new BlockLightField();
    this.uniforms = {
      ...blockLightUniforms(this.blockLight),
      uDaylightEnabled: { value: 0 },
      uDaylightFogEnabled: { value: 0 },
      uPlayerVision: { value: 0 },
      uSkyCeilings: { value: columns.texture },
      ...pageUniforms("SurfaceLight", columns.surfaceLight.store),
      uSurfaceField: { value: new THREE.Vector3() },
      uSurfaceOrigin: { value: new THREE.Vector2() },
      uSkyField: { value: new THREE.Vector3() },
      uDaylightKey: { value: new THREE.Color() },
      uDaylightSky: { value: new THREE.Color() },
      uDaylightGround: { value: new THREE.Color() },
      uCaveSky: { value: new THREE.Color() },
      uCaveGround: { value: new THREE.Color() },
      uCaveFog: { value: new THREE.Color() },
    };
  }

  install(material, exterior = false) {
    if (this.disposed || !material?.isMeshLambertMaterial || this.installed.has(material)) return;
    const existing = installations.get(material);
    existing?.owner.installed.delete(material);
    this.installed.add(material);
    // Rebinding retains the original skin/ripple hook, never another daylight
    // wrapper. A distinct binding key recompiles uniforms for the new owner.
    const previous = existing?.previous ?? material.onBeforeCompile;
    const cacheKey = existing?.cacheKey ?? material.customProgramCacheKey.bind(material);
    installations.set(material, { owner: this, previous, cacheKey });
    material.onBeforeCompile = (shader, renderer) => {
      previous.call(material, shader, renderer);
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = `varying vec3 vDaylightPosition;\n${shader.vertexShader}`.replace(
        "#include <project_vertex>",
        `#include <project_vertex>
        vec4 daylightPosition = vec4(transformed, 1.0);
        #ifdef USE_BATCHING
          daylightPosition = batchingMatrix * daylightPosition;
        #endif
        #ifdef USE_INSTANCING
          daylightPosition = instanceMatrix * daylightPosition;
        #endif
        vDaylightPosition = (modelMatrix * daylightPosition).xyz;`
      );
      const lights = THREE.ShaderChunk.lights_fragment_begin
        .replace(
          "getDirectionalLightInfo( directionalLight, directLight );",
          `getDirectionalLightInfo( directionalLight, directLight );
          if (uDaylightEnabled > 0.5) directLight.color = uDaylightKey * skyMask.x;`
        )
        .replace(
          "irradiance += getHemisphereLightIrradiance( hemisphereLights[ i ], geometryNormal );",
          `HemisphereLight skyLight = hemisphereLights[ i ];
          if (uDaylightEnabled > 0.5) {
            skyLight.skyColor = mix(uCaveSky, uDaylightSky, skyMask.y);
            skyLight.groundColor = mix(uCaveGround, uDaylightGround, skyMask.y);
          }
          if (uPlayerVision > 0.0) {
            vec3 naturalFill = getHemisphereLightIrradiance( skyLight, geometryNormal );
            // A floor, not a multiplier: retain albedo/AO and add voxel light
            // once. Emissive maps and direct lights keep their original path.
            vec3 visionFill = max(naturalFill, vec3(2.4) -
              blockLightAt(vDaylightPosition + daylightNormal * 0.02));
            irradiance += mix(naturalFill, visionFill, uPlayerVision);
          } else {
            irradiance += getHemisphereLightIrradiance( skyLight, geometryNormal );
          }`
        );
      const fog = THREE.ShaderChunk.fog_fragment.replace(
        "gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );",
        `vec3 caveFog = linearToOutputTexel(vec4(uCaveFog, 1.0)).rgb;
        vec3 localFog = uDaylightFogEnabled > 0.5 ? mix(caveFog, fogColor, skyMask.y) : fogColor;
        gl_FragColor.rgb = mix( gl_FragColor.rgb, localFog, fogFactor );`
      );
      shader.fragmentShader =
        `${exterior ? "#define MINESLOP_EXTERIOR_DAYLIGHT\n" : ""}${DAYLIGHT_DECLARATIONS}\n${BLOCK_LIGHT_DECLARATIONS}\n${shader.fragmentShader}`
          .replace(
            "#include <lights_fragment_begin>",
            `vec3 daylightNormal = transformNormalByInverseViewMatrix(normal, viewMatrix);
            vec2 skyMask = daylightMask(vDaylightPosition + daylightNormal * 0.02);
            ${lights}
            #if defined(RE_IndirectDiffuse)
              irradiance += blockLightAt(vDaylightPosition + daylightNormal * 0.02);
            #endif`
          )
          .replace("#include <fog_fragment>", fog);
    };
    material.customProgramCacheKey = () => `${cacheKey()}:daylight-3:${Number(exterior)}:surface-pages-1:block-light-pages-1:player-vision-1:${this.binding}`;
    material.needsUpdate = true;
  }

  dispose() {
    this.disposed = true;
    this.uniforms.uPlayerVision.value = 0;
    this.uniforms.uBlockLightEnabled.value = 0;
    this.blockLight.dispose();
    if (this.scene && sceneDaylight.get(this.scene) === this)
      sceneDaylight.delete(this.scene);
  }

  /** Call once after CPU lighting updates and before ANY scene/hand draw.
   * Invalidation barriers run first even when page publication is exhausted.
   */
  flush(renderer) {
    this.flushFailed = true;
    if (this.disposed || renderer.getContext().isContextLost()) throw new Error("Lighting draw barrier unavailable");
    const budget = lightUploadBudget();
    if (this.uploadedPalette !== this.blockLight.paletteTexture) {
      const palette = this.blockLight.paletteTexture;
      // Palette is the only fixed full upload; count it before any pages.
      palette.source.dataReady = true;
      palette.needsUpdate = true;
      budget.bytes -= 1024; budget.copies--; budget.uploadedBytes += 1024;
      try {
        checkedLightTransfer(renderer, "palette", () => renderer.initTexture(palette));
      } catch (error) {
        // Three may have recorded the texture version even when GL rejected
        // allocation. Discard that GPU object so initTexture really retries.
        palette.dispose();
        throw error;
      }
      this.uploadedPalette = palette;
      this.uniforms.uBlockLightPalette.value = palette;
    }
    const surface = this.columns.surfaceLight.store, block = this.blockLight.store;
    block.flushInvalidations(renderer, budget);
    surface.flushInvalidations(renderer, budget);
    this.columns.flush(renderer, budget);
    const stores = this.flushTurn ? [surface, block] : [block, surface];
    this.flushTurn = !this.flushTurn;
    for (const store of stores) store.flush(renderer, budget);
    updatePageUniforms("BlockLight", block, this.uniforms);
    updatePageUniforms("SurfaceLight", surface, this.uniforms);
    this.uniforms.uSkyCeilings.value = this.columns.texture;
    this.uploadStats = budget;
    this.flushFailed = false;
    return budget;
  }

  // Call on BOTH loss and restoration. Loss releases Three's old dispose
  // listeners while GL deletion is a no-op; waiting until restoration would
  // delete handles from the previous context and cause INVALID_OPERATION.
  restoreGPU() {
    this.uploadedPalette = null;
    this.blockLight.restoreGPU();
    this.columns.restoreGPU();
  }

  resources() {
    const block = this.blockLight.resources(), surface = this.columns.surfaceLight.resources();
    const sky = this.columns.resources(), overworld = this.columns.world?.dimension === "overworld";
    const pendingPalette = Number(!this.disposed && this.uploadedPalette !== this.blockLight.paletteTexture);
    const pendingBarrier = Number(!this.disposed && !!this.flushFailed);
    const pendingRequired = block.pendingRequired + (overworld ? surface.pendingRequired + sky.pendingRequired : 0)
      + pendingPalette + pendingBarrier;
    return { block, surface, sky, lightingSamplers: 10, upload: this.uploadStats ?? null,
      pendingPalette, pendingBarrier, pendingRequired, ready: !this.disposed && pendingRequired === 0 };
  }

  observeMutation(world, event) {
    if (this.disposed) return;
    this.blockLight.observeMutation(world, event);
    this.columns.observeMutation(world, event);
  }

  update(atmosphere) {
    if (this.disposed) return;
    const u = this.uniforms;
    u.uPlayerVision.value = atmosphere.fullbrightInspection ? 0 : visualStrength(atmosphere.playerVision);
    updateBlockLightUniforms(this.blockLight, u, atmosphere.fullbrightInspection);
    u.uDaylightEnabled.value = Number(
      atmosphere.dimension === "overworld" &&
      this.columns.world.dimension === "overworld" &&
      !atmosphere.fullbrightInspection
    );
    u.uDaylightFogEnabled.value = Number(
      u.uDaylightEnabled.value &&
      atmosphere.cameraMediumKnown &&
      !atmosphere.underwater &&
      !atmosphere.inLava
    );
    u.uCaveFog.value.copy(atmosphere.dimensionHorizon);
    u.uSkyCeilings.value = this.columns.texture;
    u.uSkyField.value.set(this.columns.origin.x, this.columns.origin.y, this.columns.size);
    updatePageUniforms("SurfaceLight", this.columns.surfaceLight.store, u);
    u.uSurfaceField.value.set(this.columns.spec.minY, this.columns.surfaceLight.height, this.columns.surfaceLight.tiles);
    u.uSurfaceOrigin.value.set((this.columns.cx ?? 0) - this.columns.layout.radius,
      (this.columns.cz ?? 0) - this.columns.layout.radius);
    const lighting = atmosphere.outdoorLighting;
    u.uDaylightKey.value.copy(atmosphere.sunlight.color).multiplyScalar(lighting.keyIntensity);
    u.uDaylightSky.value.copy(atmosphere.hemi.color).multiplyScalar(lighting.hemisphereIntensity);
    u.uDaylightGround.value.copy(atmosphere.hemi.groundColor).multiplyScalar(lighting.hemisphereIntensity);
    // A dim, neutral material floor that survives the ACES toe on textured
    // stone. This is linear irradiance, not a percentage of displayed light.
    // Only roofed surfaces receive it; direct sky, albedo/AO, and tone mapping
    // are unchanged. No camera exposure, biome, clock, or adaptation involved.
    u.uCaveSky.value.setRGB(0.20, 0.22, 0.25);
    u.uCaveGround.value.setRGB(0.18, 0.19, 0.21);
  }
}
