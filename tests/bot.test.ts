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
  config: { upkeep: boolean; partyIds: number[]; routeStuckSec: number; readyStuckSec: number };
  state: { alerts: Alert[] };
  tick(): Promise<void>;
  surplus(): { name: string }[];
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
  const autoLevel = { stops: 0, starts: 0 };
  const events: PageEvent[] = [];
  const seqs = { event: 0 };
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
    kills: [],
    mods: {},
    guard: { phase: "watching" },
    socket: { isConnected: true },
    bagSpace: () => ({ free: 30, capacity: 58, cursor: null }),
    stores: {
      character: store({ characterProfile: me }),
      companions: store({
        companions: [tank],
        requestAccountCharacterAvailability: () => {},
        controlAccountCharacter: (id: number) => recruited.push(id),
      }),
      combat: store({
        isRunning: true,
        isZoneLoading: false,
        currentZone: 58,
        noAutoSellBagInstanceIds: [],
        setIsRunning: (on: boolean) => { if (!on) autoLevel.stops++; },
        startAutoLevel: () => autoLevel.starts++,
      }),
      screen: store({ currentScreen: "game" }),
      staticData: store({ zones: [] }),
      skills: store({ inCombat: false }),
      spellbook: store({ scribedSpells: [], memorizedSpells: [] }),
    },
  };
  eval(await Bun.file(new URL("../src/bot.js", import.meta.url)).text());
  const bot = g.iqBot;
  if (!bot) throw new Error("bot.js did not install window.iqBot");
  clearInterval(bot.timerId);
  bot.config.upkeep = false;
  bot.config.partyIds = partyIds;
  await bot.tick(); // the first tick only sets the event cursor
  const say = (text: string, type = "SYSTEM") => events.push({ ses: 1, seq: ++seqs.event, t: Date.now(), type, text });
  return { bot, events, say, recruited, autoLevel, me, tank };
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
