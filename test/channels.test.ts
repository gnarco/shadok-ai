import assert from "node:assert/strict";
import test from "node:test";
import { upsertInto, mergeChannels, findTelegramChannel, type Channel } from "../src/channels.js";

test("upsertInto: inserts a new channel when the id is unknown", () => {
  const out = upsertInto([], { sessionId: "a", cwd: "/x" });
  assert.deepEqual(out, [{ cwd: "/x", sessionId: "a" }]);
});

test("upsertInto: merges fields into an existing channel, ignoring undefined", () => {
  const list: Channel[] = [{ sessionId: "a", cwd: "/x", name: "old" }];
  const out = upsertInto(list, { sessionId: "a", telegram: { chatId: 7, threadId: 3 }, name: undefined });
  assert.deepEqual(out[0], { sessionId: "a", cwd: "/x", name: "old", telegram: { chatId: 7, threadId: 3 } });
});

test("upsertInto: does not mutate the input list", () => {
  const list: Channel[] = [{ sessionId: "a", cwd: "/x" }];
  upsertInto(list, { sessionId: "a", name: "new" });
  assert.equal(list[0].name, undefined);
});

test("findTelegramChannel: matches chat + topic exactly", () => {
  const list: Channel[] = [
    { sessionId: "g", cwd: "", telegram: { chatId: -100 } },
    { sessionId: "t", cwd: "", telegram: { chatId: -100, threadId: 40 } },
  ];
  assert.equal(findTelegramChannel(list, -100)?.sessionId, "g");
  assert.equal(findTelegramChannel(list, -100, 40)?.sessionId, "t");
  assert.equal(findTelegramChannel(list, -100, 99), undefined);
});

test("mergeChannels: client drives name/group; server-owned fields preserved", () => {
  const stored: Channel[] = [
    { sessionId: "a", cwd: "/real", branch: "b", telegram: { chatId: 7 }, name: "srv" },
  ];
  const client: Channel[] = [{ sessionId: "a", cwd: "/wrong", name: "renamed", group: 2 }];
  const out = mergeChannels(stored, client, new Set());
  assert.deepEqual(out, [
    { sessionId: "a", cwd: "/real", name: "renamed", group: 2, branch: "b", telegram: { chatId: 7 } },
  ]);
});

test("mergeChannels: a client omission of a Telegram session does NOT drop it", () => {
  const stored: Channel[] = [
    { sessionId: "web", cwd: "/w" },
    { sessionId: "tg", cwd: "/t", telegram: { chatId: 7, threadId: 1 } },
  ];
  // client only knows about the web tab
  const out = mergeChannels(stored, [{ sessionId: "web", cwd: "/w", name: "kept" }], new Set());
  assert.deepEqual(out.map((c) => c.sessionId).sort(), ["tg", "web"]);
});

test("mergeChannels: a live session omitted by the client is kept", () => {
  const stored: Channel[] = [{ sessionId: "live", cwd: "/l" }];
  const out = mergeChannels(stored, [], new Set(["live"]));
  assert.equal(out.length, 1);
  assert.equal(out[0].sessionId, "live");
});

test("mergeChannels: a dead, non-Telegram session the client dropped is removed", () => {
  const stored: Channel[] = [{ sessionId: "gone", cwd: "/g" }];
  const out = mergeChannels(stored, [], new Set());
  assert.deepEqual(out, []);
});
