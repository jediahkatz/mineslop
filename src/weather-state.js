const CYCLE_SECONDS = 1200;
const MAX_ELAPSED = 1e12;

// Hash the entire coordinate/seed string: never truncate world cells to int32.
export function weatherHash(text) {
  let value = 2166136261;
  for (let i = 0; i < text.length; i++)
    value = Math.imul(value ^ text.charCodeAt(i), 16777619);
  return (value >>> 0) / 4294967296;
}

/** Missing legacy sidecars start clear; explicit malformed sidecars reject. */
export function normalizeWeatherSnapshot(data) {
  if (data === undefined) return { version: 1, elapsed: 0 };
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const fields = Object.getOwnPropertyDescriptors(data);
  if (Object.keys(fields).some((key) => !["version", "elapsed"].includes(key)) ||
      !fields.version || !("value" in fields.version) ||
      !fields.elapsed || !("value" in fields.elapsed) ||
      fields.version.value !== 1) return null;
  const elapsed = fields.elapsed.value;
  return Number.isFinite(elapsed) && elapsed >= 0 && elapsed <= MAX_ELAPSED
    ? { version: 1, elapsed } : null;
}

/** Pass the original archive, before structuredClone can invoke accessors. */
export function normalizeWeatherArchive(saved) {
  if (saved === null || saved === undefined)
    return { weather: normalizeWeatherSnapshot(undefined) };
  if (typeof saved !== "object" || Array.isArray(saved)) return null;
  const field = Object.getOwnPropertyDescriptor(saved, "weather");
  if (field && !("value" in field)) return null;
  const weather = normalizeWeatherSnapshot(field?.value);
  return weather ? { weather } : null;
}

// Rain only. Snow/accumulation is intentionally absent, including frozen oceans.
// Savannas are explicitly dry; cave labels are not substitutes for surface biome.
export function precipitationPolicy(biome, dimension) {
  if (dimension !== "overworld" || !biome ||
      (biome.dimension && biome.dimension !== "overworld") ||
      ["desert", "badlands", "savanna", "snowy", "cave"].includes(biome.category) ||
      !Number.isFinite(biome.temperature) || biome.temperature <= 0.15)
    return "none";
  return "rain";
}

export class WeatherState {
  constructor(seed, saved) {
    const snapshot = normalizeWeatherSnapshot(saved);
    if (!snapshot) throw new Error("Invalid saved weather");
    this.seed = String(seed);
    this.elapsed = snapshot.elapsed;
  }

  advance(dt, simulating = true) {
    if (!simulating || !Number.isFinite(dt) || dt < 0) return false;
    this.elapsed = Math.min(MAX_ELAPSED, this.elapsed + dt);
    return true;
  }

  sample() {
    const cycle = Math.floor(this.elapsed / CYCLE_SECONDS);
    const phaseTime = this.elapsed - cycle * CYCLE_SECONDS;
    const clearSeconds = 600 + Math.floor(weatherHash(`${this.seed}:rain:${cycle}`) * 300);
    const raining = phaseTime >= clearSeconds;
    const intensity = raining
      ? Math.max(0, Math.min(1, (phaseTime - clearSeconds) / 8, (CYCLE_SECONDS - phaseTime) / 8))
      : 0;
    return { elapsed: this.elapsed, phase: raining ? "rain" : "clear", intensity };
  }

  serialize() { return { version: 1, elapsed: this.elapsed }; }
}
