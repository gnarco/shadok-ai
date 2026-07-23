import WebSocket from "ws";
import {
  loadChannels,
  upsertChannel,
  removeChannel,
  channelForTelegram,
  loadTgGroup,
  saveTgGroup,
} from "./channels.js";
import { readAndClearUpdateResult } from "./update-flag.js";
import { UPDATE_EXIT_CODE } from "./supervisor.js";

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

/** Telegram's "typing…" indicator lives ~5 s per sendChatAction and dies on
 *  every sendMessage — a single beat can't cover a turn that runs for minutes.
 *  This keeps it alive: an immediate beat, then one every `intervalMs` until
 *  stop(). start() while beating is a no-op; stop() is idempotent. */
export function makeTyping(beat: () => void, intervalMs = 4000): { start: () => void; stop: () => void } {
  let timer: NodeJS.Timeout | null = null;
  return {
    start() {
      if (timer) return;
      beat();
      timer = setInterval(beat, intervalMs);
      timer.unref?.(); // never keep the process alive for an indicator
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

interface DialogOption {
  n: number;
  label: string;
  hint?: string;
  checked?: boolean;
}
interface Dialog {
  question: string;
  options: DialogOption[];
  multi: boolean;
}

/** Inline keyboard for a TUI dialog. Single-select → one button per option
 *  (choose); multi-select → toggle buttons (with ☑/☐) + a Submit row. */
export function dialogKeyboard(d: Dialog): { inline_keyboard: { text: string; callback_data: string }[][] } {
  const rows = d.options.map((o) => [
    {
      text: (d.multi ? (o.checked ? "☑ " : "☐ ") : "") + `${o.n}. ${o.label}`.slice(0, 60),
      callback_data: (d.multi ? "t:" : "d:") + o.n,
    },
  ]);
  if (d.multi) rows.push([{ text: "✅ Submit", callback_data: "s" }]);
  return { inline_keyboard: rows };
}

/** Parse a dialog callback_data → an action for the WS. */
export function parseCallback(data: string): { kind: "choose" | "toggle" | "confirm"; n?: number } | null {
  if (data === "s") return { kind: "confirm" };
  const m = data.match(/^([dt]):(\d+)$/);
  if (!m) return null;
  return { kind: m[1] === "d" ? "choose" : "toggle", n: Number(m[2]) };
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
  pendingActions: object[]; // dialog actions (choose/toggle/confirm) queued until ready
  dialogMsgId?: number; // Telegram message showing the current dialog keyboard
  worktree?: boolean; // spawn the session in an isolated worktree
  name?: string; // channel name (a /spawn topic name), stored in the registry
  typing: { start: () => void; stop: () => void }; // "typing…" heartbeat for the running turn
}

/**
 * Rename a Telegram forum topic to match a channel renamed elsewhere (the web
 * UI). Wired up by startTelegram; a no-op when Telegram is off. Lets the server
 * push a web-side rename to Telegram without importing its token/closure.
 */
let renameTopicImpl: ((chatId: number, threadId: number, name: string) => void) | null = null;
export function renameTelegramTopic(chatId: number, threadId: number, name: string): void {
  renameTopicImpl?.(chatId, threadId, name);
}

/** Close (archive) a Telegram forum topic when its session ends elsewhere. */
let closeTopicImpl: ((chatId: number, threadId: number) => void) | null = null;
export function closeTelegramTopic(chatId: number, threadId: number): void {
  closeTopicImpl?.(chatId, threadId);
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

  // Web-side rename → rename the matching Telegram topic (best effort).
  renameTopicImpl = (chatId, threadId, name) => {
    tg("editForumTopic", { chat_id: chatId, message_thread_id: threadId, name: name.slice(0, 128) });
  };
  // Session ended elsewhere → delete its topic so it disappears from the group
  // (the bot created it, so it can). Irreversible; ignore errors.
  closeTopicImpl = (chatId, threadId) => {
    tg("deleteForumTopic", { chat_id: chatId, message_thread_id: threadId });
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

  // Fold each bridge into the ONE registry: its session becomes a channel
  // carrying the Telegram binding, so it shows up (and is pilotable) in the web
  // UI too. The server fills cwd/branch on ready; here we own the binding.
  const persist = () => {
    for (const b of bridges.values()) {
      if (!b.sessionId) continue;
      upsertChannel({
        sessionId: b.sessionId,
        name: b.name,
        telegram: { chatId: b.chatId, ...(b.threadId ? { threadId: b.threadId } : {}) },
      });
    }
  };

  /** Open (or resume) a session for a chat/topic and wire its events to Telegram. */
  const openBridge = (
    key: string,
    chatId: number,
    threadId: number | undefined,
    opts: { resumeId?: string; worktree?: boolean; name?: string } = {},
  ): Bridge => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const b: Bridge = {
      key,
      chatId,
      threadId,
      ws,
      sessionId: opts.resumeId ?? null,
      ready: false,
      pending: [],
      pendingActions: [],
      worktree: opts.worktree,
      name: opts.name,
      typing: makeTyping(() =>
        tg("sendChatAction", {
          chat_id: chatId,
          ...(threadId ? { message_thread_id: threadId } : {}),
          action: "typing",
        }),
      ),
    };
    bridges.set(key, b);

    ws.on("open", () => {
      ws.send(
        JSON.stringify(
          opts.resumeId
            ? { type: "start", resume: opts.resumeId, cwd: process.cwd() }
            : { type: "start", cwd: process.cwd(), worktree: !!opts.worktree },
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
          for (const a of b.pendingActions.splice(0)) ws.send(JSON.stringify(a));
          break;
        case "working":
          // Heartbeat, not a one-shot: Telegram's indicator dies after ~5 s
          // (and on every message we send) while a turn runs for minutes.
          b.typing.start();
          break;
        case "stream-text":
          if (m.text?.trim()) send(b, m.text);
          break;
        case "stream-tool":
          send(b, "→ " + m.name + (m.summary ? "  " + m.summary : ""));
          break;
        case "dialog":
          // The turn is suspended on a question — Claude isn't "typing",
          // it's waiting for the user. Stop the heartbeat.
          b.typing.stop();
          // A TUI question → inline keyboard. On multi-select toggles the
          // server re-sends the dialog; edit the existing keyboard in place.
          if (b.dialogMsgId) {
            tg("editMessageReplyMarkup", {
              chat_id: b.chatId,
              message_id: b.dialogMsgId,
              reply_markup: dialogKeyboard(m),
            });
          } else {
            tg("sendMessage", {
              chat_id: b.chatId,
              ...(b.threadId ? { message_thread_id: b.threadId } : {}),
              text: m.question || "Choisis :",
              reply_markup: dialogKeyboard(m),
            }).then((r) => {
              if (r?.ok) b.dialogMsgId = r.result.message_id;
            });
          }
          break;
        case "turn-done":
          b.typing.stop();
          b.dialogMsgId = undefined; // any dialog is resolved once the turn ends
          break;
        case "pace-blocked":
          // The prompt was refused by the pace guard (there is no "force"
          // button here) — say so instead of staying silent, and drop the
          // optimistic typing started at message receipt.
          b.typing.stop();
          send(b, "⏸️ pace guard: " + (m.reason ?? "over the ideal pace") + "\nYour message was not sent — retry later.");
          break;
        case "error":
          // No typing.stop() here: fail() errors ("a response is already in
          // progress") don't end the running turn — turn-done/exited will.
          send(b, "⚠️ " + m.message);
          break;
        case "exited":
          b.typing.stop();
          send(b, "— session ended —");
          break;
      }
    });
    ws.on("close", () => {
      b.typing.stop();
      if (bridges.get(key) === b) bridges.delete(key);
    });
    ws.on("error", () => {});
    return b;
  };

  const bridgeFor = (key: string, chatId: number, threadId?: number): Bridge => {
    const existing = bridges.get(key);
    if (existing && existing.ws.readyState <= WebSocket.OPEN) return existing;
    const saved = channelForTelegram(chatId, threadId);
    return openBridge(key, chatId, threadId, { resumeId: saved?.sessionId });
  };

  const promptTo = (b: Bridge, text: string) => {
    if (b.ready && b.ws.readyState === WebSocket.OPEN) b.ws.send(JSON.stringify({ type: "prompt", text }));
    else b.pending.push(text);
  };

  const reply = (chatId: number, threadId: number | undefined, text: string, extra: object = {}) =>
    tg("sendMessage", {
      chat_id: chatId,
      ...(threadId ? { message_thread_id: threadId } : {}),
      text,
      disable_web_page_preview: true,
      ...extra,
    });

  const endBinding = (key: string, chatId: number, threadId?: number) => {
    const b = bridges.get(key);
    if (b) {
      b.ws.send(JSON.stringify({ type: "stop" }));
      b.ws.close();
      bridges.delete(key);
    }
    // The session is stopped → drop it from the one registry (removes it from
    // the web UI too).
    const ch = channelForTelegram(chatId, threadId);
    if (ch) removeChannel(ch.sessionId);
  };

  const handleMessage = async (msg: any) => {
    if (typeof msg.text !== "string") return;
    const chat = msg.chat;
    if (allowed.length && !allowed.includes(String(chat.id))) {
      await reply(chat.id, msg.message_thread_id, "⛔ this bot is restricted.");
      return;
    }
    const threadId = msg.message_thread_id as number | undefined;
    const isGroup = chat.type === "group" || chat.type === "supergroup";
    const cmd = parseCommand(msg.text);

    // One board per instance: a group must be the bound group.
    if (isGroup) {
      const bound = loadTgGroup();
      if (bound === null) {
        if (cmd?.cmd === "setup") {
          saveTgGroup(chat.id);
          await reply(chat.id, threadId, "✅ This group is now shadok-ai's board. Use /spawn <name> to create an agent (a forum topic). Enable Topics + make me admin if /spawn fails.");
        } else {
          await reply(chat.id, threadId, "Run /setup here to bind this group as shadok-ai's board (one group per instance).");
        }
        return;
      }
      if (bound !== chat.id) {
        await reply(chat.id, threadId, "⛔ This shadok-ai instance is bound to another group.");
        return;
      }
    }

    const key = bindKey(chat, threadId);

    if (cmd) {
      switch (cmd.cmd) {
        case "start":
        case "help":
          await reply(chat.id, threadId, "shadok-ai — talk to your agent by sending a message.\n/spawn <name> — new agent in a topic (groups)\n/new — reset · /end — stop · /list — bindings");
          return;
        case "setup":
          if (isGroup) await reply(chat.id, threadId, "✅ already this instance's board.");
          return;
        case "spawn": {
          if (!isGroup) {
            await reply(chat.id, threadId, "/spawn works in the board group. In a DM just send a message.");
            return;
          }
          const name = cmd.arg || "agent";
          const t = await tg("createForumTopic", { chat_id: chat.id, name: name.slice(0, 128) });
          if (!t?.ok) {
            const why = t?.description ? ` (Telegram: ${t.description})` : "";
            console.log(`telegram: createForumTopic failed for ${chat.id}:`, t?.description ?? t);
            await reply(chat.id, threadId, `⚠️ Couldn't create a topic${why}.\nMake sure this is a supergroup with Topics enabled, and that I'm an admin with 'Manage topics'.`);
            return;
          }
          const newThread = t.result.message_thread_id;
          // A group agent is isolated in its own worktree (a board of agents).
          openBridge(bindKey(chat, newThread), chat.id, newThread, { worktree: true, name });
          await reply(chat.id, newThread, `🤖 Agent « ${name} » ready (isolated worktree). Send it a task.`);
          return;
        }
        case "new":
        case "end":
          endBinding(key, chat.id, threadId);
          await reply(chat.id, threadId, cmd.cmd === "new" ? "🔄 fresh session — send a message." : "🛑 session ended.");
          return;
        case "list": {
          const lines = loadChannels()
            .filter((c) => c.telegram)
            .map((c) => {
              const where = c.telegram!.threadId ? `topic ${c.telegram!.threadId}` : "here";
              return `• ${c.name ?? c.sessionId.slice(0, 8)} (${where})`;
            });
          await reply(chat.id, threadId, lines.length ? lines.join("\n") : "no sessions bound yet.");
          return;
        }
        case "update": {
          // Powerful (npm install + respawn): board group only. The allowlist,
          // if set, was already enforced at the top of handleMessage.
          if (!isGroup) {
            await reply(chat.id, threadId, "/update runs in the board group.");
            return;
          }
          await reply(chat.id, threadId, "🔄 updating… I'll be back in a moment.");
          // Ask the supervisor to fetch @latest and respawn us.
          process.exit(UPDATE_EXIT_CODE);
        }
      }
    }

    // Optimistic typing: start the heartbeat now, before the server confirms
    // anything — spawning/resuming a session can take tens of seconds and the
    // first "working" only arrives after it. Every terminal outcome stops it
    // (turn-done, dialog, pace-blocked, exited, ws close).
    const b = bridgeFor(key, chat.id, threadId);
    b.typing.start();
    promptTo(b, msg.text);
  };

  const handleCallback = async (cq: any) => {
    const action = parseCallback(cq.data ?? "");
    const msg = cq.message;
    if (!action || !msg) return;
    await tg("answerCallbackQuery", { callback_query_id: cq.id }); // stop the client spinner
    const wsMsg =
      action.kind === "confirm" ? { type: "confirm" } : { type: action.kind, n: action.n };
    // Resume the bridge if the server was restarted since the dialog was shown
    // (otherwise a click on an orphaned keyboard would silently do nothing).
    const b = bridgeFor(bindKey(msg.chat, msg.message_thread_id), msg.chat.id, msg.message_thread_id);
    if (b.ready && b.ws.readyState === WebSocket.OPEN) b.ws.send(JSON.stringify(wsMsg));
    else b.pendingActions.push(wsMsg);
  };

  // A topic renamed in Telegram → update the one registry so the web tab follows.
  const handleTopicEdited = (msg: any) => {
    const name = msg.forum_topic_edited?.name;
    if (typeof name !== "string" || !name) return;
    const ch = channelForTelegram(msg.chat.id, msg.message_thread_id);
    if (ch) upsertChannel({ sessionId: ch.sessionId, name });
  };

  // A topic closed/deleted in Telegram → end its session everywhere. Sending
  // `stop` lets the server tear down + drop it from the registry (which removes
  // the web tab via the sync poll). No bridge → just unbind.
  const handleTopicClosed = (msg: any) => {
    const ch = channelForTelegram(msg.chat.id, msg.message_thread_id);
    if (!ch) return;
    const key = bindKey(msg.chat, msg.message_thread_id);
    const b = bridges.get(key);
    if (b?.ws.readyState === WebSocket.OPEN) b.ws.send(JSON.stringify({ type: "stop" }));
    else removeChannel(ch.sessionId);
    bridges.delete(key);
  };

  const handleUpdate = async (u: any) => {
    if (u.callback_query) return handleCallback(u.callback_query);
    if (u.message?.forum_topic_edited) return handleTopicEdited(u.message);
    if (u.message?.forum_topic_closed || u.message?.forum_topic_deleted)
      return handleTopicClosed(u.message);
    if (u.message) return handleMessage(u.message);
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

  // Connect, retrying transient failures with backoff. A single network hiccup
  // on getMe used to leave Telegram dead for the whole run; only a real 401
  // (bad token) stops us now.
  const connect = async (attempt = 0): Promise<void> => {
    const me = await tg("getMe", {});
    if (me?.ok) {
      console.log(`telegram: bot @${me.result.username} connected (long-polling)`);
      poll();
      announceUpdateResult();
      return;
    }
    if (me && me.error_code === 401) {
      console.log("telegram: unauthorized — check TELEGRAM_BOT_TOKEN");
      return;
    }
    const delay = Math.min(30_000, 2_000 * 2 ** attempt);
    console.log(`telegram: getMe failed (transient), retrying in ${delay / 1000}s`);
    setTimeout(() => connect(attempt + 1), delay);
  };
  connect();

  /** After a supervisor-driven /update, tell the board group how it went. */
  function announceUpdateResult(): void {
    const r = readAndClearUpdateResult();
    const group = loadTgGroup();
    if (!r || group === null) return;
    const text = r.ok ? `✅ updated to v${r.version}` : `⚠️ update failed: ${r.error}`;
    tg("sendMessage", { chat_id: group, text });
  }
}
