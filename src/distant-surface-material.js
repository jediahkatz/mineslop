import * as THREE from "three";
import { BLOCK, BLOCKS, BLOCK_CATALOG } from "./blocks.js";
import { strata } from "./terrain-profiles.js";

// Render-only surface detail; the daylight wrapper chains this existing hook.
export function installDistantSurface(material, atlas) {
  if (atlas) return installAtlasSurface(material, atlas);
  const version = { value: 3 };
  const bands = strata.map((id) => new THREE.Color(BLOCKS[id].color));
  const stone = new THREE.Color(BLOCKS[BLOCK.STONE].color);
  material.defaultAttributeValues = { ...material.defaultAttributeValues, lodSurface: [0, 0, 0] };
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, {
      uLodVersion: version, uLodBands: { value: bands }, uLodStone: { value: stone },
    });
    shader.vertexShader = `
      attribute vec3 lodSurface;
      varying vec3 vLodSurface;
      varying vec3 vLodPosition;
      varying float vLodUp;
      ${shader.vertexShader}`.replace("#include <begin_vertex>", `
        #include <begin_vertex>
        vLodSurface = lodSurface;
        vLodUp = abs(normal.y);
        vLodPosition = (modelMatrix * vec4(position, 1.0)).xyz;
      `);
    shader.fragmentShader = `
      uniform float uLodVersion;
      uniform vec3 uLodBands[12];
      uniform vec3 uLodStone;
      varying vec3 vLodSurface;
      varying vec3 vLodPosition;
      varying float vLodUp;
      float lodGrain(vec3 p) {
        return fract(sin(dot(p, vec3(12.9898, 78.233, 45.164))) * 43758.5453);
      }
      ${shader.fragmentShader}`.replace("#include <color_fragment>", `
        #include <color_fragment>
        float y = floor(vLodPosition.y);
        float top = vLodSurface.y;
        bool modern = uLodVersion >= 4.0;
        bool banded = modern ? (y >= 54.0 && y >= top - 72.0)
                            : (y > 18.0 || y >= top - 3.0);
        if (vLodSurface.z > 0.5 && vLodUp < 0.5 && y < top && banded) {
          float layer = floor((y + floor(vLodSurface.x + 0.5)) / (modern ? 2.0 : 1.0));
          int band = int(mod(mod(layer, 12.0) + 12.0, 12.0));
          diffuseColor.rgb = uLodBands[band];
          if (uLodVersion >= 5.0 && top - y > 10.0 && mod(layer, 8.0) < 3.0)
            diffuseColor.rgb = uLodStone;
        }
        vec3 grainPoint = floor(mod(vLodPosition, 256.0) * 16.0);
        float detail = 1.0 - smoothstep(0.10, 0.65, length(fwidth(vLodPosition)));
        if (detail > 0.0)
          diffuseColor.rgb *= mix(1.0, 0.92 + 0.16 * lodGrain(grainPoint), detail);
      `);
  };
  material.customProgramCacheKey = () => "distant-surface-strata-grain-v1";
  return version;
}

function installAtlasSurface(material, atlas) {
  const version = { value: 3 };
  // Two rectangles per catalog ID, independent of terrain area/quality. Only
  // this lookup belongs to the material; the renderer owns the shared atlas.
  const rows = Math.max(...BLOCK_CATALOG.map((block) => block.id)) + 1;
  const rectangles = new Float32Array(rows * 8);
  for (const block of BLOCK_CATALOG) {
    rectangles.set(atlas.uvFor(block.id, "side"), block.id * 8);
    rectangles.set(atlas.uvFor(block.id, "top"), block.id * 8 + 4);
  }
  const tiles = new THREE.DataTexture(rectangles, 2, rows, THREE.RGBAFormat, THREE.FloatType);
  tiles.needsUpdate = true;
  // Context recovery also dispatches material disposal, then reuses this
  // CPU-backed lookup. Keep ownership for the later final teardown as well.
  material.addEventListener("dispose", () => tiles.dispose());
  material.defaultAttributeValues = {
    ...material.defaultAttributeValues, lodSurface: [0, 0, 0], lodBlocks: [0, 0, 0],
  };
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, {
      uLodVersion: version,
      uLodAtlas: { value: atlas.texture },
      uLodTiles: { value: tiles },
      uLodTileRows: { value: rows },
      uLodBandIds: { value: strata },
    });
    shader.vertexShader = `
      attribute vec3 lodSurface;
      attribute vec3 lodBlocks;
      varying vec3 vLodSurface;
      varying vec3 vLodBlocks;
      varying vec3 vLodPosition;
      varying vec3 vLodNormal;
      ${shader.vertexShader}`.replace("#include <begin_vertex>", `
        #include <begin_vertex>
        vLodSurface = lodSurface;
        vLodBlocks = lodBlocks;
        vLodNormal = normal;
        vLodPosition = (modelMatrix * vec4(position, 1.0)).xyz;
      `);
    shader.fragmentShader = `
      uniform sampler2D uLodAtlas;
      uniform sampler2D uLodTiles;
      uniform float uLodTileRows;
      uniform float uLodVersion;
      uniform float uLodBandIds[12];
      varying vec3 vLodSurface;
      varying vec3 vLodBlocks;
      varying vec3 vLodPosition;
      varying vec3 vLodNormal;
      ${shader.fragmentShader}`.replace("#include <color_fragment>", `
        #include <color_fragment>
        // Vegetation and landmarks share this material but have no lodBlocks.
        // Their existing vertex colors and daylight path remain untouched.
        if (vLodBlocks.x > 0.5) {
          bool up = vLodNormal.y > 0.5;
          float y = floor(vLodPosition.y - (up ? 0.001 : 0.0));
          float top = vLodSurface.y;
          float id = y >= top ? vLodBlocks.x :
            (y >= top - 3.0 ? vLodBlocks.y : vLodBlocks.z);
          bool modern = uLodVersion >= 4.0;
          // Preserve the guaranteed deep-rock region. The thin randomized
          // stone/deepslate transition remains a coarse render-only sample.
          if (modern && vLodBlocks.z == ${BLOCK.STONE}.0 && y < top - 3.0 &&
              (uLodVersion >= 5.0 ? y <= 0.0 : y < -8.0))
            id = ${BLOCK.DEEPSLATE}.0;
          bool banded = modern ? (y >= 54.0 && y >= top - 72.0 && y < top - 3.0)
                              : (y > 18.0 || y >= top - 3.0);
          if (vLodSurface.z > 0.5 && y < top && banded) {
            float layer = floor((y + floor(vLodSurface.x + 0.5)) / (modern ? 2.0 : 1.0));
            int band = int(mod(mod(layer, 12.0) + 12.0, 12.0));
            id = uLodBandIds[band];
            if (uLodVersion >= 5.0 && top - y > 10.0 && mod(layer, 8.0) < 3.0)
              id = ${BLOCK.STONE}.0;
          }
          // Match the cube mesher's face orientation and baked face shade.
          vec2 uv;
          float shade = 1.0;
          if (up) uv = vec2(vLodPosition.x, -vLodPosition.z);
          else if (abs(vLodNormal.x) > 0.5) {
            uv = vec2(vLodNormal.x > 0.0 ? -vLodPosition.z : vLodPosition.z, vLodPosition.y);
            shade = vLodNormal.x > 0.0 ? 0.86 : 0.77;
          } else {
            uv = vec2(vLodNormal.z > 0.0 ? vLodPosition.x : -vLodPosition.x, vLodPosition.y);
            shade = vLodNormal.z > 0.0 ? 0.9 : 0.73;
          }
          vec4 rect = texture2D(uLodTiles, vec2(up ? 0.75 : 0.25, (id + 0.5) / uLodTileRows));
          // The shared SRGB DataTexture decodes on sampling, exactly as the
          // native map. No second base-color multiplication or synthetic grain.
          vec3 texel = texture2D(uLodAtlas, mix(rect.xy, rect.zw, fract(uv))).rgb;
          diffuseColor.rgb = texel * shade;
          #if defined(USE_COLOR) || defined(USE_COLOR_ALPHA)
            if (up && y >= top) diffuseColor.rgb *= vColor.rgb;
          #endif
        }
      `);
  };
  material.customProgramCacheKey = () => "distant-surface-native-atlas-v2";
  return version;
}
