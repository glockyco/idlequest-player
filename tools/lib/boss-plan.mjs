// The boss-kill planner (docs/plans/raids.md): which boss the account kills next, from which
// source and by which way. Pure: tools/iqd.mjs gathers the daily list, the potions the survey
// finds, the kill chances and the raid time, and queues the result as a task.

import { copyValue } from "./acquire.mjs";
import { npcKey } from "./fight-record.mjs";

/**
 * The worth of one kill of each boss in `bosses` (`[{ key, name }]`), in hours of a group's
 * progress: the gear pass's target for the boss by name (`targets`, tools/lib/gear-plan.mjs), each
 * wanted copy at its drop chance times its worth to its taker (`copyValue` at `hoursPerLevel`), the
 * best copy for each taker's slot, since one copy fills it. A boss no target names is worth 0.
 */
export function bossValues({ bosses, targets = [], hoursPerLevel = {} }) {
  // The daily list says "Cazic-Thule" for the content's "Cazic_Thule", so both go by the record's key.
  const byName = new Map(targets.map((t) => [npcKey(t.npc), t]));
  const out = {};
  for (const b of bosses) {
    const best = new Map();
    for (const w of byName.get(npcKey(b.name))?.items ?? []) {
      const key = `${w.to}:${w.slot}`;
      best.set(key, Math.max(best.get(key) ?? 0, (w.drop ?? 1) * copyValue(w, hoursPerLevel)));
    }
    out[b.key] = [...best.values()].reduce((s, v) => s + v, 0);
  }
  return out;
}

/** A candidate is killable when every simulated fight killed it (`{ kills, fights }`). */
export const killable = (o) => Boolean(o && !o.error && o.fights > 0 && o.kills === o.fights);

/**
 * The daily list's bosses a summon or a resume can bring now: a boss the client shows as
 * "Available" (any status but cooldown, limit and disabled) while free summons are left, and a
 * saved private copy (`resume`) always, since resuming spends no summon.
 */
export function dailyCandidates(daily) {
  if (!daily) return [];
  return daily.bosses.filter((b) => b.status === "resume" || (!["cooldown", "limit", "disabled"].includes(b.status) && daily.resetsRemaining > 0));
}

/**
 * The next boss kill, or null with the reasons in `skipped`.
 * - `daily`: `iq.raid.bosses()` of a leader at 46 or more: `{ resetsRemaining, resetLimit, bosses: [{ key, name, zone, status }] }`.
 * - `potions`: casino potions the survey finds, `[{ key, name, zone, itemId, who }]`, `who` the holder.
 * - `standing`: casino bosses a potion summoned that no raid has killed yet (`standingBosses`).
 * - `open`: raid bosses a tab saw alive at their open-world spawn point, `[{ key, name, zone }]`
 *   (`openBosses`). They need no summon and no potion.
 * - `paid`: whether raid time is running that a raid can use.
 * - `canBuy`: whether the day's raid hours leave one for the open world (`OPEN_BUY`). An open-world
 *   boss outside `first` is killed in paid time, or buys an hour when `canBuy` holds and the
 *   open-world kills the hour would bring are worth `OPEN_BUY.worth` hours together.
 * - `odds`: kill chances by boss key (runs/state/kill-odds.json), `{ raid: { kills, fights }, groups: { [group]: { kills, fights } } }`.
 * - `value`: worth of a kill by boss key, in hours of a group's progress from its loot (`bossValues`), 0 when unknown.
 * - `first`: the raid goal's bosses that no raid has killed yet (data/raid-goal.json): the account
 *   has to kill each of them once, whatever they drop, so they are planned also outside paid time.
 * A standing boss goes first: its potion is spent, it waits at its spawn point for the character
 * that summoned it, and the server refuses every other potion while it stands ("Your account
 * already has a summoned casino boss"), so the other potions wait for it. The others go by their
 * worth per minute of raid time, the simulator's fight and `RAID_SETUP_MIN` together, also a
 * boss of `first`: after the server's restart of 2026-11-12 five bosses stood, and the raid spent
 * its hour on Cazic-Thule's ten-minute fight while Lady Vox, Trakanon and Phinigel Autropos each
 * take the simulator under a minute and other players may take them first. Every kill is a raid's:
 * a group can fight a boss in a hunt, but nothing yet judges it against the boss with its company.
 * The simulator fights a boss alone and gave group 1 four kills of four against Phinigel
 * Autropos, who beat it twice beside his seahorses (docs/plans/raids.md, Schedule). A raid on a
 * summon or a potion runs as soon as one is due, because a free summon comes back 24 hours after
 * its use. A boss that stands in the open world is killed there, which leaves its summon for
 * another boss, and outside `first` within the day's raid hours (`OPEN_BUY`). A potion's raid is
 * led by its holder.
 */
export function nextBossKill({ daily = null, potions = [], standing = [], open = [], paid = true, canBuy = false, odds = {}, value = {}, first = [], waiting = () => null }) {
  const skipped = [];
  const ways = [];
  // `waiting(candidate, source)` names why a boss's last raid holds it, such as a kill minutes
  // ago, so the next boss gets its turn: Lord Nagafen, killed at 22:25 on 2026-11-12, stayed the
  // plan's pick and held Innoruuk and Cazic-Thule back.
  const add = (c, source) => {
    const o = odds[c.key] ?? {};
    const held = waiting(c, source);
    if (held) skipped.push({ key: c.key, why: held });
    else if (killable(o.raid)) ways.push({ ...c, source, way: "raid" });
    else skipped.push({ key: c.key, why: o.raid?.error ? "the simulation failed" : o.raid ? `the simulator kills it in ${o.raid.kills} of ${o.raid.fights} fights` : "no kill chance yet" });
  };
  for (const s of standing) add(s, "standing");
  const worth = open.filter((o) => !first.includes(o.key) && killable(odds[o.key]?.raid) && !waiting(o, "open")).reduce((s, o) => s + (value[o.key] ?? 0), 0);
  for (const o of open) {
    if (first.includes(o.key) || paid) add(o, "open");
    else if (!canBuy) skipped.push({ key: o.key, why: `it stands in the open world, and ${OPEN_BUY.hoursADay} hours of raid time ran in the last day, the most such bosses may bring it to` });
    else if (worth < OPEN_BUY.worth) skipped.push({ key: o.key, why: `it stands in the open world, and an hour of raid time would bring kills worth ${worth.toFixed(2)} h, under the ${OPEN_BUY.worth} h it has to bring` });
    else add(o, "open");
  }
  for (const b of dailyCandidates(daily)) if (!open.some((o) => o.key === b.key)) add(b, "summon");
  for (const p of potions) {
    if (standing.length) skipped.push({ key: p.key, why: `${standing[0].name} stands summoned, and the server takes no other potion until it is dead` });
    else add(p, "potion");
  }
  const perMinute = (w) => (value[w.key] ?? 0) / (RAID_SETUP_MIN + (odds[w.key]?.raid?.meanSec ?? 600) / 60);
  const rank = (w) => (w.source === "standing" ? 0 : 1);
  return { kill: ways.sort((a, b) => rank(a) - rank(b) || perMinute(b) - perMinute(a))[0] ?? null, skipped };
}

// The minutes a raid takes besides its fight: from the task's start to the engagement (two minutes
// for Cazic-Thule on 2026-11-12), and the end and the loot.
export const RAID_SETUP_MIN = 3;

/** The coordinator's history id of a kill's raid task: a potion's boss with its holder, an open-world boss, or a summon's boss. */
export const killId = (k) => (k.source === "potion" || k.source === "standing" ? `boss:potion:${k.itemId}:${k.who}` : k.source === "open" ? `boss:open:${k.key}` : `boss:summon:${k.key}`);

/**
 * What an open-world boss outside the raid goal may spend on raid time. An hour costs 10,000
 * platinum and the account's sales brought 30,241 on 2026-11-11, three hours a day, of which the
 * evening's summons take one. So such a boss buys an hour while fewer than `hoursADay` ran in the
 * last 24 hours, and only for kills worth `worth` hours of a group's progress together, which is
 * an assumed price: nothing measures yet what else the platinum would buy.
 */
export const OPEN_BUY = { hoursADay: 2, worth: 1 };

/**
 * The raid hours on record with `time` added (`iq.raid.time()`: `{ active, expiresAt }`): the end
 * of each hour, kept for three days. Each bought or renewed hour moves the end by an hour, so an
 * end within half an hour of one on record is the same hour.
 */
export function raidHours(ledger = [], time = null, now = Date.now()) {
  const ends = ledger.filter((end) => end > now - 3 * 86400000);
  if (time?.active && time.expiresAt > now && !ends.some((end) => Math.abs(end - time.expiresAt) < 30 * 60000)) ends.push(time.expiresAt);
  return ends;
}

/** How many of the raid hours on record (`raidHours`) ended inside the last 24 hours or still run. */
export const hoursLastDay = (ledger, now) => ledger.filter((end) => end > now - 86400000).length;

// A boss a tab saw alive counts as standing this long after the look, the time between two reads
// of a zone's spawn list by a group that hunts there.
const OPEN_SEEN_MS = 30 * 60000;

/**
 * The raid bosses that stand in the open world, from what the tabs see in their zones' spawn lists
 * (`seen`, by name key: `{ name, zone, level, state, seenAt }`, the enemies the client keeps out of
 * AutoLevel): those alive at a look within `OPEN_SEEN_MS` whose name is on the daily list
 * (`daily.bosses`, which gives the key and the zone the look has to be from) or among the raid
 * goal's bosses (`goal`, names), as `[{ key, name, zone }]`. A boss off the daily list goes by its
 * name key.
 */
export function openBosses({ seen = {}, daily = null, goal = [], now }) {
  const out = [];
  for (const [key, s] of Object.entries(seen)) {
    if (s.state !== "alive" || now - s.seenAt > OPEN_SEEN_MS) continue;
    const listed = (daily?.bosses ?? []).find((b) => npcKey(b.name) === key);
    if (listed ? listed.zone !== s.zone : !goal.some((g) => npcKey(g) === key)) continue;
    out.push({ key: listed?.key ?? key, name: listed?.name ?? String(s.name).replace(/^#/, "").replace(/_/g, " "), zone: s.zone });
  }
  return out;
}

/**
 * The bosses the account watches in the open world: those of the daily list and of the raid goal
 * (`goal`, names) that a live spawn point puts up (`spawns`, `namedSpawns` of
 * tools/lib/content.mjs for their names), as `[{ key, name, zone, respawnMs, goal }]`. A boss of
 * the daily list goes by the list's key and counts at a point in the list's zone. The two free
 * summons a day bring two kills, and each of these is one more. Lord Yelinak and Vulak`Aerr are
 * on no list, so the open world is the only place the account kills them.
 */
export function watchedBosses({ daily = null, goal = [], spawns = new Map() }) {
  const out = [];
  const add = (name, key, zone, isGoal) => {
    const points = (spawns.get(name) ?? []).filter((p) => !zone || p.zone === zone);
    if (points.length && !out.some((w) => w.key === key)) out.push({ key, name, zone: points[0].zone, respawnMs: Math.min(...points.map((p) => p.respawnMs)), goal: isGoal });
  };
  const isGoal = (name) => goal.some((g) => npcKey(g) === npcKey(name));
  for (const b of daily?.bosses ?? []) add(b.name, b.key, b.zone, isGoal(b.name));
  for (const g of goal) if (!(daily?.bosses ?? []).some((b) => npcKey(b.name) === npcKey(g))) add(g, npcKey(g), null, true);
  return out;
}

/**
 * When a look is sent and how long it stays. A pass starts every five minutes and gives its tasks
 * one to three minutes later (13:15:34 and 13:18:44 for the passes begun at 13:12 and 13:17 on
 * 2026-11-12), and the trip takes under a minute. So a look for a due respawn is sent by the
 * first pass inside `leadMs` before it, which puts the group there two minutes ahead at the
 * latest, and it waits `waitMs` past the respawn. One boss is looked for again after `retryMs` at
 * the earliest, and a sighting that gave no respawn time is asked again after `staleMs`.
 */
export const LOOK = { leadMs: 10 * 60000, waitMs: 5 * 60000, retryMs: 30 * 60000, staleMs: 6 * 3600000 };

const clock = (t) => new Date(t).toTimeString().slice(0, 5);

/**
 * The next look into a boss's zone, `{ key, name, zone, until, why }`, or null. A look is a group
 * that travels there, reads the zone's spawn list and leaves (`lookTask` of src/bot.js), staying
 * until `until` when a respawn is due. Other players kill these bosses too: all five the tabs had
 * seen by 2026-11-12 were dead, so a boss is the account's only when a tab is there as it comes
 * back.
 * - `watch`: `watchedBosses`. `seen`: what the tabs last saw, by name key (`bossesSeen`).
 * - `lastLook(key)`: when the last look for the boss was sent, 0 for none.
 * - `lookTimes(key)`: look queue times, newest first, for backing off unchanged sightings.
 * - `wanted(w)`: whether the plan would kill the boss now if it stood. Only such a boss gets a
 *   look, since a look that leads to no kill costs a group its minutes and its risk for nothing.
 * A due respawn goes first, the earliest of them, then a boss that stood, whose kill needs a look
 * that is fresh (`OPEN_SEEN_MS`), then one no tab has seen, a goal boss before the others.
 */
export function nextLook({ watch = [], seen = {}, now, lastLook = () => 0, lookTimes = () => [], wanted = () => true }) {
  const due = [];
  for (const w of watch) {
    const s = seen[npcKey(w.name)]?.zone === w.zone ? seen[npcKey(w.name)] : null;
    const times = lookTimes(w.key);
    const unchanged = times.filter((t) => t > (s?.seenAt ?? 0)).length;
    const retry = Math.min(LOOK.staleMs, LOOK.retryMs * 2 ** Math.min(20, Math.max(0, unchanged - 1)));
    if (now - (times[0] ?? lastLook(w.key)) < retry || !wanted(w)) continue;
    if (!s) due.push({ rank: 2, at: 0, w, until: 0, why: "no tab has seen it yet" });
    else if (s.state === "alive") {
      if (now - s.seenAt > OPEN_SEEN_MS) due.push({ rank: 1, at: s.seenAt, w, until: 0, why: `it stood at ${clock(s.seenAt)}, and a raid needs a look that is fresh` });
    } else if (s.respawnAt) {
      if (now >= s.respawnAt - LOOK.leadMs) due.push({ rank: 0, at: s.respawnAt, w, until: Math.max(0, s.respawnAt + LOOK.waitMs), why: `its respawn ${now < s.respawnAt ? "is" : "was"} due at ${clock(s.respawnAt)}` });
    } else if (now - s.seenAt > LOOK.staleMs) due.push({ rank: 2, at: s.seenAt, w, until: 0, why: `it was down at ${clock(s.seenAt)} with no respawn time` });
  }
  const first = due.sort((a, b) => a.rank - b.rank || Number(b.w.goal) - Number(a.w.goal) || a.at - b.at)[0];
  return first ? { key: first.w.key, name: first.w.name, zone: first.w.zone, until: first.until > now ? first.until : 0, why: first.why } : null;
}

/**
 * The sightings on record with what the tabs see now of the watched bosses added (`log`, at most
 * 300 rows `{ key, state, respawnAt, seenAt }`): one row when a boss's state or respawn time is
 * another than at its last row, which is a kill by someone or a respawn.
 */
export function noteSightings(log = [], watch = [], seen = {}) {
  const out = [...log];
  for (const w of watch) {
    const s = seen[npcKey(w.name)];
    if (!s || s.zone !== w.zone) continue;
    const last = out.findLast((r) => r.key === w.key);
    if (last && last.state === s.state && (last.respawnAt ?? null) === (s.respawnAt ?? null)) continue;
    out.push({ key: w.key, state: s.state, respawnAt: s.respawnAt ?? null, seenAt: s.seenAt });
  }
  return out.slice(-300);
}

/**
 * The watched bosses as a reader sees them: `[{ key, name, zone, goal, state, seenAt, respawnAt,
 * killedAt, livedMs, value, raid }]`, `state` "alive", "down" or "unknown". A boss that is down
 * with a respawn time was killed one respawn before it (`killedAt`), and when the record holds
 * the respawn it had come back at, `livedMs` is how long it stood before someone killed it, which
 * is the time a look has to be there in.
 */
export function watchRows({ watch = [], seen = {}, log = [], value = {}, odds = {} }) {
  return watch.map((w) => {
    const s = seen[npcKey(w.name)]?.zone === w.zone ? seen[npcKey(w.name)] : null;
    const down = s && s.state !== "alive";
    const killedAt = down && s.respawnAt ? s.respawnAt - w.respawnMs : null;
    const cameAt = killedAt == null ? null : (log.findLast((r) => r.key === w.key && r.respawnAt && r.respawnAt <= killedAt && killedAt - r.respawnAt < w.respawnMs)?.respawnAt ?? null);
    return { key: w.key, name: w.name, zone: w.zone, goal: w.goal, state: !s ? "unknown" : down ? "down" : "alive", seenAt: s?.seenAt ?? null, respawnAt: down ? (s.respawnAt ?? null) : null, killedAt, livedMs: cameAt == null ? null : killedAt - cameAt, value: value[w.key] ?? null, raid: odds[w.key]?.raid ?? null };
  });
}

// The raid task's steps before it uses its potion (`raidTask` of src/bot.js). A task that ended
// at one of them left the potion in the bags.
const BEFORE_POTION = /^(become |stop$|travel to |raid time$|open the raid$|recruit$)/;

/**
 * Whether a raid task has used potion `p` since the survey that lists it, taken at `surveyAt`: one
 * queued for it since then, unless it ended at a step before the use. The survey runs hourly, so
 * until the next one it still lists a potion a raid drank, and its holder's group would travel to
 * the boss's zone at every pass.
 */
export function potionSpent(history, p, surveyAt) {
  const id = killId({ ...p, source: "potion" });
  return history.some((h) => h.id === id && h.t >= surveyAt && !(h.status && h.status !== "done" && BEFORE_POTION.test(h.step ?? "")));
}

// A summoned casino boss is taken as gone a day after its first sighting, when the next potion is due.
const STANDING_MS = 24 * 3600000;

/**
 * The casino bosses that stand summoned, from the raid tasks on record (`history`, the
 * coordinator's, with each task's status, step and result) and the casino table `bosses`
 * (`[{ key, name, zone, itemId }]`): `[{ key, name, zone, itemId, who, since, fights }]`, `who` the
 * character that used the potion and `fights` the raids that fought the boss without a kill. A
 * boss stands from the task that used its potion until a task kills it ("killed" in its result)
 * or finds no such enemy to target, which is a boss that expired. A task that ended before it
 * reached the boss changes nothing. Lodizal stood for 90 minutes and three fights, and a second
 * potion's raid bought an hour of raid time for 10,000 pp to be refused.
 */
export function standingBosses(history, bosses, now) {
  const state = new Map();
  for (const h of history) {
    const m = /^boss:potion:(\d+):(.+)$/.exec(h.id ?? "");
    if (!m || h.kind !== "raid") continue;
    const early = h.status && h.status !== "done" && BEFORE_POTION.test(h.step ?? "");
    const refused = h.status === "failed" && /^use potion /.test(h.step ?? "");
    if (early || refused) continue;
    const killed = h.status === "done" && /^killed /.test(h.result ?? "");
    const gone = h.status === "failed" && h.step === "target";
    if (killed || gone) state.delete(h.id);
    else state.set(h.id, { itemId: Number(m[1]), who: m[2], since: state.get(h.id)?.since ?? h.t, last: h.t, fights: (state.get(h.id)?.fights ?? 0) + (h.status ? 1 : 0) });
  }
  const out = [];
  for (const s of state.values()) {
    const boss = bosses.find((b) => b.itemId === s.itemId);
    if (boss && now - s.since < STANDING_MS) out.push({ key: boss.key, name: boss.name, zone: boss.zone, itemId: s.itemId, who: s.who, since: s.since, fights: s.fights });
  }
  return out;
}
