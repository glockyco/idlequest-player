// The coordinator's policy (docs/plans/controller.md, step 5): what each tab should do next that
// several tabs share, decided in one place. It is pure: `decide` gets the world as plain data and
// returns the tasks to queue, and tools/iqd.mjs gathers the inputs and queues the tasks in the
// pages through the bot's own task API. It never plays a step itself.
import { stoneShares } from "../../src/group.mjs";

export const STONES = ["Greater Lightstone", "Lightstone"];
/** XP Smith Tv`ysa pays for each stone (docs/guide.md). */
export const STONE_XP = { "Greater Lightstone": 274400, Lightstone: 137200 };

export const DEFAULTS = {
  // A hand-in costs each member about a minute of the group's hunting, so a batch waits until it
  // pays every member at least one Greater Lightstone's worth (two stones a member on average).
  minStonesPerMember: 2,
  // A tab gets at most one coordinator task in this window, so a failing task cannot loop.
  taskGapMin: 20,
  // Hunts and camps take a tab away from its own hunting, so they get at most this share of a tab's
  // last hour until the value model weighs a piece against the XP it costs.
  huntShare: 0.15,
};

/** Game hours count as night from 20 to 5, as the client's spell time rules do. */
export const isNight = (hour) => hour != null && (hour >= 20 || hour < 5);

/**
 * The tasks to queue now. Inputs:
 * - `tabs`: `[{ label, group, members: [{ name, level, class }], task: { kind, status } | null, errand, zone, gameHour }]`,
 *   one per playing tab whose bot runs.
 * - `stock`: lightstones on the account, `{ "Greater Lightstone": n, Lightstone: m }`.
 * - `opportunities`: data/opportunities.json, `[{ id, group | levels, kind, zone, keep, item, count, camp, when, retryMin, points }]`,
 *   where `kind` "errand" hunts the enemies inside normal hunting and the default is a directed hunt,
 *   which camps the enemies' spawn points unless `camp` is false (gray enemies, which a camp skips).
 * - `owned`: opportunities whose item the account holds in `count` copies, `{ [id]: true }`.
 * - `farms`: data/farms.json, `[{ id, zone, keep, levels: [min, max], maxGroups, minutes }]`, errands
 *   that run for loot rather than one item, such as lightstones from Nektulos wisps.
 * - `quests`: data/quests.json, `{ [id]: { class, minLevel, reward, steps, retryMin } }`, and `holders`,
 *   the account characters that carry each quest's reward, `{ [id]: [name] }`.
 * - `history`: the coordinator's earlier tasks, `[{ t, label, kind, id }]`.
 * Returns `[{ label, kind, spec, why, id? }]`, at most one per tab. Kind `stopErrand` ends a tab's errand.
 */
export function decide({ now, tabs, stock = {}, opportunities = [], owned = {}, farms = [], quests = {}, holders = {}, history = [], cfg = DEFAULTS }) {
  const out = [];
  const busy = new Set(tabs.filter((t) => t.task?.status === "running" || t.errand).map((t) => t.label));
  // A task that reported when to come back (`nextAt`, a hunt's respawn) brings its own schedule;
  // any other task holds its tab for `taskGapMin`, so a failing task cannot loop.
  const recent = (label) => history.some((h) => h.label === label && !h.nextAt && now - h.t < cfg.taskGapMin * 60000);
  const free = (t) => !busy.has(t.label) && !recent(t.label) && !out.some((o) => o.label === t.label);

  // Minutes of the last hour each tab spent on the coordinator's hunts, by their recorded length
  // (a task still running counts five minutes).
  const huntMs = (label) => history.filter((h) => h.label === label && h.kind === "hunt" && now - h.t < 3600000).reduce((a, h) => a + (h.ms ?? 300000), 0);

  // Epic and quest pieces first. An opportunity names its group, or `levels` for any free group
  // whose mean level lies inside, preferring one already in the zone, because NO DROP pieces move
  // between account characters. It waits for its time of day.
  for (const o of opportunities) {
    if (owned[o.id]) continue;
    // Pieces from the same enemies (the four Mastery pages) need one group on them, not four.
    if (o.kind === "errand" && (tabs.some((t) => t.errand?.zone === o.zone && t.errand?.keep === o.keep) || out.some((a) => a.spec?.zone === o.zone && a.spec?.keep === o.keep))) continue;
    const tab = o.levels
      ? tabs.filter((t) => free(t) && t.members.length && mean(t) >= o.levels[0] && mean(t) <= o.levels[1]).sort((a, b) => (b.zone === o.zone) - (a.zone === o.zone) || mean(a) - mean(b))[0]
      : tabs.find((t) => t.group === o.group);
    if (!tab || !free(tab)) continue;
    if (o.when === "night" && !isNight(tab.gameHour)) continue;
    if (o.when === "day" && (tab.gameHour == null || isNight(tab.gameHour))) continue;
    const last = history.filter((h) => h.id === o.id).at(-1);
    // Come back when the last hunt said its points respawn, or after `retryMin` without that.
    if (last && now < (last.nextAt ?? last.t + (o.retryMin ?? 30) * 60000)) continue;
    if (o.kind !== "errand" && huntMs(tab.label) >= cfg.huntShare * 3600000) continue;
    // An errand puts the enemies first inside the group's normal hunting, for pieces from enemies in
    // its level range. A hunt fights them directed or camps their points, for gray ones or rare spawns.
    const spec = o.kind === "errand" ? { zone: o.zone, keep: o.keep, item: o.item, minutes: o.minutes ?? 60 } : { zone: o.zone, keep: o.keep, item: o.item, ...(o.points?.length ? { points: o.points } : {}), waitMin: 0, minutes: o.minutes ?? 20 };
    out.push({ label: tab.label, kind: o.kind === "errand" ? "errand" : "hunt", id: o.id, spec, why: `${o.item} for ${tab.group}` });
  }

  // Quest chains (data/quests.json) run for every member of their class who has the level and lacks
  // the reward, one quest task per tab for all such members of it, and come back after `retryMin`
  // when one failed.
  for (const [id, q] of Object.entries(quests)) {
    for (const t of tabs) {
      if (!free(t)) continue;
      const who = t.members.filter((m) => m.class === q.class && (m.level ?? 0) >= (q.minLevel ?? 1) && !(holders[id] ?? []).includes(m.name)).map((m) => m.name);
      if (!who.length) continue;
      const last = history.filter((h) => h.id === id && h.label === t.label).at(-1);
      if (last && now < last.t + (q.retryMin ?? 120) * 60000) continue;
      out.push({ label: t.label, kind: "quest", id, spec: { members: who, steps: q.steps, name: id }, why: `${id} for ${who.join(", ")}` });
    }
  }

  // A farm goes to the groups with the lowest mean level inside its `levels`, whose own hunting
  // earns least next to the farm's fixed yield. At most `maxGroups` share it, because groups in one
  // zone wait for the enemies the others hold: three wisp groups in Nektulos lost 11 to 20% of their
  // time that way. A farming group that left the levels or is beyond the cap stops.
  for (const f of farms) {
    const fits = (t) => mean(t) >= f.levels[0] && mean(t) <= f.levels[1];
    const on = tabs.filter((t) => t.errand?.zone === f.zone && t.errand?.keep === f.keep).sort((a, b) => mean(a) - mean(b));
    const stay = on.filter(fits).slice(0, f.maxGroups);
    for (const t of on) if (!stay.includes(t)) out.push({ label: t.label, kind: "stopErrand", id: f.id, spec: null, why: `${f.id}: ${fits(t) ? `more than ${f.maxGroups} groups` : `mean level ${mean(t).toFixed(1)} is outside ${f.levels.join(" to ")}`}` });
    const join = tabs.filter((t) => free(t) && t.members.length && fits(t)).sort((a, b) => mean(a) - mean(b)).slice(0, Math.max(0, f.maxGroups - stay.length));
    for (const t of join) out.push({ label: t.label, kind: "errand", id: f.id, spec: { zone: f.zone, keep: f.keep, minutes: f.minutes }, why: `${f.id} for ${t.group}, mean level ${mean(t).toFixed(1)}` });
  }

  // Lightstones go to the group with the lowest levels, where they buy the most levels and which
  // sets the account's time to level 60.
  const total = STONES.reduce((a, s) => a + (stock[s] ?? 0), 0);
  const candidates = tabs.filter((t) => free(t) && t.members.length).sort((a, b) => mean(a) - mean(b));
  const target = candidates[0];
  if (target && total >= cfg.minStonesPerMember * target.members.length) {
    const levels = Object.fromEntries(target.members.map((m) => [m.name, m.level]));
    const members = stoneShares(target.members.map((m) => m.name), levels, stock);
    const xp = STONES.reduce((a, s) => a + (stock[s] ?? 0) * STONE_XP[s], 0);
    out.push({ label: target.label, kind: "handIn", spec: { members }, why: `${total} stones (${Math.round(xp / 1000)}k XP) to the lowest group, mean level ${mean(target).toFixed(1)}` });
  }
  return out;
}

const mean = (t) => t.members.reduce((a, m) => a + (m.level ?? 0), 0) / Math.max(1, t.members.length);
