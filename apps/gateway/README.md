# `apps/gateway`

Implementation of the `omp-gateway` CLI and per-user `omp-gatewayd` daemon.

Stock OMP `>= 18.1.20` supplies the collaboration controller and local registry natively. This
separately installed gateway reads that registry; no fork, custom OMP build, or gateway-specific
OMP plugin is required. Enable `collab.autoStart` once, then start plain `omp`. Deployment still
requires Bun 1.4.4 and TUN-mode Tailscale Serve; see [OMP integration](../../docs/OMP_INTEGRATION.md).

Implemented modules:

- strict configuration and private gateway-only readiness token;
- read-only OMP discovery, endpoint ownership/permission checks, and per-host query authentication;
- bounded snapshot polling and generation-bound, just-in-time link queries to OMP-owned endpoints;
- schema validation and protocol versioning;
- metadata-only in-memory registry; no capability store or cache;
- generation and poll/TTL reconciliation;
- loopback-only HTTP server;
- Tailscale Serve identity middleware and exact allowlist;
- metadata list, SSE, just-in-time launch, generic local health, and redacted local diagnostics;
- static PWA and pinned collab-web asset serving;
- `serve`, `install`, `uninstall`, `status`, `doctor`, and `rotate-readiness-token` commands;
- systemd-user, LaunchAgent, and Windows current-user integration;
- privacy-safe structured logging.

## Optional multi-host dashboard and speech

Old configurations remain local-only: `http.trustedDashboardOrigins` defaults to `[]`,
`fleet.targets` to `[]`, and `speech.browserRecognition` to `false`. `fleet.label` defaults to the
first DNS label of `http.publicOrigin` (or the loopback address for development).

Configure both sides in the private `config.json`; there are no new install flags:

```json
{
  "http": {
    "trustedDashboardOrigins": ["https://dashboard.example.ts.net"]
  },
  "fleet": {
    "label": "Studio",
    "targets": [
      { "id": "remote", "label": "Remote host", "origin": "https://remote.example.ts.net" }
    ]
  },
  "speech": { "browserRecognition": false }
}
```

This is a partial configuration example: keep the existing listener/public-origin and authentication
settings. A dashboard lists each target in `fleet.targets`; each target must separately list the
dashboard's exact origin in `http.trustedDashboardOrigins` **and** allow the user's Tailscale login in
`auth.allowedLogins`. Browser requests go directly to the target: no gateway proxy, shared login,
remote SSE, or remote push subscription is created. Alerts remain scoped to each installed host.
Targets are limited to seven and trusted dashboards to eight, with canonical HTTPS origins, no
duplicates or local-origin collisions. Development gateways may additionally use canonical
`http://127.0.0.1:<port>` or `http://[::1]:<port>` origins.

Restart the gateway after editing its configuration and **reload the PWA** to load the new host list
or speech setting. Keyboard dictation works with speech recognition disabled. Enabling
`speech.browserRecognition` permits the opt-in in-page recognizer on Control sessions only; reviewing
and using recognized text is separate from Send. Recognition availability and audio processing depend
on the browser and its speech provider.

Install/reinstall preserves authored fleet and speech settings. A rollback to a retained runtime
older than `0.8.0` first atomically saves the full authored bytes to owner-only
`config.pre-rollback.json`, then removes `http.trustedDashboardOrigins`, `fleet`, and `speech` from
`config.json` before starting that runtime. An existing backup refuses the rollback rather than being
overwritten. To restore those options, install `0.8.0` or newer first, replace `config.json` with the
backup, restart the gateway, and reload the PWA. A failed rollback restores the original configuration
before repairing the current service.

Windows x86-64 build 26100 at interactive logon is qualified for the latest release; supported
platforms, automated test coverage, and exact qualified combinations and evidence are in
[Compatibility](../../docs/COMPATIBILITY.md#platforms-and-browsers).

Do not implement a relay in this package for v1. Do not add a persistent session database.
