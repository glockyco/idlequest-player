// Checks the content reader (tools/lib/content.mjs): which spawn rows the live server uses. Run with
// `bun test`.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { liveSpawnRows } from "../tools/lib/content.mjs";

const table = (root: string, name: string, rows: object[]) => {
  mkdirSync(join(root, "data", name), { recursive: true });
  writeFileSync(join(root, "data", name, "a.ndjson"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
};
const read = async (name: string, root: string) => {
  const out = [];
  for await (const r of liveSpawnRows(name, root)) out.push(r);
  return out;
};

test("spawn rows of an instanced zone copy are left out whatever the expansion, a weight-0 entry spawns only in a group without weights, and zone names come in lower case", async () => {
  const root = mkdtempSync(join(tmpdir(), "content-"));
  try {
    table(root, "spawn2", [
      // -1 bounds an expansion range on neither side.
      { id: 1, zone: "kedge", version: 0, min_expansion: -1, max_expansion: -1 },
      { id: 2, zone: "kedge", version: 0, min_expansion: 0, max_expansion: 2 },
      { id: 3, zone: "highpass", version: 0, min_expansion: 12, max_expansion: -1 },
      { id: 4, zone: "kedge", version: 0, min_expansion: -1, max_expansion: 1 },
      { id: 5, zone: "kedge", version: 1, min_expansion: -1, max_expansion: -1 },
      { id: 6, zone: "Everfrost", version: 0, min_expansion: -1, max_expansion: -1 },
    ]);
    table(root, "spawnentry", [
      { spawngroupID: 1, npcID: 10, chance: 30, min_expansion: -1, max_expansion: -1 },
      { spawngroupID: 1, npcID: 11, chance: 0, min_expansion: -1, max_expansion: -1 },
      { spawngroupID: 2, npcID: 12, chance: 100, min_expansion: 3, max_expansion: -1 },
      { spawngroupID: 3, npcID: 13, chance: 0, min_expansion: -1, max_expansion: -1 },
      { spawngroupID: 3, npcID: 14, chance: 0, min_expansion: -1, max_expansion: -1 },
    ]);
    expect((await read("spawn2", root)).map((r) => [r.id, r.zone])).toEqual([[1, "kedge"], [2, "kedge"], [3, "highpass"], [4, "kedge"], [6, "everfrost"]]);
    expect((await read("spawnentry", root)).map((r) => [r.npcID, r.chance])).toEqual([[10, 30], [12, 100], [13, 1], [14, 1]]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
