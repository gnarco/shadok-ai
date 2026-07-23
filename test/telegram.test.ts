import assert from "node:assert/strict";
import test from "node:test";
import { bindKey, chunk, parseCommand } from "../src/telegram.js";

test("bindKey: DM, group, and forum topic map to distinct keys", () => {
  assert.equal(bindKey({ id: 42, type: "private" }), "private:42");
  assert.equal(bindKey({ id: -100, type: "supergroup" }), "group:-100");
  assert.equal(bindKey({ id: -100, type: "supergroup" }, 7), "topic:-100:7");
});

test("chunk: short text is one piece", () => {
  assert.deepEqual(chunk("hello", 4000), ["hello"]);
});

test("chunk: long text splits under the limit, preferring newlines", () => {
  const line = "x".repeat(30);
  const text = Array.from({ length: 200 }, () => line).join("\n"); // ~6000 chars
  const parts = chunk(text, 4000);
  assert.ok(parts.length >= 2);
  assert.ok(parts.every((p) => p.length <= 4000));
  assert.equal(parts.join("\n"), text); // lossless reassembly
});

test("chunk: a single very long line is hard-cut", () => {
  const parts = chunk("y".repeat(9000), 4000);
  assert.equal(parts.length, 3);
  assert.ok(parts.every((p) => p.length <= 4000));
  assert.equal(parts.join(""), "y".repeat(9000));
});

test("parseCommand: recognizes commands, args, and @botname suffix", () => {
  assert.deepEqual(parseCommand("/new"), { cmd: "new", arg: "" });
  assert.deepEqual(parseCommand("/spawn my agent"), { cmd: "spawn", arg: "my agent" });
  assert.deepEqual(parseCommand("/list@claudepilot_bot"), { cmd: "list", arg: "" });
});

test("parseCommand: plain text is not a command", () => {
  assert.equal(parseCommand("hello there"), null);
  assert.equal(parseCommand("what is /usr/bin?"), null);
});
