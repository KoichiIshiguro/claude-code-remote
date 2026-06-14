# Claude/Codex history sync design

This project currently treats Claude Code's JSONL transcript as the canonical
session store. To support both Claude Code and Codex while sharing history, we
should add a transcript adapter layer instead of spreading provider-specific
JSONL assumptions through the websocket runner and UI.

## Goals

- Let the user choose Claude Code or Codex per session/turn.
- Show Claude-created sessions and Codex-created sessions in the same project
  sidebar.
- Convert Claude JSONL to Codex session files and Codex session files to Claude
  JSONL so either CLI can resume a shared conversation.
- Preserve human conversation, assistant text, tool calls, tool results,
  timestamps, session cwd, and lightweight titles/previews.
- Keep destructive operations scoped: never mutate the original transcript
  without a backup or generated mirror.

## Non-goals for the first implementation

- Bit-perfect preservation of provider-private metadata.
- Cross-provider resume with encrypted/internal reasoning blocks.
- Perfect mapping for every tool type. Unknown blocks should be retained in
  metadata and rendered as generic tool blocks where possible.
- Concurrent editing of the same canonical session by both CLIs.

## Public/observed format notes

No existing public Claude<->Codex transcript converter was found during
research. OpenAI's current Codex manual documents that local session transcripts
live under `$CODEX_HOME/sessions`, defaulting to `~/.codex/sessions`, and that
`codex resume <SESSION_ID>` / `codex exec resume <SESSION_ID>` can resume saved
threads. The manual also documents `codex exec --json`, but that stream is a
runtime event stream, not the persisted session JSONL format.

Local observed Codex session files on Codex CLI `0.139.0` are stored as:

```text
~/.codex/sessions/YYYY/MM/DD/rollout-<local timestamp>-<session id>.jsonl
```

Each line has a top-level shape like:

```json
{"timestamp":"...","type":"session_meta","payload":{"id":"...","cwd":"..."}}
{"timestamp":"...","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"..."}]}}
{"timestamp":"...","type":"event_msg","payload":{"type":"user_message","message":"..."}}
{"timestamp":"...","type":"response_item","payload":{"type":"function_call","name":"exec_command","arguments":"...","call_id":"..."}}
{"timestamp":"...","type":"response_item","payload":{"type":"function_call_output","call_id":"...","output":"..."}}
```

Claude Code session files are already handled by `src/jsonl-reader.js` and are
stored as:

```text
~/.claude/projects/<encoded cwd>/<session id>.jsonl
```

Claude events use `type: "user"`, `type: "assistant"`, `type: "system"`, and
Claude message content blocks such as `text`, `thinking`, `tool_use`, and
`tool_result`.

Because both vendors can change private transcript details, conversion should be
implemented as best-effort adapters with snapshot tests against real fixtures.

## Canonical transcript model

Introduce a provider-neutral internal model under `src/transcripts/`:

```js
{
  version: 1,
  id: "session id",
  cwd: "/absolute/project/path",
  createdAt: "ISO timestamp",
  updatedAt: "ISO timestamp",
  title: "optional display title",
  sourceProvider: "claude" | "codex" | "remote",
  providerIds: { claude: "...", codex: "..." },
  turns: [
    {
      id: "stable event id",
      role: "user" | "assistant" | "system",
      ts: "ISO timestamp",
      parts: [
        { type: "text", text: "..." },
        { type: "thinking", text: "...", private: true },
        {
          type: "tool_call",
          id: "tool id",
          name: "Bash",
          input: {},
          display: "npm test"
        },
        {
          type: "tool_result",
          toolCallId: "tool id",
          text: "...",
          isError: false
        },
        { type: "attachment", path: "...", mime: "image/png" }
      ],
      providerMeta: {
        claude: {},
        codex: {}
      }
    }
  ]
}
```

This model is not another permanent source of truth at first. It is the
conversion intermediate used by adapters and tests. Once stable, we can decide
whether to persist it as a project-local mirror.

## Adapter modules

Add these modules:

- `src/transcripts/canonical.js`: validation helpers, stable id generation,
  trim/merge utilities.
- `src/transcripts/claude-adapter.js`: `readClaudeJsonl`, `writeClaudeJsonl`,
  `claudePathFor`.
- `src/transcripts/codex-adapter.js`: `readCodexJsonl`, `writeCodexJsonl`,
  `codexPathFor`, `updateCodexSessionIndex`.
- `src/transcripts/sync-store.js`: provider mapping, mirror state, conflict
  detection.

The existing `src/jsonl-reader.js` can be kept as a Claude-specific adapter in
phase 1, then gradually moved behind the common interface.

## Conversion rules

### Claude to canonical

- `user` with string or text content -> user text part.
- `user` with `tool_result` blocks -> tool result parts attached to the prior
  assistant call when possible.
- `assistant` text blocks -> assistant text part.
- `assistant` thinking blocks -> private thinking part. Preserve for display if
  already supported, but allow dropping when writing to Codex if Codex cannot
  accept plaintext reasoning.
- `assistant` tool_use blocks -> tool_call part.
- `system compact_boundary`, `ai-title`, `last-prompt`, and similar metadata ->
  transcript metadata, not normal chat turns.

### Codex to canonical

- `session_meta.payload` -> transcript id/cwd/provider metadata.
- `response_item.payload.type === "message"`:
  - `role: "user"` -> user text, skipping developer/system bootstrap messages.
  - `role: "assistant"` -> assistant text.
- `event_msg.payload.type === "user_message"` can backfill user text when the
  matching `response_item` is absent.
- `response_item.payload.type === "function_call"` -> tool_call part. Parse
  `arguments` as JSON when possible, otherwise preserve as raw text.
- `response_item.payload.type === "function_call_output"` -> tool_result part
  by `call_id`.
- `event_msg.payload.type === "agent_message"` is display/progress commentary.
  Keep it only as assistant commentary if no matching assistant message exists;
  otherwise treat as live event metadata.
- `response_item.payload.type === "reasoning"` should not be converted to
  Claude visible text. Preserve only opaque metadata when present.

### Canonical to Claude JSONL

Generate Claude-compatible events with:

- `parentUuid`, `sessionId`, `uuid`, `timestamp`, `cwd`.
- `type: "user"` for user turns with `{ role: "user", content: "..." }`.
- `type: "assistant"` for assistant turns with Anthropic-style content blocks.
- `tool_call` -> `tool_use` block with stable `id`.
- `tool_result` -> following `user` event with `tool_result` content.
- `entrypoint: "cli"` in early metadata if needed so native Claude TUI resume
  picker can see mirrored sessions, matching the existing picker visibility fix.

Unknown Codex-only metadata should be saved under a generated comment-like
metadata event only if Claude tolerates it. Otherwise keep it only in the sync
mapping file.

### Canonical to Codex JSONL

Generate a minimal Codex persisted transcript:

- First line: `session_meta` with `id`, `timestamp`, `cwd`, `originator:
  "claude-code-remote"`, `source: "cli"`, `model_provider: "openai"`.
- User/assistant text turns as `response_item` message payloads.
- Tool calls as `response_item` function calls.
- Tool results as `response_item` function call outputs.
- Optional `event_msg.user_message` lines for user display/search parity.
- Update `~/.codex/session_index.jsonl` with `{ id, thread_name, updated_at }`
  if a title is available.

The first implementation should also verify generated files by launching
`codex resume <SESSION_ID>` in a controlled manual test, because Codex's
persisted format is not documented as a stable public API.

## Runtime architecture

Phase 1 should keep Claude behavior unchanged and add Codex as an opt-in
provider:

1. Extend project/session records with `provider` and `providerSessionIds`.
2. Add an agent selector in settings and in the session header.
3. Add `codex-session-manager.js` using `codex exec --json` for non-interactive
   turns. For resume, run `codex exec resume <SESSION_ID> --json "<prompt>"`.
4. Normalize live Codex JSONL events into the existing websocket event shape so
   the UI can render them without a rewrite.
5. After each completed turn, sync the source provider transcript to the other
   provider mirror.

Phase 2 can replace `jsonl-reader.js` calls with a `history-store` interface:

```js
historyStore.listSessions(projectPath)
historyStore.readHistory(sessionRef)
historyStore.runTurn({ provider, sessionRef, prompt, imagePaths, model, effort })
historyStore.purgeSession(sessionRef)
historyStore.syncSession(sessionRef, targetProvider)
```

## Conflict handling

Use generated mirrors, not in-place rewrites, until the sync layer is proven:

```text
data/history-sync.json
{
  "shared-session-id": {
    "cwd": "/project",
    "primary": "claude",
    "claude": {
      "sessionId": "...",
      "path": "...",
      "mtime": 1781400000000,
      "lastHash": "sha256..."
    },
    "codex": {
      "sessionId": "...",
      "path": "...",
      "mtime": 1781400000000,
      "lastHash": "sha256..."
    }
  }
}
```

If both provider files changed since the last sync hash, mark the session as
`conflicted` and do not auto-merge. The UI should offer:

- keep Claude version,
- keep Codex version,
- create fork from each side.

For the first release, last-writer-wins is too risky because either CLI may
compact, summarize, or rewrite context in provider-specific ways.

## Files and UI touch points

- `src/session-manager.js`: split Claude-specific spawning from common runner
  orchestration.
- `src/ws-handler.js`: replace direct `jsonlReader` calls with `historyStore`
  calls; add provider in `new_session`, `send_prompt`, session list, and archive
  payloads.
- `src/jsonl-reader.js`: keep existing Claude display folding, then migrate into
  `claude-adapter.js`.
- `public/terminal.html`: add provider selector, provider badge in session list,
  and sync/conflict indicators.
- `data/config.json`: add `defaultProvider: "claude" | "codex"` and optional
  `codexPath`.

## Test plan

Add fixture-based tests before any UI work:

- Claude JSONL fixture -> canonical -> displayed history equals current
  `readHistory` output.
- Codex JSONL fixture -> canonical -> expected user/assistant/tool blocks.
- Claude -> canonical -> Codex -> canonical round trip preserves visible turns.
- Codex -> canonical -> Claude -> canonical round trip preserves visible turns.
- Conflict detector catches two-sided edits by hash.
- Generated paths are stable and do not escape `$HOME/.claude` or
  `$CODEX_HOME/sessions`.

Manual verification:

- Start a Claude session, sync to Codex, run `codex resume <id>` and confirm the
  prior user/assistant text is visible.
- Start a Codex session, sync to Claude, run `claude --resume <id>` and confirm
  the prior user/assistant text is visible.
- Continue from each side once and confirm the opposite mirror updates.

## Recommended implementation order

1. Add fixtures from local observed Claude/Codex sessions with sensitive content
   redacted.
2. Implement canonical model and read-only adapters.
3. Switch the UI history reader to provider-neutral reads while defaulting to
   Claude only.
4. Add write adapters and a manual `node scripts/sync-history.js` command.
5. Add Codex runner using `codex exec --json`.
6. Add UI provider selector and automatic post-turn mirroring.
7. Add conflict UI.

This order keeps the current Claude-only product stable while giving us
testable conversion code before Codex can mutate real transcripts.
