import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** A Telegram chat/topic a channel is bound to (folded into the channel). */
export interface TgBinding {
  chatId: number;
  threadId?: number;
}

/** A remembered session — the ONE registry, whatever created it (web or
 *  Telegram). Enough to restore, resume, and route it. */
export interface Channel {
  sessionId: string;
  cwd: string;
  name?: string;
  branch?: string | null;
  /** Repo the worktree belongs to, to recreate a reclaimed checkout. */
  repo?: string;
  /** Tab group id (client-owned metadata). */
  group?: number | null;
  /** Present iff the session is bound to a Telegram chat/topic. */
  telegram?: TgBinding | null;
}

/** Fields the server owns; a browser PUT must never overwrite or drop them. */
const SERVER_OWNED = ["cwd", "branch", "repo", "telegram"] as const;

/**
 * The registry is stored server-side, keyed by the directory the server was
 * launched from — so the set of sessions survives a wiped browser, another
 * device, a restart, or a reboot. One file per launch dir:
 * ~/.shadok-ai/channels/<encoded cwd>.json.
 */
function storeFile(kind: string): string {
  const enc = process.cwd().replace(/[^a-zA-Z0-9]/g, "-");
  const suffix = kind === "channels" ? "" : "-" + kind;
  return path.join(os.homedir(), ".shadok-ai", "channels", enc + suffix + ".json");
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

/**
 * Insert or update a channel by sessionId, shallow-merging the given fields
 * (an `undefined` field never clobbers an existing value). The server calls
 * this whenever a session reaches `ready`, so every session — web or Telegram —
 * lands in the one list.
 */
/** Pure core of upsertChannel — returns a new list; exported for testing. */
export function upsertInto(list: Channel[], patch: Partial<Channel> & { sessionId: string }): Channel[] {
  const out = list.map((c) => ({ ...c }));
  const cur = out.find((c) => c.sessionId === patch.sessionId);
  if (!cur) {
    out.push({ cwd: "", ...patch });
  } else {
    for (const [k, v] of Object.entries(patch)) if (v !== undefined) (cur as any)[k] = v;
  }
  return out;
}

export function upsertChannel(patch: Partial<Channel> & { sessionId: string }): void {
  saveChannels(upsertInto(loadChannels(), patch));
}

export function removeChannel(sessionId: string): void {
  saveChannels(loadChannels().filter((c) => c.sessionId !== sessionId));
}

/** Pure lookup of the channel bound to a Telegram chat/topic. */
export function findTelegramChannel(list: Channel[], chatId: number, threadId?: number): Channel | undefined {
  return list.find(
    (c) => c.telegram && c.telegram.chatId === chatId && (c.telegram.threadId ?? undefined) === threadId,
  );
}

/** The channel bound to a given Telegram chat/topic, or undefined. */
export function channelForTelegram(chatId: number, threadId?: number): Channel | undefined {
  return findTelegramChannel(loadChannels(), chatId, threadId);
}

/**
 * Pure core of the PUT merge (exported for testing). The client drives order
 * and its own metadata (name, group); server-owned fields are preserved per
 * sessionId, and any stored channel the client omitted is kept when its session
 * is live or it has a Telegram binding — so persistence never drops a
 * live/Telegram session (invariant #6).
 */
export function mergeChannels(stored: Channel[], clientList: Channel[], liveIds: Set<string>): Channel[] {
  const byId = new Map(stored.map((c) => [c.sessionId, c]));
  const result: Channel[] = [];
  const seen = new Set<string>();
  for (const c of Array.isArray(clientList) ? clientList : []) {
    if (!c || typeof c.sessionId !== "string") continue;
    seen.add(c.sessionId);
    const prev = byId.get(c.sessionId);
    if (!prev) {
      result.push(c); // a new channel the client just created
      continue;
    }
    const merged: Channel = { ...c };
    for (const k of SERVER_OWNED) if (prev[k] !== undefined) (merged as any)[k] = prev[k];
    result.push(merged);
  }
  for (const c of stored) {
    if (seen.has(c.sessionId)) continue;
    if (liveIds.has(c.sessionId) || c.telegram) result.push(c); // never erase live/Telegram
  }
  return result;
}

export function mergeClientChannels(clientList: Channel[], liveIds: Set<string>): Channel[] {
  const result = mergeChannels(loadChannels(), clientList, liveIds);
  saveChannels(result);
  return result;
}

/** Tab groups (id, name, collapsed, order), persisted the same way as channels. */
export function loadGroups(): any[] {
  return readJson("groups");
}
export function saveGroups(list: any[]): void {
  writeJson("groups", list);
}

/** The single group this instance is bound to (one board per instance), or null.
 *  Instance-level, not a session — kept separate from the channel registry. */
export function loadTgGroup(): number | null {
  const v = readJson("telegram-group")[0];
  return typeof v === "number" ? v : null;
}
export function saveTgGroup(groupId: number | null): void {
  writeJson("telegram-group", groupId == null ? [] : [groupId]);
}

/**
 * One-time migration of the old separate `…-telegram.json` bindings into the
 * channel registry. Idempotent: renames the file once folded so it's never
 * re-applied. cwd/name are filled in later when the session next reaches ready.
 */
export function migrateTgBindings(): void {
  const f = storeFile("telegram");
  let raw: string;
  try {
    raw = fs.readFileSync(f, "utf8");
  } catch {
    return; // already migrated or never existed
  }
  let bindings: any[];
  try {
    bindings = JSON.parse(raw);
  } catch {
    return;
  }
  if (Array.isArray(bindings)) {
    for (const b of bindings) {
      if (b && typeof b.sessionId === "string" && typeof b.chatId === "number") {
        upsertChannel({
          sessionId: b.sessionId,
          telegram: { chatId: b.chatId, ...(typeof b.threadId === "number" ? { threadId: b.threadId } : {}) },
        });
      }
    }
  }
  try {
    fs.renameSync(f, f + ".migrated");
  } catch {
    /* best effort */
  }
}
