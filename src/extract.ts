import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Extracts the response: everything after the "❯ <prompt>" echo in the
 * transcript, minus the final input box and status lines.
 */
export function extractResponse(buffer: string, prompt: string): string {
  const lines = buffer.split("\n");
  const probe = prompt.slice(0, 15);
  let start = -1;
  // The prompt echo in the transcript starts with "❯ "; so does the (empty)
  // input box at the bottom — take the last occurrence containing the
  // beginning of the prompt.
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^\s*[❯>]/.test(lines[i]) && lines[i].includes(probe)) {
      start = i + 1;
      break;
    }
  }
  if (start === -1) return buffer.trim();
  // A long prompt echo spans several lines: the response starts at the
  // first "⏺" marker that follows, when there is one.
  for (let i = start; i < lines.length; i++) {
    if (/^\s*⏺/.test(lines[i])) {
      start = i;
      break;
    }
  }
  const noise = (l: string) =>
    /^\s*✻/.test(l) || /·\s*\/effort\s*$/.test(l) || /esc to interrupt/i.test(l);
  // Cut the input area (─── separator followed by ❯) when present.
  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    if (/^─{10,}/.test(lines[i].trim())) {
      end = i;
      break;
    }
  }
  return lines
    .slice(start, end)
    .filter((l) => !noise(l))
    .join("\n")
    .trim();
}

export interface TuiDialogOption {
  n: number;
  label: string;
  hint: string;
  /** Multi-select only: state of the [ ] / [✔] checkbox. */
  checked?: boolean;
}

export interface TuiDialog {
  question: string;
  options: TuiDialogOption[];
  /**
   * True for multi-select questions: digits toggle checkboxes, submission
   * goes through Tab (Submit page) then Enter. In single-select mode,
   * pressing the digit selects and validates directly.
   */
  multi: boolean;
}

/**
 * Detects an interactive TUI dialog (multiple-choice question, permission
 * prompt…): numbered options, one of which carries the "❯" selector.
 */
export function detectDialog(screen: string): TuiDialog | null {
  const lines = screen.split("\n");
  const optionRe = /^\s*(❯\s*)?(\d+)\.\s+(?:\[( |✔|✓|x)\]\s*)?(.+)$/;
  const options: TuiDialogOption[] = [];
  let hasSelector = false;
  let multi = false;
  let firstOptionLine = -1;
  let current: TuiDialogOption | null = null;

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(optionRe);
    if (m) {
      if (m[1]) hasSelector = true;
      current = { n: Number(m[2]), label: m[4].trim(), hint: "" };
      if (m[3] !== undefined) {
        multi = true;
        current.checked = m[3] !== " ";
      }
      options.push(current);
      if (firstOptionLine === -1) firstOptionLine = i;
    } else if (
      current &&
      /^\s{2,}\S/.test(lines[i]) &&
      !/Enter to /i.test(lines[i]) &&
      !/^\s*Submit\s*$/.test(lines[i])
    ) {
      // Indented line under an option: the option's description.
      current.hint = (current.hint ? current.hint + " " : "") + lines[i].trim();
    } else if (lines[i].trim() !== "" && !/^\s*─+/.test(lines[i])) {
      current = null;
    }
  }

  if (options.length < 2 || !hasSelector) return null;

  // The question: the text lines right above the first option (skipping
  // frames, separators and the "← ☐ … ✔ Submit →" tab bar).
  const questionLines: string[] = [];
  for (let i = firstOptionLine - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (t === "" || /^[─═╭╮╰╯│□⏺←→]/.test(t) || /[☐☒]|✔\s*Submit/.test(t)) {
      if (questionLines.length) break;
      continue;
    }
    questionLines.unshift(t);
  }
  return { question: questionLines.join(" "), options, multi };
}

export interface HistoryTurn {
  role: "user" | "assistant";
  text: string;
}

/**
 * Reads a session transcript back from its .jsonl file
 * (~/.claude/projects/<encoded cwd>/<session-id>.jsonl) so the history can
 * be replayed when resuming the session.
 */
export function loadHistory(cwd: string, sessionId: string): HistoryTurn[] {
  const encoded = path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, "-");
  const file = path.join(
    os.homedir(),
    ".claude",
    "projects",
    encoded,
    sessionId + ".jsonl",
  );
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const turns: HistoryTurn[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.isMeta || !e.message) continue;
    if (e.type === "user") {
      const c = e.message.content;
      let text = "";
      if (typeof c === "string") text = c;
      else if (Array.isArray(c))
        text = c
          .filter((b: any) => b.type === "text")
          .map((b: any) => b.text)
          .join("\n");
      text = text.trim();
      // Skip technical messages (system reminders, commands, tool results,
      // interruptions).
      if (!text || text.startsWith("<") || text.startsWith("[Request interrupted"))
        continue;
      turns.push({ role: "user", text });
    } else if (e.type === "assistant" && Array.isArray(e.message.content)) {
      const text = e.message.content
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join("\n")
        .trim();
      if (!text) continue;
      const last = turns[turns.length - 1];
      if (last && last.role === "assistant") last.text += "\n\n" + text;
      else turns.push({ role: "assistant", text });
    }
  }
  return turns.slice(-100);
}

export interface SessionInfo {
  id: string;
  /** Last activity, in ms since epoch (file mtime). */
  mtime: number;
  /** First real user prompt of the session, truncated. */
  preview: string;
}

/**
 * Lists the resumable sessions of a directory (newest first), with the
 * first user prompt as a preview so a session can be recognized by more
 * than its id.
 */
export function listSessions(cwd: string): SessionInfo[] {
  const encoded = path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, "-");
  const dir = path.join(os.homedir(), ".claude", "projects", encoded);
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return [];
  }
  const sessions: SessionInfo[] = [];
  for (const f of files) {
    const file = path.join(dir, f);
    let mtime: number;
    try {
      mtime = fs.statSync(file).mtimeMs;
    } catch {
      continue;
    }
    sessions.push({
      id: f.replace(/\.jsonl$/, ""),
      mtime,
      preview: firstUserPrompt(file),
    });
  }
  return sessions.sort((a, b) => b.mtime - a.mtime);
}

/** Reads the beginning of a transcript and returns the first real user prompt. */
function firstUserPrompt(file: string): string {
  // Only the head of the file is needed — transcripts can be several MB.
  let head: string;
  try {
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(256 * 1024);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      head = buf.toString("utf8", 0, n);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
  for (const line of head.split("\n")) {
    if (!line.trim()) continue;
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.isMeta || e.type !== "user" || !e.message) continue;
    const c = e.message.content;
    let text = "";
    if (typeof c === "string") text = c;
    else if (Array.isArray(c))
      text = c
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join("\n");
    text = text.trim();
    // Same filtering as loadHistory: skip technical messages.
    if (!text || text.startsWith("<") || text.startsWith("[Request interrupted"))
      continue;
    return text.replace(/\s+/g, " ").slice(0, 120);
  }
  return "";
}

/**
 * Finds the id of the most recent session of a directory: Claude Code
 * writes each session to ~/.claude/projects/<encoded cwd>/<session-id>.jsonl.
 */
export function findSessionId(cwd: string): string | null {
  const encoded = path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, "-");
  const dir = path.join(os.homedir(), ".claude", "projects", encoded);
  try {
    const newest = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => ({ f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)[0];
    return newest ? newest.f.replace(/\.jsonl$/, "") : null;
  } catch {
    return null;
  }
}
