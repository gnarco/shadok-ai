import assert from "node:assert/strict";
import test from "node:test";
import { effectiveToken, parseLegacyToken } from "../src/config.js";

test("effectiveToken: an explicit env var always wins", () => {
  assert.equal(effectiveToken({ telegramToken: "cfg" }, { TELEGRAM_BOT_TOKEN: "env" } as any), "env");
});

test("effectiveToken: falls back to config when env is unset", () => {
  assert.equal(effectiveToken({ telegramToken: "cfg" }, {} as any), "cfg");
});

test("effectiveToken: null/undefined config means no token", () => {
  assert.equal(effectiveToken({ telegramToken: null }, {} as any), null);
  assert.equal(effectiveToken({}, {} as any), null);
});

test("parseLegacyToken: extracts TELEGRAM_BOT_TOKEN from an env file", () => {
  assert.equal(parseLegacyToken("TELEGRAM_BOT_TOKEN=123:abc\n"), "123:abc");
  assert.equal(parseLegacyToken('export TELEGRAM_BOT_TOKEN="123:abc"'), "123:abc");
  assert.equal(parseLegacyToken("NOTHING=here"), null);
});
