# shadok-ai — technical architecture

Deep dive behind `CLAUDE.md`. Read `CLAUDE.md` first for the map and invariants.

## The big picture

```
 browser (public/index.html)            server (src/server.ts)          claude CLI
 ┌───────────────────────┐   WebSocket  ┌──────────────────────┐       ┌──────────┐
 │ channels / groups     │ ───/ws────▶  │ sessions: Map<id,Live>│       │  TUI in  │
 │ chat, dialogs, gauges │ ◀─────────── │  per session:         │──────▶│  a PTY / │
 │ engine room, diff     │              │  • pilot (PTY|tmux)   │ drive │  tmux    │
 └───────────────────────┘   HTTP GET   │  • .jsonl tail        │◀──────│          │
             │              ───────────▶ │  • screen watcher     │ read  └────┬─────┘
             │  /usage /live /diff …     └──────────────────────┘            │ writes
             ▼                                     ▲                          ▼
   ~/.shadok-ai/channels/<cwd>.json              └──── reads ── ~/.claude/projects/<cwd>/<id>.jsonl
   (channel + group lists)                                        (authoritative transcript)
```

Two independent data planes per session:

- **Content plane — the `.jsonl` tail.** Claude Code writes every turn to a
  JSONL transcript. `src/tail.ts` tails it and emits complete assistant text,
  tool calls, tool results, and token usage. This is authoritative and
  survives everything (it's a file). The UI's chat is built from it.
- **Control plane — the rendered screen.** The pilot exposes `screen()` (the
  rendered TUI). Used to: submit prompts, detect turn end (`screenShowsWork`),
  detect interactive dialogs (`detectDialog`), parse `ctx:NN%`, and mirror the
  raw TUI in the "engine room". **Never** used to reconstruct response text.

Splitting these is the key design decision. Early versions scraped the screen
for content and suffered truncation + fragility; the tail fixed it.

## Transport: PTY vs tmux

Both implement the same interface (`start, screen, submit, press, write,
waitForIdle, isWorking, onExit, hasExited, stop, kill`). The server picks one
via `makePilot()`.

- **`PtyPilot` (node-pty)** — spawns `claude` as a child of the server,
  with `@xterm/headless` replaying the ANSI stream into a virtual screen so we
  can read it. Must forward xterm's query responses (cursor position, etc.)
  back to the PTY or the TUI ignores keystrokes. Dies with the server.
- **`TmuxPilot` (default when tmux present)** — runs `claude` inside a detached
  tmux session named `cp-<sessionId>`. tmux owns the terminal, so the agent
  survives the server crashing/restarting; on next `start` for that id,
  `has-session` is true → **reattach** instead of respawn. `screen()` is a
  polled `capture-pane`; input is `send-keys` / bracketed-paste `paste-buffer`.
  tmux handles terminal queries itself, so that whole class of PTY hacks
  disappears. Does **not** survive a machine reboot (tmux dies then).

`SHADOK_TMUX=0` forces node-pty.

## Session lifecycle

1. **start** (`ClientMessage.start`): compute a deterministic session id
   (new → `randomUUID()` + `--session-id`; resume → the given id; continue →
   latest in cwd). If `worktree`, create an isolated checkout and use it as the
   cwd. `makePilot()` → `pilot.start()` (reattach if the tmux/session exists).
2. **startup gate**: wait for the TUI to be up (`❯`, spinner, or trust prompt);
   accept the trust dialog; **auto-answer the resume-from-summary prompt**
   (keep full session). Then send `ready` + `history` (replayed from `.jsonl`)
   + `tokens` + `context`.
3. **turn**: `prompt` → pace gate (unless `force`) → `pilot.submit()` →
   `finishTurn()` waits for idle, then broadcasts either a `dialog` (interactive
   question) or `turn-done`. Content streams independently via the tail.
4. **screen watcher** (300 ms): broadcasts `screen`, `context`, and catches a
   spontaneous resume (a background turn starting with no client prompt).
5. **detach**: a client leaves → if it was the last, arm an idle-reclaim timer
   (`SHADOK_IDLE_MIN`, default 60 min). Reattaching cancels it.
6. **destroy**: process exits, explicit `stop`, or idle timeout → kill the
   pilot (and tmux session). Worktrees are NOT removed.

## Interactive dialogs

`detectDialog(screen)` finds numbered options with a `❯` selector, strips any
right-hand preview column, and returns `{question, options[], multi}`. The UI
renders clickable buttons.

- **single-select** (`choose n`): server moves the `❯` cursor with arrow keys to
  option n, then Enter. Digit keys don't work for preview-style dialogs.
- **multi-select** (`toggle n`, then `confirm`): digit toggles the checkbox;
  confirm is Tab → "Submit" page → Enter.
- **free text** ("Type something", `freetext n text`): digit → paste → Enter.
- A dialog already on screen at attach time is surfaced via `sendPendingDialog`
  (except the auto-answered resume-from-summary one).

## Persistence

- **Transcripts**: Claude Code's own `~/.claude/projects/<encoded-cwd>/<id>.jsonl`.
  History and streaming both read these. Keyed by cwd — see invariant #1.
- **Channel + group lists**: `~/.shadok-ai/channels/<encoded server cwd>.json`
  and `…-groups.json`, via `src/channels.ts`. **Keyed by the server's launch
  directory** — each project/repo the server is started from keeps its own
  cockpit. Server is the source of truth; browser localStorage is an offline
  fallback. See invariant #6 for the erosion trap.
- **Worktrees**: `~/.shadok-ai/worktrees/<repo>-<tag>` on branch
  `shadok-ai/<tag>`. Durable.

## Pace guardrail (`src/pace.ts`)

For each window (5h, 7d): `idealPace = fraction of the window elapsed`;
`ratio = used / (idealPace + PACE_EPSILON)`. **Blocked when `ratio > 100`**,
i.e. `used > idealPace + PACE_EPSILON` (currently 2). It's dynamic: as time
passes the ideal rises, so a block clears on its own once you're back within
budget. `/usage` returns the verdict; a `prompt` bypasses with `force: true`.
The UI shows two-bar gauges (consumed vs elapsed) and a per-message force path.

## Spawning agents (`shadok-ai-agents` skill)

`pilotctl.mjs` is a thin WS/HTTP client so an agent (or a human script) can
`spawn` / `prompt` / `choose` / `diff` other agents through the same server —
each spawned agent is visible in `/live` ("Agents running now" in the UI).
Spawned prompts respect the pace gate; a block is currently silent to the
parent (a known rough edge).

## Known rough edges / debt

- Much was built in low-visibility agent sessions; detection heuristics,
  `pilotctl`, `/live`, auto-retry and pace are the least-reviewed areas — most
  past bugs were found there.
- No orchestration/verification layer yet: agents run in parallel but don't
  coordinate, and nothing gates the quality of their work before it lands.
- Landing/merge is manual and has been the #1 source of breakage (blind merges,
  conflict markers). A safe merge flow is the priority stabilization work.
