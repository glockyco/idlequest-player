// Builds data/class-spells.json: the spells the game client auto-casts for each class, with the
// facts the bot's gem plan needs.
//
//   bun tools/class-spells.mjs [--chunk <client chunk>] [--content <repo dir>] [--out <file>]
//
// The leader casts only spells in the client's static per-class table, and only while they are
// memorized. The table is a function of the class id in the client's BQ chunk. Its minified name
// changes with every client build, so the tool finds it by what it returns: a short function whose
// result for the Magician (13) lists spell 1505. The tool fails when no function, or more than one,
// matches. The client chunk needs the browser globals that @happy-dom/global-registrator provides.
//
// Defaults: the chunk is .re/js/BQ.pretty.js in this repository, the content snapshot is
// $IQ_CONTENT or ~/src/github.com/brynnb/idlequest-content. The facts come from its spells_new
// table: name, mana, cast and recast time, hit point effect, duration and reagents.
//
// Output, keyed by class id 1-14: null for a class with no table (Warrior, Monk, Rogue), else the
// client's fields (manaReservePercent, isHybrid, healThreshold, aggroMultiplier) and `spells`, one
// row per table entry with its client fields (spellId, category, minLevel, targetType) and facts:
//   hp         first effect when it changes hit points: negative damage, positive heal; the cap
//              (max1) when the spell has one, else the base value
//   durationTicks  buff or DoT duration in 6 s ticks, 0 for an instant spell
//   skill      the casting skill, for Bards the instrument family (docs/client-internals.md)
//   reagents   [{ id, count }] consumed per cast
//   tags       control effects of a harmful spell, by the client's own tests (main.pretty.js, the
//              slow/mez/stun/snare tagger): slow (SPA 11 below 100), mez (31), stun (21), snare
//              (SPA 3 below 0), root (99), fear (23), charm (22)
//   contentLevel   the class's level for the spell in spells_new, which must equal minLevel
import { readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const repo = new URL("..", import.meta.url).pathname;
const chunk = resolve(opt("chunk", `${repo}.re/js/BQ.pretty.js`));
const content = opt("content", process.env.IQ_CONTENT ?? `${homedir()}/src/github.com/brynnb/idlequest-content`);
const out = resolve(opt("out", `${repo}data/class-spells.json`));
const CLASS_IDS = Array.from({ length: 14 }, (_, k) => k + 1);

const fail = (message) => {
  console.error(`class-spells: ${message}`);
  process.exit(1);
};

// Find the per-class table function among the chunk's exports. Only short one-argument functions
// are called, because the bundle also exports functions that do real work.
async function findTable() {
  GlobalRegistrator.register({ url: "https://idlequest.net/play" });
  const mod = await import(chunk);
  const found = [];
  for (const [name, f] of Object.entries(mod)) {
    if (typeof f !== "function" || f.length !== 1 || f.toString().length > 300) continue;
    try {
      if (f(13)?.spells?.some?.((s) => s.spellId === 1505)) found.push([name, f]);
    } catch {
      // Not the table.
    }
  }
  if (found.length !== 1) fail(`expected one table function in ${chunk} (the one whose Magician spells hold 1505), found ${found.length}: ${found.map(([n]) => n).join(", ")}`);
  return found[0];
}

const [tableName, table] = await findTable();
const tables = new Map();
for (const id of CLASS_IDS) {
  const t = table(id);
  if (t == null) {
    tables.set(id, null);
    continue;
  }
  if (!Array.isArray(t.spells) || !t.spells.length) fail(`class ${id}: table function ${tableName} returned no spell list`);
  for (const s of t.spells) {
    for (const k of ["spellId", "category", "minLevel", "targetType"]) {
      if (!Number.isInteger(s[k])) fail(`class ${id}: spell row ${JSON.stringify(s)} has no integer ${k}`);
    }
  }
  tables.set(id, t);
}
if ([...tables.values()].filter(Boolean).length < 11) fail(`only ${[...tables.values()].filter(Boolean).length} classes have a table, expected 11`);

// spells_new facts for the table's spell ids.
const wanted = new Set([...tables.values()].filter(Boolean).flatMap((t) => t.spells.map((s) => s.spellId)));
const spellDir = `${content}/data/spells_new`;
let files;
try {
  files = (await readdir(spellDir)).filter((f) => f.endsWith(".ndjson")).sort();
} catch {
  fail(`cannot read ${spellDir}; pass --content <idlequest-content dir> or set IQ_CONTENT`);
}
const records = new Map();
for (const f of files) {
  for (const line of (await readFile(`${spellDir}/${f}`, "utf8")).split("\n")) {
    const id = Number(/^\{"id":(\d+),/.exec(line)?.[1]);
    if (wanted.has(id)) records.set(id, JSON.parse(line));
  }
}
const missing = [...wanted].filter((id) => !records.has(id));
if (missing.length) fail(`spells_new has no record for ${missing.length} table spells: ${missing.join(", ")}`);

// The effect slots hold SPA numbers, with 254 for an empty slot.
const controlTags = (r) => {
  if (r.goodEffect) return [];
  const tags = new Set();
  for (let k = 1; k <= 12; k++) {
    const spa = r[`effectid${k}`];
    const base = r[`effect_base_value${k}`];
    if (spa === 11 && base < 100) tags.add("slow");
    else if (spa === 31) tags.add("mez");
    else if (spa === 21) tags.add("stun");
    else if (spa === 3 && base < 0) tags.add("snare");
    else if (spa === 99) tags.add("root");
    else if (spa === 23) tags.add("fear");
    else if (spa === 22) tags.add("charm");
  }
  return [...tags].sort();
};

const facts = (r, classId) => {
  const base = r.effect_base_value1;
  const hitPoints = r.effectid1 === 0 && base !== 0;
  const reagents = [];
  for (let k = 1; k <= 4; k++) {
    const id = r[`components${k}`];
    if (id > 0) reagents.push({ id, count: Math.max(1, r[`component_counts${k}`] ?? 1) });
  }
  return {
    name: r.name,
    mana: r.mana,
    castMs: r.cast_time,
    recastMs: r.recast_time,
    hp: hitPoints ? Math.sign(base) * (r.max1 || Math.abs(base)) : 0,
    durationTicks: r.buffduration,
    skill: r.skill,
    reagents,
    tags: controlTags(r),
    contentLevel: r[`classes${classId}`],
  };
};

const classes = {};
const mismatched = [];
for (const [classId, t] of tables) {
  if (!t) {
    classes[classId] = null;
    continue;
  }
  classes[classId] = {
    manaReservePercent: t.manaReservePercent,
    isHybrid: t.isHybrid,
    healThreshold: t.healThreshold,
    aggroMultiplier: t.aggroMultiplier,
    spells: t.spells.map((s) => {
      const row = { spellId: s.spellId, category: s.category, minLevel: s.minLevel, targetType: s.targetType, ...facts(records.get(s.spellId), classId) };
      if (row.contentLevel !== row.minLevel) mismatched.push(`class ${classId} spell ${row.spellId} ${row.name}: table L${row.minLevel}, spells_new L${row.contentLevel}`);
      return row;
    }),
  };
}

// One spell row per line keeps the file readable and its diffs small.
const text = `{\n${Object.entries(classes)
  .map(([id, c]) => {
    if (!c) return `  "${id}": null`;
    const { spells, ...fields } = c;
    return `  "${id}": {\n    ${Object.entries(fields)
      .map(([k, v]) => `"${k}": ${JSON.stringify(v)}`)
      .join(",\n    ")},\n    "spells": [\n${spells.map((s) => `      ${JSON.stringify(s)}`).join(",\n")}\n    ]\n  }`;
  })
  .join(",\n")}\n}\n`;
await writeFile(out, text);
console.log(`${tableName}: ${Object.values(classes).filter(Boolean).length} class tables, ${wanted.size} spells, written to ${out}`);
if (mismatched.length) console.warn(`${mismatched.length} rows where the table level differs from spells_new:\n${mismatched.join("\n")}`);
process.exit(0);
