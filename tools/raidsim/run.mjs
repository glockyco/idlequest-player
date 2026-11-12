// Runs seeded raid fights for variants of a roster and summarizes each variant. tools/raidsim.mjs
// is the command line on it, and tools/raid-kit.mjs calls it to compare gear.
import { compactSpells } from "./spells.mjs";
import { byId } from "./content.mjs";
import { DEFAULT_JOBS, runJobs } from "./pool.mjs";
import { normalizeEntries } from "./roster.mjs";
import { summarize } from "./report.mjs";

export const DPS_MODES = ["dps-balanced", "dps-all-out", "all-all-out"];
export const HEAL_MODES = ["clr-balanced", "all-balanced", "clr-all-out", "all-all-out", "off"];
// The fight model's version. Kill odds of another version are stale (tools/kill-odds.mjs), so a
// change to what a fight models raises it: 2 lets the boss's area spells reach the raid, 3 gives
// the boss the weapon proc of his spell list.
export const SIM_VERSION = 3;

let compact;

/**
 * Fights every variant of a roster against `boss` (`bossSpec` in boss.mjs), `seeds` fights each
 * with the seeds `seedBase` up (a variant's own `seedBase` wins). `variants`: `[{ label, entries, seedBase? }]`, roster entries as roster.mjs
 * takes them (`rosterEntries`), normalized here with `level`, `gear`, `farmHours` and `resolve`
 * (the options of `normalizeEntries`). `jobs` fights run at once, `onProgress(done, total)` hears
 * each finished fight, and `trace` is a member index or name whose first fight in the first variant
 * is traced. The client build comes from the RAIDSIM_CLIENT environment variable.
 * Returns `[{ label, roster, summary, fights }]` in the order of `variants`, `roster` being the
 * normalized members.
 */
export async function simulate({ boss, variants, level = 60, gear, farmHours, resolve, seeds = 20, seedBase = 1, maxSec = 900, dpsMode = "dps-all-out", healMode = "clr-balanced", jobs = DEFAULT_JOBS, onProgress, trace }) {
  const options = { gear, farmHours, resolve };
  const rosters = [];
  for (const v of variants) rosters.push(await normalizeEntries(v.entries, level, options));

  // Everything a worker needs from the content snapshot is in its job: one process per fight.
  compact ??= JSON.stringify(await compactSpells());
  const itemRows = await byId("items");
  const traceIndex = trace === undefined ? undefined : /^\d+$/.test(String(trace)) ? Number(trace) : rosters[0].findIndex((m) => m.name === trace);
  if (trace !== undefined && !rosters[0][traceIndex]) throw new Error(`no roster member ${JSON.stringify(trace)} to trace`);
  const queue = [];
  for (const [v, members] of rosters.entries()) {
    const items = {};
    for (const m of members) for (const id of Object.values(m.equipped)) items[id] ??= itemRows.get(id);
    for (let s = 0; s < seeds; s++) queue.push({ variant: v, job: { members, boss, items, compact, seed: (variants[v].seedBase ?? seedBase) + s, maxSec, dpsMode, healMode: healMode === "off" ? null : healMode, trace: v === 0 && s === 0 ? traceIndex : undefined } });
  }

  const fights = await runJobs(queue.map((q) => q.job), jobs, onProgress);
  return variants.map((v, i) => {
    const own = fights.filter((_, k) => queue[k].variant === i);
    return { label: v.label, roster: rosters[i], summary: summarize(own, maxSec), fights: own };
  });
}
