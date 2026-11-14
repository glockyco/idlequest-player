// The score and farm-time rules shared by tools/gear.mjs and the raid simulator's farmed kits.
import { expect, test } from "bun:test";
// @ts-expect-error plain .mjs module without types
import { CLASS_KEYS, BIT, capFor, damageBonus, dropChance, expectedMult, farmHours, outputValue, procDamagePerMinute, scoreFor, statScore, weaponRatio } from "../tools/lib/gear-data.mjs";

test("class keys line up with the class bit masks", () => {
  CLASS_KEYS.slice(1).forEach((key: string, i: number) => expect(BIT[key]).toBe(1 << i));
});

test("a lootdrop with a limit gives one of its items, and one without rolls each on its own", () => {
  // An Elite Dragoon's weapons: four entries of chance 100, a table probability of 25 and a limit
  // of one. Group 1's 60 kills on 2026-11-11 gave 6, 5, 3 and 2 of the four, 6.7% on average.
  const weapons = { probability: 25, multiplier: 1, droplimit: 1, mindrop: 1 };
  expect(dropChance({ chance: 100, sum: 400 }, weapons)).toBeCloseTo(0.0625);
  // A Disciple's armor: seven pieces behind 42%.
  expect(dropChance({ chance: 100, sum: 700 }, { probability: 42, droplimit: 1, mindrop: 1 })).toBeCloseTo(0.06);
  // A single entry behind its table's probability drops at that probability.
  expect(dropChance({ chance: 100, sum: 100 }, { probability: 50, droplimit: 1, mindrop: 1 })).toBeCloseTo(0.5);
  // Without a limit every entry rolls on its own, the entry's multiplier that many times.
  expect(dropChance({ chance: 25, sum: 400 }, { probability: 100 })).toBeCloseTo(0.25);
  expect(dropChance({ chance: 25, sum: 400, entryMult: 2 }, { probability: 100 })).toBeCloseTo(1 - 0.75 ** 2);
  // A limit of two with one sure draw: the second draw is against at least 100.
  expect(dropChance({ chance: 10, sum: 40 }, { probability: 100, droplimit: 2, mindrop: 1 })).toBeCloseTo(1 - (1 - 10 / 40) * (1 - 10 / 100));
  // The table rolls its lootdrop `multiplier` times.
  expect(dropChance({ chance: 100, sum: 400 }, { ...weapons, multiplier: 2 })).toBeCloseTo(1 - (1 - 0.0625) ** 2);
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

test("a proc for one kind of enemy counts for the share of the wearer's kills of that kind", () => {
  // Target type 11 hits the summoned: body types 24, 27 and 28.
  const blade = { damage: 10, delay: 30, procrate: 0, procSpell: { effects: [{ formula: 100, base: -50, max: 0 }], ticks: 0, targetType: 11 } };
  expect(procDamagePerMinute(blade, 30, 85, { 24: 0.1, 28: 0.05, 3: 0.5 })).toBeCloseTo(0.15 * 50);
  // Without a record of the kills it counts nothing, and a proc for any enemy is not reduced.
  expect(weaponRatio(blade, "wizard", 30, { dex: 85 })).toBeCloseTo(10 / 30);
  expect(procDamagePerMinute({ ...blade, procSpell: { ...blade.procSpell, targetType: 5 } }, 30, 85, { 3: 1 })).toBeCloseTo(50);
});

test("a worn effect counts like the stats it gives, from its required level, and a focus by its best item", () => {
  // Worn STR (SPA 4) adds offense for a Warrior like the same STR on the item.
  expect(outputValue([{ wornEffects: [{ spa: 4, value: 15 }], reqlevel: 30 }], "warrior", 40).melee).toBeCloseTo(outputValue([{ astr: 15 }], "warrior", 40).melee);
  expect(outputValue([{ wornEffects: [{ spa: 4, value: 15 }], reqlevel: 30 }], "warrior", 20).melee).toBe(0);
  // Worn haste (SPA 11, 100 plus the percent) counts as the highest item haste.
  expect(outputValue([{ wornEffects: [{ spa: 11, value: 121 }] }, { haste: 15 }], "warrior", 40).melee).toBeCloseTo(outputValue([{ haste: 21 }], "warrior", 40).melee);
  // A 10% mana cost focus (SPA 132) is worth 10% of a caster's spells, and of two only the better counts.
  const focus = (v: number) => ({ focusEffects: [{ spa: 132, value: v }] });
  expect(outputValue([focus(10)], "wizard", 40)).toEqual({ melee: 0, spells: 100, party: 0 });
  expect(outputValue([focus(10), focus(5)], "wizard", 40).spells).toBe(100);
  expect(outputValue([focus(10)], "warrior", 40).spells).toBe(0);
});

test("mana regeneration is worth the group time its wearer's refill holds the party", () => {
  const ring = [{ manaregen: 5 }];
  // A Necromancer the party waited for 20% of the time, with no supply: 5 regen refills 10% faster,
  // so the party saves 20% x (1 - 1/1.1) of its time.
  expect(outputValue(ring, "necromancer", 30, { recovery: { share: 0.2, regen: 0 } }).party).toBeCloseTo(10 * 100 * 0.2 * (1 - 1 / 1.1));
  // The party never waits for it: nothing.
  expect(outputValue(ring, "necromancer", 30, { recovery: { share: 0, regen: 0 } }).party).toBe(0);
  // Supply at the cap of 50 leaves nothing to gain, and item regeneration counts at most 15.
  expect(outputValue(ring, "necromancer", 30, { recovery: { share: 0.2, regen: 50 } }).party).toBe(0);
  expect(outputValue([{ manaregen: 30 }], "necromancer", 30, { recovery: { share: 0.2, regen: 0 } }).party).toBeCloseTo(outputValue([{ manaregen: 15 }], "necromancer", 30, { recovery: { share: 0.2, regen: 0 } }).party);
  // Item mana shrinks the share of the pool a fight spends: 100 on a 1,000 pool rests 1/11 shorter.
  expect(outputValue([{ mana: 100 }], "necromancer", 30, { pool: 1000, recovery: { share: 0.2, regen: 0 } }).party).toBeCloseTo(10 * 100 * 0.2 * (1 - 1000 / 1100));
});

test("farm hours are respawn over spawn chance and drop chance", () => {
  expect(farmHours({ respawn: 640, spawn: 0.25, drop: 0.68 })).toBeCloseTo(640 / (0.25 * 0.68) / 3600, 10);
  expect(farmHours({ respawn: Infinity, spawn: 1, drop: 1 })).toBe(Infinity);
  expect(farmHours({ respawn: 640, spawn: 0, drop: 1 })).toBe(Infinity);
});
