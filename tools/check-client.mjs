// Checks that a saved client release still has everything the SDK and the bot use.
//
//   bun tools/check-client.mjs [release dir]
//
// The release dir holds the bundles of one client (`.re/releases/<id>/`, written by
// tools/client-snapshot.mjs, or the older `.re/js/`). The default is the newest dir under
// `.re/releases/`. The bundles load under happy-dom and go through the same discovery the bridge
// runs in the page (`CLIENT_SURFACE` in src/bridge.js), so a FAIL here is a FAIL in the page.
// Exit code 1 when any part of the surface is missing.
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

const repo = new URL("../", import.meta.url).pathname;

/** The bridge's `CLIENT_SURFACE`, evaluated from its source. */
export async function loadSurface() {
  const src = await readFile(join(repo, "src/bridge.js"), "utf8");
  const block = /\/\/ BEGIN CLIENT_SURFACE\n([\s\S]*?)\n\s*\/\/ END CLIENT_SURFACE/.exec(src)?.[1];
  if (!block) throw new Error("src/bridge.js has no CLIENT_SURFACE block");
  return new Function(`${block}\nreturn CLIENT_SURFACE;`)();
}

/** The release string a bundle sends as `client_release`, found through the constant it names. */
export function clientReleaseOf(bundleText) {
  const name = /client_release:\s*([\w$]+)/.exec(bundleText)?.[1];
  if (!name) return null;
  const escaped = name.replace(/\$/g, "\\$");
  return new RegExp(`(?:^|[\\s,;(])${escaped}\\s*=\\s*"(\\d{4}-\\d\\d-\\d\\dT[^"]+Z)"`).exec(bundleText)?.[1] ?? null;
}

/** The newest directory under `.re/releases/`, or null. */
export async function newestRelease() {
  const root = join(repo, ".re/releases");
  const names = await readdir(root).catch(() => []);
  const dirs = [];
  for (const n of names) {
    const s = await stat(join(root, n));
    if (s.isDirectory()) dirs.push({ dir: join(root, n), t: s.mtimeMs });
  }
  return dirs.sort((a, b) => b.t - a.t)[0]?.dir ?? null;
}

/**
 * Loads the release's bundles under happy-dom and returns `{ mods, failed, files }`. The module
 * script of `play.html` loads first, so discovery sees modules in the order the page loads them.
 * A bundle that throws on load is listed in `failed` and skipped.
 */
export async function loadBundles(dirArg) {
  const dir = resolve(dirArg);
  const { GlobalRegistrator } = await import("@happy-dom/global-registrator");
  if (!globalThis.window) {
    GlobalRegistrator.register({
      url: "https://idlequest.net/play",
      settings: { disableCSSFileLoading: true, handleDisabledFileLoadingAsSuccess: true },
    });
  }
  // The page has Web Locks, happy-dom has not. One bundle takes a lock while it loads.
  if (!navigator.locks) Object.defineProperty(navigator, "locks", { value: { request: async (_name, a, b) => (b ?? a)({ name: _name }) }, configurable: true });
  const files = (await readdir(dir)).filter((f) => f.endsWith(".js") && !f.endsWith(".pretty.js")).sort();
  const html = await readFile(join(dir, "play.html"), "utf8").catch(() => "");
  const surface = await loadSurface();
  const entry = surface.assetNames(surface.declaredInHtml(html))[0];
  if (entry && files.includes(entry)) files.unshift(...files.splice(files.indexOf(entry), 1));
  const mods = {};
  const failed = [];
  for (const f of files) {
    try {
      mods[f] = await import(join(dir, f));
    } catch (e) {
      failed.push(`${f}: ${String(e?.message ?? e).split("\n")[0]}`);
    }
  }
  return { mods, failed, files };
}

/** Rows `{ kind, name, ok }` for the bridge's client surface, its client functions included. */
export async function checkRelease(dir) {
  const surface = await loadSurface();
  const loaded = await loadBundles(dir);
  const rows = surface.audit(surface.discover(loaded.mods));
  return { rows, ...loaded };
}

if (import.meta.main) {
  const arg = process.argv[2];
  const dir = resolve(arg ?? (await newestRelease()) ?? join(repo, ".re/js"));
  const { rows, failed, files } = await checkRelease(dir);
  console.log(`release dir: ${dir}`);
  console.log(`loaded ${files.length - failed.length} of ${files.length} bundles`);
  for (const f of failed) console.log(`  not loaded ${f}`);
  console.log();
  for (const r of rows) console.log(`${r.ok ? "PASS" : "FAIL"} ${r.kind.padEnd(10)} ${r.name}`);
  const fails = rows.filter((r) => !r.ok);
  console.log(`\n${rows.length - fails.length} of ${rows.length} PASS${fails.length ? `, ${fails.length} FAIL: ${fails.map((r) => r.name).join(", ")}` : ""}`);
  process.exit(fails.length ? 1 : 0);
}
