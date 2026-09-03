// Both entry points name the same mixer and SoundBank, never parallel contexts.
// Keep AudioEngine for the standalone integration and AudioEffects for callers
// of the complete audio contract.
export {
  AUDIO_LIMITS,
  AUDIO_MASTER_GAIN,
  MAX_AUDIO_VOICES,
  MAX_VOICE_GAIN,
  AudioEngine,
  AudioEngine as AudioEffects,
} from "./audio-engine.js";
