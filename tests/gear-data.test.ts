// The score and farm-time rules shared by tools/gear.mjs and the raid simulator's farmed kits.
import { expect, test } from "bun:test";
// @ts-expect-error plain .mjs module without types
import { CLASS_KEYS, BIT, capFor, damageBonus, expectedMult, farmHours, outputValue, procDamagePerMinute, scoreFor, statScore, weaponRatio } from "../tools/lib/gear-data.mjs";

test("class keys line up with the class bit masks", () => {
  CLASS_KEYS.slice(1).forEach((key: string, i: number) => expect(BIT[key]).toBe(1 << i));
});

test("the score is the stat score plus haste and regeneration", () => {
  const item = { ac: 10, hp: 20, astr: 5, haste: 20, regen: 2, manaregen: 1 };
  expect(scoreFor(item, "warrior", 60)).toBe(statScore(item, "warrior", 60) + 3 * 20 + 8 * 3);
  expect(statScore({ ac: 10, hp: 20, astr: 5 }, "warrior", 60)).toBe(1.5 * 10 + 0.5 * 20 + 5);
});

test("a weapon's damage is capped at the level's limit before it is divided by the delay", () => {
  expect(capFor("warrior", 60)).toBe(100);
  expect(capFor("cleric", 60)).toBe(40);
  // Below 28 no flat bonus applies, so the ratio is the capped damage over the delay.
  expect(weaponRatio({ damage: 200, delay: 40 }, "warrior", 20)).toBe(30 / 40);
  expect(weaponRatio({ damage: 12, delay: 30 }, "warrior", 20)).toBe(12 / 30);
});

test("a main-hand hit of a melee class carries the client's flat bonus, two-handers by delay", () => {
  expect(damageBonus({ itemtype: 0, delay: 30 }, "warrior", 60)).toBe(11);
  expect(damageBonus({ itemtype: 1, delay: 40 }, "warrior", 60)).toBe(34);
  expect(damageBonus({ itemtype: 0, delay: 30 }, "wizard", 60)).toBe(0);
  expect(damageBonus({ itemtype: 0, delay: 30 }, "warrior", 27)).toBe(0);
  // The bonus adds the same damage to every swing, so it favours the fast weapon at equal damage over delay.
  const fast = { damage: 10, delay: 20, itemtype: 0 };
  const slow = { damage: 20, delay: 40, itemtype: 0 };
  expect(weaponRatio(fast, "warrior", 40)).toBeGreaterThan(weaponRatio(slow, "warrior", 40));
  // The off hand gets no bonus.
  expect(weaponRatio(slow, "warrior", 40, { primary: false })).toBe(20 / 40);
});

test("a proc adds its damage at the wearer's level, (0.5 + DEX/170) times a minute, and none below its level", () => {
  const blade = { damage: 10, delay: 30, procrate: 0, proclevel: 20, procSpell: { effects: [{ formula: 100, base: -50, max: 0 }], ticks: 0 } };
  expect(procDamagePerMinute(blade, 30, 85)).toBeCloseTo(1 * 50);
  expect(procDamagePerMinute({ ...blade, procrate: 50 }, 30, 85)).toBeCloseTo(1.5 * 50);
  expect(procDamagePerMinute(blade, 19, 85)).toBe(0);
  expect(weaponRatio(blade, "wizard", 30, { dex: 85 })).toBeCloseTo(10 / 30 + 50 / 60 / (10 * expectedMult(30)));
});

test("a worn effect counts like the stats it gives, from its required level, and a focus by its best item", () => {
  // Worn STR (SPA 4) adds offense for a Warrior like the same STR on the item.
  expect(outputValue([{ wornEffects: [{ spa: 4, value: 15 }], reqlevel: 30 }], "warrior", 40)).toBeCloseTo(outputValue([{ astr: 15 }], "warrior", 40));
  expect(outputValue([{ wornEffects: [{ spa: 4, value: 15 }], reqlevel: 30 }], "warrior", 20)).toBe(0);
  // Worn haste (SPA 11, 100 plus the percent) counts as the highest item haste.
  expect(outputValue([{ wornEffects: [{ spa: 11, value: 121 }] }, { haste: 15 }], "warrior", 40)).toBeCloseTo(outputValue([{ haste: 21 }], "warrior", 40));
  // A 10% mana cost focus (SPA 132) is worth 10% of a caster's output, and of two only the better counts.
  const focus = (v: number) => ({ focusEffects: [{ spa: 132, value: v }] });
  expect(outputValue([focus(10)], "wizard", 40)).toBe(100);
  expect(outputValue([focus(10), focus(5)], "wizard", 40)).toBe(100);
  expect(outputValue([focus(10)], "warrior", 40)).toBe(0);
});

test("farm hours are respawn over spawn chance and drop chance", () => {
  expect(farmHours({ respawn: 640, spawn: 0.25, drop: 0.68 })).toBeCloseTo(640 / (0.25 * 0.68) / 3600, 10);
  expect(farmHours({ respawn: Infinity, spawn: 1, drop: 1 })).toBe(Infinity);
  expect(farmHours({ respawn: 640, spawn: 0, drop: 1 })).toBe(Infinity);
});
