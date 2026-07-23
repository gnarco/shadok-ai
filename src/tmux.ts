import { execFileSync } from "node:child_process";
import { screenShowsWork, inputHasProbe } from "./detect.js";
import type { PilotOptions, WaitIdleOptions, WaitOptions } from "./session.js";

/**
 * Same interface as {@link PtyPilot}, but runs `claude` inside a detached
 * **tmux** session instead of a node-pty child. tmux (its own daemon) owns the
 * terminal, so the agent survives the shadok-ai server restarting or
 * crashing: on restart the server reattaches to the running tmux session and
 * the in-flight turn continues uninterrupted.
 *
 * The tmux session name is derived from the Claude session id, so reattach is
 * deterministic. Content still comes from the .jsonl tail (unchanged); tmux is
 * only about keeping the live process alive.
 */
export interface TmuxPilotOptions extends PilotOptions {
  /** tmux session name (stable across restarts — derive from the session id). */
  tmuxName: string;
}

function tmux(args: string[], input?: string): string {
  return execFileSync("tmux", args, {
    encoding: "utf8",
    input,
    timeout: 10_000,
    maxBuffer: 8 * 1024 * 1024,
    stdio: ["pipe", "pipe", "ignore"],
  });
}

function tmuxOk(args: string[]): boolean {
  try {
    tmux(args);
    return true;
  } catch {
    return false;
  }
}

export class TmuxPilot {
  private readonly opts: Required<Pick<TmuxPilotOptions, "cols" | "rows">> & TmuxPilotOptions;
  private readonly name: string;
  private exitListeners = new Set<(code: number) => void>();
  private poller: ReturnType<typeof setInterval> | null = null;
  private _screen = "";
  private exited = false;
  /** True when we reattached to an already-running session (survived restart). */
  attached = false;

  constructor(options: TmuxPilotOptions) {
    this.opts = { cols: 100, rows: 40, ...options };
    this.name = options.tmuxName;
  }

  /** Whether a tmux session with our name is currently alive. */
  private hasSession(): boolean {
    return tmuxOk(["has-session", "-t", this.name]);
  }

  start(): void {
    if (this.hasSession()) {
      // Reattach to a session that outlived a previous server: claude is
      // already past the trust dialog and holding its state.
      this.attached = true;
    } else {
      // Strip a parent Claude Code session's vars (a nested claude that sees
      // them may disable interactive mode), like PtyPilot does.
      const unset = Object.keys(process.env)
        .filter((k) => /^(CLAUDE|CLAUDECODE|AI_AGENT)/.test(k))
        .flatMap((k) => ["-u", k]);
      const bin = this.opts.claudePath ?? "claude";
      const cmd = ["env", ...unset, "TERM=xterm-256color", bin, ...(this.opts.args ?? [])]
        .map((a) => `'${String(a).replace(/'/g, "'\\''")}'`)
        .join(" ");
      tmux([
        "new-session",
        "-d",
        "-s", this.name,
        "-x", String(this.opts.cols),
        "-y", String(this.opts.rows),
        "-c", this.opts.cwd ?? process.cwd(),
        cmd,
      ]);
    }
    this.capture();
    this.poller = setInterval(() => this.tick(), 250);
  }

  private tick(): void {
    if (this.exited) return;
    if (!this.hasSession()) {
      this.exited = true;
      if (this.poller) clearInterval(this.poller);
      this.poller = null;
      for (const cb of this.exitListeners) cb(0);
      return;
    }
    this.capture();
  }

  /** Refreshes the cached rendered screen from tmux. */
  private capture(): void {
    try {
      this._screen = tmux(["capture-pane", "-t", this.name, "-p"]).replace(/\n+$/, "");
    } catch {
      /* session gone or transient tmux error — keep last */
    }
  }

  onExit(cb: (code: number) => void): () => void {
    this.exitListeners.add(cb);
    return () => this.exitListeners.delete(cb);
  }

  get hasExited(): boolean {
    return this.exited;
  }

  /** The currently rendered screen (cached, refreshed by the poller). */
  screen(): string {
    return this._screen;
  }

  /** tmux gives us the rendered pane incl. scrollback; used rarely. */
  fullBuffer(): string {
    try {
      return tmux(["capture-pane", "-t", this.name, "-p", "-S", "-"]).replace(/\n+$/, "");
    } catch {
      return this._screen;
    }
  }

  /** Sends literal text to the session (no submit). */
  write(text: string): void {
    tmux(["send-keys", "-t", this.name, "-l", "--", text]);
  }

  /** Pastes text with bracketed-paste framing (reliable for the TUI input). */
  private paste(text: string): void {
    tmux(["load-buffer", "-b", "cp", "-"], text);
    tmux(["paste-buffer", "-t", this.name, "-b", "cp", "-p", "-d"]);
  }

  press(key: "enter" | "escape" | "up" | "down" | "left" | "right" | "tab" | "ctrl-c"): void {
    const map: Record<string, string> = {
      enter: "Enter",
      escape: "Escape",
      up: "Up",
      down: "Down",
      left: "Left",
      right: "Right",
      tab: "Tab",
      "ctrl-c": "C-c",
    };
    tmux(["send-keys", "-t", this.name, map[key]]);
  }

  isWorking(): boolean {
    return screenShowsWork(this.screen());
  }

  /**
   * Types a prompt then presses Enter — same robustness as PtyPilot:
   * bracketed paste with retry until the text shows, then Enter with retry
   * until the turn is actually sent.
   */
  async submit(text: string): Promise<void> {
    const probe = text.slice(0, 15);
    let typed = false;
    for (let attempt = 0; attempt < 6; attempt++) {
      this.paste(text);
      try {
        await this.waitFor((s) => s.includes(probe), { timeoutMs: 2_000 });
        typed = true;
        break;
      } catch {
        this.write("\x15"); // Ctrl-U: clear partial input
        await sleep(300);
      }
    }
    if (!typed) {
      throw this.submitError("the text never appeared in the input box");
    }
    await sleep(200);
    // Enter was accepted once the text we typed has LEFT the input box (or the
    // spinner is up). Don't require the echo to still be visible in scrollback:
    // a fast turn scrolls it away and that caused false "not sent" dumps.
    const submitted = (s: string) => screenShowsWork(s) || !inputHasProbe(s, probe);
    for (let attempt = 0; attempt < 3; attempt++) {
      this.press("enter");
      try {
        await this.waitFor(submitted, { timeoutMs: 3_000 });
        return;
      } catch {
        /* Enter swallowed — retry */
      }
    }
    throw this.submitError("the prompt does not seem to have been sent");
  }

  /** A concise client-facing error; the full screen goes to the server log only. */
  private submitError(reason: string): Error {
    console.error(`[${this.name}] submit failed — ${reason}. Screen:\n${this.screen()}`);
    return new Error(`submit: ${reason}.`);
  }

  async waitFor(
    predicate: (screen: string) => boolean,
    { timeoutMs = 60_000 }: WaitOptions = {},
  ): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.exited) throw new Error("The claude process has exited.");
      const s = this.screen();
      if (predicate(s)) return s;
      await sleep(120);
    }
    throw new Error(`waitFor: timed out after ${timeoutMs} ms. Last screen:\n${this.screen()}`);
  }

  async waitForIdle({
    stableMs = 1_500,
    timeoutMs = 600_000,
  }: WaitIdleOptions = {}): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    let lastScreen = "";
    let stableSince = 0;
    while (Date.now() < deadline) {
      if (this.exited) throw new Error("The claude process has exited.");
      const s = this.screen();
      const working = screenShowsWork(s);
      if (!working && s === lastScreen) {
        if (stableSince === 0) stableSince = Date.now();
        if (Date.now() - stableSince >= stableMs) return s;
      } else {
        stableSince = 0;
        lastScreen = s;
      }
      await sleep(160);
    }
    throw new Error(`waitForIdle: timed out after ${timeoutMs} ms. Last screen:\n${this.screen()}`);
  }

  /** Clean shutdown: /exit, then kill the tmux session as a fallback. */
  async stop(): Promise<void> {
    if (this.exited) return;
    try {
      await this.submit("/exit");
      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline && this.hasSession()) await sleep(200);
    } catch {
      /* fall through to kill */
    }
    this.kill();
  }

  /** Kills the tmux session (ends the agent). */
  kill(): void {
    tmuxOk(["kill-session", "-t", this.name]);
    if (this.poller) clearInterval(this.poller);
    this.poller = null;
    this.exited = true;
  }
}

/** True when tmux is available on this host. */
export function tmuxAvailable(): boolean {
  return tmuxOk(["-V"]);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
