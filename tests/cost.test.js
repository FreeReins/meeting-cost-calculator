import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MM } from './load-app.js';
const salaries = MM.salaries;
const jokeRoles = MM.jokeRoles;
const { buildCatalog, perPersonRatePerMs, GENERIC_KEY, LOADED_MULTIPLIER } = MM.catalog;
const { projection, totalRate, ratesFor, headcount } = MM.cost;
const S = MM.session;

const MIN = 60_000;
const HOUR = 60 * MIN;
// Flat $104,000/yr per person = $50/hr, which makes the math easy to eyeball.
const flat = () => 50 / HOUR;
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

test('matches the original CostController formula', () => {
  // Old app: hourly = Σ(avg annual / 2080); overall = hours*hourly + minutes*perMinute, times frequency.
  const annual = [148_100, 110_000, 269_000];
  const hourly = annual.reduce((s, a) => s + a / 2080, 0);
  const oldOverall = (1 * hourly + 30 * (hourly / 60)) * 4;

  const ratePerMs = annual.reduce((s, a) => s + a / 2080 / HOUR, 0);
  const p = projection(ratePerMs, 1.5 * HOUR, 4);
  near(p.perHour, hourly);
  near(p.perYear, oldOverall);
});

test('a steady meeting costs rate × time', () => {
  let s = S.createSession({ attendees: { a: 4 } });
  s = S.start(s, 0, flat);
  near(S.cost(s, HOUR), 200);
  assert.equal(S.elapsed(s, HOUR), HOUR);
});

test('headcount changes only affect time after the change', () => {
  let s = S.start(S.createSession({ attendees: { a: 2 } }), 0, flat);
  s = S.update(s, { attendees: { a: 4 } }, 30 * MIN, flat);  // two more join halfway
  near(S.cost(s, HOUR), 2 * 25 + 4 * 25);
  assert.equal(s.peak, 4);
  s = S.update(s, { attendees: { a: 1 } }, HOUR, flat);
  near(S.cost(s, HOUR), 150, 1e-6);                          // dropping people never refunds
  assert.equal(s.peak, 4);
});

test('pauses are free and excluded from elapsed time', () => {
  let s = S.start(S.createSession({ attendees: { a: 1 } }), 0, flat);
  s = S.pause(s, 10 * MIN);
  near(S.cost(s, 50 * MIN), 50 / 6);
  s = S.resume(s, 50 * MIN, flat);
  s = S.end(s, 60 * MIN);
  assert.equal(s.status, 'ended');
  assert.equal(S.elapsed(s, 999 * HOUR), 20 * MIN);
  near(S.cost(s, 999 * HOUR), 50 / 3);
});

test('starting late backdates the meter', () => {
  const s = S.start(S.createSession({ attendees: { a: 1 } }), HOUR, flat, 15 * MIN);
  assert.equal(s.startedAt, 45 * MIN);
  near(S.cost(s, HOUR), 12.5);
});

test('invalid transitions are no-ops', () => {
  const idle = S.createSession({ attendees: { a: 1 } });
  assert.equal(S.pause(idle, 1), idle);
  assert.equal(S.end(idle, 1), idle);
  const running = S.start(idle, 0, flat);
  assert.equal(S.start(running, 5, flat), running);
  assert.equal(S.resume(running, 5, flat), running);
});

test('changes while idle or paused do not open segments', () => {
  let s = S.createSession({ attendees: { a: 1 } });
  s = S.update(s, { attendees: { a: 3 } }, 5, flat);
  assert.equal(s.segments.length, 0);
  s = S.pause(S.start(s, 0, flat), MIN);
  s = S.update(s, { attendees: { a: 10 } }, 2 * MIN, flat);
  assert.equal(s.segments.length, 1);
  s = S.resume(s, 3 * MIN, flat);
  near(S.cost(s, 4 * MIN), 3 * 50 / 60 + 10 * 50 / 60);
});

test('loaded-cost toggle mid-meeting starts a new segment at the new rate', () => {
  const rateOf = (_k, loaded) => (loaded ? 70 : 50) / HOUR;
  let s = S.start(S.createSession({ attendees: { a: 1 } }), 0, rateOf);
  s = S.update(s, { loaded: true }, 30 * MIN, rateOf);
  near(S.cost(s, HOUR), 25 + 35);
});

test('breakdown splits cost per role', () => {
  const rateOf = (k) => (k === 'boss' ? 200 : 50) / HOUR;
  let s = S.start(S.createSession({ attendees: { dev: 3 } }), 0, rateOf);
  s = S.update(s, { attendees: { dev: 3, boss: 1 } }, 30 * MIN, rateOf);
  const rows = S.breakdown(s, HOUR);
  assert.deepEqual(rows.map((r) => r.key), ['dev', 'boss']); // most expensive first
  near(rows[0].cost, 150);
  near(rows[1].cost, 100);
  near(rows.reduce((t, r) => t + r.cost, 0), S.cost(s, HOUR));
});

test('catalog covers every industry with real numbers', () => {
  const c = buildCatalog(salaries, jokeRoles);
  assert.ok(c.industries.length >= 20);
  assert.ok(c.has(GENERIC_KEY));
  for (const r of c.roles.values()) {
    assert.ok(Number.isFinite(r.annual) && r.annual >= 0, r.key);
    if (!r.joke) assert.ok(r.annual >= 20_000 && r.annual <= 1_000_000, `${r.key} = ${r.annual}`);
  }
  const swe = /** @type {any} */ (c.get('all.swe'));
  near(perPersonRatePerMs(swe, false) * HOUR, swe.annual / 2080);
  near(perPersonRatePerMs(swe, true) * HOUR, (swe.annual / 2080) * LOADED_MULTIPLIER);
  const consultant = /** @type {any} */ (c.get('fun.outside-consultant'));
  near(perPersonRatePerMs(consultant, true) * HOUR, 400); // billed rates aren't loaded again
});

test('ratesFor / totalRate / headcount ignore empty seats', () => {
  const a = { x: 2, y: 0, z: 1 };
  const rates = ratesFor(a, () => 1);
  assert.deepEqual(Object.keys(rates), ['x', 'z']);
  assert.equal(totalRate(a, rates), 3);
  assert.equal(headcount(a), 3);
});
