import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startMockServer } from "./mock-server.mjs";

process.env.CLAUDEPILOT_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pilotctl-test-"));
process.env.CLAUDEPILOT_NO_HOLDER = "1";
process.env.CLAUDEPILOT_NO_AUTOSTART = "1";
const { run, writeState } = await import("../pilotctl.mjs");

const READY = { type: "ready", sessionId: "abc", cwd: "/tmp/x" };

function useMock(mock) {
  process.env.CLAUDEPILOT_PORT = String(mock.port);
  writeState("abc", { sessionId: "abc", cwd: "/tmp/x", holderPid: null });
}

test("prompt retourne la réponse streamée à turn-done", async () => {
  const mock = await startMockServer({
    start: [READY],
    prompt: [
      { type: "working" },
      { type: "stream-text", text: "Bonjour" },
      { type: "stream-tool", name: "Bash", summary: "ls" },
      { type: "stream-text", text: "Fini." },
      { type: "turn-done", sessionId: "abc" },
    ],
  });
  useMock(mock);
  try {
    const r = await run(["prompt", "abc", "fais un truc"]);
    assert.equal(r.status, "answer");
    assert.equal(r.text, "Bonjour\n\nFini.");
    assert.deepEqual(r.tools, [{ name: "Bash", summary: "ls" }]);
    assert.deepEqual(mock.received[1], { type: "prompt", text: "fais un truc" });
  } finally {
    await mock.close();
  }
});

test("prompt remonte un dialog en attente", async () => {
  const dialog = {
    type: "dialog",
    question: "Autoriser Bash ?",
    options: [{ n: 1, label: "Oui" }, { n: 2, label: "Non" }],
    multi: false,
  };
  const mock = await startMockServer({ start: [READY], prompt: [{ type: "working" }, dialog] });
  useMock(mock);
  try {
    const r = await run(["prompt", "abc", "fais un truc"]);
    assert.equal(r.status, "dialog");
    assert.equal(r.question, "Autoriser Bash ?");
    assert.equal(r.options.length, 2);
  } finally {
    await mock.close();
  }
});

test("prompt sans fin de tour rend un timeout avec le screen courant", async () => {
  const mock = await startMockServer({
    start: [READY],
    prompt: [{ type: "working" }, { type: "screen", text: "esc to interrupt", working: true }],
  });
  useMock(mock);
  try {
    const r = await run(["prompt", "abc", "long", "--timeout", "1"]);
    assert.equal(r.status, "timeout");
    assert.equal(r.screen, "esc to interrupt");
  } finally {
    await mock.close();
  }
});

test("choose valide une option et attend la suite", async () => {
  const mock = await startMockServer({
    start: [READY],
    choose: [{ type: "working" }, { type: "stream-text", text: "ok" }, { type: "turn-done" }],
  });
  useMock(mock);
  try {
    const r = await run(["choose", "abc", "1"]);
    assert.equal(r.status, "answer");
    assert.deepEqual(mock.received[1], { type: "choose", n: 1 });
  } finally {
    await mock.close();
  }
});

test("dialog interroge via settle et mappe answer → idle", async () => {
  const mock = await startMockServer({ start: [READY], settle: [{ type: "turn-done" }] });
  useMock(mock);
  try {
    const r = await run(["dialog", "abc"]);
    assert.equal(r.status, "idle");
  } finally {
    await mock.close();
  }
});

test("freetext transmet n et le texte", async () => {
  const mock = await startMockServer({ start: [READY], freetext: [{ type: "turn-done" }] });
  useMock(mock);
  try {
    await run(["freetext", "abc", "3", "ma réponse"]);
    assert.deepEqual(mock.received[1], { type: "freetext", n: 3, text: "ma réponse" });
  } finally {
    await mock.close();
  }
});
