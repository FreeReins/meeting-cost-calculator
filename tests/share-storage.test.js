import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MM } from './load-app.js';
const { encodeConfig, decodeConfig } = MM.share;
const { createStore } = MM.storage;
const { tierFor, nextTier, TIERS } = MM.tiers;
const { equivalents } = MM.equivalents;
const { earned } = MM.badges;

const memory = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m };
};
const entry = (id, cost, extra = {}) => ({
  id, title: id, startedAt: new Date(2026, 0, 1).toISOString(), durationMs: 30 * 60e3, cost, peak: 5,
  industry: 'Every Industry', loaded: false, ...extra,
});

test('share links round-trip', () => {
  const cfg = { industry: 'tech', attendees: { 'tech.swe': 3, 'all.pm': 1, 'all.generic': 0 }, title: 'Sprint Planning & Snacks', loaded: true };
  const back = decodeConfig('#' + encodeConfig(cfg));
  assert.deepEqual(back, { industry: 'tech', attendees: { 'tech.swe': 3, 'all.pm': 1 }, title: 'Sprint Planning & Snacks', loaded: true });
});

test('share links reject junk and unknown roles', () => {
  assert.equal(decodeConfig(''), null);
  assert.equal(decodeConfig('#hello'), null);
  const d = decodeConfig('#r=tech.swe*5,<script>*2,fun.dog*99999,all.ceo*-3,x.y*2', (k) => k !== 'x.y');
  assert.deepEqual(d?.attendees, { 'tech.swe': 5, 'fun.dog': 999 });
  assert.equal(decodeConfig('#i=../../etc&r=a.b*1')?.industry, undefined);
});

test('storage persists, renames, removes, and caps history', () => {
  const be = memory();
  const s = createStore(be);
  assert.equal(s.available, true);
  s.addEntry(entry('a', 10));
  s.addEntry(entry('b', 20));
  s.addEntry(entry('a', 15)); // same id replaces
  assert.deepEqual(s.history().map((e) => [e.id, e.cost]), [['b', 20], ['a', 15]]);
  s.rename('b', 'Renamed');
  assert.equal(s.history()[0].title, 'Renamed');
  s.removeEntry('b');
  assert.equal(s.history().length, 1);
  for (let i = 0; i < 250; i++) s.addEntry(entry('x' + i, i));
  assert.equal(s.history().length, 200);
});

test('storage survives corrupt data, wrong versions, and no backend', () => {
  const be = memory();
  be.setItem('meeting-meter:history', '{not json');
  be.setItem('meeting-meter:prefs', JSON.stringify({ v: 999, data: { sound: true } }));
  const s = createStore(be);
  assert.deepEqual(s.history(), []);
  assert.deepEqual(s.prefs(), {});
  be.setItem('meeting-meter:history', JSON.stringify({ v: 1, data: [entry('ok', 1), { id: 'bad' }, null] }));
  assert.deepEqual(s.history().map((e) => e.id), ['ok']);

  const none = createStore(null);
  assert.equal(none.available, false);
  assert.equal(none.setPrefs({ a: 1 }), false);
  assert.deepEqual(none.history(), []);

  const throwing = createStore({ getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() {} });
  assert.equal(throwing.available, false);
});

test('export/import merges without duplicates', () => {
  const a = createStore(memory());
  a.addEntry(entry('one', 1));
  a.addEntry(entry('two', 2));
  const b = createStore(memory());
  b.addEntry(entry('two', 2));
  assert.equal(b.importJSON(a.exportJSON()), 1);
  assert.equal(b.history().length, 2);
  assert.throws(() => b.importJSON('nope'));
});

test('tiers escalate in order and cover the old meme thresholds', () => {
  for (let i = 1; i < TIERS.length; i++) assert.ok(TIERS[i].min > TIERS[i - 1].min);
  assert.equal(tierFor(0).level, 0);
  assert.equal(tierFor(50_000).name, 'The 50K Club');
  assert.equal(nextTier(9.99)?.min, 10);
  assert.equal(nextTier(1e9), null);
});

test('equivalents always say something', () => {
  for (const c of [0, 0.004, 0.5, 7, 42, 999, 12_345, 2e6, 1e9]) {
    const list = equivalents(c);
    assert.ok(list.length >= 1 && list.every((t) => typeof t === 'string' && t.length > 3), String(c));
  }
  assert.match(equivalents(36)[0], /burrito|pizza|ticket|streaming|latte/);
});

test('badges unlock from history', () => {
  assert.deepEqual(earned([]).map((b) => b.id), []);
  const ids = earned([entry('a', 60_000, { durationMs: 3 * 3600e3 })]).map((b) => b.id);
  for (const id of ['first', 'k1', 'k10', 'k50', 'marathon']) assert.ok(ids.includes(id), id);
});
