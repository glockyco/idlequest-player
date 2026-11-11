// The page supervisor (docs/plans/fault-handling.md): what each game tab's page needs next to keep
// playing, from one look at it. Pure, so tests replay recorded situations, and iqd only carries out
// the action it returns (`pageAction` in tools/iqd.mjs).
//
// A page should be loaded, signed in, in the world, running the current bridge and bot, within its
// memory and free of a client fault the bridge names. Each look gives at most one action:
//   signIn   the login form shows on a fresh page, or `offlineSec` after the page left the game,
//            at most every `signInEveryMin` per tab and `signInBurst` times in the fleet per
//            `signInWindowSec`, because the server refuses a burst ("Too many login attempts"). A
//            page that shows that refusal holds every sign-in of the fleet for `refusedHoldSec`,
//            the minute the server asks for
//   install  the bridge or the bot is missing, or runs older code outside a raid and outside a task
//            younger than `taskWaitMin`, which a reinstall stops, at most every `installEveryMin`
//            per tab, and at once after the tab's sign-in
//   reload   the heap's floor over `heapWindowMin` stays at `heapShare` of its limit, because the
//            client keeps memory it no longer needs, the last `lootlessKills` kills brought no
//            loot line, which a failed zone load can leave behind, or the client refused travel
//            for want of its zone's state, which only a reconnect restores, once every row is on disk, at a
//            quiet moment, and one page of the fleet per `reloadGapMin`. A character select whose
//            connection stayed down for `offlineSec` is a session the server ended without the login
//            form ("Log in before entering the world."), so its reload counts as a sign-in

export const PAGE = {
  offlineSec: 60, // the client tries to resume a session by itself first
  signInEveryMin: 2, // a sign-in takes the page through loading to the character select, which outlasts a cycle
  signInBurst: 6, // twelve sign-ins at once saw two or three refused, and nine at once none
  signInWindowSec: 30,
  refusedHoldSec: 70, // "Please wait a minute before trying again."
  installEveryMin: 2,
  taskWaitMin: 30, // a reinstall stopped a raid's loot step with half the corpse taken, and tasks mostly end within minutes
  heapShare: 0.5,
  heapWindowMin: 10, // longer than V8's collection sawtooth of a few minutes
  lootlessKills: 25, // healthy play reaches about ten
  reloadGapMin: 10, // so one group at a time is down
};

/** A moment a reload loses little at: no running task, raid, fight or zone load, and the page in the world. */
const quiet = (snap) => snap.bot?.task?.status !== "running" && !snap.raid && !snap.conn?.inCombat && !snap.conn?.zoneLoading && Boolean(snap.conn?.worldReady);

/**
 * Why the page should reload, or null: the floor of its heap readings (`heap`, `{ t, used }` since it
 * loaded) over the last `heapWindowMin`, which counts because the heap saws up and down by hundreds
 * of MB between collections, the bridge's count of kills in a row without a loot line, or a travel
 * the client refused for want of its zone's state.
 */
function reloadReason(heap, snap, now, cfg) {
  if (snap.faults?.desync) return "the client refused travel for want of its zone's state (\"Your zone is not synchronized. Reconnect before travelling.\")";
  const lootless = snap.faults?.lootless ?? 0;
  if (lootless >= cfg.lootlessKills) return `the last ${lootless} kills brought no loot line, which the client loses in a failed zone load`;
  const limit = snap.heap?.limit;
  const since = now - cfg.heapWindowMin * 60000;
  if (!limit || !heap.length || heap[0].t > since) return null;
  const floor = Math.min(...heap.filter((r) => r.t >= since).map((r) => r.used));
  return floor >= cfg.heapShare * limit ? `the page heap stayed above ${floor} of ${limit} MB for ${cfg.heapWindowMin} min` : null;
}

/**
 * The next step for one tab. `obs` is the look, `{ reachable, snap }`, where `snap` is the page
 * snapshot with the page's `screen` (loading, login, select or game). `page` is this tab's state and
 * `fleet` the fleet's, both as the last step returned them. `exported` says whether every row the
 * page recorded is on disk, which a reload needs, and `code` names the code the tabs should run.
 * Returns `{ action, page, fleet }`, with `action` null or `{ kind, why, update }`.
 */
export function pageStep({ obs, page = {}, fleet = {}, now, code = null, exported = false, cfg = PAGE }) {
  const out = { ...page };
  const next = { ...fleet, signIns: (fleet.signIns ?? []).filter((t) => now - t < cfg.signInWindowSec * 1000) };
  const result = (action = null) => ({ action, page: out, fleet: next });
  const snap = obs?.reachable ? obs.snap : null;
  if (!snap || snap.error) return result();
  if (out.heapSession !== snap.pageSession) Object.assign(out, { heapSession: snap.pageSession, heap: [] });
  if (snap.heap) out.heap = [...(out.heap ?? []).filter((r) => now - r.t <= 2 * cfg.heapWindowMin * 60000), { t: now, used: snap.heap.used }];
  const fresh = !snap.hasBridge || !snap.hasBot;
  out.offlineSince = snap.screen === "login" || snap.conn?.connected === false ? (out.offlineSince ?? now) : null;
  // The refusal stays on the form until the next attempt, so it holds the fleet once for each
  // sign-in it answers, not at every look.
  if (snap.signInRefused && out.refusedFor !== (out.signInAt ?? 0)) {
    next.signInHoldUntil = Math.max(next.signInHoldUntil ?? 0, now + cfg.refusedHoldSec * 1000);
    out.refusedFor = out.signInAt ?? 0;
  }
  // A sign-in or a reload that leads to one waits for the server's minute and the fleet's budget.
  const signInHeld = now < (next.signInHoldUntil ?? 0) || next.signIns.length >= cfg.signInBurst;
  if (snap.screen === "loading") return result();
  if (snap.screen === "select" && snap.conn?.connected === false && now - out.offlineSince >= cfg.offlineSec * 1000) {
    if (now - (out.signInAt ?? 0) < cfg.signInEveryMin * 60000 || signInHeld) return result();
    out.signInAt = now;
    next.signIns = [...next.signIns, now];
    return result({ kind: "reload", why: `the character select had no connection for ${Math.round((now - out.offlineSince) / 1000)} s` });
  }
  if (snap.screen === "login") {
    // A fresh page signs in at once, and one that left the game gives the client its minute.
    const offlineMs = now - out.offlineSince;
    if (!(fresh || offlineMs >= cfg.offlineSec * 1000) || now - (out.signInAt ?? 0) < cfg.signInEveryMin * 60000 || signInHeld) return result();
    out.signInAt = now;
    next.signIns = [...next.signIns, now];
    return result({ kind: "signIn", why: fresh ? "a fresh page" : `the login form for ${Math.round(offlineMs / 1000)} s` });
  }
  const tasked = snap.bot?.task?.status === "running" && now - (snap.bot.task.startedAt ?? 0) < cfg.taskWaitMin * 60000;
  const stale = !fresh && code != null && snap.code !== code && !snap.raid && !tasked;
  if (fresh || stale) {
    if (now - (out.installAt ?? 0) < cfg.installEveryMin * 60000 && !((out.signInAt ?? 0) > (out.installAt ?? 0))) return result();
    out.installAt = now;
    return result({ kind: "install", update: stale, why: stale ? `the page runs code ${snap.code}` : `${snap.hasBridge ? "the bot" : "the bridge"} is missing at ${snap.screen}` });
  }
  const why = reloadReason(out.heap ?? [], snap, now, cfg);
  if (!why || !exported || !quiet(snap) || now - (next.reloadAt ?? 0) < cfg.reloadGapMin * 60000) return result();
  next.reloadAt = now;
  return result({ kind: "reload", why });
}
