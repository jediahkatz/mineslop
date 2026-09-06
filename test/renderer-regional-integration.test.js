import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { usesSectionMeshing } from "../src/section-renderer.js";
import { getWorldSpec } from "../src/world-spec.js";
import { authoredColumns } from "./shape-fixture.js";
import { daylightRenderer } from "./daylight-fixture.js";

test("legacy-height saves use regional packing and refresh late lighting hooks", (t) => {
  const world = authoredColumns([]);
  world.generatorVersion = 3;
  world.spec = getWorldSpec(3, "overworld");
  world.admit(0, 0);
  world.put(8, 8, 8, BLOCK.STONE);
  assert.equal(usesSectionMeshing(world), false, "legacy height normally uses the column path");
  const graphics = daylightRenderer(t, world, { x: 8, y: 10, z: 12 });
  t.after(() => graphics.daylightMaterial?.dispose());
  graphics.meshLimits = { regionalPages: true };
  graphics.rebuildDirty(Infinity);
  assert.equal(graphics.sectionPackingMode, "regional");
  assert.equal(graphics.chunks.get("0,0").userData.sections.size, 6);
  assert.deepEqual([...graphics.detailCoverage()], ["0,0"]);
  assert.equal(graphics.sectionRegions.size, 1);
  const region = [...graphics.sectionRegions.values()][0];
  const page = region.userData.pages[0];
  assert.equal(page.parent, region);
  assert.equal(region.parent, graphics.scene);
  const unlitMaterial = page.material, palette = graphics.geometryPalette;
  let disposals = 0;
  unlitMaterial.addEventListener("dispose", () => disposals++);
  assert.equal(graphics.daylightMaterial, undefined);

  graphics.updateDaylight();
  assert.equal(disposals, 1);
  assert.notEqual(page.material, unlitMaterial);
  assert.equal(graphics.geometryPalette, palette);
  const shader = {
    uniforms: {},
    vertexShader: "#include <color_vertex>\n#include <project_vertex>",
    fragmentShader: "#include <lights_fragment_begin>",
  };
  page.material.onBeforeCompile(shader, graphics.renderer);
  assert.equal(shader.uniforms.uRegionalColors.value, palette.texture);
  assert.equal(shader.uniforms.uBlockLightPages, graphics.daylightMaterial.uniforms.uBlockLightPages);
  assert.equal(shader.uniforms.uSurfaceLightPages, graphics.daylightMaterial.uniforms.uSurfaceLightPages);
  assert.match(shader.vertexShader, /vColor\.rgb \*= regionalColor\(color\.r\)/);
  assert.notEqual(page.material, graphics.materials.opaque, "ordinary RGB consumers keep their original material");
  assert.deepEqual([...graphics.detailCoverage()], ["0,0"]);
});
