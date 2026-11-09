// How long items stay worn: one stint per character and slot, from the gear pass's survey of every
// worn item, so the gear value's wear horizon (`wearLevels` in tools/lib/acquire.mjs) can come from
// how often slots are actually replaced instead of an assumption.

export const WEAR_SCHEMA = `
CREATE TABLE IF NOT EXISTS wear (
  name TEXT NOT NULL, slot INTEGER NOT NULL, item_id INTEGER NOT NULL,
  since INTEGER NOT NULL, since_level INTEGER, until INTEGER, until_level INTEGER);
CREATE INDEX IF NOT EXISTS wear_open ON wear (name, slot) WHERE until IS NULL;
`;

/**
 * Record the worn items of a survey (`rows` with `characterName`, `level`, `location`, `slot` and
 * `itemId`) at `now`: an item that replaced another in a slot closes the old stint and opens a new
 * one, and an item that left a slot closes its stint. Characters the survey does not list keep their
 * stints, since a missing tab says nothing about their gear.
 */
export function recordWear(db, rows, now) {
  const worn = new Map();
  const levelOf = new Map();
  for (const r of rows) {
    levelOf.set(r.characterName, r.level ?? null);
    if (r.location === "Equipped") worn.set(`${r.characterName}\t${r.slot}`, r.itemId);
  }
  const open = db.query("SELECT rowid AS id, name, slot, item_id FROM wear WHERE until IS NULL").all();
  const close = db.query("UPDATE wear SET until = ?, until_level = ? WHERE rowid = ?");
  const start = db.query("INSERT INTO wear (name, slot, item_id, since, since_level) VALUES (?, ?, ?, ?, ?)");
  db.transaction(() => {
    const held = new Set();
    for (const s of open) {
      if (!levelOf.has(s.name)) continue;
      const key = `${s.name}\t${s.slot}`;
      if (worn.get(key) === s.item_id) held.add(key);
      else close.run(now, levelOf.get(s.name), s.id);
    }
    for (const [key, itemId] of worn) {
      if (held.has(key)) continue;
      const [name, slot] = key.split("\t");
      start.run(name, Number(slot), itemId, now, levelOf.get(name));
    }
  })();
}
