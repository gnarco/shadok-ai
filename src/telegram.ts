import WebSocket from "ws";
import { loadTgBindings, saveTgBindings } from "./channels.js";

/**
 * Telegram control bridge. Runs inside the server process (only when
 * TELEGRAM_BOT_TOKEN is set) and connects to the server's own /ws as a plain
 * client — so a Telegram-driven session is the same Live session the web UI
 * sees. See docs/superpowers/specs/2026-07-23-telegram-design.md.
 *
 * Increment 1: DMs (1 chat = 1 session), text prompt → streamed reply,
 * /new /end /list, binding persistence. Topics + dialogs come next.
 */

const MSG_LIMIT = 4000; // Telegram hard limit is 4096; leave headroom.

// ── Pure helpers (unit-tested) ───────────────────────────────────────────

/** The binding key for a chat + optional forum topic thread. */
export function bindKey(chat: { id: number; type: string }, threadId?: number): string {
  if (chat.type === "private") return `private:${chat.id}`;
  return threadId ? `topic:${chat.id}:${threadId}` : `group:${chat.id}`;
}

/** Split text into Telegram-sized chunks, preferring line boundaries. */
export function chunk(text: string, max = MSG_LIMIT): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max * 0.5) cut = max; // no nearby newline: hard cut
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest) out.push(rest);
  return out;
}

/** Parse a leading bot command: "/spawn foo" → {cmd:"spawn", arg:"foo"}. */
export function parseCommand(text: string): { cmd: string; arg: string } | null {
  const m = text.match(/^\/([a-z]+)(?:@\w+)?\s*(.*)$/is);
  return m ? { cmd: m[1].toLowerCase(), arg: m[2].trim() } : null;
}

// ── Runtime ──────────────────────────────────────────────────────────────

interface Bridge {
  key: string;
  chatId: number;
  threadId?: number;
  ws: WebSocket;
  sessionId: string | null;
  ready: boolean;
  pending: string[]; // prompts queued until the WS is ready
}

export function startTelegram(port: number): void {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  const api = `https://api.telegram.org/bot${token}`;
  const allowed = (process.env.TELEGRAM_ALLOWED_CHATS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const bridges = new Map<string, Bridge>();

  const tg = async (method: string, params: object): Promise<any> => {
    try {
      const r = await fetch(`${api}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(params),
      });
      return await r.json();
    } catch {
      return null;
    }
  };

  const send = async (b: Bridge, text: string) => {
    for (const part of chunk(text)) {
      await tg("sendMessage", {
        chat_id: b.chatId,
        ...(b.threadId ? { message_thread_id: b.threadId } : {}),
        text: part,
        disable_web_page_preview: true,
      });
    }
  };

  const persist = () => {
    saveTgBindings(
      [...bridges.values()]
        .filter((b) => b.sessionId)
        .map((b) => ({ key: b.key, sessionId: b.sessionId, chatId: b.chatId, threadId: b.threadId })),
    );
  };

  /** Open (or resume) a session for a chat/topic and wire its events to Telegram. */
  const openBridge = (key: string, chatId: number, threadId: number | undefined, resumeId?: string): Bridge => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const b: Bridge = { key, chatId, threadId, ws, sessionId: resumeId ?? null, ready: false, pending: [] };
    bridges.set(key, b);

    ws.on("open", () => {
      ws.send(
        JSON.stringify(
          resumeId ? { type: "start", resume: resumeId, cwd: process.cwd() } : { type: "start", cwd: process.cwd() },
        ),
      );
    });
    ws.on("message", (raw) => {
      let m: any;
      try {
        m = JSON.parse(String(raw));
      } catch {
        return;
      }
      switch (m.type) {
        case "ready":
          b.sessionId = m.sessionId;
          b.ready = true;
          persist();
          for (const p of b.pending.splice(0)) ws.send(JSON.stringify({ type: "prompt", text: p }));
          break;
        case "working":
          tg("sendChatAction", {
            chat_id: b.chatId,
            ...(b.threadId ? { message_thread_id: b.threadId } : {}),
            action: "typing",
          });
          break;
        case "stream-text":
          if (m.text?.trim()) send(b, m.text);
          break;
        case "error":
          send(b, "⚠️ " + m.message);
          break;
        case "exited":
          send(b, "— session ended —");
          break;
        // stream-tool / stream-result / dialog / turn-done handled in increment 2/3
      }
    });
    ws.on("close", () => {
      if (bridges.get(key) === b) bridges.delete(key);
    });
    ws.on("error", () => {});
    return b;
  };

  const bridgeFor = (key: string, chatId: number, threadId?: number): Bridge => {
    const existing = bridges.get(key);
    if (existing && existing.ws.readyState <= WebSocket.OPEN) return existing;
    const saved = loadTgBindings().find((x: any) => x.key === key);
    return openBridge(key, chatId, threadId, saved?.sessionId);
  };

  const promptTo = (b: Bridge, text: string) => {
    if (b.ready && b.ws.readyState === WebSocket.OPEN) b.ws.send(JSON.stringify({ type: "prompt", text }));
    else b.pending.push(text);
  };

  const handleUpdate = async (u: any) => {
    const msg = u.message;
    if (!msg || typeof msg.text !== "string") return;
    const chat = msg.chat;
    if (allowed.length && !allowed.includes(String(chat.id))) {
      await tg("sendMessage", { chat_id: chat.id, text: "⛔ this bot is restricted." });
      return;
    }
    const threadId = msg.message_thread_id as number | undefined;
    const key = bindKey(chat, threadId);
    const cmd = parseCommand(msg.text);

    if (cmd) {
      switch (cmd.cmd) {
        case "start":
          await tg("sendMessage", {
            chat_id: chat.id,
            ...(threadId ? { message_thread_id: threadId } : {}),
            text: "claudepilot — send a message to talk to your agent. /new to reset, /end to stop, /list to see bindings.",
          });
          return;
        case "new":
        case "end": {
          const b = bridges.get(key);
          if (b) {
            b.ws.send(JSON.stringify({ type: "stop" }));
            b.ws.close();
            bridges.delete(key);
          }
          saveTgBindings(loadTgBindings().filter((x: any) => x.key !== key));
          await tg("sendMessage", {
            chat_id: chat.id,
            ...(threadId ? { message_thread_id: threadId } : {}),
            text: cmd.cmd === "new" ? "🔄 fresh session — send a message." : "🛑 session ended.",
          });
          return;
        }
        case "list": {
          const lines = loadTgBindings().map((x: any) => `• ${x.key} → ${String(x.sessionId).slice(0, 8)}`);
          await tg("sendMessage", {
            chat_id: chat.id,
            ...(threadId ? { message_thread_id: threadId } : {}),
            text: lines.length ? lines.join("\n") : "no sessions bound yet.",
          });
          return;
        }
        // spawn / cwd / worktree: increment 2
      }
    }

    promptTo(bridgeFor(key, chat.id, threadId), msg.text);
  };

  // Long-poll loop — no webhook / public URL needed.
  let offset = 0;
  const poll = async () => {
    const res = await tg("getUpdates", { offset, timeout: 30, allowed_updates: ["message", "callback_query"] });
    if (res?.ok && Array.isArray(res.result)) {
      for (const u of res.result) {
        offset = u.update_id + 1;
        handleUpdate(u).catch(() => {});
      }
    }
    setTimeout(poll, res ? 0 : 3000); // back off on network error
  };

  tg("getMe", {}).then((me) => {
    if (me?.ok) {
      console.log(`telegram: bot @${me.result.username} connected (long-polling)`);
      poll();
    } else {
      console.log("telegram: getMe failed — check TELEGRAM_BOT_TOKEN");
    }
  });
}
