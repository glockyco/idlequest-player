#!/usr/bin/env bun
// Saves the client the site serves right now, and reports what changed between two saved clients.
//
//   bun tools/client-snapshot.mjs [--force]        download the live client to .re/releases/<release>/
//   bun tools/client-snapshot.mjs --latest         print the release the site serves and whether it is saved
//   bun tools/client-snapshot.mjs --diff OLD NEW [--top 25]
//                                                  OLD and NEW are release ids or directories (.re/js works)
//
// A snapshot holds every /assets/*.js file reachable from https://idlequest.net/play (script and
// modulepreload tags, then every `./x.js`, `assets/x.js` and `/assets/x.js` reference inside the
// files that were fetched, and `spells-*.json`), a manifest.json with file, bytes and sha256, and
// pretty/ with prettier-formatted copies for reading. The release id is the one `window.iq.release`
// reports in the page (`CLIENT_SURFACE.releaseId` in src/bridge.js). A release that is already
// saved is not downloaded again.
//
// The diff compares what survives minification: string literals, enum members (option ids,
// opcode names), arrow-function properties (store actions) and zone audio names. Chunk names are
// hashes, so files are reported by size and by their readable stem.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadSurface } from "./check-client.mjs";

const repo = new URL("../", import.meta.url).pathname;
const releases = join(repo, ".re/releases");
const BASE = process.env.IQ_BASE ?? "https://idlequest.net";

// Returns null for a missing file. The site answers an unknown /assets path with its HTML page.
async function get(url, tries = 3) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url, { headers: { "cache-control": "no-cache" } });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      if (url.includes("/assets/") && (res.headers.get("content-type") ?? "").includes("text/html")) return null;
      return Buffer.from(await res.arrayBuffer());
    } catch (e) {
      if (i >= tries) throw new Error(`${url}: ${e.message}`);
      await new Promise((r) => setTimeout(r, 500 * i));
    }
  }
}

/** The release id of the client the site serves, from its HTML alone. */
async function liveRelease() {
  const surface = await loadSurface();
  const html = (await get(`${BASE}/play`)).toString("utf8");
  const clientRelease = surface.buildTag(html);
  const entry = surface.assetNames(surface.declaredInHtml(html));
  if (!clientRelease || !entry.length) throw new Error("the play page has no Build comment or module script; the client page changed shape");
  return { html, clientRelease, entry, id: surface.releaseId(clientRelease, entry) };
}

const REF_JS = /(?:assets\/|\.\/|\/assets\/)([A-Za-z0-9_-]+\.js)\b/g;
const REF_JSON = /\/assets\/([A-Za-z0-9_.-]+\.json)\b/g;

async function snapshot(force) {
  const live = await liveRelease();
  const dir = join(releases, live.id);
  if (existsSync(join(dir, "manifest.json")) && !force) {
    console.log(`already saved: ${dir}`);
    console.log(`release ${live.id}`);
    return;
  }
  const part = join(releases, `.${live.id}.partial`);
  await rm(part, { recursive: true, force: true });
  await mkdir(part, { recursive: true });
  await writeFile(join(part, "play.html"), live.html);

  const seen = new Set();
  const queue = [];
  const add = (name) => {
    if (!seen.has(name)) {
      seen.add(name);
      queue.push(name);
    }
  };
  for (const m of live.html.matchAll(/\/assets\/([A-Za-z0-9_.-]+\.js)\b/g)) add(m[1]);
  const files = [];
  const absent = [];
  const worker = async () => {
    for (let name; (name = queue.shift()); ) {
      const body = await get(`${BASE}/assets/${name}`);
      if (!body) {
        absent.push(name);
        continue;
      }
      await writeFile(join(part, name), body);
      files.push({ file: name, bytes: body.length, sha256: createHash("sha256").update(body).digest("hex") });
      const text = body.toString("utf8");
      for (const m of text.matchAll(REF_JS)) add(m[1]);
      for (const m of text.matchAll(REF_JSON)) add(m[1]);
    }
  };
  // Each worker stops when the queue is empty, so run rounds until a round fetches nothing new.
  do await Promise.all(Array.from({ length: 8 }, worker));
  while (queue.length);
  files.sort((a, b) => a.file.localeCompare(b.file));
  await writeFile(
    join(part, "manifest.json"),
    `${JSON.stringify({ release: live.id, clientRelease: live.clientRelease, entry: live.entry, fetchedAt: new Date().toISOString(), url: `${BASE}/play`, notFound: absent.sort(), files }, null, 2)}\n`,
  );
  await pretty(part, files.filter((f) => f.file.endsWith(".js")).map((f) => f.file));
  await rm(dir, { recursive: true, force: true });
  await rename(part, dir);
  console.log(`saved ${files.length} files (${(files.reduce((a, f) => a + f.bytes, 0) / 1048576).toFixed(1)} MB) to ${dir}; ${absent.length} references returned 404`);
  console.log(`release ${live.id}`);
}

/** Formatted copies in pretty/, with the prettier of .re/node_modules or `bunx prettier`. `.re/` is gitignored, so the ignore file must not apply. */
async function pretty(dir, names) {
  const out = join(dir, "pretty");
  await mkdir(out, { recursive: true });
  for (const n of names) await writeFile(join(out, n), await readFile(join(dir, n)));
  const local = join(repo, ".re/node_modules/prettier/bin/prettier.cjs");
  const cmd = existsSync(local) ? [process.execPath, local] : ["bunx", "prettier"];
  const run = Bun.spawn([...cmd, "--write", "--log-level", "warn", "--no-config", "--ignore-path", "/dev/null", join(out, "*.js")], { stdout: "inherit", stderr: "inherit", cwd: repo });
  const code = await run.exited;
  if (code !== 0) console.log(`prettier exited with ${code}; pretty/ holds unformatted copies for the files it could not parse`);
}

// ---------------------------------------------------------------- diff
function locate(arg) {
  for (const c of [resolve(arg), join(releases, arg)]) if (existsSync(c)) return c;
  throw new Error(`no release or directory ${arg}`);
}

const ENUM_RE = /\[\w+\.([A-Za-z_]\w*)=(-?\d+)\]="\1"/g;
// `name: (args) => ...` and `name: async x => ...` as object properties, which is how the stores declare actions.
const ARROW_RE = /[,{]\s*([a-z][A-Za-z0-9]{3,}):\s*(?:async\s*)?(?:\([^()]*\)|[A-Za-z_$][\w$]*)\s*=>/g;
const MP3_RE = /\b([a-z][a-z0-9]{2,})_\d+\.mp3\b/g;
const HASHED_FILE = /^(?:\.\/|\/?assets\/)?[A-Za-z0-9_-]+\.(?:js|css)$/;
// Stylesheet and shader source in template literals, which is not text a player reads.
const CODE_TEXT = /\n|#if|#endif|gl_|uniform |;.*;/;

const WORD_BEFORE_REGEX = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await"]);

/**
 * Calls `emit(kind, text)` for every string literal (`"str"`) and template literal (`"tpl"`, with
 * each `${...}` replaced by `${}`) in minified JavaScript. A regex literal, a comment or a quote
 * inside a template would confuse a plain pattern, so this follows the token stream: a `/` starts
 * a regex only where an expression can start, and template expressions are scanned as code.
 */
function scanStrings(text, emit) {
  const n = text.length;
  const templates = []; // open templates: { buf, depth } with the brace depth of the open `${`
  let depth = 0;
  let regexOk = true;
  let i = 0;
  const readTemplate = (t, from) => {
    let j = from;
    while (j < n) {
      const ch = text.charCodeAt(j);
      if (ch === 92) {
        t.buf += text.slice(j, j + 2);
        j += 2;
      } else if (ch === 96) {
        emit("tpl", t.buf);
        templates.pop();
        regexOk = false;
        return j + 1;
      } else if (ch === 36 && text.charCodeAt(j + 1) === 123) {
        t.buf += "${}";
        t.depth = depth;
        regexOk = true;
        return j + 2;
      } else {
        t.buf += text[j++];
      }
    }
    return n;
  };
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c <= 32) {
      i++;
    } else if (c === 47) {
      const d = text.charCodeAt(i + 1);
      if (d === 47) {
        const e = text.indexOf("\n", i);
        i = e < 0 ? n : e;
      } else if (d === 42) {
        const e = text.indexOf("*/", i + 2);
        i = e < 0 ? n : e + 2;
      } else if (regexOk) {
        let inClass = false;
        for (i++; i < n; i++) {
          const ch = text[i];
          if (ch === "\\") i++;
          else if (ch === "[") inClass = true;
          else if (ch === "]") inClass = false;
          else if (ch === "/" && !inClass) break;
          else if (ch === "\n") break;
        }
        i++;
        while (i < n && /[a-z]/i.test(text[i])) i++;
        regexOk = false;
      } else {
        i++;
        regexOk = true;
      }
    } else if (c === 34 || c === 39) {
      let j = i + 1;
      while (j < n && text.charCodeAt(j) !== c && text.charCodeAt(j) !== 10) j += text.charCodeAt(j) === 92 ? 2 : 1;
      emit("str", text.slice(i + 1, j));
      i = j + 1;
      regexOk = false;
    } else if (c === 96) {
      const t = { buf: "", depth: -1 };
      templates.push(t);
      i = readTemplate(t, i + 1);
    } else if (c === 123) {
      depth++;
      regexOk = true;
      i++;
    } else if (c === 125) {
      const t = templates.at(-1);
      if (t && depth === t.depth) {
        i = readTemplate(t, i + 1);
      } else {
        depth--;
        regexOk = false;
        i++;
      }
    } else if (/[A-Za-z_$\u0080-\uffff]/.test(text[i])) {
      let j = i + 1;
      while (j < n && /[\w$\u0080-\uffff]/.test(text[j])) j++;
      regexOk = WORD_BEFORE_REGEX.has(text.slice(i, j));
      i = j;
    } else if ((c >= 48 && c <= 57) || c === 41 || c === 93) {
      // A number, `)` or `]` ends an expression, so a following `/` divides.
      if (c >= 48 && c <= 57) while (i < n && /[\w.]/.test(text[i])) i++;
      else i++;
      regexOk = false;
    } else {
      i++;
      regexOk = true;
    }
  }
}

async function harvest(dir) {
  const names = (await readdir(dir)).filter((f) => f.endsWith(".js") && !f.endsWith(".pretty.js"));
  const strings = new Set();
  const templates = new Set();
  const enums = new Map();
  const actions = new Set();
  const audio = new Set();
  const sizes = new Map();
  const perFile = new Map();
  for (const f of names) {
    const text = await readFile(join(dir, f), "utf8");
    sizes.set(f, text.length);
    const own = new Set();
    perFile.set(f, own);
    scanStrings(text, (kind, raw) => {
      const tpl = kind === "tpl";
      const s = raw.replace(/\\(["'`\\])/g, "$1");
      if (s.length < 12 || HASHED_FILE.test(s) || /^[A-Za-z0-9+/=_-]{40,}$/.test(s) || s.startsWith("data:") || CODE_TEXT.test(s)) return;
      own.add(s);
      (tpl && s.includes("${}") ? templates : strings).add(s);
    });
    for (const m of text.matchAll(ENUM_RE)) enums.set(m[1], m[2]);
    // Only the files with zustand stores: the 3D engine has thousands of arrow properties of its own.
    if (text.includes(".getState()")) for (const m of text.matchAll(ARROW_RE)) if (!/^on[A-Z]/.test(m[1])) actions.add(m[1]);
    for (const m of text.matchAll(MP3_RE)) audio.add(m[1]);
  }
  return { names, sizes, perFile, strings, templates, enums, actions, audio };
}

const stem = (f) => (/^(.+?)[-.][A-Za-z0-9_-]{8}\.js$/.exec(f)?.[1] ?? null);
const kb = (n) => `${(n / 1024).toFixed(n > 10240 ? 0 : 1)} KB`;

async function diff(oldArg, newArg, top) {
  const oldDir = locate(oldArg);
  const newDir = locate(newArg);
  const a = await harvest(oldDir);
  const b = await harvest(newDir);
  const section = (title, lines, extra = "") => {
    console.log(`\n${title} (${lines.length})${extra}`);
    for (const l of lines.slice(0, top)) console.log(`  ${l}`);
    if (lines.length > top) console.log(`  ... ${lines.length - top} more`);
  };
  const added = (x, y) => [...y].filter((s) => !x.has(s));
  const clip = (s) => JSON.stringify(s.length > 140 ? `${s.slice(0, 137)}...` : s);
  // Longest first within a category, because short strings are mostly fragments.
  const byLen = (l) => l.sort((p, q) => q.length - p.length || (p < q ? -1 : 1));

  console.log(`old ${oldDir}\nnew ${newDir}`);
  console.log(`old has ${a.names.length} bundles, new has ${b.names.length}${b.names.length > a.names.length * 1.5 ? ": strings of bundles the old snapshot lacks count as added" : ""}`);

  // Files
  const oldSet = new Set(a.names);
  const newSet = new Set(b.names);
  const fileAdded = b.names.filter((f) => !oldSet.has(f));
  const fileRemoved = a.names.filter((f) => !newSet.has(f));
  section("Files added", fileAdded.sort((p, q) => b.sizes.get(q) - b.sizes.get(p)).map((f) => `${f} ${kb(b.sizes.get(f))}${stem(f) ? ` (${stem(f)})` : ""}`));
  section("Files removed", fileRemoved.sort((p, q) => a.sizes.get(q) - a.sizes.get(p)).map((f) => `${f} ${kb(a.sizes.get(f))}${stem(f) ? ` (${stem(f)})` : ""}`));
  const renamed = fileAdded.map((f) => [f, fileRemoved.find((g) => stem(g) && stem(g) === stem(f))]).filter(([, g]) => g);
  if (renamed.length) section("Named files that changed hash", renamed.map(([f, g]) => `${stem(f)}: ${g} ${kb(a.sizes.get(g))} -> ${f} ${kb(b.sizes.get(f))}`));
  // A bundle whose name changed is matched to the new file that keeps most of its strings.
  const successors = [];
  for (const g of fileRemoved) {
    const old = a.perFile.get(g);
    if (old.size < 20) continue;
    let best = null;
    for (const f of fileAdded) {
      let hit = 0;
      for (const s of old) if (b.perFile.get(f).has(s)) hit++;
      if (!best || hit > best.hit) best = { f, hit };
    }
    if (best && best.hit / old.size >= 0.5) successors.push(`${g} ${kb(a.sizes.get(g))} -> ${best.f} ${kb(b.sizes.get(best.f))}, ${Math.round((100 * best.hit) / old.size)}% of its ${old.size} strings kept`);
  }
  section("Bundles that carry over under a new name", successors);

  // Enum members: option ids, opcodes, kinds
  const enumLines = [];
  for (const [k, v] of b.enums) if (!a.enums.has(k)) enumLines.push(`+ ${k} = ${v}`);
  for (const [k, v] of a.enums) if (!b.enums.has(k)) enumLines.push(`- ${k} = ${v}`);
  for (const [k, v] of b.enums) if (a.enums.has(k) && a.enums.get(k) !== v) enumLines.push(`~ ${k}: ${a.enums.get(k)} -> ${v}`);
  section("Enum members (option ids, opcode names, kinds)", enumLines);

  // Store actions
  section("Added action names (arrow-function properties, e.g. store actions)", added(a.actions, b.actions).sort().map((s) => `+ ${s}`));
  section("Removed action names", added(b.actions, a.actions).sort().map((s) => `- ${s}`));

  // Zones
  const zoneNames = Object.keys(JSON.parse(await readFile(join(repo, "data/idlequest-zones.json"), "utf8")));
  const mentions = (h) => new Set(zoneNames.filter((z) => [...h.strings, ...h.templates].some((s) => s.includes(z))));
  const zoneLines = [
    ...added(a.audio, b.audio).sort().map((s) => `+ zone audio ${s}`),
    ...added(b.audio, a.audio).sort().map((s) => `- zone audio ${s}`),
    ...added(mentions(a), mentions(b)).map((s) => `+ text mentions ${s}`),
    ...added(mentions(b), mentions(a)).map((s) => `- text mentions ${s}`),
  ];
  section("Zone names (audio file stems, known zone names inside strings)", zoneLines);

  // Strings
  const wordy = (s) => /\s/.test(s) && /[A-Za-z]{3}/.test(s);
  const newStrings = added(a.strings, b.strings);
  const goneStrings = added(b.strings, a.strings);
  section("Message templates added (template literals with ${})", byLen(added(a.templates, b.templates)).map((s) => `+ ${clip(s)}`));
  section("Message templates removed", byLen(added(b.templates, a.templates)).map((s) => `- ${clip(s)}`));
  section("Text added (strings with spaces, 12+ characters)", byLen(newStrings.filter(wordy)).map((s) => `+ ${clip(s)}`));
  section("Text removed", byLen(goneStrings.filter(wordy)).map((s) => `- ${clip(s)}`));
  section("Identifier-like strings added (keys, ids, event names, paths)", byLen(newStrings.filter((s) => !wordy(s))).map((s) => `+ ${clip(s)}`));
  section("Identifier-like strings removed", byLen(goneStrings.filter((s) => !wordy(s))).map((s) => `- ${clip(s)}`));
}

const args = process.argv.slice(2);
if (args[0] === "--diff") {
  const top = Number(args[args.indexOf("--top") + 1]) || 25;
  const dirs = args.slice(1).filter((x, i, l) => !x.startsWith("--") && l[i - 1] !== "--top");
  if (dirs.length !== 2) throw new Error("usage: client-snapshot.mjs --diff OLD NEW [--top N]");
  await diff(dirs[0], dirs[1], top);
} else if (args[0] === "--latest") {
  const live = await liveRelease();
  console.log(`${existsSync(join(releases, live.id, "manifest.json")) ? "saved" : "not saved"}: release ${live.id}`);
} else {
  await snapshot(args.includes("--force"));
}
process.exit(0);
