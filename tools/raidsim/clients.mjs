// The client builds the simulator can load. The client is minified and every release renames its
// module-level bindings, so each build has a table of the files and bindings the simulator reads.
// A build without a table is refused.
//
//   files    the three bundles a fight needs: `main` (stores, member builder, raid buffs), `bq` (combat
//            service and encounter engine) and `engine` (raid tick and auto-heal)
//   names    what fight.mjs reads, under the role it plays there
//   counted  functions `--calls` counts (observation only)
//
// A new release: `bun tools/raidsim/map-client.mjs <release id>` prints the table by matching the
// code of the functions in the table below the release it was written for, then check that it loads
// with `bun tools/raidsim.mjs --client <release id> ...`.
import { readdir } from "node:fs/promises";

const repo = new URL("../../", import.meta.url).pathname;

export const CLIENTS = {
  "20261108T004644-064bc896": {
    dir: ".re/releases/20261108T004644-064bc896/",
    files: { main: "OSTsR53r.js", bq: "0eakiHJI.js", engine: "CVEP2_Ra.js" },
    names: {
      main: {
        spellStore: "c1",
        socket: "z",
        npcSpellBuilder: "as",
        eventRecorder: "G2",
        characterStore: "t1",
        defaultProfile: "W6",
        spellbookStore: "Wt",
        gameStore: "S1",
        raidTimeStore: "i2",
        raidTimeScope: "y5",
        hydrateSpells: "eD",
        skillNames: "kc",
        resolveBosses: "Dd",
        memberFromSnapshot: "fr",
        petsForRoster: "Y7",
      },
      bq: { combatStartRequest: "$L", sceneStandIn: "W2", encounterClass: "L2" },
      engine: { runtime: "hi", raidStore: "rt", raidTick: "Zd", setAutoHeal: "XL", setAutoDps: "OGe" },
    },
    counted: {
      engine: ["Zd", "zGe", "GGe", "Nu", "SGe", "N_", "JOt", "t0e", "Jxe", "e0e", "dDt", "mDt", "BOt", "FOt", "fDt", "pDt", "oDt", "lDt", "aDt", "jOt", "WOt", "eM", "qOt", "KOt", "ZOt"],
      main: ["fr", "bQ", "bp", "Bt", "yJ", "i8", "XQ", "s8", "f6", "V0", "q8", "tn", "Dp", "g61", "v61", "y61", "pQ"],
      bq: ["MO", "vO", "yO", "WO", "XO", "JO", "Ve", "ub", "_P"],
    },
  },
  "legacy": {
    dir: ".re/js/",
    files: { main: "BYHOoN7B.js", bq: "BQawK6zj.js", engine: "nEit1u-a.js" },
    names: {
      main: {
        spellStore: "c1",
        socket: "z",
        npcSpellBuilder: "Zt",
        eventRecorder: "G2",
        characterStore: "t1",
        defaultProfile: "z6",
        spellbookStore: "Ht",
        gameStore: "S1",
        raidTimeStore: "i2",
        raidTimeScope: "v5",
        hydrateSpells: "JE",
        skillNames: "Sc",
        resolveBosses: "Ed",
        memberFromSnapshot: "dr",
        petsForRoster: "K7",
      },
      bq: { combatStartRequest: "$L", sceneStandIn: "W2", encounterClass: "L2" },
      engine: { runtime: "pi", raidStore: "rt", raidTick: "qd", setAutoHeal: "XL", setAutoDps: "gGe" },
    },
    counted: {
      engine: ["qd", "IGe", "CGe", "Nu", "aGe", "I_", "xOt", "Uxe", "Gxe", "zxe", "wOt", "NOt", "iOt", "tOt", "OOt", "DOt", "IOt", "ROt", "COt", "uOt", "lOt", "jP", "pOt", "mOt", "_Ot"],
      main: ["dr", "yQ", "kp", "Pt", "vJ", "n8", "QQ", "t8", "p6", "U0", "V8", "Qs", "Ep", "o61", "c61", "m61", "mQ"],
      bq: ["MO", "vO", "yO", "WO", "XO", "JO", "Ve", "sb", "_P"],
    },
  },
  "20261110T154736-1d13b899": {
    dir: ".re/releases/20261110T154736-1d13b899/",
    files: { main: "BpHyB6iC.js", bq: "B6iSY2J0.js", engine: "BHfVSHXB.js" },
    names: {
      main: {
        spellStore: "c1",
        socket: "z",
        npcSpellBuilder: "os",
        eventRecorder: "$2",
        characterStore: "t1",
        defaultProfile: "Y6",
        spellbookStore: "Yt",
        gameStore: "y1",
        raidTimeStore: "r2",
        raidTimeScope: "T5",
        hydrateSpells: "cD",
        skillNames: "wc",
        resolveBosses: "Fd",
        memberFromSnapshot: "br",
        petsForRoster: "Q7",
      },
      bq: { combatStartRequest: "$L", sceneStandIn: "W2", encounterClass: "L2" },
      engine: { runtime: "hi", raidStore: "st", raidTick: "Kd", setAutoHeal: "ZL", setAutoDps: "UGe" },
    },
    counted: {
      engine: ["Kd", "ZGe", "KGe", "Nu", "wGe", "N_", "dDt", "o0e", "n0e", "a0e", "CDt", "ADt", "KOt", "qOt", "IDt", "RDt", "bDt", "SDt", "vDt", "rDt", "iDt", "rM", "lDt", "cDt", "uDt"],
      main: ["br", "NQ", "wp", "RJ", "o8", "oJ", "r8", "v6", "Y0", "Z8", "dn", "Fp", "C61", "x61", "R61", "IQ"],
      bq: ["MO", "vO", "yO", "WO", "XO", "JO", "Ve", "ub", "_P"],
    },
  },
};

// Without a reference the newest saved release is used. A reference is a release id, "legacy", or
// a directory that is one of the two.
export async function resolveClient(reference) {
  let id = reference;
  if (!id) id = (await readdir(`${repo}.re/releases`).catch(() => [])).sort().at(-1) ?? "legacy";
  id = id.replace(/\/+$/, "").split("/").pop();
  if (id === "js") id = "legacy";
  const client = CLIENTS[id];
  if (!client) throw new Error(`no client table for ${JSON.stringify(id)} (known: ${Object.keys(CLIENTS).join(", ")}); write one with tools/raidsim/map-client.mjs`);
  return { id, ...client, dir: `${repo}${client.dir}` };
}

// The client's Raid Resolve bosses ({ ids: Set of npc ids, names: Set of names }), read from the list
// the main bundle holds under `resolveBosses`. The simulator's farmed kits keep these NPCs out of
// the drop sources.
export async function resolveBossList(client) {
  const name = client.names.main.resolveBosses;
  const text = await Bun.file(`${client.dir}${client.files.main}`).text();
  const list = text.match(new RegExp(`(?:^|[^\\w$])${name.replace(/\$/g, "\\$")}=\\[(\\{npcId:.*?)\\](?=[,;\\n])`));
  if (!list) throw new Error(`the Raid Resolve list ${name} was not found in ${client.files.main}`);
  const entries = [...list[1].matchAll(/npcId:(\d+),zoneId:\d+,name:"([^"]*)"/g)];
  if (!entries.length) throw new Error(`the Raid Resolve list ${name} in ${client.files.main} has no entries`);
  return { ids: new Set(entries.map((m) => Number(m[1]))), names: new Set(entries.map((m) => m[2])) };
}
