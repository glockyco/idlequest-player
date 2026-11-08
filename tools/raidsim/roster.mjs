// Roster entries to the inputs the client's member builder takes.
//
// An entry: { name, class, race?, level?, leader?, stats?, skills?, items?, spells?, gems? }
//   class   number 1-14 or name ("warrior", "shadow-knight", ...)
//   items   { slotId: itemId } or [itemId, ...] (placed by each item's slot mask); default is the
//           plain merchant kit from kits.mjs
//   spells  scribed spell ids; default is every merchant scroll the class can cast at its level
//   gems    leader only: memorized spell ids, up to 8 (3 for a Bard); default is the 8 highest level
//           spells that appear in the client's auto-cast table for the class
import { byId } from "./content.mjs";
import { BASE_STATS, SKILL_CAPS, SKILL_IDS, classId, raceId } from "./classes.mjs";
import { defaultGear, defaultGems, merchantSpells } from "./kits.mjs";

function placeItems(list, items) {
  const used = new Set();
  const out = {};
  for (const id of list) {
    const item = items.get(id);
    if (!item) throw new Error(`item ${id} is not in the content snapshot`);
    const bits = [...Array(22).keys()].filter((s) => (item.slots & (1 << s)) !== 0);
    const slot = bits.find((s) => !used.has(s));
    if (slot === undefined) throw new Error(`no free equipment slot for item ${id} ${item.Name}`);
    used.add(slot);
    out[slot] = id;
  }
  return out;
}

export async function normalizeEntry(entry, defaultLevel, index) {
  const cls = classId(entry.class);
  const level = entry.level ?? defaultLevel;
  const race = raceId(entry.race, cls);
  const caps = SKILL_CAPS[cls];
  const nameToId = SKILL_IDS;
  const skills = {};
  for (const [name, cap] of Object.entries(caps)) skills[nameToId[name]] = Math.min(cap, level * 5);
  for (const [k, v] of Object.entries(entry.skills ?? {})) {
    const id = Number.isInteger(+k) ? +k : nameToId[k];
    if (id === undefined) throw new Error(`unknown skill ${JSON.stringify(k)} in the roster entry for ${entry.name}`);
    skills[id] = v;
  }
  const items = await byId("items");
  const equipped = Array.isArray(entry.items) ? placeItems(entry.items, items) : (entry.items ?? (await defaultGear(cls, race, level, caps)));
  return {
    index,
    name: entry.name ?? `${cls}-${index}`,
    cls,
    race,
    level,
    leader: !!entry.leader,
    stats: { ...BASE_STATS[cls], ...(entry.stats ?? {}) },
    skills,
    equipped,
    spells: entry.spells ?? (await merchantSpells(cls, level)),
    gems: entry.gems ?? null,
  };
}

export function rosterEntries(file) {
  const entries = Array.isArray(file) ? file : file.members;
  if (!Array.isArray(entries) || !entries.length) throw new Error("roster file needs a non-empty array of members");
  return { entries, level: (Array.isArray(file) ? undefined : file.level) ?? 60 };
}

// Normalized roster for the fight worker: exactly one leader, and its gems chosen.
export async function normalizeEntries(entries, level) {
  const out = [];
  for (const [i, e] of entries.entries()) out.push(await normalizeEntry(e, level, i));
  const leaders = out.filter((m) => m.leader);
  if (leaders.length > 1) throw new Error("a roster has one leader");
  if (!leaders.length) out[0].leader = true;
  const leader = out.find((m) => m.leader);
  leader.gems ??= await defaultGems(leader);
  return out;
}

export function snapshotOf(member, characterId) {
  return {
    characterId,
    name: member.name,
    surname: "",
    level: member.level,
    classId: member.cls,
    raceId: member.race,
    gender: 0,
    face: 0,
    showHelm: true,
    baseStats: member.stats,
    skills: member.skills,
    equippedItems: Object.entries(member.equipped).map(([slot, itemId]) => ({ slot: +slot, itemId })),
    scribedSpellIds: member.spells,
    aaBonuses: {},
    deityId: 0,
    quiverHastePercent: 0,
  };
}
