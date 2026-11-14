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
    // An escape counts against every enemy of the fight, each name once.
    { t: T0 + 4, type: "guard", text: "[guard] escape done", escape: "down", npc: "Korucust`s_Courier", leaderLevel: 57, mobs: [{ id: 1, name: "Korucust`s_Courier" }, { id: 2, name: "Arch_Inspector_Nibi`zi" }, { id: 3, name: "an imperial construct" }, { id: 4, name: "an imperial construct" }] },
  ];
  expect(fightOutcomes(events, 52)).toEqual([
    { t: T0, npc: "lady vox", level: 52, outcome: "kill", rule: null },
    { t: T0 + 1, npc: "tilania shadowwalker", level: 52, outcome: "escape", rule: "level" },
    { t: T0 + 4, npc: "korucust`s courier", level: 57, outcome: "escape", rule: "down" },
    { t: T0 + 4, npc: "arch inspector nibi`zi", level: 57, outcome: "escape", rule: "down" },
    { t: T0 + 4, npc: "an imperial construct", level: 57, outcome: "escape", rule: "down" },
  ]);
});

test("an enemy has one key however the game spells its name", () => {
  // The simulator found no "Cazic-Thule" of the daily list among the content's NPCs, so the goal boss had no kill chance.
  expect(["Cazic-Thule", "#Cazic_Thule", "Cazic Thule"].map(npcKey)).toEqual(["cazic thule", "cazic thule", "cazic thule"]);
});

test("the record counts the kills of leaders at a group's level or below, the escapes of those at it or above, and less of the escapes below", () => {
  const db = new Database(":memory:");
  db.run(FIGHTS_SCHEMA);
  const fight = (t: number, level: number, outcome: string) => ({ t, npc: "lady vox", level, outcome, rule: outcome === "escape" ? "dying" : null });
  recordFights(db, "G1", [fight(T0, 52, "kill"), fight(T0 + 1, 52, "escape"), fight(T0 + 2, 52, "kill")]);
  // A weaker leader's kill counts, and a fight three weeks old does not.
  recordFights(db, "G1", [fight(T0 + 3, 51, "kill"), fight(T0 - 20 * 86400000, 52, "kill")]);
  // A fight the guard left by its level rule was refused, not lost.
  recordFights(db, "G1", [{ t: T0 + 4, npc: "lady vox", level: 52, outcome: "escape", rule: "level" }]);
  // Another group's fights count the same: a stronger leader's escape, and not its kill.
  recordFights(db, "G2", [fight(T0 + 5, 54, "escape"), fight(T0 + 6, 54, "kill")]);
  expect(recordCounts(db, { npc: "Lady_Vox", level: 52, now: T0 + 10 })).toEqual({ kills: 3, escapes: 2 });
  expect(recordCounts(db, { npc: "Lady_Vox", level: 51, now: T0 + 10 })).toEqual({ kills: 1, escapes: 2 });
  // An escape counts half for each level its leader stood below: one at 54 and one at 52.
  expect(recordCounts(db, { npc: "Lady_Vox", level: 55, now: T0 + 10 })).toEqual({ kills: 4, escapes: 0.5 + 0.125 });
});
