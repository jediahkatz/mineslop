export const REMOTE_DRAG_THRESHOLD = 4; // CSS pixels, independent of sensitivity.
export const REMOTE_TAP_MS = 300;

const point = (event) =>
  Number.isFinite(event.clientX) && Number.isFinite(event.clientY);

/** Uncaptured right-button gesture; deliberately never reads movementX/Y. */
export class RemoteLook {
  constructor() {
    this.reset();
  }

  reset() {
    this.gesture = null;
  }

  get dragging() {
    return this.gesture?.dragging ?? false;
  }

  begin(event) {
    this.reset();
    if (!point(event)) return;
    this.gesture = {
      startX: event.clientX,
      startY: event.clientY,
      x: event.clientX,
      y: event.clientY,
      at: event.timeStamp,
      distance: 0,
      dragging: false,
    };
  }

  move(event) {
    const gesture = this.gesture;
    if (!gesture) return { x: 0, y: 0 };
    if (!point(event)) {
      this.reset();
      return { x: 0, y: 0 };
    }
    let x = event.clientX - gesture.x;
    let y = event.clientY - gesture.y;
    gesture.x = event.clientX;
    gesture.y = event.clientY;
    gesture.distance += Math.hypot(x, y);
    if (!gesture.dragging) {
      if (gesture.distance < REMOTE_DRAG_THRESHOLD) return { x: 0, y: 0 };
      gesture.dragging = true;
      // Once a drag is recognized, apply its buffered start exactly once.
      // Slow 2px events conserve their full displacement, including reversals.
      x = gesture.x - gesture.startX;
      y = gesture.y - gesture.startY;
    }
    return { x, y };
  }

  end(event) {
    // Include the release position even if its final mousemove was coalesced.
    const delta = this.move(event);
    const gesture = this.gesture;
    const elapsed = event.timeStamp - gesture?.at;
    const tap = Boolean(
      gesture && !gesture.dragging && elapsed >= 0 && elapsed <= REMOTE_TAP_MS
    );
    this.reset();
    return { ...delta, tap };
  }
}
