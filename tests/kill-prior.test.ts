// Checks the kill chance prior (tools/lib/kill-prior.mjs). Run with `bun test`.
import { expect, test } from "bun:test";
import { fitPrior, priorOf } from "../tools/lib/kill-prior.mjs";

const logistic = (z: number) => 1 / (1 + Math.exp(-z));
// Forty fights a pair from a known model: the chance falls by levels above the leader and by hit points.
const truth = (gap: number, hp: number) => logistic(3 - 0.8 * gap - 1.5 * (Math.log10(hp) - 4));
const fights = () => {
  const obs = [];
  for (const gap of [-6, -3, 0, 3, 6, 9]) {
    for (const hp of [5000, 20000, 80000]) {
      const p = truth(gap, hp);
      obs.push({ gap, hp, kills: Math.round(40 * p), fights: 40, deaths: 3 * (1 - p), leaderDeaths: 1 - p });
    }
  }
  return obs;
};

test("the fitted chance falls with the enemy's level above the leader and with its hit points", () => {
  const prior = fitPrior(fights())!;
  expect(priorOf(prior, 0, 20000).p).toBeCloseTo(truth(0, 20000), 1);
  expect(priorOf(prior, 6, 20000).p).toBeCloseTo(truth(6, 20000), 1);
  expect(priorOf(prior, 6, 20000).p).toBeLessThan(priorOf(prior, 0, 20000).p);
  expect(priorOf(prior, 0, 80000).p).toBeLessThan(priorOf(prior, 0, 5000).p);
  // An enemy whose hit points are not known counts with the fights' mean, here 20,000.
  expect(priorOf(prior, 3, undefined).p).toBeCloseTo(priorOf(prior, 3, 20000).p, 2);
});

test("deaths per fight follow the enemy's level and hit points, so an easy enemy costs few", () => {
  // Deaths a fight at a known log-linear rate, and the leader's death in a fight at a logistic one.
  const rate = (gap: number, hp: number) => Math.exp(-1 + 0.35 * gap + 0.6 * (Math.log10(hp) - 4));
  const leader = (gap: number) => logistic(-2 + 0.5 * gap);
  const prior = fitPrior(fights().map((o) => ({ ...o, deaths: rate(o.gap, o.hp), leaderDeaths: leader(o.gap) })))!;
  for (const [gap, hp] of [[-6, 5000], [0, 20000], [6, 80000]]) {
    expect(priorOf(prior, gap, hp).deaths / rate(gap, hp)).toBeCloseTo(1, 1);
    expect(priorOf(prior, gap, hp).leaderDeaths).toBeCloseTo(leader(gap), 1);
  }
  expect(priorOf(prior, -3, 10000).deaths).toBeLessThan(priorOf(prior, 3, 10000).deaths / 5);
});

test("a won fight's seconds follow the enemy's hit points and level, and a fit without fight times has none", () => {
  // Seconds at a known power of the hit points, a little longer for a stronger enemy.
  const secs = (gap: number, hp: number) => 30 * (hp / 10000) ** 0.85 * Math.exp(0.05 * gap);
  const prior = fitPrior(fights().map((o) => ({ ...o, sec: secs(o.gap, o.hp) })))!;
  for (const [gap, hp] of [[-3, 5000], [0, 20000], [6, 80000]]) expect(priorOf(prior, gap, hp).sec! / secs(gap, hp)).toBeCloseTo(1, 1);
  expect(priorOf(fitPrior(fights())!, 0, 20000).sec).toBeNull();
});

test("no fit without enough fights, or without both wins and losses", () => {
  expect(fitPrior([])).toBeNull();
  expect(fitPrior([{ gap: 0, hp: 1000, kills: 40, fights: 40, deaths: 0, leaderDeaths: 0 }])).toBeNull();
  expect(fitPrior([{ gap: 0, hp: 1000, kills: 2, fights: 4, deaths: 1, leaderDeaths: 0 }])).toBeNull();
});
