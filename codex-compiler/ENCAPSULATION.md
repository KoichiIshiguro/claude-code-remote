# Encapsulation boundary

`codex-compiler` is intentionally isolated from the main Claude Code Remote app.

Rules:

- Do not import from `../src` or mutate files outside this directory.
- Do not modify root `package.json` scripts while this remains a prototype.
- Do not write directly to `~/.claude` or `~/.codex` from library functions.
- CLI commands must require explicit `--input` and `--output` paths.
- Integration with the main app should happen later through a narrow adapter API,
  after fixture tests and manual CLI resume checks are stable.

Allowed public API:

- `claudeToCanonical(text, opts)`
- `canonicalToClaude(transcript, opts)`
- `codexToCanonical(text, opts)`
- `canonicalToCodex(transcript, opts)`
- `transcriptSummary(transcript)`

Everything else is prototype internals.
