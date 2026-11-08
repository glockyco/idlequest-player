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
};

/** Game hours count as night from 20 to 5, as the client's spell time rules do. */
export const isNight = (hour) => hour != null && (hour >= 20 || hour < 5);

/**
 * The tasks to queue now. Inputs:
 * - `tabs`: `[{ label, group, members: [{ name, level }], task: { kind, status } | null, gameHour }]`,
 *   one per playing tab whose bot runs.
 * - `stock`: lightstones on the account, `{ "Greater Lightstone": n, Lightstone: m }`.
 * - `opportunities`: data/opportunities.json, `[{ id, group, as, zone, keep, item, when, retryMin }]`.
 * - `owned`: item names an opportunity's `as` character already holds, `{ [id]: true }`.
 * - `history`: the coordinator's earlier tasks, `[{ t, label, kind, id }]`.
 * Returns `[{ label, kind, spec, why, id? }]`, at most one per tab.
 */
export function decide({ now, tabs, stock = {}, opportunities = [], owned = {}, history = [], cfg = DEFAULTS }) {
  const out = [];
  const busy = new Set(tabs.filter((t) => t.task?.status === "running").map((t) => t.label));
  const recent = (label) => history.some((h) => h.label === label && now - h.t < cfg.taskGapMin * 60000);
  const free = (t) => !busy.has(t.label) && !recent(t.label) && !out.some((o) => o.label === t.label);

  // Epic and quest pieces first: each belongs to one group and waits for its time of day.
  for (const o of opportunities) {
    if (owned[o.id]) continue;
    const tab = tabs.find((t) => t.group === o.group);
    if (!tab || !free(tab)) continue;
    if (o.when === "night" && !isNight(tab.gameHour)) continue;
    if (o.when === "day" && (tab.gameHour == null || isNight(tab.gameHour))) continue;
    const last = history.filter((h) => h.id === o.id).at(-1);
    if (last && now - last.t < (o.retryMin ?? 30) * 60000) continue;
    out.push({ label: tab.label, kind: "hunt", id: o.id, spec: { zone: o.zone, keep: o.keep, item: o.item, ...(o.as ? { as: o.as } : {}), waitMin: 0, minutes: o.minutes ?? 20 }, why: `${o.item} for ${o.as ?? o.group}` });
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
