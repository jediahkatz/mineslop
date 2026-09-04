import { audioOperation } from "./audio-lifecycle.js";

/** Delegate to the real #ui controls, including keyboard-generated trusted clicks.
 * The getter lets a Game own one mixer across title, world rebuilds and pause.
 */
export function attachAudioUI(getAudio, doc = globalThis.document) {
  if (!doc?.addEventListener) return () => {};
  let disposed = false;
  let generation = 0;
  function visibility() {
    generation++;
    audioOperation(getAudio(), "setHidden", Boolean(doc.hidden));
  }
  function activate(event) {
    if (disposed || event.isTrusted !== true || event.defaultPrevented || doc.hidden) return;
    const selector = event.type === "change" ? "select" : 'button, input[type="checkbox"], input[type="radio"]';
    const target = event.target?.closest?.(selector);
    if (!target || !target.closest("#ui") || target.disabled ||
      target.closest('[hidden], [inert], [aria-disabled="true"], fieldset:disabled')) return;
    // Checkbox pre-activation toggles checked before click capture. Do not rely
    // on a microtask waiting until the later change handler has muted the mixer.
    if (target.id === "sound-setting" && target.checked === false) return;
    const audio = getAudio();
    if (!audio) return;
    const current = ++generation;
    audioOperation(audio, "setHidden", false);
    const revision = audio.lifecycleRevision;
    // unlock() itself is synchronous until resume(): browser gesture is retained.
    const unlocked = audioOperation(audio, "unlock");
    const waitingForDevice = audio.context?.state !== "running" || Boolean(audio.resuming);
    void Promise.resolve(unlocked).then((ready) => {
      if (ready && !disposed && !event.defaultPrevented && current === generation &&
        getAudio() === audio && (!waitingForDevice || audio.lifecycleRevision === revision) && !doc.hidden)
        audioOperation(audio, "play", "ui-click");
    });
  }
  // Capture validates the still-visible control; handlers may then hide its menu.
  // Playback runs after handlers, so the mute checkbox takes effect first.
  doc.addEventListener("click", activate, true);
  doc.addEventListener("change", activate, true);
  doc.addEventListener("visibilitychange", visibility);
  visibility();
  return () => {
    disposed = true;
    generation++;
    doc.removeEventListener("click", activate, true);
    doc.removeEventListener("change", activate, true);
    doc.removeEventListener("visibilitychange", visibility);
  };
}
