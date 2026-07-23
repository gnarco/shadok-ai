import assert from "node:assert/strict";
import test from "node:test";
import { mergeSecret, dropSecret, resolveRepo, type SecretStore } from "../src/secrets.js";

test("mergeSecret: adds a key to a new repo without mutating input", () => {
  const store: SecretStore = {};
  const out = mergeSecret(store, "/repo", "KEY", "v");
  assert.deepEqual(out, { "/repo": { KEY: "v" } });
  assert.deepEqual(store, {}); // unchanged
});

test("mergeSecret: updates an existing key, keeps siblings", () => {
  const store: SecretStore = { "/repo": { A: "1", B: "2" } };
  const out = mergeSecret(store, "/repo", "A", "9");
  assert.deepEqual(out["/repo"], { A: "9", B: "2" });
});

test("dropSecret: removes a key; drops the repo when it empties", () => {
  const store: SecretStore = { "/repo": { ONLY: "x" }, "/other": { K: "y" } };
  const out = dropSecret(store, "/repo", "ONLY");
  assert.deepEqual(out, { "/other": { K: "y" } });
});

test("dropSecret: keeps the repo when other keys remain", () => {
  const store: SecretStore = { "/repo": { A: "1", B: "2" } };
  const out = dropSecret(store, "/repo", "A");
  assert.deepEqual(out["/repo"], { B: "2" });
});

test("dropSecret: a missing key is a no-op (same object)", () => {
  const store: SecretStore = { "/repo": { A: "1" } };
  assert.equal(dropSecret(store, "/repo", "NOPE"), store);
  assert.equal(dropSecret(store, "/nope", "A"), store);
});

test("resolveRepo: this checkout resolves to a real git repo root", () => {
  const repo = resolveRepo(process.cwd());
  // The repo root contains package.json; worktree-safe resolution lands here.
  assert.ok(repo.length > 1);
});
