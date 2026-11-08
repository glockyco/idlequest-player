// Aggregates fights over seeds and prints them.
import { CLASS_NAMES, RACES } from "./classes.mjs";

const RACE_NAMES = Object.fromEntries(Object.entries(RACES).map(([name, id]) => [id, name]));

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
      stats: m.stats,
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
    // Member deaths per fight, over all members.
    deathsPerFight: round(mean(fights.map((f) => f.members.filter((r) => r.died !== null).length)), 2),
    members,
  };
}

const pad = (v, w, left = false) => {
  const s = v === null || v === undefined ? "-" : String(v);
  return left ? s.padEnd(w) : s.padStart(w);
};

export function memberTable(summary) {
  const head = ["Member", "Class", "HP", "AC", "Mana", "Melee", "Pet", "Nuke", "DoT", "Proc", "Total", "Heal", "Spent", "Deaths"];
  const widths = [18, 14, 6, 5, 5, 7, 7, 7, 7, 6, 7, 7, 7, 14];
  const lines = [head.map((h, i) => pad(h, widths[i], i < 2)).join(" ")];
  for (const m of summary.members) {
    const deaths = m.deaths ? `${m.deaths}/${summary.fights} @${m.medianDeathSec}s` : `0/${summary.fights}`;
    const cells = [m.name + (m.leader ? " *" : ""), CLASS_NAMES[m.cls], m.stats?.hp, m.stats?.ac, m.stats?.mana, m.melee, m.pet, m.nuke, m.dot, m.proc, m.total, m.healed, m.manaSpent, deaths];
    lines.push(cells.map((c, i) => pad(c, widths[i], i < 2)).join(" "));
  }
  const col = (key) => sum(summary.members.map((m) => m[key]));
  const total = ["Raid total", "", "", "", "", col("melee"), col("pet"), col("nuke"), col("dot"), col("proc"), col("total"), col("healed"), col("manaSpent"), ""];
  lines.push(total.map((c, i) => pad(c, widths[i], i < 2)).join(" "));
  return lines.join("\n");
}

export function fightLines(summary, maxSec) {
  const k = summary.killSec;
  const lines = [`Fights ${summary.fights}: ${summary.kills} kills, ${summary.wipes} wipes, ${summary.timeouts} timeouts (limit ${maxSec} s)`];
  if (summary.kills) lines.push(`Kill time: min ${k.min} s, median ${k.median} s, mean ${k.mean} s, max ${k.max} s`);
  lines.push(`Member deaths per fight: ${summary.deathsPerFight} of ${summary.members.length}`);
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

// The traced member's fight, from fight.mjs `traceBuckets`.
export function traceLines(name, rows) {
  const lines = [`${name}: hit points, damage taken from the boss, healing received and hate, per 10 s`, ""];
  lines.push(["From s", "HP", "Taken/s", "Hits", "Healed/s", "Rank", "Targeted s", "Cleric mana", "Healing received (caster: spell amount)"].map((h, i) => pad(h, [7, 12, 8, 5, 9, 5, 11, 12, 0][i], i === 8)).join(" "));
  for (const r of rows) {
    const heals = Object.entries(r.heals).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => `${k} ${v}`).join("; ");
    lines.push([pad(r.from, 7), pad(r.hp === null ? null : `${r.hp}/${r.maxHp}`, 12), pad(Math.round(r.taken / 10), 8), pad(r.hits, 5), pad(Math.round(r.healed / 10), 9), pad(r.rank, 5), pad(r.targetedSec, 11), pad(r.clericMana, 12), heals + (r.died ? "  DIED" : "")].join(" "));
  }
  return lines;
}

// ---- Gear report: what each member wears and where it comes from ----------------------------------

const SLOT_LABEL = { 0: "charm", 1: "ear 1", 2: "head", 3: "face", 4: "ear 2", 5: "neck", 6: "shoulders", 7: "arms", 8: "back", 9: "wrist 1", 10: "wrist 2", 11: "range", 12: "hands", 13: "primary", 14: "secondary", 15: "finger 1", 16: "finger 2", 17: "chest", 18: "legs", 19: "feet", 20: "waist" };
const STAT_LABEL = [["ac", "AC"], ["hp", "HP"], ["mana", "Mana"], ["astr", "STR"], ["asta", "STA"], ["adex", "DEX"], ["aagi", "AGI"], ["aint", "INT"], ["awis", "WIS"], ["acha", "CHA"], ["attack", "ATK"], ["haste", "haste"], ["regen", "regen"], ["manaregen", "mregen"]];

const itemStats = (item) => {
  const stats = STAT_LABEL.filter(([k]) => item[k]).map(([k, label]) => `${label} ${item[k]}`);
  if (item.damage > 0 && item.delay > 0) stats.unshift(`${item.damage}/${item.delay}`);
  return stats.join(" ");
};

function originText(origin) {
  if (origin === undefined || origin === null) return "merchant kit, any merchant";
  if (origin === "roster") return "roster entry";
  if (origin.kind === "merchant") return `sold by ${origin.npc} in ${origin.zone}`;
  const respawn = Number.isFinite(origin.respawn) ? `${origin.respawn} s respawn` : "no respawn timer";
  return `${origin.npc} (L${origin.level}) in ${origin.zone}: ${(origin.drop * 100).toFixed(1)}% drop, ${(origin.spawn * 100).toFixed(0)}% spawn, ${respawn}, about ${origin.hours.toFixed(1)} h per copy`;
}

// `roster` is a normalized roster (roster.mjs) and `items` the content snapshot's items by id.
export function gearReport(roster, items) {
  const lines = [];
  for (const m of roster) {
    const total = Object.values(m.equipped).reduce((t, id) => ({ ac: t.ac + (items.get(id).ac ?? 0), hp: t.hp + (items.get(id).hp ?? 0), mana: t.mana + (items.get(id).mana ?? 0) }), { ac: 0, hp: 0, mana: 0 });
    lines.push(`${m.name} (${CLASS_NAMES[m.cls]}, ${RACE_NAMES[m.race] ?? m.race}, gear ${m.kit.policy}): ${Object.keys(m.equipped).length} items with AC ${total.ac}, HP ${total.hp}, mana ${total.mana}; ${m.spells.length} spells scribed`);
    const slots = Object.keys(m.equipped).map(Number).sort((a, b) => a - b);
    for (const slot of slots) {
      const item = items.get(m.equipped[slot]);
      const origin = m.kit.origins === "roster" ? "roster" : m.kit.origins?.[slot];
      lines.push(`  ${(SLOT_LABEL[slot] ?? `slot ${slot}`).padEnd(10)} ${item.Name.padEnd(34)} ${itemStats(item).padEnd(34)} ${originText(origin)}`);
    }
    if (m.kit.farmedSpells === "roster") lines.push("  spells: roster entry");
    else if (m.kit.policy === "farm") {
      lines.push(`  spells: ${m.spells.length - m.kit.farmedSpells.length} from merchant scrolls, ${m.kit.farmedSpells.length} farmed`);
      for (const s of m.kit.farmedSpells) lines.push(`    ${s.name} (spell ${s.id}): ${originText(s.origin)}`);
    } else lines.push(`  spells: ${m.spells.length} from merchant scrolls`);
  }
  return lines;
}
