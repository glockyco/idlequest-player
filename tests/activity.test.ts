// The bridge's activity label rules (`ACTIVITY_RULES` in src/bridge.js), evaluated from its source.
import { expect, test } from "bun:test";

interface Stop {
  t: number;
  cause: string;
}
interface View {
  loadFailed: boolean;
  dead: boolean;
  zoneLoading: boolean;
  escaping: boolean;
  inCombat: boolean;
  fightQuietMs: number;
  stillMs?: number;
  raid: boolean;
  hidden: boolean;
  pause: string | null;
  trip: string | null;
  runtime: { attempt: string | null; buffPhase: boolean; retrying: boolean; pendingLoot: number; waitingTargets: boolean } | null;
  running: boolean;
  partyFull: boolean;
  sinceKillMs: number;
  ranAt: number;
  stop: Stop | null;
  heldAt: number;
}
interface Rules {
  stopCause(e: { type: string; text: string }): string | null;
  label(v: View): [string, string?];
}

const src = await Bun.file(new URL("../src/bridge.js", import.meta.url)).text();
const block = /\/\/ BEGIN ACTIVITY_RULES\n([\s\S]*?)\n\s*\/\/ END ACTIVITY_RULES/.exec(src)?.[1];
if (!block) throw new Error("src/bridge.js has no ACTIVITY_RULES block");
const rules: Rules = new Function(`${block}\nreturn ACTIVITY_RULES;`)();

const rest = { attempt: null, buffPhase: false, retrying: false, pendingLoot: 0, waitingTargets: false };
// A page at rest: AutoLevel on, the party full, nothing pending and no kill lately.
const view = (over: Partial<View> = {}): View => ({ loadFailed: false, dead: false, zoneLoading: false, escaping: false, inCombat: false, fightQuietMs: 0, raid: false, hidden: false, pause: null, trip: null, runtime: rest, running: true, partyFull: true, sinceKillMs: 60000, ranAt: 0, stop: null, heldAt: 0, ...over });
const off = (ranAt: number, stop: Stop | null, heldAt: number) => rules.label(view({ running: false, ranAt, stop, heldAt }))[1];

test("AutoLevel off takes the cause of the latest evidence since it last ran", () => {
  // A client line before AutoLevel last ran explains nothing.
  expect(off(100, { t: 50, cause: "clientPause" }, 0)).toBe("off");
  expect(off(100, { t: 150, cause: "clientPause" }, 0)).toBe("clientPause");
  // The bot's hold after the line takes over, and a line after the hold takes over again.
  expect(off(100, { t: 150, cause: "contested" }, 200)).toBe("held");
  expect(off(100, { t: 250, cause: "noEnemies" }, 200)).toBe("noEnemies");
  // A hold that ended before AutoLevel ran again is no reason either.
  expect(off(300, null, 200)).toBe("off");
  expect(off(100, null, 200)).toBe("held");
});

test("only the client's own system lines stop AutoLevel", () => {
  expect(rules.stopCause({ type: "SYSTEM_ERROR", text: "AutoLevel paused: The server has not confirmed combat. Check your connection, then try again." })).toBe("clientPause");
  // A pause that asks for a camp and a new entry has a cure of its own.
  expect(rules.stopCause({ type: "SYSTEM_ERROR", text: "AutoLevel paused: a spell's server result is unconfirmed. Camp and re-enter your character, or reload, before trying again." })).toBe("clientRejoin");
  expect(rules.stopCause({ type: "SYSTEM", text: "A gnoll pup is engaged by another player. Looking for another target." })).toBe("contested");
  expect(rules.stopCause({ type: "SYSTEM", text: "No available enemies found in this zone." })).toBe("noEnemies");
  // The bot's log and a player's shout that quote such a line are not the client's.
  expect(rules.stopCause({ type: "bot", text: "AutoLevel paused: copied into a remedy line" })).toBeNull();
  expect(rules.stopCause({ type: "SHOUT", text: "No available enemies found in this zone." })).toBeNull();
});

test("a failed load, a missing runtime and the waits after a kill get their own causes", () => {
  // Nothing plays while the window is open, so it comes before every other state.
  expect(rules.label(view({ loadFailed: true, dead: true, zoneLoading: true }))).toEqual(["idle", "loadFailed"]);
  expect(rules.label(view({ runtime: null }))).toEqual(["idle", "unknown"]);
  // The client's 5 s pause after a kill comes first, then its wait for the loot.
  expect(rules.label(view({ sinceKillMs: 3000, runtime: { ...rest, pendingLoot: 1 } }))).toEqual(["idle", "afterKill"]);
  expect(rules.label(view({ sinceKillMs: 8000, runtime: { ...rest, pendingLoot: 1 } }))).toEqual(["idle", "lootSettle"]);
  // A party below full would wait for its recovery anyway, so the loot costs nothing then.
  expect(rules.label(view({ partyFull: false, sinceKillMs: 8000, runtime: { ...rest, pendingLoot: 1 } }))).toEqual(["recover"]);
  expect(rules.label(view({ runtime: { ...rest, waitingTargets: true } }))).toEqual(["idle", "crowded"]);
  expect(rules.label(view())).toEqual(["idle", "noTarget"]);
});

test("an approach that has not moved the party for a minute is stuck", () => {
  // Group 1 stood 30 min at one spot in Karnor's Castle on 2026-11-13, approaching a drolvarg sentry.
  const walking = { runtime: { ...rest, attempt: "approaching" } };
  expect(rules.label(view({ ...walking, stillMs: 20000 }))).toEqual(["approach"]);
  expect(rules.label(view({ ...walking, stillMs: 61000 }))).toEqual(["idle", "stuckApproach"]);
  // At the target with Auto Attack off is a cause of its own, however long it stands.
  expect(rules.label(view({ runtime: { ...rest, attempt: "waiting-to-attack" }, stillMs: 61000 }))).toEqual(["idle", "waitAttack"]);
});

test("a fight without a combat line for 45 s is dead, except in a raid and on a hidden page", () => {
  expect(rules.label(view({ inCombat: true, fightQuietMs: 29000 }))).toEqual(["fight"]);
  // A task's pause does not hide it, because the task's stop waits for this fight.
  expect(rules.label(view({ inCombat: true, fightQuietMs: 46000, pause: "task raid: stop", running: false }))).toEqual(["idle", "deadFight"]);
  expect(rules.label(view({ inCombat: true, fightQuietMs: 46000, raid: true }))).toEqual(["fight"]);
  expect(rules.label(view({ inCombat: true, fightQuietMs: 46000, hidden: true }))).toEqual(["fight"]);
});
