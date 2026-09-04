// Exact integer-grid minimax escape level, not just samples along one transect.
// The cheapest path to the bounding square's edge must rise to this spill level.
export function hollowSpill(generator, bowl) {
  const radius = Math.ceil(bowl.radius * 1.7), side = radius * 2 + 1;
  const cx = bowl.x, cz = bowl.z, heights = new Int16Array(side * side);
  const seen = new Uint8Array(side * side);
  for (let z = 0; z < side; z++) for (let x = 0; x < side; x++)
    heights[z * side + x] = generator.surfaceYAt(cx + x - radius, cz + z - radius) ?? -1;
  const center = radius * side + radius, start = heights[center];
  const levels = Array.from({ length: 256 }, () => []);
  levels[start].push(center); seen[center] = 1;
  for (let level = start; level < levels.length; level++) {
    const queue = levels[level];
    for (let i = 0; i < queue.length; i++) {
      const current = queue[i], x = current % side, z = Math.floor(current / side);
      if (x === 0 || z === 0 || x === side - 1 || z === side - 1)
        return { center: [cx, start, cz], spillY: level, depth: level - start };
      for (const next of [current - 1, current + 1, current - side, current + side]) {
        if (seen[next]) continue;
        seen[next] = 1;
        levels[Math.max(level, heights[next])].push(next);
      }
    }
  }
  throw new Error("No bounded hollow escape route");
}

export function centralOutline(generator) {
  return Array.from({ length: 32 }, (_, i) => {
    const angle = i * Math.PI / 16;
    for (let radius = 128; radius <= 256; radius++)
      if (generator.surfaceYAt(Math.round(Math.cos(angle) * radius), Math.round(Math.sin(angle) * radius)) === null)
        return radius;
    throw new Error("Central outline exceeds its fixed reach");
  });
}
