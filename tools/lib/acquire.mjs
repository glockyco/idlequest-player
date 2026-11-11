// The gear acquisition model (docs/plans/gear-acquisition.md): what a copy of an item is worth in
// hours of its group's progress, and what each way of getting it costs. Pure, so the gear plan ranks
// enemies and the coordinator chooses hunts with the same numbers.
import { xpStart } from "./xp.mjs";

// XP per hour against party damage, the calibrated model's elasticity by level (leveling plan, lever 7).
const ELASTICITY = [[20, 0.5], [29, 0.74], [35, 0.82], [45, 0.85]];
export const elasticity = (level) => {
  if (level <= ELASTICITY[0][0]) return ELASTICITY[0][1];
  for (let k = 1; k < ELASTICITY.length; k++) {
    const [l1, e1] = ELASTICITY[k];
    const [l0, e0] = ELASTICITY[k - 1];
    if (level <= l1) return e0 + ((e1 - e0) * (level - l0)) / (l1 - l0);
  }
  return ELASTICITY.at(-1)[1];
};

export const ACQUIRE = {
  // An upgrade is worn for this many levels of its wearer's pace, until the gear plan tracks what
  // replaces it.
  wearLevels: 10,
  // The share of its time a group idled on an errand in a zone another group played (group 4, once).
  sharedCost: 0.4,
  // A visit travels, reads the zone's spawn list, kills the enemy if it is up and leaves. One that
  // found nothing up took about 1.6 minutes to the group's next fight, but a visit's deadline comes
  // from these hours too and has to leave the walk to an enemy that is up.
  visitHours: 0.1,
  // A camp runs this long, and the next pass sends the group again while the enemy still pays.
  campMin: 30,
  // Below this chance for its best group, a target counts as out of every group's reach on the
  // dashboard. The decision itself weighs any chance by its expected value (`ways`).
  tooStrong: 0.05,
  // The share of a group's hunting time its fights take (58.7% over 34 group-hours on 2026-11-11),
  // so its usual fight lasts this share of the time between two of its kills.
  fightShare: 0.59,
};

// What a death costs beyond a won fight, in seconds of the party's time: the fight and the wait
// after it (`bun tools/fights.mjs`, "What escapes and deaths cost"), as the bot's `DEATH_EXTRA_SEC`.
// A leader's death also costs level squared times 666.67 XP, and a companion's costs no XP.
const DEATH_SEC = { member: 38, leader: 85 };

// A sure kill without deaths, for a way valued apart from any group's chance.
const SURE = { p: 1, fights: 0, deaths: 0, leaderDeaths: 0 };

/**
 * A group's chance against an enemy and what one fight costs it: the prior of tools/lib/kill-prior.mjs
 * (`prior`, `{ p, deaths, leaderDeaths }`) as `priorWeight` fights, the simulator's fights of its six
 * (`sim`, `{ kills, fights, meanSec, deathsPerFight, leaderDeathsPerFight }`, tools/kill-odds.mjs) and its
 * fight record at its level (`record`, `{ kills, escapes }`, tools/lib/fight-record.mjs), each a
 * fight of evidence, so the pair's own fights outweigh the prior as they come. Deaths per fight come
 * from the simulator where it fought the pair, else from the prior. `{ p, fights, deaths,
 * leaderDeaths }`, with `sec`, the simulator's seconds per won fight, where it won one, or null
 * with none of the three.
 */
export function killChanceOf({ record = null, sim = null, prior = null, priorWeight = 1 }) {
  const live = (record?.kills ?? 0) + (record?.escapes ?? 0);
  const simulated = sim && !sim.error ? sim.fights : 0;
  const w = prior ? priorWeight : 0;
  if (!live && !simulated && !w) return null;
  const p = (w * (prior?.p ?? 0) + (record?.kills ?? 0) + (simulated ? sim.kills : 0)) / (w + live + simulated);
  const deaths = simulated ? sim.deathsPerFight : (prior?.deaths ?? 0);
  const leaderDeaths = simulated ? (sim.leaderDeathsPerFight ?? 0) : (prior?.leaderDeaths ?? 0);
  return { p, fights: live + simulated, deaths, leaderDeaths, ...(simulated && sim.meanSec > 0 ? { sec: sim.meanSec } : {}) };
}

/**
 * The kills an hour a group makes of an enemy it fights for `k.sec` seconds, from its usual
 * `killsPerHour`: its time per kill grows as the fight does against its usual fight
 * (`fightShare`). Group 2's simulated fight with a Disciple of Innoruuk takes 293 s where its
 * usual one takes about 38, so it kills 7 of them an hour and not 56. Without a fight time or a
 * kill rate the usual rate stands.
 */
export const paceOf = (killsPerHour, k) => {
  if (!(killsPerHour > 0) || !(k?.sec > 0)) return killsPerHour;
  return killsPerHour / Math.max(1, k.sec / ((ACQUIRE.fightShare * 3600) / killsPerHour));
};

/**
 * The hours of tab `t`'s progress one fight's deaths cost (`k` of `killChanceOf`): each companion
 * death its time, the leader's its time and its XP at the group's measured pace
 * (`hoursPerLevel` of the leader). Without a pace the XP part is unknown and left out.
 */
export function deathHours(t, k, hoursPerLevel = {}) {
  const leader = t.members[0] ?? {};
  const level = leader.level ?? 0;
  const perLevel = hoursPerLevel[leader.name];
  const xph = perLevel > 0 ? (xpStart(level + 1) - xpStart(level)) / perLevel : 0;
  const leaderXpHours = xph > 0 && level >= 5 ? (level * level * 666.67) / xph : 0;
  return (Math.max(0, k.deaths - k.leaderDeaths) * DEATH_SEC.member) / 3600 + k.leaderDeaths * (DEATH_SEC.leader / 3600 + leaderXpHours);
}

/**
 * V: the hours of its group's progress one copy of a wanted item adds while it is worn, from the
 * gain to the taker's group's XP rate (`w.gain`, tenths of a percent, the gear plan's `xpGain`) and
 * the hours it is worn, `wearLevels` at the taker's pace (`hoursPerLevel[w.to]`, which the
 * coordinator measures from the group's XP per hour). When another hunt already serves the slot
 * (`w.claim`, `{ gain, hours }`: that copy's gain and its expected hours of hunting), a copy that
 * comes after `hours` of hunting is worn until that one would come, and adds for good only what it
 * gains over that one.
 */
export const copyValue = (w, hoursPerLevel = {}, hours = 0) => {
  const wear = ACQUIRE.wearLevels * (hoursPerLevel[w.to] ?? 0);
  if (!w.claim) return (w.gain / 1000) * wear;
  const meanwhile = Math.min(wear, Math.max(0, w.claim.hours - hours));
  return (Math.max(0, w.gain - w.claim.gain) * wear + Math.min(w.gain, w.claim.gain) * meanwhile) / 1000;
};

/**
 * The hunting hours for one copy of item `w` from enemy `x` for a group that kills `killsPerHour`:
 * the respawns bound it (`w.hours`, every point cleared as it respawns), and so does the kill rate,
 * since each kill is the enemy with the `spawn` chance and drops the item with the `drop` chance,
 * unless the source counts the kills a copy takes (`w.kills`).
 */
export const copyHours = (w, x, killsPerHour) => Math.max(w.hours, killsPerHour > 0 ? (w.kills ?? 1 / ((x.spawn ?? 1) * (w.drop ?? 1))) / killsPerHour : 0);

// The kills a copy's chain of deaths takes once the enemy is up: one, or the `kills` of an item a
// chain ends in, as the black reaver's line ends in Lord Rak`Ashiir after five reavers on average.
export const chainKills = (x) => Math.max(1, ...x.items.map((w) => w.kills ?? 1));

/**
 * The ways tab `t` can hunt gear target `x` (an enemy of the gear plan's `targets`), each
 * `{ kind, hours, value, cost }` for one copy or one visit, in hours of the group's progress, on
 * expected value at the group's kill chance `k` (`killChanceOf`, a sure kill by default):
 * - errand: inside the group's rotation, `hours` the expected hunting until the first wanted copy
 *   (`copyHours` at the group's `killsPerHour`, stretched by the fights it loses), free;
 * - camp: outside it, the same hours, all of them a cost, since a camp holds the enemy's points with
 *   the client's Spawn Camp and earns no XP while it waits for their respawns;
 * - visit: outside it, `visitHours`, worth the chance the enemy is up on one of its points on
 *   arrival, 1 - (1 - spawn)^points, times the kill chance and each item's drop chance and value.
 * Every fight, won or lost, pays its expected deaths (`deathHours`): an errand or a camp as many as
 * one copy takes and a visit one when the enemy is up, and a copy at the end of a chain of deaths
 * every fight of its chain, each at its own enemy's kill chance (`fights` of the target, through
 * `killChance(tab, enemy)`), else at the target's for every kill (`chainKills`). An errand costs `sharedCost` of its
 * hours in a zone another tab plays or travels to. The items' drops roll on their own, so a
 * copy of any of them comes every `1 / sum(1 / hours)` hours, and its value is the items' value per
 * hour of hunting times that. Each way also names `zoneRate`, the share of each of its hours the
 * zone costs whatever the group hunts there, which a trip for several targets pays once (`trip`),
 * and `copies`, each item's hours of hunting per copy.
 */
export function ways(t, x, { tabs = [], hoursPerLevel = {}, killsPerHour = {}, killChance = null } = {}, k = SURE) {
  const perFight = deathHours(t, k, hoursPerLevel);
  const copies = x.items.map((w) => copyHours({ ...w, hours: w.respawnHours ?? w.hours }, x, paceOf(killsPerHour[t.group], k)) / k.p);
  const values = x.items.map((w, j) => copyValue(w, hoursPerLevel, copies[j]));
  const perHour = values.reduce((s, v, j) => s + v / copies[j], 0);
  const hours = 1 / copies.reduce((s, h) => s + 1 / h, 0);
  // A kill drops a wanted copy with the chance that at least one of the enemy's items rolls.
  const anyDrop = 1 - x.items.reduce((q, w) => q * (1 - (w.drop ?? 1)), 1);
  const chainDeaths = x.fights?.length ? x.fights.reduce((s, f) => s + f.kills * deathHours(t, killChance?.(t, { ...x, npc: f.npc, npcLevel: f.level, npcHp: f.hp }) ?? k, hoursPerLevel), 0) : perFight * chainKills(x);
  const deaths = chainDeaths / (k.p * Math.max(anyDrop, 1e-6));
  const base = { hours, value: perHour * hours, copies, values, killChance: k.p };
  if ((t.rotation ?? []).includes(x.zone)) {
    const shared = tabs.some((o) => o !== t && o.zone === x.zone) ? ACQUIRE.sharedCost : 0;
    return [{ kind: "errand", ...base, zoneRate: shared, cost: shared * hours + deaths }];
  }
  const up = 1 - (1 - (x.spawn ?? 1)) ** Math.max(1, x.points ?? 1);
  const visitValue = k.p * up * x.items.reduce((s, w, j) => s + (w.drop ?? 1) * values[j], 0);
  return [
    { kind: "camp", ...base, zoneRate: 1, cost: hours + deaths },
    { kind: "visit", hours: ACQUIRE.visitHours, value: visitValue, cost: ACQUIRE.visitHours + up * chainDeaths, up, copies, values, killChance: k.p, zoneRate: 1 },
  ];
}

/** What a way earns per hour of the group's time: its value less its cost, over its hours. */
export const netRate = (w) => (w.value - w.cost) / w.hours;

/**
 * The way of `ways` that earns most per hour for tab `t` at its kill chance against `x`
 * (`ctx.killChance(t, x)`, `killChanceOf`), or null when the group has no kill chance yet or never
 * wins.
 */
export function bestWay(t, x, ctx = {}) {
  const k = ctx.killChance?.(t, x) ?? null;
  if (!(k?.p > 0)) return null;
  return ways(t, x, ctx, k).reduce((a, b) => (netRate(b) > netRate(a) ? b : a));
}

/**
 * Tab `t`'s best trip into one zone for the targets `xs` there: `{ kind, zone, hours, value, cost,
 * members }`, `members` the targets it hunts, each `{ x, w }` with its way, or null when no trip
 * pays. Inside the group's rotation a trip is an errand of an hour, outside it a camp of `campMin`
 * or a visit, and `due(x, kind)` leaves out a target not due for that kind. The zone's cost
 * (`zoneRate`) is paid once. The targets of an errand or a camp share the group's kills: one hunted
 * at its full rate takes the share of the group's kills its points give as they respawn, at most
 * all of them, and when the shares pass all kills, the targets that pay most per share keep
 * theirs. A trip fills each taker slot at most once: with the chance that a copy of one of the
 * slot's items comes within its hours, at the rates its share of kills gives, worth the mean value
 * of those copies, and every fight pays its deaths. A visit of `visitHours` kills whichever of its
 * targets is up, each kill of its chain (`chainKills`) taking the group's time per kill, so a
 * target joins a visit only when it pays more than that time.
 */
export function trip(t, xs, ctx = {}, due = () => true) {
  const fought = xs.map((x) => ({ x, k: ctx.killChance?.(t, x) ?? null })).filter((m) => m.k?.p > 0);
  if (!fought.length) return null;
  const kills = ctx.killsPerHour?.[t.group] ?? 0;
  const zone = fought[0].x.zone;
  const options = [];
  for (const kind of (t.rotation ?? []).includes(zone) ? ["errand"] : ["camp", "visit"]) {
    const members = fought.filter((m) => due(m.x, kind)).map((m) => ({ x: m.x, k: m.k, w: ways(t, m.x, ctx, m.k).find((w) => w.kind === kind) }));
    if (!members.length) continue;
    const { zoneRate } = members[0].w;
    let kept;
    let hours;
    let value;
    if (kind === "visit") {
      // Each target's pay per visit: its drops less its deaths. A kill takes the group's time per
      // kill of that enemy, and none without a kill rate.
      const perKill = (m) => (kills > 0 ? 1 / paceOf(kills, m.k) : 0);
      kept = members.filter((m) => m.w.value - (m.w.cost - ACQUIRE.visitHours) > zoneRate * m.w.up * chainKills(m.x) * perKill(m));
      hours = ACQUIRE.visitHours + kept.reduce((s, m) => s + m.w.up * chainKills(m.x) * perKill(m), 0);
      value = kept.reduce((s, m) => s + m.w.value - (m.w.cost - ACQUIRE.visitHours), 0);
    } else {
      hours = kind === "errand" ? 1 : ACQUIRE.campMin / 60;
      // Each target's pay per hour of hunting it at its full rate, its deaths per hour, and its
      // share of the group's kills: its points over their respawn, unknown without a kill rate.
      const paying = members
        .map((m) => {
          const deathRate = (m.w.cost - zoneRate * m.w.hours) / m.w.hours;
          return { ...m, deathRate, pay: m.w.value / m.w.hours - deathRate, share: kills > 0 && m.x.respawn > 0 ? Math.min(1, (m.x.points ?? 1) / (m.x.respawn / 3600) / paceOf(kills, m.k)) : 0 };
        })
        .filter((m) => m.pay > 0)
        .sort((a, b) => b.pay / (b.share || 1e-9) - a.pay / (a.share || 1e-9));
      let left = 1;
      kept = [];
      for (const m of paying) {
        if (m.share > 0 && left <= 0) continue;
        const got = Math.min(m.share, left);
        left -= got;
        // The share of its full rate the target gets on this trip.
        kept.push({ ...m, rate: m.share > 0 ? got / m.share : 1 });
      }
      const slots = new Map();
      let deaths = 0;
      for (const m of kept) {
        deaths += m.rate * m.deathRate * hours;
        for (const [j, item] of m.x.items.entries()) {
          const s = slots.get(slotKey(item)) ?? slots.set(slotKey(item), { copies: 0, value: 0 }).get(slotKey(item));
          s.copies += m.rate / m.w.copies[j];
          s.value += (m.rate / m.w.copies[j]) * m.w.values[j];
        }
      }
      value = [...slots.values()].reduce((sum, s) => sum + (s.copies > 0 ? (s.value / s.copies) * (1 - Math.exp(-s.copies * hours)) : 0), 0) - deaths;
    }
    if (kept.length) options.push({ kind, zone, hours, value, cost: zoneRate * hours, members: kept.map(({ x, w }) => ({ x, w })) });
  }
  return options.length ? options.reduce((a, b) => (netRate(b) > netRate(a) ? b : a)) : null;
}

/** A gear target's id in the coordinator's history and the dashboard, `target-<zone>-<npc>`. */
export const targetId = (t) => `target-${t.zone}-${t.npc.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;

/** The character slot an item of a target serves, `<taker>:<slot>`: one copy fills it. */
export const slotKey = (w) => `${w.to}:${w.slot}`;

/** Minutes before a target's next hunt: an errand ran an hour inside normal hunting, a camp or a visit (history kind "hunt") was a trip. */
export const targetRetryMin = (kind) => (kind === "errand" ? 120 : 60);

const span = (h) => (h >= 1 ? `${h.toFixed(1)} h` : h * 60 >= 1 ? `${Math.round(h * 60)} min` : "under a minute");

/**
 * A trip in words, with its value in the progress of its takers' groups and its cost in the hunting
 * group's: "30 min of camping for 3 enemies adds 12 min to their takers' groups and costs 3 min of
 * the hunters' progress".
 */
export function describeTrip(w) {
  const cost = w.cost > 0 ? `costs ${span(w.cost)} of the hunters' progress` : "costs nothing";
  const what = w.kind === "visit" ? "a visit" : w.kind === "camp" ? "camping" : "hunting";
  const n = w.members.length;
  return `${span(w.hours)} of ${what} for ${n === 1 ? "1 enemy" : `${n} enemies`} adds ${span(w.value)} to ${n === 1 ? "its taker's group" : "their takers' groups"} and ${cost}`;
}
