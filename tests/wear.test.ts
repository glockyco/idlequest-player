// Checks the wear stints (tools/lib/wear.mjs). Run with `bun test`.
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { WEAR_SCHEMA, recordWear } from "../tools/lib/wear.mjs";

const worn = (name: string, level: number, slot: number, itemId: number) => ({ characterName: name, level, location: "Equipped", slot, itemId });

test("a replaced item closes its stint at the replacement's level, and an unlisted character keeps its stints", () => {
  const db = new Database(":memory:");
  db.run(WEAR_SCHEMA);
  recordWear(db, [worn("Tank", 20, 13, 1), worn("Mage", 21, 13, 7)], 1000);
  // The same item a pass later changes nothing.
  recordWear(db, [worn("Tank", 21, 13, 1), worn("Mage", 21, 13, 7)], 2000);
  // Tank's sword is replaced at 24, and Mage's tab is missing from the survey.
  recordWear(db, [worn("Tank", 24, 13, 2)], 3000);
  const rows = db.query("SELECT name, item_id, since, since_level, until, until_level FROM wear ORDER BY since, name").all();
  expect(rows).toEqual([
    { name: "Mage", item_id: 7, since: 1000, since_level: 21, until: null, until_level: null },
    { name: "Tank", item_id: 1, since: 1000, since_level: 20, until: 3000, until_level: 24 },
    { name: "Tank", item_id: 2, since: 3000, since_level: 24, until: null, until_level: null },
  ]);
  // An item taken off closes its stint.
  recordWear(db, [{ characterName: "Tank", level: 25, location: "Carried", slot: 25, itemId: 2 }], 4000);
  expect(db.query("SELECT until, until_level FROM wear WHERE item_id = 2").get()).toEqual({ until: 4000, until_level: 25 });
});
