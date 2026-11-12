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
export const killable = (o) => Boolean(o && o.fights > 0 && o.kills === o.fights);

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
 * - `odds`: kill chances by boss key (runs/state/kill-odds.json), `{ raid: { kills, fights }, groups: { [group]: { kills, fights } } }`.
 * - `value`: worth of a kill by boss key, in hours of a group's progress from its loot (`bossValues`), 0 when unknown.
 * - `first`: the keys of the bosses to kill before any other, the raid goal's bosses that no raid
 *   has killed yet (data/raid-goal.json): the account has to kill each of them once, whatever they drop.
 * A standing boss goes first: its potion is spent, it waits at its spawn point for the character
 * that summoned it, and the server refuses every other potion while it stands ("Your account
 * already has a summoned casino boss"), so the other potions wait for it. A boss of `first` comes
 * next, then the others by their worth. Every kill is a raid's: no task carries out a group's
 * visit to a boss, and the simulator, which fights a boss alone, gave group 1 four kills of four
 * against Phinigel Autropos, who won all 52 fights with the groups beside his seahorses. A raid
 * runs as soon as one is due, because a free summon comes back 24 hours after its use, an
 * open-world boss is anyone's to kill, and the account's platinum far outruns the raid time it
 * buys. A boss that stands in the open world is killed there, which leaves its summon for
 * another boss. A potion's raid is led by its holder.
 */
export function nextBossKill({ daily = null, potions = [], standing = [], open = [], odds = {}, value = {}, first = [] }) {
  const skipped = [];
  const ways = [];
  const add = (c, source) => {
    const o = odds[c.key] ?? {};
    if (killable(o.raid)) ways.push({ ...c, source, way: "raid" });
    else skipped.push({ key: c.key, why: o.raid ? `the simulator kills it in ${o.raid.kills} of ${o.raid.fights} fights` : "no kill chance yet" });
  };
  for (const s of standing) add(s, "standing");
  for (const o of open) add(o, "open");
  for (const b of dailyCandidates(daily)) if (!open.some((o) => o.key === b.key)) add(b, "summon");
  for (const p of potions) {
    if (standing.length) skipped.push({ key: p.key, why: `${standing[0].name} stands summoned, and the server takes no other potion until it is dead` });
    else add(p, "potion");
  }
  const rank = (w) => (w.source === "standing" ? 0 : first.includes(w.key) ? 1 : 2);
  return { kill: ways.sort((a, b) => rank(a) - rank(b) || (value[b.key] ?? 0) - (value[a.key] ?? 0))[0] ?? null, skipped };
}

/** The coordinator's history id of a kill's raid task: a potion's boss with its holder, an open-world boss, or a summon's boss. */
export const killId = (k) => (k.source === "potion" || k.source === "standing" ? `boss:potion:${k.itemId}:${k.who}` : k.source === "open" ? `boss:open:${k.key}` : `boss:summon:${k.key}`);

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

// A summoned casino boss is taken as gone a day after its last raid, when the next potion is due.
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
    if (boss && now - s.last < STANDING_MS) out.push({ key: boss.key, name: boss.name, zone: boss.zone, itemId: s.itemId, who: s.who, since: s.since, fights: s.fights });
  }
  return out;
}
