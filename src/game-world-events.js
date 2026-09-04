const serviceSlots = [
  "buildingServices",
  "fluidServices",
  "gravityServices",
  "weatherServices",
  "vehicleServices",
  "explorationServices",
  "ecologyServices",
];

/** Queue each current consumer independently after World publication. */
export function bindWorldServiceEvents(game) {
  const world = game.world;
  const consumers = serviceSlots.map((slot) => [slot, game[slot]]);
  let bound = true;
  const currentWorld = () => bound && game.world === world && !world._disposed;

  function dispatch(method, event) {
    if (
      !currentWorld() ||
      event?.epoch !== world.epoch ||
      event?.dimension !== world.dimension
    )
      return;
    const errors = [];
    for (const [slot, service] of consumers) {
      try {
        if (
          !currentWorld() ||
          !service ||
          game[slot] !== service ||
          !service.active
        )
          continue;
        const callback = service[method];
        if (
          typeof callback !== "function" ||
          Object.prototype.toString.call(callback) !== "[object Function]"
        )
          throw new TypeError("World service observers must be synchronous");
        const result = callback.call(service, world, event);
        if (result != null && typeof result.then === "function") {
          if (result instanceof Promise) result.catch(() => {});
          throw new TypeError("World service observers must be synchronous");
        }
      } catch (error) {
        errors.push(error);
      }
    }
    if (method === "onMutation" && currentWorld()) {
      try {
        game.scheduleSave?.();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length)
      throw new AggregateError(errors, "World service observation failed");
  }

  const mutation = (event) => dispatch("onMutation", event);
  const admitted = (event) => dispatch("onChunkLoaded", event);
  world.onMutation = mutation;
  world.onChunkAdmitted = admitted;
  const unbind = () => {
    bound = false;
    if (world.onMutation === mutation) world.onMutation = undefined;
    if (world.onChunkAdmitted === admitted) world.onChunkAdmitted = undefined;
  };

  try {
    // Replay only the initial residents, with the same frozen identity envelope
    // as a real admission. Later residents arrive through World's notification.
    const errors = [];
    for (const chunk of [...world.chunks.values()]) {
      if (!currentWorld()) break;
      const key = `${chunk.cx},${chunk.cz}`;
      if (world.chunks.get(key) !== chunk) continue;
      try {
        admitted(
          Object.freeze({
            world,
            chunk,
            seed: world.seed,
            generatorVersion: world.generatorVersion,
            epoch: world.epoch,
            dimension: world.dimension,
            key,
            cx: chunk.cx,
            cz: chunk.cz,
            incarnation: chunk.incarnation,
            revision: chunk.revision,
          })
        );
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length)
      throw new AggregateError(
        errors,
        "Initial world service observation failed"
      );
  } catch (error) {
    unbind();
    throw error;
  }
  return unbind;
}
