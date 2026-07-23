import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** A remembered channel: enough to restore and (re)open its session. */
export interface Channel {
  sessionId: string;
  cwd: string;
  name?: string;
  branch?: string | null;
  /** Repo the worktree belongs to, to recreate a reclaimed checkout. */
  repo?: string;
}

/**
 * The channel list is stored server-side, keyed by the directory the server
 * was launched from — so the set of open channels survives a wiped browser,
 * another device, a server restart, or a reboot. Each launch directory keeps
 * its own list under ~/.claudepilot/channels/<encoded cwd>.json.
 */
function storeFile(kind: string): string {
  const enc = process.cwd().replace(/[^a-zA-Z0-9]/g, "-");
  const suffix = kind === "channels" ? "" : "-" + kind;
  return path.join(os.homedir(), ".claudepilot", "channels", enc + suffix + ".json");
}

function readJson(kind: string): any[] {
  try {
    const v = JSON.parse(fs.readFileSync(storeFile(kind), "utf8"));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function writeJson(kind: string, value: any[]): void {
  const f = storeFile(kind);
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(value, null, 2));
  } catch {
    // best effort: losing the persisted list is non-fatal
  }
}

export function loadChannels(): Channel[] {
  return readJson("channels").filter((c) => c && typeof c.sessionId === "string");
}
export function saveChannels(list: Channel[]): void {
  writeJson("channels", list);
}

/** Tab groups (id, name, collapsed, order), persisted the same way as channels. */
export function loadGroups(): any[] {
  return readJson("groups");
}
export function saveGroups(list: any[]): void {
  writeJson("groups", list);
}

/** Telegram chat/topic → session bindings, persisted per launch directory. */
export function loadTgBindings(): any[] {
  return readJson("telegram");
}
export function saveTgBindings(list: any[]): void {
  writeJson("telegram", list);
}
