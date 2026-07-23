import assert from "node:assert/strict";
import test from "node:test";
import { effectiveToken, parseLegacyToken } from "../src/config.js";

test("effectiveToken: an explicit env var always wins", () => {
  assert.equal(
    effectiveToken({ tokens: { "/x": "cfg" } }, "/x", { TELEGRAM_BOT_TOKEN: "env" } as any),
    "env",
  );
});

test("effectiveToken: falls back to this dir's configured token", () => {
  assert.equal(effectiveToken({ tokens: { "/x": "cfg" } }, "/x", {} as any), "cfg");
});

test("effectiveToken: is per directory — another dir's token doesn't leak", () => {
  assert.equal(effectiveToken({ tokens: { "/x": "cfg" } }, "/other", {} as any), null);
});

test("effectiveToken: null/undefined means no token", () => {
  assert.equal(effectiveToken({ tokens: { "/x": null } }, "/x", {} as any), null);
  assert.equal(effectiveToken({}, "/x", {} as any), null);
});

test("parseLegacyToken: extracts TELEGRAM_BOT_TOKEN from an env file", () => {
  assert.equal(parseLegacyToken("TELEGRAM_BOT_TOKEN=123:abc\n"), "123:abc");
  assert.equal(parseLegacyToken('export TELEGRAM_BOT_TOKEN="123:abc"'), "123:abc");
  assert.equal(parseLegacyToken("NOTHING=here"), null);
});
