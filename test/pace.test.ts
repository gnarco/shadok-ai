import assert from "node:assert/strict";
import test from "node:test";
import { computePace, paceBlock, WINDOW_SEC } from "../src/pace.js";
import type { Usage, Window } from "../src/usage.js";

/** Horloge figée : les tests ne doivent jamais dépendre de l'heure réelle. */
const NOW = 1_700_000_000_000;

/** Fenêtre dont le reset tombe dans `remainingSec` secondes. */
const win = (usedPercentage: number, remainingSec: number): Window => ({
  usedPercentage,
  resetsAt: NOW / 1000 + remainingSec,
});

const usage = (fiveHour: Window | null, sevenDay: Window | null): Usage => ({
  fiveHour,
  sevenDay,
  fetchedAt: NOW,
});

const round = (n: number | null) => (n === null ? null : Math.round(n));

test("5h : 90% consommé avec 10 min restantes suit le rythme", () => {
  const p = computePace(win(90, 600), WINDOW_SEC.fiveHour, NOW);
  assert.equal(round(p.idealPacePct), 97);
  assert.equal(round(p.ratioPct), 89);
});

test("5h : 3% consommé 5 min après le reset ne déclenche pas l'epsilon", () => {
  const p = computePace(win(3, 17_700), WINDOW_SEC.fiveHour, NOW);
  assert.equal(round(p.idealPacePct), 2);
  assert.equal(round(p.ratioPct), 45);
});

test("5h : 15% consommé 5 min après le reset dépasse le seuil", () => {
  const p = computePace(win(15, 17_700), WINDOW_SEC.fiveHour, NOW);
  assert.equal(round(p.ratioPct), 225);
});

test("7d : 55% consommé avec 6 jours restants dépasse largement", () => {
  const p = computePace(win(55, 6 * 86_400), WINDOW_SEC.sevenDay, NOW);
  assert.equal(round(p.idealPacePct), 14);
  assert.equal(round(p.ratioPct), 285);
});

test("7d : 80% consommé avec 1 jour restant suit le rythme", () => {
  const p = computePace(win(80, 86_400), WINDOW_SEC.sevenDay, NOW);
  assert.equal(round(p.idealPacePct), 86);
  assert.equal(round(p.ratioPct), 88);
});

test("resetsAt absent : pas de rythme calculable", () => {
  const p = computePace({ usedPercentage: 99, resetsAt: null }, WINDOW_SEC.fiveHour, NOW);
  assert.equal(p.idealPacePct, null);
  assert.equal(p.ratioPct, null);
});

test("fenêtre expirée : le rythme idéal est borné à 100%", () => {
  const p = computePace(win(50, -3_600), WINDOW_SEC.fiveHour, NOW);
  assert.equal(p.idealPacePct, 100);
  assert.equal(round(p.ratioPct), 48);
});

// Borne basse : un resetsAt plus lointain que la durée de la fenêtre elle-même
// (dérive d'horloge, ou un reset annoncé à +6h sur une fenêtre de 5h) donne un
// temps écoulé négatif. Sans le clamp, idealPacePct serait négatif et le
// dénominateur (idealPacePct + 5) pourrait s'annuler ou changer de signe.
// remaining = 21 600 s > 18 000 s ⇒ (18000 − 21600)/18000 × 100 = −20 → 0.
// ratio = 50 / (0 + 5) × 100 = 1000.
test("resetsAt au-delà de la durée de la fenêtre : le rythme idéal est borné à 0%", () => {
  const p = computePace(win(50, WINDOW_SEC.fiveHour + 3_600), WINDOW_SEC.fiveHour, NOW);
  assert.equal(p.idealPacePct, 0);
  assert.equal(p.ratioPct, 1000);
});

// Frontière exacte du seuil unique (BLOCK_RATIO = 100), posée par arithmétique
// et non par arrondi, pour qu'une régression `<` ↔ `<=` fasse tomber le test.
//
//   remaining = 9 000 s sur une fenêtre de 18 000 s
//   idealPacePct = (18000 − 9000) / 18000 × 100 = 50          (exact en binaire)
//   ratioPct     = used / (50 + 5) × 100
//   ratio = 100  ⟺  used = 55                                  (55/55 = 1, exact)
//
// 55 % ⇒ ratio exactement 100 : la comparaison est `ratioPct <= 100 → continue`,
// donc pile sur la limite ne bloque pas. 56 % ⇒ ratio ≈ 101,8 : bloque.
test("computePace : 55% à mi-fenêtre donne un ratio de 100 pile", () => {
  const p = computePace(win(55, WINDOW_SEC.fiveHour / 2), WINDOW_SEC.fiveHour, NOW);
  assert.equal(p.idealPacePct, 50);
  assert.equal(p.ratioPct, 100); // égalité stricte, pas d'arrondi
});

test("paceBlock : un ratio de 100 pile ne bloque pas", () => {
  const v = paceBlock(usage(win(55, WINDOW_SEC.fiveHour / 2), null), NOW);
  assert.equal(v.blocked, false);
  assert.equal(v.reason, null);
});

test("paceBlock : juste au-dessus de 100 bloque", () => {
  const w = win(56, WINDOW_SEC.fiveHour / 2);
  assert.ok(computePace(w, WINDOW_SEC.fiveHour, NOW).ratioPct! > 100);
  const v = paceBlock(usage(w, null), NOW);
  assert.equal(v.blocked, true);
  assert.match(v.reason ?? "", /^5h:/);
});

test("paceBlock : une seule fenêtre au-dessus du seuil suffit", () => {
  const v = paceBlock(usage(win(90, 600), win(55, 6 * 86_400)), NOW);
  assert.equal(v.blocked, true);
  assert.match(v.reason ?? "", /^7d:/);
});

test("paceBlock : les deux dans les clous ne bloque pas", () => {
  const v = paceBlock(usage(win(90, 600), win(80, 86_400)), NOW);
  assert.equal(v.blocked, false);
  assert.equal(v.reason, null);
});

test("paceBlock : la raison cite la fenêtre au ratio le plus élevé", () => {
  const v = paceBlock(usage(win(15, 17_700), win(55, 6 * 86_400)), NOW);
  assert.equal(v.blocked, true);
  assert.match(v.reason ?? "", /^7d:/); // 285% l'emporte sur 225%
});

test("paceBlock : la raison porte les trois chiffres", () => {
  const v = paceBlock(usage(null, win(55, 6 * 86_400)), NOW);
  assert.equal(v.reason, "7d: 55% used vs 14% ideal pace (285% of pace)");
});

test("paceBlock : usage absent ne bloque jamais", () => {
  assert.deepEqual(paceBlock(null, NOW), { blocked: false, reason: null });
});

test("paceBlock : resetsAt absent ne bloque jamais", () => {
  const v = paceBlock(usage(null, { usedPercentage: 99, resetsAt: null }), NOW);
  assert.equal(v.blocked, false);
});
