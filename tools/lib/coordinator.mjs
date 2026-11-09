// The coordinator's policy (docs/plans/controller.md, step 5): what each tab should do next that
// several tabs share, decided in one place. It is pure: `decide` gets the world as plain data and
// returns the tasks to queue, and tools/iqd.mjs gathers the inputs and queues the tasks in the
// pages through the bot's own task API. It never plays a step itself.
import { stoneShares } from "../../src/group.mjs";
import { ACQUIRE, bestWay, describeWay, netRate, targetId, targetRetryMin } from "./acquire.mjs";
import { estimate } from "./rates.mjs";

export const STONES = ["Greater Lightstone", "Lightstone"];
/** XP Smith Tv`ysa pays for each stone (docs/guide.md). */
export const STONE_XP = { "Greater Lightstone": 274400, Lightstone: 137200 };

export const DEFAULTS = {
  // A hand-in costs each member about a minute of the group's hunting, so a batch waits until it
  // pays every member at least one Greater Lightstone's worth (two stones a member on average).
  minStonesPerMember: 2,
  // A tab gets at most one coordinator task in this window, so a failing task cannot loop.
  taskGapMin: 20,
  // A hunt for an epic or quest piece, whose value the gear model does not price, starts only while
  // the tab's hunts took less than this share of its last hour.
  huntShare: 0.15,
  // A task running this long, half again the hour that raises the long-task alert, waits for
  // something that is not coming (an NPC that never spawns), so it stops and the tab hunts again.
  taskStopMin: 90,
};

/**
 * Every character's AA settings: all XP to AA, paused below level 60, because a rank gives 2 stat
 * points for 75M XP while a level below 60 gives far more for less (docs/plans/systems-research.md,
 * section 1).
 */
export const AA_POLICY = { allocation: 100, level: 60 };

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
 * The items quest chains keep: every chain's done items (`doneItems`), which show progress and are
 * often epic pieces, and the needed pieces and step items of every chain that a member of its
 * class, at any level, does not hold yet. The bag reserve never sells or destroys them, and lets go
 * of a finished chain's inputs.
 */
export function questKeepItems({ quests = {}, holders = {}, members = [] }) {
  const open = Object.keys(quests).filter((id) => members.some((m) => m.class === quests[id].class && !(holders[id] ?? []).includes(m.name)));
  const steps = open.flatMap((id) => {
    const q = quests[id];
    return [...(q.needs ?? []), ...q.steps.flatMap((s) => [...(s.give ?? []), ...(s.craft?.inputs ?? []), ...Object.keys(s.each ?? {}), s.expect])];
  });
  return [...new Set([...Object.keys(quests).flatMap((id) => doneItems(id, quests)), ...steps].filter(Boolean))];
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
 * its status (done, failed or stopped), the result or error and the step it stopped at, and when
 * the task said to come back. `tasks` are the tabs' latest `bot.task` objects. Returns whether
 * an entry changed.
 */
export function settleHistory(history, tasks) {
  const byId = new Map(tasks.filter((t) => t?.id).map((t) => [t.id, t]));
  let changed = false;
  for (const h of history) {
    const task = byId.get(h.task);
    if (!task || task.status === "running") continue;
    const next = { nextAt: task.nextAt ?? h.nextAt, ms: task.endedAt && task.startedAt ? task.endedAt - task.startedAt : h.ms, endedAt: task.endedAt ?? h.endedAt, status: task.status, result: task.result ?? null, error: task.error ?? null, step: task.step ?? null };
    for (const [k, v] of Object.entries(next)) {
      if (v === undefined || h[k] === v) continue;
      h[k] = v;
      changed = true;
    }
  }
  return changed;
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
 * The tasks to queue now. Inputs:
 * - `tabs`: `[{ label, group, members: [{ name, level, class }], task: { kind, status } | null, errand, zone, gameHour }]`,
 *   one per playing tab whose bot runs.
 * - `stock`: lightstones on the account, `{ "Greater Lightstone": n, Lightstone: m }`.
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
 *   by `targetId`, and the terms of `bestWay` (tools/lib/acquire.mjs): `hoursPerLevel` and `zoneShare`.
 * Returns `{ actions, targets }`: `actions`, `[{ label, kind, spec, why, id? }]`, at most one per tab,
 * where kind `stopErrand` ends a tab's errand and `stopTask` its running task, and `targets`, by
 * `targetId`, the group each target pays most for, its way, hours, value and cost, and its `status`.
 */
export function decide({ now, tabs, stock = {}, opportunities = [], missing = {}, carriedBy = {}, farms = [], quests = {}, holders = {}, started = {}, have = {}, gear = null, held = new Set(), history = [], code = null, targets = [], crowded = new Set(), points = {}, hoursPerLevel = {}, killsPerHour = {}, zoneShare = () => 0, cfg = DEFAULTS }) {
  const out = [];
  const busy = new Set(tabs.filter((t) => t.task?.status === "running" || t.errand).map((t) => t.label));
  // A task that reported when to come back (`nextAt`, a hunt's respawn) brings its own schedule;
  // any other task holds its tab for `taskGapMin`, so a failing task cannot loop.
  const recent = (label) => history.some((h) => h.label === label && !h.nextAt && now - h.t < cfg.taskGapMin * 60000);
  const free = (t) => !busy.has(t.label) && !recent(t.label) && !out.some((o) => o.label === t.label);
  // A task comes back after the time its last run said (`nextAt`, a respawn) or after `retryMin`. A
  // failure under older code comes back at once, because the deploy since may have fixed its cause,
  // and a repeat under the new code waits as usual.
  const due = (last, retryMin) => !last || (last.status === "failed" && code != null && last.code != null && last.code !== code) || now >= (last.nextAt ?? last.t + retryMin * 60000);

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

  // Quest chains (data/quests.json) come first, because each step is certain progress while a
  // camp mostly finds its spawn down. They run for every member of their class who has the level and lacks
  // the reward, one quest task per tab for all such members of it, and come back after `retryMin`
  // when one failed.
  for (const [id, q] of Object.entries(quests)) {
    // A quest that uses up a dropped item runs for as many members as the account holds copies
    // outside the chain's needers (`have`), and for every member already past the step that uses
    // it up (`started`, from `progressItems`). A pull never takes another needer's copy (`avoid`).
    let copies = Math.min(Infinity, ...(q.needs ?? []).map((n) => have[n] ?? 0));
    const needers = chainNeeders(id, { quests, holders, members: tabs.flatMap((t) => t.members) });
    for (const t of tabs) {
      if (!free(t)) continue;
      const want = t.members.map((m) => m.name).filter((n) => needers.includes(n));
      const begun = want.filter((n) => (started[id] ?? []).includes(n));
      const fresh = want.filter((n) => !begun.includes(n)).slice(0, copies);
      const who = [...begun, ...fresh];
      if (!who.length) continue;
      const last = history.filter((h) => h.id === id && h.label === t.label).at(-1);
      if (!due(last, q.retryMin ?? 120)) continue;
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
    if (o.kind !== "errand" && huntMs(tab.label) >= cfg.huntShare * 3600000) continue;
    // An errand puts the enemies first inside the group's normal hunting, for pieces from enemies in
    // its level range. A hunt fights them directed or camps their points, for gray ones or rare spawns.
    // A hunt runs at most for what is left of the tab's hunt share of the hour.
    const left = Math.floor((cfg.huntShare * 3600000 - huntMs(tab.label)) / 60000);
    const spec = o.kind === "errand" ? { zone: o.zone, keep: o.keep, item: o.item, minutes: o.minutes ?? 60 } : { zone: o.zone, keep: o.keep, item: o.item, ...(o.points?.length ? { points: o.points } : {}), waitMin: 0, minutes: Math.max(1, Math.min(o.minutes ?? 20, left)) };
    out.push({ label: tab.label, kind: o.kind === "errand" ? "errand" : "hunt", id: o.id, spec, why: `${o.item} for ${tab.group}` });
  }

  // Gear targets (docs/plans/gear-acquisition.md): any group may hunt for any character, because a
  // gear task moves the copy afterwards. One copy serves one character's slot, and groups in one
  // zone contest its enemies, so the assignment is greedy with re-evaluation: of all pairs of free
  // tab (no experiment holds its group) and due target in a zone no tab found crowded lately, the
  // one whose best way (`bestWay`) earns most per hour of the hunting group's time goes first, then
  // every pair is valued again without the taker slots it serves and with its zone occupied, and so
  // on. A target a group already hunts claims its slots the same way.
  const targetEval = {};
  const lastHunt = (id) => history.filter((h) => h.id === id).at(-1);
  const ctx = { tabs, hoursPerLevel, killsPerHour, zoneShare };
  const hunter = (t) => free(t) && t.members.length;
  // An errand changes the AutoLevel limits an experiment's arms compare, so a held group gets none.
  const allowed = (t, w) => !(w.kind === "errand" && held.has(t.group));
  // What keeps a group from a target this pass, for the target's status.
  const holding = (t) => {
    const queued = out.find((o) => o.label === t.label);
    if (queued) return `${queued.kind} ${queued.why}`;
    if (t.errand) return `an errand for ${t.errand.item ?? t.errand.keep} in ${t.errand.zone}`;
    if (t.task?.status === "running") return `a ${t.task.kind} task${t.task.step ? ` at "${t.task.step}"` : ""}`;
    return `the ${cfg.taskGapMin} minutes after its last task`;
  };
  // The tab on a target's errand, by its enemies, or on the hunt the coordinator queued for it, by
  // the bot task the history records for the target.
  const huntedBy = (x) => tabs.find((t) => (t.errand?.zone === x.zone && new RegExp(t.errand.keep ?? "^$", "i").test(x.npc)) || (t.task?.status === "running" && history.some((h) => h.label === t.label && h.task != null && h.task === t.task.id && h.id === targetId(x))));
  const slotKey = (w) => `${w.to}:${w.slot}`;
  // A night or day spawn is hunted only then, by the game's hour on the tab.
  const inTime = (x, t) => !x.when || (x.when === "night" ? isNight(t.gameHour) : t.gameHour != null && !isNight(t.gameHour));
  const claimed = new Set(targets.filter(huntedBy).flatMap((x) => x.items.map(slotKey)));
  const open = (x) => ({ ...x, items: x.items.filter((w) => !claimed.has(slotKey(w))) });
  // The trips chosen this pass, as tabs in their zones for the shared-zone cost.
  const occupied = [];
  const taker = (x) => x.items[0].to;
  for (;;) {
    const withTrips = { ...ctx, tabs: [...tabs, ...occupied] };
    let best = null;
    for (const t of tabs.filter(hunter)) {
      for (const target of targets) {
        const id = targetId(target);
        if (targetEval[id] || crowded.has(target.zone) || huntedBy(target) || !inTime(target, t)) continue;
        const x = open(target);
        if (!x.items.length) continue;
        const w = bestWay(t, x, withTrips);
        if (w && netRate(w) > 0 && allowed(t, w) && due(lastHunt(id), targetRetryMin(w.kind)) && (!best || netRate(w) > netRate(best.w))) best = { t, x, w, id };
      }
    }
    if (!best) break;
    const { t, x, w, id } = best;
    const keep = x.npc.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const item = x.items[0].item;
    const spec = w.kind === "errand" ? { zone: x.zone, keep, item, minutes: 60 } : { zone: x.zone, keep, item, ...(w.kind === "camp" && points[id]?.length ? { points: points[id] } : {}), waitMin: 0, minutes: w.kind === "visit" ? Math.round(ACQUIRE.visitHours * 60) : ACQUIRE.campMin };
    const why = `${t.group} hunts it for ${taker(x)} (${w.kind}): ${describeWay(w, taker(x))}`;
    out.push({ label: t.label, kind: w.kind === "errand" ? "errand" : "hunt", id, spec, why });
    targetEval[id] = { group: t.group, kind: w.kind, hours: w.hours, value: w.value, cost: w.cost, status: `${w.kind} queued: ${why}` };
    for (const s of x.items) claimed.add(slotKey(s));
    occupied.push({ label: null, group: t.group, zone: x.zone });
  }
  // Why every other target waits: its hunt runs, its zone is crowded, no group can kill it, its
  // takers' slots go to other targets this pass, no way pays, or the group it pays most for is busy
  // or held and no free group takes it at a profit.
  for (const x of targets) {
    const id = targetId(x);
    if (targetEval[id]) continue;
    const on = huntedBy(x);
    const best = tabs.filter((t) => t.members.length).map((t) => ({ t, w: bestWay(t, x, ctx) })).filter((p) => p.w).reduce((a, b) => (!a || netRate(b.w) > netRate(a.w) ? b : a), null);
    const terms = best ? { group: best.t.group, kind: best.w.kind, hours: best.w.hours, value: best.w.value, cost: best.w.cost } : {};
    const says = best && `${best.t.group} for ${taker(x)} (${best.w.kind}): ${describeWay(best.w, taker(x))}`;
    let status;
    if (on) status = `hunting: ${on.group}`;
    else if (!open(x).items.length) status = "its takers' slots are served by targets other groups hunt";
    else if (crowded.has(x.zone)) status = "zone crowded by other players";
    else if (tabs.length && !inTime(x, tabs[0])) status = `waits for the ${x.when}, when it spawns`;
    else if (!best) status = `too strong for every group (level ${x.npcLevel})`;
    else if (!x.items.some((w) => hoursPerLevel[w.to] > 0)) status = `waits for a measured pace of ${taker(x)}'s group, without which a copy's worth is unknown`;
    else if (netRate(best.w) <= 0) status = `not worth it yet, best ${says}`;
    else if (!allowed(best.t, best.w)) status = `waits for an experiment to end, best ${says}`;
    else if (!hunter(best.t)) status = `waits for ${best.t.group}, which is on ${holding(best.t)}, best ${says}`;
    else if (!due(lastHunt(id), targetRetryMin(best.w.kind))) status = `waits for its retry, best ${says}`;
    else status = `its groups took better targets, best ${says}`;
    targetEval[id] = { ...terms, status };
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
    const join = tabs.filter((t) => free(t) && t.members.length && fits(t)).sort((a, b) => mean(a) - mean(b)).slice(0, Math.max(0, f.maxGroups - stay.length));
    for (const t of join) out.push({ label: t.label, kind: "errand", id: f.id, spec: { zone: f.zone, keep: f.keep, minutes: f.minutes }, why: `${f.id} for ${t.group}, mean level ${mean(t).toFixed(1)}` });
  }

  // Gear moves need no character switch and no travel, so one tab carries them all out: the free
  // tab with the lowest levels, whose hunting the minutes cost least.
  if (gear?.moves?.length) {
    const t = tabs.filter((x) => free(x) && x.members.length).sort((a, b) => mean(a) - mean(b))[0];
    if (t) out.push({ label: t.label, kind: "gear", spec: { moves: gear.moves }, why: `${gear.moves.length} gear moves for ${new Set(gear.moves.map((m) => m.to)).size} characters` });
  }

  // Lightstones go to the group with the lowest levels, where they buy the most levels and which
  // sets the account's time to level 60. That is often a farming group, whose farm the hand-in
  // interrupts: the farm itself feeds the lowest groups, so it must not keep them from the stones.
  const total = STONES.reduce((a, s) => a + (stock[s] ?? 0), 0);
  const farming = (t) => farms.some((f) => t.errand?.zone === f.zone && t.errand?.keep === f.keep);
  const candidates = tabs.filter((t) => (free(t) || (farming(t) && t.task?.status !== "running" && !recent(t.label) && !out.some((o) => o.label === t.label))) && t.members.length).sort((a, b) => mean(a) - mean(b));
  const target = candidates[0];
  if (target && total >= cfg.minStonesPerMember * target.members.length) {
    const levels = Object.fromEntries(target.members.map((m) => [m.name, m.level]));
    const members = stoneShares(target.members.map((m) => m.name), levels, stock);
    const xp = STONES.reduce((a, s) => a + (stock[s] ?? 0) * STONE_XP[s], 0);
    out.push({ label: target.label, kind: "handIn", spec: { members }, why: `${total} stones (${Math.round(xp / 1000)}k XP) to the lowest group, mean level ${mean(target).toFixed(1)}` });
  }
  return { actions: out, targets: targetEval };
}

const mean = (t) => t.members.reduce((a, m) => a + (m.level ?? 0), 0) / Math.max(1, t.members.length);

export const ZONE_DEFAULTS = {
  // Zones in a rotation: the bot hunts the first and moves along when a zone runs dry.
  keep: 3,
  // Hours of the row's median rate a zone's own measurement is weighed against, so a zone with
  // little time there ranks near the median and gets tried, and its own rate takes over with time.
  priorHours: 0.5,
  // Another group in the zone takes about half a group's share of its enemies (tools/calibrate.mjs).
  crowdWeight: 0.5,
  // A group leaves its zone for one worth this share more.
  margin: 0.2,
  // A rotation set this recently stays, so the group can arrive before the crowds shift again.
  settleMin: 10,
};

/** Zones any tab found crowded by other players in the last 45 minutes (`crowdedAt`), which hold for every group. */
export function crowdedZones(tabs, now) {
  return new Set(tabs.flatMap((t) => Object.entries(t.crowdedAt ?? {}).filter(([, at]) => now - at < 45 * 60000).map(([z]) => z)));
}

/**
 * Each group's zone rotation (docs/plans/controller.md, principle 4): the `keep` zones of the band
 * row at its leader's level (`rows`, data/band-rotations.json) with the most measured XP per hour
 * (`rates`, tools/lib/rates.mjs), best first. The bot stays in a zone of its rotation and moves
 * along it when the zone runs dry, and moves to the first zone when its own is not in the
 * rotation. A group stays in its zone, and keeps its rotation, until the best zone is worth
 * `margin` more, so measurement noise and shifting crowds do not move groups back and forth.
 * A rotation set within `settleMin` (`rotationSetAt`) stays while the group travels to it. Groups are assigned from the lowest
 * level up, because the slowest group sets the account's time to 60, and a zone is worth a
 * `crowdWeight` share less for each group that hunts there already. A zone's measured rate is
 * weighed against `priorHours` of the median rate of the row's zones with that much time, so a
 * zone with little time there ranks near the median and gets tried. Busy groups keep their rotation and
 * count for the zone they are in. Groups an experiment holds are assigned like the others, because
 * crowding the arms unevenly confounds an experiment more than a change of zone does. Returns
 * `[{ label, rotation, why }]` for the rotations whose zones change.
 */
export function assignZones({ now, tabs, rows = [], rates = {}, cfg = ZONE_DEFAULTS }) {
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
    const row = [...rows].sort((a, b) => b[0] - a[0]).find(([min]) => level >= min)?.[1] ?? [];
    if (!row.length) continue;
    const zones = row.map((z, k) => ({ z, k, e: estimate(rates, z, level, now) }));
    const solid = zones.filter((m) => m.e?.hours >= cfg.priorHours);
    const known = (solid.length ? solid : zones.filter((m) => m.e)).map((m) => m.e.xph).sort((a, b) => a - b);
    const median = known.length ? known[Math.floor(known.length / 2)] : 1;
    const xph = (e) => (e ? (e.hours * e.xph + cfg.priorHours * median) / (e.hours + cfg.priorHours) : median);
    const ranked = zones.map((m) => ({ ...m, xph: xph(m.e), value: xph(m.e) / (1 + cfg.crowdWeight * (crowd.get(m.z) ?? 0)) / (busyZones.has(m.z) ? 4 : 1) })).sort((a, b) => b.value - a.value || a.k - b.k);
    const own = ranked.find((m) => m.z === t.zone);
    const stay = own && own.value * (1 + cfg.margin) >= ranked[0].value;
    const top = ranked.filter((m) => m.z !== t.zone || stay).slice(0, cfg.keep);
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
    if (rotationInRow && rotationBest * (1 + cfg.margin) >= ranked[0].value) continue;
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
 * principle 7). An experiment is a two-period crossover as tools/crossover.mjs reads it:
 * `{ id, a: [group], b: [group], blockMin, setting, without, after }`. In the first block arm A plays
 * with `setting` and arm B with `without`, in the second block the other way round, and then every
 * group of it keeps `without` until the experiment leaves the file. `started` maps an experiment
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
    if (block >= 2) {
      set([...x.a, ...x.b], x.without);
      if (ended[x.id] == null) events.push({ id: x.id, kind: "end", start });
      continue;
    }
    for (const g of [...x.a, ...x.b]) held.add(g);
    set(x.a, block === 0 ? x.setting : x.without);
    set(x.b, block === 0 ? x.without : x.setting);
  }
  const listed = new Set(experiments.map((x) => x.id));
  for (const [id, x] of Object.entries(running)) {
    if (listed.has(id) || ended[id] != null) continue;
    set([...x.a, ...x.b], x.without);
    events.push({ id, kind: "dropped", start: started[id] });
  }
  return { settings, events, held };
}
