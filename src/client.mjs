import { readFile } from "node:fs/promises";

const here = new URL(".", import.meta.url);

const METHODS = ["status", "inventory", "chatTail", "scribeAndMemorize", "talk", "recruitDefaultParty", "packets"];

/**
 * Inject the bridge into a browser tab and return a handle with one async method per bridge call.
 * `tab` needs `evaluate(expression | function, ...args)` that runs in the page.
 */
export async function attach(tab) {
  const [bridge, opcodes] = await Promise.all([
    readFile(new URL("bridge.js", here), "utf8"),
    readFile(new URL("../data/opcodes.json", here), "utf8").then(JSON.parse),
  ]);
  await tab.evaluate(bridge);
  await tab.evaluate((table) => window.iq.setOpcodeNames(table), opcodes);

  const handle = {
    tab,
    /** Kill log built from server combat messages: [{t, enemy, xp}]. */
    kills: () => tab.evaluate(() => window.iq.kills),
  };
  for (const name of METHODS) {
    handle[name] = (...args) => tab.evaluate((n, a) => window.iq[n](...a), name, args);
  }
  return handle;
}
