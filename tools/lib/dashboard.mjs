// The dashboard's views of the collector database (runs/iq.db) and data/roster.json. Every view is
// a pure function of the database rows and `now`, so the server stays thin and the views can be
// tested on a database built in memory. Reports that need the run logs (tools/groups.mjs,
// tools/plan.mjs) come from those tools, not from here.
import { THRESHOLDS, sessionSummary } from "../iqd.mjs";
import { MINUTE_MS } from "./minutes.mjs";
import { targetId, targetRetryMin } from "./acquire.mjs";
import { KINDS, needsPerson } from "./attention.mjs";
import { retryTime, worldHold } from "./coordinator.mjs";
import { factor, xpAt, xpStart } from "./xp.mjs";
import { progressCounts } from "./progress.mjs";
import { cardsFor } from "./cards.mjs";

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
 * ones grouped for the alert history (`historyView`) and the latest manual interventions (SDK calls
 * and notes started by hand).
 */
export function attentionView(db, now, { recent = 25, groupOf = new Map() } = {}) {
  const open = db.query("SELECT id, t, severity, kind, session, text FROM attention WHERE resolved IS NULL ORDER BY id DESC").all();
  const info = {};
  for (const a of open.filter((x) => x.severity === "info")) info[a.kind] = (info[a.kind] ?? 0) + 1;
  const manual = MANUAL_ACTORS.map(() => "?").join(",");
  return {
    open: open.filter((x) => x.severity !== "info"),
    info,
    resolved: historyView(db.query("SELECT id, t, severity, kind, session, text, resolved, note FROM attention WHERE resolved IS NOT NULL AND severity != 'info' ORDER BY resolved DESC LIMIT ?").all(recent), groupOf),
    manual: db.query(`SELECT id, t, session, actor, text FROM interventions WHERE actor IN (${manual}) ORDER BY id DESC LIMIT ?`).all(...MANUAL_ACTORS, recent),
  };
}

/**
 * Resolved items for the alert history, newest end first: items of one kind that ended the same
 * way share a row with their groups, the time the first was raised and the longest any took.
 */
export function historyView(resolved, groupOf = new Map()) {
  const rows = new Map();
  for (const x of resolved) {
    const key = `${x.kind}|${x.note ?? ""}`;
    const r = rows.get(key) ?? { kind: x.kind, title: itemTitle(x.kind), note: x.note ?? null, text: x.text, t: x.t, resolved: x.resolved, tookMs: 0, groups: [], n: 0 };
    const g = groupOf.get(x.session) ?? x.session;
    if (g && !r.groups.includes(g)) r.groups.push(g);
    r.t = Math.min(r.t, x.t);
    r.tookMs = Math.max(r.tookMs, x.resolved - x.t);
    r.n++;
    rows.set(key, r);
  }
  return [...rows.values()].map((r) => ({ ...r, groups: r.groups.sort((x, y) => Number(String(x).slice(1)) - Number(String(y).slice(1))) }));
}

/**
 * Engineering health per local day over the last `days` days: group-hours played (the time each
 * open or ended session was seen, parked tabs left out), manual interventions and stalls, both per
 * group-hour, the stalls' mean minutes to resolution, and the deaths of the character each tab
 * plays, from the minute totals. These are the numbers the goal asks to fall over time.
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
  for (const r of db.query("SELECT minute, deaths FROM minutes WHERE minute >= ? AND deaths > 0").all(Math.floor(first / 60000))) at(r.minute * 60000).deaths += r.deaths;
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

/**
 * A coordinator task's slug id as words, a last resort: the item's name loses punctuation in the
 * slug, a gear target's id (`target-<zone>-<npc>`) reads as the enemy in its zone, and a look or a
 * raid for a boss by the boss's key (`look:<key>`, `boss:summon:<key>`, `boss:open:<key>`).
 */
const unslug = (id, catalog) => {
  const target = /^target-([a-z0-9]+)-(.+)$/.exec(String(id));
  if (target) return `${target[2].replace(/-/g, " ")} in ${zoneName(catalog, target[1])}`;
  const boss = /^(look|boss:summon|boss:open):(.+)$/.exec(String(id));
  if (boss) return `${boss[1] === "look" ? "a look for" : "a raid on"} ${boss[2]}`;
  return String(id).replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase());
};

/**
 * What the dashboard needs to give coordinator ids and zone ids names: the opportunities, quest
 * chains and farms of data/*.json, the gear pass's wanted `targets` (the coordinator names a gear
 * errand `target-<zone>-<npc>`, `targetId`), and `zones` mapping a zone's short name to its long name.
 */
export function makeCatalog({ opportunities = [], quests = {}, farms = [], targets = [], zones = {} } = {}) {
  return { opportunities: new Map(opportunities.map((o) => [o.id, o])), quests, farms: new Map(farms.map((f) => [f.id, f])), targets: new Map(targets.map((t) => [targetId(t), t])), zones };
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
  const target = catalog.targets.get(id);
  if (target) return `${target.npc} in ${zoneName(catalog, target.zone)} (${target.items.map((w) => w.item).join(", ")})`;
  return unslug(id, catalog);
}

/** What a task is after in a word or two: an opportunity's item, a quest's reward, a farm's enemy or a target's enemy. */
export function taskSubject(catalog, id) {
  if (id == null) return null;
  const o = catalog.opportunities.get(id);
  if (o) return o.item;
  const q = catalog.quests[id];
  if (q) return q.reward;
  const f = catalog.farms.get(id);
  if (f) return f.keep;
  const target = catalog.targets.get(id);
  if (target) return npcName(target.npc);
  return unslug(id, catalog);
}

/** `text` with every coordinator id in it replaced by its name. */
export function nameIds(catalog, text) {
  const ids = [...catalog.opportunities.keys(), ...Object.keys(catalog.quests), ...catalog.farms.keys(), ...catalog.targets.keys()].sort((a, b) => b.length - a.length);
  let out = String(text ?? "");
  for (const id of ids) out = out.replace(new RegExp(`(?<![\\w-])${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`, "g"), taskName(catalog, id));
  return out;
}

/**
 * When the coordinator looks at a history entry's task again, by its own rule (`retryTime` and,
 * for a quest, `worldHold` in tools/lib/coordinator.mjs), with `history` the coordinator's history
 * and `code` the code version the tabs run. Null for a task kind that does not come back.
 */
export function retryAt(catalog, h, { history = [], code = null } = {}) {
  if (h.kind === "quest") return Math.max(retryTime(h, catalog.quests[h.id]?.retryMin ?? 120, code), worldHold(history, h.id, code));
  if (h.nextAt) return h.nextAt;
  if (!h.id || catalog.farms.has(h.id) || (h.kind !== "hunt" && h.kind !== "errand")) return null;
  return retryTime(h, catalog.opportunities.get(h.id)?.retryMin ?? (h.id.startsWith("target-") ? targetRetryMin(h.kind) : 30), code);
}

/** An enemy's name as the game shows it: the content marks named enemies with a leading "#" and spaces with "_". */
export const npcName = (name) => String(name ?? "").replace(/^#/, "").replace(/_/g, " ");

/**
 * The gear pass's most wanted enemies for the dashboard, best first: every enemy a group hunts or
 * has queued, then the `limit` best of the rest, with zone names in full, the coordinator's reason
 * by `targetId` (`evaluations`, from `decide`: a `state` with its facts and the best `plan`), and
 * each item with its taker and the taker's group.
 */
export function mostWantedView(targets, { catalog, groupOf = new Map(), evaluations = {}, limit = 15 }) {
  const active = (t) => ["hunting", "queued"].includes(evaluations[targetId(t)]?.state);
  return [...targets.filter(active), ...targets.filter((t) => !active(t)).slice(0, limit)].map((t) => {
    const { plan = null, ...why } = evaluations[targetId(t)] ?? {};
    return {
      npc: npcName(t.npc),
      zone: zoneName(catalog, t.zone),
      level: t.npcLevel ?? null,
      why: why.state ? { ...why, ...(why.by ? { by: why.by.map(npcName) } : {}) } : null,
      plan,
      items: t.items.map((w) => ({ item: w.item, itemId: w.itemId, to: w.to, group: groupOf.get(w.to) ?? null, slot: w.slot, gain: w.gain / 10, hours: w.hours, takers: w.takers ?? 1 })),
    };
  });
}

const TASK_KIND = { hunt: "hunt", handIn: "lightstone hand-in", errand: "errand", quest: "quest", gear: "gear moves", stopErrand: "errand stopped", look: "look", raid: "raid" };
// A trip's task names all its enemies (`ids`), and reads as its first one and how many more.
const taskLabel = (catalog, h) => (h.id ? `${taskName(catalog, h.id)}${h.ids?.length > 1 ? ` and ${h.ids.length - 1} more` : ""}` : (TASK_KIND[h.kind] ?? h.kind));

// ---- Attention -----------------------------------------------------------------------------------

/** What one item of each kind is called on the page. */
const TITLE = { "alert-bags": "Bags full of kept items", "alert-offline": "Signed out", "alert-idle": "Idle after every remedy", heap: "Page memory high", trigger: "Decision", "alert-xpStall": "No XP", client: "Client update breaks the bot", "alert-switch": "Leader not in play", stall: "Stalled", nokill: "No kills", gone: "Tab gone", nobridge: "Bridge missing", "alert-task": "Task failed", "alert-cursor": "Item on the cursor", "alert-lootFull": "Loot left on a corpse", "alert-guard": "Guard escape", "alert-errand": "Errand ended", "alert-crowded": "Zone crowded", "alert-rotate": "Zone move failed", "alert-autoLevelRestarted": "AutoLevel restarted", "alert-raid": "Raid not ended", "alert-deaths": "Deaths", death: "Death", longtask: "Task ran long", "alert-clientUpdate": "Client update" };
export const itemTitle = (kind) => TITLE[kind] ?? kind;

/**
 * Open attention items split into those a person must act on and those a mechanism handles
 * (`needsPerson`, tools/lib/attention.mjs). Needs of one kind with one text on several tabs share a
 * card that lists their groups. The handled items come back as counts per kind for one muted line.
 */
export function needsYouView(open, now, groupOf = new Map()) {
  const cards = new Map();
  const handled = new Map();
  for (const a of open) {
    if (a.severity === "info") continue;
    const k = KINDS[a.kind];
    const person = needsPerson(a, now);
    if (person) {
      const key = `${a.kind}|${a.text}`;
      const c = cards.get(key) ?? { id: a.id, t: a.t, severity: a.severity, kind: a.kind, label: itemTitle(a.kind), groups: [], text: a.text };
      const g = groupOf.get(a.session);
      if (g && !c.groups.includes(g)) c.groups.push(g);
      c.t = Math.min(c.t, a.t);
      cards.set(key, c);
    } else {
      const h = handled.get(a.kind) ?? { kind: a.kind, label: k.label, how: k.how, n: 0 };
      h.n++;
      handled.set(a.kind, h);
    }
  }
  const needs = [...cards.values()].map((c) => ({ ...c, ageMs: now - c.t, groups: c.groups.sort((x, y) => Number(x.slice(1)) - Number(y.slice(1))) }));
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

const activityGroup = (key) => ACTIVITY_GROUPS.find(([, test]) => test(key))?.[0] ?? "task";

// ---- Minute totals ---------------------------------------------------------------------------------

/** The group timeline covers this many minutes, one cell each. */
export const TIMELINE_MINUTES = 120;
/** "Where time goes" shows this many hourly bars. */
export const HOURLY_BARS = 24;
/** Minute totals of the last hours that a view needs, `Map<group, [{ minute, sec, xp, deaths }]>` oldest first. */
export function minuteTotals(db, now, hours = HOURLY_BARS + 1) {
  const out = new Map();
  for (const r of db.query("SELECT grp, minute, sec, xp, deaths FROM minutes WHERE minute >= ? ORDER BY minute").all(Math.floor(now / MINUTE_MS) - hours * 60)) {
    if (!out.has(r.grp)) out.set(r.grp, []);
    out.get(r.grp).push({ minute: r.minute, sec: JSON.parse(r.sec), xp: r.xp, deaths: r.deaths });
  }
  return out;
}

const total = (sec) => Object.values(sec).reduce((a, b) => a + b, 0);

/**
 * A group's last two hours as one cell per minute that has data: `m` is the minute's offset from
 * the window's start, `k` the activity group with the most seconds (fight, move, recover, idle,
 * dead or task), `i` the main idle cause of an idle minute, `mix` the seconds per activity group,
 * `d` the deaths and `x` the XP. `spans` are task spans as minute offsets from the window's start,
 * `[{ from, to, name, status }]` clipped to the window. A minute without data has no cell.
 */
export function timelineView(minutes, now, spans = []) {
  const end = Math.floor(now / MINUTE_MS);
  const start = end - TIMELINE_MINUTES + 1;
  const cells = [];
  for (const r of minutes) {
    if (r.minute < start || r.minute > end) continue;
    const mix = activityMix(r.sec);
    const top = Object.entries(mix).sort((a, b) => b[1] - a[1])[0];
    cells.push({ m: r.minute - start, k: top[1] > 0 ? top[0] : null, i: top[0] === "idle" ? idleCauseOf(r.sec) : null, mix: Object.fromEntries(Object.entries(mix).filter(([, v]) => v >= 0.5).map(([k, v]) => [k, Math.round(v)])), d: r.deaths, x: r.xp });
  }
  const clipped = spans
    .map((s) => ({ from: (s.from - start * MINUTE_MS) / MINUTE_MS, to: (s.to - start * MINUTE_MS) / MINUTE_MS, name: s.name, status: s.status }))
    .filter((s) => s.to > 0 && s.from < TIMELINE_MINUTES)
    .map((s) => ({ ...s, from: Math.max(0, s.from), to: Math.min(TIMELINE_MINUTES, s.to) }));
  return { start: start * MINUTE_MS, minutes: TIMELINE_MINUTES, cells, spans: clipped };
}

/** The idle share and main idle cause of the last hour in a group's minute rows, or null with under five minutes of data. */
function lastHour(minutes, now) {
  const from = Math.floor(now / MINUTE_MS) - 59;
  const sec = {};
  for (const r of minutes) if (r.minute >= from) for (const [k, v] of Object.entries(r.sec)) sec[k] = (sec[k] ?? 0) + v;
  const all = total(sec);
  if (all < 300) return null;
  const idle = Object.entries(sec).filter(([k]) => activityGroup(k) === "idle").reduce((a, [, v]) => a + v, 0);
  return { share: idle / all, cause: idleCauseOf(sec) };
}

const hourStart = (t) => new Date(t).setMinutes(0, 0, 0);
/** A bar's segment: the activity group, with an idle minute split by its cause. */
const barKey = (key) => (activityGroup(key) === "idle" ? (key.includes("/") ? key : "idle/other") : activityGroup(key));

/**
 * The last `HOURLY_BARS` local hours of all groups' time: per hour the seconds by segment (fight,
 * move, recover, dead, task and `idle/<cause>`), the group-hours recorded, XP and deaths. The
 * current hour is partial. An hour without minute totals is an empty bar.
 */
export function hourlyView(minutes, now, hours = HOURLY_BARS) {
  const starts = [];
  for (let t = hourStart(now); starts.length < hours; t = hourStart(t - 1)) starts.unshift(t);
  const bars = new Map(starts.map((t) => [t, { t, sec: {}, groupHours: 0, xp: 0, deaths: 0, partial: t === starts.at(-1) }]));
  for (const rows of minutes.values()) {
    for (const r of rows) {
      const bar = bars.get(hourStart(r.minute * MINUTE_MS));
      if (!bar) continue;
      for (const [k, v] of Object.entries(r.sec)) {
        const key = barKey(k);
        bar.sec[key] = (bar.sec[key] ?? 0) + v;
        bar.groupHours += v / 3600;
      }
      bar.xp += r.xp;
      bar.deaths += r.deaths;
    }
  }
  return [...bars.values()].map((b) => ({ ...b, sec: Object.fromEntries(Object.entries(b.sec).map(([k, v]) => [k, Math.round(v)])) }));
}

/**
 * XP per hour over the last `hours`: each group's net XP (kills and hand-ins, minus deaths) over
 * the time it recorded, summed over the groups that recorded at least an hour. Null without any.
 */
export function xpRate(minutes, now, hours = 24) {
  const from = Math.floor(now / MINUTE_MS) - hours * 60;
  let perHour = 0;
  let groups = 0;
  for (const rows of minutes.values()) {
    const mine = rows.filter((r) => r.minute >= from);
    const sec = mine.reduce((a, r) => a + total(r.sec), 0);
    if (sec < 3600) continue;
    perHour += mine.reduce((a, r) => a + r.xp, 0) / (sec / 3600);
    groups++;
  }
  return groups ? { perHour, groups } : null;
}

/** The outcome the collector wrote into a coordinator history entry (`settleHistory`), or null while the task has none. */
const outcomeOf = (h) => (h.status ? { status: h.status, result: h.result ?? null, error: h.error ?? null, step: h.step ?? null, endedAt: h.endedAt ?? (h.ms ? h.t + h.ms : null) } : null);

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
 * the coordinator looks at it again under the tabs' code version `code`. A running `errand` shows
 * instead of a task that has ended.
 */
export function taskView(catalog, task, history, now, errand = null, code = null) {
  // An errand runs inside normal hunting, between and after tasks, so while one runs and no task
  // does, the errand is what the group is doing.
  if (errand && task?.status !== "running") {
    return { id: null, kind: "errand", name: errand.item ?? errand.keep, subject: errand.item ?? errand.keep, status: "running", step: `errand for ${errand.keep} in ${zoneName(catalog, errand.zone)}${errand.until ? `, ends in ${Math.max(0, Math.round((errand.until - now) / 60000))} min` : ""}`, forMs: errand.since ? now - errand.since : null, agoMs: null, result: null, error: null, retryInMs: null };
  }
  if (!task) return null;
  const h = history.find((x) => x.task === task.id);
  const retry = h ? retryAt(catalog, h, { history, code }) : (task.nextAt ?? null);
  return {
    id: task.id,
    kind: task.kind,
    name: h ? taskLabel(catalog, h) : (TASK_KIND[task.kind] ?? task.kind),
    subject: h?.id ? taskSubject(catalog, h.id) : null,
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
 * cause, the bot's task, the two-hour timeline, and the details a click opens. The idle share and
 * cause are the last hour's, from the minute totals, else from `report` (tools/groups.mjs's rows of
 * the last hour), else from the tab's own last 10 minutes.
 */
export function groupRowsView(db, now, { roster, groupOf, catalog, report = null, minutes = minuteTotals(db, now) }) {
  const sessions = sessionsByGroup(db, now, groupOf);
  const history = (metaRow(db, "coordinator")?.history ?? []).slice().reverse();
  const code = metaRow(db, "daemon")?.code ?? null;
  const reportOf = new Map((report ?? []).map((r) => [r.group, r]));
  const tail = (q, ...args) => db.query(q).all(...args);
  return roster.groups.map((g) => {
    const v = sessions.get(g.id) ?? null;
    const leader = v?.leader ?? g.members[0].name;
    const state = stateOf(v);
    const r = reportOf.get(g.id);
    const hour = lastHour(minutes.get(g.id) ?? [], now);
    const idleShare = hour?.share ?? r?.idle ?? v?.idleShare ?? null;
    const task = taskView(catalog, v?.bot.task, history, now, v?.errand, code);
    const levels = (v?.party ?? []).map((m) => m.level).filter((l) => l != null);
    const stuck = state.kind === "gone" || (state.kind === "activity" && (state.act === "idle" || state.act === "dead") && state.forMs > 120000) || (v != null && !v.parked && !v.raid && v.lastKillMs != null && v.lastKillMs > 300000);
    const mine = history.filter((h) => h.label === leader);
    // Task spans: finished tasks from the coordinator's history (queued at `t`, took `ms`) and the task running now.
    const spans = [
      ...mine.filter((h) => h.ms).map((h) => ({ from: h.t, to: h.t + h.ms, name: taskLabel(catalog, h), status: h.status ?? "done" })),
      ...(task?.status === "running" && v?.bot?.task?.startedAt ? [{ from: v.bot.task.startedAt, to: now, name: task.name, status: "running" }] : []),
    ];
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
      idleCause: hour ? hour.cause : r ? (r.idleCause ?? null) : idleCauseOf(v?.activitySec),
      idleWindow: hour || r ? "hour" : "10 minutes",
      waitedFor: r?.waitedFor ?? null,
      timeline: timelineView(minutes.get(g.id) ?? [], now, spans),
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
        history: mine.slice(0, 12).map((h) => ({ t: h.t, kind: h.kind, name: taskLabel(catalog, h), ms: h.ms ?? null, retryAt: retryAt(catalog, h, { history, code }), outcome: outcomeOf(h) })),
        progress: progressRows(db, now - 2 * DAY, { group: g.id, limit: 8 }),
      },
    };
  });
}

// ---- Status, goal and coordinator ----------------------------------------------------------------

const metaRow = (db, k) => {
  const row = db.query("SELECT v FROM meta WHERE k = ?").get(k);
  return row ? JSON.parse(row.v) : null;
};

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
    { id: "xp24", label: "XP/h, 24 h", value: xp24?.perHour ?? null, level: "ok", title: xp24 ? `Net XP per recorded hour of ${xp24.groups} groups over the last 24 hours, from the minute totals` : "Minute totals start when the collector runs the version that writes them" },
    { id: "idle", label: "Idle, last hour", value: idle, level: idle == null ? "ok" : idle >= STATUS_LIMITS.idleBad ? "bad" : idle >= STATUS_LIMITS.idleWarn ? "warn" : "ok", title: "Mean idle share of the groups over the last hour, from the minute totals" },
    { id: "needs", label: "Needs you", value: need, level: need === 0 ? "ok" : need >= 3 || needs.needs.some((n) => n.severity === "decide") ? "bad" : "warn" },
    { id: "memory", label: "Max tab memory", value: heapRow ? heapRow.details.heap.used : null, share: heapShare, tab: heapRow?.id ?? null, level: heapShare == null ? "ok" : heapShare >= STATUS_LIMITS.heapBad ? "bad" : heapShare >= STATUS_LIMITS.heapWarn ? "warn" : "ok" },
  ];
}

/**
 * One entry per success criterion of the goal (docs/plans/leveling-plan.md): `share` is its bar
 * from 0 to 1 and null where nothing measures it yet, with the numbers the collector has. `recent`
 * is what moved the bars in the last 24 hours (`progressCounts`). The raid bar is the share of the
 * goal's bosses (`raidGoal`, data/raid-goal.json) that a raid task has killed. `levels.event` is
 * the XP event that runs at `now` (the collector's meta key `xpEvents`), `{ factor, since }`, whose
 * XP the estimate to the target counts at its normal worth.
 */
export function goalView(db, { now, roster, plan, groupOf, catalog, raidGoal = [] }) {
  const members = roster.groups.flatMap((g) => g.members);
  const eta = (plan?.groups ?? []).filter((g) => g.eta?.[roster.target]).map((g) => ({ group: groupOf.get(g.leader) ?? null, leader: g.leader, ...g.eta[roster.target], slowest: g.slowest }));
  const slowest = eta.sort((a, b) => b.hours - a.hours)[0] ?? null;
  const span = (metaRow(db, "xpEvents")?.spans ?? []).find((s) => now >= s.from && (s.to == null || now < s.to));
  const coordinator = metaRow(db, "coordinator");
  const gear = metaRow(db, "gear");
  const sheet = gearView(db, { roster });
  const epics = epicsView(coordinator);
  const questPieces = [...catalog.opportunities.values()].filter((o) => o.quest);
  const missing = coordinator?.last?.missing ?? {};
  const wanted = questPieces.filter((o) => (missing[o.id] ?? 0) > 0);
  const reached = members.filter((m) => (m.level ?? 0) >= AA_LEVEL).length;
  const kills = db.query("SELECT t, name, text, data FROM progress WHERE kind = 'raid' ORDER BY t").all().map((r) => ({ t: r.t, by: r.name, text: r.text, ...JSON.parse(r.data ?? "{}") }));
  const killed = [...new Set(kills.map((k) => k.goal).filter(Boolean))];
  const bosses = metaRow(db, "bossPlan");
  const lately = kills.filter((k) => k.t > now - DAY);
  return {
    recent: progressCounts(db, now - DAY),
    levels: { share: roster.progress, atTarget: roster.atTarget, characters: roster.characters, target: roster.target, minLevel: roster.minLevel, meanLevel: roster.meanLevel, maxLevel: roster.maxLevel, slowest, noEstimate: plan?.idle ?? [], planWindowMin: plan?.windowMin ?? null, event: span ? { factor: span.factor, since: span.from } : null },
    gear: { share: sheet.share, afterMoves: sheet.afterMoves, characters: sheet.characters, moves: gear?.moves ?? null, drops: gear?.drops?.length ?? null, passT: sheet.t ?? gear?.t ?? null },
    aa: aaView(metaRow(db, "aa") ?? {}, { reached, characters: roster.characters, plan: metaRow(db, "aaPlan") }),
    epics: { share: epics?.share ?? null, holders: epics?.holders ?? null, needers: epics?.needers ?? null, started: epics?.started ?? null, chains: epics?.chains.length ?? 0, held: coordinator?.last?.epicHolders?.filter((n) => members.some((m) => m.name === n)).length ?? null, characters: roster.characters, missingCopies: wanted.reduce((a, o) => a + missing[o.id], 0), missingPieces: wanted.length, passT: coordinator?.last?.t ?? null },
    raids: {
      share: raidGoal.length ? killed.length / raidGoal.length : null, goal: raidGoal, killed, kills: kills.length, recent: lately.filter((k) => k.goal).length, others: lately.filter((k) => !k.goal).length, next: bosses?.next ?? [], resets: bosses?.resets ?? null, resetAt: bosses?.resetAt ?? null, last: kills.at(-1) ?? null, level: AA_LEVEL, reached, characters: roster.characters,
      // The bosses the open world puts up (`watchRows` of tools/lib/boss-plan.mjs), the look the
      // plan sends next and the raid hours of the last day.
      watch: (bosses?.watch ?? []).map((w) => ({ ...w, zone: zoneName(catalog, w.zone) })),
      look: bosses?.look ? { ...bosses.look, zone: zoneName(catalog, bosses.look.zone) } : null,
      hours: bosses?.hours ?? null,
    },
  };
}

/**
 * The AA bar from the meta key `aa` (iqd's coordinator pass, the AA window's state of each tab's
 * active character): ranks trained against the catalog's ranks for the characters recorded past
 * the unlock level, with their unspent points. `share` is null until one such character is recorded.
 * `coin` is the pass's plan (meta key `aaPlan`): the ranks the points could buy, the ranks the
 * account's coin above its reserve pays for, and those numbers.
 */
export function aaView(aa, { reached, characters, plan = null }) {
  const past = Object.values(aa).filter((s) => (s.level ?? 0) >= AA_LEVEL && s.maxRanks > 0);
  const trained = past.reduce((n, s) => n + Object.values(s.ranks ?? {}).reduce((a, b) => a + (Number(b) || 0), 0), 0);
  const possible = past.reduce((n, s) => n + s.maxRanks, 0);
  return { share: possible ? trained / possible : null, level: AA_LEVEL, reached, characters, recorded: past.length, trained, possible, points: past.reduce((n, s) => n + (s.points ?? 0), 0), coin: plan?.wanted ? plan : null, passT: Math.max(0, ...past.map((s) => s.t ?? 0)) || null };
}

/**
 * The epic quest chains of the last coordinator pass (`chainSummary`): per chain its class, reward,
 * and how many characters hold it, have started it and still need it, and the share of the
 * eligible character-steps (holders plus needers) that are done. Chains outside the epics (no
 * "epic" in the id) are left out. Null before a pass that saved chains.
 */
export function epicsView(coordinator) {
  const chains = coordinator?.last?.chains;
  if (!chains) return null;
  const list = Object.entries(chains)
    .filter(([id]) => id.includes("epic"))
    .map(([id, c]) => ({ id, class: c.class, reward: c.reward, minLevel: c.minLevel, holders: c.holders, started: c.started, needers: c.needers }));
  const holders = list.reduce((a, c) => a + c.holders.length, 0);
  const needers = list.reduce((a, c) => a + c.needers.length, 0);
  return { chains: list, holders, needers, started: list.reduce((a, c) => a + c.started.length, 0), share: holders + needers ? holders / (holders + needers) : null };
}

// ---- Progress --------------------------------------------------------------------------------------

// A group's level-ups to one milestone level this close together share a row, as a party levels together.
const MILESTONE_MERGE_MS = 30 * 60000;

/** "A", "A and B" or "A, B and C". */
const nameList = (list) => (list.length > 1 ? `${list.slice(0, -1).join(", ")} and ${list.at(-1)}` : (list[0] ?? ""));

/**
 * The row an event shares with others, or null for one that stands alone. Twelve parties level
 * about once an hour each and a gear task or a gear pass upgrades a dozen characters, so a group's
 * ordinary level-ups of one day share a row, and so do the upgrades of one gear task (`data.task`)
 * or one gear pass. A group's level-ups to one milestone level share a row within half an hour.
 */
function mergeKey(r, data) {
  if (r.kind === "level") return r.sig >= 2 ? `level:${r.grp}:${data.level}` : `levels:${r.grp}:${new Date(r.t).toDateString()}`;
  if (r.kind === "gear") return `gear:${data.task ?? r.t}`;
  return null;
}

/**
 * The progress record (`progress`, tools/lib/progress.mjs) since `since`, newest first and of one
 * group if `group` names it, as rows for the page: `{ key, t, kind, sig, group, text, detail,
 * items, parts }`. A row of several events (`mergeKey`) sums them up in `text` and lists them
 * earliest first in `parts`, each `{ group, text, items }`. `items` are the items the text names
 * (`itemRefs`), which the page shows by their cards.
 */
export function progressRows(db, since, { group = null, limit = 150 } = {}) {
  const raw = db.query(`SELECT t, kind, sig, name, grp, text, data, key FROM progress WHERE t >= ?${group ? " AND grp = ?" : ""} ORDER BY t DESC, id DESC`).all(...(group ? [since, group] : [since]));
  const rows = [];
  const open = new Map(); // merge key -> row
  for (const r of raw) {
    const e = { ...r, data: r.data ? JSON.parse(r.data) : {} };
    const mk = mergeKey(r, e.data);
    const row = mk ? open.get(mk) : null;
    if (row && !(r.kind === "level" && r.sig >= 2 && row.events[0].t - r.t > MILESTONE_MERGE_MS)) {
      // The events come newest first, so an earlier one goes to the front of its row.
      row.events.unshift(e);
      continue;
    }
    const next = { key: mk ?? r.key, events: [e] };
    rows.push(next);
    if (mk) open.set(mk, next);
  }
  return rows.slice(0, limit).map(rowView);
}

/**
 * The items a progress event names, `[{ id, name }]`, and for an upgraded slot also the item it
 * replaced as `was`, null for a slot that was empty.
 */
function itemRefs(kind, data) {
  if (kind === "item") return [{ id: data.itemId ?? null, name: data.item }];
  if (kind === "gear") return (data.slots ?? []).map((s) => ({ id: s.itemId ?? null, name: s.item, was: s.was ? { id: s.wasId ?? null, name: s.was } : null }));
  return [];
}

/** Every item id the progress rows `rows` name, in their parts and as replaced items too. */
export const itemIdsOf = (rows) => rows.flatMap((r) => [...r.items, ...r.parts.flatMap((p) => p.items)]).flatMap((x) => [x.id, x.was?.id]).filter((id) => id != null);

/** A row of `progressRows` from its events, earliest first. */
function rowView({ key, events }) {
  const last = events.at(-1);
  const groups = [...new Set(events.map((e) => e.grp))];
  const row = { key, t: last.t, kind: last.kind, sig: Math.max(...events.map((e) => e.sig)), group: groups.length === 1 ? groups[0] : null, items: [], parts: [] };
  if (events.length === 1) return { ...row, text: last.text, detail: detailOf(last.kind, last.data), items: itemRefs(last.kind, last.data) };
  const names = [...new Set(events.map((e) => e.name).filter(Boolean))];
  // Up to three names read as a list, and a party's day as a count, since the row opens to the names.
  const who = names.length > 3 ? `${names.length} characters` : nameList(names);
  const parts = events.map((e) => ({ group: e.grp, text: e.text, items: itemRefs(e.kind, e.data) }));
  if (last.kind === "level") {
    const levels = events.map((e) => e.data.level);
    const [low, top] = [Math.min(...levels), Math.max(...levels)];
    return { ...row, parts, text: `${who} reached ${low === top ? `level ${top}` : `levels ${low} to ${top}`}`, detail: low === top ? null : `${events.length} levels` };
  }
  const slots = events.reduce((a, e) => a + (e.data.slots?.length ?? 1), 0);
  const gain = events.reduce((a, e) => a + (e.data.slots ?? []).reduce((b, s) => b + (s.gain > 0 ? s.gain : 0), 0), 0);
  return { ...row, parts, text: `${who} ${names.length === 1 ? "wears" : "wear"} ${slots} upgrade${slots === 1 ? "" : "s"}`, detail: gain > 0 ? `slot score +${Math.round(10 * gain) / 10}` : null };
}

/**
 * The detail a row of one event shows beside its text: for gear, the slot score the planned items
 * add (`gain`, as the gear sheet gives it) and the set score before and after, and for a raid kill
 * whether the boss is one of the goal's.
 */
function detailOf(kind, data) {
  if (kind === "gear") {
    const gain = (data.slots ?? []).reduce((a, s) => a + (s.gain > 0 ? s.gain : 0), 0);
    const score = data.score?.target > 0 ? `set ${Math.round((100 * data.score.before) / data.score.target)}% to ${Math.round((100 * data.score.after) / data.score.target)}% of target` : null;
    return [gain > 0 ? `slot score +${Math.round(10 * gain) / 10}` : null, score].filter(Boolean).join(", ") || null;
  }
  if (kind === "raid") return data.goal ? "a boss of the goal" : null;
  return null;
}

/** The progress section: the last two days' rows, the 24-hour counts and the latest milestone. */
export function progressView(db, now, { hours = 48 } = {}) {
  const rows = progressRows(db, now - hours * 3600000);
  return { hours, rows, counts: progressCounts(db, now - DAY), latest: rows.find((r) => r.sig >= 2) ?? null };
}

// ---- Gear -----------------------------------------------------------------------------------------

const share = (score, of) => (of > 0 ? Math.min(1, score / of) : null);

/**
 * The gear pass's scores per character (`gearPlan`), grouped as the roster: for each character the
 * set score of its armor and jewelry now, after the queued moves and at the target, which is what
 * the moves and every wanted drop would give it, and the shares of the target. `share` is the mean
 * of the characters' shares now and `afterMoves` the mean after the queued moves. Weapons are not
 * in the score, because their gain is relative to the weapon worn and has no absolute value to sum.
 */
export function gearView(db, { roster }) {
  const plan = metaRow(db, "gearPlan");
  const byName = new Map((plan?.characters ?? []).map((c) => [c.name, c]));
  const groups = roster.groups.map((g) => ({
    id: g.id,
    characters: g.members.map((m) => {
      const c = byName.get(m.name);
      return { name: m.name, class: m.class, level: m.level, planned: Boolean(c), now: c?.score.now ?? null, moves: c?.score.moves ?? null, target: c?.score.target ?? null, share: c ? share(c.score.now, c.score.target) : null, afterMoves: c ? share(c.score.moves, c.score.target) : null };
    }),
  }));
  const mean = (key) => {
    const xs = groups.flatMap((g) => g.characters.map((c) => c[key])).filter((x) => x != null);
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
  };
  for (const g of groups) {
    const xs = g.characters.map((c) => c.share).filter((x) => x != null);
    g.share = xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
  }
  return { t: plan?.t ?? null, groups, characters: byName.size, share: mean("share"), afterMoves: mean("afterMoves") };
}

/**
 * One character's sheet for the paper doll: the 22 slots in the inventory window's order, each with
 * the item worn now, the optimal item (the wanted drop, which beats what the queued moves give, else
 * the queued move) with where it comes from, and the cards of every item named, from the card store.
 * `found` is false for a character the last gear pass did not plan.
 */
export function gearSheetView(db, name, { roster, catalog }) {
  const sheets = metaRow(db, "gearSheets");
  const plan = metaRow(db, "gearPlan");
  const slots = sheets?.sheets?.[name];
  const member = roster.groups.flatMap((g) => g.members.map((m) => ({ ...m, group: g.id }))).find((m) => m.name === name);
  const entry = plan?.characters.find((c) => c.name === name);
  if (!slots || !member) return { name, found: false };
  const items = cardsFor(db, slots.flatMap((s) => [s.worn?.itemId, s.move?.itemId, s.drop?.itemId]));
  const out = slots.map((s) => {
    const drop = s.drop ? { ...s.drop, zoneName: zoneName(catalog, s.drop.zone) } : null;
    const move = s.move ? { ...s.move, ...(s.move.buy ? { buy: { ...s.move.buy, zoneName: zoneName(catalog, s.move.buy.zone) } } : {}) } : null;
    // The wanted drop beats the moved item (it is scored against the set after the moves), so it is the optimal item.
    const optimal = drop ? { kind: "drop", itemId: drop.itemId, item: drop.item } : move ? { kind: move.buy ? "buy" : "move", itemId: move.itemId, item: move.item } : null;
    return { slotNum: s.slotNum, slot: s.slot, worn: s.worn, move, drop, optimal };
  });
  return { name, found: true, t: sheets.t, group: member.group, class: member.class, race: member.race, level: member.level, xpPct: member.xpPct, score: entry?.score ?? null, share: entry ? share(entry.score.now, entry.score.target) : null, afterMoves: entry ? share(entry.score.moves, entry.score.target) : null, slots: out, items };
}

/**
 * The coordinator panel: running tasks, the running experiments and recent outcomes, each outcome
 * with its short `subject` (`taskSubject`) and its full name. The bot keeps only each tab's latest
 * task, so the outcomes are those.
 */
export function coordinatorView(db, now, { catalog, rows, groupOf }) {
  const state = metaRow(db, "coordinator");
  if (!state) return null;
  const history = state.history ?? [];
  const running = rows
    .filter((r) => r.task?.status === "running")
    .map((r) => ({ group: r.id, leader: r.leader, ...r.task }))
    .sort((a, b) => b.forMs - a.forMs);
  // Each task's own outcome, newest first, from the history the collector settles every cycle.
  const outcomes = history
    .filter((h) => h.status && outcomeOf(h).endedAt)
    .sort((a, b) => outcomeOf(b).endedAt - outcomeOf(a).endedAt)
    .slice(0, 12)
    .map((h) => ({ group: groupOf.get(h.label) ?? null, kind: h.kind, subject: taskSubject(catalog, h.id) ?? TASK_KIND[h.kind] ?? h.kind, name: taskLabel(catalog, h), step: h.step ?? null, status: h.status, result: h.result ?? null, error: h.error ?? null, agoMs: now - outcomeOf(h).endedAt }));
  const ex = state.experiments ?? {};
  const experiments = Object.entries(ex.running ?? {}).map(([name, x]) => ({ name, sinceMs: ex.started?.[name] ? now - ex.started[name] : null, a: x.a ?? [], b: x.b ?? [] }));
  return { running, experiments, outcomes };
}
