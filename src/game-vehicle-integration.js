import {
  bindFishingLootSymbols,
  FISHING_TREASURE_ADDITIONS,
} from "./content-bindings.js";
import { DEFAULT_FISHING_TABLES } from "./fishing-loot.js";
import { GameVehicleServices } from "./game-vehicle-services.js";

const lootTables = bindFishingLootSymbols({
  ...DEFAULT_FISHING_TABLES,
  treasure: [...DEFAULT_FISHING_TABLES.treasure, ...FISHING_TREASURE_ADDITIONS],
});

/** Admit only the saved active rider/cast footprints before live-world teardown. */
export async function stageVehicleServices({
  world,
  gameplay,
  overflow,
  context,
  saved,
  position,
}) {
  const services = new GameVehicleServices({
    world,
    gameplay,
    overflow,
    context,
    saved,
    lootTables,
    coordinator: world.coordinator,
    allowOverBudget: saved != null,
  });
  try {
    const footprints = services.requiredFootprints();
    if (footprints.length > 2)
      throw new Error("Too many saved vehicle footprints");
    for (const footprint of footprints) {
      if (footprint.dimension !== world.dimension || footprint.radius !== 1)
        throw new Error("Invalid saved vehicle footprint");
      await world.ensureArea(footprint, footprint.radius);
    }
    const checked = services.stagePlayerPose(position);
    if (!checked.ok)
      throw new Error(`Invalid saved vehicle pose: ${checked.reason}`);
    return services;
  } catch (error) {
    services.dispose();
    throw error;
  }
}

/** No walking tick is run by an input-event pose consumer. */
export function applyVehiclePose(game) {
  if (!game.player) return false;
  const riderPose = game.vehicleServices?.riderPose();
  const exitPose = game.vehicleServices?.takeExitPose();
  if (!riderPose && !exitPose) return false;
  game.player.update(0, { recoverFromVoid: false, riderPose, exitPose });
  return true;
}
