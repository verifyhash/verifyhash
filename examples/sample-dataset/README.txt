Sample training dataset for the verifyhash / DataLedger end-to-end example.

This directory stands in for a real AI training dataset. It is intentionally tiny
(a handful of small text files, no secrets, no large blobs) so the example runs in
well under a second and the whole pipeline is auditable by eye.

The per-file source/license hints live in ../sample-dataset.hints.json. Those hints
are UNTRUSTED, self-asserted metadata: they are NOT bound into the Merkle root and
prove nothing on their own. The example's policy check is a gate on those CLAIMS,
not a verification that any license is genuinely correct.
