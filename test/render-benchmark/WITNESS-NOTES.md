# Audit witness interpretation

The reviewer reproduced a real stale ownership-cache defect on empty publication:
`meshResourceRevision` remained `0`, fresh ownership bits were `15`, and cached
bits were `0`. This is not a sampling-phase explanation. Keep the ownership
mismatch gate failed. An ownership mismatch alone is not a visible-hole witness.
Production repair is assigned separately; this harness does not repair it.

Future correctness captures record mismatching section keys, fresh/cached bits,
mesh-resource/cache revisions and mask revisions. Absent revision instrumentation
is reported as unavailable, never invented.

The recorded lifecycle exceptions are `Lighting draw barrier unavailable` from
normal RAF during context loss/recovery. Preserve them as failures even when
post-restore positive native-surface and pixel controls pass. They are not proof
that restored pixels are missing.

The prior frozen captures used an explicit worktree snapshot plus its recorded
patch and extra files, not a clean-ref baseline. Preserve the original artifacts.
Observer-heavy physical edit observation time is not clean publication latency;
the revised evaluator separates the performance deadline from bounded physical
proof. No new expensive capture is authorized by this re-audit.
