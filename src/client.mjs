import { readFile } from "node:fs/promises";

const here = new URL(".", import.meta.url);

/**
 * Inject the bridge into a browser tab and return a thin handle.
 * `tab` needs `evaluate(expression | function, ...args)` that runs in the page.
 */
export async function attach(tab) {
  const [bridge, opcodes] = await Promise.all([
    readFile(new URL("bridge.js", here), "utf8"),
    readFile(new URL("../data/opcodes.json", here), "utf8").then(JSON.parse),
  ]);
  await tab.evaluate(bridge);
  await tab.evaluate((table) => window.iq.setOpcodeNames(table), opcodes);

  return {
    tab,
    status: () => tab.evaluate(() => window.iq.status()),
    /** Packets after `sinceSeq`, optionally filtered by an opcode-name regex source. */
    packets: (sinceSeq = 0, nameRe = null) => tab.evaluate((s, r) => window.iq.packets(s, r), sinceSeq, nameRe),
  };
}
