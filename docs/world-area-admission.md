# Exact multi-area admission

`World.ensureAreas(footprints)` is the public staging operation for one dependency
that spans multiple areas. A footprint is `{ x, z, radius }`, optionally with the
current `dimension`. It returns a promise of the same `World`.

```js
await world.ensureAreas([
  { x: rider.x, z: rider.z, radius: 1 },
  { x: cast.x, z: cast.z, radius: 1 },
]);
// Both declared footprints can now be checked together.
```

## Admission and retention contract

- Supply a nonempty array of at most `MAX_RESIDENT_CHUNKS` footprints. Every
  position/radius uses `ensureArea` validation, including negative-coordinate
  flooring, radius 0–14, and clipping at world edges. A supplied dimension must
  match this World.
- The dependency is the exact union of the squares, not their bounding box.
  Overlaps and duplicates share one request and one batch pin per column.
  The first footprint supplies queue priority; it does not limit retention.
- Validation and the prospective union of this batch's keys with existing pins
  must fit the existing 841-column limit before focus, pins, queues or residents
  change. Invalid input/oversized admission rejects with `RangeError`.
- The entire group is pinned until its promise settles. Successful completion
  releases this group's pins, not another caller's overlapping pins. It does not
  leave a private lease that callers must manually release.
- The latest batch is the explicit cache footprint until new `ensureArea`,
  `ensureAreas`, `updateStreaming`, spawn, or synchronous generation demand
  replaces it. Superseded groups remain protected only while their own promises
  are pending. An all-resident new request still retires an old batch.
- Other callers' pins and existing streaming demand remain legitimate owners.
  Therefore a busy World can contain more than this group's columns, always
  within the same resident/physical-reservation cap. An idle fresh World admits
  only the declared union.
- Explicit batch retention can temporarily displace optional visual residents.
  Streaming status continues to report the real missing demand. A subsequent
  streaming update retires the batch and wakes any already-queued visual work;
  blocked work does not spin a timer.
- Physical worker reservations count against the same 841-column cap, with at
  most two physical jobs. Logical cancellation or synchronous fulfillment cannot
  prematurely free those reservations. Existing worker fallback retries the
  same declared keys; it does not select substitute terrain.
- Generation errors reject visibly, release this batch's pins and cancel
  unshared queued work. A failed current batch relinquishes its cache footprint
  without resurrecting earlier failed demand. This is not a rollback of already
  generated terrain or durable edits.
- Epoch changes cancel pending admissions. Old completions/finally blocks cannot
  mutate new-epoch pins or admit old worker packets. Dimension changes and
  disposal clear the cache. As with `ensureArea`, same-dimension `loadEdits`
  preserves the cached view while re-admitting it with new incarnations; that
  does not preserve the old asynchronous admission.

`ensureArea(position, radius)` retains its independent, single-square semantics.
`Promise.all` over separate calls is not a collective retention contract. Under
real tasks, one call can release its pins before another admission trims the
cache. Synchronously draining mocked workers before allowing promise
continuations can hide that ordering.

## Production and acceptance coverage

Saved vehicle staging validates both rider/cast footprint descriptions before
calling `ensureAreas` once. Actual rider geometry and exact saved rod/slot
validation still happen afterward; the batch cannot make an invalid pose valid.

The native ecology suite declares its original 6/9/9/12/12-column rectangles as
five batches. Seeds, selected sites, the <=16 bound, generation/resident/removal
counts, native payload checks, and actual mob behavior assertions are unchanged.

`test/world-areas.test.js` covers real-task retention, union deduplication,
capacity/validation atomicity, concurrent groups, replacement, worker fallback,
physical reservations, epoch/save/disposal cleanup, failures and streaming.
`test/vehicle-area-staging.integration.test.js` uses real Game/resource owners:
it places and mounts a boat, flies one cast two columns away, saves via
`GameArchive`/`WorldStorage`, reopens storage and cold-stages both footprints.
The authored 15-column ocean is an owner/storage regression, not native
generation, acquisition or rendering evidence. A stored head obstruction still
rejects through the actual rider validator.

Focused verification:

```bash
/exec-daemon/node --test --test-concurrency=1 --test-reporter=spec \
  test/world-areas.test.js test/streaming.test.js \
  test/world-admission-events.test.js test/world.integration.test.js \
  test/ecology-native.integration.test.js \
  test/vehicle-area-staging.integration.test.js \
  test/game-vehicle-*.integration.test.js test/vehicle-fishing-save.test.js
```
