import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Per-repo secrets, stored OUTSIDE any repo at ~/.shadok-ai/secrets.json (600)
 * and injected as environment variables into an agent's `claude` process at
 * spawn — never written into the working directory. Keyed by the main repo root
 * so all worktrees of a repo share its secrets.
 */
export type SecretStore = Record<string, Record<string, string>>;

const FILE = path.join(os.homedir(), ".shadok-ai", "secrets.json");

export function loadStore(): SecretStore {
  try {
    const v = JSON.parse(fs.readFileSync(FILE, "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

function saveStore(s: SecretStore): void {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(s, null, 2), { mode: 0o600 });
  fs.chmodSync(FILE, 0o600); // enforce 600 even if the file pre-existed
}

// ── Pure cores (unit-tested) ─────────────────────────────────────────────

/** Set repo[key]=value in a store, returning a new store (no mutation). */
export function mergeSecret(store: SecretStore, repo: string, key: string, value: string): SecretStore {
  return { ...store, [repo]: { ...(store[repo] ?? {}), [key]: value } };
}

/** Remove repo[key], dropping the repo entry when it becomes empty. */
export function dropSecret(store: SecretStore, repo: string, key: string): SecretStore {
  if (!store[repo] || !(key in store[repo])) return store;
  const repoSecrets = { ...store[repo] };
  delete repoSecrets[key];
  const next = { ...store };
  if (Object.keys(repoSecrets).length) next[repo] = repoSecrets;
  else delete next[repo];
  return next;
}

// ── Repo resolution ──────────────────────────────────────────────────────

/** The main repo root for a cwd (worktree-safe); the cwd if it isn't a repo. */
export function resolveRepo(cwd: string): string {
  try {
    const common = execFileSync("git", ["-C", cwd, "rev-parse", "--git-common-dir"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const abs = path.isAbsolute(common) ? common : path.resolve(cwd, common);
    return path.dirname(abs);
  } catch {
    return cwd;
  }
}

// ── Store API ────────────────────────────────────────────────────────────

export function secretsForRepo(repo: string): Record<string, string> {
  return loadStore()[repo] ?? {};
}

/** Secrets to inject for an agent running in `cwd` (resolved to its repo). */
export function secretsForCwd(cwd: string): Record<string, string> {
  return secretsForRepo(resolveRepo(cwd));
}

/** Key names for a repo (never the values). */
export function secretKeys(repo: string): string[] {
  return Object.keys(secretsForRepo(repo));
}

export function setSecret(repo: string, key: string, value: string): void {
  saveStore(mergeSecret(loadStore(), repo, key, value));
}

export function deleteSecret(repo: string, key: string): void {
  saveStore(dropSecret(loadStore(), repo, key));
}
