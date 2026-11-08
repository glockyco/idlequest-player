// What the content snapshot does not hold: class names, default races, raw stat lines and skill
// levels for a recruit. Raw stats come from the live client's creation table, skill levels are
// assumptions of this tool. A roster entry overrides any of them ("stats", "alloc", "skills", "race").
import { readFileSync } from "node:fs";

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

// Raw attributes are the live client's creation stats for the race and class
// (data/char-create.json): the base row plus a bonus-point allocation. Attributes never grow with
// level, so gear, buffs and AAs are the only other sources. `alloc` defaults to the server's preset,
// which is what `iq.createCharacter` sends.
const CHAR_CREATE = JSON.parse(readFileSync(new URL("../../data/char-create.json", import.meta.url), "utf8"));
const STAT_KEYS = ["str", "sta", "agi", "dex", "wis", "int", "cha"];
export function creationStats(cls, race, alloc) {
  const combo = CHAR_CREATE.combinations.find((c) => c.class === cls && c.race === race);
  if (!combo) throw new Error(`race ${race} cannot be class ${cls} (data/char-create.json)`);
  const points = CHAR_CREATE.classes.find((c) => c.id === cls).createPoints;
  const spend = alloc ?? combo.preset;
  const spent = STAT_KEYS.reduce((n, k) => n + (spend[k] ?? 0), 0);
  if (spent > points) throw new Error(`allocation spends ${spent} points, class ${cls} has ${points}`);
  return Object.fromEntries(STAT_KEYS.map((k) => [k, combo.base[k] + (spend[k] ?? 0)]));
}

// Skill ids by name, as the client's skill enum (`skillNames` in clients.mjs) numbers them. fight.mjs
// checks this table against the client.
export const SKILL_IDS = {"OneHBlunt": 0, "OneHSlashing": 1, "TwoHBlunt": 2, "TwoHSlashing": 3, "Abjuration": 4, "Alteration": 5, "Archery": 7, "Backstab": 8, "Bash": 10, "Block": 11, "BrassInstruments": 12, "Channeling": 13, "Conjuration": 14, "Defense": 15, "Divination": 18, "Dodge": 19, "DoubleAttack": 20, "DragonPunch": 21, "DualWield": 22, "EagleStrike": 23, "Evocation": 24, "FlyingKick": 26, "HandToHand": 28, "Kick": 30, "Meditate": 31, "Mend": 32, "Offense": 33, "Parry": 34, "OneHPiercing": 36, "Riposte": 37, "RoundKick": 38, "Singing": 41, "StringedInstruments": 49, "WindInstruments": 54, "PercussionInstruments": 70, "Taunt": 73};

// Skill caps per class and level from the live server (data/skill-caps.json, levels 46 to 60). A
// recruit is assumed trained to the cap. Returns the cap of every skill the class has, by skill id.
const SKILL_CAP_ROWS = JSON.parse(readFileSync(new URL("../../data/skill-caps.json", import.meta.url), "utf8")).caps;
export function skillCaps(cls, level) {
  const row = SKILL_CAP_ROWS[`${cls}-${level}`];
  if (!row) throw new Error(`no skill caps for class ${cls} at level ${level}; data/skill-caps.json holds levels 46 to 60`);
  return Object.fromEntries(row.flatMap((cap, id) => (cap > 0 ? [[id, cap]] : [])));
}
// The same caps by the names in SKILL_IDS, for the kit's weapon choice.
export function skillCapsByName(cls, level) {
  const byId = skillCaps(cls, level);
  return Object.fromEntries(Object.entries(SKILL_IDS).flatMap(([name, id]) => (byId[id] ? [[name, byId[id]]] : [])));
}
