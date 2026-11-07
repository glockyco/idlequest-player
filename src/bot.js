// In-page supervisor for unattended play.
//
// AutoLevel fights, loots and rests by itself. The supervisor does the routine work it leaves to a
// person: it starts AutoLevel again when it stays off without a pause, sells surplus copies before
// the bags fill, and keeps a short report with alerts, so an attached script can check in with one
// call instead of many. It runs on a timer inside the page and keeps working while no script is
// attached, for example while an agent waits for an answer.
//
// Evaluate after src/bridge.js. It reads `window.iq` on every tick, so reinstalling the bridge does
// not stop it. Evaluating this file again replaces the timer and keeps the settings, the alerts,
// the action log and any pause.
(() => {
  const prev = window.iqBot;
  if (prev?.timerId) clearInterval(prev.timerId);

  // Settings changed with `set` are saved in localStorage and override these defaults.
  const KEY = "iqBot.config";
  const DEFAULTS = {
    enabled: true,
    tickSec: 15,
    restartAfterSec: 60, // AutoLevel off this long while not paused: start it again (manual movement input cancels it)
    defaultPauseMin: 20, // a pause ends by itself after this many minutes unless renewed
    minFreeSlots: 8, // start selling surplus copies below this many free bag slots
    targetFreeSlots: 16, // and stop once this many are free
    keepCopies: 1, // copies (or stacks) of each item that are never sold as surplus
    autoBank: true, // when bags run low, first send ingredients and spell scrolls to the tradeskill bank
    junkMaxCopper: 1000, // then sell single items whose merchant price is at most this (1000 = 1 platinum)
    keepItemIds: [10015], // never sold: Malachite, the Magician pet reagent
    // Never sold as cheap single items: spell research pieces, which Auto Bank usually banks first.
    keepNamePattern: "^(Words of|Rune of|Part of|Torn Page|Page of)\\b",
    keepItemTypes: [14, 15], // never sold as cheap single items: food and drink
    sellPerTick: 8,
    cursorAlertSec: 60, // an item held on the cursor this long raises an alert
    cursorPlaceSec: 180, // and after this long the bot puts it away once (0 = never)
    stallMin: 10, // AutoLevel running without XP this long raises an alert
    stuckRestartMin: 3, // running, out of combat and without XP this long: restart AutoLevel (0 = never)
    routeStuckSec: 45, // after "No usable route", no engage, cast or kill this long: restart AutoLevel
    readyStuckSec: 30, // "Waiting for party to be ready" this long with everyone full: restart AutoLevel
    upkeep: true, // after a level-up or new spells, memorize the best spells and replace older pets
    nukeGems: 2, // direct-damage spells to keep memorized
    petGap: 6, // a companion's pet this many levels below its owner is replaced once per owner level
    memoryAlertShare: 0.8, // alert when the page's JS heap passes this share of its limit
    partyIds: [], // account characters to keep in the party; a login starts with none of them
    crowdedWaits: 6, // "Waiting for an available enemy" this often in 10 minutes raises an alert
  };
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(KEY) ?? "{}") ?? {};
  } catch {
    saved = {};
  }
  const config = { ...DEFAULTS, ...saved };

  const fresh = {
    alerts: [], // { seq, t, kind, wake, text }; `wake` marks what an attached script should act on
    alertSeq: 0,
    actions: [], // { t, text }
    pauseUntil: 0,
    pauseReason: null,
    offSince: null,
    restarts: [],
    eventCursor: null, // { ses, seq } of the last chat event looked at
    cursorSince: null,
    cursorAlerted: false,
    offlineSince: null,
    offlineAlerted: false,
    xpSeen: null, // { xp, t } when XP last changed
    stallAlerted: false,
    lootFails: [], // times of "could not loot" messages
    lootAlertAt: 0,
    enemyWaits: [], // times of "Waiting for an available enemy"
    crowdAlertAt: 0,
    noEnemies: [], // times of "No available enemies found in this zone"
    noEnemiesAlertAt: 0,
    rejoinAt: 0,
    zone: null,
    lastError: null,
    upkeepDue: false, // set by level-ups, spell purchases and every install
    upkeepAfter: 0, // not before this time, so purchases after a level-up are scribed first
    upkeepRunning: false,
    petChecked: {}, // owner character id -> owner level at which its pet was last replaced or kept
    memory: [], // [t, used MB] every five minutes
    memoryAlertAt: 0,
  };
  const state = prev?.state ?? fresh;
  for (const [k, v] of Object.entries(fresh)) if (!(k in state)) state[k] = v;
  // A new install may bring new spell rules, so look at gems and pets once.
  state.upkeepDue = true;

  const now = () => Date.now();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const iq = () => window.iq;

  const log = (text) => {
    state.actions.push({ t: now(), text });
    if (state.actions.length > 200) state.actions.splice(0, 50);
    const i = iq();
    if (i?.events && i.seqs) i.events.push({ ses: i.session, seq: ++i.seqs.event, t: now(), type: "bot", text: `[bot] ${text}` });
  };
  const alert = (kind, text, wake = false) => {
    state.alerts.push({ seq: ++state.alertSeq, t: now(), kind, wake, text });
    if (state.alerts.length > 300) state.alerts.splice(0, 100);
    log(`${wake ? "alert" : "note"} ${kind}: ${text}`);
  };

  // Client functions are found by text they contain, because the release build renames exports.
  const findClientFn = (needle) => {
    for (const m of Object.values(iq().mods)) {
      for (const v of Object.values(m)) {
        if (typeof v === "function" && Function.prototype.toString.call(v).includes(needle)) return v;
      }
    }
    throw new Error(`client function containing "${needle}" not found`);
  };

  // The client's own sale call: it sends ShopPlayerSell for the item at (bag, slot), the request the
  // Sell Item button sends for the cursor and a merchant window sends for a selected item.
  let sellAtFn = null;
  const sellAt = (bag, slot) => {
    sellAtFn ??= findClientFn("Sale confirmation was interrupted");
    return sellAtFn(bag, slot);
  };
  // The call behind the Auto Bank macro: it sends crafting ingredients and spell scrolls to the
  // tradeskill bank by courier. Nothing is sold or destroyed.
  let autoBankFn = null;
  const autoBank = () => {
    autoBankFn ??= findClientFn("No eligible ingredients or spell scrolls found");
    return autoBankFn();
  };

  const characterNames = (i) => {
    const p = i.stores.character.getState().characterProfile ?? {};
    const comps = i.stores.companions.getState().companions ?? [];
    return new Set([p.name, ...comps.filter((c) => c.companionType === 0 || c.companionType === 2).map((c) => c.name)]);
  };

  /**
   * Carried items that can be sold, cheapest loss first. Skips containers, NO DROP and NO RENT
   * items, items without a merchant price, `keepItemIds`, equipped items, the cursor and bags
   * marked No Sell, whose copies count as kept.
   * First come the copies or stacks of an item beyond `keepCopies` (largest stacks kept), then,
   * with `cheap`, single items whose merchant price is at most `junkMaxCopper`, lowest total value
   * first. Dearer single items are left for hand-downs or a person to review.
   */
  const surplus = (i, cheap = false) => {
    const inv = i.stores.character.getState().characterProfile?.inventory ?? [];
    const noSell = new Set(i.stores.combat.getState().noAutoSellBagInstanceIds ?? []);
    const general = new Map(inv.filter((r) => r.bag === 0 && r.slot >= 22 && r.slot <= 29).map((r) => [r.slot, r]));
    const kept = new Map();
    const groups = new Map();
    for (const r of inv) {
      const loose = r.bag === 0 && r.slot >= 22 && r.slot <= 29;
      if (!loose && !(r.bag >= 23 && r.bag <= 30)) continue;
      const d = r.itemDetails;
      if (!d || (d.bagslots || 0) > 0) continue;
      if (!loose && noSell.has(general.get(r.bag - 1)?.itemInstanceId)) {
        kept.set(r.itemid, (kept.get(r.itemid) ?? 0) + 1);
        continue;
      }
      if (d.nodrop === 0 || d.norent === 0 || !(d.price > 0) || config.keepItemIds.includes(r.itemid)) continue;
      if (!groups.has(r.itemid)) groups.set(r.itemid, []);
      groups.get(r.itemid).push(r);
    }
    const row = (r, copies) => ({ bag: r.bag, slot: r.slot, id: r.itemid, instanceId: r.itemInstanceId, name: r.itemDetails.Name ?? r.itemDetails.name, quantity: r.quantity ?? 1, price: r.itemDetails.price, copies });
    const keepName = new RegExp(config.keepNamePattern, "i");
    const cheapOk = (r) => r.itemDetails.price <= config.junkMaxCopper && !config.keepItemTypes.includes(r.itemDetails.itemtype) && !keepName.test(r.itemDetails.Name ?? r.itemDetails.name ?? "");
    const extra = [];
    const single = [];
    for (const [id, rows] of groups) {
      rows.sort((a, b) => (b.quantity ?? 1) - (a.quantity ?? 1));
      const keep = Math.max(0, config.keepCopies - (kept.get(id) ?? 0));
      for (const r of rows.slice(keep)) extra.push(row(r, rows.length));
      if (cheap) for (const r of rows.slice(0, keep)) if (cheapOk(r)) single.push(row(r, rows.length));
    }
    extra.sort((a, b) => b.copies - a.copies || a.price - b.price);
    single.sort((a, b) => a.price * a.quantity - b.price * b.quantity);
    return [...extra, ...single];
  };

  const sellSurplus = async (i) => {
    let space = i.bagSpace();
    if (space.cursor || space.free >= config.minFreeSlots) return;
    // Banking loses nothing, so it goes first, at most every ten minutes because the courier is slow.
    if (config.autoBank && now() - (state.bankAt ?? 0) > 600000) {
      state.bankAt = now();
      const r = await autoBank().catch((e) => ({ success: false, message: String(e?.message ?? e) }));
      const after = i.bagSpace().free;
      if (r?.success || after > space.free) log(`auto bank: ${r?.message ?? "done"}; ${after} slots free`);
      space = i.bagSpace();
      if (space.free >= config.minFreeSlots) return;
    }
    let free = space.free;
    let sold = 0;
    let copper = 0;
    const names = [];
    for (const s of surplus(i, true)) {
      if (free >= config.targetFreeSlots || sold >= config.sellPerTick) break;
      // The client sells whatever sits at (bag, slot) when the call runs, so check it is still ours.
      const row = (i.stores.character.getState().characterProfile?.inventory ?? []).find((r) => r.bag === s.bag && r.slot === s.slot);
      if (row?.itemInstanceId !== s.instanceId) break;
      const r = await sellAt(s.bag, s.slot);
      if (!r?.success) {
        log(`sale of ${s.name} at ${s.bag}/${s.slot} stopped: ${r?.message ?? "no reply"}`);
        break;
      }
      sold++;
      free++;
      copper += r.data?.copperTotal ?? 0;
      names.push(s.quantity > 1 ? `${s.quantity} ${s.name}` : s.name);
      await sleep(400);
    }
    if (sold) log(`sold ${sold} surplus item(s) for ${copper} copper (${names.join(", ")}); ${i.bagSpace().free} slots free`);
  };

  const keepAutoLevel = (i, cb) => {
    if (cb.isRunning) {
      state.offSince = null;
      return;
    }
    if (now() < state.pauseUntil || i.guard?.phase === "leaving" || !i.socket.isConnected) return;
    state.offSince ??= now();
    if (now() - state.offSince < config.restartAfterSec * 1000) return;
    cb.startAutoLevel();
    state.offSince = now(); // give the start a full interval before trying again
    state.restarts = state.restarts.filter((t) => t > now() - 3600000);
    state.restarts.push(now());
    const repeated = state.restarts.length >= 3;
    alert("autoLevelRestarted", `AutoLevel was off for ${config.restartAfterSec}s without a pause; started it again${repeated ? ` (${state.restarts.length} times this hour)` : ""}`, repeated);
  };

  const scanEvents = (i) => {
    const evs = i.events ?? [];
    const c = state.eventCursor;
    const after = (e) => !c || (e.ses ?? 0) > c.ses || ((e.ses ?? 0) === c.ses && e.seq > c.seq);
    // The first scan after an install only sets the cursor, so old lines raise no alerts.
    if (!c) {
      const last = evs.at(-1);
      state.eventCursor = last ? { ses: last.ses ?? 0, seq: last.seq } : { ses: 0, seq: 0 };
      return;
    }
    const names = characterNames(i);
    // Take the new lines first: alerts below append the bot's own lines to the same array, and
    // reading those back would match the same patterns again without end.
    const fresh = evs.filter(after);
    if (fresh.length) state.eventCursor = { ses: fresh.at(-1).ses ?? 0, seq: fresh.at(-1).seq };
    for (const e of fresh) {
      if (e.type === "bot") continue;
      const text = e.text ?? "";
      let m;
      if ((m = /^You have gained a level! Welcome to level (\d+)/.exec(text))) {
        alert("levelUp", text, true);
        // The game reminds about missing merchant spells right after a level-up and the chore buys
        // them, so give that a minute before choosing gems.
        state.upkeepDue = true;
        state.upkeepAfter = now() + 60000;
      } else if ((m = /^(.+?) has reached level (\d+)/.exec(text))) {
        alert("memberLevelUp", text);
        state.upkeepDue = true;
        state.upkeepAfter = Math.max(state.upkeepAfter, now() + 60000);
      } else if (e.type === "chore" && /bought spells/.test(text)) state.upkeepDue = true;
      else if ((m = /^(.+?) has been slain!/.exec(text)) || /^You have been slain/.test(text)) {
        const who = m?.[1] ?? "You";
        alert("death", text, who === "You" || names.has(who));
      } else if (/inventory is full, you could not loot/i.test(text)) state.lootFails.push(e.t ?? now());
      else if (/^Waiting for an available enemy/.test(text)) state.enemyWaits.push(e.t ?? now());
      else if (/^No usable route\. Recovering near/.test(text)) state.routeRecoverAt = e.t ?? now();
      else if (/^Waiting for party to be ready/.test(text)) state.readyWaitAt = e.t ?? now();
      else if (/^You (engage .+ in combat|begin casting)|^You have defeated/.test(text)) state.routeRecoverAt = state.readyWaitAt = null;
      else if (/^No available enemies found in this zone/.test(text)) state.noEnemies.push(e.t ?? now());
      else if (e.type === "guard" && /lowering the AutoLevel cap|did NOT restart|failed/.test(text)) alert("guard", text, true);
    }
  };

  const watchLoot = (i) => {
    state.lootFails = state.lootFails.filter((t) => t > now() - 600000);
    if (state.lootFails.length && now() - state.lootAlertAt > 1800000) {
      state.lootAlertAt = now();
      const sp = i.bagSpace();
      alert("lootFull", `${state.lootFails.length} item(s) left on corpses in 10 minutes; ${sp.free} bag slots free${sp.cursor ? `, cursor holds ${sp.cursor}` : ""}`, true);
    }
  };

  // The client's auto-place call, which puts the cursor item into the first place that fits.
  let autoPlaceFn = null;
  const autoPlace = () => {
    autoPlaceFn ??= findClientFn("Auto-placing");
    return autoPlaceFn();
  };

  const watchCursor = async (i) => {
    const held = i.bagSpace().cursor;
    if (!held) {
      state.cursorSince = null;
      state.cursorAlerted = false;
      state.cursorPlaced = false;
      return;
    }
    state.cursorSince ??= now();
    const heldSec = (now() - state.cursorSince) / 1000;
    if (!state.cursorAlerted && heldSec > config.cursorAlertSec) {
      state.cursorAlerted = true;
      alert("cursor", `${held} has been on the cursor for over ${config.cursorAlertSec}s; looting and cleanup need a free cursor`, true);
    }
    // A person may be holding it on purpose, so wait longer before putting it away, and try once.
    if (!state.cursorPlaced && config.cursorPlaceSec > 0 && heldSec > config.cursorPlaceSec) {
      state.cursorPlaced = true;
      const r = await autoPlace();
      await sleep(1500);
      const still = i.bagSpace().cursor;
      log(`auto-placed cursor item ${held}: ${r?.message ?? "no reply"}${still ? `; cursor still holds ${still}` : ""}`);
    }
  };

  const partyFull = (i) => {
    const p = i.stores.character.getState().characterProfile ?? {};
    const full = (hp, maxHp, mana, maxMana) => hp >= maxHp && (!(maxMana > 0) || mana >= maxMana);
    return full(p.curHp, p.maxHp, p.mana, p.maxMana) && (i.stores.companions.getState().companions ?? []).every((c) => c.isDead || full(c.curHp, c.maxHp, c.curMana, c.maxMana));
  };

  const watchXp = (i, cb) => {
    const xp = i.stores.character.getState().characterProfile?.experienceProgress?.current;
    if (xp == null) return;
    if (!state.xpSeen || state.xpSeen.xp !== xp || !cb.isRunning) {
      state.xpSeen = { xp, t: now() };
      state.stallAlerted = false;
      return;
    }
    const idleMin = (now() - state.xpSeen.t) / 60000;
    const inCombat = !!i.stores.skills?.getState?.().inCombat;
    const restart = (why) => {
      state.stuckRestartAt = now();
      state.routeRecoverAt = state.readyWaitAt = null;
      cb.setIsRunning(false);
      setTimeout(() => iq()?.stores.combat.getState().startAutoLevel(), 1500);
      alert("stuckRestart", `${why}; restarted AutoLevel`, false);
    };
    if (inCombat || now() < state.pauseUntil) return;
    // The game's route recovery ("No usable route. Recovering near ...") usually finds a new target
    // within a second, but can also leave AutoLevel on and idle for good. Stopping and starting it
    // picks a new target.
    if (state.routeRecoverAt && now() - state.routeRecoverAt > config.routeStuckSec * 1000) {
      restart(`route recovery found no target in ${config.routeStuckSec}s`);
      return;
    }
    // AutoLevel waits for full HP and mana before each pull. Waiting on with everyone full is the
    // same kind of hang.
    if (state.readyWaitAt && now() - state.readyWaitAt > config.readyStuckSec * 1000 && partyFull(i)) {
      restart(`waited ${Math.round((now() - state.readyWaitAt) / 1000)}s for a party that was already full`);
      return;
    }
    // Any other hang: running, out of combat and no XP for a few minutes.
    if (config.stuckRestartMin > 0 && idleMin > config.stuckRestartMin && now() - (state.stuckRestartAt ?? 0) > config.stuckRestartMin * 60000) {
      restart(`${Math.round(idleMin)} minutes out of combat without XP`);
    }
    if (!state.stallAlerted && idleMin > config.stallMin) {
      state.stallAlerted = true;
      alert("xpStall", `AutoLevel has run ${config.stallMin} minutes without gaining XP`, true);
    }
  };

  const watchConnection = (i) => {
    const ok = i.socket.isConnected && i.stores.screen.getState().currentScreen === "game";
    if (ok) {
      state.offlineSince = null;
      state.offlineAlerted = false;
      return;
    }
    state.offlineSince ??= now();
    if (!state.offlineAlerted && now() - state.offlineSince > 60000) {
      state.offlineAlerted = true;
      alert("offline", `not in the game world for over a minute (screen ${i.stores.screen.getState().currentScreen}, connected ${i.socket.isConnected})`, true);
    }
  };

  // Other players clearing the same spawns leave AutoLevel waiting for enemies.
  const watchCrowding = (i) => {
    state.enemyWaits = state.enemyWaits.filter((t) => t > now() - 600000);
    if (state.enemyWaits.length >= config.crowdedWaits && now() - state.crowdAlertAt > 1800000) {
      state.crowdAlertAt = now();
      const z = i.stores.staticData.getState().zones.find((x) => x.zoneidnumber === i.stores.combat.getState().currentZone);
      alert("crowded", `AutoLevel waited for an available enemy ${state.enemyWaits.length} times in 10 minutes in ${z?.longName ?? "this zone"}`, true);
    }
  };

  // "No available enemies found in this zone" means nothing passes AutoLevel's con and level
  // filters (spawns it failed to reach are skipped for five minutes), and the game then switches
  // AutoLevel off. Undo what can be undone here: limits the guard tightened, then a raised minimum
  // con. Otherwise the zone does not fit the party, so wake an attached script to choose another.
  const watchNoEnemies = (i) => {
    state.noEnemies = state.noEnemies.filter((t) => t > now() - 300000);
    if (state.noEnemies.length < 3) return;
    const cb = i.stores.combat.getState();
    const g = i.guard;
    state.noEnemies = [];
    if (g?.preferred) {
      const p = g.preferred;
      g.preferred = null;
      cb.setMaxCon(p.maxCon);
      cb.setMinCon(p.minCon);
      cb.setMaxLevelDiff(p.maxLevelDiff);
      log(`no enemies at the guard's tightened limits; back to con ${p.minCon}..${p.maxCon}, cap ${p.maxLevelDiff}`);
    } else if (cb.minCon > 4) {
      cb.setMinCon(4);
      log(`no enemies at minimum con ${cb.minCon}; lowered it to blue (4)`);
    } else if (now() - state.noEnemiesAlertAt > 900000) {
      state.noEnemiesAlertAt = now();
      const z = i.stores.staticData.getState().zones.find((x) => x.zoneidnumber === cb.currentZone);
      alert("noEnemies", `no enemies within con ${cb.minCon}..${cb.maxCon}, cap ${cb.maxLevelDiff} in ${z?.longName ?? "this zone"} at level ${i.stores.character.getState().characterProfile?.level}`, true);
    }
  };

  // After a login or reload the party holds no account characters, and AutoLevel would hunt alone.
  const keepParty = (i) => {
    if (!config.partyIds.length || i.stores.skills.getState().inCombat || now() - state.rejoinAt < 120000) return;
    const cs = i.stores.companions.getState();
    const present = new Set((cs.companions ?? []).filter((c) => c.companionType === 2).map((c) => c.characterId));
    const missing = config.partyIds.filter((id) => !present.has(id));
    if (!missing.length) return;
    state.rejoinAt = now();
    cs.requestAccountCharacterAvailability();
    missing.forEach((id, k) => setTimeout(() => i.stores.companions.getState().controlAccountCharacter(id), 2500 * (k + 1)));
    alert("rejoin", `asked ${missing.length} account character(s) to rejoin the party: ${missing.join(", ")}`);
  };

  const watchZone = (i, cb) => {
    if (state.zone !== null && state.zone !== cb.currentZone) {
      const z = i.stores.staticData.getState().zones.find((x) => x.zoneidnumber === cb.currentZone);
      alert("zone", `now in ${z?.longName ?? cb.currentZone}`);
    }
    state.zone = cb.currentZone;
  };

  // ---- Spells and pets after level-ups -----------------------------------------------------
  // The active character casts only memorized spells, and a living pet is kept when its owner
  // levels (wiki: AutoLevel, Companions). So after a level-up or a spell purchase the bot puts the
  // best learned summon, direct-damage spells and pet heal into the first gems, and replaces a pet
  // that an older summon or tier made.
  //
  // The client's spellbook entries carry no effect data, so the Magician roles come from the
  // content snapshot's spells_new: [spell id, Magician level, damage cap]. Summons are the water
  // pet line (effect 33). Nukes are single-target direct damage (effect 0, negative base, no
  // duration, target type 1 or 5) without the summoned-only spells. Pet heals are effect 0 with a
  // positive base on the pet target (14).
  const ROLES = {
    summon: [[315, 4, 0], [398, 8, 0], [402, 12, 0], [336, 16, 0], [497, 20, 0], [570, 24, 0], [574, 29, 0], [621, 34, 0], [625, 39, 0], [629, 44, 0], [633, 49, 0], [1672, 54, 0], [1676, 60, 0]],
    nuke: [[93, 1, 5], [94, 4, 14], [324, 8, 35], [322, 8, 47], [334, 16, 96], [68, 20, 156], [113, 24, 176], [120, 34, 295], [69, 34, 333], [114, 44, 600], [70, 49, 810], [1660, 52, 702], [1661, 54, 525], [1663, 57, 825], [1664, 59, 1024], [2540, 60, 1294], [2118, 60, 1350]],
    petHeal: [[1504, 8, 50], [1505, 20, 0], [3584, 34, 175], [2536, 52, 611], [2896, 60, 873]],
  };
  const isSummon = (id) => ROLES.summon.some(([s]) => s === id);
  const spellPlan = (i) => {
    const book = new Map((i.stores.spellbook.getState().scribedSpells ?? []).map((x) => [x.spellId, x.spell?.name]));
    const best = (role, n) =>
      ROLES[role]
        .filter(([id]) => book.has(id))
        .sort((a, b) => b[1] - a[1] || b[2] - a[2])
        .slice(0, n)
        .map(([id, level]) => ({ id, name: book.get(id), level }));
    return [...best("summon", 1), ...best("nuke", config.nukeGems), ...best("petHeal", 1)];
  };

  const runUpkeep = async (i, reason) => {
    if (state.upkeepRunning) return "already running";
    state.upkeepRunning = true;
    const cb = () => i.stores.combat.getState();
    const sb = () => i.stores.spellbook.getState();
    const me = i.stores.character.getState().characterProfile;
    const done = [];
    let stopped = false;
    try {
      const plan = spellPlan(i);
      const gems = new Map((sb().memorizedSpells ?? []).map((m) => [m.gemSlot, m.spellId]));
      const changes = plan.map((p, gem) => ({ ...p, gem })).filter((p) => gems.get(p.gem) !== p.id);
      const oldSummon = gems.get(0);
      const newSummon = plan[0] && isSummon(plan[0].id) ? plan[0].id : null;
      const pets = (i.stores.companions.getState().companions ?? []).filter((c) => c.companionType === 1);
      const comps = i.stores.companions.getState().companions ?? [];
      const ownerLevel = (ownerId) => (ownerId === me.id ? me.level : comps.find((c) => c.characterId === ownerId)?.level);
      // Our own pet goes when gem 0 gets another summon. A companion's pet goes when it is far below
      // its owner, once per owner level, so a pet with no better tier is not replaced in a loop.
      const replace = pets.filter((pet) => {
        const owner = pet.petOwnerCharacterId;
        if (owner === me.id) return newSummon && oldSummon !== newSummon && changes.some((c) => c.gem === 0);
        const lvl = ownerLevel(owner);
        return lvl && lvl - pet.level >= config.petGap && state.petChecked[owner] !== lvl;
      });
      if (!changes.length && !replace.length) return "nothing to change";

      // Stand still out of combat, as the client requires for memorizing.
      state.pauseUntil = Math.max(state.pauseUntil, now() + 5 * 60000);
      state.pauseReason = `upkeep (${reason})`;
      if (cb().isRunning) {
        cb().setIsRunning(false);
        stopped = true;
      }
      for (let k = 0; k < 90 && i.stores.skills.getState().inCombat; k++) await sleep(1000);
      if (i.stores.skills.getState().inCombat) throw new Error("still in combat after 90 s");

      if (changes.length) {
        for (let k = 0; k < 5 && !cb().isPlayerSitting; k++) {
          cb().setPlayerSitting(true);
          await sleep(600);
        }
        if (!cb().isSpellbookOpen) cb().toggleSpellbook();
        await sleep(800);
        for (const c of changes) {
          // The client refuses a spell that sits in another gem, so free that gem first.
          const elsewhere = (sb().memorizedSpells ?? []).find((m) => m.spellId === c.id && m.gemSlot !== c.gem);
          if (elsewhere) await sb().unmemorizeSpell(elsewhere.gemSlot);
          const ok = await sb().memorizeSpell(c.id, c.gem);
          done.push(`gem ${c.gem} ${c.name}${ok ? "" : " FAILED"}`);
          await sleep(400);
        }
        if (cb().isSpellbookOpen) cb().toggleSpellbook();
        cb().setPlayerSitting(false);
      }
      for (const pet of replace) {
        i.stores.companions.getState().dismissPet(pet.id);
        if (pet.petOwnerCharacterId !== me.id) state.petChecked[pet.petOwnerCharacterId] = ownerLevel(pet.petOwnerCharacterId);
        done.push(`replaced pet ${pet.name} L${pet.level}`);
        await sleep(1000);
      }
      return done.join(", ");
    } finally {
      if (stopped || state.pauseReason?.startsWith("upkeep")) {
        state.pauseUntil = 0;
        state.pauseReason = null;
      }
      if (stopped) cb().startAutoLevel();
      state.upkeepRunning = false;
      if (done.length) alert("upkeep", `${reason}: ${done.join(", ")}`);
    }
  };

  const upkeepIfDue = async (i) => {
    if (!config.upkeep || !state.upkeepDue || now() < state.upkeepAfter || now() < state.pauseUntil) return;
    state.upkeepDue = false;
    const r = await runUpkeep(i, "level or spells changed");
    if (r !== "nothing to change") log(`upkeep: ${r}`);
  };

  // ---- Page memory -------------------------------------------------------------------------
  // The game tab's renderer has crashed after many hours, so keep a memory trend for evidence.
  const watchMemory = () => {
    const m = performance.memory;
    if (!m) return;
    const t = now();
    if (!state.memory.length || t - state.memory.at(-1)[0] >= 300000) {
      state.memory.push([t, Math.round(m.usedJSHeapSize / 1048576)]);
      if (state.memory.length > 300) state.memory.splice(0, 50);
    }
    const share = m.usedJSHeapSize / m.jsHeapSizeLimit;
    if (share > config.memoryAlertShare && t - state.memoryAlertAt > 3600000) {
      state.memoryAlertAt = t;
      alert("memory", `page JS heap at ${Math.round(m.usedJSHeapSize / 1048576)} of ${Math.round(m.jsHeapSizeLimit / 1048576)} MB`, true);
    }
  };

  let ticking = false;
  const tick = async () => {
    if (!config.enabled || ticking) return;
    ticking = true;
    try {
      const i = iq();
      if (!i?.stores || typeof i.bagSpace !== "function") return;
      watchConnection(i);
      const cb = i.stores.combat.getState();
      if (i.stores.screen.getState().currentScreen !== "game" || cb.isZoneLoading || !i.stores.character.getState().characterProfile?.id) return;
      scanEvents(i);
      watchZone(i, cb);
      await watchCursor(i);
      watchLoot(i);
      watchCrowding(i);
      watchNoEnemies(i);
      keepParty(i);
      watchXp(i, cb);
      keepAutoLevel(i, cb);
      watchMemory();
      await upkeepIfDue(i);
      await sellSurplus(i);
      state.lastError = null;
    } catch (e) {
      const msg = String(e?.message ?? e);
      if (state.lastError !== msg) log(`tick failed: ${msg}`);
      state.lastError = msg;
    } finally {
      ticking = false;
    }
  };

  const bot = {
    config,
    state,
    timerId: setInterval(tick, config.tickSec * 1000),
    tick,
    /** What the next cleanup would sell, in order: extra copies, then cheap single items. */
    surplus: () => surplus(iq(), true),
    /** The gems the upkeep would set: best summon, direct-damage spells and pet heal, in gem order. */
    spellPlan: () => spellPlan(iq()),
    /** Memorize the planned gems and replace older pets now, out of combat. Returns what changed. */
    upkeep: (reason = "manual") => runUpkeep(iq(), reason),

    /**
     * Change settings, e.g. `{ minFreeSlots: 12 }` or `{ enabled: false }`. They persist in this
     * browser. `null` restores a setting's default.
     */
    set(partial) {
      for (const [k, v] of Object.entries(partial)) {
        if (v === null) {
          delete saved[k];
          config[k] = DEFAULTS[k];
        } else {
          saved[k] = v;
          config[k] = v;
        }
      }
      localStorage.setItem(KEY, JSON.stringify(saved));
      if ("tickSec" in partial) {
        clearInterval(bot.timerId);
        bot.timerId = setInterval(tick, config.tickSec * 1000);
      }
      return config;
    },

    /** Let AutoLevel stay off for `minutes`. A pause always ends by itself; renew it to extend it. */
    pause(minutes = config.defaultPauseMin, reason = "") {
      state.pauseUntil = now() + minutes * 60000;
      state.pauseReason = reason || null;
      log(`pause for ${minutes} min${reason ? `: ${reason}` : ""}`);
      return new Date(state.pauseUntil).toISOString();
    },

    /** End a pause now. AutoLevel starts again within `restartAfterSec` if it is off. */
    resume() {
      if (state.pauseUntil) log("pause ended");
      state.pauseUntil = 0;
      state.pauseReason = null;
      return true;
    },

    /**
     * Compact state for an attached script: level, XP rate over the last 30 minutes, kills, bag
     * space, AutoLevel limits, recent actions, and alerts after `sinceSeq`. Alerts with `wake` are
     * listed in full; the others are trimmed to the latest eight.
     */
    report(sinceSeq = 0) {
      const i = iq();
      const p = i.stores.character.getState().characterProfile ?? {};
      const cb = i.stores.combat.getState();
      const t = now();
      const lastHalfHour = (i.samples ?? []).filter((s) => s.t >= t - 1800000 && s.xp != null);
      const first = lastHalfHour[0];
      const last = lastHalfHour.at(-1);
      const xpPerHour = first && last && last.t - first.t > 300000 ? Math.round(((last.xp - first.xp) / (last.t - first.t)) * 3600000) : null;
      const withVis = lastHalfHour.filter((s) => s.vis != null);
      const newer = state.alerts.filter((a) => a.seq > sinceSeq);
      const zone = i.stores.staticData.getState().zones.find((z) => z.zoneidnumber === cb.currentZone);
      return {
        t: new Date(t).toISOString(),
        enabled: config.enabled,
        paused: state.pauseUntil > t ? { until: new Date(state.pauseUntil).toISOString(), reason: state.pauseReason } : null,
        zone: zone?.longName ?? cb.currentZone,
        level: p.level,
        levelPct: p.experienceProgress ? p.experienceProgress.progressBasisPoints / 100 : null,
        xpPerHour,
        kills30m: (i.kills ?? []).filter((k) => k.t >= t - 1800000).length,
        // Share of the last 30 minutes the tab was visible. Hidden tabs get throttled timers.
        visible30m: withVis.length ? Math.round((100 * withVis.filter((s) => s.vis === 1).length) / withVis.length) / 100 : null,
        bags: i.bagSpace(),
        // JS heap in MB now and its limit, plus one value every five minutes for the last hour.
        memoryMB: performance.memory ? { used: Math.round(performance.memory.usedJSHeapSize / 1048576), limit: Math.round(performance.memory.jsHeapSizeLimit / 1048576), trend: state.memory.slice(-12).map(([, mb]) => mb) } : null,
        autoLevel: { running: cb.isRunning, minCon: cb.minCon, maxCon: cb.maxCon, maxLevelDiff: cb.maxLevelDiff },
        alertSeq: state.alertSeq,
        alerts: [...newer.filter((a) => a.wake), ...newer.filter((a) => !a.wake).slice(-8)].sort((a, b) => a.seq - b.seq).map((a) => ({ ...a, t: new Date(a.t).toISOString() })),
        recent: state.actions.slice(-5).map((a) => `${new Date(a.t).toISOString().slice(11, 19)} ${a.text}`),
      };
    },
  };

  window.iqBot = bot;
  if (window.iq) window.iq.bot = bot;
  log(`installed (tick ${config.tickSec}s, restart after ${config.restartAfterSec}s, sell below ${config.minFreeSlots} free slots)`);
  return { installed: true, config };
})();
