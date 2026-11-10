// Checks the measured zone rates (tools/lib/rates.mjs). Run with `bun test`. Cells decay between
// samples, so seconds and XP come out a little below their sums.
import { expect, test } from "bun:test";
import { accumulate, estimate } from "../tools/lib/rates.mjs";

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

test("zone rates leave out time another group shares the zone", () => {
  const samples = [at(0, 0), at(1, 100), at(2, 200), at(3, 300)];
  const r = accumulate({}, samples, { zoneOf, alone: (s: { t: number }) => s.t < NOW + 1000 });
  expect(r.kurn[10].s).toBeCloseTo(1, 3);
  expect(r.kurn[10].xp).toBeCloseTo(100, 1);
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
