import { DropOverflow } from "../src/drop-overflow.js";
import { cloneSlots } from "../src/inventory-slots.js";

/** Scene-less real overflow owner; observers record only committed drop batches. */
export function preparedDropFixture(
  gameplay,
  { onCommit = () => {}, ...options } = {}
) {
  const overflow = new DropOverflow({
    ...options,
    coordinator: gameplay.coordinator,
    context: gameplay.context,
  });
  return {
    overflow,
    prepareDrops(stacks) {
      const detached = cloneSlots(stacks, gameplay.context);
      const participant = overflow.prepareEnqueue(
        detached,
        { x: 0.5, y: 2, z: 0.5 },
        "overworld"
      );
      return (
        participant && {
          ...participant,
          notify: () => {
            participant.notify?.();
            onCommit(cloneSlots(detached));
          },
        }
      );
    },
  };
}
