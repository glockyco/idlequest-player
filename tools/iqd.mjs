#!/usr/bin/env bun
// iqd: the collector and coordinator for the IdleQuest game tabs.
//
// `iqd run` reads every game tab through the browser relay (src/cdp.mjs) on a timer, keeps a
// durable history in runs/iq.db and runs/live/<leader>/, and raises attention items, so an agent
// can sleep in `iqd wait` instead of polling the tabs. It never clicks, types or injects anything.
// With `--coordinate` it also queues tasks in the bots (tools/lib/coordinator.mjs) through their
// own task API, which plays the steps.
// Usage: see `iqd help` and the "Monitoring" section of the README.
import { Database } from "bun:sqlite";
import { appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { statSync, openSync, readSync, closeSync, readFileSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { Relay } from "../src/cdp.mjs";
import { accumulate, zoneNames } from "./lib/rates.mjs";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const SEVERITY_RANK = { info: 1, decide: 2, act: 3 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Thresholds of the attention rules. */
export const THRESHOLDS = {
  goneSec: 60, // tab missing or not answering
  idleSec: 120, // idle or dead without a bot pause or a raid
  noKillSec: 300, // no kill without a bot pause or a raid
  heapShare: 0.85, // share of the JS heap limit
  taskMin: 60, // a coordinator task running longer than this (the longest, a farm, runs 120 under its own errand)
  snapshotEverySec: 300, // a character's snapshot is written at least this often
};

/** Attention kinds that describe a state. They resolve themselves when the state ends. */
export const CONDITION_KINDS = ["gone", "nobridge", "stall", "heap", "longtask"];

// ---- Database -----------------------------------------------------------------------------------

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS characters (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, class TEXT, race TEXT, roster_level INTEGER,
  first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS char_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT, char_id INTEGER NOT NULL, t INTEGER NOT NULL, session_id INTEGER,
  leader INTEGER NOT NULL DEFAULT 0, level INTEGER, xp_pct REAL, max_hp INTEGER, max_mana INTEGER, zone TEXT);
CREATE INDEX IF NOT EXISTS char_snapshots_char ON char_snapshots (char_id, t);
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, target_id TEXT NOT NULL, page_session INTEGER NOT NULL,
  leader_id INTEGER, leader TEXT, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, ended INTEGER,
  parked INTEGER NOT NULL DEFAULT 0, state TEXT, snap TEXT, UNIQUE (target_id, page_session));
CREATE TABLE IF NOT EXISTS attention (
  id INTEGER PRIMARY KEY AUTOINCREMENT, t INTEGER NOT NULL, severity TEXT NOT NULL, kind TEXT NOT NULL,
  session TEXT, dedupe TEXT NOT NULL, text TEXT NOT NULL, resolved INTEGER, note TEXT);
CREATE INDEX IF NOT EXISTS attention_open ON attention (dedupe) WHERE resolved IS NULL;
CREATE TABLE IF NOT EXISTS interventions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, t INTEGER NOT NULL, session TEXT, actor TEXT NOT NULL, text TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, purpose TEXT NOT NULL, command TEXT, output TEXT,
  started INTEGER NOT NULL, done INTEGER, result TEXT);
CREATE TABLE IF NOT EXISTS attach_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, t INTEGER NOT NULL, target_id TEXT NOT NULL, url TEXT, event TEXT NOT NULL);
`;

export function openDb(path) {
  const db = new Database(path, { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA busy_timeout = 5000");
  db.run(SCHEMA);
  return db;
}

const metaGet = (db, k) => {
  const row = db.query("SELECT v FROM meta WHERE k = ?").get(k);
  return row ? JSON.parse(row.v) : null;
};
const metaSet = (db, k, v) => db.query("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v").run(k, JSON.stringify(v));

/** Insert an attention item unless an unresolved one has the same key. Returns the new id or null. */
export function raiseItem(db, { t = Date.now(), severity, kind, session = null, key, text }) {
  if (db.query("SELECT 1 FROM attention WHERE dedupe = ? AND resolved IS NULL").get(key)) return null;
  return db.query("INSERT INTO attention (t, severity, kind, session, dedupe, text) VALUES (?, ?, ?, ?, ?, ?) RETURNING id").get(t, severity, kind, session, key, text).id;
}

export function resolveItem(db, id, note = null, t = Date.now()) {
  return db.query("UPDATE attention SET resolved = ?, note = ? WHERE id = ? AND resolved IS NULL").run(t, note, id).changes > 0;
}

// ---- Rules --------------------------------------------------------------------------------------

/** The activity seconds of a snapshot as "; last 10 min: fight 40%, approach 21%, ...", largest first. */
export function activityText(sec) {
  const total = Object.values(sec ?? {}).reduce((a, b) => a + b, 0);
  if (!total) return "";
  const parts = Object.entries(sec)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${Math.round((100 * v) / total)}%`);
  return `; last ${Math.round(total / 60)} min: ${parts.join(", ")}`;
}

/**
 * One rule step for one tab. Pure: reads the observation and the tab's rule state, returns the new
 * state, the items that are true now and the condition kinds this step could judge. The caller
 * raises the items (deduplicated by key) and resolves open items of an evaluated kind whose key is
 * no longer in the list.
 *
 * `obs` is `{ reachable, present, error, snap }` where `snap` comes from `snapshotInPage`.
 * `levels` maps a character id to the last level stored for it. `triggers` is data/triggers.json.
 */
export function stepSession({ state, obs, now, label, levels = {}, triggers = [], thresholds = THRESHOLDS }) {
  const st = { ...state };
  const items = [];
  const item = (severity, kind, key, text) => items.push({ severity, kind, key, text });

  if (!obs.reachable) {
    st.unreachableSince ??= now;
    const secs = Math.round((now - st.unreachableSince) / 1000);
    if (secs >= thresholds.goneSec) {
      const why = obs.present ? `not answering${obs.error ? ` (${obs.error})` : ""}` : "not in the relay list";
      item("act", "gone", `gone:${label}`, `${label}: tab ${why} for ${secs} s`);
    }
    return { state: st, items, evaluated: ["gone"] };
  }
  st.unreachableSince = null;
  const snap = obs.snap;
  const evaluated = [...CONDITION_KINDS];

  if (snap.error || !snap.hasBridge || !snap.hasBot) {
    st.watchSince = null;
    const what = snap.error ? `snapshot failed: ${snap.error}` : !snap.hasBridge ? "window.iq is missing" : "window.iqBot is missing";
    item("act", "nobridge", `nobridge:${label}`, `${label}: ${what}`);
    return { state: st, items, evaluated };
  }

  // A parked tab has its bot turned off on purpose. Nothing about it needs attention.
  if (snap.bot.enabled === false) {
    st.watchSince = null;
    return { state: st, items, evaluated, parked: true };
  }

  // Every tab that plays must make progress (docs/plans/controller.md). Idle and dead seconds come
  // from the page's activity label, and a tab that keeps busy without a kill, such as an approach
  // that never arrives, shows in the time since its last kill. A bot pause is a lease with its own
  // deadline and a raid sets its own pace, so both stop the clocks. An errand does not, because an
  // errand hunts as well.
  const leased = Boolean(snap.raid || (snap.bot.pauseUntil ?? 0) > now);
  st.watchSince = leased ? null : (st.watchSince ?? now);
  if (!leased) {
    const act = snap.activity;
    const stillSec = act && (act.act === "idle" || act.act === "dead") ? (now - Math.max(act.since, st.watchSince)) / 1000 : 0;
    const noKillSec = (now - Math.max(snap.kills?.last ?? 0, st.watchSince)) / 1000;
    if (stillSec >= thresholds.idleSec || noKillSec >= thresholds.noKillSec) {
      const what = stillSec >= thresholds.idleSec ? `${act.act}${act.why ? ` (${act.why})` : ""} for ${Math.round(stillSec)} s` : `no kill for ${Math.round(noKillSec / 60)} min`;
      item("act", "stall", `stall:${label}`, `${label}: ${what}${snap.zone ? ` in ${snap.zone}` : ""}${activityText(snap.activitySec)}`);
    }
  }
  if (snap.heap?.limit && snap.heap.used / snap.heap.limit > thresholds.heapShare) {
    item("act", "heap", `heap:${label}`, `${label}: page heap at ${snap.heap.used} of ${snap.heap.limit} MB`);
  }
  // A task holds its tab under a bot pause, which stops the stall clocks above, so a task that
  // runs far longer than tasks take (a wait for an NPC that never spawns) is its own condition.
  const task = snap.bot.task;
  if (task?.status === "running" && task.startedAt && now - task.startedAt > thresholds.taskMin * 60000) {
    item("act", "longtask", `longtask:${label}`, `${label}: ${task.kind} task running for ${Math.round((now - task.startedAt) / 60000)} min${task.step ? ` at "${task.step}"` : ""}`);
  }

  for (const a of snap.bot.alerts ?? []) {
    if (!a.wake || a.kind === "levelUp") continue; // level-ups are reported by the level rules below
    const kind = a.kind === "death" ? "death" : `alert-${a.kind}`;
    item("act", kind, `${kind}:${snap.pageSession}:${a.seq}`, a.text);
  }

  const leader = snap.leader;
  const roster = [...(leader ? [leader] : []), ...(snap.party ?? []).filter((m) => m.type === 2 && m.id != null)];
  const chars = [...new Map(roster.map((c) => [c.id, c])).values()];
  for (const c of chars) {
    const prev = levels[c.id];
    if (prev != null && c.level > prev) item("info", "levelup", `levelup:${c.id}:${c.level}`, `${c.name}${c.class ? ` (${c.class})` : ""} reached level ${c.level}`);
  }
  if (leader && levels[leader.id] != null) {
    for (const tr of triggers) {
      if (levels[leader.id] < tr.level && leader.level >= tr.level) {
        item("decide", "trigger", `trigger:${leader.id}:${tr.level}`, `${leader.name} reached level ${tr.level}: ${tr.text}${tr.doc ? ` See ${tr.doc}.` : ""}`);
      }
    }
  }
  // What the tab does now can show that an earlier event is over: a later task that finished
  // settles a failed task, a tab that plays again settles an idle alert raised before it did, and
  // an empty cursor settles a cursor alert.
  const settled = {};
  if (snap.bot.task?.status === "done" && snap.bot.task.endedAt) settled["alert-task"] = snap.bot.task.endedAt;
  if (snap.activity && snap.activity.act !== "idle" && snap.activity.since) settled["alert-idle"] = snap.activity.since;
  if (snap.bags && !snap.bags.cursor) settled["alert-cursor"] = now;
  return { state: st, items, evaluated, settled };
}

// Events (bot alerts, deaths, level-ups) say what happened at one moment, and an ongoing problem
// shows as a condition (stall, gone, nobridge, heap). So a newer act event of the same kind for the
// tab replaces the older one, an info event closes after its time to live, and an act event closes
// after its time to live once the tab has no open condition. An event the tab's state shows to be
// over (`settled` of the rule step) closes at once. Decisions stay open until answered.
export const EVENT_TTL_MS = { info: 10 * 60000, act: 60 * 60000 };

/**
 * Store the items of one rule step, resolve open condition items that no longer hold and close
 * events that are replaced or expired. Items of the tab's earlier label (the tab showed another
 * character before) are resolved the same way.
 */
export function syncAttention(db, { label, oldLabel = label, res, now = Date.now(), log = () => {} }) {
  const open = db.query("SELECT id, kind, dedupe FROM attention WHERE resolved IS NULL AND session IN (?, ?)").all(label, oldLabel);
  const active = new Set(res.items.map((i) => i.key));
  for (const it of res.items) {
    const id = raiseItem(db, { t: now, severity: it.severity, kind: it.kind, session: label, key: it.key, text: it.text });
    if (id) log(`attention #${id} ${it.severity} ${it.kind}: ${it.text}`);
  }
  for (const o of open) {
    if (CONDITION_KINDS.includes(o.kind) && res.evaluated.includes(o.kind) && !active.has(o.dedupe)) {
      resolveItem(db, o.id, res.parked ? "tab is parked" : "condition cleared", now);
      log(`attention #${o.id} ${o.kind} cleared`);
    }
  }
  const events = db.query("SELECT id, t, severity, kind FROM attention WHERE resolved IS NULL AND session IN (?, ?) ORDER BY id").all(label, oldLabel);
  const conditionOpen = events.some((e) => CONDITION_KINDS.includes(e.kind));
  const newest = new Map(events.filter((e) => e.severity === "act").map((e) => [e.kind, e.id]));
  for (const e of events) {
    if (CONDITION_KINDS.includes(e.kind) || !(e.severity in EVENT_TTL_MS)) continue;
    if (res.settled?.[e.kind] >= e.t) resolveItem(db, e.id, { "alert-task": "a later task finished", "alert-cursor": "the cursor is empty" }[e.kind] ?? "the tab plays again", now);
    else if (e.severity === "act" && newest.get(e.kind) !== e.id) resolveItem(db, e.id, `replaced by #${newest.get(e.kind)}`, now);
    else if (now - e.t >= EVENT_TTL_MS[e.severity] && (e.severity === "info" || !conditionOpen)) resolveItem(db, e.id, "expired", now);
  }
}

// ---- In-page expressions ------------------------------------------------------------------------
// Both read window.iq and window.iqBot and change nothing. They run inside the game page, so they
// stay short.

/** Snapshot of one tab. `a` is `{ session, after, sinceT }`: the page session and bot alert cursor
 * the caller stored, and the earliest alert time to report when the cursor belongs to another page. */
export function snapshotInPage(a) {
  const t = Date.now();
  const iq = window.iq;
  const bot = window.iqBot;
  const out = { t, href: location.href, vis: document.visibilityState, hasBridge: Boolean(iq?.stores), hasBot: Boolean(bot?.config && bot?.state) };
  try {
    if (out.hasBot) {
      const st = bot.state;
      const same = iq && iq.session === a.session;
      const after = same ? a.after : 0;
      const since = same ? 0 : a.sinceT;
      const wake = st.alerts.filter((x) => x.seq > after && x.t >= since && x.wake);
      out.bot = {
        enabled: bot.config.enabled,
        pauseUntil: st.pauseUntil || 0,
        pauseReason: st.pauseReason ?? null,
        rotation: bot.config.rotation ?? [],
        errand: st.errand ? { zone: st.errand.zone, item: st.errand.item, keep: st.errand.keep } : null,
        task: st.task ? { id: st.task.id, kind: st.task.kind, status: st.task.status, step: st.task.step ?? null, startedAt: st.task.startedAt, result: st.task.result ?? null, error: st.task.error ?? null, nextAt: st.task.nextAt ?? null, endedAt: st.task.endedAt ?? null } : null,
        // Past the 50 alerts that fit, the cursor stops at the last one returned.
        alertSeq: wake.length > 50 ? wake[49].seq : st.alertSeq,
        alerts: wake.slice(0, 50).map((x) => ({ seq: x.seq, t: x.t, kind: x.kind, wake: x.wake, text: String(x.text).slice(0, 400) })),
      };
    }
    if (!out.hasBridge) return out;
    const S = iq.stores;
    const p = S.character.getState().characterProfile;
    const cb = S.combat.getState();
    const sd = S.staticData.getState();
    const cs = S.companions.getState();
    const roster = S.roster?.getState?.().characters ?? [];
    const cls = Object.fromEntries((sd.classes ?? []).map((c) => [c.id, c.name]));
    const races = Object.fromEntries((sd.races ?? []).map((r) => [r.id, r.name]));
    const byId = Object.fromEntries(roster.map((r) => [r.id, r]));
    const ep = p?.experienceProgress;
    out.pageSession = iq.session;
    out.release = iq.release ?? null;
    out.code = iq.code ?? null;
    out.leader = p?.id
      ? { id: p.id, name: p.name, level: p.level, class: p.class?.name ?? cls[p.class] ?? null, race: p.race?.name ?? races[p.race] ?? null, hp: p.curHp, maxHp: p.maxHp, mana: p.mana, maxMana: p.maxMana, xpPct: ep ? ep.progressBasisPoints / 100 : null, xp: ep?.current ?? null }
      : null;
    out.party = (cs.companions ?? []).map((c) => {
      const r = c.characterId != null ? byId[c.characterId] : null;
      return { id: c.characterId ?? null, name: c.name, level: c.level, type: c.companionType, hp: c.curHp, maxHp: c.maxHp, mana: c.curMana, maxMana: c.maxMana, class: r ? cls[r.class] : (cls[cs.botCombatDataMap?.[c.id]?.class] ?? null), race: r ? races[r.race] : null };
    });
    out.roster = roster.map((r) => ({ id: r.id, name: r.name, level: r.level, class: cls[r.class] ?? null, race: races[r.race] ?? null }));
    const zone = (sd.zones ?? []).find((z) => z.zoneidnumber === cb.currentZone);
    out.zone = zone ? (zone.longName ?? zone.shortName) : (cb.currentZone ?? null);
    out.zoneShort = zone?.shortName ?? null;
    out.autoLevel = { running: Boolean(cb.isRunning), mode: cb.automatedCombatMode, minCon: cb.minCon, maxCon: cb.maxCon, maxLevelDiff: cb.maxLevelDiff };
    out.activity = iq.activity?.() ?? null;
    out.gameHour = iq.gameHour?.() ?? null;
    out.activitySec = iq.activitySeconds?.(600000) ?? null;
    out.raid = Boolean(S.raid?.getState?.().raidModeActive);
    out.conn = { screen: S.screen?.getState?.().currentScreen ?? null, connected: iq.socket?.isConnected ?? null, worldReady: iq.socket?.worldReady ?? null, inCombat: Boolean(S.skills?.getState?.().inCombat), zoneLoading: Boolean(cb.isZoneLoading) };
    const ks = iq.kills ?? [];
    let n = 0;
    let xp = 0;
    for (let i = ks.length - 1; i >= 0 && ks[i].t >= t - 1800000; i--) {
      n++;
      xp += ks[i].xp;
    }
    const firstT = iq.samples?.[0]?.t ?? t;
    out.kills = { total: ks.length, last: ks.length ? ks.at(-1).t : null, lastEnemy: ks.length ? ks.at(-1).enemy : null, n30: n, xp30: xp, winMs: Math.min(1800000, t - firstT) };
    const m = performance.memory;
    out.heap = m ? { used: Math.round(m.usedJSHeapSize / 1048576), limit: Math.round(m.jsHeapSizeLimit / 1048576) } : null;
    out.bags = p?.id ? iq.bagSpace() : null;
    out.rec = { ses: iq.session, seqS: iq.seqs?.sample ?? 0, seqE: iq.seqs?.event ?? 0 };
  } catch (e) {
    out.error = String(e?.message ?? e).slice(0, 200);
  }
  return out;
}

/** Recorder rows after the cursors `{ ses, seq }`, at most `max` of each kind, read without touching the buffers. */
export function drainInPage(a) {
  const iq = window.iq;
  if (!iq?.samples || !iq?.events) return null;
  const after = (x, c) => (x.ses ?? 0) > c.ses || ((x.ses ?? 0) === c.ses && x.seq > c.seq);
  const pick = (arr, c, max) => {
    const rows = [];
    for (let i = 0; i < arr.length; i++) {
      if (!after(arr[i], c)) continue;
      if (rows.length === max) return { rows, more: true };
      rows.push(arr[i]);
    }
    return { rows, more: false };
  };
  const s = pick(iq.samples, a.s, a.maxS);
  const e = pick(iq.events, a.e, a.maxE);
  return { samples: s.rows, events: e.rows, more: s.more || e.more };
}

// The roster gear plan runs this often (`gearPass`): a survey of the account takes a minute.
const GEAR_EVERY_MIN = 60;
const call = (fn, arg) => `(${fn.toString()})(${JSON.stringify(arg)})`;

/** Inventory Search over every account character for `a.q`: `[{ item, who, n }]`. Read-only. */
export async function searchInPage(a) {
  const p = window.iq.stores.character.getState().characterProfile;
  const r = await window.iq.socket.sendCorrelatedJsonRequest(1241, 1241, { characterId: p.id, stateSessionId: p.stateSessionId, action: "search", query: a.q }, 8000);
  return (r?.matches ?? []).map((m) => ({ item: m.itemName, who: m.characterName, n: m.quantity ?? 1 }));
}

/** Queue a task with the bot's own API (`iqBot.handIn`, `iqBot.hunt`, `iqBot.errand`), which checks it and runs it in the page. `stopErrand` ends the errand and `stopTask` the running task. */
export async function queueInPage(a) {
  const t = await (a.kind === "stopErrand" ? window.iqBot.errand(null) : a.kind === "stopTask" ? window.iqBot.stopTask() : window.iqBot[a.kind](a.spec));
  return { id: t?.id ?? null, status: t?.status ?? String(t) };
}

/** Give a bot without a leader its group's leader and members by name, from the account's character list. */
export function setGroupInPage(a) {
  const chars = window.iq.stores.roster?.getState?.().characters ?? [];
  const idOf = (n) => chars.find((c) => c.name === n)?.id ?? null;
  if (window.iqBot.config.leaderId != null || idOf(a.leader) == null) return false;
  window.iqBot.set({ leaderId: idOf(a.leader), partyIds: a.members.map(idOf).filter((id) => id != null) });
  return true;
}

/**
 * The worn and carried items of the tab's leader and account companions, which the client holds
 * for its party (the character sheet and `botInventories`), so the gear plan needs no search.
 * Rows carry the item id and instance, where the item is and the holder's class, race and level.
 */
export function inventoryInPage() {
  const S = window.iq.stores;
  const p = S.character.getState().characterProfile;
  const cs = S.companions.getState();
  const chars = S.roster?.getState?.().characters ?? [];
  const races = Object.fromEntries((S.staticData.getState().races ?? []).map((r) => [r.id, r.name]));
  const who = [{ id: p.id, name: p.name, class: p.class?.id ?? p.class, race: p.race?.id ?? p.race, level: p.level, inv: p.inventory ?? [] }];
  for (const c of cs.companions ?? []) {
    const r = chars.find((x) => x.id === c.characterId);
    if (r) who.push({ id: r.id, name: r.name, class: r.class, race: r.race, level: c.level ?? r.level, inv: cs.botInventories?.[`character-${r.id}`] ?? [] });
  }
  return who.flatMap((w) =>
    w.inv
      .filter((x) => x.itemid && !(x.bag === 0 && x.slot === 30))
      .map((x) => ({ characterId: w.id, characterName: w.name, class: w.class, race: races[w.race] ?? null, level: w.level, itemId: x.itemid, itemName: x.itemDetails?.Name ?? x.itemDetails?.name ?? null, itemInstanceId: x.itemInstanceId, location: x.bag === 0 && x.slot <= 21 ? "Equipped" : "Carried", slot: x.slot, bag: x.bag, blockReason: "" })),
  );
}

/** Start bridge job `a.name` with `a.args` and return its id (the bridge keeps it in `window.iq.jobs`). */
export function startJobInPage(a) {
  return window.iq.job(a.name, ...a.args);
}

/** The state of bridge job `a.id`: done, ok, result and error. */
export function jobInPage(a) {
  return window.iq.jobs[a.id] ?? null;
}

/** Set the bot settings of `a.s` that differ, and return the names of those that changed. */
export function applySettingsInPage(a) {
  const changed = Object.keys(a.s).filter((k) => JSON.stringify(window.iqBot.config[k]) !== JSON.stringify(a.s[k]));
  if (changed.length) window.iqBot.set(Object.fromEntries(changed.map((k) => [k, a.s[k]])));
  return changed;
}

/**
 * Make the tab's AA settings match `a`: `allocation` percent for the active character and its
 * account companions, and the level rule that pauses it below `a.level` for both
 * (docs/plans/systems-research.md, section 1). Uses the Alternate Advancement window's own
 * request. The server refuses both below the unlock level (46), so the allocation covers the
 * characters past it and the rule waits for the host to reach it. The allocation goes first,
 * because the window does not allocate while the rule pauses a character. Returns what it changed.
 */
export async function aaInPage(a) {
  const host = window.iq.stores.character.getState().characterProfile.id;
  const send = (action, extra) => window.iq.socket.sendCorrelatedJsonRequest(1237, 1238, { action, ...extra, hostCharacterId: host }, 10000);
  let r = await send("get", {});
  if (!r?.success) throw new Error(r?.error ?? "no advancement state");
  const done = [];
  const unlock = r.state.unlockLevel ?? 46;
  const off = (r.state.party ?? []).filter((m) => m.level >= unlock && m.allocation !== a.allocation);
  if (off.length) {
    r = await send("allocate", { allocation: a.allocation, targets: off.map((m) => ({ characterId: m.characterId, leaseId: m.leaseId })) });
    if (!r?.success) throw new Error(r?.error ?? "allocation refused");
    done.push(`${a.allocation}% for ${off.map((m) => m.name).join(", ")}`);
  }
  for (const scope of r.state.characterLevel >= unlock ? ["player", "companions"] : []) {
    const rule = r.state.levelRules?.[scope];
    if (rule?.enabled && rule.level === a.level) continue;
    r = await send("levelRule", { ruleScope: scope, levelRule: { enabled: true, level: a.level }, expectedRulesRevision: r.state.levelRules?.revision ?? 0 });
    if (!r?.success) throw new Error(r?.error ?? `${scope} level rule refused`);
    done.push(`${scope} paused below ${a.level}`);
  }
  return done;
}

/** Give the bot the items the roster gear plan wants kept, which its cleanup never sells. */
export function setGearKeepInPage(a) {
  window.iqBot.set({ gearKeepIds: a.ids });
  return a.ids.length;
}

// ---- Recorder files -----------------------------------------------------------------------------

/** Last `{ ses, seq }` in a JSONL file, like exportRun's resume point, or zeros without a file. */
function tailCursor(path) {
  let fd;
  try {
    const size = statSync(path).size;
    if (!size) return { ses: 0, seq: 0 };
    fd = openSync(path, "r");
    const len = Math.min(size, 65536);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString("utf8").split("\n").filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const row = JSON.parse(lines[i]);
        return { ses: row.ses ?? 0, seq: row.seq ?? 0 };
      } catch {
        /* partial line at the cut or an interrupted write */
      }
    }
  } catch {
    /* no file yet */
  } finally {
    if (fd != null) closeSync(fd);
  }
  return { ses: 0, seq: 0 };
}

const safeName = (s) => String(s).replace(/[^A-Za-z0-9_-]+/g, "_");

// ---- Daemon -------------------------------------------------------------------------------------

class Daemon {
  constructor({ db, relay, runs, intervalSec, log, coordinate = false, recover = false }) {
    this.db = db;
    this.relay = relay;
    this.runs = runs;
    this.intervalSec = intervalSec;
    this.log = log;
    this.coordinate = coordinate;
    this.recover = recover;
    this.coordinatedAt = 0;
    this.trackers = new Map(); // targetId -> tracker
    this.cursors = new Map(); // recorder directory -> { s, e }
    this.lastSnap = new Map(); // characterId -> last stored snapshot { t, level, maxHp, maxMana, zone }
    this.stopped = false;
    for (const r of db.query("SELECT * FROM sessions WHERE ended IS NULL").all()) {
      const state = r.state ? JSON.parse(r.state) : {};
      this.trackers.set(r.target_id, { targetId: r.target_id, rowId: r.id, label: r.leader ?? `tab:${r.target_id.slice(-4)}`, leader: r.leader, state });
    }
    for (const r of db.query("SELECT s.* FROM char_snapshots s JOIN (SELECT char_id, MAX(id) AS id FROM char_snapshots GROUP BY char_id) m ON s.id = m.id").all()) {
      this.lastSnap.set(r.char_id, { t: r.t, level: r.level, maxHp: r.max_hp, maxMana: r.max_mana, zone: r.zone });
    }
  }

  /**
   * The coordinator's pass (tools/lib/coordinator.mjs), at most every five minutes: read the
   * account's lightstones and the open opportunities' items with Inventory Search, decide, and
   * queue each task in its tab through the bot's task API. Every queued task is logged as an
   * intervention by `coordinator`, which the dashboard keeps apart from manual ones.
   */
  async coordinatePass(now) {
    if (!this.coordinate || now - this.coordinatedAt < 300000) return;
    this.coordinatedAt = now;
    const { decide, assignZones, piecesNeeded, AA_POLICY } = await import("./lib/coordinator.mjs");
    const groupOf = rosterGroups();
    // When each tab last got a rotation, from the coordinator's logged zone changes, so a restart keeps it.
    this.zoneSetAt ??= new Map(this.db.query("SELECT session, MAX(t) AS t FROM interventions WHERE actor = 'coordinator' AND text LIKE 'zone:%' GROUP BY session").all().map((r) => [r.session, r.t]));
    const tabs = [...this.trackers.values()]
      .filter((tr) => tr.snap?.leader && tr.snap.bot?.enabled !== false && !tr.state.unreachableSince && !tr.snap.raid && !(tr.snap.bot?.pauseUntil > now && tr.snap.bot?.task?.status !== "running"))
      .map((tr) => ({ targetId: tr.targetId, label: tr.label, group: groupOf.get(tr.snap.leader.name) ?? null, members: [tr.snap.leader, ...(tr.snap.party ?? []).filter((m) => m.type === 2)].map((m) => ({ name: m.name, level: m.level, class: m.class ?? null })), task: tr.snap.bot?.task ?? null, errand: tr.snap.bot?.errand ?? null, zone: tr.snap.zoneShort ?? null, rotation: tr.snap.bot?.rotation ?? null, rotationSetAt: this.zoneSetAt?.get(tr.label) ?? null, gameHour: tr.snap.gameHour }));
    if (!tabs.length) return;
    let opportunities = [];
    try {
      opportunities = JSON.parse(await readFile(join(REPO, "data/opportunities.json"), "utf8"));
    } catch {
      /* no opportunities file */
    }
    let farms = [];
    try {
      farms = JSON.parse(await readFile(join(REPO, "data/farms.json"), "utf8"));
    } catch {
      /* no farms file */
    }
    let quests = {};
    try {
      quests = JSON.parse(await readFile(join(REPO, "data/quests.json"), "utf8"));
    } catch {
      /* no quests file */
    }
    // One search per item and pass, since chains share items, and a timed-out search is asked once more.
    const searched = new Map();
    const ask = (q) => this.relay.evaluate(tabs[0].targetId, call(searchInPage, { q }), { timeout: 12000 });
    const search = (q) => {
      if (!searched.has(q)) searched.set(q, ask(q).catch(() => ask(q)));
      return searched.get(q);
    };
    const stock = {};
    for (const m of await search("Lightstone")) if (m.item === "Greater Lightstone" || m.item === "Lightstone") stock[m.item] = (stock[m.item] ?? 0) + m.n;
    const holders = {};
    const started = {};
    const have = {};
    const carriers = async (item) => (await search(item)).filter((m) => m.item === item).map((m) => m.who);
    for (const [id, q] of Object.entries(quests)) {
      // A character is done with a chain while it carries the reward or an item of a later chain
      // that the reward was spent on (`doneIf`), so a spent reward does not restart the chain.
      holders[id] = [...new Set((await Promise.all([q.reward, ...(q.doneIf ?? [])].map(carriers))).flat())];
      const steps = [...new Set(q.steps.map((s) => s.expect).filter((e) => e && e !== q.reward))];
      started[id] = [...new Set((await Promise.all(steps.map(carriers))).flat())];
      for (const n of q.needs ?? []) have[n] ??= (await search(n)).filter((m) => m.item === n).reduce((a, m) => a + m.n, 0);
    }
    const owned = {};
    // An opportunity is done once the account holds the copies its characters need (`piecesNeeded`),
    // wherever they lie, because Inventory Search moves NO DROP pieces between characters. Only
    // pieces some group can hunt now, by its level, are searched for, which keeps the pass short.
    const groupLevels = tabs.map((t) => t.members.reduce((s, m) => s + (m.level ?? 0), 0) / Math.max(1, t.members.length));
    const reachable = (o) => !o.levels || groupLevels.some((l) => l >= o.levels[0] && l <= o.levels[1]);
    const members = tabs.flatMap((t) => t.members);
    // Four searches at a time: one at a time made the pass take two minutes, and all at once timed out.
    const queue = opportunities.filter(reachable);
    await Promise.all(Array.from({ length: 4 }, async () => {
      for (let o; (o = queue.shift()); ) owned[o.id] = (await search(o.item)).filter((m) => m.item === o.item).reduce((a, m) => a + m.n, 0) >= piecesNeeded(o, { quests, holders, members });
    }));
    // The wanted enemies' spawn points, read once from the content snapshot.
    const { spawnPoints } = await import("./lib/content.mjs");
    this.points ??= new Map();
    for (const o of opportunities) if (!this.points.has(o.id)) this.points.set(o.id, o.camp === false ? [] : await spawnPoints(o.zone, o.keep).catch(() => []));
    // An NPC wait watches the NPC's spawn points, because a point that another NPC holds rolls again
    // only when that NPC dies.
    for (const q of Object.values(quests)) {
      for (const s of q.steps) {
        if (!s.npc || !s.waitMin) continue;
        const k = `${s.zone}:${s.npc}`;
        if (!this.points.has(k)) this.points.set(k, await spawnPoints(s.zone, `^${s.npc}$`).catch(() => []));
        s.points = this.points.get(k);
      }
    }
    const state = metaGet(this.db, "coordinator") ?? { history: [] };
    // A finished hunt reports when its points respawn, which is when to come back.
    for (const h of state.history) {
      const task = tabs.find((t) => t.label === h.label)?.task;
      if (task?.id !== h.task || task.status === "running") continue;
      if (task.nextAt) h.nextAt = task.nextAt;
      if (task.endedAt) h.ms = task.endedAt - task.startedAt;
    }
    const held = await this.experimentPass(now, tabs, state);
    const gear = await this.gearPass(now, tabs).catch((e) => (this.log(`gear pass failed: ${e.message}`), null));
    // Wanted drops from the gear pass: for each group, the drop with the most gain per hour of
    // hunting among the zones of its rotation that no other group plays in, because a shared zone
    // left group 4 idle 40% of its errand, as an errand inside normal hunting.
    for (const t of tabs) {
      // The last gear pass's wants, kept in the db so a restart does not lose them for an hour.
      this.dropWants ??= metaGet(this.db, "gear")?.drops ?? [];
      const best = this.dropWants.filter((d) => groupOf.get(d.to) === t.group && (t.rotation ?? []).includes(d.zone) && !tabs.some((o) => o !== t && o.zone === d.zone)).sort((a, b) => b.gain / b.hours - a.gain / a.hours)[0];
      if (best) opportunities.push({ id: `drop-${best.to}-${best.slot}`, group: t.group, kind: "errand", zone: best.zone, keep: best.npc, item: best.item, count: 1, retryMin: 120, minutes: 30 });
    }
    const dropped = opportunities.filter((o) => o.id.startsWith("drop-"));
    if (dropped.length) this.log(`coordinator: ${dropped.length} wanted drops in the groups' rotations (${dropped.map((o) => `${o.item} for ${o.group}`).join(", ")})`);
    const actions = decide({ now, tabs, stock, opportunities: opportunities.map((o) => ({ ...o, points: this.points.get(o.id) })), owned, farms, quests, holders, started, have, gear, held, history: state.history });
    for (const a of actions) {
      const tab = tabs.find((t) => t.label === a.label);
      try {
        // An errand travels to its zone inside this call, after waiting for the fight at hand, which
        // takes up to about 30 s, so a shorter limit reported errands as not queued that had started.
        const r = await this.relay.evaluate(tab.targetId, call(queueInPage, { kind: a.kind, spec: a.spec }), { timeout: 40000 });
        state.history.push({ t: now, label: a.label, kind: a.kind, id: a.id ?? null, task: r?.id ?? null });
        this.db.query("INSERT INTO interventions (t, session, actor, text) VALUES (?, ?, 'coordinator', ?)").run(now, a.label, `${a.kind}: ${a.why}`);
        this.log(`coordinator: ${a.label} ${a.kind}: ${a.why}`);
      } catch (e) {
        this.log(`coordinator: ${a.label} ${a.kind} not queued: ${e.message}`);
      }
    }
    // Zone rotations by measured XP per hour. A tab given a task this pass keeps its rotation.
    const rates = await this.loadRates();
    const rows = JSON.parse(await readFile(join(REPO, "data/band-rotations.json"), "utf8"));
    const tasked = new Set(actions.map((a) => a.label));
    for (const z of assignZones({ now, tabs: tabs.map((t) => (tasked.has(t.label) ? { ...t, task: { status: "running" } } : t)), rows, rates })) {
      const tab = tabs.find((t) => t.label === z.label);
      const changed = await this.relay.evaluate(tab.targetId, call(applySettingsInPage, { s: { rotation: z.rotation } }), { timeout: 10000 }).catch(() => []);
      if (!changed?.length) continue;
      (this.zoneSetAt ??= new Map()).set(z.label, now);
      this.db.query("INSERT INTO interventions (t, session, actor, text) VALUES (?, ?, 'coordinator', ?)").run(now, z.label, `zone: ${z.rotation.join(", ")} for ${tab.group}, ${z.why}`);
      this.log(`coordinator: ${z.label} zone: ${z.rotation.join(", ")}, ${z.why}`);
    }
    metaSet(this.db, "rates", rates);
    // AA settings for each party, outside tasks, which may have another character active.
    for (const t of tabs.filter((x) => x.task?.status !== "running" && !tasked.has(x.label))) {
      const done = await this.relay.evaluate(t.targetId, call(aaInPage, AA_POLICY), { timeout: 20000 }).catch((e) => (this.log(`coordinator: ${t.label} AA settings: ${e.message}`), []));
      if (!done?.length) continue;
      this.db.query("INSERT INTO interventions (t, session, actor, text) VALUES (?, ?, 'coordinator', ?)").run(now, t.label, `aa: ${done.join("; ")}`);
      this.log(`coordinator: ${t.label} aa: ${done.join("; ")}`);
    }
    state.history = state.history.filter((h) => now - h.t < 2 * 86400000);
    state.last = { t: now, stock, owned, actions: actions.map((a) => ({ label: a.label, kind: a.kind, why: a.why })) };
    // How long the pass took, so a slow pass shows before it delays the groups.
    metaSet(this.db, "coordinator", { ...state, passMs: Date.now() - now });
  }

  /**
   * The measured zone rates (tools/lib/rates.mjs), kept in the db's meta key `rates` and grown by
   * `exportRows`. Without them, the first call reads every leader's recorded samples once, and a
   * minute counts as alone when no other leader recorded samples in that zone in that minute.
   */
  async loadRates() {
    this.zoneNames ??= await zoneNames();
    if (this.rates) return this.rates;
    const saved = metaGet(this.db, "rates");
    if (saved) return (this.rates = saved);
    const dir = join(this.runs, "live");
    const read = async (leader) => {
      const out = [];
      const text = await readFile(join(dir, leader, "samples.jsonl"), "utf8").catch(() => "");
      for (const line of text.split("\n")) {
        if (!line) continue;
        try {
          const s = JSON.parse(line);
          out.push({ ses: s.ses, t: s.t, act: s.act, busy: s.busy, lvl: s.lvl, xp: s.xp, zone: s.zone });
        } catch {
          /* a line cut short by a crash */
        }
      }
      return out;
    };
    const leaders = await readdir(dir).catch(() => []);
    const minute = (s) => `${Math.floor(s.t / 60000)}:${s.zone}`;
    const seen = new Map(); // minute and zone -> the leader seen there, or null for several
    for (const leader of leaders) {
      for (const s of await read(leader)) {
        const k = minute(s);
        if (!seen.has(k)) seen.set(k, leader);
        else if (seen.get(k) !== leader) seen.set(k, null);
      }
    }
    const rates = {};
    for (const leader of leaders) accumulate(rates, await read(leader), { zoneOf: (id) => this.zoneNames.get(id), alone: (s) => seen.get(minute(s)) === leader });
    this.log(`zone rates: read the samples of ${leaders.length} leaders`);
    return (this.rates = rates);
  }

  /**
   * Experiments from data/experiments.json (`experimentSettings` in tools/lib/coordinator.mjs): each
   * pass sets the arms' bot settings for the current block, records the start and the end in the
   * coordinator's state, and at the end registers a job with the crossover command that reads the
   * result. Returns the groups the experiments hold.
   */
  async experimentPass(now, tabs, state) {
    const { experimentSettings } = await import("./lib/coordinator.mjs");
    let experiments = [];
    try {
      experiments = JSON.parse(await readFile(join(REPO, "data/experiments.json"), "utf8"));
    } catch {
      return new Set();
    }
    const ex = (state.experiments ??= { started: {}, ended: {} });
    const { settings, events, held } = experimentSettings({ now, experiments, started: ex.started, ended: ex.ended });
    const note = (text) => {
      this.db.query("INSERT INTO interventions (t, session, actor, text) VALUES (?, ?, 'coordinator', ?)").run(now, null, text);
      this.log(`coordinator: ${text}`);
    };
    for (const e of events) {
      const x = experiments.find((y) => y.id === e.id);
      if (e.kind === "start") {
        ex.started[e.id] = e.start;
        note(`experiment ${e.id} started: A ${x.a.join(",")}, B ${x.b.join(",")}, blocks of ${x.blockMin} min`);
      } else {
        ex.ended[e.id] = now;
        const cmd = `bun tools/crossover.mjs --start ${e.start} --block ${x.blockMin} --a ${x.a.join(",")} --b ${x.b.join(",")}`;
        const job = this.db.query("INSERT INTO jobs (purpose, command, output, started) VALUES (?, ?, ?, ?) RETURNING id").get(`experiment ${e.id}: read the crossover and record it in the plans`, cmd, null, now).id;
        note(`experiment ${e.id} ended, job #${job}: ${cmd}`);
      }
    }
    for (const t of tabs) {
      const s = settings[t.group];
      if (!s) continue;
      const changed = await this.relay.evaluate(t.targetId, call(applySettingsInPage, { s }), { timeout: 10000 }).catch(() => []);
      if (changed?.length) this.log(`experiment settings for ${t.group}: ${changed.join(", ")}`);
    }
    return held;
  }

  /**
   * The roster gear pass, every `GEAR_EVERY_MIN`: worn items and the leaders' bags from every
   * party's own inventories, the companions' carried items from Inventory Search (`searchItems` in
   * the bridge), then the plan of tools/lib/gear-plan.mjs. The items the plan wants kept go to every
   * bot, and the moves go to the coordinator's policy, which queues them as one gear task. The
   * survey is saved to runs/state/account-items.json for tools/handdown.mjs.
   */
  async gearPass(now, tabs) {
    // The last pass is kept in the database, so a restart of iqd does not survey again at once.
    if (now - (metaGet(this.db, "gear")?.t ?? 0) < GEAR_EVERY_MIN * 60000) return null;
    metaSet(this.db, "gear", { t: now });
    const { BUY_PP, planGear, rosterPeople, mergeSurvey, surveyWords } = await import("./lib/gear-plan.mjs");
    const party = [];
    for (const t of tabs) party.push(...((await this.relay.evaluate(t.targetId, call(inventoryInPage, {}), { timeout: 10000 }).catch(() => [])) ?? []));
    const id = await this.relay.evaluate(tabs[0].targetId, call(startJobInPage, { name: "searchItems", args: [surveyWords(party.map((r) => r.itemName))] }), { timeout: 10000 });
    let job = null;
    for (let k = 0; k < 90 && !job?.done; k++) {
      await new Promise((r) => setTimeout(r, 2000));
      job = await this.relay.evaluate(tabs[0].targetId, call(jobInPage, { id }), { timeout: 10000 });
    }
    if (!job?.ok) throw new Error(`item search: ${job?.error ?? "did not finish"}`);
    const survey = mergeSurvey(party, job.result.rows);
    await writeFile(join(this.runs, "state/account-items.json"), JSON.stringify(survey)).catch(() => {});
    const { bardSongs, merchantGoods, rows, zoneDrops } = await import("./lib/gear-data.mjs");
    const { contentRoot } = await import("./lib/content.mjs");
    // The merchant goods and their item rows, read once.
    if (!this.shop) {
      const goods = await merchantGoods(contentRoot(), { maxPp: BUY_PP });
      this.shop = goods.shop;
      this.items = goods.items;
      const dropped = await zoneDrops(contentRoot(), JSON.parse(await readFile(join(REPO, "data/band-rotations.json"), "utf8")));
      this.drops = dropped.drops;
      for (const [id, i] of dropped.items) this.items.set(id, i);
    }
    const missing = new Set(survey.map((r) => r.itemId).filter((i) => !this.items.has(i)));
    if (missing.size) for await (const i of rows(contentRoot(), "items")) if (missing.has(i.id)) this.items.set(i.id, i);
    const raceOf = new Map(this.db.query("SELECT name, race FROM characters").all().map((r) => [r.name, r.race]));
    const { moves, wanted, drops } = planGear({ survey, items: this.items, people: rosterPeople(survey, rosterGroups(), raceOf), songs: await bardSongs(), shop: this.shop, buyPp: BUY_PP, drops: this.drops });
    this.dropWants = drops;
    for (const t of tabs) await this.relay.evaluate(t.targetId, call(setGearKeepInPage, { ids: wanted }), { timeout: 10000 }).catch(() => {});
    metaSet(this.db, "gear", { t: now, items: survey.length, moves: moves.length, kept: wanted.length, capped: job.result.capped, drops });
    this.log(`gear pass: ${survey.length} items, ${moves.length} moves, ${wanted.length} kept${job.result.capped.length ? `, cut off: ${job.result.capped.join(", ")}` : ""}`);
    return { moves };
  }

  async triggers() {
    try {
      return JSON.parse(await readFile(join(REPO, "data/triggers.json"), "utf8"));
    } catch {
      return [];
    }
  }

  levels() {
    return Object.fromEntries([...this.lastSnap].map(([id, s]) => [id, s.level]));
  }

  async cycle() {
    const now = Date.now();
    // An acknowledged vanished tab ends its session. Stop tracking it until it comes back.
    const ended = new Set(this.db.query("SELECT id FROM sessions WHERE ended IS NOT NULL").all().map((r) => r.id));
    for (const [id, tr] of this.trackers) if (tr.rowId && ended.has(tr.rowId)) this.trackers.delete(id);
    for (const id of this.relay.tabs().keys()) {
      if (!this.trackers.has(id)) this.trackers.set(id, { targetId: id, rowId: null, label: `tab:${id.slice(-4)}`, leader: null, state: {} });
    }
    const triggers = await this.triggers();
    if (this.recover) this.code = await import("../src/install.mjs").then((m) => m.codeVersion()).catch(() => this.code);
    await Promise.all([...this.trackers.values()].map((tr) => this.poll(tr, now, triggers).catch((e) => this.log(`poll ${tr.label}: ${e.message}`))));
    metaSet(this.db, "daemon", { pid: process.pid, intervalSec: this.intervalSec, last: Date.now(), relay: this.relay.connected, coordinate: this.coordinate });
    await this.coordinatePass(Date.now()).catch((e) => this.log(`coordinator: ${e.message}`));
    await writeFile(join(this.runs, "status.md"), renderStatus(this.db, Date.now()) + "\n");
  }

  async poll(tr, now, triggers) {
    const present = this.relay.connected && this.relay.tabs().has(tr.targetId);
    let obs;
    if (!present) obs = { reachable: false, present: false, error: this.relay.connected ? null : "relay not connected" };
    else {
      try {
        const snap = await this.relay.evaluate(tr.targetId, call(snapshotInPage, { session: tr.state.pageSession ?? null, after: tr.state.alertSeq ?? 0, sinceT: now - 900000 }), { timeout: 8000 });
        obs = { reachable: true, present: true, snap };
      } catch (e) {
        obs = { reachable: false, present: true, error: String(e.message).slice(0, 100) };
      }
    }
    const snap = obs.snap;
    const oldLabel = tr.label;
    if (snap?.leader?.name) tr.label = snap.leader.name;

    const usable = snap && !snap.error && snap.hasBridge && snap.pageSession != null;
    if (usable) {
      if (tr.state.pageSession != null && tr.state.pageSession !== snap.pageSession) {
        // The page reloaded: a new session with its own rule timers and alert cursor.
        if (tr.rowId) this.db.query("UPDATE sessions SET ended = ? WHERE id = ?").run(now, tr.rowId);
        tr.rowId = null;
        tr.state = {};
      }
      // The relay may list the same page under a new target id after it restarted.
      for (const [id, other] of this.trackers) {
        if (other !== tr && other.state.pageSession === snap.pageSession) {
          if (other.rowId) this.db.query("UPDATE sessions SET ended = ? WHERE id = ?").run(now, other.rowId);
          this.trackers.delete(id);
        }
      }
    }

    const res = stepSession({ state: tr.state, obs, now, label: tr.label, levels: this.levels(), triggers });
    tr.state = res.state;

    if (usable) {
      tr.state.pageSession = snap.pageSession;
      tr.snap = snap;
      if (snap.bot) tr.state.alertSeq = snap.bot.alertSeq;
      this.saveSession(tr, snap, now);
      this.recordCharacters(tr, snap, now);
    } else if (tr.rowId) {
      this.db.query("UPDATE sessions SET state = ? WHERE id = ?").run(JSON.stringify(tr.state), tr.rowId);
    }
    this.applyItems(tr, res, now, oldLabel);
    // A tab without the bridge or the bot is recovered, and one that runs older code gets the new
    // code, unless a raid runs, which a reinstall would end.
    const stale = snap?.hasBridge && snap.hasBot && this.code && snap.code !== this.code && !snap.raid;
    if (obs.reachable && snap && !snap.error && (!snap.hasBridge || !snap.hasBot || stale)) await this.recoverTab(tr, now, stale).catch((e) => this.log(`recovery ${tr.label}: ${e.message}`));
    else if (snap?.hasBot && !stale) tr.state.recovery = null;
    if (usable && snap.leader && snap.rec) await this.exportRows(tr, snap).catch((e) => this.log(`export ${tr.label}: ${e.message}`));
  }

  saveSession(tr, snap, now) {
    const leader = snap.leader;
    const parked = snap.bot?.enabled === false ? 1 : 0;
    const row = this.db
      .query(
        `INSERT INTO sessions (target_id, page_session, leader_id, leader, first_seen, last_seen, parked, state, snap) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (target_id, page_session) DO UPDATE SET leader_id = excluded.leader_id, leader = excluded.leader, last_seen = excluded.last_seen, ended = NULL, parked = excluded.parked, state = excluded.state, snap = excluded.snap
         RETURNING id`,
      )
      .get(tr.targetId, snap.pageSession, leader?.id ?? null, leader?.name ?? tr.leader, now, now, parked, JSON.stringify(tr.state), JSON.stringify(snap));
    tr.rowId = row.id;
    tr.prevLeader = tr.leader;
    tr.leader = leader?.name ?? tr.leader;
  }

  /**
   * Bring a reachable game tab without the bridge or the bot back to play, at most every two
   * minutes (`--recover`): sign in with the stored login when the login form shows, then install
   * the bridge and bot as the SDK does (src/install.mjs). The bot keeps its settings in the tab's
   * sessionStorage, so a reloaded tab knows its leader. A tab that lost them gets its group's leader
   * and members from data/roster.json, by the leader it showed before. The bot then enters the
   * world as the leader and regroups by itself.
   */
  async recoverTab(tr, now, update = false) {
    if (!this.recover) return;
    const r = (tr.state.recovery ??= { attempts: 0, at: 0 });
    if (now - r.at < 120000) return;
    r.at = now;
    r.attempts++;
    const { installExpressions, screenInPage, signInInPage, storedLogin } = await import("../src/install.mjs");
    const evaluate = (expression, timeout = 15000) => this.relay.evaluate(tr.targetId, expression, { timeout });
    const screen = await evaluate(`(${screenInPage})()`);
    const note = (text) => {
      this.db.query("INSERT INTO interventions (t, session, actor, text) VALUES (?, ?, 'iqd', ?)").run(now, tr.label, text);
      this.log(`recovery ${tr.label}: ${text}`);
    };
    if (screen === "loading") return;
    if (screen === "login") {
      await evaluate(`(${signInInPage})(${JSON.stringify(await storedLogin())})`);
      return note("signed in with the stored login");
    }
    for (const e of await installExpressions()) await evaluate(e, 30000);
    const g = JSON.parse(readFileSync(join(REPO, "data/roster.json"), "utf8")).groups.find((x) => x.members?.[0] === tr.leader);
    const set = g ? await evaluate(`(${setGroupInPage})(${JSON.stringify({ leader: g.members[0], members: g.members.slice(1) })})`) : false;
    if (update) return this.log(`deploy ${tr.label}: code ${this.code}`);
    note(`installed the bridge and bot at ${screen}${set ? `, and set ${g.members[0]} as leader of ${g.id}` : ""}`);
  }

  recordCharacters(tr, snap, now) {
    const db = this.db;
    const upsert = db.query(
      `INSERT INTO characters (id, name, class, race, roster_level, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET name = excluded.name, class = COALESCE(excluded.class, class), race = COALESCE(excluded.race, race), roster_level = COALESCE(excluded.roster_level, roster_level), last_seen = excluded.last_seen`,
    );
    const seeRoster = db.query("INSERT INTO characters (id, name, class, race, roster_level, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET name = excluded.name, class = COALESCE(excluded.class, class), race = COALESCE(excluded.race, race), roster_level = excluded.roster_level");
    const insertSnap = db.query("INSERT INTO char_snapshots (char_id, t, session_id, leader, level, xp_pct, max_hp, max_mana, zone) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    const live = [];
    if (snap.leader) live.push({ ...snap.leader, isLeader: 1 });
    for (const m of snap.party ?? []) if (m.type === 2 && m.id != null) live.push({ ...m, isLeader: 0 });
    db.transaction(() => {
      for (const r of snap.roster ?? []) seeRoster.run(r.id, r.name, r.class, r.race, r.level, now, now);
      for (const c of live) {
        const roster = (snap.roster ?? []).find((r) => r.id === c.id);
        upsert.run(c.id, c.name, c.class ?? roster?.class ?? null, c.race ?? roster?.race ?? null, roster?.level ?? null, now, now);
        const prev = this.lastSnap.get(c.id);
        const next = { t: now, level: c.level, maxHp: c.maxHp, maxMana: c.maxMana, zone: snap.zone };
        const changed = !prev || prev.level !== next.level || prev.maxHp !== next.maxHp || prev.maxMana !== next.maxMana || prev.zone !== next.zone;
        if (changed || now - prev.t >= THRESHOLDS.snapshotEverySec * 1000) {
          insertSnap.run(c.id, now, tr.rowId, c.isLeader, c.level, c.xpPct ?? null, c.maxHp, c.maxMana, snap.zone);
          this.lastSnap.set(c.id, next);
        }
      }
    })();
  }

  applyItems(tr, res, now, oldLabel = tr.label) {
    syncAttention(this.db, { label: tr.label, oldLabel, res, now, log: this.log });
  }

  async exportRows(tr, snap) {
    const dir = join(this.runs, "live", safeName(snap.leader.name));
    let cur = this.cursors.get(dir);
    if (!cur) {
      cur = { s: tailCursor(join(dir, "samples.jsonl")), e: tailCursor(join(dir, "events.jsonl")) };
      // A tab that switched to another character carries the earlier character's rows. Start after them.
      if (!cur.s.ses && !cur.e.ses && tr.prevLeader && tr.prevLeader !== snap.leader.name) {
        cur = { s: { ses: snap.rec.ses, seq: snap.rec.seqS }, e: { ses: snap.rec.ses, seq: snap.rec.seqE } };
      }
      this.cursors.set(dir, cur);
    }
    await mkdir(dir, { recursive: true });
    for (let i = 0; i < 12; i++) {
      const got = await this.relay.evaluate(tr.targetId, call(drainInPage, { s: cur.s, e: cur.e, maxS: 2000, maxE: 4000 }), { timeout: 10000 });
      if (!got) return;
      if (got.samples.length) {
        await appendFile(join(dir, "samples.jsonl"), got.samples.map((r) => JSON.stringify(r)).join("\n") + "\n");
        cur.s = { ses: got.samples.at(-1).ses ?? 0, seq: got.samples.at(-1).seq };
        this.addRates(tr, got.samples);
      }
      if (got.events.length) {
        await appendFile(join(dir, "events.jsonl"), got.events.map((r) => JSON.stringify(r)).join("\n") + "\n");
        cur.e = { ses: got.events.at(-1).ses ?? 0, seq: got.events.at(-1).seq };
      }
      if (!got.more) return;
    }
  }

  /**
   * Add a tab's new samples to the zone rates, with the pair across two drains. The group counts as
   * alone while no other tab's latest sample of the last two minutes lies in its zone.
   */
  addRates(tr, samples) {
    const last = samples.at(-1);
    if (this.rates && this.zoneNames) {
      const others = [...this.trackers.values()].filter((o) => o !== tr && o.lastSample && last.t - o.lastSample.t < 120000).map((o) => o.lastSample.zone);
      accumulate(this.rates, tr.lastSample ? [tr.lastSample, ...samples] : samples, { zoneOf: (id) => this.zoneNames.get(id), alone: (s) => !others.includes(s.zone) });
    }
    tr.lastSample = last;
  }

  async loop() {
    while (!this.stopped) {
      const started = Date.now();
      try {
        await this.cycle();
      } catch (e) {
        this.log(`cycle failed: ${e.stack ?? e.message}`);
      }
      const wait = Math.max(1000, this.intervalSec * 1000 - (Date.now() - started));
      for (let waited = 0; waited < wait && !this.stopped; waited += 500) await sleep(500);
    }
  }
}

// ---- Status -------------------------------------------------------------------------------------

const clock = (t) => new Date(t).toTimeString().slice(0, 8);
const dur = (ms) => (ms < 90000 ? `${Math.round(ms / 1000)}s` : ms < 5400000 ? `${Math.round(ms / 60000)}m` : `${(ms / 3600000).toFixed(1)}h`);
const big = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}k` : String(Math.round(n)));
const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}~` : s);

/** Group of each character name from data/roster.json, or an empty map without the file. */
export function rosterGroups() {
  try {
    const r = JSON.parse(readFileSync(join(REPO, "data/roster.json"), "utf8"));
    return new Map(r.groups.flatMap((g) => (g.members ?? []).map((n) => [n, g.id])));
  } catch {
    return new Map();
  }
}

/**
 * What one open session row of the database says about its tab at `now`: who leads, where, what
 * the party does and since when, its kill and XP rates over the snapshot's window, the idle share of
 * the last 10 minutes, the last kill, page memory and the bot's errand or pause. The status text and
 * the dashboard both read tabs through this.
 */
export function sessionSummary(s, now, groupOf = rosterGroups()) {
  const sn = s.snap ? JSON.parse(s.snap) : null;
  const st = s.state ? JSON.parse(s.state) : {};
  const l = sn?.leader;
  const k = sn?.kills;
  const hours = k?.winMs >= 60000 ? k.winMs / 3600000 : null;
  const a = sn?.activity;
  const secs = Object.entries(sn?.activitySec ?? {});
  const total = secs.reduce((sum, [, v]) => sum + v, 0);
  const idle = secs.filter(([key]) => key.startsWith("idle") || key === "dead").reduce((sum, [, v]) => sum + v, 0);
  return {
    group: groupOf.get(s.leader) ?? null,
    leader: s.leader ?? null,
    level: l?.level ?? null,
    xpPct: l?.xpPct ?? null,
    zone: sn?.zone ?? null,
    goneMs: st.unreachableSince ? now - st.unreachableSince : null,
    parked: Boolean(s.parked),
    raid: Boolean(sn?.raid),
    activity: a ? { act: a.act, why: a.why ?? null, forMs: (sn.t ?? now) - a.since } : null,
    autoLevel: sn?.autoLevel ?? null,
    killsPerHour: hours ? k.n30 / hours : null,
    xpPerHour: hours ? k.xp30 / hours : null,
    activitySec: sn?.activitySec ?? null,
    idleShare: total ? idle / total : null,
    lastKillMs: k?.last ? now - k.last : null,
    lastEnemy: k?.lastEnemy ?? null,
    heap: sn?.heap ?? null,
    bags: sn?.bags ?? null,
    errand: sn?.bot?.errand ?? null,
    pause: sn?.bot?.pauseUntil > now ? { untilMs: sn.bot.pauseUntil - now, reason: sn.bot.pauseReason } : null,
    party: [...(l ? [{ name: l.name, level: l.level, class: l.class, hp: l.hp, maxHp: l.maxHp, mana: l.mana, maxMana: l.maxMana }] : []), ...(sn?.party ?? []).filter((m) => m.type === 2).map((m) => ({ name: m.name, level: m.level, class: m.class, hp: m.hp, maxHp: m.maxHp, mana: m.mana, maxMana: m.maxMana }))],
    seenMs: now - s.last_seen,
  };
}

/** Plain-text status, at most 40 lines. Reads the database only. */
export function renderStatus(db, now, groupOf = rosterGroups()) {
  const out = [];
  const d = metaGet(db, "daemon");
  const age = d ? now - d.last : null;
  const alive = d && age < (d.intervalSec * 3 + 10) * 1000;
  const state = !d ? "NOT STARTED" : !d.last ? "STOPPED" : alive ? `running (pid ${d.pid}, every ${d.intervalSec}s, last cycle ${dur(age)} ago, relay ${d.relay ? "up" : "DOWN"})` : `NOT RUNNING (last cycle ${dur(age)} ago)`;
  out.push(`iqd ${clock(now)}  daemon ${state}`);

  out.push("Sessions");
  const sessions = db.query("SELECT * FROM sessions WHERE ended IS NULL ORDER BY first_seen, id").all();
  if (!sessions.length) out.push("  none");
  for (const s of sessions) {
    const v = sessionSummary(s, now, groupOf);
    const head = `${v.group ?? "--"} ${v.leader ?? "?"} L${v.level ?? "?"}${v.xpPct != null ? ` ${v.xpPct.toFixed(0)}%` : ""} ${v.zone ?? "?"}`;
    let tail;
    if (v.goneMs != null) tail = `GONE ${dur(v.goneMs)}`;
    else if (v.parked) tail = "PARKED (bot disabled)";
    else {
      const rates = v.killsPerHour != null ? `${Math.round(v.killsPerHour)} kills/h ${big(v.xpPerHour)} xp/h` : "rates n/a";
      // What the party did at the last look and for how long, and the idle share of the 10 minutes before.
      const mode = v.raid ? "raid" : v.activity ? `${v.activity.act}${v.activity.why ? `(${v.activity.why})` : ""} ${dur(v.activity.forMs)}` : v.autoLevel?.running ? "running" : "OFF";
      tail = `${mode} ${rates}${v.idleShare != null ? ` idle ${Math.round(100 * v.idleShare)}%` : ""} last kill ${v.lastKillMs != null ? dur(v.lastKillMs) : "none"}`;
    }
    out.push(cut(`  ${head} | ${tail} | heap ${v.heap ? `${v.heap.used}MB ${Math.round((100 * v.heap.used) / v.heap.limit)}%` : "n/a"}`, 150));
  }

  const chars = db
    .query(
      `SELECT c.name, c.class, c.race, c.roster_level, (SELECT level FROM char_snapshots s WHERE s.char_id = c.id ORDER BY s.id DESC LIMIT 1) AS level FROM characters c ORDER BY c.name`,
    )
    .all();
  out.push(`Characters (${chars.length})`);
  const byGroup = new Map();
  for (const c of chars) {
    const g = groupOf.get(c.name) ?? "--";
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g).push(c);
  }
  const order = [...byGroup.keys()].sort((a, b) => (a === "--") - (b === "--") || Number(a.slice(1)) - Number(b.slice(1)));
  for (const g of order) {
    const cells = byGroup.get(g).map((c) => `${c.name} ${(c.class ?? "?").toLowerCase()} ${c.level ?? `~${c.roster_level ?? "?"}`}`);
    out.push(cut(`  ${g} ${cells.join(", ")}`, 150));
  }

  const items = db.query("SELECT * FROM attention WHERE resolved IS NULL ORDER BY id").all();
  const urgent = items.filter((a) => a.severity !== "info");
  out.push(`Attention (${urgent.length} open${items.length > urgent.length ? `, ${items.length - urgent.length} info` : ""})`);
  for (const a of urgent.slice(0, 8)) out.push(cut(`  #${a.id} ${a.severity} ${a.kind} ${clock(a.t)} ${a.text}`, 150));
  if (urgent.length > 8) out.push(`  and ${urgent.length - 8} more`);

  const jobs = db.query("SELECT * FROM jobs WHERE done IS NULL ORDER BY id").all();
  out.push(`Jobs (${jobs.length} open)`);
  for (const j of jobs.slice(0, 4)) out.push(cut(`  #${j.id} ${j.purpose} | ${j.command ?? ""} -> ${j.output ?? ""} since ${clock(j.started)}`, 150));
  if (jobs.length > 4) out.push(`  and ${jobs.length - 4} more`);

  const notes = db.query("SELECT * FROM interventions ORDER BY id DESC LIMIT 3").all().reverse();
  if (notes.length) {
    out.push("Latest notes");
    for (const n of notes) out.push(cut(`  ${clock(n.t)} ${n.actor}${n.session ? ` (${n.session})` : ""}: ${n.text}`, 150));
  }
  return out.slice(0, 40).join("\n");
}

// ---- Commands -----------------------------------------------------------------------------------

const HELP = `iqd <command>
  run [--interval 30] [--port 4790] [--coordinate] [--recover]
                                 collect game tab state until stopped, with the dashboard on the port (0 for none);
                                 --coordinate also queues hand-ins and hunts by tools/lib/coordinator.mjs,
                                 --recover signs tabs in again, reinstalls a missing bridge and bot, and deploys changed code
  serve [--port 4790]            only the dashboard, on the database as it is
  status                         sessions, characters, open attention items and jobs
  wait [--severity act|decide|info] [--max-minutes 60]
                                 block until a new unresolved attention item appears
  ack <id> [note]                resolve an attention item
  note <text> [--session leader] [--actor agent]
  job add --purpose .. --cmd .. --out ..
  job done <id> [result]
Global option: --runs <dir> (default runs/ of this repository, or $IQD_RUNS)`;

function parse(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: false,
    options: { interval: { type: "string" }, port: { type: "string" }, coordinate: { type: "boolean" }, recover: { type: "boolean" }, severity: { type: "string" }, "max-minutes": { type: "string" }, session: { type: "string" }, actor: { type: "string" }, purpose: { type: "string" }, cmd: { type: "string" }, out: { type: "string" }, runs: { type: "string" } },
  });
  const runs = values.runs ?? process.env.IQD_RUNS ?? join(REPO, "runs");
  return { values, positionals, runs: isAbsolute(runs) ? runs : join(process.cwd(), runs) };
}

const stamp = () => `${new Date().toLocaleDateString("sv")} ${clock(Date.now())}`;

async function cmdRun({ values, runs }) {
  const intervalSec = Number(values.interval ?? 30);
  if (!(intervalSec >= 5)) throw new Error("--interval must be at least 5 seconds");
  await mkdir(runs, { recursive: true });
  const db = openDb(join(runs, "iq.db"));
  const prior = metaGet(db, "daemon");
  if (prior && prior.pid !== process.pid && Date.now() - prior.last < (prior.intervalSec * 3 + 10) * 1000) {
    try {
      process.kill(prior.pid, 0);
      throw new Error(`another iqd run is active (pid ${prior.pid})`);
    } catch (e) {
      if (e.code !== "ESRCH") throw e;
    }
  }
  const log = (m) => console.log(`${stamp()} ${m}`);
  const relay = new Relay();
  const logAttach = db.query("INSERT INTO attach_log (t, target_id, url, event) VALUES (?, ?, ?, ?)");
  relay.on("attached", (a) => {
    logAttach.run(Date.now(), a.targetId, a.url, "attach");
    log(`attached ${a.targetId.slice(-4)} ${a.url}`);
  });
  relay.on("violation", (a) => {
    logAttach.run(Date.now(), a.targetId, a.url, "violation");
    log(`relay attached a non-game page, detached it: ${a.targetId}`);
  });
  relay.on("connected", () => log("relay connected"));
  relay.on("disconnected", () => log("relay disconnected"));
  relay.on("tab-added", (i) => log(`tab appeared ${i.targetId.slice(-4)}`));
  relay.on("tab-removed", (i) => log(`tab gone ${i.targetId.slice(-4)}`));
  const daemon = new Daemon({ db, relay, runs, intervalSec, log, coordinate: Boolean(values.coordinate), recover: Boolean(values.recover) });
  const stop = async () => {
    daemon.stopped = true;
    await relay.stop();
    metaSet(db, "daemon", { pid: process.pid, intervalSec, last: 0, relay: false });
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  await relay.start();
  log(`iqd started, every ${intervalSec}s, data in ${runs}`);
  const port = Number(values.port ?? 4790);
  if (port) {
    // A dashboard that cannot start, such as on a taken port, must not stop the collector.
    try {
      const { startDashboard } = await import("./lib/dashboard-server.mjs");
      startDashboard({ db, port, log });
    } catch (e) {
      log(`dashboard did not start: ${e.message}`);
    }
  }
  await daemon.loop();
}

async function cmdServe({ values, runs }) {
  const db = openDb(join(runs, "iq.db"));
  const { startDashboard } = await import("./lib/dashboard-server.mjs");
  startDashboard({ db, port: Number(values.port ?? 4790) });
}

async function cmdStatus({ runs }) {
  const db = openDb(join(runs, "iq.db"));
  console.log(renderStatus(db, Date.now()));
}

async function cmdWait({ values, runs }) {
  const sev = values.severity ?? "act";
  if (!SEVERITY_RANK[sev]) throw new Error("--severity must be act, decide or info");
  const maxMs = Number(values["max-minutes"] ?? 60) * 60000;
  const db = openDb(join(runs, "iq.db"));
  const key = `wait:${sev}`;
  let cursor = metaGet(db, key);
  if (cursor == null) {
    cursor = db.query("SELECT COALESCE(MAX(id), 0) AS m FROM attention").get().m;
    metaSet(db, key, cursor);
  }
  const kinds = Object.keys(SEVERITY_RANK).filter((s) => SEVERITY_RANK[s] >= SEVERITY_RANK[sev]);
  const q = db.query(`SELECT * FROM attention WHERE resolved IS NULL AND id > ? AND severity IN (${kinds.map(() => "?").join(",")}) ORDER BY id`);
  const deadline = Date.now() + maxMs;
  for (;;) {
    const rows = q.all(cursor, ...kinds);
    if (rows.length) {
      metaSet(db, key, rows.at(-1).id);
      for (const a of rows) console.log(`ATTENTION #${a.id} ${a.severity} ${a.kind}${a.session ? ` [${a.session}]` : ""} ${clock(a.t)}: ${a.text}`);
      console.log("");
      console.log(renderStatus(db, Date.now()));
      return;
    }
    if (Date.now() >= deadline) {
      console.log(`wait: nothing new at ${sev} or above after ${Math.round(maxMs / 60000)} min`);
      console.log("");
      console.log(renderStatus(db, Date.now()));
      return;
    }
    await sleep(Math.min(2000, Math.max(100, deadline - Date.now())));
  }
}

async function cmdAck({ positionals, runs }) {
  const id = Number(positionals[1]);
  if (!Number.isInteger(id)) throw new Error("usage: iqd ack <id> [note]");
  const db = openDb(join(runs, "iq.db"));
  const row = db.query("SELECT * FROM attention WHERE id = ?").get(id);
  if (!row) throw new Error(`no attention item #${id}`);
  if (!resolveItem(db, id, positionals.slice(2).join(" ") || "acknowledged")) return console.log(`#${id} was resolved already`);
  // An acknowledged vanished tab is closed on purpose: stop tracking its session.
  if (row.kind === "gone") {
    for (const s of db.query("SELECT id, state FROM sessions WHERE ended IS NULL AND leader IS ?").all(row.session)) {
      if (JSON.parse(s.state ?? "{}").unreachableSince) db.query("UPDATE sessions SET ended = ? WHERE id = ?").run(Date.now(), s.id);
    }
  }
  console.log(`resolved #${id}`);
}

async function cmdNote({ values, positionals, runs }) {
  const text = positionals.slice(1).join(" ");
  if (!text) throw new Error("usage: iqd note <text> [--session leader]");
  const db = openDb(join(runs, "iq.db"));
  const id = db.query("INSERT INTO interventions (t, session, actor, text) VALUES (?, ?, ?, ?) RETURNING id").get(Date.now(), values.session ?? null, values.actor ?? "agent", text).id;
  console.log(`noted #${id}`);
}

async function cmdJob({ values, positionals, runs }) {
  const db = openDb(join(runs, "iq.db"));
  const sub = positionals[1];
  if (sub === "add") {
    if (!values.purpose) throw new Error("usage: iqd job add --purpose .. --cmd .. --out ..");
    const id = db.query("INSERT INTO jobs (purpose, command, output, started) VALUES (?, ?, ?, ?) RETURNING id").get(values.purpose, values.cmd ?? null, values.out ?? null, Date.now()).id;
    console.log(`job #${id}`);
  } else if (sub === "done") {
    const id = Number(positionals[2]);
    if (!Number.isInteger(id)) throw new Error("usage: iqd job done <id> [result]");
    const n = db.query("UPDATE jobs SET done = ?, result = ? WHERE id = ? AND done IS NULL").run(Date.now(), positionals.slice(3).join(" ") || null, id).changes;
    console.log(n ? `job #${id} done` : `job #${id} not open`);
  } else throw new Error("usage: iqd job add|done");
}

async function main(argv) {
  const args = parse(argv);
  const cmd = args.positionals[0];
  const table = { run: cmdRun, serve: cmdServe, status: cmdStatus, wait: cmdWait, ack: cmdAck, note: cmdNote, job: cmdJob };
  if (!table[cmd]) {
    console.log(HELP);
    process.exit(cmd && cmd !== "help" ? 1 : 0);
  }
  await table[cmd](args);
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(`iqd: ${e.message}`);
    process.exit(1);
  });
}
