# `packages/protocol`

Shared TypeScript types, strict runtime validators, and protocol constants for the stock OMP
local discovery/query contract and the gateway browser API. Browser JSON Schemas live in `schemas/`;
[PROTOCOL.md](../../docs/PROTOCOL.md) describes the complete boundary. The gateway is OMP's query
client, not a publisher registry server.

Enforced invariants:

- secret-bearing records are structurally distinct from browser-facing metadata;
- OMP registry v1 input (discovery entries and snapshot/link replies) strictly validates consumed fields and tolerates additive unknown fields, while refusing forbidden prompt/answer keys in snapshots;
- gateway browser API and Push v2 envelopes are strict and reject unknown versions or unknown fields;
- duplicate JSON keys, NUL bytes, invalid UTF-8, and out-of-bounds inputs are rejected across all frames;
- capability wrappers cannot be serialized and redact string/inspector conversion; and
- distinctive synthetic capability fixtures are covered by the repository leak scanner.
