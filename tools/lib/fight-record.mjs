// The fight record (docs/plans/gear-acquisition.md, "Kill chance"): each kill and each escape of a
// group's leader party, per enemy, from the game log lines every tab exports. A kill is the game's
// "You have defeated X" line, and an escape is the guard's leaving event, which names the rule and
// the enemy as fields (`guardLeave` in src/bridge.js). The acquisition model counts these fights
// beside the simulator's (`killChanceOf` in tools/lib/acquire.mjs).

export const FIGHTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS fights (t INTEGER, grp TEXT, level INTEGER, npc TEXT, outcome TEXT, rule TEXT);
CREATE INDEX IF NOT EXISTS fights_npc ON fights (npc, grp, t);
`;

const KILL = /^You have defeated (.+?) and gained/;

/** An enemy's name as the record keys it: the game writes `Lady_Vox` in some places and `Lady Vox` in others. */
export const npcKey = (name) => String(name).replace(/[#_]/g, " ").replace(/\s+/g, " ").trim().toLowerCase();

/**
 * The kills and escapes among one tab's `events`, whose leader is at `level`: rows
 * `{ t, npc, level, outcome, rule }`. An escape without a named enemy, such as a member's death in
 * no fight, counts against nobody.
 */
export function fightOutcomes(events, level) {
  const out = [];
  for (const e of events) {
    const kill = e.type === "EXPERIENCE_GAIN" && KILL.exec(e.text ?? "");
    if (kill) out.push({ t: e.t, npc: npcKey(kill[1]), level, outcome: "kill", rule: null });
    else if (e.type === "guard" && e.escape && e.npc) out.push({ t: e.t, npc: npcKey(e.npc), level: e.leaderLevel ?? level, outcome: "escape", rule: e.escape });
  }
  return out;
}

/** Store the rows of `fightOutcomes` for group `grp`. */
export function recordFights(db, grp, rows) {
  const insert = db.query("INSERT INTO fights (t, grp, level, npc, outcome, rule) VALUES (?, ?, ?, ?, ?, ?)");
  for (const r of rows) insert.run(r.t, grp, r.level, r.npc, r.outcome, r.rule);
}

/**
 * Group `grp`'s kills and escapes against enemy `npc` in the last `days`, while its leader stood at
 * `level`: the group's strength changes with every level, so older fights at lower levels say
 * little about the next one. An escape by the guard's level rule was a fight refused at its first
 * second, which says nothing about how it would have gone, so it does not count. `{ kills, escapes }`.
 */
export function recordCounts(db, { grp, npc, level, now = Date.now(), days = 14 }) {
  const r = db.query("SELECT SUM(outcome = 'kill') AS kills, SUM(outcome = 'escape' AND rule IS NOT 'level') AS escapes FROM fights WHERE grp = ? AND npc = ? AND t >= ? AND level = ?").get(grp, npcKey(npc), now - days * 86400000, level);
  return { kills: r?.kills ?? 0, escapes: r?.escapes ?? 0 };
}
