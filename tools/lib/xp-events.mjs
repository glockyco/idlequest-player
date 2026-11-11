// XP events: the periods in which the server multiplies kill XP, such as the double XP of
// Veteran's Day 2026 (2026-11-11 17:54 to midnight Pacific). Pure. The collector finds them in the
// kill lines it exports and keeps them in the db meta key `xpEvents`, and everything that reads an
// XP rate for what comes after an event (the zone rates, the paces of the coordinator, the hours
// to 60) counts the XP of an event at its normal worth.
//
// A kill pays its party 90 x the client's zone multiplier (`zoneExpMultiplier` of its zone list)
// x the enemy's level squared x the event's factor, split among the characters by level, each
// share rounded. So the XP lines of one kill sum to that pool, and since no factor here is the
// square of a fraction, at most one of them makes the enemy's level a whole number. Over 14 hours
// of twelve groups in 33 zones, 10,301 kills with all six lines fit factor 1 before the event and
// 2,608 fit factor 2 in it, 203 fit none, their shares a few hundredths of a percent short of a
// pool, and none fit another factor. The switch took seven seconds (17:54:19 to 17:54:26).

/** The factors a kill is tested for. None is a square, so no two fit the same pool. */
export const FACTORS = [1, 1.5, 2, 3];

const KILL = /^You have (?:defeated|slain) .+? and gained (\d+) experience/;
const SHARE = /^\S+ gains (\d+) experience\.$/;
// A kill's lines come within a moment of each other.
const KILL_SPAN_MS = 3000;

/**
 * The kills in `events` (the bridge's chat rows, oldest first): `[{ t, pool, lines }]`, `pool` the
 * sum of the kill line's XP and of the members' share lines after it, `lines` their number.
 */
export function killPools(events) {
  const out = [];
  let cur = null;
  for (const e of events) {
    if (e.type !== "EXPERIENCE_GAIN") continue;
    const kill = KILL.exec(e.text ?? "");
    if (kill) {
      cur = { t: e.t, pool: Number(kill[1]), lines: 1 };
      out.push(cur);
      continue;
    }
    const share = cur && e.t - cur.t < KILL_SPAN_MS ? SHARE.exec(e.text ?? "") : null;
    if (share) {
      cur.pool += Number(share[1]);
      cur.lines++;
    }
  }
  return out;
}

/**
 * The event factor a kill's `pool` shows in a zone with the client's multiplier `mult`, or null
 * when none or more than one of `FACTORS` gives a whole enemy level. Each of the `lines` shares is
 * rounded, so the pool may be off by half a point for each. A kill that paid fewer shares than the
 * party has characters, with one dead or away, fits none.
 */
export function killFactor({ pool, lines = 1, mult }) {
  if (!(pool > 0 && mult > 0)) return null;
  const fits = FACTORS.filter((f) => {
    const unit = 90 * mult * f;
    const level = Math.round(Math.sqrt(pool / unit));
    return level > 0 && Math.abs(pool - unit * level * level) <= lines / 2 + 1;
  });
  return fits.length === 1 ? fits[0] : null;
}

/**
 * The factor of each kill in `events`, `[{ t, factor }]`, for `foldKills`. `places` says where the
 * party was, `[[t, zone]]` oldest first, and `multOf(zone)` gives the client's multiplier there. A
 * kill before the first place has no zone and so no factor.
 */
export function killFactors(events, places, multOf) {
  let i = 0;
  return killPools(events).map((k) => {
    while (i + 1 < places.length && places[i + 1][0] <= k.t) i++;
    const zone = places.length && places[i][0] <= k.t ? places[i][1] : null;
    return { t: k.t, factor: zone == null ? null : killFactor({ ...k, mult: multOf(zone) }) };
  });
}

// Tabs are exported one after another within a cycle, so a kill from just before a change can
// arrive after the kills that showed it.
const SLACK_MS = 120000;

/**
 * Fold `kills` (`[{ t, factor }]`) into the event log `log`, `{ spans: [{ from, to, factor }],
 * pending }`, and return the new log. `spans` are the periods with a factor other than 1, `to`
 * null while one runs. The factor changes once `need` kills in a row show another one, from the
 * time of the first of them, so a misfit kill starts no event. A kill from before the last change
 * moves that change back to its own time when it shows the new factor within `SLACK_MS` of it,
 * and is left out otherwise.
 */
export function foldKills(log, kills, need = 3) {
  const spans = (log?.spans ?? []).map((s) => ({ ...s }));
  let pending = log?.pending ?? null;
  for (const k of [...kills].filter((x) => x.factor != null).sort((a, b) => a.t - b.t)) {
    const last = spans.at(-1);
    const open = last && last.to == null ? last : null;
    const changedAt = open ? open.from : (last?.to ?? 0);
    if (k.t < changedAt) {
      const earliest = open ? (spans.at(-2)?.to ?? 0) : last.from;
      if (k.factor === (open?.factor ?? 1) && changedAt - k.t <= SLACK_MS && k.t >= earliest) last[open ? "from" : "to"] = k.t;
      continue;
    }
    if (k.factor === (open?.factor ?? 1)) {
      pending = null;
      continue;
    }
    pending = pending?.factor === k.factor ? { ...pending, n: pending.n + 1, since: Math.min(pending.since, k.t) } : { factor: k.factor, n: 1, since: k.t };
    if (pending.n < need) continue;
    if (open) open.to = pending.since;
    if (k.factor !== 1) spans.push({ from: pending.since, to: null, factor: k.factor });
    pending = null;
  }
  return { spans, pending };
}

/** The event factor at time `t`: 1 outside every span. */
export function factorAt(log, t) {
  for (const s of log?.spans ?? []) if (t >= s.from && (s.to == null || t < s.to)) return s.factor;
  return 1;
}

/** The XP gain `dxp` recorded at `t` at its normal worth. A loss, at a death, is no kill XP and stays. */
export const normalXp = (log, dxp, t) => (dxp > 0 ? dxp / factorAt(log, t) : dxp);
