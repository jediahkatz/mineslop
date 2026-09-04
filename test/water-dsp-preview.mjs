// DSP preview, NOT a game recording. Run before/after the change with distinct paths.
// Three deterministic variants at the real entry gain, separated by silence.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { AUDIO_SAMPLE_RATE, AUDIO_VARIANTS } from "../src/audio-dsp.js";
import { soundDescription, synthesizeSound } from "../src/audio-samples.js";

const output = process.argv[2];
if (!output?.endsWith(".wav")) throw Error("Pass a new .wav output path");
const definition = soundDescription("water-entry");
const stride = AUDIO_SAMPLE_RATE;
const pcm = Buffer.alloc(stride * AUDIO_VARIANTS * 2);
for (let variant = 0; variant < AUDIO_VARIANTS; variant++) {
  const data = synthesizeSound(definition, variant);
  for (let i = 0; i < data.length; i++)
    pcm.writeInt16LE(Math.round(data[i] * definition.gain * 32767), (variant * stride + i) * 2);
}
const header = Buffer.alloc(44);
header.write("RIFF");
header.writeUInt32LE(36 + pcm.length, 4);
header.write("WAVEfmt ", 8);
header.writeUInt32LE(16, 16);
header.writeUInt16LE(1, 20);
header.writeUInt16LE(1, 22);
header.writeUInt32LE(AUDIO_SAMPLE_RATE, 24);
header.writeUInt32LE(AUDIO_SAMPLE_RATE * 2, 28);
header.writeUInt16LE(2, 32);
header.writeUInt16LE(16, 34);
header.write("data", 36);
header.writeUInt32LE(pcm.length, 40);
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, Buffer.concat([header, pcm]), { flag: "wx" });
console.log(JSON.stringify({ output, label: "DSP preview; three original variants; actual entry gain",
  gain: definition.gain, duration: definition.duration, sampleRate: AUDIO_SAMPLE_RATE }));
