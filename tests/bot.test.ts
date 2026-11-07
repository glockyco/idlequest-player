// Runs src/bot.js against a fake game page. Run with `bun test`.
import { expect, test, vi } from "bun:test";

interface PageEvent {
  ses: number;
  seq: number;
  t: number;
  type: string;
  text: string;
}
interface Alert {
  kind: string;
  wake: boolean;
  text: string;
}
interface Bot {
  timerId: Timer;
  fastTimerId: Timer;
  config: { upkeep: boolean; partyIds: number[]; routeStuckSec: number; readyStuckSec: number; rotation: string[] };
  state: { alerts: Alert[] };
  tick(): Promise<void>;
  upkeep(reason: string): Promise<string>;
  fastTick(): void;
  surplus(): { name: string }[];
  errand(opts: { zone: string; keep: string; item: string; minutes?: number; minCon?: number } | null): Promise<string>;
}
interface FakeGlobals {
  localStorage: { getItem(): null; setItem(): void };
  window: unknown;
  iq: unknown;
  iqBot?: Bot;
}

const store = (state: object) => ({ getState: () => state });

async function install(partyIds: number[] = []) {
  const recruited: number[] = [];
  // The active character and one companion, at full HP and mana unless a test changes them.
  const me = { id: 1, name: "Me", level: 14, inventory: [], experienceProgress: { current: 1 }, curHp: 300, maxHp: 300, mana: 200, maxMana: 200 };
  const tank = { name: "Tagujazolu", companionType: 2, characterId: 10, curHp: 500, maxHp: 500, curMana: 0, maxMana: 0 };
  // An enchanter who knows Cancel Magic, at full HP and mana.
  const ench = { id: "character-20", name: "Edroun", companionType: 2, characterId: 20, level: 22, curHp: 200, maxHp: 200, curMana: 300, maxMana: 300 };
  // Active effects by entity id, as the client's effects registry holds them; `root` marks a root.
  const effects = new Map<string, { effectId: string; spellId: number; casterLevel: number; remainingTicks: number; root: boolean }[]>();
  const skills = { inCombat: false };
  // Tactic changes the bot made, as [who, key, value].
  const tactics: [string, string, unknown][] = [];
  const autoLevel = { stops: 0, starts: 0 };
  const events: PageEvent[] = [];
  const seqs = { event: 0 };
  // AutoLevel's limits and the guard's tightening memory, which some tests change.
  const guard: { phase: string; preferred: { minCon: number; maxCon: number; maxLevelDiff: number } | null; trips: { t: number; reason: string; zone: number }[] } = { phase: "watching", preferred: null, trips: [] };
  const combat = {
    isRunning: true,
    isZoneLoading: false,
    currentZone: 58,
    noAutoSellBagInstanceIds: [],
    minCon: 4,
    maxCon: 13,
    maxLevelDiff: 5,
    setIsRunning: (on: boolean) => { if (!on) autoLevel.stops++; },
    startAutoLevel: () => autoLevel.starts++,
    setMinCon: (v: number) => { combat.minCon = v; },
    setMaxCon: (v: number) => { combat.maxCon = v; },
    setMaxLevelDiff: (v: number) => { combat.maxLevelDiff = v; },
    isAutoAttackEnabled: true,
    targetNPC: null as { spawnInstanceId: number; name: string } | null,
  };
  // The game runtime: the alive enemies, AutoLevel's skip list, the target approach of its
  // current pull and the Auto Attack button.
  const targets: { spawnInstanceId: number; name: string }[] = [];
  const runtime = {
    combatScene: { getAliveCombatTargetList: () => targets },
    deferred: [] as number[],
    deferAutoLevelSpawn: (id: number) => {
      runtime.deferred.push(id);
    },
    combatApproach: { attempt: null as { phase: string; spawnInstanceId: number } | null },
    presses: 0,
    attackSelectedTarget: () => {
      runtime.presses++;
      combat.isAutoAttackEnabled = true;
    },
  };
  const zones = [
    { shortName: "guktop", longName: "The City of Guk", zoneidnumber: 65 },
    { shortName: "permafrost", longName: "The Permafrost Caverns", zoneidnumber: 73 },
  ];
  const kills: { t: number; xp: number; enemy: string }[] = [];
  const moves: string[] = [];
  // Item rows in the bags, by name.
  const bag: { name: string }[] = [];
  // The spellbook and the party, which the upkeep test fills in.
  const book = {
    scribedSpells: [] as { spellId: number; spell: { name: string } }[],
    memorizedSpells: [] as { gemSlot: number; spellId: number }[],
    memorizeSpell: async (_id: number, _gem: number) => true,
  };
  const dismissed: string[] = [];
  const party = {
    companions: [tank, ench] as object[],
    botCombatDataMap: { "character-20": { level: 22, curHp: 200, scribedSpellIds: [48] } },
    requestAccountCharacterAvailability: () => {},
    controlAccountCharacter: (id: number) => recruited.push(id),
    dismissPet: (id: string) => dismissed.push(id),
  };
  // bot.js reads the page's globals, so the test provides them on globalThis.
  const g = globalThis as unknown as FakeGlobals;
  g.localStorage = { getItem: () => null, setItem: () => {} };
  g.window = globalThis;
  g.iqBot = undefined;
  g.iq = {
    events,
    seqs,
    session: 1,
    samples: [],
    kills,
    // Zone changes the bot asked for, by short name; the fake moves the party at once.
    changeZone: async (shortName: string) => {
      moves.push(shortName);
      combat.currentZone = zones.find((z) => z.shortName === shortName)?.zoneidnumber ?? combat.currentZone;
      return shortName;
    },
    mods: {
      game: { G: { getInstance: () => runtime } },
      effects: {
        l: { records: effects, getEffects: (id: string) => ({ active: effects.get(id) ?? [] }) },
        cm: ({ effects: list }: { effects: { root: boolean }[] }) => ({ isRooted: list.some((e) => e.root) }),
      },
    },
    setTactic: (who: string, key: string, value: unknown) => tactics.push([who, key, value]),
    guard,
    socket: { isConnected: true },
    bagSpace: () => ({ free: 30, capacity: 58, cursor: null }),
    inventory: () => bag,
    stores: {
      character: store({ characterProfile: me }),
      companions: store(party),
      combat: store(combat),
      screen: store({ currentScreen: "game" }),
      staticData: store({ zones }),
      skills: store(skills),
      spellbook: store(book),
      partySpells: store({ overridesByCompanion: { "character:20": { cure: false } } }),
    },
  };
  eval(await Bun.file(new URL("../src/bot.js", import.meta.url)).text());
  const bot = g.iqBot;
  if (!bot) throw new Error("bot.js did not install window.iqBot");
  clearInterval(bot.timerId);
  clearInterval(bot.fastTimerId);
  bot.config.upkeep = false;
  bot.config.partyIds = partyIds;
  await bot.tick(); // the first tick only sets the event cursor
  const say = (text: string, type = "SYSTEM") => events.push({ ses: 1, seq: ++seqs.event, t: Date.now(), type, text });
  return { bot, events, say, recruited, autoLevel, me, tank, combat, guard, kills, moves, runtime, targets, bag, effects, skills, tactics, book, party, dismissed };
}

test("chat lines that the bot's own alerts repeat are read once", async () => {
  // The bot logs each alert as an event whose text contains the chat line, so reading its own
  // lines back used to loop without end and crash the game tab.
  const { bot, events, say } = await install();
  say("Tagujazolu has reached level 15!");
  say("Tagujazolu has been slain!", "DEATH");
  await bot.tick();
  await bot.tick();
  expect(bot.state.alerts.map((a) => a.kind)).toEqual(["memberLevelUp", "death"]);
  expect(events.length).toBeLessThan(10);
});

test("a party member's death wakes an attached script, a pet's does not", async () => {
  const { bot, say } = await install();
  say("Tagujazolu has been slain!", "DEATH");
  say("Kekab has been slain!", "DEATH");
  await bot.tick();
  expect(bot.state.alerts.map((a) => [a.text, a.wake])).toEqual([
    ["Tagujazolu has been slain!", true],
    ["Kekab has been slain!", false],
  ]);
});

test("frequent waits for an enemy raise a crowded alert, a few do not", async () => {
  const few = await install();
  for (let k = 0; k < 5; k++) few.say("Waiting for an available enemy. AutoLevel will try again shortly.");
  await few.bot.tick();
  expect(few.bot.state.alerts.map((a) => a.kind)).not.toContain("crowded");

  const many = await install();
  for (let k = 0; k < 6; k++) many.say("Waiting for an available enemy. AutoLevel will try again shortly.");
  await many.bot.tick();
  expect(many.bot.state.alerts.filter((a) => a.kind === "crowded").map((a) => a.wake)).toEqual([true]);
});

test("account characters missing from the party are asked to rejoin", async () => {
  const { bot, recruited } = await install([10, 11, 12]);
  expect(bot.state.alerts.map((a) => a.kind)).toContain("rejoin");
  await Bun.sleep(5200);
  expect(recruited).toEqual([11, 12]);
}, 10000);

test("a route recovery that finds no target restarts AutoLevel, one that does is left alone", async () => {
  const hung = await install();
  vi.useFakeTimers();
  try {
    hung.say("No usable route. Recovering near Burynai excavator.");
    await hung.bot.tick();
    vi.advanceTimersByTime(hung.bot.config.routeStuckSec * 1000 + 1000);
    await hung.bot.tick();
    vi.advanceTimersByTime(2000);
    expect(hung.autoLevel).toEqual({ stops: 1, starts: 1 });

    const found = await install();
    found.say("No usable route. Recovering near Burynai excavator.");
    found.say("You engage Burynai sapper in combat!");
    await found.bot.tick();
    vi.advanceTimersByTime(found.bot.config.routeStuckSec * 1000 + 1000);
    await found.bot.tick();
    expect(found.autoLevel).toEqual({ stops: 0, starts: 0 });
  } finally {
    vi.useRealTimers();
  }
});

test("a readiness wait with everyone full restarts AutoLevel, one for a hurt member does not", async () => {
  vi.useFakeTimers();
  try {
    const hurt = await install();
    hurt.tank.curHp = 250;
    hurt.say("Waiting for party to be ready.");
    await hurt.bot.tick();
    vi.advanceTimersByTime(hurt.bot.config.readyStuckSec * 1000 + 1000);
    await hurt.bot.tick();
    vi.advanceTimersByTime(2000);
    expect(hurt.autoLevel).toEqual({ stops: 0, starts: 0 });

    const full = await install();
    full.say("Waiting for party to be ready.");
    await full.bot.tick();
    vi.advanceTimersByTime(full.bot.config.readyStuckSec * 1000 + 1000);
    await full.bot.tick();
    vi.advanceTimersByTime(2000);
    expect(full.autoLevel).toEqual({ stops: 1, starts: 1 });
  } finally {
    vi.useRealTimers();
  }
});

test("cleanup sells extra copies first, then cheap singles, and keeps food, research pieces and dear items", async () => {
  const { bot, me } = await install();
  const item = (slot: number, itemid: number, Name: string, price: number, extra: object = {}) => ({ bag: 23, slot, itemid, itemInstanceId: 100 + slot, quantity: 1, itemDetails: { Name, price, nodrop: 1, norent: 1, itemtype: 0, ...extra } });
  Object.assign(me, {
    inventory: [
      item(0, 1, "Rusty Mace", 100),
      item(1, 2, "Legionnaire's Bracer", 320),
      item(2, 2, "Legionnaire's Bracer", 320),
      item(3, 3, "Ration", 25, { itemtype: 14 }),
      item(4, 4, "Words of Tyranny", 200),
      item(5, 5, "Solist's Icy Wand", 10000),
      item(6, 10015, "Malachite", 50),
      item(7, 6, "Bone Chips", 15, { nodrop: 0 }),
    ],
  });
  const names = bot.surplus().map((s) => s.name);
  expect(names).toEqual(["Legionnaire's Bracer", "Rusty Mace", "Legionnaire's Bracer"]);
});

test("an empty zone first undoes the guard's tightening, then a raised minimum con, then wakes a script", async () => {
  const empty = "No available enemies found in this zone.";
  const tightened = await install();
  tightened.guard.preferred = { minCon: 4, maxCon: 13, maxLevelDiff: 5 };
  Object.assign(tightened.combat, { minCon: 4, maxCon: 15, maxLevelDiff: 2 });
  for (let k = 0; k < 3; k++) tightened.say(empty);
  await tightened.bot.tick();
  expect([tightened.combat.minCon, tightened.combat.maxCon, tightened.combat.maxLevelDiff, tightened.guard.preferred]).toEqual([4, 13, 5, null]);

  const picky = await install();
  picky.combat.minCon = 10;
  for (let k = 0; k < 3; k++) picky.say(empty);
  await picky.bot.tick();
  expect(picky.combat.minCon).toBe(4);

  const unfit = await install();
  for (let k = 0; k < 3; k++) unfit.say(empty);
  await unfit.bot.tick();
  expect(unfit.bot.state.alerts.filter((a) => a.kind === "noEnemies").map((a) => a.wake)).toEqual([true]);
});

test("rotation moves on from an empty zone and from one whose XP rate fell", async () => {
  vi.useFakeTimers();
  try {
    const empty = await install();
    empty.bot.config.rotation = ["guktop", "permafrost"];
    empty.combat.currentZone = 65;
    await empty.bot.tick();
    for (let k = 0; k < 3; k++) empty.say("No available enemies found in this zone.");
    await empty.bot.tick();
    expect(empty.moves).toEqual(["permafrost"]);
    expect(empty.bot.state.alerts.map((a) => a.kind)).not.toContain("noEnemies");

    const dry = await install();
    dry.bot.config.rotation = ["guktop", "permafrost"];
    dry.combat.currentZone = 65;
    await dry.bot.tick(); // arrival
    for (let m = 0; m < 10; m++) {
      vi.advanceTimersByTime(60000);
      dry.kills.push({ t: Date.now(), xp: 10000, enemy: "a froglok" });
    }
    await dry.bot.tick(); // ten minutes in: this visit's best ten minutes
    expect(dry.moves).toEqual([]);
    vi.advanceTimersByTime(11 * 60000); // nothing killed since
    await dry.bot.tick();
    expect(dry.moves).toEqual(["permafrost"]);

    const ambushed = await install();
    ambushed.bot.config.rotation = ["permafrost", "paw"];
    ambushed.combat.currentZone = 73;
    await ambushed.bot.tick();
    for (let k = 0; k < 4; k++) ambushed.guard.trips.push({ t: Date.now(), reason: "level: an ice giant L47", zone: 73 });
    await ambushed.bot.tick();
    expect(ambushed.moves).toEqual(["paw"]);
  } finally {
    vi.useRealTimers();
  }
});

test("an errand pulls only its enemies, holds rotation until the item drops, then rotates on", async () => {
  vi.useFakeTimers();
  try {
    const found = await install();
    found.bot.config.rotation = ["guktop", "permafrost"];
    found.combat.currentZone = 65;
    found.targets.push({ spawnInstanceId: 1, name: "a_gorged_ravener" }, { spawnInstanceId: 2, name: "a skeletal guardian" });
    await found.bot.errand({ zone: "permafrost", keep: "gorged|hungered|famished", item: "Power of Water", minCon: 2 });
    expect(found.moves).toEqual(["permafrost"]);
    expect(found.combat.minCon).toBe(2);
    found.bot.fastTick();
    expect(found.runtime.deferred).toEqual([2]);

    // An empty zone would rotate or wake a script, but the errand waits for respawns.
    for (let k = 0; k < 3; k++) found.say("No available enemies found in this zone.");
    await found.bot.tick();
    vi.advanceTimersByTime(25 * 60000);
    await found.bot.tick();
    expect(found.moves).toEqual(["permafrost"]);
    expect(found.bot.state.alerts.map((a) => a.kind)).not.toContain("noEnemies");

    found.bag.push({ name: "Power of Water" });
    await found.bot.tick();
    expect(found.moves).toEqual(["permafrost", "guktop"]);
    expect(found.combat.minCon).toBe(4);
    expect(found.bot.state.alerts.find((a) => a.kind === "errand")?.wake).toBe(false);
    found.runtime.deferred.length = 0;
    found.bot.fastTick();
    expect(found.runtime.deferred).toEqual([]);

    const late = await install();
    late.bot.config.rotation = ["guktop", "permafrost"];
    late.combat.currentZone = 65;
    await late.bot.errand({ zone: "permafrost", keep: "famished", item: "Power of Water", minutes: 30 });
    vi.advanceTimersByTime(31 * 60000);
    await late.bot.tick();
    expect(late.moves).toEqual(["permafrost", "guktop"]);
    expect(late.bot.state.alerts.find((a) => a.kind === "errand")?.wake).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

test("a pull standing at its target with Auto Attack off gets Auto Attack, and only such a pull", async () => {
  vi.useFakeTimers();
  try {
    const { bot, combat, runtime } = await install();
    combat.isAutoAttackEnabled = false;
    combat.targetNPC = { spawnInstanceId: 557, name: "a_goblin_archeologist" };
    const waitFor = async (sec: number) => {
      bot.fastTick();
      vi.advanceTimersByTime(sec * 1000);
      bot.fastTick();
    };

    // Still walking to the target: the client starts the fight on arrival by itself.
    runtime.combatApproach.attempt = { phase: "approaching", spawnInstanceId: 557 };
    await waitFor(10);
    // Standing at the target while AutoLevel is stopped: a player's choice.
    runtime.combatApproach.attempt = { phase: "waiting-to-attack", spawnInstanceId: 557 };
    combat.isRunning = false;
    await waitFor(10);
    expect(runtime.presses).toBe(0);

    // AutoLevel running and the pull standing at its target: press once, after attackWaitSec.
    combat.isRunning = true;
    await waitFor(1);
    expect(runtime.presses).toBe(0);
    await waitFor(3);
    expect(runtime.presses).toBe(1);
    await waitFor(10);
    expect(runtime.presses).toBe(1);
    expect(bot.state.alerts.filter((a) => a.kind === "autoAttack").length).toBe(1);
  } finally {
    vi.useRealTimers();
  }
});

test("a root that outlasts a fight is dispelled only when that saves time, and cures go back off", async () => {
  vi.useFakeTimers();
  try {
    const { bot, effects, skills, tactics } = await install();
    // The live client's runtime root: 6-second ticks left and an id that repeats for the same spell.
    const root = (sec: number) => effects.set("pet:1:pet", [{ effectId: "runtime:root:230:unknown:0", spellId: 230, casterLevel: 22, remainingTicks: sec / 6, root: true }]);

    // 32% per attempt at equal levels: about 28 s plus the overhead to dispel, so 20 s left is not worth it.
    root(18);
    bot.fastTick();
    // A long root during a fight: dispels in combat would only cost casts.
    root(120);
    skills.inCombat = true;
    bot.fastTick();
    expect(tactics).toEqual([]);

    // The fight ends with 120 s of root left: cures on, then back to their previous value once it is gone.
    skills.inCombat = false;
    bot.fastTick();
    expect(tactics).toEqual([["Edroun", "cure", true]]);
    effects.delete("pet:1:pet");
    bot.fastTick();
    expect(tactics.at(-1)).toEqual(["Edroun", "cure", false]);

    // A new pull starts before the dispel lands: cures go back off at once.
    root(120);
    bot.fastTick();
    skills.inCombat = true;
    bot.fastTick();
    expect(tactics.slice(-2)).toEqual([["Edroun", "cure", true], ["Edroun", "cure", false]]);
    expect(bot.state.alerts.filter((a) => a.kind === "dispel").length).toBe(4);
  } finally {
    vi.useRealTimers();
  }
});

test("upkeep keeps our pet when the new summon could not be memorized", async () => {
  vi.useFakeTimers();
  try {
    const { bot, combat, book, party, dismissed } = await install();
    // Lesser Summoning: Water in gem 0 and Summoning: Water newly learned; memorizing fails, as it
    // does when the character cannot sit.
    book.scribedSpells = [{ spellId: 497, spell: { name: "Lesser Summoning: Water" } }, { spellId: 570, spell: { name: "Summoning: Water" } }];
    book.memorizedSpells = [{ gemSlot: 0, spellId: 497 }];
    book.memorizeSpell = async () => false;
    Object.assign(combat, { isPlayerSitting: true, isSpellbookOpen: true, setPlayerSitting: () => {}, toggleSpellbook: () => {} });
    party.companions.push({ id: "pet-1", name: "Zonobtik", companionType: 1, petOwnerCharacterId: 1, level: 20 });

    const run = bot.upkeep("test");
    for (let k = 0; k < 40; k++) {
      vi.advanceTimersByTime(500);
      for (let j = 0; j < 5; j++) await Promise.resolve();
    }
    const result = await run;
    expect(dismissed).toEqual([]);
    expect(result).toContain("kept pet Zonobtik");
  } finally {
    vi.useRealTimers();
  }
});
