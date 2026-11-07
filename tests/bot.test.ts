// Runs src/bot.js against a fake game page. Run with `bun test`.
import { expect, test } from "bun:test";

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
  config: { upkeep: boolean };
  state: { alerts: Alert[] };
  tick(): Promise<void>;
}
interface FakeGlobals {
  localStorage: { getItem(): null; setItem(): void };
  window: unknown;
  iq: unknown;
  iqBot?: Bot;
}

const store = (state: object) => ({ getState: () => state });

async function install() {
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
      character: store({ characterProfile: { id: 1, name: "Me", level: 14, inventory: [], experienceProgress: { current: 1 } } }),
      companions: store({ companions: [{ name: "Tagujazolu", companionType: 2 }] }),
      combat: store({ isRunning: true, isZoneLoading: false, currentZone: 58, noAutoSellBagInstanceIds: [] }),
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
  await bot.tick(); // the first tick only sets the event cursor
  const say = (text: string, type = "SYSTEM") => events.push({ ses: 1, seq: ++seqs.event, t: Date.now(), type, text });
  return { bot, events, say };
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
