// Checks the measured zone rates (tools/lib/rates.mjs). Run with `bun test`. Cells decay between
// samples, so seconds and XP come out a little below their sums.
import { expect, test } from "bun:test";
import { accumulate, crowdShare, estimate } from "../tools/lib/rates.mjs";

const NOW = 1_800_000_000_000;
const DAY = 24 * 3600000;
const zoneOf = (id: number) => (id === 1 ? "kurn" : null);
const at = (k: number, xp: number, extra = {}) => ({ ses: 7, t: NOW + k * 1000, act: "fight", lvl: 10, xp, zone: 1, ...extra });

test("zone rates count play outside tasks and errands, and leave out gaps and level changes", () => {
  const samples = [
    at(0, 1000),
    at(1, 1100),
    at(2, 1200, { busy: "errand" }),
    at(3, 1300),
    at(4, 1400, { act: "task" }),
    at(5, 1500),
    at(6, 1600),
    at(26, 1700),
    at(27, 1800, { lvl: 11 }),
    at(28, 1900, { lvl: 11 }),
  ];
  const r = accumulate({}, samples, { zoneOf });
  expect(r.kurn[10].s).toBeCloseTo(2, 3);
  expect(r.kurn[10].xp).toBeCloseTo(200, 1);
  expect(r.kurn[11].s).toBeCloseTo(1, 3);
  expect(r.kurn[11].xp).toBeCloseTo(100, 1);
});

test("time another group shares the zone counts at the share of the zone it gets, so it measures the rate alone", () => {
  // One second alone at 100 XP, then two seconds with two others at 50 XP each, where the model
  // gives a group half the zone's rate alone: the rate alone is 100 XP a second throughout.
  const samples = [at(0, 0), at(1, 100), at(2, 150), at(3, 200)];
  const r = accumulate({}, samples, { zoneOf, others: (s: { t: number }) => (s.t < NOW + 1000 ? 0 : 2), factor: (zone: string, level: number, n: number) => (zone === "kurn" && level === 10 && n === 2 ? 0.5 : 1) });
  expect(r.kurn[10].s).toBeCloseTo(2, 3);
  expect(r.kurn[10].xp).toBeCloseTo(200, 1);
});

test("a switch to another character of the same level in the zone is not XP earned there", () => {
  const samples = [at(0, 40_000_000, { cid: 1 }), at(1, 40_000_100, { cid: 1 }), at(2, 18_000_000, { cid: 2 }), at(3, 18_000_100, { cid: 2 })];
  const r = accumulate({}, samples, { zoneOf });
  expect(r.kurn[10].s).toBeCloseTo(2, 3);
  expect(r.kurn[10].xp).toBeCloseTo(200, 1);
});

test("an estimate weighs nearer levels more and older time less", () => {
  const rates = { kurn: { 10: { s: 3600, xp: 1e6, t: NOW }, 12: { s: 3600, xp: 4e6, t: NOW } } };
  // Level 12 counts a third: (1M + 4M/3) over (1 h + 1/3 h).
  expect(estimate(rates, "kurn", 10, NOW)!.xph).toBeCloseTo(1.75e6, -2);
  expect(estimate(rates, "kurn", 10, NOW)!.hours).toBeCloseTo(2, 6);
  const old = { kurn: { 10: { s: 3600, xp: 1e6, t: NOW - DAY } } };
  expect(estimate(old, "kurn", 10, NOW)).toMatchObject({ hours: 0.5 });
  expect(estimate(old, "kurn", 10, NOW)!.xph).toBeCloseTo(1e6, -2);
  expect(estimate(rates, "kurn", 15, NOW)).toBeNull();
});

test("samples older than their cell add at their weight instead of growing the cell", () => {
  const rates = { kurn: { 10: { s: 3600, xp: 1e6, t: NOW } } };
  const dayOld = [at(0, 0), at(1, 100)].map((s) => ({ ...s, t: s.t - DAY }));
  accumulate(rates, dayOld, { zoneOf });
  expect(rates.kurn[10].s).toBeCloseTo(3600.5, 3);
  expect(rates.kurn[10].xp).toBeCloseTo(1e6 + 50, 1);
  expect(rates.kurn[10].t).toBe(NOW);
});

test("the crowd share is the time a group hunts beside others over the same with the fewest others", () => {
  // A quarter hour at each count: alone the group waits for a target 4% of the time, beside two
  // others 10%, beside three 40% and beside four 20%, which reads better than three.
  const SEC = 990;
  const run = (from: number, lvl: number, crowdedSec: number) => Array.from({ length: SEC + 1 }, (_, k) => at(from + k, 100 * k, { lvl, ses: from, ...(k < crowdedSec ? { act: "idle", why: "crowded" } : {}) }));
  const crowding = {};
  const others = (s: { t: number }) => [0, 2, 3, 4][Math.floor((s.t - NOW) / 1000000)];
  const waits = [0.04, 0.1, 0.4, 0.2];
  waits.forEach((w, k) => accumulate({}, run(k * 1000, 10 + (k % 2), Math.round(w * SEC)), { zoneOf, others, crowding }));
  const now = NOW + 4000000;
  expect(crowdShare(crowding, "kurn", 11, 0, now)!.share).toBe(1);
  expect(crowdShare(crowding, "kurn", 11, 2, now)!.share).toBeCloseTo(0.9 / 0.96, 2);
  // Three and four pool, each by its time at the nearer level: a larger count never reads better than a smaller one.
  const pooled = (0.6 * (2 / 3) + 0.8) / (2 / 3 + 1) / 0.96;
  expect(crowdShare(crowding, "kurn", 11, 3, now)!.share).toBeCloseTo(pooled, 2);
  expect(crowdShare(crowding, "kurn", 11, 4, now)!.share).toBeCloseTo(pooled, 2);
  // No time beside one other: the share of the nearest smaller count, alone. Beside six: that of four.
  expect(crowdShare(crowding, "kurn", 11, 1, now)!.share).toBe(1);
  expect(crowdShare(crowding, "kurn", 11, 6, now)!.share).toBeCloseTo(pooled, 2);
  // A zone without ten minutes at any count has no measurement.
  expect(crowdShare(crowding, "guktop", 11, 2, now)).toBeNull();
  expect(crowdShare({ kurn: { 11: { 2: { s: 300, xp: 1, t: now, c: 100 } } } }, "kurn", 11, 2, now)).toBeNull();
});
