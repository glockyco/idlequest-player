// The coordinator's policy (docs/plans/controller.md, step 5): what each tab should do next that
// several tabs share, decided in one place. It is pure: `decide` gets the world as plain data and
// returns the tasks to queue, and tools/iqd.mjs gathers the inputs and queues the tasks in the
// pages through the bot's own task API. It never plays a step itself.
import { stoneShares } from "../../src/group.mjs";
import { ACQUIRE, bestWay, describeTrip, netRate, paceOf, slotKey, targetId, targetRetryMin, trip } from "./acquire.mjs";
import { estimate } from "./rates.mjs";

export const STONES = ["Greater Lightstone", "Lightstone"];

export const DEFAULTS = {
  // A hand-in costs each member about a minute of the group's hunting, so a batch waits until it
  // pays every member at least one Greater Lightstone's worth (two stones a member on average).
  minStonesPerMember: 2,
  // A hand-in or farm join that failed holds its tab this long, because neither has a retry time
  // of its own, unlike quests, hunts and targets (`due` in `decide`).
  failHoldMin: 30,
  // A hunt for an epic or quest piece, whose value the gear model does not price, starts only while
  // the tab's hunts took less than this share of its last hour.
  huntShare: 0.15,
  // A piece hunt needs this many minutes of that share left, since a trip and a clear of the
  // points take about two and a shorter hunt ends with nothing.
  minHuntMin: 5,
  // A task running this long, half again the hour that raises the long-task alert, waits for
  // something that is not coming (an NPC that never spawns), so it stops and the tab hunts again.
  taskStopMin: 90,
  // The casino's daily boss potion (docs/plans/systems-research.md, "Boss summons and daily
  // allowance"): a leader from `minLevel` rolls `dice` dice, which win it in about six rolls for the
  // same mean price as fewer dice, and stops after `maxPp`, about three potions' mean price.
  casino: { minLevel: 46, dice: 9, maxPp: 10000 },
};

/**
 * Every character's AA settings: all XP to AA, paused below level 60, because a rank gives 2 stat
 * points for 75M XP while a level below 60 gives far more for less (docs/plans/systems-research.md,
 * section 1).
 */
export const AA_POLICY = { allocation: 100, level: 60, rankPp: 2000 };

const AA = { str: 50001, sta: 50002, agi: 50003, dex: 50004, int: 50005, wis: 50006, cha: 50007, magic: 50008, cold: 50009, fire: 50010, poison: 50011, disease: 50012, run: 50013, regen: 50014, metabolism: 50015, lungs: 50016 };
const CASTING = { magician: AA.int, wizard: AA.int, necromancer: AA.int, enchanter: AA.int, cleric: AA.wis, druid: AA.wis, shaman: AA.wis };

/**
 * The order in which a class trains its abilities, as ability ids (docs/plans/systems-research.md,
 * "When and what to train"): the casting stat for casters and priests, stamina, for the others
 * stamina and the melee stats, then the resists, regeneration, and last what adds little to the
 * play the bot runs. Every ability is in it, so a character ends with every rank.
 */
export function aaOrder(cls) {
  const casting = CASTING[String(cls ?? "").toLowerCase()];
  const melee = [AA.str, AA.dex, AA.agi];
  const first = casting ? [casting, AA.sta] : [AA.sta, ...melee];
  return [...new Set([...first, AA.magic, AA.fire, AA.cold, AA.poison, AA.disease, AA.regen, ...melee, AA.int, AA.wis, AA.cha, AA.run, AA.metabolism, AA.lungs])];
}

/** Game hours count as night from 20 to 5, as the client's spell time rules do. */
export const isNight = (hour) => hour != null && (hour >= 20 || hour < 5);

/** The `members` of quest chain `id`'s class and level who do not hold the chain (`holders`). */
export function chainNeeders(id, { quests = {}, holders = {}, members = [] }) {
  const q = quests[id];
  return members.filter((m) => m.class === q.class && (m.level ?? 0) >= (q.minLevel ?? 1) && !(holders[id] ?? []).includes(m.name)).map((m) => m.name);
}

/**
 * The items that show a character is done with quest chain `id`: its reward, its `doneIf`, and,
 * for every chain that `needs` the reward and so takes it away, that chain's own done items, so a
 * reward spent on the next chain (the Sealed Note for Brother Hayle's Note) does not start the
 * chain over.
 */
export function doneItems(id, quests, seen = new Set()) {
  const q = quests[id];
  if (!q || seen.has(id)) return [];
  seen.add(id);
  const later = Object.keys(quests).filter((k) => k !== id && (quests[k].needs ?? []).includes(q.reward));
  return [...new Set([q.reward, ...(q.doneIf ?? []), ...later.flatMap((k) => doneItems(k, quests, seen))].filter(Boolean))];
}

/**
 * Where each quest chain stands, for the dashboard: its class, reward and level, `holders` (carry
 * the reward or an item that stands for it), `started` (carry an item of the chain, not holders)
 * and `needers` (`chainNeeders`: members of the class and level who do not hold it yet).
 */
export function chainSummary({ quests = {}, holders = {}, started = {}, members = [] }) {
  return Object.fromEntries(
    Object.entries(quests).map(([id, q]) => [
      id,
      { class: q.class, reward: q.reward, minLevel: q.minLevel ?? 1, holders: holders[id] ?? [], started: (started[id] ?? []).filter((n) => !(holders[id] ?? []).includes(n)), needers: chainNeeders(id, { quests, holders, members }) },
    ]),
  );
}

/**
 * Write the outcome of each ended bot task into its history entry: when it ended, how long it took,
 * its status (done, failed or stopped), the result or error and the step it stopped at, when the
 * task said to come back, and a gear task's refused purchases (`refusedBuys`). A failure at the step
 * where the tab's run of the same task before it failed too is a `repeat` (`retryTime`). `tasks` are
 * the tabs' latest `bot.task` objects. Returns whether an entry changed.
 */
export function settleHistory(history, tasks) {
  const byId = new Map(tasks.filter((t) => t?.id).map((t) => [t.id, t]));
  let changed = false;
  for (const [k, h] of history.entries()) {
    const task = byId.get(h.task);
    if (!task || task.status === "running") continue;
    const next = { nextAt: task.nextAt ?? h.nextAt, ms: task.endedAt && task.startedAt ? task.endedAt - task.startedAt : h.ms, endedAt: task.endedAt ?? h.endedAt, status: task.status, result: task.result ?? null, error: task.error ?? null, step: task.step ?? null, kills: task.kills };
    if (task.status === "failed") {
      const before = history.slice(0, k).filter((x) => x.id === h.id && x.label === h.label).at(-1);
      next.repeat = before?.status === "failed" && before.step === next.step;
    }
    for (const [key, v] of Object.entries(next)) {
      if (v === undefined || h[key] === v) continue;
      h[key] = v;
      changed = true;
    }
    if (task.refusedBuys?.length && !h.refusedBuys) {
      h.refusedBuys = task.refusedBuys;
      changed = true;
    }
  }
  return changed;
}

// The longest an errand runs, a farm's two hours, with the passes around it.
const ERRAND_MAX_MS = 2.5 * 3600000;

/**
 * Write the end of each errand into its history entry. An errand is a mode of the bot and not a
 * task, so nothing reports its end: it is over once its tab shows no errand, or a later one.
 * `tabs` are `[{ label, errand }]` for the tabs seen now, `errand` with the bot's `since`. The end
 * is the time it was first seen over, at most a cycle late. Without it the errands' hours were
 * missing from every count of what trips cost. Returns whether an entry changed.
 */
export function settleErrands(history, tabs, now) {
  const byLabel = new Map(tabs.map((t) => [t.label, t]));
  let changed = false;
  for (const h of history) {
    if (h.kind !== "errand" || h.status) continue;
    const tab = byLabel.get(h.label);
    // A tab not seen now says nothing, and an errand queued a moment ago may not show yet.
    if (!tab || now - h.t < 120000 || (tab.errand && !(tab.errand.since > h.t + 120000))) continue;
    // An entry from before the ends were recorded, or from before a long stop of the collector,
    // is over at a time nobody saw, so it gets no length.
    Object.assign(h, now - h.t > ERRAND_MAX_MS ? { status: "done" } : { ms: now - h.t, endedAt: now, status: "done" });
    changed = true;
  }
  return changed;
}

/**
 * The merchant goods whose purchase a gear task saw refused within `hours`, as `merchant|item`
 * keys, so the gear plan offers them again only after that, when the merchant may stand again.
 */
export function refusedGoods(history, now, hours = 24) {
  return new Set(history.filter((h) => h.refusedBuys && now - (h.endedAt ?? h.t) < hours * 3600000).flatMap((h) => h.refusedBuys.map((b) => `${b.merchant}|${b.item}`)));
}

/**
 * The items that show a carrier of them part way through quest chain `q` with the pieces it needs
 * (`needs`) behind it: the `expect` of every step from the first one that uses a needed piece up, by
 * a `give` or a craft input, or of every step when the chain needs nothing. A carrier of an earlier
 * step's item has begun the chain but still needs the pieces.
 */
export function progressItems(q) {
  const needs = q.needs ?? [];
  const at = needs.length ? q.steps.findIndex((s) => needs.some((n) => (s.give ?? []).includes(n) || (s.craft?.inputs ?? []).includes(n))) : 0;
  return [...new Set(q.steps.slice(Math.max(0, at)).map((s) => s.expect).filter((e) => e && e !== q.reward))];
}

/**
 * Copies of opportunity `o`'s item the account needs: its `count`, or for a piece of quest chain
 * `o.quest` one for each member who needs the chain, so a piece its hand-ins use up is hunted
 * again only while someone still needs it.
 */
export function piecesNeeded(o, { quests = {}, holders = {}, members = [] }) {
  return quests[o.quest] ? chainNeeders(o.quest, { quests, holders, members }).length : (o.count ?? 1);
}

/**
 * When the coordinator may run a task again after `last`, its newest history entry on a tab, as a
 * time in ms (0 for at once): the time the run named (`nextAt`, a respawn) or `retryMin` after it.
 * A failure under older code than `code` may run at once, also one that named a time, because the
 * deploy since may have fixed its cause, and a repeat under the new code waits as usual. So does a
 * failure that repeated the run before it at the same step (`repeat`), because the deploys between
 * them did not change it. A run that ended as waiting named the world's time, such as a spawn
 * point's next roll, which no deploy changes.
 */
export function retryTime(last, retryMin, code = null) {
  if (!last) return 0;
  if (last.status === "failed" && !last.repeat && code != null && last.code != null && last.code !== code) return 0;
  return last.nextAt ?? last.t + retryMin * 60000;
}

/**
 * Until when quest `id` is held for every tab, in ms (0 for not at all): a run that waits for the
 * world's time, such as a spawn point that rolls at a known time, and a failure with a time of its
 * own under the code that runs now (`code`) or repeated at its step, such as an occupant the group
 * could not clear, hold every member who needs that NPC.
 */
export function worldHold(history, id, code = null) {
  const holds = (h) => h.status === "waiting" || (h.status === "failed" && (h.repeat || code == null || h.code == null || h.code === code));
  return Math.max(0, ...history.filter((h) => h.id === id && h.nextAt && holds(h)).map((h) => h.nextAt));
}

/**
 * The tasks to queue now. Inputs:
 * - `tabs`: `[{ label, group, members: [{ name, level, class }], task: { kind, status } | null, errand, zone, gameHour }]`,
 *   one per playing tab whose bot runs.
 * - `stock`: lightstones on the account, `{ "Greater Lightstone": n, Lightstone: m }`.
 * - `stoneXp`: the XP Smith Tv`ysa's script pays for one of each stone, by name (`handInDemand`).
 * - `opportunities`: data/opportunities.json, `[{ id, group | levels, kind, zone, keep, item, count | quest, camp, when, retryMin, points }]`,
 *   epic and quest pieces, where `kind` "errand" hunts the enemies inside normal hunting and the default is a directed hunt,
 *   which camps the enemies' spawn points unless `camp` is false, when it fights them through Enemy Targets wherever they stand.
 * - `missing`: copies of each opportunity's item the account still needs, `{ [id]: n }` (tools/iqd.mjs counts them),
 *   and `carriedBy`, who carries each opportunity's item, `{ [id]: [name] }`.
 * - `farms`: data/farms.json, `[{ id, zone, keep, levels: [min, max], maxGroups, minutes }]`, errands
 *   that run for loot rather than one item, such as lightstones from Nektulos wisps.
 * - `quests`: data/quests.json, `{ [id]: { class, minLevel, reward, needs, steps, retryMin } }`, `holders`,
 *   the account characters that carry each quest's reward, `{ [id]: [name] }`, `started`, those that
 *   carry the reward of one of its earlier steps, `{ [id]: [name] }`, and `have`, the account's
 *   copies of each item a quest `needs`, `{ [item]: n }`.
 * - `gear`: the roster gear pass of this pass, `{ moves }` (tools/lib/gear-plan.mjs), or null.
 * - `held`: groups a running experiment holds (`experimentSettings`), which get no farms and no
 *   errands, because both change the AutoLevel limits the arms compare. Their hunts, quests and
 *   gear moves run, since tools/crossover.mjs leaves the minutes a task ran in out of XP per hour.
 * - `history`: the coordinator's earlier tasks, `[{ t, label, kind, id, code }]`, where `code` is the
 *   bot and bridge code the task ran under, and `code` the code the tabs run now.
 * - `targets`: the gear pass's enemies worth hunting for gear (tools/lib/gear-plan.mjs), best first,
 *   `crowded`, zones other players crowd (`crowdedZones`), `points`, the spawn points of each target
 *   by `targetId`, and the terms of `trip` and `bestWay` (tools/lib/acquire.mjs): `hoursPerLevel`,
 *   `killsPerHour` and `killChance(tab, target)`, a group's kill chance against the enemy
 *   (`killChanceOf`), null when unknown.
 * - `rolled`: when each character last rolled the casino, `{ [name]: ms }`.
 * - `xpFactor`: what kills pay now against their normal XP, above 1 during an XP event
 *   (tools/lib/xp-events.mjs), with `hoursPerLevel` at the normal pace.
 * Returns `{ actions, targets }`: `actions`, `[{ label, kind, spec, why, id?, ids? }]`, at most one
 * per tab, where kind `stopErrand` ends a tab's errand and `stopTask` its running task, and a trip
 * names its targets in `ids`, and `targets`, by `targetId`, the group each target pays most for,
 * its way, hours, value and cost, and its `status`.
 */
export function decide({ now, tabs, stock = {}, stoneXp = {}, opportunities = [], missing = {}, carriedBy = {}, farms = [], quests = {}, holders = {}, started = {}, have = {}, gear = null, held = new Set(), history = [], code = null, targets = [], crowded = new Set(), points = {}, hoursPerLevel = {}, killsPerHour = {}, killChance = () => null, rolled = {}, xpFactor = 1, cfg = DEFAULTS }) {
  const out = [];
  // A tab whose page runs older code than the tabs should (`stale`) takes no new task, because
  // the page supervisor deploys only between tasks: group 1 went from task to task for an hour and
  // fought three raids on the code of an hour before.
  const busy = new Set(tabs.filter((t) => t.task?.status === "running" || t.errand || t.stale).map((t) => t.label));
  // A tab takes its next task as soon as its last one ended: each task comes back on its own clock
  // (`due`), and the two kinds without one, hand-ins and farm joins, wait `failHoldMin` after a failure.
  const free = (t) => !busy.has(t.label) && !out.some((o) => o.label === t.label);
  const failedLately = (label, match) => history.some((h) => h.label === label && h.status === "failed" && match(h) && now - h.t < cfg.failHoldMin * 60000);
  const due = (last, retryMin) => now >= retryTime(last, retryMin, code);
  // An hour of hunting in an XP event is worth `xpFactor` normal hours, and a quest chain, a piece
  // hunt or a gear trip can run on any day. So the chains and the piece hunts, whose value no
  // model prices, wait for the event's end, and a gear trip goes only when it pays for its time at
  // that worth. What a day loses when it passes, the casino roll and the boss kills, still runs,
  // and so do errands, which hunt on, and gear moves, which take minutes and raise the XP rate.
  const event = xpFactor > 1;
  const net = (w) => (w.value - xpFactor * w.cost) / w.hours;

  // Time of the last hour each tab spent on the coordinator's hunts, by their recorded length, and
  // a hunt without one, still running or ended unseen, by the time since it started, at most the
  // 20 minutes a hunt may run.
  const huntMs = (label) => history.filter((h) => h.label === label && h.kind === "hunt" && now - h.t < 3600000).reduce((a, h) => a + (h.ms ?? Math.min(now - h.t, 1200000)), 0);

  // A group an experiment holds plays only what its arm sets, so an errand it runs stops.
  for (const t of tabs) if (held.has(t.group) && t.errand) out.push({ label: t.label, kind: "stopErrand", id: null, spec: null, why: `an experiment holds ${t.group}` });

  for (const t of tabs) {
    const ms = t.task?.status === "running" && t.task.startedAt ? now - t.task.startedAt : 0;
    if (ms > cfg.taskStopMin * 60000) out.push({ label: t.label, kind: "stopTask", id: null, spec: null, why: `${t.task.kind} task running for ${Math.round(ms / 60000)} min${t.task.step ? ` at "${t.task.step}"` : ""}` });
  }

  // The casino's boss potion comes first: the account wins at most one a day, a day not rolled is a
  // potion lost, and the rolls take a minute. One character of `casino.minLevel` rolls for the
  // account, and the task names when the next potion can be won. A potion stays with its winner and
  // is LORE, so the character that rolled longest ago (`rolled`, by name) rolls, a member as well as
  // a leader, which spreads a boss's potions over characters.
  const lastRoll = history.filter((h) => h.kind === "casino").at(-1);
  const rollers = tabs.filter(free).flatMap((t) => t.members.filter((m) => (m.level ?? 0) >= cfg.casino.minLevel).map((m) => ({ t, name: m.name })));
  const roller = rollers.sort((a, b) => (rolled[a.name] ?? 0) - (rolled[b.name] ?? 0))[0];
  if (roller && due(lastRoll, 60) && !tabs.some((t) => t.task?.kind === "casino" && t.task.status === "running")) out.push({ label: roller.t.label, kind: "casino", id: "casino", who: roller.name, spec: { who: roller.name, dice: cfg.casino.dice, maxPp: cfg.casino.maxPp }, why: `the day's boss potion with ${roller.name}` });

  // Quest chains (data/quests.json) come next, because each step is certain progress while a
  // camp mostly finds its spawn down. They run for every member of their class who has the level and lacks
  // the reward, one quest task per tab for all such members of it, and come back after `retryMin`
  // when one failed.
  for (const [id, q] of event ? [] : Object.entries(quests)) {
    // A quest that uses up a dropped item runs for as many members as the account holds copies
    // outside the chain's needers (`have`), and for every member already past the step that uses
    // it up (`started`, from `progressItems`). A pull never takes another needer's copy (`avoid`).
    let copies = Math.min(Infinity, ...(q.needs ?? []).map((n) => have[n] ?? 0));
    const needers = chainNeeders(id, { quests, holders, members: tabs.flatMap((t) => t.members) });
    // A quest whose NPC was not up lately waits on a spawn point, which every needer's group would
    // reach at once when its hold ends, and all but the first would find the point held. So one
    // group runs it at a time, and the others come once that run has looked. So does a quest
    // with a fight: its enemy is one NPC that a hand-in calls, and the giver is gone until its
    // respawn. Four groups sent to Jaeil the Wretched at once (2026-11-12) fought one another's
    // enemy, and no ranger got its hammer.
    const pointBound = history.some((h) => h.id === id && h.status === "waiting" && now - h.t < 2 * 3600000);
    const fights = q.steps.some((s) => s.kill);
    const runs = () => out.some((o) => o.kind === "quest" && o.id === id) || tabs.some((t) => t.task?.status === "running" && history.some((h) => h.id === id && h.label === t.label && h.task === t.task.id));
    for (const t of tabs) {
      if (!free(t)) continue;
      const want = t.members.map((m) => m.name).filter((n) => needers.includes(n));
      const begun = want.filter((n) => (started[id] ?? []).includes(n));
      const fresh = want.filter((n) => !begun.includes(n)).slice(0, copies);
      const who = [...begun, ...fresh];
      if (!who.length) continue;
      const last = history.filter((h) => h.id === id && h.label === t.label).at(-1);
      if (!due(last, q.retryMin ?? 120)) continue;
      if (now < worldHold(history, id, code)) continue;
      if ((pointBound || fights) && runs()) continue;
      copies -= fresh.length;
      out.push({ label: t.label, kind: "quest", id, spec: { members: who, steps: q.steps, name: id, ...(q.needs?.length ? { avoid: needers.filter((n) => !who.includes(n)) } : {}) }, why: `${id} for ${who.join(", ")}` });
    }
  }

  // Epic and quest pieces next, whose value the gear model does not price. An opportunity names
  // its group, or `levels` for any free group whose mean level lies inside, preferring one already
  // in the zone, because NO DROP pieces move between account characters. It waits for its time of
  // day. Pieces of a quest chain come first, those most characters still miss first, because a
  // kill that serves several characters' chains is worth more than one for a single piece.
  const rank = (o) => (o.quest ? (missing[o.id] ?? 0) : -1);
  for (const o of [...opportunities].sort((a, b) => rank(b) - rank(a))) {
    if (missing[o.id] === 0) continue;
    // Pieces from the same enemies (the four Mastery pages) need one group on them, not four.
    if (o.kind === "errand" && (tabs.some((t) => t.errand?.zone === o.zone && t.errand?.keep === o.keep) || out.some((a) => a.spec?.zone === o.zone && a.spec?.keep === o.keep))) continue;
    // The leader loots, and a lore piece it already carries stays on the corpse, so a group whose
    // leader carries the piece does not hunt it until a member has taken it.
    const looter = (t) => !(carriedBy[o.id] ?? []).includes(t.members[0]?.name);
    const tab = o.levels
      ? tabs.filter((t) => free(t) && t.members.length && looter(t) && (o.kind !== "errand" || !held.has(t.group)) && mean(t) >= o.levels[0] && mean(t) <= o.levels[1]).sort((a, b) => (b.zone === o.zone) - (a.zone === o.zone) || mean(a) - mean(b))[0]
      : tabs.find((t) => t.group === o.group);
    // An errand widens AutoLevel's range, which an experiment's arms compare, so a held group gets none.
    if (!tab || !free(tab) || !looter(tab) || (o.kind === "errand" && held.has(tab.group))) continue;
    if (o.when === "night" && !isNight(tab.gameHour)) continue;
    if (o.when === "day" && (tab.gameHour == null || isNight(tab.gameHour))) continue;
    const last = history.filter((h) => h.id === o.id).at(-1);
    if (!due(last, o.retryMin ?? 30)) continue;
    // An errand puts the enemies first inside the group's normal hunting, for pieces from enemies in
    // its level range. A hunt fights them directed or camps their points, for gray ones or rare spawns.
    // A hunt runs at most for what is left of the tab's hunt share of the hour, and only when that
    // leaves `minHuntMin` for the trip and a clear of the points.
    const left = Math.floor((cfg.huntShare * 3600000 - huntMs(tab.label)) / 60000);
    if (o.kind !== "errand" && (event || left < cfg.minHuntMin)) continue;
    const spec = o.kind === "errand" ? { zone: o.zone, keep: o.keep, item: o.item, minutes: o.minutes ?? 60 } : { zone: o.zone, keep: o.keep, item: o.item, ...(o.points?.length ? { points: o.points } : {}), waitMin: 0, minutes: Math.min(o.minutes ?? 20, left) };
    out.push({ label: tab.label, kind: o.kind === "errand" ? "errand" : "hunt", id: o.id, spec, why: `${o.item} for ${tab.group}` });
  }

  // Gear moves come before gear hunts: one gear task carries out every move of the plan, its
  // largest gains, in minutes, and at most one trip to a merchant's city.
  // The task pulls each item to its tab's leader, which refuses a lore item it carries already
  // (`loreHolders` of a move), so such moves wait for a later task on another tab. It goes to the
  // free tab whose leader blocks the fewest moves, then to the one with the lowest levels, whose
  // hunting the minutes cost least. A move that has to be placed (`exact`) runs in the tab of the
  // receiver's own group, where the receiver can become the active character, together with the
  // receiver's other moves, so no other tab changes what it wears meanwhile. While that tab is
  // busy the placed move waits for the next plan, and the receiver's other moves go as usual.
  if (gear?.moves?.length) {
    const blocks = (t, m) => (m.loreHolders ?? []).includes(t.members[0]?.name);
    const ownTab = (name) => tabs.find((x) => x.members.some((m) => m.name === name));
    const placed = new Set(gear.moves.filter((m) => m.exact && ownTab(m.to) && free(ownTab(m.to))).map((m) => m.to));
    const anywhere = gear.moves.filter((m) => !placed.has(m.to) && !m.exact);
    for (const x of tabs.filter((x) => x.members.some((m) => placed.has(m.name)))) {
      const own = gear.moves.filter((m) => placed.has(m.to) && x.members.some((mm) => mm.name === m.to) && !blocks(x, m));
      if (own.length) out.push({ label: x.label, kind: "gear", spec: { moves: own }, why: `${own.length} gear moves for ${[...new Set(own.map((m) => m.to))].join(", ")}, placed in their hands` });
    }
    const blocked = (t) => anywhere.filter((m) => blocks(t, m)).length;
    const t = tabs.filter((x) => free(x) && x.members.length).sort((a, b) => blocked(a) - blocked(b) || mean(a) - mean(b))[0];
    const moves = t ? anywhere.filter((m) => !blocks(t, m)) : [];
    if (moves.length) out.push({ label: t.label, kind: "gear", spec: { moves }, why: `${moves.length} gear moves for ${new Set(moves.map((m) => m.to)).size} characters` });
  }

  // Gear targets (docs/plans/gear-acquisition.md): any group may hunt for any character, because a
  // gear task moves the copy afterwards. A group's trip goes to one zone and hunts every wanted
  // enemy there that pays (`trip`), since the zone's cost is paid once and the drops roll on their
  // own. The assignment is greedy with re-evaluation: of all pairs of free tab (no experiment holds
  // its group for an errand) and zone no tab found crowded lately, the trip that earns most per hour
  // of the hunting group's time goes first, then every pair is valued again with that trip's taker
  // slots claimed, its zone occupied and its kills taken from its enemies' spawn points, and so
  // on. An enemy stays open to further groups while its points still supply a quarter of what
  // they respawn (`minSupply`), and a further group's copy goes to the item's next taker. A
  // claimed slot without one still takes a copy that comes sooner, for the hours until the
  // claim's copy would come (`copyValue`). The groups that already hunt a target claim and take
  // the same way.
  const targetEval = {};
  // Each target's last coordinator task, found once for the pass. A trip's task names all its targets.
  const lastHunts = new Map();
  for (const h of history) for (const id of h.ids ?? (h.id ? [h.id] : [])) lastHunts.set(id, h);
  const lastHunt = (id) => lastHunts.get(id);
  const ctx = { tabs, hoursPerLevel, killsPerHour, killChance };
  const hunter = (t) => free(t) && t.members.length;
  // An errand changes the AutoLevel limits an experiment's arms compare, so a held group gets none.
  const allowed = (t, kind) => !(kind === "errand" && held.has(t.group));
  // What keeps a group from a target this pass: a task queued this pass, its errand or its running task.
  const holding = (t) => {
    const queued = out.find((o) => o.label === t.label);
    if (queued) return { kind: queued.kind, id: queued.id ?? null, queued: true };
    if (t.errand) return { kind: "errand", zone: t.errand.zone };
    if (t.task?.status === "running") return { kind: t.task.kind, step: t.task.step ?? null };
    return { kind: "none" };
  };
  // The tabs on a target's errand, by its enemies, or on the hunt the coordinator queued for it, by
  // the bot task the history records for the target.
  const huntersOf = (x) => tabs.filter((t) => (t.errand?.zone === x.zone && new RegExp(t.errand.keep ?? "^$", "i").test(x.npc)) || (t.task?.status === "running" && history.some((h) => h.label === t.label && h.task != null && h.task === t.task.id && (h.ids ?? [h.id]).includes(targetId(x)))));
  const hunted = new Map(targets.map((x) => [targetId(x), huntersOf(x)]));
  const byId = new Map(targets.map((x) => [targetId(x), x]));
  // The kills an hour an enemy's points supply as they respawn, null where no respawn time is known.
  const supply = (x) => (x.respawn > 0 ? ((x.points ?? 1) * (x.spawn ?? 1)) / (x.respawn / 3600) : null);
  // What the hunting groups take of each target, in kills an hour. A hunt kills whichever of its
  // enemies is up, so a group's kills spread over its hunt's targets as their supply offers them.
  // A target without a respawn time, or a group without a kill rate, leaves nothing to others.
  const taken = new Map();
  const take = (t, xs) => {
    const all = xs.reduce((s, x) => s + (supply(x) ?? 0), 0);
    for (const x of xs) {
      const s = supply(x);
      const kills = paceOf(killsPerHour[t.group] ?? 0, killChance(t, x));
      taken.set(targetId(x), (taken.get(targetId(x)) ?? 0) + (s == null || !(kills > 0) ? Infinity : Math.min(s, (kills * s) / all)));
    }
  };
  for (const t of tabs) {
    const xs = targets.filter((x) => hunted.get(targetId(x)).includes(t));
    if (xs.length) take(t, xs);
  }
  // The share of a target's supply that no hunt takes.
  const left = (x) => {
    const k = taken.get(targetId(x)) ?? 0;
    return k === 0 ? 1 : Math.max(0, 1 - k / (supply(x) ?? 0));
  };
  // A target as a further group finds it: with the points and the copies its other hunters leave.
  const shared = (x) => {
    const f = left(x);
    return f >= 1 ? x : { ...x, points: (x.points ?? 1) * f, items: x.items.map((w) => ({ ...w, hours: w.hours / f, ...(w.respawnHours ? { respawnHours: w.respawnHours / f } : {}) })) };
  };
  // A night or day spawn is hunted only then, by the game's hour on the tab.
  const inTime = (x, t) => !x.when || (x.when === "night" ? isNight(t.gameHour) : t.gameHour != null && !isNight(t.gameHour));
  // Each taker slot a hunt serves, `{ gain, hours, npc }`: the best copy coming, its expected hours
  // of hunting and its enemy. A slot keeps the better of two claims.
  const claimed = new Map();
  const claim = (x, w) => {
    for (const [j, item] of x.items.entries()) {
      const c = { gain: item.gain, hours: w?.copies?.[j] ?? Infinity, npc: x.npc };
      const old = claimed.get(slotKey(item));
      if (!old || c.gain > old.gain || (c.gain === old.gain && c.hours < old.hours)) claimed.set(slotKey(item), c);
    }
  };
  // A target with the claims on its slots: an item whose slot another hunt serves goes to its next
  // taker (`others`, the gear plan's further takers of the item, best first), and without one it
  // is valued as a copy that a slot already expects.
  const withClaims = (x) => ({
    ...x,
    items: x.items.map((w) => {
      if (!claimed.has(slotKey(w))) return w;
      const next = (w.others ?? []).find((o) => !claimed.has(slotKey(o)));
      return next ? { ...w, ...next } : { ...w, claim: claimed.get(slotKey(w)) };
    }),
  });
  for (const x of targets) {
    for (const by of hunted.get(targetId(x))) {
      const y = withClaims(x);
      claim(y, bestWay(by, y, ctx));
    }
  }
  // The trips chosen this pass, as tabs in their zones for the shared-zone cost.
  const occupied = [];
  const taker = (x) => x.items[0].to;
  // The facts of a way to get a target's drop, for the dashboard: who hunts it for whom, how, the
  // hours per copy (or per visit), the share of visits that find it up, what a copy adds and costs
  // in hours of group progress, and how many enemies its trip hunts.
  const planOf = (t, x, w, enemies = 1) => ({ group: t.group, taker: taker(x), item: x.items[0].item, kind: w.kind, hours: w.hours, up: w.up ?? null, value: w.value, cost: w.cost, enemies });
  // The groups queued for each target this pass.
  const queuedFor = new Map();
  // Wanted enemies by zone, leaving out zones found crowded.
  const zones = new Map();
  // The enemies a hunt found no route to in the last day ("no route to a Paebala warrior" in its
  // result): the client finds no place to stand and fight them, so no trip names them.
  const noRoute = new Set();
  for (const h of history) {
    const said = now - h.t < 86400000 ? /no route to ([^()]+?)(?: \(|$)/.exec(h.result ?? "") : null;
    if (!said) continue;
    const names = said[1].split(", ").map((n) => n.trim().toLowerCase());
    const ids = new Set(h.ids ?? (h.id ? [h.id] : []));
    for (const x of targets) if (ids.has(targetId(x)) && names.includes(String(x.npc).replace(/#/g, "").toLowerCase())) noRoute.add(targetId(x));
  }
  for (const x of targets) if (!crowded.has(x.zone) && !noRoute.has(targetId(x))) (zones.get(x.zone) ?? zones.set(x.zone, []).get(x.zone)).push(x);
  // The enemies of a camp the client stopped in the last day ("Spawn Camp stopped: Navigation
  // recovery could not find a supported combat position."): it cannot camp their points, and the
  // hunt went on as a visit, so the next trips are visits too. The client stopped 17 camps on
  // 2026-11-11.
  const noCamp = new Set(history.filter((h) => now - h.t < 86400000 && /Spawn Camp stopped/.test(h.result ?? "")).flatMap((h) => h.ids ?? (h.id ? [h.id] : [])));
  for (;;) {
    const withTrips = { ...ctx, tabs: [...tabs, ...occupied] };
    let best = null;
    for (const t of tabs.filter(hunter)) {
      for (const xs of zones.values()) {
        // An enemy a group hunts now is not waiting for its next hunt, so its retry time does not hold a further group.
        const open = xs.filter((x) => left(x) >= ACQUIRE.minSupply && inTime(x, t)).map((x) => withClaims(shared(x)));
        if (!open.length) continue;
        const w = trip(t, open, withTrips, (x, kind) => allowed(t, kind) && !(kind === "camp" && noCamp.has(targetId(x))) && (taken.has(targetId(x)) || due(lastHunt(targetId(x)), targetRetryMin(kind))));
        if (w && net(w) > 0 && (!best || net(w) > net(best.w))) best = { t, w };
      }
    }
    if (!best) break;
    const { t, w } = best;
    const ids = w.members.map((m) => targetId(m.x));
    // A target's `also` are the enemies a chain of deaths brings to it, which the hunt kills too.
    const keep = [...new Set(w.members.flatMap((m) => [m.x.npc, ...(m.x.also ?? [])]).map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))].join("|");
    // A trip for one enemy ends once its best item is in the bags, and one for several runs its time.
    const item = w.members.length === 1 ? { item: w.members[0].x.items[0].item } : {};
    // A camp kills whatever stands on its targets' points, and a visit watches them for their respawn.
    const pts = [...new Set(w.members.flatMap((m) => points[targetId(m.x)] ?? []))];
    const spec = w.kind === "errand" ? { zone: w.zone, keep, ...item, minutes: 60 } : { zone: w.zone, keep, ...item, ...(pts.length ? { [w.kind === "camp" ? "points" : "watch"]: pts } : {}), waitMin: 0, minutes: w.kind === "visit" ? Math.max(1, Math.round(w.hours * 60)) : ACQUIRE.campMin };
    const why = `${t.group} ${w.kind === "errand" ? "hunts" : w.kind === "camp" ? "camps" : "visits"} ${w.zone} for ${w.members.map((m) => m.x.npc).join(", ")}: ${describeTrip(w)}`;
    out.push({ label: t.label, kind: w.kind === "errand" ? "errand" : "hunt", id: ids[0], ids, spec, why });
    for (const m of w.members) {
      const id = targetId(m.x);
      targetEval[id] ??= { state: "queued", plan: planOf(t, m.x, m.w, w.members.length) };
      queuedFor.set(id, [...(queuedFor.get(id) ?? []), t.group]);
      claim(m.x, m.w);
    }
    take(t, w.members.map((m) => byId.get(targetId(m.x))));
    occupied.push({ label: null, group: t.group, zone: w.zone });
  }
  // Why every other target waits: its hunt runs, its zone is crowded, no group can kill it, other
  // hunts serve its takers' slots, no way pays, or the group it pays most for is busy or held and
  // no free group's trip takes it at a profit. Each reason is a `state` with its facts, and the
  // dashboard words it (tools/dashboard/gear.js).
  for (const x of targets) {
    const id = targetId(x);
    const on = hunted.get(id);
    // Every group on the target: those that hunt it and those this pass sends.
    const groups = [...new Set([...on.map((t) => t.group), ...(queuedFor.get(id) ?? [])])];
    if (targetEval[id]) {
      Object.assign(targetEval[id], { ...(on.length ? { state: "hunting", group: on[0].group } : {}), groups });
      continue;
    }
    const reach = tabs.filter((t) => t.members.length).map((t) => ({ t, w: bestWay(t, x, ctx) })).filter((p) => p.w);
    const best = reach.reduce((a, b) => (!a || net(b.w) > net(a.w) ? b : a), null);
    const plan = best ? planOf(best.t, x, best.w) : null;
    // The best chance any group has against it, which says whether a target is out of every
    // group's reach (below `ACQUIRE.tooStrong`) or only not worth it yet.
    const chances = tabs.filter((t) => t.members.length).map((t) => killChance(t, x)?.p).filter((p) => p != null);
    const chance = chances.length ? Math.max(...chances) : null;
    let why;
    if (on.length) why = { state: "hunting", group: on[0].group, groups };
    else if (x.items.every((w) => claimed.has(slotKey(w)))) why = { state: "covered", by: [...new Set(x.items.map((w) => claimed.get(slotKey(w)).npc))] };
    else if (noRoute.has(id)) why = { state: "noRoute" };
    else if (crowded.has(x.zone)) why = { state: "crowded" };
    else if (tabs.length && !inTime(x, tabs[0])) why = { state: "time", when: x.when };
    else if (chance == null) why = { state: "untested", level: x.npcLevel ?? null };
    else if (!best || chance < ACQUIRE.tooStrong) why = { state: "tooStrong", level: x.npcLevel ?? null, chance };
    else if (!x.items.some((w) => hoursPerLevel[w.to] > 0)) why = { state: "noPace", taker: taker(x) };
    else if (netRate(best.w) <= 0) why = { state: "notWorth" };
    else if (net(best.w) <= 0) why = { state: "event", factor: xpFactor };
    else if (!allowed(best.t, best.w.kind)) why = { state: "experiment", group: best.t.group };
    else if (!hunter(best.t)) why = { state: "busy", group: best.t.group, only: reach.length === 1, on: holding(best.t) };
    else if (!due(lastHunt(id), targetRetryMin(best.w.kind))) why = { state: "retry", at: retryTime(lastHunt(id), targetRetryMin(best.w.kind), code) };
    else why = { state: "outbid" };
    targetEval[id] = { ...why, plan };
  }

  // A farm goes to the groups with the lowest mean level inside its `levels`, whose own hunting
  // earns least next to the farm's fixed yield. At most `maxGroups` share it, because groups in one
  // zone wait for the enemies the others hold: three wisp groups in Nektulos lost 11 to 20% of their
  // time that way. A farming group that left the levels or is beyond the cap stops.
  for (const f of farms) {
    const fits = (t) => mean(t) >= f.levels[0] && mean(t) <= f.levels[1] && !held.has(t.group);
    const on = tabs.filter((t) => t.errand?.zone === f.zone && t.errand?.keep === f.keep).sort((a, b) => mean(a) - mean(b));
    const stay = on.filter(fits).slice(0, f.maxGroups);
    for (const t of on) if (!stay.includes(t) && !out.some((o) => o.label === t.label)) out.push({ label: t.label, kind: "stopErrand", id: f.id, spec: null, why: `${f.id}: ${held.has(t.group) ? "an experiment holds the group" : fits(t) ? `more than ${f.maxGroups} groups` : `mean level ${mean(t).toFixed(1)} is outside ${f.levels.join(" to ")}`}` });
    const join = tabs.filter((t) => free(t) && t.members.length && fits(t) && !failedLately(t.label, (h) => h.id === f.id)).sort((a, b) => mean(a) - mean(b)).slice(0, Math.max(0, f.maxGroups - stay.length));
    for (const t of join) out.push({ label: t.label, kind: "errand", id: f.id, spec: { zone: f.zone, keep: f.keep, minutes: f.minutes }, why: `${f.id} for ${t.group}, mean level ${mean(t).toFixed(1)}` });
  }

  // Lightstones go to the group with the lowest levels, where they buy the most levels and which
  // sets the account's time to level 60. That is often a farming group, whose farm the hand-in
  // interrupts: the farm itself feeds the lowest groups, so it must not keep them from the stones.
  const total = STONES.reduce((a, s) => a + (stock[s] ?? 0), 0);
  const farming = (t) => farms.some((f) => t.errand?.zone === f.zone && t.errand?.keep === f.keep);
  const ready = (t) => (free(t) || (farming(t) && t.task?.status !== "running" && !out.some((o) => o.label === t.label))) && !failedLately(t.label, (h) => h.kind === "handIn");
  const candidates = tabs.filter((t) => ready(t) && t.members.length).sort((a, b) => mean(a) - mean(b));
  const target = candidates[0];
  if (target && total >= cfg.minStonesPerMember * target.members.length) {
    const levels = Object.fromEntries(target.members.map((m) => [m.name, m.level]));
    const members = stoneShares(target.members.map((m) => m.name), levels, stock);
    const xp = STONES.reduce((a, s) => a + (stock[s] ?? 0) * (stoneXp[s] ?? 0), 0);
    out.push({ label: target.label, kind: "handIn", spec: { members }, why: `${total} stones (${Math.round(xp / 1000)}k XP) to the lowest group, mean level ${mean(target).toFixed(1)}` });
  }
  return { actions: out, targets: targetEval };
}

const mean = (t) => t.members.reduce((a, m) => a + (m.level ?? 0), 0) / Math.max(1, t.members.length);

export const ZONE_DEFAULTS = {
  // Zones in a rotation: the bot hunts the first and moves along when a zone runs dry.
  keep: 3,
  // Hours of a zone's prior rate its own measurement is weighed against, so a zone with little time
  // there ranks at the prior and gets tried, and its own rate takes over with time.
  priorHours: 0.5,
  // A zone that pays under `deadShare` of its prior over `trialHours` is one the model does not
  // hold for, so its measured rate stands alone. High Keep and the Temple of Solusek Ro paid no XP
  // at all in 0.20 and 0.74 hours at levels 43 to 50 on 2026-11-11, and their priors of 2.9M and
  // 2.3M an hour kept them in the rotations, High Keep first for group 8 at level 50.
  trialHours: 0.1,
  deadShare: 0.25,
  // A zone's trial also counts its time at the levels this far away, where the levels within two
  // have less than a trial. Zones that never pay were otherwise tried by every group at every
  // level: High Keep took 20 minutes without XP in six tries from level 38 to 54.
  trialSpan: 8,
  // A group leaves its zone for one worth this share more.
  margin: 0.2,
  // A rotation set this recently stays, so the group can arrive before the crowds shift again.
  settleMin: 10,
};

// A group this many levels below the next band row also ranks that row's zones: the XP model rates
// them close to its own row's best a few levels early, and many groups at one band crowd one row.
const NEXT_BAND_LEVELS = 2;

/** The zones a group at `level` ranks: its band row's, and the next row's within `NEXT_BAND_LEVELS`. */
export function bandZones(rows, level) {
  const sorted = [...rows].sort((a, b) => a[0] - b[0]);
  const next = sorted.find(([min]) => min > level);
  return [...new Set([...(sorted.findLast(([min]) => level >= min)?.[1] ?? []), ...(next && level >= next[0] - NEXT_BAND_LEVELS ? next[1] : [])])];
}

/** Zones any tab found crowded by other players in the last 45 minutes (`crowdedAt`), which hold for every group. */
export function crowdedZones(tabs, now) {
  return new Set(tabs.flatMap((t) => Object.entries(t.crowdedAt ?? {}).filter(([, at]) => now - at < 45 * 60000).map(([z]) => z)));
}

/**
 * Each group's zone rotation (docs/plans/controller.md, principle 4): the `keep` zones of the band
 * row at its leader's level (`rows`, data/band-rotations.json, with the next row near it,
 * `bandZones`) with the most measured XP per hour
 * (`rates`, tools/lib/rates.mjs), best first. The bot stays in a zone of its rotation and moves
 * along it when the zone runs dry, and moves to the first zone when its own is not in the
 * rotation. A group stays in its zone, and keeps its rotation, until the best zone is worth
 * `margin` more, so measurement noise and shifting crowds do not move groups back and forth.
 * A rotation set within `settleMin` (`rotationSetAt`) stays while the group travels to it. Groups are assigned from the lowest
 * level up, because the slowest group sets the account's time to 60. A zone is worth what one
 * more group adds to the account there: with `f(n)` = `crowdFactor(zone, level, n)` the share of
 * its rate alone a group gets beside `n` others, the `n` groups already there earn `n f(n-1)` and
 * would earn `(n+1) f(n)` with this one (docs/plans/zone-crowding.md: a zone supplies so many kills
 * an hour, which the groups share). Valued at its own share alone, a sixth group in Solusek's Eye
 * looked as good as a third in Kaesora while it added a third as much. A zone's measured rate is
 * weighed against `priorHours` of a prior: the XP model's rate there (`model(zone, level)`, tools/
 * predict.mjs) at the median ratio of measured to modeled rate in the row's zones with that much
 * time, or the median of their measured rates where the model has none. So a zone with little time
 * there ranks where the model puts it among the measured ones and gets tried. Busy groups keep their rotation and
 * count for the zone they are in. Groups an experiment holds are assigned like the others, because
 * crowding the arms unevenly confounds an experiment more than a change of zone does. Returns
 * `[{ label, rotation, why }]` for the rotations whose zones change.
 */
export function assignZones({ now, tabs, rows = [], rates = {}, crowdFactor = () => 1, model = () => null, cfg = ZONE_DEFAULTS }) {
  const out = [];
  const crowd = new Map();
  const occupy = (zone) => zone && crowd.set(zone, (crowd.get(zone) ?? 0) + 1);
  const fixed = (t) => t.task?.status === "running" || t.errand;
  for (const t of tabs) if (fixed(t)) occupy(t.zone);
  // A zone any tab found crowded lately is worth a quarter, after group 1 idled 46% of two hours
  // moving between three crowded zones of its rotation.
  const busyZones = crowdedZones(tabs, now);
  for (const t of [...tabs].filter((x) => !fixed(x)).sort((a, b) => mean(a) - mean(b))) {
    const level = t.members[0]?.level ?? 0;
    const row = bandZones(rows, level);
    if (!row.length) continue;
    const zones = row.map((z, k) => ({ z, k, e: estimate(rates, z, level, now), wide: estimate(rates, z, level, now, cfg.trialSpan), m: model(z, level) }));
    const solid = zones.filter((m) => m.e?.hours >= cfg.priorHours);
    const base = solid.length ? solid : zones.filter((m) => m.e);
    const mid = (xs) => (xs.length ? xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null);
    const median = mid(base.map((m) => m.e.xph)) ?? 1;
    const scale = mid(base.filter((m) => m.m > 0).map((m) => m.e.xph / m.m)) ?? 1;
    const prior = (m) => (m.m > 0 ? scale * m.m : median);
    // What a zone's trial measured: at the levels within two, or failing that over the wider span.
    const trial = (m) => [m.e, m.wide].find((e) => e?.hours >= cfg.trialHours) ?? null;
    const dead = (m) => Boolean(trial(m)) && trial(m).xph < cfg.deadShare * prior(m);
    const xph = (m) => (dead(m) ? trial(m).xph : !m.e ? prior(m) : (m.e.hours * m.e.xph + cfg.priorHours * prior(m)) / (m.e.hours + cfg.priorHours));
    // What one more group adds to the account in a zone, in shares of the zone's rate alone.
    const gain = (z) => {
      const n = crowd.get(z) ?? 0;
      const f = (k) => (k > 0 ? crowdFactor(z, level, k) : 1);
      return (n + 1) * f(n) - n * f(n - 1);
    };
    // A zone with less than `priorHours` of its own time is the model's guess, so one group tries
    // it at a time: on 0.3 hours in The Hole a replay sent four groups there in one pass. A group
    // already in it stays in the count, and where every zone of a row is such a guess, as at a
    // new band, the rule would leave a group without a zone and does not apply.
    const guess = (m) => !(m.e?.hours >= cfg.priorHours) && m.z !== t.zone && (crowd.get(m.z) ?? 0) > 0;
    const rank = (held) => zones.map((m) => ({ ...m, xph: xph(m), value: held(m) ? 0 : (xph(m) * gain(m.z)) / (busyZones.has(m.z) ? 4 : 1) })).sort((a, b) => b.value - a.value || a.k - b.k);
    const ranked = rank(guess).some((m) => m.value > 0) ? rank(guess) : rank(() => false);
    const own = ranked.find((m) => m.z === t.zone);
    const stay = own && own.value * (1 + cfg.margin) >= ranked[0].value;
    // A zone worth under `deadShare` of the row's best fills no place, nor one held for another
    // group's trial: a rotation's later zones are where the bot goes when the first runs dry, and
    // it would idle there.
    const worth = ranked.filter((m) => !guess(m) && m.xph >= cfg.deadShare * Math.max(...ranked.map((x) => x.xph)));
    const top = worth.filter((m) => m.z !== t.zone || stay).slice(0, cfg.keep);
    const rotation = [...top, ...(stay && !top.includes(own) ? [own] : [])].map((m) => m.z);
    occupy(stay ? t.zone : rotation[0]);
    // A group that stays keeps its rotation while it holds at most `keep` zones of the band row and
    // none found crowded: the other zones matter only once the bot leaves this one, and the pass
    // after that move ranks them anew, so shifting crowds do not rewrite the rotation every pass. A
    // longer rotation, as restoreGroup sets the whole row, or one with a crowded zone sends the bot
    // through zones the ranking would skip.
    const rotationInRow = (t.rotation ?? []).length > 0 && t.rotation.length <= cfg.keep && t.rotation.every((z) => row.includes(z) && !busyZones.has(z)) && t.rotation.includes(t.zone);
    // The bot moves through its rotation as spawns run out, so the rotation is judged by its best zone.
    const rotationBest = Math.max(0, ...ranked.filter((m) => (t.rotation ?? []).includes(m.z)).map((m) => m.value));
    // A rotation of one zone leaves the bot nowhere to go when that zone fills. A move leaves the
    // old zone out, so the bot goes, and with two live zones in a row that left one: four groups
    // stood in Kedge Keep for 37 to 62% of an hour with no second zone (2026-11-12). Once the group
    // stays where it was sent, the rotation gets the ranking's next zones.
    const noWayOut = (t.rotation ?? []).length < 2 && rotation.length > 1;
    if (stay && rotationInRow && !noWayOut && rotationBest * (1 + cfg.margin) >= ranked[0].value) continue;
    if (t.rotationSetAt && now - t.rotationSetAt < cfg.settleMin * 60000 && (t.rotation ?? []).every((z) => row.includes(z))) {
      occupy(t.rotation[0]);
      continue;
    }
    // Order alone moves no group, so a rotation with the same zones stays as it is.
    if (JSON.stringify([...rotation].sort()) === JSON.stringify([...(t.rotation ?? [])].sort())) continue;
    const shown = rotation.map((z) => ranked.find((m) => m.z === z)).map((m) => `${m.z} ${Math.round(m.xph / 1000)}k (${m.e ? `${m.e.hours.toFixed(1)} h` : "unmeasured"})`);
    out.push({ label: t.label, rotation, why: `level ${level}: ${shown.join(", ")}` });
  }
  return out;
}

/**
 * The bot settings experiments ask for now (data/experiments.json, docs/plans/controller.md,
 * principle 7). An experiment is a crossover as tools/crossover.mjs reads it:
 * `{ id, a: [group], b: [group], blockMin, blocks, setting, without, after }`. In even blocks arm A
 * plays with `setting` and arm B with `without`, in odd blocks the other way round, for `blocks`
 * blocks (2 by default), and then every group of it keeps `without` until the experiment leaves
 * the file. More, shorter blocks cancel the slow drifts of a group's XP per hour (level-ups, zone
 * changes) that two long ones carry into the comparison. `started` maps an experiment
 * id to the time it started, and `running` to its `{ a, b, without }` as it started, both kept by
 * the caller, so an experiment that leaves the file before its end still returns its groups to
 * `without`. `ended` maps an experiment id to the time its end or drop was reported. An experiment
 * with `after` starts only once the experiment of that id has ended, so the file can queue the next
 * one on the same groups. Returns
 * `{ settings: { [group]: partial }, events: [{ id, kind: "start" | "end" | "dropped", start }],
 * held: Set of the groups an experiment holds }`, where `held` groups get no farms and no errands,
 * because these change what the arms compare.
 */
export function experimentSettings({ now, experiments = [], started = {}, ended = {}, running = {} }) {
  const settings = {};
  const events = [];
  const held = new Set();
  const set = (groups, s) => {
    for (const g of groups) settings[g] = { ...settings[g], ...s };
  };
  for (const x of experiments) {
    if (started[x.id] == null && x.after && ended[x.after] == null) continue;
    const start = started[x.id] ?? now;
    if (started[x.id] == null) events.push({ id: x.id, kind: "start", start });
    const block = Math.floor((now - start) / (x.blockMin * 60000));
    if (block >= (x.blocks ?? 2)) {
      set([...x.a, ...x.b], x.without);
      if (ended[x.id] == null) events.push({ id: x.id, kind: "end", start });
      continue;
    }
    for (const g of [...x.a, ...x.b]) held.add(g);
    set(x.a, block % 2 === 0 ? x.setting : x.without);
    set(x.b, block % 2 === 0 ? x.without : x.setting);
  }
  const listed = new Set(experiments.map((x) => x.id));
  for (const [id, x] of Object.entries(running)) {
    if (listed.has(id) || ended[id] != null) continue;
    set([...x.a, ...x.b], x.without);
    events.push({ id, kind: "dropped", start: started[id] });
  }
  return { settings, events, held };
}
