// Tables the client bundle holds as literals, read from a saved release (`.re/releases/<id>/`).
import { readdir, readFile } from "node:fs/promises";

const REPO = new URL("../../", import.meta.url).pathname;

/** The newest saved client release's directory. */
export async function newestRelease() {
  const ids = (await readdir(`${REPO}.re/releases`)).sort();
  if (!ids.length) throw new Error("no client release under .re/releases");
  return `${REPO}.re/releases/${ids.at(-1)}/`;
}

/**
 * The array literal that starts at `start` in `text`, cut out by matching brackets outside strings
 * and evaluated. Only a plain literal is read: anything that could run code, such as a call, an
 * assignment or a template, outside strings refuses it.
 */
export function arrayLiteral(text, start) {
  let depth = 0;
  let quote = null;
  for (let k = start; k < text.length; k++) {
    const c = text[k];
    if (quote) {
      if (c === "\\") k++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "(" || c === "=" || c === "`") throw new Error(`not a plain literal at ${k}`);
    else if (c === "[" || c === "{") depth++;
    else if ((c === "]" || c === "}") && --depth === 0) return new Function(`"use strict"; return ${text.slice(start, k + 1)};`)();
  }
  throw new Error("the literal does not close");
}

/**
 * The casino's boss potions (docs/plans/systems-research.md, "Boss summons and daily allowance"):
 * the client's potion table, one row per boss with `key`, `name`, `zone`, `npcId`, `itemId` and,
 * for a boss a script spawns, `scriptedSpawn` (its point and the quest script).
 */
export async function casinoBosses(dir) {
  const at = dir ?? (await newestRelease());
  for (const f of (await readdir(at)).filter((x) => x.endsWith(".js"))) {
    const text = await readFile(`${at}${f}`, "utf8");
    for (let start = text.indexOf('[{key:"'); start >= 0; start = text.indexOf('[{key:"', start + 1)) {
      if (/^[^\]]*?itemId:99\d{4}/.test(text.slice(start, start + 600))) return arrayLiteral(text, start);
    }
  }
  throw new Error(`no casino potion table in ${at}`);
}
