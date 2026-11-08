// In-page supervisor for unattended play.
//
// AutoLevel fights, loots and rests by itself. The supervisor does the routine work it leaves to a
// person: it keeps the tab on its leader, starts AutoLevel again when it stays off without a pause,
// sells surplus copies before the bags fill, and keeps a short report with alerts, so an attached
// script can check in with one call instead of many. It runs on a timer inside the page and keeps
// working while no script is attached, for example while an agent waits for an answer.
//
// A pause is a lease: while it holds, the bot leaves the leader, the party, the zone and AutoLevel
// to the script that took it. When it ends, also because the script died, the bot brings all four
// back to their settings (docs/plans/controller.md).
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
    // Never sold, besides the reagents of the leader's own spells. Lightstones (10300) and Greater
    // Lightstones (10400) are worth 137,200 and 274,400 XP each to Smith Tv`ysa in South Ro.
    keepItemIds: [10015, 10300, 10400],
    // Client options the bot keeps for every character it plays, by the combat store's state key. The
    // client's Auto-Upgrade equips each drop on the looting party only, the leader first, and never
    // moves it again, so the coordinator's roster gear pass (tools/lib/gear-plan.mjs) equips instead.
    clientOptions: { autoUpgradeEnabled: false, autoUpgradeCompanionsEnabled: false },
    gearKeepIds: [], // items the coordinator's roster gear plan wants for some character (tools/lib/gear-plan.mjs), never sold
    // Never sold as cheap single items: spell research pieces, which Auto Bank usually banks first.
    keepNamePattern: "^(Words of|Rune of|Part of|Torn Page|Page of)\\b",
    keepItemTypes: [14, 15], // never sold as cheap single items: food and drink
    sellPerTick: 8,
    cursorAlertSec: 60, // an item held on the cursor this long raises an alert
    cursorPlaceSec: 180, // and after this long the bot puts it away once (0 = never)
    deathCostShareAlert: 0.1, // deaths whose cost passes this share of the last hour wake a script (`watchDeaths`); single deaths are notes
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
    leaderId: null, // the character this tab plays as when no pause holds it; null leaves the active character alone
    // Regular expression of enemy names AutoLevel should not pick, e.g. "shaman|idealist" for the
    // Root casters in Guk; empty to pick everything. Such enemies can still join a fight.
    avoidNames: "",
    // A fight the party has fought this long while the enemy it pulled keeps over half its HP is
    // left, and that enemy is skipped from then on (`slowFoes`): melee-immune wisps held parties
    // without magic damage for minutes. 0 turns both off.
    slowFightSec: 180,
    slowFoeShare: 0.25, // an enemy that pays less than this share of the party's usual XP per fight second is skipped
    rotation: [], // zone short names to cycle through as the reachable spawns run out, e.g. ["permafrost", "guktop"]
    rotateBelowShare: 0.6, // move on when the last 10 minutes earned less than this share of the visit's best
    rotateMinStayMin: 20, // and only after this many minutes in the zone
    rotateEscapes: 4, // guard escapes in this zone within 10 minutes rotate immediately (0 = never)
    autoBandRotation: true, // update `rotation` from the band table when the leader enters a new level band
    // AutoLevel's con and level limits, { minCon, maxCon, maxLevelDiff }, that the party returns to
    // after a zone change, an errand, and `widenMin` minutes after a remedy widened them (`keepLimits`).
    // null leaves the limits as they are.
    limits: null,
    widenMin: 20,
    respawnAfterSec: 20, // a dead leader without a resurrection takes the free respawn at the bind point after this long (0 = leave the Resurrection window alone)
    rezMaxPp: 200, // the most platinum one resurrection may cost (200 buys 90% of the lost XP back); 0 = only free ones
    rezReservePp: 100, // platinum a paid resurrection must leave for spells
    rezPullCoin: true, // a dead leader short of coin pulls the largest account balance with Manage Money
    coinKeepNames: [], // characters whose coin is never pulled, such as a farming leader's
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
    idleCase: null, // { why, rung, at, alerted }: the idle cause the remedy table works on
    lootFails: [], // times of "could not loot" messages
    lootAlertAt: 0,
    deaths: [], // times of party deaths
    deathAlertAt: 0,
    rejoinAt: 0,
    switching: null, // { id, name, startedAt, done, ok, message } of the last character switch
    switchFails: 0, // failed switches in a row
    switchRetryAt: 0, // the leader is not switched to again before this time
    task: null, // the last task: { id, kind, status, step, startedAt, endedAt, error, ... }
    fight: null, // { name, t } of the enemy the party engaged last, until its kill line
    foes: {}, // per enemy name: { fights, secs, xp, slow, level }, the party's fight times and XP with it
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

  // The client's own sale call: it sends ShopPlayerSell for the item at (bag, slot), the request the
  // Sell Item button sends for the cursor and a merchant window sends for a selected item. Client
  // functions come from the bridge (`surface.FUNCTIONS` in src/bridge.js).
  const sellAt = (bag, slot) => iq().clientFn("sell")(bag, slot);
  // The call behind the Auto Bank macro: a banker courier arrives and sends crafting ingredients
  // and spell scrolls to the tradeskill bank. Nothing is sold or destroyed. It takes the scene's
  // world-interaction port, which the client hands to its UI through a React context, so it is
  // read from the provider's props in the React tree. It reports in chat and returns nothing.
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
    await iq().clientFn("autoBank")("banker", interactionPort());
    return null;
  };

  const characterNames = (i) => {
    const p = i.stores.character.getState().characterProfile ?? {};
    const comps = i.stores.companions.getState().companions ?? [];
    return new Set([p.name, ...comps.filter((c) => c.companionType === 0 || c.companionType === 2).map((c) => c.name)]);
  };

  /**
   * Carried items that can be sold, cheapest loss first. Skips containers, NO DROP and NO RENT
   * items, items without a merchant price, `keepItemIds`, the gear plan's `gearKeepIds`, reagents of the leader's class spells,
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
      if (d.nodrop === 0 || d.norent === 0 || !(d.price > 0) || config.keepItemIds.includes(r.itemid) || config.gearKeepIds.includes(r.itemid) || reagents.has(r.itemid)) continue;
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

  const sellSurplus = async (i, force = false) => {
    let space = i.bagSpace();
    if ((!force && now() < state.pauseUntil) || space.cursor || space.free >= config.minFreeSlots) return;
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
  // From level 5 a death costs the leader level squared times 666.67 XP (16,666 at 5, 24,000 at 6,
  // about 963,000 at 38). The window offers a free group resurrection when the party can cast one,
  // resurrections that restore 50, 90 or 96% of the loss for platinum, and a free respawn at the
  // bind point that restores nothing. A resurrection also puts the leader back at the corpse.
  const leaderDead = (i) => !(i.stores.character.getState().characterProfile?.curHp > 0);
  // The highest restore the leader can pay: free offers always, paid ones up to `rezMaxPp` and only
  // while `rezReservePp` stays for spells. Offers are { percent, price } in platinum.
  const recoveryChoice = (offers, coinPp) => {
    const budget = Math.min(config.rezMaxPp, coinPp - config.rezReservePp);
    const best = offers.filter((o) => o.price === 0 || o.price <= budget).sort((a, b) => b.percent - a.percent || a.price - b.price)[0];
    return best ?? null;
  };
  // Manage Money moves another character's whole balance, carried and banked, to the active one,
  // so coin cannot be split ahead of time. A dead leader that cannot pay for a resurrection pulls
  // the largest balance it may take instead, and the coin stays there until another leader needs it.
  const pullCoin = async (i, minPp) => {
    const cb = i.stores.combat.getState();
    cb.openManageMoney();
    let panel = null;
    for (let k = 0; k < 30; k++) {
      await sleep(250);
      panel = document.querySelector('[data-testid="manage-money-panel"]');
      if (panel && !panel.querySelector('[aria-busy="true"]') && !/Loading balances/.test(panel.textContent ?? "")) break;
    }
    const rows = [...(panel?.querySelectorAll('tbody tr[data-testid^="money-row-"]') ?? [])].map((tr) => {
      const tds = [...tr.querySelectorAll("td")].map((td) => td.textContent.trim());
      return { name: tds[0], pp: Number((/([\d,]+)\s*pp/.exec(tds[3] ?? "")?.[1] ?? "0").replace(/,/g, "")), button: tr.querySelector("button") };
    });
    const pick = rows.filter((r) => r.button && !r.button.disabled && r.pp >= minPp && !config.coinKeepNames.includes(r.name)).sort((a, b) => b.pp - a.pp)[0];
    if (pick) {
      pick.button.click();
      await sleep(2000);
    }
    i.stores.combat.getState().closeManageMoney();
    return pick ? `${pick.name} (${pick.pp}pp)` : null;
  };
  const watchDeath = async (i) => {
    if (!leaderDead(i)) {
      state.deadSince = null;
      return;
    }
    state.deadSince ??= now();
    const dialog = document.querySelector('[role="dialog"][aria-label="Resurrection"]');
    if (!dialog) {
      // The window opens by itself once recovery is ready. A closed one reopens with its button.
      document.querySelector('[data-testid="death-recovery-reopen"] button')?.click();
      return;
    }
    if (/Loading recovery options|Recovering…/.test(dialog.textContent ?? "")) return;
    const label = (b) => b.getAttribute("aria-label") ?? "";
    const offers = [];
    for (const b of dialog.querySelectorAll("button")) {
      const paid = /^Resurrect for ([\d,]+)pp$/.exec(label(b));
      if (!paid && !/^Group resurrection/.test(label(b))) continue;
      const pct = /(\d+)%/.exec(b.parentElement?.textContent ?? "");
      if (pct && !b.disabled) offers.push({ button: b, percent: Number(pct[1]), price: paid ? Number(paid[1].replace(/,/g, "")) : 0 });
    }
    const p = i.stores.character.getState().characterProfile ?? {};
    const coinPp = (p.platinum ?? 0) + (p.gold ?? 0) / 10 + (p.silver ?? 0) / 100 + (p.copper ?? 0) / 1000;
    const pick = recoveryChoice(offers, coinPp);
    if (pick) {
      pick.button.click();
      state.deadSince = now();
      // A resurrection chosen in the window leaves AutoLevel paused at the corpse.
      state.restartNow = "the resurrection";
      alert("respawn", `the leader was dead at level ${p.level}; resurrected with ${pick.percent}% of the lost XP for ${pick.price ? `${pick.price}pp` : "free"}`);
      return;
    }
    const cheapest = Math.min(...offers.filter((o) => o.price > 0 && o.price <= config.rezMaxPp).map((o) => o.price));
    if (config.rezPullCoin && Number.isFinite(cheapest) && state.coinPullFor !== state.deadSince) {
      state.coinPullFor = state.deadSince;
      const from = await pullCoin(i, cheapest + config.rezReservePp - coinPp);
      log(from ? `pulled the coin of ${from} to pay for a resurrection` : "no account balance large enough for a resurrection");
      return; // the next tick reads the new balance
    }
    if (now() - state.deadSince < config.respawnAfterSec * 1000) return;
    const free = [...dialog.querySelectorAll("button")].find((b) => label(b) === "Respawn at Bind");
    if (!free) return;
    free.click();
    state.deadSince = now();
    alert("respawn", `the leader was dead at level ${p.level}; took the free respawn at the bind point${offers.length ? ` (${Math.floor(coinPp)}pp carried, no resurrection within the limits)` : ""}`);
  };
  // The group's account characters (`partyIds` and the leader) that are not in the party now.
  const partyMissing = (i) => {
    const present = new Set((i.stores.companions.getState().companions ?? []).filter((c) => c.companionType === 2).map((c) => Number(c.characterId)));
    const me = Number(i.stores.character.getState().characterProfile?.id);
    const group = [...new Set([...config.partyIds, config.leaderId].filter((id) => id != null).map(Number))];
    return group.filter((id) => !present.has(id) && id !== me);
  };
  const keepAutoLevel = (i, cb) => {
    if (cb.isRunning) {
      state.offSince = null;
      state.restartNow = null;
      return;
    }
    if (now() < state.pauseUntil || i.guard?.phase === "leaving" || !i.socket.isConnected || leaderDead(i)) return;
    // Companions asked to rejoin arrive one every 2.5 s, and a pull before they do fights short-handed.
    if (now() - state.rejoinAt < 30000 && partyMissing(i).length) return;
    state.offSince ??= now();
    // When another player holds the chosen target, the client gives it up with "Looking for another
    // target." and sometimes stops AutoLevel instead of retrying (CAUokwED.js:5400-5426). That stop
    // is the client's, not a person's, so it restarts at the next tick, within a minute of the line.
    // The bot's own resurrections and switches restart it at once as well (`restartNow` says which).
    const contested = state.abandonAt && now() - state.abandonAt < 60000;
    if (contested || state.restartNow) {
      state.abandonAt = null;
      cb.startAutoLevel();
      state.offSince = now();
      if (state.restartNow) {
        log(`restarted AutoLevel after ${state.restartNow}`);
        state.restartNow = null;
        return;
      }
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

  // ---- Enemies worth their time -------------------------------------------------------------
  // The party's fight time and XP per enemy name, from the chat: an engage line opens a fight and
  // the kill line of the same enemy closes it. What an enemy pays per second of fighting is the
  // base of the value the party puts on it (docs/plans/controller.md). An enemy that pays less
  // than `slowFoeShare` of the party's usual rate, or whose fight had to be left, is skipped until
  // the leader is two levels higher, because the party gains spells, pets and weapons that change
  // what it can fight.
  const foeKey = (name) => String(name ?? "").replace(/_/g, " ").trim().toLowerCase();
  const myLevel = (i) => i.stores.character.getState().characterProfile?.level ?? 0;
  const foeRecord = (i, name) => {
    const lvl = myLevel(i);
    const f = state.foes[name];
    if (!f || lvl >= f.level + 2) state.foes[name] = { fights: 0, secs: 0, xp: 0, slow: 0, level: lvl };
    return state.foes[name];
  };
  const recordFight = (i, line, t) => {
    let m;
    if ((m = /^You engage (.+?) in combat!/.exec(line))) {
      state.fight = { name: foeKey(m[1]), t };
    } else if ((m = /^You have (?:defeated|slain) (.+?)(?: and gained (\d+) experience!|, but gain no experience\.)/.exec(line)) && state.fight?.name === foeKey(m[1])) {
      const f = foeRecord(i, state.fight.name);
      f.fights++;
      f.secs += Math.max(1, (t - state.fight.t) / 1000);
      f.xp += Number(m[2] ?? 0);
      state.fight = null;
    }
  };
  /** Names of the enemies the party skips: fights it had to leave, or a rate far below its usual one. */
  const slowFoes = (i) => {
    const lvl = myLevel(i);
    const fresh = Object.entries(state.foes).filter(([, f]) => lvl < f.level + 2);
    const secs = fresh.reduce((s, [, f]) => s + f.secs, 0);
    const usual = secs > 0 ? fresh.reduce((s, [, f]) => s + f.xp, 0) / secs : 0;
    return new Set(fresh.filter(([, f]) => f.slow > 0 || (f.secs >= 120 && f.xp / f.secs < config.slowFoeShare * usual)).map(([name]) => name));
  };
  // A fight that makes no headway costs the party every second it lasts. After `slowFightSec`
  // with the enemy it pulled still above half its HP, the guard leaves it the way it leaves a
  // dangerous one, which also skips that fight's enemies for a while.
  const leaveSlowFight = (i, cb) => {
    const f = state.fight;
    if (!f || !config.slowFightSec || now() - f.t < config.slowFightSec * 1000 || leaderDead(i)) return;
    if (!i.stores.skills.getState().inCombat) {
      state.fight = null; // it ended without a kill line, such as by an escape or a zone change
      return;
    }
    const e = state.errand;
    if (e?.arrived && enemyPattern(e.keep).test(f.name)) return; // an errand's enemy is worth its time
    const mob = Object.values(cb.engagedMobs ?? {}).find((x) => foeKey(x.name) === f.name && x.state === "alive");
    if (!mob || !(mob.hp > mob.maxHp / 2) || typeof i.leaveFight !== "function") return;
    const secs = Math.round((now() - f.t) / 1000);
    const r = foeRecord(i, f.name);
    r.slow++;
    r.secs += secs;
    state.fight = null;
    i.leaveFight(`${f.name} kept ${Math.round((100 * mob.hp) / mob.maxHp)}% of its HP for ${secs} s`);
    alert("slowFight", `left a fight with ${f.name} after ${secs} s at ${Math.round((100 * mob.hp) / mob.maxHp)}% of its HP; the party skips it until level ${r.level + 2}`);
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
      recordFight(i, text, e.t ?? now());
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
        const lvl = i.stores.character.getState().characterProfile?.level ?? 0;
        if (who === "You" || names.has(who)) (state.deaths ??= []).push({ t: e.t ?? now(), text, leader: who === "You", lostXp: who === "You" && lvl >= 5 ? lvl * lvl * 666.67 : 0 });
      } else if ((m = /inventory is full, you could not loot (.+?)\.?$/i.exec(text))) state.lootFails.push({ t: e.t ?? now(), item: m[1] });
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

  // A death costs the fight and the wait that follows it beyond a kill's (tools/fights.mjs, "What
  // escapes and deaths cost": 38 s more for a companion, 85 s more for the leader), and the
  // leader's also costs level squared times 666.67 XP, which takes as long to earn again as the
  // party's XP rate of the hour says. Companions' deaths cost only time, so a tougher target band
  // can be worth a few of them: only when their cost passes `deathCostShareAlert` of the hour does a
  // script decide about the zone or the limits.
  const DEATH_EXTRA_SEC = { member: 38, leader: 85 };
  const watchDeaths = (i) => {
    state.deaths = (state.deaths ?? []).filter((d) => d.t > now() - 3600000);
    if (!state.deaths.length || now() - (state.deathAlertAt ?? 0) < 3600000) return;
    const xpPerSec = (i.kills ?? []).filter((k) => k.t > now() - 3600000).reduce((s, k) => s + (k.xp ?? 0), 0) / 3600;
    const cost = state.deaths.reduce((s, d) => s + (d.leader ? DEATH_EXTRA_SEC.leader + (xpPerSec > 0 ? d.lostXp / xpPerSec : 0) : DEATH_EXTRA_SEC.member), 0);
    if (cost < config.deathCostShareAlert * 3600) return;
    state.deathAlertAt = now();
    const leader = state.deaths.filter((d) => d.leader).length;
    alert("deaths", `${state.deaths.length} deaths in the last hour (${leader} of the leader) cost about ${Math.round(cost / 60)} minutes, the last: ${state.deaths.at(-1).text}`, true);
  };

  // The client's auto-place call, which puts the cursor item into the first place that fits.
  const autoPlace = () => iq().clientFn("autoPlace")();

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
      // With every bag slot taken the item can only leave by sale, and while it sits there the
      // cleanup cannot free space either, so a cheap unprotected item is sold, such as the book a
      // quest NPC hands back.
      const row = (i.stores.character.getState().characterProfile?.inventory ?? []).find((x) => x.bag === 0 && x.slot === 30);
      const d = row?.itemDetails;
      if (still && i.bagSpace().free === 0 && d && d.price > 0 && d.price <= config.junkMaxCopper && d.nodrop !== 0 && !config.keepItemIds.includes(row.itemid) && !config.gearKeepIds.includes(row.itemid) && !(i.questItems ?? []).includes(row.itemid)) {
        const s = await sellAt(0, 30);
        log(`sold cursor item ${held} because the bags are full: ${s?.message ?? "no reply"}`);
      }
    }
  };

  // ---- Idle remedies -----------------------------------------------------------------------
  // One table maps each idle cause of the page's activity label (src/bridge.js, "Activity") to a
  // ladder of remedies (docs/plans/controller.md, principle 3). A rung runs once the cause has
  // lasted `afterSec`, the next one if the same cause outlasts `afterSec` again, and a rung with
  // nothing to do passes to the next at once. When the ladder is used up, an alert wakes a script.
  // "off" is keepAutoLevel's, "afterKill" is the client's own pause after a kill, and an errand
  // waits for its spawns on purpose, so it gets the restarts only.
  const REMEDIES = {
    waitAttack: { afterSec: 20, rungs: ["restart"] },
    readyWait: { afterSec: 30, rungs: ["restart"] },
    noTarget: { afterSec: 20, rungs: ["restart", "widen", "move"] },
    crowded: { afterSec: 60, rungs: ["widen", "move"] },
    noEnemies: { afterSec: 0, rungs: ["widen", "move"] },
  };
  const restartAutoLevel = (cb) => {
    cb.setIsRunning(false);
    setTimeout(() => iq()?.stores.combat.getState().startAutoLevel(), 1500);
  };
  const remedies = {
    restart: (i, cb) => {
      restartAutoLevel(cb);
      return "restarted AutoLevel";
    },
    // Undo what narrowed the limits: the guard's tightening first, then a minimum con above blue.
    // `keepLimits` returns them to `limits` after `widenMin`.
    widen: (i, cb) => {
      const p = i.guard?.preferred;
      if (p) {
        i.guard.preferred = null;
        setLimits(cb, p);
        state.widenedAt = now();
        restartAutoLevel(cb);
        return `back to con ${p.minCon}..${p.maxCon}, cap ${p.maxLevelDiff} from before the guard tightened them`;
      }
      if (cb.minCon > 4) {
        const was = cb.minCon;
        cb.setMinCon(4);
        state.widenedAt = now();
        restartAutoLevel(cb);
        return `lowered minimum con from ${was} to blue (4)`;
      }
      return null;
    },
    move: async (i, cb, why) => (nextZone(i) && (await rotate(i, why)) ? "moved to another rotation zone" : null),
  };
  // The setters overwrite each other in this order (docs/client-internals.md).
  const setLimits = (cb, l) => {
    cb.setMaxCon(l.maxCon);
    cb.setMinCon(l.minCon);
    cb.setMaxLevelDiff(l.maxLevelDiff);
  };
  const sameLimits = (cb, l) => cb.minCon === l.minCon && cb.maxCon === l.maxCon && cb.maxLevelDiff === l.maxLevelDiff;
  // Remedies, errands, camps and the guard change AutoLevel's limits for a reason that passes, and
  // without a way back the limits drifted: groups hunted at blue for hours after one crowded
  // minute. The limits return to `limits` once nothing holds them: no errand or task, no tightening
  // by the guard, which returns by itself after a quiet hour, and no widening within `widenMin`.
  // The options live per character on the server, so a character switch brings the new
  // character's own. Each setting flips with its toggle (`autoUpgradeEnabled`, `toggleAutoUpgrade`).
  const keepOptions = (cb) => {
    for (const [key, want] of Object.entries(config.clientOptions ?? {})) {
      const toggle = cb[`toggle${key[0].toUpperCase()}${key.slice(1).replace(/Enabled$/, "")}`];
      if (key in cb && cb[key] !== want && typeof toggle === "function") {
        toggle();
        log(`client option ${key} set to ${want}`);
      }
    }
  };
  const keepLimits = (i, cb) => {
    const l = config.limits;
    if (!l || state.errand || state.task?.status === "running" || i.guard?.preferred || now() - (state.widenedAt ?? 0) < config.widenMin * 60000 || sameLimits(cb, l)) return;
    log(`AutoLevel limits back to con ${l.minCon}..${l.maxCon}, cap ${l.maxLevelDiff} from ${cb.minCon}..${cb.maxCon}, cap ${cb.maxLevelDiff}`);
    setLimits(cb, l);
  };
  const watchIdle = async (i, cb) => {
    const a = i.activity?.();
    const spec = a?.act === "idle" ? REMEDIES[a.why] : null;
    // A rooted member keeps the readiness wait on, and Nullify Magic (`watchRoots`) breaks roots.
    if (!spec || (a.why === "readyWait" && partyRoots(i).length)) return void (state.idleCase = null);
    let c = state.idleCase;
    if (!c || c.why !== a.why) c = state.idleCase = { why: a.why, rung: 0, at: a.since };
    if (now() - c.at < spec.afterSec * 1000) return;
    const rungs = state.errand ? spec.rungs.filter((r) => r === "restart") : spec.rungs;
    const zone = i.stores.staticData.getState().zones.find((z) => z.zoneidnumber === cb.currentZone)?.longName ?? "this zone";
    while (c.rung < rungs.length) {
      const done = await remedies[rungs[c.rung++]](i, cb, `idle (${a.why}) in ${zone}`);
      if (done) {
        c.at = now();
        log(`remedy for idle (${a.why}): ${done}`);
        return;
      }
    }
    if (!c.alerted) {
      c.alerted = true;
      alert("idle", `idle (${a.why}) in ${zone} after every remedy (${rungs.join(", ") || "none during an errand"})`, true);
    }
  };

  // AutoLevel picks the nearest enemy that passes its con and level filters and is not on the
  // client's skip list (`deferAutoLevelSpawn`, which the client uses for spawns it cannot reach).
  // Enemies named by `avoidNames` and the slow ones (`slowFoes`) stay on that list, so AutoLevel
  // pulls the others. An errand puts the enemies its `keep` pattern names first, inside normal
  // hunting: while one of them is alive in the errand's zone and AutoLevel could pull it (inside
  // its level bounds, not skipped and not another player's), every other enemy goes on the list
  // for a few seconds, so AutoLevel pulls the wanted one. With none such it hunts as usual, so an
  // errand never leaves the party idle. When the errand widened AutoLevel's range, the other
  // enemies outside the normal range stay on the list. The fast tick renews the entries.
  const avoidTargets = (i) => {
    const e = state.errand;
    const keep = e?.arrived && zoneShort(i) === e.zone ? e.keep : null;
    const slow = slowFoes(i);
    if (!config.avoidNames && !keep && !slow.size) return;
    const rt = runtime(i);
    if (!rt?.deferAutoLevelSpawn) return;
    const avoid = config.avoidNames ? enemyPattern(config.avoidNames) : null;
    const wanted = keep ? enemyPattern(keep) : null;
    const normal = keep && e.widened ? normalRange(i, e) : null;
    const targets = rt.combatScene.getAliveCombatTargetList?.() ?? [];
    const me = Number(i.stores.character.getState().characterProfile?.id);
    const { minLevel = -Infinity, maxLevel = Infinity } = rt.getAutoCombatLevelBounds?.() ?? {};
    const pullable = (t) => {
      const owner = Number(rt.combatScene.getCombatTargetBySpawnInstanceId?.(t.spawnInstanceId)?.spawn?.combatOwnerCharacterId ?? 0);
      return t.level >= minLevel && t.level <= maxLevel && !((rt.unreachableSpawnUntil?.get(t.spawnInstanceId) ?? 0) > now()) && !(owner > 0 && owner !== me);
    };
    const first = wanted && targets.some((t) => wanted.test(t.name ?? "") && pullable(t));
    const ms = (config.fastTickSec * 2 + 1) * 1000;
    for (const t of targets) {
      const name = t.name ?? "";
      const other = !wanted?.test(name);
      const outside = normal && (t.level < normal.minLevel || t.level > normal.maxLevel);
      if (avoid?.test(name) || (other && (first || outside || slow.has(foeKey(name))))) rt.deferAutoLevelSpawn(t.spawnInstanceId, ms);
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
      // The bridge's surface audit covers the stores, the socket and the client functions.
      const missing = i.missingApi ?? [];
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

  // The full party is part of the desired state. The client refuses new members during combat
  // ("You cannot add party members during combat"), and AutoLevel pulls again right after each
  // fight, so a party short of members stops pulling until the current fight ends, then gathers
  // them, and keepAutoLevel starts it again. Members the server does not offer as available, such
  // as one another tab plays, are not waited for.
  const keepParty = (i, cb) => {
    if (!config.partyIds.length || now() < state.pauseUntil) return;
    const available = new Set(i.stores.companions.getState().availableAccountCharacterIds ?? []);
    const missing = partyMissing(i).filter((id) => !available.size || available.has(id));
    if (!missing.length) return;
    if (i.stores.skills.getState().inCombat) {
      if (cb.isRunning) {
        cb.setIsRunning(false);
        log(`stopped pulling until ${missing.length} missing member(s) can join after this fight`);
      }
      return;
    }
    if (now() - state.rejoinAt < 20000) return;
    state.rejoinAt = now();
    i.stores.companions.getState().requestAccountCharacterAvailability();
    missing.forEach((id, k) => setTimeout(() => iq()?.stores.companions.getState().controlAccountCharacter(id), 2500 * (k + 1)));
    // Look again once the last of them should have arrived, so AutoLevel starts without waiting for the next tick.
    setTimeout(tick, 2500 * (missing.length + 1) + 500);
    state.restartNow = "the party gathered";
    alert("rejoin", `asked ${missing.length} account character(s) to rejoin the party: ${missing.join(", ")}`);
  };
  // ---- Leader -------------------------------------------------------------------------------
  // The active character converges to `leaderId` whenever no pause holds the tab. A switch camps
  // with the client's own command and enters the world as the character (`session.camp` and
  // `session.enterWorld`, the commands behind the Camp and ENTER WORLD buttons). It runs in the
  // page as a job, because it takes longer than one script call may last, and keepParty brings
  // the companions back afterwards. Failures back off, and the third in a row wakes a script.
  const SWITCH_TIMEOUT_MS = 180000;
  const characters = (i) => i.stores.roster?.getState?.().characters ?? [];
  const findCharacter = (i, who) => characters(i).find((c) => (typeof who === "number" ? Number(c.id) === who : String(c.name).toLowerCase() === String(who).toLowerCase())) ?? null;
  const command = (i, cmd, ms) => Promise.race([Promise.resolve(i.command(cmd)), sleep(ms).then(() => ({ ok: false, message: `${cmd.type} timed out` }))]);
  const switchSteps = async (i, target) => {
    const screen = () => i.stores.screen.getState().currentScreen;
    if (screen() === "game") {
      if (Number(i.stores.character.getState().characterProfile?.id) === Number(target.id)) return { ok: true, message: `${target.name} is active` };
      if (i.stores.skills.getState().inCombat) return { ok: false, message: "the party is in combat" };
      i.stores.combat.getState().setIsRunning(false);
      const r = await command(i, { type: "session.camp" }, 60000);
      if (!r?.ok) return { ok: false, message: `camping failed: ${r?.message ?? "no reply"}` };
    }
    if (screen() !== "characterSelect") return { ok: false, message: `the screen is ${screen()}, not character select` };
    // A numeric selector would pick by list position, so the command gets the name.
    const r = await command(i, { type: "session.enterWorld", selector: target.name }, 120000);
    return r?.ok ? { ok: true, message: `entered the world as ${target.name}` } : { ok: false, message: `entering as ${target.name} failed: ${r?.message ?? "no reply"}` };
  };
  /** Start making `who` (a name or a character id) the active character. Returns the job. */
  const switchTo = (i, who) => {
    const job = state.switching;
    if (job && !job.done && now() - job.startedAt < SWITCH_TIMEOUT_MS) return job;
    const target = findCharacter(i, who);
    if (!target) return (state.switching = { id: null, name: String(who), startedAt: now(), done: true, ok: false, message: `no account character ${who}` });
    const next = (state.switching = { id: Number(target.id), name: target.name, startedAt: now(), done: false, ok: null, message: "switching" });
    log(`switching to ${target.name}`);
    switchSteps(i, target)
      .catch((e) => ({ ok: false, message: String(e?.message ?? e) }))
      .then((r) => {
        Object.assign(next, r, { done: true });
        if (r.ok) {
          state.switchFails = 0;
          state.rejoinAt = 0; // the new active character gathers its party at once
          state.restartNow = `the switch to ${target.name}`;
          log(r.message);
          setTimeout(tick, 1000);
        } else {
          state.switchFails++;
          state.switchRetryAt = now() + Math.min(600000, 30000 * 2 ** (state.switchFails - 1));
          alert("switch", `could not switch to ${target.name}: ${r.message}`, state.switchFails >= 3);
        }
      });
    return next;
  };
  /**
   * One step toward `leaderId`. True while the active character is not the leader yet and the
   * rest of the tick, which serves the leader's party, should wait.
   */
  const reconcileLeader = (i) => {
    const job = state.switching;
    if (job && !job.done) {
      if (now() - job.startedAt < SWITCH_TIMEOUT_MS) return true;
      Object.assign(job, { done: true, ok: false, message: "timed out" });
    }
    const want = config.leaderId;
    if (want == null || now() < state.pauseUntil || inRaid(i)) return false;
    const screen = i.stores.screen.getState().currentScreen;
    if (screen === "game") {
      if (Number(i.stores.character.getState().characterProfile?.id) === Number(want)) return false;
      if (leaderDead(i)) return false; // the Resurrection window comes first
      if (i.stores.skills.getState().inCombat) return true;
    } else if (screen !== "characterSelect") {
      return false; // a login or loading screen is not the bot's to drive
    }
    if (now() < state.switchRetryAt) return true;
    switchTo(i, Number(want));
    return true;
  };

  // ---- Tasks --------------------------------------------------------------------------------
  // Work of several steps runs here, in the page, so a script only starts it and reads its
  // progress (docs/plans/controller.md). A task holds the pause while it runs, each step for as
  // long as that step may take. Its end, whether it finished, failed or was stopped, ends the
  // pause, so the bot restores the leader, the party, the zone and AutoLevel at once. A step that
  // fails is tried once more before the task gives up. `state.task` keeps the last task.
  class TaskStopped extends Error {}
  const withTimeout = (p, ms, what) => Promise.race([p, sleep(ms).then(() => Promise.reject(new Error(`${what} took longer than ${Math.round(ms / 1000)} s`)))]);
  const activeName = (i) => (i.stores.screen.getState().currentScreen === "game" ? (i.stores.character.getState().characterProfile?.name ?? null) : null);
  /** Stop AutoLevel and let the fight at hand end. */
  const calm = async (i) => {
    i.stores.combat.getState().setIsRunning(false);
    for (let k = 0; k < 70 && i.stores.skills.getState().inCombat; k++) await sleep(1000);
    if (i.stores.skills.getState().inCombat) throw new Error("the fight did not end");
  };
  const becomeActive = async (i, name) => {
    // A switch already under way for someone else finishes first.
    for (let k = 0; k < 2 && activeName(i) !== name; k++) {
      const job = switchTo(i, name);
      while (!job.done) await sleep(1000);
      if (!job.ok) throw new Error(job.message);
    }
    if (activeName(i) !== name) throw new Error(`${name} did not become active`);
  };
  const pullOne = async (i, item, from = null) => {
    if (i.bagSpace().free < 2) await sellSurplus(i, true);
    const r = await i.pullItem(item, { from });
    if (!r.got) throw new Error(`pulling ${item} from ${r.from} failed: ${r.reply ?? "no reply"}`);
  };
  // A gear task carries out moves of the roster gear plan (tools/lib/gear-plan.mjs): each pulls an
  // item from the account character that holds it, which Inventory Search does for NO DROP items
  // too, and gives it equipped to the character it suits best, in the party or not, so the tab
  // never switches characters. A move that fails is recorded and the next one runs.
  const gearTask = async (i, task, step) => {
    await step("stop", () => calm(i), 75000);
    for (const mv of task.moves) {
      if (mv.done || mv.error) continue;
      try {
        const to = findCharacter(i, mv.to);
        if (!to) throw new Error(`no account character ${mv.to}`);
        if (i.carried(mv.item) < 1) await step(`pull ${mv.item} from ${mv.from}`, () => pullOne(i, mv.item, mv.from), 45000);
        const r = await step(`give ${mv.item} to ${mv.to}`, () => i.giveItem(mv.item, Number(to.id), { equip: true }), 30000);
        if (!r.ok) throw new Error(`the transfer was refused${r.lines.length ? `: ${r.lines.at(-1)}` : ""}`);
        Object.assign(mv, { done: true, lines: r.lines });
      } catch (e) {
        if (e instanceof TaskStopped) throw e;
        mv.error = String(e?.message ?? e);
        log(`gear: ${mv.item} to ${mv.to} failed: ${mv.error}`);
      }
    }
    task.result = `${task.moves.filter((m) => m.done).length} of ${task.moves.length} moves`;
  };
  // A quest runs its `steps` for each member while that member is the active character, because
  // quest NPCs answer and reward the character in front of them. A step travels to its zone, pulls
  // the items it hands over from whoever on the account holds them, then talks to its NPC with
  // `say` keywords, gives `give` (one trade of up to four items), or hands in `each` per item as
  // `handInEach` does, and checks that the member then carries `expect`. A hand-in is a quest of one
  // `each` step per member. Entering the world puts a character where it last stood, and the zone
  // store can lag the switch, so every step travels.
  const questTask = async (i, task, step) => {
    for (const m of task.members) {
      if (m.done) continue;
      const t0 = now();
      await step(`stop for ${m.name}`, () => calm(i), 75000);
      await step(`switch to ${m.name}`, () => becomeActive(i, m.name), 200000);
      // A chain that stopped part way, in this task or an earlier one, goes on after the last step
      // whose reward the member carries, so no step repeats and no reward is asked for twice.
      const resume = m.steps.findLastIndex((s) => s.expect && i.carried(s.expect) > 0) + 1;
      m.at = Math.max(m.at ?? 0, resume);
      for (const [k, s] of m.steps.entries()) {
        if (k < m.at) continue;
        await step(`travel to ${s.zone}`, () => i.changeZone(s.zone), 90000);
        const need = { ...(s.each ?? {}) };
        for (const item of s.give ?? []) need[item] = (need[item] ?? 0) + 1;
        for (const [item, n] of Object.entries(need)) {
          while (i.carried(item) < n) await step(`pull ${item} for ${m.name}`, () => pullOne(i, item), 45000);
        }
        // The walk can cross a large zone, and talkToNpc gives up after two minutes without progress, so the step itself may last 15.
        if (s.say?.length || s.give?.length) await step(`talk to ${s.npc}`, () => i.talkToNpc(s.npc, s.say ?? []), 900000);
        if (s.give?.length) await step(`give to ${s.npc}`, () => i.giveToNpc(s.give), 60000);
        if (s.each) {
          const r = await step(`hand in for ${m.name}`, () => i.handInEach(s.npc, s.each), 300000);
          Object.assign(m, { trades: (m.trades ?? 0) + r.trades, items: (m.items ?? 0) + r.items, xp: (m.xp ?? 0) + r.xp });
        }
        if (s.expect) {
          for (let w = 0; w < 10 && i.carried(s.expect) < 1; w++) await sleep(500);
          if (i.carried(s.expect) < 1) throw new Error(`${m.name} did not get ${s.expect} from ${s.npc}`);
        }
        m.at = k + 1;
      }
      Object.assign(m, { done: true, sec: Math.round((now() - t0) / 1000) });
      log(`quest: ${m.name} done in ${m.sec} s${m.xp ? `, ${m.items} items for ${m.xp} XP` : ""}`);
    }
  };
  // A directed hunt fights the enemies its `keep` pattern names through the Enemy Targets action,
  // the way a click on that list does with "attack on arrival": the client walks to the closest
  // alive spawn of those NPCs and starts the fight there (`selectEnemyTarget`,
  // docs/client-internals.md). AutoLevel never pulls enemies that con gray, so this is how a party
  // far above them gets their drops. The leader loots, and NO DROP pieces move between account
  // characters with Inventory Search, so a hunt never switches characters. `zone` may list several
  // zones with the same enemies: when none is up where the hunt is, it moves on to the next one,
  // and it waits a minute in each only after a round found none anywhere. It ends when `item` is in
  // the bags, when none of those enemies has been up for `waitMin` minutes, or after `minutes`, and
  // the bot then restores the tab as after every task.
  const KILL_LINE = /^You have (?:defeated|slain) (.+?)(?: and gained \d+ experience!|, but gain no experience\.)/;
  const killedSince = (i, wanted, t0) => {
    const evs = i.events ?? [];
    for (let k = evs.length - 1; k >= 0 && evs[k].t >= t0; k--) {
      const m = KILL_LINE.exec(evs[k].text ?? "");
      if (m && wanted.test(m[1])) return true;
    }
    return false;
  };
  const directedKill = async (i, wanted) => {
    const rt = runtime(i);
    if (!rt?.selectEnemyTarget) throw new Error("the client's Enemy Targets action was not found");
    const cb = () => i.stores.combat.getState();
    const alive = (rt.combatScene.getAliveCombatTargetList?.() ?? []).filter((t) => wanted.test(t.name ?? ""));
    if (!alive.length) return "none";
    for (let k = 0; k < 30 && (rt.combatActive || rt.combatApproach?.isBusy?.() || rt.buffPhaseActive || rt.preparationRetryTimer != null); k++) await sleep(1000);
    if (cb().isRunning) cb().setIsRunning(false);
    if (!cb().enemyTargetAttackOnArrival) cb().setEnemyTargetAttackOnArrival(true);
    const t0 = now();
    rt.selectEnemyTarget([...new Set(alive.map((t) => t.npcId))]);
    for (let k = 0; k < 150; k++) {
      await sleep(1000);
      if (killedSince(i, wanted, t0)) {
        await sleep(3000); // the loot settles
        return "killed";
      }
      const busy = i.stores.skills.getState().inCombat || rt.combatApproach?.attempt || rt.buffPhaseActive;
      if (!busy && now() - t0 > 15000) return "lost";
    }
    return "lost";
  };
  // With the wanted enemies' spawn points (`points`, spawn2 ids), a hunt camps them with the client's
  // own Spawn Camp (`startSpawnCamp` in the combat runtime), which kills whatever stands on them,
  // placeholders too, so the wanted NPC can roll at the next respawn. The camp ends when the item
  // is in the bags, at the deadline, or once every point waits for its respawn, and the earliest
  // respawn becomes `nextAt`, for a scheduler to come back then and not before.
  const CAMP_WAITING = /^Waiting for (the )?next spawn|^Waiting for another player/;
  const CAMP_HELD_RETRY_MS = 15 * 60000; // a camp another player holds is tried again after this
  const campPoints = async (i, task, wanted) => {
    const rt = runtime(i);
    const cb = () => i.stores.combat.getState();
    if (!rt?.startSpawnCamp) throw new Error("the client's Spawn Camp was not found");
    let kills = 0;
    let scanned = now();
    let waitingSince = null;
    // The camp takes only enemies inside AutoLevel's level range, and placeholders often con green
    // for the party that hunts a piece, so the minimum con drops to green (2, the lowest the client
    // offers) while the camp runs.
    const minCon = cb().minCon;
    if (minCon > 2) cb().setMinCon(2);
    rt.startSpawnCamp(task.points, 0, task.keep);
    try {
      while (now() < task.startedAt + task.minutes * 60000) {
        await sleep(2000);
        if (killedSince(i, wanted, scanned)) kills++;
        scanned = now();
        if (task.item && hasItem(i, task.item)) return { kills, result: `got ${task.item}` };
        const waiting = CAMP_WAITING.test(cb().spawnCampStatus ?? "") && !i.stores.skills.getState().inCombat;
        waitingSince = waiting ? (waitingSince ?? now()) : null;
        if (waitingSince && now() - waitingSince > 5000) {
          // The camp also waits when its points hold enemies it will not take: another player's, or
          // outside AutoLevel's level range. Those points are not cleared, so the hunt comes back later.
          const pts = (i.zoneSpawns?.spawns ?? []).filter((s) => task.points.includes(s.spawn2Id));
          const held = pts.filter((s) => s.state === "alive");
          if (held.length) {
            const owned = held.filter((s) => s.combatOwnershipState && s.combatOwnershipState !== "unowned").length;
            return { kills, nextAt: now() + CAMP_HELD_RETRY_MS, result: `camp held: ${held.map((s) => s.name.replace(/_/g, " ")).join(", ")} on the points (${owned} owned by another player, the rest outside AutoLevel's range)` };
          }
          const due = pts.filter((s) => s.nextRespawnAtMs > now()).map((s) => s.nextRespawnAtMs);
          const nextAt = due.length ? Math.min(...due) : null;
          return { kills, nextAt, result: `camp cleared${nextAt ? `, next spawn at ${new Date(nextAt).toTimeString().slice(0, 8)}` : ""}` };
        }
      }
      return { kills, result: "time is up" };
    } finally {
      cb().setIsRunning(false); // ends the camp as well
      if (cb().minCon !== minCon) cb().setMinCon(minCon);
    }
  };
  const huntTask = async (i, task, step) => {
    const wanted = enemyPattern(task.keep);
    const onArrival = Boolean(i.stores.combat.getState().enemyTargetAttackOnArrival);
    try {
      await step("stop", () => calm(i), 75000);
      // The leader loots, and a full bag leaves a drop on the corpse.
      await step("make room", async () => {
        await sellSurplus(i, true);
        if (i.bagSpace().free < 1) throw new Error(`${activeName(i)} has no free bag slot`);
      }, 120000);
      const zones = [].concat(task.zone);
      let at = 0;
      let empty = 0; // zones in a row without a wanted enemy
      await step(`travel to ${zones[at]}`, () => i.changeZone(zones[at]), 90000);
      task.kills = 0;
      let seen = now();
      while (now() < task.startedAt + task.minutes * 60000) {
        if (task.item && hasItem(i, task.item)) return void (task.result = `got ${task.item}`);
        if (task.points?.length) {
          const r = await step(`camp ${task.keep}`, () => campPoints(i, task, wanted), task.minutes * 60000);
          task.kills += r.kills;
          if (r.nextAt) task.nextAt = r.nextAt;
          return void (task.result = r.result);
        }
        const r = await step(`hunt ${task.keep}`, () => directedKill(i, wanted), 200000);
        if (r === "killed") {
          task.kills++;
          seen = now();
          empty = 0;
        } else if (r === "none") {
          empty++;
          if (empty >= zones.length && now() - seen >= task.waitMin * 60000) return void (task.result = `none of ${task.keep} up`);
          if (empty >= zones.length) await sleep(zones.length > 1 ? 60000 : 10000);
          if (zones.length > 1) {
            at = (at + 1) % zones.length;
            await step(`travel to ${zones[at]}`, () => i.changeZone(zones[at]), 90000);
          }
        }
      }
      task.result = task.item && hasItem(i, task.item) ? `got ${task.item}` : "time is up";
    } finally {
      i.stores.combat.getState().setEnemyTargetAttackOnArrival?.(onArrival);
    }
  };
  // A raid fights one target with the leader and recruited account characters in the client's raid
  // mode (`window.iq.raid`), where AutoLevel is off and the leader commands the fight. The task
  // buys an hour of raid time when none is left and an hour costs at most `maxPp`, releases the
  // party, recruits `members`, targets the boss (a daily boss by `bossKey`, or the enemy in the
  // zone whose name matches `target`), attacks with everyone, and follows the fight until the
  // boss dies, the raid wipes or `minutes` pass. Then it ends the raid, and the bot's party and
  // AutoLevel keepers restore the group. `task.fight` keeps what a wipe is read from: duration,
  // each member's damage and survival, and the raid log's last lines.
  const raidTask = async (i, task, step) => {
    const raid = i.raid;
    if (!raid) throw new Error("the bridge has no raid actions");
    const rt = runtime(i);
    await step("stop", () => calm(i), 75000);
    if (task.zone && zoneShort(i) !== task.zone) await step(`travel to ${task.zone}`, () => i.changeZone(task.zone), 90000);
    await step("raid time", async () => {
      if ((await raid.time()).active) return;
      if (!task.maxPp) throw new Error("no raid time left and maxPp is 0");
      const b = await raid.buyHour(task.maxPp);
      log(`task raid: bought an hour of raid time for ${b.pricePp}pp`);
    }, 30000);
    await step("open the raid", () => raid.open(), 30000);
    try {
      const ids = task.members.map((m) => findCharacter(i, m)?.id).filter((id) => id != null).map(Number);
      const joined = await step("recruit", () => raid.recruit(ids), 120000);
      task.recruited = joined.length;
      if (joined.length < ids.length) log(`task raid: ${ids.length - joined.length} of ${ids.length} members did not join`);
      if (task.bossKey) {
        const r = await step(`summon ${task.bossKey}`, () => raid.bosses(task.bossKey), 30000);
        task.spawnInstanceId = r.spawnInstanceId;
      }
      const wanted = task.target ? enemyPattern(task.target) : null;
      const boss = await step("target", async () => {
        for (let k = 0; k < 30; k++) {
          const list = rt?.combatScene.getAliveCombatTargetList?.() ?? [];
          const t = list.find((x) => (task.spawnInstanceId ? x.spawnInstanceId === task.spawnInstanceId : wanted?.test(x.name ?? "")));
          if (t) {
            rt.selectEnemyTarget([t.npcId]);
            await sleep(1000);
            if (i.stores.combat.getState().targetNPC?.spawnInstanceId) return t;
          }
          await sleep(2000);
        }
        throw new Error(`no ${task.target ?? task.bossKey} to target in ${zoneShort(i)}`);
      }, 90000);
      const t0 = now();
      await step(`attack ${boss.name}`, async () => raid.attack(), 15000);
      task.fight = { boss: boss.name, startedAt: t0 };
      const bossAlive = () => (rt?.combatScene.getAliveCombatTargetList?.() ?? []).some((x) => x.spawnInstanceId === boss.spawnInstanceId);
      const outcome = await step(`fight ${boss.name}`, async () => {
        let s;
        while (now() < task.startedAt + task.minutes * 60000) {
          await sleep(2000);
          s = raid.state();
          task.fight.roster = s.roster.map((m) => ({ name: m.name, damage: m.damage, alive: m.alive }));
          task.fight.log = s.log.slice(-15);
          if (s.combat) continue;
          // The kill line's wording in raid mode is unverified, so a boss gone from the alive list counts too.
          if (killedSince(i, enemyPattern(boss.name), t0) || !bossAlive()) return "killed";
          return s.leaderDead || !s.roster.some((m) => m.alive) ? "wiped" : "ended";
        }
        return "time is up";
      }, task.minutes * 60000 + 60000);
      Object.assign(task.fight, { outcome, seconds: Math.round((now() - t0) / 1000), alive: task.fight.roster?.filter((m) => m.alive).length ?? 0 });
      task.result = `${outcome} ${boss.name} in ${task.fight.seconds} s with ${task.fight.alive} of ${task.fight.roster?.length ?? 0} standing`;
      if (outcome === "killed") alert("raid", `killed ${boss.name}`, true);
    } finally {
      await raid.end().catch((e) => log(`task raid: end raid failed: ${e?.message ?? e}`));
    }
  };
  const TASKS = { handIn: questTask, quest: questTask, hunt: huntTask, raid: raidTask, gear: gearTask };
  const startQuest = (kind, members, name = kind) => {
    if (state.task?.status === "running") throw new Error(`the ${state.task.kind} task is still running`);
    if (!members.length) throw new Error(`a ${kind} needs members`);
    for (const m of members) if (!findCharacter(iq(), m.name)) throw new Error(`no account character ${m.name}`);
    state.task = { id: `${kind}-${now().toString(36)}`, kind, name, startedAt: now(), members: members.map((m) => ({ ...m, done: false })) };
    return { ...runTask(state.task) };
  };
  const taskSummary = (task) =>
    task.kind === "hunt"
      ? `${task.kills ?? 0} kills of ${task.keep} in ${task.zone}${task.result ? `, ${task.result}` : ""}`
      : task.kind === "raid" || task.kind === "gear"
        ? (task.result ?? `${task.target ?? task.bossKey ?? "no moves"}, not run`)
        : (task.members ?? []).map((m) => `${m.name} ${m.done ? (m.xp != null ? `${m.items} items ${m.xp} XP` : "done") : `not done after ${m.at ?? 0} of ${m.steps.length} steps`}`).join(", ");
  const runTask = (task) => {
    const runner = Math.random().toString(36).slice(2);
    Object.assign(task, { runner, status: "running", heartbeat: now() });
    const step = async (label, fn, timeoutMs) => {
      for (let attempt = 1; ; attempt++) {
        if (state.task !== task || task.runner !== runner || task.status !== "running") throw new TaskStopped();
        Object.assign(task, { step: label, heartbeat: now() });
        state.pauseUntil = Math.max(state.pauseUntil, now() + timeoutMs + 60000);
        state.pauseReason = `task ${task.kind}: ${label}`;
        try {
          return await withTimeout(fn(), timeoutMs, label);
        } catch (e) {
          if (e instanceof TaskStopped || attempt >= 2) throw e;
          log(`task ${task.kind}: ${label} failed, trying once more: ${e?.message ?? e}`);
          await sleep(3000);
        }
      }
    };
    // Only the task's current runner settles it: an older one, left by a reinstall, just stops.
    const mine = () => state.task === task && task.runner === runner;
    (async () => {
      try {
        await TASKS[task.kind](iq(), task, step);
        if (mine()) task.status = "done";
      } catch (e) {
        if (mine() && task.status === "running") Object.assign(task, e instanceof TaskStopped ? { status: "stopped" } : { status: "failed", error: String(e?.message ?? e) });
      } finally {
        if (mine()) {
          task.endedAt = now();
          alert("task", `${task.kind} ${task.status}${task.error ? ` at "${task.step}": ${task.error}` : ""}; ${taskSummary(task)}`, task.status === "failed");
          state.pauseUntil = 0;
          state.pauseReason = null;
          state.restartNow ??= `the ${task.kind} task`;
          setTimeout(tick, 500);
        }
      }
    })();
    return task;
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
    // A new zone starts from the target limits: a widening was for the zone the party leaves.
    const limits = config.limits ?? { minCon: cb.minCon, maxCon: cb.maxCon, maxLevelDiff: cb.maxLevelDiff };
    log(`moving to ${dest}: ${why}`);
    cb.setIsRunning(false);
    try {
      const name = await i.changeZone(dest);
      const c = i.stores.combat.getState();
      setLimits(c, limits);
      state.widenedAt = 0;
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
  // errand's zone and hunts there, with the enemies whose names match `keep` first whenever
  // AutoLevel can pull one (`avoidTargets`), and rotation waits. The errand ends when the item is
  // in the bags, at its deadline, when the party is no longer in the zone, or after
  // `rotateEscapes` guard escapes there. Then AutoLevel's limits come back, and the rotation
  // rules take over: a party outside its rotation moves back into it.
  const hasItem = (i, name) => (i.inventory?.() ?? []).some((r) => r.name === name);
  const enemyPattern = (s) => new RegExp(s.replace(/[ _]/g, "[ _]"), "i");
  // AutoLevel's level range at the leader's level, as the limits were before the errand.
  const normalRange = (i, e) => {
    const shift = (i.stores.character.getState().characterProfile?.level ?? e.startLevel) - e.startLevel;
    return { minLevel: e.range.minLevel + shift, maxLevel: e.range.maxLevel + shift };
  };
  // An errand's enemies can lie outside AutoLevel's level range, such as the level 9 and 11 wisps
  // of Nektulos for a level 7 party that pulls levels 7 and 8. The errand widens the range just
  // enough to take them in, and `avoidTargets` keeps every other enemy outside the normal range
  // skipped, so the party hunts its usual band besides them. The levels come from the zone's
  // spawn list, so this waits until the party is in the zone.
  const widenForErrand = (i, e) => {
    const rt = runtime(i);
    const cb = () => i.stores.combat.getState();
    if (!rt?.getAutoCombatLevelBounds || zoneShort(i) !== e.zone) return;
    e.range ??= rt.getAutoCombatLevelBounds();
    e.startLevel ??= i.stores.character.getState().characterProfile?.level ?? 0;
    const wanted = enemyPattern(e.keep);
    const levels = (i.zoneSpawns?.spawns ?? []).filter((s) => wanted.test(s.name ?? "")).map((s) => s.level).filter(Number.isFinite);
    if (!levels.length) return;
    const lo = Math.min(...levels);
    const hi = Math.max(...levels);
    // Blue, then green, the lowest con AutoLevel pulls. The cap goes last, because the setters
    // overwrite each other in that order (docs/client-internals.md).
    for (const c of [4, 2]) {
      if (rt.getAutoCombatLevelBounds().minLevel <= lo) break;
      if (c < cb().minCon) cb().setMinCon(c);
    }
    if (rt.getAutoCombatLevelBounds().maxLevel < hi) cb().setMaxLevelDiff(Math.max(1, hi - (i.stores.character.getState().characterProfile?.level ?? hi)));
    e.widened = true;
    const b = rt.getAutoCombatLevelBounds();
    log(`errand: AutoLevel pulls levels ${b.minLevel} to ${b.maxLevel} for enemies of ${lo} to ${hi}, others only from ${e.range.minLevel} to ${e.range.maxLevel}`);
  };
  const endErrand = (i, why, failed) => {
    const e = state.errand;
    state.errand = null;
    if (e.widened) setLimits(i.stores.combat.getState(), config.limits ?? e.limits);
    // The visit clock restarts, so the rate rule judges the zone without the errand.
    state.zoneSince = now();
    state.zoneBestRate = 0;
    alert("errand", `${e.item ?? e.keep} in ${e.zone}: ${why}`, failed);
  };
  const watchErrand = async (i) => {
    const e = state.errand;
    if (!e?.arrived) return;
    if (!e.widened) widenForErrand(i, e);
    const cb = i.stores.combat.getState();
    if (e.item && hasItem(i, e.item)) return endErrand(i, `got ${e.item}`, false);
    // An errand without an item farms its enemies until its time is up, which is not a failure.
    if (now() > e.until) return endErrand(i, e.item ? `no ${e.item} after ${e.minutes} minutes` : `${e.minutes} minutes done`, Boolean(e.item));
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
      // The end of a pause is an event: whatever its script left behind, the bot restores at once.
      if (state.pauseUntil && now() >= state.pauseUntil) {
        log(`pause ended${state.pauseReason ? `: ${state.pauseReason}` : ""}`);
        state.pauseUntil = 0;
        state.pauseReason = null;
        state.restartNow ??= "the end of a pause";
      }
      // The other watchers serve the leader's party, so they wait while another character is active.
      if (reconcileLeader(i)) return;
      const cb = i.stores.combat.getState();
      if (i.stores.screen.getState().currentScreen !== "game" || cb.isZoneLoading || !i.stores.character.getState().characterProfile?.id) return;
      scanEvents(i);
      watchZone(i, cb);
      shareZone(i);
      await watchCursor(i);
      watchLoot(i);
      watchDeaths(i);
      if (inRaid(i)) {
        watchMemory();
        state.lastError = null;
        return;
      }
      if (config.respawnAfterSec > 0) await watchDeath(i);
      watchMemory();
      // A pause holds the tab for a script or a task: until it ends, the bot changes neither the
      // zone, the party, AutoLevel and its targets nor the gems and the bags.
      if (now() < state.pauseUntil) {
        state.lastError = null;
        return;
      }
      await watchErrand(i);
      await watchOutside(i);
      await watchRate(i);
      keepParty(i, cb);
      await watchIdle(i, cb);
      keepLimits(i, cb);
      keepOptions(cb);
      avoidTargets(i);
      keepAutoLevel(i, cb);
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
  // Auto Attack off, a root holding the readiness wait and a fight that makes no headway.
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
      leaveSlowFight(i, cb);
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
    /** The resurrection the bot would buy from `offers` ({ percent, price } in pp) with `coinPp` carried, or null to respawn. */
    recoveryChoice: (offers, coinPp) => recoveryChoice(offers, coinPp),
    /** Run the bag cleanup now, also during a pause, as below `minFreeSlots`. Resolves with the free slots after. */
    cleanup: async () => {
      await sellSurplus(iq(), true);
      return iq().bagSpace().free;
    },
    /** Memorize the planned gems and replace older pets now, out of combat. Returns what changed. */
    upkeep: (reason = "manual") => runUpkeep(iq(), reason),
    /**
     * Start making `who` (a name or a character id) the active character, in the page, and return
     * a copy of the job `{ id, name, startedAt, done, ok, message }`, which `state.switching` keeps
     * up to date. Hold a pause while another character than `leaderId` should stay active.
     */
    switchTo: (who) => ({ ...switchTo(iq(), who) }),
    /**
     * Hand items to a quest NPC for several account characters, each while it is the active
     * character, as a quest task (`questTask`) of one step per member. `members` lists `{ name,
     * counts }`, such as `{ name: "Mashidond", counts: { "Greater Lightstone": 2 } }`, and a member
     * short of an item pulls it from another account character first. The default NPC is Smith
     * Tv`ysa in South Ro, who pays 274,400 XP for a Greater Lightstone and 137,200 for a Lightstone.
     * Returns a copy of the task, which `state.task` keeps up to date.
     */
    handIn({ members, npc = "Tv`ysa", zone = "sro" }) {
      const task = startQuest("handIn", members.map((m) => ({ name: m.name, steps: [{ zone, npc, each: { ...m.counts } }] })));
      log(`task handIn: ${members.map((m) => `${m.name} ${Object.entries(m.counts).map(([k, v]) => `${v} ${k}`).join(" and ")}`).join(", ")} to ${npc} in ${zone}`);
      return task;
    },
    /**
     * Run quest `steps` for each of `members` (names), each while it is the active character, as a
     * task in the page (`questTask`). A step is `{ zone, npc, say, give, each, expect }`, such as
     * `{ zone: "freporte", npc: "Kargek Redblade", say: ["scabbard", "favor"], expect: "Wax Sealed
     * Note" }`. Returns a copy of the task, which `state.task` keeps up to date.
     */
    quest({ members, steps, name = "quest" }) {
      if (!steps?.length) throw new Error("a quest needs steps");
      const task = startQuest("quest", (members ?? []).map((n) => ({ name: n, steps })), name);
      log(`task quest ${name}: ${members.join(", ")}, ${steps.length} steps`);
      return task;
    },
    /**
     * Fight the enemies whose names match `keep` in `zone` (one zone or a list of zones with the same enemies) through the Enemy Targets action, as a
     * task in the page (`huntTask`), for drops from enemies AutoLevel does not pull, such as gray
     * ones. The leader loots, and a NO DROP piece moves to the character who needs it with
     * Inventory Search, as a hand-in does. The task ends when
     * `item` is in the bags, when none of those enemies was up for `waitMin` minutes, or after
     * `minutes`. With `points`, the wanted enemies' spawn points (spawn2 ids, `spawnPoints` in
     * tools/lib/content.mjs), the hunt camps them with the client's Spawn Camp instead, which kills
     * placeholders too, and ends once every point waits, with `nextAt` set to the first respawn
     * (`campPoints`). Returns a copy of the task, which `state.task` keeps up to date.
     */
    hunt({ zone, keep, item = null, minutes = 20, waitMin = 0, points = [] }) {
      if (state.task?.status === "running") throw new Error(`the ${state.task.kind} task is still running`);
      if (!zone || !keep) throw new Error("a hunt needs zone and keep");
      new RegExp(keep);
      state.task = { id: `hunt-${now().toString(36)}`, kind: "hunt", zone, keep, item, minutes, waitMin, points, startedAt: now() };
      log(`task hunt: ${keep} in ${zone}${item ? ` for ${item}` : ""}, up to ${minutes} min`);
      return { ...runTask(state.task) };
    },
    /**
     * Fight one raid target with the leader and the account characters `members` (names or ids),
     * as a task in the page (`raidTask`): `target`, a regular expression for an enemy of level 51
     * or more in `zone`, or `bossKey`, a daily boss from `iq.raid.bosses()`. An hour of raid time is
     * bought only when none is left and it costs at most `maxPp`. The task ends when the boss dies,
     * the raid wipes or `minutes` pass, and `task.fight` records the fight. Returns a copy of the
     * task, which `state.task` keeps up to date.
     */
    raid({ members, target = null, bossKey = null, zone = null, maxPp = 0, minutes = 15 }) {
      if (state.task?.status === "running") throw new Error(`the ${state.task.kind} task is still running`);
      if (!target === !bossKey) throw new Error("a raid needs either target or bossKey");
      if (!members?.length) throw new Error("a raid needs members");
      for (const m of members) if (!findCharacter(iq(), m)) throw new Error(`no account character ${m}`);
      if (target) new RegExp(target);
      state.task = { id: `raid-${now().toString(36)}`, kind: "raid", members: [...members], target, bossKey, zone, maxPp, minutes, startedAt: now() };
      log(`task raid: ${target ?? bossKey}${zone ? ` in ${zone}` : ""} with ${members.length} members, up to ${minutes} min`);
      return { ...runTask(state.task) };
    },
    /**
     * Carry out gear moves `[{ item, from, to, slot }]` from the roster gear plan as a task in the
     * page (`gearTask`): pull each item from its holder and give it equipped to its receiver.
     * Returns a copy of the task, which `state.task` keeps up to date.
     */
    gear({ moves }) {
      if (state.task?.status === "running") throw new Error(`the ${state.task.kind} task is still running`);
      if (!moves?.length) throw new Error("a gear task needs moves");
      state.task = { id: `gear-${now().toString(36)}`, kind: "gear", startedAt: now(), moves: moves.map((m) => ({ item: m.item, from: m.from, to: m.to, slot: m.slot ?? null })) };
      log(`task gear: ${moves.length} moves`);
      return { ...runTask(state.task) };
    },
    /** Stop the running task after its current step. The bot then gives the tab back to its leader. */
    stopTask() {
      if (state.task?.status === "running") state.task.status = "stopped";
      return state.task && { ...state.task };
    },

    /**
     * Hunt in `zone` with the enemies whose names match `keep` (a regular expression) first until
     * an item named `item` is in the bags, e.g. `{ zone: "kaesora", keep:
     * "gorged|hungered|famished", item: "Power of Water" }`. Without `item` the errand puts those
     * enemies first for `minutes`, such as the wisps of Nektulos for lightstones. AutoLevel's
     * range widens to take them in (`widenForErrand`), and `minutes` caps the errand.
     * `errand(null)` ends a running one.
     */
    async errand(opts) {
      const i = iq();
      if (opts === null) {
        if (state.errand) endErrand(i, "stopped", false);
        return "no errand";
      }
      const { zone, keep, item = null, minutes = 40 } = opts;
      if (state.errand) throw new Error(`the errand in ${state.errand.zone} is still running`);
      if (!zone || !keep) throw new Error("an errand needs zone and keep");
      new RegExp(keep);
      if (item && hasItem(i, item)) return `already carrying ${item}`;
      const cb = i.stores.combat.getState();
      const what = item ? `${item} from enemies matching ${keep}` : `enemies matching ${keep}`;
      state.errand = { zone, keep, item, minutes, limits: { minCon: cb.minCon, maxCon: cb.maxCon, maxLevelDiff: cb.maxLevelDiff }, arrived: false, since: now(), until: now() + minutes * 60000 };
      log(`errand: ${what} in ${zone}, up to ${minutes} min`);
      // A zone change waits for the fight at hand to end, so AutoLevel stops pulling meanwhile. The
      // wait stays under the 30 s a script's page call may last.
      if (zoneShort(i) !== zone && i.stores.skills.getState().inCombat) {
        i.stores.combat.getState().setIsRunning(false);
        for (let k = 0; k < 22 && i.stores.skills.getState().inCombat; k++) await sleep(1000);
      }
      if (zoneShort(i) !== zone && !(await moveTo(i, zone, `errand: ${what}`))) {
        state.errand = null;
        i.stores.combat.getState().startAutoLevel();
        throw new Error(`could not move to ${zone}`);
      }
      Object.assign(state.errand, { arrived: true, since: now(), until: now() + minutes * 60000 });
      widenForErrand(i, state.errand);
      return `hunting ${what} in ${zone}`;
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

    /**
     * Hold the tab for a script for `minutes`: the bot leaves the leader, the party, the zone and
     * AutoLevel alone. A pause always ends by itself; renew it to extend it. When it ends, the
     * bot restores all four from its settings at once.
     */
    pause(minutes = config.defaultPauseMin, reason = "") {
      state.pauseUntil = now() + minutes * 60000;
      state.pauseReason = reason || null;
      log(`pause for ${minutes} min${reason ? `: ${reason}` : ""}`);
      setTimeout(tick, minutes * 60000 + 500);
      return new Date(state.pauseUntil).toISOString();
    },

    /** End a pause now. The bot restores the leader, the party, the zone and AutoLevel at once. */
    resume() {
      if (state.pauseUntil) log("pause ended");
      state.pauseUntil = 0;
      state.pauseReason = null;
      state.restartNow ??= "the end of a pause";
      setTimeout(tick, 500);
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
  // A task that ran under the previous install goes on under this one from its recorded progress
  // (docs/plans/controller.md, principle 6), because the old runner's bridge stopped with the
  // reinstall. The old runner stops at its next step, since the task names a new runner. A raid
  // ends instead: its steps from the start would recruit a running raid again.
  if (state.task?.status === "running") {
    const task = state.task;
    setTimeout(() => {
      if (state.task !== task || task.status !== "running") return;
      if (task.kind === "raid") {
        Object.assign(task, { status: "stopped", endedAt: now() });
        iq()?.raid?.end().catch(() => {});
        alert("task", `raid stopped by a reinstall at "${task.step}"`, true);
        return;
      }
      log(`task ${task.kind}: resumed after a reinstall at "${task.step}"`);
      runTask(task);
    }, 2000);
  }
  return { installed: true, config };
})();
