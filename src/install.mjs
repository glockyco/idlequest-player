// What a game tab needs to play: the bridge, its tables and the bot, and the stored login. The SDK
// (`attach` in src/client.mjs) and the collector's tab recovery (tools/iqd.mjs) both install
// through these expressions, so a tab comes back the same way whoever restores it. Every
// expression is a plain string, because the relay evaluates only strings.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const here = new URL(".", import.meta.url);
const repo = fileURLToPath(new URL("..", here));

// A commit's files never change, so each is read from git once.
const shown = new Map();
/** The text of the repository's `path` in `commit`, or in the working tree for no commit. */
async function fileAt(commit, path) {
  if (!commit) return readFile(new URL(`../${path}`, here), "utf8");
  const key = `${commit}:${path}`;
  if (!shown.has(key)) {
    const p = Bun.spawn(["git", "-C", repo, "show", key], { stdout: "pipe", stderr: "pipe" });
    const [text, err, exit] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    if (exit !== 0) throw new Error(`git show ${key}: ${err.trim()}`);
    shown.set(key, text);
  }
  return shown.get(key);
}

/** The files the expressions are made of, which a deploy checks against the working tree. */
export const PAGE_FILES = ["src/bridge.js", "data/opcodes.json", "data/class-spells.json", "src/bot.js"];

/**
 * The expressions that install the bridge, give it the opcode names and the tables the bot reads
 * (the client's per-class spell table, the quest turn-in items, the band rotations), and install
 * the bot, in that order, from the files of `commit` (a full hash), or from the working tree
 * without one. The bot keeps its settings in the tab's sessionStorage, so a reload in the same tab
 * gets its leader, party and rotation back. The last expression stamps the page with
 * `codeVersion`, so the collector can tell a tab that runs other code.
 */
export async function installExpressions(commit = null) {
  const [bridge, opcodes, classSpells, bot] = await Promise.all(PAGE_FILES.map((f) => fileAt(commit, f)));
  const code = [
    bridge,
    `window.iq.setOpcodeNames(${opcodes})`,
    `(() => { window.iq.classSpells = ${classSpells}; })()`,
    bot,
  ];
  return [...code, `window.iq.code = ${JSON.stringify(version(code))}`];
}

const version = (parts) => Bun.hash(parts.join("\n")).toString(36);

/** The version of the code `installExpressions` installs for `commit`, a hash of the expressions. */
export async function codeVersion(commit = null) {
  return (await installExpressions(commit)).at(-1).match(/"(.+)"/)[1];
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
