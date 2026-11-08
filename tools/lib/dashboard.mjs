// The dashboard's views of the collector database (runs/iq.db) and data/roster.json. Every view is
// a pure function of the database rows and `now`, so the server stays thin and the views can be
// tested on a database built in memory. Reports that need the run logs (tools/groups.mjs,
// tools/plan.mjs) come from those tools, not from here.
import { sessionSummary } from "../iqd.mjs";
import { factor, xpAt, xpStart } from "./xp.mjs";

const DAY = 86400000;
/** Actors whose interventions a person or an agent started by hand, as the SDK and `iqd note` log them. */
export const MANUAL_ACTORS = ["sdk", "agent"];
/** Attention kinds that mean a group stopped making progress. */
export const STALL_KINDS = ["stall", "nokill", "gone", "nobridge"];

/** Local midnight before `t`. */
export const dayStart = (t) => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** The latest known level and XP share of every character id, from its last snapshot. */
function latestLevels(db) {
  const rows = db.query("SELECT s.char_id, s.level, s.xp_pct, s.t FROM char_snapshots s JOIN (SELECT char_id, MAX(id) AS id FROM char_snapshots GROUP BY char_id) m ON s.id = m.id").all();
  return new Map(rows.map((r) => [r.char_id, r]));
}

/**
 * The roster of data/roster.json with each member's class, race and latest level, and the totals
 * the level 60 goal is measured by. A member the collector never saw has no level.
 */
export function rosterView(db, roster, target = 60) {
  const chars = new Map(db.query("SELECT id, name, class, race, roster_level FROM characters").all().map((c) => [c.name, c]));
  const latest = latestLevels(db);
  const groups = roster.groups
    .filter((g) => g.members?.length)
    .map((g) => ({
      id: g.id,
      members: g.members.map((name) => {
        const c = chars.get(name);
        const snap = c ? latest.get(c.id) : null;
        const level = snap?.level ?? c?.roster_level ?? null;
        return { name, class: c?.class ?? null, race: c?.race ?? null, level, xpPct: snap?.level === level ? (snap?.xp_pct ?? null) : null, seen: snap?.t ?? null };
      }),
    }));
  const members = groups.flatMap((g) => g.members);
  const levels = members.map((m) => m.level).filter((l) => l != null);
  // Progress counts XP, not levels: each member's XP over the XP to the target, with its race and
  // class factor, because the late levels cost most of it (the start of level 40 is 12% of 60's).
  const need = members.reduce((a, m) => a + xpStart(target) * factor(m.race, m.class), 0);
  const have = members.reduce((a, m) => a + (m.level == null ? 0 : Math.min(xpStart(target), xpAt(m.level, m.xpPct ?? 0)) * factor(m.race, m.class)), 0);
  return {
    target,
    groups,
    characters: members.length,
    atTarget: levels.filter((l) => l >= target).length,
    minLevel: levels.length ? Math.min(...levels) : null,
    maxLevel: levels.length ? Math.max(...levels) : null,
    meanLevel: levels.length ? levels.reduce((a, b) => a + b, 0) / levels.length : null,
    progress: need ? have / need : 0,
  };
}

/** One card per open session, in roster group order, with the tab's summary. */
export function groupsView(db, now, groupOf) {
  const rows = db.query("SELECT * FROM sessions WHERE ended IS NULL ORDER BY first_seen, id").all();
  const order = (g) => (g ? Number(String(g).replace(/\D/g, "")) : 999);
  return rows.map((s) => sessionSummary(s, now, groupOf)).sort((a, b) => order(a.group) - order(b.group));
}

/** Open attention items that need someone, open info items counted by kind, and the latest resolved ones. */
export function attentionView(db, now, recent = 25) {
  const open = db.query("SELECT id, t, severity, kind, session, text FROM attention WHERE resolved IS NULL ORDER BY id DESC").all();
  const info = {};
  for (const a of open.filter((x) => x.severity === "info")) info[a.kind] = (info[a.kind] ?? 0) + 1;
  return {
    open: open.filter((x) => x.severity !== "info"),
    info,
    resolved: db.query("SELECT id, t, severity, kind, session, text, resolved, note FROM attention WHERE resolved IS NOT NULL AND severity != 'info' ORDER BY resolved DESC LIMIT ?").all(recent),
    interventions: db.query("SELECT id, t, session, actor, text FROM interventions ORDER BY id DESC LIMIT ?").all(recent),
  };
}

/**
 * Engineering health per local day over the last `days` days: group-hours played (the time each
 * open or ended session was seen, parked tabs left out), manual interventions and stalls, both per
 * group-hour, the stalls' mean minutes to resolution, and deaths raised as attention items. These
 * are the numbers the goal asks to fall over time.
 */
export function engineeringView(db, now, days = 14) {
  // The window starts at the first recorded session when that is later, so the chart has no empty days before the data.
  const firstSeen = db.query("SELECT MIN(first_seen) AS t FROM sessions").get()?.t ?? now;
  const first = Math.max(dayStart(now) - (days - 1) * DAY, dayStart(firstSeen));
  const out = [];
  for (let d = first; d <= now; d += DAY) out.push({ day: d, groupHours: 0, interventions: 0, stalls: 0, stallMinutes: [], deaths: 0 });
  const at = (t) => out[Math.floor((dayStart(t) - first) / DAY)];
  for (const s of db.query("SELECT first_seen, last_seen FROM sessions WHERE parked = 0 AND last_seen >= ?").all(first)) {
    for (let d = Math.max(first, dayStart(s.first_seen)); d <= s.last_seen; d += DAY) {
      const row = at(d);
      if (row) row.groupHours += Math.max(0, Math.min(s.last_seen, d + DAY) - Math.max(s.first_seen, d)) / 3600000;
    }
  }
  const manual = MANUAL_ACTORS.map(() => "?").join(",");
  for (const r of db.query(`SELECT t FROM interventions WHERE t >= ? AND actor IN (${manual})`).all(first, ...MANUAL_ACTORS)) at(r.t).interventions++;
  const stalls = STALL_KINDS.map(() => "?").join(",");
  for (const r of db.query(`SELECT t, resolved FROM attention WHERE t >= ? AND kind IN (${stalls})`).all(first, ...STALL_KINDS)) {
    const row = at(r.t);
    row.stalls++;
    if (r.resolved) row.stallMinutes.push((r.resolved - r.t) / 60000);
  }
  for (const r of db.query("SELECT t FROM attention WHERE t >= ? AND kind = 'death'").all(first)) at(r.t).deaths++;
  return out.map((r) => ({
    day: r.day,
    groupHours: r.groupHours,
    interventions: r.interventions,
    interventionsPerGroupHour: r.groupHours ? r.interventions / r.groupHours : null,
    stalls: r.stalls,
    stallsPerGroupHour: r.groupHours ? r.stalls / r.groupHours : null,
    stallMinutes: r.stallMinutes.length ? r.stallMinutes.reduce((a, b) => a + b, 0) / r.stallMinutes.length : null,
    deaths: r.deaths,
  }));
}

/**
 * Level over time for each group's first member (its roster leader) since `since`, as fractional
 * levels, at most one point per `stepMs`. Snapshots are written when a level, HP, mana or zone
 * changes and at least every five minutes.
 */
export function levelTrends(db, roster, since, stepMs = 600000) {
  const ids = new Map(db.query("SELECT id, name FROM characters").all().map((c) => [c.name, c.id]));
  const q = db.query("SELECT t, level, xp_pct FROM char_snapshots WHERE char_id = ? AND t >= ? ORDER BY t");
  return roster.groups
    .filter((g) => g.members?.length && ids.has(g.members[0]))
    .map((g) => {
      const points = [];
      let next = 0;
      for (const r of q.all(ids.get(g.members[0]), since)) {
        if (r.t < next || r.level == null) continue;
        points.push([r.t, r.level + (r.xp_pct ?? 0) / 100]);
        next = r.t + stepMs;
      }
      return { group: g.id, leader: g.members[0], points };
    });
}

/** Open jobs and the latest finished ones. */
export function jobsView(db, recent = 10) {
  return {
    open: db.query("SELECT * FROM jobs WHERE done IS NULL ORDER BY id DESC").all(),
    done: db.query("SELECT * FROM jobs WHERE done IS NOT NULL ORDER BY done DESC LIMIT ?").all(recent),
  };
}
