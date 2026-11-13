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
//            younger than `taskWaitMin` that plays in the world, which a reinstall stops, at most
//            every `installEveryMin` per tab, and at once after the tab's sign-in
//   renew    the heap's floor over `heapWindowMin` stays at `heapShare` of its limit. The client
//            keeps memory it no longer needs, and the tab's process keeps what a reload frees, so
//            the tab gets a new process (`Relay.renew` in src/cdp.mjs), which comes back at the
//            login form like a reload
//   reload   the last `lootlessKills` kills brought no loot line, which a failed zone load can
//            leave behind, or the client refused travel for want of its zone's state, which only
//            a reconnect restores. Both, like a renewal, wait until every row is on disk, for a
//            quiet moment, and for one page of the fleet per `reloadGapMin`. A character select whose
//            connection stayed down for `offlineSec` is a session the server ended without the login
//            form ("Log in before entering the world."), so its reload counts as a sign-in

export const PAGE = {
  offlineSec: 60, // the client tries to resume a session by itself first
  loadingMin: 3, // a reload can outlast a cycle, but should not leave a blank page indefinitely
  signInEveryMin: 2, // a sign-in takes the page through loading to the character select, which outlasts a cycle
  signInBurst: 6, // twelve sign-ins at once saw two or three refused, and nine at once none
  signInWindowSec: 30,
  refusedHoldSec: 70, // "Please wait a minute before trying again."
  installEveryMin: 2,
  taskWaitMin: 30, // a reinstall stopped a raid's loot step with half the corpse taken, and tasks mostly end within minutes
  // A process that played for hours held 2.2 to 4.5 GB with a heap of 0.6 to 2.1 GB, and twelve of
  // them took the machine into swap, while a new one held 0.8 GB at a heap of 0.4 GB. A page's
  // heap passes this share of its 4 GB limit after some four to eight hours.
  heapShare: 0.3,
  heapWindowMin: 10, // longer than V8's collection sawtooth of a few minutes
  lootlessKills: 25, // healthy play reaches about ten
  reloadGapMin: 10, // so one group at a time is down
};

/**
 * A moment a reload loses little at: no running task, raid, fight or zone load, the page in the
 * world, and no raid ended in the last quarter hour, since the next raid of a paid hour may follow:
 * group 1's tab got a new process a minute after a raid on 2026-11-12 and lost the next raid's order.
 */
const quiet = (snap) => snap.bot?.task?.status !== "running" && !(snap.bot?.task?.kind === "raid" && (snap.t ?? Date.now()) - (snap.bot.task.endedAt ?? 0) < 15 * 60000) && !snap.raid && !snap.conn?.inCombat && !snap.conn?.zoneLoading && Boolean(snap.conn?.worldReady);

/**
 * Why the page should start again, or null, as `{ kind, why }`: a reload for the bridge's count of
 * kills in a row without a loot line or a travel the client refused for want of its zone's state,
 * and a new process for the floor of its heap readings (`heap`, `{ t, used }` since it loaded)
 * over the last `heapWindowMin`, which counts because the heap saws up and down by hundreds of MB
 * between collections.
 */
function restartReason(heap, snap, now, cfg) {
  if (snap.faults?.desync) return { kind: "reload", why: "the client refused travel for want of its zone's state (\"Your zone is not synchronized. Reconnect before travelling.\")" };
  const lootless = snap.faults?.lootless ?? 0;
  if (lootless >= cfg.lootlessKills) return { kind: "reload", why: `the last ${lootless} kills brought no loot line, which the client loses in a failed zone load` };
  const limit = snap.heap?.limit;
  const since = now - cfg.heapWindowMin * 60000;
  if (!limit || !heap.length || heap[0].t > since) return null;
  const readings = heap.filter((r) => r.t >= since);
  const halfWindow = cfg.heapWindowMin * 30000;
  if (readings.length < 3 || readings[0].t - since > halfWindow || heap.some((r, k) => k > 0 && r.t > since && r.t - heap[k - 1].t > halfWindow)) return null;
  const floor = Math.min(...readings.map((r) => r.used));
  return floor >= cfg.heapShare * limit ? { kind: "renew", why: `the page heap stayed above ${floor} of ${limit} MB for ${cfg.heapWindowMin} min` } : null;
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
  out.loadingSince = snap.screen === "loading" ? (out.loadingSince ?? now) : null;
  // The refusal stays on the form until the next attempt, so it holds the fleet once for each
  // sign-in it answers, not at every look.
  if (snap.signInRefused && out.refusedFor !== (out.signInAt ?? 0)) {
    next.signInHoldUntil = Math.max(next.signInHoldUntil ?? 0, now + cfg.refusedHoldSec * 1000);
    out.refusedFor = out.signInAt ?? 0;
  }
  // A sign-in or a reload that leads to one waits for the server's minute and the fleet's budget.
  const signInHeld = now < (next.signInHoldUntil ?? 0) || next.signIns.length >= cfg.signInBurst;
  const stuckLoading = snap.screen === "loading" && now - out.loadingSince >= cfg.loadingMin * 60000;
  if (snap.screen === "loading" && !stuckLoading) return result();
  if (stuckLoading || (snap.screen === "select" && snap.conn?.connected === false && now - out.offlineSince >= cfg.offlineSec * 1000)) {
    if (now - (out.signInAt ?? 0) < cfg.signInEveryMin * 60000 || signInHeld) return result();
    out.signInAt = now;
    out.reloadSignIn = true;
    next.signIns = [...next.signIns, now];
    return result({ kind: "reload", why: stuckLoading ? `the page stayed loading for ${cfg.loadingMin} min` : `the character select had no connection for ${Math.round((now - out.offlineSince) / 1000)} s` });
  }
  if (snap.screen === "login") {
    // A fresh page signs in at once, and one that left the game gives the client its minute.
    const offlineMs = now - out.offlineSince;
    if (!(fresh || offlineMs >= cfg.offlineSec * 1000) || (!out.reloadSignIn && now - (out.signInAt ?? 0) < cfg.signInEveryMin * 60000) || signInHeld) return result();
    out.signInAt = now;
    out.reloadSignIn = false;
    next.signIns = [...next.signIns, now];
    return result({ kind: "signIn", why: fresh ? "a fresh page" : `the login form for ${Math.round(offlineMs / 1000)} s` });
  }
  // A task plays in the world only, so one whose page stands elsewhere holds nothing.
  const tasked = snap.screen === "game" && snap.bot?.task?.status === "running" && now - (snap.bot.task.startedAt ?? 0) < cfg.taskWaitMin * 60000;
  const stale = !fresh && code != null && snap.code !== code && !snap.raid && !tasked;
  if (fresh || stale) {
    if (now - (out.installAt ?? 0) < cfg.installEveryMin * 60000 && !((out.signInAt ?? 0) > (out.installAt ?? 0))) return result();
    out.installAt = now;
    return result({ kind: "install", update: stale, why: stale ? `the page runs code ${snap.code}` : `${snap.hasBridge ? "the bot" : "the bridge"} is missing at ${snap.screen}` });
  }
  const restart = restartReason(out.heap ?? [], snap, now, cfg);
  if (!restart || !exported || !quiet(snap) || now - (next.reloadAt ?? 0) < cfg.reloadGapMin * 60000) return result();
  next.reloadAt = now;
  return result(restart);
}
