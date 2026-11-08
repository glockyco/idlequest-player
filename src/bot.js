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
  if (prev?.fastTimerId) clearInterval(prev.fastTimerId);

  // Settings changed with `set` override these defaults and are saved in the tab's sessionStorage.
  // It survives reloads of that tab, and a second session's tab does not see it, so two groups
  // never share a party list.
  const KEY = "iqBot.config";
  const DEFAULTS = {
    enabled: true,
    tickSec: 15,
    fastTickSec: 2, // Auto Attack and root checks, which lose play time for every second they wait
    restartAfterSec: 60, // AutoLevel off this long while not paused: start it again (manual movement input cancels it)
    defaultPauseMin: 20, // a pause ends by itself after this many minutes unless renewed
    minFreeSlots: 8, // start selling surplus copies below this many free bag slots
    targetFreeSlots: 16, // and stop once this many are free
    keepCopies: 1, // copies (or stacks) of each item that are never sold as surplus
    autoBank: true, // when bags run low, first send ingredients and spell scrolls to the tradeskill bank
    junkMaxCopper: 8000, // then sell single items whose merchant price is at most this (1000 = 1 platinum)
    keepItemIds: [10015], // never sold, besides the reagents of the leader's own spells
    // Never sold as cheap single items: spell research pieces, which Auto Bank usually banks first.
    keepNamePattern: "^(Words of|Rune of|Part of|Torn Page|Page of)\\b",
    keepItemTypes: [14, 15], // never sold as cheap single items: food and drink
    sellPerTick: 8,
    cursorAlertSec: 60, // an item held on the cursor this long raises an alert
    cursorPlaceSec: 180, // and after this long the bot puts it away once (0 = never)
    stallMin: 10, // AutoLevel running without XP this long raises an alert
    deathsPerHourAlert: 6, // party deaths within an hour that wake a script; single deaths are notes
    stuckRestartMin: 3, // running, out of combat and without XP this long: restart AutoLevel (0 = never)
    routeStuckSec: 8, // after "No usable route", no engage, cast or kill this long: restart AutoLevel
    readyStuckSec: 30, // "Waiting for party to be ready" this long with everyone full: restart AutoLevel
    attackWaitSec: 3, // a pull standing at its target with Auto Attack off this long: turn it on
    dispelRoots: true, // dispel a root that holds the readiness wait when that saves time (dispelRoots)
    dispelCycleSec: 9, // seconds between one member's dispel attempts between fights
    dispelOverheadSec: 6, // the extra pass and mana refill a dispel costs the readiness wait
    dispelMinSavedSec: 10, // turn dispels on only when they are expected to save this much
    upkeep: true, // after a level-up or new spells, memorize the best spells and replace older pets
    nukeGems: 1, // direct-damage spells to keep memorized (a Wizard keeps at least three)
    dotGems: 1, // damage-over-time spells to keep memorized, for classes whose table has them
    buffGems: 1, // self-buffs to keep memorized (a Bard's three gems are all songs)
    // Among equal-level summons, the one whose name has this. The Magician's four elements hit the
    // same in melee at every tier (npc_types), and Water adds a damage spell and more HP than Fire
    // or Air. Earth has the most HP and no damage spell.
    petPreference: "Water",
    petGap: 6, // a companion's pet this many levels below its owner is replaced once per owner level
    memoryAlertShare: 0.8, // alert when the page's JS heap passes this share of its limit
    partyIds: [], // account characters to keep in the party; a login starts with none of them
    crowdedWaits: 6, // "Waiting for an available enemy" this often in 10 minutes moves to another rotation zone, or raises an alert without one
    // Regular expression of enemy names AutoLevel should not pick, e.g. "shaman|idealist" for the
    // Root casters in Guk; empty to pick everything. Such enemies can still join a fight.
    avoidNames: "",
    rotation: [], // zone short names to cycle through as the reachable spawns run out, e.g. ["permafrost", "guktop"]
    rotateBelowShare: 0.6, // move on when the last 10 minutes earned less than this share of the visit's best
    rotateMinStayMin: 20, // and only after this many minutes in the zone
    rotateEscapes: 4, // guard escapes in this zone within 10 minutes rotate immediately (0 = never)
    autoBandRotation: true, // update `rotation` from the band table when the leader enters a new level band
    respawnAfterSec: 20, // a dead leader takes the free respawn at the bind point after this long (0 = never)
    outsideRotationSec: 60, // a party this long in a zone outside `rotation` moves to its first zone (0 = never)
    releaseProbeMin: 10, // ask the site this often whether a newer client release is served (0 = never)
  };
  let saved = {};
  try {
    saved = JSON.parse(sessionStorage.getItem(KEY) ?? "{}") ?? {};
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
    deaths: [], // times of party deaths
    deathAlertAt: 0,
    rejoinAt: 0,
    releaseChecked: null, // client release the page was last compared with the stored one
    releaseProbeAt: 0, // when the site was last asked which client release it serves
    remoteRelease: null, // the newer release already alerted about
    zone: null,
    lastError: null,
    upkeepDue: false, // set by level-ups, spell purchases and every install
    upkeepAfter: 0, // not before this time, so purchases after a level-up are scribed first
    upkeepRunning: false,
    petChecked: {}, // owner character id -> owner level at which its pet was last replaced or kept
    memory: [], // [t, used MB] every five minutes
    memoryAlertAt: 0,
    errand: null, // { zone, keep, item, minutes, minCon, limits, arrived, since, until } while an errand runs
  };
  const state = prev?.state ?? fresh;
  for (const [k, v] of Object.entries(fresh)) if (!(k in state)) state[k] = v;
  // A new install may bring new spell rules, so look at gems and pets once.
  state.upkeepDue = true;

  const now = () => Date.now();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const iq = () => window.iq;
  // The client's game runtime: combat scene, target approach and the Auto Attack button's handler.
  const runtime = (i) => Object.values(i.mods ?? {}).flatMap((m) => Object.values(m)).find((g) => typeof g?.getInstance === "function" && (() => { try { return g.getInstance()?.combatScene; } catch { return false; } })())?.getInstance();

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
  // `tools/check-client.mjs` reads this table to see whether a new client still has them.
  const CLIENT_FN = {
    sell: "Sale confirmation was interrupted",
    autoBank: "courier-based banking fees",
    autoPlace: "Auto-placing",
  };
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
    sellAtFn ??= findClientFn(CLIENT_FN.sell);
    return sellAtFn(bag, slot);
  };
  // The call behind the Auto Bank macro: a banker courier arrives and sends crafting ingredients
  // and spell scrolls to the tradeskill bank. Nothing is sold or destroyed. It takes the scene's
  // world-interaction port, which the client hands to its UI through a React context, so it is
  // read from the provider's props in the React tree. It reports in chat and returns nothing.
  let autoBankFn = null;
  const interactionPort = () => {
    for (const el of document.querySelectorAll("body *")) {
      const key = Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
      for (let f = key ? el[key] : null; f; f = f.return) {
        const v = f.memoizedProps?.value;
        if (v && typeof v.summonCourier === "function") return v;
      }
    }
    throw new Error("world interaction port not found");
  };
  const autoBank = async () => {
    autoBankFn ??= findClientFn(CLIENT_FN.autoBank);
    await autoBankFn("banker", interactionPort());
    return null;
  };

  const characterNames = (i) => {
    const p = i.stores.character.getState().characterProfile ?? {};
    const comps = i.stores.companions.getState().companions ?? [];
    return new Set([p.name, ...comps.filter((c) => c.companionType === 0 || c.companionType === 2).map((c) => c.name)]);
  };

  /**
   * Carried items that can be sold, cheapest loss first. Skips containers, NO DROP and NO RENT
   * items, items without a merchant price, `keepItemIds`, reagents of the leader's class spells,
   * equipped items, the cursor and bags marked No Sell, whose copies count as kept.
   * First come the copies or stacks of an item beyond `keepCopies` (largest stacks kept), then,
   * with `cheap`, single items whose merchant price is at most `junkMaxCopper`, lowest total value
   * first. Quest turn-in items (`window.iq.questItems`, from tools/quest-items.mjs) are never sold
   * as cheap singles, because these sales bypass the client's Keep Epic Quest Items. Dearer single
   * items are left for hand-downs or a person to review.
   */
  const surplus = (i, cheap = false) => {
    const inv = i.stores.character.getState().characterProfile?.inventory ?? [];
    const noSell = new Set(i.stores.combat.getState().noAutoSellBagInstanceIds ?? []);
    const general = new Map(inv.filter((r) => r.bag === 0 && r.slot >= 22 && r.slot <= 29).map((r) => [r.slot, r]));
    const kept = new Map();
    const groups = new Map();
    const reagents = new Set((classTable(i)?.spells ?? []).flatMap((s) => s.reagents.map((x) => x.id)));
    const questItems = new Set(i.questItems ?? []);
    for (const r of inv) {
      const loose = r.bag === 0 && r.slot >= 22 && r.slot <= 29;
      if (!loose && !(r.bag >= 23 && r.bag <= 30)) continue;
      const d = r.itemDetails;
      if (!d || (d.bagslots || 0) > 0) continue;
      if (!loose && noSell.has(general.get(r.bag - 1)?.itemInstanceId)) {
        kept.set(r.itemid, (kept.get(r.itemid) ?? 0) + 1);
        continue;
      }
      if (d.nodrop === 0 || d.norent === 0 || !(d.price > 0) || config.keepItemIds.includes(r.itemid) || reagents.has(r.itemid)) continue;
      if (!groups.has(r.itemid)) groups.set(r.itemid, []);
      groups.get(r.itemid).push(r);
    }
    const row = (r, copies) => ({ bag: r.bag, slot: r.slot, id: r.itemid, instanceId: r.itemInstanceId, name: r.itemDetails.Name ?? r.itemDetails.name, quantity: r.quantity ?? 1, price: r.itemDetails.price, copies });
    const keepName = new RegExp(config.keepNamePattern, "i");
    const hasEffect = (d) => d.proceffect > 0 || d.clickeffect > 0 || d.worneffect > 0 || d.focuseffect > 0;
    const cheapOk = (r) => r.itemDetails.price <= config.junkMaxCopper && !hasEffect(r.itemDetails) && !config.keepItemTypes.includes(r.itemDetails.itemtype) && !keepName.test(r.itemDetails.Name ?? r.itemDetails.name ?? "") && !questItems.has(r.itemid);
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
    if (now() < state.pauseUntil || space.cursor || space.free >= config.minFreeSlots) return;
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

  // Raid mode turns AutoLevel off and the leader commands each fight (main.pretty.js:72297-72300),
  // so during a raid the bot only reports: no AutoLevel restarts, rejoins, rotation, errands, gem
  // changes, target skips, cures or sales.
  const inRaid = (i) => Boolean(i.stores.raid?.getState?.().raidModeActive);
  // A dead leader waits on the Resurrection window, and AutoLevel cannot run until it answers.
  // The free respawn at the bind point costs no XP while Death XP Loss is off (its default).
  const leaderDead = (i) => !(i.stores.character.getState().characterProfile?.curHp > 0);
  const watchDeath = (i) => {
    if (!leaderDead(i)) {
      state.deadSince = null;
      return;
    }
    state.deadSince ??= now();
    if (now() - state.deadSince < config.respawnAfterSec * 1000) return;
    const near = (el, re) => {
      for (let k = 0; el && k < 5; k++, el = el.parentElement) if (re.test(el.textContent ?? "")) return true;
      return false;
    };
    const free = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Free" && near(b, /Respawn at bind/i));
    if (!free) return;
    free.click();
    state.deadSince = now();
    alert("respawn", "the leader was dead; took the free respawn at the bind point");
  };
  const keepAutoLevel = (i, cb) => {
    if (cb.isRunning) {
      state.offSince = null;
      return;
    }
    if (now() < state.pauseUntil || i.guard?.phase === "leaving" || !i.socket.isConnected || leaderDead(i)) return;
    state.offSince ??= now();
    // When another player holds the chosen target, the client gives it up with "Looking for another
    // target." and sometimes stops AutoLevel instead of retrying (CAUokwED.js:5400-5426). That stop
    // is the client's, not a person's, so it restarts at the next tick, within a minute of the line.
    const contested = state.abandonAt && now() - state.abandonAt < 60000;
    if (contested) {
      state.abandonAt = null;
      cb.startAutoLevel();
      state.offSince = now();
      state.contestedRestarts = (state.contestedRestarts ?? 0) + 1;
      log(`restarted AutoLevel after a contested target (${state.contestedRestarts} so far)`);
      return;
    }
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
        const lvl = Number(m[1]);
        alert("levelUp", text, true);
        applyBandRotation(lvl);
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
        // The game and the bot recover from a death by themselves (respawn, rejoin), so one death
        // is a note. A run of them points at a zone or limits that need changing (`watchDeaths`).
        const who = m?.[1] ?? "You";
        alert("death", text, false);
        if (who === "You" || names.has(who)) (state.deaths ??= []).push({ t: e.t ?? now(), text });
      } else if ((m = /inventory is full, you could not loot (.+?)\.?$/i.exec(text))) state.lootFails.push({ t: e.t ?? now(), item: m[1] });
      else if (/^Waiting for an available enemy/.test(text)) state.enemyWaits.push(e.t ?? now());
      else if (/^(No usable route|Route blocked)\. Recovering near/.test(text)) state.routeRecoverAt = e.t ?? now();
      else if (/^Waiting for party to be ready/.test(text)) state.readyWaitAt = e.t ?? now();
      else if (/^You (engage .+ in combat|begin casting)|^You have defeated/.test(text)) state.routeRecoverAt = state.readyWaitAt = null;
      else if (/^No available enemies found in this zone/.test(text)) state.noEnemies.push(e.t ?? now());
      else if (/Looking for another target\.$/.test(text)) state.abandonAt = e.t ?? now();
      // A lowered cap and a timed-out escape are the guard working. Only an AutoLevel it could not
      // restart needs someone.
      else if (e.type === "guard" && /lowering the AutoLevel cap|did NOT restart|failed/.test(text)) alert("guard", text, /did NOT restart/.test(text));
    }
  };

  // A container needs a free general slot, so "inventory is full" also appears with free bag
  // slots when every general slot holds a bag. That loses only the container, so it wakes nobody
  // unless the bags are short of space or the cursor is taken.
  const watchLoot = (i) => {
    state.lootFails = state.lootFails.filter((f) => f.t > now() - 600000);
    if (state.lootFails.length && now() - state.lootAlertAt > 1800000) {
      state.lootAlertAt = now();
      const sp = i.bagSpace();
      const items = [...new Set(state.lootFails.map((f) => f.item))].join(", ");
      const short = sp.free < config.minFreeSlots || !!sp.cursor;
      alert("lootFull", `${state.lootFails.length} item(s) left on corpses in 10 minutes (${items}); ${sp.free} bag slots free${sp.cursor ? `, cursor holds ${sp.cursor}` : ""}`, short);
    }
  };

  const watchDeaths = () => {
    state.deaths = (state.deaths ?? []).filter((d) => d.t > now() - 3600000);
    if (state.deaths.length < config.deathsPerHourAlert || now() - (state.deathAlertAt ?? 0) < 3600000) return;
    state.deathAlertAt = now();
    alert("deaths", `${state.deaths.length} deaths in the last hour, the last: ${state.deaths.at(-1).text}`, true);
  };

  // The client's auto-place call, which puts the cursor item into the first place that fits.
  let autoPlaceFn = null;
  const autoPlace = () => {
    autoPlaceFn ??= findClientFn(CLIENT_FN.autoPlace);
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
    const cs = i.stores.companions.getState();
    const full = (hp, maxHp, mana, maxMana) => hp >= maxHp && (!(maxMana > 0) || mana >= maxMana);
    return (
      full(p.curHp, p.maxHp, p.mana, p.maxMana) &&
      (cs.companions ?? []).every((c) => {
        if (c.isDead) return true;
        const d = cs.botCombatDataMap?.[c.id];
        return full(d?.curHp ?? c.curHp, d?.maxHp ?? c.maxHp, d?.curMana ?? c.curMana, d?.maxMana ?? c.maxMana);
      })
    );
  };

  const watchXp = async (i, cb) => {
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
    if (state.readyWaitAt && now() - state.readyWaitAt > config.readyStuckSec * 1000 && partyFull(i) && !partyRoots(i).length) {
      restart(`waited ${Math.round((now() - state.readyWaitAt) / 1000)}s for a party that was already full`);
      return;
    }
    // Running, out of combat and no XP for a few minutes.
    if (config.stuckRestartMin > 0 && idleMin > config.stuckRestartMin && now() - (state.stuckRestartAt ?? 0) > config.stuckRestartMin * 60000) {
      // After "Waiting for an available enemy" AutoLevel idles until something passes its limits, so
      // other groups hold every such enemy. A white minimum con (new groups start there) widens to
      // blue first, then the party moves to the rotation zone fewest other groups hunt. An errand
      // waits for its named spawns on purpose.
      const waited = !state.errand && state.enemyWaits.at(-1) > state.xpSeen.t;
      const minCon = cb.minCon;
      if (waited && minCon > 4) {
        cb.setMinCon(4);
        restart(`${Math.round(idleMin)} minutes waiting for an available enemy at minimum con ${minCon}; lowered it to blue (4)`);
      } else if (waited && nextZone(i) && (await rotate(i, `${Math.round(idleMin)} minutes waiting for an available enemy`))) {
        state.stuckRestartAt = now();
        state.xpSeen = { xp, t: now() };
      } else restart(`${Math.round(idleMin)} minutes out of combat without XP`);
    }
    if (!state.stallAlerted && idleMin > config.stallMin) {
      state.stallAlerted = true;
      alert("xpStall", `AutoLevel has run ${config.stallMin} minutes without gaining XP`, true);
    }
  };

  // AutoLevel picks the nearest enemy that passes its con and level filters and is not on the
  // client's skip list (`deferAutoLevelSpawn`, which the client uses for spawns it cannot reach).
  // Keeping enemies named by `avoidNames` on that list makes AutoLevel pull the others, and an
  // errand keeps every enemy on it except those its `keep` pattern names. Each entry lasts a
  // little over two ticks and is renewed while the setting or the errand lasts.
  const avoidTargets = (i) => {
    const keep = state.errand?.keep;
    if (!config.avoidNames && !keep) return;
    const rt = runtime(i);
    if (!rt?.deferAutoLevelSpawn) return;
    const pattern = (s) => new RegExp(s.replace(/[ _]/g, "[ _]"), "i");
    const avoid = config.avoidNames ? pattern(config.avoidNames) : null;
    const wanted = keep ? pattern(keep) : null;
    for (const t of rt.combatScene.getAliveCombatTargetList?.() ?? []) {
      const name = t.name ?? "";
      if (avoid?.test(name) || (wanted && !wanted.test(name))) rt.deferAutoLevelSpawn(t.spawnInstanceId, (config.tickSec * 2 + 5) * 1000);
    }
  };

  // The client turns Auto Attack off when every enemy left in a fight is mezzed, so the player
  // does not wake them (`adoptActiveEncounterForAutoLevel`: no enemy passes
  // `canAutomaticallyFocusNpc`). Nothing turns it back on, and AutoLevel's next pull then stands
  // at its target in the approach phase "waiting-to-attack", which has no timeout. Once the
  // fight is over and a pull waits like that, press Auto Attack as a player would.
  const keepAutoAttack = (i, cb) => {
    const rt = runtime(i);
    const attempt = rt?.combatApproach?.attempt;
    if (!cb.isRunning || cb.isAutoAttackEnabled || attempt?.phase !== "waiting-to-attack") {
      state.attackWaitAt = null;
      return;
    }
    state.attackWaitAt ??= now();
    if (now() - state.attackWaitAt < config.attackWaitSec * 1000) return;
    state.attackWaitAt = null;
    const target = cb.targetNPC;
    if (target?.spawnInstanceId === attempt.spawnInstanceId && typeof rt.attackSelectedTarget === "function") rt.attackSelectedTarget();
    else rt.setAutoAttackEnabled?.(true);
    alert("autoAttack", `AutoLevel stood at ${target?.name?.replace(/_/g, " ") ?? "its target"} with Auto Attack off; turned it on`);
  };

  // ---- Dispelling roots that outlast a fight ---------------------------------------------------
  // Between pulls the readiness wait stands still while a member or pet is rooted, and a pass
  // that casts a cure or dispel holds it one pass longer, so cures stay off (docs/guide.md). A
  // root can outlast the fight by a minute or more, though. Out of combat with AutoLevel running,
  // the bot turns the cure tactic on for the members who know a dispel, but only when the root's
  // remaining time exceeds the expected time to dispel it by `dispelMinSavedSec`. A dispel
  // succeeds with 32% plus 7% per level the caster is above the root's caster, or minus 2% per
  // level below, clamped to 10-100% (docs/client-internals.md). The cure tactic goes back to its
  // previous value as soon as the root is gone, a fight starts, AutoLevel stops, or the expected
  // time has passed three times over.
  // Spellbook level-dispel spells (spa 27): [name, levelModifier]. Bard songs are not cast by the
  // out-of-combat readiness pass (BQ.pretty.js Nz).
  const DISPELS = {
    289: ["Taper Enchantment", 1],
    48: ["Cancel Magic", 1],
    24: ["Strip Enchantment", 1],
    49: ["Nullify Magic", 4],
    25: ["Pillage Enchantment", 4],
    1526: ["Annul Magic", 9],
    1697: ["Recant Magic", 9],
  };
  const effectsModule = (i) => Object.values(i.mods ?? {}).find((m) => typeof m?.l?.getEffects === "function" && typeof m.cm === "function");
  const partyRoots = (i) => {
    const fx = effectsModule(i);
    if (!fx) return [];
    const recs = fx.l.records;
    const ids = recs instanceof Map ? [...recs.keys()] : Object.keys(recs ?? {});
    const out = [];
    for (const id of ids) {
      if (!/^(character|pet):/.test(id)) continue;
      // Runtime roots carry `remainingTicks` (6 s each) and an `effectId` that repeats for the same spell.
      for (const e of fx.l.getEffects(id)?.active ?? []) if (fx.cm({ effects: [e] }).isRooted) out.push({ id, app: e.applicationId ?? `${id}|${e.effectId}`, spellId: e.spellId, casterLevel: e.casterLevel ?? 0, endsAt: e.expiresAtMs ?? now() + (e.remainingTicks ?? 0) * 6000 });
    }
    return out;
  };
  const dispelChance = (level, rootCaster, mod = 1) => {
    const d = level + mod - 1 - rootCaster;
    return Math.min(100, Math.max(10, 32 + (d > 0 ? 7 * d : 2 * d))) / 100;
  };
  const dispellers = (i) => {
    const cs = i.stores.companions.getState();
    const ps = i.stores.partySpells?.getState?.();
    const out = [];
    for (const c of cs.companions ?? []) {
      if (c.companionType !== 2) continue;
      const d = cs.botCombatDataMap?.[c.id];
      if (!d || !(d.curHp > 0)) continue;
      const known = (d.scribedSpellIds ?? []).filter((s) => DISPELS[s]);
      if (!known.length) continue;
      const mod = Math.max(...known.map((s) => DISPELS[s][1]));
      // BQ.pretty.js sorts dispels by mana/chance, which picks Taper Enchantment (5 mana, mod 1)
      // over Nullify Magic (50 mana, mod 4) unless weaker dispels are excluded.
      const weaker = known.filter((s) => DISPELS[s][1] < mod);
      const key = `character:${c.characterId}`;
      if (weaker.length && typeof ps?.setCastingPreferences === "function") {
        const cur = ps.castingPreferences?.[key];
        const prev = cur?.excludedSpellIds ?? [];
        const mez = d.class === 14 || d.class === 8;
        if (weaker.some((s) => !prev.includes(s)) || (mez && cur?.mez === false)) {
          ps.setCastingPreferences(key, { mez, excludedSpellIds: [...new Set([...prev, ...weaker])] });
        }
      }
      out.push({ name: c.name, key, level: d.level ?? c.level, mod });
    }
    return out.sort((a, b) => b.level + b.mod - (a.level + a.mod));
  };
  const dispelRoots = (i, cb) => {
    if (!config.dispelRoots || typeof i.setTactic !== "function") return;
    state.dispelSkip ??= [];
    const fighting = i.stores.skills.getState().inCombat;
    const roots = partyRoots(i);
    const run = state.dispel;
    if (run) {
      const gone = !roots.some((r) => r.app === run.app);
      const stop = gone ? "gone" : fighting ? "a fight started" : !cb.isRunning ? "AutoLevel stopped" : run.endsAt - now() <= config.dispelOverheadSec * 1000 ? "nearly expired" : null;
      if (!stop) return;
      for (const w of run.who) i.setTactic(w.name, "cure", w.prev ?? false);
      state.dispel = null;
      const took = Math.round((now() - run.at) / 1000);
      const left = Math.max(0, Math.round((run.endsAt - now()) / 1000));
      if (stop !== "gone") state.dispelSkip = [...state.dispelSkip.filter((s) => s.until > now()).slice(-20), { app: run.app, until: run.endsAt }];
      alert("dispel", stop === "gone" ? `root on ${run.target} gone after ${took}s with ${left}s of it left; cures back off` : `stopped after ${took}s (${stop}) with ${left}s of the root left; cures back off`);
      return;
    }
    if (fighting || !cb.isRunning || !roots.length) return;
    const root = roots.reduce((a, b) => (b.endsAt > a.endsAt ? b : a));
    if (state.dispelSkip.some((s) => s.app === root.app && s.until > now())) return;
    const casters = dispellers(i);
    if (!casters.length) return;
    // The client locks a target while one dispeller casts on it (BQ.pretty.js Rn), so at most two
    // casters alternate on one rooted target during a 9 s recast cycle.
    const active = casters.slice(0, 2);
    const miss = active.reduce((m, c) => m * (1 - dispelChance(c.level, root.casterLevel, c.mod)), 1);
    const expected = config.dispelCycleSec / (1 - miss) + config.dispelOverheadSec;
    const left = (root.endsAt - now()) / 1000;
    if (left - expected < config.dispelMinSavedSec) return;
    const overrides = i.stores.partySpells?.getState?.().overridesByCompanion ?? {};
    const who = active.map((c) => ({ name: c.name, prev: overrides[c.key]?.cure }));
    for (const w of who) i.setTactic(w.name, "cure", true);
    state.dispel = { app: root.app, target: root.id, at: now(), endsAt: root.endsAt, who };
    alert("dispel", `${root.id} rooted (spell ${root.spellId}, caster level ${root.casterLevel}) with ${Math.round(left)}s left between fights; cures on for ${active.map((c) => c.name).join(", ")}, expected ${Math.round(expected)}s`);
  };

  // A client update changes the build the page runs, and the SDK may no longer fit it. The page runs
  // one build until it reloads, so the bot compares this page's release with the last one the tab
  // or the browser saw, and it asks the site every few minutes which build a reload would load.
  const RELEASE_KEY = "iqBot.release";
  const missingClientFns = (i) => {
    const lost = [];
    for (const [name, needle] of Object.entries(CLIENT_FN)) {
      try {
        findClientFn(needle);
      } catch {
        lost.push(`fn.${name}`);
      }
    }
    return lost;
  };
  const watchRelease = async (i) => {
    if (!i.release) return;
    if (state.releaseChecked !== i.release) {
      state.releaseChecked = i.release;
      let last = null;
      try {
        last = sessionStorage.getItem(RELEASE_KEY) ?? localStorage.getItem(RELEASE_KEY);
        sessionStorage.setItem(RELEASE_KEY, i.release);
        localStorage.setItem(RELEASE_KEY, i.release);
      } catch {
        /* storage unavailable */
      }
      const missing = [...(i.missingApi ?? []), ...missingClientFns(i)];
      const changed = last && last !== i.release;
      if (changed || missing.length) {
        alert("clientUpdate", `${changed ? `client changed from ${last} to ${i.release}` : `client ${i.release}`}; ${missing.length ? `it lacks ${missing.join(", ")}, which the SDK uses` : "it has everything the SDK uses"}. Run tools/check-client.mjs and read the diff (tools/client-snapshot.mjs --diff)`, true);
      }
    }
    if (!config.releaseProbeMin || !i.surface?.releaseId || now() - state.releaseProbeAt < config.releaseProbeMin * 60000) return;
    state.releaseProbeAt = now();
    try {
      const html = await (await fetch("/play", { cache: "no-store", signal: AbortSignal.timeout(15000) })).text();
      const tag = i.surface.buildTag(html);
      const id = tag && i.surface.releaseId(tag, i.surface.assetNames(i.surface.declaredInHtml(html)));
      if (id && id !== i.release && state.remoteRelease !== id) {
        state.remoteRelease = id;
        alert("clientUpdate", `the site serves client ${id} while this page runs ${i.release}; a reload loads it. Run tools/client-snapshot.mjs and tools/check-client.mjs first`, true);
      }
    } catch {
      /* offline or blocked: ask again next time */
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

  // Waiting again and again for an available enemy means other players or other groups of this
  // browser hold the zone's targets. With another zone in the rotation the bot moves there (the one
  // fewest other groups hunt), otherwise it wakes a script to decide.
  const watchCrowding = async (i) => {
    state.enemyWaits = state.enemyWaits.filter((t) => t > now() - 600000);
    if (state.enemyWaits.length < config.crowdedWaits || now() - state.crowdAlertAt < 600000) return;
    state.crowdAlertAt = now();
    const z = i.stores.staticData.getState().zones.find((x) => x.zoneidnumber === i.stores.combat.getState().currentZone);
    const why = `AutoLevel waited for an available enemy ${state.enemyWaits.length} times in 10 minutes in ${z?.longName ?? "this zone"}`;
    if (!state.errand && nextZone(i) && (await rotate(i, why))) {
      state.enemyWaits = [];
      return;
    }
    alert("crowded", why, true);
  };

  // "No available enemies found in this zone" means nothing passes AutoLevel's con and level
  // filters (spawns it failed to reach are skipped for five minutes), and the game then switches
  // AutoLevel off. Undo what can be undone here: limits the guard tightened, then a raised minimum
  // con. Otherwise the zone does not fit the party, so wake an attached script to choose another.
  const watchNoEnemies = async (i) => {
    state.noEnemies = state.noEnemies.filter((t) => t > now() - 300000);
    // During an errand an empty zone means the wanted enemies are dead, and the errand's deadline
    // decides how long to wait for them.
    if (state.errand) state.noEnemies = [];
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
    } else if (await rotate(i, "no available enemies")) {
      // moved on
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
    if (state.zone !== cb.currentZone) {
      if (state.zone !== null) {
        const z = i.stores.staticData.getState().zones.find((x) => x.zoneidnumber === cb.currentZone);
        alert("zone", `now in ${z?.longName ?? cb.currentZone}`);
      }
      state.zoneSince = now();
      state.zoneBestRate = 0;
    } else if (state.zoneSince == null) {
      // An install that carries an older state starts the visit clock here.
      state.zoneSince = now();
      state.zoneBestRate = 0;
    }
    state.zone = cb.currentZone;
  };

  // ---- Zone rotation ------------------------------------------------------------------------
  // AutoLevel only pulls enemies it can reach, and spawns return after about ten minutes, so a
  // party can empty the reachable part of a zone: in Permafrost at level 19 the XP rate fell from
  // 1.9M to nothing in 40 minutes. With `rotation` set to zone short names, the bot moves to the
  // next one when "No available enemies" persists, or when the last 10 minutes earned less than
  // `rotateBelowShare` of the best 10 minutes since arriving, after at least `rotateMinStayMin`.
  // The band rows (`window.iq.bandRotations`, from data/band-rotations.json, shared with
  // tools/gear.mjs) set `rotation` at each level-up. docs/plans/leveling-plan.md gives the evidence
  // for each row.
  // Every group's bot reads the same rows, and groups in one zone contest the same enemies ("That
  // target is already engaged by another player"). The game tabs of one browser share
  // localStorage, so each bot records its zone there every tick, and a band row and the next zone
  // are chosen by how few other groups of this browser hunt there, in row order on a tie.
  const ZONE_PREFIX = "iqBot.zone.";
  const shareZone = (i) => {
    const me = i.stores.character.getState().characterProfile;
    const zone = i.stores.staticData?.getState?.().zones?.find((z) => z.zoneidnumber === i.stores.combat.getState().currentZone)?.shortName;
    if (me?.name && zone && typeof localStorage !== "undefined") localStorage.setItem(ZONE_PREFIX + me.name, JSON.stringify({ zone, level: me.level, t: now() }));
  };
  const occupancy = (zone) => {
    if (typeof localStorage === "undefined") return 0;
    const self = ZONE_PREFIX + (iq()?.stores.character.getState().characterProfile?.name ?? "");
    let n = 0;
    for (let k = 0; k < localStorage.length; k++) {
      const key = localStorage.key(k);
      if (!key?.startsWith(ZONE_PREFIX) || key === self) continue;
      try {
        const v = JSON.parse(localStorage.getItem(key));
        if (v.zone === zone && now() - v.t < 300000) n++;
      } catch {}
    }
    return n;
  };
  const leastUsed = (list) => list.map((z, k) => ({ z, k, n: occupancy(z) })).sort((a, b) => a.n - b.n || a.k - b.k).map((x) => x.z);
  const applyBandRotation = (lvl) => {
    if (!config.autoBandRotation || !(config.rotation ?? []).length) return;
    const row = (iq()?.bandRotations ?? []).find(([min]) => lvl >= min)?.[1];
    if (!row || JSON.stringify([...row].sort()) === JSON.stringify([...config.rotation].sort())) return;
    const band = leastUsed(row);
    config.rotation = [...band];
    saved.rotation = [...band];
    sessionStorage.setItem(KEY, JSON.stringify(saved));
    log(`updated rotation for level ${lvl}: ${band.join(", ")}`);
  };
  const xpLast10 = (i) => (i.kills ?? []).filter((k) => k.t > now() - 600000).reduce((s, k) => s + (k.xp ?? 0), 0);
  const zoneShort = (i) => i.stores.staticData.getState().zones.find((z) => z.zoneidnumber === i.stores.combat.getState().currentZone)?.shortName;
  // A party outside its rotation, after a respawn at the bind point, a new band row or a fresh
  // start in a home city, moves to the rotation's first zone after `outsideRotationSec`.
  const watchOutside = async (i) => {
    const list = config.rotation ?? [];
    if (!list.length || state.errand || !config.outsideRotationSec || list.includes(zoneShort(i))) return;
    if (now() - (state.zoneSince ?? now()) < config.outsideRotationSec * 1000) return;
    await moveTo(i, leastUsed(list)[0], `${zoneShort(i)} is not in the rotation`);
  };
  const nextZone = (i) => {
    const here = zoneShort(i);
    const others = (config.rotation ?? []).filter((z) => z !== here);
    if (!others.length) return null;
    const k = (config.rotation ?? []).indexOf(here);
    // Row order from the zone after this one, so ties keep the old cycling.
    const ordered = [...others.filter((z) => config.rotation.indexOf(z) > k), ...others.filter((z) => config.rotation.indexOf(z) < k)];
    return leastUsed(ordered)[0];
  };
  const moveTo = async (i, dest, why) => {
    if (!dest || typeof i.changeZone !== "function" || i.guard?.phase === "leaving" || i.stores.skills.getState().inCombat) return false;
    const cb = i.stores.combat.getState();
    const limits = { minCon: cb.minCon, maxCon: cb.maxCon, maxLevelDiff: cb.maxLevelDiff };
    log(`moving to ${dest}: ${why}`);
    cb.setIsRunning(false);
    try {
      const name = await i.changeZone(dest);
      const c = i.stores.combat.getState();
      c.setMaxCon(limits.maxCon);
      c.setMinCon(limits.minCon);
      c.setMaxLevelDiff(limits.maxLevelDiff);
      c.startAutoLevel();
      alert("rotate", `moved to ${name}: ${why}`);
      return true;
    } catch (e) {
      alert("rotate", `move to ${dest} failed: ${e?.message ?? e}`, true);
      return false;
    }
  };
  // A running errand holds the rotation.
  const rotate = async (i, why) => !state.errand && moveTo(i, nextZone(i), why);
  const watchRate = async (i) => {
    if (!(config.rotation ?? []).length) return;
    const cb = i.stores.combat.getState();
    if (config.rotateEscapes > 0) {
      const since = Math.max(state.zoneSince ?? 0, now() - 600000);
      const escapes = (i.guard?.trips ?? []).filter((t) => t.zone === cb.currentZone && t.t >= since);
      if (escapes.length >= config.rotateEscapes) {
        await rotate(i, `${escapes.length} guard escapes in 10 minutes`);
        return;
      }
    }
    if (now() - (state.zoneSince ?? now()) < 600000) return;
    const rate = xpLast10(i);
    state.zoneBestRate = Math.max(state.zoneBestRate ?? 0, rate);
    if (now() - state.zoneSince < config.rotateMinStayMin * 60000 || rate >= config.rotateBelowShare * state.zoneBestRate) return;
    await rotate(i, `the last 10 minutes earned ${Math.round((100 * rate) / Math.max(1, state.zoneBestRate))}% of this visit's best`);
  };

  // ---- Errands ------------------------------------------------------------------------------
  // An errand hunts named enemies for a drop, such as an epic piece. The party moves to the
  // errand's zone, AutoLevel pulls only enemies whose names match `keep`, and rotation waits. The
  // errand ends when the item is in the bags, at its deadline, when the party is no longer in the
  // zone, or after `rotateEscapes` guard escapes there. Then the minimum con it changed comes
  // back and the bot rotates on.
  const hasItem = (i, name) => (i.inventory?.() ?? []).some((r) => r.name === name);
  const endErrand = async (i, why, failed) => {
    const e = state.errand;
    state.errand = null;
    if (e.minCon != null) i.stores.combat.getState().setMinCon(e.limits.minCon);
    alert("errand", `${e.item} in ${e.zone}: ${why}`, failed);
    await rotate(i, `errand ended: ${why}`);
  };
  const watchErrand = async (i) => {
    const e = state.errand;
    if (!e?.arrived) return;
    const cb = i.stores.combat.getState();
    if (hasItem(i, e.item)) return endErrand(i, `got ${e.item}`, false);
    if (now() > e.until) return endErrand(i, `no ${e.item} after ${e.minutes} minutes`, true);
    if (i.guard?.phase !== "leaving" && zoneShort(i) !== e.zone) return endErrand(i, `the party left ${e.zone}`, true);
    const escapes = (i.guard?.trips ?? []).filter((t) => t.zone === cb.currentZone && t.t >= e.since);
    if (config.rotateEscapes > 0 && escapes.length >= config.rotateEscapes) return endErrand(i, `${escapes.length} guard escapes`, true);
  };

  // ---- Spells and pets after level-ups -----------------------------------------------------
  // The active character casts only memorized spells, and a living pet is kept when its owner
  // levels (wiki: AutoLevel, Companions). So after a level-up or a spell purchase the bot puts the
  // best learned spell of each role into the gems and replaces a pet that an older summon or tier
  // made. It works for every class and treats none as the default.
  //
  // The leader auto-casts only spells in the client's static table for its class
  // (`buildMergedAutoCastData`, .re/js/BQ.pretty.js:45082-45103), so a gem holding any other spell
  // is never cast. `window.iq.classSpells` holds that table with the content snapshot's facts per
  // spell, keyed by class id, and is generated by tools/class-spells.mjs. A class with a null entry
  // (Warrior, Monk, Rogue) casts nothing: the bot leaves its gems alone.
  const BARD = 8;
  const BARD_GEMS = 3;
  const MAX_GEMS = 8;
  // Classes the client lets summon a pet on its own (`Du` in main.pretty.js): Shaman, Necromancer,
  // Magician and Enchanter. The tables give other classes category 14 rows too, but those never fire.
  const PET_CLASSES = new Set([10, 11, 13, 14]);
  // The client prefers this spell over every other summon (`qi`, main.pretty.js:58697).
  const EPIC_SUMMON = 1944;
  // Table categories (main.pretty.js:54250-54266).
  const CAT = { nuke: 1, heal: 2, buff: 3, dot: 4, debuff: 5, lifetap: 11, cc: 12, pet: 14 };
  const levelDesc = (a, b) => b.minLevel - a.minLevel;
  const dmgDesc = (a, b) => levelDesc(a, b) || a.hp - b.hp; // hp is negative damage
  const hpDesc = (a, b) => b.hp - a.hp;
  // Roles in gem order. `rows` picks a role's table rows and `rank` orders the learned ones. Gems
  // belong to roles by this order and by each class's budget, whether or not a role has a spell
  // yet, so a level-up changes the gem of one role and leaves the others where they are.
  const ROLES = {
    pet: { rows: (r) => r.category === CAT.pet && r.spellId !== EPIC_SUMMON, rank: levelDesc },
    nuke: { rows: (r) => r.category === CAT.nuke && (r.targetType === 1 || r.targetType === 5) && r.hp < 0, rank: dmgDesc },
    petHeal: { rows: (r) => r.category === CAT.heal && r.targetType === 14, rank: hpDesc },
    heal: { rows: (r) => r.category === CAT.heal && r.targetType === 5 && r.hp > 0, rank: hpDesc },
    // A slow, else a snare: the client's default casting preferences allow both and forbid mez.
    control: {
      rows: (r) => (r.category === CAT.debuff || r.category === CAT.cc) && (r.tags.includes("slow") || r.tags.includes("snare")),
      rank: (a, b) => Number(b.tags.includes("slow")) - Number(a.tags.includes("slow")) || levelDesc(a, b),
    },
    lifetap: { rows: (r) => r.category === CAT.lifetap && r.hp < 0, rank: dmgDesc },
    dot: { rows: (r) => r.category === CAT.dot, rank: levelDesc },
    buff: { rows: (r) => r.category === CAT.buff, rank: levelDesc },
  };
  const gemCount = (classId) => (classId === BARD ? BARD_GEMS : MAX_GEMS);
  // Gems per role. Healers heal, pet classes summon, and a Bard's three gems are all songs.
  const roleBudget = (classId, cls) => {
    if (classId === BARD) return { buff: BARD_GEMS };
    return {
      pet: PET_CLASSES.has(classId) ? 1 : 0,
      nuke: classId === 12 ? Math.max(config.nukeGems, 3) : config.nukeGems, // the Wizard has no other job
      petHeal: 1,
      heal: cls.healThreshold > 0 ? 2 : 0,
      control: 1,
      lifetap: 1,
      dot: config.dotGems,
      buff: config.buffGems,
    };
  };
  const classOf = (profile) => profile?.class?.id ?? profile?.class;
  const classTable = (i) => i.classSpells?.[classOf(i.stores.character.getState().characterProfile)] ?? null;
  const bagCounts = (i) => {
    const held = new Map();
    for (const r of i.inventory?.() ?? []) held.set(r.id, (held.get(r.id) ?? 0) + (r.quantity ?? 1));
    return held;
  };
  const hasReagents = (held, row) => row.reagents.every((r) => (held.get(r.id) ?? 0) >= r.count);

  // The gems the upkeep would set, ordered by gem: { gem, role, id, name, level, reagents }. Empty
  // for a class without a spell table. Only learned spells at or below the leader's level count, and
  // a spell whose reagent is missing from the bags does not, because the client skips it, except a
  // summon: the plan keeps the pet spell so a pet class that ran out of its reagent still holds it.
  const spellPlan = (i) => {
    const profile = i.stores.character.getState().characterProfile;
    const cls = classTable(i);
    if (!cls) return [];
    const classId = classOf(profile);
    const sb = i.stores.spellbook.getState();
    const scribed = new Set((sb.scribedSpells ?? []).map((x) => x.spellId));
    const memorized = new Map((sb.memorizedSpells ?? []).map((m) => [m.spellId, m.gemSlot]));
    const held = bagCounts(i);
    const budget = roleBudget(classId, cls);
    const plan = [];
    let next = 0;
    for (const [role, def] of Object.entries(ROLES)) {
      const size = Math.min(budget[role] ?? 0, gemCount(classId) - next);
      if (size <= 0 || !cls.spells.some(def.rows)) continue;
      const slots = Array.from({ length: size }, (_, k) => next + k);
      next += size;
      // Ties between spells of one level go to the one already memorized, then to the name the
      // `petPreference` setting names (the Magician's four elements), then to the lowest id.
      const preferred = (r) => Number(memorized.has(r.spellId)) * 2 + Number(Boolean(config.petPreference) && r.name.includes(config.petPreference));
      const picks = cls.spells
        .filter((r) => def.rows(r) && r.minLevel <= profile.level && scribed.has(r.spellId) && (role === "pet" || hasReagents(held, r)))
        .sort((a, b) => def.rank(a, b) || (role === "pet" ? preferred(b) - preferred(a) : 0) || a.spellId - b.spellId)
        .slice(0, size);
      // A spell that is memorized in one of the role's gems stays there.
      const placed = new Map();
      for (const p of picks) if (slots.includes(memorized.get(p.spellId))) placed.set(memorized.get(p.spellId), p);
      const rest = picks.filter((p) => ![...placed.values()].includes(p));
      for (const gem of slots) if (!placed.has(gem) && rest.length) placed.set(gem, rest.shift());
      for (const [gem, r] of placed) plan.push({ gem, role, id: r.spellId, name: r.name, level: r.minLevel, reagents: r.reagents });
    }
    return plan.sort((a, b) => a.gem - b.gem);
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
      if (!i.classSpells) return "no class spell table: window.iq.classSpells is missing";
      // A level-up unlocks merchant spells, and the game's reminder that buys them comes only every
      // ten minutes, so buy first: the new pet tier would otherwise wait up to ten minutes.
      if (typeof i.buyMissingSpells === "function") {
        const bought = await i.buyMissingSpells().catch((e) => [`failed: ${e?.message ?? e}`]);
        if (bought.some((l) => /Bought/.test(l))) done.push(`spells: ${bought.join(" | ")}`);
      }
      const managed = classTable(i) != null;
      const plan = spellPlan(i);
      const gems = new Map((sb().memorizedSpells ?? []).map((m) => [m.gemSlot, m.spellId]));
      const changes = plan.filter((p) => gems.get(p.gem) !== p.id);
      // The summon is identified by its spell id, not by a gem: the client casts any memorized one.
      const summon = plan.find((p) => p.role === "pet");
      const summonMemorized = Boolean(summon) && [...gems.values()].includes(summon.id);
      const pets = (i.stores.companions.getState().companions ?? []).filter((c) => c.companionType === 1);
      const comps = i.stores.companions.getState().companions ?? [];
      const ownerLevel = (ownerId) => (ownerId === me.id ? me.level : comps.find((c) => c.characterId === ownerId)?.level);
      // Our own pet goes when a new summon is planned. A companion's pet goes when it is far below
      // its owner, once per owner level, so a pet with no better tier is not replaced in a loop.
      const replace = pets.filter((pet) => {
        const owner = pet.petOwnerCharacterId;
        if (owner === me.id) return Boolean(summon) && !summonMemorized;
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
        // Free every gem the plan does not use, so only spells the client casts stay memorized.
        const planned = new Set(plan.map((p) => p.gem));
        if (managed) for (const m of sb().memorizedSpells ?? []) if (!planned.has(m.gemSlot)) await sb().unmemorizeSpell(m.gemSlot);
        if (cb().isSpellbookOpen) cb().toggleSpellbook();
        cb().setPlayerSitting(false);
      }
      for (const pet of replace) {
        // Keep our pet unless the client can summon a new one: the old pet beats none at all.
        if (pet.petOwnerCharacterId === me.id) {
          const memorizedNow = (sb().memorizedSpells ?? []).some((m) => m.spellId === summon.id);
          const missing = summon.reagents.filter((r) => (bagCounts(i).get(r.id) ?? 0) < r.count);
          if (!memorizedNow || missing.length) {
            done.push(`kept pet ${pet.name}: ${summon.name} ${memorizedNow ? `needs reagent item ${missing.map((r) => r.id).join(", ")}` : "is not memorized"}`);
            state.upkeepDue = true;
            state.upkeepAfter = now() + 30000;
            continue;
          }
        }
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
      await watchRelease(i);
      const cb = i.stores.combat.getState();
      if (i.stores.screen.getState().currentScreen !== "game" || cb.isZoneLoading || !i.stores.character.getState().characterProfile?.id) return;
      scanEvents(i);
      watchZone(i, cb);
      shareZone(i);
      await watchCursor(i);
      watchLoot(i);
      watchDeaths();
      if (inRaid(i)) {
        watchMemory();
        state.lastError = null;
        return;
      }
      await watchCrowding(i);
      if (config.respawnAfterSec > 0) watchDeath(i);
      await watchErrand(i);
      await watchNoEnemies(i);
      await watchOutside(i);
      await watchRate(i);
      keepParty(i);
      await watchXp(i, cb);
      avoidTargets(i);
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

  // Checks of the fight state that cost time for every second they wait: a pull standing with
  // Auto Attack off and a root holding the readiness wait.
  const fastTick = () => {
    if (!config.enabled) return;
    try {
      const i = iq();
      if (!i?.stores) return;
      const cb = i.stores.combat.getState();
      if (i.stores.screen.getState().currentScreen !== "game" || cb.isZoneLoading || inRaid(i)) return;
      avoidTargets(i);
      keepAutoAttack(i, cb);
      dispelRoots(i, cb);
    } catch (e) {
      const msg = String(e?.message ?? e);
      if (state.lastFastError !== msg) log(`fast tick failed: ${msg}`);
      state.lastFastError = msg;
    }
  };

  const bot = {
    config,
    state,
    timerId: setInterval(tick, config.tickSec * 1000),
    fastTimerId: setInterval(fastTick, config.fastTickSec * 1000),
    tick,
    fastTick,
    /** Roots on party members and pets with their end times, and who could dispel them. */
    roots: () => ({ roots: partyRoots(iq()), dispellers: dispellers(iq()) }),
    /** What the next cleanup would sell, in order: extra copies, then cheap single items. */
    surplus: () => surplus(iq(), true),
    /** The gems the upkeep would set for the leader's class, in gem order: [{gem, role, id, name, level}]. */
    spellPlan: () => spellPlan(iq()),
    /** The zones of `list` ordered by how few other groups of this browser hunt there now. */
    leastUsed: (list) => leastUsed(list),
    /** Memorize the planned gems and replace older pets now, out of combat. Returns what changed. */
    upkeep: (reason = "manual") => runUpkeep(iq(), reason),

    /**
     * Hunt only enemies whose names match `keep` (a regular expression) in `zone` until an item
     * named `item` is in the bags, then rotate on, e.g. `{ zone: "kaesora", keep:
     * "gorged|hungered|famished", item: "Power of Water" }`. `minCon` lowers AutoLevel's con
     * filter for weaker enemies and `minutes` caps the hunt. `errand(null)` ends a running one.
     */
    async errand(opts) {
      const i = iq();
      if (opts === null) {
        if (state.errand) await endErrand(i, "stopped", false);
        return "no errand";
      }
      const { zone, keep, item, minutes = 40, minCon = null } = opts;
      if (state.errand) throw new Error(`the errand for ${state.errand.item} is still running`);
      if (!zone || !keep || !item) throw new Error("an errand needs zone, keep and item");
      new RegExp(keep);
      if (hasItem(i, item)) return `already carrying ${item}`;
      const cb = i.stores.combat.getState();
      state.errand = { zone, keep, item, minutes, minCon, limits: { minCon: cb.minCon }, arrived: false, since: now(), until: now() + minutes * 60000 };
      log(`errand: ${item} from enemies matching ${keep} in ${zone}, up to ${minutes} min`);
      if (zoneShort(i) !== zone && !(await moveTo(i, zone, `errand for ${item}`))) {
        state.errand = null;
        throw new Error(`could not move to ${zone}`);
      }
      if (minCon != null) i.stores.combat.getState().setMinCon(minCon);
      Object.assign(state.errand, { arrived: true, since: now(), until: now() + minutes * 60000 });
      return `hunting ${keep} in ${zone} for ${item}`;
    },

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
      sessionStorage.setItem(KEY, JSON.stringify(saved));
      if ("tickSec" in partial) {
        clearInterval(bot.timerId);
        bot.timerId = setInterval(tick, config.tickSec * 1000);
      }
      if ("fastTickSec" in partial) {
        clearInterval(bot.fastTimerId);
        bot.fastTimerId = setInterval(fastTick, config.fastTickSec * 1000);
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
