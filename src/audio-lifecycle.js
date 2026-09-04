/** Optional device/observer failures must never stop the simulation or UI action. */
export function audioOperation(audio, method, ...args) {
  try {
    const result = audio?.[method]?.(...args);
    return result?.then ? Promise.resolve(result).catch(() => false) : result;
  } catch {
    return false;
  }
}
