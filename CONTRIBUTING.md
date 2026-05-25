# Contributing

Thanks for taking a look. This project exists because every other Claude Code
web UI on GitHub was either bloated, abandoned, or both. The whole point is
to **stay small enough that one person can read the entire source in an
afternoon**. PRs that respect that goal are very welcome.

## Ground rules

1. **LOC matters.** A 50-line PR that adds a feature is fantastic. A
   2000-line PR that adds a build pipeline is a different project. If
   you're not sure, open an issue first.
2. **No new heavy runtime dependencies.** Current dependency count is
   single-digit and all are tiny. Adding React / Tailwind / a CSS framework
   / a state library is out of scope.
3. **No build step for the frontend.** Vanilla JS + `<script>` tags is a
   feature, not a bug. It means a clone-and-run developer experience.
4. **Mobile must keep working.** The PWA on iOS Safari is tested by hand on
   every change. Don't break it.
5. **Single-user by design.** Multi-user, RBAC, admin panels, etc. are
   out of scope. Use a reverse proxy or oauth2-proxy if you need that.

## Development

```bash
git clone https://github.com/KoichiIshiguro/claude-code-remote.git
cd claude-code-remote
npm install
cp .env.example .env   # fill in your secrets
npm run dev            # node --watch, auto-restart on file change
```

You'll need a working `claude` CLI logged into Anthropic, and a GitHub OAuth
App pointing at `http://localhost:4000/auth/github/callback`.

## Style

- 2-space indentation, no semicolons-skipping, single quotes
- Prefer plain functions over classes
- No comments that just restate the code
- Comments are welcome when they explain the **why** (a subtle invariant,
  a hidden Claude CLI behavior, a browser quirk)

## Commit messages

Conventional-commits-ish, but not strict:

- `fix: shutdown flush no longer wipes sessions.json`
- `feat: refresh button on file viewer`
- `docs: clarify CLAUDE_PATH under PM2`

## PR checklist

- [ ] Tested manually in a real browser (Chrome desktop is fine, bonus for iOS Safari)
- [ ] No new `npm` runtime dependencies (or a great reason for the one you added)
- [ ] Frontend still works without a build step
- [ ] README updated if you changed user-visible behavior
- [ ] No secrets, tokens, or personal paths in the diff

## What gets merged fast

- Bug fixes with reproducible reports
- Small, focused features that fit the single-user / minimal philosophy
- Better error messages
- Docs improvements

## What probably won't get merged

- Multi-user / RBAC / admin panel
- Build pipelines (webpack/vite/esbuild)
- CSS frameworks (Tailwind/Bootstrap)
- Major rewrites in TypeScript/React/Vue/Svelte
- "While I was at it I also refactored everything" PRs

Open an issue first if you're unsure — saves us both time.
