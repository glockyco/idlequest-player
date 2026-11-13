// The relay client (src/cdp.mjs) against a relay that records what it is sent.
import { afterEach, expect, spyOn, test } from "bun:test";
import { Relay } from "../src/cdp.mjs";

const GAME = { targetId: "T1", type: "page", url: "https://idlequest.net/play" };
let stop = async () => {};
afterEach(() => stop());

/** A relay with one game tab. Every attach gets a new session, and `sent` keeps each request. */
async function relayWith(sent: { method: string; sessionId?: string }[], { dead = new Set<string>() } = {}) {
  let sessions = 0;
  const server = Bun.serve({
    port: 0,
    fetch: (req, srv) => (srv.upgrade(req) ? undefined : new Response(null, { status: 400 })),
    websocket: {
      message(ws, raw) {
        const m = JSON.parse(String(raw));
        sent.push({ method: m.method, sessionId: m.sessionId });
        // A session in `dead` answers as Chrome's relay does after it let the tab go.
        if (m.sessionId && dead.has(m.sessionId)) return void ws.send(JSON.stringify({ id: m.id, error: { message: "Debugger is not attached to the tab with id: 1211053903." } }));
        const result = m.method === "Target.getTargets" ? { targetInfos: [GAME] } : m.method === "Target.attachToTarget" ? { sessionId: `S${++sessions}` } : m.method === "Runtime.evaluate" ? { result: { value: 1 } } : {};
        ws.send(JSON.stringify({ id: m.id, result }));
      },
    },
  });
  const relay = new Relay({ url: `ws://127.0.0.1:${server.port}/cdp` });
  await relay.start();
  stop = async () => {
    await relay.stop();
    server.stop(true);
  };
  return relay;
}

test("a game tab is focused in its session before the first expression runs in it, and not again within the minute", async () => {
  const sent: { method: string; sessionId?: string }[] = [];
  const relay = await relayWith(sent);
  await relay.evaluate("T1", "1");
  await relay.evaluate("T1", "1");
  const inSession = sent.filter((m) => m.sessionId === "S1").map((m) => m.method);
  expect(inSession).toEqual(["Emulation.setFocusEmulationEnabled", "Runtime.evaluate", "Runtime.evaluate"]);
});

test("a session the relay let go is attached anew on the next call", async () => {
  // Group 10's tab kept a dead session for seven hours on 2026-11-13.
  const sent: { method: string; sessionId?: string }[] = [];
  const dead = new Set<string>();
  const relay = await relayWith(sent, { dead });
  await relay.evaluate("T1", "1");
  dead.add("S1");
  await expect(relay.evaluate("T1", "1")).rejects.toThrow(/not attached/);
  expect(await relay.evaluate("T1", "1")).toBe(1);
  expect(sent.filter((m) => m.method === "Target.attachToTarget")).toHaveLength(2);
  expect(sent.filter((m) => m.sessionId === "S2").map((m) => m.method)).toEqual(["Emulation.setFocusEmulationEnabled", "Runtime.evaluate"]);
});

test("initialization failures retain their reason and back off without reaching connected", async () => {
  const timers: { ms: number; run: () => void }[] = [];
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(((run: () => void, ms: number) => {
    const entry = { run, ms };
    timers.push(entry);
    return entry;
  }) as unknown as typeof setTimeout);
  const clear = spyOn(globalThis, "clearTimeout").mockImplementation(() => {});
  const OriginalWebSocket = globalThis.WebSocket;
  class RefusingSocket {
    static OPEN = 1;
    readyState = 1;
    onopen?: () => void;
    onclose?: () => void;
    onmessage?: (m: { data: string }) => void;
    constructor() { queueMicrotask(() => this.onopen?.()); }
    send(raw: string) {
      const m = JSON.parse(raw);
      queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ id: m.id, error: { message: "discovery refused" } }) }));
    }
    close() {
      this.readyState = 3;
      queueMicrotask(() => this.onclose?.());
    }
  }
  // The fake supplies only the socket surface this client uses.
  globalThis.WebSocket = RefusingSocket as unknown as typeof WebSocket;
  const relay = new Relay();
  const reasons: string[] = [];
  relay.on("disconnected", (why) => reasons.push(why));
  const started = relay.start();
  try {
    for (let k = 0; k < 20; k++) await Promise.resolve();
    expect(reasons[0]).toContain("discovery refused");
    expect(timers.filter((t) => t.ms === 1000)).toHaveLength(1);
    timers.find((t) => t.ms === 1000)!.run();
    for (let k = 0; k < 20; k++) await Promise.resolve();
    expect(timers.filter((t) => t.ms === 2000)).toHaveLength(1);
  } finally {
    const stopped = relay.stop();
    timers.find((t) => t.ms === 2000)?.run();
    for (let k = 0; k < 50; k++) {
      timers.filter((t) => t.ms === 100).at(-1)?.run();
      await Promise.resolve();
    }
    await Promise.all([started, stopped]);
    globalThis.WebSocket = OriginalWebSocket;
    timer.mockRestore();
    clear.mockRestore();
  }
});
