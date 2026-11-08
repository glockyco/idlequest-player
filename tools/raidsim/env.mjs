// Boots the client bundles in Bun and replaces what a fight cannot take from the host: time,
// randomness, the network and the 3D scene. Every replacement is made in this file.
import { setImmediate as hostImmediate } from "node:timers";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { resolveClient } from "./clients.mjs";

GlobalRegistrator.register({
  url: "https://idlequest.net/play",
  settings: { disableCSSFileLoading: true, handleDisabledFileLoadingAsSuccess: true },
});

// The client build to load: tools/raidsim.mjs chooses it (--client) and passes it to each fight
// process in RAIDSIM_CLIENT.
export const client = await resolveClient(process.env.RAIDSIM_CLIENT);
const BUNDLES = new RegExp(`(${Object.values(client.files).join("|").replace(/\./g, "\\.")})$`);

// The client modules export only part of what the raid code uses, so each module gets one extra
// export that evaluates a name in its own scope. This reads and assigns module-level bindings.
Bun.plugin({
  name: "raidsim-scope",
  setup(build) {
    build.onLoad({ filter: BUNDLES }, async (args) => ({
      contents: `${await Bun.file(args.path).text()}\n;export const __scope = (s) => eval(s);\n`,
      loader: "js",
    }));
  },
});

export const main = await import(`${client.dir}${client.files.main}`);
export const bq = await import(`${client.dir}${client.files.bq}`);
export const eng = await import(`${client.dir}${client.files.engine}`);

// Name -> value in a bundle's module scope.
export const inMain = (name) => main.__scope(name);
export const inBq = (name) => bq.__scope(name);
export const inEngine = (name) => eng.__scope(name);

// Seeded generator (mulberry32) behind Math.random.
export function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Virtual clock: Date.now, performance.now and the timer functions read and fire from one
// schedule that only advance() moves, so a fight runs as fast as the code does and gives the same
// result for the same seed.
export const clock = {
  now: 1_800_000_000_000,
  start: 1_800_000_000_000,
  timers: new Map(),
  nextId: 1,
};

function addTimer(fn, ms, repeat, args) {
  const id = clock.nextId++;
  const delay = Math.max(1, Number(ms) || 0);
  clock.timers.set(id, { id, fn, args, due: clock.now + delay, every: repeat ? delay : 0 });
  return id;
}

for (const target of new Set([globalThis, globalThis.window])) {
  if (!target) continue;
  target.setTimeout = (fn, ms, ...args) => addTimer(fn, ms, false, args);
  target.setInterval = (fn, ms, ...args) => addTimer(fn, ms, true, args);
  target.clearTimeout = target.clearInterval = (id) => void clock.timers.delete(id);
  target.requestAnimationFrame = (fn) => addTimer(() => fn(clock.now - clock.start), 16, false, []);
  target.cancelAnimationFrame = (id) => void clock.timers.delete(id);
}
Date.now = () => clock.now;
performance.now = () => clock.now - clock.start;

export const flush = () => new Promise((resolve) => hostImmediate(resolve));

// Fires due timers in order until `stop()` is true or `untilMs` of virtual time has passed.
// The microtask queue drains between timers because the client chains promises off them.
export async function advance(untilMs, stop = () => false) {
  const end = clock.now + untilMs;
  await flush();
  while (!stop()) {
    let next = null;
    for (const t of clock.timers.values()) if (!next || t.due < next.due || (t.due === next.due && t.id < next.id)) next = t;
    if (!next || next.due > end) {
      clock.now = end;
      return;
    }
    clock.now = next.due;
    if (next.every) next.due += next.every;
    else clock.timers.delete(next.id);
    try {
      next.fn(...next.args);
    } catch (e) {
      clock.errors.push(e);
    }
    await flush();
  }
}
clock.errors = [];

// Counts calls of module-level functions by wrapping their bindings. The wrapper forwards
// arguments, `this` and the result unchanged. Only `function` declarations can be rebound, so
// names declared with `const` come back in the returned list and are not counted.
export const callCounts = new Map();
export function countCalls(bundle, names) {
  const holder = { main, bq, engine: eng }[bundle];
  const skipped = [];
  for (const name of names) {
    holder.__scope(`globalThis.__wrapped = ${name}`);
    const original = globalThis.__wrapped;
    if (typeof original !== "function") throw new Error(`${bundle}:${name} is not a function`);
    const key = `${bundle}:${name}`;
    globalThis.__counted = function (...args) {
      callCounts.set(key, (callCounts.get(key) ?? 0) + 1);
      return original.apply(this, args);
    };
    try {
      holder.__scope(`${name} = globalThis.__counted`);
      callCounts.set(key, 0);
    } catch {
      skipped.push(name);
    }
  }
  delete globalThis.__counted;
  delete globalThis.__wrapped;
  return skipped;
}
