// Checks the fight record (tools/lib/fight-record.mjs). Run with `bun test`.
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { FIGHTS_SCHEMA, fightOutcomes, npcKey, recordCounts, recordFights } from "../tools/lib/fight-record.mjs";

const T0 = 1_800_000_000_000;

test("a defeat line is a kill, a guard escape naming its enemy is an escape, and anything else counts against nobody", () => {
  const events = [
    { t: T0, type: "EXPERIENCE_GAIN", text: "You have defeated Lady Vox and gained 88539 experience!" },
    { t: T0 + 1, type: "guard", text: "[guard] leaving: level: Tilania_Shadowwalker L61 against leader L52", escape: "level", npc: "Tilania_Shadowwalker", npcLevel: 61, leaderLevel: 52 },
    // A member's death in no fight names no enemy.
    { t: T0 + 2, type: "guard", text: "[guard] leaving: down: Felowynna died", escape: "down", npc: null },
    { t: T0 + 3, type: "EXPERIENCE_GAIN", text: "You gain experience!! (1107392)" },
  ];
  expect(fightOutcomes(events, 52)).toEqual([
    { t: T0, npc: "lady vox", level: 52, outcome: "kill", rule: null },
    { t: T0 + 1, npc: "tilania shadowwalker", level: 52, outcome: "escape", rule: "level" },
  ]);
});

test("an enemy has one key however the game spells its name", () => {
  // The simulator found no "Cazic-Thule" of the daily list among the content's NPCs, so the goal boss had no kill chance.
  expect(["Cazic-Thule", "#Cazic_Thule", "Cazic Thule"].map(npcKey)).toEqual(["cazic thule", "cazic thule", "cazic thule"]);
});

test("a group's record counts its recent fights at its current level, and only its own", () => {
  const db = new Database(":memory:");
  db.run(FIGHTS_SCHEMA);
  const fight = (t: number, level: number, outcome: string) => ({ t, npc: "lady vox", level, outcome, rule: outcome === "escape" ? "dying" : null });
  recordFights(db, "G1", [fight(T0, 52, "kill"), fight(T0 + 1, 52, "escape"), fight(T0 + 2, 52, "kill")]);
  // A fight at another level and one three weeks old stay out.
  recordFights(db, "G1", [fight(T0 + 3, 51, "kill"), fight(T0 - 20 * 86400000, 52, "kill")]);
  // A fight the guard left by its level rule was refused, not lost.
  recordFights(db, "G1", [{ t: T0 + 4, npc: "lady vox", level: 52, outcome: "escape", rule: "level" }]);
  expect(recordCounts(db, { grp: "G1", npc: "Lady_Vox", level: 52, now: T0 + 10 })).toEqual({ kills: 2, escapes: 1 });
  expect(recordCounts(db, { grp: "G2", npc: "Lady_Vox", level: 52, now: T0 + 10 })).toEqual({ kills: 0, escapes: 0 });
});
