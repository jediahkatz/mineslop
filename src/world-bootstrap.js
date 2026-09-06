// Landing searches reach at most 12 blocks. Two 16-block chunk rings cover
// that search, body/shape neighbor reads, and an apron around a shifted landing,
// even when the original position is on a chunk boundary. Visual R+2 demand is
// admitted separately by World.updateStreaming; it must never gate arrival.
export const COLLISION_LOAD_RADIUS = 2;
