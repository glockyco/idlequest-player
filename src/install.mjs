// What a game tab needs to play: the bridge, its tables and the bot, and the stored login. The SDK
// (`attach` in src/client.mjs) and the collector's tab recovery (tools/iqd.mjs) both install
// through these expressions, so a tab comes back the same way whoever restores it. Every
// expression is a plain string, because the relay evaluates only strings.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";

const here = new URL(".", import.meta.url);

/**
 * The expressions that install the bridge, give it the opcode names and the tables the bot reads
 * (the client's per-class spell table, the quest turn-in items, the band rotations), and install
 * the bot, in that order. The bot keeps its settings in the tab's sessionStorage, so a reload in
 * the same tab gets its leader, party and rotation back. The last expression stamps the page with
 * `codeVersion`, so the collector can tell a tab that runs older code.
 */
export async function installExpressions() {
  const [bridge, bot, opcodes, classSpells, questItems, bandRotations] = await Promise.all([
    readFile(new URL("bridge.js", here), "utf8"),
    readFile(new URL("bot.js", here), "utf8"),
    readFile(new URL("../data/opcodes.json", here), "utf8"),
    readFile(new URL("../data/class-spells.json", here), "utf8"),
    readFile(new URL("../data/quest-items.json", here), "utf8"),
    readFile(new URL("../data/band-rotations.json", here), "utf8"),
  ]);
  const code = [
    bridge,
    `window.iq.setOpcodeNames(${opcodes})`,
    `(() => { window.iq.classSpells = ${classSpells}; window.iq.questItems = ${questItems}; window.iq.bandRotations = ${bandRotations}; })()`,
    bot,
  ];
  return [...code, `window.iq.code = ${JSON.stringify(version(code))}`];
}

const version = (parts) => Bun.hash(parts.join("\n")).toString(36);

/** The version of the code `installExpressions` installs now, a hash of the expressions. */
export async function codeVersion() {
  return (await installExpressions()).at(-1).match(/"(.+)"/)[1];
}

/** The stored login, `~/.config/idlequest/email` and `password`. */
export async function storedLogin() {
  const dir = `${homedir()}/.config/idlequest`;
  const [email, password] = await Promise.all(["email", "password"].map((f) => readFile(`${dir}/${f}`, "utf8").then((s) => s.trim())));
  return { email, password };
}

/**
 * Where the page stands: "select" at character select, "login" when the login form is ready to
 * submit, "game" in the world, or "loading". Runs in the page.
 */
export function screenInPage() {
  if (/SELECT A CHARACTER/i.test(document.body?.innerText ?? "")) return "select";
  const connect = [...document.querySelectorAll("button")].find((b) => /CONNECT/.test(b.textContent));
  if (document.querySelector('input[type="password"]') && connect && !connect.disabled) return "login";
  if (window.iq?.stores?.screen?.getState?.().currentScreen === "game") return "game";
  return document.querySelector("canvas") ? "game" : "loading";
}

/** Fill the login form with `a.email` and `a.password` and press CONNECT. Runs in the page. */
export function signInInPage(a) {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  const em = document.querySelector('input[type="email"], input[name="email"], input[type="text"]');
  const pw = document.querySelector('input[type="password"]');
  if (!em || !pw) return false;
  set.call(em, a.email);
  em.dispatchEvent(new Event("input", { bubbles: true }));
  set.call(pw, a.password);
  pw.dispatchEvent(new Event("input", { bubbles: true }));
  const connect = [...document.querySelectorAll("button")].find((b) => /CONNECT/.test(b.textContent));
  connect?.click();
  return Boolean(connect);
}
