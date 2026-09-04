import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { updatePlayerVisualEffects } from "../src/game-conduit-services.js";
import { CONDUIT_AT, buildConduit, conduitFixture, putCell } from "./conduit-fixture.js";
import { daylightRenderer } from "./daylight-fixture.js";

test("live Game conduit/potion observation drives the actual renderer setter and shader uniform", async (t) => {
  const f = await conduitFixture(t);
  buildConduit(f.world, 16);
  const graphics = daylightRenderer(t, f.world, f.player.position, "low");
  // Preserve the scene/camera identities owned by live pearl/progression hosts;
  // route the presentation transport to the actual renderer implementation.
  f.game.graphics.setPlayerVisualEffects = graphics.setPlayerVisualEffects.bind(graphics);
  const paint = () => {
    const state = updatePlayerVisualEffects(f.game);
    graphics.update(0, 0, f.player.position);
    return state;
  };
  assert.equal(paint().conduitPower, true);
  assert.equal(graphics.daylightMaterial.uniforms.uPlayerVision.value, 1);
  assert.equal(graphics.atmosphere.conduitPower, true);
  f.game.paused = true;
  assert.equal(paint().conduitPower, true);
  assert.equal(graphics.daylightMaterial.uniforms.uPlayerVision.value, 1);
  putCell(f.world, CONDUIT_AT, BLOCK.WATER);
  assert.equal(paint().conduitPower, false);
  assert.equal(graphics.daylightMaterial.uniforms.uPlayerVision.value, 0);
  const effects = f.progression.services.effects;
  assert.equal(f.coordinator.commit([effects.prepare({
    version: 1, tickRemainder: 0,
    effects: [{ id: "night_vision", amplifier: 0, remainingTicks: 500 }],
  })]).ok, true);
  assert.deepEqual(paint(), { nightVision: 1, conduitPower: false });
  assert.equal(graphics.daylightMaterial.uniforms.uPlayerVision.value, 1);
  f.game.player = { ...f.player };
  assert.deepEqual(paint(), { nightVision: 0, conduitPower: false });
  assert.equal(graphics.daylightMaterial.uniforms.uPlayerVision.value, 0);
  f.game.player = f.player;
});
