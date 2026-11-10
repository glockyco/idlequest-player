// Minute totals per group: for every minute, the seconds of each activity (the keys of the bridge's
// `activitySeconds`: `act`, or `act/why` for idle and travel), the XP the active character gained
// and its deaths. The collector folds the leaders' one-second samples into them
// as it exports the samples, so the dashboard's timelines, hourly bars and XP rates read this
// small table and not the sample files. Rows older than `RETENTION_MS` are removed.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { activeOf, xpStep } from "./samples.mjs";

export const MINUTE_MS = 60000;
export const RETENTION_MS = 14 * 86400000;
/** A longer gap between two samples is a pause in recording, not play time (as in the bridge's `activitySeconds`). */
export const MAX_GAP_MS = 3500;
/** XP gained across a gap longer than this is not attributed to a minute, since it cannot be placed. */
const MAX_XP_GAP_MS = 60000;

/** The key a sample's seconds count under, as in the bridge's `activitySeconds`. */
export const sampleKey = (s) => (s.why && (s.act === "idle" || s.act === "travel") ? `${s.act}/${s.why}` : s.act);

/**
 * Fold `samples` (oldest first, `prev` the sample before them or null) into minute totals,
 * `Map<minute, { sec, xp, deaths }>` with `minute` = floor(t / 60000). An interval counts toward
 * the minute of its later sample, within one recorder session and without a gap. `xp` is the
 * active character's XP change, net of losses at death, and leaves out steps across a character
 * switch (`xpStep` in tools/lib/samples.mjs). Pass `into` to keep adding to earlier totals.
 */
export function foldMinutes(prev, samples, into = new Map()) {
  let a = prev;
  for (const s of samples) {
    if (a && a.ses === s.ses && s.t > a.t) {
      const dt = s.t - a.t;
      const m = Math.floor(s.t / MINUTE_MS);
      let row = into.get(m);
      if (!row) into.set(m, (row = { sec: {}, xp: 0, deaths: 0 }));
      if (s.act && dt <= MAX_GAP_MS) {
        const key = sampleKey(s);
        row.sec[key] = (row.sec[key] ?? 0) + dt / 1000;
      }
      const dxp = dt <= MAX_XP_GAP_MS ? xpStep(a, s) : null;
      if (dxp != null) row.xp += dxp;
      if (s.act === "dead" && a.act !== "dead") row.deaths++;
    }
    a = s;
  }
  return into;
}

/** Add minute totals of group `grp` to the table, minutes already stored included. */
export function storeMinutes(db, grp, totals) {
  if (!totals.size) return;
  const get = db.query("SELECT sec, xp, deaths FROM minutes WHERE grp = ? AND minute = ?");
  const put = db.query("INSERT INTO minutes (grp, minute, sec, xp, deaths) VALUES (?, ?, ?, ?, ?) ON CONFLICT (grp, minute) DO UPDATE SET sec = excluded.sec, xp = excluded.xp, deaths = excluded.deaths");
  db.transaction(() => {
    for (const [minute, add] of totals) {
      const old = get.get(grp, minute);
      const sec = old ? JSON.parse(old.sec) : {};
      for (const [k, v] of Object.entries(add.sec)) sec[k] = Math.round(((sec[k] ?? 0) + v) * 10) / 10;
      put.run(grp, minute, JSON.stringify(sec), Math.round((old?.xp ?? 0) + add.xp), (old?.deaths ?? 0) + add.deaths);
    }
  })();
}

/**
 * Folds each group's new samples into the table as the collector exports them. It remembers the
 * last sample per group, so a pair of samples across two drains counts and a sample drained twice
 * does not: a tab that played another character of its group exports the tab's recorder buffer to
 * that character's directory too, with samples already folded.
 */
export class MinuteFolder {
  constructor(db) {
    this.db = db;
    this.last = new Map(); // group -> { t, sample }
  }

  add(grp, samples) {
    let last = this.last.get(grp);
    if (!last) {
      // After a restart, nothing at or before the last stored minute counts again.
      const stored = this.db.query("SELECT MAX(minute) AS m FROM minutes WHERE grp = ?").get(grp).m;
      last = { t: stored == null ? 0 : (stored + 1) * MINUTE_MS - 1, sample: null };
    }
    const fresh = samples.filter((s) => s.t > last.t);
    if (!fresh.length) return;
    storeMinutes(this.db, grp, foldMinutes(last.sample, fresh));
    this.last.set(grp, { t: fresh.at(-1).t, sample: fresh.at(-1) });
  }
}

/** Remove minute totals older than the retention. */
export function pruneMinutes(db, now) {
  return db.query("DELETE FROM minutes WHERE minute < ?").run(Math.floor((now - RETENTION_MS) / MINUTE_MS)).changes;
}

/**
 * Rebuild the minute totals since `since` from the leaders' recorded samples (runs/live/<leader>/
 * samples.jsonl), for the leaders `groupOf` maps to a group, and return the number of minutes
 * written. A stored minute is replaced, because the files hold every sample the collector folded.
 * Samples that several characters\' files hold count once.
 */
export async function backfillMinutes(db, runs, groupOf, since) {
  const dir = join(runs, "live");
  const byGroup = new Map(); // group -> Map("ses:seq" -> sample)
  for (const leader of readdirSync(dir)) {
    const grp = groupOf.get(leader);
    if (!grp) continue;
    const text = await Bun.file(join(dir, leader, "samples.jsonl")).text().catch(() => "");
    // A tab that played several characters of its group wrote its samples to each character\'s directory.
    const rows = byGroup.get(grp) ?? new Map();
    byGroup.set(grp, rows);
    for (const line of text.split("\n")) {
      if (!line) continue;
      try {
        const s = JSON.parse(line);
        if (s.t >= since - MINUTE_MS) rows.set(`${s.ses}:${s.seq}`, { ses: s.ses, t: s.t, act: s.act, why: s.why, xp: s.xp, cid: activeOf(s) });
      } catch {
        /* a line cut short by a crash */
      }
    }
  }
  const totals = new Map(); // group -> Map(minute -> row)
  for (const [grp, rows] of byGroup) totals.set(grp, foldMinutes(null, [...rows.values()].sort((x, y) => x.t - y.t || x.ses - y.ses)));
  let n = 0;
  const first = Math.floor(since / MINUTE_MS);
  const put = db.query("INSERT OR REPLACE INTO minutes (grp, minute, sec, xp, deaths) VALUES (?, ?, ?, ?, ?)");
  db.transaction(() => {
    for (const [grp, minutes] of totals) {
      for (const [minute, r] of minutes) {
        if (minute < first) continue;
        const sec = Object.fromEntries(Object.entries(r.sec).map(([k, v]) => [k, Math.round(v * 10) / 10]));
        put.run(grp, minute, JSON.stringify(sec), Math.round(r.xp), r.deaths);
        n++;
      }
    }
  })();
  return n;
}
