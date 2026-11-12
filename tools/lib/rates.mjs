// Measured XP per hour by zone and leader level, from the leaders' one-second samples
// (src/bridge.js), which the coordinator's zone assignment ranks zones by. A task or an errand
// changes what the party fights, so only hunting time counts. Time shared with other account groups
// counts as the share of the zone's rate alone that tools/predict.mjs gives for them
// (docs/plans/zone-crowding.md), so the rates are rates alone, measured over all of a zone's hours:
// the minutes a busy zone is alone come right after the others left, with every point up, and
// alone they overrated Solusek's Eye by a third. Older time weighs less, halving every
// `HALF_LIFE_H` hours, so the estimates follow the groups' gear.
import { rows } from "./content.mjs";
import { xpStep } from "./samples.mjs";

export const HALF_LIFE_H = 24;
// Samples come every second, so a longer gap is a pause in recording, not play.
const MAX_GAP_MS = 5000;
// Crowding is counted up to this many other groups, and more count as this many.
const MAX_OTHERS = 7;

// The weight at time `t` of what was recorded at `t0`.
const weight = (t0, t) => 2 ** (-(t - t0) / (HALF_LIFE_H * 3600000));

// Add `sec` seconds and `xp` recorded at `t` to cell `key` of `cells`, decaying the older side.
// `c` is the part of `sec` the group waited for a target (`crowdShare`).
const addTo = (cells, key, sec, xp, t, c = 0) => {
  const cell = cells[key] ?? { s: 0, xp: 0, t, c: 0 };
  const older = weight(cell.t, t); // the cell, when the sample is newer
  const late = weight(t, cell.t); // the sample, when the cell is newer
  cells[key] = t >= cell.t ? { s: cell.s * older + sec, xp: cell.xp * older + xp, t, c: (cell.c ?? 0) * older + c } : { s: cell.s + late * sec, xp: cell.xp + late * xp, t: cell.t, c: (cell.c ?? 0) + late * c };
};

/**
 * Add one leader's samples, oldest first, to `rates` (`{ [zone]: { [level]: { s, xp, t } } }`,
 * with `t` the time the cell's sums are weighed at) and return it. Leaders come one after another,
 * so a sample can be older than its cell, and then the sample weighs less. `zoneOf(id)` gives a
 * zone id's short name, `others(sample)` the number of other account groups in that zone then, and
 * `factor(zone, level, n)` the share of its rate alone a zone pays with `n` others, so `s` holds
 * seconds alone-equivalent. A pair of samples counts when it is one second of play by one character
 * in one zone at one level, outside tasks (`act` "task", or `busy`) and errands (`busy`). Deaths
 * count with the XP they lose. `crowding`, when given, gets the same play raw by the number of
 * other groups, `{ [zone]: { [level]: { [n]: { s, xp, t, c } } } }`, for `crowdShare`: `c` are the
 * seconds of `s` the group stood idle for want of a target (the bot's idle cause "crowded").
 * `normal(dxp, t)`
 * XP event do not lift the zones hunted in it above the others.
 */
export function accumulate(rates, samples, { zoneOf, others = () => 0, factor = () => 1, crowding = null, normal = (dxp) => dxp }) {
  for (let k = 1; k < samples.length; k++) {
    const a = samples[k - 1];
    const b = samples[k];
    const raw = xpStep(a, b);
    const dxp = raw == null ? null : normal(raw, b.t);
    if (a.ses !== b.ses || a.zone !== b.zone || a.lvl !== b.lvl || dxp == null) continue;
    if (a.busy || b.busy || a.act === "task" || b.act === "task") continue;
    const dt = b.t - a.t;
    if (!(dt > 0 && dt <= MAX_GAP_MS)) continue;
    const zone = zoneOf(a.zone);
    if (!zone) continue;
    const n = others(a);
    if (crowding) addTo(((crowding[zone] ??= {})[a.lvl] ??= {}), Math.min(n, MAX_OTHERS), dt / 1000, dxp, b.t, a.act === "idle" && a.why === "crowded" ? dt / 1000 : 0);
    const f = n ? factor(zone, a.lvl, n) : 1;
    if (!(f > 0)) continue;
    addTo((rates[zone] ??= {}), a.lvl, (dt / 1000) * f, dxp, b.t);
  }
  return rates;
}

/**
 * XP per hour in `zone` for a leader at `level`, from the levels within `span` of it, the nearer
 * weighing more, and the hours behind it after decay to `now`: `{ xph, hours }`, or null without
 * any time there.
 */
export function estimate(rates, zone, level, now, span = 2) {
  let s = 0;
  let xp = 0;
  let hours = 0;
  for (let d = -span; d <= span; d++) {
    const cell = rates[zone]?.[level + d];
    if (!cell?.s) continue;
    const fade = weight(cell.t, now);
    const w = 1 - Math.abs(d) / (span + 1);
    s += cell.s * fade * w;
    xp += cell.xp * fade * w;
    hours += (cell.s * fade) / 3600;
  }
  return s > 0 ? { xph: (xp * 3600) / s, hours } : null;
}

// A crowding measurement counts from this many seconds of play at one number of other groups.
const CROWD_MIN_SEC = 600;

/**
 * The share of its time alone a group hunts in `zone` beside `n` other account groups, as measured
 * (`crowding` of `accumulate`): the time it does not stand idle for want of a target, over the
 * same with the fewest others on record. The time is pooled over the levels within two of `level`,
 * the nearer more, after decay to `now`, and the share never rises with the number of groups: a
 * count that reads better than a smaller one is pooled with it. A count with no time of its own
 * takes the share of the nearest smaller one, which bounds it from above. Returns `{ share, hours }`
 * with the hours behind that count, or null where no count up to `n` has `CROWD_MIN_SEC` of play.
 *
 * The time is the measure, not the XP: over 100 group-hours on 2026-11-12 the Tower of Frozen
 * Shadow cost no such time with up to seven other groups, and Kedge Keep 3% with one other, 13%
 * with three and 31% with four, while its XP per hour by count at one level swung by half from
 * one cell to the next, and no cell alone existed to compare with.
 */
export function crowdShare(crowding, zone, level, n, now) {
  // Blocks of counts from `from` on, each with its seconds and the seconds hunted, merged while a
  // larger count hunts more. All counts are fitted, so the shares of two counts never cross.
  const blocks = [];
  for (let k = 0; k <= MAX_OTHERS; k++) {
    let s = 0;
    let c = 0;
    for (let d = -2; d <= 2; d++) {
      const cell = crowding?.[zone]?.[level + d]?.[k];
      if (!(cell?.s > 0)) continue;
      const w = weight(cell.t, now) * (1 - Math.abs(d) / 3);
      s += cell.s * w;
      c += (cell.c ?? 0) * w;
    }
    if (s < CROWD_MIN_SEC) continue;
    blocks.push({ from: k, s, hunted: s - c });
    while (blocks.length > 1 && blocks.at(-1).hunted / blocks.at(-1).s > blocks.at(-2).hunted / blocks.at(-2).s) {
      const b = blocks.pop();
      blocks.at(-1).s += b.s;
      blocks.at(-1).hunted += b.hunted;
    }
  }
  const at = blocks.findLast((b) => b.from <= Math.min(n, MAX_OTHERS));
  const base = blocks.length ? blocks[0].hunted / blocks[0].s : 0;
  return at && base > 0 ? { share: at.hunted / at.s / base, hours: at.s / 3600 } : null;
}

/** Zone ids to short names, from the content snapshot's zone table. */
export async function zoneNames() {
  const out = new Map();
  for await (const z of rows("zone")) if (z.version === 0 && !out.has(z.zoneidnumber)) out.set(z.zoneidnumber, z.short_name);
  return out;
}
