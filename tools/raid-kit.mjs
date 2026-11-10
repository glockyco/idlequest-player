#!/usr/bin/env bun
// The raid kit: gear swaps among the account's items that make the raid simulator's fight against
// one boss go better, written to runs/state/raid-kit.json (the pure parts are tools/lib/raid-kit.mjs).
//
//   bun tools/raid-kit.mjs [--boss <npc id|name>] [--seeds 6] [--leader Tagujazolu] [--budget 30]
//     [--max-sec 900] [--screen-sec 90] [--screen-seeds 6] [--margin 1] [--validate] [--out <file>]
//     [--heal-mode all-balanced] [--dps-mode dps-all-out] [--jobs N] [--seed-base 1] [--pick-seeds 2]
//
//   --boss          npc_types id or name. Without it the goal boss closest to a kill (kill chance, then
//                   mean kill time, then boss hit points left) of `--pick-seeds` fights each
//   --seeds         fights of every full evaluation (default 6)
//   --leader        the roster's leader, a character of data/roster.json (default the first one)
//   --budget        minutes after which no further fights start (default 30)
//   --max-sec       fight time limit of full evaluations (default 900)
//   --screen-sec    fight time limit of the screen's fights (default 90)
//   --screen-seeds  fights that measure the screen's baseline and its noise (default 6)
//   --margin        standard errors of chance a swap batch must beat (default 1)
//   --validate      also measure how well the screen agrees with full fights: a second screen of part of
//                   the candidates, and two more full evaluations, of the best and the worst bundle
//
// The roster is every roster character as runs/state/account-items.json found it (raidsim `--roster
// account`). A swap puts a carried copy of an item, the character's own or another roster member's,
// into a slot of a character that can wear it (class, race, slot, level, one copy of a lore item,
// no item that needs a deity, a two-hander only with an empty off hand). The search works in three steps.
//
//   Candidates  Every such swap, less those the worn item or another candidate beats in every stat.
//   Screen      Fights of the screen's length where each member wears one candidate (the p-th of its
//               list in fight p), so one fight tests a candidate for every member at once. A member's
//               result is its damage to the boss plus its healing, which is compared with the same
//               member's mean over the baseline fights of the same length. Stage one fights every
//               candidate once. Stage two fights the best four of each member (by the change against the
//               member's own spread) twice more, and a candidate's score is its mean over the three
//               fights, which takes back the luck that put it high among its member's candidates. Only
//               swaps with a positive score are fought in full.
//   Search      Rounds of the best remaining swap of each member, fought in full against the kit so far.
//               A round is accepted when it beats the kit by the outcome order (higher kill chance,
//               then shorter mean kill time, then less boss hit points left) by more than --margin
//               standard errors of the kit's own fights, and otherwise halved until a half is accepted or
//               three evaluations in a row fail. The kit is written after every accepted round.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { readFile } from "node:fs/promises";
import { findBoss, bossSpec } from "./raidsim/boss.mjs";
import { resolveClient } from "./raidsim/clients.mjs";
import { accountRoster } from "./raidsim/account.mjs";
import { rosterEntries } from "./raidsim/roster.mjs";
import { byId } from "./raidsim/content.mjs";
import { DEFAULT_JOBS } from "./raidsim/pool.mjs";
import { DPS_MODES, HEAL_MODES, simulate } from "./raidsim/run.mjs";
import { SLOT_BY_NUM } from "./lib/gear-data.mjs";
import {
  GOAL_BOSSES,
  buildBatch,
  candidates,
  closestToKill,
  cloneState,
  improves,
  applySwap,
  kitState,
  margins,
  memberOutput,
  outcomeDelta,
  probeRounds,
  spearman,
  undominated,
  withSwaps,
} from "./lib/raid-kit.mjs";

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const fail = (message) => {
  console.error(`raid-kit: ${message}`);
  process.exit(1);
};
const log = (message) => console.error(`[${((Date.now() - started) / 60000).toFixed(1)} min] ${message}`);

const started = Date.now();
const seeds = Number(opt("seeds", 6));
const seedBase = Number(opt("seed-base", 1));
const maxSec = Number(opt("max-sec", 900));
const screenSec = Number(opt("screen-sec", 90));
const screenSeeds = Number(opt("screen-seeds", 6));
const pickSeeds = Number(opt("pick-seeds", 2));
const marginFactor = Number(opt("margin", 1));
const budgetMin = Number(opt("budget", 30));
const jobs = Number(opt("jobs", DEFAULT_JOBS));
const dpsMode = opt("dps-mode", "dps-all-out");
const healMode = opt("heal-mode", "all-balanced");
const out = opt("out", new URL("../runs/state/raid-kit.json", import.meta.url).pathname);
for (const [name, value] of [["--seeds", seeds], ["--max-sec", maxSec], ["--screen-sec", screenSec], ["--screen-seeds", screenSeeds], ["--pick-seeds", pickSeeds], ["--budget", budgetMin], ["--jobs", jobs]]) {
  if (!(value >= 1)) fail(`${name} must be a number of at least 1`);
}
if (!(marginFactor >= 0)) fail("--margin must be a number of at least 0");
if (!DPS_MODES.includes(dpsMode)) fail(`--dps-mode must be one of ${DPS_MODES.join(", ")}`);
if (!HEAL_MODES.includes(healMode)) fail(`--heal-mode must be one of ${HEAL_MODES.join(", ")}`);
const deadline = started + budgetMin * 60_000;

let client;
try {
  client = await resolveClient(opt("client"));
} catch (error) {
  fail(error.message);
}
process.env.RAIDSIM_CLIENT = client.id; // read by every fight process (env.mjs)

const progress = (label) => (done, total) => {
  if (process.stderr.isTTY) process.stderr.write(`\r${label} ${done}/${total} fights`);
};
const endProgress = () => process.stderr.isTTY && process.stderr.write("\r\x1b[K");

// ---- Input: the survey, the roster, the content snapshot ------------------------------------------
const rows = JSON.parse(await readFile(new URL("../runs/state/account-items.json", import.meta.url), "utf8"));
const groups = JSON.parse(await readFile(new URL("../data/roster.json", import.meta.url), "utf8")).groups;
const names = groups.flatMap((g) => g.members ?? []);
const leader = opt("leader", names[0]);
let entries;
let level;
try {
  ({ entries, level } = rosterEntries(accountRoster(rows, { leader, names })));
} catch (error) {
  fail(error.message);
}
const items = await byId("items");

const run = async (boss, variants, o = {}) => {
  const results = await simulate({ boss, level, seeds, seedBase, maxSec, dpsMode, healMode, jobs, ...o, variants });
  endProgress();
  return results;
};

// ---- Target boss -------------------------------------------------------------------------------------
let boss;
try {
  if (opt("boss") !== undefined) boss = await bossSpec(await findBoss(opt("boss")));
  else {
    const scored = [];
    for (const g of GOAL_BOSSES) {
      const spec = await bossSpec(await findBoss(g.npc));
      const [r] = await run(spec, [{ label: g.name, entries }], { seeds: pickSeeds, onProgress: progress(g.name) });
      log(`${g.name}: ${r.summary.kills}/${r.summary.fights} kills, boss hit points left ${r.summary.bossHpLeftMean}`);
      scored.push({ boss: spec, summary: r.summary });
    }
    boss = closestToKill(scored).boss;
  }
} catch (error) {
  fail(error.message);
}
const bossInfo = { id: boss.row.id, name: boss.row.name.replace(/#/g, "").replace(/_/g, " "), level: boss.row.level, hp: Number(boss.row.hp) };
log(`boss ${bossInfo.name} (npc ${bossInfo.id}), ${entries.length} members`);

const brief = (s) => ({ fights: s.fights, kills: s.kills, killSecMean: s.kills ? s.killSec.mean : null, bossHpLeftMean: s.bossHpLeftMean, deathsPerFight: s.deathsPerFight });
const describe = (s) => `${s.kills}/${s.fights} kills${s.kills ? `, mean ${s.killSec.mean} s` : ""}, boss hit points left ${s.bossHpLeftMean} of ${s.bossMaxHp}, ${s.deathsPerFight} deaths per fight`;

// ---- Baseline and candidates ---------------------------------------------------------------------------
const [baseline] = await run(boss, [{ label: "baseline", entries }], { onProgress: progress("baseline") });
log(`baseline: ${describe(baseline.summary)}`);

const state = kitState({ rows, items, names });
const all = candidates(state);
const kept = undominated(state, all);
log(`candidates: ${all.length} swaps, ${kept.length} after dropping the ones the worn item or another candidate beats in every stat`);

// ---- Screen ------------------------------------------------------------------------------------------------
// A fixed shuffle, so a screen that runs out of time has probed an unbiased part of every member's list.
const shuffled = (() => {
  let a = 0x9e3779b9;
  const random = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const list = [...kept];
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
})();
const rounds = probeRounds(shuffled);

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const key = (s) => `${s.character}:${s.slot}:${s.itemId}`;

// A member's mean output and its standard deviation in `screenSeeds` baseline fights of the screen's length.
const stats = await (async () => {
  const [base] = await run(boss, [{ label: "screen baseline", entries }], { seeds: screenSeeds, maxSec: screenSec, onProgress: progress("screen baseline") });
  const means = new Map();
  const sds = new Map();
  base.summary.members.forEach((m, i) => {
    const xs = base.fights.map((f) => memberOutput(f.members[i]));
    const m1 = mean(xs);
    means.set(m.name, m1);
    sds.set(m.name, Math.sqrt(xs.reduce((a, x) => a + (x - m1) ** 2, 0) / Math.max(1, xs.length - 1)));
  });
  return { mean: means, sd: sds };
})();

/**
 * Probe fights: fight `p` of `roundList` has the `p`-th swap of every member worn, `seedsPerRound`
 * times. Returns each swap with `gain`, the change of its member's output (damage plus healing, in
 * hit points) against the member's mean in the baseline fights of the same length, and the
 * member's `noise`, its standard deviation there.
 */
async function probe(roundList, { seedStart, seedsPerRound, label }) {
  const scored = [];
  // Chunks, so a screen that has used its share of the time stops between them.
  const chunk = Math.max(jobs * 4, 8);
  const share = started + (deadline - started) * 0.45;
  for (let from = 0; from < roundList.length; from += chunk) {
    if (from > 0 && Date.now() > share) {
      log(`${label}: stopped after ${from} of ${roundList.length} probe rounds, its share of the budget is used`);
      break;
    }
    const part = roundList.slice(from, from + chunk);
    const variants = part.map((swaps, k) => ({ label: `probe ${from + k}`, entries: withSwaps(entries, swaps), seedBase: seedStart + (from + k) * 10 }));
    const results = await run(boss, variants, { seeds: seedsPerRound, maxSec: screenSec, onProgress: progress(`${label} ${from}/${roundList.length}`) });
    results.forEach((r, k) => {
      for (const s of part[k]) {
        const i = r.summary.members.findIndex((m) => m.name === s.character);
        scored.push({ ...s, gain: Math.round(mean(r.fights.map((f) => memberOutput(f.members[i]))) - stats.mean.get(s.character)), noise: Math.round(stats.sd.get(s.character)) });
      }
    });
  }
  return scored;
}

// Stage one: one fight per candidate. Stage two: the best few candidates of each member, by their change
// against the member's own spread, again in fresh fights. A candidate's score is the mean over all its fights,
// which takes back the luck that put it near the top of 92 draws.
log(`screen: ${rounds.length} probe fights of ${screenSec} s, one candidate per member each`);
const stageOne = await probe(rounds, { seedStart: 1000, seedsPerRound: 1, label: "screen" });
log(`screen done: ${stageOne.length} of ${kept.length} candidates probed`);
const CONFIRM_PER_MEMBER = 4;
const CONFIRM_SEEDS = 2;
const byMember = new Map();
for (const s of stageOne.filter((s) => s.gain > 0)) (byMember.get(s.character) ?? byMember.set(s.character, []).get(s.character)).push(s);
const finalists = [...byMember.values()].flatMap((list) => list.sort((a, b) => b.gain / Math.max(1, b.noise) - a.gain / Math.max(1, a.noise)).slice(0, CONFIRM_PER_MEMBER));
const stageTwo = await probe(probeRounds(finalists), { seedStart: 3000, seedsPerRound: CONFIRM_SEEDS, label: "confirm" });
const firstGain = new Map(stageOne.map((s) => [key(s), s.gain]));
const confirmed = stageTwo.map((s) => ({ ...s, gain1: firstGain.get(key(s)), gain2: s.gain, screen: Math.round((firstGain.get(key(s)) + CONFIRM_SEEDS * s.gain) / (1 + CONFIRM_SEEDS)) }));
const ranked = confirmed.filter((s) => s.screen > 0).sort((a, b) => b.screen - a.screen);
log(`confirmed: ${confirmed.length} finalists, mean change ${Math.round(mean(confirmed.map((s) => s.gain1)))} in the first fight and ${Math.round(mean(confirmed.map((s) => s.gain2)))} in the confirming fights, ${ranked.length} still positive`);

// ---- Search -------------------------------------------------------------------------------------------------
const fullSeconds = (baseline.fights.reduce((t, f) => t + f.wallMs, 0) / baseline.fights.length / 1000 / jobs) * seeds;
const roundsLog = [];
let kit = [];
let current = baseline;
let remaining = [...ranked];
let misses = 0;
const used = new Set();
const tried = new Set();
const write = (extra = {}) => {
  const doc = {
    boss: bossInfo,
    baseline: brief(baseline.summary),
    outcome: brief(current.summary),
    swaps: kit,
    rounds: roundsLog,
    params: { seeds, seedBase, maxSec, screenSec, screenSeeds, margin: marginFactor, dpsMode, healMode, leader, client: client.id, members: entries.length },
    candidates: { all: all.length, undominated: kept.length, probed: stageOne.length, confirmed: confirmed.length, positive: ranked.length },
    confirmed: confirmed.map((s) => ({ character: s.character, slot: s.slot, itemId: s.itemId, name: s.name, firstFight: s.gain1, confirmingFights: s.gain2, score: s.screen, noise: s.noise })),
    generatedAt: new Date().toISOString(),
    wallMinutes: Math.round((Date.now() - started) / 600) / 100,
    ...extra,
  };
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`);
};

let guard = cloneState(state);

while (remaining.length && misses < 3) {
  let batch = buildBatch(guard, kit, remaining);
  if (!batch.length) break;
  const original = batch;
  let accepted = false;
  while (batch.length && misses < 3) {
    if (Date.now() + fullSeconds * 1000 > deadline) {
      log("budget used, no further evaluation starts");
      remaining = [];
      break;
    }
    const [trial] = await run(boss, [{ label: `round ${roundsLog.length + 1}`, entries: withSwaps(entries, [...kit, ...batch]) }], { onProgress: progress(`round ${roundsLog.length + 1}, ${batch.length} swaps`) });
    const margin = margins(current.fights, marginFactor);
    const ok = improves(current.summary, trial.summary, margin);
    log(`round ${roundsLog.length + 1}: ${batch.length} swaps, ${describe(trial.summary)}, ${ok ? "accepted" : "rejected"}`);
    if (ok) {
      const delta = outcomeDelta(current.summary, trial.summary);
      for (const s of batch) {
        const holder = applySwap(guard, s);
        kit.push({ character: s.character, slot: s.slot, itemId: s.itemId, name: s.name, from: holder, replaces: s.from === null ? null : { itemId: s.from, name: s.fromName }, gain: { screen: s.screen, round: roundsLog.length + 1, outcome: delta } });
        used.add(key(s));
      }
      roundsLog.push({ swaps: batch.length, outcome: brief(trial.summary), delta });
      current = trial;
      misses = 0;
      accepted = true;
      write();
      break;
    }
    misses++;
    roundsLog.push({ swaps: batch.length, rejected: true, outcome: brief(trial.summary), delta: outcomeDelta(current.summary, trial.summary) });
    batch = batch.slice(0, Math.floor(batch.length / 2));
  }
  if (!accepted) for (const s of original) tried.add(key(s));
  remaining = remaining.filter((s) => !used.has(key(s)) && !tried.has(key(s)));
}

// ---- Agreement of the screen with full fights ---------------------------------------------------------------
let validation = null;
if (flag("validate")) {
  log("validation: the screen against itself and against full fights");
  // The first stage's candidates probed again with other seeds: how much of a one-fight change is chance.
  const again = await probe(rounds.slice(0, Math.max(jobs * 4, 8)), { seedStart: 5000, seedsPerRound: 1, label: "repeat screen" });
  const first = new Map(stageOne.map((s) => [key(s), s.gain]));
  const pairs = again.filter((s) => first.has(key(s)));
  // The best (confirmed) and the worst swap of each member as bundles of the same size: full fights should
  // order them the way the screen did (best bundle, baseline, worst bundle).
  const top = buildBatch(state, [], ranked);
  const bottom = buildBatch(state, [], [...stageOne].sort((a, b) => a.gain - b.gain));
  const [t, b] = await run(boss, [{ label: "best bundle", entries: withSwaps(entries, top) }, { label: "worst bundle", entries: withSwaps(entries, bottom) }], { onProgress: progress("validation") });
  validation = {
    // Rank agreement of two single-fight screens of the same swaps.
    screenRepeat: { swaps: pairs.length, spearman: spearman(pairs.map((s) => first.get(key(s))), pairs.map((s) => s.gain)) },
    // The confirmed swaps' mean change in their first fight and in the confirming fights: the gap is the chance the selection picked up.
    selection: { swaps: confirmed.length, firstFightMean: Math.round(mean(confirmed.map((s) => s.gain1))), confirmingMean: Math.round(mean(confirmed.map((s) => s.gain2))) },
    bundles: {
      size: { best: top.length, worst: bottom.length },
      predictedScreenSum: { best: Math.round(top.reduce((a, s) => a + s.screen, 0)), worst: Math.round(bottom.reduce((a, s) => a + s.gain, 0)) },
      baseline: brief(baseline.summary),
      best: brief(t.summary),
      worst: brief(b.summary),
      orderAgrees: t.summary.bossHpLeftMean < baseline.summary.bossHpLeftMean && baseline.summary.bossHpLeftMean < b.summary.bossHpLeftMean,
    },
  };
  log(`validation: screen repeat spearman ${validation.screenRepeat.spearman?.toFixed(2)} over ${pairs.length} swaps; boss hit points left best ${t.summary.bossHpLeftMean}, baseline ${baseline.summary.bossHpLeftMean}, worst ${b.summary.bossHpLeftMean}`);
}

write({ validation });

// ---- Report --------------------------------------------------------------------------------------------------
const pad = (v, w) => String(v ?? "-").padEnd(w);
console.log(`${bossInfo.name} (npc ${bossInfo.id}): baseline ${describe(baseline.summary)}`);
console.log(`Kit: ${kit.length} swaps, ${describe(current.summary)}\n`);
if (kit.length) {
  console.log([pad("Character", 14), pad("Class", 13), pad("Slot", 10), pad("Item", 34), pad("Replaces", 34), pad("From", 14), "Screen"].join(" "));
  for (const s of kit) console.log([pad(s.character, 14), pad(state.people.get(s.character).cls, 13), pad(SLOT_BY_NUM[s.slot], 10), pad(s.name, 34), pad(s.replaces?.name, 34), pad(s.from === s.character ? "own bags" : s.from, 14), s.gain.screen].join(" "));
}
console.log(`\nWritten to ${out}; ${((Date.now() - started) / 60000).toFixed(1)} minutes.`);
process.exit(0);
