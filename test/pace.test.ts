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

test("paceBlock : une seule fenêtre au-dessus du seuil suffit", () => {
  const v = paceBlock(usage(win(90, 600), win(55, 6 * 86_400)), NOW);
  assert.equal(v.blocked, true);
  assert.match(v.reason ?? "", /^7d /);
});

test("paceBlock : les deux dans les clous ne bloque pas", () => {
  const v = paceBlock(usage(win(90, 600), win(80, 86_400)), NOW);
  assert.equal(v.blocked, false);
  assert.equal(v.reason, null);
});

test("paceBlock : la raison cite la fenêtre au ratio le plus élevé", () => {
  const v = paceBlock(usage(win(15, 17_700), win(55, 6 * 86_400)), NOW);
  assert.equal(v.blocked, true);
  assert.match(v.reason ?? "", /^7d /); // 285% l'emporte sur 225%
});

test("paceBlock : la raison porte les trois chiffres", () => {
  const v = paceBlock(usage(null, win(55, 6 * 86_400)), NOW);
  assert.equal(v.reason, "7d : 55% consommé pour un rythme idéal de 14% (285% du rythme)");
});

test("paceBlock : usage absent ne bloque jamais", () => {
  assert.deepEqual(paceBlock(null, NOW), { blocked: false, reason: null });
});

test("paceBlock : resetsAt absent ne bloque jamais", () => {
  const v = paceBlock(usage(null, { usedPercentage: 99, resetsAt: null }), NOW);
  assert.equal(v.blocked, false);
});
