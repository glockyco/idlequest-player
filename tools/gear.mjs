// Best gear for a class at a level, and where it drops or who sells it.
//
//   bun tools/gear.mjs <class> --level N [--race dwarf] [--slot head] [--mob-max N] [--top 3] [--list data/gear/p99-velious-preraid.json] [--data dir]
//   bun tools/gear.mjs --party [roster.json] --level N [--mob-max N] [--top 3]
//   class: warrior cleric paladin ranger shadowknight druid monk bard rogue shaman necromancer wizard magician enchanter
//   race: human barbarian erudite woodelf highelf darkelf halfelf dwarf troll ogre halfling gnome iksar vahshir
//
// Reads the developer's public content snapshot (see tools/drops.mjs). Items are limited to the
// class, the race if given, `reqlevel <= level`, and a source: a drop from an NPC of at most
// `mob-max` levels (default level+6), or a merchant, in a zone IdleQuest has. Prices are the
// item's base price in platinum; what a merchant asks may differ. Items with neither source are
// shown as "quest or unknown".
//
// Armor and jewelry are ranked by what they add to the group's XP rate, `xpGain` in
// tools/lib/gear-plan.mjs (tenths of a percent: offense and haste for melee, mana and regeneration
// for spell casters, a little for AC and HP, weighed as for a member whose damage share is not
// measured), and weapon slots by `weaponRatio`: base damage capped at the level's limit over delay,
// plus the client's flat main-hand bonus and the weapon's proc damage. The source tables are in
// tools/lib/gear-data.mjs.
import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
import { BIT, RACE, SLOTS, SLOT_BY_NUM, attachEffects, capFor as capForLevel, groupOf, liveZoneNames, loadSources, outputValue, rows as contentRows, slotName, weaponRatio } from "./lib/gear-data.mjs";
import { xpGain } from "./lib/gear-plan.mjs";

const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : d;
};
const has = (n) => args.includes(`--${n}`);
const pos = args.filter((a, i) => !a.startsWith("--") && (i === 0 || !args[i - 1]?.startsWith("--") || args[i - 1] === "--party"));
const partyMode = has("party");
const partyFile = (() => {
  const i = args.indexOf("--party");
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : null;
})();
const cls = partyMode ? "warrior" : (pos[0] ?? "").toLowerCase();
const level = Number(opt("level", NaN));
const race = opt("race", null)?.toLowerCase().replace(/[^a-z]/g, "");
if (race && !RACE[race]) {
  console.error(`unknown race ${race}; one of ${Object.keys(RACE).join(" ")}`);
  process.exit(2);
}
if ((!partyMode && !BIT[cls]) || Number.isNaN(level)) {
  console.error("usage: bun tools/gear.mjs <class> --level N [--slot name] [--mob-max N] [--top N]\n       bun tools/gear.mjs --party [roster.json] --level N");
  process.exit(2);
}
const root = opt("data", process.env.IQ_CONTENT ?? `${homedir()}/src/github.com/brynnb/idlequest-content`);
const mobMax = Number(opt("mob-max", level + 6));
const top = Number(opt("top", 3));
const slotFilter = opt("slot", null)?.toLowerCase();
// A curated list, such as data/gear/p99-velious-preraid.json, limits the candidates to items one
// group can get, because the score alone ranks raid drops first.
const listFile = opt("list", null);
const listed = listFile ? new Set((JSON.parse(await readFile(listFile, "utf8")).rows ?? []).map((r) => r.item)) : null;

// The value and the damage cap at the level asked for (the party plan may name classes of any level).
const capFor = (c, lvl = level) => capForLevel(c, lvl);
const scoreFor = (i, c) => xpGain(outputValue([i], c, level), { cls: c, level });
const group = groupOf(cls);
const damageCap = capFor(cls);
const score = (i) => scoreFor(i, cls);
const rows = (table) => contentRows(root, table);
const zoneName = await liveZoneNames(root);

// ---- Candidate items ---------------------------------------------------------------------------
const cands = new Map(); // id -> item with slot names and score
const allItems = new Map();
for await (const i of rows("items")) {
  if (!i.slots || i.augtype || i.bagslots || (listed && !listed.has(i.Name))) continue;
  const slots = slotName(i.slots);
  if (!slots.length) continue;
  allItems.set(i.id, { raw: i, id: i.id, name: i.Name, slots, req: i.reqlevel ?? 0, classes: i.classes ?? 0, races: i.races ?? 0, ac: i.ac, hp: i.hp, mana: i.mana, int: i.aint, wis: i.awis, dmg: i.damage, delay: i.delay, twoHand: [1, 4, 35].includes(i.itemtype), nodrop: i.nodrop, price: i.price });
}
// An item's worth counts its proc, worn and focus effects, so their spells come along before scoring.
await attachEffects(new Map([...allItems].map(([id, w]) => [id, w.raw])), root);
for (const [id, w] of allItems) {
  const i = w.raw;
  if (partyMode) {
    if ((i.reqlevel ?? 0) <= level) cands.set(id, w);
    continue;
  }
  if (!(i.classes & BIT[cls]) || (race && !(i.races & RACE[race])) || (i.reqlevel ?? 0) > level) continue;
  const sc = score(i);
  if (sc <= 0 && !((w.slots.includes("primary") || w.slots.includes("secondary")) && i.damage)) continue;
  cands.set(id, { ...w, score: sc, ratio: weaponRatio(i, cls, level) });
}

// ---- Sources: item -> lootdrop -> loottable -> NPC -> spawns -> zone (tools/lib/gear-data.mjs) ---
const { sources, sellers } = await loadSources(root, { itemIds: new Set(cands.keys()), maxNpcLevel: mobMax, zoneName });

const obtainable = (i) => sources.has(i.id) || sellers.has(i.id);
if (partyMode) {
  if (!partyFile) {
    console.error('--party needs a saved roster: await Bun.write("runs/roster.json", JSON.stringify(await iq.roster()))');
    process.exit(2);
  }
  const r = JSON.parse(await readFile(partyFile, "utf8"));
  const key = (s) => String(s ?? "").toLowerCase().replace(/[^a-z]/g, "");
  const members = [r.me, ...(r.party ?? [])].filter(Boolean).map((m) => ({ name: m.name, class: key(m.class), race: key(m.race), items: m.items ?? [] }));
  const unknown = members.filter((m) => !BIT[m.class] || !RACE[m.race]).map((m) => `${m.name} (${m.class || "no class"}, ${m.race || "no race"})`);
  if (unknown.length) {
    console.error(`unknown class or race in ${partyFile}: ${unknown.join(", ")}. Save the roster again with the current SDK.`);
    process.exit(2);
  }
  const byName = new Map();
  for (const it of allItems.values()) if (!byName.has(it.name)) byName.set(it.name, it);
  // In-rotation zones: the bot's band row for this level and the next one up.
  const bands = JSON.parse(await readFile(new URL("../data/band-rotations.json", import.meta.url), "utf8"));
  const here = bands.findIndex(([min]) => level >= min);
  const shorts = [...(bands[here]?.[1] ?? []), ...(here > 0 ? bands[here - 1][1] : [])];
  const ROTATION_ZONES = new Set(shorts.map((s) => zoneName.get(s)).filter(Boolean));
  console.log(`Whole-party upgrade plan at level ${level} (drops from mobs up to level ${mobMax})`);
  console.log(`In-rotation zones: ${[...ROTATION_ZONES].join(", ")}\n`);
  for (const m of members) {
    const cBit = BIT[m.class];
    const rBit = RACE[m.race];
    const cap = capFor(m.class, level);
    const eqBySlot = new Map();
    for (const eq of m.items) {
      const sName = SLOT_BY_NUM[eq.slot];
      const found = byName.get(eq.name);
      if (!sName || !found) continue;
      const val = sName === "primary" || sName === "secondary" ? weaponRatio(found.raw, m.class, level, { primary: sName === "primary" }) : scoreFor(found.raw, m.class);
      const prev = eqBySlot.get(sName);
      if (!prev || val < prev.val) eqBySlot.set(sName, { name: eq.name, val, twoHand: found.twoHand });
    }
    const canDW = ["warrior", "bard", "rogue", "monk", "ranger"].includes(m.class);
    const mh = eqBySlot.get("primary") ?? { name: "empty", val: 0, twoHand: false };
    const oh = eqBySlot.get("secondary") ?? { name: "empty", val: 0 };
    const dwTotal = mh.val + (canDW && !mh.twoHand ? 0.35 * oh.val : 0);
    console.log(`=== ${m.name} (${m.class}, ${m.race}) ===`);
    const merch = [];
    const inRot = [];
    const outRot = [];
    for (const [slot] of Object.entries(SLOTS)) {
      if (slotFilter && slot !== slotFilter) continue;
      if (slot === "secondary" && mh.twoHand) continue;
      const hand = slot === "primary" || slot === "secondary";
      const cur = eqBySlot.get(slot) ?? { name: "empty", val: 0 };
      const elig = [...cands.values()]
        .filter((i) => i.slots.includes(slot) && (i.classes & cBit) && (i.races & rBit) && !(slot === "secondary" && i.twoHand) && obtainable(i))
        .map((i) => ({ ...i, val: hand ? weaponRatio(i.raw, m.class, level, { primary: slot === "primary" }) : scoreFor(i.raw, m.class) }))
        .filter((i) => (slot === "primary" && i.twoHand && canDW ? i.val > dwTotal + 0.03 : i.val > cur.val + (hand ? 0.02 : 4)))
        .sort((a, b) => b.val - a.val);
      const bestMerch = elig.find((i) => sellers.has(i.id));
      if (bestMerch) {
        const s = sellers.get(bestMerch.id)[0];
        merch.push(`  [${slot}] ${bestMerch.name} (${hand ? `${bestMerch.dmg}/${bestMerch.delay}=${bestMerch.val.toFixed(2)}` : `+${Math.round(bestMerch.val - cur.val)} score`} vs ${cur.name}): ${s.npc} in ${s.zone} (${((bestMerch.price ?? 0) / 1000).toFixed(1)} pp)`);
      }
      const bestRot = elig.find((i) => (sources.get(i.id) ?? []).some((s) => ROTATION_ZONES.has(s.zone) && s.drop * s.spawn >= 0.01));
      if (bestRot) {
        const s = (sources.get(bestRot.id) ?? []).filter((x) => ROTATION_ZONES.has(x.zone)).sort((a, b) => b.drop * b.spawn - a.drop * a.spawn)[0];
        inRot.push(`  [${slot}] ${bestRot.name} (${hand ? `${bestRot.dmg}/${bestRot.delay}=${bestRot.val.toFixed(2)}` : `+${Math.round(bestRot.val - cur.val)} score`} vs ${cur.name}): ${s.npc} L${s.level} in ${s.zone} (${(s.drop * 100).toFixed(0)}% drop x ${(s.spawn * 100).toFixed(0)}% spawn)`);
      }
      const bestOut = elig.find((i) => !ROTATION_ZONES.has((sources.get(i.id) ?? [])[0]?.zone) && (sources.get(i.id) ?? []).some((s) => s.drop * s.spawn >= 0.08) && i.val > cur.val + (hand ? 0.08 : 20));
      if (bestOut) {
        const s = (sources.get(bestOut.id) ?? []).sort((a, b) => b.drop * b.spawn - a.drop * a.spawn)[0];
        outRot.push(`  [${slot}] ${bestOut.name} (${hand ? `${bestOut.dmg}/${bestOut.delay}=${bestOut.val.toFixed(2)}` : `+${Math.round(bestOut.val - cur.val)} score`} vs ${cur.name}): ${s.npc} L${s.level} in ${s.zone} (${(s.drop * 100).toFixed(0)}% drop x ${(s.spawn * 100).toFixed(0)}% spawn)`);
      }
    }
    if (merch.length) console.log("  Merchant upgrades:\n" + merch.slice(0, 6).join("\n"));
    if (inRot.length) console.log("  In-rotation drops:\n" + inRot.slice(0, 6).join("\n"));
    if (outRot.length) console.log("  High-gain side drops:\n" + outRot.slice(0, 4).join("\n"));
  }
  process.exit(0);
}
// ---- Report: top items per slot ---------------------------------------------------------------
console.log(`${cls} (${group})${race ? `, ${race}` : ""}, level ${level}, drops from mobs up to level ${mobMax}\n`);
const bySlot = new Map();
for (const it of cands.values()) for (const s of it.slots) (bySlot.get(s) ?? bySlot.set(s, []).get(s)).push(it);
for (const [slot] of Object.entries(SLOTS)) {
  if (slotFilter && slot !== slotFilter) continue;
  // In the hands a weapon's capped damage over delay decides ordinary swings; a shield or other
  // non-weapon secondary item is still ranked by its stats after the weapons.
  const hand = slot === "primary" || slot === "secondary";
  const list = (bySlot.get(slot) ?? []).filter((i) => (obtainable(i) || i.score > 0) && !(slot === "secondary" && i.twoHand));
  // Prefer items that can actually be farmed or bought: whether a source exists, then the ratio
  // in the hands, then score.
  list.sort((a, b) => (obtainable(b) ? 1 : 0) - (obtainable(a) ? 1 : 0) || (hand ? b.ratio - a.ratio : 0) || b.score - a.score);
  if (!list.length) continue;
  console.log(`== ${slot}${hand ? ` (damage capped at ${damageCap})` : ""}`);
  for (const it of list.slice(0, top)) {
    const st = [it.ac && `ac ${it.ac}`, it.hp && `hp ${it.hp}`, it.mana && `mana ${it.mana}`, it.int && `int ${it.int}`, it.wis && `wis ${it.wis}`, it.dmg && `${it.dmg}/${it.delay} ratio ${it.ratio.toFixed(2)}${it.twoHand ? " 2H" : ""}`].filter(Boolean).join(" ");
    const src = (sources.get(it.id) ?? []).sort((a, b) => b.drop * b.spawn - a.drop * a.spawn).slice(0, 2);
    const sold = (sellers.get(it.id) ?? []).slice(0, 2);
    console.log(`  ${it.name.padEnd(30)} score ${it.score.toFixed(1).padStart(5)}  ${st}${it.nodrop === 0 ? " [no drop]" : ""}`);
    if (!src.length && !sold.length) console.log("      quest or unknown");
    for (const s of sold) console.log(`      sold by ${s.npc} in ${s.zone}, base price ${((it.price ?? 0) / 1000).toFixed(1)} pp`);
    for (const s of src) console.log(`      ${s.npc} (L${s.level}) in ${s.zone}: ${(s.drop * 100).toFixed(0)}% drop, ${(s.spawn * 100).toFixed(0)}% spawn, ${s.points} points, ${Number.isFinite(s.respawn) ? `respawn ${s.respawn}s` : "no respawn timer"}`);
  }
}
