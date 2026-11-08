// Read-only client for the browser relay's browser-level CDP endpoint.
//
// The relay lists every tab of the browser, including ones that have nothing to do with the game.
// This client attaches only to pages whose URL starts with GAME_URL_PREFIX, re-checks that before
// every attach and detaches at once from any other page the relay attaches on its own. It never
// opens, navigates, closes or activates a tab. Callers can only `evaluate` an expression in a game
// tab.
import { EventEmitter } from "node:events";

export const RELAY_URL = "ws://127.0.0.1:9224/cdp";
export const GAME_URL_PREFIX = "https://idlequest.net/play";

export const isGameTarget = (info) => info?.type === "page" && typeof info.url === "string" && info.url.startsWith(GAME_URL_PREFIX);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Events: `connected`, `disconnected`, `tab-added` (info), `tab-updated` (info), `tab-removed`
 * (info), `attached` ({ targetId, url, sessionId }), `detached` ({ targetId }), `violation`
 * ({ targetId, url }) for a non-game page that the relay attached without being asked.
 */
export class Relay extends EventEmitter {
  #ws = null;
  #nextId = 0;
  #pending = new Map(); // id -> { resolve, reject, timer }
  #sessions = new Map(); // targetId -> sessionId
  #attaching = new Map(); // targetId -> Promise<sessionId>
  #tabs = new Map(); // targetId -> target info of game pages
  #stopped = false;
  #loop = null;
  #pollTimer = null;

  constructor({ url = RELAY_URL, pollMs = 10000 } = {}) {
    super();
    this.url = url;
    this.pollMs = pollMs;
  }

  get connected() {
    return this.#ws?.readyState === WebSocket.OPEN;
  }

  /** Game tabs the relay lists right now: Map of targetId to target info. */
  tabs() {
    return this.#tabs;
  }

  /** Start connecting and keep the connection up until `stop`. Resolves after the first attempt. */
  async start() {
    this.#stopped = false;
    this.#loop = this.#run();
    // Give the first connection a moment so the caller's first cycle sees the tabs.
    for (let i = 0; i < 50 && !this.connected; i++) await sleep(100);
  }

  async stop() {
    this.#stopped = true;
    clearInterval(this.#pollTimer);
    const detaches = [...this.#sessions.values()].map((sessionId) => this.#send("Target.detachFromTarget", { sessionId }, undefined, 2000).catch(() => {}));
    await Promise.all(detaches);
    this.#sessions.clear();
    try {
      this.#ws?.close();
    } catch {
      /* already closed */
    }
    await this.#loop;
  }

  async #run() {
    let delay = 1000;
    while (!this.#stopped) {
      try {
        await this.#connectOnce();
        delay = 1000;
      } catch {
        /* relay down or restarting: retry */
      }
      if (this.#stopped) break;
      await sleep(delay);
      delay = Math.min(delay * 2, 10000);
    }
  }

  #connectOnce() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      let opened = false;
      ws.onopen = async () => {
        opened = true;
        this.#ws = ws;
        try {
          await this.#send("Target.setDiscoverTargets", { discover: true });
          await this.#refreshTabs();
          this.emit("connected");
          clearInterval(this.#pollTimer);
          this.#pollTimer = setInterval(() => {
            // A relay that stopped answering without closing the socket looks like a dead tab list.
            this.#refreshTabs().catch(() => ws.close());
          }, this.pollMs);
        } catch {
          ws.close();
        }
      };
      ws.onmessage = (m) => this.#onMessage(m.data);
      ws.onerror = () => {};
      ws.onclose = () => {
        clearInterval(this.#pollTimer);
        if (this.#ws === ws) this.#ws = null;
        for (const [id, p] of this.#pending) {
          clearTimeout(p.timer);
          p.reject(new Error("relay connection closed"));
          this.#pending.delete(id);
        }
        const wasUp = opened;
        this.#sessions.clear();
        this.#attaching.clear();
        if (wasUp) this.emit("disconnected");
        if (opened) resolve();
        else reject(new Error("relay unreachable"));
      };
    });
  }

  #send(method, params = {}, sessionId, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      if (this.#ws?.readyState !== WebSocket.OPEN) return reject(new Error("relay not connected"));
      const id = ++this.#nextId;
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      this.#ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  #onMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.id != null) {
      const p = this.#pending.get(msg.id);
      if (!p) return;
      this.#pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
      else p.resolve(msg.result);
      return;
    }
    const params = msg.params ?? {};
    switch (msg.method) {
      case "Target.targetCreated":
      case "Target.targetInfoChanged":
        this.#seeTarget(params.targetInfo);
        break;
      case "Target.targetDestroyed":
        this.#dropTab(params.targetId);
        break;
      case "Target.attachedToTarget": {
        const info = params.targetInfo;
        // Only attaches this client asked for are expected. Anything else on a non-game page is let go.
        if (info && !isGameTarget(info) && params.sessionId) {
          this.emit("violation", { targetId: info.targetId, url: info.url });
          this.#send("Target.detachFromTarget", { sessionId: params.sessionId }).catch(() => {});
        }
        break;
      }
      case "Target.detachedFromTarget":
        for (const [targetId, sessionId] of this.#sessions) {
          if (sessionId === params.sessionId) {
            this.#sessions.delete(targetId);
            this.emit("detached", { targetId });
          }
        }
        break;
    }
  }

  #seeTarget(info) {
    if (!info?.targetId) return;
    const known = this.#tabs.has(info.targetId);
    if (isGameTarget(info)) {
      this.#tabs.set(info.targetId, info);
      this.emit(known ? "tab-updated" : "tab-added", info);
    } else if (known) {
      // The tab navigated away from the game.
      this.#dropTab(info.targetId);
    }
  }

  #dropTab(targetId) {
    const info = this.#tabs.get(targetId);
    this.#sessions.delete(targetId);
    this.#attaching.delete(targetId);
    if (info) {
      this.#tabs.delete(targetId);
      this.emit("tab-removed", info);
    }
  }

  async #refreshTabs() {
    const { targetInfos } = await this.#send("Target.getTargets", {}, undefined, 5000);
    const seen = new Set();
    for (const info of targetInfos ?? []) {
      if (isGameTarget(info)) {
        seen.add(info.targetId);
        this.#seeTarget(info);
      }
    }
    for (const targetId of [...this.#tabs.keys()]) if (!seen.has(targetId)) this.#dropTab(targetId);
  }

  async #sessionFor(targetId) {
    const existing = this.#sessions.get(targetId);
    if (existing) return existing;
    const pending = this.#attaching.get(targetId);
    if (pending) return pending;
    const info = this.#tabs.get(targetId);
    if (!isGameTarget(info)) throw new Error(`refusing to attach to ${targetId}: not a game tab`);
    const p = (async () => {
      const { sessionId } = await this.#send("Target.attachToTarget", { targetId, flatten: true });
      this.#sessions.set(targetId, sessionId);
      this.emit("attached", { targetId, url: info.url, sessionId });
      return sessionId;
    })().finally(() => this.#attaching.delete(targetId));
    this.#attaching.set(targetId, p);
    return p;
  }

  /**
   * Evaluate an expression in a game tab and return its value (`returnByValue`, promises awaited).
   * Throws when the tab is unknown, the page throws or the call takes longer than `timeout` ms.
   */
  async evaluate(targetId, expression, { timeout = 10000 } = {}) {
    const info = this.#tabs.get(targetId);
    if (!isGameTarget(info)) throw new Error(`not a game tab: ${targetId}`);
    const sessionId = await this.#sessionFor(targetId);
    let res;
    try {
      res = await this.#send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, timeout }, sessionId, timeout + 1000);
    } catch (e) {
      // A session the relay dropped answers with an error. Attach again on the next call.
      if (/session|not found|closed/i.test(e.message)) this.#sessions.delete(targetId);
      throw e;
    }
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text ?? "evaluate failed");
    return res.result?.value;
  }
}
