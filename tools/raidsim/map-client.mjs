// Writes the clients.mjs table for a saved release, and lists what changed in the code the
// simulator runs.
//
//   bun tools/raidsim/map-client.mjs <release id> [--from <release id|legacy>]
//
// Minification renames bindings but keeps the code, so a name in the `--from` table (default
// "legacy") is found in the release by its declaration and the lines after it with every short
// identifier masked. A function whose masked body differs between the two builds is listed: the
// release changed code that a fight runs, and a roster result may differ from the --from build.
// Prints the table entry to paste into clients.mjs. Needs the prettified copies (`pretty/` in a
// release, `*.pretty.js` in .re/js).
import { readFile } from "node:fs/promises";
import { CLIENTS } from "./clients.mjs";

const repo = new URL("../../", import.meta.url).pathname;
const args = process.argv.slice(2);
const fromAt = args.indexOf("--from");
const from = fromAt >= 0 ? args[fromAt + 1] : "legacy";
const release = args.filter((a, i) => !a.startsWith("--") && (fromAt < 0 || i !== fromAt + 1))[0];
if (!release) {
  console.error("usage: bun tools/raidsim/map-client.mjs <release id> [--from <release id|legacy>]");
  process.exit(1);
}

// Pretty copies of the three bundles of a build.
async function prettyFiles(id, files) {
  const read = async (role, legacy) => (await readFile(id === "legacy" ? `${repo}.re/js/${legacy}.pretty.js` : `${repo}.re/releases/${id}/pretty/${files[role]}`, "utf8")).split("\n");
  return { main: await read("main", "main"), bq: await read("bq", "BQ"), engine: await read("engine", "engine") };
}

const KEYWORDS = new Set("if for new let var try do in else case this null void true false typeof delete throw while break const class super await async yield return switch default export import static function continue".split(" "));
const mask = (text) => text.replace(/[A-Za-z_$][A-Za-z0-9_$]*/g, (w) => (w.length <= 3 && !KEYWORDS.has(w) ? "_" : w)).replace(/\s+/g, " ");
const escape = (name) => name.replace(/\$/g, "\\$");
const declaration = (name) => new RegExp(`^ {0,2}(?:(?:async )?function ${escape(name)}\\(|(?:const|let|var) ${escape(name)}\\b|class ${escape(name)}\\b|${escape(name)} = )`);
const WINDOW = 7;

// The declaration of `name` to the line that closes it (the next line at the same indent that
// starts with a closer), at most 400 lines.
function body(lines, start) {
  const indent = lines[start].match(/^ */)[0].length;
  let end = start;
  while (end < lines.length - 1 && end - start < 400) {
    end++;
    if (lines[end].match(/^ */)[0].length <= indent && /^\s*[})\]]/.test(lines[end])) break;
  }
  return lines.slice(start, end + 1).join("\n");
}

// A release without a table: its entry file is main, the others are found by what they define.
async function bundleFiles(id) {
  const dir = `${repo}.re/releases/${id}/`;
  const manifest = JSON.parse(await readFile(`${dir}manifest.json`, "utf8"));
  const find = async (needle, not) => {
    for (const { file } of manifest.files) {
      if (!file.endsWith(".js") || not.includes(file)) continue;
      if ((await readFile(`${dir}${file}`, "utf8")).includes(needle)) return file;
    }
    throw new Error(`no file in ${id} holds ${needle}`);
  };
  const main = manifest.entry[0];
  const engine = await find("beginCombatForTarget", [main]);
  const bq = await find("applyRaidHeal", [main, engine]);
  return { main, bq, engine };
}

const baseClient = CLIENTS[from];
if (!baseClient) throw new Error(`no table for ${from}`);
const base = { client: baseClient, lines: await prettyFiles(from, baseClient.files) };
const targetFiles = CLIENTS[release]?.files ?? (await bundleFiles(release));
const target = { files: targetFiles, lines: await prettyFiles(release, targetFiles) };

const names = { main: {}, bq: {}, engine: {} };
const changed = [];
const missing = [];
const counted = { main: [], bq: [], engine: [] };

function find(role, name) {
  const old = base.lines[role];
  const at = old.findIndex((l) => declaration(name).test(l));
  if (at < 0) return { error: "not in the --from build" };
  const wanted = mask(old.slice(at, at + WINDOW).join("\n"));
  const hits = [];
  target.lines[role].forEach((line, i) => {
    if (/^ {0,2}(async function|function|const|let|var|class|[A-Za-z_$][\w$]* =)/.test(line) && mask(target.lines[role].slice(i, i + WINDOW).join("\n")) === wanted) hits.push(i);
  });
  if (!hits.length) return { error: "no match" };
  // Several declarations can open alike (small helpers): the one at the same relative position in
  // the file is taken.
  const expected = (at / old.length) * target.lines[role].length;
  const first = hits.reduce((a, b) => (Math.abs(b - expected) < Math.abs(a - expected) ? b : a));
  const declared = target.lines[role][first].replace(/^\s*(?:async )?(?:function |const |let |var |class )?/, "").match(/^[A-Za-z_$][\w$]*/)[0];
  return { name: declared, same: mask(body(old, at)) === mask(body(target.lines[role], first)), ambiguous: hits.length > 1 };
}

for (const role of ["main", "bq", "engine"]) {
  const wanted = [...Object.entries(base.client.names[role]), ...base.client.counted[role].map((n) => [null, n])];
  for (const [key, name] of wanted) {
    if (role === "engine" && (key === "runtime" || key === "raidStore")) continue; // imports, below
    const hit = find(role, name);
    if (hit.error) {
      missing.push(`${role}.${key ?? "counted"} ${name}: ${hit.error}`);
      continue;
    }
    if (key) names[role][key] = hit.name;
    else counted[role].push(hit.name);
    if (!hit.same) changed.push(`${role} ${name} -> ${hit.name}`);
    if (hit.ambiguous) missing.push(`${role} ${name} -> ${hit.name}: several matches, the one nearest the old position was taken`);
  }
}

// Bindings that are imports of the engine file (no declaration to match): found by how the code
// uses them.
const engineText = target.lines.engine.join("\n");
const importedAs = (pattern) => engineText.match(pattern)?.[1];
names.engine.runtime = importedAs(/([A-Za-z_$][\w$]*)\.bindScenePorts\(/);
names.engine.raidStore = importedAs(/([A-Za-z_$][\w$]*)\.setState\(\{ autoHealMode/);
for (const role of Object.keys(names)) names[role] = Object.fromEntries(Object.keys(base.client.names[role]).map((key) => [key, names[role][key]]));
console.log(JSON.stringify({ [release]: { dir: `.re/releases/${release}/`, files: target.files, names, counted } }, null, 2));
if (missing.length) console.error(`\nCheck by hand:\n  ${missing.join("\n  ")}`);
console.error(`\n${changed.length} of the matched functions changed between ${from} and ${release}${changed.length ? `:\n  ${changed.join("\n  ")}` : ""}`);
