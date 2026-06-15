# codex-compiler

Prototype converter for Claude Code JSONL and Codex JSONL transcripts.

The converter uses a provider-neutral canonical transcript as an intermediate:

```text
Claude JSONL -> canonical -> Codex JSONL
Codex JSONL  -> canonical -> Claude JSONL
```

This is intentionally separate from the main app. It does not mutate
`~/.claude` or `~/.codex`; callers must pass explicit input and output files.

## CLI

```bash
node codex-compiler/cli.js inspect --provider claude --input session.jsonl
node codex-compiler/cli.js inspect --provider codex --input rollout.jsonl

node codex-compiler/cli.js claude-to-codex \
  --input ~/.claude/projects/.../session.jsonl \
  --output /tmp/session.codex.jsonl

node codex-compiler/cli.js codex-to-claude \
  --input ~/.codex/sessions/YYYY/MM/DD/rollout-....jsonl \
  --output /tmp/session.claude.jsonl
```

## Library

```js
const compiler = require('./codex-compiler');

const canonical = compiler.claudeToCanonical(claudeJsonlText);
const codexJsonl = compiler.canonicalToCodex(canonical);
```

## Current limits

- The Codex persisted rollout format is observed from local Codex sessions, not
  a documented stable API.
- Private reasoning/encrypted content is not converted into visible text.
- Non-visible provider context is preserved in canonical `meta.contextItems`
  where possible, including compact summaries, bootstrap/developer messages,
  agent progress messages, system metadata, and unknown events. Context-bearing
  items are materialized back into synthetic native sessions as
  `<shared-agent-context>` metadata so the target agent has the background
  without turning it into normal visible chat history.
- Provider-specific state such as Codex `session_meta` is preserved under
  canonical `meta.providerState`, but private/internal CLI semantics are still
  best-effort.
- Generated output should be validated with each CLI before enabling automatic
  sync in the main app.
