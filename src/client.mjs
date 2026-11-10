import { readFile, writeFile, mkdir, appendFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { installExpressions } from "./install.mjs";

const here = new URL(".", import.meta.url);
/**
 * A relative run or zone directory names a place in this repository, whatever the calling
 * script's working directory is, so exports always land in `runs/`.
 */
const repoPath = (p) => (isAbsolute(p) ? p : fileURLToPath(new URL(p, new URL("..", here))));

const METHODS = ["status", "roster", "inventory", "bagSpace", "chatTail", "talk", "recruitDefaultParty", "setLabel", "setTactic", "packets", "guardStatus", "setGuard", "testGuard", "setChores"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
 * `clickAt`, `fill` and `waitForSelector` for page evaluation and the game's UI controls.
 */
export async function attach(tab) {
  // The same install the collector's tab recovery uses (src/install.mjs).
  for (const expression of await installExpressions()) await tab.evaluate(expression);

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

    /** Close windows that hide the right-hand buttons: Done/Close buttons, merchant, Path To, the quest dialogue and the combat macro bar. */
    async clearWindows() {
      return handle.runJob("closeWindows", []);
    },

    /**
     * Run the bridge action `name` (`JOBS` in src/bridge.js) as a page job with `args` and wait
     * for its result, because one page call may last only about 30 seconds.
     */
    async runJob(name, args = [], timeoutMs = 300000) {
      const id = await tab.evaluate((n, a) => window.iq.job(n, ...a), name, args);
      for (const end = Date.now() + timeoutMs; Date.now() < end; ) {
        await sleep(1000);
        const j = await tab.evaluate((k) => window.iq.jobs[k] ?? null, id);
        if (!j) throw new Error(`job ${id} is gone (was the bridge installed again?)`);
        if (!j.done) continue;
        if (!j.ok) throw new Error(j.error);
        return j.result;
      }
      throw new Error(`${name} did not finish within ${Math.round(timeoutMs / 1000)} s`);
    },

    /**
     * Give a carried item to any character on the account (in the party or offline), equipped when
     * `equip` is true, with the bridge's `giveItem` (the client's held-item transfer).
     */
    async giveItem(itemName, characterName, equip = true) {
      const characterId = await tab.evaluate((name) => Number((window.iq.stores.roster?.getState?.().characters ?? []).find((x) => x.name?.toLowerCase() === name.toLowerCase())?.id || 0), characterName);
      if (!characterId) throw new Error(`${characterName} is not a character on this account`);
      return handle.runJob("giveItem", [itemName, characterId, { equip }]);
    },

    /**
     * Kit the active character after creation: put the starred starter weapon into the empty
     * primary slot, then move every general-slot item that is not a container into a container,
     * so the general slots can take bags. Contents of the container in general slot N are
     * addressed as `{ bag: N, slot: 0.. }`. Resolves with the moves made and the bag space.
     */
    async kitStarter() {
      return tab.evaluate(async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const ch = () => window.iq.stores.character.getState();
        const inv = () => ch().characterProfile.inventory;
        const general = (x) => x.bag === 0 && x.slot >= 22 && x.slot <= 29;
        const moves = [];
        if (!inv().some((x) => x.bag === 0 && x.slot === 13)) {
          const w = inv().find((x) => /\*$/.test(x.itemDetails?.name ?? "") && x.itemDetails.slots & 8192 && x.itemDetails.damage > 0 && (general(x) || x.bag >= 22));
          if (w) {
            ch().moveItemToSlot({ bag: w.bag, slot: w.slot }, { bag: 0, slot: 13 });
            await sleep(1200);
            moves.push(`equipped ${w.itemDetails.name}`);
          }
        }
        for (const it of inv().filter((x) => general(x) && !(x.itemDetails?.bagslots > 0))) {
          let to = null;
          for (const c of inv().filter((x) => general(x) && x.itemDetails?.bagslots > 0)) {
            const used = new Set(inv().filter((x) => x.bag === c.slot).map((x) => x.slot));
            let s = 0;
            while (used.has(s)) s++;
            if (s < c.itemDetails.bagslots) {
              to = { bag: c.slot, slot: s };
              break;
            }
          }
          if (!to) break;
          ch().moveItemToSlot({ bag: 0, slot: it.slot }, to);
          await sleep(900);
          moves.push(`packed ${it.itemDetails.name}`);
        }
        return { moves, primary: inv().find((x) => x.bag === 0 && x.slot === 13)?.itemDetails?.name ?? null, space: window.iq.bagSpace() };
      });
    },

    /**
     * Buy `count` of an item from a merchant in the current zone with the bridge's `buyItem` job:
     * it walks to the merchant's Path To row and presses PURCHASE once per item. A purchase lands
     * in a free general or bag slot, and a container needs a free general slot. Disable the bot
     * first so its cleanup does not sell the purchases. Resolves with the number bought and the
     * platinum left.
     */
    async buyItem(itemName, { count = 1, merchant, timeoutMs = 300000 } = {}) {
      return handle.runJob("buyItem", [itemName, merchant, count], timeoutMs);
    },

    /**
     * Pull one carried or banked item of another account character (`from`, or the first one
     * Inventory Search lists) to the active character with the window's Transfer button (the
     * bridge's `pullItem`). The active character needs a free bag slot. Resolves with the
     * window's reply, the giver and whether the item arrived.
     */
    async pullItem({ itemName, from = null }) {
      return handle.runJob("pullItem", [itemName, { from }]);
    },

    /**
     * Equip a carried item on the active character in worn slot `slot` (gear-data's slot numbers,
     * for example 17 for the chest) with the character store's slot move. The slot must be empty,
     * because a move onto an occupied slot does nothing. Resolves with what the slot holds after.
     */
    async equipFromBags(itemName, slot) {
      return tab.evaluate(
        async (item, to) => {
          const ch = () => window.iq.stores.character.getState();
          const inv = () => ch().characterProfile.inventory;
          const from = inv().find((x) => x.itemDetails?.name === item && (x.bag >= 22 || (x.bag === 0 && x.slot >= 22 && x.slot <= 29)));
          if (!from) throw new Error(`no ${item} in the bags`);
          if (inv().some((x) => x.bag === 0 && x.slot === to)) throw new Error(`slot ${to} is not empty`);
          ch().moveItemToSlot({ bag: from.bag, slot: from.slot }, { bag: 0, slot: to });
          await new Promise((r) => setTimeout(r, 1200));
          return inv().find((x) => x.bag === 0 && x.slot === to)?.itemDetails?.name ?? null;
        },
        itemName,
        slot,
      );
    },

    /**
     * Read account-wide coin balances through the Manage Money panel, and optionally pull carried
     * and bank coin from `transferFrom` (a character name, an array of names, or `"all"`) into the
     * active character's wallet.
     */
    async manageMoney({ transferFrom = null } = {}) {
      return tab.evaluate(async (from) => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const cb = window.iq.stores.combat.getState();
        cb.openManageMoney();
        const waitReady = async () => {
          for (let k = 0; k < 30; k++) {
            const p = document.querySelector('[data-testid="manage-money-panel"]');
            if (p && !p.querySelector('[aria-busy="true"]') && !p.textContent.includes("Loading balances")) return p;
            await sleep(250);
          }
          return document.querySelector('[data-testid="manage-money-panel"]');
        };
        const readRows = (p) =>
          p
            ? [...p.querySelectorAll('tbody tr[data-testid^="money-row-"]')].map((tr) => {
                const tds = [...tr.querySelectorAll("td")].map((td) => td.textContent.trim());
                const btn = tr.querySelector("button");
                return { character: tds[0], carried: tds[1], bank: tds[2], total: tds[3], canTransfer: Boolean(btn && !btn.disabled) };
              })
            : [];
        let panel = await waitReady();
        const before = readRows(panel);
        const transferred = [];
        if (from) {
          const want = from === "all" ? null : new Set((Array.isArray(from) ? from : [from]).map((s) => String(s).toLowerCase()));
          for (let pass = 0; pass < 20; pass++) {
            panel = await waitReady();
            const tr = [...(panel?.querySelectorAll('tbody tr[data-testid^="money-row-"]') ?? [])].find((row) => {
              const name = row.querySelector("td")?.textContent?.trim()?.toLowerCase() ?? "";
              const btn = row.querySelector("button");
              return btn && !btn.disabled && (!want || want.has(name));
            });
            if (!tr) break;
            const name = tr.querySelector("td")?.textContent?.trim() ?? "";
            tr.querySelector("button").click();
            await sleep(300);
            await waitReady();
            transferred.push(name);
          }
        }
        panel = await waitReady();
        const balances = readRows(panel);
        cb.closeManageMoney();
        return { before, transferred, balances, platinum: window.iq.stores.character.getState().characterProfile?.platinum ?? 0 };
      }, transferFrom);
    },

    /**
     * Walk to a quest NPC in the current zone, open its dialogue, click each matching option in
     * `keywords`, and return the NPC's lines, its remaining options and whether Give Items is
     * available (the bridge's `talkToNpc`, run as a page job). Run inside `pausedAutoLevel`.
     */
    async talkToNpc(npcName, keywords = []) {
      return handle.runJob("talkToNpc", [npcName, keywords]);
    },

    /**
     * Trade up to four carried items (`itemNames`) to a quest NPC with its Give Items window and
     * return the NPC's reply and the chat lines the trade brought. `talk: false` skips the walk
     * when the dialogue is already open, and `closeNote: false` leaves it open for the next
     * trade. Run inside `pausedAutoLevel`.
     */
    async turnInQuest(npcName, itemNames = [], { talk = true, closeNote = true } = {}) {
      if (talk) await handle.talkToNpc(npcName);
      return { ok: true, ...(await handle.runJob("giveToNpc", [itemNames, { closeNote }])) };
    },

    /**
     * Hand carried items to a quest NPC for repeatable single-item quests, up to `counts[name]`
     * copies of each, one copy of every name per trade (the bridge's `handInEach`, which says
     * why). Only the active character gets the reward. Returns the trades made, the items handed
     * in and the XP the chat reported. Run inside `pausedAutoLevel`; for several characters use
     * `handIn`.
     */
    async turnInEach({ npc, counts }) {
      return handle.runJob("handInEach", [npc, counts], 600000);
    },

    /**
     * Hand items to a quest NPC for several account characters, each while it is the active
     * character, with the bot's in-page task (`iqBot.handIn`): `members` lists `{ name, counts }`,
     * and a member short of an item pulls it from another account character first. The default
     * NPC is Smith Tv`ysa in South Ro. The task holds the bot's pause and gives the tab back to
     * its leader when it ends, also when this script stops waiting. Resolves with the finished
     * task, or throws with the task when it failed.
     */
    async handIn({ members, npc, zone, timeoutMs = 3600000 }) {
      return handle.runTask("handIn", { members, ...(npc ? { npc } : {}), ...(zone ? { zone } : {}) }, timeoutMs);
    },

    /**
     * Run quest `steps` for each of `members` with the bot's in-page task (`iqBot.quest`), each
     * while it is the active character. A step is `{ zone, npc, say, give, each, expect }`: travel,
     * pull what it hands over from any account character, talk with `say` keywords, give `give` in
     * one trade or hand in `each` per item, then check that `expect` is carried. Resolves with the
     * finished task, or throws with it.
     */
    async quest({ timeoutMs = 3600000, ...opts }) {
      return handle.runTask("quest", opts, timeoutMs);
    },

    /**
     * Fight the enemies whose names match `keep` in `zone` (one zone or a list of zones with the
     * same enemies) with the bot's in-page task (`iqBot.hunt`), for drops from enemies AutoLevel
     * does not pull, such as gray ones, e.g. `{ zone: "mistmoore", keep: "gypsy dancer", item:
     * "Power of Wind", waitMin: 3 }`. With `points` it camps the enemies' spawn points. The leader
     * loots, and NO DROP pieces move to the character who needs them with Inventory Search
     * (`pullItem`). The tab goes back to its leader when the task ends. Resolves with the finished
     * task, or throws with the task when it failed.
     */
    async hunt({ timeoutMs = 3600000, ...opts }) {
      return handle.runTask("hunt", opts, timeoutMs);
    },

    /**
     * Fight one raid target with the bot's in-page task (`iqBot.raid`): the leader and `members`
     * (account character names) against `target`, a regular expression for an enemy above level
     * 50 in `zone`, or `bossKey`, a daily boss from `iq.raid.bosses()` in the page. It buys an hour
     * of raid time only when none is left and it costs at most `maxPp`, e.g. `{ members, target:
     * "Nagafen", zone: "soldungb", maxPp: 2500 }`. `heal` (default "all-balanced") and `nuke`
     * (default "dps-balanced") are the raid's heal mode and nuke order, null for none. Resolves
     * with the finished task, whose `fight` holds the outcome, duration, each member's damage, HP
     * and mana, the leader's deaths and revives and a trace every 5 s, or throws with it.
     */
    async raid({ timeoutMs = 3600000, ...opts }) {
      return handle.runTask("raid", opts, timeoutMs);
    },

    /** Start the bot's task `kind` with `spec` and wait for its end. Resolves with the done task, or throws with it. */
    async runTask(kind, spec, timeoutMs = 3600000) {
      await tab.evaluate((k, json) => window.iqBot[k](JSON.parse(json)), kind, JSON.stringify(spec));
      let task = null;
      for (const end = Date.now() + timeoutMs; Date.now() < end; ) {
        await sleep(5000);
        task = await tab.evaluate(() => window.iqBot.state.task && JSON.parse(JSON.stringify(window.iqBot.state.task)));
        if (task?.status !== "running") break;
      }
      if (task?.status !== "done") throw Object.assign(new Error(`${kind} ${task?.status ?? "lost"}${task?.error ? ` at "${task.step}": ${task.error}` : ""}`), { task });
      return task;
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
     * 2 green, 4 blue, 10 white, 15 yellow, 13 red. `maxLevelDiff` caps enemy level above yours and
     * also sets the maximum con: 0 gives White, 1 to 2 Yellow, 3 or more Red (main.pretty.js:190701-190716).
     * The bot's remedy table is the only code that starts AutoLevel, so this sets the limits and ends
     * the bot's pause, a hold after which the bot starts AutoLevel at once.
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
      await handle.resumeBot();
      for (let k = 0; k < 10 && !(await handle.status()).autoLevel?.running; k++) await sleep(1000);
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

    /**
     * Make `name` the active character, for work as another account character, with the bot's
     * in-page switch (`iqBot.switchTo`, the client's camp and enter-world commands). The party is
     * not regrouped. Without a pause the bot switches back to its `leaderId` at its next tick, so
     * this extends the bot's pause to at least `holdMin` minutes. Renew it with `pauseBot` or work
     * inside `pausedAutoLevel`, and use `setLeader` to change the leader for good. Resolves with
     * the active character and zone.
     */
    async switchCharacter(name, { holdMin = 5 } = {}) {
      const pauseLeft = await tab.evaluate(() => (window.iqBot?.state.pauseUntil ?? 0) - Date.now());
      if (pauseLeft < holdMin * 60000) await handle.pauseBot(holdMin, `switchCharacter ${name}`);
      let job = await tab.evaluate((n) => window.iqBot.switchTo(n), name);
      for (const end = Date.now() + 200000; !job.done && Date.now() < end; ) {
        await sleep(2000);
        job = await tab.evaluate(() => ({ ...window.iqBot.state.switching }));
      }
      if (!job.done) throw new Error(`switching to ${name} did not finish`);
      if (!job.ok) throw new Error(job.message);
      return tab.evaluate(async () => {
        const s = window.iq.stores;
        for (let k = 0; k < 40 && s.combat.getState().isZoneLoading; k++) await new Promise((r) => setTimeout(r, 500));
        const zone = s.staticData.getState().zones.find((z) => z.zoneidnumber === s.combat.getState().currentZone);
        return { active: s.character.getState().characterProfile?.name ?? null, zone: zone?.longName ?? null };
      });
    },

    /**
     * Make `name` the tab's leader for good: the bot's `leaderId` becomes that character and its
     * `partyIds` the `members` (names; by default the current party and the current leader,
     * without `name`). The bot then switches and regroups by itself, also at character select
     * after a sign-in, and keeps doing so after every pause. Tactics need no copying: companions'
     * tactics are keyed by character id, and a leader's own tactics by its id
     * (docs/client-internals.md). Resolves once the leader is active with every member in the
     * party, with the leader, zone, party and missing members, or throws after `timeoutMs`.
     */
    async setLeader(name, { members, timeoutMs = 240000 } = {}) {
      const ids = await tab.evaluate(
        (n, names) => {
          const chars = window.iq.stores.roster.getState().characters ?? [];
          const idOf = (x) => Number(chars.find((c) => c.name.toLowerCase() === String(x).toLowerCase())?.id ?? NaN);
          const cfg = window.iqBot.config;
          const active = window.iq.stores.screen.getState().currentScreen === "game" ? Number(window.iq.stores.character.getState().characterProfile?.id) : null;
          const party = names ? names.map(idOf) : [...new Set([...cfg.partyIds.map(Number), ...(cfg.leaderId != null ? [Number(cfg.leaderId)] : []), ...(active ? [active] : [])])];
          return { leader: idOf(n), party: party.filter((id) => id !== idOf(n)) };
        },
        name,
        members ?? null,
      );
      if (!Number.isFinite(ids.leader)) throw new Error(`no account character named ${name}`);
      if (ids.party.some((id) => !Number.isFinite(id))) throw new Error(`a member of ${members.join(", ")} is not on the account`);
      await handle.setBot({ leaderId: ids.leader, partyIds: ids.party });
      await handle.resumeBot();
      let last = null;
      for (const end = Date.now() + timeoutMs; Date.now() < end; await sleep(3000)) {
        last = await tab.evaluate((want) => {
          const s = window.iq.stores;
          const inGame = s.screen.getState().currentScreen === "game" && !s.combat.getState().isZoneLoading;
          const me = inGame ? s.character.getState().characterProfile : null;
          const present = new Set((s.companions.getState().companions ?? []).filter((c) => c.companionType === 2).map((c) => Number(c.characterId)));
          const zone = s.staticData.getState().zones.find((z) => z.zoneidnumber === s.combat.getState().currentZone);
          return { leader: me?.name ?? null, active: Number(me?.id), zone: zone?.longName ?? null, party: (s.companions.getState().companions ?? []).filter((c) => c.companionType === 2).map((c) => c.name), missing: want.filter((id) => !present.has(id)), switching: window.iqBot.state.switching };
        }, ids.party);
        if (last.active === ids.leader && !last.missing.length) break;
      }
      if (last?.active !== ids.leader) throw new Error(`${name} did not become active: ${last?.switching?.message ?? "no switch started"}`);
      return { leader: last.leader, zone: last.zone, party: last.party, missing: last.missing };
    },

    /**
     * Create an account character with the client's own command (`session.createCharacter`,
     * `.re/js/C8.pretty.js:3085-3122`, `4393-4480`). It checks the race, class and deity combination
     * and applies the stat allocation the server lists for it. `race`, `className`, `deity` and
     * `startZone` take names. Deity and start zone default to the first valid ones (Agnostic when
     * allowed). Works only at character select, because the command switches to that screen when
     * it finishes. Resolves with the client's result `{ ok, message, data }`, `ok` false on failure.
     */
    async createCharacter({ name, race, className, deity, startZone, gender }) {
      const spec = JSON.stringify({ type: "session.createCharacter", name, race, className, deity, startZone, gender });
      return tab.evaluate(async (json) => {
        if (window.iq.stores.screen.getState().currentScreen !== "characterSelect") throw new Error("createCharacter needs the character select screen");
        if (!window.iq.command) throw new Error("the client's command dispatcher was not found");
        return window.iq.command(JSON.parse(json));
      }, spec);
    },

    /**
     * Set group 1's measured tactics on every member of the current party by class: support casters
     * (Cleric, Druid, Shaman, Enchanter) neither nuke nor DoT, and support classes do not cure,
     * because the readiness wait holds the whole party for their mana and their cure casts
     * (docs/guide.md, "First hour of a new group"). Enchanters keep crowd control and debuffs.
     * Other tactics and classes keep the game's defaults. Resolves with the tactics set per member.
     */
    async applyRoleTactics() {
      const ROLE = {
        Cleric: { nuke: false, dot: false, cure: false, cc: false },
        Druid: { nuke: false, dot: false, cure: false },
        Shaman: { nuke: false, dot: false, cure: false },
        Enchanter: { nuke: false, dot: false, cure: false, cc: true, debuff: true },
        Bard: { cure: false },
        Paladin: { cure: false },
      };
      const r = await handle.roster();
      const set = {};
      for (const m of [r.me, ...r.party]) {
        const t = ROLE[m.class];
        if (!t) continue;
        for (const [k, v] of Object.entries(t)) await handle.setTactic(m.name, k, v);
        set[m.name] = t;
      }
      return set;
    },

    /**
     * The account's raid time through the Raid Time section's own request (`iq.raid.time` in the
     * page), which only reads: the price of an hour in platinum, the expiry in ms and whether time
     * is left. See docs/client-internals.md, "Running a raid from a script".
     */
    raidTime: () => tab.evaluate(() => window.iq.raid.time()),

    /**
     * The daily raid bosses of the current zone (`iq.raid.bosses` in the page): the resets left,
     * the next reset and each boss's key, name, zone and status. Throws with the server's reason,
     * such as "Daily raid bosses unlock at level 46.".
     */
    dailyBosses: () => tab.evaluate(() => window.iq.raid.bosses()),

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
     * Change bot settings, e.g. `{ minFreeSlots: 12 }` or `{ enabled: false }`. `null` restores a
     * default. They persist in this tab across reloads, and a second session's tab keeps its own.
     * Sent as JSON because tab arguments drop null values.
     */
    setBot: (partial) => tab.evaluate((json) => window.iqBot.set(JSON.parse(json)), JSON.stringify(partial)),

    /** Let AutoLevel stay off for `minutes` (the bot's default when omitted). The pause ends by itself. */
    pauseBot: (minutes, reason = "") => tab.evaluate((m, r) => window.iqBot.pause(m ?? undefined, r), minutes ?? null, reason),

    /** End the bot's pause now. */
    resumeBot: () => tab.evaluate(() => window.iqBot.resume()),

    /**
     * Start a bot errand: hunt in `zone` with the enemies whose names match `keep` first until an
     * item named `item` is in the bags, then rotate on, e.g. `{ zone: "kaesora", keep: "enraged
     * ravener|gorged ravener", item: "Power of Water" }`. Resolves once the party hunts there,
     * because the move can outlast one page evaluation. `errand(null)` ends a running errand.
     */
    async errand(opts) {
      await tab.evaluate((json) => {
        window.__iqErrand = { pending: true };
        window.iqBot.errand(JSON.parse(json)).then(
          (result) => (window.__iqErrand = { result }),
          (e) => (window.__iqErrand = { error: String(e?.message ?? e) }),
        );
      }, JSON.stringify(opts));
      for (;;) {
        await sleep(2000);
        const r = await tab.evaluate(() => window.__iqErrand);
        if (r?.error) throw new Error(r.error);
        if (r && !r.pending) return r.result;
      }
    },

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
     * Travel to a zone, given by short name (`misty`) or long name (`Misty Thicket`). Travel is an
     * instant teleport: this sends the Travel window's zone-change request through the bridge's
     * `changeZone` and waits for the zone to load. Waits for the current fight to end first, and
     * throws for an unknown zone instead of retrying. Stop AutoLevel first.
     */
    async travelTo(zoneName, timeoutMs = 120000) {
      const deadline = Date.now() + timeoutMs;
      while ((await handle.status()).inCombat) {
        if (Date.now() > deadline) throw new Error(`travel to ${zoneName}: the fight did not end`);
        await sleep(1000);
      }
      await handle.clearWindows();
      const short = await tab.evaluate((n) => {
        const k = n.toLowerCase();
        const z = window.iq.stores.staticData.getState().zones.find((x) => x.shortName === k || x.longName?.toLowerCase() === k);
        return z?.shortName ?? null;
      }, zoneName);
      if (!short) throw new Error(`travel to ${zoneName}: no such zone`);
      // changeZone waits up to a minute for the load, longer than one tab evaluation may take.
      await tab.evaluate((s) => {
        window.iq.lastTravelError = null;
        window.iq.changeZone(s).catch((e) => (window.iq.lastTravelError = String(e.message ?? e)));
      }, short);
      for (;;) {
        await sleep(1500);
        const at = await tab.evaluate(() => {
          const cb = window.iq.stores.combat.getState();
          return { loading: cb.isZoneLoading, short: window.iq.stores.staticData.getState().zones.find((z) => z.zoneidnumber === cb.currentZone)?.shortName, error: window.iq.lastTravelError ?? null };
        });
        if (at.error) throw new Error(`travel to ${zoneName}: ${at.error}`);
        if (at.short === short && !at.loading) return handle.status();
        if (Date.now() > deadline) throw new Error(`travel to ${zoneName} timed out in ${at.short}`);
      }
    },

    /**
     * Visit each zone with `travelTo` and save its raw spawn data to `<zoneDir>/<zone>.json`
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
  logActions(handle, tab);
  return handle;
}

// Calls that change the game or the bot. Each top-level call is written to the `interventions`
// table of runs/iq.db, which `iqd status` shows under "Latest notes", so what a script changed and
// when stays on record next to the attention items it answered.
const ACTIONS = ["setBot", "setTactic", "setGuard", "travelTo", "startAutoLevel", "stopAutoLevel", "switchCharacter", "setLeader", "createCharacter", "giveItem", "pullItem", "equipFromBags", "buyItem", "kitStarter", "applyRoleTactics", "errand", "pauseBot", "resumeBot", "scribeAndMemorize", "turnInQuest", "turnInEach", "handIn", "quest", "hunt", "raid"];
let interventionsDb = null;
function logActions(handle, tab) {
  let depth = 0;
  const log = async (name, args) => {
    try {
      const leader = await tab.evaluate(() => window.iq?.stores?.character?.getState?.().characterProfile?.name ?? null);
      if (!interventionsDb) {
        const { Database } = await import("bun:sqlite");
        interventionsDb = new Database(repoPath("runs/iq.db"));
        interventionsDb.run("CREATE TABLE IF NOT EXISTS interventions (id INTEGER PRIMARY KEY AUTOINCREMENT, t INTEGER NOT NULL, session TEXT, actor TEXT NOT NULL, text TEXT NOT NULL)");
      }
      const text = `${name}(${JSON.stringify(args).slice(1, -1)})`.slice(0, 300);
      interventionsDb.query("INSERT INTO interventions (t, session, actor, text) VALUES (?, ?, 'sdk', ?)").run(Date.now(), leader, text);
    } catch {
      // Logging never stops the action it records, for example outside Bun or without runs/.
    }
  };
  for (const name of ACTIONS) {
    const fn = handle[name];
    if (typeof fn !== "function") continue;
    // Only the outermost call is logged: setLeader's own setBot and resumeBot are part of it.
    handle[name] = async (...args) => {
      depth++;
      try {
        return await fn(...args);
      } finally {
        depth--;
        if (depth === 0) await log(name, args);
      }
    };
  }
}
