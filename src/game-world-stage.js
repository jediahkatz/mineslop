import { restorePlayerSave } from "./player-save.js";
import { GENERATOR_VERSION } from "./terrain.js";
import { World } from "./world.js";
import { findSafeLanding } from "./world-interactions.js";

const createWorld = (seed, options) => new World(seed, options);
const radiusFor = Object.freeze({ low: 2, medium: 3, high: 4 });

function poseTarget() {
  return {
    position: null,
    yaw: 0,
    pitch: -0.12,
    flying: false,
    sneaking: false,
    setPosition(position) {
      this.position = { x: position.x, y: position.y, z: position.z };
    },
  };
}

/**
 * Prepare terrain and a valid player footprint without referencing a live Game.
 * The caller supplies already-normalized save components. Ownership of the new
 * world transfers only on success; every failed preparation disposes it.
 * Factories are injectable for bounded, renderer-free lifecycle regression tests.
 */
export async function stageWorld(
  {
    seed,
    saved = null,
    mode = "survival",
    quality = "medium",
    dimension = "overworld",
    generatorVersion = GENERATOR_VERSION,
    onProgress = () => {},
  },
  { worldFactory = createWorld, selectLanding = findSafeLanding } = {}
) {
  if (!["survival", "creative"].includes(mode))
    throw new RangeError("Invalid candidate game mode");
  if (!Object.hasOwn(radiusFor, quality))
    throw new RangeError("Invalid candidate graphics quality");
  let world;
  try {
    world = worldFactory(seed, {
      dimension: saved?.world?.dimension ?? dimension,
      generatorVersion: saved?.world?.generatorVersion ?? generatorVersion,
    });
    if (saved?.world && world.loadEdits(saved.world) === false)
      throw new Error("The saved terrain edits are invalid");
    const source = saved?.player ?? world.getSpawn();
    const origin = { x: source.x, y: source.y, z: source.z };
    onProgress(0.2, "Growing nearby biomes");
    await world.ensureArea(origin, radiusFor[quality] + 1);

    const candidate = poseTarget();
    const restored = Boolean(
      saved?.player && restorePlayerSave(candidate, world, saved.player)
    );
    if (!restored) {
      const landing = selectLanding(world, origin, {
        allowFlying: mode === "creative",
        preferUnderground:
          Boolean(saved?.player) && world.dimension === "overworld",
        allowPlatform: false,
      });
      if (
        !landing ||
        !restorePlayerSave(candidate, world, {
          ...landing,
          yaw: saved?.player?.yaw ?? 0,
          pitch: saved?.player?.pitch ?? -0.12,
          flying: landing.flying === true,
        })
      )
        throw new Error(
          "No unobstructed player footprint in the candidate world"
        );
    }
    onProgress(0.65, "Lighting the landscape");
    return {
      world,
      mode,
      quality,
      restored,
      pose: {
        position: candidate.position,
        yaw: candidate.yaw,
        pitch: candidate.pitch,
        flying: mode === "creative" && candidate.flying,
        sneaking: candidate.sneaking,
      },
    };
  } catch (error) {
    try {
      world?.dispose();
    } catch {
      // Cleanup failure must not replace the original preparation error.
    }
    throw error;
  }
}
