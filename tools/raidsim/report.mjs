// Aggregates fights over seeds and prints them.
import { CLASS_NAMES } from "./classes.mjs";

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const mean = (xs) => (xs.length ? sum(xs) / xs.length : null);
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
const round = (x, d = 0) => (x === null ? null : Math.round(x * 10 ** d) / 10 ** d);

export function summarize(fights, maxSec) {
  const kills = fights.filter((f) => f.outcome === "kill");
  const times = kills.map((f) => f.seconds);
  const members = fights[0].members.map((m, i) => {
    const rows = fights.map((f) => f.members[i]);
    const avg = (get) => round(mean(rows.map(get)));
    const deaths = rows.filter((r) => r.died !== null);
    return {
      name: m.name,
      cls: m.cls,
      leader: m.leader,
      melee: avg((r) => r.damage.melee),
      pet: avg((r) => r.damage.pet),
      nuke: avg((r) => r.damage.nuke),
      dot: avg((r) => r.damage.dot),
      proc: avg((r) => r.damage.proc + r.damage.other),
      total: avg((r) => sum(Object.values(r.damage))),
      healed: avg((r) => r.healed),
      manaSpent: avg((r) => r.manaSpent),
      taken: avg((r) => r.taken),
      deaths: deaths.length,
      medianDeathSec: round(median(deaths.map((r) => r.died)), 1),
    };
  });
  return {
    fights: fights.length,
    kills: kills.length,
    wipes: fights.filter((f) => f.outcome === "wipe").length,
    timeouts: fights.filter((f) => f.outcome === "timeout").length,
    killSec: { min: round(Math.min(...times), 1), median: round(median(times), 1), mean: round(mean(times), 1), max: round(Math.max(...times), 1) },
    // A fight that is not a kill counts as the time limit, so the mean moves when kills turn into misses.
    meanSecOrLimit: round(mean(fights.map((f) => (f.outcome === "kill" ? f.seconds : maxSec))), 1),
    bossHpLeftMean: round(mean(fights.map((f) => f.bossHpLeft))),
    bossMaxHp: fights[0].bossMaxHp,
    members,
  };
}

const pad = (v, w, left = false) => {
  const s = v === null || v === undefined ? "-" : String(v);
  return left ? s.padEnd(w) : s.padStart(w);
};

export function memberTable(summary) {
  const head = ["Member", "Class", "Melee", "Pet", "Nuke", "DoT", "Proc", "Total", "Heal", "Mana", "Deaths"];
  const widths = [18, 14, 7, 7, 7, 7, 6, 7, 7, 7, 14];
  const lines = [head.map((h, i) => pad(h, widths[i], i < 2)).join(" ")];
  for (const m of summary.members) {
    const deaths = m.deaths ? `${m.deaths}/${summary.fights} @${m.medianDeathSec}s` : `0/${summary.fights}`;
    const cells = [m.name + (m.leader ? " *" : ""), CLASS_NAMES[m.cls], m.melee, m.pet, m.nuke, m.dot, m.proc, m.total, m.healed, m.manaSpent, deaths];
    lines.push(cells.map((c, i) => pad(c, widths[i], i < 2)).join(" "));
  }
  const col = (key) => sum(summary.members.map((m) => m[key]));
  const total = ["Raid total", "", col("melee"), col("pet"), col("nuke"), col("dot"), col("proc"), col("total"), col("healed"), col("manaSpent"), ""];
  lines.push(total.map((c, i) => pad(c, widths[i], i < 2)).join(" "));
  return lines.join("\n");
}

export function fightLines(summary, maxSec) {
  const k = summary.killSec;
  const lines = [`Fights ${summary.fights}: ${summary.kills} kills, ${summary.wipes} wipes, ${summary.timeouts} timeouts (limit ${maxSec} s)`];
  if (summary.kills) lines.push(`Kill time: min ${k.min} s, median ${k.median} s, mean ${k.mean} s, max ${k.max} s`);
  const missed = summary.fights - summary.kills;
  if (missed) lines.push(`Boss HP left, mean over all fights: ${summary.bossHpLeftMean} of ${summary.bossMaxHp}`);
  return lines;
}

export function sweepTable(rows, baseline, maxSec) {
  const lines = [[pad("Slot class", 14, true), pad("Kills", 7), pad("Mean kill s", 12), pad("Change s", 10), pad("Mean s*", 9), pad("Boss HP left", 13)].join(" ")];
  for (const r of rows) {
    const s = r.summary;
    const change = baseline.kills && s.kills ? round(s.killSec.mean - baseline.killSec.mean, 1) : null;
    const label = r.label;
    lines.push([pad(label, 14, true), pad(`${s.kills}/${s.fights}`, 7), pad(s.kills ? s.killSec.mean : null, 12), pad(change === null ? null : (change > 0 ? "+" : "") + change, 10), pad(s.meanSecOrLimit, 9), pad(s.bossHpLeftMean, 13)].join(" "));
  }
  lines.push(`* mean over all fights, a fight without a kill counts as ${maxSec} s. Change is mean kill time against the unchanged roster (kills only).`);
  return lines.join("\n");
}
