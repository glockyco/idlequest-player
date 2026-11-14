// The page supervisor (tools/lib/page.mjs) on the situations of 2026-11-10.
import { expect, test } from "bun:test";
import { pageStep } from "../tools/lib/page.mjs";

const T0 = 1_800_000_000_000;
const SEC = 1000;
const MIN = 60 * SEC;
// A page playing in the world with the current code, the bridge and the bot.
const game = (over: Record<string, unknown> = {}) => ({ pageSession: 1, hasBridge: true, hasBot: true, code: "c1", screen: "game", raid: false, conn: { connected: true, worldReady: true, inCombat: false, zoneLoading: false }, heap: { used: 900, limit: 4000 }, bot: { task: null }, faults: { lootless: 0 }, ...over });
const login = (over: Record<string, unknown> = {}) => game({ screen: "login", conn: { connected: false }, ...over });

/** A fleet of tabs that the steps share, as iqd's poll runs them. */
function fleetOf(n: number) {
  const pages: Record<string, unknown>[] = Array.from({ length: n }, () => ({}));
  let fleet = {};
  return (k: number, snap: object, now: number, extra = {}) => {
    const r = pageStep({ obs: { reachable: true, snap }, page: pages[k], fleet, now, code: "c1", ...extra });
    pages[k] = r.page;
    fleet = r.fleet;
    return r.action?.kind ?? null;
  };
}

test("twelve pages a server restart signed out sign in after the client's minute, six in each half minute", () => {
  const step = fleetOf(12);
  const all = (now: number) => Array.from({ length: 12 }, (_, k) => step(k, login(), now));
  expect(all(T0).filter(Boolean)).toEqual([]);
  expect(all(T0 + 59 * SEC).filter(Boolean)).toEqual([]);
  expect(all(T0 + 60 * SEC).filter(Boolean).length).toBe(6);
  expect(all(T0 + 90 * SEC).filter(Boolean).length).toBe(6);
  // Each tab waits two minutes before its next try.
  expect(all(T0 + 120 * SEC).filter(Boolean)).toEqual([]);
  expect(all(T0 + 180 * SEC).filter(Boolean).length).toBe(6);
});

test("a reloaded page signs in at once and installs as soon as its sign-in left the login form", () => {
  const step = fleetOf(1);
  const fresh = { hasBridge: false, hasBot: false, pageSession: 2 };
  expect(step(0, game({ code: "old" }), T0)).toBe("install");
  expect(step(0, login(fresh), T0 + 30 * SEC)).toBe("signIn");
  expect(step(0, game({ ...fresh, screen: "loading" }), T0 + 40 * SEC)).toBeNull();
  expect(step(0, game({ ...fresh, screen: "select" }), T0 + 60 * SEC)).toBe("install");
  // An install that did not take waits two minutes, and the bot's own Try Again answers a failed zone load.
  expect(step(0, game({ ...fresh, screen: "select" }), T0 + 100 * SEC)).toBeNull();
  expect(step(0, game({ ...fresh, screen: "select" }), T0 + 180 * SEC)).toBe("install");
  expect(step(0, game({ pageSession: 2 }), T0 + 220 * SEC)).toBeNull();
});

test("a full page gets a new process at a quiet moment with its rows on disk, one page of the fleet per ten minutes, and a sign-in elsewhere goes on", () => {
  const step = fleetOf(3);
  // Readings every 30 s for 12 minutes that never fell below three tenths of the heap limit.
  const full = game({ heap: { used: 1500, limit: 4000 } });
  for (let k = 0; k <= 24; k++) for (const tab of [0, 1]) step(tab, full, T0 + k * 30 * SEC);
  const now = T0 + 12 * MIN + 30 * SEC;
  expect(step(0, game({ ...full, conn: { connected: true, worldReady: true, inCombat: true, zoneLoading: false } }), now, { exported: true })).toBeNull();
  expect(step(0, full, now, { exported: false })).toBeNull();
  // A raid that ended four minutes ago may have a next one in its paid hour.
  const raided = { ...full, t: now, bot: { ...full.bot, task: { kind: "raid", status: "done", endedAt: now - 4 * MIN } } };
  expect(step(0, game(raided), now, { exported: true })).toBeNull();
  expect(step(0, full, now, { exported: true })).toBe("renew");
  expect(step(1, full, now + 30 * SEC, { exported: true })).toBeNull();
  expect(step(2, login({ hasBridge: false }), now + 30 * SEC)).toBe("signIn");
  for (let k = 1; k < 20; k++) step(1, full, now + k * 30 * SEC);
  expect(step(1, full, now + 10 * MIN, { exported: true })).toBe("renew");
});

test("a page reloads once 25 kills in a row brought no loot line, and one dip of the heap keeps its process", () => {
  const step = fleetOf(2);
  expect(step(0, game({ faults: { lootless: 24 } }), T0, { exported: true })).toBeNull();
  expect(step(0, game({ faults: { lootless: 25 } }), T0 + 30 * SEC, { exported: true })).toBe("reload");
  // One collection down to 1100 MB within the window: the floor is below three tenths of the limit.
  for (let k = 0; k <= 24; k++) expect(step(1, game({ heap: { used: k === 8 ? 1100 : 2600, limit: 4000 } }), T0 + k * 30 * SEC, { exported: true })).toBeNull();
  expect(step(1, game({ heap: { used: 2600, limit: 4000 } }), T0 + 12 * MIN + 30 * SEC, { exported: true })).toBeNull();
});

test("a page whose client refused travel for want of its zone's state reloads, which reconnects it", () => {
  const step = fleetOf(1);
  expect(step(0, game({ faults: { lootless: 0, desync: 0 } }), T0, { exported: true })).toBeNull();
  expect(step(0, game({ faults: { lootless: 0, desync: T0 } }), T0 + 30 * SEC, { exported: true })).toBe("reload");
});

test("older code installs outside a raid and a young task, at most every two minutes", () => {
  const step = fleetOf(1);
  expect(step(0, game({ code: "c0", raid: true }), T0)).toBeNull();
  // A reinstall stops the task, so it waits for the task, but not for one that hangs.
  expect(step(0, game({ code: "c0", bot: { task: { status: "running", startedAt: T0 } } }), T0 + 10 * SEC)).toBeNull();
  expect(step(0, game({ code: "c0", bot: { task: { status: "running", startedAt: T0 - 31 * MIN } } }), T0 + 20 * SEC)).toBe("install");
  expect(step(0, game({ code: "c0", bot: { task: { status: "done", startedAt: T0 } } }), T0 + 150 * SEC)).toBe("install");
  expect(step(0, game({ code: "c0" }), T0 + 180 * SEC)).toBeNull();
  expect(step(0, game({ code: "c0" }), T0 + 270 * SEC)).toBe("install");
});

test("a task holds an install only while its page is in the world", () => {
  // Groups 6 and 9 on 2026-11-11: the server signed every tab out at 22:38, the sign-in left these
  // two at the character select under their camp tasks, and their pages ran code from before the
  // bot failed such a task, which waited for the tasks.
  const step = fleetOf(1);
  const camp = { code: "c0", bot: { task: { status: "running", startedAt: T0 } } };
  expect(step(0, game(camp), T0 + 10 * SEC)).toBeNull();
  expect(step(0, game({ ...camp, screen: "select" }), T0 + 20 * SEC)).toBe("install");
});

test("a character select without a connection for a minute reloads, so the login form shows", () => {
  const step = fleetOf(1);
  const select = game({ screen: "select", conn: { connected: false } });
  expect(step(0, select, T0)).toBeNull();
  expect(step(0, select, T0 + 30 * SEC)).toBeNull();
  expect(step(0, select, T0 + 60 * SEC)).toBe("reload");
  // Its sign-in limit holds the next reload, and a connected select needs nothing.
  expect(step(0, select, T0 + 90 * SEC)).toBeNull();
  expect(step(0, game({ screen: "select" }), T0 + 300 * SEC)).toBeNull();
});

test("a page that shows the game without a connection for five minutes reloads", () => {
  const step = fleetOf(1);
  const down = game({ conn: { connected: false } });
  expect(step(0, down, T0)).toBeNull();
  // The client mostly reaches the login form by itself within three minutes.
  expect(step(0, down, T0 + 4 * MIN)).toBeNull();
  expect(step(0, down, T0 + 5 * MIN)).toBe("reload");
  // A connection that came back in between starts the count again.
  const other = fleetOf(1);
  expect(other(0, down, T0)).toBeNull();
  expect(other(0, game(), T0 + 3 * MIN)).toBeNull();
  expect(other(0, down, T0 + 5 * MIN)).toBeNull();
});

test("a page that shows the server's refusal holds every sign-in of the fleet for its minute", () => {
  const step = fleetOf(3);
  const fresh = { hasBridge: false, hasBot: false };
  expect(step(0, login({ ...fresh, signInRefused: true }), T0)).toBeNull();
  expect(step(1, login(fresh), T0 + 30 * SEC)).toBeNull();
  expect(step(2, login(fresh), T0 + 69 * SEC)).toBeNull();
  expect(step(1, login(fresh), T0 + 71 * SEC)).toBe("signIn");
});

test("a refusal left on the form holds the fleet once, so the page signs in again after the minute", () => {
  const step = fleetOf(1);
  const refused = login({ signInRefused: true });
  expect(step(0, refused, T0)).toBeNull();
  // The text still shows at every look, and the page signs in once the hold and its minute pass.
  expect(step(0, refused, T0 + 60 * SEC)).toBeNull();
  expect(step(0, refused, T0 + 75 * SEC)).toBe("signIn");
});

test("loading has a deadline and shares the fleet sign-in budget", () => {
  const step = fleetOf(7);
  const loading = game({ screen: "loading" });
  for (let k = 0; k < 7; k++) expect(step(k, loading, T0)).toBeNull();
  expect(step(0, loading, T0 + 179 * SEC)).toBeNull();
  for (let k = 0; k < 6; k++) expect(step(k, loading, T0 + 3 * MIN)).toBe("reload");
  expect(step(6, loading, T0 + 3 * MIN)).toBeNull();
  expect(step(6, loading, T0 + 3 * MIN + 30 * SEC)).toBe("reload");
});

test("a gap in heap readings waits for a new sustained window", () => {
  const step = fleetOf(1);
  const full = game({ heap: { used: 2600, limit: 4000 } });
  expect(step(0, full, T0, { exported: true })).toBeNull();
  expect(step(0, full, T0 + 11 * MIN, { exported: true })).toBeNull();
  expect(step(0, full, T0 + 12 * MIN, { exported: true })).toBeNull();
  expect(step(0, full, T0 + 13 * MIN, { exported: true })).toBeNull();
  for (let k = 14; k < 21; k++) expect(step(0, full, T0 + k * MIN, { exported: true })).toBeNull();
  expect(step(0, full, T0 + 21 * MIN, { exported: true })).toBe("renew");
});

test("renewal waits fifteen minutes after a raid, but not sixteen", () => {
  const step = fleetOf(1);
  const full = (t: number) => game({ t, heap: { used: 2600, limit: 4000 }, bot: { task: { kind: "raid", status: "done", endedAt: T0 + 10 * MIN } } });
  for (let k = 0; k <= 24; k++) expect(step(0, full(T0 + k * MIN), T0 + k * MIN, { exported: true })).toBeNull();
  expect(step(0, full(T0 + 26 * MIN), T0 + 26 * MIN, { exported: true })).toBe("renew");
});

test("a select reload's fresh login does not wait the per-tab retry interval", () => {
  const step = fleetOf(1);
  const select = game({ screen: "select", conn: { connected: false } });
  expect(step(0, select, T0)).toBeNull();
  expect(step(0, select, T0 + MIN)).toBe("reload");
  expect(step(0, login({ hasBridge: false, hasBot: false, pageSession: 2 }), T0 + 90 * SEC)).toBe("signIn");
});
