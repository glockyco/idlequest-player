// Checks the XP event detection (tools/lib/xp-events.mjs). Run with `bun test`.
import { expect, test } from "bun:test";
import { factorAt, foldKills, killFactor, killFactors, killPools, normalXp } from "../tools/lib/xp-events.mjs";

// The Tower of Frozen Shadow's multiplier in the client, and kills recorded there on 2026-11-11.
const FROZEN = 1.62666667;
const line = (t: number, text: string) => ({ t, type: "EXPERIENCE_GAIN", text });

test("a kill's XP lines sum to its pool, and other lines and later shares stay out", () => {
  const events = [
    line(1000, "You have defeated a shrouded bat and gained 79553 experience!"),
    { t: 1000, type: "FACTION_CHANGE", text: "Your faction standing with Tserrina Syl`Tor could not possibly get any worse." },
    ...["Domeyafun", "Ewbanaqoa", "Ugfeu", "Edroun"].map((n) => line(1200, `${n} gains 78080 experience.`)),
    line(1300, "Qigaa gains 76607 experience."),
    line(9000, "Qigaa gains 500 experience."),
    line(20000, "You have slain a rat, but gain no experience."),
  ];
  expect(killPools(events)).toEqual([{ t: 1000, pool: 468480, lines: 6 }]);
});

test("the pool of a kill tells the event factor, and a kill with a share missing tells nothing", () => {
  // A level 40 enraged vampire pays 234,240 at normal XP and 468,480 at double XP.
  expect(killFactor({ pool: 234240, lines: 6, mult: FROZEN })).toBe(1);
  expect(killFactor({ pool: 468480, lines: 6, mult: FROZEN })).toBe(2);
  // Rounded shares move the sum by a point or two.
  expect(killFactor({ pool: 468478, lines: 6, mult: FROZEN })).toBe(2);
  // One member dead: five shares of six.
  expect(killFactor({ pool: 468480 - 78080, lines: 5, mult: FROZEN })).toBeNull();
  expect(killFactor({ pool: 468480, lines: 6, mult: 0 })).toBeNull();
});

test("only a kill that paid the whole party tells a factor", () => {
  const mult = (zone: number) => ({ 111: FROZEN, 88: 1.54666667 })[zone];
  // Kaesora, 2026-11-10: the leader's line alone, a part of the pool, happens to fit a factor 1.5.
  expect(killFactor({ pool: 25265, lines: 1, mult: 1.54666667 })).toBe(1.5);
  const alone = [line(5000, "You have defeated a spectral guardian and gained 25265 experience!")];
  expect(killFactors(alone, [[0, 88]], mult, "Tovrenalis")).toEqual([{ t: 5000, factor: null, source: "Tovrenalis" }]);
  const whole = [line(6000, "You have defeated a shrouded bat and gained 79553 experience!"), ...[78080, 78080, 78080, 78080, 76607].map((xp, k) => line(6100, `M${k} gains ${xp} experience.`))];
  expect(killFactors(whole, [[0, 111]], mult, "Tagujazolu")).toEqual([{ t: 6000, factor: 2, source: "Tagujazolu" }]);
  // A kill before the party's zone is known tells nothing either.
  expect(killFactors(whole, [[7000, 111]], mult)[0].factor).toBeNull();
});

test("an event starts and ends after three kills in a row from two tabs, from the first of them", () => {
  let tab = 0;
  const k = (t: number, factor: number | null, source = ["A", "B"][tab++ % 2]) => ({ t, factor, source });
  let log = foldKills(null, [k(10, 1), k(20, 2), k(30, 1), k(40, 2), k(50, 2)]);
  // One misfit and two kills are no event yet.
  expect(log.spans).toEqual([]);
  log = foldKills(log, [k(60, null), k(70, 2)]);
  expect(log.spans).toEqual([{ from: 40, to: null, factor: 2 }]);
  // A tab exported later still holds kills from before the start: one at the old factor changes
  // nothing, and one at the new factor shows the event began that much earlier.
  log = foldKills(log, [k(25, 1), k(26, 1), k(27, 1), k(80, 2)]);
  expect(log.spans).toEqual([{ from: 40, to: null, factor: 2 }]);
  log = foldKills(log, [k(35, 2)]);
  expect(log.spans).toEqual([{ from: 35, to: null, factor: 2 }]);
  // The end is found the same way, and moves back to an earlier kill at normal XP.
  log = foldKills(log, [k(100, 1), k(110, 1), k(120, 1), k(130, 1)]);
  expect(log.spans).toEqual([{ from: 35, to: 100, factor: 2 }]);
  log = foldKills(log, [k(95, 1), k(90, 2)]);
  expect(log.spans).toEqual([{ from: 35, to: 95, factor: 2 }]);
  expect([factorAt(log, 34), factorAt(log, 35), factorAt(log, 94), factorAt(log, 95)]).toEqual([1, 2, 2, 1]);
});

test("one tab alone starts no event, since its zone may be taken for another", () => {
  // Permafrost's multiplier is 1.5 times the Mines of Droga's, so kills counted in the wrong one fit 1.5.
  const wrong = [200, 210, 220, 230].map((t) => ({ t, factor: 1.5, source: "A" }));
  let log = foldKills(null, wrong);
  expect(log.spans).toEqual([]);
  // The other tabs' kills at normal XP in between end the count, and a second tab would confirm it.
  expect(foldKills(log, [{ t: 240, factor: 1, source: "B" }]).pending).toBeNull();
  log = foldKills(log, [{ t: 240, factor: 1.5, source: "B" }]);
  expect(log.spans).toEqual([{ from: 200, to: null, factor: 1.5 }]);
});

test("XP gained in an event counts at its normal worth, and a death's loss stays", () => {
  const log = { spans: [{ from: 100, to: null, factor: 2 }], pending: null };
  expect([normalXp(log, 1000, 50), normalXp(log, 1000, 150), normalXp(log, -4000, 150)]).toEqual([1000, 500, -4000]);
});
