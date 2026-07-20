import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { WebSocketServer, type WebSocket } from "ws";
import {
  detectDialog,
  findSessionId,
  listSessions,
  loadHistory,
} from "./extract.js";
import { findTransientErrors, newTransientErrors, RETRY_DELAYS_MS } from "./retry.js";
import { screenShowsWork } from "./detect.js";
import { ClaudePilot } from "./session.js";
import { TmuxPilot, tmuxAvailable } from "./tmux.js";
import { scanUsage, sessionFilePath, tailSession, type TokenUsage } from "./tail.js";
import { getUsage } from "./usage.js";
import {
  createWorktree,
  ensureWorktreeCheckout,
  gitDiff,
  isGitRepo,
  listPastSessions,
  type Worktree,
} from "./worktree.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3789);

const app = express();
app.use(express.static(path.join(__dirname, "..", "public")));
// Markdown parser served locally (history rendering on the client).
app.get("/vendor/marked.js", (_req, res) =>
  res.sendFile(path.join(__dirname, "..", "node_modules", "marked", "lib", "marked.umd.js")),
);
// Resumable sessions of a directory (for the "resume by id" picker).
app.get("/sessions", (req, res) => {
  const cwd = String(req.query.cwd ?? "").trim() || process.cwd();
  res.json(listSessions(cwd));
});
// Sessions alive in THIS server (agents spawned by any client, including the
// pilotctl thin client). They own no transcript until their first turn, so
// /sessions cannot see them — this is the only way the UI can list them.
app.get("/live", (_req, res) => {
  res.json(
    [...sessions.values()]
      .filter((s) => !s.pilot.hasExited)
      .map((s) => ({
        id: s.id,
        cwd: s.cwd,
        branch: s.worktree?.branch ?? null,
        busy: s.busy,
        clients: s.clients.size,
        lastPrompt: s.lastPrompt,
      })),
  );
});
// Current 5-hour and 7-day subscription usage (for the quota gauges).
app.get("/usage", async (_req, res) => {
  res.json((await getUsage()) ?? { fiveHour: null, sevenDay: null, fetchedAt: Date.now() });
});
// Changes made by a session (git status + diff), for the review panel.
app.get("/diff", (req, res) => {
  const s = sessions.get(String(req.query.session ?? ""));
  if (!s) return res.json({ status: "", diff: "", branch: null, error: "no such session" });
  res.json(gitDiff(s.cwd, s.worktree?.baseSha ?? null));
});
// Past worktree sessions of a repo (for reopening unfinished work).
app.get("/recover", (req, res) => {
  const repo = String(req.query.repo ?? "").trim() || process.cwd();
  res.json(isGitRepo(repo) ? listPastSessions(repo) : []);
});
// Server-side defaults (the launch directory pre-fills the working dir field).
app.get("/defaults", (_req, res) => {
  res.json({ cwd: process.cwd() });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

type ClientMessage =
  | {
      type: "start";
      cwd?: string;
      resume?: string;
      continue?: boolean;
      worktree?: boolean;
      /** Reopen: recreate this worktree branch's checkout if it was reclaimed. */
      branch?: string;
      /** Reopen: the repo the worktree belongs to (to recreate the checkout). */
      repo?: string;
    }
  | { type: "prompt"; text: string }
  | { type: "choose"; n: number }
  | { type: "toggle"; n: number }
  | { type: "confirm" }
  | { type: "freetext"; n: number; text: string }
  | { type: "key"; key: string }
  | { type: "settle" }
  | { type: "stop" };

/**
 * A piloted session = ONE claude process, shared by N WebSocket clients.
 * Every event (prompts, answers, dialogs, screen) is broadcast to all
 * attached clients — several tabs or interfaces can follow the same
 * session live.
 */
/** Either transport — same surface; TmuxPilot additionally survives restarts. */
type Pilot = ClaudePilot | TmuxPilot;

/**
 * Selects the transport. tmux is the DEFAULT whenever it is installed: the
 * agent runs in a detached tmux session named after the Claude session id, so
 * it survives the server restarting/crashing and is reattached on the next
 * start of the same id. Set CLAUDEPILOT_TMUX=0 to force the node-pty transport
 * (which dies with the server). Falls back to node-pty if tmux is absent.
 */
const USE_TMUX = process.env.CLAUDEPILOT_TMUX !== "0" && tmuxAvailable();
function makePilot(id: string, cwd: string, args: string[]): Pilot {
  return USE_TMUX
    ? new TmuxPilot({ cwd, args, tmuxName: "cp-" + id })
    : new ClaudePilot({ cwd, args });
}

interface Live {
  id: string;
  cwd: string;
  pilot: Pilot;
  clients: Set<WebSocket>;
  busy: boolean;
  lastPrompt: string;
  screenTimer: ReturnType<typeof setInterval> | null;
  lastScreen: string;
  /** Stops the .jsonl tail loop (content streaming). */
  stopTail: (() => void) | null;
  /** Isolated git worktree, when the session runs in one. */
  worktree: Worktree | null;
  /** Reclaim timer armed when no client is attached. */
  idleTimer: ReturnType<typeof setTimeout> | null;
  /** Token usage per assistant message id (final counts win), from the .jsonl. */
  usage: Map<string, TokenUsage>;
  /** Pending auto-retry of a turn that died on a transient API error. */
  retryTimer: ReturnType<typeof setTimeout> | null;
  /** Auto-retry attempts consumed for the current error streak (0–3). */
  retryCount: number;
  /** Transient error lines already on screen when the turn started. */
  errorsAtTurnStart: string[];
  /** Epoch ms when the in-flight turn started — lets clients (re)joining
   *  mid-turn show the real thinking time instead of restarting at zero. */
  turnStartedAt: number | null;
  /** How long the last finished turn took, so a client attaching between
   *  turns can restore the frozen time instead of showing a blank timer. */
  lastTurnMs: number | null;
}

/** Session-wide token totals, for the window-title counter. */
function tokenTotals(s: Live) {
  const t = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
  for (const u of s.usage.values()) {
    t.input += u.input;
    t.output += u.output;
    t.cacheCreation += u.cacheCreation;
    t.cacheRead += u.cacheRead;
  }
  return t;
}

/**
 * How long a session with no attached client is kept alive before being
 * reclaimed. Closing a tab or reloading detaches but does NOT kill the agent;
 * you reattach on return and the running turn continues. Set 0 to keep
 * sessions until the process exits or an explicit End.
 */
const IDLE_RECLAIM_MS = Number(process.env.CLAUDEPILOT_IDLE_MIN ?? 60) * 60_000;

const sessions = new Map<string, Live>();

function broadcast(s: Live, msg: object, except?: WebSocket) {
  const data = JSON.stringify(msg);
  for (const c of s.clients) {
    if (c !== except && c.readyState === c.OPEN) c.send(data);
  }
}

function destroySession(s: Live) {
  if (s.screenTimer) clearInterval(s.screenTimer);
  s.screenTimer = null;
  if (s.idleTimer) clearTimeout(s.idleTimer);
  s.idleTimer = null;
  if (s.retryTimer) clearTimeout(s.retryTimer);
  s.retryTimer = null;
  s.stopTail?.();
  s.stopTail = null;
  s.pilot.kill();
  // Worktrees are durable: never auto-removed. They persist (with their
  // branch and any uncommitted changes) until an explicit merge/discard,
  // so no work is ever silently lost.
  sessions.delete(s.id);
}

function detach(ws: WebSocket, s: Live) {
  s.clients.delete(ws);
  if (s.clients.size !== 0) return;
  // No viewer attached: keep the agent running and reclaim only after a long
  // idle, so reloading or closing a tab never aborts work.
  if (IDLE_RECLAIM_MS <= 0) return;
  if (s.idleTimer) clearTimeout(s.idleTimer);
  s.idleTimer = setTimeout(() => {
    if (s.clients.size === 0) destroySession(s);
  }, IDLE_RECLAIM_MS);
}

async function createSession(
  id: string,
  cwd: string,
  args: string[],
  worktree: Worktree | null = null,
): Promise<Live> {
  const pilot = makePilot(id, cwd, args);
  const s: Live = {
    id,
    cwd,
    pilot,
    clients: new Set(),
    busy: false,
    lastPrompt: "",
    screenTimer: null,
    lastScreen: "",
    stopTail: null,
    worktree,
    idleTimer: null,
    // Resumed sessions start with what the transcript already consumed.
    usage: scanUsage(sessionFilePath(cwd, id)),
    retryTimer: null,
    retryCount: 0,
    errorsAtTurnStart: [],
    turnStartedAt: null,
    lastTurnMs: null,
  };
  pilot.onExit((code) => {
    broadcast(s, { type: "exited", code });
    destroySession(s);
  });
  pilot.start();
  // Stream authoritative content from the session transcript: each assistant
  // text/tool block is broadcast as soon as Claude Code writes it — complete,
  // never truncated, at message granularity.
  s.stopTail = tailSession(sessionFilePath(cwd, id), (e) => {
    if (e.kind === "text") broadcast(s, { type: "stream-text", text: e.text });
    else if (e.kind === "tool")
      broadcast(s, { type: "stream-tool", id: e.id, name: e.name, summary: e.summary });
    else if (e.kind === "usage") {
      s.usage.set(e.messageId, e.usage);
      broadcast(s, { type: "tokens", tokens: tokenTotals(s) });
    } else
      broadcast(s, {
        type: "stream-result",
        toolUseId: e.toolUseId,
        text: e.text,
        isError: e.isError,
      });
  });
  let settled = false;
  s.screenTimer = setInterval(() => {
    if (pilot.hasExited) return;
    const scr = pilot.screen();
    if (scr !== s.lastScreen) {
      s.lastScreen = scr;
      broadcast(s, { type: "screen", text: scr, working: pilot.isWorking() });
    }
    // Spontaneous resume: work restarting without a client prompt (e.g. a
    // background agent completing and waking the model). No handler called
    // finishTurn, so watch for it here and signal the turn like any other.
    if (settled && !s.busy && pilot.isWorking()) finishTurn(s).catch(() => {});
  }, 300);

  // Ready as soon as the TUI is up: trust prompt, input line, or an
  // in-flight turn. A session reattached MID-WORK (tmux survives server
  // restarts, and turns can run for many minutes) must not block on idle —
  // the screen watcher above signals the running turn right after `settled`.
  const isUp = (scr: string) =>
    /do you trust the files/i.test(scr) || screenShowsWork(scr) || scr.includes("❯");
  let screen = await pilot.waitFor(isUp, { timeoutMs: 60_000 });
  if (/do you trust the files/i.test(screen)) {
    pilot.press("enter");
    await pilot.waitFor(
      (scr) => screenShowsWork(scr) || scr.includes("❯"),
      { timeoutMs: 30_000 },
    );
  }
  settled = true;
  sessions.set(id, s);
  return s;
}

/**
 * Waits for the current turn to finish and broadcasts the outcome. Content is
 * streamed separately by the transcript tail; here we only signal an
 * interactive dialog (turn stays suspended) or turn completion.
 */
async function finishTurn(s: Live) {
  s.busy = true;
  if (!s.turnStartedAt) s.turnStartedAt = Date.now();
  s.errorsAtTurnStart = findTransientErrors(s.pilot.screen());
  broadcast(s, { type: "working", startedAt: s.turnStartedAt });
  try {
    await s.pilot.waitForIdle({ stableMs: 2000, timeoutMs: 900_000 });
    const dialog = detectDialog(s.pilot.screen());
    if (dialog) broadcast(s, { type: "dialog", ...dialog });
    else {
      broadcast(s, { type: "turn-done", sessionId: s.id });
      maybeScheduleRetry(s);
    }
  } finally {
    s.busy = false;
    // Remember how long it took: a dialog suspends the turn and a completion
    // ends it, but both freeze the client's timer, so both are worth keeping.
    if (s.turnStartedAt) s.lastTurnMs = Date.now() - s.turnStartedAt;
    s.turnStartedAt = null;
  }
}

/**
 * Surfaces a dialog already on screen when a client connects — e.g. the
 * "resume from summary" or permission prompt that appears at startup/resume.
 * Without this, a resumed session waiting on such a dialog looks frozen.
 */
function sendPendingDialog(s: Live, send: (msg: object) => void) {
  const d = detectDialog(s.pilot.screen());
  if (d) send({ type: "dialog", ...d });
}

/** Cancels a pending auto-retry (user took over, or session ends). */
function clearRetry(s: Live, notify = false) {
  if (!s.retryTimer) return;
  clearTimeout(s.retryTimer);
  s.retryTimer = null;
  if (notify) broadcast(s, { type: "auto-retry-cancelled" });
}

/**
 * If the turn died on a NEW transient API error (529 Overloaded, 5xx,
 * timeout…), schedules an automatic `continue` — 15 s, then 30 s, then
 * 60 s. Cancelled if the user takes over; gives up after 3 attempts.
 */
function maybeScheduleRetry(s: Live) {
  if (s.retryTimer) return; // one pending retry at a time
  const fresh = newTransientErrors(
    s.errorsAtTurnStart,
    findTransientErrors(s.pilot.screen()),
  );
  if (fresh.length === 0) {
    s.retryCount = 0; // clean turn: the error streak is over
    return;
  }
  if (s.retryCount >= RETRY_DELAYS_MS.length) {
    broadcast(s, { type: "auto-retry-gave-up", attempts: s.retryCount });
    s.retryCount = 0;
    return;
  }
  const delayMs = RETRY_DELAYS_MS[s.retryCount];
  s.retryCount++;
  broadcast(s, {
    type: "auto-retry",
    delayMs,
    attempt: s.retryCount,
    max: RETRY_DELAYS_MS.length,
  });
  s.retryTimer = setTimeout(async () => {
    s.retryTimer = null;
    if (s.pilot.hasExited || s.busy) return;
    broadcast(s, { type: "prompt-echo", text: "continue", auto: true });
    s.busy = true;
    s.turnStartedAt = Date.now();
    broadcast(s, { type: "working", startedAt: s.turnStartedAt });
    try {
      await s.pilot.submit("continue");
    } catch {
      return; // TUI unreachable: give the user back the controls
    } finally {
      s.busy = false;
    }
    await finishTurn(s).catch(() => {});
  }, delayMs);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

wss.on("connection", (ws: WebSocket) => {
  let session: Live | null = null;

  const send = (msg: object) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };
  const fail = (message: string) => send({ type: "error", message });

  ws.on("close", () => {
    if (session) detach(ws, session);
    session = null;
  });

  ws.on("message", async (raw) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return fail("unreadable message");
    }

    try {
      // Any user takeover cancels a pending auto-retry and ends the streak.
      if (
        session &&
        ["prompt", "choose", "toggle", "freetext", "confirm", "key"].includes(msg.type)
      ) {
        clearRetry(session, true);
        session.retryCount = 0;
      }
      switch (msg.type) {
        case "start": {
          if (session) return fail("session already started");
          const cwd = msg.cwd?.trim() || process.cwd();
          // Deterministic id: enforced with --session-id for a new session,
          // known for a resume. NEVER derive it from the most recent file
          // in the directory — with several channels in the same directory
          // they would all converge to the same session.
          let id: string;
          const args: string[] = [];
          let resumed = false;
          if (msg.resume) {
            id = msg.resume;
            args.push("--resume", id);
            resumed = true;
          } else if (msg.continue) {
            const found = findSessionId(cwd);
            if (found) {
              id = found;
              args.push("--resume", id);
              resumed = true;
            } else {
              // Nothing to resume in this directory: new session.
              id = randomUUID();
              args.push("--session-id", id);
            }
          } else {
            id = randomUUID();
            args.push("--session-id", id);
          }

          // Isolation: run a NEW session inside a fresh git worktree so the
          // agent's edits stay contained until the user merges them.
          let worktree: Worktree | null = null;
          let effectiveCwd = cwd;
          if (msg.worktree && !resumed && isGitRepo(cwd)) {
            try {
              worktree = createWorktree(cwd, id.slice(0, 8));
              effectiveCwd = worktree.path;
            } catch (e) {
              return fail(
                "worktree creation failed: " + (e instanceof Error ? e.message : String(e)),
              );
            }
          }

          // Reopen: if resuming into a worktree whose checkout was reclaimed,
          // recreate it from its branch so the past session can continue.
          if (resumed && msg.branch && msg.repo && !fs.existsSync(effectiveCwd)) {
            ensureWorktreeCheckout(msg.repo, msg.branch, effectiveCwd);
          }

          // Guard against a vanished directory (e.g. a restored channel whose
          // worktree was removed): spawning claude there would exit instantly
          // with a cryptic error. Signal it clearly so the client can drop it.
          if (!fs.existsSync(effectiveCwd)) {
            return send({
              type: "gone",
              sessionId: id,
              message: "working directory no longer exists: " + effectiveCwd,
            });
          }

          const existing = sessions.get(id);
          if (existing && !existing.pilot.hasExited) {
            // Session already piloted: attach to it (shared process). Cancel
            // any pending reclaim — a viewer is back.
            session = existing;
            if (session.idleTimer) {
              clearTimeout(session.idleTimer);
              session.idleTimer = null;
            }
            session.clients.add(ws);
            const turns = loadHistory(session.cwd, id);
            if (turns.length) send({ type: "history", turns });
            send({
              type: "ready",
              sessionId: id,
              cwd: session.cwd,
              lastTurnMs: session.lastTurnMs,
            });
            send({ type: "tokens", tokens: tokenTotals(session) });
            send({
              type: "screen",
              text: session.pilot.screen(),
              working: session.pilot.isWorking(),
            });
            if (session.busy)
              send({ type: "working", startedAt: session.turnStartedAt });
            sendPendingDialog(session, send);
            break;
          }

          session = await createSession(id, effectiveCwd, args, worktree);
          session.clients.add(ws);
          if (resumed) {
            const turns = loadHistory(effectiveCwd, id);
            if (turns.length) send({ type: "history", turns });
          }
          send({
            type: "ready",
            sessionId: id,
            cwd: effectiveCwd,
            branch: worktree?.branch ?? null,
          });
          send({ type: "tokens", tokens: tokenTotals(session) });
          sendPendingDialog(session, send);
          break;
        }

        case "prompt": {
          if (!session) return fail("no session started");
          if (session.busy) return fail("a response is already in progress");
          const text = msg.text.trim();
          if (!text) return;
          session.lastPrompt = text;
          // The session's other clients see the prompt arrive.
          broadcast(session, { type: "prompt-echo", text }, ws);
          session.busy = true;
          session.turnStartedAt = Date.now();
          broadcast(session, { type: "working", startedAt: session.turnStartedAt });
          try {
            await session.pilot.submit(text);
          } finally {
            session.busy = false;
          }
          await finishTurn(session);
          break;
        }

        case "choose": {
          // Single select: the digit selects and validates.
          if (!session) return fail("no session started");
          if (session.busy) return fail("a response is already in progress");
          session.pilot.write(String(msg.n));
          await sleep(800);
          await finishTurn(session);
          break;
        }

        case "toggle": {
          // Multi-select: toggle the checkbox then rebroadcast the state.
          if (!session) return fail("no session started");
          if (session.busy) return fail("a response is already in progress");
          session.pilot.write(String(msg.n));
          await sleep(500);
          const d = detectDialog(session.pilot.screen());
          if (d) broadcast(session, { type: "dialog", ...d });
          else await finishTurn(session);
          break;
        }

        case "freetext": {
          // "Type something" option: digit → paste the text → Enter.
          if (!session) return fail("no session started");
          if (session.busy) return fail("a response is already in progress");
          const t = msg.text.trim();
          if (!t) return;
          session.pilot.write(String(msg.n));
          await sleep(700);
          session.pilot.write(`\x1b[200~${t}\x1b[201~`);
          await sleep(400);
          session.pilot.press("enter");
          await sleep(600);
          const d = detectDialog(session.pilot.screen());
          if (d) broadcast(session, { type: "dialog", ...d });
          else await finishTurn(session);
          break;
        }

        case "confirm": {
          // Multi-select: Tab → "Submit answers" page → Enter.
          if (!session) return fail("no session started");
          if (session.busy) return fail("a response is already in progress");
          session.pilot.press("tab");
          await sleep(600);
          session.pilot.press("enter");
          await sleep(400);
          await finishTurn(session);
          break;
        }

        case "key": {
          // Manual keystroke from the terminal view (dialogs, menus…).
          if (!session) return fail("no session started");
          const named = [
            "enter",
            "escape",
            "up",
            "down",
            "left",
            "right",
            "tab",
            "ctrl-c",
          ] as const;
          if ((named as readonly string[]).includes(msg.key)) {
            session.pilot.press(msg.key as (typeof named)[number]);
          } else if (msg.key.length === 1) {
            session.pilot.write(msg.key);
          }
          break;
        }

        case "settle": {
          // After a manual intervention: wait for the turn to finish.
          if (!session || session.busy) return;
          await finishTurn(session);
          break;
        }

        case "stop": {
          // Explicit stop: ends the session for ALL clients.
          if (!session) return;
          const s = session;
          broadcast(s, { type: "stopped" });
          await s.pilot.stop();
          destroySession(s);
          session = null;
          break;
        }
      }
    } catch (err) {
      if (session) session.busy = false;
      fail(err instanceof Error ? err.message : String(err));
    }
  });
});

server.listen(PORT, () => {
  console.log(`claudepilot web: http://localhost:${PORT}`);
  console.log(
    USE_TMUX
      ? "transport: tmux (agents survive server restarts)"
      : "transport: node-pty (agents die with the server; install tmux or unset CLAUDEPILOT_TMUX=0 for durability)",
  );
});
