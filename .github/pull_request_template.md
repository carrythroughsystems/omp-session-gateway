## Summary

<!-- What problem does this change solve? -->

## Validation

<!-- List exact commands/scenarios, toolchain, and results. Distinguish repository checks, source smokes, and exact signed-artifact/physical-client qualification; mark non-applicable checks explicitly. -->

## Security and privacy impact

- [ ] No capability, readiness token or OMP discovery token, transcript, or private identity is included in this PR or its artifacts.
- [ ] Authentication/authorization impact is described.
- [ ] Browser storage/cache/history impact is described.
- [ ] Logging/diagnostics impact is described.
- [ ] OMP lifecycle/generation impact is described.
- [ ] Relevant negative and leak-detection tests were added or updated, or non-applicability is explained.
- [ ] `docs/SECURITY.md` and ADRs were updated when trust boundaries changed.

## Compatibility

<!-- State the tested stock OMP version/commit, Bun version, protocol versions, and host/client scope. The >=18.1.20 integration minimum is not a blanket qualification claim. Preserve the native registry/controller boundary; no gateway-specific OMP plugin or custom build is required. -->

## Documentation

- [ ] User/operations docs updated.
- [ ] Compatibility lock/matrix updated when OMP integration changed.
- [ ] `changelog.d/` fragment added when user-visible.