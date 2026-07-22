import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectDialog, extractResponse, loadHistory, listSessions, findSessionId } from "../src/extract.js";

// ── detectDialog ─────────────────────────────────────────────────────────

test("single-select dialog: question + options, ❯ selector required", () => {
  const screen = [
    " □ Test",
    "Quelle option préfères-tu ?",
    "❯ 1. Option A",
    "    First option, nothing special.",
    "  2. Option B",
    "  3. Option C",
    "Enter to select · ↑/↓ to navigate · Esc to cancel",
  ].join("\n");
  const d = detectDialog(screen);
  assert.ok(d, "should detect");
  assert.equal(d!.multi, false);
  assert.equal(d!.question, "Quelle option préfères-tu ?");
  assert.deepEqual(d!.options.map((o) => o.n), [1, 2, 3]);
  assert.equal(d!.options[0].label, "Option A");
  assert.equal(d!.options[0].hint, "First option, nothing special.");
});

test("two-column dialog: the right-hand preview chart is stripped from labels", () => {
  const screen = [
    "Quel style de visualisation veux-tu ?",
    "❯ 1. Barres horizontales          ┌─────────────────────────────────────┐",
    "    (Recommandé)                  │ JAUGES — barres horizontales         │",
    "  2. Sparklines temporelles       │   Session   ████████░░░░  67%         │",
    "  3. Cadrans / arcs               │   Semaine   ██████░░░░░░  42%         │",
    "Enter to select · ↑/↓ to navigate",
  ].join("\n");
  const d = detectDialog(screen);
  assert.ok(d);
  assert.equal(d!.options[0].label, "Barres horizontales");
  assert.equal(d!.options[1].label, "Sparklines temporelles");
  assert.equal(d!.options[2].label, "Cadrans / arcs");
  assert.equal(d!.question, "Quel style de visualisation veux-tu ?");
});

test("multi-select dialog: checkboxes parsed with their state", () => {
  const screen = [
    "Quelles garnitures ?",
    "❯ 1. [✔] Champignons",
    "  2. [ ] Pepperoni",
    "  3. [✔] Mozzarella",
    "Enter to select · ↑/↓ to navigate",
  ].join("\n");
  const d = detectDialog(screen);
  assert.ok(d);
  assert.equal(d!.multi, true);
  assert.deepEqual(
    d!.options.map((o) => o.checked),
    [true, false, true],
  );
});

test("no ❯ selector → not a dialog", () => {
  const screen = ["Some text", "  1. thing", "  2. other"].join("\n");
  assert.equal(detectDialog(screen), null);
});

test("fewer than 2 options → not a dialog", () => {
  assert.equal(detectDialog("Q?\n❯ 1. only one"), null);
});

test("plain transcript text → not a dialog", () => {
  assert.equal(detectDialog("⏺ Voici la réponse.\n\nUn paragraphe normal."), null);
});

// ── extractResponse ──────────────────────────────────────────────────────

test("extractResponse takes the ⏺ answer after the prompt echo, dropping status", () => {
  const buffer = [
    "❯ Explique X",
    "⏺ Voici l'explication de X.",
    "  suite sur deux lignes.",
    "✻ Cooked for 3s",
    "────────────────────────────────────────────",
    "❯ ",
  ].join("\n");
  const out = extractResponse(buffer, "Explique X");
  assert.match(out, /Voici l'explication de X/);
  assert.match(out, /suite sur deux lignes/);
  assert.doesNotMatch(out, /Cooked for/);
  assert.doesNotMatch(out, /^❯/m);
});

// ── filesystem readers (loadHistory / listSessions / findSessionId) ───────
// Run against a throwaway HOME so we never touch the real ~/.claude.

function withTempHome(fn: (cwd: string, sid: string) => void) {
  const prevHome = process.env.HOME;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cp-home-"));
  process.env.HOME = tmp;
  try {
    const cwd = "/tmp/some/project";
    const sid = "abc123-session";
    const enc = cwd.replace(/[^a-zA-Z0-9]/g, "-");
    const dir = path.join(tmp, ".claude", "projects", enc);
    fs.mkdirSync(dir, { recursive: true });
    const lines = [
      JSON.stringify({ type: "user", isMeta: true, message: { content: "<system>" } }),
      JSON.stringify({ type: "user", message: { content: "Première demande" } }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "Réponse une." }] },
      }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "Suite de la réponse une." }] },
      }),
      JSON.stringify({ type: "user", message: { content: "[Request interrupted…" } }),
    ].join("\n");
    fs.writeFileSync(path.join(dir, sid + ".jsonl"), lines);
    fn(cwd, sid);
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test("loadHistory: real turns only, consecutive assistant blocks merged, meta/interrupt skipped", () => {
  withTempHome((cwd, sid) => {
    const turns = loadHistory(cwd, sid);
    assert.deepEqual(
      turns.map((t) => t.role),
      ["user", "assistant"],
    );
    assert.equal(turns[0].text, "Première demande");
    assert.match(turns[1].text, /Réponse une\.\n\nSuite de la réponse une\./);
  });
});

test("findSessionId returns the session's id; listSessions previews the first prompt", () => {
  withTempHome((cwd, sid) => {
    assert.equal(findSessionId(cwd), sid);
    const list = listSessions(cwd);
    assert.equal(list.length, 1);
    assert.equal(list[0].id, sid);
    assert.equal(list[0].preview, "Première demande");
  });
});

test("loadHistory on a missing transcript is empty, never throws", () => {
  assert.deepEqual(loadHistory("/nope/nowhere", "missing"), []);
});
