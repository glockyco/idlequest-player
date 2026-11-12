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

/**
 * An enemy's name as the record keys it: the game writes `Lady_Vox` in some places and `Lady Vox` in
 * others, and the daily boss list says `Cazic-Thule` for the content's `Cazic_Thule`.
 */
export const npcKey = (name) => String(name).replace(/[#_-]/g, " ").replace(/\s+/g, " ").trim().toLowerCase();

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
 * The kills and escapes against enemy `npc` in the last `days` that say how a group whose leader
 * stands at `level` fares: `{ kills, escapes }`. A kill counts when a leader at this level or below
 * won it, and an escape when a leader at this level or above lost it, whichever group fought,
 * because the groups are built alike and grow with their level. So a group knows an enemy the
 * others lost to before it meets it, and keeps what it knew when it gains a level: Phinigel
 * Autropos beat eleven groups 46 times on 2026-11-12, each of them sent on its own record. An
 * escape by the guard's level rule was a fight refused at its first second, which says nothing
 * about how it would have gone, so it does not count.
 */
export function recordCounts(db, { npc, level, now = Date.now(), days = 14 }) {
  const r = db
    .query("SELECT SUM(outcome = 'kill' AND level <= ?1) AS kills, SUM(outcome = 'escape' AND rule IS NOT 'level' AND level >= ?1) AS escapes FROM fights WHERE npc = ?2 AND t >= ?3")
    .get(level, npcKey(npc), now - days * 86400000);
  return { kills: r?.kills ?? 0, escapes: r?.escapes ?? 0 };
}
