#!/usr/bin/env node
// pilotctl — thin client for the claudepilot web server. One-shot commands,
// JSON on stdout. See .claude/skills/claudepilot-agents/SKILL.md.
import { execFileSync, spawn as spawnChild } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

export const port = () => Number(process.env.CLAUDEPILOT_PORT ?? 3789);
export const httpBase = () => `http://localhost:${port()}`;
export const wsUrl = () => `ws://localhost:${port()}/ws`;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function stateDir() {
  return process.env.CLAUDEPILOT_STATE_DIR ?? path.join(os.homedir(), ".claudepilot", "pilotctl");
}

export function readState(id) {
  try {
    return JSON.parse(fs.readFileSync(path.join(stateDir(), id + ".json"), "utf8"));
  } catch {
    return null;
  }
}

export function writeState(id, obj) {
  fs.mkdirSync(stateDir(), { recursive: true });
  fs.writeFileSync(path.join(stateDir(), id + ".json"), JSON.stringify(obj, null, 2));
}

export function deleteState(id) {
  fs.rmSync(path.join(stateDir(), id + ".json"), { force: true });
}

export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const flags = {};
  const pos = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--worktree" || a === "--continue") flags[a.slice(2)] = true;
    else if (a === "--cwd" || a === "--resume" || a === "--timeout") flags[a.slice(2)] = rest[++i];
    else pos.push(a);
  }
  return { cmd, pos, flags };
}

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl());
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

// Attaches to (or starts) a session; resolves once the server says `ready`.
export async function openSession(startMsg) {
  const ws = await connect();
  const listeners = new Set();
  const state = { lastScreen: "", busy: false, ready: null };
  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (msg.type === "screen") state.lastScreen = msg.text;
    if (msg.type === "working") state.busy = true;
    if (msg.type === "turn-done" || msg.type === "dialog") state.busy = false;
    for (const l of [...listeners]) l(msg);
  });
  ws.on("close", () => {
    for (const l of [...listeners]) l({ type: "socket-closed" });
  });
  const client = {
    ws,
    state,
    send: (m) => ws.send(JSON.stringify(m)),
    on: (l) => listeners.add(l),
    off: (l) => listeners.delete(l),
    waitFor: (types, timeoutMs) =>
      new Promise((resolve) => {
        const timer = timeoutMs
          ? setTimeout(() => {
              listeners.delete(l);
              resolve({ type: "timeout" });
            }, timeoutMs)
          : null;
        const l = (msg) => {
          if (!types.includes(msg.type)) return;
          if (timer) clearTimeout(timer);
          listeners.delete(l);
          resolve(msg);
        };
        listeners.add(l);
      }),
  };
  client.send({ type: "start", ...startMsg });
  const ready = await client.waitFor(["ready", "error"], 90_000);
  if (ready.type !== "ready") {
    ws.close();
    throw new Error(ready.message ?? "timeout waiting for ready");
  }
  state.ready = ready;
  return client;
}

// Accumulates streamed content until the turn ends (or a dialog suspends it).
export async function collectTurn(client, timeoutMs) {
  const texts = [];
  const tools = [];
  const collector = (msg) => {
    if (msg.type === "stream-text") texts.push(msg.text);
    else if (msg.type === "stream-tool") tools.push({ name: msg.name, summary: msg.summary });
  };
  client.on(collector);
  const end = await client.waitFor(
    ["dialog", "turn-done", "exited", "stopped", "error", "socket-closed"],
    timeoutMs,
  );
  client.off(collector);
  const text = texts.join("\n\n");
  if (end.type === "turn-done") return { status: "answer", text, tools };
  if (end.type === "dialog")
    return { status: "dialog", question: end.question, options: end.options, multi: end.multi, text };
  if (end.type === "timeout") return { status: "timeout", screen: client.state.lastScreen, text };
  if (end.type === "error") return { status: "error", error: end.message };
  return { status: "exited", code: end.code ?? null, text };
}

async function serverUp() {
  try {
    const r = await fetch(`${httpBase()}/sessions?cwd=${encodeURIComponent(os.homedir())}`, {
      signal: AbortSignal.timeout(1500),
    });
    return r.ok;
  } catch {
    return false;
  }
}

export async function ensureServer() {
  if (await serverUp()) return;
  throw new Error(`claudepilot server unreachable on :${port()}`);
}

// The server kills the claude process when its last WS client detaches, so a
// detached "hold" process keeps one attachment open per piloted agent.
export async function ensureHolder(id, cwd) {
  if (process.env.CLAUDEPILOT_NO_HOLDER) return;
  const st = readState(id);
  if (st?.holderPid && pidAlive(st.holderPid)) return;
  const self = fileURLToPath(import.meta.url);
  const args = [self, "hold", id];
  if (cwd) args.push(cwd);
  const child = spawnChild(process.execPath, args, {
    detached: true,
    stdio: ["ignore", "pipe", "ignore"],
    env: process.env,
  });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("holder failed to attach within 90s")), 90_000);
    child.stdout.on("data", (d) => {
      if (String(d).includes("attached")) {
        clearTimeout(t);
        resolve();
      }
    });
    child.once("exit", () => {
      clearTimeout(t);
      reject(new Error("holder exited before attaching"));
    });
  });
  child.unref();
  writeState(id, { ...(readState(id) ?? { sessionId: id }), cwd: cwd ?? null, holderPid: child.pid });
}

async function cmdSpawn(flags) {
  await ensureServer();
  const startMsg = {};
  if (flags.cwd) startMsg.cwd = flags.cwd;
  if (flags.worktree) startMsg.worktree = true;
  if (flags.resume) startMsg.resume = flags.resume;
  if (flags.continue) startMsg.continue = true;
  const client = await openSession(startMsg);
  const { sessionId, cwd, branch } = client.state.ready;
  let baseSha = null;
  if (branch) {
    try {
      baseSha = execFileSync("git", ["-C", cwd, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    } catch {}
  }
  writeState(sessionId, { sessionId, cwd, branch: branch ?? null, baseSha, holderPid: null });
  await ensureHolder(sessionId, cwd);
  client.ws.close();
  return { sessionId, cwd, branch: branch ?? null };
}

// Internal command: stays attached until the session ends.
async function cmdHold(id, cwd) {
  await openSession({ resume: id, cwd }).then((client) => {
    process.stdout.write("attached\n");
    client.on((msg) => {
      if (msg.type === "stopped") deleteState(id);
      if (["stopped", "exited", "socket-closed"].includes(msg.type)) process.exit(0);
    });
  });
  return new Promise(() => {}); // never resolves; the WS keeps the loop alive
}

const HELP =
  "usage: pilotctl <spawn|prompt|dialog|choose|toggle|confirm|freetext|list|diff|stop|screen> …";

export async function run(argv) {
  const { cmd, pos, flags } = parseArgs(argv);
  switch (cmd) {
    case "spawn":
      return cmdSpawn(flags);
    case "hold":
      return cmdHold(pos[0], pos[1]);
    default:
      throw new Error(HELP);
  }
}

// CLI entry point — not triggered when imported by tests.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run(process.argv.slice(2))
    .then((r) => {
      console.log(JSON.stringify(r));
      process.exit(r?.error || r?.status === "error" ? 1 : 0);
    })
    .catch((e) => {
      console.log(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
      process.exit(1);
    });
}
