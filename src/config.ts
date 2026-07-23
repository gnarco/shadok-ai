import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Global CLI config, stored at ~/.shadok-ai/config.json (mode 600). Holds the
 * Telegram bot token and the port. Replaces the old telegram.env shell hack:
 * the token now lives here and is passed to the server child via env.
 *
 * `telegramToken` semantics:
 *   undefined → never asked yet (first run should prompt)
 *   null      → asked and deliberately skipped (never prompt again)
 *   string    → the token
 */
export interface Config {
  telegramToken?: string | null;
  port?: number;
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
  // 600: the token is a secret. Write then chmod (umask-independent).
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  fs.chmodSync(CONFIG_FILE, 0o600);
}

/**
 * One-time migration of the legacy ~/.shadok-ai/telegram.env
 * (`TELEGRAM_BOT_TOKEN=...`) into config.json. Returns the migrated token, or
 * null if there was nothing to migrate. The env file is left on disk but no
 * longer read by anything.
 */
export function migrateLegacyEnv(cfg: Config): string | null {
  if (cfg.telegramToken !== undefined) return null; // already decided
  let raw: string;
  try {
    raw = fs.readFileSync(LEGACY_ENV, "utf8");
  } catch {
    return null;
  }
  const token = parseLegacyToken(raw);
  if (!token) return null;
  cfg.telegramToken = token;
  saveConfig(cfg);
  return token;
}

/** Pull TELEGRAM_BOT_TOKEN out of a shell-style env file body. */
export function parseLegacyToken(raw: string): string | null {
  const m = raw.match(/TELEGRAM_BOT_TOKEN\s*=\s*["']?([^"'\s]+)/);
  return m ? m[1] : null;
}

/**
 * The effective token to hand the server: an explicit env var always wins,
 * otherwise the configured value (a null/undefined config means "no token").
 */
export function effectiveToken(cfg: Config, env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.TELEGRAM_BOT_TOKEN) return env.TELEGRAM_BOT_TOKEN;
  return cfg.telegramToken ?? null;
}
