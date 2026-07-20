/**
 * Detection of the "Claude is working" state from the rendered TUI screen.
 *
 * Kept free of any dependency so it can be unit-tested directly
 * (debug/detect.test.mjs) against captured screen fixtures.
 */

/** Marker displayed by older Claude Code TUIs while working. */
const ESC_TO_INTERRUPT = /esc to interrupt/i;

/**
 * Newer TUIs drop the "esc to interrupt" hint; the live spinner line is then
 * the only working signal: a glyph at column 0 followed by a status and an
 * "(<elapsed> · …)" group with the elapsed FIRST, e.g.
 *   ✽ Jitterbugging… (4m 26s · ↓ 7.1k tokens · …)
 * A finished turn renders past tense without parens ("✻ Baked for 8m 20s"),
 * and completion lines put the elapsed LAST ("(… · 5m 40s)"): no match.
 */
const SPINNER_STATUS =
  /^[^\s\w].{0,80}?\(\s*(?:\d+h\s*)?(?:\d+m\s*)?\d+s\s*·/m;

/** True when the screen indicates that Claude is currently working. */
export function screenShowsWork(screen: string): boolean {
  return ESC_TO_INTERRUPT.test(screen) || SPINNER_STATUS.test(screen);
}
