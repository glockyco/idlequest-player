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

// Item kinds for `searchAccount`. A search lists at most 200 rows, so it asks for kinds of armor,
// jewelry and weapons one at a time.
const SURVEY_WORDS = ["Bracer", "Ring", "Mask", "Cloak", "Cape", "Boots", "Shoes", "Gloves", "Gauntlets", "Helm", "Cap", "Robe", "Tunic", "Breastplate", "Leggings", "Pants", "Sleeves", "Vambraces", "Belt", "Girdle", "Earring", "Necklace", "Amulet", "Choker", "Shield", "Sword", "Dagger", "Staff", "Mace", "Axe", "Spear", "Bow", "Hammer", "Club", "Wand", "Mantle", "Shoulder", "Collar", "Veil", "Band", "Stud", "Armor", "Coif", "Skullcap", "Wristband", "Greaves", "Jerkin", "Shirt", "Hood", "Scimitar", "Blade", "Rapier", "Flail", "Warhammer", "Knife", "Fist", "Totem", "Idol", "Charm", "Medallion", "Pendant", "Bandolier", "Sash", "Gorget", "Brooch", "Torque", "Circlet", "Crown"];

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
  const [bridge, bot, opcodes, classSpells, questItems, bandRotations] = await Promise.all([
    readFile(new URL("bridge.js", here), "utf8"),
    readFile(new URL("bot.js", here), "utf8"),
    readFile(new URL("../data/opcodes.json", here), "utf8").then(JSON.parse),
    readFile(new URL("../data/class-spells.json", here), "utf8").then(JSON.parse),
    readFile(new URL("../data/quest-items.json", here), "utf8").then(JSON.parse),
    readFile(new URL("../data/band-rotations.json", here), "utf8").then(JSON.parse),
  ]);
  await tab.evaluate(bridge);
  await tab.evaluate((table) => window.iq.setOpcodeNames(table), opcodes);
  // The bot's gem plan reads the client's per-class spell table from window.iq.classSpells, its
  // cleanup keeps the quest turn-in items in window.iq.questItems, and its level-ups set the zone
  // rotation from window.iq.bandRotations.
  await tab.evaluate(
    (table, items, bands) => {
      window.iq.classSpells = table;
      window.iq.questItems = items;
      window.iq.bandRotations = bands;
    },
    classSpells,
    questItems,
    bandRotations,
  );
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
     * Give a carried item to any character on the account (in the party or offline), equipped when
     * `equip` is true. Moves the item to the cursor with the character store's slot move, sends
     * the client's held-item transfer, and puts the item back if the transfer is rejected.
     */
    async giveItem(itemName, characterName, equip = true) {
      const item = (await handle.inventory()).find((r) => r.name === itemName && (r.loc === "bag" || (r.bag === 0 && r.slot >= 22 && r.slot <= 29)));
      if (!item) throw new Error(`no ${itemName} in the bags`);
      const target = (await handle.roster()).party.find((m) => m.name === characterName);
      let characterId = Number(String(target?.id ?? "").replace("character-", ""));
      if (!characterId) {
        characterId = await tab.evaluate((name) => {
          const c = (window.iq.stores.roster?.getState?.().characters ?? []).find((x) => x.name?.toLowerCase() === name.toLowerCase());
          return Number(c?.id || 0);
        }, characterName);
      }
      if (!characterId) throw new Error(`${characterName} is not a character on this account`);
      return tab.evaluate(
        async (from, id, e, expectedName) => {
          const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
          const ch = () => window.iq.stores.character.getState();
          const since = window.iq.seqs.event;
          ch().moveItemToSlot(from, { bag: 0, slot: 30 });
          await sleep(900);
          if (window.iq.bagSpace().cursor !== expectedName) {
            throw new Error(`cursor holds ${window.iq.bagSpace().cursor ?? "nothing"} instead of ${expectedName}`);
          }
          const ok = await window.iq.stores.companions.getState().transferHeldItem(id, e);
          await sleep(900);
          if (window.iq.bagSpace().cursor) {
            ch().moveItemToSlot({ bag: 0, slot: 30 }, from);
            await sleep(700);
          }
          if (window.iq.bagSpace().cursor) {
            throw new Error(`${window.iq.bagSpace().cursor} is still on the cursor; place it before continuing`);
          }
          const lines = window.iq.events.filter((x) => x.seq > since && /equips|transfer|give|cannot|space/i.test(x.text)).map((x) => x.text);
          return { ok, lines };
        },
        { bag: item.bag, slot: item.slot },
        characterId,
        equip,
        itemName,
      );
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
     * Buy `count` of an item from a merchant in the current zone: walk there through the Path To
     * window (the row whose name matches `merchant`), then press PURCHASE once per item. A
     * purchase lands in a free general slot or bag slot, and a container needs a free general
     * slot. Stops early when a purchase adds nothing. Disable the bot first so its cleanup does
     * not sell the purchases. Resolves with the number bought and the platinum left.
     */
    async buyItem(itemName, { count = 1, merchant, timeoutMs = 180000 } = {}) {
      await tab.evaluate(async (who) => {
        const cb = window.iq.stores.combat.getState();
        if (window.iq.stores.merchant.getState().selectedMerchant?.name === who) return;
        if (!cb.isMerchantListOpen) cb.toggleMerchantList();
        let row = null;
        for (let k = 0; k < 20 && !row; k++) {
          await new Promise((r) => setTimeout(r, 250));
          row = [...document.querySelectorAll(".merchant-name")].find((el) => el.textContent.trim() === who && !/QUEST NPC/i.test(el.parentElement?.textContent ?? ""));
        }
        if (!row) throw new Error(`merchant ${who} not found in the Path To list`);
        row.parentElement.click();
      }, merchant);
      const ready = () => tab.evaluate((who, want) => {
        const m = window.iq.stores.merchant.getState();
        if (m.selectedMerchant?.name !== who || m.isLoadingItems || !(m.merchantItems ?? []).length) return false;
        return m.merchantItems.some((i) => i.item?.name === want) ? true : "missing";
      }, merchant, itemName);
      for (let end = Date.now() + timeoutMs, r; (r = await ready()) !== true; await sleep(3000)) {
        if (r === "missing") throw new Error(`${merchant} does not sell ${itemName}`);
        if (Date.now() > end) throw new Error(`${merchant} did not open with ${itemName} for sale`);
      }
      let bought = 0;
      for (let left = count; left > 0; ) {
        const r = await tab.evaluate(async (want, n) => {
          const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
          const have = () => window.iq.stores.character.getState().characterProfile.inventory.filter((x) => x.itemDetails?.name === want).reduce((s, x) => s + Math.max(1, x.charges ?? 1), 0);
          const ms = window.iq.stores.merchant;
          const e = ms.getState().merchantItems.find((i) => i.item?.name === want);
          let got = 0;
          for (let k = 0; k < n; k++) {
            // The PURCHASE button shows only for an item considered from the merchant's side.
            ms.getState().setConsideredItem({ item: e.item, price: e.price, source: "merchant", slot: e.slot });
            await sleep(250);
            const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "PURCHASE");
            if (!b || b.disabled) return { got, stop: true };
            const before = have();
            b.click();
            for (let j = 0; j < 20 && have() === before; j++) await sleep(200);
            if (have() === before) return { got, stop: true };
            got++;
          }
          return { got, stop: false };
        }, itemName, Math.min(left, 10));
        bought += r.got;
        left -= r.got;
        if (r.stop) break;
      }
      const platinum = await tab.evaluate(() => window.iq.stores.character.getState().characterProfile.platinum);
      return { bought, platinum };
    },

    /**
     * Survey the account's items with Inventory Search's own request (opcode 1241, action
     * "search"): one search per word, merged by owner and item instance. A search returns at most
     * 200 rows, so the words are item kinds rather than letters. Rows name the owner, its class and
     * level, the item, and where it is ("Carried", "Equipped", a bank). `save` writes the rows to a
     * file of the repository (relative paths). Read-only. Resolves with the rows.
     */
    async searchAccount({ words = SURVEY_WORDS, save = "runs/state/account-items.json" } = {}) {
      await tab.evaluate((ws) => {
        const p = window.iq.stores.character.getState().characterProfile;
        const job = (window.iq.accountSearch = { done: false, rows: [], capped: [] });
        (async () => {
          const seen = new Map();
          for (const q of ws) {
            const r = await window.iq.socket.sendCorrelatedJsonRequest(1241, 1241, { characterId: p.id, stateSessionId: p.stateSessionId, action: "search", query: q }, 8000);
            if (r?.more) job.capped.push(q);
            for (const m of r?.matches ?? []) seen.set(`${m.characterId}:${m.itemInstanceId}:${m.bankKind ?? ""}`, m);
            await new Promise((res) => setTimeout(res, 250));
          }
          job.rows = [...seen.values()];
          job.done = true;
        })().catch((e) => Object.assign(job, { done: true, error: String(e?.message ?? e) }));
      }, words);
      let job;
      for (;;) {
        await sleep(3000);
        job = await tab.evaluate(() => ({ done: window.iq.accountSearch.done, error: window.iq.accountSearch.error ?? null, capped: window.iq.accountSearch.capped }));
        if (job.done) break;
      }
      if (job.error) throw new Error(`account search failed: ${job.error}`);
      const rows = await tab.evaluate(() => window.iq.accountSearch.rows);
      if (save) await writeFile(repoPath(save), JSON.stringify(rows));
      return rows;
    },

    /**
     * Pull one carried or banked item of another account character to the active character with
     * the Inventory Search window: search the item's name, press the row's Transfer button for
     * `from`, and read the window's reply. The active character needs a free bag slot. Resolves
     * with the reply text, or throws when no transferable row names that owner.
     */
    async pullItem({ itemName, from, timeoutMs = 20000 }) {
      return tab.evaluate(
        async (item, who, ms) => {
          const sleep = (t) => new Promise((r) => setTimeout(r, t));
          const cb = () => window.iq.stores.combat.getState();
          cb().openInventorySearch();
          let panel = null;
          for (let k = 0; k < 25 && !(panel = document.querySelector('[data-testid="inventory-search-panel"]')); k++) await sleep(200);
          if (!panel) throw new Error("Inventory Search did not open");
          const input = panel.querySelector("input");
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, item);
          input.dispatchEvent(new Event("input", { bubbles: true }));
          const label = `Transfer ${item} from ${who}`;
          const end = Date.now() + ms;
          let btn = null;
          while (Date.now() < end && !(btn = [...panel.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === label && !b.disabled))) await sleep(300);
          if (!btn) {
            cb().closeInventorySearch();
            throw new Error(`no transferable ${item} on ${who}`);
          }
          btn.click();
          // The window first shows "Transferring item…", then the result.
          const have = () => window.iq.stores.character.getState().characterProfile.inventory.filter((x) => x.itemDetails?.name === item).length;
          const before = have();
          let reply = null;
          while (Date.now() < end && (!reply || /…$|^Transferring/.test(reply) || (!panel.querySelector('[role="alert"]') && have() === before))) {
            await sleep(300);
            reply = panel.querySelector('[role="status"]')?.textContent || panel.querySelector('[role="alert"]')?.textContent || null;
          }
          cb().closeInventorySearch();
          return reply;
        },
        itemName,
        from,
        timeoutMs,
      );
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
     * Walk to a quest NPC in the current zone through the Path To window, open the dialogue
     * panel, optionally click each matching option in `keywords`, and return the NPC's lines
     * and remaining options. Run inside `pausedAutoLevel`.
     */
    async talkToNpc(npcName, keywords = []) {
      return tab.evaluate(
        async (targetName, kws) => {
          const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
          const cb = window.iq.stores.combat.getState();
          if (!cb.isMerchantListOpen) cb.toggleMerchantList();
          const norm = (s) => String(s ?? "").replace(/_/g, " ").trim().toLowerCase();
          let row = null;
          for (let k = 0; k < 20 && !row; k++) {
            await sleep(250);
            row = [...document.querySelectorAll(".merchant-name")]
              .map((el) => el.parentElement)
              .find((p) => p && /QUEST NPC/i.test(p.textContent ?? "") && norm(p.querySelector(".merchant-name")?.textContent).includes(norm(targetName)));
          }
          if (!row) throw new Error(`quest NPC "${targetName}" not found in Path To list`);
          row.click();
          const waitDialogue = async () => {
            for (let k = 0; k < 60; k++) {
              await sleep(400);
              const loading = [...document.querySelectorAll(".dialogue-entry")].some((el) => /^Loading$/i.test(el.textContent.trim()));
              const hasContent = document.querySelectorAll('[data-testid="quest-npc-dialogue"], [data-testid="quest-dialogue-option"]').length > 0;
              const giveBtn = [...document.querySelectorAll("button")].find((b) => /^Give Items$/i.test((b.textContent ?? "").trim()));
              if (!loading && (hasContent || (giveBtn && !giveBtn.disabled))) return;
            }
          };
          await waitDialogue();
          for (const kw of kws) {
            const opt = [...document.querySelectorAll('[data-testid="quest-dialogue-option"]')].find((b) => norm(b.textContent).includes(norm(kw)));
            if (!opt) throw new Error(`dialogue option "${kw}" not found on ${targetName}`);
            opt.click();
            await sleep(300);
            await waitDialogue();
          }
          const dialogues = [...document.querySelectorAll('[data-testid="quest-npc-dialogue"]')].map((el) => el.textContent.trim());
          const options = [...document.querySelectorAll('[data-testid="quest-dialogue-option"]')].map((el) => el.textContent.trim());
          const giveBtn = [...document.querySelectorAll("button")].find((b) => /^Give Items$/i.test((b.textContent ?? "").trim()));
          return { npcName: targetName, dialogues, options, canGive: Boolean(giveBtn && !giveBtn.disabled) };
        },
        npcName,
        keywords,
      );
    },

    /**
     * Walk to a quest NPC in the current zone, open the Give Items trade window, place up to four
     * carried items (`itemNames`) into the trade slots, click Give, and return the NPC's reply and
     * any reward chat lines. Run inside `pausedAutoLevel`.
     */
    async turnInQuest(npcName, itemNames = []) {
      if (!itemNames.length || itemNames.length > 4) throw new Error("turnInQuest takes 1 to 4 item names");
      await handle.talkToNpc(npcName);
      return tab.evaluate(async (items) => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const since = window.iq.seqs.event;
        const giveItemsBtn = [...document.querySelectorAll("button")].find((b) => /^Give Items$/i.test((b.textContent ?? "").trim()));
        if (!giveItemsBtn || giveItemsBtn.disabled) throw new Error("Give Items button is not available on this NPC");
        giveItemsBtn.click();
        let win = null;
        for (let k = 0; k < 20 && !win; k++) {
          await sleep(200);
          win = document.querySelector('[data-testid="quest-give-window"]');
        }
        if (!win) throw new Error("quest-give-window did not open");
        const slots = [...win.querySelectorAll('[data-testid^="quest-give-slot-"]')].map((el) => Number(el.getAttribute("data-testid").replace("quest-give-slot-", "")));
        const ch = () => window.iq.stores.character.getState();
        const inv = () => ch().characterProfile?.inventory ?? [];
        for (let k = 0; k < items.length; k++) {
          const want = items[k];
          const found = inv().find((x) => (x.bag >= 1 || (x.bag === 0 && x.slot >= 22 && x.slot <= 29)) && x.itemDetails?.name === want);
          if (!found) throw new Error(`item "${want}" not found in bags`);
          ch().moveItemToSlot({ bag: found.bag, slot: found.slot }, { bag: 0, slot: slots[k] });
          await sleep(800);
        }
        const giveBtn = [...win.querySelectorAll("button")].find((b) => /^Give$/i.test((b.textContent ?? "").trim()));
        if (!giveBtn || giveBtn.disabled) throw new Error("Give button in quest-give-window is disabled");
        giveBtn.click();
        for (let k = 0; k < 30 && document.querySelector('[data-testid="quest-give-window"]'); k++) await sleep(300);
        const dialogues = [...document.querySelectorAll('[data-testid="quest-npc-dialogue"]')].map((el) => el.textContent.trim());
        const cb = window.iq.stores.combat.getState();
        if (cb.isNoteOpen) cb.toggleNote();
        const lines = window.iq.events.filter((e) => e.seq > since && /experience|loot|receive|faction|quest/i.test(e.text)).map((e) => e.text);
        return { ok: true, dialogues: dialogues.slice(-2), lines };
      }, itemNames);
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
      // The AutoLevel window's Start button closes the window and calls the store's start
      // (`CVEP2_Ra.js:417418`), as the bot and the guard do. A click can land on a zone-change
      // overlay that still covers the button.
      await tab.evaluate(() => {
        const s = window.iq.stores.combat.getState();
        if (!s.isRunning) s.startAutoLevel();
      });
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

    /**
     * Camp the active character and enter the world as another account character, with the Camp
     * button and the character select screen. The earlier leader and party then rejoin as the new
     * leader's companions, and the bot's `partyIds` is updated so it keeps them grouped. AutoLevel
     * restarts with the same limits if it was running. Tactics need no copying: companions' tactics
     * are keyed by character id, and a leader's own tactics by its id (docs/client-internals.md).
     * `atSelect` runs at character select before entering, for example to create characters.
     * Resolves with the new leader's name, zone and party.
     */
    async switchCharacter(name, { atSelect } = {}) {
      const before = await tab.evaluate(() => {
        const s = window.iq.stores;
        const inWorld = s.screen.getState().currentScreen === "game";
        return {
          inWorld,
          leaderId: inWorld ? s.character.getState().characterProfile?.id ?? null : null,
          chars: (s.roster.getState().characters ?? []).map((c) => ({ id: c.id, name: c.name })),
          partyIds: window.iqBot?.config.partyIds ?? [],
        };
      });
      const target = before.chars.find((c) => c.name.toLowerCase() === String(name).toLowerCase());
      if (!target) throw new Error(`no account character named ${name}`);
      if (target.id === before.leaderId) throw new Error(`${target.name} is already the active character`);
      const party = [...new Set([...before.partyIds, ...(before.leaderId ? [before.leaderId] : [])])].filter((id) => id !== target.id);
      const until = async (what, timeoutMs, fn, ...args) => {
        for (const end = Date.now() + timeoutMs; Date.now() < end; await sleep(1000)) if (await tab.evaluate(fn, ...args)) return;
        throw new Error(`timed out waiting for ${what}`);
      };
      return handle.pausedAutoLevel(async () => {
        if (before.inWorld) {
          await until("the fight to end", 120000, () => !window.iq.stores.skills.getState().inCombat);
          await handle.clearWindows();
          await tab.click('role/button[name="Camp" exact]');
        }
        await until("character select", 90000, () => window.iq.stores.screen.getState().currentScreen === "characterSelect");
        if (atSelect) await atSelect();
        const listed = () => tab.evaluate((n) => [...document.querySelectorAll("button")].some((b) => b.textContent.trim() === n), target.name);
        // Character select shows eight characters per page.
        for (let p = 0; p < 10 && !(await listed()); p++) {
          await tab.click('role/button[name="Next page" exact]');
          await sleep(800);
        }
        // The list stays covered by a transition overlay for a moment after camping.
        for (let k = 0; ; k++) {
          try {
            await tab.click(`role/button[name="${target.name}" exact]`);
            break;
          } catch (e) {
            if (k >= 15) throw e;
            await sleep(1000);
          }
        }
        await tab.click('role/button[name="ENTER WORLD" exact]');
        await until(`${target.name} in the world`, 180000, (id) => {
          const s = window.iq.stores;
          return s.screen.getState().currentScreen === "game" && !s.combat.getState().isZoneLoading && s.character.getState().characterProfile?.id === id;
        }, target.id);
        return tab.evaluate(async (ids) => {
          const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
          const s = window.iq.stores;
          if (window.iqBot) window.iqBot.set({ partyIds: ids });
          const present = () => new Set((s.companions.getState().companions ?? []).filter((c) => c.companionType === 2).map((c) => c.characterId));
          s.companions.getState().requestAccountCharacterAvailability();
          for (const id of ids) {
            await sleep(2500);
            if (!present().has(id)) s.companions.getState().controlAccountCharacter(id);
          }
          for (let k = 0; k < 60 && ids.some((id) => !present().has(id)); k++) await sleep(1000);
          const me = s.character.getState().characterProfile;
          const zone = s.staticData.getState().zones.find((z) => z.zoneidnumber === s.combat.getState().currentZone);
          return { leader: me.name, zone: zone?.longName ?? null, party: (s.companions.getState().companions ?? []).filter((c) => c.companionType === 2).map((c) => c.name), missing: ids.filter((id) => !present().has(id)) };
        }, party);
      });
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
     * Start a bot errand: hunt only enemies whose names match `keep` in `zone` until an item named
     * `item` is in the bags, then rotate on, e.g. `{ zone: "kaesora", keep: "enraged ravener|gorged
     * ravener", item: "Power of Water" }`. Resolves once the party hunts there, because the move
     * can outlast one page evaluation. `errand(null)` ends a running errand.
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
  return handle;
}
