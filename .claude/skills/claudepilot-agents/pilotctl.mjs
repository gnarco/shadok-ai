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

const HELP =
  "usage: pilotctl <spawn|prompt|dialog|choose|toggle|confirm|freetext|list|diff|stop|screen> …";

export async function run(argv) {
  const { cmd, pos, flags } = parseArgs(argv);
  switch (cmd) {
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
