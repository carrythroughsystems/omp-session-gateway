- Move the OMP engineering baseline from v18.12.5 through v18.16.0 (#557) to published v18.17.0
  (#559), with pins derived by `scripts/upstream-pins.ts`. Registry v1, the discovery file format
  and socket paths, the relay protocol, and `collab.autoStart` are unchanged from v18.12.5, and the
  embedded client stays at v18.12.6. Exact-version canary run 42239663270 passed all eleven Linux
  stages and the eight supported Windows stages (`new-generation`, `fork`, and `branch-rewind`
  skipped by design on Windows) as Tested evidence. No qualification is claimed; published v0.9.0
  stays qualified on OMP v18.12.5.
