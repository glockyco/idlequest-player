// The gear acquisition model (docs/plans/gear-acquisition.md): what a copy of an item is worth in
// hours of its group's progress, and what each way of getting it costs. Pure, so the gear plan ranks
// enemies and the coordinator chooses hunts with the same numbers.

// XP per hour against party damage, the calibrated model's elasticity by level (leveling plan, lever 7).
const ELASTICITY = [[20, 0.5], [29, 0.74], [35, 0.82], [45, 0.85]];
export const elasticity = (level) => {
  if (level <= ELASTICITY[0][0]) return ELASTICITY[0][1];
  for (let k = 1; k < ELASTICITY.length; k++) {
    const [l1, e1] = ELASTICITY[k];
    const [l0, e0] = ELASTICITY[k - 1];
    if (level <= l1) return e0 + ((e1 - e0) * (level - l0)) / (l1 - l0);
  }
  return ELASTICITY.at(-1)[1];
};

export const ACQUIRE = {
  // An upgrade is worn for this many levels of its wearer's pace, until the gear plan tracks what
  // replaces it.
  wearLevels: 10,
  // The share of its time a group idled on an errand in a zone another group played (group 4, once).
  sharedCost: 0.4,
  // A visit travels, reads the zone's spawn list, kills the enemy if it is up and leaves, about six
  // minutes without XP, until visits are measured.
  visitHours: 0.1,
  // A camp runs this long, and the next pass sends the group again while the enemy still pays.
  campMin: 30,
  // The most levels an enemy may stand above the group's leader.
  killMargin: 3,
};

/**
 * V: the hours of its group's progress one copy of a wanted item adds while it is worn, from the
 * taker's output gain (`w.gain`, tenths of a percent), its share of the party's damage (one of six),
 * the XP elasticity at its level, and the hours it is worn, `wearLevels` at the taker's pace
 * (`hoursPerLevel[w.to]`, which the coordinator measures from the group's XP per hour).
 */
export const copyValue = (w, hoursPerLevel = {}) => (w.gain / 1000) * (1 / 6) * elasticity(w.level ?? 0) * ACQUIRE.wearLevels * (hoursPerLevel[w.to] ?? 0);

/**
 * The ways tab `t` can hunt gear target `x` (an enemy of the gear plan's `targets`), each
 * `{ kind, hours, value, cost }` for one copy or one visit, in hours of the group's progress:
 * - errand: inside the group's rotation, `hours` the expected hunting until the first wanted copy,
 *   free, or `sharedCost` of those hours in a zone another tab plays;
 * - camp: outside it, the same hours, less the share of the group's XP the trip zone pays
 *   (`zoneShare(t, zone)`);
 * - visit: outside it, `visitHours`, worth the chance the enemy is up on one of its points on
 *   arrival, 1 - (1 - spawn)^points, times each item's drop chance and copy value.
 * The items' drops roll on their own, so a copy of any of them comes every `1 / sum(1 / hours)`
 * hours, and its value is the items' value per hour of hunting times that.
 */
export function ways(t, x, { tabs = [], hoursPerLevel = {}, zoneShare = () => 0 } = {}) {
  const perHour = x.items.reduce((s, w) => s + copyValue(w, hoursPerLevel) / w.hours, 0);
  const hours = 1 / x.items.reduce((s, w) => s + 1 / w.hours, 0);
  if ((t.rotation ?? []).includes(x.zone)) {
    const shared = tabs.some((o) => o !== t && o.zone === x.zone);
    return [{ kind: "errand", hours, value: perHour * hours, cost: shared ? ACQUIRE.sharedCost * hours : 0 }];
  }
  const up = 1 - (1 - (x.spawn ?? 1)) ** Math.max(1, x.points ?? 1);
  return [
    { kind: "camp", hours, value: perHour * hours, cost: Math.max(0, 1 - Math.min(1, zoneShare(t, x.zone) ?? 0)) * hours },
    { kind: "visit", hours: ACQUIRE.visitHours, value: up * x.items.reduce((s, w) => s + (w.drop ?? 1) * copyValue(w, hoursPerLevel), 0), cost: ACQUIRE.visitHours, up },
  ];
}

/** What a way earns per hour of the group's time: its value less its cost, over its hours. */
export const netRate = (w) => (w.value - w.cost) / w.hours;

/** The way of `ways` that earns most per hour, or null when the enemy is too strong for the tab. */
export function bestWay(t, x, ctx) {
  if (x.npcLevel != null && x.npcLevel > (t.members[0]?.level ?? 0) + ACQUIRE.killMargin) return null;
  return ways(t, x, ctx).reduce((a, b) => (netRate(b) > netRate(a) ? b : a));
}

/** A gear target's id in the coordinator's history and the dashboard, `target-<zone>-<npc>`. */
export const targetId = (t) => `target-${t.zone}-${t.npc.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;

/** Minutes before a target's next hunt: an errand ran an hour inside normal hunting, a camp or a visit (history kind "hunt") was a trip. */
export const targetRetryMin = (kind) => (kind === "errand" ? 120 : 60);

const span = (h) => (h >= 1 ? `${h.toFixed(1)} h` : h * 60 >= 1 ? `${Math.round(h * 60)} min` : "under a minute");

/**
 * A way in words, with the value in the progress of the taker's group and the cost in the hunting
 * group's: "a copy takes 1.2 h of hunting, adds 9 min to Linysir's group and costs nothing".
 */
export function describeWay(w, taker) {
  const cost = w.cost > 0 ? `costs ${span(w.cost)} of the hunters' progress` : "costs nothing";
  if (w.kind === "visit") return `a ${span(w.hours)} visit finds it up ${Math.round(100 * w.up)}% of the time, adds ${span(w.value)} to ${taker}'s group and ${cost}`;
  return `a copy takes ${span(w.hours)} of ${w.kind === "errand" ? "hunting" : "camping"}, adds ${span(w.value)} to ${taker}'s group and ${cost}`;
}
