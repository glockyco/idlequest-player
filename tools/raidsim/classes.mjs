// What the content snapshot does not hold: class names, default races, raw stat lines and skill
// levels for a recruit. The server owns these for real characters, so the values below are
// assumptions of this tool. A roster entry overrides any of them ("stats", "skills", "race").

export const CLASS_NAMES = [
  null,
  "warrior",
  "cleric",
  "paladin",
  "ranger",
  "shadow-knight",
  "druid",
  "monk",
  "bard",
  "rogue",
  "shaman",
  "necromancer",
  "wizard",
  "magician",
  "enchanter",
];

export function classId(value) {
  if (Number.isInteger(value) && value >= 1 && value <= 14) return value;
  const key = String(value).toLowerCase().replace(/[\s_]+/g, "-");
  const id = CLASS_NAMES.indexOf(key === "shadowknight" ? "shadow-knight" : key);
  if (id < 1) throw new Error(`unknown class ${JSON.stringify(value)}; use a number 1-14 or one of ${CLASS_NAMES.slice(1).join(", ")}`);
  return id;
}

export const RACES = { human: 1, barbarian: 2, erudite: 3, "wood-elf": 4, "high-elf": 5, "dark-elf": 6, "half-elf": 7, dwarf: 8, troll: 9, ogre: 10, halfling: 11, gnome: 12, iksar: 128, "vah-shir": 130 };
// Race bit in an item's `races` mask.
export const RACE_BIT = { 1: 0, 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 7: 6, 8: 7, 9: 8, 10: 9, 11: 10, 12: 11, 128: 12, 130: 13 };

export function raceId(value, cls) {
  if (value === undefined) return cls === 10 ? RACES.barbarian : RACES.human;
  if (Number.isInteger(value)) return value;
  const id = RACES[String(value).toLowerCase().replace(/[\s_]+/g, "-")];
  if (!id) throw new Error(`unknown race ${JSON.stringify(value)}; use an id or one of ${Object.keys(RACES).join(", ")}`);
  return id;
}

// Raw (ungeared) attributes. Assumption: every class has 255 in the attribute its mana or damage
// scales with, as docs/plans/raid-roster.md assumes for casters, and a plain 100 elsewhere.
const STAT = (o) => ({ str: 100, sta: 150, dex: 100, agi: 100, int: 100, wis: 100, cha: 100, ...o });
export const BASE_STATS = {
  1: STAT({ str: 200, sta: 200, dex: 150, agi: 120 }),
  2: STAT({ wis: 255 }),
  3: STAT({ str: 200, sta: 200, dex: 120, wis: 150 }),
  4: STAT({ str: 150, sta: 150, dex: 150, agi: 150, wis: 150 }),
  5: STAT({ str: 200, sta: 200, dex: 120, int: 150 }),
  6: STAT({ wis: 255 }),
  7: STAT({ str: 150, sta: 200, dex: 150, agi: 200 }),
  8: STAT({ str: 150, dex: 150, agi: 120, cha: 200 }),
  9: STAT({ str: 150, dex: 200, agi: 200 }),
  10: STAT({ wis: 255 }),
  11: STAT({ int: 255 }),
  12: STAT({ int: 255 }),
  13: STAT({ int: 255 }),
  14: STAT({ int: 255, cha: 200 }),
};

// Skill ids by name, as the client's skill enum (`Sc` in main.pretty.js) numbers them. fight.mjs
// checks this table against the client.
export const SKILL_IDS = {"OneHBlunt": 0, "OneHSlashing": 1, "TwoHBlunt": 2, "TwoHSlashing": 3, "Abjuration": 4, "Alteration": 5, "Archery": 7, "Backstab": 8, "Bash": 10, "Block": 11, "BrassInstruments": 12, "Channeling": 13, "Conjuration": 14, "Defense": 15, "Divination": 18, "Dodge": 19, "DoubleAttack": 20, "DragonPunch": 21, "DualWield": 22, "EagleStrike": 23, "Evocation": 24, "FlyingKick": 26, "HandToHand": 28, "Kick": 30, "Meditate": 31, "Mend": 32, "Offense": 33, "Parry": 34, "OneHPiercing": 36, "Riposte": 37, "RoundKick": 38, "Singing": 41, "StringedInstruments": 49, "WindInstruments": 54, "PercussionInstruments": 70, "Taunt": 73};

// Level 60 skill levels by class, written from memory of the P99 class skill caps. A skill that a
// class cannot train is absent. Lower levels use min(cap, 5 * level).
const MELEE = { Offense: 252, Defense: 210, Dodge: 200, DoubleAttack: 245 };
const CASTER = { Abjuration: 235, Alteration: 235, Conjuration: 235, Divination: 235, Evocation: 235, Channeling: 220, Meditate: 235 };
export const SKILL_CAPS = {
  1: { ...MELEE, OneHBlunt: 200, OneHSlashing: 200, TwoHBlunt: 200, TwoHSlashing: 200, OneHPiercing: 200, HandToHand: 100, Parry: 200, Riposte: 200, DualWield: 210, Bash: 200, Kick: 200, Taunt: 200 },
  2: { Offense: 135, Defense: 160, Dodge: 125, OneHBlunt: 175, TwoHBlunt: 175, HandToHand: 100, ...CASTER },
  3: { ...MELEE, Offense: 240, DoubleAttack: 200, OneHBlunt: 200, OneHSlashing: 200, TwoHBlunt: 200, TwoHSlashing: 200, Parry: 175, Riposte: 175, Bash: 200, Taunt: 150, Meditate: 100, Abjuration: 150, Alteration: 150, Channeling: 150, Divination: 150, Evocation: 150 },
  4: { ...MELEE, Offense: 240, DoubleAttack: 235, OneHSlashing: 200, TwoHSlashing: 200, OneHPiercing: 200, OneHBlunt: 200, Parry: 200, Riposte: 175, DualWield: 210, Archery: 240, Taunt: 150, Meditate: 100, Alteration: 150, Channeling: 150, Divination: 150, Evocation: 150 },
  5: { ...MELEE, Offense: 240, DoubleAttack: 200, OneHBlunt: 200, OneHSlashing: 200, TwoHBlunt: 200, TwoHSlashing: 200, OneHPiercing: 200, Parry: 175, Riposte: 175, Bash: 200, Taunt: 150, Meditate: 100, Abjuration: 150, Alteration: 150, Channeling: 150, Conjuration: 150, Divination: 150, Evocation: 150 },
  6: { Offense: 140, Defense: 150, Dodge: 125, OneHBlunt: 125, HandToHand: 100, ...CASTER },
  7: { ...MELEE, HandToHand: 225, Parry: 200, Riposte: 200, Block: 200, Kick: 200, DragonPunch: 225, EagleStrike: 225, FlyingKick: 225, RoundKick: 225, Mend: 200, Taunt: 0 },
  8: { ...MELEE, Offense: 200, DoubleAttack: 200, Defense: 190, Dodge: 175, OneHSlashing: 200, OneHPiercing: 200, OneHBlunt: 200, HandToHand: 100, Parry: 175, Riposte: 175, DualWield: 210, Singing: 235, BrassInstruments: 235, StringedInstruments: 235, WindInstruments: 235, PercussionInstruments: 235 },
  9: { ...MELEE, Offense: 245, Defense: 190, DoubleAttack: 245, OneHBlunt: 200, OneHSlashing: 200, OneHPiercing: 200, HandToHand: 100, Parry: 200, Riposte: 200, DualWield: 210, Backstab: 210, Dodge: 200 },
  10: { Offense: 140, Defense: 145, Dodge: 125, OneHBlunt: 125, TwoHBlunt: 125, HandToHand: 100, ...CASTER },
  11: { Offense: 110, Defense: 110, Dodge: 100, OneHPiercing: 110, HandToHand: 75, ...CASTER },
  12: { Offense: 110, Defense: 110, Dodge: 100, OneHPiercing: 110, HandToHand: 75, ...CASTER },
  13: { Offense: 110, Defense: 110, Dodge: 100, OneHBlunt: 110, OneHSlashing: 110, OneHPiercing: 110, HandToHand: 75, ...CASTER },
  14: { Offense: 110, Defense: 110, Dodge: 100, OneHPiercing: 110, HandToHand: 75, ...CASTER },
};
