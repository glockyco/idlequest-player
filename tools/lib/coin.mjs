// The account's coin: what comes in and goes out, by kind and day, from the lines each tab's
// recorder exports, and the account's total as the boss pass reads it (docs/plans/coin.md).

/**
 * Coin kept for raids, three hours of raid time. Raids come first: gear purchases, crafted gear,
 * AA ranks and quest raids spend only what the account holds above it.
 */
export const RAID_RESERVE_PP = 30000;

export const COIN_SCHEMA = `
CREATE TABLE IF NOT EXISTS coin_ledger (
  day TEXT NOT NULL, grp TEXT NOT NULL, kind TEXT NOT NULL, pp REAL NOT NULL DEFAULT 0, n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, grp, kind)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS coin (t INTEGER PRIMARY KEY, pp INTEGER NOT NULL);`;

const UNIT = { platinum: 1, gold: 0.1, silver: 0.01, copper: 0.001, pp: 1, gp: 0.1, sp: 0.01, cp: 0.001 };
const sum = (text, re) => [...text.matchAll(re)].reduce((a, m) => a + Number(m[1]) * UNIT[m[2]], 0);

// Income first, then the spends. Each rule reads one line a tab exports once: the game's own
// line where it has one, else the bot's line for the action. AA ranks leave no line in a tab: the
// collector trains them and records them itself (kind "AA ranks").
const RULES = [
  { kind: "loot", type: "LOOT", re: /^You loot ((?:\d+ (?:platinum|gold|silver|copper)(?:, )?)+)[!.]$/, pp: (m) => sum(m[1], /(\d+) (platinum|gold|silver|copper)/g) },
  { kind: "sales", type: "bot", re: /^\[bot\] sold \d+ surplus item\(s\) for (\d+) copper/, pp: (m) => Number(m[1]) / 1000 },
  { kind: "sales", type: "bot", re: /^\[bot\] craft: sold \d+ .+? for (\d+) pp$/, pp: (m) => Number(m[1]) },
  { kind: "courier", type: "SYSTEM", re: /^You are charged (\d+)pp for courier-based banking fees/, pp: (m) => -Number(m[1]) },
  { kind: "raid time", type: "SYSTEM", re: /^Raid time purchased: one hour for ([\d,]+) platinum/, pp: (m) => -Number(m[1].replace(/,/g, "")) },
  { kind: "casino", type: "bot", re: /^\[bot\] note task: casino .*? in \d+ rolls for (\d+)pp/, pp: (m) => -Number(m[1]) },
  { kind: "spells", type: "bot", re: /^\[bot\] upkeep: .*Bought and scribed/, pp: (m) => -sum(m.input, /(\d+)(pp|gp|sp|cp)\b/g) },
  { kind: "purchases", type: "SYSTEM", re: /^You purchased .* for ((?:\d+(?:pp|gp|sp|cp) ?)+)\.$/, pp: (m) => -sum(m[1], /(\d+)(pp|gp|sp|cp)/g) },
  { kind: "hand-ins", type: "bot", re: /^\[bot\] quest: \S+ gave (\d+) platinum to /, pp: (m) => -Number(m[1]) },
  { kind: "resurrection", type: "SYSTEM", re: /^Resurrected: .*?(\d+(?:\.\d+)?)pp charged/, pp: (m) => -Number(m[1]) },
  { kind: "crafts", type: "bot", re: /^\[bot\] craft: .*? after \d+ attempts for about (\d+) pp/, pp: (m) => -Number(m[1]) },
];

/** The coin lines among a tab's exported `events` (`{ t, type, text }`): `[{ t, kind, pp }]`, `pp` in platinum, negative for a spend. */
export function coinEntries(events) {
  const out = [];
  for (const e of events) {
    const text = e.text ?? e.msg;
    if (typeof text !== "string") continue;
    for (const r of RULES) {
      if (r.type !== e.type) continue;
      const m = r.re.exec(text);
      if (!m) continue;
      const pp = r.pp(m);
      if (pp) out.push({ t: e.t, kind: r.kind, pp });
      break;
    }
  }
  return out;
}

const dayOf = (t) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** Add `entries` (`coinEntries`) of group `grp` to the ledger, by local day and kind. */
export function recordCoin(db, entries, grp) {
  const q = db.query("INSERT INTO coin_ledger (day, grp, kind, pp, n) VALUES (?, ?, ?, ?, 1) ON CONFLICT (day, grp, kind) DO UPDATE SET pp = pp + excluded.pp, n = n + 1");
  for (const e of entries) q.run(dayOf(e.t), grp, e.kind, e.pp);
}

/** Keep the account's total coin `pp` as read at `t`. */
export const recordPurse = (db, t, pp) => db.query("INSERT OR REPLACE INTO coin (t, pp) VALUES (?, ?)").run(t, Math.round(pp));

/**
 * The ledger of the last `days` days, oldest first: `[{ day, kinds: { [kind]: { pp, n } }, income,
 * spent, purse, change, other }]`, with `purse` the account's total at its last read of the day,
 * `change` its change since the last read of an earlier day, and `other` the part of that change
 * the ledger's lines do not explain (null without two reads).
 */
export function coinDays(db, days = 7, now = Date.now()) {
  const from = dayOf(now - (days - 1) * 86400000);
  const byDay = new Map();
  for (const r of db.query("SELECT day, kind, SUM(pp) AS pp, SUM(n) AS n FROM coin_ledger WHERE day >= ? GROUP BY day, kind").all(from)) {
    (byDay.get(r.day) ?? byDay.set(r.day, {}).get(r.day))[r.kind] = { pp: r.pp, n: r.n };
  }
  const purses = db.query("SELECT t, pp FROM coin ORDER BY t").all();
  const lastOf = (day) => purses.findLast((p) => dayOf(p.t) === day) ?? null;
  const before = (day) => purses.findLast((p) => dayOf(p.t) < day) ?? null;
  return [...byDay.keys()].sort().map((day) => {
    const kinds = byDay.get(day);
    const all = Object.values(kinds);
    const income = all.filter((k) => k.pp > 0).reduce((a, k) => a + k.pp, 0);
    const spent = all.filter((k) => k.pp < 0).reduce((a, k) => a + k.pp, 0);
    const end = lastOf(day);
    const start = before(day);
    const change = end && start ? end.pp - start.pp : null;
    return { day, kinds, income, spent, purse: end?.pp ?? null, change, other: change == null ? null : change - income - spent };
  });
}
