import * as THREE from "three";
import { BLOCK, BLOCKS } from "./blocks.js";
import { strata } from "./terrain-profiles.js";

// Render-only surface detail; the daylight wrapper chains this existing hook.
export function installDistantSurface(material) {
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
