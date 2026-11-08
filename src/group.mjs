// Bring up a planned leveling group from data/roster.json in a tab of its own: sign in, create its
// characters at character select, kit each one, and start AutoLevel in the first zone of the
// level 1 band row. Runs where `browser` exists (an omp eval cell), because it opens the tab.
import { readFile, writeFile } from "node:fs/promises";
import { screenInPage, signInInPage, storedLogin } from "./install.mjs";

const ROSTER = new URL("../data/roster.json", import.meta.url);
const CREATE = new URL("../data/char-create.json", import.meta.url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Creation attributes never grow with level (docs/plans/systems-research.md, "Race"), so the race
// is chosen for the stat that feeds the class's mana or melee first, then for survival.
const KEY_STATS = {
  Warrior: ["sta", "agi", "str"],
  Paladin: ["sta", "wis", "str"],
  "Shadow Knight": ["sta", "int", "str"],
  Cleric: ["wis", "sta"],
  Druid: ["wis", "sta"],
  Shaman: ["wis", "sta"],
  Necromancer: ["int", "sta"],
  Wizard: ["int", "sta"],
  Magician: ["int", "sta"],
  Enchanter: ["int", "sta"],
  Rogue: ["str", "dex", "agi"],
  Monk: ["str", "dex", "sta"],
  Ranger: ["str", "dex", "wis"],
  Bard: ["sta", "dex", "cha"],
};

/** The class name the client uses for a roster slug such as `shadow-knight`. */
export function className(slug) {
  return slug
    .split("-")
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * The race with the highest creation values of the class's key stats, compared in order, from
 * the server's creation table (base row plus the preset allocation).
 */
export async function bestRace(cls) {
  const d = JSON.parse(await readFile(CREATE, "utf8"));
  const classId = d.classes.find((c) => c.name === cls)?.id;
  const key = KEY_STATS[cls];
  if (!classId || !key) throw new Error(`no creation data for class ${cls}`);
  const score = (r) => key.map((s) => r.base[s] + r.preset[s]);
  const rows = d.combinations.filter((c) => c.class === classId);
  rows.sort((a, b) => {
    const x = score(a);
    const y = score(b);
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return y[i] - x[i];
    return 0;
  });
  return d.races.find((r) => r.id === rows[0].race).name;
}

const ONSETS = ["b", "d", "f", "g", "k", "l", "m", "n", "r", "s", "t", "v", "z", "th", "dr", "gr", "br", "kr", "sh", "vel", "mor"];
const VOWELS = ["a", "e", "i", "o", "u", "ae", "ia", "y"];
const CODAS = ["n", "r", "l", "s", "th", "nd", "rk", "x", "m", "", "", ""];
const pick = (list) => list[Math.floor(Math.random() * list.length)];

/** A pronounceable name of 6 to 11 letters starting with `letter`. Taken names fail at creation. */
export function makeName(letter) {
  for (;;) {
    let s = letter.toLowerCase();
    if (!/[aeiouy]/.test(s)) s += pick(VOWELS);
    for (let k = 0; k < 2; k++) s += pick(ONSETS) + pick(VOWELS);
    s += pick(CODAS);
    if (s.length >= 6 && s.length <= 11) return s[0].toUpperCase() + s.slice(1);
  }
}

/**
 * Sign in on the login form from the login files in `~/.config/idlequest`, without printing them,
 * and wait for character select. The inputs are set with the native value setter, never focused,
 * because focusing opens a password manager's autofill menu, which detaches the tab (AGENTS.md).
 */
export async function signIn(tab, { timeoutMs = 120000 } = {}) {
  const end = Date.now() + timeoutMs;
  const screen = () => tab.evaluate(`(${screenInPage})()`);
  for (let s = await screen(); s !== "select"; s = await screen()) {
    if (s === "login") {
      await tab.evaluate(`(${signInInPage})(${JSON.stringify(await storedLogin())})`);
      while ((await screen()) !== "select") {
        if (Date.now() > end) throw new Error("character select did not appear after CONNECT");
        await sleep(1000);
      }
      return;
    }
    if (Date.now() > end) throw new Error("the login form did not become ready");
    await sleep(1000);
  }
}

/** Platinum of a Manage Money cell such as "3,563 pp". */
const platinum = (cell) => Number(String(cell ?? "").replace(/[^0-9]/g, "")) || 0;
const readRoster = async () => JSON.parse(await readFile(ROSTER, "utf8"));
/** The roster as the file keeps it: one line per group. */
export function formatRoster(r) {
  const line = (g) => JSON.stringify(g).replace(/,"/g, ', "').replace(/":/g, '": ').replace(/^\{/, "{ ").replace(/\}$/, " }");
  return `{\n  "about": ${JSON.stringify(r.about)},\n  "groups": [\n${r.groups.map((g) => `    ${line(g)}`).join(",\n")}\n  ]\n}\n`;
}
const writeRoster = (r) => writeFile(ROSTER, formatRoster(r));
const zoneShort = (tab) => tab.evaluate(() => window.iq.stores.staticData.getState().zones.find((z) => z.zoneidnumber === window.iq.stores.combat.getState().currentZone)?.shortName ?? null);
// Options, Graphics, Disable Rendering pauses 3D drawing while AutoLevel keeps running, which saves
// most of a tab's CPU. The client does not keep the setting across sign-ins (OSTsR53r.js:191477).
const renderingOff = (tab) =>
  tab.evaluate(() => {
    const s = window.iq.stores.combat.getState();
    if (!s.disable3D) s.toggleDisable3D();
  });

/** Names of the Path To merchants in the current zone that list Bags. */
const bagMerchants = (tab) =>
  tab.evaluate(async () => {
    const cb = window.iq.stores.combat.getState();
    if (!cb.isMerchantListOpen) cb.toggleMerchantList();
    await new Promise((r) => setTimeout(r, 1200));
    return [...document.querySelectorAll(".merchant-name")].filter((el) => /Bags/.test(el.parentElement?.textContent ?? "") && !/QUEST NPC/.test(el.parentElement.textContent)).map((el) => el.textContent.trim());
  });

/**
 * Kit the active character: starter weapon, packed general slots, and a Backpack in every free
 * general slot, bought from the zone's bag merchants with coin pulled from `coinFrom`.
 */
async function kitActive(iq, tab, coinFrom, log) {
  if (coinFrom) await iq.manageMoney({ transferFrom: coinFrom });
  const kit = await iq.kitStarter();
  const used = await tab.evaluate(() => window.iq.stores.character.getState().characterProfile.inventory.filter((x) => x.bag === 0 && x.slot >= 22 && x.slot <= 29).length);
  let bought = 0;
  for (const m of await bagMerchants(tab)) {
    if (bought >= 8 - used) break;
    try {
      bought += (await iq.buyItem("Backpack", { count: 8 - used - bought, merchant: m })).bought;
    } catch (e) {
      log(`  ${m}: ${e.message}`);
    }
    await iq.clearWindows();
  }
  return { weapon: kit.primary, bags: bought, wanted: 8 - used };
}

/**
 * Create and start group `id` from data/roster.json. `attach` is src/client.mjs's export. Opens
 * the tab `iq-<id>`, so call it with no game running in that name. Writes the created names to
 * data/roster.json as soon as they exist. Resolves with the members, the zone and the leader's
 * platinum.
 */
export async function createGroup({ browser, attach, id, kitZone = "rivervale", log = console.log }) {
  const roster = await readRoster();
  const g = roster.groups.find((x) => x.id === id);
  if (!g?.planned?.length) throw new Error(`${id} has no planned characters in data/roster.json`);
  if (!g.letter) throw new Error(`${id} has no name letter in data/roster.json`);

  const tab = await browser.open({ name: `iq-${id.toLowerCase()}`, app: { relay: true }, url: "https://idlequest.net/play", persist: true });
  await signIn(tab);
  let iq = await attach(tab);
  log(`${id}: signed in`);

  const made = [];
  for (const slug of g.planned) {
    const cls = className(slug);
    const race = await bestRace(cls);
    let name = null;
    for (let k = 0; k < 8 && !name; k++) {
      const n = makeName(g.letter);
      const r = await iq.createCharacter({ name: n, race, className: cls });
      if (r?.ok) name = n;
      else await sleep(1500);
    }
    if (!name) {
      g.members = made;
      g.planned = g.planned.slice(made.length);
      await writeRoster(roster);
      throw new Error(`${id}: could not create the ${race} ${cls} after 8 names`);
    }
    made.push(name);
    log(`${id}: created ${name}, ${race} ${cls}`);
    await sleep(1500);
  }
  g.members = made;
  delete g.planned;
  await writeRoster(roster);

  const [leader, ...rest] = made;
  const ids = await tab.evaluate((names) => Object.fromEntries((window.iq.stores.roster.getState().characters ?? []).filter((c) => names.includes(c.name)).map((c) => [c.name, Number(c.id)])), made);
  await iq.setBot({ partyIds: rest.map((n) => ids[n]), enabled: false });
  await iq.switchCharacter(leader);
  await iq.setBot({ enabled: false });
  if ((await zoneShort(tab)) !== kitZone) await iq.travelTo(kitZone);

  // The kit costs a few platinum per character. Take it from the richest character outside the
  // first group, whose leader buys the most expensive spells.
  const first = new Set(roster.groups[0].members);
  const rows = (await iq.manageMoney()).balances.filter((b) => !first.has(b.character) && !made.includes(b.character));
  const richest = rows.sort((a, b) => platinum(b.total) - platinum(a.total))[0]?.character ?? null;
  let holder = richest;
  for (const who of [leader, ...rest]) {
    if (who !== leader) {
      await iq.switchCharacter(who);
      await iq.setBot({ enabled: false });
      if ((await zoneShort(tab)) !== kitZone) await iq.travelTo(kitZone);
    }
    const k = await kitActive(iq, tab, holder, log);
    holder = who;
    log(`${id}: ${who} armed with ${k.weapon ?? "nothing"}, ${k.bags} of ${k.wanted} bags`);
  }
  await iq.switchCharacter(leader);
  await iq.manageMoney({ transferFrom: holder });

  await tab.evaluate(() => {
    const cb = window.iq.stores.combat.getState();
    if (!cb.autoUpgradeCompanionsEnabled) cb.toggleAutoUpgradeCompanions();
  });
  await iq.applyRoleTactics();
  // The bot orders a band row by how few of this browser's other groups hunt each zone. From here
  // it keeps the leader active and the members in the party by itself.
  const rotation = await tab.evaluate(() => window.iqBot.leastUsed([...(window.iq.bandRotations ?? []).find(([min]) => min <= 1)[1]]));
  await iq.setBot({ rotation, leaderId: ids[leader], enabled: true });
  await iq.travelTo(rotation[0]);
  await iq.startAutoLevel({ minCon: 10, maxCon: 13 });
  await renderingOff(tab);
  await iq.setLabel(id.toLowerCase());
  const s = await iq.status();
  const pp = await tab.evaluate(() => window.iq.stores.character.getState().characterProfile.platinum);
  log(`${id}: ${leader} leads in ${s.zone}, AutoLevel ${s.autoLevel?.running ? "running" : "OFF"}, ${pp} pp`);
  return { id, members: made, zone: s.zone, platinum: pp };
}

/**
 * Bring a group back after its tab crashed or lost its session: open the tab `name`, sign in,
 * and give the bot the group's leader (the first member in data/roster.json) and members, so it
 * enters the world as the leader and regroups by itself. Then restore the rotation for the
 * leader's level and start AutoLevel with the limits the game kept. The new session takes over
 * from any old one of the same leader, so close the old tab afterwards. Resolves with the leader,
 * zone and party.
 */
export async function restoreGroup({ browser, attach, id, name = `iq-${id.toLowerCase()}-${Date.now().toString(36).slice(-4)}`, log = console.log }) {
  const roster = await readRoster();
  const g = roster.groups.find((x) => x.id === id);
  if (!g?.members?.length) throw new Error(`${id} has no members in data/roster.json`);
  const [leader, ...rest] = g.members;
  const tab = await browser.open({ name, app: { relay: true }, url: "https://idlequest.net/play", persist: true });
  await signIn(tab);
  const iq = await attach(tab);
  log(`${id}: signed in as tab ${name}`);
  await iq.setBot({ enabled: true });
  const sw = await iq.setLeader(leader, { members: rest });
  const level = await tab.evaluate(() => window.iq.stores.character.getState().characterProfile.level);
  const rotation = await tab.evaluate((lvl) => window.iqBot.leastUsed([...((window.iq.bandRotations ?? []).find(([min]) => lvl >= min)?.[1] ?? [])]), level);
  if (rotation.length) await iq.setBot({ rotation });
  if (rotation.length && !rotation.includes(await zoneShort(tab))) await iq.travelTo(rotation[0]);
  await iq.startAutoLevel({});
  await renderingOff(tab);
  await iq.setLabel(id.toLowerCase());
  const s = await iq.status();
  log(`${id}: ${leader} L${level} in ${s.zone} with ${sw.party.join(", ")}${sw.missing.length ? `, missing ${sw.missing.join(", ")}` : ""}, AutoLevel ${s.autoLevel?.running ? "running" : "OFF"}`);
  return { tab: name, leader, zone: s.zone, party: sw.party, missing: sw.missing };
}

/**
 * Deal lightstones among a group's `members` for `iq.handIn`: Greater Lightstones first,
 * round-robin from the lowest level in `levels` (names to levels), so shares differ by at most one
 * stone and the extra ones go where a level costs least. `stones` holds the counts, such as
 * `{ "Greater Lightstone": 8, Lightstone: 3 }`. Returns `[{ name, counts }]` for the members that
 * get any, lowest level first.
 */
export function stoneShares(members, levels, stones) {
  const order = [...members].sort((a, b) => (levels[a] ?? 99) - (levels[b] ?? 99));
  const share = Object.fromEntries(order.map((m) => [m, {}]));
  let k = 0;
  for (const s of ["Greater Lightstone", "Lightstone"]) {
    for (let j = 0; j < (stones[s] ?? 0); j++) {
      const m = order[k++ % order.length];
      share[m][s] = (share[m][s] ?? 0) + 1;
    }
  }
  return order.filter((m) => Object.keys(share[m]).length).map((m) => ({ name: m, counts: share[m] }));
}
