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

test("deaths per fight weigh the won and the lost fights' deaths by the chance", () => {
  const prior = fitPrior(fights())!;
  // Every lost fight here cost three deaths, one of them the leader's, and a won fight none.
  const { p, deaths, leaderDeaths } = priorOf(prior, 3, 20000);
  expect(deaths).toBeCloseTo(3 * (1 - p), 1);
  expect(leaderDeaths).toBeCloseTo(1 - p, 1);
});

test("no fit without enough fights, or without both wins and losses", () => {
  expect(fitPrior([])).toBeNull();
  expect(fitPrior([{ gap: 0, hp: 1000, kills: 40, fights: 40, deaths: 0, leaderDeaths: 0 }])).toBeNull();
  expect(fitPrior([{ gap: 0, hp: 1000, kills: 2, fights: 4, deaths: 1, leaderDeaths: 0 }])).toBeNull();
});
