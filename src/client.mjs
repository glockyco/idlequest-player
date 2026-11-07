import { readFile, writeFile, mkdir, appendFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const here = new URL(".", import.meta.url);
/**
 * A relative run or zone directory names a place in this repository, whatever the calling
 * script's working directory is, so exports always land in `runs/`.
 */
const repoPath = (p) => (isAbsolute(p) ? p : fileURLToPath(new URL(p, new URL("..", here))));

const METHODS = ["status", "roster", "inventory", "bagSpace", "chatTail", "talk", "recruitDefaultParty", "setLabel", "setTactic", "packets", "guardStatus", "setGuard", "testGuard", "setChores"];

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
 * Inject the bridge and the supervisor bot into a browser tab and return a handle with one async
 * method per bridge call. `tab` needs `evaluate(expression | function, ...args)`, `click`,
 * `clickAt`, `fill`, `type` and `waitForSelector` for page evaluation and the game's UI controls.
 */
export async function attach(tab) {
  const [bridge, bot, opcodes] = await Promise.all([
    readFile(new URL("bridge.js", here), "utf8"),
    readFile(new URL("bot.js", here), "utf8"),
    readFile(new URL("../data/opcodes.json", here), "utf8").then(JSON.parse),
  ]);
  await tab.evaluate(bridge);
  await tab.evaluate((table) => window.iq.setOpcodeNames(table), opcodes);
  await tab.evaluate(bot);

  const handle = {
    tab,
    /** Kill log built from server combat messages: [{t, enemy, xp}]. */
    kills: () => tab.evaluate(() => window.iq.kills),

    /**
     * Append new recorder rows to `<dir>/samples.jsonl` and `<dir>/events.jsonl`. A relative `dir`
     * is resolved against the repository. Resumes from the last sequence number already on disk,
     * so it is safe to call repeatedly and after a restart of the calling script.
     */
    async exportRun(runDir) {
      const dir = repoPath(runDir);
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
     * Give a carried item to an account character in the party, equipped when `equip` is true,
     * for example an instrument for the Bard. Picks the item up through the inventory window, as a
     * player does, then sends the client's held-item transfer. Returns the game's reply and checks
     * the cursor is empty afterwards. `itemName` must be in a bag.
     */
    async giveItem(itemName, characterName, equip = true) {
      const item = (await handle.inventory()).find((r) => r.name === itemName && r.loc === "bag");
      if (!item) throw new Error(`no ${itemName} in the bags`);
      const target = (await handle.roster()).party.find((m) => m.name === characterName);
      const characterId = Number(String(target?.id ?? "").replace("character-", ""));
      if (!characterId) throw new Error(`${characterName} is not an account character in the party`);
      await handle.clearWindows();
      await tab.click('role/button[name="Persona" exact]');
      await tab.waitForSelector(`testid/general-inventory-slot-${item.bag - 1}`, { timeout: 5000 });
      await tab.click(`testid/general-inventory-slot-${item.bag - 1}`, { button: "right" });
      await tab.waitForSelector(`testid/container-inventory-slot-${item.bag}-${item.slot}`, { timeout: 5000 });
      await tab.click(`testid/container-inventory-slot-${item.bag}-${item.slot}`);
      for (let i = 0; i < 10 && (await handle.bagSpace()).cursor !== itemName; i++) await sleep(300);
      const since = await tab.evaluate(() => window.iq.seqs.event);
      const ok = await tab.evaluate((id, e) => window.iq.stores.companions.getState().transferHeldItem(id, e), characterId, equip);
      await sleep(1500);
      await tab.click(`testid/general-inventory-slot-${item.bag - 1}`, { button: "right" }).catch(() => {});
      await handle.clearWindows();
      const cursor = (await handle.bagSpace()).cursor;
      if (cursor) throw new Error(`${cursor} is still on the cursor; place it before continuing`);
      const lines = await tab.evaluate((s) => window.iq.events.filter((x) => x.seq > s && /equips|transfer|^You give/i.test(x.text)).map((x) => x.text), since);
      return { ok, lines };
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

    /**
     * Stop AutoLevel and wait until combat automation has stopped. The AutoLevel button toggles.
     * The bot is paused first so it does not start AutoLevel again. The pause lasts `pauseMinutes`
     * (the bot's default when omitted) and then ends by itself, so a forgotten stop cannot leave the
     * party idle. Renew it with `pauseBot` for longer work.
     */
    async stopAutoLevel(pauseMinutes) {
      await handle.pauseBot(pauseMinutes, "stopAutoLevel");
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
      await handle.resumeBot();
      return (await handle.status()).autoLevel;
    },

    /**
     * Run `fn` with AutoLevel paused, then restart it with the same con and level limits, even if
     * `fn` throws. Use it for anything that needs the party standing still (travel, memorizing,
     * shopping, experiments) so a pause can never be left in place by accident. If AutoLevel was
     * not running, `fn` runs as is and nothing is restarted. While `fn` runs, the bot's pause is
     * renewed every 30 seconds. If this script dies, the renewals stop and the bot resumes play
     * within two minutes.
     */
    async pausedAutoLevel(fn) {
      const was = (await handle.status()).autoLevel;
      const limits = await tab.evaluate(() => {
        const s = window.iq.stores.combat.getState();
        return { minCon: s.minCon, maxCon: s.maxCon, maxLevelDiff: s.maxLevelDiff };
      });
      await handle.pauseBot(1.5, "pausedAutoLevel");
      const renew = setInterval(() => handle.pauseBot(1.5, "pausedAutoLevel").catch(() => {}), 30000);
      try {
        if (was.running) await handle.stopAutoLevel(1.5);
        return await fn();
      } finally {
        clearInterval(renew);
        if (was.running) await handle.startAutoLevel(limits);
      }
    },

    /** The bot's compact report: level, XP/hour, bag space, AutoLevel, recent actions and alerts after `sinceSeq`. */
    botReport: (sinceSeq = 0) => tab.evaluate((s) => window.iqBot.report(s), sinceSeq),

    /**
     * Scribe carried spell scrolls and memorize the named spells into gems 0..n-1, for example
     * after a level-up. Waits up to 90 s for the current fight to end, because memorizing needs the
     * player sitting. Run it inside `pausedAutoLevel`.
     */
    async scribeAndMemorize(names = []) {
      for (let i = 0; i < 90 && (await handle.status()).inCombat; i++) await sleep(1000);
      return tab.evaluate((n) => window.iq.scribeAndMemorize(n), names);
    },

    /**
     * Change bot settings, e.g. `{ minFreeSlots: 12 }` or `{ enabled: false }`; `null` restores a
     * default. They persist in the browser. Sent as JSON because tab arguments drop null values.
     */
    setBot: (partial) => tab.evaluate((json) => window.iqBot.set(JSON.parse(json)), JSON.stringify(partial)),

    /** Let AutoLevel stay off for `minutes` (the bot's default when omitted). The pause ends by itself. */
    pauseBot: (minutes, reason = "") => tab.evaluate((m, r) => window.iqBot.pause(m ?? undefined, r), minutes ?? null, reason),

    /** End the bot's pause now. */
    resumeBot: () => tab.evaluate(() => window.iqBot.resume()),

    /**
     * Wait while the page plays and return when the bot raises an alert that needs attention, or
     * after `minutes`. Polls the report every `pollSeconds` and, with `exportDir`, appends run data
     * on the way. Pass the returned `alertSeq` as `sinceSeq` to the next call. One call replaces
     * dozens of status checks, which is what keeps unattended play cheap to supervise.
     */
    async watch({ minutes = 50, pollSeconds = 60, sinceSeq, exportDir } = {}) {
      const until = Date.now() + minutes * 60000;
      const seq = sinceSeq ?? (await handle.botReport()).alertSeq;
      for (;;) {
        const r = await handle.botReport(seq);
        if (exportDir) await handle.exportRun(exportDir);
        const woke = r.alerts.some((a) => a.wake);
        if (woke || Date.now() >= until) return { ...r, woke };
        await sleep(Math.min(pollSeconds * 1000, until - Date.now()));
      }
    },

    /**
     * Travel through the Travel window (the same path a player uses) and wait for the zone to load.
     * AutoLevel must be stopped first. The window only opens out of combat, and the game's
     * auto-loot after the last kill closes it again, so this waits until the fight is over and the
     * chat has had no loot line for a few seconds, and opens the window again if it closes.
     */
    async travelTo(zoneName, timeoutMs = 120000) {
      const deadline = Date.now() + timeoutMs;
      const quiet = () => tab.evaluate(() => {
        const last = window.iq.events.findLast?.((e) => e.type === "LOOT" || /^You loot|corpse/i.test(e.text ?? ""));
        return !window.iq.status().inCombat && (!last || Date.now() - last.t > 4000);
      });
      await handle.clearWindows();
      let lastError = new Error("combat or looting did not end");
      while (Date.now() < deadline) {
        if (!(await quiet())) {
          await sleep(1000);
          continue;
        }
        try {
          await tab.click('role/button[name="Travel" exact]');
          await tab.waitForSelector("placeholder/Search travel destinations", { timeout: 5000 });
          await tab.fill("placeholder/Search travel destinations", zoneName);
          await tab.waitForSelector(`role/button[name="${zoneName}" exact]`, { timeout: 5000 });
          await tab.click(`role/button[name="${zoneName}" exact]`);
          lastError = null;
          break;
        } catch (error) {
          // Loot or a new fight closed the window, or the zone is not in the list.
          lastError = error;
          await handle.clearWindows();
          await sleep(1500);
        }
      }
      if (lastError) throw new Error(`travel to ${zoneName} failed: ${lastError.message}`, { cause: lastError });
      for (;;) {
        await sleep(2000);
        const s = await handle.status();
        if (norm(s.zone ?? "") === norm(zoneName) && !s.zoneLoading) {
          await tab.evaluate(() => [...document.querySelectorAll("button")].find((b) => /^done$/i.test(b.textContent.trim()))?.click());
          return s;
        }
        if (Date.now() >= deadline) throw new Error(`travel to ${zoneName} timed out`);
      }
    },

    /**
     * Visit each zone through the Travel window and save its raw spawn data to `<zoneDir>/<zone>.json`
     * (see `zoneSnapshot` in the bridge). A relative `zoneDir` is resolved against the repository.
     * Zones already saved are skipped. Does not fight. AutoLevel must be stopped. Analyze the
     * result with `tools/zones.mjs`.
     */
    async scoutZones(zoneNames, zoneDir) {
      const outDir = repoPath(zoneDir);
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
