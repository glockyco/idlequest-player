// The boss-kill planner (docs/plans/raids.md): which boss the account kills next, from which
// source and by which way. Pure: tools/iqd.mjs gathers the daily list, the potions the survey
// finds, the kill chances and the raid time, and queues the result as a task.

import { copyValue } from "./acquire.mjs";

/**
 * The worth of one kill of each boss in `bosses` (`[{ key, name }]`), in hours of a group's
 * progress: the gear pass's target for the boss by name (`targets`, tools/lib/gear-plan.mjs), each
 * wanted copy at its drop chance times its worth to its taker (`copyValue` at `hoursPerLevel`), the
 * best copy for each taker's slot, since one copy fills it. A boss no target names is worth 0.
 */
export function bossValues({ bosses, targets = [], hoursPerLevel = {} }) {
  const byName = new Map(targets.map((t) => [t.npc.replace(/^#/, "").toLowerCase(), t]));
  const out = {};
  for (const b of bosses) {
    const best = new Map();
    for (const w of byName.get(b.name.toLowerCase())?.items ?? []) {
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
 * - `odds`: kill chances by boss key (runs/state/kill-odds.json), `{ raid: { kills, fights }, groups: { [group]: { kills, fights } } }`.
 * - `value`: worth of a kill by boss key, in hours of a group's progress from its loot (`bossValues`), 0 when unknown.
 * A group kill goes first, since it needs no raid time, for an open-world spawn only: a summon or a
 * potion has been used inside raid mode only. A raid runs as soon as one is due, the most valuable
 * first, because a free summon comes back 24 hours after its use and the account's platinum far
 * outruns the raid time it buys. A potion's raid is led by its holder.
 */
export function nextBossKill({ daily = null, potions = [], odds = {}, value = {} }) {
  const skipped = [];
  const ways = [];
  const add = (c, source) => {
    const o = odds[c.key] ?? {};
    const group = Object.entries(o.groups ?? {}).find(([, g]) => killable(g))?.[0];
    if (source === "open" && group) ways.push({ ...c, source, way: "group", group });
    else if (killable(o.raid)) ways.push({ ...c, source, way: "raid" });
    else skipped.push({ key: c.key, why: o.raid ? `the simulator kills it in ${o.raid.kills} of ${o.raid.fights} fights` : "no kill chance yet" });
  };
  for (const b of dailyCandidates(daily)) add(b, "summon");
  for (const p of potions) add(p, "potion");
  const rank = (w) => (w.way === "group" ? 0 : 1);
  return { kill: ways.sort((a, b) => rank(a) - rank(b) || (value[b.key] ?? 0) - (value[a.key] ?? 0))[0] ?? null, skipped };
}

/** The coordinator's history id of a kill's raid task: a potion with its holder, or a summon's boss. */
export const killId = (k) => (k.source === "potion" ? `boss:potion:${k.itemId}:${k.who}` : `boss:summon:${k.key}`);

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
