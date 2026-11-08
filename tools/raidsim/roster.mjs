// Roster entries to the inputs the client's member builder takes.
//
// A roster file is { "level": 60, "gear": "merchant" | "farm", "members": [...] } or just the array.
// An entry: { name, class, race?, level?, leader?, gear?, stats?, skills?, items?, spells?, gems? }
//   class   number 1-14 or name ("warrior", "shadow-knight", ...)
//   gear    where a default kit comes from (kits.mjs): "merchant" or "farm". The entry's value wins over the
//           roster file's "gear", which wins over the default "merchant"
//   items   { slotId: itemId } or [itemId, ...] (placed by each item's slot mask); default is the kit
//           of the gear policy
//   spells  scribed spell ids; default is every scroll the policy gives the class at its level
//   gems    leader only: memorized spell ids, up to 8 (3 for a Bard); default is the 8 highest level
//           spells that appear in the client's auto-cast table for the class
//
// A normalized member also carries `kit`, where each default item and spell came from, for the
// gear report (report.mjs).
import { byId } from "./content.mjs";
import { SKILL_IDS, classId, creationStats, raceId, skillCaps, skillCapsByName } from "./classes.mjs";
import { defaultGear, defaultGems, farmGear, farmSpells, merchantSpells } from "./kits.mjs";

export const GEAR_POLICIES = ["merchant", "farm"];
export const DEFAULT_FARM_HOURS = 4;
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

const kitCache = new Map();
// The default kit of a class, race and level under a policy: { gear, origins, spells, farmedSpells }.
// Members of one class share it, and `origins` says where each item came from.
async function defaultKit(policy, cls, race, level, caps, options) {
  const key = `${policy}:${cls}:${race}:${level}:${options.farmHours}`;
  if (!kitCache.has(key)) {
    kitCache.set(key, (async () => {
      if (policy === "merchant") return { gear: await defaultGear(cls, race, level, caps), origins: null, spells: await merchantSpells(cls, level), farmedSpells: [] };
      if (!options.resolve) throw new Error("gear policy farm needs the Raid Resolve boss list of the client (options.resolve)");
      const farm = { hours: options.farmHours ?? DEFAULT_FARM_HOURS, resolve: options.resolve };
      const { gear, origins } = await farmGear(cls, race, level, caps, farm);
      const { spells, farmed } = await farmSpells(cls, level, farm);
      return { gear, origins, spells, farmedSpells: farmed };
    })());
  }
  return kitCache.get(key);
}

// `options`: { gear: policy for entries without their own (default "merchant"), farmHours, resolve }
export async function normalizeEntry(entry, defaultLevel, index, options = {}) {
  const policy = entry.gear ?? options.gear ?? "merchant";
  if (!GEAR_POLICIES.includes(policy)) throw new Error(`gear must be one of ${GEAR_POLICIES.join(", ")}, not ${JSON.stringify(policy)} (roster entry ${entry.name ?? index})`);
  const cls = classId(entry.class);
  const level = entry.level ?? defaultLevel;
  const race = raceId(entry.race, cls);
  const caps = skillCapsByName(cls, level);
  const nameToId = SKILL_IDS;
  const skills = { ...skillCaps(cls, level) };
  for (const [k, v] of Object.entries(entry.skills ?? {})) {
    const id = Number.isInteger(+k) ? +k : nameToId[k];
    if (id === undefined) throw new Error(`unknown skill ${JSON.stringify(k)} in the roster entry for ${entry.name}`);
    skills[id] = v;
  }
  const items = await byId("items");
  const kit = entry.items && entry.spells ? null : await defaultKit(policy, cls, race, level, caps, options);
  const equipped = Array.isArray(entry.items) ? placeItems(entry.items, items) : (entry.items ?? kit.gear);
  return {
    index,
    name: entry.name ?? `${cls}-${index}`,
    cls,
    race,
    level,
    leader: !!entry.leader,
    stats: { ...creationStats(cls, race, entry.alloc), ...(entry.stats ?? {}) },
    skills,
    equipped,
    spells: entry.spells ?? kit.spells,
    gems: entry.gems ?? null,
    kit: { policy, origins: entry.items ? "roster" : kit.origins, farmedSpells: entry.spells ? "roster" : kit.farmedSpells },
  };
}

export function rosterEntries(file) {
  const entries = Array.isArray(file) ? file : file.members;
  if (!Array.isArray(entries) || !entries.length) throw new Error("roster file needs a non-empty array of members");
  return { entries, level: (Array.isArray(file) ? undefined : file.level) ?? 60, gear: Array.isArray(file) ? undefined : file.gear };
}

// Normalized roster for the fight worker: exactly one leader, and its gems chosen.
export async function normalizeEntries(entries, level, options = {}) {
  const out = [];
  for (const [i, e] of entries.entries()) out.push(await normalizeEntry(e, level, i, options));
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
