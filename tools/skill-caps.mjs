// Writes data/skill-caps.json: the server's skill caps for every class at every level, from the
// public read-only request behind the client's weapon comparison. One request at a time, four a
// second, so a refresh after a server update takes about five minutes.
//
//   bun tools/skill-caps.mjs [--levels 1-60]
import { writeFile } from "node:fs/promises";

const arg = process.argv.indexOf("--levels");
const [from, to] = (arg >= 0 ? process.argv[arg + 1] : "1-60").split("-").map(Number);
const URL_BASE = "https://idlequest.net/api/skill-caps";
const caps = {};
for (let cls = 1; cls <= 14; cls++) {
  for (let level = from; level <= to; level++) {
    const res = await fetch(`${URL_BASE}?class=${cls}&level=${level}`);
    if (!res.ok) throw new Error(`class ${cls} level ${level}: HTTP ${res.status}`);
    caps[`${cls}-${level}`] = await res.json();
    await Bun.sleep(250);
  }
  process.stderr.write(`class ${cls} done\n`);
}
const file = new URL("../data/skill-caps.json", import.meta.url);
await writeFile(file, `${JSON.stringify({ source: "live server /api/skill-caps?class=C&level=L, the request behind the client's weapon comparison (tools/skill-caps.mjs)", caps })}\n`);
console.log(`${Object.keys(caps).length} rows`);
