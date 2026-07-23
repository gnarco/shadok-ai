# CLAUDE.md — shadok-ai

Read this first. It exists so you can evolve shadok-ai **without re-scanning
the whole codebase** and **without repeating the mistakes already made**.
Keep it up to date when you change architecture, invariants, or the protocol.

## What shadok-ai is

A **web cockpit that drives multiple real Claude Code TUI sessions in
parallel**. Each "channel" in the UI is one `claude` process. It runs on the
user's **Claude subscription** (not the API), via a pseudo-terminal or tmux —
so it's Claude Code piloting Claude Code, with a browser chat on top.

It largely **built itself** (agents in git worktrees). See `docs/architecture.md`
for the deep dive; `docs/superpowers/specs/*` for per-feature design specs.

## Build / run / restart (do it exactly this way)

```bash
npm run build          # tsc → dist/  (ALWAYS build before restarting)
```

The server runs in its **own dedicated tmux session** so it survives shells,
agents, and crashes. Restart it like this (token injected in the shell, never
by node — the keychain ACL blocks node→security):

```bash
tmux kill-session -t shadok-ai-server 2>/dev/null; sleep 1
tmux new-session -d -s shadok-ai-server \
  "cd ~/projects/shadok-ai && CLAUDE_CODE_OAUTH_TOKEN=\$(security find-generic-password -s 'Claude Code-credentials' -a \"\$USER\" -w | jq -r '.claudeAiOauth.accessToken') node dist/server.js > /tmp/cp.log 2>&1"
```

UI: **http://localhost:3789**. Logs: `/tmp/cp.log`. Health: `curl -s -o /dev/null -w '%{http_code}' localhost:3789/`.

- `CLAUDE_CODE_OAUTH_TOKEN` is only for the `/usage` (pace) endpoint; `claude`
  itself authenticates via the keychain.
- Never `cat` the token or print it. Extract it in the shell, pass via env.

## Architecture map (file → responsibility)

| File | Responsibility |
|---|---|
| `src/server.ts` | HTTP + WebSocket server. Session registry (`sessions` Map), the `Live` object, the WS message handlers, all endpoints. The hub. |
| `src/session.ts` | `PtyPilot` — drives `claude` in a **node-pty** PTY + `@xterm/headless`. Dies with the server. |
| `src/tmux.ts` | `TmuxPilot` — same interface as `PtyPilot`, but runs `claude` in a **detached tmux session** (`cp-<sessionId>`). **Survives server restart** (reattaches). Default transport when tmux is present. |
| `src/tail.ts` | Tails a session's `.jsonl` transcript → streams assistant text/tool_use/tool_result + token usage. **This is the source of truth for content**, not the screen. |
| `src/extract.ts` | Parse the transcript / screen: `loadHistory`, `detectDialog`, `listSessions`, `findSessionId`. |
| `src/detect.ts` | `screenShowsWork(screen)` — the fragile "is Claude working" heuristic. |
| `src/worktree.ts` | Git worktree isolation: create, diff, list past sessions, recreate a reclaimed checkout. |
| `src/usage.ts` | Fetches subscription usage (5h/7d) from `/api/oauth/usage`. |
| `src/pace.ts` | The quota **guardrail**: ideal-pace computation + block verdict. |
| `src/retry.ts` | Auto-retry of turns that died on a transient API error (529, 5xx, timeout). |
| `src/channels.ts` | Server-side persistence of the channel + group lists, keyed by launch dir. |
| `src/cli.ts` | One-shot CLI (`node dist/cli.js "prompt"`), separate from the server. |
| `public/index.html` | The entire web client (no framework, no build). Channels, groups, dialogs, engine room, diff panel, pace/usage gauges, context bars. |
| `.claude/skills/shadok-ai-agents/pilotctl.mjs` | Thin client that lets an agent spawn/pilot other agents through the server (used by the `shadok-ai-agents` skill). |

## Core model

- **One session = one `claude` process = one `Live` object**, shared by N
  WebSocket clients (several tabs/devices follow the same session live).
- **Content** flows from the `.jsonl` tail (complete, streamed, survives
  everything). **Control** (submit, detect turn end, dialogs, engine-room
  screen) flows through the pilot's rendered screen. Don't scrape the screen
  for response text — that's what caused truncation; use the tail.
- **Sessions outlive clients**: closing a tab detaches; the process keeps
  running and is reclaimed only after `SHADOK_IDLE_MIN` min (default 60)
  with no client, or on explicit `stop`. With tmux, it also outlives the
  server.

## WebSocket protocol (`/ws`)

**client → server:** `start` (cwd/resume/continue/worktree/branch/repo),
`prompt` (text, `force?`), `choose` n, `toggle` n, `confirm`, `freetext` n
text, `key`, `settle`, `stop`.

**server → client:** `ready`, `working`, `turn-done`, `stream-text`,
`stream-tool`, `stream-result`, `history`, `dialog`, `screen`, `tokens`,
`context`, `prompt-echo`, `pace-blocked` / `pace-hold` / `pace-resumed`,
`auto-retry-*`, `gone`, `error`, `exited`, `stopped`.

**HTTP:** `/usage` (5h/7d + pace verdict), `/live` (running sessions),
`/sessions` `/recover` (resumable), `/diff`, `/channels` `/groups` (GET/PUT,
persisted per launch dir), `/defaults` (server cwd).

## Invariants & hard-won gotchas (DO NOT relearn these the hard way)

1. **Session cwd must be the session's real directory.** `loadHistory` is keyed
   by the cwd (encoded → `~/.claude/projects/<enc>/<id>.jsonl`). A worktree
   session resumed with the repo-root cwd shows **no history**. Always resume a
   worktree session with its worktree path.
2. **Detection heuristics are fragile.** `screenShowsWork` must ignore a
   *quoted* "esc to interrupt" (Claude explaining shadok-ai tripped it →
   session stuck "busy"). `detectDialog` must strip a right-hand **preview
   column** (AskUserQuestion charts) or option labels get mangled.
3. **Single-select dialogs are navigated, not typed.** `choose` moves the `❯`
   cursor with arrow keys then Enter — preview-style dialogs ignore digit keys.
   Multi-select `toggle` uses the digit; `confirm` does Tab→Submit→Enter.
4. **The resume-from-summary prompt is auto-answered** ("full session as-is")
   at startup and never surfaced (`SHADOK_RESUME_SUMMARY=1` to disable).
5. **Worktrees are durable** — never auto-removed. Branch + uncommitted work
   always survive; cleanup is explicit only.
6. **Persistence must never save a partial/empty list.** The channel list
   eroded to one because `persistChannels` skipped tabs without a sessionId and
   pushed mid-restore. Restored tabs get their sessionId **immediately**; pushes
   are suppressed during restore; a failed fetch must never PUT `[]`.
7. **Don't let an agent restart the server.** It kills sibling PTY sessions
   mid-work. (tmux mitigates, but still.) Only the human / top-level restarts it.
8. **Never `git merge` blind in the shared repo.** Parallel agents leaving
   conflict markers in `.ts`/`.html` = broken build + crashed server + a whole
   afternoon lost. Agents work in **isolated worktrees**; landing is a reviewed,
   conflict-checked, build-verified step. This is the #1 source of past chaos.
9. **Pace guard** blocks a prompt when `used > idealPace + PACE_EPSILON`
   (currently 2). A prompt can bypass with `force: true`. A blocked spawn is
   silent to the parent — surface it if you touch that path.

## Conventions

- TypeScript, ESM, Node 20. `.js` extensions in imports (NodeNext).
- Comments explain **why**, in the surrounding language (mixed FR/EN here).
- Feature work: write a spec in `docs/superpowers/specs/`, build in a worktree,
  land reviewed. Keep this file and `docs/architecture.md` current.
- After any change with runtime surface: `npm run build`, restart the server in
  its tmux session, and verify in the browser (not just tsc).
