// Runs src/bot.js against a fake game page. Run with `bun test`.
import { expect, test, vi } from "bun:test";
import generatedSpells from "../data/class-spells.json";

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
  config: { upkeep: boolean; partyIds: number[]; leaderId: number | null; routeStuckSec: number; readyStuckSec: number; rotation: string[] };
  state: { alerts: Alert[]; switching: { name: string; done: boolean; ok: boolean | null } | null };
  pause(minutes: number, reason?: string): string;
  tick(): Promise<void>;
  upkeep(reason: string): Promise<string>;
  fastTick(): void;
  surplus(): { name: string }[];
  spellPlan(): { gem: number; role: string; id: number; name: string; level: number }[];
  errand(opts: { zone: string; keep: string; item?: string; minutes?: number } | null): Promise<string>;
}
interface FakeGlobals {
  sessionStorage: { getItem(): null; setItem(): void };
  window: unknown;
  iq: unknown;
  iqBot?: Bot;
}

// The client's per-class spell table as tools/class-spells.mjs writes it, reduced to what the bot reads.
interface TableSpell {
  spellId: number;
  category: number;
  minLevel: number;
  targetType: number;
  name: string;
  hp: number;
  reagents: { id: number; count: number }[];
  tags: string[];
}
interface ClassTable {
  healThreshold: number;
  spells: TableSpell[];
}
type SpellTable = Record<string, ClassTable | null>;
const generated: SpellTable = generatedSpells;

const store = (state: object) => ({ getState: () => state });

async function install(partyIds: number[] = []) {
  const recruited: number[] = [];
  // The active character and one companion, at full HP and mana unless a test changes them.
  const me = { id: 1, class: 0, name: "Me", level: 14, inventory: [], experienceProgress: { current: 1 }, curHp: 300, maxHp: 300, mana: 200, maxMana: 200 };
  const tank = { name: "Tagujazolu", companionType: 2, characterId: 10, curHp: 500, maxHp: 500, curMana: 0, maxMana: 0 };
  // An enchanter who knows Cancel Magic, at full HP and mana.
  const ench = { id: "character-20", name: "Edroun", companionType: 2, characterId: 20, level: 22, curHp: 200, maxHp: 200, curMana: 300, maxMana: 300 };
  // Active effects by entity id, as the client's effects registry holds them; `root` marks a root.
  const effects = new Map<string, { effectId: string; spellId: number; casterLevel: number; remainingTicks: number; root: boolean }[]>();
  const skills = { inCombat: false };
  // The raid store's mode flag, which a test can switch on.
  const raid = { raidModeActive: false };
  // Tactic changes the bot made, as [who, key, value].
  const tactics: [string, string, unknown][] = [];
  const spells: { overridesByCompanion: Record<string, Record<string, unknown>> } = { overridesByCompanion: { "character:10": { cure: false }, "character:20": { cure: false } } };
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
  const bag: { id?: number; name: string; quantity?: number }[] = [];
  // The spellbook and the party, which the upkeep test fills in.
  const book = {
    scribedSpells: [] as { spellId: number; spell: { name: string } }[],
    memorizedSpells: [] as { gemSlot: number; spellId: number }[],
    memorizeSpell: async (_id: number, _gem: number) => true,
    unmemorizeSpell: async (_gem: number) => {},
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
  g.sessionStorage = { getItem: () => null, setItem: () => {} };
  g.window = globalThis;
  g.iqBot = undefined;
  // The account's characters, the active one and the screen, which the camp and enter-world
  // commands change the way the client does. Camping releases the companions.
  const roster = { characters: [{ id: 1, name: "Me" }, { id: 10, name: "Tagujazolu" }, { id: 20, name: "Edroun" }] };
  const sheet = { characterProfile: me as typeof me };
  const screen = { currentScreen: "game" };
  const commands: string[] = [];
  const commandReply = { enterWorld: { ok: true } as { ok: boolean; message?: string } };
  const command = async (c: { type: string; selector?: string }) => {
    commands.push(c.selector ? `${c.type} ${c.selector}` : c.type);
    if (c.type === "session.camp") {
      screen.currentScreen = "characterSelect";
      party.companions = [];
      return { ok: true };
    }
    const who = roster.characters.find((x) => x.name === c.selector);
    if (c.type !== "session.enterWorld" || !who || !commandReply.enterWorld.ok) return { ok: false, message: commandReply.enterWorld.message ?? "refused" };
    sheet.characterProfile = { ...me, id: who.id, name: who.name };
    screen.currentScreen = "game";
    return { ok: true };
  };
  const activity: { act: string; why: string | null; since: number } = { act: "fight", why: null, since: Date.now() };
  const iq = {
    // The client's spell table by class id, which the tests that plan gems fill in.
    classSpells: {} as SpellTable,
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
    command,
    // Like the bridge, a tactic for an account companion lands in the party spells store.
    setTactic: (who: string, key: string, value: unknown) => {
      tactics.push([who, key, value]);
      const c = (party.companions as { name: string; characterId?: number }[]).find((x) => x.name === who);
      if (c?.characterId) (spells.overridesByCompanion[`character:${c.characterId}`] ??= {})[key] = value;
    },
    guard,
    socket: { isConnected: true },
    bagSpace: () => ({ free: 30, capacity: 58, cursor: null }),
    // The bridge's activity label, which tests set to the situation they need.
    activity: () => activity,
    // The bridge's readiness check over the fake party: full HP, and full mana for casters.
    partyFull: () =>
      me.curHp >= me.maxHp && me.mana >= me.maxMana && (party.companions as { curHp: number; maxHp: number; curMana: number; maxMana: number }[]).every((c) => c.curHp >= c.maxHp && (!(c.maxMana > 0) || c.curMana >= c.maxMana)),
    inventory: () => bag,
    stores: {
      character: store(sheet),
      companions: store(party),
      combat: store(combat),
      screen: store(screen),
      roster: store(roster),
      staticData: store({ zones }),
      skills: store(skills),
      spellbook: store(book),
      partySpells: store(spells),
      raid: store(raid),
    },
  };
  g.iq = iq;
  eval(await Bun.file(new URL("../src/bot.js", import.meta.url)).text());
  const bot = g.iqBot;
  if (!bot) throw new Error("bot.js did not install window.iqBot");
  clearInterval(bot.timerId);
  clearInterval(bot.fastTimerId);
  bot.config.upkeep = false;
  bot.config.partyIds = partyIds;
  await bot.tick(); // the first tick only sets the event cursor
  const say = (text: string, type = "SYSTEM") => events.push({ ses: 1, seq: ++seqs.event, t: Date.now(), type, text });
  return { iq, bot, events, say, recruited, autoLevel, me, tank, combat, guard, kills, moves, runtime, targets, bag, effects, skills, tactics, book, party, dismissed, raid, sheet, screen, commands, commandReply, activity };
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

test("deaths wake a script once their cost passes a tenth of the hour, and a leader's lost XP counts", async () => {
  const { bot, say } = await install();
  for (let k = 0; k < 6; k++) say("Kekab has been slain!", "DEATH"); // a pet's deaths do not count
  for (let k = 0; k < 6; k++) say("Tagujazolu has been slain!", "DEATH"); // six companion deaths cost under 6 minutes
  await bot.tick();
  await bot.tick();
  expect(bot.state.alerts.filter((a) => a.wake)).toEqual([]);
  for (let k = 0; k < 4; k++) say("Tagujazolu has been slain!", "DEATH");
  await bot.tick();
  expect(bot.state.alerts.filter((a) => a.wake).map((a) => a.kind)).toEqual(["deaths"]);

  // At level 14 a leader death loses 130,667 XP, 20 minutes at 400k XP an hour.
  const lead = await install();
  lead.kills.push({ t: Date.now() - 60000, xp: 400000, enemy: "a rat" });
  lead.say("You have been slain by a rat!", "DEATH");
  await lead.bot.tick();
  await lead.bot.tick();
  expect(lead.bot.state.alerts.filter((a) => a.wake).map((a) => a.text)).toEqual([expect.stringContaining("(1 of the leader) cost about 21 minutes")]);
});

test("the remedy table widens a crowded party's limits, then moves it, and wakes a script when nothing is left", async () => {
  vi.useFakeTimers();
  try {
    const p = await install();
    p.bot.config.rotation = ["guktop", "permafrost"];
    p.combat.currentZone = 65;
    p.combat.minCon = 10;
    await p.bot.tick();
    Object.assign(p.activity, { act: "idle", why: "crowded", since: Date.now() });
    vi.advanceTimersByTime(30000);
    await p.bot.tick();
    expect([p.combat.minCon, p.moves]).toEqual([10, []]);
    vi.advanceTimersByTime(31000);
    await p.bot.tick();
    expect([p.combat.minCon, p.moves]).toEqual([4, []]);
    vi.advanceTimersByTime(61000);
    await p.bot.tick();
    expect(p.moves).toEqual(["permafrost"]);

    const alone = await install();
    alone.combat.minCon = 4;
    Object.assign(alone.activity, { act: "idle", why: "crowded", since: Date.now() - 61000 });
    await alone.bot.tick();
    await alone.bot.tick();
    expect(alone.bot.state.alerts.filter((a) => a.kind === "idle").map((a) => a.wake)).toEqual([true]);
  } finally {
    vi.useRealTimers();
  }
});

test("widened limits return to the target limits after widenMin, and a move starts from them", async () => {
  vi.useFakeTimers();
  try {
    const p = await install();
    p.bot.config.rotation = ["guktop", "permafrost"];
    p.bot.config.limits = { minCon: 10, maxCon: 13, maxLevelDiff: 5 };
    p.combat.currentZone = 65;
    Object.assign(p.combat, { minCon: 10, maxCon: 13, maxLevelDiff: 5 });
    Object.assign(p.activity, { act: "idle", why: "crowded", since: Date.now() - 61000 });
    await p.bot.tick();
    expect(p.combat.minCon).toBe(4);
    Object.assign(p.activity, { act: "fight", why: null, since: Date.now() });
    vi.advanceTimersByTime(19 * 60000);
    await p.bot.tick();
    expect(p.combat.minCon).toBe(4);
    vi.advanceTimersByTime(2 * 60000);
    await p.bot.tick();
    expect([p.combat.minCon, p.combat.maxCon, p.combat.maxLevelDiff]).toEqual([10, 13, 5]);

    // With the guard holding a tightened cap, the cons follow the target and the cap stays, and the
    // guard's return goes to the target.
    Object.assign(p.combat, { minCon: 4, maxLevelDiff: 3 });
    p.guard.preferred = { minCon: 4, maxCon: 13, maxLevelDiff: 5 };
    await p.bot.tick();
    expect([p.combat.minCon, p.combat.maxLevelDiff, p.guard.preferred]).toEqual([10, 3, { minCon: 10, maxCon: 13, maxLevelDiff: 5 }]);
    p.guard.preferred = null;
    p.combat.maxLevelDiff = 5;

    // A party that widened and then moves hunts the new zone at the target limits.
    p.combat.minCon = 4;
    p.bot.state.widenedAt = Date.now();
    Object.assign(p.activity, { act: "idle", why: "crowded", since: Date.now() - 61000 });
    p.bot.state.idleCase = { why: "crowded", rung: 1, at: Date.now() - 61000 };
    await p.bot.tick();
    expect([p.moves, p.combat.minCon]).toEqual([["permafrost"], 10]);
  } finally {
    vi.useRealTimers();
  }
});

test("account characters missing from the party are asked to rejoin", async () => {
  const { bot, recruited } = await install([10, 11, 12]);
  expect(bot.state.alerts.map((a) => a.kind)).toContain("rejoin");
  await Bun.sleep(5200);
  expect(recruited).toEqual([11, 12]);
}, 10000);

test("a party short of members stops pulling during a fight and asks them to rejoin once it ends", async () => {
  const p = await install([10, 20]);
  p.party.companions.splice(1); // Edroun (20) dropped out
  p.skills.inCombat = true;
  p.combat.isRunning = true;
  p.bot.state.rejoinAt = 0;
  await p.bot.tick();
  expect([p.autoLevel.stops, p.recruited]).toEqual([1, []]);
  p.skills.inCombat = false;
  await p.bot.tick();
  await Bun.sleep(2600);
  expect(p.recruited).toEqual([20]);
}, 10000);

test("a target or readiness hang restarts AutoLevel, and the client's own pause after a kill is left alone", async () => {
  vi.useFakeTimers();
  try {
    const hung = await install();
    Object.assign(hung.activity, { act: "idle", why: "noTarget", since: Date.now() - 21000 });
    await hung.bot.tick();
    vi.advanceTimersByTime(2000);
    expect(hung.autoLevel).toEqual({ stops: 1, starts: 1 });

    const ready = await install();
    Object.assign(ready.activity, { act: "idle", why: "readyWait", since: Date.now() - 31000 });
    await ready.bot.tick();
    vi.advanceTimersByTime(2000);
    expect(ready.autoLevel).toEqual({ stops: 1, starts: 1 });

    const fighting = await install();
    Object.assign(fighting.activity, { act: "idle", why: "afterKill", since: Date.now() - 60000 });
    await fighting.bot.tick();
    expect(fighting.autoLevel).toEqual({ stops: 0, starts: 0 });
  } finally {
    vi.useRealTimers();
  }
});

test("a dead leader takes a free group resurrection, else the best one it can pay above its reserve, else respawns", async () => {
  const { bot } = await install();
  const paid = [
    { percent: 50, price: 50 },
    { percent: 90, price: 200 },
    { percent: 96, price: 1000 },
  ];
  // 96% for 1000pp is above rezMaxPp (200), so 90% is the most it buys.
  expect(bot.recoveryChoice(paid, 2400)).toEqual({ percent: 90, price: 200 });
  // 260pp leaves 160 to spend above the 100pp reserve: 50% only.
  expect(bot.recoveryChoice(paid, 260)).toEqual({ percent: 50, price: 50 });
  expect(bot.recoveryChoice(paid, 140)).toBeNull();
  expect(bot.recoveryChoice([{ percent: 75, price: 0 }, ...paid.slice(1)], 0)).toEqual({ percent: 75, price: 0 });
  expect(bot.recoveryChoice([], 5000)).toBeNull();
});

test("a leader at 0 HP with no recovery pending camps and enters the world again after three respawn waits", async () => {
  vi.useFakeTimers();
  const g = globalThis as unknown as { document?: unknown };
  g.document = { querySelector: () => null, querySelectorAll: () => [] };
  try {
    const f = await install();
    f.bot.config.leaderId = 1;
    f.bot.config.respawnAfterSec = 20;
    f.me.curHp = 0;
    await f.bot.tick();
    vi.advanceTimersByTime(30000);
    await f.bot.tick();
    await flush();
    expect(f.commands).toEqual([]);
    // A death the client still recovers from waits for its window.
    Object.assign(f.sheet.characterProfile, { deathRecoveryReadyAt: Date.now() + 5000 });
    vi.advanceTimersByTime(40000);
    await f.bot.tick();
    await flush();
    expect(f.commands).toEqual([]);
    Object.assign(f.sheet.characterProfile, { deathRecoveryReadyAt: 0 });
    await f.bot.tick();
    await flush();
    expect(f.commands).toEqual(["session.camp", "session.enterWorld Me"]);
  } finally {
    delete g.document;
    vi.useRealTimers();
  }
});

test("cleanup sells extra copies first, then singles by value, and keeps food, research pieces and items with an effect", async () => {
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
      item(8, 7, "Charm of Vigor", 50, { worneffect: 12 }),
      item(6, 10015, "Malachite", 50),
      item(7, 6, "Bone Chips", 15, { nodrop: 0 }),
    ],
  });
  const names = bot.surplus().map((s) => s.name);
  expect(names).toEqual(["Legionnaire's Bracer", "Rusty Mace", "Legionnaire's Bracer", "Solist's Icy Wand"]);
});

test("cleanup keeps the last copy of a quest turn-in item and sells its extra copies", async () => {
  const { bot, me, iq } = await install();
  const item = (slot: number, itemid: number, Name: string, price: number) => ({ bag: 23, slot, itemid, itemInstanceId: 100 + slot, quantity: 1, itemDetails: { Name, price, nodrop: 1, norent: 1, itemtype: 0 } });
  Object.assign(me, { inventory: [item(0, 16539, "Hill Giant Toes", 200), item(1, 16539, "Hill Giant Toes", 200), item(2, 1, "Rusty Mace", 100)] });
  Object.assign(iq, { questItems: [16539] });
  expect(bot.surplus().map((s) => s.name)).toEqual(["Hill Giant Toes", "Rusty Mace"]);
});

test("an empty zone first undoes the guard's tightening, then a raised minimum con, then wakes a script", async () => {
  const empty = { act: "idle", why: "noEnemies", since: Date.now() };
  const tightened = await install();
  tightened.guard.preferred = { minCon: 4, maxCon: 13, maxLevelDiff: 5 };
  Object.assign(tightened.combat, { minCon: 4, maxCon: 15, maxLevelDiff: 2 });
  Object.assign(tightened.activity, empty);
  await tightened.bot.tick();
  expect([tightened.combat.minCon, tightened.combat.maxCon, tightened.combat.maxLevelDiff, tightened.guard.preferred]).toEqual([4, 13, 5, null]);

  const picky = await install();
  picky.combat.minCon = 10;
  Object.assign(picky.activity, empty);
  await picky.bot.tick();
  expect(picky.combat.minCon).toBe(4);

  const unfit = await install();
  Object.assign(unfit.activity, empty);
  await unfit.bot.tick();
  expect(unfit.bot.state.alerts.filter((a) => a.kind === "idle").map((a) => a.wake)).toEqual([true]);
});

test("rotation moves on from a zone whose XP rate fell or whose guard keeps escaping", async () => {
  vi.useFakeTimers();
  try {
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

test("an errand puts its enemies first while AutoLevel can pull one and holds rotation until its item drops or its minutes end", async () => {
  vi.useFakeTimers();
  try {
    const found = await install();
    found.bot.config.rotation = ["guktop", "permafrost"];
    found.combat.currentZone = 65;
    const bounds = { minLevel: 30, maxLevel: 40 };
    Object.assign(found.runtime, { getAutoCombatLevelBounds: () => bounds });
    found.targets.push({ spawnInstanceId: 1, name: "a_gorged_ravener", level: 34 } as { spawnInstanceId: number; name: string }, { spawnInstanceId: 2, name: "a skeletal guardian", level: 33 } as { spawnInstanceId: number; name: string });
    await found.bot.errand({ zone: "permafrost", keep: "gorged|hungered|famished", item: "Power of Water" });
    expect(found.moves).toEqual(["permafrost"]);
    found.bot.fastTick();
    expect(found.runtime.deferred).toEqual([2]);

    // A wanted enemy AutoLevel cannot pull, or none alive, leaves the party hunting the others.
    found.runtime.deferred.length = 0;
    Object.assign(bounds, { minLevel: 35 });
    found.bot.fastTick();
    expect(found.runtime.deferred).toEqual([]);
    Object.assign(bounds, { minLevel: 30 });
    found.targets.splice(0, 1);
    found.bot.fastTick();
    expect(found.runtime.deferred).toEqual([]);

    // An empty zone would rotate or wake a script, but the errand waits for respawns.
    for (let k = 0; k < 3; k++) found.say("No available enemies found in this zone.");
    await found.bot.tick();
    vi.advanceTimersByTime(25 * 60000);
    await found.bot.tick();
    expect(found.moves).toEqual(["permafrost"]);
    expect(found.bot.state.alerts.map((a) => a.kind)).not.toContain("noEnemies");

    // The item ends the errand in a zone of the rotation, where the party keeps hunting.
    found.bag.push({ name: "Power of Water" });
    await found.bot.tick();
    expect(found.moves).toEqual(["permafrost"]);
    expect(found.bot.state.alerts.find((a) => a.kind === "errand")?.wake).toBe(false);
    found.runtime.deferred.length = 0;
    found.bot.fastTick();
    expect(found.runtime.deferred).toEqual([]);

    // Without an item the errand farms until its minutes are up, and that end is not a failure.
    const farm = await install();
    farm.bot.config.rotation = ["guktop", "permafrost"];
    farm.combat.currentZone = 65;
    await farm.bot.errand({ zone: "permafrost", keep: "wisp", minutes: 30 });
    vi.advanceTimersByTime(31 * 60000);
    await farm.bot.tick();
    expect(farm.bot.state.alerts.find((a) => a.kind === "errand")?.wake).toBe(false);

    // An errand without its item wakes a script, and a party outside its rotation moves back into it.
    const late = await install();
    late.bot.config.rotation = ["guktop"];
    late.combat.currentZone = 65;
    await late.bot.errand({ zone: "permafrost", keep: "famished", item: "Power of Water", minutes: 30 });
    vi.advanceTimersByTime(31 * 60000);
    await late.bot.tick();
    expect(late.bot.state.alerts.find((a) => a.kind === "errand")?.wake).toBe(true);
    expect(late.moves).toEqual(["permafrost"]);
    vi.advanceTimersByTime(61000);
    await late.bot.tick();
    expect(late.moves).toEqual(["permafrost", "guktop"]);
  } finally {
    vi.useRealTimers();
  }
});

test("an errand widens AutoLevel's range for its enemies, keeps the others in the normal range and restores the limits", async () => {
  vi.useFakeTimers();
  try {
    const f = await install();
    f.combat.currentZone = 73;
    // A level 7 party pulls levels 7 and 8; blue reaches down to 5, green to 3, and the cap adds to the leader's level.
    Object.assign(f.combat, { minCon: 10, maxCon: 10, maxLevelDiff: 1 });
    Object.assign(f.me, { level: 7 });
    Object.assign(f.runtime, { getAutoCombatLevelBounds: () => ({ minLevel: f.combat.minCon <= 2 ? 3 : f.combat.minCon <= 4 ? 5 : 7, maxLevel: 7 + f.combat.maxLevelDiff }) });
    // A level 15 wisp lies 8 levels up, where the guard (levelGap 8) leaves the fight, so the range stops at 11.
    Object.assign(f.iq, { zoneSpawns: { spawns: [{ name: "a_willowisp", level: 9 }, { name: "a_greater_wisp", level: 11 }, { name: "an_elder_wisp", level: 15 }, { name: "a_skeleton", level: 8 }] } });
    Object.assign(f.guard, { config: { enabled: true, levelGap: 8 } });
    await f.bot.errand({ zone: "permafrost", keep: "wisp", minutes: 60 });
    expect(f.combat.maxLevelDiff).toBe(4);
    expect(f.combat.minCon).toBe(10);

    // No wisp up: the party hunts its normal levels, and a level 10 enemy that only the wider range takes stays skipped.
    f.targets.push({ spawnInstanceId: 1, name: "a_skeleton", level: 8 } as { spawnInstanceId: number; name: string }, { spawnInstanceId: 2, name: "a_ghoul", level: 10 } as { spawnInstanceId: number; name: string });
    f.bot.fastTick();
    expect(f.runtime.deferred).toEqual([2]);

    // A wisp up: everything else waits.
    f.runtime.deferred.length = 0;
    f.targets.push({ spawnInstanceId: 3, name: "a_greater_wisp", level: 11 } as { spawnInstanceId: number; name: string });
    f.bot.fastTick();
    expect(f.runtime.deferred).toEqual([1, 2]);

    await f.bot.errand(null);
    expect(f.combat).toMatchObject({ minCon: 10, maxCon: 10, maxLevelDiff: 1 });
  } finally {
    vi.useRealTimers();
  }
});

test("a fight that makes no headway is left after slowFightSec and its enemy is skipped from then on", async () => {
  vi.useFakeTimers();
  try {
    const f = await install();
    const left: string[] = [];
    Object.assign(f.iq, { leaveFight: (why: string) => left.push(why) });
    Object.assign(f.combat, { engagedMobs: { 1: { name: "a_willowisp", state: "alive", hp: 160, maxHp: 171 } } });
    f.skills.inCombat = true;
    f.say("You engage a willowisp in combat!");
    await f.bot.tick();
    vi.advanceTimersByTime(170000);
    f.bot.fastTick();
    expect(left).toEqual([]);
    vi.advanceTimersByTime(15000);
    f.bot.fastTick();
    expect(left.length).toBe(1);
    expect(left[0]).toContain("a willowisp");

    f.skills.inCombat = false;
    f.targets.push({ spawnInstanceId: 5, name: "a_willowisp", level: 9 } as { spawnInstanceId: number; name: string }, { spawnInstanceId: 6, name: "a_skeleton", level: 8 } as { spawnInstanceId: number; name: string });
    f.bot.fastTick();
    expect(f.runtime.deferred).toEqual([5]);

    // Two levels later the party may have the spells or weapons it lacked.
    f.runtime.deferred.length = 0;
    Object.assign(f.me, { level: f.me.level + 2 });
    f.bot.fastTick();
    expect(f.runtime.deferred).toEqual([]);
  } finally {
    vi.useRealTimers();
  }
});

test("an enemy that pays far less XP per fight second than the party's usual is skipped", async () => {
  vi.useFakeTimers();
  try {
    const f = await install();
    const fight = async (name: string, secs: number, xp: number) => {
      f.say(`You engage ${name} in combat!`);
      vi.advanceTimersByTime(secs * 1000);
      f.say(`You have defeated ${name} and gained ${xp} experience!`);
      await f.bot.tick();
    };
    for (let k = 0; k < 10; k++) await fight("a skeleton", 20, 1000);
    await fight("a fire beetle", 60, 1000);
    await fight("a stone golem", 150, 1000);
    f.targets.push({ spawnInstanceId: 7, name: "a_skeleton", level: 8 } as { spawnInstanceId: number; name: string }, { spawnInstanceId: 8, name: "a_fire_beetle", level: 8 } as { spawnInstanceId: number; name: string }, { spawnInstanceId: 9, name: "a_stone_golem", level: 8 } as { spawnInstanceId: number; name: string });
    f.bot.fastTick();
    expect(f.runtime.deferred).toEqual([9]);
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

test("in raid mode the bot leaves AutoLevel off, and restarts it after the raid", async () => {
  vi.useFakeTimers();
  try {
    const { bot, combat, raid, autoLevel } = await install();
    raid.raidModeActive = true;
    combat.isRunning = false;
    await bot.tick();
    vi.advanceTimersByTime(120000);
    await bot.tick();
    expect(autoLevel.starts).toBe(0);

    raid.raidModeActive = false;
    await bot.tick();
    vi.advanceTimersByTime(120000);
    await bot.tick();
    expect(autoLevel.starts).toBe(1);
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

// ---- Gem plans and pets for every class --------------------------------------------------

const MAGICIAN = 13;
const scribe = (book: { scribedSpells: { spellId: number; spell: { name: string } }[] }, ids: number[]) => {
  book.scribedSpells = ids.map((spellId) => ({ spellId, spell: { name: `spell ${spellId}` } }));
};
// The ids of a class's table up to a level.
const tableIds = (table: SpellTable, classId: number, level: number) => (table[classId]?.spells ?? []).filter((s) => s.minLevel <= level).map((s) => s.spellId);

test("a Magician at level 31 keeps its pet, nuke and pet heal, and nothing the client does not cast", async () => {
  const { iq, bot, me, book } = await install();
  iq.classSpells = generated;
  Object.assign(me, { class: MAGICIAN, level: 31 });
  // Learned Magician spells, two of them (a level 34 pet heal and a level 60 nuke) outside the
  // client's auto-cast table for Magicians.
  scribe(book, [574, 113, 1505, 3584, 2118]);
  expect(bot.spellPlan().map((s) => s.id)).toEqual([574, 113, 1505]);
});

// Gem, role and spell id at level 31 with everything learned. The gem of a role is fixed by the
// class's budget, so a Shaman's gem 0 waits for its first pet spell and a Cleric has none.
const EXPECTED: Record<number, [number, string, number][]> = {
  2: [[0, "nuke", 329], [1, "heal", 15], [2, "heal", 12]],
  10: [[1, "nuke", 508], [2, "heal", 15], [3, "heal", 12], [4, "control", 506], [5, "dot", 434]],
  14: [[0, "pet", 686], [1, "nuke", 350], [2, "control", 185], [3, "dot", 450]],
  11: [[0, "pet", 441], [1, "nuke", 204], [2, "control", 2542], [3, "lifetap", 524], [4, "dot", 451]],
};

for (const [classId, name] of [[2, "Cleric"], [10, "Shaman"], [14, "Enchanter"], [11, "Necromancer"]] as const) {
  test(`a ${name} at level 31 gets a plan of spells from its own table only`, async () => {
    const { iq, bot, me, book } = await install();
    iq.classSpells = generated;
    Object.assign(me, { class: classId, level: 31 });
    // Everything the class has learned by level 31, and every Magician spell as a decoy.
    scribe(book, [...tableIds(generated, classId, 31), ...tableIds(generated, MAGICIAN, 31)]);
    const plan = bot.spellPlan();
    const own = new Set(tableIds(generated, classId, 31));
    expect(plan.length).toBeGreaterThan(2);
    expect(plan.every((p) => own.has(p.id))).toBe(true);
    expect(new Set(plan.map((p) => p.gem)).size).toBe(plan.length);
    expect(plan.map((p) => [p.gem, p.role, p.id])).toEqual(EXPECTED[classId]);
  });
}
test("a Warrior, Monk or Rogue has no spell table and an empty plan", async () => {
  for (const classId of [1, 7, 9]) {
    const { iq, bot, me, book } = await install();
    iq.classSpells = generated;
    Object.assign(me, { class: classId, level: 31 });
    scribe(book, tableIds(generated, MAGICIAN, 31));
    expect(bot.spellPlan()).toEqual([]);
  }
});

test("a Bard has three gems, all songs from its own table", async () => {
  const { iq, bot, me, book } = await install();
  iq.classSpells = generated;
  Object.assign(me, { class: 8, level: 31 });
  scribe(book, [...tableIds(generated, 8, 31), ...tableIds(generated, MAGICIAN, 31)]);
  const plan = bot.spellPlan();
  const own = new Set(tableIds(generated, 8, 31));
  expect(plan.map((p) => [p.gem, p.role, p.id])).toEqual([[0, "buff", 2603], [1, "buff", 715], [2, "buff", 712]]);
  expect(plan.every((p) => own.has(p.id))).toBe(true);
});

test("a role keeps the gem of a spell it already holds when a better one is learned", async () => {
  vi.useFakeTimers();
  try {
    const { iq, bot, me, book, combat } = await install();
    iq.classSpells = generated;
    Object.assign(me, { class: 2, level: 34 });
    scribe(book, [329, 15, 12, 9]);
    book.memorizedSpells = [{ gemSlot: 0, spellId: 329 }, { gemSlot: 1, spellId: 15 }, { gemSlot: 2, spellId: 12 }];
    const memorized: number[][] = [];
    book.memorizeSpell = async (id: number, gem: number) => {
      memorized.push([id, gem]);
      return true;
    };
    Object.assign(combat, { isPlayerSitting: true, isSpellbookOpen: true, setPlayerSitting: () => {}, toggleSpellbook: () => {} });
    // Greater Healing stays in gem 1 and Superior Healing replaces the lesser heal in gem 2.
    expect(bot.spellPlan().map((p) => [p.gem, p.id])).toEqual([[0, 329], [1, 15], [2, 9]]);
    await settle(bot.upkeep("test"));
    expect(memorized).toEqual([[9, 2]]);
  } finally {
    vi.useRealTimers();
  }
});

test("a class without a spell table keeps its gems and its pets", async () => {
  const { iq, bot, me, book, party, dismissed } = await install();
  iq.classSpells = generated;
  Object.assign(me, { class: 1, level: 31 });
  scribe(book, tableIds(generated, MAGICIAN, 31));
  book.memorizedSpells = [{ gemSlot: 0, spellId: 497 }];
  party.companions.push({ id: "pet-1", name: "Zonobtik", companionType: 1, petOwnerCharacterId: 1, level: 20 });
  expect(await bot.upkeep("test")).toBe("nothing to change");
  expect(book.memorizedSpells).toEqual([{ gemSlot: 0, spellId: 497 }]);
  expect(dismissed).toEqual([]);
});

// Runs a pending upkeep to its end under fake timers.
async function settle<T>(run: Promise<T>): Promise<T> {
  for (let k = 0; k < 60; k++) {
    vi.advanceTimersByTime(500);
    for (let j = 0; j < 5; j++) await Promise.resolve();
  }
  return run;
}

// A leader of a pet class, level 31, with its old pet and a newly learned summon.
async function petLeader(classId: number, oldSummon: number, newSummon: number, memorize: boolean) {
  const page = await install();
  page.iq.classSpells = generated;
  Object.assign(page.me, { class: classId, level: 31 });
  scribe(page.book, [oldSummon, newSummon]);
  page.book.memorizedSpells = [{ gemSlot: 0, spellId: oldSummon }];
  page.book.memorizeSpell = async (id: number, gem: number) => {
    if (!memorize) return false;
    page.book.memorizedSpells = page.book.memorizedSpells.filter((m) => m.gemSlot !== gem);
    page.book.memorizedSpells.push({ gemSlot: gem, spellId: id });
    return true;
  };
  Object.assign(page.combat, { isPlayerSitting: true, isSpellbookOpen: true, setPlayerSitting: () => {}, toggleSpellbook: () => {} });
  page.party.companions.push({ id: "pet-1", name: "Zonobtik", companionType: 1, petOwnerCharacterId: 1, level: 24 });
  return page;
}

test("upkeep keeps our pet when the new summon could not be memorized", async () => {
  vi.useFakeTimers();
  try {
    // Lesser Summoning: Water in gem 0 and Summoning: Water newly learned; memorizing fails, as it
    // does when the character cannot sit.
    const { bot, dismissed } = await petLeader(MAGICIAN, 497, 570, false);
    const result = await settle(bot.upkeep("test"));
    expect(dismissed).toEqual([]);
    expect(result).toContain("kept pet Zonobtik");
  } finally {
    vi.useRealTimers();
  }
});

test("a Necromancer replaces its pet by the new summon only when the reagent is in the bags", async () => {
  vi.useFakeTimers();
  try {
    // Haunting Corpse to Summon Dead, which needs Bone Chips.
    const without = await petLeader(11, 493, 441, true);
    const kept = await settle(without.bot.upkeep("test"));
    expect(without.book.memorizedSpells).toEqual([{ gemSlot: 0, spellId: 441 }]);
    expect(without.dismissed).toEqual([]);
    expect(kept).toContain("kept pet Zonobtik");

    const withChips = await petLeader(11, 493, 441, true);
    withChips.bag.push({ id: 13073, name: "Bone Chips", quantity: 5 });
    const replaced = await settle(withChips.bot.upkeep("test"));
    expect(withChips.dismissed).toEqual(["pet-1"]);
    expect(replaced).toContain("replaced pet Zonobtik");
  } finally {
    vi.useRealTimers();
  }
});

test("a Cleric never replaces a pet, whatever it learns", async () => {
  vi.useFakeTimers();
  try {
    const { iq, bot, me, book, combat, party, dismissed } = await install();
    iq.classSpells = generated;
    Object.assign(me, { class: 2, level: 31 });
    scribe(book, [329, 15]);
    book.memorizeSpell = async () => true;
    Object.assign(combat, { isPlayerSitting: true, isSpellbookOpen: true, setPlayerSitting: () => {}, toggleSpellbook: () => {} });
    party.companions.push({ id: "pet-1", name: "Zonobtik", companionType: 1, petOwnerCharacterId: 1, level: 24 });
    const result = await settle(bot.upkeep("test"));
    expect(result).toContain("gem 0 Wrath");
    expect(dismissed).toEqual([]);
  } finally {
    vi.useRealTimers();
  }
});

test("cleanup keeps the reagents of the leader's class spells", async () => {
  const { iq, bot, me } = await install();
  const chips = (slot: number) => ({ bag: 23, slot, itemid: 13073, itemInstanceId: 100 + slot, quantity: 1, itemDetails: { Name: "Bone Chips", price: 15, nodrop: 1, norent: 1, itemtype: 0 } });
  Object.assign(me, { class: 11, inventory: [chips(0), chips(1)] });
  // With no table the copy beyond the first and the cheap single both count as surplus.
  expect(bot.surplus().map((s) => s.name)).toEqual(["Bone Chips", "Bone Chips"]);
  iq.classSpells = generated;
  expect(bot.surplus()).toEqual([]);
});

// Lets the bot's in-page switch job run its fake commands to the end.
const flush = async () => {
  for (let k = 0; k < 20; k++) await Promise.resolve();
};

test("when a pause ends with another character active, the bot switches back to its leader and regroups", async () => {
  vi.useFakeTimers();
  try {
    const f = await install([10, 20]);
    f.bot.config.leaderId = 1;
    // A script played Edroun under a pause and died: Edroun is active and alone.
    f.sheet.characterProfile = { ...f.me, id: 20, name: "Edroun" };
    f.party.companions = [];
    f.bot.pause(10, "hand-in");
    await f.bot.tick();
    await flush();
    expect(f.commands).toEqual([]);

    vi.advanceTimersByTime(11 * 60000);
    await f.bot.tick();
    await flush();
    expect(f.commands).toEqual(["session.camp", "session.enterWorld Me"]);
    expect(f.sheet.characterProfile.id).toBe(1);

    await f.bot.tick();
    vi.advanceTimersByTime(6000);
    expect(f.recruited).toEqual([10, 20]);
  } finally {
    vi.useRealTimers();
  }
});

test("a tab left at character select enters the world as its leader, and a fight delays a switch", async () => {
  vi.useFakeTimers();
  try {
    const atSelect = await install();
    atSelect.bot.config.leaderId = 1;
    atSelect.screen.currentScreen = "characterSelect";
    await atSelect.bot.tick();
    await flush();
    expect(atSelect.commands).toEqual(["session.enterWorld Me"]);

    const fighting = await install();
    fighting.bot.config.leaderId = 10;
    fighting.skills.inCombat = true;
    await fighting.bot.tick();
    await flush();
    expect(fighting.commands).toEqual([]);
    fighting.skills.inCombat = false;
    await fighting.bot.tick();
    await flush();
    expect(fighting.commands).toEqual(["session.camp", "session.enterWorld Tagujazolu"]);
  } finally {
    vi.useRealTimers();
  }
});

test("failed switches back off and the third in a row wakes a script", async () => {
  vi.useFakeTimers();
  try {
    const f = await install();
    f.bot.config.leaderId = 10;
    f.screen.currentScreen = "characterSelect";
    f.commandReply.enterWorld = { ok: false, message: "Character equipment is still loading." };
    const attempt = async (waitMs: number) => {
      vi.advanceTimersByTime(waitMs);
      await f.bot.tick();
      await flush();
    };
    await attempt(0);
    await attempt(5000); // inside the 30 s back-off
    expect(f.commands.length).toBe(1);
    await attempt(30000);
    await attempt(60000);
    expect(f.commands.length).toBe(3);
    const woken = f.bot.state.alerts.filter((a) => a.kind === "switch" && a.wake);
    expect(woken.length).toBe(1);
    expect(woken[0].text).toContain("still loading");
  } finally {
    vi.useRealTimers();
  }
});

// Bags per character for the hand-in tests, and fake bridge actions that use them the way the
// game does: a pull adds one item to the active character, a hand-in takes what is due.
function handInPage(f: Awaited<ReturnType<typeof install>>, held: Record<string, Record<string, number>>, pull: { ok: boolean }) {
  const given: string[] = [];
  const mine = () => (held[f.sheet.characterProfile.name] ??= {});
  Object.assign(f.iq, {
    carried: (item: string) => mine()[item] ?? 0,
    pullItem: async (item: string) => {
      if (!pull.ok) return { got: false, from: "Tagujazolu", reply: "Transfer failed." };
      mine()[item] = (mine()[item] ?? 0) + 1;
      return { got: true, from: "Tagujazolu", reply: "Transferred." };
    },
    handInEach: async (_npc: string, counts: Record<string, number>) => {
      let items = 0;
      for (const [k, n] of Object.entries(counts)) {
        const g = Math.min(n, mine()[k] ?? 0);
        mine()[k] = (mine()[k] ?? 0) - g;
        items += g;
      }
      given.push(`${f.sheet.characterProfile.name} ${items}`);
      return { trades: items, items, xp: items * 274400 };
    },
  });
  return given;
}
const runToEnd = async (f: Awaited<ReturnType<typeof install>>) => {
  for (let k = 0; k < 400 && f.bot.state.task?.status === "running"; k++) {
    vi.advanceTimersByTime(500);
    await flush();
  }
  // The task's end hands the tab to the bot, which switches back to its leader.
  vi.advanceTimersByTime(1000);
  await flush();
  await f.bot.tick();
  await flush();
};

test("a hand-in task serves each member in turn and then gives the tab back to the leader", async () => {
  vi.useFakeTimers();
  try {
    const f = await install([10, 20]);
    f.bot.config.leaderId = 1;
    const given = handInPage(f, { Tagujazolu: { "Greater Lightstone": 1 } }, { ok: true });
    f.bot.handIn({ members: [{ name: "Tagujazolu", counts: { "Greater Lightstone": 1 } }, { name: "Edroun", counts: { "Greater Lightstone": 2 } }] });
    await runToEnd(f);
    expect(f.bot.state.task?.status).toBe("done");
    expect(given).toEqual(["Tagujazolu 1", "Edroun 2"]);
    expect(f.moves).toEqual(["sro", "sro"]);
    expect(f.commands).toEqual(["session.camp", "session.enterWorld Tagujazolu", "session.camp", "session.enterWorld Edroun", "session.camp", "session.enterWorld Me"]);
  } finally {
    vi.useRealTimers();
  }
});

test("a hand-in step that fails twice ends the task, wakes a script and gives the tab back", async () => {
  vi.useFakeTimers();
  try {
    const f = await install([10, 20]);
    f.bot.config.leaderId = 1;
    const given = handInPage(f, {}, { ok: false });
    f.bot.handIn({ members: [{ name: "Edroun", counts: { "Greater Lightstone": 1 } }] });
    await runToEnd(f);
    expect(f.bot.state.task?.status).toBe("failed");
    expect(given).toEqual([]);
    const woken = f.bot.state.alerts.filter((a) => a.kind === "task" && a.wake);
    expect(woken.length).toBe(1);
    expect(woken[0].text).toContain("Transfer failed.");
    expect(f.sheet.characterProfile.name).toBe("Me");
  } finally {
    vi.useRealTimers();
  }
});

test("a hunt task fights gray enemies through Enemy Targets with the leader, until the item drops", async () => {
  vi.useFakeTimers();
  try {
    const f = await install([10, 20]);
    f.bot.config.leaderId = 1;
    const selected: number[][] = [];
    const onArrival: boolean[] = [];
    Object.assign(f.combat, { enemyTargetAttackOnArrival: false, setEnemyTargetAttackOnArrival: (v: boolean) => onArrival.push(v) });
    f.targets.push({ spawnInstanceId: 4, npcId: 59144, name: "a_gypsy_dancer", level: 24 } as { spawnInstanceId: number; name: string });
    Object.assign(f.runtime, {
      selectEnemyTarget: (ids: number[]) => {
        selected.push(ids);
        setTimeout(() => {
          f.say("You have defeated a gypsy dancer, but gain no experience.");
          f.bag.push({ name: "Power of Wind" });
          f.targets.splice(0);
        }, 4000);
      },
    });
    f.bot.hunt({ zone: "mistmoore", keep: "gypsy dancer", item: "Power of Wind", waitMin: 1 });
    await runToEnd(f);
    expect(f.bot.state.task).toMatchObject({ status: "done", kills: 1, result: "got Power of Wind" });
    expect(selected).toEqual([[59144]]);
    expect(f.moves).toEqual(["mistmoore"]);
    expect(f.commands).toEqual([]); // no character switch
    expect(onArrival.at(-1)).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

test("a hunt over several zones moves on when none of the enemies is up and ends after a round finds none", async () => {
  vi.useFakeTimers();
  try {
    const f = await install([10, 20]);
    f.bot.config.leaderId = 1;
    const guard = { spawnInstanceId: 9, npcId: 57053, name: "a_faerie_guard", level: 17 };
    Object.assign(f.combat, { enemyTargetAttackOnArrival: true, setEnemyTargetAttackOnArrival: () => {} });
    f.runtime.combatScene.getAliveCombatTargetList = () => (f.moves.at(-1) === "gfaydark" && !f.events.some((e: { text: string }) => /defeated a faerie guard/.test(e.text)) ? [guard] : []);
    Object.assign(f.runtime, { selectEnemyTarget: () => setTimeout(() => f.say("You have defeated a faerie guard, but gain no experience."), 3000) });
    f.bot.hunt({ zone: ["lfaydark", "gfaydark"], keep: "faerie guard", item: "Power of Earth", waitMin: 0 });
    await runToEnd(f);
    expect(f.bot.state.task).toMatchObject({ status: "done", kills: 1, result: "none of faerie guard up" });
    expect(f.moves).toEqual(["lfaydark", "gfaydark", "lfaydark"]);
  } finally {
    vi.useRealTimers();
  }
});

// The raid adapter the bridge offers (`window.iq.raid`), with a fight that lasts `fightMs`
// and ends in a kill or a wipe.
function fakeRaid(f: Awaited<ReturnType<typeof install>>, { timeLeft = false, pricePp = 2000, outcome = "killed", fightMs = 10000 } = {}) {
  const calls: string[] = [];
  const r = { active: false, combat: false, leaderDead: false, roster: [] as { name: string; damage: number; alive: boolean }[] };
  (f.iq as unknown as { raid: object }).raid = {
    time: async () => (calls.push("time"), { active: timeLeft, pricePp }),
    buyHour: async (maxPp: number) => {
      calls.push(`buy ${maxPp}`);
      if (pricePp > maxPp) throw new Error("too dear");
      timeLeft = true;
      return { pricePp };
    },
    open: async () => (calls.push("open"), (r.active = true)),
    recruit: async (ids: number[]) => {
      calls.push(`recruit ${ids.join(",")}`);
      r.roster = [{ name: "Tagujazolu", damage: 0, alive: true }, { name: "Edroun", damage: 0, alive: true }];
      return ids;
    },
    attack: () => {
      calls.push(`attack ${f.combat.targetNPC?.name}`);
      r.combat = true;
      setTimeout(() => {
        r.combat = false;
        r.roster = r.roster.map((m) => ({ ...m, damage: 500, alive: outcome === "killed" }));
        if (outcome === "killed") f.targets.splice(0);
        else r.leaderDead = true;
      }, fightMs);
    },
    state: () => ({ combat: r.combat, leaderDead: r.leaderDead, roster: r.roster, log: [] }),
    end: async () => (calls.push("end"), (r.active = false)),
  };
  f.targets.push({ spawnInstanceId: 7, npcId: 1032, name: "Lord_Nagafen", level: 55 } as { spawnInstanceId: number; name: string });
  Object.assign(f.runtime, { selectEnemyTarget: () => (f.combat.targetNPC = { spawnInstanceId: 7, name: "Lord_Nagafen" }) });
  return calls;
}

test("a raid task buys time when none is left, recruits, kills its target and ends the raid", async () => {
  vi.useFakeTimers();
  try {
    const f = await install([10, 20]);
    const calls = fakeRaid(f);
    f.bot.raid({ members: ["Tagujazolu", "Edroun"], target: "Nagafen", maxPp: 2500 });
    await runToEnd(f);
    expect(calls).toEqual(["time", "buy 2500", "open", "recruit 10,20", "attack Lord_Nagafen", "end"]);
    expect(f.bot.state.task).toMatchObject({ status: "done", fight: { outcome: "killed", alive: 2 } });
    expect(f.bot.state.alerts.filter((a) => a.kind === "raid" && a.wake)).toHaveLength(1);
  } finally {
    vi.useRealTimers();
  }
});

test("a raid task records a wipe, and without raid time it stops before releasing the party", async () => {
  vi.useFakeTimers();
  try {
    const f = await install([10, 20]);
    const calls = fakeRaid(f, { timeLeft: true, outcome: "wiped" });
    f.bot.raid({ members: ["Tagujazolu"], target: "Nagafen" });
    await runToEnd(f);
    expect(calls).toEqual(["time", "open", "recruit 10", "attack Lord_Nagafen", "end"]);
    expect(f.bot.state.task).toMatchObject({ status: "done", fight: { outcome: "wiped", alive: 0 } });

    const g = await install([10, 20]);
    const none = fakeRaid(g, { pricePp: 3000 });
    g.bot.raid({ members: ["Tagujazolu"], target: "Nagafen", maxPp: 2500 });
    await runToEnd(g);
    expect(g.bot.state.task.status).toBe("failed");
    expect(none).not.toContain("open");
  } finally {
    vi.useRealTimers();
  }
});

test("a quest runs its steps in order for each member and stops at a step whose reward did not come", async () => {
  vi.useFakeTimers();
  try {
    const f = await install([10, 20]);
    f.bot.config.leaderId = 1;
    handInPage(f, {}, { ok: true });
    const held = (f.iq as unknown as { carried: (i: string) => number }).carried;
    const bags: Record<string, Record<string, number>> = {};
    const mine = () => (bags[f.sheet.characterProfile.name] ??= {});
    const talks: string[] = [];
    // Kargek gives the note for the keywords, Oknoggin the lute for the note, unless he is gone.
    let oknoggin = true;
    Object.assign(f.iq, {
      carried: (item: string) => (mine()[item] ?? 0) + held(item),
      talkToNpc: async (npc: string, say: string[]) => {
        talks.push(`${f.sheet.characterProfile.name} ${npc} ${say.join(",")}`);
        if (npc === "Kargek Redblade" && say.includes("favor")) mine()["Wax Sealed Note"] = 1;
      },
      giveToNpc: async (items: string[]) => {
        // An NPC that is not there to take the trade leaves the items with the character.
        if (!oknoggin) return;
        for (const x of items) mine()[x] = (mine()[x] ?? 0) - 1;
        mine()["Tiny Lute"] = 1;
      },
    });
    const steps = [
      { zone: "freporte", npc: "Kargek Redblade", say: ["scabbard", "favor"], expect: "Wax Sealed Note" },
      { zone: "feerrott", npc: "Oknoggin Stonesmacker", give: ["Wax Sealed Note"], expect: "Tiny Lute" },
    ];
    f.bot.quest({ members: ["Tagujazolu"], steps });
    await runToEnd(f);
    expect(f.bot.state.task).toMatchObject({ status: "done", members: [{ name: "Tagujazolu", done: true, at: 2 }] });
    expect(talks).toEqual(["Tagujazolu Kargek Redblade scabbard,favor", "Tagujazolu Oknoggin Stonesmacker "]);
    expect(f.moves).toEqual(["freporte", "feerrott"]);

    oknoggin = false;
    f.bot.quest({ members: ["Edroun"], steps });
    await runToEnd(f);
    expect(f.bot.state.task).toMatchObject({ status: "failed", members: [{ name: "Edroun", done: false, at: 1 }] });
    expect(f.bot.state.task.error).toContain("did not get Tiny Lute");

    // A later quest for Edroun, who still carries the note, starts at the step that takes it.
    oknoggin = true;
    talks.length = 0;
    f.bot.quest({ members: ["Edroun"], steps });
    await runToEnd(f);
    expect(f.bot.state.task).toMatchObject({ status: "done" });
    expect(talks).toEqual(["Edroun Oknoggin Stonesmacker "]);
  } finally {
    vi.useRealTimers();
  }
});

test("an NPC wait ends at once while another NPC holds the spawn point, and waits while the point is empty", async () => {
  vi.useFakeTimers();
  try {
    const f = await install([10, 20]);
    f.bot.config.leaderId = 1;
    handInPage(f, {}, { ok: true });
    let note = 0;
    const zone = { spawns: [{ name: "Lozani", spawn2Id: 3075, currentHp: 1200 }] as { name: string; spawn2Id: number; currentHp: number }[] };
    Object.assign(f.iq, {
      // The champagne is carried, the cell number comes from the hand-in.
      carried: (item: string) => (item === "Bunker Cell #1" ? note : 1),
      refreshSpawns: async () => zone.spawns.length,
      zoneSpawns: zone,
      talkToNpc: async () => {},
      giveToNpc: async () => {
        note = 1;
      },
    });
    const steps = [{ zone: "freporte", npc: "Tykar Renlin", waitMin: 45, points: [3075], give: ["Drom's Champagne"], expect: "Bunker Cell #1" }];
    f.bot.quest({ members: ["Tagujazolu"], steps });
    await runToEnd(f);
    expect(f.bot.state.task).toMatchObject({ status: "failed" });
    expect(f.bot.state.task.error).toContain("Tykar Renlin cannot spawn while Lozani holds its spawn point");

    // An empty point respawns, so the wait goes on until the NPC stands there.
    zone.spawns = [];
    f.bot.quest({ members: ["Edroun"], steps });
    await runToEnd(f);
    expect(f.bot.state.task).toMatchObject({ status: "running", step: "wait for Tykar Renlin" });
    zone.spawns = [{ name: "Tykar_Renlin", spawn2Id: 3075, currentHp: 651 }];
    await runToEnd(f);
    expect(f.bot.state.task).toMatchObject({ status: "done" });
  } finally {
    vi.useRealTimers();
  }
});

test("a quest running when the bot is reinstalled goes on under the new install", async () => {
  vi.useFakeTimers();
  try {
    const f = await install([10, 20]);
    f.bot.config.leaderId = 1;
    handInPage(f, {}, { ok: true });
    let note = 0;
    let answering = false; // the old install's walk never arrives
    Object.assign(f.iq, {
      carried: (item: string) => (item === "Wax Sealed Note" ? note : 0),
      talkToNpc: () => (answering ? Promise.resolve((note = 1)) : new Promise(() => {})),
      giveToNpc: async () => {},
    });
    f.bot.quest({ members: ["Tagujazolu"], steps: [{ zone: "freporte", npc: "Kargek Redblade", say: ["favor"], expect: "Wax Sealed Note" }] });
    for (let k = 0; k < 20; k++) {
      vi.advanceTimersByTime(500);
      await flush();
    }
    expect(f.bot.state.task.step).toBe("talk to Kargek Redblade");
    answering = true;
    const g = globalThis as unknown as FakeGlobals;
    eval(await Bun.file(new URL("../src/bot.js", import.meta.url)).text());
    const bot = g.iqBot!;
    clearInterval(bot.timerId);
    clearInterval(bot.fastTimerId);
    await runToEnd({ ...f, bot });
    expect(bot.state.task).toMatchObject({ status: "done", members: [{ done: true }] });
    expect(bot.state.actions.map((a) => a.text)).toContainEqual(expect.stringContaining("resumed after a reinstall"));
  } finally {
    vi.useRealTimers();
  }
});

test("client options are kept at the bot's values with their toggles, and set ones are left alone", async () => {
  const f = await install();
  const flips: string[] = [];
  Object.assign(f.combat, {
    autoUpgradeEnabled: true,
    autoUpgradeCompanionsEnabled: false,
    toggleAutoUpgrade: () => (flips.push("self"), (f.combat as { autoUpgradeEnabled: boolean }).autoUpgradeEnabled = false),
    toggleAutoUpgradeCompanions: () => flips.push("companions"),
  });
  await f.bot.tick();
  await f.bot.tick();
  expect(flips).toEqual(["self"]);
  expect((f.combat as { autoUpgradeEnabled: boolean }).autoUpgradeEnabled).toBe(false);
});

test("a gear move with a merchant travels there, buys the item and gives it, and a held item is pulled", async () => {
  vi.useFakeTimers();
  try {
    const f = await install();
    const bag: Record<string, number> = {};
    const log: string[] = [];
    Object.assign(f.iq, {
      carried: (item: string) => bag[item] ?? 0,
      buyItem: async (item: string, merchant: string) => {
        log.push(`buy ${item} from ${merchant}`);
        bag[item] = (bag[item] ?? 0) + 1;
        return { bought: 1, platinum: 10 };
      },
      pullItem: async (item: string, { from }: { from: string }) => {
        log.push(`pull ${item} from ${from}`);
        bag[item] = (bag[item] ?? 0) + 1;
        return { got: true, from, reply: "Transferred." };
      },
      giveItem: async (item: string, id: number) => {
        log.push(`give ${item} to ${id}`);
        bag[item] -= 1;
        return { ok: true, lines: [] };
      },
    });
    f.bot.gear({ moves: [
      { item: "Hand Drum", from: null, to: "Edroun", slot: "secondary", buy: { merchant: "Fania Esruc", zone: "permafrost", price: 0.1 } },
      { item: "Fine Cloak", from: "Tagujazolu", to: "Edroun", slot: "back" },
    ] });
    await runToEnd(f);
    expect(f.moves[0]).toBe("permafrost");
    expect(log).toEqual(["buy Hand Drum from Fania Esruc", "give Hand Drum to 20", "pull Fine Cloak from Tagujazolu", "give Fine Cloak to 20"]);
    expect(f.bot.state.task.result).toBe("2 of 2 moves");
  } finally {
    vi.useRealTimers();
  }
});

test("a companion without the kept tactics gets them", async () => {
  const f = await install();
  delete (f.iq.stores.partySpells.getState() as { overridesByCompanion: Record<string, unknown> }).overridesByCompanion["character:10"];
  await f.bot.tick();
  await f.bot.tick();
  // Tagujazolu has no overrides and so would cure with the client's defaults. Edroun's cure is off.
  expect(f.tactics).toEqual([["Tagujazolu", "cure", false]]);
});
