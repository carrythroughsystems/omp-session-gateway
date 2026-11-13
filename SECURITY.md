# Security policy

OMP Session Gateway is a companion to Oh My Pi (OMP): a loopback daemon behind Tailscale Serve. This policy tells you how to report a vulnerability privately and which releases receive security fixes.

## Project status

Use the [latest stable release](https://github.com/carrythroughsystems/omp-session-gateway/releases/latest) with stock OMP `>= 18.1.20`. Check [Platforms and browsers](docs/COMPATIBILITY.md#platforms-and-browsers) and [Current claim](docs/COMPATIBILITY.md#current-claim) for supported and hardware-qualified host, browser, and device combinations. Never expose the loopback listener directly, never enable Tailscale Funnel, and do not route traffic through another forwarder (such as Portal Tunnel).

## Reporting a vulnerability

Report suspected vulnerabilities privately through this repository's [GitHub Security Advisories](https://github.com/carrythroughsystems/omp-session-gateway/security/advisories/new). Do not open a public issue containing:

- collaboration links or URL fragments (a **View** or **Control** link is a bearer secret, called a capability in [Security design and threat model](docs/SECURITY.md));
- OMP discovery/query tokens, gateway readiness tokens, or legacy publisher tokens;
- transcript content;
- Tailscale identity details;
- filesystem paths that reveal private project names; or
- exploit steps that would put current users at immediate risk.

If GitHub Security Advisories is unavailable, contact `@alphastorm` through a private channel listed on the maintainer's GitHub profile.

## What to include

Include the affected version/commit, deployment mode (`tailscale-serve` or `dev-localhost`), impact, minimal reproduction, and whether any collaboration capability or transcript data may have been exposed. Redact all live secrets and use synthetic test inputs rather than real workspaces or sessions.

## Response expectations

The volunteer-maintainer response targets are:

- acknowledge within 3 business days;
- provide an initial severity assessment within 7 business days; and
- coordinate disclosure after a fix or mitigation is available.

These are goals, not a service-level guarantee for a volunteer project.

## Security design

The detailed threat model, trust boundaries, and security invariants are in [Security design and threat model](docs/SECURITY.md). Changes to authentication, capability handling, IPC, browser storage, logging, or OMP lifecycle must update that document and include security-focused tests.

## Supported versions

Security fixes ship in the [current stable release](https://github.com/carrythroughsystems/omp-session-gateway/releases/latest); see [Compatibility and support policy](docs/COMPATIBILITY.md#current-claim) for supported and hardware-qualified combinations.

Older releases keep their own instructions and prerequisites — follow [Upgrade and rollback](docs/UPGRADE_ROLLBACK.md) when upgrading or rolling back; gateway rollback does not switch the OMP executable. Report suspected vulnerabilities in any version privately.
