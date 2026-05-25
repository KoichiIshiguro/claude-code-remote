# Security Policy

## Supported versions

This is a small personal-grade project. Only the `main` branch is supported.
Security fixes are applied to `main` and shipped immediately.

## Threat model

`claude-code-remote` is a **single-user remote** for the Claude Code CLI. It
is intentionally NOT hardened against:

- Multi-tenant abuse (there is no multi-user mode by design)
- Compromised host (anyone with shell access on the server already owns
  Claude's filesystem permissions)
- Browser-side malware on the operator's device

It IS designed to be safe to expose on the public internet **as long as**:

1. You enable HTTPS in front of it (Apache/Caddy/nginx + Let's Encrypt)
2. `ALLOWED_GITHUB_USER` is set to your single GitHub username
3. `SESSION_SECRET` is a real random string (`openssl rand -hex 32`)
4. `BASE_DIR` is restricted to a subtree you're comfortable with Claude editing

## Reporting a vulnerability

Please **do not** open a public issue for security problems. Instead:

- Open a [private security advisory](https://github.com/KoichiIshiguro/claude-code-remote/security/advisories/new), OR
- Email the maintainer directly (see the GitHub profile)

Please include:

- A clear description of the issue
- Steps to reproduce or a proof-of-concept
- The version / commit SHA you tested against

You can expect an acknowledgement within a few days. Triaged fixes are
released as soon as practical.

## Hall of fame

Reporters will be credited in the release notes unless they prefer to remain
anonymous.
