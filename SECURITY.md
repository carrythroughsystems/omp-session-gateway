# Security policy

## Project status

Use the [latest stable release](https://github.com/carrythroughsystems/omp-session-gateway/releases/latest) with stock OMP `>= 18.1.20`. No OMP fork or custom build is required. Check [`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md) for supported and hardware-qualified host, browser, and device combinations. Never expose the loopback listener directly, never enable Tailscale Funnel, and do not route traffic through Portal Tunnel or another forwarder.

## Reporting a vulnerability

Please report suspected vulnerabilities privately through this repository's [GitHub Security Advisories](https://github.com/carrythroughsystems/omp-session-gateway/security/advisories/new). Do not open a public issue containing:

- collaboration links or URL fragments;
- OMP discovery/query tokens, gateway readiness tokens, or legacy publisher tokens;
- transcript content;
- Tailscale identity details;
- filesystem paths that reveal private project names; or
- exploit steps that would put current users at immediate risk.

If GitHub Security Advisories is unavailable, contact `@alphastorm` through a private channel listed on the maintainer's GitHub profile.

## What to include

Include the affected version/commit, deployment mode, impact, minimal reproduction, and whether any bearer capability or transcript data may have been exposed. Redact all live secrets and use synthetic fixtures.

## Response expectations

The volunteer-maintainer response targets are:

- acknowledge within 3 business days;
- provide an initial severity assessment within 7 business days; and
- coordinate disclosure after a fix or mitigation is available.

These are goals, not a service-level guarantee for a volunteer project.

## Security design

The detailed threat model, trust boundaries, and security invariants are in [`docs/SECURITY.md`](docs/SECURITY.md). Changes to authentication, capability handling, IPC, browser storage, logging, or OMP lifecycle must update that document and include security-focused tests.

## Supported versions

Security fixes ship in the [current stable release](https://github.com/carrythroughsystems/omp-session-gateway/releases/latest); see [`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md) for supported and hardware-qualified combinations. Older releases keep their own instructions and prerequisites — follow [`docs/UPGRADE_ROLLBACK.md`](docs/UPGRADE_ROLLBACK.md) when upgrading or rolling back, and note that gateway rollback does not switch the OMP executable. Please report suspected vulnerabilities in any version privately.
