/**
 * One gate per game, shared by generation, import, and travel.
 * Acquire before the first await and hold through the final save. Busy requests
 * are rejected, not queued against a world that may no longer exist.
 */
export class TransitionGate {
  #busy = false;

  get busy() {
    return this.#busy;
  }

  /** Returns an idempotent release function, or null while another owner holds it. */
  tryAcquire() {
    if (this.#busy) return null;
    this.#busy = true;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#busy = false;
    };
  }

  /** Calls operation synchronously after acquisition; always releases on settlement. */
  async run(operation) {
    const release = this.tryAcquire();
    if (!release)
      return {
        ok: false,
        message: "A world transition is already in progress",
      };
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
