// Reads the idlequest-content snapshot: one ndjson shard directory per table. A table is read
// whole only when a lookup needs it, and each lookup builds its index once.
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";

export const contentDir = process.env.IQ_CONTENT ?? `${homedir()}/src/github.com/brynnb/idlequest-content`;

const cache = new Map();

export async function table(name) {
  if (cache.has(name)) return cache.get(name);
  const dir = `${contentDir}/data/${name}`;
  let files;
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".ndjson")).sort();
  } catch {
    throw new Error(`cannot read ${dir}; set IQ_CONTENT to the idlequest-content directory`);
  }
  const rows = [];
  for (const f of files) {
    for (const line of (await Bun.file(`${dir}/${f}`).text()).split("\n")) if (line) rows.push(JSON.parse(line));
  }
  cache.set(name, rows);
  return rows;
}

const indexes = new Map();
export async function byId(name, key = "id") {
  const k = `${name}.${key}`;
  if (!indexes.has(k)) {
    const m = new Map();
    for (const r of await table(name)) m.set(r[key], r);
    indexes.set(k, m);
  }
  return indexes.get(k);
}
