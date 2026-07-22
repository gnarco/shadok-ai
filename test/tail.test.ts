import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseLine, parseUsage, resultText, scanUsage } from "../src/tail.js";

test("parseLine: assistant text block → one text event", () => {
  const ev = parseLine(
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hello" }] } }),
  );
  assert.deepEqual(ev, [{ kind: "text", text: "hello" }]);
});

test("parseLine: tool_use → tool event with id/name/summary", () => {
  const ev = parseLine(
    JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls -la" } }],
      },
    }),
  );
  assert.deepEqual(ev, [{ kind: "tool", id: "toolu_1", name: "Bash", summary: "ls -la" }]);
});

test("parseLine: thinking blocks and empty text are skipped", () => {
  assert.deepEqual(
    parseLine(
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "thinking", thinking: "hmm" },
            { type: "text", text: "   " },
          ],
        },
      }),
    ),
    [],
  );
});

test("parseLine: usage is emitted before content, keyed by message id", () => {
  const ev = parseLine(
    JSON.stringify({
      type: "assistant",
      message: {
        id: "msg_9",
        usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 5 },
        content: [{ type: "text", text: "hi" }],
      },
    }),
  );
  assert.equal(ev[0].kind, "usage");
  assert.deepEqual((ev[0] as any).usage, { input: 10, output: 20, cacheCreation: 0, cacheRead: 5 });
  assert.equal((ev[0] as any).messageId, "msg_9");
  assert.equal(ev[1].kind, "text");
});

test("parseLine: user tool_result → result event (string and block-array content)", () => {
  const asString = parseLine(
    JSON.stringify({
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "output here", is_error: false }],
      },
    }),
  );
  assert.deepEqual(asString, [
    { kind: "result", toolUseId: "toolu_1", text: "output here", isError: false },
  ]);

  const asBlocks = parseLine(
    JSON.stringify({
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "t2", content: [{ type: "text", text: "line" }], is_error: true },
        ],
      },
    }),
  );
  assert.equal((asBlocks[0] as any).isError, true);
  assert.equal((asBlocks[0] as any).text, "line");
});

test("parseLine: meta rows, non-message rows and malformed JSON yield nothing", () => {
  assert.deepEqual(parseLine(JSON.stringify({ isMeta: true, message: { content: [] } })), []);
  assert.deepEqual(parseLine(JSON.stringify({ type: "system" })), []);
  assert.deepEqual(parseLine("{ not json"), []);
  assert.deepEqual(parseLine("   "), []);
});

test("parseUsage: absent/invalid usage → null", () => {
  assert.equal(parseUsage({}), null);
  assert.equal(parseUsage({ usage: "x" }), null);
});

test("resultText: long output is truncated with a marker", () => {
  const big = "x".repeat(5000);
  const out = resultText(big);
  assert.ok(out.length < 5000);
  assert.match(out, /truncated/);
});

test("scanUsage: last record per message id wins (streaming writes growing counts)", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cp-tail-"));
  const file = path.join(tmp, "t.jsonl");
  fs.writeFileSync(
    file,
    [
      JSON.stringify({ type: "assistant", message: { id: "m1", usage: { input_tokens: 1, output_tokens: 1 } } }),
      JSON.stringify({ type: "assistant", message: { id: "m1", usage: { input_tokens: 1, output_tokens: 9 } } }),
      JSON.stringify({ type: "assistant", message: { id: "m2", usage: { input_tokens: 4, output_tokens: 4 } } }),
    ].join("\n"),
  );
  const map = scanUsage(file);
  assert.equal(map.get("m1")!.output, 9); // last record
  assert.equal(map.get("m2")!.input, 4);
  fs.rmSync(tmp, { recursive: true, force: true });
});
