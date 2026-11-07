import { readFile, writeFile, mkdir, appendFile } from "node:fs/promises";

const here = new URL(".", import.meta.url);

const METHODS = ["status", "roster", "inventory", "chatTail", "scribeAndMemorize", "talk", "recruitDefaultParty", "setLabel", "setTactic", "packets", "guardStatus", "setGuard", "testGuard", "setChores"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** The Travel window lists zones without a leading "The"; the status reports the long name with it. */
const norm = (s) => s.replace(/^the\s+/i, "").trim().toLowerCase();

/**
 * Last (session, seq) pair in a JSONL file, or zeros if the file is missing or empty. The page
 * numbers rows from 1 again after every reload, so `seq` alone cannot say what was exported.
 * It is a cursor into one file, so each buffer keeps its own.
 */
async function lastCursor(path) {
  try {
    const lines = (await readFile(path, "utf8")).trimEnd().split("\n");
    const row = lines.at(-1) ? JSON.parse(lines.at(-1)) : null;
    return { ses: row?.ses ?? 0, seq: row?.seq ?? 0 };
  } catch {
    return { ses: 0, seq: 0 };
  }
}

/**
 * Inject the bridge into a browser tab and return a handle with one async method per bridge call.
 * `tab` needs `evaluate(expression | function, ...args)`, `click`, `clickAt`, `fill`, `type` and
 * `waitForSelector` for page evaluation and the game's UI controls.
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

    /**
     * Append new recorder rows to `<dir>/samples.jsonl` and `<dir>/events.jsonl`.
     * Resumes from the last sequence number already on disk, so it is safe to call repeatedly
     * and after a restart of the calling script.
     */
    async exportRun(dir) {
      await mkdir(dir, { recursive: true });
      const sPath = `${dir}/samples.jsonl`;
      const ePath = `${dir}/events.jsonl`;
      const [s, e] = await Promise.all([lastCursor(sPath), lastCursor(ePath)]);
      const { samples, events } = await tab.evaluate((a, b) => window.iq.drain(a, b), s, e);
      if (samples.length) await appendFile(sPath, samples.map((r) => JSON.stringify(r)).join("\n") + "\n");
      if (events.length) await appendFile(ePath, events.map((r) => JSON.stringify(r)).join("\n") + "\n");
      return { samples: samples.length, events: events.length };
    },

    /** Close windows that hide the right-hand buttons: Done/Close buttons, merchant, and the combat macro bar. */
    async clearWindows() {
      for (let i = 0; i < 4; i++) {
        const n = await tab.evaluate(() => {
          const s = window.iq.stores.combat.getState();
          if (s.isCombatSkillMacrosOpen) s.setCombatSkillMacrosOpen(false);
          const d = [...document.querySelectorAll("button")].filter((b) => /^(done|close)$/i.test(b.textContent.trim()));
          d.forEach((b) => b.click());
          return d.length;
        });
        if (!n) return;
        await sleep(600);
      }
    },

    /**
     * Press buttons on macro bar page 2 (Buy Spells, Buy Companion Spells, Auto Sell, ...) and
     * return the game's reply lines that match `pattern`. Combat chatter can push replies out of
     * the chat tail, so they are read from the event log.
     */
    async macroPress(labels, pattern, waitMs = 6000) {
      await handle.clearWindows();
      const click = (label) =>
        tab.evaluate((l) => {
          const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === l || x.getAttribute("aria-label") === l);
          if (!b) return false;
          b.click();
          return true;
        }, label);
      // The macro bar and the chat both have pager buttons. The macro pager sits left of x=1200.
      // A DOM click does not turn the page, so click at the button's centre.
      const macroPage = async (label) => {
        const r = await tab.evaluate((l) => {
          const b = [...document.querySelectorAll("button")].filter((x) => x.getAttribute("aria-label") === l && x.getBoundingClientRect().x < 1200).pop();
          if (!b) return null;
          const q = b.getBoundingClientRect();
          return { x: q.x + q.width / 2, y: q.y + q.height / 2 };
        }, label);
        if (!r) return false;
        await tab.clickAt(r.x, r.y);
        return true;
      };
      const since = await tab.evaluate(() => window.iq.seqs.event);
      if (!(await click(labels[0]))) await macroPage("Next page");
      await sleep(700);
      try {
        for (const label of labels) {
          if (!(await click(label))) throw new Error(`macro button "${label}" not found`);
          await sleep(waitMs);
        }
      } finally {
        await macroPage("Previous page");
      }
      return tab.evaluate((s, p) => window.iq.events.filter((e) => e.seq > s && new RegExp(p, "i").test(e.text)).map((e) => e.text), since, pattern.source);
    },

    /**
     * Buy and scribe every missing merchant spell for the player and the same-account companions in
     * the party, with the request the macro buttons send. No clicks and safe while AutoLevel runs.
     * The page also does this by itself when the game reminds the player (see `chores`). Returns
     * the server's reply per scope.
     */
    async buySpells() {
      const lines = await tab.evaluate(() => window.iq.buyMissingSpells());
      return { lines };
    },

    /**
     * Sell eligible carried items through the game's Auto Sell (macro page 2). It respects the
     * game's protections (No Sell bags, valuable gear, quest items) and takes a 20% courier fee.
     * Returns the carried coin before and after, in copper, and the game's reply lines.
     */
    async autoSell() {
      const coin = () => tab.evaluate(() => { const p = window.iq.stores.character.getState().characterProfile; return (p.platinum || 0) * 1000 + (p.gold || 0) * 100 + (p.silver || 0) * 10 + (p.copper || 0); });
      const before = await coin();
      const lines = await handle.macroPress(["Auto Sell"], /sold|sell|courier|nothing|no items|eligible/, 8000);
      return { beforeCopper: before, afterCopper: await coin(), lines };
    },

    /** Pause AutoLevel and wait until combat automation has stopped. The AutoLevel button toggles. */
    async stopAutoLevel() {
      await handle.clearWindows();
      const a0 = (await handle.status()).autoLevel;
      if (a0.running || a0.autoAttack) await tab.click('role/button[name="AutoLevel" exact]');
      for (let i = 0; i < 40; i++) {
        const a = (await handle.status()).autoLevel;
        if (!a.running && !a.autoAttack) return true;
        await sleep(1500);
      }
      return false;
    },

    /**
     * Start AutoLevel with the given limits. Con values follow the game's options:
     * 2 green, 4 blue, 10 white, 15 yellow, 13 red. `maxLevelDiff` caps enemy level above yours (0 = no cap).
     */
    async startAutoLevel({ minCon, maxCon, maxLevelDiff } = {}) {
      await handle.clearWindows();
      await tab.evaluate(
        (a, b, c) => {
          const s = window.iq.stores.combat.getState();
          if (a != null) s.setMinCon(a);
          if (b != null) s.setMaxCon(b);
          if (c != null) s.setMaxLevelDiff(c);
        },
        minCon ?? null,
        maxCon ?? null,
        maxLevelDiff ?? null,
      );
      await tab.click('role/button[name="AutoLevel" exact]');
      await tab.waitForSelector('role/button[name="Start" exact]', { timeout: 10000 });
      await tab.click('role/button[name="Start" exact]');
      await sleep(2000);
      return (await handle.status()).autoLevel;
    },

    /**
     * Run `fn` with AutoLevel paused, then restart it with the same con and level limits, even if
     * `fn` throws. Use it for anything that needs the party standing still (travel, memorizing,
     * shopping, experiments) so a pause can never be left in place by accident. If AutoLevel was
     * not running, `fn` runs as is and nothing is restarted.
     */
    async pausedAutoLevel(fn) {
      const was = (await handle.status()).autoLevel;
      const limits = await tab.evaluate(() => {
        const s = window.iq.stores.combat.getState();
        return { minCon: s.minCon, maxCon: s.maxCon, maxLevelDiff: s.maxLevelDiff };
      });
      if (was.running) await handle.stopAutoLevel();
      try {
        return await fn();
      } finally {
        if (was.running) await handle.startAutoLevel(limits);
      }
    },

    /**
     * Travel through the Travel window (the same path a player uses) and wait for the zone to load.
     * AutoLevel must be stopped first. Returns the status once the zone has loaded.
     */
    async travelTo(zoneName, timeoutMs = 120000) {
      await handle.clearWindows();
      await tab.click('role/button[name="Travel" exact]');
      await sleep(1200);
      await tab.fill("placeholder/Search travel destinations", zoneName);
      await tab.waitForSelector(`role/button[name="${zoneName}" exact]`, { timeout: 10000 });
      await tab.click(`role/button[name="${zoneName}" exact]`);
      const t0 = Date.now();
      for (;;) {
        await sleep(2000);
        const s = await handle.status();
        if (norm(s.zone ?? "") === norm(zoneName) && !s.zoneLoading) {
          await tab.evaluate(() => [...document.querySelectorAll("button")].find((b) => /^done$/i.test(b.textContent.trim()))?.click());
          return s;
        }
        if (Date.now() - t0 > timeoutMs) throw new Error(`travel to ${zoneName} timed out`);
      }
    },

    /**
     * Visit each zone through the Travel window and save its raw spawn data to `<outDir>/<zone>.json`
     * (see `zoneSnapshot` in the bridge). Zones already saved are skipped. Does not fight.
     * AutoLevel must be stopped. Analyze the result with `tools/zones.mjs`.
     */
    async scoutZones(zoneNames, outDir) {
      await mkdir(outDir, { recursive: true });
      const out = [];
      for (const name of zoneNames) {
        const file = `${outDir}/${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.json`;
        try {
          if (await readFile(file, "utf8").then(() => true, () => false)) {
            out.push({ zone: name, file, skipped: true });
            continue;
          }
          await handle.travelTo(name);
          for (let i = 0; i < 15; i++) {
            const n = await tab.evaluate(() => window.iq.stores.combat.getState().currentZoneNPCs.length);
            if (n > 0) break;
            await sleep(1000);
          }
          await sleep(1500);
          const snap = await tab.evaluate(() => window.iq.zoneSnapshot());
          await writeFile(file, JSON.stringify(snap));
          out.push({ zone: name, file, spawns: snap.spawns.length });
        } catch (e) {
          out.push({ zone: name, error: String(e.message ?? e) });
        }
      }
      return out;
    },
  };
  for (const name of METHODS) {
    handle[name] = (...args) => tab.evaluate((n, a) => window.iq[n](...a), name, args);
  }
  return handle;
}
