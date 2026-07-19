import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface Worktree {
  /** Working directory of the isolated checkout. */
  path: string;
  /** Branch created for this session. */
  branch: string;
  /** Commit the branch forked from (diff baseline). */
  baseSha: string;
  /** The original repository the worktree belongs to. */
  repo: string;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trimEnd();
}

/** True if `cwd` is inside a git working tree. */
export function isGitRepo(cwd: string): boolean {
  try {
    return git(cwd, ["rev-parse", "--is-inside-work-tree"]) === "true";
  } catch {
    return false;
  }
}

/**
 * Creates an isolated git worktree off the repo's current HEAD, on a fresh
 * branch, so an agent's edits stay contained until the user merges them.
 * The checkout lives under ~/.claudepilot/worktrees to avoid polluting the repo.
 */
export function createWorktree(repo: string, tag: string): Worktree {
  const baseSha = git(repo, ["rev-parse", "HEAD"]);
  const repoName = path.basename(path.resolve(repo)).replace(/[^a-zA-Z0-9._-]/g, "-");
  const branch = `claudepilot/${tag}`;
  const dir = path.join(os.homedir(), ".claudepilot", "worktrees", `${repoName}-${tag}`);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  git(repo, ["worktree", "add", "-b", branch, dir, baseSha]);
  return { path: dir, branch, baseSha, repo };
}

/**
 * Removes a worktree only if it has no uncommitted changes (git refuses a
 * dirty removal without --force, which we intentionally don't pass — work is
 * never discarded automatically).
 */
export function removeWorktreeIfClean(wt: Worktree): void {
  try {
    git(wt.repo, ["worktree", "remove", wt.path]);
  } catch {
    // Dirty or has commits: leave it in place for the user to merge/inspect.
  }
}

export interface DiffResult {
  status: string;
  diff: string;
  branch: string | null;
}

/**
 * Returns the changes made in `cwd`: `git status` plus the full diff. With a
 * known baseline (worktree), diffs against the fork point so committed work
 * shows too; otherwise diffs the working tree against HEAD.
 */
export function gitDiff(cwd: string, baseSha?: string | null): DiffResult {
  let status = "",
    diff = "",
    branch: string | null = null;
  try {
    branch = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
    status = git(cwd, ["status", "--short"]);
    diff = git(cwd, ["diff", baseSha ?? "HEAD"]);
    // Include untracked files (diff doesn't show them).
    const untracked = git(cwd, ["ls-files", "--others", "--exclude-standard"])
      .split("\n")
      .filter(Boolean);
    if (untracked.length) {
      const shown = untracked.map((f) => {
        try {
          const body = git(cwd, ["diff", "--no-index", "/dev/null", f]);
          return body;
        } catch (e: any) {
          // --no-index exits non-zero when files differ; its stdout has the diff.
          return e?.stdout ? String(e.stdout).trimEnd() : `+++ ${f} (untracked)`;
        }
      });
      diff = [diff, ...shown].filter(Boolean).join("\n");
    }
  } catch {
    // not a repo, or git error — return whatever we gathered
  }
  return { status, diff, branch };
}
