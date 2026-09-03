import assert from "node:assert/strict";
import { Gameplay } from "../src/gameplay.js";
import { HurtFeedback } from "../src/hurt-feedback.js";

// Real health publication drives every positive feedback assertion. This is
// an isolated domain fixture, not a browser or saved-world walkthrough.
export function hurtFixture(t, { motionPreference = { matches: false } } = {}) {
  const events = [];
  const feedback = new HurtFeedback({ motionPreference });
  const gameplay = new Gameplay({
    onHurt(event) {
      events.push(event);
      feedback.noteHealthLoss(event);
    },
    onDeath: () => feedback.reset(),
  });
  t.after(() => {
    feedback.dispose();
    gameplay.dispose();
  });
  return { gameplay, feedback, events, motionPreference };
}

export function loadVitals(gameplay, vitals) {
  assert.equal(
    gameplay.load({ ...gameplay.serialize(), ...vitals }, { notify: false }),
    true
  );
}
