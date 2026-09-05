import * as THREE from "three";
import { BLOCK } from "../src/blocks.js";

// Small GPU compile/binding gate, not a substitute for the native screenshots.
// Reuse the real shared material and renderer; dispose only test-owned objects.
export function auditDistantSurfaceVariants(graphics) {
  const renderer = graphics.renderer, material = graphics.distant._terrainMaterial;
  const gl = renderer.getContext();
  const previousTarget = renderer.getRenderTarget();
  const previousColor = renderer.getClearColor(new THREE.Color());
  const previousAlpha = renderer.getClearAlpha();
  const target = new THREE.WebGLRenderTarget(8, 8);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#000000");
  scene.add(new THREE.AmbientLight("#ffffff", 1));
  const camera = new THREE.OrthographicCamera(0, 1, 1, 0, 0.01, 10);
  camera.position.set(0, 2, 0);
  camera.up.set(0, 0, -1);
  camera.lookAt(0, 0, 0);
  const results = [];
  try {
    renderer.setRenderTarget(target);
    for (const [name, size, terrain] of [
      ["rgb-terrain", 3, true], ["rgba-terrain", 4, true],
      ["rgb-vegetation", 3, false], ["rgba-vegetation", 4, false],
      ["rgb-terrain-rebound", 3, true],
    ]) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(
        [0, 1, 0, 1, 1, 0, 1, 1, -1, 0, 1, -1], 3));
      geometry.setAttribute("normal", new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
      geometry.setAttribute("color", new THREE.Float32BufferAttribute(
        Array.from({ length: 4 }, () => size === 4 ? [1, 1, 1, 0.5] : [1, 1, 1]).flat(), size));
      geometry.setIndex([0, 1, 2, 0, 2, 3]);
      if (terrain) {
        geometry.setAttribute("lodSurface", new THREE.Float32BufferAttribute(new Float32Array(12), 3));
        geometry.setAttribute("lodBlocks", new THREE.Uint16BufferAttribute(new Uint16Array(12).fill(BLOCK.END_STONE), 3));
      }
      const mesh = new THREE.Mesh(geometry, material);
      scene.add(mesh);
      try {
        renderer.render(scene, camera);
        const program = renderer.properties.get(material).currentProgram;
        const location = program.getAttributes().lodBlocks?.location;
        const pixel = new Uint8Array(4);
        renderer.readRenderTargetPixels(target, 4, 4, 1, 1, pixel);
        results.push({
          name, colorItemSize: size, programId: program.id,
          linked: gl.getProgramParameter(program.program, gl.LINK_STATUS),
          lodBlocksEnabled: location === undefined ? null :
            gl.getVertexAttrib(location, gl.VERTEX_ATTRIB_ARRAY_ENABLED),
          lodBlocksDefault: !terrain && location !== undefined
            ? [...gl.getVertexAttrib(location, gl.CURRENT_VERTEX_ATTRIB)].slice(0, 3) : null,
          pixel: [...pixel], glError: gl.getError(),
        });
      } finally {
        scene.remove(mesh);
        geometry.dispose();
      }
    }
  } finally {
    renderer.setRenderTarget(previousTarget);
    renderer.setClearColor(previousColor, previousAlpha);
    target.dispose();
  }
  return results;
}
