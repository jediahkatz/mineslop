import test from "node:test";
import assert from "node:assert/strict";
import { gameGravityOccupied } from "../src/gravity-occupancy.js";

function host() {
  const world = { dimension: "overworld" };
  return {
    world,
    player: { world, position: { x: 8, y: 1, z: 8 }, height: 1.8 },
    wildlife: { world, dimension: "overworld", entities: [] },
    vehicleServices: { active: true },
    boats: { intersectsBounds: () => false },
  };
}

test("swept gravity occupancy protects real player dimensions and touching floor is clear", () => {
  const game = host();
  assert.equal(gameGravityOccupied(game, [7, 0, 7, 9, 2, 9]), true);
  assert.equal(gameGravityOccupied(game, [7, -1, 7, 9, 1, 9]), false);
  assert.equal(gameGravityOccupied(game, [0, 1, 0, 1, 3, 1]), false);
});

test("missing/stale vehicle ownership and an occupied boat fail closed", () => {
  const game = host();
  const bounds = [0, 1, 0, 1, 3, 1];
  game.boats.intersectsBounds = () => true;
  assert.equal(gameGravityOccupied(game, bounds), true);
  delete game.boats.intersectsBounds;
  assert.equal(gameGravityOccupied(game, bounds), true);
  game.boats.intersectsBounds = () => false;
  game.vehicleServices.active = false;
  assert.equal(gameGravityOccupied(game, bounds), true);
});

test("horse hull and rider volume block falling cubes even away from player", () => {
  const game = host();
  game.wildlife.entities.push({
    kind: "horse", position: { x: 0.5, y: 1, z: 0.5 }, dead: false,
  });
  assert.equal(gameGravityOccupied(game, [0, 1, 0, 1, 3, 1]), true);
  game.wildlife.entities[0].position.x = 5;
  assert.equal(gameGravityOccupied(game, [0, 1, 0, 1, 3, 1]), false);
});

test("passive hostile and aquatic body bounds share no-crushing behavior", () => {
  const game = host();
  const bounds = [0, 1, 0, 1, 3, 1];
  for (const kind of ["sheep", "zombie", "cod"]) {
    const mob = {
      kind, position: { x: 0.5, y: 1, z: 0.5 },
      spec: { radius: 0.4, height: 1 }, dormant: true, dead: false,
    };
    game.wildlife.entities = [mob];
    assert.equal(gameGravityOccupied(game, bounds), true, kind);
    mob.dead = true;
    assert.equal(gameGravityOccupied(game, bounds), false, kind);
  }
});
