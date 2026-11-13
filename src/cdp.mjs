// Read-only client for the browser relay's browser-level CDP endpoint.
//
// The relay lists every tab of the browser, including ones that have nothing to do with the game.
// This client attaches only to pages whose URL starts with GAME_URL_PREFIX, re-checks that before
// every attach and detaches at once from any other page the relay attaches on its own. It never
// opens, navigates, closes or activates a tab. Callers can only `evaluate` an expression in a game
// tab. It asks the browser to treat every game tab it evaluates in as focused, because the browser
// throttles the timers of a hidden tab and the client simulates combat in the page, so fights in a
// hidden tab stop ending.
import { EventEmitter } from "node:events";

export const RELAY_URL = "ws://127.0.0.1:9224/cdp";
export const GAME_URL_PREFIX = "https://idlequest.net/play";

export const isGameTarget = (info) => info?.type === "page" && typeof info.url === "string" && info.url.startsWith(GAME_URL_PREFIX);

/** The page a tab is sent to for a new process (`Relay.renew`): it returns to the game after `backSec`. */
export const renewPage = (backSec = 3) => `<!doctype html><meta http-equiv="refresh" content="${backSec};url=${GAME_URL_PREFIX}"><title>IdleQuest</title>Back to the game in a moment.`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** How long a tab's focus emulation counts as set before it is asked for again. */
const FOCUS_MS = 60000;

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
  #focused = new Map(); // targetId -> { sessionId, t } of the last focus emulation request
  #stopped = false;
  #loop = null;
  #pollTimer = null;
  #listed = false; // whether this connection has read the relay's tabs once

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
    for (let i = 0; i < 50 && !(this.connected && this.#listed); i++) await sleep(100);
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
      // Why this client closed the socket itself, for the "disconnected" event.
      let why = null;
      ws.onopen = async () => {
        opened = true;
        this.#ws = ws;
        try {
          await this.#send("Target.setDiscoverTargets", { discover: true });
          await this.#refreshTabs();
          this.#listed = true;
          this.emit("connected");
          clearInterval(this.#pollTimer);
          // A relay that stopped answering without closing the socket looks like a dead tab list,
          // so the socket is closed and opened again, after two lists in a row that did not come:
          // one late answer on a loaded machine is no dead relay, and a close ends every request
          // that is open. On 2026-11-12 the connection closed and was back a second later three
          // times in five minutes, each ending the coordinator's pass, with the cause not logged.
          let missed = 0;
          this.#pollTimer = setInterval(() => {
            this.#refreshTabs().then(
              () => (missed = 0),
              (e) => {
                if (++missed < 2) return;
                why = `the relay gave no tab list twice in a row (${e.message})`;
                ws.close();
              },
            );
          }, this.pollMs);
        } catch {
          ws.close();
        }
      };
      ws.onmessage = (m) => this.#onMessage(m.data);
      ws.onerror = () => {};
      ws.onclose = () => {
        clearInterval(this.#pollTimer);
        this.#listed = false;
        if (this.#ws === ws) this.#ws = null;
        for (const [id, p] of this.#pending) {
          clearTimeout(p.timer);
          p.reject(new Error("relay connection closed"));
          this.#pending.delete(id);
        }
        const wasUp = opened;
        this.#sessions.clear();
        this.#attaching.clear();
        if (wasUp) this.emit("disconnected", why ?? "the relay closed the connection");
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
    }).catch((e) => {
      // A session the relay dropped answers with an error, and the next call attaches anew.
      // Chrome's relay says "Debugger is not attached to the tab with id: ...": group 10's tab,
      // renewed at 00:05 on 2026-11-13, kept such a dead session for seven hours, because only
      // an evaluate dropped one and only for "session", "not found" or "closed".
      if (sessionId && /session|not found|closed|not attached|detached/i.test(e?.message ?? "")) {
        for (const [targetId, s] of this.#sessions) if (s === sessionId) this.#sessions.delete(targetId);
      }
      throw e;
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
      default:
        // A session's own events, for a caller that turned their domain on (`stacks`).
        if (msg.sessionId && msg.method) this.emit("session-event", { sessionId: msg.sessionId, method: msg.method, params });
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
   * Ask the browser to treat the tab as focused and visible. Asked again for a new session and
   * every minute, because nothing reports when the browser drops the setting.
   */
  async #keepFocused(targetId, sessionId) {
    const last = this.#focused.get(targetId);
    const now = Date.now();
    if (last?.sessionId === sessionId && now - last.t < FOCUS_MS) return;
    this.#focused.set(targetId, { sessionId, t: now });
    await this.#send("Emulation.setFocusEmulationEnabled", { enabled: true }, sessionId).catch(() => this.#focused.delete(targetId));
  }

  /**
   * Evaluate an expression in a game tab and return its value (`returnByValue`, promises awaited).
   * Throws when the tab is unknown, the page throws or the call takes longer than `timeout` ms.
   */
  async evaluate(targetId, expression, { timeout = 10000 } = {}) {
    const info = this.#tabs.get(targetId);
    if (!isGameTarget(info)) throw new Error(`not a game tab: ${targetId}`);
    const sessionId = await this.#sessionFor(targetId);
    await this.#keepFocused(targetId, sessionId);
    const res = await this.#send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, timeout }, sessionId, timeout + 1000);
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text ?? "evaluate failed");
    return res.result?.value;
  }

  /** A JPEG of a game tab as it shows now, as a Buffer, for the diary's pictures of kills and milestones. */
  async screenshot(targetId, { quality = 80, timeout = 15000 } = {}) {
    const info = this.#tabs.get(targetId);
    if (!isGameTarget(info)) throw new Error(`not a game tab: ${targetId}`);
    const sessionId = await this.#sessionFor(targetId);
    const res = await this.#send("Page.captureScreenshot", { format: "jpeg", quality }, sessionId, timeout);
    return Buffer.from(res.data, "base64");
  }

  /**
   * Give a game tab a new renderer process. A reload keeps the process, and one that has played
   * for hours holds 2 to 4.5 GB that no reload gives back, while a new one starts under 1 GB. The
   * browser ends a tab's process when the tab goes to another site and starts one when it comes
   * back, so the tab is sent to `via`, a page that returns to the game by itself (`renewPage`),
   * with no second command that could fail and leave it there. A `data:` page is refused, and
   * `about:blank` cannot return on its own. The page comes back at the login form with the
   * tab's session storage, as after a reload.
   */
  async renew(targetId, via) {
    const info = this.#tabs.get(targetId);
    if (!isGameTarget(info)) throw new Error(`not a game tab: ${targetId}`);
    const sessionId = await this.#sessionFor(targetId);
    const r = await this.#send("Page.navigate", { url: via }, sessionId);
    if (r?.errorText) throw new Error(`the tab did not leave for ${via}: ${r.errorText}`);
    // The tab leaves the game for a moment, so this session ends here and the next call attaches anew.
    this.#sessions.delete(targetId);
    await this.#send("Target.detachFromTarget", { sessionId }, undefined, 3000).catch(() => {});
  }

  /**
   * How busy a game tab's main thread is over `ms`: the seconds it spent in tasks and in script,
   * from the Performance domain's counters, with its JavaScript heap. The relay passes no Profiler
   * domain, so this and `stacks` are what shows a page's processor time.
   */
  async load(targetId, ms) {
    const info = this.#tabs.get(targetId);
    if (!isGameTarget(info)) throw new Error(`not a game tab: ${targetId}`);
    const sessionId = await this.#sessionFor(targetId);
    const read = async () => Object.fromEntries((await this.#send("Performance.getMetrics", {}, sessionId)).metrics.map((m) => [m.name, m.value]));
    await this.#send("Performance.enable", {}, sessionId);
    try {
      const a = await read();
      await sleep(ms);
      const b = await read();
      return { sec: b.Timestamp - a.Timestamp, taskSec: b.TaskDuration - a.TaskDuration, scriptSec: b.ScriptDuration - a.ScriptDuration, layoutSec: b.LayoutDuration - a.LayoutDuration + b.RecalcStyleDuration - a.RecalcStyleDuration, heapMB: Math.round(b.JSHeapUsedSize / 1048576) };
    } finally {
      await this.#send("Performance.disable", {}, sessionId, 5000).catch(() => {});
    }
  }

  /**
   * `count` call stacks of a game tab's JavaScript, innermost frame first, each
   * `[{ fn, url, line, col }]` with the place the function starts. The page is paused through
   * the Debugger domain at a random moment, its stack is read and it runs on, which holds it a
   * few milliseconds a sample. A pause lands in the next statement that runs, so an idle page
   * shows the start of its next task.
   */
  async stacks(targetId, count, { everyMs = 100 } = {}) {
    const info = this.#tabs.get(targetId);
    if (!isGameTarget(info)) throw new Error(`not a game tab: ${targetId}`);
    const sessionId = await this.#sessionFor(targetId);
    let paused = null;
    const onEvent = (e) => e.sessionId === sessionId && e.method === "Debugger.paused" && paused?.(e.params);
    this.on("session-event", onEvent);
    const out = [];
    await this.#send("Debugger.enable", {}, sessionId);
    try {
      for (let k = 0; k < count; k++) {
        await sleep(everyMs * (0.4 + 1.2 * Math.random()));
        const stop = new Promise((resolve) => (paused = resolve));
        await this.#send("Debugger.pause", {}, sessionId);
        const p = await Promise.race([stop, sleep(3000).then(() => null)]);
        if (!p) continue;
        out.push(p.callFrames.map((f) => ({ fn: f.functionName || "(anonymous)", url: f.url, line: (f.functionLocation ?? f.location).lineNumber, col: (f.functionLocation ?? f.location).columnNumber })));
        await this.#send("Debugger.resume", {}, sessionId);
      }
    } finally {
      this.off("session-event", onEvent);
      await this.#send("Debugger.resume", {}, sessionId, 3000).catch(() => {});
      await this.#send("Debugger.disable", {}, sessionId, 5000).catch(() => {});
    }
    return out;
  }
}
