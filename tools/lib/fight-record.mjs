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

// The guard's rules that leave a fight for what its enemies do (`guardDanger` in src/bridge.js).
// A fight a task or the slow-fight rule left was not lost.
const LOST = new Set(["level", "hit", "dying", "down", "healer"]);

/**
 * The kills and escapes among one tab's `events`, whose leader is at `level`: rows
 * `{ t, npc, level, outcome, rule }`. An escape counts once against every enemy of the fight it
 * left (`mobs`), because a named enemy fights with its company and the guard names one of them.
 * An escape without an enemy, such as a member's death in no fight, counts against nobody.
 */
export function fightOutcomes(events, level) {
  const out = [];
  for (const e of events) {
    const kill = e.type === "EXPERIENCE_GAIN" && KILL.exec(e.text ?? "");
    if (kill) out.push({ t: e.t, npc: npcKey(kill[1]), level, outcome: "kill", rule: null });
    else if (e.type === "guard" && LOST.has(e.escape)) {
      const names = new Set([e.npc, ...(e.mobs ?? []).map((m) => m.name)].filter(Boolean).map(npcKey));
      for (const npc of names) out.push({ t: e.t, npc, level: e.leaderLevel ?? level, outcome: "escape", rule: e.escape });
    }
  }
  return out;
}

/** Store the rows of `fightOutcomes` for group `grp`. */
export function recordFights(db, grp, rows) {
  const insert = db.query("INSERT INTO fights (t, grp, level, npc, outcome, rule) VALUES (?, ?, ?, ?, ?, ?)");
  for (const r of rows) insert.run(r.t, grp, r.level, r.npc, r.outcome, r.rule);
}

// An escape of a leader `n` levels below counts as this to the power of `n`.
const ESCAPE_DECAY = 0.5;

/**
 * The kills and escapes against enemy `npc` in the last `days` that say how a group whose leader
 * stands at `level` fares: `{ kills, escapes }`. A kill counts when a leader at this level or below
 * won it, and an escape when a leader at this level or above lost it, whichever group fought,
 * because the groups are built alike and grow with their level. So a group knows an enemy the
 * others lost to before it meets it. An escape of a leader below this level counts for less with
 * each level between (`ESCAPE_DECAY`), because a level changes little: without it every level
 * gained kept the kills and forgot the escapes, and the groups went back to an enemy that had
 * beaten them a level before. An escape by the guard's level rule was a fight refused at its
 * first second, which says nothing about how it would have gone, so it does not count.
 */
export function recordCounts(db, { npc, level, now = Date.now(), days = 14 }) {
  const rows = db
    .query("SELECT level, outcome, COUNT(*) AS n FROM fights WHERE npc = ?1 AND t >= ?2 AND (outcome = 'kill' OR rule IS NOT 'level') GROUP BY level, outcome")
    .all(npcKey(npc), now - days * 86400000);
  let kills = 0;
  let escapes = 0;
  for (const r of rows) {
    if (r.outcome === "kill") kills += r.level <= level ? r.n : 0;
    else if (r.outcome === "escape") escapes += r.n * (r.level >= level ? 1 : ESCAPE_DECAY ** (level - r.level));
  }
  return { kills, escapes };
}

/**
 * The body types of each group's kills of the last `days`, by share: `{ [group]: { [body type]:
 * share } }`. `bodyOf(npc)` gives the body type of an enemy by its record key, or null for one it
 * does not know, whose kills count in the total and for no type. A weapon proc that hits one kind
 * of enemy is worth this share of its damage (`procShare` in tools/lib/gear-data.mjs).
 */
export function killBodies(db, bodyOf, { now = Date.now(), days = 2 } = {}) {
  const counts = {};
  const totals = {};
  for (const r of db.query("SELECT grp, npc, COUNT(*) AS n FROM fights WHERE outcome = 'kill' AND t >= ? GROUP BY grp, npc").all(now - days * 86400000)) {
    totals[r.grp] = (totals[r.grp] ?? 0) + r.n;
    const body = bodyOf(r.npc);
    if (body != null) (counts[r.grp] ??= {})[body] = (counts[r.grp][body] ?? 0) + r.n;
  }
  return Object.fromEntries(Object.entries(totals).map(([grp, total]) => [grp, Object.fromEntries(Object.entries(counts[grp] ?? {}).map(([body, n]) => [body, n / total]))]));
}
