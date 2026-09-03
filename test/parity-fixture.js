import * as THREE from "three";
import { BuildingActions } from "../src/building-actions.js";
import { DropOverflow } from "../src/drop-overflow.js";
import { Fuses } from "../src/fuses.js";
import { VoxelGame } from "../src/game.js";
import { GameHarvestActions } from "../src/game-harvest-actions.js";
import { GameInventoryActions } from "../src/game-inventory-actions.js";
import { GameUseActions } from "../src/game-use-actions.js";
import { Gameplay } from "../src/gameplay.js";
import { Settlement } from "../src/settlement.js";
import { interactionSinks, InteractionWorld } from "./interaction-fixture.js";

/** In-memory integration fixture; never used for screenshots or gameplay claims. */
export function parityGame(mode = "survival", options = {}) {
  const world = new InteractionWorld({ floor: 8, ...options });
  const { coordinator, context } = world;
  const drops = [];
  const experience = [];
  const messages = [];
  const opened = [];
  const game = Object.create(VoxelGame.prototype);
  Object.defineProperty(game, "active", { value: true, writable: true });
  Object.assign(game, {
    paused: false,
    building: false,
    overlayOpen: false,
    started: true,
    elapsed: 10,
    lastAction: -Infinity,
    lastOverflowToast: -Infinity,
    miningKey: "",
    miningProgress: 0,
    heldAction: null,
    target: null,
    mobTarget: null,
    world,
    coordinator,
    worldContext: context,
    player: {
      position: new THREE.Vector3(0.5, 9, 0.5),
      eyePosition: new THREE.Vector3(0.5, 10.62, 0.5),
      forward: new THREE.Vector3(0, 0, -1),
      intersectsBlock: () => false,
      intersectsPlacement: () => false,
      inputMode: "native",
      sneaking: false,
    },
    graphics: {
      camera: { position: new THREE.Vector3(0.5, 10.62, 4.5) },
      rebuildDirty() {},
    },
    effects: {
      swing: 0,
      offhand: { swing: 0 },
      burst() {},
      sound() {},
      shoot() {},
      select() {},
      selectOffhand() {},
    },
    ui: {
      toast: (text) => messages.push(text),
      openInventory: (screen) => {
        opened.push(screen);
        return true;
      },
      closeInventory() {},
      closeAtlas() {},
      setSelected() {},
    },
    containerUI: {
      open: (_world, hit) => {
        opened.push({ container: hit.id });
        return true;
      },
      refresh() {},
    },
    ...interactionSinks(world, drops, experience),
    wildlife: { endSpawnProtection() {}, interact: () => false },
    scheduleSave() {},
    refreshHud() {},
    updateTarget() {},
  });
  game.gameplay = new Gameplay({
    mode,
    random: () => 0.9,
    coordinator,
    context,
    onToast: (text) => messages.push(text),
  });
  game.overflow = new DropOverflow({ coordinator, context });
  game.settlement = new Settlement({ coordinator, context });
  game.fuses = new Fuses({ coordinator, context });
  game.inventoryActions = new GameInventoryActions(game);
  game.useActions = new GameUseActions(game);
  game.harvestActions = new GameHarvestActions(game);
  game.buildingActions = new BuildingActions(game);
  game.beds = game.buildingActions.beds;
  return { game, cells: world.cells, drops, experience, messages, opened };
}

export function setOwnedSlots(game, entries, offhand = null) {
  if (
    !game.gameplay.inventoryTransaction((draft) => {
      draft.slots.fill(null);
      for (const [index, stack] of entries) draft.slots[index] = { ...stack };
      draft.offhand = offhand ? { ...offhand } : null;
      return true;
    })
  )
    throw new Error("Invalid test inventory setup");
}
