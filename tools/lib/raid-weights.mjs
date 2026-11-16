// The pure parts of tools/raid-weights.mjs: the roles, the probes, a fight's score and a weight.

/** Class ids (the client's, 1 Warrior to 15 Beastlord) by raid role. */
export const ROLES = { tank: [1, 3, 5], melee: [4, 7, 8, 9, 15], priest: [2, 6, 10], caster: [11, 12, 13, 14] };

/** A class id's raid role. */
export const roleOf = (cls) => Object.keys(ROLES).find((r) => ROLES[r].includes(Number(cls))) ?? null;

// The probes, item fields and their amounts. Each is large enough to move a fight's outcome, and a
// weight divides by the amount, so it assumes the change is about linear up to it.
export const PROBES = {
  hp: { hp: 1000 },
  ac: { ac: 100 },
  resists: { fr: 50, cr: 50, mr: 50, pr: 50, dr: 50 },
  mana: { mana: 1000 },
  attack: { attack: 100 },
};

/** A copy of content row `row` under `id` with the probe's amounts added to its fields. */
export function probeRow(row, id, probe) {
  const copy = { ...row, id };
  for (const [k, v] of Object.entries(probe)) copy[k] = (copy[k] ?? 0) + v;
  return copy;
}

/** A fight's score: the share of the boss's hit points the raid took, and for a kill the share of `maxSec` it left. */
export const fightScore = (f, maxSec) => (f.bossMaxHp > 0 ? (f.bossMaxHp - f.bossHpLeft) / f.bossMaxHp : 0) + (f.outcome === "kill" ? Math.max(0, maxSec - f.seconds) / maxSec : 0);

/**
 * The weight of a probe from the scores of the baseline's fights and the probe's fights of the same
 * seeds, in order: the mean paired change per point of the probe (the sum of its amounts) and per
 * probed member, and its standard error.
 */
export function weightOf(base, probed, probe, members) {
  const d = probed.map((s, i) => s - base[i]);
  const n = d.length;
  const mean = d.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(d.reduce((a, x) => a + (x - mean) ** 2, 0) / Math.max(1, n - 1));
  const scale = Object.values(probe).reduce((a, b) => a + b, 0) * Math.max(1, members);
  return { change: mean, perPoint: mean / scale, se: sd / Math.sqrt(n) / scale };
}
