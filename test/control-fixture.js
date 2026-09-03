import * as THREE from "three";
import { Player } from "../src/player.js";

export class InputElement extends EventTarget {
  constructor(document) {
    super();
    this.ownerDocument = document;
    this.dataset = {};
    this.children = [];
  }
  contains(target) {
    return target === this || this.children.includes(target);
  }
  matches() {
    return false;
  }
  closest() {
    return null;
  }
}

export function dispatch(target, type, properties = {}) {
  const event = new Event(type, { cancelable: true });
  for (const [key, value] of Object.entries(properties))
    Object.defineProperty(event, key, { configurable: true, value });
  target.dispatchEvent(event);
  return event;
}

export function controlFixture(t, preferences = { inputMode: "remote" }) {
  const document = new EventTarget();
  document.defaultView = new EventTarget();
  document.pointerLockElement = null;
  document.hidden = false;
  const element = new InputElement(document);
  const calls = [];
  element.requestPointerLock = (...args) => {
    calls.push(args);
    return Promise.resolve().then(() => {
      document.pointerLockElement = element;
      dispatch(document, "pointerlockchange");
    });
  };
  document.exitPointerLock = () => {
    document.pointerLockElement = null;
    dispatch(document, "pointerlockchange");
  };
  const world = {
    isSolid: (_x, y) => y === 0,
    isLoaded: () => true,
    get: (_x, y) => (y === 0 ? 3 : 0),
    getSpawn: () => ({ x: 0.5, y: 1, z: 0.5 }),
  };
  const camera = new THREE.PerspectiveCamera(75);
  const player = new Player(camera, world, element, preferences);
  player.setPosition(world.getSpawn());
  player.enabled = true;
  t.after(() => player.dispose());
  const event = (x, y = 100, properties = {}) => ({
    clientX: x,
    clientY: y,
    timeStamp: 0,
    buttons: 2,
    button: 2,
    movementX: -874,
    movementY: 600,
    target: element,
    ...properties,
  });
  return {
    document,
    window: document.defaultView,
    element,
    world,
    camera,
    player,
    calls,
    event,
  };
}
