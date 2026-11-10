// The prior of the kill chance (docs/plans/gear-acquisition.md, "Kill chance"): a logistic model of a
// group's chance to win one fight, from the enemy's level above the group's leader and the log of its
// hit points, fitted to every simulated and live fight on record. Every pair of group and enemy
// starts from it, and the pair's own fights move the chance from there (`killChanceOf` in
// tools/lib/acquire.mjs), so a doable target is hunted before anyone simulated it.

const features = (gap, hp) => [1, gap, Math.log10(Math.max(1, hp))];

/**
 * Fit the model to `obs`, `[{ gap, hp, kills, fights, deaths, leaderDeaths }]` (deaths per fight),
 * by Newton's method on the binomial log likelihood, with a unit Gaussian prior on the slopes,
 * which keeps them finite when wins and losses separate perfectly. Also the mean deaths and leader
 * deaths per won and per lost fight, which price a pair without fights of its own, and the mean
 * hit points (`hp`, from the mean of their logs), which stand in for an enemy whose hit points are
 * not known. Null with fewer than `minFights` fights, or without both wins and losses, which leave
 * the slopes free.
 */
export function fitPrior(obs, { minFights = 20, ridge = 1, steps = 50 } = {}) {
  const rows = obs.filter((o) => o.fights > 0 && Number.isFinite(o.gap) && o.hp > 0);
  const fights = rows.reduce((s, o) => s + o.fights, 0);
  const wins = rows.reduce((s, o) => s + o.kills, 0);
  if (fights < minFights || wins === 0 || wins === fights) return null;
  const X = rows.map((o) => features(o.gap, o.hp));
  let w = [0, 0, 0];
  for (let k = 0; k < steps; k++) {
    // Gradient and Hessian of the log likelihood with the prior, intercept left free.
    const g = w.map((v, j) => (j ? -ridge * v : 0));
    const H = [0, 1, 2].map((a) => [0, 1, 2].map((b) => (a === b && a ? ridge : 0)));
    for (const [i, x] of X.entries()) {
      const p = 1 / (1 + Math.exp(-(w[0] * x[0] + w[1] * x[1] + w[2] * x[2])));
      const v = rows[i].fights * p * (1 - p);
      for (let a = 0; a < 3; a++) {
        g[a] += (rows[i].kills - rows[i].fights * p) * x[a];
        for (let b = 0; b < 3; b++) H[a][b] += v * x[a] * x[b];
      }
    }
    const step = solve(H, g);
    w = w.map((v, j) => v + step[j]);
    if (Math.max(...step.map(Math.abs)) < 1e-9) break;
  }
  const avg = (pick, won) => {
    const sel = rows.map((o) => ({ n: won ? o.kills : o.fights - o.kills, v: pick(o) ?? 0 })).filter((x) => x.n > 0);
    const n = sel.reduce((s, x) => s + x.n, 0);
    return n ? sel.reduce((s, x) => s + x.n * x.v, 0) / n : 0;
  };
  const hp = 10 ** (rows.reduce((s, o) => s + o.fights * Math.log10(o.hp), 0) / fights);
  return { w, hp, fights, wins, deathsWon: avg((o) => o.deaths, true), deathsLost: avg((o) => o.deaths, false), leaderWon: avg((o) => o.leaderDeaths, true), leaderLost: avg((o) => o.leaderDeaths, false) };
}

// The solution s of the square system A s = b, by Gaussian elimination with partial pivoting.
function solve(A, b) {
  const n = b.length;
  const m = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let pivot = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r][c]) > Math.abs(m[pivot][c])) pivot = r;
    [m[c], m[pivot]] = [m[pivot], m[c]];
    for (let r = c + 1; r < n; r++) {
      const f = m[r][c] / m[c][c];
      for (let k = c; k <= n; k++) m[r][k] -= f * m[c][k];
    }
  }
  const s = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let sum = m[r][n];
    for (let k = r + 1; k < n; k++) sum -= m[r][k] * s[k];
    s[r] = sum / m[r][r];
  }
  return s;
}

/**
 * The prior's chance and deaths per fight for an enemy `gap` levels above the leader with `hp` hit
 * points, the fit's mean when unknown: `{ p, deaths, leaderDeaths }`.
 */
export function priorOf(prior, gap, hp) {
  const x = features(gap, hp > 0 ? hp : prior.hp);
  const p = 1 / (1 + Math.exp(-(prior.w[0] * x[0] + prior.w[1] * x[1] + prior.w[2] * x[2])));
  return { p, deaths: p * prior.deathsWon + (1 - p) * prior.deathsLost, leaderDeaths: p * prior.leaderWon + (1 - p) * prior.leaderLost };
}
