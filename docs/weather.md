# Clouds and weather implementation

Weather is connected to normal Game staging, archive/preflight, frame rendering,
World mutation notifications, travel recovery and the persistent Game mixer.
Headless integration tests exercise the actual Game lifecycle; browser visual
and listening acceptance remains a separate check.

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

## Game lifecycle

Game stages this owner without scene/audio writes, activates it with the admitted
World/Gameplay/Player/graphics identities, and disposes it before replacing the
old scene. Original weather accessors and malformed records reject before generic
archive cloning. The optional `{weather:{version:1,elapsed}}` sidecar does not
change archive version 3 or the default terrain generator (version 3).

The schedule advances during admitted simulation, including ordinary inventory
overlays. Pause, hidden, death, failed/loading states freeze it. Dimension travel
and rollback explicitly rebind the same owner to the new World epoch; respawn
does not reroll or reconstruct the schedule. Nether/End still advance this clock
but suppress precipitation.

Weather rendering runs after atmosphere update and before scene draw. The
Wildlife → late vehicle exit → gravity → one mesh rebuild → graphics update
ordering remains unchanged. No atmosphere visibility, lighting constants,
terrain, fluid, crop or combat rules change.

## Rain audio

The single `desiredAudio.level` projection drives `AudioEngine.setRain()`.
It admits one looping source into the existing 12-voice mixer, preserving the
two reserved gameplay-cue slots. Its original filtered-noise 1.5-second mono PCM
uses one 144,000-byte entry inside the existing 48-buffer / 2 MiB SoundBank
limits. Steady rain reuses the source and does not append gain automation.
Changing intensity updates gain; silence releases the source. A later shower
can reuse its cached buffer.

No second context, network audio, event-per-frame playback, or pending rain queue
exists. Gesture unlock remains mandatory. Mute, pause, hidden, death, travel,
replacement and teardown silence rain without waiting for another RAF.
Unmuting/unlocking alone never replays an earlier projection.

## Focused verification and browser acceptance

`test/weather-game.integration.test.js` runs the actual Game constructor,
initialize/stage/activate, frame, archive save/reload and travel/rollback paths
with only headless presentation and authored terrain transports. Real resource
owners, rain geometry, cloud instance matrices, Effects and AudioEngine run.
`test/rain-audio.test.js` verifies PCM, gesture gating, loop/gain reuse,
transitions, failed allocation cleanup, and shared voice/cache limits.

Browser acceptance (not performed by the headless tests):

1. Open a normal new world and enter Play with sound enabled. Export it.
2. In a copy of that JSON, set only `weather` to
   `{"version":1,"elapsed":1000}`. Import through the normal UI, then resume.
   Use an open, loaded Plains/forest site rather than a dry/cold biome.
3. Confirm visible rain and a quiet continuous rain bed. Walk under a roof, then
   back outside; covered/unknown locations must not produce exposed rain audio.
4. Look upward while walking sideways: clouds should retain world parallax.
   Stand still to observe slow independent wind. Pause must freeze their drift.
5. Open ordinary inventory: weather continues. Pause, mute, switch tabs and die:
   audio stops immediately. Return/unmute must not burst queued sounds.
6. Save/reload; travel to Nether/End and return. The schedule continues from its
   saved elapsed time, with no precipitation in those dimensions.
7. Confirm footsteps, water entry/jump, menu clicks and sparse music still work.

Limits: rain only, no snow/lightning/thunder; conservative occupied-cell roofs;
unknown exposure suppresses precipitation until the bounded scan completes.
