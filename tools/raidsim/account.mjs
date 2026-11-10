// The account's characters as a raid roster, from the gear survey iqd saves hourly
// (runs/state/account-items.json): each character's class, race, level and equipped items by slot.
// Spells stay the kit default, every merchant scroll of the class at its level, which the bot buys
// for every character it plays. Allocated stats are not in the survey, so members start from their
// race and class creation stats.

/**
 * Roster entries (tools/raidsim/roster.mjs) for the survey `rows`, the character named `leader`
 * first and leading. `names` limits the roster to those characters.
 */
export function accountRoster(rows, { leader, names = null }) {
  const chars = new Map();
  for (const r of rows) {
    if (names && !names.includes(r.characterName)) continue;
    if (!chars.has(r.characterName)) chars.set(r.characterName, { name: r.characterName, class: r.class, race: r.race, level: r.level, items: {} });
    if (r.location === "Equipped") chars.get(r.characterName).items[r.slot] = r.itemId;
  }
  const lead = chars.get(leader);
  if (!lead) throw new Error(`the survey has no character ${leader}`);
  return [{ ...lead, leader: true }, ...[...chars.values()].filter((c) => c !== lead)];
}
