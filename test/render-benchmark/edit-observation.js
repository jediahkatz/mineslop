export function farLoadingWitness(facts) {
  return facts.requiredAbsent === true &&
    (facts.generationPending === true || facts.meshPending === true || facts.lodPending === true);
}

export function paidTransaction({ now, farStillLoading, prepare, commit }) {
  if (farStillLoading !== true) throw new Error("Paid edit requires a far-loading witness at submission");
  const startedMs = now();
  const prepared = prepare();
  if (!prepared || !commit(prepared)) throw new Error("Paid edit transaction refused");
  return { startedMs, transactionMs: now() - startedMs, farStillLoading: true };
}

// Constant-size map/ticket checks only; never scan geometry in a timing capture.
export function publicationObserved(edit, section, dirty, contextLost) {
  return edit?.ticket !== undefined && edit?.ticket !== null && !!section &&
    dirty === false && contextLost === false && section.stamp?.ticket === edit.ticket;
}
