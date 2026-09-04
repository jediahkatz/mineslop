# Clouds and weather implementation

The bounded weather and cloud domains are implemented. Normal Game staging,
archive/travel integration and rain audio are still required before this is a
playable feature; their presence in source is not a completion claim.

## State and presentation

`WeatherState` derives a deterministic clear/rain schedule from the world seed
and a versioned elapsed-time sidecar. Missing legacy state starts at zero;
malformed state is rejected. Simulation pauses must freeze this clock.
Rain is currently Overworld-only; dry, cold and cave biomes suppress it.
Snow, thunder, lightning and weather-driven terrain changes are not implemented.

`CloudField` maintains 108 original cuboids with world-cell identities and
independent wind. Recycling preserves surviving clouds' world positions.
`WeatherRender` has one 200-drop line pool. It reads admitted biome bytes rather
than asking the procedural generator for climate during rendering.

## Roof-query safety

Exposure uses loaded cells only and conservatively treats any occupied block
or fluid cell as a roof. Unknown columns do not emit rain. It retains at most
64 column records and reads at most 2,048 cells per rendering update.

World mutation notifications now carry their committed edit revision. A current
notification can retain scans through unrelated changes or unchanged occupancy;
only relevant changes above the scan frontier or at/above a known roof restart
that column. No terrain reads occur in notification callbacks.

Replay, missing chunk revisions, replacement residents and epoch changes cannot
advance stale cache state. Missing notifications fall back to rescanning.
Batches above 512 changes also take the conservative fallback instead of doing
unbounded notification work. Existing world/archive serialization is unchanged
by the notification revision.

The native expanded-world regression reproduces a previous failure where
continuous unrelated edits left only 64 of 200 rain drops available. With
current notifications, all 200 converge after four updates under block or fluid
churn, exactly as in the quiet case, and settled roof queries perform zero reads.

## Required live integration

- Stage, activate and dispose `GameWeatherServices` with the other Game owners.
- Add `weatherServices` to the independent World event consumers.
- Advance the schedule only during admitted simulation; render after atmosphere
  updates and before the scene draw.
- Validate and persist the optional weather sidecar through preflight/archive.
- Rebind the same schedule after successful dimension admission and rollback.
- Feed the single `desiredAudio` projection to the existing shared mixer, with
  immediate pause, hidden, mute, death and teardown silence.
- Verify normal new/restored worlds, travel, real rain/cloud motion and sound in
  the browser before marking the feature complete.
