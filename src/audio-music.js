// Hand-authored original phrases with silence between notes and long phrase rests.
// Driven only by the host frame; no timers, oscillators or catch-up note bursts.
const PHRASES = Object.freeze([
  Object.freeze([[0, 0], [2.7, 3], [6.9, 1], [10.4, 4]]),
  Object.freeze([[0, 2], [3.8, 0], [8.2, 5], [12.6, 3]]),
  Object.freeze([[0, 1], [4.4, 4], [7.6, 2]]),
]);

export class AmbientMusic {
  constructor() {
    this.reset();
  }

  reset() {
    this.elapsed = 0;
    this.phrase = 0;
    this.note = 0;
    this.next = 9;
  }

  update(dt, play) {
    if (!Number.isFinite(dt) || dt <= 0) return;
    this.elapsed += Math.min(dt, 0.25);
    if (this.elapsed < this.next) return;
    const phrase = PHRASES[this.phrase];
    play(phrase[this.note][1]);
    this.note++;
    if (this.note === phrase.length) {
      this.phrase = (this.phrase + 1) % PHRASES.length;
      this.note = 0;
      this.next = this.elapsed + 31 + this.phrase * 7;
    } else {
      this.next = this.elapsed + phrase[this.note][0] - phrase[this.note - 1][0];
    }
  }
}
