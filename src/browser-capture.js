// Reserved shortcuts (notably Ctrl+W) can only be captured in API fullscreen.
// Escape is deliberately included: a normal press opens the game menu, while
// the browser's mandatory long-Escape escape hatch remains available.
export const GAME_KEYBOARD_CODES = Object.freeze([
  "KeyW",
  "KeyA",
  "KeyS",
  "KeyD",
  "KeyQ",
  "F1",
  "F3",
  "F5",
  "Escape",
]);

export class BrowserCapture {
  constructor(
    element,
    {
      keyboard = globalThis.navigator?.keyboard,
      onChange = () => {},
      onMessage = () => {},
    } = {}
  ) {
    this.element = element;
    this.document = element.ownerDocument;
    this.keyboard = keyboard;
    this.onChange = onChange;
    this.onMessage = onMessage;
    this.captured = false;
    this.disposed = false;
    this.generation = 0;
    this.lastFullscreen = null;
    this.syncPromise = Promise.resolve(false);
    this.abort = new AbortController();
    this.document.addEventListener(
      "fullscreenchange",
      () => {
        void this.synchronize();
      },
      { signal: this.abort.signal }
    );
  }

  get fullscreen() {
    return this.document.fullscreenElement === this.element;
  }

  async toggle() {
    return this.fullscreen ? this.exit() : this.enter();
  }

  async enter() {
    if (this.disposed || typeof this.element.requestFullscreen !== "function")
      return {
        ok: false,
        message: "Fullscreen is unavailable in this browser.",
      };
    try {
      // Must be called from the user's button/key gesture, not a background retry.
      await this.element.requestFullscreen();
      await this.synchronize();
      return {
        ok: !this.disposed && this.fullscreen,
        keyboardCaptured: this.captured,
      };
    } catch {
      const message =
        "Fullscreen was not allowed. Double-tap W is available for sprinting.";
      this.onMessage(message);
      return { ok: false, message };
    }
  }

  async exit() {
    if (this.disposed) return { ok: false };
    try {
      if (this.fullscreen) await this.document.exitFullscreen();
      await this.synchronize();
      return { ok: !this.fullscreen };
    } catch {
      return { ok: false, message: "Hold Escape to leave fullscreen." };
    }
  }

  synchronize() {
    const fullscreen = !this.disposed && this.fullscreen;
    if (fullscreen === this.lastFullscreen) return this.syncPromise;
    this.lastFullscreen = fullscreen;
    const generation = ++this.generation;
    this.syncPromise = this.apply(fullscreen, generation);
    return this.syncPromise;
  }

  async apply(fullscreen, generation) {
    this.captured = false;
    if (!fullscreen) {
      this.keyboard?.unlock?.();
      if (!this.disposed)
        this.onChange({ fullscreen: false, keyboardCaptured: false });
      return false;
    }
    if (typeof this.keyboard?.lock !== "function") {
      this.onMessage(
        "This browser reserves some Ctrl shortcuts. Double-tap W to sprint."
      );
      this.onChange({ fullscreen: true, keyboardCaptured: false });
      return false;
    }
    try {
      await this.keyboard.lock([...GAME_KEYBOARD_CODES]);
      if (this.disposed || !this.fullscreen) {
        this.keyboard.unlock?.();
        return false;
      }
      if (generation !== this.generation) return false;
      this.captured = true;
      this.onChange({ fullscreen: true, keyboardCaptured: true });
      return true;
    } catch {
      if (generation !== this.generation || this.disposed) return false;
      this.onMessage(
        "Keyboard capture was not allowed. Double-tap W to sprint."
      );
      this.onChange({ fullscreen: this.fullscreen, keyboardCaptured: false });
      return false;
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.generation++;
    this.abort.abort();
    this.keyboard?.unlock?.();
    this.captured = false;
  }
}
