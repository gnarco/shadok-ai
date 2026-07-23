import assert from "node:assert/strict";
import test from "node:test";
import {
  bindKey,
  chunk,
  parseCommand,
  dialogKeyboard,
  parseCallback,
  makeTyping,
  mdToTelegramHtml,
  attachmentOf,
  mediaFileName,
} from "../src/telegram.js";

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
  assert.deepEqual(parseCommand("/list@shadokai_bot"), { cmd: "list", arg: "" });
});

test("parseCommand: plain text is not a command", () => {
  assert.equal(parseCommand("hello there"), null);
  assert.equal(parseCommand("what is /usr/bin?"), null);
});

test("dialogKeyboard: single-select → one 'choose' button per option, no submit", () => {
  const kb = dialogKeyboard({
    question: "Q?",
    multi: false,
    options: [
      { n: 1, label: "Alpha" },
      { n: 2, label: "Beta" },
    ],
  });
  assert.equal(kb.inline_keyboard.length, 2);
  assert.deepEqual(kb.inline_keyboard[0][0], { text: "1. Alpha", callback_data: "d:1" });
  assert.deepEqual(kb.inline_keyboard[1][0], { text: "2. Beta", callback_data: "d:2" });
});

test("dialogKeyboard: multi-select → toggle buttons with ☑/☐ + a Submit row", () => {
  const kb = dialogKeyboard({
    question: "Q?",
    multi: true,
    options: [
      { n: 1, label: "A", checked: true },
      { n: 2, label: "B", checked: false },
    ],
  });
  assert.match(kb.inline_keyboard[0][0].text, /^☑ 1\. A/);
  assert.equal(kb.inline_keyboard[0][0].callback_data, "t:1");
  assert.match(kb.inline_keyboard[1][0].text, /^☐ 2\. B/);
  const last = kb.inline_keyboard[kb.inline_keyboard.length - 1][0];
  assert.deepEqual(last, { text: "✅ Submit", callback_data: "s" });
});

test("makeTyping: start beats immediately, then on every interval", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let beats = 0;
  const typing = makeTyping(() => beats++, 4000);
  typing.start();
  assert.equal(beats, 1); // immediate first beat — no 4s wait for the indicator
  t.mock.timers.tick(4000);
  assert.equal(beats, 2);
  t.mock.timers.tick(8000);
  assert.equal(beats, 4);
  typing.stop();
});

test("makeTyping: start while already beating does not double the pulse", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let beats = 0;
  const typing = makeTyping(() => beats++, 4000);
  typing.start();
  typing.start(); // e.g. two "working" events in a row
  assert.equal(beats, 1);
  t.mock.timers.tick(4000);
  assert.equal(beats, 2);
  typing.stop();
});

test("makeTyping: stop halts the pulse and is idempotent; restart works", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let beats = 0;
  const typing = makeTyping(() => beats++, 4000);
  typing.start();
  typing.stop();
  typing.stop(); // turn-done then exited must not throw
  t.mock.timers.tick(20000);
  assert.equal(beats, 1); // only the immediate beat, nothing after stop
  typing.start(); // next turn
  assert.equal(beats, 2);
  typing.stop();
});

test("parseCallback: choose / toggle / confirm, and garbage → null", () => {
  assert.deepEqual(parseCallback("d:3"), { kind: "choose", n: 3 });
  assert.deepEqual(parseCallback("t:2"), { kind: "toggle", n: 2 });
  assert.deepEqual(parseCallback("s"), { kind: "confirm" });
  assert.equal(parseCallback("x:1"), null);
  assert.equal(parseCallback(""), null);
});

test("mdToTelegramHtml: bold/italic/inline code, digits untouched", () => {
  assert.equal(
    mdToTelegramHtml("**b** and *i* and `c` and 3 files"),
    "<b>b</b> and <i>i</i> and <code>c</code> and 3 files",
  );
});

test("mdToTelegramHtml: heading → bold, bullets → •, links", () => {
  assert.equal(
    mdToTelegramHtml("# Title\n- a\n- b\n[t](https://x.com)"),
    '<b>Title</b>\n• a\n• b\n<a href="https://x.com">t</a>',
  );
});

test("mdToTelegramHtml: code fence content is escaped, not reformatted", () => {
  assert.equal(
    mdToTelegramHtml("```js\nconst x = 1 < 2 && *y*;\n```"),
    "<pre>const x = 1 &lt; 2 &amp;&amp; *y*;</pre>",
  );
});

test("mdToTelegramHtml: bare <>& are escaped so the HTML is well-formed", () => {
  assert.equal(mdToTelegramHtml("a <b> & c"), "a &lt;b&gt; &amp; c");
});

test("mdToTelegramHtml: a lone marker stays literal (no unbalanced tag)", () => {
  assert.equal(mdToTelegramHtml("2 * 3 = 6"), "2 * 3 = 6");
});

test("attachmentOf: photo → la plus grande taille, kind image", () => {
  const att = attachmentOf({
    photo: [
      { file_id: "small", file_unique_id: "u1", file_size: 100 },
      { file_id: "big", file_unique_id: "u2", file_size: 5000 },
    ],
  });
  assert.deepEqual(att, { fileId: "big", fileUniqueId: "u2", kind: "image", fileSize: 5000 });
});

test("attachmentOf: document image/* → kind image, garde le nom", () => {
  const att = attachmentOf({
    document: { file_id: "f", file_unique_id: "u", file_name: "shot.png", mime_type: "image/png", file_size: 42 },
  });
  assert.deepEqual(att, { fileId: "f", fileUniqueId: "u", kind: "image", fileName: "shot.png", fileSize: 42 });
});

test("attachmentOf: document quelconque → kind file", () => {
  const att = attachmentOf({
    document: { file_id: "f", file_unique_id: "u", file_name: "rapport.pdf", mime_type: "application/pdf" },
  });
  assert.equal(att?.kind, "file");
  assert.equal(att?.fileName, "rapport.pdf");
});

test("attachmentOf: message texte pur → null", () => {
  assert.equal(attachmentOf({ text: "hello" }), null);
});

test("mediaFileName: nom original préfixé par l'id unique, nettoyé", () => {
  assert.equal(
    mediaFileName({ fileId: "f", fileUniqueId: "AQAD", kind: "file", fileName: "../é vil/rapport final.pdf" }),
    "AQAD-rapport final.pdf",
  );
});

test("mediaFileName: photo sans nom → .jpg ; fichier sans nom → id nu", () => {
  assert.equal(mediaFileName({ fileId: "f", fileUniqueId: "AQAD", kind: "image" }), "AQAD.jpg");
  assert.equal(mediaFileName({ fileId: "f", fileUniqueId: "AQAD", kind: "file" }), "AQAD");
});
