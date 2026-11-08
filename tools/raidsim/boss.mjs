// A boss row from npc_types and its npc_spells list, as the data the fight worker turns into the
// CombatInit the server sends the client when a fight starts (fight.mjs, `bossInit`).
import { byId, table } from "./content.mjs";

export const BOSS_SPAWN_ID = 1;

export async function findBoss(ref) {
  const npcs = await table("npc_types");
  const text = String(ref);
  let rows = /^\d+$/.test(text) ? npcs.filter((n) => n.id === +text) : [];
  if (!rows.length) {
    const key = text.toLowerCase().replace(/^#/, "").replace(/[\s_]+/g, " ");
    const clean = (n) => n.name.toLowerCase().replace(/^#/, "").replace(/_/g, " ");
    rows = npcs.filter((n) => clean(n) === key);
    if (!rows.length) rows = npcs.filter((n) => clean(n).includes(key));
  }
  if (rows.length !== 1) {
    const hint = rows.slice(0, 8).map((r) => `${r.id} ${r.name} L${r.level}`).join("; ");
    throw new Error(rows.length ? `${rows.length} NPCs match ${JSON.stringify(ref)}: ${hint}` : `no NPC matches ${JSON.stringify(ref)}`);
  }
  return rows[0];
}

// npc_spells_entries.type is EQEmu's bit mask, and the client's spell categories are its own
// numbers (damage 1, heal 2, over time 4, buff 5, lifetap 11, control 12, pet 14). The server
// decides which entries a fight sends, and this tool chose the rule: the types an engaged NPC
// casts (nuke, heal, root, lifetap, snare, DoT, dispel, in-combat buff, mez, charm, slow, debuff,
// cure), without out-of-combat buff, escape and pet.
const CATEGORY_OF_TYPE = [
  [1, 1],
  [2, 2],
  [4, 12],
  [64, 11],
  [128, 12],
  [256, 4],
  [512, 12],
  [1024, 5],
  [2048, 12],
  [4096, 12],
  [8192, 12],
  [16384, 4],
  [32768, 2],
];
const categoryOf = (type) => CATEGORY_OF_TYPE.find(([bit]) => (type & bit) !== 0)?.[1] ?? null;

// The entries of a spell list at the NPC's level, with the parent lists a list inherits from.
async function spellEntries(listId, level) {
  const lists = await byId("npc_spells");
  const entries = await table("npc_spells_entries");
  const out = [];
  const seen = new Set();
  let list = lists.get(listId);
  for (let depth = 0; list && depth < 4; depth++) {
    for (const e of entries.filter((x) => x.npc_spells_id === list.id)) {
      const category = categoryOf(e.type);
      if (category === null || level < e.minlevel || level > e.maxlevel || seen.has(e.spellid)) continue;
      seen.add(e.spellid);
      out.push({ spellId: e.spellid, category, minLevel: e.minlevel });
    }
    list = list.parent_list ? lists.get(list.parent_list) : null;
  }
  return out;
}

export async function bossSpec(row) {
  return { row, spells: row.npc_spells_id > 0 ? await spellEntries(row.npc_spells_id, row.level) : [] };
}
