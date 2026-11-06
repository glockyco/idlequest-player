// Rank hunting grounds for a character level from saved zone snapshots.
//
//   bun tools/zones.mjs <snapshot dir> --level 5 [--lo -2] [--hi 3] [--strong 4] [--json]
//
// Snapshots come from `scoutZones` (src/client.mjs). One visit per zone serves every level.
//
// Candidates are real monsters (no merchants, guildmasters or `#` named NPCs) whose level is in
// [level+lo, level+hi]. Per zone:
//   cand      number of candidates
//   nn        mean distance from a candidate to the nearest other candidate. Walking per kill is
//             roughly this, so lower is better. Toxxulia at level 5 is about 160.
//   near300   mean number of other candidates within 300 units
//   exposed   share of candidates with a monster of level >= level+strong within 70 units (aggro
//             radius plus a margin to join). Fighting those pulls something the party cannot beat.
//   arrival   monsters of level >= level+strong within 150 units of the safe point, where the
//             party arrives
import { readdir, readFile } from "node:fs/promises";

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith("--"));
const opt = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? Number(args[i + 1]) : d;
};
const level = opt("level", NaN);
if (!dir || Number.isNaN(level)) {
  console.error("usage: bun tools/zones.mjs <snapshot dir> --level N [--lo -2] [--hi 3] [--strong 4] [--all] [--json]");
  process.exit(2);
}
const lo = opt("lo", -2);
const hi = opt("hi", 3);
const strongGap = opt("strong", 4);
const LINK = 70;
const ARRIVAL = 150;

// Zones IdleQuest has, with their XP multipliers (from the wiki). Snapshots of other zones are skipped.
const norm = (s) => s.replace(/^the\s+/i, "").trim().toLowerCase();
const gameZones = new Map(Object.entries(JSON.parse(await readFile(new URL("../data/idlequest-zones.json", import.meta.url), "utf8"))).map(([k, v]) => [norm(k), v]));
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const rows = [];
for (const f of (await readdir(dir)).filter((f) => f.endsWith(".json"))) {
  const z = JSON.parse(await readFile(`${dir}/${f}`, "utf8"));
  const zem = gameZones.get(norm(z.zone));
  if (zem === undefined && !args.includes("--all")) continue; // not a zone IdleQuest has
  const defs = new Map(z.defs.map((d) => [d.id, d]));
  const mobs = z.spawns.filter((s) => {
    const d = defs.get(s.npcId);
    return d && d.cls < 20 && !d.merchant && !s.name.startsWith("#") && s.level > 0;
  });
  const cand = mobs.filter((s) => s.level >= level + lo && s.level <= level + hi);
  const strong = mobs.filter((s) => s.level >= level + strongGap);
  let nn = 0;
  let near = 0;
  let exposed = 0;
  for (const a of cand) {
    let best = Infinity;
    for (const b of cand) {
      if (a === b) continue;
      const d = dist(a, b);
      if (d < best) best = d;
      if (d <= 300) near++;
    }
    if (best < Infinity) nn += best;
    if (strong.some((s) => dist(a, s) <= LINK)) exposed++;
  }
  rows.push({
    zone: z.zone,
    zem: zem,
    cand: cand.length,
    nn: cand.length > 1 ? Math.round(nn / cand.length) : null,
    near300: cand.length ? +(near / cand.length).toFixed(1) : 0,
    exposed: cand.length ? +(exposed / cand.length).toFixed(2) : null,
    arrival: z.safe ? strong.filter((s) => dist(s, z.safe) <= ARRIVAL).length : null,
    levels: cand.length ? [Math.min(...cand.map((s) => s.level)), Math.max(...cand.map((s) => s.level))] : null,
  });
}
// Dense first among zones with enough targets; zones with no candidates sink.
rows.sort((a, b) => (a.cand < 10) - (b.cand < 10) || (a.nn ?? 1e9) - (b.nn ?? 1e9));

if (args.includes("--json")) console.log(JSON.stringify(rows, null, 2));
else {
  console.log(`Level ${level}, candidates ${level + lo}..${level + hi}, strong >= ${level + strongGap}\n`);
  console.log("zone".padEnd(32) + "zem".padStart(5) + "cand".padStart(5) + "nn".padStart(6) + "near300".padStart(9) + "exposed".padStart(9) + "arrival".padStart(9) + "  levels");
  for (const r of rows) {
    console.log(r.zone.padEnd(32) + String(r.zem ?? "-").padStart(5) + String(r.cand).padStart(5) + String(r.nn ?? "-").padStart(6) + String(r.near300).padStart(9) + String(r.exposed ?? "-").padStart(9) + String(r.arrival ?? "-").padStart(9) + "  " + JSON.stringify(r.levels));
  }
}
