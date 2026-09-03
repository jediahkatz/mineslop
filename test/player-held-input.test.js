import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { Player } from "../src/player.js";

test("holding Space jumps again after landing and releasing it stops the repeats", () => {
  const document = new EventTarget();
  document.defaultView = new EventTarget();
  const element = { ownerDocument: document };
  const world = {
    isSolid: (_x, y) => y === 0,
    isLoaded: () => true,
    get: (_x, y) => (y === 0 ? 3 : 0),
    getSpawn: () => ({ x: 0.5, y: 1, z: 0.5 }),
  };
  const player = new Player(new THREE.PerspectiveCamera(), world, element);
  player.setPosition(world.getSpawn());
  player.enabled = true;
  player.update(1 / 60);
  let jumps = 0;
  player.onJump = () => jumps++;
  player._onKeyDown({ code: "Space", repeat: false, preventDefault() {} });
  for (let frame = 0; frame < 180; frame++) player.update(1 / 60);
  assert.ok(jumps >= 3, `held Space produced only ${jumps} jump(s)`);
  player._onKeyUp({ code: "Space" });
  const released = jumps;
  for (let frame = 0; frame < 120; frame++) player.update(1 / 60);
  assert.equal(jumps, released);
  assert.equal(player.grounded, true);
  assert.equal(player.position.y, 1);
  player.dispose();
});
