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
const addTo = (cells, key, sec, xp, t) => {
  const cell = cells[key] ?? { s: 0, xp: 0, t };
  const older = weight(cell.t, t); // the cell, when the sample is newer
  const late = weight(t, cell.t); // the sample, when the cell is newer
  cells[key] = t >= cell.t ? { s: cell.s * older + sec, xp: cell.xp * older + xp, t } : { s: cell.s + late * sec, xp: cell.xp + late * xp, t: cell.t };
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
 * other groups, `{ [zone]: { [level]: { [n]: { s, xp, t } } } }`, for `crowdShare`.
 */
export function accumulate(rates, samples, { zoneOf, others = () => 0, factor = () => 1, crowding = null }) {
  for (let k = 1; k < samples.length; k++) {
    const a = samples[k - 1];
    const b = samples[k];
    const dxp = xpStep(a, b);
    if (a.ses !== b.ses || a.zone !== b.zone || a.lvl !== b.lvl || dxp == null) continue;
    if (a.busy || b.busy || a.act === "task" || b.act === "task") continue;
    const dt = b.t - a.t;
    if (!(dt > 0 && dt <= MAX_GAP_MS)) continue;
    const zone = zoneOf(a.zone);
    if (!zone) continue;
    const n = others(a);
    if (crowding) addTo(((crowding[zone] ??= {})[a.lvl] ??= {}), Math.min(n, MAX_OTHERS), dt / 1000, dxp, b.t);
    const f = n ? factor(zone, a.lvl, n) : 1;
    if (!(f > 0)) continue;
    addTo((rates[zone] ??= {}), a.lvl, (dt / 1000) * f, dxp, b.t);
  }
  return rates;
}

/**
 * XP per hour in `zone` for a leader at `level`, from the levels within two of it, the nearer
 * weighing more, and the hours behind it after decay to `now`: `{ xph, hours }`, or null without
 * any time there.
 */
export function estimate(rates, zone, level, now) {
  let s = 0;
  let xp = 0;
  let hours = 0;
  for (let d = -2; d <= 2; d++) {
    const cell = rates[zone]?.[level + d];
    if (!cell?.s) continue;
    const fade = weight(cell.t, now);
    const w = 1 - Math.abs(d) / 3;
    s += cell.s * fade * w;
    xp += cell.xp * fade * w;
    hours += (cell.s * fade) / 3600;
  }
  return s > 0 ? { xph: (xp * 3600) / s, hours } : null;
}

/**
 * The share of its rate alone zone `zone` pays a group at `level` beside `n` other account groups,
 * as measured (`crowding` of `accumulate`): at each level within two of `level`, the rate beside
 * `n` others over the rate alone, weighed by the hours of the scarcer of the two after decay to
 * `now`, the nearer levels more. Within a level, the groups' levels, which XP per hour grows with,
 * stay out of the share. Returns `{ share, hours }`, or null without both at one level.
 */
export function crowdShare(crowding, zone, level, n, now) {
  let sum = 0;
  let hours = 0;
  for (let d = -2; d <= 2; d++) {
    const cells = crowding?.[zone]?.[level + d];
    const alone = cells?.[0];
    const shared = cells?.[Math.min(n, MAX_OTHERS)];
    if (!(alone?.s > 0 && alone.xp > 0 && shared?.s > 0)) continue;
    const h = (Math.min(alone.s * weight(alone.t, now), shared.s * weight(shared.t, now)) / 3600) * (1 - Math.abs(d) / 3);
    sum += h * (shared.xp / shared.s / (alone.xp / alone.s));
    hours += h;
  }
  return hours > 0 ? { share: sum / hours, hours } : null;
}

/** Zone ids to short names, from the content snapshot's zone table. */
export async function zoneNames() {
  const out = new Map();
  for await (const z of rows("zone")) if (z.version === 0 && !out.has(z.zoneidnumber)) out.set(z.zoneidnumber, z.short_name);
  return out;
}
