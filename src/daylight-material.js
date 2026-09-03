import * as THREE from "three";
import { CAVE_DAYLIGHT_LIMITS, entranceLightWeight } from "./cave-daylight.js";
import { UNKNOWN_SKY_HEIGHT } from "./sky-columns.js";

/** CPU equivalent of the shader's mask, for focused geometry regressions. */
export function sampleDaylightAt(columns, sources, point) {
  const x = Math.floor(point.x) - columns.origin.x;
  const z = Math.floor(point.z) - columns.origin.y;
  if (x < 0 || z < 0 || x >= columns.size || z >= columns.size)
    return { direct: 0, ambient: 0 };
  const top = columns.data[z * columns.size + x];
  if (top === UNKNOWN_SKY_HEIGHT) return { direct: 0, ambient: 0 };
  const direct = Number(point.y >= top);
  let ambient = direct;
  for (const source of sources.slice(0, CAVE_DAYLIGHT_LIMITS.sources))
    ambient = Math.max(
      ambient,
      entranceLightWeight(Math.hypot(point.x - source.x, point.y - source.y, point.z - source.z))
    );
  return { direct, ambient };
}

const DECLARATIONS = `
varying vec3 vDaylightPosition;
uniform float uDaylightEnabled;
uniform float uDaylightFogEnabled;
uniform sampler2D uSkyCeilings;
uniform vec3 uSkyField;
uniform vec3 uDaylightKey, uDaylightSky, uDaylightGround;
uniform vec3 uCaveSky, uCaveGround;
uniform vec3 uCaveFog;
uniform vec4 uDaylightOpenings[${CAVE_DAYLIGHT_LIMITS.sources}];

vec2 daylightMask(vec3 point) {
  #ifdef MINESLOP_EXTERIOR_DAYLIGHT
    return vec2(1.0);
  #else
    vec2 cell = floor(point.xz) - uSkyField.xy;
    if (any(lessThan(cell, vec2(0.0))) || any(greaterThanEqual(cell, vec2(uSkyField.z))))
      return vec2(0.0);
    float ceiling = texture2D(uSkyCeilings, (cell + 0.5) / uSkyField.z).r;
    if (ceiling >= ${UNKNOWN_SKY_HEIGHT.toFixed(1)}) return vec2(0.0);
    float directSky = step(ceiling, point.y);
    float fill = directSky;
    for (int i = 0; i < ${CAVE_DAYLIGHT_LIMITS.sources}; i++) {
      float d = length(point - uDaylightOpenings[i].xyz);
      fill = max(fill, uDaylightOpenings[i].w * (1.0 - smoothstep(0.0, ${CAVE_DAYLIGHT_LIMITS.lightRadius.toFixed(1)}, d)));
    }
    return vec2(directSky, fill);
  #endif
}
`;

/**
 * Only natural directional/hemisphere irradiance is spatially masked.
 * Torch point lights, emissive art, AO, fluid shaders and Fullbright's white
 * ambient term remain in Three's normal pipeline. Exposed LOD is always lit
 * as exterior terrain, irrespective of the camera's cave classification.
 */
export class DaylightMaterial {
  constructor(columns) {
    this.columns = columns;
    this.installed = new WeakSet();
    this.uniforms = {
      uDaylightEnabled: { value: 0 },
      uDaylightFogEnabled: { value: 0 },
      uSkyCeilings: { value: columns.texture },
      uSkyField: { value: new THREE.Vector3() },
      uDaylightKey: { value: new THREE.Color() },
      uDaylightSky: { value: new THREE.Color() },
      uDaylightGround: { value: new THREE.Color() },
      uCaveSky: { value: new THREE.Color() },
      uCaveGround: { value: new THREE.Color() },
      uCaveFog: { value: new THREE.Color() },
      uDaylightOpenings: {
        value: Array.from({ length: CAVE_DAYLIGHT_LIMITS.sources }, () => new THREE.Vector4()),
      },
    };
  }

  install(material, exterior = false) {
    if (!material?.isMeshLambertMaterial || this.installed.has(material)) return;
    this.installed.add(material);
    const previous = material.onBeforeCompile;
    const cacheKey = material.customProgramCacheKey.bind(material);
    material.onBeforeCompile = (shader, renderer) => {
      previous.call(material, shader, renderer);
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = `varying vec3 vDaylightPosition;\n${shader.vertexShader}`.replace(
        "#include <project_vertex>",
        "#include <project_vertex>\nvDaylightPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;"
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
          irradiance += getHemisphereLightIrradiance( skyLight, geometryNormal );`
        );
      const fog = THREE.ShaderChunk.fog_fragment.replace(
        "gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );",
        `vec3 caveFog = linearToOutputTexel(vec4(uCaveFog, 1.0)).rgb;
        vec3 localFog = uDaylightFogEnabled > 0.5 ? mix(caveFog, fogColor, skyMask.y) : fogColor;
        gl_FragColor.rgb = mix( gl_FragColor.rgb, localFog, fogFactor );`
      );
      shader.fragmentShader =
        `${exterior ? "#define MINESLOP_EXTERIOR_DAYLIGHT\n" : ""}${DECLARATIONS}\n${shader.fragmentShader}`
          .replace(
            "#include <lights_fragment_begin>",
            `vec3 daylightNormal = transformNormalByInverseViewMatrix(normal, viewMatrix);
            vec2 skyMask = daylightMask(vDaylightPosition + daylightNormal * 0.02);
            ${lights}`
          )
          .replace("#include <fog_fragment>", fog);
    };
    material.customProgramCacheKey = () => `${cacheKey()}:daylight-1:${Number(exterior)}`;
    material.needsUpdate = true;
  }

  update(atmosphere, access) {
    const u = this.uniforms;
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
    u.uSkyField.value.set(this.columns.origin.x, this.columns.origin.y, this.columns.size);
    const lighting = atmosphere.outdoorLighting;
    u.uDaylightKey.value.copy(atmosphere.sunlight.color).multiplyScalar(lighting.keyIntensity);
    u.uDaylightSky.value.copy(atmosphere.hemi.color).multiplyScalar(lighting.hemisphereIntensity);
    u.uDaylightGround.value.copy(atmosphere.hemi.groundColor).multiplyScalar(lighting.hemisphereIntensity);
    u.uCaveSky.value.copy(atmosphere.hemi.color).multiplyScalar(0.05);
    u.uCaveGround.value.copy(atmosphere.hemi.groundColor).multiplyScalar(0.05);
    u.uDaylightOpenings.value.forEach((value, index) => {
      const source = access.sources[index];
      value.set(source?.x ?? 0, source?.y ?? 0, source?.z ?? 0, Number(!!source));
    });
  }
}
