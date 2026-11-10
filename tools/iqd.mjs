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
import { MinuteFolder, backfillMinutes, pruneMinutes } from "./lib/minutes.mjs";
import { targetId } from "./lib/acquire.mjs";
import { WEAR_SCHEMA, recordWear } from "./lib/wear.mjs";
import { PROGRESS_SCHEMA, aaChanges, chainChanges, gearChanges, levelUps, lootProgress, progressCounts, recordProgress, snapshotProgress } from "./lib/progress.mjs";
import { CARDS_SCHEMA, missingCards, putCards } from "./lib/cards.mjs";
import { pageStep } from "./lib/page.mjs";
import { screenInPage } from "../src/install.mjs";

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
CREATE TABLE IF NOT EXISTS minutes (
  grp TEXT NOT NULL, minute INTEGER NOT NULL, sec TEXT NOT NULL, xp REAL NOT NULL DEFAULT 0, deaths INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (grp, minute)) WITHOUT ROWID;
`;

export function openDb(path) {
  const db = new Database(path, { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA busy_timeout = 5000");
  db.run(SCHEMA);
  db.run(WEAR_SCHEMA);
  db.run(PROGRESS_SCHEMA);
  db.run(CARDS_SCHEMA);
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
  for (const c of levelUps(snap, levels)) item("info", "levelup", `levelup:${c.id}:${c.level}`, `${c.name}${c.class ? ` (${c.class})` : ""} reached level ${c.level}`);
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
  // Room in the bags means new drops are looted again, and room up to the bot's reserve ends the
  // shortage a bags alert reported.
  if (snap.bags?.free >= 4) settled["alert-lootFull"] = now;
  if (snap.bags?.reserve != null && snap.bags.free >= snap.bags.reserve) settled["alert-bags"] = now;
  // A page back in the game world ends the outage an offline alert reported.
  if (snap.conn?.screen === "game" && snap.conn.connected) settled["alert-offline"] = now;
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
    if (res.settled?.[e.kind] >= e.t) resolveItem(db, e.id, { "alert-task": "a later task finished", "alert-cursor": "the cursor is empty", "alert-lootFull": "the bags have room" }[e.kind] ?? "the tab plays again", now);
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
      // The raid alert of a kill names its boss (`killed`) for the progress feed.
      const wake = st.alerts.filter((x) => x.seq > after && x.t >= since && x.wake);
      out.bot = {
        enabled: bot.config.enabled,
        pauseUntil: st.pauseUntil || 0,
        pauseReason: st.pauseReason ?? null,
        rotation: bot.config.rotation ?? [],
        crowdedAt: st.crowdedAt ?? {},
        errand: st.errand ? { zone: st.errand.zone, item: st.errand.item, keep: st.errand.keep, since: st.errand.since, until: st.errand.until } : null,
        task: st.task ? { id: st.task.id, kind: st.task.kind, status: st.task.status, step: st.task.step ?? null, startedAt: st.task.startedAt, result: st.task.result ?? null, error: st.task.error ?? null, nextAt: st.task.nextAt ?? null, endedAt: st.task.endedAt ?? null } : null,
        // Past the 50 alerts that fit, the cursor stops at the last one returned.
        alertSeq: wake.length > 50 ? wake[49].seq : st.alertSeq,
        alerts: wake.slice(0, 50).map((x) => ({ seq: x.seq, t: x.t, kind: x.kind, wake: x.wake, text: String(x.text).slice(0, 400), killed: x.killed ?? null })),
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
    // `supportManaRegen`: the mana regeneration the party's supply gives every member, which sets how
    // fast the slowest bar refills between fights (docs/client-internals.md, Readiness wait).
    out.leader = p?.id
      ? { id: p.id, name: p.name, level: p.level, class: p.class?.name ?? cls[p.class] ?? null, race: p.race?.name ?? races[p.race] ?? null, hp: p.curHp, maxHp: p.maxHp, mana: p.mana, maxMana: p.maxMana, xpPct: ep ? ep.progressBasisPoints / 100 : null, xp: ep?.current ?? null, supportManaRegen: p.partySupport?.bonuses?.ManaRegen ?? null }
      : null;
    // The party's supplied run speed and the Bard's run song in it with its instrument modifier,
    // which the gear plan weighs a Bard's percussion instrument by (`walkShares`).
    const runSong = (p?.partySupport?.contributions ?? []).find((c) => c.classId === 8 && /Run speed/.test(c.description ?? ""));
    out.runSpeed = p?.id ? { total: p.movementSpeedMod ?? null, bard: runSong ? { name: runSong.providerName, level: runSong.casterLevel, mod: runSong.instrumentMod ?? 10, spellId: runSong.spellId } : null } : null;
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
    out.rendering = !cb.disable3D;
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
    out.faults = iq.faults ?? null;
    out.shims = iq.shimCounts ?? null;
    out.bags = p?.id ? { ...iq.bagSpace(), reserve: window.iqBot?.config?.minFreeSlots ?? null } : null;
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
// A pass that failed, such as an Inventory Search the server timed out, comes again this soon.
const GEAR_RETRY_MIN = 10;
// The raid budget a gear pass leaves untouched: an hour of raid time and a casino boss potion a day
// (docs/plans/leveling-plan.md, lever 9).
const RAID_PP_PER_DAY = 5300;
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
 * because the window does not allocate while the rule pauses a character. Returns what it changed
 * and the active character's AA state: `{ done, state: { name, level, points, spent, ranks, names, maxRanks, allocation } }`,
 * where `names` maps ability ids to names and `maxRanks` sums the catalog's maximum ranks.
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
  const s = r.state;
  return { done, state: { name: s.characterName, level: s.characterLevel, points: s.points ?? 0, spent: s.spent ?? 0, ranks: s.ranks ?? {}, names: Object.fromEntries((s.abilities ?? []).map((x) => [x.id, x.name])), maxRanks: (s.abilities ?? []).reduce((n, x) => n + (x.maxRank ?? 0), 0), allocation: s.allocation ?? null } };
}

/** Give the bot what the roster gear plan needs kept: copies per item the account is short of, and the copies its moves take. */
export function setGearKeepInPage(a) {
  window.iqBot.set({ gearKeepCounts: a.counts, gearKeepInstances: a.instances });
  return Object.keys(a.counts).length + a.instances.length;
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
    const { decide, assignZones, chainNeeders, chainSummary, crowdedZones, doneItems, piecesNeeded, progressItems, questKeepItems, settleHistory, AA_POLICY } = await import("./lib/coordinator.mjs");
    const groupOf = rosterGroups();
    // When each tab last got a rotation, from the coordinator's logged zone changes, so a restart keeps it.
    this.zoneSetAt ??= new Map(this.db.query("SELECT session, MAX(t) AS t FROM interventions WHERE actor = 'coordinator' AND text LIKE 'zone:%' GROUP BY session").all().map((r) => [r.session, r.t]));
    const tabs = [...this.trackers.values()]
      .filter((tr) => tr.snap?.leader && tr.snap.bot?.enabled !== false && !tr.state.unreachableSince && !tr.snap.raid && !(tr.snap.bot?.pauseUntil > now && tr.snap.bot?.task?.status !== "running"))
      .map((tr) => ({ targetId: tr.targetId, label: tr.label, group: groupOf.get(tr.snap.leader.name) ?? null, members: [tr.snap.leader, ...(tr.snap.party ?? []).filter((m) => m.type === 2)].map((m) => ({ name: m.name, level: m.level, class: m.class ?? null })), task: tr.snap.bot?.task ?? null, errand: tr.snap.bot?.errand ?? null, zone: tr.snap.zoneShort ?? null, rotation: tr.snap.bot?.rotation ?? null, crowdedAt: tr.snap.bot?.crowdedAt ?? {}, rotationSetAt: this.zoneSetAt?.get(tr.label) ?? null, gameHour: tr.snap.gameHour }));
    if (!tabs.length) return;
    // Crowding by other players holds for every group, and a tab's own reports end with the tab, so
    // the account remembers the newest report per zone for 45 minutes and every tab carries the same
    // map. A machine restart had sent group 1 straight back to two crowded zones. A report from a zone
    // where another of our groups hunts is left out, because the zone choice counts our own groups
    // already (`crowdFactor`): seven restored groups in Permafrost marked it crowded and pushed five
    // groups into Paw. Only reports since the last pass count, so the groups' zones now are the zones
    // at the report.
    const crowdedAt = metaGet(this.db, "crowded") ?? {};
    for (const t of tabs) for (const [z, at] of Object.entries(t.crowdedAt)) if (now - at < 6 * 60000 && !(crowdedAt[z] >= at) && !tabs.some((o) => o !== t && o.zone === z)) crowdedAt[z] = at;
    for (const z of Object.keys(crowdedAt)) if (now - crowdedAt[z] > 45 * 60000) delete crowdedAt[z];
    metaSet(this.db, "crowded", crowdedAt);
    for (const t of tabs) t.crowdedAt = crowdedAt;
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
    // The copies of each piece a chain's needers still lack past the free copies of others, which
    // makes a looted copy progress (`recordPassProgress`).
    const lacking = {};
    const members = tabs.flatMap((t) => t.members);
    const carriers = async (item) => (await search(item)).filter((m) => m.item === item).map((m) => m.who);
    for (const [id, q] of Object.entries(quests)) {
      // A character is done with a chain while it carries an item that shows it (`doneItems`): the
      // reward, or what the reward was spent on, so a spent reward does not restart the chain.
      holders[id] = [...new Set((await Promise.all(doneItems(id, quests).map(carriers))).flat())];
      // A step's item shows progress only once the chain's needed pieces lie behind it
      // (`progressItems`), because a member who holds an earlier step's item still needs the pieces.
      started[id] = [...new Set((await Promise.all(progressItems(q).map(carriers))).flat())];
      if (!q.needs?.length) continue;
      // A copy a needer of the chain carries is its own: it is not free for others (`have`), and a
      // needer that carries every piece runs like one part way through.
      const needers = chainNeeders(id, { quests, holders, members });
      const rows = await Promise.all(q.needs.map(async (n) => (await search(n)).filter((m) => m.item === n)));
      q.needs.forEach((n, k) => (have[n] = Math.min(have[n] ?? Infinity, rows[k].filter((m) => !needers.includes(m.who)).reduce((a, m) => a + m.n, 0))));
      q.needs.forEach((n, k) => {
        const free = rows[k].filter((m) => !needers.includes(m.who)).reduce((a, m) => a + m.n, 0);
        lacking[n] = Math.max(lacking[n] ?? 0, needers.filter((who) => !rows[k].some((m) => m.who === who)).length - free);
      });
      started[id].push(...needers.filter((who) => rows.every((r) => r.some((m) => m.who === who))));
    }
    const missing = {};
    const carriedBy = {};
    // An opportunity is done once the account holds the copies its characters need (`piecesNeeded`),
    // wherever they lie, because Inventory Search moves NO DROP pieces between characters. Only
    // pieces some group can hunt now, by its level, are searched for, which keeps the pass short.
    const groupLevels = tabs.map((t) => t.members.reduce((s, m) => s + (m.level ?? 0), 0) / Math.max(1, t.members.length));
    const reachable = (o) => !o.levels || groupLevels.some((l) => l >= o.levels[0] && l <= o.levels[1]);
    // Four searches at a time: one at a time made the pass take two minutes, and all at once timed out.
    const queue = opportunities.filter(reachable);
    await Promise.all(Array.from({ length: 4 }, async () => {
      for (let o; (o = queue.shift()); ) {
        const rows = (await search(o.item)).filter((m) => m.item === o.item);
        missing[o.id] = Math.max(0, piecesNeeded(o, { quests, holders, members }) - rows.reduce((a, m) => a + m.n, 0));
        carriedBy[o.id] = rows.map((m) => m.who);
      }
    }));
    // Spawn points from the content snapshot, read once per key and in one read for all new keys:
    // the opportunities' enemies, which a hunt camps, and each quest step's NPC, whose point the step
    // looks at, because a point that another NPC holds rolls again only when that NPC dies.
    this.points ??= new Map();
    const loadPoints = async (entries) => {
      const fresh = entries.filter((e) => !this.points.has(e.key));
      if (!fresh.length) return;
      const { spawnPoints } = await import("./lib/content.mjs");
      const found = await spawnPoints(fresh).catch(() => fresh.map(() => []));
      fresh.forEach((e, k) => this.points.set(e.key, found[k]));
    };
    await loadPoints(opportunities.filter((o) => o.camp !== false).map((o) => ({ key: o.id, zone: o.zone, pattern: o.keep })));
    for (const o of opportunities) if (o.camp === false) this.points.set(o.id, []);
    const steps = Object.values(quests).flatMap((q) => q.steps).filter((s) => s.npc);
    await loadPoints(steps.map((s) => ({ key: `${s.zone}:${s.npc}`, zone: s.zone, pattern: `^${s.npc}$` })));
    for (const s of steps) s.points = this.points.get(`${s.zone}:${s.npc}`);
    const state = metaGet(this.db, "coordinator") ?? { history: [] };
    // A finished hunt reports when its points respawn, which is when to come back. Every cycle
    // writes the outcomes (`recordOutcomes`), and this keeps the retry times current for the pass.
    settleHistory(state.history, tabs.map((t) => t.task));
    const held = await this.experimentPass(now, tabs, state);
    // Hours a level takes each character at its group's own XP per hour over the last two hours of
    // minute totals, minutes with a task left out (another member is active then, and a trip zone
    // pays its own rate): the pace at which gear pays (`copyValue` in tools/lib/acquire.mjs). A
    // character at 60 earns AA XP at the pace of level 59.
    const rates = await this.loadRates();
    const { estimate } = await import("./lib/rates.mjs");
    const { xpStart } = await import("./lib/xp.mjs");
    const hoursPerLevel = {};
    const sinceMinute = Math.floor((now - 2 * 3600000) / 60000);
    for (const t of tabs) {
      let xp = 0;
      let sec = 0;
      for (const m of this.db.query("SELECT sec, xp FROM minutes WHERE grp = ? AND minute >= ?").all(t.group, sinceMinute)) {
        const s = JSON.parse(m.sec);
        if (s.task > 0) continue;
        xp += m.xp;
        sec += Object.values(s).reduce((a, b) => a + b, 0);
      }
      const xph = sec >= 1800 ? (3600 * xp) / sec : 0;
      if (xph > 0) for (const m of t.members) hoursPerLevel[m.name] = (xpStart(Math.min(59, m.level ?? 0) + 1) - xpStart(Math.min(59, m.level ?? 0))) / xph;
    }
    // Each group's kills per hour from the last gear pass's report, which bound a common drop's hours per copy.
    this.killsPerHour ??= metaGet(this.db, "gear")?.killsPerHour ?? {};
    // The last gear pass's moves wait for a free tab until a gear task takes them or a newer pass
    // replaces them, because the pass runs hourly and a busy hour would otherwise lose them.
    this.pendingGear = (await this.gearPass(now, tabs, hoursPerLevel).catch((e) => (this.log(`gear pass failed: ${e.message}`), null))) ?? this.pendingGear ?? null;
    const gear = this.pendingGear;
    // The last gear pass's targets, kept in the db so a restart does not lose them for an hour.
    this.targetWants ??= metaGet(this.db, "gear")?.targets ?? [];
    // A camp clears its target's spawn points.
    await loadPoints(this.targetWants.map((x) => ({ key: targetId(x), zone: x.zone, pattern: `^${x.npc.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$` })));
    // The share of a tab's XP per hour a trip zone pays at its leader's level: the measured rates
    // where both zones have them, else the leveling model's prediction for both (tools/predict.mjs).
    const predicted = await this.predictedRates(new Set([...tabs.map((t) => t.zone), ...this.targetWants.map((x) => x.zone)].filter(Boolean)));
    const zoneShare = (t, zone) => {
      const level = t.members[0]?.level ?? 0;
      const there = estimate(rates, zone, level, now)?.xph;
      const here = estimate(rates, t.zone, level, now)?.xph;
      if (there > 0 && here > 0) return there / here;
      const a = predicted(zone, level);
      const b = predicted(t.zone, level);
      return a > 0 && b > 0 ? a / b : 0;
    };
    // What the hunts, errands and open quest chains are for is never sold, wherever it is looted.
    // Gear targets' items are kept by the gear plan's counts (`setGearKeepInPage`).
    const keepNames = [...new Set([...opportunities.map((o) => o.item), ...questKeepItems({ quests, holders, members })].filter(Boolean))].sort();
    for (const t of tabs) await this.relay.evaluate(t.targetId, call(applySettingsInPage, { s: { keepNames } }), { timeout: 10000 }).catch(() => {});
    // Gear targets skip zones any tab found crowded by other players in the last 45 minutes, after
    // group 1 idled a whole errand in a Temple of Solusek Ro it had just left as crowded.
    const { actions, targets: targetEval } = decide({ now, tabs, stock, opportunities: opportunities.map((o) => ({ ...o, points: this.points.get(o.id) })), missing, carriedBy, farms, quests, holders, started, have, gear, held, history: state.history, code: this.code, targets: this.targetWants, crowded: crowdedZones(tabs, now), points: Object.fromEntries(this.targetWants.map((x) => [targetId(x), this.points.get(targetId(x))])), hoursPerLevel, killsPerHour: this.killsPerHour, zoneShare });
    // Why each listed target is or is not hunted, for the dashboard's Most wanted list.
    metaSet(this.db, "targetStatus", { t: now, targets: targetEval });
    for (const a of actions) {
      const tab = tabs.find((t) => t.label === a.label);
      try {
        // An errand travels to its zone inside this call, after waiting for the fight at hand, which
        // takes up to about 30 s, so a shorter limit reported errands as not queued that had started.
        const r = await this.relay.evaluate(tab.targetId, call(queueInPage, { kind: a.kind, spec: a.spec }), { timeout: 40000 });
        state.history.push({ t: now, label: a.label, kind: a.kind, id: a.id ?? null, task: r?.id ?? null, code: this.code });
        if (a.kind === "gear") this.pendingGear = null;
        this.db.query("INSERT INTO interventions (t, session, actor, text) VALUES (?, ?, 'coordinator', ?)").run(now, a.label, `${a.kind}: ${a.why}`);
        this.log(`coordinator: ${a.label} ${a.kind}: ${a.why}`);
      } catch (e) {
        this.log(`coordinator: ${a.label} ${a.kind} not queued: ${e.message}`);
      }
    }
    // Zone rotations by measured XP per hour. A tab given a task this pass keeps its rotation.
    const rows = JSON.parse(await readFile(join(REPO, "data/band-rotations.json"), "utf8"));
    const tasked = new Set(actions.map((a) => a.label));
    const crowdFactor = await this.crowdFactors();
    for (const z of assignZones({ now, tabs: tabs.map((t) => (tasked.has(t.label) ? { ...t, task: { status: "running" } } : t)), rows, rates, crowdFactor })) {
      const tab = tabs.find((t) => t.label === z.label);
      const changed = await this.relay.evaluate(tab.targetId, call(applySettingsInPage, { s: { rotation: z.rotation } }), { timeout: 10000 }).catch(() => []);
      if (!changed?.length) continue;
      (this.zoneSetAt ??= new Map()).set(z.label, now);
      this.db.query("INSERT INTO interventions (t, session, actor, text) VALUES (?, ?, 'coordinator', ?)").run(now, z.label, `zone: ${z.rotation.join(", ")} for ${tab.group}, ${z.why}`);
      this.log(`coordinator: ${z.label} zone: ${z.rotation.join(", ")}, ${z.why}`);
    }
    metaSet(this.db, "rates", rates);
    // AA settings for each party, outside tasks, which may have another character active. The
    // window's state also names the active character's points, spent points and ranks, kept per
    // character in the meta key `aa` for the dashboard.
    const aa = metaGet(this.db, "aa") ?? {};
    const aaBefore = structuredClone(aa);
    for (const t of tabs.filter((x) => x.task?.status !== "running" && !tasked.has(x.label))) {
      const r = await this.relay.evaluate(t.targetId, call(aaInPage, AA_POLICY), { timeout: 20000 }).catch((e) => (this.log(`coordinator: ${t.label} AA settings: ${e.message}`), null));
      if (r?.state) aa[r.state.name] = { ...r.state, t: now };
      if (!r?.done?.length) continue;
      this.db.query("INSERT INTO interventions (t, session, actor, text) VALUES (?, ?, 'coordinator', ?)").run(now, t.label, `aa: ${r.done.join("; ")}`);
      this.log(`coordinator: ${t.label} aa: ${r.done.join("; ")}`);
    }
    metaSet(this.db, "aa", aa);
    const chains = chainSummary({ quests, holders, started, members });
    this.recordPassProgress(now, { quests, opportunities, missing, lacking, doneItems, progressItems, chainsBefore: state.last?.chains, chains, aaBefore, aa });
    state.history = state.history.filter((h) => now - h.t < 2 * 86400000);
    state.last = { t: now, stock, missing, chains, actions: actions.map((a) => ({ label: a.label, kind: a.kind, why: a.why })) };
    // How long the pass took, so a slow pass shows before it delays the groups.
    metaSet(this.db, "coordinator", { ...state, passMs: Date.now() - now });
  }

  /**
   * The progress one coordinator pass shows (tools/lib/progress.mjs): chains finished and started
   * against the last pass's summary, and AA ranks and points against the AA states before this
   * pass. It also keeps what the account still wants, for the loot lines (`itemFor`): a chain's
   * piece its needers lack copies of (`lacking`), and an opportunity's item with copies missing
   * (`missing`), without the items that mark a chain done or under way, which the chain summary
   * reports. A copy beyond those is surplus, not progress. The meta key `wanted` keeps them for
   * the loot that a restart exports before its first pass.
   */
  recordPassProgress(now, { quests, opportunities, missing, lacking, doneItems, progressItems, chainsBefore, chains, aaBefore, aa }) {
    recordProgress(this.db, [...chainChanges(chainsBefore, chains, now), ...aaChanges(aaBefore, aa, now)], this.groups());
    const label = (q) => `the ${q.class} chain for ${q.reward}`;
    const pieceFor = new Map();
    for (const q of Object.values(quests)) for (const n of q.needs ?? []) if (lacking[n] > 0 && !pieceFor.has(n)) pieceFor.set(n, label(q));
    for (const o of opportunities) if (missing[o.id] > 0 && !pieceFor.has(o.item)) pieceFor.set(o.item, quests[o.quest] ? label(quests[o.quest]) : null);
    for (const id of Object.keys(quests)) for (const item of [...doneItems(id, quests), ...progressItems(quests[id])]) pieceFor.delete(item);
    this.pieceFor = pieceFor;
    metaSet(this.db, "wanted", Object.fromEntries(pieceFor));
  }

  /**
   * The leveling model's XP per hour (tools/predict.mjs) for `zones`, as `(zone, level) => xph`,
   * loading each zone once and evaluating each level once.
   */
  async predictedRates(zones) {
    const predict = await import("./predict.mjs");
    this.modelZones ??= new Map();
    this.modelRates ??= new Map();
    const missing = [...zones].filter((z) => !this.modelZones.has(z));
    if (missing.length) {
      const loaded = await predict.loadZones(`^(${missing.join("|")})$`).catch(() => new Map());
      for (const z of missing) this.modelZones.set(z, loaded.get(z) ?? null);
    }
    return (zone, level) => {
      const k = `${zone}|${level}`;
      if (!this.modelRates.has(k)) {
        const z = this.modelZones.get(zone);
        this.modelRates.set(k, z ? (predict.evalZone(z, predict.cfgFromFlags(level)).xph ?? 0) : 0);
      }
      return this.modelRates.get(k);
    };
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
   * result. An experiment that leaves the file before its end returns its groups to `without` and
   * registers no job. A file that does not parse changes nothing. Returns the groups the
   * experiments hold.
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
    ex.running ??= {};
    const { settings, events, held } = experimentSettings({ now, experiments, started: ex.started, ended: ex.ended, running: ex.running });
    const note = (text) => {
      this.db.query("INSERT INTO interventions (t, session, actor, text) VALUES (?, ?, 'coordinator', ?)").run(now, null, text);
      this.log(`coordinator: ${text}`);
    };
    for (const e of events) {
      const x = experiments.find((y) => y.id === e.id);
      if (e.kind === "start") {
        ex.started[e.id] = e.start;
        ex.running[e.id] = { a: x.a, b: x.b, without: x.without };
        note(`experiment ${e.id} started: A ${x.a.join(",")}, B ${x.b.join(",")}, blocks of ${x.blockMin} min`);
      } else if (e.kind === "dropped") {
        ex.ended[e.id] = now;
        delete ex.running[e.id];
        note(`experiment ${e.id} left data/experiments.json before its end: its groups are back on its other setting, and no crossover job was registered`);
      } else {
        ex.ended[e.id] = now;
        delete ex.running[e.id];
        const cmd = `bun tools/crossover.mjs --start ${e.start} --block ${x.blockMin} --blocks ${x.blocks ?? 2} --a ${x.a.join(",")} --b ${x.b.join(",")}`;
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
   * the bridge), then the plan of tools/lib/gear-plan.mjs. A roster character whose party the pass
   * cannot read, because its tab is out of the world or a task plays another character, keeps the
   * worn items of the last survey. Taken for naked, it would get moves into slots it fills, its wear
   * stints would close and the progress feed would count its items as new at the next read. The
   * items the plan wants kept go to every bot, and the moves go to the coordinator's policy, which
   * queues them as one gear task. The survey is saved to runs/state/account-items.json for
   * tools/handdown.mjs and the next pass.
   */
  async gearPass(now, tabs, hoursPerLevel = {}) {
    // The last pass is kept in the database, so a restart of iqd does not survey again at once. The
    // report and targets of the last pass that finished stay until the next one finishes, and one
    // that fails comes again after GEAR_RETRY_MIN.
    const prev = metaGet(this.db, "gear") ?? {};
    if (now < (prev.next ?? (prev.t ?? 0) + GEAR_EVERY_MIN * 60000)) return null;
    metaSet(this.db, "gear", { ...prev, next: now + GEAR_RETRY_MIN * 60000 });
    const { buyBudget, damageShares, itemCard, planGear, recoveryShares, rosterPeople, mergeSurvey, surveyWords, walkShares } = await import("./lib/gear-plan.mjs");
    const party = [];
    for (const t of tabs) party.push(...((await this.relay.evaluate(t.targetId, call(inventoryInPage, {}), { timeout: 10000 }).catch(() => [])) ?? []));
    const read = new Set(party.map((r) => r.characterName));
    const groups = this.groups();
    const last = JSON.parse(await readFile(join(this.runs, "state/account-items.json"), "utf8").catch(() => "[]"));
    const kept = last.filter((r) => r.location === "Equipped" && groups.has(r.characterName) && !read.has(r.characterName));
    if (kept.length) this.log(`gear pass: kept the last worn items of ${new Set(kept.map((r) => r.characterName)).size} characters whose party was not readable`);
    const id = await this.relay.evaluate(tabs[0].targetId, call(startJobInPage, { name: "searchItems", args: [surveyWords([...party, ...kept].map((r) => r.itemName))] }), { timeout: 10000 });
    let job = null;
    for (let k = 0; k < 90 && !job?.done; k++) {
      await new Promise((r) => setTimeout(r, 2000));
      job = await this.relay.evaluate(tabs[0].targetId, call(jobInPage, { id }), { timeout: 10000 });
    }
    if (!job?.ok) throw new Error(`item search: ${job?.error ?? "did not finish"}`);
    const survey = mergeSurvey([...party, ...kept], job.result.rows);
    await writeFile(join(this.runs, "state/account-items.json"), JSON.stringify(survey)).catch(() => {});
    // Each slot's stints, for how long items stay worn (tools/lib/wear.mjs).
    recordWear(this.db, survey, now);
    const { attachEffects, merchantGoods, pickDrops, zoneDrops } = await import("./lib/gear-data.mjs");
    const { contentRoot, rows } = await import("./lib/content.mjs");
    // The merchant goods, the drops of the band rotations and of the gear picks (data/gear-picks.json,
    // sources outside the rotations), and their item rows, read once.
    if (!this.shop) {
      const goods = await merchantGoods(contentRoot());
      this.shop = goods.shop;
      this.items = goods.items;
      const dropped = await zoneDrops(contentRoot(), JSON.parse(await readFile(join(REPO, "data/band-rotations.json"), "utf8")));
      const picked = await pickDrops(contentRoot(), JSON.parse(await readFile(join(REPO, "data/gear-picks.json"), "utf8")));
      this.drops = [...dropped.drops, ...picked.drops];
      for (const [id, i] of [...dropped.items, ...picked.items]) this.items.set(id, i);
    }
    const missing = new Set(survey.map((r) => r.itemId).filter((i) => !this.items.has(i)));
    if (missing.size) for await (const i of rows("items", contentRoot())) if (missing.has(i.id)) this.items.set(i.id, i);
    // An item's proc, worn and focus effects count in its worth, so their spells come along, read again
    // only when an item new to the pass has one.
    const unread = (i) => (i.proceffect > 0 && !("procSpell" in i)) || (i.worneffect > 0 && i.worntype === 2 && !("wornEffects" in i)) || (i.focuseffect > 0 && i.focustype === 6 && !("focusEffects" in i));
    if ([...this.items.values()].some(unread)) await attachEffects(this.items, contentRoot());
    const raceOf = new Map(this.db.query("SELECT name, race FROM characters").all().map((r) => [r.name, r.race]));
    // Each character's last recorded maximum mana, which an item's mana is a share of.
    const poolOf = new Map(this.db.query("SELECT c.name, s.max_mana FROM char_snapshots s JOIN characters c ON c.id = s.char_id WHERE s.id IN (SELECT MAX(id) FROM char_snapshots WHERE max_mana > 0 GROUP BY char_id)").all().map((r) => [r.name, r.max_mana]));
    // Each character's part in its group's recovery over the last two hours, which mana regeneration
    // shortens (`recoveryShares`), each Bard's walk, which its percussion instrument speeds up
    // (`walkShares`), and each member's melee and spell share of its party's damage, by which its gear
    // counts (`damageShares`). A character the party never waited for gets a zero recovery share.
    const proc = Bun.spawn(["bun", join(REPO, "tools/groups.mjs"), "--last", "120", "--json"], { stdout: "pipe", stderr: "ignore" });
    const groupRows = await new Response(proc.stdout).json().catch(() => []);
    const recoveryOf = recoveryShares(groupRows);
    const runSongs = new Set(groupRows.map((r) => r.runSpeed?.bard?.spellId).filter(Boolean));
    this.spellRows ??= new Map();
    if ([...runSongs].some((id) => !this.spellRows.has(id))) for await (const s of rows("spells_new", contentRoot())) if (runSongs.has(s.id)) this.spellRows.set(s.id, s);
    const { spellEffects } = await import("./lib/spell-value.mjs");
    const seloAt = (id, level) => (this.spellRows.has(id) ? (spellEffects(this.spellRows.get(id), level).find((e) => e.spa === 3)?.value ?? 0) : 0);
    const walkOf = walkShares(groupRows, seloAt);
    const groupOfName = rosterGroups();
    const members = new Map();
    for (const [name, g] of groupOfName) members.set(g, [...(members.get(g) ?? []), name]);
    const shareOf = damageShares(groupRows, members);
    const people = rosterPeople(survey, groupOfName, raceOf).map((p) => ({ ...p, pool: poolOf.get(p.name), recovery: groupRows.length ? (recoveryOf.get(p.name) ?? { share: 0, regen: 0 }) : undefined, walk: walkOf.get(p.name), shares: shareOf.get(p.name) }));
    const { copyValue } = await import("./lib/acquire.mjs");
    // Each group's kills per hour over the report's two hours, and their median for the plan's hours per copy.
    this.killsPerHour = Object.fromEntries(groupRows.filter((r) => r.killsPerMin > 0).map((r) => [r.group, 60 * r.killsPerMin]));
    const kph = Object.values(this.killsPerHour).sort((a, b) => a - b);
    const { moves, keep, drops, targets, characters } = planGear({ survey, items: this.items, people, shop: this.shop, buyPp: buyBudget(groupRows, RAID_PP_PER_DAY), drops: this.drops, copyValue: (w) => copyValue(w, hoursPerLevel), killsPerHour: kph[Math.floor(kph.length / 2)] ?? 0 });
    // Every target the plan values goes to the coordinator, which weighs it against every group's
    // reach and rate, and the dashboard lists the best of them.
    this.targetWants = targets;
    // The per-character report for the dashboard: the scores in `gearPlan`, the slots in
    // `gearSheets`, and in the card store the card (name, icon, stats) of every item the dashboard
    // names: each slot's worn item, move and drop, every target's items and the items the upgrades
    // worn since the last pass replaced.
    const scores = (list) => Object.fromEntries((list ?? []).map((c) => [c.name, c.score]));
    const sheets = Object.fromEntries(characters.map((c) => [c.name, c.slots]));
    const before = { sheets: metaGet(this.db, "gearSheets")?.sheets, scores: scores(metaGet(this.db, "gearPlan")?.characters) };
    const changes = gearChanges({ before, after: { sheets, scores: scores(characters) }, t: now });
    recordProgress(this.db, changes, this.groups());
    const named = [
      ...characters.flatMap((c) => c.slots.flatMap((s) => [s.worn?.itemId, s.move?.itemId, s.drop?.itemId])),
      ...targets.flatMap((x) => x.items.map((w) => w.itemId)),
      ...changes.flatMap((e) => e.data.slots.flatMap((s) => [s.itemId, s.wasId])),
    ].filter((id) => id != null);
    putCards(this.db, Object.fromEntries(named.filter((id) => this.items.has(id)).map((id) => [id, itemCard(this.items.get(id))])));
    this.keepCards(named);
    metaSet(this.db, "gearPlan", { t: now, characters: characters.map(({ slots, ...c }) => c) });
    metaSet(this.db, "gearSheets", { t: now, sheets });
    for (const t of tabs) await this.relay.evaluate(t.targetId, call(setGearKeepInPage, keep), { timeout: 10000 }).catch(() => {});
    metaSet(this.db, "gear", { t: now, next: now + GEAR_EVERY_MIN * 60000, items: survey.length, moves: moves.length, kept: Object.keys(keep.counts).length, keptCopies: keep.instances.length, capped: job.result.capped, missed: job.result.missed ?? [], drops, targets: this.targetWants, killsPerHour: this.killsPerHour });
    this.log(`gear pass: ${survey.length} items, ${moves.length} moves, ${targets.length} targets, ${Object.keys(keep.counts).length} items short, ${keep.instances.length} copies held for moves${job.result.capped.length ? `, cut off: ${job.result.capped.join(", ")}` : ""}${job.result.missed?.length ? `, ${job.result.missed.length} words missed` : ""}`);
    return { moves };
  }

  /**
   * Write the outcome of each ended task into the coordinator's history every cycle, so a task that
   * a later one replaces between two passes still has its status and reason on record.
   */
  async recordOutcomes() {
    const state = metaGet(this.db, "coordinator");
    if (!state?.history?.length) return;
    const { settleHistory } = await import("./lib/coordinator.mjs");
    if (settleHistory(state.history, [...this.trackers.values()].map((t) => t.snap?.bot?.task))) metaSet(this.db, "coordinator", state);
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
    metaSet(this.db, "daemon", { pid: process.pid, intervalSec: this.intervalSec, last: Date.now(), relay: this.relay.connected, coordinate: this.coordinate, code: this.code });
    await this.recordOutcomes().catch((e) => this.log(`outcomes: ${e.message}`));
    await this.coordinatePass(Date.now()).catch((e) => this.log(`coordinator: ${e.message}`));
    await writeFile(join(this.runs, "status.md"), renderStatus(this.db, Date.now()) + "\n");
  }

  async poll(tr, now, triggers) {
    const present = this.relay.connected && this.relay.tabs().has(tr.targetId);
    let obs;
    if (!present) obs = { reachable: false, present: false, error: this.relay.connected ? null : "relay not connected" };
    else {
      try {
        // The page's screen comes with the snapshot, also for a page without the bridge.
        const snap = await this.relay.evaluate(tr.targetId, `({ ...${call(snapshotInPage, { session: tr.state.pageSession ?? null, after: tr.state.alertSeq ?? 0, sinceT: now - 900000 })}, screen: (${screenInPage})() })`, { timeout: 8000 });
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

    // The levels stored before this look, which the attention rules and the progress feed compare with.
    const levels = this.levels();
    const res = stepSession({ state: tr.state, obs, now, label: tr.label, levels, triggers });
    tr.state = res.state;

    if (usable) {
      // What this look shows of the goal's progress: level-ups and raid kills.
      recordProgress(this.db, snapshotProgress({ snap, levels, now, goal: this.raidGoal() }), this.groups());
      tr.state.pageSession = snap.pageSession;
      tr.snap = snap;
      if (snap.bot) tr.state.alertSeq = snap.bot.alertSeq;
      this.saveSession(tr, snap, now);
      this.recordCharacters(tr, snap, now);
    } else if (tr.rowId) {
      this.db.query("UPDATE sessions SET state = ? WHERE id = ?").run(JSON.stringify(tr.state), tr.rowId);
    }
    this.applyItems(tr, res, now, oldLabel);
    // Every recorded row goes to disk first, since a reload drops the page's buffers. Then the page
    // supervisor (tools/lib/page.mjs) says what the page needs to keep playing.
    const exported = usable && snap.leader && snap.rec ? await this.exportRows(tr, snap).catch((e) => void this.log(`export ${tr.label}: ${e.message}`)) : false;
    if (this.recover) {
      const step = pageStep({ obs, page: tr.page, fleet: this.fleet, now, code: this.code, exported: Boolean(exported) });
      tr.page = step.page;
      this.fleet = step.fleet;
      if (step.action) await this.pageAction(tr, step.action, now).catch((e) => this.log(`page ${tr.label}: ${e.message}`));
    }
  }

  /**
   * The zone choice's `crowdFactor(zone, level, n)`: the share of its rate alone a zone pays a group
   * at `level` while `n` other groups hunt there, as tools/predict.mjs models it (every kill empties
   * a point until its respawn, and the groups share the zone's spawn rate), docs/plans/zone-crowding.md.
   * The zones are read once and each factor is kept. A zone the model lacks counts as shared evenly.
   */
  async crowdFactors() {
    const predict = await import("./predict.mjs");
    this.zoneModels ??= await predict.loadZones();
    this.crowdCache ??= new Map();
    return (zone, level, n) => {
      if (!n) return 1;
      const key = `${zone}:${level}:${n}`;
      if (!this.crowdCache.has(key)) {
        const z = this.zoneModels.get(zone);
        const at = (crowd) => (z ? predict.evalZone(z, { ...predict.cfgFromFlags(level), crowd }).xph : undefined);
        const alone = at(0);
        this.crowdCache.set(key, alone > 0 ? at(n) / alone : 1 / (1 + n));
      }
      return this.crowdCache.get(key);
    };
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
    tr.leader = leader?.name ?? tr.leader;
    // A tab that vanished, as all of them do in a machine restart, is replaced by a new tab of the same
    // leader, so the old session ends here: it kept a second card for each group on the dashboard and
    // raised a gone item at every collector start.
    for (const [id, other] of this.trackers) {
      if (other === tr || other.leader !== tr.leader || !other.state.unreachableSince) continue;
      if (other.rowId) this.db.query("UPDATE sessions SET ended = ? WHERE id = ?").run(now, other.rowId);
      this.trackers.delete(id);
    }
  }

  /**
   * Carry out the page supervisor's `action` in the tab (`pageStep` in tools/lib/page.mjs): sign in
   * with the stored login, install the bridge and bot as the SDK does (src/install.mjs), or reload
   * the page. The bot keeps its settings in the tab's sessionStorage, so a reloaded tab knows its
   * leader, and a tab that lost them gets its group's leader and members from data/roster.json, by
   * the leader it showed before. The bot then enters the world as the leader and regroups by itself.
   */
  async pageAction(tr, action, now) {
    const { installExpressions, signInInPage, storedLogin } = await import("../src/install.mjs");
    const evaluate = (expression, timeout = 15000) => this.relay.evaluate(tr.targetId, expression, { timeout });
    const note = (text) => {
      this.db.query("INSERT INTO interventions (t, session, actor, text) VALUES (?, ?, 'iqd', ?)").run(now, tr.label, text);
      this.log(`page ${tr.label}: ${text}`);
    };
    if (action.kind === "signIn") {
      await evaluate(`(${signInInPage})(${JSON.stringify(await storedLogin())})`);
      return note(`signed in with the stored login (${action.why})`);
    }
    if (action.kind === "reload") {
      note(`reloaded the page: ${action.why}`);
      return evaluate("setTimeout(() => location.reload(), 200), true", 5000);
    }
    for (const e of await installExpressions()) await evaluate(e, 30000);
    const g = JSON.parse(readFileSync(join(REPO, "data/roster.json"), "utf8")).groups.find((x) => x.members?.[0] === tr.leader);
    const set = g ? await evaluate(`(${setGroupInPage})(${JSON.stringify({ leader: g.members[0], members: g.members.slice(1) })})`) : false;
    if (action.update) return this.log(`deploy ${tr.label}: code ${this.code}`);
    note(`installed the bridge and bot: ${action.why}${set ? `, and set ${g.members[0]} as leader of ${g.id}` : ""}`);
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

  /**
   * Append a tab's new recorder rows to its group leader's logs, `runs/live/<leader>/`, also while a
   * task plays a member, so each tab's rows stay in one place. The cursor belongs to the page
   * (`tr.state.cursor`, saved with the session), so every row is written once: cursors per log
   * directory had written a page's whole buffer again into a member's logs. A new page starts at
   * its first row. Resolves true once every row is on disk.
   */
  async exportRows(tr, snap) {
    const dir = join(this.runs, "live", safeName(this.leaderOf(snap.leader.name)));
    await mkdir(dir, { recursive: true });
    // A page iqd has not exported in this run resumes after its rows already in the logs.
    const resume = (file) => {
      const c = tailCursor(join(dir, file));
      return c.ses === snap.rec.ses ? c : { ses: snap.rec.ses, seq: 0 };
    };
    const cur = (tr.state.cursor ??= { s: resume("samples.jsonl"), e: resume("events.jsonl") });
    try {
      for (let i = 0; i < 12; i++) {
        const got = await this.relay.evaluate(tr.targetId, call(drainInPage, { s: cur.s, e: cur.e, maxS: 2000, maxE: 4000 }), { timeout: 10000 });
        if (!got) return false;
        if (got.samples.length) {
          await appendFile(join(dir, "samples.jsonl"), got.samples.map((r) => JSON.stringify(r)).join("\n") + "\n");
          cur.s = { ses: got.samples.at(-1).ses ?? 0, seq: got.samples.at(-1).seq };
          this.addRates(tr, got.samples);
          this.addMinutes(snap.leader.name, got.samples);
        }
        if (got.events.length) {
          await appendFile(join(dir, "events.jsonl"), got.events.map((r) => JSON.stringify(r)).join("\n") + "\n");
          cur.e = { ses: got.events.at(-1).ses ?? 0, seq: got.events.at(-1).seq };
          const looted = lootProgress({ events: got.events, name: snap.leader.name, itemFor: (item) => this.itemFor(item) });
          recordProgress(this.db, looted, this.groups());
          this.keepCards(looted.map((r) => r.data.itemId));
        }
        if (!got.more) return true;
      }
      return false;
    } finally {
      // The cursor is saved at once, so a restart of iqd resumes after the last row on disk.
      if (tr.rowId) this.db.query("UPDATE sessions SET state = ? WHERE id = ?").run(JSON.stringify(tr.state), tr.rowId);
    }
  }

  /**
   * Fold a tab's new samples into the minute totals (tools/lib/minutes.mjs) of the leader's roster
   * group, and drop totals past their retention once an hour. A leader outside the roster counts
   * under its own name.
   */
  addMinutes(leader, samples) {
    const now = Date.now();
    (this.minutes ??= new MinuteFolder(this.db)).add(this.groups().get(leader) ?? leader, samples);
    if (!this.prunedAt || now - this.prunedAt > 3600000) {
      this.prunedAt = now;
      pruneMinutes(this.db, now);
    }
  }

  /** The roster group of each character name (data/roster.json), read again at most every ten minutes. */
  groups() {
    const now = Date.now();
    if (!this.groupOf || now - this.groupOfAt > 600000) {
      this.groupOf = rosterGroups();
      this.leaderOfName = rosterLeaders();
      this.groupOfAt = now;
    }
    return this.groupOf;
  }

  /** The roster leader of `name`'s group, or `name` itself outside the roster. */
  leaderOf(name) {
    this.groups();
    return this.leaderOfName.get(name) ?? name;
  }

  /** The bosses of the raid goal (data/raid-goal.json), read once. */
  raidGoal() {
    if (!this.raidBosses) {
      try {
        this.raidBosses = JSON.parse(readFileSync(join(REPO, "data/raid-goal.json"), "utf8")).bosses ?? [];
      } catch {
        this.raidBosses = [];
      }
    }
    return this.raidBosses;
  }

  /**
   * What a looted item is for, for the progress feed: a chain piece (`pieceFor` of the last
   * coordinator pass, or the meta key `wanted` before the first), or a gear target's taker. Null
   * for an item nobody wants.
   */
  itemFor(item) {
    this.pieceFor ??= new Map(Object.entries(metaGet(this.db, "wanted") ?? {}));
    if (this.pieceFor.has(item)) return { for: this.pieceFor.get(item), piece: true };
    this.targetWants ??= metaGet(this.db, "gear")?.targets ?? [];
    const to = this.targetWants.flatMap((x) => x.items ?? []).find((w) => w.item === item)?.to;
    return to ? { for: to, piece: false } : null;
  }

  /**
   * Store the cards of the items `ids` names that have none yet, from the gear pass's item rows or,
   * for an item it never read, from the content's, in one read for all of them. Calls run one after
   * another, because that read takes seconds, and the caller does not wait for them.
   */
  keepCards(ids) {
    this.cardQueue = (this.cardQueue ?? Promise.resolve())
      .then(async () => {
        const want = missingCards(this.db, ids);
        if (!want.length) return;
        const { itemCard } = await import("./lib/gear-plan.mjs");
        const found = new Map(want.filter((id) => this.items?.has(id)).map((id) => [id, this.items.get(id)]));
        const unread = new Set(want.filter((id) => !found.has(id)));
        if (unread.size) {
          const { contentRoot, rows } = await import("./lib/content.mjs");
          for await (const i of rows("items", contentRoot())) {
            if (unread.delete(i.id)) found.set(i.id, i);
            if (!unread.size) break;
          }
        }
        putCards(this.db, Object.fromEntries([...found].map(([id, i]) => [id, itemCard(i)])));
      })
      .catch((e) => this.log(`item cards: ${e.message}`));
    return this.cardQueue;
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

/** The leader, its first member, of each character's group from data/roster.json, or an empty map without the file. */
export function rosterLeaders() {
  try {
    const r = JSON.parse(readFileSync(join(REPO, "data/roster.json"), "utf8"));
    return new Map(r.groups.flatMap((g) => (g.members ?? []).map((n) => [n, g.members[0]])));
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

  const c = progressCounts(db, now - 86400000);
  const ms = db.query("SELECT t, grp, text FROM progress WHERE sig >= 2 ORDER BY t DESC LIMIT 1").get();
  out.push(cut(`Progress (24 h): ${c.level} levels, ${c.gear} gear slots, ${c.item} items, ${c.chain} chains, ${c.aa} AA ranks, ${c.raid} raid kills${ms ? ` | latest milestone ${dur(now - ms.t)} ago: ${ms.grp ? `${ms.grp} ` : ""}${ms.text}` : ""}`, 150));

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
  minutes [--hours 336]          rebuild the minute totals of the last hours from the recorded samples, for the
                                 time before the collector wrote them (run it while the collector is stopped)
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
    options: { interval: { type: "string" }, port: { type: "string" }, coordinate: { type: "boolean" }, recover: { type: "boolean" }, severity: { type: "string" }, "max-minutes": { type: "string" }, session: { type: "string" }, actor: { type: "string" }, purpose: { type: "string" }, cmd: { type: "string" }, out: { type: "string" }, runs: { type: "string" }, hours: { type: "string" } },
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

async function cmdMinutes({ values, runs }) {
  const hours = Number(values.hours ?? 336);
  if (!(hours > 0)) throw new Error("--hours must be a positive number");
  const db = openDb(join(runs, "iq.db"));
  const n = await backfillMinutes(db, runs, rosterGroups(), Date.now() - hours * 3600000);
  console.log(`minutes: ${n} group-minutes written for the last ${hours} hours`);
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
  const table = { run: cmdRun, serve: cmdServe, minutes: cmdMinutes, status: cmdStatus, wait: cmdWait, ack: cmdAck, note: cmdNote, job: cmdJob };
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
