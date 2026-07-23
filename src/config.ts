import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Global CLI config at ~/.shadok-ai/config.json (mode 600). The Telegram bot
 * token is **per launch directory** (`tokens[cwd]`), so each instance you run
 * from a different directory has its own bot — like the channel list. Port is
 * global.
 *
 * Per-cwd token semantics:
 *   undefined → never asked for this dir yet (first run should prompt)
 *   null      → asked and deliberately skipped (never prompt again)
 *   string    → the token
 */
export interface Config {
  port?: number;
  /** @deprecated legacy single global token — migrated into `tokens` on boot. */
  telegramToken?: string | null;
  /** Per launch-directory bot token, keyed by absolute cwd. */
  tokens?: Record<string, string | null>;
}

export const SHADOK_DIR = path.join(os.homedir(), ".shadok-ai");
const CONFIG_FILE = path.join(SHADOK_DIR, "config.json");
const LEGACY_ENV = path.join(SHADOK_DIR, "telegram.env");

export function loadConfig(): Config {
  try {
    const v = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

export function saveConfig(cfg: Config): void {
  fs.mkdirSync(SHADOK_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  fs.chmodSync(CONFIG_FILE, 0o600); // the token is a secret; enforce 600
}

/** This directory's token entry (undefined = never asked). */
export function tokenForCwd(cfg: Config, cwd: string): string | null | undefined {
  return cfg.tokens?.[cwd];
}

export function setTokenForCwd(cfg: Config, cwd: string, token: string | null): void {
  (cfg.tokens ??= {})[cwd] = token;
  saveConfig(cfg);
}

/**
 * The effective token for an instance launched in `cwd`: an explicit env var
 * always wins, otherwise this directory's configured token. No global fallback —
 * a different directory gets a different bot (or none).
 */
export function effectiveToken(cfg: Config, cwd: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.TELEGRAM_BOT_TOKEN) return env.TELEGRAM_BOT_TOKEN;
  return cfg.tokens?.[cwd] ?? null;
}

/** Pull TELEGRAM_BOT_TOKEN out of a shell-style env file body. */
export function parseLegacyToken(raw: string): string | null {
  const m = raw.match(/TELEGRAM_BOT_TOKEN\s*=\s*["']?([^"'\s]+)/);
  return m ? m[1] : null;
}

/**
 * One-time migration of the OLD global token (the `telegram.env` file and the
 * legacy `telegramToken` config field, both global) into this directory's token
 * — but only for an already-established instance (`established`, i.e. it has a
 * bound Telegram group), so an existing setup keeps its bot while a brand-new
 * directory is prompted for its own. Both global sources are consumed (env file
 * renamed, config field deleted) so they never leak to another directory.
 */
export function migrateLegacyToken(cfg: Config, cwd: string, established: boolean): void {
  if (cfg.tokens?.[cwd] !== undefined || !established) return;
  let token: string | null = null;
  try {
    token = parseLegacyToken(fs.readFileSync(LEGACY_ENV, "utf8"));
  } catch {
    /* no env file */
  }
  if (!token && typeof cfg.telegramToken === "string") token = cfg.telegramToken;
  if (!token) return;
  (cfg.tokens ??= {})[cwd] = token;
  delete cfg.telegramToken; // consume the global field
  try {
    fs.renameSync(LEGACY_ENV, LEGACY_ENV + ".migrated"); // consume the global file
  } catch {
    /* best effort */
  }
  saveConfig(cfg);
}
