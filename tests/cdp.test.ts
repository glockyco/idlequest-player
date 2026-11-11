// The relay client (src/cdp.mjs) against a relay that records what it is sent.
import { afterEach, expect, test } from "bun:test";
import { Relay } from "../src/cdp.mjs";

const GAME = { targetId: "T1", type: "page", url: "https://idlequest.net/play" };
let stop = async () => {};
afterEach(() => stop());

/** A relay with one game tab. Every attach gets a new session, and `sent` keeps each request. */
async function relayWith(sent: { method: string; sessionId?: string }[]) {
  let sessions = 0;
  const server = Bun.serve({
    port: 0,
    fetch: (req, srv) => (srv.upgrade(req) ? undefined : new Response(null, { status: 400 })),
    websocket: {
      message(ws, raw) {
        const m = JSON.parse(String(raw));
        sent.push({ method: m.method, sessionId: m.sessionId });
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
