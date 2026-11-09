// The dashboard's views of the collector database (runs/iq.db) and data/roster.json. Every view is
// a pure function of the database rows and `now`, so the server stays thin and the views can be
// tested on a database built in memory. Reports that need the run logs (tools/groups.mjs,
// tools/plan.mjs) come from those tools, not from here.
import { THRESHOLDS, sessionSummary } from "../iqd.mjs";
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
  // Progress counts XP, not levels: each member's XP over the XP to the target, with its race and
  // class factor, because the late levels cost most of it (the start of level 40 is 12% of 60's).
  const share = (ms) => {
    const need = ms.reduce((a, m) => a + xpStart(target) * factor(m.race, m.class), 0);
    const have = ms.reduce((a, m) => a + (m.level == null ? 0 : Math.min(xpStart(target), xpAt(m.level, m.xpPct ?? 0)) * factor(m.race, m.class)), 0);
    return need ? have / need : 0;
  };
  const groups = roster.groups
    .filter((g) => g.members?.length)
    .map((g) => {
      const members = g.members.map((name) => {
        const c = chars.get(name);
        const snap = c ? latest.get(c.id) : null;
        const level = snap?.level ?? c?.roster_level ?? null;
        return { name, class: c?.class ?? null, race: c?.race ?? null, level, xpPct: snap?.level === level ? (snap?.xp_pct ?? null) : null, seen: snap?.t ?? null };
      });
      return { id: g.id, members, progress: share(members) };
    });
  const members = groups.flatMap((g) => g.members);
  const levels = members.map((m) => m.level).filter((l) => l != null);
  return {
    target,
    groups,
    characters: members.length,
    atTarget: levels.filter((l) => l >= target).length,
    minLevel: levels.length ? Math.min(...levels) : null,
    maxLevel: levels.length ? Math.max(...levels) : null,
    meanLevel: levels.length ? levels.reduce((a, b) => a + b, 0) / levels.length : null,
    progress: share(members),
  };
}

/**
 * Open attention items that are not info, open info items counted by kind, the latest resolved
 * ones and the latest manual interventions (SDK calls and notes started by hand).
 */
export function attentionView(db, now, recent = 25) {
  const open = db.query("SELECT id, t, severity, kind, session, text FROM attention WHERE resolved IS NULL ORDER BY id DESC").all();
  const info = {};
  for (const a of open.filter((x) => x.severity === "info")) info[a.kind] = (info[a.kind] ?? 0) + 1;
  const manual = MANUAL_ACTORS.map(() => "?").join(",");
  return {
    open: open.filter((x) => x.severity !== "info"),
    info,
    resolved: db.query("SELECT id, t, severity, kind, session, text, resolved, note FROM attention WHERE resolved IS NOT NULL AND severity != 'info' ORDER BY resolved DESC LIMIT ?").all(recent),
    manual: db.query(`SELECT id, t, session, actor, text FROM interventions WHERE actor IN (${manual}) ORDER BY id DESC LIMIT ?`).all(...MANUAL_ACTORS, recent),
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

// ---- Names ---------------------------------------------------------------------------------------

/** Characters at this level or above have AA and can join raids (docs/plans/leveling-plan.md, levers 9 and 8). */
export const AA_LEVEL = 46;

/** A coordinator task's slug id as words: the item's name loses punctuation in the slug, so this is a last resort. */
const unslug = (id) => String(id).replace(/^gear-/, "").replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase());

/**
 * What the dashboard needs to give coordinator ids and zone ids names: the opportunities, quest
 * chains and farms of data/*.json, the gear pass's wanted `drops` (the coordinator names a drop errand
 * `drop-<character>-<slot>`), and `zones` mapping a zone's short name to its long name.
 */
export function makeCatalog({ opportunities = [], quests = {}, farms = [], drops = [], zones = {} } = {}) {
  return { opportunities: new Map(opportunities.map((o) => [o.id, o])), quests, farms: new Map(farms.map((f) => [f.id, f])), drops: new Map(drops.map((d) => [`drop-${d.to}-${d.slot}`, d])), zones };
}

/** A zone's long name from its short name, or the short name for a zone the content does not list. */
export const zoneName = (catalog, short) => (short == null ? null : (catalog.zones[short] ?? short));

/** The name of a coordinator opportunity, quest chain, farm or wanted drop by its id. */
export function taskName(catalog, id) {
  if (id == null) return null;
  const o = catalog.opportunities.get(id);
  if (o) return o.item;
  const q = catalog.quests[id];
  if (q) return `${q.class} quest for ${q.reward}`;
  const f = catalog.farms.get(id);
  if (f) return `${f.keep} farm in ${zoneName(catalog, f.zone)}`;
  const wanted = catalog.drops.get(id);
  if (wanted) return `${wanted.item} (${wanted.slot} for ${wanted.to})`;
  const drop = /^drop-(.+)-([a-z0-9]+)$/i.exec(id);
  if (drop) return `${drop[2]} drop for ${drop[1]}`;
  return unslug(id);
}

/** `text` with every coordinator id in it replaced by its name. */
export function nameIds(catalog, text) {
  const ids = [...catalog.opportunities.keys(), ...Object.keys(catalog.quests), ...catalog.farms.keys(), ...catalog.drops.keys()].sort((a, b) => b.length - a.length);
  let out = String(text ?? "");
  for (const id of ids) out = out.replace(new RegExp(`(?<![\\w-])${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`, "g"), taskName(catalog, id));
  return out;
}

/** When the coordinator looks at a history entry's task again: the time the task named, or its opportunity's retry interval. */
export function retryAt(catalog, h) {
  if (h.nextAt) return h.nextAt;
  if (h.kind === "quest") return h.t + (catalog.quests[h.id]?.retryMin ?? 120) * 60000;
  if (!h.id || catalog.farms.has(h.id) || (h.kind !== "hunt" && h.kind !== "errand")) return null;
  return h.t + (catalog.opportunities.get(h.id)?.retryMin ?? (h.id.startsWith("drop-") ? 120 : 30)) * 60000;
}

const TASK_KIND = { hunt: "hunt", handIn: "lightstone hand-in", errand: "errand", quest: "quest", gear: "gear moves", stopErrand: "errand stopped" };
const taskLabel = (catalog, h) => (h.id ? taskName(catalog, h.id) : (TASK_KIND[h.kind] ?? h.kind));

// ---- Attention -----------------------------------------------------------------------------------

/** A stall item older than this needs a person: the bot's own recoveries run in the first minutes. */
export const STALL_AGE_MS = 10 * 60000;
/**
 * What each open attention kind is called, and whether a mechanism handles it: `retry` kinds are
 * tried again by the coordinator or the bot, `ends` kinds end by themselves or by the bot's own
 * remedy. A kind in neither list needs a person, so a new kind is never hidden.
 */
export const KINDS = {
  "alert-task": { label: "failed tasks", how: "retried by the coordinator" },
  "alert-cursor": { label: "items on the cursor", how: "the bot puts them away", ends: true },
  "alert-lootFull": { label: "loot left on corpses", how: "the bot clears bag space", ends: true },
  "alert-guard": { label: "guard escapes", how: "the guard re-enters the zone", ends: true },
  "alert-errand": { label: "ended errands", how: "the rotation takes over", ends: true },
  "alert-crowded": { label: "crowded zones", how: "the rotation moves on", ends: true },
  "alert-rotate": { label: "rotation moves", how: "the rotation moves on", ends: true },
  "alert-autoLevelRestarted": { label: "AutoLevel restarts", how: "the bot restarts it", ends: true },
  "alert-raid": { label: "raid kills", how: "nothing to do", ends: true },
  "alert-deaths": { label: "death costs", how: "the rotation changes zones", ends: true },
  death: { label: "deaths", how: "the bot buys a resurrection", ends: true },
  longtask: { label: "long tasks", how: "the coordinator stops them", ends: true },
  stall: { label: "stalls", how: "the bot restarts AutoLevel", ends: true, needsAfterMs: STALL_AGE_MS },
  nokill: { label: "no kill", how: "the bot restarts AutoLevel", ends: true, needsAfterMs: STALL_AGE_MS },
  gone: { label: "tabs gone", how: "the tab may answer again", ends: true, needsAfterMs: STALL_AGE_MS },
  nobridge: { label: "tabs without bridge", how: "the collector injects the bridge again", ends: true, needsAfterMs: STALL_AGE_MS },
};
/** Names for the kinds that need a person. */
const NEEDS_LABEL = { "alert-bags": "bags full of kept items", "alert-offline": "signed out", "alert-idle": "idle, remedies used up", heap: "page memory high", trigger: "decision", "alert-xpStall": "no XP" };

/**
 * Open attention items split into those a person must act on and those a mechanism handles. A
 * person is needed for a decision, a sign-in, a bags alert, a stall, gone tab or lost bridge older
 * than ten minutes, and for any kind that no list names. The handled items come back as counts per
 * kind for one muted line.
 */
export function needsYouView(open, now, groupOf = new Map()) {
  const needs = [];
  const handled = new Map();
  for (const a of open) {
    if (a.severity === "info") continue;
    const k = KINDS[a.kind];
    const ageMs = now - a.t;
    const person = a.severity === "decide" || !k || (k.needsAfterMs != null && ageMs > k.needsAfterMs);
    if (person) {
      needs.push({ id: a.id, t: a.t, ageMs, severity: a.severity, kind: a.kind, label: k?.label ?? NEEDS_LABEL[a.kind] ?? a.kind, group: groupOf.get(a.session) ?? null, session: a.session, text: a.text });
    } else {
      const h = handled.get(a.kind) ?? { kind: a.kind, label: k.label, how: k.how, n: 0 };
      h.n++;
      handled.set(a.kind, h);
    }
  }
  needs.sort((a, b) => (b.severity === "decide") - (a.severity === "decide") || a.t - b.t);
  return { needs, handled: [...handled.values()].sort((a, b) => b.n - a.n), handledTotal: [...handled.values()].reduce((s, h) => s + h.n, 0) };
}

// ---- Groups --------------------------------------------------------------------------------------

const ACTIVITY_GROUPS = [
  ["fight", (k) => k === "fight"],
  ["move", (k) => k === "approach" || k.startsWith("travel")],
  ["recover", (k) => k === "recover"],
  ["idle", (k) => k.startsWith("idle")],
  ["dead", (k) => k === "dead"],
  ["task", (k) => k === "task"],
];

/** Seconds per activity group (fight, move, recover, idle, dead, task) of a map of activity seconds. */
export function activityMix(sec) {
  const out = Object.fromEntries(ACTIVITY_GROUPS.map(([name]) => [name, 0]));
  for (const [k, v] of Object.entries(sec ?? {})) out[ACTIVITY_GROUPS.find(([, test]) => test(k))?.[0] ?? "task"] += v;
  return out;
}

/** The idle cause with the most seconds in a map of activity seconds ("idle/afterKill" gives "afterKill"). */
const idleCauseOf = (sec) => Object.entries(sec ?? {}).filter(([k, v]) => k.startsWith("idle") && v > 0).sort((a, b) => b[1] - a[1])[0]?.[0].replace(/^idle\/?/, "") || null;

/** The open sessions with their summary and the bot state the summary leaves out, by group id. */
function sessionsByGroup(db, now, groupOf) {
  const out = new Map();
  for (const s of db.query("SELECT * FROM sessions WHERE ended IS NULL ORDER BY last_seen, id").all()) {
    const v = sessionSummary(s, now, groupOf);
    const bot = (s.snap ? JSON.parse(s.snap) : null)?.bot ?? {};
    if (v.group) out.set(v.group, { ...v, bot: { enabled: bot.enabled !== false, rotation: bot.rotation ?? [], crowdedAt: bot.crowdedAt ?? {}, task: bot.task ?? null } });
  }
  return out;
}

/** What the group does now: gone, parked, raiding, an activity with its cause and age, or nothing known. */
function stateOf(v) {
  if (!v) return { kind: "none" };
  if (v.goneMs != null) return { kind: "gone", forMs: v.goneMs };
  if (v.parked) return { kind: "parked" };
  if (v.raid) return { kind: "raid" };
  if (v.activity) return { kind: "activity", act: v.activity.act, why: v.activity.why, forMs: v.activity.forMs };
  return { kind: v.autoLevel?.running ? "running" : "off" };
}

/**
 * A bot task as the row and the coordinator panel show it: its name from the coordinator's history
 * (the bot knows only the task's kind and step), how long it runs or ended, its outcome and when
 * the coordinator looks at it again.
 */
export function taskView(catalog, task, history, now) {
  if (!task) return null;
  const h = history.find((x) => x.task === task.id);
  const retry = h ? retryAt(catalog, h) : (task.nextAt ?? null);
  return {
    id: task.id,
    kind: task.kind,
    name: h ? taskLabel(catalog, h) : (TASK_KIND[task.kind] ?? task.kind),
    status: task.status,
    step: task.step ?? null,
    forMs: task.status === "running" && task.startedAt ? now - task.startedAt : null,
    agoMs: task.endedAt ? now - task.endedAt : null,
    result: task.result ?? null,
    error: task.error ?? null,
    retryInMs: task.status === "running" || retry == null ? null : retry - now,
  };
}

/**
 * One row per roster group with the columns the page compares: level and its share of the XP to
 * level 60, zone, what the group does and for how long, XP per hour, idle share with its main
 * cause, the bot's task, and the details a click opens. `report` is tools/groups.mjs's rows of the
 * last hour, which give the idle share and cause over that hour. Without a report row the last 10
 * minutes of the tab's own activity seconds stand in.
 */
export function groupRowsView(db, now, { roster, groupOf, catalog, report = null }) {
  const sessions = sessionsByGroup(db, now, groupOf);
  const history = (metaRow(db, "coordinator")?.history ?? []).slice().reverse();
  const reportOf = new Map((report ?? []).map((r) => [r.group, r]));
  const tail = (q, ...args) => db.query(q).all(...args);
  return roster.groups.map((g) => {
    const v = sessions.get(g.id) ?? null;
    const leader = v?.leader ?? g.members[0].name;
    const state = stateOf(v);
    const r = reportOf.get(g.id);
    const idleShare = r?.idle ?? v?.idleShare ?? null;
    const task = taskView(catalog, v?.bot.task, history, now);
    const levels = (v?.party ?? []).map((m) => m.level).filter((l) => l != null);
    const stuck = state.kind === "gone" || (state.kind === "activity" && (state.act === "idle" || state.act === "dead") && state.forMs > 120000) || (v != null && !v.parked && !v.raid && v.lastKillMs != null && v.lastKillMs > 300000);
    const mine = history.filter((h) => h.label === leader);
    const lines = [
      ...tail("SELECT t, actor AS source, text FROM interventions WHERE session = ? ORDER BY id DESC LIMIT 8", leader),
      ...tail("SELECT t, 'alert' AS source, text FROM attention WHERE session = ? AND severity != 'info' ORDER BY id DESC LIMIT 8", leader),
    ]
      .sort((a, b) => b.t - a.t)
      .slice(0, 8)
      .map((x) => ({ t: x.t, source: x.source, text: nameIds(catalog, x.text) }));
    return {
      id: g.id,
      leader,
      hasTab: v != null,
      playing: v != null && state.kind !== "gone" && state.kind !== "parked" && state.kind !== "off" && state.kind !== "none",
      state,
      stuck,
      level: v?.level ?? null,
      xpPct: v?.xpPct ?? null,
      partyMin: levels.length ? Math.min(...levels) : null,
      partyMax: levels.length ? Math.max(...levels) : null,
      share: g.progress ?? null,
      zone: v?.zone ?? null,
      xpPerHour: v?.xpPerHour ?? null,
      idleShare,
      idleCause: r ? (r.idleCause ?? null) : idleCauseOf(v?.activitySec),
      idleWindow: r ? "hour" : "10 minutes",
      waitedFor: r?.waitedFor ?? null,
      activitySec: v?.activitySec ?? null,
      task,
      lastKillMs: v?.lastKillMs ?? null,
      details: {
        party: v?.party ?? [],
        bags: v?.bags ?? null,
        heap: v?.heap ?? null,
        pause: v?.pause ?? null,
        errand: v?.errand ?? null,
        rotation: (v?.bot.rotation ?? []).map((z) => ({ zone: zoneName(catalog, z), crowdedMs: v.bot.crowdedAt[z] ? now - v.bot.crowdedAt[z] : null })),
        crowded: Object.entries(v?.bot.crowdedAt ?? {}).filter(([z]) => !(v.bot.rotation ?? []).includes(z)).map(([z, at]) => ({ zone: zoneName(catalog, z), crowdedMs: now - at })),
        lines,
        history: mine.slice(0, 12).map((h) => ({ t: h.t, kind: h.kind, name: taskLabel(catalog, h), ms: h.ms ?? null, retryAt: retryAt(catalog, h), outcome: h.task && h.task === v?.bot.task?.id ? { status: v.bot.task.status, result: v.bot.task.result, error: v.bot.task.error } : null })),
      },
    };
  });
}

/** All groups' activity seconds of the last 10 minutes by activity group, the live part of "Where time goes". */
export function mixView(rows) {
  const total = activityMix(null);
  for (const r of rows) for (const [k, v] of Object.entries(activityMix(r.activitySec))) total[k] += v;
  return total;
}

// ---- Status, goal and coordinator ----------------------------------------------------------------

const metaRow = (db, k) => {
  const row = db.query("SELECT v FROM meta WHERE k = ?").get(k);
  return row ? JSON.parse(row.v) : null;
};

/**
 * XP per hour gained by the roster leaders over the last `hours`, from their level snapshots, as
 * the sum of each leader's rate over the time its snapshots span (at least an hour). It counts net
 * XP, so hand-ins add and deaths subtract. Null when no leader has snapshots with XP over an hour.
 */
export function xpRate(db, roster, now, hours = 24) {
  const chars = new Map(db.query("SELECT id, name, class, race FROM characters").all().map((c) => [c.name, c]));
  let perHour = 0;
  let leaders = 0;
  for (const g of roster.groups) {
    const c = chars.get(g.members?.[0]?.name);
    if (!c) continue;
    const from = db.query("SELECT t, level, xp_pct FROM char_snapshots WHERE char_id = ? AND t >= ? AND xp_pct IS NOT NULL ORDER BY t LIMIT 1").get(c.id, now - hours * 3600000);
    const to = db.query("SELECT t, level, xp_pct FROM char_snapshots WHERE char_id = ? AND xp_pct IS NOT NULL ORDER BY t DESC LIMIT 1").get(c.id);
    if (!from || !to || to.t - from.t < 3600000) continue;
    perHour += ((xpAt(to.level, to.xp_pct) - xpAt(from.level, from.xp_pct)) * factor(c.race, c.class)) / ((to.t - from.t) / 3600000);
    leaders++;
  }
  return leaders ? { perHour, leaders } : null;
}

/** Colour thresholds of the status line. Idle shares and page memory turn amber, then red. */
export const STATUS_LIMITS = { idleWarn: 0.15, idleBad: 0.3, heapWarn: 0.6, heapBad: THRESHOLDS.heapShare };

/**
 * The status line: collector, relay, groups playing, XP per hour now and over 24 hours, idle share
 * of the last hour, items that need a person and the largest tab memory. Each item has a level of
 * "ok", "warn" or "bad", so the line stays calm while everything works.
 */
export function statusView({ now, daemon, rows, needs, xp24 }) {
  const age = daemon?.last ? now - daemon.last : null;
  const alive = Boolean(daemon && age != null && age < (daemon.intervalSec * 3 + 10) * 1000);
  const playing = rows.filter((r) => r.playing).length;
  const xpNow = rows.reduce((a, r) => a + (r.xpPerHour ?? 0), 0);
  const idles = rows.map((r) => r.idleShare).filter((x) => x != null);
  const idle = idles.length ? idles.reduce((a, b) => a + b, 0) / idles.length : null;
  const heapRow = rows.filter((r) => r.details.heap).sort((a, b) => b.details.heap.used / b.details.heap.limit - a.details.heap.used / a.details.heap.limit)[0];
  const heapShare = heapRow ? heapRow.details.heap.used / heapRow.details.heap.limit : null;
  const need = needs.needs.length;
  return [
    { id: "collector", label: "Collector", value: alive ? "running" : daemon ? "not running" : "not started", level: alive ? "ok" : "bad", ageMs: age, title: age != null ? `Last cycle ${Math.round(age / 1000)} s ago` : undefined },
    { id: "relay", label: "Relay", value: daemon?.relay ? "up" : "down", level: daemon?.relay ? "ok" : "bad" },
    { id: "playing", label: "Groups playing", value: `${playing} / ${rows.length}`, level: playing === rows.length ? "ok" : playing >= rows.length * 0.75 ? "warn" : "bad" },
    { id: "xp", label: "XP/h now", value: xpNow, level: "ok", title: "Sum of the groups' leaders' kill XP over the last 30 minutes" },
    { id: "xp24", label: "XP/h, 24 h", value: xp24?.perHour ?? null, level: "ok", title: xp24 ? `Net XP of ${xp24.leaders} leaders over the last 24 hours, from their level snapshots` : "No leader has snapshots with XP over an hour yet" },
    { id: "idle", label: "Idle, last hour", value: idle, level: idle == null ? "ok" : idle >= STATUS_LIMITS.idleBad ? "bad" : idle >= STATUS_LIMITS.idleWarn ? "warn" : "ok", title: "Mean idle share of the groups over the last hour" },
    { id: "needs", label: "Needs you", value: need, level: need === 0 ? "ok" : need >= 3 || needs.needs.some((n) => n.severity === "decide") ? "bad" : "warn" },
    { id: "memory", label: "Max tab memory", value: heapRow ? heapRow.details.heap.used : null, share: heapShare, tab: heapRow?.id ?? null, level: heapShare == null ? "ok" : heapShare >= STATUS_LIMITS.heapBad ? "bad" : heapShare >= STATUS_LIMITS.heapWarn ? "warn" : "ok" },
  ];
}

/**
 * One entry per success criterion of the goal (docs/plans/leveling-plan.md): `share` is its bar
 * from 0 to 1 and null where nothing measures it yet, with the numbers the collector has.
 */
export function goalView(db, { roster, plan, groupOf, catalog }) {
  const members = roster.groups.flatMap((g) => g.members);
  const eta = (plan?.groups ?? []).filter((g) => g.eta?.[roster.target]).map((g) => ({ group: groupOf.get(g.leader) ?? null, leader: g.leader, ...g.eta[roster.target], slowest: g.slowest }));
  const slowest = eta.sort((a, b) => b.hours - a.hours)[0] ?? null;
  const coordinator = metaRow(db, "coordinator");
  const gear = metaRow(db, "gear");
  const questPieces = [...catalog.opportunities.values()].filter((o) => o.quest);
  const missing = coordinator?.last?.missing ?? {};
  const wanted = questPieces.filter((o) => (missing[o.id] ?? 0) > 0);
  const reached = members.filter((m) => (m.level ?? 0) >= AA_LEVEL).length;
  return {
    levels: { share: roster.progress, atTarget: roster.atTarget, characters: roster.characters, target: roster.target, minLevel: roster.minLevel, meanLevel: roster.meanLevel, maxLevel: roster.maxLevel, slowest, noEstimate: plan?.idle ?? [], planWindowMin: plan?.windowMin ?? null },
    gear: { share: null, moves: gear?.moves ?? null, drops: gear?.drops?.length ?? null, passT: gear?.t ?? null },
    aa: { share: null, level: AA_LEVEL, reached, characters: roster.characters },
    epics: { share: null, missingCopies: wanted.reduce((a, o) => a + missing[o.id], 0), missingPieces: wanted.length, passT: coordinator?.last?.t ?? null },
    raids: { share: null, level: AA_LEVEL, reached, characters: roster.characters },
  };
}

/** A retry that came due longer ago than this is not waiting for its turn but for a group that fits it, and is left out of the panel. */
const RETRY_GRACE_MS = 30 * 60000;

/**
 * The coordinator panel: running tasks, next retries, the running experiment and recent outcomes,
 * with item and quest names. The bot keeps only each tab's latest task, so the outcomes are those.
 */
export function coordinatorView(db, now, { catalog, rows, groupOf }) {
  const state = metaRow(db, "coordinator");
  if (!state) return null;
  const history = state.history ?? [];
  const tasks = rows.filter((r) => r.task).map((r) => ({ group: r.id, leader: r.leader, ...r.task }));
  const running = tasks.filter((t) => t.status === "running").sort((a, b) => b.forMs - a.forMs);
  const outcomes = tasks
    .filter((t) => t.status !== "running" && t.agoMs != null)
    .sort((a, b) => a.agoMs - b.agoMs)
    .map((t) => ({ group: t.group, name: t.name, step: t.step, status: t.status, result: t.result, error: t.error, agoMs: t.agoMs }));
  // The newest history entry of each opportunity (of each tab for a quest) says when it comes up again.
  const latest = new Map();
  for (const h of history) latest.set(h.kind === "quest" ? `${h.id}@${h.label}` : (h.id ?? `${h.kind}@${h.label}`), h);
  const missing = state.last?.missing ?? {};
  const runningIds = new Set(running.map((t) => t.id));
  const retries = [...latest.values()]
    .filter((h) => h.id && !runningIds.has(h.task) && missing[h.id] !== 0)
    .map((h) => ({ at: retryAt(catalog, h), h }))
    .filter((x) => x.at != null && x.at > now - RETRY_GRACE_MS)
    .sort((a, b) => a.at - b.at)
    .map(({ at, h }) => ({ inMs: at - now, group: groupOf.get(h.label) ?? null, name: taskLabel(catalog, h) }));
  const ex = state.experiments ?? {};
  const live = Object.entries(ex.running ?? {}).map(([name, x]) => ({ name, sinceMs: ex.started?.[name] ? now - ex.started[name] : null, a: x.a ?? [], b: x.b ?? [] }));
  const ended = Object.entries(ex.ended ?? {}).sort((a, b) => b[1] - a[1])[0];
  const decisions = db
    .query("SELECT t, session, text FROM interventions WHERE actor = 'coordinator' ORDER BY id DESC LIMIT 10")
    .all()
    .map((x) => ({ t: x.t, group: groupOf.get(x.session) ?? null, text: nameIds(catalog, x.text) }));
  return {
    passAgeMs: state.last ? now - state.last.t : null,
    stock: state.last?.stock ?? {},
    running,
    retries,
    experiment: { running: live, lastEnded: ended ? { name: ended[0], agoMs: now - ended[1] } : null },
    outcomes,
    decisions,
  };
}
