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
function storeFile(): string {
  const enc = process.cwd().replace(/[^a-zA-Z0-9]/g, "-");
  return path.join(os.homedir(), ".claudepilot", "channels", enc + ".json");
}

export function loadChannels(): Channel[] {
  try {
    const list = JSON.parse(fs.readFileSync(storeFile(), "utf8"));
    return Array.isArray(list) ? list.filter((c) => c && typeof c.sessionId === "string") : [];
  } catch {
    return [];
  }
}

export function saveChannels(list: Channel[]): void {
  const f = storeFile();
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(list, null, 2));
  } catch {
    // best effort: losing the persisted list is non-fatal
  }
}
