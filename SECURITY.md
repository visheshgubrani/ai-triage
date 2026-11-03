# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub: **Security → Report a vulnerability** on this repository. Don't open a public issue.

Include what you found, how to reproduce it, and the impact you expect. You'll get an acknowledgement within a few days, and a fix or a plan once it's confirmed.

## Supported versions

This project is pre-1.0. Fixes land on `main` only.

## Scope

The threat model, the controls and the production checklist are in [docs/security.md](docs/security.md). Findings against the demo defaults (`TRIAGE_DEMO=true`, `demo-password`, the dev secrets in `.env.example`) are out of scope: production refuses to start with them.
