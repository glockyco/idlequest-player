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
  waker: { timer: Timer | null };
  config: { enabled: boolean; upkeep: boolean; partyIds: number[]; leaderId: number | null; routeStuckSec: number; readyStuckSec: number; rotation: string[] };
  state: { alerts: Alert[]; switching: { name: string; done: boolean; ok: boolean | null } | null; heldAt: number; idleCases: Record<string, { rung: number; at: number; began: number; errand: boolean; alerted?: boolean }> };
  pause(minutes: number, reason?: string): string;
  resume(): boolean;
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
  // The failed zone load the client shows as Loading Failed, and the presses of its TRY AGAIN.
  const loadFailure = { message: null as string | null, retries: 0, retry: () => void loadFailure.retries++ };
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
    minNpcLevel: 0,
    setMinNpcLevel: (v: number) => { combat.minNpcLevel = v; },
    // AutoLevel runs once started, and the page then labels a running state.
    setIsRunning: (on: boolean) => {
      combat.isRunning = on;
      if (!on) autoLevel.stops++;
    },
    startAutoLevel: () => {
      autoLevel.starts++;
      combat.isRunning = true;
      Object.assign(activity, { act: "approach", why: null, since: Date.now() });
    },
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
  // Seconds per activity label over the last minutes, as the bridge counts them from its samples. The
  // fake played the whole window unless a test changes it.
  const played: Record<string, number> = { fight: 600 };
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
  // A bot of an earlier test must not tick into this one's page.
  if (g.iqBot) {
    g.iqBot.config.enabled = false;
    clearTimeout(g.iqBot.waker?.timer ?? undefined);
  }
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
    activitySeconds: () => ({ ...played }),
    // Zone changes the bot asked for, by short name; the fake moves the party at once.
    changeZone: async (shortName: string) => {
      moves.push(shortName);
      combat.currentZone = zones.find((z) => z.shortName === shortName)?.zoneidnumber ?? combat.currentZone;
      return shortName;
    },
    mods: {
      game: { G: { getInstance: () => runtime } },
    },
    // Like the bridge, the roots on the party from the client's effects registry.
    roots: () => [...effects].flatMap(([id, list]) => list.filter((e) => e.root).map((e) => ({ id, app: `${id}|${e.effectId}`, spellId: e.spellId, casterLevel: e.casterLevel, endsAt: Date.now() + e.remainingTicks * 6000 }))),
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
    // The bridge's activity label, which tests set to the situation they need. Like the bridge's, each
    // read is a snapshot that later changes leave alone.
    activity: () => ({ ...activity }),
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
      loadFailure: store(loadFailure),
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
  return { iq, bot, events, say, recruited, autoLevel, me, tank, combat, guard, kills, played, moves, runtime, targets, bag, effects, skills, tactics, book, party, dismissed, raid, loadFailure, sheet, screen, roster, commands, commandReply, activity };
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
    p.bot.config.limits = { minCon: 10, maxCon: 13, maxLevelDiff: 5 };
    p.combat.minCon = 10;
    await p.bot.tick();
    Object.assign(p.activity, { act: "idle", why: "crowded", since: Date.now() });
    vi.advanceTimersByTime(30000);
    await p.bot.tick();
    expect([p.combat.minCon, p.moves]).toEqual([10, []]);
    // A crowded minute marks the zone for the coordinator, which sends no errand there for a while.
    expect(Object.keys(p.bot.state.crowdedAt ?? {})).toEqual([]);
    vi.advanceTimersByTime(31000);
    await p.bot.tick();
    expect([p.combat.minCon, p.moves]).toEqual([4, []]);
    expect(Object.keys(p.bot.state.crowdedAt)).toEqual(["guktop"]);
    vi.advanceTimersByTime(61000);
    await p.bot.tick();
    expect(p.moves).toEqual(["permafrost"]);

    const alone = await install();
    alone.combat.minCon = 4;
    Object.assign(alone.activity, { act: "idle", why: "crowded", since: Date.now() - 61000 });
    await alone.bot.tick();
    await alone.bot.tick();
    expect(alone.bot.state.alerts.filter((a) => a.kind === "idle").map((a) => a.wake)).toEqual([true]);
    // A used-up ladder starts over ten minutes after its last remedy.
    vi.advanceTimersByTime(601000);
    alone.combat.minCon = 4;
    await alone.bot.tick();
    expect(alone.bot.state.idleCases.crowded.rung).toBeGreaterThan(0);
    expect(alone.bot.state.idleCases.crowded.at).toBeGreaterThan(Date.now() - 1000);
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
    p.bot.state.idleCases = { crowded: { rung: 1, at: Date.now() - 61000, began: Date.now() - 61000, errand: false } };
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

test("a hang restarts AutoLevel, the same hang before the next kill widens the limits, and the client's pause after a kill is left alone", async () => {
  vi.useFakeTimers();
  try {
    const hung = await install();
    hung.bot.config.limits = { minCon: 10, maxCon: 13, maxLevelDiff: 5 };
    hung.combat.minCon = 10;
    Object.assign(hung.activity, { act: "idle", why: "noTarget", since: Date.now() - 21000 });
    await hung.bot.tick();
    expect(hung.autoLevel).toEqual({ stops: 1, starts: 0 });
    // The restart's stop is the bot's own hold, which the page labels "held", and the start follows at once.
    Object.assign(hung.activity, { act: "idle", why: "held", since: Date.now() });
    await hung.bot.tick();
    expect(hung.autoLevel).toEqual({ stops: 1, starts: 1 });
    // The hang is back with no kill since, so the ladder goes on to the wider limits.
    Object.assign(hung.activity, { act: "idle", why: "noTarget", since: Date.now() });
    vi.advanceTimersByTime(21000);
    await hung.bot.tick();
    expect([hung.combat.minCon, hung.autoLevel.stops]).toEqual([4, 2]);
    // A kill ends the case, so the next hang starts over with a restart.
    hung.kills.push({ t: Date.now(), xp: 1000, enemy: "a rat" });
    Object.assign(hung.activity, { act: "idle", why: "noTarget", since: Date.now() });
    vi.advanceTimersByTime(21000);
    await hung.bot.tick();
    expect(hung.autoLevel.stops).toBe(3);
    expect(hung.bot.state.alerts.filter((a) => a.kind === "idle")).toEqual([]);

    const ready = await install();
    Object.assign(ready.activity, { act: "idle", why: "readyWait", since: Date.now() - 31000 });
    await ready.bot.tick();
    Object.assign(ready.activity, { act: "idle", why: "held", since: Date.now() });
    await ready.bot.tick();
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

test("a level floor follows the leader's level, and an empty zone lifts it before it lowers the con", async () => {
  vi.useFakeTimers();
  try {
    const f = await install();
    f.bot.config.limits = { minCon: 4, maxCon: 13, maxLevelDiff: 5, levelsBelow: 4 };
    Object.assign(f.me, { level: 28 });
    await f.bot.tick();
    expect(f.combat.minNpcLevel).toBe(24);
    Object.assign(f.me, { level: 29 });
    await f.bot.tick();
    expect(f.combat.minNpcLevel).toBe(25);
    Object.assign(f.activity, { act: "idle", why: "noEnemies", since: Date.now() });
    await f.bot.tick();
    expect([f.combat.minNpcLevel, f.combat.minCon]).toEqual([0, 4]);
    // The floor returns once the widening is `widenMin` old.
    Object.assign(f.activity, { act: "fight", why: null, since: Date.now() });
    vi.advanceTimersByTime(21 * 60000);
    await f.bot.tick();
    expect(f.combat.minNpcLevel).toBe(25);
  } finally {
    vi.useRealTimers();
  }
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

test("a party signed out or held through the last ten minutes keeps its zone, because the rate counts play only", async () => {
  vi.useFakeTimers();
  try {
    const { bot, combat, kills, played, moves } = await install();
    bot.config.rotation = ["guktop", "permafrost"];
    combat.currentZone = 65;
    await bot.tick(); // arrival
    for (let m = 0; m < 10; m++) {
      vi.advanceTimersByTime(60000);
      kills.push({ t: Date.now(), xp: 10000, enemy: "a froglok" });
    }
    await bot.tick(); // this visit's best ten minutes
    vi.advanceTimersByTime(11 * 60000); // nothing killed since
    // A signed-out page records no seconds, and a hold records its own.
    for (const window of [{}, { "idle/held": 400, fight: 200 }]) {
      for (const k of Object.keys(played)) delete played[k];
      Object.assign(played, window);
      await bot.tick();
    }
    expect(moves).toEqual([]);
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

    // An errand without its item only notes, because the coordinator retries it, and a party outside
    // its rotation moves back into it.
    const late = await install();
    late.bot.config.rotation = ["guktop"];
    late.combat.currentZone = 65;
    await late.bot.errand({ zone: "permafrost", keep: "famished", item: "Power of Water", minutes: 30 });
    vi.advanceTimersByTime(31 * 60000);
    await late.bot.tick();
    expect(late.bot.state.alerts.find((a) => a.kind === "errand")?.wake).toBe(false);
    expect(late.moves).toEqual(["permafrost"]);
    vi.advanceTimersByTime(61000);
    await late.bot.tick();
    expect(late.moves).toEqual(["permafrost", "guktop"]);

    // A crowded errand zone, whose enemies other players take, ends the errand before its minutes,
    // also when the crowding began before the errand and used up the hunting ladder.
    const crowded = await install();
    crowded.bot.config.rotation = ["guktop"];
    crowded.combat.currentZone = 65;
    crowded.bot.state.idleCases = { crowded: { rung: 2, at: Date.now() - 900000, began: Date.now() - 900000, errand: false, alerted: true } };
    await crowded.bot.errand({ zone: "permafrost", keep: "famished", item: "Power of Water", minutes: 60 });
    Object.assign(crowded.activity, { act: "idle", why: "crowded", since: Date.now() - 61000 });
    await crowded.bot.tick();
    expect(crowded.bot.state.errand).toBeNull();
    expect(crowded.bot.state.alerts.find((a) => a.kind === "errand")?.wake).toBe(true);
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
    f.bot.config.limits = { minCon: 10, maxCon: 10, maxLevelDiff: 1 };
    Object.assign(f.me, { level: 7 });
    Object.assign(f.runtime, { getAutoCombatLevelBounds: () => ({ minLevel: f.combat.minCon <= 2 ? 3 : f.combat.minCon <= 4 ? 5 : 7, maxLevel: 7 + f.combat.maxLevelDiff }) });
    // A level 15 wisp lies 8 levels up, and up to level 8 the guard leaves a fight with an enemy 6 levels up, so the range stops at 11.
    Object.assign(f.iq, { zoneSpawns: { spawns: [{ name: "a_willowisp", level: 9 }, { name: "a_greater_wisp", level: 11 }, { name: "an_elder_wisp", level: 15 }, { name: "a_skeleton", level: 8 }] } });
    Object.assign(f.guard, { config: { enabled: true, lowLevelMax: 8, levelGapLow: 6 } });
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

test("AutoLevel skips the spawn points inside the aggro radius of a live enemy the client keeps out of it", async () => {
  // Kedge Keep on 2026-11-12: Phinigel Autropos, a raid target of level 53 with an aggro radius of
  // 200, and the swirlspine seahorses that spawn 111 to 163 units from him.
  const f = await install();
  Object.assign(f.me, { level: 51 });
  const spawn = (spawnInstanceId: number, name: string, x: number, extra = {}) => ({ spawnInstanceId, name, level: 50, x, y: 0, z: 0, state: "alive", aggroRadius: 60, ...extra });
  const phinigel = spawn(1, "Phinigel_Autropos", 0, { level: 53, aggroRadius: 200, autoLevelExcluded: true });
  // A quest NPC far below the party is excluded too and guards nothing.
  const slave = spawn(2, "an_escaped_slave", 1000, { level: 8, autoLevelExcluded: true });
  const spawns = [phinigel, slave, spawn(3, "a_swirlspine_seahorse", 111), spawn(4, "a_swirlspine_seahorse", 163), spawn(5, "a_cobalt_sailfin", 217), spawn(6, "a_piranha", 1010)];
  Object.assign(f.iq, { zoneSpawns: { t: 1, spawns } });
  f.targets.push(...(spawns.slice(2) as never[]));
  const skipped = () => [...new Set(f.runtime.deferred)].sort();
  f.bot.fastTick();
  expect(skipped()).toEqual([3, 4]);
  // Once the zone's list shows him dead, his guards are ordinary enemies again.
  f.runtime.deferred.length = 0;
  Object.assign(f.iq, { zoneSpawns: { t: 2, spawns: spawns.map((s) => (s === phinigel ? { ...s, state: "respawning" } : s)) } });
  f.bot.fastTick();
  expect(skipped()).toEqual([]);
});

test("an enemy that joins fights the guard has to leave is skipped with the camp it joins, and a common one is not", async () => {
  // Phinigel Autropos in Kedge Keep, 2026-11-12: he joined the fights with the seahorses around
  // him, 40 escapes in eight hours and no kill.
  const f = await install();
  const mob = (id: number, name: string) => ({ id, name });
  const escape = async (engaged: string, rule: string, mobs: { id: number; name: string }[]) => {
    f.say(`You engage ${engaged} in combat!`);
    f.say(`[guard] leaving: ${rule}: the fight is lost`, "guard");
    Object.assign(f.events.at(-1)!, { escape: rule, mobs });
    await f.bot.tick();
  };
  const kill = async (name: string) => {
    f.say(`You engage ${name} in combat!`);
    f.say(`You have defeated ${name} and gained 1000 experience!`);
    await f.bot.tick();
  };
  const target = (spawnInstanceId: number, name: string, level = 50) => ({ spawnInstanceId, name, level }) as never;
  f.targets.push(target(5, "Phinigel_Autropos", 53), target(6, "a_seahorse"), target(7, "a_seahorse"), target(8, "a_seahorse"), target(9, "a_piranha"));
  // The tick and the fast tick both renew the skip list, so the list is read as a set.
  const skipped = () => [...new Set(f.runtime.deferred)].sort();
  for (let k = 0; k < 30; k++) await kill("a seahorse");
  await escape("a seahorse", "healer", [mob(6, "a_seahorse"), mob(5, "Phinigel_Autropos")]);
  f.bot.fastTick();
  expect(skipped()).toEqual([]);
  // The second fight he joins: he is skipped, and so are the spawn points of that fight.
  await escape("a seahorse", "down", [mob(7, "a_seahorse"), mob(5, "Phinigel_Autropos")]);
  f.bot.fastTick();
  expect(skipped()).toEqual([5, 7]);
  expect(f.bot.state.alerts.at(-1)).toMatchObject({ kind: "lostFight" });
  // A fight without him that had to be left costs the seahorses nothing: 30 kills, three escapes.
  // A refused fight is no lost one.
  f.runtime.deferred.length = 0;
  await escape("a seahorse", "dying", [mob(8, "a_seahorse")]);
  await escape("a piranha", "level", [mob(9, "a_piranha")]);
  await escape("a piranha", "level", [mob(9, "a_piranha")]);
  f.bot.fastTick();
  expect(skipped()).toEqual([5, 7]);
  // Two levels later the party tries him and his camp again.
  f.runtime.deferred.length = 0;
  Object.assign(f.me, { level: f.me.level + 2 });
  f.bot.fastTick();
  expect(skipped()).toEqual([]);
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

test("in raid mode the bot leaves AutoLevel off, and starts it at once after the raid", async () => {
  vi.useFakeTimers();
  try {
    const { bot, combat, raid, autoLevel, activity } = await install();
    raid.raidModeActive = true;
    combat.isRunning = false;
    Object.assign(activity, { act: "idle", why: "off", since: Date.now() });
    await bot.tick();
    vi.advanceTimersByTime(120000);
    await bot.tick();
    expect(autoLevel.starts).toBe(0);
    // The raid is a hold, so the page labels AutoLevel off after it "held".
    expect(bot.state.heldAt).toBe(Date.now());
    raid.raidModeActive = false;
    Object.assign(activity, { act: "idle", why: "held", since: Date.now() });
    await bot.tick();
    expect(autoLevel.starts).toBe(1);
  } finally {
    vi.useRealTimers();
  }
});

test("AutoLevel starts at once after a hold or a contested target, 5 s after the client's pause, and a minute after a stop nothing explains", async () => {
  vi.useFakeTimers();
  try {
    const f = await install();
    const off = (why: string) => {
      f.combat.isRunning = false;
      Object.assign(f.activity, { act: "idle", why, since: Date.now() });
    };
    off("contested");
    await f.bot.tick();
    expect(f.autoLevel.starts).toBe(1);
    off("clientPause");
    await f.bot.tick();
    expect(f.autoLevel.starts).toBe(1);
    vi.advanceTimersByTime(5000);
    await f.bot.tick();
    expect(f.autoLevel.starts).toBe(2);
    off("off");
    vi.advanceTimersByTime(59000);
    await f.bot.tick();
    expect(f.autoLevel.starts).toBe(2);
    vi.advanceTimersByTime(1000);
    await f.bot.tick();
    expect(f.autoLevel.starts).toBe(3);
    expect(f.bot.state.alerts.filter((a) => a.kind === "autoLevelRestarted").length).toBe(1);
    // A pause holds AutoLevel off, and its end is a hold the page labels "held".
    f.bot.pause(5, "a script");
    off("off");
    vi.advanceTimersByTime(120000);
    await f.bot.tick();
    expect(f.autoLevel.starts).toBe(3);
    f.bot.resume();
    expect(f.bot.state.heldAt).toBe(Date.now());
    off("held");
    await f.bot.tick();
    expect(f.autoLevel.starts).toBe(4);
  } finally {
    vi.useRealTimers();
  }
});

test("a failed zone load gets Try Again also under a pause, and every new failure gets its own", async () => {
  vi.useFakeTimers();
  try {
    const f = await install();
    f.bot.pause(5, "a task");
    Object.assign(f.activity, { act: "idle", why: "loadFailed", since: Date.now() });
    await f.bot.tick();
    expect(f.loadFailure.retries).toBe(1);
    // Still open with no zone load since: the ladder is used up and wakes a script.
    await f.bot.tick();
    expect([f.loadFailure.retries, f.bot.state.alerts.filter((a) => a.kind === "idle").map((a) => a.wake)]).toEqual([1, [true]]);
    // The retried load failed again between two ticks, which saw the window open both times.
    vi.advanceTimersByTime(30000);
    Object.assign(f.activity, { act: "idle", why: "loadFailed", since: Date.now() });
    await f.bot.tick();
    expect(f.loadFailure.retries).toBe(2);
  } finally {
    vi.useRealTimers();
  }
});

test("a dead fight is left through the guard, also under a task's pause", async () => {
  const f = await install();
  const left: string[] = [];
  Object.assign(f.iq, { leaveFight: (why: string) => left.push(why) });
  f.bot.pause(5, "task raid: stop");
  f.skills.inCombat = true;
  Object.assign(f.activity, { act: "idle", why: "deadFight", since: Date.now() });
  await f.bot.tick();
  expect(left).toEqual(["the fight showed no combat line for 45 s"]);
  // The same dead fight is not left twice: an escape that did not end it wakes a script.
  await f.bot.tick();
  expect([left.length, f.bot.state.alerts.filter((a) => a.kind === "idle").map((a) => a.wake)]).toEqual([1, [true]]);
});

test("a task does not take a tab that a pause holds", async () => {
  const f = await install();
  f.bot.pause(5, "loot by hand");
  expect(() => f.bot.casino()).toThrow("the tab is paused for loot by hand");
  f.bot.resume();
  expect(f.bot.casino().status).toBe("running");
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

test("the reserve keeps the reagents of the leader's class spells", async () => {
  const { iq, bot, me } = await install();
  const chips = (slot: number) => ({ bag: 23, slot, itemid: 13073, itemInstanceId: 100 + slot, quantity: 1, itemDetails: { Name: "Bone Chips", price: 15, nodrop: 1, norent: 1, itemtype: 0 } });
  Object.assign(me, { class: 11, inventory: [chips(0), chips(1)] });
  // With no class table both copies are surplus.
  expect(bot.fates().sell.map((s) => s.name)).toEqual(["Bone Chips", "Bone Chips"]);
  iq.classSpells = generated;
  expect(bot.fates().sell).toEqual([]);
});

test("the reserve keeps a supply of food and of drink from the largest stacks, not a stack of every kind", async () => {
  const { bot, me } = await install();
  const meal = (slot: number, Name: string, itemtype: number, quantity: number) => ({ bag: 23, slot, itemid: 900 + slot, itemInstanceId: 200 + slot, quantity, itemDetails: { Name, price: 5, nodrop: 1, norent: 1, itemtype } });
  me.inventory = [meal(0, "Beer Braised Rat", 14, 17), meal(1, "Bread Cakes", 14, 12), meal(2, "Rat Sandwich", 14, 4), meal(3, "Malted Milk", 15, 20), meal(4, "Skin of Milk", 15, 3)];
  const f = bot.fates();
  // Food: 17 then 12 reach the 20 units, so the third stack is surplus. Drink: one full stack is enough.
  expect(f.keep.map((k) => k.name).sort()).toEqual(["Beer Braised Rat", "Bread Cakes", "Malted Milk"]);
  expect(f.sell.map((s) => s.name).sort()).toEqual(["Rat Sandwich", "Skin of Milk"]);
});

test("the reserve keeps copies up to the account's demand, counting stacks, and lets the rest go", async () => {
  const { bot, me } = await install();
  const row = (slot: number, itemid: number, Name: string, price: number, quantity = 1) => ({ bag: 23, slot, itemid, itemInstanceId: 300 + slot, quantity, itemDetails: { Name, price, nodrop: price ? 1 : 0, norent: 1, itemtype: 21 } });
  // A boss potion and an epic piece have no price and are NO DROP, like the Battle Plans nobody wants.
  me.inventory = [row(0, 990113, "Potion of Lodizal", 0), row(1, 20524, "Kedge Backbone", 0), row(2, 20524, "Kedge Backbone", 0), row(3, 3, "Battle Plans", 0), row(4, 10035, "Ruby", 50, 3), row(5, 10035, "Ruby", 50, 3)];
  bot.config.demand = { 990113: 1, 20524: 1, 10035: 2 };
  const f = bot.fates();
  // One Kedge Backbone is wanted, the first stack of rubies covers the two wanted, the second is surplus.
  expect(f.keep.map((k) => `${k.name} ${k.slot}`).sort()).toEqual(["Kedge Backbone 1", "Potion of Lodizal 0", "Ruby 4"]);
  expect(f.sell.map((s) => `${s.name} ${s.slot}`)).toEqual(["Ruby 5"]);
  expect(f.discard.map((d) => `${d.name} ${d.slot}`).sort()).toEqual(["Battle Plans 3", "Kedge Backbone 2"]);
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

test("a page that comes to the character select anew, as after a sign-in, enters the world without the back-off of earlier switches", async () => {
  vi.useFakeTimers();
  try {
    const f = await install();
    f.bot.config.leaderId = 10;
    f.screen.currentScreen = "characterSelect";
    f.commandReply.enterWorld = { ok: false, message: "Could not confirm camping. Please sign in again." };
    const attempt = async (waitMs: number) => {
      vi.advanceTimersByTime(waitMs);
      await f.bot.tick();
      await flush();
    };
    await attempt(0);
    await attempt(30000);
    await attempt(60000);
    expect(f.commands.length).toBe(3);
    // The next try would wait two minutes. The page is signed in again within one.
    f.screen.currentScreen = "login";
    await attempt(20000);
    f.screen.currentScreen = "characterSelect";
    f.commandReply.enterWorld = { ok: true };
    await attempt(20000);
    expect(f.commands.length).toBe(4);
  } finally {
    vi.useRealTimers();
  }
});

test("failed zone moves back off, and only the third in a row wakes a script", async () => {
  vi.useFakeTimers();
  try {
    const f = await install();
    f.bot.config.rotation = ["guktop"];
    f.combat.currentZone = 73; // permafrost, outside the rotation
    let refusals = 3;
    const move = f.iq.changeZone;
    f.iq.changeZone = async (shortName: string) => {
      if (refusals-- > 0) throw new Error("Request timeout for opcode 313");
      return move(shortName);
    };
    const at = async (waitMs: number) => {
      vi.advanceTimersByTime(waitMs);
      await f.bot.tick();
      await flush();
    };
    await at(0); // arrival starts the clock outside the rotation
    await at(61000);
    await at(5000); // inside the 30 s back-off
    await at(30000);
    const woken = () => f.bot.state.alerts.filter((a) => a.kind === "rotate" && a.wake).length;
    expect(woken()).toBe(0);
    await at(60000);
    expect(woken()).toBe(1);
    await at(120000);
    expect(f.moves).toEqual(["guktop"]);
    expect(f.bot.state.alerts.filter((a) => a.kind === "rotate").map((a) => a.text.slice(0, 22))).toEqual(["move to guktop failed:", "move to guktop failed:", "move to guktop failed:", "moved to guktop: perma"]);
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

test("a hunt fights its boss for minutes while the boss loses HP, and leaves one that keeps it", async () => {
  // Group 1 at 56 against Phinigel Autropos on 2026-11-12: 58% of 18,000 HP after 180 s, nobody
  // dead, and the rule for fights without headway ended it.
  vi.useFakeTimers();
  try {
    const fight = async (lossPerSec: number) => {
      const f = await install([10, 20]);
      f.bot.config.leaderId = 1;
      const left: string[] = [];
      const selected: number[][] = [];
      const boss = { name: "Phinigel_Autropos", state: "alive", hp: 18000, maxHp: 18000 };
      const over = () => {
        f.skills.inCombat = false;
        f.targets.splice(0);
        Object.assign(f.combat, { engagedMobs: {} });
      };
      Object.assign(f.iq, { leaveFight: (why: string) => (left.push(why), over()) });
      Object.assign(f.combat, { enemyTargetAttackOnArrival: true, setEnemyTargetAttackOnArrival: () => {} });
      f.targets.push({ spawnInstanceId: 4, npcId: 64001, name: "Phinigel_Autropos", level: 53 } as { spawnInstanceId: number; name: string });
      Object.assign(f.runtime, {
        selectEnemyTarget: (ids: number[]) => {
          selected.push(ids);
          f.say("You engage Phinigel Autropos in combat!");
          f.skills.inCombat = true;
          // The leader's target moves to the seahorse that joins, as it did in that fight.
          Object.assign(f.combat, { targetNPC: { name: "a_swirlspine_seahorse" }, engagedMobs: { 1: boss, 2: { name: "a_swirlspine_seahorse", state: "alive", hp: 9000, maxHp: 9777 } } });
        },
      });
      f.bot.hunt({ zone: "kedge", keep: "Phinigel Autropos", waitMin: 0, minutes: 15 });
      for (let k = 0; k < 700 && f.bot.state.task?.status === "running"; k++) {
        vi.advanceTimersByTime(1000);
        await flush();
        if (f.skills.inCombat) {
          boss.hp -= lossPerSec;
          if (boss.hp <= 0) {
            f.say("You have defeated Phinigel Autropos and gained 100 experience!");
            over();
          }
        }
        if (k % 10 === 0) await f.bot.tick();
        f.bot.fastTick();
      }
      return { left, selected, task: f.bot.state.task };
    };
    const won = await fight(42); // dead after 429 s
    expect(won.left).toEqual([]);
    expect(won.selected).toEqual([[64001]]);
    expect(won.task).toMatchObject({ status: "done", kills: 1 });
    const healed = await fight(5); // 5% in 180 s
    expect(healed.left).toHaveLength(1);
    expect(healed.left[0]).toContain("phinigel autropos kept 95% of its HP");
    expect(healed.task).toMatchObject({ status: "done", kills: 0 });
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

test("a look waits in a boss's zone for its respawn, keeps what the zone's list shows and goes home", async () => {
  // Lord Yelinak in Skyshrine, 2026-11-12: a gear visit saw him waiting for his respawn, and
  // nothing was there when he came back.
  vi.useFakeTimers();
  try {
    const look = async (respawnsInMs: number, until: number) => {
      const f = await install([10, 20]);
      f.bot.config.rotation = ["hole"];
      const t0 = Date.now();
      const dragon = { npcId: 114106, name: "Lord_Yelinak", level: 70, autoLevelExcluded: true, state: "respawning", currentHp: 0, maxHp: 500000, nextRespawnAtMs: t0 + respawnsInMs };
      const zone = { t: 0, spawns: [dragon, { npcId: 2, name: "a_wyvern", level: 55, state: "alive" }] };
      let reads = 0;
      Object.assign(f.iq, {
        zoneSpawns: zone,
        refreshSpawns: async () => {
          reads++;
          if (Date.now() >= dragon.nextRespawnAtMs) Object.assign(dragon, { state: "alive", currentHp: 500000 });
          return zone.spawns.length;
        },
      });
      f.bot.look({ zone: "skyshrine", name: "Lord Yelinak", until: until ? t0 + until : 0 });
      await runToEnd(f);
      return { task: f.bot.state.task, moves: f.moves, reads, t0 };
    };
    const came = await look(40000, 5 * 60000);
    expect(came.task).toMatchObject({ status: "done", result: "Lord Yelinak stands", seen: [{ name: "Lord_Yelinak", state: "alive", level: 70 }] });
    expect(came.task.seenAt).toBeGreaterThanOrEqual(came.t0 + 40000);
    expect(came.moves).toEqual(["skyshrine", "hole"]);
    // A look without a wait reads once and reports when the boss is due.
    const down = await look(3 * 3600000, 0);
    expect(down.task).toMatchObject({ status: "done", seen: [{ name: "Lord_Yelinak", state: "respawning" }] });
    expect(down.task.result).toMatch(/^Lord Yelinak is not up, next spawn at \d\d:\d\d$/);
    expect(down.reads).toBe(1);
    expect(down.moves).toEqual(["skyshrine", "hole"]);
  } finally {
    vi.useRealTimers();
  }
});

test("a camp the client stops is started once more and then goes on as a hunt for what is up", async () => {
  vi.useFakeTimers();
  try {
    // Group 1 in Dragon Necropolis on 2026-11-11: the client stopped the camp on arrival, and the
    // task stood until its half hour was up.
    const f = await install([10, 20]);
    f.bot.config.leaderId = 1;
    Object.assign(f.combat, { enemyTargetAttackOnArrival: true, setEnemyTargetAttackOnArrival: () => {}, isRunning: false });
    let camps = 0;
    Object.assign(f.runtime, { selectEnemyTarget: () => {}, startSpawnCamp: () => (camps++, f.say("Spawn Camp stopped: Navigation recovery could not find a supported combat position.")) });
    const t0 = Date.now();
    f.bot.hunt({ zone: "necropolis", keep: "a Chetari Dominator", points: [123010], minutes: 30 });
    await runToEnd(f);
    expect(camps).toBe(2);
    expect(f.bot.state.task).toMatchObject({ status: "done", kills: 0, result: "none of a Chetari Dominator up (Spawn Camp stopped: Navigation recovery could not find a supported combat position.)" });
    expect(Date.now() - t0).toBeLessThan(90000);
  } finally {
    vi.useRealTimers();
  }
});

test("a hunt leaves an enemy the client finds no route to and goes on with the others", async () => {
  vi.useFakeTimers();
  try {
    // Group 10 in Dragon Necropolis on 2026-11-12: the client found no route to a Paebala warrior
    // every 15 s for 11 minutes, and the hunt kept choosing it until it was stopped by hand.
    const f = await install([10, 20]);
    f.bot.config.leaderId = 1;
    Object.assign(f.combat, { enemyTargetAttackOnArrival: true, setEnemyTargetAttackOnArrival: () => {} });
    const warrior = { spawnInstanceId: 1, npcId: 123001, name: "a_Paebala_warrior", level: 55 };
    const chelaki = { spawnInstanceId: 2, npcId: 123002, name: "a_Chelaki", level: 54 };
    let up = [warrior, chelaki];
    const picked: number[][] = [];
    f.runtime.combatScene.getAliveCombatTargetList = () => up;
    Object.assign(f.runtime, {
      selectEnemyTarget: (ids: number[]) => {
        picked.push(ids);
        // The client takes the nearest of them, the warrior while it is among them.
        if (ids.includes(warrior.npcId)) {
          Object.assign(f.combat, { targetNPC: warrior });
          setTimeout(() => {
            f.say("No usable route. Recovering near a Paebala warrior.");
            f.say("Navigation recovery could not find a supported combat position. Looking for another target.");
          }, 1000);
        } else {
          Object.assign(f.combat, { targetNPC: chelaki });
          setTimeout(() => {
            up = [warrior];
            f.say("You have defeated a Chelaki and gained 114145 experience!");
          }, 3000);
        }
      },
    });
    const t0 = Date.now();
    f.bot.hunt({ zone: "necropolis", keep: "a Chelaki|a Paebala warrior", minutes: 30 });
    await runToEnd(f);
    expect(picked).toEqual([[123001, 123002], [123002]]);
    expect(f.bot.state.task).toMatchObject({ status: "done", kills: 1, result: "none of a Chelaki|a Paebala warrior up, no route to a Paebala warrior" });
    expect(Date.now() - t0).toBeLessThan(120000);
  } finally {
    vi.useRealTimers();
  }
});

test("a visit that finds none of its enemies up names the first respawn of the points it watches", async () => {
  vi.useFakeTimers();
  try {
    const f = await install([10, 20]);
    f.bot.config.leaderId = 1;
    Object.assign(f.combat, { enemyTargetAttackOnArrival: true, setEnemyTargetAttackOnArrival: () => {} });
    Object.assign(f.runtime, { selectEnemyTarget: () => {} });
    f.runtime.combatScene.getAliveCombatTargetList = () => [];
    const respawn = Date.now() + 3600000;
    // Another point of the zone respawns sooner, but the visit waits only on its own.
    const spawns = [
      { name: "a_black_reaver", spawn2Id: 3265732, currentHp: 0, state: "respawning", nextRespawnAtMs: respawn },
      { name: "a_shade", spawn2Id: 7, currentHp: 0, state: "respawning", nextRespawnAtMs: Date.now() + 60000 },
    ];
    Object.assign(f.iq, { zoneSpawns: { spawns } });
    f.bot.hunt({ zone: "citymist", keep: "a black reaver", item: "Iksar Scale", watch: [3265732] });
    await runToEnd(f);
    expect(f.bot.state.task).toMatchObject({ status: "done", nextAt: respawn });
    expect(f.bot.state.task.result).toMatch(/^none of a black reaver up, next spawn at /);
  } finally {
    vi.useRealTimers();
  }
});

test("a summoned enemy that is up already sends the member to the fight", async () => {
  vi.useFakeTimers();
  try {
    const f = await install([10, 20]);
    f.bot.config.leaderId = 1;
    handInPage(f, {}, { ok: true });
    const gives: string[][] = [];
    const dopple = { spawnInstanceId: 9, npcId: 4401, name: "Maligars_Enraged_Doppleganger", level: 40 };
    const zone = { spawns: [{ name: "Maligars_Enraged_Doppleganger", spawn2Id: 0, currentHp: 900 }] as { name: string; spawn2Id: number; currentHp: number }[] };
    let dead = false;
    Object.assign(f.iq, {
      carried: (item: string) => (item === "Note to Maligar" ? 1 : 0),
      refreshSpawns: async () => zone.spawns.length,
      zoneSpawns: zone,
      talkToNpc: async () => {},
      giveToNpc: async (items: string[]) => void gives.push(items),
    });
    Object.assign(f.party, { requestAccountCharacterAvailability: () => {}, availableAccountCharacterIds: [] });
    Object.assign(f.combat, { enemyTargetAttackOnArrival: true, setEnemyTargetAttackOnArrival: () => {} });
    f.runtime.combatScene.getAliveCombatTargetList = () => (dead ? [] : [dopple]);
    // The party arrives with no mana, and the pull must wait until it is ready again.
    Object.assign(f.me, { mana: 0, maxMana: 100 });
    setTimeout(() => (f.me.mana = 100), 30000);
    const pulledReady: boolean[] = [];
    Object.assign(f.runtime, { selectEnemyTarget: () => (pulledReady.push(f.iq.partyFull()), setTimeout(() => ((dead = true), f.say("You have defeated Maligars Enraged Doppleganger, but gain no experience.")), 3000)) });
    const steps = [
      { zone: "qey2hh1", npc: "Maligar", give: ["Note to Maligar"] },
      { zone: "qey2hh1", kill: "Enraged Doppleganger", waitSec: 120 },
    ];
    f.bot.quest({ members: ["Tagujazolu"], steps });
    await runToEnd(f);
    expect(f.bot.state.task).toMatchObject({ status: "done" });
    expect(gives).toEqual([]);
    expect(pulledReady).toEqual([true]);

    // An enemy that is also the hand-in's NPC says nothing about the hand-in: Shmendrik Lavawalker
    // can be attacked before he has the crown too, so he gets it first and the fight follows.
    const shmendrik = { spawnInstanceId: 12, npcId: 51012, name: "Shmendrik Lavawalker", level: 30 };
    let handed = false;
    dead = false;
    zone.spawns = [{ name: "Shmendrik_Lavawalker", spawn2Id: 7099, currentHp: 900 }];
    Object.assign(f.iq, {
      carried: (item: string) => (item === "Lord Bergurgle's Crown" && !handed ? 1 : 0),
      giveToNpc: async (items: string[]) => {
        gives.push(items);
        handed = true;
      },
    });
    f.runtime.combatScene.getAliveCombatTargetList = () => (dead ? [] : [shmendrik]);
    Object.assign(f.runtime, { selectEnemyTarget: () => setTimeout(() => ((dead = true), f.say("You have slain Shmendrik Lavawalker, but gain no experience.")), 3000) });
    f.bot.quest({ members: ["Tagujazolu"], steps: [{ zone: "lakerathe", npc: "Shmendrik Lavawalker", give: ["Lord Bergurgle's Crown"] }, { zone: "lakerathe", kill: "Shmendrik Lavawalker", waitSec: 30 }] });
    await runToEnd(f);
    expect(gives).toEqual([["Lord Bergurgle's Crown"]]);
    expect(f.bot.state.task).toMatchObject({ status: "done" });

    // During Natasha's scene the server takes Shmendrik out of automated combat, so Enemy Targets
    // leaves him out and the step attacks his spawn directly.
    handed = false;
    dead = false;
    const attacked: number[] = [];
    const entity = { spawnInstanceId: 12, spawn: { name: "Shmendrik_Lavawalker", npcId: 51012, automatedCombatExcluded: true, combatBlockedReason: "scripted" } };
    f.runtime.combatScene.getAliveCombatTargetList = () => (handed || dead ? [] : [shmendrik]);
    Object.assign(f.runtime.combatScene, { dependencies: { getEntityPool: () => ({ getAliveEntities: () => (dead ? [] : [entity]) }) } });
    Object.assign(f.runtime, {
      selectEnemyTarget: () => {},
      startDirectedCombat: (npcId: number) => {
        attacked.push(npcId);
        setTimeout(() => ((dead = true), f.say("You have slain Shmendrik Lavawalker, but gain no experience.")), 3000);
      },
    });
    f.bot.quest({ members: ["Tagujazolu"], steps: [{ zone: "lakerathe", npc: "Shmendrik Lavawalker", give: ["Lord Bergurgle's Crown"] }, { zone: "lakerathe", kill: "Shmendrik Lavawalker", waitSec: 30 }] });
    await runToEnd(f);
    expect(attacked).toEqual([51012]);
    expect(f.bot.state.task).toMatchObject({ status: "done" });
  } finally {
    vi.useRealTimers();
  }
});

test("a quest's fight that outlasts the step's wait and the client's target goes on until the kill", async () => {
  vi.useFakeTimers();
  try {
    const f = await install([10, 20]);
    f.bot.config.leaderId = 1;
    handInPage(f, {}, { ok: true });
    const jaeil = { spawnInstanceId: 9, npcId: 39154, name: "Jaeil_the_Insane", level: 55 };
    let dead = false;
    let hammer = 0;
    Object.assign(f.iq, { carried: (item: string) => (item === "Soulbound Hammer" ? hammer : 0), talkToNpc: async () => {}, giveToNpc: async () => {} });
    Object.assign(f.party, { requestAccountCharacterAvailability: () => {}, availableAccountCharacterIds: [] });
    Object.assign(f.combat, { enemyTargetAttackOnArrival: true, setEnemyTargetAttackOnArrival: () => {} });
    f.runtime.combatScene.getAliveCombatTargetList = () => (dead ? [] : [jaeil]);
    // The fight takes 200 s, longer than the step's 60 s and one call's 150 s, and the client shows
    // no target through it.
    Object.assign(f.runtime, {
      selectEnemyTarget: () => {
        f.skills.inCombat = true;
        setTimeout(() => {
          dead = true;
          f.skills.inCombat = false;
          hammer = 1;
          f.say("You have defeated Jaeil the Insane and gained 77680 experience!");
        }, 200000);
      },
    });
    f.bot.quest({ members: ["Tagujazolu"], steps: [{ zone: "hole", kill: "Jaeil the Insane", expect: "Soulbound Hammer", waitSec: 60 }] });
    for (let k = 0; k < 4 && f.bot.state.task?.status === "running"; k++) await runToEnd(f);
    expect(f.bot.state.task).toMatchObject({ status: "done" });
  } finally {
    vi.useRealTimers();
  }
});

test("a quest item that lies in the zone is picked up, and one another player took ends the task as waiting until its respawn", async () => {
  vi.useFakeTimers();
  try {
    const f = await install([10, 20]);
    f.bot.config.leaderId = 1;
    handInPage(f, {}, { ok: true });
    let hilt = 0;
    let lying = true;
    Object.assign(f.iq, {
      carried: (item: string) => (item === "Unjeweled Dragon Head Hilt" ? hilt : 0),
      pickupGround: async (name: string) => {
        if (!lying) throw new Error(`no ${name} lies in lakerathe now`);
        hilt = 1;
        return "You picked it up.";
      },
    });
    const steps = [{ zone: "lakerathe", pick: "Unjeweled Dragon Head Hilt", expect: "Unjeweled Dragon Head Hilt", respawnSec: 600 }];
    f.bot.quest({ members: ["Tagujazolu"], steps });
    await runToEnd(f);
    expect(f.bot.state.task).toMatchObject({ status: "done" });

    hilt = 0;
    lying = false;
    f.bot.quest({ members: ["Tagujazolu"], steps });
    await runToEnd(f);
    expect(f.bot.state.task).toMatchObject({ status: "waiting" });
    expect(f.bot.state.task.nextAt - Date.now()).toBeGreaterThan(9 * 60000);
  } finally {
    vi.useRealTimers();
  }
});

// The raid adapter the bridge offers (`window.iq.raid`), with a fight that lasts `fightMs`
// and ends in a kill, a wipe or, with outcome "fled", a boss that leaves the fight alive. A kill
// shows as the server's kill line and leaves one drop on the corpse. `leaderFalls` kills the
// leader once, mid-fight, `endFails` makes that many calls of `end` throw, `diesOnArrival`
// has the raid engage and kill the boss while it walks there, before any attack order, and
// `stalls` leaves the raid standing in combat under its first attack order until a second one.
function fakeRaid(f: Awaited<ReturnType<typeof install>>, { timeLeft = false, pricePp = 2000, outcome = "killed", fightMs = 10000, leaderFalls = false, endFails = 0, healer = false, diesOnArrival = false, stalls = false } = {}) {
  const calls: string[] = [];
  const r = { active: false, combat: false, leaderDead: false, roster: [] as { name: string; damage: number; alive: boolean }[] };
  let started = false;
  let drops: { id: string; name: string }[] = [];
  const page = f.iq as unknown as { events: { t: number; seq: number; type?: string; text: string }[] };
  const die = () => {
    f.targets.splice(0);
    drops = [{ id: "loot-item-7-0", name: "Red Dragon Scales" }];
    page.events = [...(page.events ?? []), { t: Date.now(), seq: 9002, type: "EXPERIENCE_GAIN", text: "You have defeated Lord Nagafen and gained 520300 experience!" }];
  };
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
    heal: (mode: string) => calls.push(`heal ${mode}`),
    position: () => {
      calls.push(`position ${f.combat.targetNPC?.name}`);
      if (diesOnArrival) setTimeout(die, 4000);
    },
    attack: async () => {
      calls.push(`attack ${f.combat.targetNPC?.name}`);
      if (started) return;
      r.combat = true;
      if (stalls) return void (stalls = false);
      started = true;
      if (leaderFalls) setTimeout(() => (r.leaderDead = true), fightMs / 2);
      // An add joins the fight and heals the boss, as Phinigel's seahorse did.
      if (healer)
        setTimeout(() => {
          f.targets.push({ spawnInstanceId: 8, npcId: 1099, name: "a_swirlspine_seahorse", level: 49, distance: 20 } as { spawnInstanceId: number; name: string });
          page.events = [...(page.events ?? []), { t: Date.now(), seq: 9001, text: "a swirlspine seahorse heals Lord Nagafen for 10000 points." }];
        }, fightMs / 4);
      setTimeout(() => {
        r.combat = false;
        r.roster = r.roster.map((m) => ({ ...m, damage: 500, alive: outcome !== "wiped" }));
        if (outcome === "killed") die();
        else if (outcome === "fled") f.targets.splice(0);
        else r.leaderDead = true;
      }, fightMs);
    },
    nuke: (mode: string) => calls.push(`nuke ${mode}`),
    effect: async (kind: string) => {
      calls.push(`effect ${kind}`);
      if (kind === "debuff") throw new Error("no raid member has resistance debuffs");
      return { kind, spell: "Drowsy", kept: true };
    },
    revive: async () => {
      calls.push("revive");
      r.leaderDead = false;
    },
    state: () => ({ combat: r.combat, leaderDead: r.leaderDead, pending: false, roster: r.roster, enemies: [], leader: { hp: 100, order: "attacking", revision: 1 }, log: [] }),
    end: async () => {
      calls.push("end");
      if (endFails-- > 0) throw new Error("the raid was not abandoned: Request timeout for opcode 1026");
      r.active = false;
    },
    // One drop on one corpse, which a take moves straight into the bags.
    loot: {
      cells: () => drops,
      open: async () => true,
      coin: async () => false,
      take: async (id: string) => {
        calls.push("loot");
        drops = drops.filter((c) => c.id !== id);
        return null;
      },
      giveBack: async () => true,
    },
  };
  // The boss that dies on arrival stands as far off as Lodizal did, so the raid is still walking.
  f.targets.push({ spawnInstanceId: 7, npcId: 1032, name: "Lord_Nagafen", level: 55, distance: diesOnArrival ? 5580 : 12 } as { spawnInstanceId: number; name: string });
  Object.assign(f.runtime, { selectEnemyTarget: (ids: number[]) => (f.combat.targetNPC = ids[0] === 1099 ? { spawnInstanceId: 8, name: "a_swirlspine_seahorse" } : { spawnInstanceId: 7, name: "Lord_Nagafen" }) });
  return calls;
}

test("a raid that deals no damage gets its attack order again", async () => {
  vi.useFakeTimers();
  try {
    // Tolapumj on 2026-11-11: the tab reconnected a minute into the fight, the boss was back at
    // full health, and the raid stood in combat under its old order until a new one.
    const f = await install([10, 20]);
    const calls = fakeRaid(f, { timeLeft: true, stalls: true });
    f.bot.raid({ members: ["Tagujazolu", "Edroun"], target: "Nagafen", effects: [] });
    await runToEnd(f);
    expect(calls.filter((c) => c.startsWith("attack"))).toEqual(["attack Lord_Nagafen", "attack Lord_Nagafen"]);
    expect(f.bot.state.task).toMatchObject({ status: "done", fight: { outcome: "killed", orders: [{ kind: "attack", why: "no damage for 20 s", result: "attacked" }] } });
  } finally {
    vi.useRealTimers();
  }
});

test("a raid fight past its minutes goes on while the boss still loses health and raid time is left", async () => {
  vi.useFakeTimers();
  try {
    // Cazic-Thule on 2026-11-12: 30 minutes ended the fight 75 s before the kill.
    const f = await install([10, 20]);
    const calls = fakeRaid(f, { timeLeft: true, fightMs: 150000 });
    const raid = (f.iq as unknown as { raid: { time: () => Promise<object>; state: () => { enemies: object[] } } }).raid;
    const state = raid.state;
    const t0 = Date.now();
    raid.state = () => ({ ...state(), enemies: [{ id: 7, hp: Math.max(1, 400000 - (Date.now() - t0)) }] });
    raid.time = async () => (calls.push("time"), { active: true, pricePp: 2000, expiresAt: Date.now() + 3600000 });
    f.bot.raid({ members: ["Tagujazolu", "Edroun"], target: "Nagafen", effects: [], minutes: 1 });
    for (let k = 0; k < 4 && f.bot.state.task?.status === "running"; k++) await runToEnd(f);
    expect(f.bot.state.task).toMatchObject({ status: "done", fight: { outcome: "killed", overtime: true } });
  } finally {
    vi.useRealTimers();
  }
});

test("a leader that Run To Target leaves far from the boss walks there before the attack", async () => {
  vi.useFakeTimers();
  try {
    // Cazic-Thule on 2026-11-12: the members ran to the boss and the leader, the raid's tank,
    // stood 2,222 away for the whole fight.
    const f = await install([10, 20]);
    const calls = fakeRaid(f, { timeLeft: true });
    const boss = f.targets.find((t) => t.spawnInstanceId === 7) as { distance: number };
    boss.distance = 2222;
    Object.assign(f.runtime.combatScene, { dependencies: { getEntityPool: () => ({ getAliveEntities: () => [{ spawn: { spawnInstanceId: 7 }, currentPos: { x: -100, y: 5, z: 300 } }] }) } });
    const walks: unknown[] = [];
    Object.assign(f.iq, {
      walkTo: async (pos: unknown) => {
        walks.push(pos);
        boss.distance = 12;
        return true;
      },
    });
    f.bot.raid({ members: ["Tagujazolu", "Edroun"], target: "Nagafen", effects: [] });
    await runToEnd(f);
    expect(walks).toEqual([{ x: 300, y: 100, z: 5 }]);
    expect(calls.indexOf("attack Lord_Nagafen")).toBeGreaterThan(calls.indexOf("position Lord_Nagafen"));
    expect(f.bot.state.task).toMatchObject({ status: "done", fight: { outcome: "killed" } });
  } finally {
    vi.useRealTimers();
  }
});

test("a raid task buys time when none is left, recruits, sets its orders, kills its target and ends the raid", async () => {
  vi.useFakeTimers();
  try {
    const f = await install([10, 20]);
    const calls = fakeRaid(f);
    // The leader carries the hour's price, so no balance is pulled.
    (f.me as unknown as { platinum: number }).platinum = 2000;
    f.bot.raid({ members: ["Tagujazolu", "Edroun"], target: "Nagafen", maxPp: 2500, effects: ["slow", "debuff"] });
    await runToEnd(f);
    // The heal mode stands before the fight, the raid walks to the boss first, and the nuke and
    // effect orders need the running fight. A debuff nobody can cast does not hold the fight.
    expect(calls).toEqual(["time", "buy 2500", "open", "recruit 10,20", "heal all-balanced", "position Lord_Nagafen", "attack Lord_Nagafen", "nuke dps-balanced", "effect slow", "effect debuff", "end", "loot"]);
    expect(f.bot.state.task.result).toContain("looted 1 items");
    expect(f.bot.state.task).toMatchObject({ status: "done", fight: { outcome: "killed", alive: 2, deaths: 0, orders: [{ kind: "slow", spell: "Drowsy", kept: true }, { kind: "debuff", error: "no raid member has resistance debuffs" }] } });
    expect(f.bot.state.task.fight.trace.length).toBeGreaterThan(0);
    expect(f.bot.state.alerts.filter((a) => a.kind === "raid" && a.wake)).toMatchObject([{ killed: expect.stringContaining("Nagafen") }]);
  } finally {
    vi.useRealTimers();
  }
});

test("a potion raid uses the potion after recruiting and fights its boss, and a refused potion ends the raid", async () => {
  vi.useFakeTimers();
  try {
    const f = await install([10, 20]);
    const calls = fakeRaid(f, { timeLeft: true });
    let accept = true;
    (f.iq as unknown as { useItem: (id: number) => Promise<boolean> }).useItem = async (id) => (calls.push(`potion ${id}`), accept);
    f.bot.raid({ members: ["Edroun"], target: "Nagafen", potion: 990100, maxPp: 0 });
    await runToEnd(f);
    expect(calls.slice(0, 5)).toEqual(["time", "open", "recruit 20", "potion 990100", "heal all-balanced"]);
    expect(f.bot.state.task).toMatchObject({ status: "done", fight: { outcome: "killed" } });
    // Without the potion's boss there is nothing to fight, and the raid ends.
    calls.splice(0);
    accept = false;
    f.bot.raid({ members: ["Edroun"], target: "Nagafen", potion: 990100, maxPp: 0 });
    await runToEnd(f);
    expect(f.bot.state.task.status).toBe("failed");
    expect(calls).toContain("end");
    expect(calls).not.toContain("attack Lord_Nagafen");
  } finally {
    vi.useRealTimers();
  }
});

test("a raid task records a wipe, and without raid time it stops before releasing the party", async () => {
  vi.useFakeTimers();
  try {
    const f = await install([10, 20]);
    const calls = fakeRaid(f, { timeLeft: true, outcome: "wiped" });
    f.bot.raid({ members: ["Tagujazolu"], target: "Nagafen", heal: null, nuke: null, effects: [] });
    await runToEnd(f);
    expect(calls).toEqual(["time", "open", "recruit 10", "position Lord_Nagafen", "attack Lord_Nagafen", "end"]);
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

test("a raid on a boss of the open world that no longer stands ends before it buys raid time", async () => {
  vi.useFakeTimers();
  try {
    const f = await install([10, 20]);
    const calls = fakeRaid(f, { pricePp: 10000 });
    const boss = { npcId: 64001, name: "Phinigel_Autropos", level: 53, autoLevelExcluded: true, state: "respawning", nextRespawnAtMs: Date.now() + 3600000 };
    Object.assign(f.iq, { zoneSpawns: { t: 0, spawns: [boss] }, refreshSpawns: async () => 1 });
    f.bot.raid({ members: ["Tagujazolu"], target: "Phinigel Autropos", zone: "kedge", open: true, maxPp: 10000 });
    await runToEnd(f);
    expect(f.bot.state.task).toMatchObject({ status: "done", result: "Phinigel Autropos is not up", seen: [{ name: "Phinigel_Autropos", state: "respawning" }] });
    expect(calls).toEqual([]);
  } finally {
    vi.useRealTimers();
  }
});

test("a raid's leader pulls balances one after another until it carries the hour's price", async () => {
  vi.useFakeTimers();
  const g = globalThis as unknown as { document?: unknown };
  try {
    // 2026-11-12: the account held 49,000 platinum, no character over 9,300 and the leader 618,
    // and the raid on Phinigel Autropos failed at its raid time.
    const run = async (held: [string, number][]) => {
      const f = await install([10, 20]);
      Object.assign(f.sheet.characterProfile, { platinum: 618 });
      const pulls: string[] = [];
      const row = ([name, pp]: [string, number]) => ({
        querySelectorAll: () => [name, "", "", `${pp.toLocaleString("en")} pp`].map((textContent) => ({ textContent })),
        querySelector: () => ({
          disabled: false,
          click: () => {
            Object.assign(f.sheet.characterProfile, { platinum: (f.sheet.characterProfile as { platinum?: number }).platinum! + pp });
            held.splice(held.findIndex((b) => b[0] === name), 1);
            pulls.push(name);
          },
        }),
      });
      const panel = { textContent: "", querySelector: () => null, querySelectorAll: () => held.map(row) };
      g.document = { querySelector: (sel: string) => (sel.includes("manage-money-panel") ? panel : null), querySelectorAll: () => [] };
      Object.assign(f.combat, { openManageMoney: () => {}, closeManageMoney: () => {} });
      const calls = fakeRaid(f, { pricePp: 10000 });
      f.bot.raid({ members: ["Tagujazolu"], target: "Nagafen", maxPp: 10000, heal: null, nuke: null, effects: [] });
      await runToEnd(f);
      return { pulls, calls, task: f.bot.state.task };
    };
    const rich = await run([["Figrothe", 6627], ["Gygekrian", 9286], ["Tovrenalis", 7968]]);
    expect(rich.pulls).toEqual(["Gygekrian", "Tovrenalis"]);
    expect(rich.calls).toContain("buy 10000");
    // An account that cannot raise the price buys no hour and opens no raid.
    const poor = await run([["Loshotin", 50], ["Kimorili", 270]]);
    expect(poor.pulls).toEqual(["Kimorili", "Loshotin"]);
    expect(poor.task).toMatchObject({ status: "failed", step: "raid time", error: "Me carries 938 of the 10000 platinum an hour of raid time costs, with every balance it could pull" });
    expect(poor.calls).not.toContain("open");
  } finally {
    delete g.document;
    vi.useRealTimers();
  }
});

test("a raid task has a living member revive the fallen leader and fights on", async () => {
  vi.useFakeTimers();
  try {
    const f = await install([10, 20]);
    const calls = fakeRaid(f, { timeLeft: true, leaderFalls: true, fightMs: 20000 });
    f.bot.raid({ members: ["Tagujazolu", "Edroun"], target: "Nagafen" });
    await runToEnd(f);
    expect(calls.filter((c) => c === "revive")).toHaveLength(1);
    expect(f.bot.state.task).toMatchObject({ status: "done", fight: { outcome: "killed", deaths: 1, revives: 1 } });
  } finally {
    vi.useRealTimers();
  }
});

test("a boss that leaves the fight alive is no kill, and one that dies on the raid's arrival is", async () => {
  vi.useFakeTimers();
  try {
    // Lodizal fled two fights and was gone from the enemy list, with no kill line.
    const f = await install([10, 20]);
    const calls = fakeRaid(f, { timeLeft: true, outcome: "fled" });
    f.bot.raid({ members: ["Tagujazolu", "Edroun"], target: "Nagafen", effects: [] });
    await runToEnd(f);
    expect(f.bot.state.task).toMatchObject({ status: "done", fight: { outcome: "ended", alive: 2 } });
    expect(f.bot.state.alerts.filter((a) => a.kind === "raid")).toEqual([]);
    expect(calls).not.toContain("loot");
    // The third fight killed him while the raid still walked to him.
    const g = await install([10, 20]);
    const early = fakeRaid(g, { timeLeft: true, diesOnArrival: true });
    g.bot.raid({ members: ["Tagujazolu", "Edroun"], target: "Nagafen" });
    await runToEnd(g);
    expect(g.bot.state.task).toMatchObject({ status: "done", fight: { outcome: "killed" } });
    expect(early.filter((c) => /^(attack|nuke|effect)/.test(c))).toEqual([]);
    expect(early.at(-1)).toBe("loot");
    expect(g.bot.state.alerts.filter((a) => a.kind === "raid" && a.wake)).toMatchObject([{ killed: expect.stringContaining("Nagafen") }]);
  } finally {
    vi.useRealTimers();
  }
});

test("a raid task attacks an enemy that heals its boss, once, and collects the loot after the kill", async () => {
  vi.useFakeTimers();
  try {
    const f = await install([10, 20]);
    const calls = fakeRaid(f, { timeLeft: true, healer: true, fightMs: 20000 });
    f.bot.raid({ members: ["Tagujazolu", "Edroun"], target: "Nagafen", effects: [] });
    await runToEnd(f);
    expect(calls.filter((c) => c.startsWith("attack"))).toEqual(["attack Lord_Nagafen", "attack a_swirlspine_seahorse"]);
    expect(f.bot.state.task.fight.orders).toMatchObject([{ kind: "healer", name: "a swirlspine seahorse", result: "attacked" }]);
    expect(calls.at(-1)).toBe("loot");
  } finally {
    vi.useRealTimers();
  }
});

test("any task that takes the tab ends a running errand as finished, not failed", async () => {
  vi.useFakeTimers();
  try {
    const f = await install([10, 20]);
    fakeRaid(f, { timeLeft: true });
    await f.bot.errand({ zone: "permafrost", keep: "wisp", item: "Diamond Wedding Band", minutes: 60 });
    f.bot.raid({ members: ["Tagujazolu"], target: "Nagafen" });
    expect(f.bot.state.errand).toBeNull();
    expect(f.bot.state.alerts.find((a) => a.kind === "errand")).toMatchObject({ wake: false, text: expect.stringContaining("raid task took the tab") });
    await runToEnd(f);
  } finally {
    vi.useRealTimers();
  }
});

test("a task's stop leaves a fight that still runs after 45 s", async () => {
  vi.useFakeTimers();
  try {
    const f = await install([10, 20]);
    fakeRaid(f, { timeLeft: true });
    // Chardok: with AutoLevel held, enemy after enemy attacks the standing party, so the fight never
    // ends by itself. The guard's escape ends it some seconds after it is asked.
    const left: string[] = [];
    f.skills.inCombat = true;
    Object.assign(f.iq, { leaveFight: (why: string) => (left.push(why), setTimeout(() => (f.skills.inCombat = false), 5000), true) });
    f.bot.raid({ members: ["Tagujazolu"], target: "Nagafen", effects: [] });
    await runToEnd(f);
    expect(left).toEqual(["a task waited 45 s for the fight to end"]);
    expect(f.bot.state.task).toMatchObject({ status: "done", fight: { outcome: "killed" } });
  } finally {
    vi.useRealTimers();
  }
});

test("a raid end that fails is tried again, and a raid left on asks for attention", async () => {
  vi.useFakeTimers();
  try {
    const f = await install([10, 20]);
    const calls = fakeRaid(f, { timeLeft: true, endFails: 1 });
    f.bot.raid({ members: ["Tagujazolu"], target: "Nagafen" });
    await runToEnd(f);
    expect(calls.filter((c) => c === "end")).toHaveLength(2);
    expect(f.bot.state.alerts.some((a) => a.kind === "raid" && /still on/.test(a.text))).toBe(false);

    const g = await install([10, 20]);
    fakeRaid(g, { timeLeft: true, endFails: 2 });
    g.bot.raid({ members: ["Tagujazolu"], target: "Nagafen" });
    await runToEnd(g);
    expect(g.bot.state.alerts.find((a) => a.kind === "raid" && /still on/.test(a.text))?.wake).toBe(true);
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

test("a camping the server could not confirm signs the page out, and the quest's switch waits until the page is back", async () => {
  vi.useFakeTimers();
  try {
    const f = await install([10, 20]);
    f.bot.config.leaderId = 1;
    handInPage(f, {}, { ok: true });
    const held = (f.iq as unknown as { carried: (i: string) => number }).carried;
    let note = 0;
    Object.assign(f.iq, {
      carried: (item: string) => (item === "Wax Sealed Note" ? note : held(item)),
      talkToNpc: async () => {
        note = 1;
      },
    });
    // As the client does: the socket closes and the page shows the login form with no characters,
    // until the client resumes the session 80 s later at the character select.
    const socket = (f.iq as unknown as { socket: { isConnected: boolean } }).socket;
    const enter = f.iq.command;
    let campFails = 1;
    f.iq.command = async (c: { type: string; selector?: string }) => {
      if (c.type !== "session.camp" || campFails-- <= 0) return enter(c);
      f.commands.push("session.camp refused");
      const list = f.roster.characters.splice(0);
      Object.assign(socket, { isConnected: false });
      f.screen.currentScreen = "login";
      setTimeout(() => {
        f.roster.characters.push(...list);
        Object.assign(socket, { isConnected: true });
        f.screen.currentScreen = "characterSelect";
      }, 80000);
      return { ok: false, message: "Could not confirm camping. Please sign in again." };
    };
    f.bot.quest({ members: ["Tagujazolu"], steps: [{ zone: "freporte", npc: "Kargek Redblade", say: ["favor"], expect: "Wax Sealed Note" }] });
    await runToEnd(f);
    expect(f.bot.state.task).toMatchObject({ status: "done", members: [{ name: "Tagujazolu", done: true }] });
    expect(f.commands.slice(0, 2)).toEqual(["session.camp refused", "session.enterWorld Tagujazolu"]);
  } finally {
    vi.useRealTimers();
  }
});

test("a task whose page is left at the character select fails, and the bot enters the world again", async () => {
  vi.useFakeTimers();
  try {
    const f = await install([10, 20]);
    f.bot.config.leaderId = 1;
    handInPage(f, {}, { ok: true });
    // A step that plays in the world and does not end, as a camp waits on its spawn points.
    let talking = false;
    Object.assign(f.iq, { talkToNpc: () => ((talking = true), new Promise(() => {})) });
    f.bot.quest({ members: ["Tagujazolu"], steps: [{ zone: "freporte", npc: "Kargek Redblade", say: ["favor"], expect: "Wax Sealed Note" }] });
    for (let k = 0; k < 60 && !talking; k++) {
      vi.advanceTimersByTime(500);
      await flush();
    }
    expect([talking, f.sheet.characterProfile.name, f.bot.state.task.status]).toEqual([true, "Tagujazolu", "running"]);
    // The server restarts, and the page supervisor's sign-in leaves the page at the character select.
    f.screen.currentScreen = "characterSelect";
    f.commands.length = 0;
    vi.advanceTimersByTime(10000);
    await f.bot.tick();
    await flush();
    expect(f.bot.state.task.status).toBe("running");
    // The bot saw the character select at that tick, and 20 s on the page is still there.
    vi.advanceTimersByTime(21000);
    await f.bot.tick();
    await flush();
    expect(f.bot.state.task).toMatchObject({ status: "failed", error: expect.stringContaining("character select") });
    expect(f.bot.state.task.nextAt).toBeGreaterThan(Date.now());
    expect(f.bot.state.alerts.filter((a) => a.kind === "task").map((a) => a.wake)).toEqual([false]);
    // The task's pause is over, so the bot enters the world as its leader.
    vi.advanceTimersByTime(2000);
    await f.bot.tick();
    await flush();
    expect(f.commands).toEqual(["session.enterWorld Me"]);
  } finally {
    vi.useRealTimers();
  }
});

test("a quest NPC's point is looked at once: the NPC goes on, a respawn ends as waiting, and the gathered leader's party camps an occupant", async () => {
  vi.useFakeTimers();
  try {
    const f = await install([10, 20]);
    f.bot.config.leaderId = 1;
    handInPage(f, {}, { ok: true });
    let note = 0;
    type Spawn = { name: string; spawn2Id: number; currentHp: number; level?: number; state: string; nextRespawnAtMs?: number };
    const zone = { spawns: [] as Spawn[] };
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
    Object.assign(f.party, { requestAccountCharacterAvailability: () => {}, availableAccountCharacterIds: [] });
    Object.assign(f.combat, { enemyTargetAttackOnArrival: true, setEnemyTargetAttackOnArrival: () => {} });
    const steps = [{ zone: "guktop", npc: "Tykar Renlin", points: [3075], give: ["Drom's Champagne"], expect: "Bunker Cell #1" }];
    // The leader enters the world where it last stood, in another zone than the quest member.
    const enter = f.iq.command;
    f.iq.command = async (c: { type: string; selector?: string }) => {
      const r = await enter(c);
      if (c.type === "session.enterWorld") f.combat.currentZone = c.selector === "Me" ? 73 : 65;
      return r;
    };

    // The point respawns in 20 minutes, so the task ends as waiting until then, without an alert.
    zone.spawns = [{ name: "Lozani", spawn2Id: 3075, currentHp: 0, state: "respawning", nextRespawnAtMs: Date.now() + 1200000 }];
    f.bot.quest({ members: ["Tagujazolu"], steps });
    await runToEnd(f);
    expect(f.bot.state.task).toMatchObject({ status: "waiting" });
    expect(f.bot.state.task.nextAt - Date.now()).toBeGreaterThan(19 * 60000);
    expect(f.bot.state.alerts.filter((a) => a.kind === "task").map((a) => a.wake)).toEqual([false]);

    // An occupant waits while the leader's party does not gather: the leader enters the world alone,
    // and a camp without the party would be a solo fight.
    zone.spawns = [{ name: "Lozani", spawn2Id: 3075, currentHp: 1200, level: 12, state: "alive" }];
    const camped: { points: number[]; keep: string }[] = [];
    Object.assign(f.runtime, {
      startSpawnCamp: (points: number[], _radius: number, keep: string) => {
        camped.push({ points, keep });
        setTimeout(() => {
          zone.spawns = [{ name: "Lozani", spawn2Id: 3075, currentHp: 0, state: "respawning", nextRespawnAtMs: Date.now() + 1800000 }];
          f.say("You have slain Lozani, but gain no experience.");
          Object.assign(f.combat, { spawnCampStatus: "Waiting for next spawn" });
        }, 3000);
      },
    });
    f.bot.quest({ members: ["Tagujazolu"], steps });
    await runToEnd(f);
    expect(camped).toEqual([]);
    expect(f.bot.state.task).toMatchObject({ status: "waiting" });
    expect(f.bot.state.task.result).toContain("did not gather");

    // With the party back, the leader camps the point in the step's zone, and the task waits for the roll.
    f.party.controlAccountCharacter = (id: number) => void f.party.companions.push({ companionType: 2, characterId: id, name: `c${id}`, curHp: 100, maxHp: 100 });
    const moved = f.moves.length;
    f.bot.quest({ members: ["Tagujazolu"], steps });
    await runToEnd(f);
    expect(camped).toEqual([{ points: [3075], keep: "Lozani" }]);
    expect(f.sheet.characterProfile.id).toBe(1);
    expect(f.moves.slice(moved).at(-1)).toBe("guktop");
    expect(f.combat.currentZone).toBe(65);
    expect(f.bot.state.task).toMatchObject({ status: "waiting" });
    expect(f.bot.state.task.nextAt - Date.now()).toBeGreaterThan(29 * 60000);

    // With the NPC up, the member hands in.
    zone.spawns = [{ name: "Tykar_Renlin", spawn2Id: 3075, currentHp: 651, state: "alive" }];
    f.bot.quest({ members: ["Edroun"], steps });
    await runToEnd(f);
    expect(f.bot.state.task).toMatchObject({ status: "done" });
  } finally {
    vi.useRealTimers();
  }
});

test("a step whose NPC is down until its respawn ends as waiting until then, without a second try", async () => {
  vi.useFakeTimers();
  try {
    const f = await install([10, 20]);
    f.bot.config.leaderId = 1;
    handInPage(f, {}, { ok: true });
    const respawn = Date.now() + 25 * 60000;
    let talks = 0;
    Object.assign(f.iq, {
      carried: (item: string) => (item === "Empty Ink Vial" ? 1 : 0),
      talkToNpc: async () => {
        talks++;
        throw Object.assign(new Error("a ghoul scribe is not up, next spawn at 22:40:00"), { nextAt: respawn });
      },
    });
    f.bot.quest({ members: ["Tagujazolu"], steps: [{ zone: "gukbottom", npc: "a ghoul scribe", give: ["Empty Ink Vial"], expect: "Ink of the Dark" }] });
    await runToEnd(f);
    expect(talks).toBe(1);
    expect(f.bot.state.task).toMatchObject({ status: "waiting", nextAt: respawn + 30000 });
    expect(f.bot.state.alerts.filter((a) => a.kind === "task").map((a) => a.wake)).toEqual([false]);
  } finally {
    vi.useRealTimers();
  }
});

test("a trade the NPC refuses is tried again after talking to the NPC", async () => {
  vi.useFakeTimers();
  try {
    const f = await install([10, 20]);
    f.bot.config.leaderId = 1;
    handInPage(f, {}, { ok: true });
    let words = 0;
    const calls: string[] = [];
    Object.assign(f.iq, {
      carried: (item: string) => (item === "Words of Mastery" ? words : 1),
      talkToNpc: async () => void calls.push("talk"),
      // The first trade meets a stale view of the bags, which the server refuses and refreshes.
      giveToNpc: async () => {
        calls.push("give");
        if (calls.filter((c) => c === "give").length === 1) throw new Error("the trade was refused: The NPC does not want these items.");
        words = 1;
      },
    });
    f.bot.quest({ members: ["Tagujazolu"], steps: [{ zone: "najena", npc: "Akksstaff", give: ["Torn Page of Mastery Fire"], expect: "Words of Mastery" }] });
    await runToEnd(f);
    expect(f.bot.state.task).toMatchObject({ status: "done" });
    expect(calls).toEqual(["talk", "give", "talk", "give"]);
  } finally {
    vi.useRealTimers();
  }
});

test("a hand-in with coin takes the smallest balance that covers it, its own leader's first, and the leader takes the rest back", async () => {
  vi.useFakeTimers();
  try {
    const f = await install([10, 20]);
    f.bot.config.leaderId = 1;
    handInPage(f, {}, { ok: true });
    // A switch gives the member a profile of its own, copied from this one.
    const purse = () => f.sheet.characterProfile as { gold?: number };
    (f.me as { gold?: number }).gold = 3;
    const took: string[] = [];
    const gave: unknown[] = [];
    let box = 0;
    Object.assign(f.iq, {
      carried: (item: string) => (item === "Gkzzallk in a Box" ? box : 1),
      talkToNpc: async () => {},
      // A rich leader, a member whose gold does not cover the trade with the purse's three, and one whose does.
      balances: async () => [
        { name: "Rich", carried: { gold: 400 }, totalCopper: 9000000 },
        { name: "Poor", carried: { gold: 6 }, totalCopper: 700 },
        { name: "Enough", carried: { gold: 8 }, totalCopper: 900 },
      ],
      takeCoin: async (name: string) => {
        took.push(name);
        purse().gold = (purse().gold ?? 0) + 8;
      },
      giveToNpc: async (items: string[], opts?: { coin?: Record<string, number> }) => {
        gave.push([items, opts?.coin]);
        box = 1;
      },
    });
    f.bot.quest({ members: ["Tagujazolu"], steps: [{ zone: "airplane", npc: "a thunder spirit princess", coin: { gold: 10 }, expect: "Gkzzallk in a Box" }] });
    await runToEnd(f);
    expect(f.bot.state.task).toMatchObject({ status: "done" });
    expect(took[0]).toBe("Enough");
    expect(gave).toEqual([[[], { gold: 10 }]]);
    // Back with the leader, the bot takes the member's coin back to it.
    for (let k = 0; k < 10 && took.length < 2; k++) {
      vi.advanceTimersByTime(15000);
      await f.bot.tick();
      await flush();
    }
    expect(took).toEqual(["Enough", "Tagujazolu"]);

    // A leader whose purse covers the trade pays for it, however rich.
    took.length = 0;
    box = 0;
    (f.me as { gold?: number }).gold = 3;
    const balances = f.iq.balances;
    f.iq.balances = async () => [...(await balances()), { name: "Me", carried: { gold: 900 }, totalCopper: 99000000 }];
    f.bot.quest({ members: ["Tagujazolu"], steps: [{ zone: "airplane", npc: "a thunder spirit princess", coin: { gold: 10 }, expect: "Gkzzallk in a Box" }] });
    await runToEnd(f);
    expect(took[0]).toBe("Me");
  } finally {
    vi.useRealTimers();
  }
});

test("a step that only buys gets the copies a later hand-in takes, in the merchant's zone, and buys nothing it carries", async () => {
  vi.useFakeTimers();
  try {
    const f = await install([10, 20]);
    f.bot.config.leaderId = 1;
    handInPage(f, {}, { ok: true });
    const bags: Record<string, number> = { Wine: 1 };
    const log: string[] = [];
    Object.assign(f.iq, {
      carried: (item: string) => bags[item] ?? 0,
      buyItem: async (item: string, merchant: string, n: number) => {
        log.push(`buy ${n} ${item} from ${merchant} in ${f.combat.currentZone}`);
        bags[item] = (bags[item] ?? 0) + n;
        return { bought: n };
      },
      talkToNpc: async () => {},
      giveToNpc: async (items: string[]) => {
        log.push(`give ${items.join(", ")}`);
        bags.Prize = 1;
      },
    });
    const zones: Record<string, number> = { freporte: 10, najena: 44 };
    f.iq.changeZone = async (zone: string) => void (f.combat.currentZone = zones[zone]);
    f.bot.quest({ members: ["Tagujazolu"], steps: [
      { zone: "freporte", buy: { merchant: "Gregor Nasin", items: ["Shirt", "Wine"], counts: { Shirt: 2, Wine: 1 } } },
      { zone: "najena", npc: "Taker", give: ["Shirt", "Shirt", "Wine"], expect: "Prize" },
    ] });
    await runToEnd(f);
    expect(f.bot.state.task).toMatchObject({ status: "done" });
    expect(log).toEqual(["buy 2 Shirt from Gregor Nasin in 10", "give Shirt, Shirt, Wine"]);
  } finally {
    vi.useRealTimers();
  }
});

test("a container on the cursor with every general slot taken sends the emptiest bag to the bank, and the bag comes back once a slot is free", async () => {
  vi.useFakeTimers();
  try {
    const f = await install([10, 20]);
    f.bot.config.leaderId = 1;
    handInPage(f, {}, { ok: true });
    f.bot.config.demand = { 1: 100 };
    type Row = { bag: number; slot: number; itemid: number; itemInstanceId: number; itemDetails: { Name: string; bagslots: number } };
    const bagWith = (slot: number, n: number): Row[] => [
      { bag: 0, slot, itemid: 900 + slot, itemInstanceId: 500 + slot, itemDetails: { Name: `Bag ${slot}`, bagslots: 8 } },
      ...Array.from({ length: n }, (_, k) => ({ bag: slot + 1, slot: k, itemid: 1, itemInstanceId: 1000 + slot * 10 + k, itemDetails: { Name: "Rock", bagslots: 0 } })),
    ];
    // Eight bags fill the general slots, and the one in slot 27 holds the fewest items.
    const inv: Row[] = [22, 23, 24, 25, 26, 27, 28, 29].flatMap((s) => bagWith(s, s === 27 ? 2 : 8));
    (f.me as unknown as { inventory: Row[] }).inventory = inv;
    const at = (bag: number, slot: number) => inv.find((r) => r.bag === bag && r.slot === slot);
    // Like the client, a move takes the bag's contents along and leaves an occupied target alone.
    Object.assign(f.sheet, {
      moveItemToSlot: async (from: { bag: number; slot: number }, to: { bag: number; slot: number }) => {
        const r = at(from.bag, from.slot);
        if (!r || at(to.bag, to.slot)) return;
        r.slot = to.slot;
        for (const c of inv) if (c.bag === from.slot + 1) c.bag = to.slot + 1;
      },
    });
    Object.assign(f.iq, {
      clientFn: (name: string) => () => {
        const held = at(0, 30);
        const general = [22, 23, 24, 25, 26, 27, 28, 29].find((s) => !at(0, s));
        if (name === "autoPlace" && held && general != null) held.slot = general;
      },
      placeCursor: async () => {
        const held = at(0, 30);
        const general = [22, 23, 24, 25, 26, 27, 28, 29].find((s) => !at(0, s));
        if (held && general != null) held.slot = general;
        return !at(0, 30);
      },
      bagSpace: () => ({ free: 5, capacity: 64, cursor: at(0, 30)?.itemDetails.Name ?? null }),
      carried: (item: string) => inv.filter((r) => !(r.bag === 0 && r.slot === 30) && r.itemDetails.Name === item).length,
      talkToNpc: async () => {},
      giveToNpc: async () => {
        inv.push({ bag: 0, slot: 30, itemid: 17323, itemInstanceId: 9000, itemDetails: { Name: "Soulcase", bagslots: 10 } });
      },
    });
    f.bot.quest({ members: ["Me"], steps: [{ zone: "freporte", npc: "Kargek Redblade", give: ["Rock"], expect: "Soulcase" }] });
    await runToEnd(f);
    expect(f.bot.state.task).toMatchObject({ status: "done" });
    expect(at(0, 2000)?.itemInstanceId).toBe(527);
    expect(inv.filter((r) => r.bag === 2001)).toHaveLength(2);
    expect(at(0, 27)?.itemDetails.Name).toBe("Soulcase");

    // While the container holds the slot the bag stays banked, and once it is used up the bag returns.
    await f.bot.tick();
    expect(at(0, 2000)?.itemInstanceId).toBe(527);
    inv.splice(inv.indexOf(at(0, 27)!), 1);
    const tick = f.bot.tick();
    for (let k = 0; k < 10; k++) {
      vi.advanceTimersByTime(500);
      await flush();
    }
    await tick;
    expect(at(0, 27)?.itemInstanceId).toBe(527);
    expect(inv.filter((r) => r.bag === 28)).toHaveLength(2);
  } finally {
    vi.useRealTimers();
  }
});

test("the reserve discards surplus without a price first, then sells surplus cheapest first, and never touches kept items", async () => {
  vi.useFakeTimers();
  try {
    const f = await install();
    type Row = { bag: number; slot: number; itemid: number; itemInstanceId: number; quantity: number; itemDetails: Record<string, unknown> };
    const item = (slot: number, itemid: number, Name: string, price: number, extra: object = {}): Row => ({ bag: 23, slot, itemid, itemInstanceId: 100 + slot, quantity: 1, itemDetails: { Name, price, nodrop: 1, norent: 1, bagslots: 0, itemtype: 0, ...extra } });
    const inv: Row[] = [
      item(0, 1, "Rusty Mace", 100),
      item(1, 2, "Fine Cloak", 500),
      item(2, 3, "Battle Plans", 0, { nodrop: 0 }),
      item(3, 4, "Power of Fire", 0, { nodrop: 0 }),
      item(4, 5, "Small Bronze Helm", 2700),
      item(5, 5, "Small Bronze Helm", 2700),
      item(6, 6, "Shaded Torch", 0, { norent: 0 }),
    ];
    (f.me as unknown as { inventory: Row[] }).inventory = inv;
    const at = (b: number, s: number) => inv.find((r) => r.bag === b && r.slot === s);
    const drop = (r?: Row) => r && inv.splice(inv.indexOf(r), 1);
    const acts: string[] = [];
    Object.assign(f.sheet, {
      moveItemToSlot: async (from: { bag: number; slot: number }, to: { bag: number; slot: number }) => {
        const r = at(from.bag, from.slot);
        if (r && !at(to.bag, to.slot)) Object.assign(r, to);
      },
      deleteItemOnCursor: () => {
        acts.push(`discard ${at(0, 30)?.itemDetails.Name}`);
        drop(at(0, 30));
      },
    });
    // Ten slots, so the reserve of 8 needs every item out but two.
    Object.assign(f.iq, {
      bagSpace: () => ({ free: 10 - inv.filter((r) => !(r.bag === 0 && r.slot === 30)).length, capacity: 10, cursor: (at(0, 30)?.itemDetails.Name as string) ?? null }),
      clientFn: (name: string) => (bag: number, slot: number) => {
        if (name !== "sell") return;
        acts.push(`sell ${at(bag, slot)?.itemDetails.Name}`);
        drop(at(bag, slot));
        return { success: true, data: { copperTotal: 1 } };
      },
    });
    // The coordinator's demand wants a quest piece, and the gear plan needs one helm copy for a move.
    Object.assign(f.bot.config, { autoBank: false, minFreeSlots: 8, targetFreeSlots: 8, demand: { 4: 1 }, gearKeepInstances: [104] });
    expect(f.bot.fates()).toMatchObject({ keep: [{ name: "Power of Fire" }, { name: "Small Bronze Helm", instanceId: 104 }], discard: [{ name: "Battle Plans" }, { name: "Shaded Torch" }] });
    // The account's demand keeps that many copies of an item it is short of, not more.
    Object.assign(f.bot.config, { gearKeepInstances: [], demand: { 4: 1, 5: 1 } });
    expect(f.bot.fates().keep.filter((k) => k.name === "Small Bronze Helm")).toHaveLength(1);
    Object.assign(f.bot.config, { gearKeepInstances: [104], demand: { 4: 1 } });
    const clean = async () => {
      const run = f.bot.cleanup();
      for (let k = 0; k < 30; k++) {
        vi.advanceTimersByTime(500);
        await flush();
      }
      await run;
    };
    // A pass that needs two slots takes the two that nothing buys.
    Object.assign(f.bot.config, { minFreeSlots: 6, targetFreeSlots: 5 });
    await clean();
    expect(acts).toEqual(["discard Battle Plans", "discard Shaded Torch"]);
    // A sale the server does not confirm leaves surplus behind, which is no reason for the kept-items alert.
    const page = f.iq as unknown as { clientFn: (name: string) => unknown };
    const sell = page.clientFn;
    page.clientFn = (name) => (name === "sell" ? () => ({ success: false, message: "Sale confirmation was interrupted." }) : sell(name));
    Object.assign(f.bot.config, { minFreeSlots: 8, targetFreeSlots: 8 });
    await clean();
    expect(f.bot.state.alerts.filter((a) => a.kind === "bags")).toEqual([]);
    page.clientFn = sell;
    await clean();
    expect(acts).toEqual(["discard Battle Plans", "discard Shaded Torch", "sell Rusty Mace", "sell Fine Cloak", "sell Small Bronze Helm"]);
    expect(inv.map((r) => r.itemInstanceId)).toEqual([103, 104]);
    // With only kept items left and the reserve still short, a party member takes the demanded copy,
    // and the gear plan's copy, which its move takes from the leader, stays.
    f.party.companions = [{ companionType: 2, characterId: 20, name: "Edroun", curHp: 100, maxHp: 100 }];
    const given: string[] = [];
    (f.iq as unknown as { giveItem: (item: string, id: number) => Promise<{ ok: boolean }> }).giveItem = async (item, id) => {
      given.push(`${item} to ${id}`);
      drop(inv.find((r) => r.itemDetails.Name === item));
      return { ok: true };
    };
    f.bot.config.minFreeSlots = 9;
    await f.bot.cleanup();
    expect(given).toEqual(["Power of Fire to 20"]);
    expect(inv.map((r) => r.itemInstanceId)).toEqual([104]);
    expect(f.bot.state.alerts.filter((a) => a.kind === "bags")).toEqual([]);
    // When what is left still leaves too little room, one alert lists it.
    f.bot.config.minFreeSlots = 10;
    await f.bot.cleanup();
    expect(f.bot.state.alerts.filter((a) => a.kind === "bags").map((a) => a.wake)).toEqual([true]);
  } finally {
    vi.useRealTimers();
  }
});

test("a discard the client has not taken off the cursor holds AutoLevel until the destroy goes through", async () => {
  vi.useFakeTimers();
  try {
    const f = await install();
    type Row = { bag: number; slot: number; itemid: number; itemInstanceId: number; quantity: number; itemDetails: Record<string, unknown> };
    const inv: Row[] = [{ bag: 23, slot: 0, itemid: 3, itemInstanceId: 103, quantity: 1, itemDetails: { Name: "Battle Plans", price: 0, nodrop: 0, norent: 1, bagslots: 0, itemtype: 11 } }];
    (f.me as unknown as { inventory: Row[] }).inventory = inv;
    const at = (b: number, s: number) => inv.find((r) => r.bag === b && r.slot === s);
    // The client refuses the destroy while the server has not confirmed the move to the cursor.
    let busy = true;
    Object.assign(f.sheet, {
      moveItemToSlot: async (from: { bag: number; slot: number }, to: { bag: number; slot: number }) => {
        const r = at(from.bag, from.slot);
        if (r && !at(to.bag, to.slot)) Object.assign(r, to);
      },
      deleteItemOnCursor: () => {
        const r = at(0, 30);
        if (r && !busy) inv.splice(inv.indexOf(r), 1);
      },
    });
    Object.assign(f.iq, { bagSpace: () => ({ free: 1 - inv.filter((r) => !(r.bag === 0 && r.slot === 30)).length, capacity: 1, cursor: (at(0, 30)?.itemDetails.Name as string) ?? null }) });
    Object.assign(f.bot.config, { autoBank: false, minFreeSlots: 1, targetFreeSlots: 1 });
    // AutoLevel went off under a hold, so nothing but a hold keeps it from starting at once.
    f.combat.isRunning = false;
    Object.assign(f.activity, { act: "idle", why: "held", since: Date.now() });
    const settle = async (p: Promise<unknown>) => {
      for (let k = 0; k < 40; k++) {
        vi.advanceTimersByTime(500);
        await flush();
      }
      await p;
    };
    await settle(f.bot.tick());
    expect(at(0, 30)?.itemDetails.Name).toBe("Battle Plans");
    expect(f.autoLevel.starts).toBe(0);
    // While the server has not confirmed the move, a pass leaves the cursor alone.
    const inventory = { busy: true };
    (f.iq.stores as Record<string, unknown>).inventory = { getState: () => inventory, subscribe: () => () => {} };
    busy = false;
    await settle(f.bot.tick());
    expect(at(0, 30)?.itemDetails.Name).toBe("Battle Plans");
    expect(f.autoLevel.starts).toBe(0);
    inventory.busy = false;
    await settle(f.bot.tick());
    expect(inv).toEqual([]);
    expect(f.autoLevel.starts).toBe(1);
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

test("client options are kept at the bot's values, a switch with its toggle and a number with its setter, and set ones are left alone", async () => {
  const f = await install();
  const flips: string[] = [];
  Object.assign(f.combat, {
    autoUpgradeEnabled: true,
    autoUpgradeCompanionsEnabled: false,
    toggleAutoUpgrade: () => (flips.push("self"), (f.combat as { autoUpgradeEnabled: boolean }).autoUpgradeEnabled = false),
    toggleAutoUpgradeCompanions: () => flips.push("companions"),
    frameRateLimit: 30,
    setFrameRateLimit: (n: number) => (flips.push(`fps ${n}`), (f.combat as { frameRateLimit: number }).frameRateLimit = n),
  });
  await f.bot.tick();
  await f.bot.tick();
  expect(flips).toEqual(["self", "fps 10"]);
  expect((f.combat as { autoUpgradeEnabled: boolean }).autoUpgradeEnabled).toBe(false);
});

test("a gear move with a merchant travels there, buys the item and gives it, a held item is pulled, and the active character's own is given without a pull", async () => {
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
      { item: "Fine Cloak", from: "Ugfeu", to: "Edroun", slot: "back" },
      // Carried by the active character, on which Inventory Search finds nothing to pull.
      { item: "Jagged Band", from: "Me", to: "Edroun", slot: "finger" },
    ] });
    await runToEnd(f);
    expect(f.moves[0]).toBe("permafrost");
    expect(log).toEqual(["buy Hand Drum from Fania Esruc", "give Hand Drum to 20", "pull Fine Cloak from Ugfeu", "give Fine Cloak to 20", "give Jagged Band to 20"]);
    expect(f.bot.state.task.result).toBe("3 of 3 moves");
  } finally {
    vi.useRealTimers();
  }
});

test("a move that has to be placed goes into the member's bags and into its slot with the member active", async () => {
  vi.useFakeTimers();
  try {
    // Imorymu on 2026-11-12: a give that equips lets the server choose the hand, and her whip went
    // to the off hand three times where the plan wanted the main hand.
    const f = await install([10, 20]);
    f.bot.config.leaderId = 1;
    const log: string[] = [];
    Object.assign(f.iq, {
      carried: () => 0,
      pullItem: async (item: string, { from }: { from: string }) => (log.push(`pull ${item} from ${from}`), { got: true, from, reply: "Transferred." }),
      giveItem: async (item: string, id: number, { equip }: { equip: boolean }) => (log.push(`give ${item} to ${id}${equip ? " equipped" : " into the bags"}`), { ok: true, lines: [] }),
      equipOwn: async (item: string, slot: number) => (log.push(`${f.sheet.characterProfile.name} wears ${item} in ${slot}`), { ok: true }),
    });
    f.bot.gear({ moves: [
      { item: "Revultant Whip", from: "Ugfeu", to: "Tagujazolu", slot: "primary", slotNum: 13, exact: true },
      { item: "Fine Cloak", from: "Ugfeu", to: "Edroun", slot: "back", slotNum: 8 },
      { item: "Kylong Hunting Knife", from: "Ugfeu", to: "Tagujazolu", slot: "secondary", slotNum: 14, exact: true },
    ] });
    await runToEnd(f);
    expect(log).toEqual([
      "pull Revultant Whip from Ugfeu",
      "give Revultant Whip to 10 into the bags",
      "pull Fine Cloak from Ugfeu",
      "give Fine Cloak to 20 equipped",
      "pull Kylong Hunting Knife from Ugfeu",
      "give Kylong Hunting Knife to 10 into the bags",
      "Tagujazolu wears Revultant Whip in 13",
      "Tagujazolu wears Kylong Hunting Knife in 14",
    ]);
    expect(f.bot.state.task).toMatchObject({ status: "done", result: "3 of 3 moves", moves: [{ placed: true }, { done: true }, { placed: true }] });
    // A receiver outside this tab's party cannot become active here, so the server places the item.
    f.party.companions = [];
    log.length = 0;
    f.sheet.characterProfile = { ...f.me };
    f.bot.gear({ moves: [{ item: "Revultant Whip", from: "Ugfeu", to: "Tagujazolu", slot: "primary", slotNum: 13, exact: true }] });
    await runToEnd(f);
    expect(log).toEqual(["pull Revultant Whip from Ugfeu", "give Revultant Whip to 10 equipped"]);
  } finally {
    vi.useRealTimers();
  }
});

test("a craft step rolls until its first success, pulling one input per attempt, and reports running out", async () => {
  vi.useFakeTimers();
  try {
    const f = await install([10, 20]);
    f.bot.config.leaderId = 1;
    const bags: Record<string, Record<string, number>> = {};
    const mine = () => (bags[f.sheet.characterProfile.name] ??= {});
    let stock = 5; // eyes elsewhere on the account
    let rolls: boolean[] = [];
    const crafts: number[] = [];
    Object.assign(f.iq, {
      carried: (item: string) => mine()[item] ?? 0,
      pullItem: async (item: string) => {
        if (stock < 1) return { got: false, reply: "No copies found." };
        stock--;
        mine()[item] = (mine()[item] ?? 0) + 1;
        return { got: true, from: "Embrogg", reply: "Transferred." };
      },
      // An attempt uses its eye up whether its roll succeeds or not.
      craftItem: async (_recipeId: number, opts: { quantity: number }) => {
        crafts.push(mine()["Fire Beetle Eye"]);
        mine()["Fire Beetle Eye"] -= 1;
        const ok = rolls.shift() ?? false;
        if (ok) mine()["Edible Goo"] = 1;
        return { attempted: opts.quantity, successes: ok ? 1 : 0, failures: ok ? 0 : 1, withdrawn: ok ? 1 : 0 };
      },
    });
    const goo = { zone: "freportw", craft: { recipeId: 1858, skillId: 60, quantity: 10, inputs: ["Fire Beetle Eye"], output: { item: "Edible Goo", id: 13498 } }, expect: "Edible Goo" };
    rolls = [false, true];
    f.bot.quest({ members: ["Tagujazolu"], name: "goo", steps: [goo] });
    await runToEnd(f);
    // Two attempts, each with one eye on hand, and the second eye pulled only after the first roll failed.
    expect(crafts).toEqual([1, 1]);
    expect(stock).toBe(3);
    expect(f.bot.state.task.status).toBe("done");

    // With every roll failing, the step ends when the account runs out of eyes, and says so.
    for (const b of Object.values(bags)) delete b["Edible Goo"];
    rolls = [];
    f.bot.quest({ members: ["Tagujazolu"], name: "goo-again", steps: [goo] });
    await runToEnd(f);
    expect(f.bot.state.task.status).toBe("failed");
    expect(f.bot.state.task.error).toMatch(/out of Fire Beetle Eye after 3 failed Edible Goo rolls/);
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

test("charm is held for Enchanters and Necromancers only, and a held preference is not set again", async () => {
  const f = await install();
  const ps = f.iq.stores.partySpells.getState() as unknown as { castingPreferences: Record<string, { charm?: boolean }>; setCastingPreferences: (k: string, p: object) => void };
  const sets: [string, object][] = [];
  Object.assign(ps, { castingPreferences: {}, setCastingPreferences: (k: string, p: object) => (sets.push([k, p]), (ps.castingPreferences[k] = { ...ps.castingPreferences[k], ...p })) });
  const cs = f.iq.stores.companions.getState() as unknown as { botCombatDataMap: Record<string, { class?: number }> };
  cs.botCombatDataMap["character-20"].class = 14;
  await f.bot.tick();
  expect(sets).toEqual([]);
  // Edroun is an Enchanter, Tagujazolu and the leader are neither, and a held preference is not set twice.
  f.bot.config.charm = true;
  await f.bot.tick();
  await f.bot.tick();
  expect(sets).toEqual([["character:20", { charm: true }]]);
});

test("long DoTs are left out per class except snares, and 0 clears the list", async () => {
  const f = await install();
  const ps = f.iq.stores.partySpells.getState() as unknown as { castingPreferences: Record<string, { excludedSpellIds?: number[] }>; setCastingPreferences: (k: string, p: object) => void };
  Object.assign(ps, { castingPreferences: {}, setCastingPreferences: (k: string, p: object) => (ps.castingPreferences[k] = { ...ps.castingPreferences[k], ...p }) });
  const cs = f.iq.stores.companions.getState() as unknown as { botCombatDataMap: Record<string, { class?: number }> };
  cs.botCombatDataMap["character-20"].class = 11;
  f.iq.classSpells = generated;
  f.bot.config.dotMaxTicks = 9;
  await f.bot.tick();
  const necro = ps.castingPreferences["character:20"]?.excludedSpellIds ?? [];
  // Disease Cloud (60 ticks) and Boil Blood (21) go, the snare Dooming Darkness (15) and Poison Bolt (7) stay.
  expect([necro.includes(340), necro.includes(451), necro.includes(452), necro.includes(348)]).toEqual([true, true, false, false]);
  f.bot.config.dotMaxTicks = 0;
  await f.bot.tick();
  expect(ps.castingPreferences["character:20"].excludedSpellIds).toEqual([]);
});
