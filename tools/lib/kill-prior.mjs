// The prior of the kill chance (docs/plans/gear-acquisition.md, "Kill chance"): a logistic model of a
// group's chance to win one fight, models of the deaths and the leader's deaths one fight costs, and
// of the seconds a won fight takes, from the enemy's level above the group's leader and the log of
// its hit points, fitted to every simulated fight on record. Every pair of group and enemy starts
// from it, and the pair's own fights move the chance from there (`killChanceOf` in
// tools/lib/acquire.mjs), so a doable target is hunted before anyone simulated it, at the pace its
// fights allow.

const features = (gap, hp) => [1, gap, Math.log10(Math.max(1, hp))];
const at = (c, x) => c[0] * x[0] + c[1] * x[1] + c[2] * x[2];
const logistic = (z) => 1 / (1 + Math.exp(-z));

/**
 * The coefficients of a model on the three features, by Newton's method on its log likelihood with a
 * unit Gaussian prior on the slopes: with `link` "logit" the share of each row's `trials` that are
 * `events`, and with "log" the events per trial as a count rate. Without any event the rate is a
 * negligible constant, since the free intercept would run off.
 */
function fitRate(rows, events, trials, link, { ridge, steps }) {
  const total = rows.reduce((s, o) => s + events(o), 0);
  if (!(total > 0)) return [-20, 0, 0];
  const X = rows.map((o) => features(o.gap, o.hp));
  // A count rate starts at the mean rate, which keeps the first steps from overshooting.
  let w = [link === "log" ? Math.log(total / rows.reduce((s, o) => s + trials(o), 0)) : 0, 0, 0];
  for (let k = 0; k < steps; k++) {
    // Gradient and Hessian of the log likelihood with the prior, intercept left free.
    const g = w.map((v, j) => (j ? -ridge * v : 0));
    const H = [0, 1, 2].map((a) => [0, 1, 2].map((b) => (a === b && a ? ridge : 0)));
    for (const [i, x] of X.entries()) {
      const n = trials(rows[i]);
      const mu = link === "logit" ? logistic(at(w, x)) : Math.exp(at(w, x));
      const v = link === "logit" ? n * mu * (1 - mu) : n * mu;
      for (let a = 0; a < 3; a++) {
        g[a] += (events(rows[i]) - n * mu) * x[a];
        for (let b = 0; b < 3; b++) H[a][b] += v * x[a] * x[b];
      }
    }
    const step = solve(H, g);
    w = w.map((v, j) => v + step[j]);
    if (Math.max(...step.map(Math.abs)) < 1e-9) break;
  }
  return w;
}

// The coefficients of a least-squares fit of `y` on the three features, each row weighed by
// `weight`, with the same unit Gaussian prior on the slopes.
function fitLine(rows, y, weight, { ridge }) {
  const A = [0, 1, 2].map((a) => [0, 1, 2].map((b) => (a === b && a ? ridge : 0)));
  const b = [0, 0, 0];
  for (const o of rows) {
    const x = features(o.gap, o.hp);
    for (let i = 0; i < 3; i++) {
      b[i] += weight(o) * x[i] * y(o);
      for (let j = 0; j < 3; j++) A[i][j] += weight(o) * x[i] * x[j];
    }
  }
  return solve(A, b);
}

/**
 * Fit the model to `obs`, `[{ gap, hp, kills, fights, deaths, leaderDeaths, sec }]` (deaths per
 * fight, `sec` the mean seconds of a won fight): the chance to win (`w`, logistic), the deaths a
 * fight costs (`v`, a count rate), the leader's death in a fight (`u`, logistic) and the log of a
 * won fight's seconds (`s`, by least squares weighed by the wins, null with fewer than `minFights`
 * of them), each on the same features, so an easy enemy costs few deaths even where the hard fights
 * on record cost many. Also the mean hit points (`hp`, from the mean of their logs), which stand in
 * for an enemy whose hit points are not known. Null with fewer than `minFights` fights, or without
 * both wins and losses, which leave the slopes free.
 */
export function fitPrior(obs, { minFights = 20, ridge = 1, steps = 50 } = {}) {
  const rows = obs.filter((o) => o.fights > 0 && Number.isFinite(o.gap) && o.hp > 0);
  const fights = rows.reduce((s, o) => s + o.fights, 0);
  const wins = rows.reduce((s, o) => s + o.kills, 0);
  if (fights < minFights || wins === 0 || wins === fights) return null;
  const opts = { ridge, steps };
  const w = fitRate(rows, (o) => o.kills, (o) => o.fights, "logit", opts);
  const v = fitRate(rows, (o) => (o.deaths ?? 0) * o.fights, (o) => o.fights, "log", opts);
  const u = fitRate(rows, (o) => Math.min(1, o.leaderDeaths ?? 0) * o.fights, (o) => o.fights, "logit", opts);
  const timed = rows.filter((o) => o.kills > 0 && o.sec > 0);
  const s = timed.reduce((n, o) => n + o.kills, 0) >= minFights ? fitLine(timed, (o) => Math.log(o.sec), (o) => o.kills, opts) : null;
  const hp = 10 ** (rows.reduce((s, o) => s + o.fights * Math.log10(o.hp), 0) / fights);
  return { w, v, u, s, hp, fights, wins };
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
 * The prior's chance, deaths per fight and seconds per won fight for an enemy `gap` levels above the
 * leader with `hp` hit points, the fit's mean when unknown: `{ p, deaths, leaderDeaths, sec }`, with
 * `sec` null for a fit without fight times.
 */
export function priorOf(prior, gap, hp) {
  const x = features(gap, hp > 0 ? hp : prior.hp);
  return { p: logistic(at(prior.w, x)), deaths: Math.exp(at(prior.v, x)), leaderDeaths: logistic(at(prior.u, x)), sec: prior.s ? Math.exp(at(prior.s, x)) : null };
}
