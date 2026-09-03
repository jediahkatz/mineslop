import { AudioEffects } from "../src/audio.js";

function parameter(value = 0) {
  return {
    value,
    events: [],
    setValueAtTime(next, at) {
      this.value = next;
      this.events.push(["set", next, at]);
    },
    linearRampToValueAtTime(next, at) {
      this.value = next;
      this.events.push(["ramp", next, at]);
    },
    cancelScheduledValues(at) {
      this.events.push(["cancel", at]);
    },
  };
}

export class FakeAudioContext {
  constructor({ state = "running", stereo = true } = {}) {
    this.state = state;
    this.currentTime = 0;
    this.destination = {};
    this.nodes = [];
    this.sources = [];
    this.buffers = [];
    this.resumeCount = 0;
    this.closeCount = 0;
    if (!stereo) this.createStereoPanner = undefined;
  }

  node(type) {
    const node = {
      type,
      connections: new Set(),
      disconnected: false,
      connect(target) {
        this.connections.add(target);
        return target;
      },
      disconnect() {
        this.connections.clear();
        this.disconnected = true;
      },
    };
    this.nodes.push(node);
    return node;
  }

  createGain() {
    if (this.failGain) throw new Error("Device lost while constructing gain");
    const node = this.node("gain");
    node.gain = parameter(1);
    return node;
  }

  createStereoPanner() {
    const node = this.node("panner");
    node.pan = parameter();
    return node;
  }

  createBuffer(channels, length, sampleRate) {
    if (this.failBuffer) throw new Error("Device lost while constructing buffer");
    const data = new Float32Array(length);
    const buffer = {
      numberOfChannels: channels,
      length,
      sampleRate,
      duration: length / sampleRate,
      getChannelData: () => data,
    };
    this.buffers.push(buffer);
    return buffer;
  }

  createBufferSource() {
    const source = this.node("source");
    source.playbackRate = parameter(1);
    source.stops = [];
    source.start = (at) => {
      if (this.failStart) throw new Error("Device lost while starting source");
      source.started = at;
    };
    source.stop = (at = this.currentTime) => {
      source.stops.push(at);
      if (at <= this.currentTime) source.finish();
    };
    source.finish = () => {
      source.onended?.();
    };
    this.sources.push(source);
    return source;
  }

  resume() {
    this.resumeCount++;
    if (this.resumeTask) return this.resumeTask();
    this.state = "running";
    return Promise.resolve();
  }

  close() {
    this.closeCount++;
    this.state = "closed";
    return this.closeTask?.() ?? Promise.resolve();
  }

  advance(seconds, deliverEnds = true) {
    this.currentTime += seconds;
    if (!deliverEnds) return;
    for (const source of this.sources) {
      if (
        source.started !== undefined &&
        (source.started + source.buffer.duration / source.playbackRate.value <=
          this.currentTime ||
          source.stops.some((at) => at <= this.currentTime))
      )
        source.finish();
    }
  }
}

export function audioFixture(options) {
  const context = new FakeAudioContext(options);
  const audio = new AudioEffects({
    createContext: () => context,
    random: () => 0,
  });
  return { audio, context };
}
