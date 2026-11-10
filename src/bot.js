// In-page supervisor for unattended play.
//
// AutoLevel fights, loots and rests by itself. The supervisor does the routine work it leaves to a
// person: it keeps the tab on its leader and AutoLevel running unless one of its holds keeps it off,
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
  if (prev?.waker?.timer) clearTimeout(prev.waker.timer);

  // Settings changed with `set` override these defaults and are saved in the tab's sessionStorage.
  // It survives reloads of that tab, and a second session's tab does not see it, so two groups
  // never share a party list.
  const KEY = "iqBot.config";
  const DEFAULTS = {
    enabled: true,
    tickSec: 15,
    fastTickSec: 2, // Auto Attack and root checks, which lose play time for every second they wait
    restartAfterSec: 60, // AutoLevel off this long for no stated reason starts again. Manual movement cancels it, so a person's stop gets this long.
    defaultPauseMin: 20, // a pause ends by itself after this many minutes unless renewed
    // The bag reserve (docs/plans/inventory.md): below `minFreeSlots` free slots between fights the
    // bot makes room until `targetFreeSlots` are free, so a drop always fits.
    minFreeSlots: 8,
    targetFreeSlots: 16,
    autoBank: true, // making room starts with the game's Auto Bank, which sends ingredients and spell scrolls to the account banks
    discard: true, // surplus the client cannot sell (no price, NO DROP or NO RENT) is destroyed; false leaves it in the bags
    // Kept in every copy, besides the reagents of the leader's own spells. Lightstones (10300) and
    // Greater Lightstones (10400) are worth 137,200 and 274,400 XP each to Smith Tv`ysa in South Ro.
    keepItemIds: [10015, 10300, 10400],
    // Client options the bot keeps for every character it plays, by the combat store's state key. The
    // client's Auto-Upgrade equips each drop on the looting party only, the leader first, and never
    // moves it again, so the coordinator's roster gear pass (tools/lib/gear-plan.mjs) equips instead.
    // The server's Auto-Sell and Delete Clutter act only on full bags and by rules that do not know
    // what the account needs, so the bot's reserve (`keepReserve`) does their work. Rendering stays
    // off (Options, Graphics, Disable Rendering), which pauses 3D drawing while AutoLevel runs and
    // saves most of a tab's CPU, and the client forgets it at a sign-in (OSTsR53r.js:191477).
    // A screenshot of the world turns it on for its moment (`render`).
    clientOptions: { autoUpgradeEnabled: false, autoUpgradeCompanionsEnabled: false, autoSellEnabled: false, deleteNoDrop: false, disable3D: true },
    // Party tactics the bot keeps for every account companion. Cures stay off, because their casts
    // cost more than the short poisons and diseases they clear (docs/plans/leveling-plan.md, lever
    // 5), and the root dispel turns them on only while it runs (`dispelRoots`).
    companionTactics: { cure: false },
    // Charm cost XP: with it on, eight groups made 9% less per hour (-17% to -2%) in a crossover
    // (docs/plans/leveling-plan.md, lever 5), so the bot holds it off. Null would leave it alone.
    charm: false,
    dotMaxTicks: 0, // DoTs longer than this many ticks are left out for every caster (`keepExclusions`); 0 leaves none out
    gearKeepCounts: {}, // item id to the copies the roster gear plan (tools/lib/gear-plan.mjs) still needs: up to that many are kept
    gearKeepInstances: [], // the item copies the gear plan's moves take, kept until moved
    keepNames: [], // items the coordinator's hunts, errands and quest chains are for, by name, kept in every copy
    keepSupply: { 14: 20, 15: 20 }, // food (item type 14) and drink (15): units kept, from the largest stacks, which the server feeds the character from
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
    rotateBelowShare: 0.6, // move on when the XP per hour of play over the last 10 minutes falls below this share of the visit's best
    rotateMinStayMin: 20, // and only after this many minutes in the zone
    rotateEscapes: 4, // guard escapes in this zone within 10 minutes rotate immediately (0 = never)
    // AutoLevel's con and level limits, { minCon, maxCon, maxLevelDiff }, that the party returns to
    // after a zone change, an errand, a task, and `widenMin` minutes after a remedy widened them
    // (`keepLimits`). The default is Blue to Red up to 5 levels above the leader, because green
    // enemies pay no XP and a White minimum gained nothing at levels 15 to 19
    // (docs/plans/leveling-plan.md, lever 2). An optional `levelsBelow` floors the window that many
    // levels below the leader (`floorOf`). null leaves the limits as they are.
    limits: { minCon: 4, maxCon: 13, maxLevelDiff: 5 },
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
    restarts: [],
    eventCursor: null, // { ses, seq } of the last chat event looked at
    cursorSince: null,
    cursorAlerted: false,
    offlineSince: null,
    offlineAlerted: false,
    idleCases: {}, // cause -> { rung, at, began, errand, alerted }: the idle causes the remedy table works on
    heldAt: 0, // the last time a hold kept AutoLevel off or the bot stopped it, which the activity label reads
    heldBy: null, // what that hold was
    holding: false, // whether a hold held at the last look
    renderUntil: 0, // rendering stays on until then, for a screenshot of the world
    lootFails: [], // times of "could not loot" messages
    lootAlertAt: 0,
    deaths: [], // times of party deaths
    deathAlertAt: 0,
    rejoinAt: 0,
    switching: null, // { id, name, startedAt, done, ok, message } of the last character switch
    switchFails: 0, // failed switches in a row
    switchRetryAt: 0, // the leader is not switched to again before this time
    moveFails: 0, // failed zone moves in a row
    moveRetryAt: 0, // no zone move starts before this time
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
  // `extra` carries what the collector reads without parsing the text: `killed`, the boss a raid
  // killed (the progress feed, tools/lib/progress.mjs).
  const alert = (kind, text, wake = false, extra = {}) => {
    state.alerts.push({ seq: ++state.alertSeq, t: now(), kind, wake, text, ...extra });
    if (state.alerts.length > 300) state.alerts.splice(0, 100);
    log(`${wake ? "alert" : "note"} ${kind}: ${text}`);
  };

  // The client's own sale call: it sends ShopPlayerSell for the item at (bag, slot), the request the
  // Sell Item button sends for the cursor and a merchant window sends for a selected item. Client
  // functions come from the bridge (`surface.FUNCTIONS` in src/bridge.js).
  const sellAt = (bag, slot) => iq().clientFn("sell")(bag, slot);
  // The call behind the Auto Bank macro: a banker courier arrives and sends crafting ingredients
  // and spell scrolls to the tradeskill bank. Nothing is sold or destroyed. It takes the scene's
  // world-interaction port (`worldPort` in src/bridge.js). It reports in chat and returns nothing.
  const autoBank = async () => {
    await iq().clientFn("autoBank")("banker", iq().worldPort());
    return null;
  };

  const characterNames = (i) => {
    const p = i.stores.character.getState().characterProfile ?? {};
    const comps = i.stores.companions.getState().companions ?? [];
    return new Set([p.name, ...comps.filter((c) => c.companionType === 0 || c.companionType === 2).map((c) => c.name)]);
  };

  /**
   * The fate of every carried item outside containers (docs/plans/inventory.md): kept up to its
   * demand, the rest surplus. Demand keeps up to `gearKeepCounts` copies of an item, and every copy of `keepItemIds`, `keepNames`, the gear plan's
   * `gearKeepInstances` and the reagents of the leader's class spells, and food and drink up to
   * `keepSupply` units of each type, from the largest stacks. Surplus the client can sell (a price, not NO
   * DROP, not NO RENT) is `sell`, cheapest first, the rest `discard`. Returns `{ keep, sell,
   * discard }`, lists of `{ bag, slot, id, instanceId, name, quantity, price }`.
   */
  const fates = (i, withCursor = false) => {
    const inv = i.stores.character.getState().characterProfile?.inventory ?? [];
    const reagents = new Set((classTable(i)?.spells ?? []).flatMap((s) => s.reagents.map((x) => x.id)));
    const out = { keep: [], sell: [], discard: [] };
    const supplyLeft = { ...config.keepSupply };
    const gearLeft = { ...config.gearKeepCounts };
    const rows = inv.filter((r) => ((r.bag === 0 && r.slot >= 22 && r.slot <= 29) || (r.bag >= 23 && r.bag <= 30) || (withCursor && r.bag === 0 && r.slot === 30)) && r.itemDetails && !((r.itemDetails.bagslots || 0) > 0));
    // Food and drink come from the largest stacks, so the supply takes the fewest slots.
    rows.sort((a, b) => (b.quantity ?? 1) - (a.quantity ?? 1));
    for (const r of rows) {
      const d = r.itemDetails;
      const name = d.Name ?? d.name;
      const row = { bag: r.bag, slot: r.slot, id: r.itemid, instanceId: r.itemInstanceId, name, quantity: r.quantity ?? 1, price: d.price ?? 0 };
      const supply = supplyLeft[d.itemtype] > 0 && ((supplyLeft[d.itemtype] -= row.quantity), true);
      const gear = config.gearKeepInstances.includes(r.itemInstanceId) || (gearLeft[r.itemid] > 0 && gearLeft[r.itemid]--);
      if (supply || gear || config.keepItemIds.includes(r.itemid) || config.keepNames.includes(name) || reagents.has(r.itemid)) out.keep.push(row);
      else if (d.price > 0 && d.nodrop !== 0 && d.norent !== 0) out.sell.push(row);
      else out.discard.push(row);
    }
    out.sell.sort((a, b) => a.price * a.quantity - b.price * b.quantity);
    return out;
  };
  // Destroy the item at (bag, slot) through the cursor, as the client's Destroy button does. The
  // client refuses the destroy while the moved item's instance is still updating (OSTsR53r.js
  // 23385-23390), so it is repeated until the cursor is empty. `state.discarding` names the item the
  // bot put on the cursor, so a destroy cut short is finished later and a person's item is left alone.
  const destroyCursor = async (i) => {
    for (let k = 0; k < 10 && i.bagSpace().cursor; k++) {
      i.stores.character.getState().deleteItemOnCursor();
      await sleep(500);
    }
    if (i.bagSpace().cursor) return false;
    state.discarding = null;
    return true;
  };
  const discardAt = async (i, s) => {
    state.discarding = s.instanceId;
    if (!(await moveSlot(i, { bag: s.bag, slot: s.slot }, { bag: 0, slot: 30 }))) return false;
    return destroyCursor(i);
  };
  /**
   * The bag reserve: below `minFreeSlots` free slots, Auto Bank (at most every ten minutes, it is a
   * slow courier), then the cheapest loss first until `targetFreeSlots`: surplus without a price,
   * which nothing buys, then surplus sold cheapest first. When kept items alone leave too little
   * room, one alert an hour lists them, because only a decision about what the account keeps can help.
   */
  const keepReserve = async (i, force = false, withCursor = false) => {
    let space = i.bagSpace();
    if (space.cursor && state.discarding != null && rowAt(i, { bag: 0, slot: 30 })?.itemInstanceId === state.discarding) {
      log(`finishing the discard of ${space.cursor}: ${(await destroyCursor(i)) ? "done" : "refused again"}`);
      space = i.bagSpace();
    }
    if ((!force && now() < state.pauseUntil) || (space.cursor && !withCursor) || space.free >= config.minFreeSlots) return;
    if (config.autoBank && now() - (state.bankAt ?? 0) > 600000) {
      state.bankAt = now();
      const r = await autoBank().catch((e) => ({ success: false, message: String(e?.message ?? e) }));
      const after = i.bagSpace().free;
      if (r?.success || after > space.free) log(`auto bank: ${r?.message ?? "done"}; ${after} slots free`);
      space = i.bagSpace();
      if (space.free >= config.minFreeSlots) return;
    }
    const f = fates(i);
    let free = space.free;
    let acted = 0;
    let copper = 0;
    const sold = [];
    const gone = [];
    // Sales first left every discard behind for as long as sellable loot kept coming.
    const queue = [...(config.discard ? f.discard : []), ...f.sell.map((x) => ({ ...x, sell: true }))];
    for (const s of queue) {
      if (free >= config.targetFreeSlots || acted >= config.sellPerTick) break;
      // The client acts on whatever sits at (bag, slot) when the call runs, so check it is still ours.
      if (rowAt(i, s)?.itemInstanceId !== s.instanceId) break;
      const label = s.quantity > 1 ? `${s.quantity} ${s.name}` : s.name;
      if (s.sell) {
        const r = await sellAt(s.bag, s.slot);
        if (!r?.success) {
          log(`sale of ${s.name} at ${s.bag}/${s.slot} stopped: ${r?.message ?? "no reply"}`);
          break;
        }
        copper += r.data?.copperTotal ?? 0;
        sold.push(label);
      } else {
        if (!(await discardAt(i, s))) {
          log(`discarding ${s.name} at ${s.bag}/${s.slot} failed`);
          break;
        }
        gone.push(label);
      }
      acted++;
      free++;
      await sleep(400);
    }
    if (sold.length) log(`sold ${sold.length} surplus item(s) for ${copper} copper (${sold.join(", ")}); ${i.bagSpace().free} slots free`);
    if (gone.length) log(`discarded ${gone.length} surplus item(s) without a sale price (${gone.join(", ")}); ${i.bagSpace().free} slots free`);
    if (!queue.length && i.bagSpace().free < config.minFreeSlots && now() - (state.keptFullAlertAt ?? 0) > 3600000) {
      state.keptFullAlertAt = now();
      alert("bags", `${i.bagSpace().free} bag slots free and only kept items left: ${f.keep.map((k) => k.name).join(", ")}`, true);
    }
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
      const reopen = document.querySelector('[data-testid="death-recovery-reopen"] button');
      if (reopen) return void reopen.click();
      // A zone change that lands after the death, such as the guard's escape during a server
      // stall, leaves the leader at 0 HP with no recovery pending (`deathRecoveryReadyAt` 0), and
      // no window ever opens. Camping and entering the world again reloads the leader's state.
      const pending = Boolean(i.stores.character.getState().characterProfile?.deathRecoveryReadyAt);
      if (!pending && now() - state.deadSince > config.respawnAfterSec * 3000) {
        const me = i.stores.character.getState().characterProfile;
        alert("respawn", `the leader was at 0 HP for ${Math.round((now() - state.deadSince) / 1000)} s with no recovery pending; camping to enter the world again`);
        state.deadSince = now();
        switchTo(i, Number(me.id), { rejoin: true });
      }
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
      // A resurrection chosen in the window leaves AutoLevel off at the corpse, and the death was a
      // hold, so the remedy table starts it again.
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
  // ---- AutoLevel holds ----------------------------------------------------------------------
  // Whether AutoLevel runs is part of the desired state, and the remedy table below is the only
  // code that starts it (docs/plans/fault-handling.md). A hold keeps it off: a pause for a script
  // or a task, a raid, a page out of the world or in a zone change, a character switch or another
  // character than the leader in play, the guard's escape, a dead leader, or members still joining.
  // The bot stops AutoLevel only under a hold or for a fresh start (`holdAutoLevel`), and it notes
  // every hold in `state.heldAt`, so the page's activity label tells AutoLevel that went off under
  // a hold ("held") from the client's own stops and from a stop nothing explains (src/bridge.js).
  const pauseName = () => `the pause${state.pauseReason ? ` for ${state.pauseReason}` : ""}`;
  const autoLevelHold = (i) => {
    const p = i.stores.character.getState().characterProfile;
    if (now() < state.pauseUntil) return pauseName();
    if (inRaid(i)) return "the raid";
    if (state.switching && !state.switching.done) return `the switch to ${state.switching.name}`;
    if (!i.socket?.isConnected || i.stores.screen.getState().currentScreen !== "game" || !p?.id) return "a page out of the world";
    if (i.stores.combat.getState().isZoneLoading) return "a zone change";
    if (config.leaderId != null && Number(p.id) !== Number(config.leaderId)) return `${p.name} in play instead of the leader`;
    if (i.guard?.phase === "leaving") return "the guard's escape";
    if (leaderDead(i)) return "the leader's death";
    // Companions asked to rejoin arrive one every 2.5 s, and a pull before they do fights short-handed.
    if (now() - state.rejoinAt < 30000 && partyMissing(i).length) return "members joining";
    return null;
  };
  // Both ticks note the holds, and the end of one wakes the tick, so AutoLevel starts without
  // waiting for the next interval.
  const noteHold = (i) => {
    const hold = autoLevelHold(i);
    if (hold) Object.assign(state, { heldAt: now(), heldBy: hold, holding: true });
    else if (state.holding) {
      state.holding = false;
      wake(500);
    }
  };
  /** The bot's every stop of AutoLevel, for `why`. The next tick starts it again once no hold remains. */
  const holdAutoLevel = (cb, why) => {
    cb.setIsRunning(false);
    Object.assign(state, { heldAt: now(), heldBy: why });
    wake(1500);
  };
  // A pause ends here, whether it ran out, its task ended or a script resumed the bot. It was a
  // hold, so AutoLevel starts at once, and the tick restores the leader, the party and the zone.
  const endPause = (what) => {
    if (state.pauseUntil) log(`${what} ended`);
    Object.assign(state, { pauseUntil: 0, pauseReason: null, heldAt: now(), heldBy: what });
    wake(500);
  };
  // The tick runs at the latest `ms` from now, for a change to act on at once, such as the end of
  // a hold or of a remedy's delay. A tick in progress takes it a second later.
  const waker = { timer: null, at: 0 };
  const wake = (ms) => {
    const at = now() + ms;
    if (waker.timer && waker.at <= at) return;
    clearTimeout(waker.timer);
    waker.at = at;
    waker.timer = setTimeout(() => {
      waker.timer = null;
      if (ticking) wake(1000);
      else tick();
    }, ms);
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
      if (/^You have gained a level! Welcome to level \d+/.test(text)) {
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
        // The game and the bot recover from a death by themselves (respawn, rejoin), so one death
        // is a note. A run of them points at a zone or limits that need changing (`watchDeaths`).
        const who = m?.[1] ?? "You";
        alert("death", text, false);
        const lvl = i.stores.character.getState().characterProfile?.level ?? 0;
        if (who === "You" || names.has(who)) (state.deaths ??= []).push({ t: e.t ?? now(), text, leader: who === "You", lostXp: who === "You" && lvl >= 5 ? lvl * lvl * 666.67 : 0 });
      } else if ((m = /inventory is full, you could not loot (.+?)\.?$/i.exec(text))) state.lootFails.push({ t: e.t ?? now(), item: m[1] });
      // A lowered cap and an escape's failed zone change are notes, because the guard and the remedy
      // table handle both.
      else if (e.type === "guard" && /lowering the AutoLevel cap|failed/.test(text)) alert("guard", text);
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

  // A container fits only an empty general slot, and with a bag in each one it stays on the
  // cursor, which stops looting. The bag with the fewest items then moves to a free personal bank
  // slot, which the client allows away from a banker, and `restoreBags` brings it back once a
  // general slot is free again. Nothing else puts bags in the personal bank.
  const GENERAL_SLOTS = [22, 23, 24, 25, 26, 27, 28, 29];
  const BANK_SLOTS = [2000, 2001, 2002, 2003, 2004, 2005, 2006, 2007];
  const slotRow = (i, slot) => (i.stores.character.getState().characterProfile?.inventory ?? []).find((r) => r.bag === 0 && r.slot === slot);
  const rowAt = (i, p) => (i.stores.character.getState().characterProfile?.inventory ?? []).find((r) => r.bag === p.bag && r.slot === p.slot);
  // A move can end without a change or a message, so it is checked and sent again.
  const moveSlot = async (i, from, to) => {
    const id = rowAt(i, from)?.itemInstanceId;
    for (let k = 0; k < 3 && id != null; k++) {
      await i.stores.character.getState().moveItemToSlot(from, to);
      for (let w = 0; w < 6; w++) {
        await sleep(500);
        if (rowAt(i, to)?.itemInstanceId === id) return true;
      }
    }
    return false;
  };
  const placeCursor = async (i) => {
    const free = (slot) => !slotRow(i, slot);
    if ((slotRow(i, 30)?.itemDetails?.bagslots ?? 0) > 0 && !GENERAL_SLOTS.some(free)) {
      const inv = i.stores.character.getState().characterProfile?.inventory ?? [];
      const bag = GENERAL_SLOTS.map((s) => ({ s, n: inv.filter((r) => r.bag === s + 1).length })).sort((a, b) => a.n - b.n)[0].s;
      const bank = BANK_SLOTS.find(free);
      const name = slotRow(i, bag)?.itemDetails?.Name ?? slotRow(i, bag)?.itemDetails?.name ?? `the bag in slot ${bag}`;
      if (bank != null) log(`moved ${name} to bank slot ${bank} to make room for ${i.bagSpace().cursor}: ${(await moveSlot(i, { bag: 0, slot: bag }, { bag: 0, slot: bank })) ? "done" : "failed"}`);
    }
    return autoPlace();
  };
  const restoreBags = async (i) => {
    if (i.bagSpace().cursor) return;
    for (const bank of BANK_SLOTS) {
      const general = GENERAL_SLOTS.find((s) => !slotRow(i, s));
      if (general == null) return;
      const row = slotRow(i, bank);
      if ((row?.itemDetails?.bagslots ?? 0) > 0) log(`moved ${row.itemDetails.Name ?? row.itemDetails.name ?? "a bag"} back from bank slot ${bank}: ${(await moveSlot(i, { bag: 0, slot: bank }, { bag: 0, slot: general })) ? "done" : "failed"}`);
    }
  };

  const watchCursor = async (i) => {
    const held = i.bagSpace().cursor;
    const inst = held ? rowAt(i, { bag: 0, slot: 30 })?.itemInstanceId ?? held : null;
    // Each item held is its own case, so a second item taken while another is put away gets its own wait.
    if (state.cursorInst !== inst) Object.assign(state, { cursorInst: inst, cursorSince: null, cursorAlerted: false, cursorPlaced: false });
    if (!held) return;
    state.cursorSince ??= now();
    const heldSec = (now() - state.cursorSince) / 1000;
    if (!state.cursorAlerted && heldSec > config.cursorAlertSec) {
      state.cursorAlerted = true;
      alert("cursor", `${held} has been on the cursor for over ${config.cursorAlertSec}s; looting and cleanup need a free cursor`, true);
    }
    // A person may be holding it on purpose, so wait longer before putting it away, and try once.
    if (!state.cursorPlaced && config.cursorPlaceSec > 0 && heldSec > config.cursorPlaceSec) {
      state.cursorPlaced = true;
      const r = await placeCursor(i);
      await sleep(1500);
      const still = i.bagSpace().cursor;
      log(`auto-placed cursor item ${held}: ${r?.message ?? "no reply"}${still ? `; cursor still holds ${still}` : ""}`);
      if (!still || i.bagSpace().free > 0) return;
      // With every bag slot taken the item has nowhere to go: surplus leaves by its fate, and a kept
      // item waits while the reserve sells what it can, then goes into the room made.
      const f = fates(i, true);
      const mine = (list) => list.some((x) => x.bag === 0 && x.slot === 30);
      if (mine(f.sell)) log(`sold cursor item ${held} because the bags are full: ${(await sellAt(0, 30))?.message ?? "no reply"}`);
      else if (mine(f.discard) && config.discard) log(`discarded cursor item ${held} because the bags are full: ${(await destroyCursor(i)) ? "done" : "refused"}`);
      else {
        await keepReserve(i, true, true);
        if (i.bagSpace().free > 0) log(`placed cursor item ${held} after making room: ${(await placeCursor(i))?.message ?? "no reply"}`);
      }
    }
  };

  // ---- Idle remedies -----------------------------------------------------------------------
  // One table maps each idle cause of the page's activity label (src/bridge.js, "Activity") to a
  // ladder of remedies (docs/plans/controller.md, principle 3), and its `start` is the only start of
  // AutoLevel (docs/plans/fault-handling.md). A rung runs once the cause has lasted `afterSec`, the
  // next one once the cause outlasts `afterSec` again, and a rung with nothing to do passes to the
  // next at once. When the ladder is used up, an alert wakes a script. A cause's case ends once the
  // label no longer shows that occurrence of it, which began at the label's `since`, and for a
  // cause with AutoLevel on, whose remedies change the label for a moment, at the next kill
  // (`untilKill`). While a hold keeps AutoLevel off, only a cause marked `always` acts. An errand
  // hunts its zone on purpose, so its ladder leaves out the rungs that change the zone or the
  // limits, unless the cause names its own (`errand`): a crowded errand zone, whose enemies other
  // players take, ends the errand. "afterKill" and "lootSettle" are the client's own waits after a
  // kill, and "unknown" has no remedy.
  const REMEDIES = {
    loadFailed: { afterSec: 0, rungs: ["tryAgain"], always: true },
    // AutoLevel off: it starts at once after a hold or a contested target, 5 s after the client
    // paused it, and after `restartAfterSec` when nothing explains the stop.
    held: { afterSec: 0, rungs: ["start"] },
    contested: { afterSec: 0, rungs: ["start"] },
    clientPause: { afterSec: 5, rungs: ["start"] },
    off: {
      get afterSec() {
        return config.restartAfterSec;
      },
      rungs: ["start"],
    },
    noEnemies: { afterSec: 0, rungs: ["widen", "move"] },
    waitAttack: { afterSec: 20, rungs: ["restart"], untilKill: true },
    readyWait: { afterSec: 30, rungs: ["restart"], untilKill: true },
    noTarget: { afterSec: 20, rungs: ["restart", "widen", "move"], untilKill: true },
    crowded: { afterSec: 60, rungs: ["widen", "move"], errand: ["leave"], untilKill: true },
  };
  const remedies = {
    // A stop nothing explains is counted, because one that keeps coming back is a person or a
    // fault to find in the event log.
    start: (i, cb, why, cause) => {
      cb.startAutoLevel();
      if (cause === "held") return `started AutoLevel after ${state.heldBy ?? "a hold"}`;
      if (cause === "off") {
        state.restarts = state.restarts.filter((t) => t > now() - 3600000);
        state.restarts.push(now());
        const repeated = state.restarts.length >= 3;
        alert("autoLevelRestarted", `AutoLevel was off for ${config.restartAfterSec} s for no stated reason; started it again${repeated ? ` (${state.restarts.length} times this hour)` : ""}`, repeated);
      }
      return "started AutoLevel";
    },
    // A stop that the next tick answers with a start, because it is the bot's own hold.
    restart: (i, cb) => {
      holdAutoLevel(cb, "a fresh start");
      return "stopped AutoLevel for a fresh start";
    },
    // Undo what narrowed the limits: the guard's tightening first, then the level floor, then a
    // minimum con above blue. `keepLimits` returns them to `limits` after `widenMin`.
    widen: (i, cb) => {
      const p = i.guard?.preferred;
      if (p) {
        i.guard.preferred = null;
        setLimits(cb, p);
        state.widenedAt = now();
        holdAutoLevel(cb, "the wider limits");
        return `back to con ${p.minCon}..${p.maxCon}, cap ${p.maxLevelDiff} from before the guard tightened them`;
      }
      if (cb.minNpcLevel > 0) {
        const was = cb.minNpcLevel;
        cb.setMinNpcLevel(0);
        state.widenedAt = now();
        holdAutoLevel(cb, "the wider limits");
        return `lifted the minimum enemy level ${was}`;
      }
      if (cb.minCon > 4) {
        const was = cb.minCon;
        cb.setMinCon(4);
        state.widenedAt = now();
        holdAutoLevel(cb, "the wider limits");
        return `lowered minimum con from ${was} to blue (4)`;
      }
      return null;
    },
    move: async (i, cb, why) => (nextZone(i) && (await rotate(i, why)) ? "moved to another rotation zone" : null),
    leave: (i, cb, why) => {
      if (!state.errand) return null;
      endErrand(i, why, true);
      return "ended the errand";
    },
    // The Loading Failed window's TRY AGAIN, which loads the zone again.
    tryAgain: (i) => {
      i.stores.loadFailure.getState().retry();
      alert("loadFailed", "the zone did not finish loading; pressed Try Again");
      return "pressed Try Again";
    },
  };
  // The setters overwrite each other in this order (docs/client-internals.md).
  const setLimits = (cb, l) => {
    cb.setMaxCon(l.maxCon);
    cb.setMinCon(l.minCon);
    cb.setMaxLevelDiff(l.maxLevelDiff);
  };
  const sameLimits = (cb, l) => cb.minCon === l.minCon && cb.maxCon === l.maxCon && cb.maxLevelDiff === l.maxLevelDiff;
  // The options live per character on the server, so a character switch brings the new
  // character's own. Each setting flips with its toggle (`autoUpgradeEnabled`, `toggleAutoUpgrade`).
  const keepOptions = (cb) => {
    for (const [key, setting] of Object.entries(config.clientOptions ?? {})) {
      // A screenshot of the world draws it for a moment (`render`).
      const want = key === "disable3D" && now() < state.renderUntil ? false : setting;
      const toggle = cb[`toggle${key[0].toUpperCase()}${key.slice(1).replace(/Enabled$/, "")}`];
      if (key in cb && cb[key] !== want && typeof toggle === "function") {
        toggle();
        log(`client option ${key} set to ${want}`);
      }
    }
  };
  // Overrides are kept per companion in the party spells store, and a companion that joins later,
  // or whose overrides were lost, has none and casts with the client's defaults.
  const keepTactics = (i) => {
    if (state.dispel) return;
    const overrides = i.stores.partySpells?.getState?.().overridesByCompanion ?? {};
    const cs = i.stores.companions.getState();
    for (const c of cs.companions ?? []) {
      if (c.companionType !== 2) continue;
      for (const [k, want] of Object.entries(config.companionTactics ?? {})) {
        if (overrides[`character:${c.characterId}`]?.[k] === want) continue;
        i.setTactic(c.name, k, want);
        log(`tactic ${k} set to ${want} for ${c.name}`);
      }
    }
    keepCharm(i, cs);
    keepExclusions(i, cs);
  };
  // The client charms for Enchanters and Necromancers (undead only) when a character's casting
  // preference `charm` is on, and it recovers a pet whose charm broke (docs/client-internals.md).
  // `charm` true or false holds that preference for the leader and every account companion of those
  // classes, and null leaves it alone. Bards also need a charm song among their songs, so they are not
  // included.
  const CHARM_CLASSES = [11, 14];
  const keepCharm = (i, cs) => {
    if (typeof config.charm !== "boolean") return;
    const ps = i.stores.partySpells?.getState?.();
    if (typeof ps?.setCastingPreferences !== "function") return;
    const me = i.stores.character.getState().characterProfile;
    const who = [...(CHARM_CLASSES.includes(me?.class?.id) ? [{ name: me.name, id: me.id }] : [])];
    for (const c of cs.companions ?? []) if (c.companionType === 2 && CHARM_CLASSES.includes(cs.botCombatDataMap?.[c.id]?.class)) who.push({ name: c.name, id: c.characterId });
    for (const w of who) {
      const key = `character:${w.id}`;
      if ((ps.castingPreferences?.[key]?.charm ?? false) === config.charm) continue;
      ps.setCastingPreferences(key, { charm: config.charm });
      log(`charm set to ${config.charm} for ${w.name}`);
    }
  };
  // The casting preference `excludedSpellIds` has one owner, so each character's list is whole:
  // - its weaker dispels, because the client picks dispels by mana per chance, which takes Taper
  //   Enchantment (5 mana, mod 1) over Nullify Magic (50 mana, mod 4);
  // - with `dotMaxTicks` above 0, the DoTs of its class that run longer than that many 6-second
  //   ticks, except snares, which keep fleeing enemies in reach. A companion casts each DoT the target
  //   lacks whenever its mana is above its class reserve, with no look at how long the fight lasts
  //   (docs/client-internals.md), and our fights last 14 to 29 s.
  const weakerDispels = (scribed = []) => {
    const known = scribed.filter((s) => DISPELS[s]);
    const mod = Math.max(0, ...known.map((s) => DISPELS[s][1]));
    return known.filter((s) => DISPELS[s][1] < mod);
  };
  const keepExclusions = (i, cs) => {
    const ps = i.stores.partySpells?.getState?.();
    if (typeof ps?.setCastingPreferences !== "function" || !i.classSpells) return;
    const long = (cls) => (config.dotMaxTicks > 0 ? (i.classSpells[cls]?.spells ?? []).filter((s) => s.category === 4 && s.durationTicks > config.dotMaxTicks && !s.tags.includes("snare")).map((s) => s.spellId) : []);
    const me = i.stores.character.getState().characterProfile;
    const who = [{ name: me?.name, id: me?.id, cls: classOf(me), scribed: [] }];
    for (const c of cs.companions ?? []) if (c.companionType === 2) who.push({ name: c.name, id: c.characterId, cls: cs.botCombatDataMap?.[c.id]?.class, scribed: cs.botCombatDataMap?.[c.id]?.scribedSpellIds ?? [] });
    for (const w of who) {
      if (!w.id || w.cls == null) continue;
      const key = `character:${w.id}`;
      const want = [...new Set([...weakerDispels(w.scribed), ...long(w.cls)])];
      const have = ps.castingPreferences?.[key]?.excludedSpellIds ?? [];
      if (have.length === want.length && want.every((id) => have.includes(id))) continue;
      ps.setCastingPreferences(key, { excludedSpellIds: want });
      log(`excluded spells for ${w.name}: ${want.length ? want.join(", ") : "none"}`);
    }
  };
  // Remedies, errands, camps and the guard change AutoLevel's limits for a reason that passes, and
  // without a way back the limits drifted: groups hunted at blue for hours after one crowded
  // minute. The limits return to `limits` once nothing holds them: no errand or task and no
  // widening within `widenMin`. The guard's tightening holds only the cap, which it returns by
  // itself after a quiet hour, so meanwhile the cons follow the target and the guard returns to it.
  // `limits.levelsBelow` floors the window at that many levels below the leader through the
  // client's minimum NPC level, an absolute level, so it follows the leader's level-ups.
  const floorOf = (i) => {
    const below = config.limits?.levelsBelow ?? 0;
    const lvl = i.stores.character.getState().characterProfile?.level ?? 0;
    return below > 0 && lvl > 0 ? Math.max(1, lvl - below) : 0;
  };
  const keepLimits = (i, cb) => {
    const t = config.limits;
    if (!t || state.errand || state.task?.status === "running" || now() - (state.widenedAt ?? 0) < config.widenMin * 60000) return;
    const floor = floorOf(i);
    if (typeof cb.setMinNpcLevel === "function" && (cb.minNpcLevel ?? 0) !== floor) {
      log(`AutoLevel minimum enemy level ${floor || "off"} from ${cb.minNpcLevel || "off"}`);
      cb.setMinNpcLevel(floor);
    }
    const g = i.guard?.preferred;
    if (g && (g.minCon !== t.minCon || g.maxCon !== t.maxCon || g.maxLevelDiff !== t.maxLevelDiff)) i.guard.preferred = { ...t };
    // The client sets the highest con from the cap (docs/client-internals.md: 1 or 2 give Yellow),
    // so under a tightened cap the max con is the client's, not the target's.
    const l = g ? { minCon: t.minCon, maxCon: cb.maxCon, maxLevelDiff: Math.min(t.maxLevelDiff, cb.maxLevelDiff) } : t;
    if (sameLimits(cb, l)) return;
    log(`AutoLevel limits back to con ${l.minCon}..${l.maxCon}, cap ${l.maxLevelDiff} from ${cb.minCon}..${cb.maxCon}, cap ${cb.maxLevelDiff}`);
    setLimits(cb, l);
  };
  const keepAutoLevel = async (i) => {
    const a = i.activity?.();
    const lastKill = (i.kills ?? []).at(-1)?.t ?? 0;
    // An errand has its own ladders, so a case also ends when one begins or ends.
    for (const [why, c] of Object.entries(state.idleCases)) {
      const spec = REMEDIES[why];
      const over = !spec || (spec.untilKill ? lastKill > c.began : !(a?.act === "idle" && a.why === why && a.since === c.began));
      if (over || c.errand !== Boolean(state.errand)) delete state.idleCases[why];
    }
    const spec = a?.act === "idle" ? REMEDIES[a.why] : null;
    if (!spec || (!spec.always && autoLevelHold(i))) return;
    // A rooted member keeps the readiness wait on, and the root dispel (`dispelRoots`) breaks roots.
    if (a.why === "readyWait" && partyRoots(i).length) return;
    const c = (state.idleCases[a.why] ??= { rung: 0, at: a.since, began: a.since, errand: Boolean(state.errand) });
    const due = Math.max(c.at, a.since) + spec.afterSec * 1000 - now();
    if (due > 0) return void wake(due);
    // Crowding comes from other players, so the coordinator sends no errand there for a while (`crowdedAt`).
    if (a.why === "crowded") (state.crowdedAt ??= {})[zoneShort(i)] = now();
    const rungs = state.errand ? (spec.errand ?? spec.rungs.filter((r) => r !== "widen" && r !== "move")) : spec.rungs;
    // A used-up ladder starts over after ten minutes, because a crowded zone empties again.
    if (c.rung >= rungs.length && now() - c.at > 600000) Object.assign(c, { rung: 0, at: now() });
    const cb = i.stores.combat.getState();
    const zone = i.stores.staticData.getState().zones.find((z) => z.zoneidnumber === cb.currentZone)?.longName ?? "this zone";
    while (c.rung < rungs.length) {
      const done = await remedies[rungs[c.rung++]](i, cb, `idle (${a.why}) in ${zone}`, a.why);
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
  // The party's roots with their end times, from the bridge (`iq.roots()`), which reads the client's
  // effects registry the way the readiness wait does.
  const partyRoots = (i) => i.roots?.() ?? [];
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
      // over Nullify Magic (50 mana, mod 4) unless weaker dispels are excluded (`keepExclusions`).
      const key = `character:${c.characterId}`;
      const mez = d.class === 14 || d.class === 8;
      if (mez && typeof ps?.setCastingPreferences === "function" && ps.castingPreferences?.[key]?.mez === false) ps.setCastingPreferences(key, { mez });
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
        holdAutoLevel(cb, "members to gather");
        log(`stopped pulling until ${missing.length} missing member(s) can join after this fight`);
      }
      return;
    }
    if (now() - state.rejoinAt < 20000) return;
    state.rejoinAt = now();
    i.stores.companions.getState().requestAccountCharacterAvailability();
    missing.forEach((id, k) => setTimeout(() => iq()?.stores.companions.getState().controlAccountCharacter(id), 2500 * (k + 1)));
    alert("rejoin", `asked ${missing.length} account character(s) to rejoin the party: ${missing.join(", ")}`);
  };
  // A task that fights as a member other than the leader gathers the group around it first, since
  // every watcher, keepParty too, waits while another character is active, and that character
  // enters the world alone.
  const gatherParty = async (i) => {
    const cs = () => i.stores.companions.getState();
    cs().requestAccountCharacterAvailability();
    await sleep(1500);
    const available = new Set(cs().availableAccountCharacterIds ?? []);
    const missing = partyMissing(i).filter((id) => !available.size || available.has(id));
    for (const id of missing) {
      cs().controlAccountCharacter(id);
      await sleep(2500);
    }
    const away = () => partyMissing(i).filter((id) => missing.includes(id));
    for (let k = 0; k < 20 && away().length; k++) await sleep(1000);
    return `${missing.length - away().length} of ${missing.length} joined`;
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
  // Only a loaded list of the account's characters can say that one does not exist: a page that
  // left the game, as a camping the server could not confirm leaves it, lists none.
  const rosterLoaded = (i) => characters(i).length > 0 && !i.stores.roster?.getState?.().isLoading;
  const accountCharacter = (i, who) => {
    const c = findCharacter(i, who);
    if (!c) throw new Error(rosterLoaded(i) ? `no account character ${who}` : "the account's characters are not loaded");
    return c;
  };
  // A switch starts from a connected page in the world or at the character select.
  const switchable = (i) => Boolean(i.socket?.isConnected) && ["game", "characterSelect"].includes(i.stores.screen.getState().currentScreen) && rosterLoaded(i);
  // A page out of the game comes back by the client's own resume, in about 80 s, or by the page
  // supervisor's sign-in after a minute (tools/lib/page.mjs), so a task's switch waits for it.
  const PAGE_BACK_MS = 150000;
  const untilSwitchable = async (i) => {
    const end = now() + PAGE_BACK_MS;
    while (!switchable(i)) {
      if (now() > end) throw new Error("the page did not come back to the game");
      await sleep(1000);
    }
  };
  const command = (i, cmd, ms) => Promise.race([Promise.resolve(i.command(cmd)), sleep(ms).then(() => ({ ok: false, message: `${cmd.type} timed out` }))]);
  const switchSteps = async (i, target, { rejoin = false } = {}) => {
    const screen = () => i.stores.screen.getState().currentScreen;
    if (screen() === "game") {
      if (!rejoin && Number(i.stores.character.getState().characterProfile?.id) === Number(target.id)) return { ok: true, message: `${target.name} is active` };
      if (i.stores.skills.getState().inCombat) return { ok: false, message: "the party is in combat" };
      holdAutoLevel(i.stores.combat.getState(), `the switch to ${target.name}`);
      const r = await command(i, { type: "session.camp" }, 60000);
      if (!r?.ok) return { ok: false, message: `camping failed: ${r?.message ?? "no reply"}` };
    }
    if (screen() !== "characterSelect") return { ok: false, message: `the screen is ${screen()}, not character select` };
    // A numeric selector would pick by list position, so the command gets the name.
    const r = await command(i, { type: "session.enterWorld", selector: target.name }, 120000);
    return r?.ok ? { ok: true, message: `entered the world as ${target.name}` } : { ok: false, message: `entering as ${target.name} failed: ${r?.message ?? "no reply"}` };
  };
  /**
   * Start making `who` (a name or a character id) the active character. Returns the job. With
   * `rejoin` the active character camps and enters the world again, which reloads its state.
   */
  const switchTo = (i, who, { rejoin = false } = {}) => {
    const job = state.switching;
    if (job && !job.done && now() - job.startedAt < SWITCH_TIMEOUT_MS) return job;
    const target = findCharacter(i, who);
    if (!target) return (state.switching = { id: null, name: String(who), startedAt: now(), done: true, ok: false, message: rosterLoaded(i) ? `no account character ${who}` : "the account's characters are not loaded" });
    const next = (state.switching = { id: Number(target.id), name: target.name, startedAt: now(), done: false, ok: null, message: "switching" });
    log(`${rejoin ? "rejoining as" : "switching to"} ${target.name}`);
    switchSteps(i, target, { rejoin })
      .catch((e) => ({ ok: false, message: String(e?.message ?? e) }))
      .then((r) => {
        Object.assign(next, r, { done: true });
        if (r.ok) {
          state.switchFails = 0;
          state.rejoinAt = 0; // the new active character gathers its party at once
          log(r.message);
          wake(1000);
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
    if (now() < state.switchRetryAt || !switchable(i)) return true;
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
  // A task that cannot go on before a known time, such as a quest NPC's spawn point that respawns
  // later, ends as "waiting" with that time (`nextAt`), and the coordinator brings it back then.
  class TaskLater extends Error {
    constructor(message, at) {
      super(message);
      this.at = at;
    }
  }
  // The group's own leader, for fights a quest member is too weak for.
  const becomeLeader = async (i) => {
    const id = Number(config.leaderId);
    for (let k = 0; k < 2 && Number(i.stores.character.getState().characterProfile?.id) !== id; k++) {
      await untilSwitchable(i);
      const job = switchTo(i, id);
      while (!job.done) await sleep(1000);
      if (!job.ok) throw new Error(job.message);
    }
    if (Number(i.stores.character.getState().characterProfile?.id) !== id) throw new Error("the leader did not become active");
  };
  const withTimeout = (p, ms, what) => Promise.race([p, sleep(ms).then(() => Promise.reject(new Error(`${what} took longer than ${Math.round(ms / 1000)} s`)))]);
  const activeName = (i) => (i.stores.screen.getState().currentScreen === "game" ? (i.stores.character.getState().characterProfile?.name ?? null) : null);
  /** Stop AutoLevel and let the fight at hand end. */
  const calm = async (i) => {
    holdAutoLevel(i.stores.combat.getState(), "a task");
    for (let k = 0; k < 70 && i.stores.skills.getState().inCombat; k++) await sleep(1000);
    if (i.stores.skills.getState().inCombat) throw new Error("the fight did not end");
  };
  const becomeActive = async (i, name) => {
    // A switch already under way for someone else finishes first.
    for (let k = 0; k < 2 && activeName(i) !== name; k++) {
      await untilSwitchable(i);
      const job = switchTo(i, name);
      while (!job.done) await sleep(1000);
      if (!job.ok) throw new Error(job.message);
    }
    if (activeName(i) !== name) throw new Error(`${name} did not become active`);
  };
  const pullOne = async (i, item, from = null, avoid = []) => {
    if (i.bagSpace().free < 2) await keepReserve(i, true);
    const r = await i.pullItem(item, { from, avoid });
    if (!r.got) throw new Error(`pulling ${item} from ${r.from} failed: ${r.reply ?? "no reply"}`);
  };
  // A gear task carries out moves of the roster gear plan (tools/lib/gear-plan.mjs): each pulls an
  // item from the account character that holds it, which Inventory Search does for NO DROP items
  // too, or buys it from the merchant its `buy` names after travelling to that zone, and gives it
  // to the character it suits best, in the party or not, so the tab never switches characters:
  // equipped, or into the bags for a move to slot "bags" (a Bard's instrument for the party supply).
  // A move that fails is recorded and the next one runs.
  const gearTask = async (i, task, step) => {
    await step("stop", () => calm(i), 75000);
    for (const mv of task.moves) {
      if (mv.done || mv.error) continue;
      try {
        const to = accountCharacter(i, mv.to);
        if (mv.buy && i.carried(mv.item) < 1) {
          if (zoneShort(i) !== mv.buy.zone) await step(`travel to ${mv.buy.zone}`, () => i.changeZone(mv.buy.zone), 90000);
          if (i.bagSpace().free < 1) await keepReserve(i, true);
          // The gear plan spends account coin, so a leader that carries too little pulls the
          // largest account balance first (Manage Money), as for a resurrection. Whether that
          // sufficed shows in the purchase, which reports the platinum carried when it fails.
          const p = i.stores.character.getState().characterProfile ?? {};
          const short = (mv.buy.price ?? 0) - (p.platinum ?? 0);
          if (short > 0) log(`gear: ${(await pullCoin(i, short).catch((e) => `no pull (${e.message})`)) ?? "no balance large enough"} for ${mv.item} (${mv.buy.price} pp)`);
          const r = await step(`buy ${mv.item} from ${mv.buy.merchant}`, () => i.buyItem(mv.item, mv.buy.merchant, 1), 240000);
          if (r.bought < 1) throw new Error(`${mv.buy.merchant} sold no ${mv.item} (${r.platinum} pp carried)`);
        }
        if (i.carried(mv.item) < 1) await step(`pull ${mv.item} from ${mv.from}`, () => pullOne(i, mv.item, mv.from), 45000);
        // A transfer to oneself is refused, so a move to the active character equips from its own
        // bags, and an instrument for its bags is already there.
        const self = Number(to.id) === Number(i.stores.character.getState().characterProfile?.id);
        if (self && mv.slot === "bags") {
          Object.assign(mv, { done: true, lines: [] });
          continue;
        }
        const r = self ? { ...(await step(`equip ${mv.item}`, () => i.equipOwn(mv.item, mv.slotNum), 30000)), lines: [] } : await step(`give ${mv.item} to ${mv.to}`, () => i.giveItem(mv.item, Number(to.id), { equip: mv.slot !== "bags" }), 30000);
        // A move retried after a reinstall may find the item already given, which the server
        // reports as a lore conflict, so that refusal means the receiver has it.
        const given = r.ok || r.lines.some((l) => /already possesses a Lore item/i.test(l));
        if (!given) throw new Error(`the ${self ? "slot move" : "transfer"} was refused${r.lines.length ? `: ${r.lines.at(-1)}` : ""}`);
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
  // quest NPCs answer and reward the character in front of them. A step travels to its zone, buys
  // the items `buy` names (`{ merchant, items }`, a merchant of that zone), pulls the other items it
  // hands over from whoever on the account holds them, then talks to its NPC with
  // `say` keywords, gives `give` (one trade of up to four items), or hands in `each` per item as
  // `handInEach` does, or fights the enemy `kill` names once it is up (within `waitSec`), or crafts
  // `craft` (`{ recipeId, skillId, quantity, inputs, output: { item, id } }`, rolling until one
  // success with one of each of `inputs` pulled per attempt; the server crafts without a held container), and checks that the
  // member then carries `expect`. A hand-in is a quest of one `each` step per
  // member. Entering the world puts a character where it last stood, and the zone store can lag
  // the switch, so the first step after a switch always travels, and later steps only to another
  // zone, because a zone change also moves the party back to the zone's entry.
  const questTask = async (i, task, step) => {
    const onArrival = Boolean(i.stores.combat.getState().enemyTargetAttackOnArrival);
    try {
      for (const m of task.members) await questMember(i, m, step);
    } finally {
      i.stores.combat.getState().setEnemyTargetAttackOnArrival?.(onArrival);
    }
  };
  const questMember = async (i, m, step) => {
    if (m.done) return;
    const t0 = now();
    await step(`stop for ${m.name}`, () => calm(i), 75000);
    await step(`switch to ${m.name}`, () => becomeActive(i, m.name), 200000);
    // A chain that stopped part way, in this task or an earlier one, goes on after the last step
    // whose reward the member carries, so no step repeats and no reward is asked for twice.
    const resume = m.steps.findLastIndex((s) => s.expect && i.carried(s.expect) > 0) + 1;
    m.at = Math.max(m.at ?? 0, resume);
    let fresh = true;
    let gathered = false;
    // Up to four minutes for full HP and mana, the readiness the client's pull waits for.
    const readyParty = () => step("wait for the party to be ready", async () => {
      for (const end = now() + 240000; !i.partyFull() && now() < end; ) await sleep(3000);
    }, 260000);
    for (const [k, s] of m.steps.entries()) {
      if (k < m.at) continue;
      if (fresh || zoneShort(i) !== s.zone) await step(`travel to ${s.zone}`, () => i.changeZone(s.zone), 90000);
      fresh = false;
      // The enemy a hand-in summons being up already shows that the hand-in happened earlier, so the
      // member goes on to the fight: Maligar stays gone while his doppleganger lives. Up means among
      // the enemies the party can attack, the list `directedKill` fights from. That holds only for an
      // enemy other than the hand-in's NPC: Shmendrik Lavawalker takes the crown and is then the
      // enemy, and he can be attacked before the hand-in too, so his being up says nothing.
      const next = m.steps[k + 1];
      if (next?.kill && !s.kill && next.zone === s.zone && !enemyPattern(next.kill).test(s.npc ?? "")) {
        if ((runtime(i)?.combatScene?.getAliveCombatTargetList?.() ?? []).some((x) => enemyPattern(next.kill).test(x.name ?? ""))) {
          log(`quest: ${next.kill} is up already, so ${m.name} goes on to the fight`);
          m.at = k + 1;
          continue;
        }
      }
      const need = { ...(s.each ?? {}) };
      for (const item of s.give ?? []) need[item] = (need[item] ?? 0) + 1;
      for (const [item, n] of Object.entries(need)) {
        if (s.buy?.items?.includes(item) && i.carried(item) < n) await step(`buy ${item} from ${s.buy.merchant}`, () => i.buyItem(item, s.buy.merchant, n - i.carried(item)), 240000);
        // A copy another member of the chain carries is its own, so a pull skips those (`avoid`).
        while (i.carried(item) < n) await step(`pull ${item} for ${m.name}`, () => pullOne(i, item, null, m.avoid ?? []), 45000);
      }
      if (s.craft) {
        const c = s.craft;
        // A skill roll can fail at any skill below the recipe's trivial, and a failed attempt uses up
        // its components too. So the step rolls until one success, at most `quantity` attempts, and
        // before each attempt pulls one more of every `inputs` item the catalog does not sell.
        const tally = { attempted: 0, failures: 0, skill: null };
        while (tally.attempted < (c.quantity ?? 1)) {
          for (const item of c.inputs ?? []) {
            if (i.carried(item) >= 1) continue;
            await step(`pull ${item} for ${m.name}`, () => pullOne(i, item, null, m.avoid ?? []), 45000).catch((e) => {
              throw new Error(`out of ${item} after ${tally.failures} failed ${c.output.item} rolls: ${e.message}`);
            });
          }
          const r = await step(`craft ${c.output.item}`, () => i.craftItem(c.recipeId, { quantity: 1, until: 1, skillId: c.skillId, output: c.output.id }), 120000);
          tally.attempted += r.attempted;
          tally.failures += r.failures;
          tally.skill = r.newSkillValue ?? tally.skill;
          if (r.successes > 0) break;
        }
        log(`craft: ${c.output.item} after ${tally.attempted} attempts, ${tally.failures} failed${tally.skill != null ? `, skill ${tally.skill}` : ""}`);
      }
      // A hand-in that summons the next step's enemy waits for the party at full HP and mana, because
      // the client attacks only a party it finds ready and does not fight back while it waits.
      if (m.steps[k + 1]?.kill && !s.kill) {
        if (!gathered) await step(`gather the party for ${m.name}`, () => gatherParty(i), 60000);
        gathered = true;
        await readyParty();
      }
      // A script-spawned enemy appears a few seconds after the hand-in or kill that summons it, and a
      // fight the party did not reach is tried again, as a hunt does, until `waitSec` runs out.
      if (s.kill) {
        if (!gathered) await step(`gather the party for ${m.name}`, () => gatherParty(i), 60000);
        gathered = true;
        // The client pulls only a party it finds ready, so the fight's time starts once it is, also
        // when the enemy was up already and the summoning hand-in, which waits too, was skipped.
        if (!i.stores.skills.getState().inCombat) await readyParty();
        const wanted = enemyPattern(s.kill);
        const since = now();
        const end = since + (s.waitSec ?? 60) * 1000;
        for (let r = null; r !== "killed" && !killedSince(i, wanted, since); ) {
          if (r && now() > end) throw new Error(`${r === "none" ? `no ${s.kill} came up` : `the fight with ${s.kill} was lost`} (${fightState(i)})`);
          if (r) await sleep(2000);
          r = await step(`kill ${s.kill}`, () => directedKill(i, wanted), 200000);
        }
      }
      // An NPC that shares its spawn point with others (`points`, which tools/iqd.mjs adds from the
      // content snapshot) is up only when its point rolled it, and a point rolls again only after its
      // occupant dies and its respawn time passes: the ghoul scribe's point in Lower Guk rolls it 34%
      // of the time every 29 minutes and a wan ghoul knight otherwise. So the step looks once. With
      // the NPC up the member goes on. With an occupant up the group's own leader, not the quest
      // member, kills it, and with the point respawning nobody waits: the task ends as waiting
      // until the point's next roll, and the group hunts meanwhile.
      if (s.npc && s.points?.length) {
        // The whole name, because a summoned enemy can carry it, such as Maligars Enraged Doppleganger.
        const wanted = new RegExp(`^${s.npc.replace(/[ _]/g, "[ _]")}$`, "i");
        await step(`look for ${s.npc}`, async () => {
          // The step's points as the zone lists them. Right after a zone change the server may not
          // list the zone's spawns yet, so an empty answer is asked again for half a minute.
          const listedPoints = async () => {
            let at = [];
            for (let r = 0; r < 10 && !at.length; r++) {
              if (r) await sleep(3000);
              await i.refreshSpawns().catch(() => {});
              at = s.points.map((p) => (i.zoneSpawns?.spawns ?? []).find((x) => x.spawn2Id === p)).filter(Boolean);
            }
            return at;
          };
          const at = await listedPoints();
          // The spawn list keeps a point's last NPC while it respawns, so only a living one counts.
          if (at.some((x) => wanted.test(x.name ?? "") && x.state === "alive")) return;
          if (!at.length) {
            // Without its points in the list the step cannot see the point, only the NPC by name.
            const listed = i.zoneSpawns?.spawns ?? [];
            if (listed.some((x) => wanted.test(x.name ?? "") && x.state === "alive")) return;
            throw new TaskLater(`${s.npc}'s spawn points (${s.points.join(", ")}) are not among the zone's ${listed.length} listed spawns`, now() + 1800000);
          }
          const held = at.filter((x) => x.state === "alive");
          if (!held.length) {
            const next = Math.min(...at.map((x) => x.nextRespawnAtMs).filter((t) => t > now()));
            throw new TaskLater(`${s.npc}'s spawn point rolls again at ${Number.isFinite(next) ? new Date(next).toTimeString().slice(0, 5) : "an unknown time"}`, Number.isFinite(next) ? next + 30000 : now() + 1800000);
          }
          // The group's own leader clears the point with the client's Spawn Camp, as a camp hunt does
          // (`campPoints`): it kills what stands there, waits when another player holds it, and ends
          // once the point waits for its respawn, which is when the step comes back. The leader may
          // stand in another zone, since a member enters the world where it last was, and enters the
          // world alone, so the party gathers around it before the camp.
          await becomeLeader(i);
          if (zoneShort(i) !== s.zone) await i.changeZone(s.zone);
          if ((await listedPoints()).some((x) => wanted.test(x.name ?? "") && x.state === "alive")) throw new TaskLater(`${s.npc} came up while the leader came`, now() + 60000);
          const joined = await gatherParty(i);
          if (partyMissing(i).length) throw new TaskLater(`the leader's party did not gather to clear ${s.npc}'s spawn point (${joined})`, now() + 600000);
          const names = held.map((x) => x.name).join("|");
          const r = await campPoints(i, { points: s.points, keep: names, startedAt: now(), minutes: 10 }, enemyPattern(names));
          log(`quest: the leader camped ${s.npc}'s spawn point: ${r.result}, ${r.kills} kill(s)`);
          // A camp that ran out of time without a kill needs a stronger group, which a few hours may bring.
          if (!r.kills && !r.nextAt) throw Object.assign(new Error(`the leader could not clear ${s.npc}'s spawn point (${r.result})`), { retryAfterMs: 6 * 3600000 });
          throw new TaskLater(`${s.npc}'s spawn point: ${r.result}`, r.nextAt ? r.nextAt + 30000 : now() + 1800000);
        }, 1200000);
      }
      // The walk can cross a large zone, and talkToNpc gives up after two minutes without progress, so the step itself may last 15.
      if (s.say?.length || s.give?.length) await step(`talk to ${s.npc}`, () => i.talkToNpc(s.npc, s.say ?? []), 900000);
      // A refused trade closes the dialogue and refreshes the bags, so the retry talks first.
      if (s.give?.length) await step(`give to ${s.npc}`, () => i.giveToNpc(s.give).catch(async (e) => {
        if (!/did not want/.test(e?.message ?? "")) throw e;
        log(`quest: ${s.npc} refused the trade, so ${m.name} trades again after the bags refresh`);
        await sleep(2000);
        await i.talkToNpc(s.npc, []);
        return i.giveToNpc(s.give);
      }), 120000);
      if (s.each) {
        const r = await step(`hand in for ${m.name}`, () => i.handInEach(s.npc, s.each), 300000);
        Object.assign(m, { trades: (m.trades ?? 0) + r.trades, items: (m.items ?? 0) + r.items, xp: (m.xp ?? 0) + r.xp });
      }
      if (s.expect) {
        // An NPC's SummonItem lands on the cursor, which the bags count leaves out. A container fits
        // only an empty general slot, so it may stay there, and it counts as received.
        const held = () => i.carried(s.expect) > 0 || i.bagSpace().cursor === s.expect;
        for (let w = 0; w < 10 && !held(); w++) await sleep(500);
        if (i.bagSpace().cursor === s.expect) await placeCursor(i);
        if (!held()) throw new Error(`${m.name} did not get ${s.expect} from ${s.npc ?? s.kill}`);
      }
      m.at = k + 1;
    }
    Object.assign(m, { done: true, sec: Math.round((now() - t0) / 1000) });
    log(`quest: ${m.name} done in ${m.sec} s${m.xp ? `, ${m.items} items for ${m.xp} XP` : ""}`);
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
  // What a failed directed kill saw, for its error.
  const fightState = (i) => `in combat ${Boolean(i.stores.skills.getState().inCombat)}, target ${i.stores.combat.getState().targetNPC?.name ?? "none"}, last line: ${(i.events ?? []).at(-1)?.text ?? "none"}`;
  const directedKill = async (i, wanted) => {
    const rt = runtime(i);
    if (!rt?.selectEnemyTarget) throw new Error("the client's Enemy Targets action was not found");
    const cb = () => i.stores.combat.getState();
    // An enemy that attacked first, such as a script spawn at a corpse, is already the party's
    // fight, so its kill is only awaited.
    const engaged = () => i.stores.skills.getState().inCombat && wanted.test(cb().targetNPC?.name ?? "");
    const alive = (rt.combatScene.getAliveCombatTargetList?.() ?? []).filter((t) => wanted.test(t.name ?? ""));
    if (!alive.length && !engaged()) return "none";
    let t0 = now();
    if (!engaged()) {
      for (let k = 0; k < 30 && (rt.combatActive || rt.combatApproach?.isBusy?.() || rt.buffPhaseActive || rt.preparationRetryTimer != null); k++) await sleep(1000);
      if (cb().isRunning) holdAutoLevel(cb(), "a directed kill");
      if (!cb().enemyTargetAttackOnArrival) cb().setEnemyTargetAttackOnArrival(true);
      t0 = now();
      rt.selectEnemyTarget([...new Set(alive.map((t) => t.npcId))]);
    }
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
    // Placeholders and wanted enemies can lie below a level floor, which `keepLimits` restores after the task.
    if (cb().minNpcLevel > 0) cb().setMinNpcLevel(0);
    rt.startSpawnCamp(task.points, 0, task.keep);
    try {
      while (now() < task.startedAt + task.minutes * 60000) {
        await sleep(2000);
        if (killedSince(i, wanted, scanned)) kills++;
        scanned = now();
        if (task.item && hasItem(i, task.item)) return { kills, result: `got ${task.item}` };
        // A camp loots for up to half an hour under the task's pause, which keeps the tick's reserve
        // away, so the camp keeps the reserve itself between fights.
        if (!i.stores.skills.getState().inCombat) await keepReserve(i, true);
        const waiting = CAMP_WAITING.test(cb().spawnCampStatus ?? "") && !i.stores.skills.getState().inCombat;
        waitingSince = waiting ? (waitingSince ?? now()) : null;
        if (waitingSince && now() - waitingSince > 5000) {
          // The camp also waits while another player's enemy stands on a point. The spawn list is the
          // zone-entry packet until refreshed, and would still show the placeholders the camp has killed.
          await i.refreshSpawns?.().catch(() => {});
          const pts = (i.zoneSpawns?.spawns ?? []).filter((s) => task.points.includes(s.spawn2Id));
          const held = pts.filter((s) => s.state === "alive");
          if (held.length) {
            const owned = held.filter((s) => s.combatOwnershipState && s.combatOwnershipState !== "unowned").length;
            return { kills, nextAt: now() + CAMP_HELD_RETRY_MS, result: `camp held: ${held.map((s) => s.name.replace(/_/g, " ")).join(", ")} on the points (${owned} owned by another player)` };
          }
          const due = pts.filter((s) => s.nextRespawnAtMs > now()).map((s) => s.nextRespawnAtMs);
          const nextAt = due.length ? Math.min(...due) : null;
          return { kills, nextAt, result: `camp cleared${nextAt ? `, next spawn at ${new Date(nextAt).toTimeString().slice(0, 8)}` : ""}` };
        }
      }
      return { kills, result: "time is up" };
    } finally {
      holdAutoLevel(cb(), "the camp's end"); // ends the camp as well
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
        await keepReserve(i, true);
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
          // The hunt loots under the task's pause, so it keeps the bag reserve itself.
          await keepReserve(i, true);
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
  // How close Run To Target brings the leader before the attack, in the scene's distance units.
  const RAID_REACH = 30;
  // A raid fights one target with the leader and recruited account characters in the client's raid
  // mode (`window.iq.raid`, docs/client-internals.md "How a raid fight runs"), where AutoLevel is off
  // and a member casts only on an order. The task buys an hour of raid time when none is left and
  // an hour costs at most `maxPp`, releases the party, recruits `members`, targets the boss (a daily
  // boss by `bossKey`, or the enemy in the zone whose name matches `target`), sets the heal mode
  // `heal`, walks the raid to the boss, attacks with everyone, gives the nuke order `nuke` and the
  // effect orders `effects` (`iq.raid.effect`: a slow kept up, a resist debuff), which the Utility
  // classes cast only on order. It follows the fight until the boss dies, the raid wipes or
  // `minutes` pass, has a living member revive the leader when he falls, and always ends raid mode,
  // after which the bot's party and AutoLevel keepers restore the group. `task.fight` keeps what a
  // fight is read from: duration, the orders given, each member's damage, HP and mana, the leader's
  // deaths and revives, the raid log's last lines and a trace every 5 s of the leader's order, auto
  // attack, casting and navigation, his distance to the boss and the boss's HP.
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
      const distance = () => (rt?.combatScene.getAliveCombatTargetList?.() ?? []).find((x) => x.spawnInstanceId === boss.spawnInstanceId)?.distance ?? null;
      if (task.heal) await step("heal mode", async () => raid.heal(task.heal), 10000);
      // Run To Target first, so the leader stands at the boss before the fight: in the first raid
      // he stood 12 minutes under an attack order. A boss out of reach does not hold the fight.
      await step(`move to ${boss.name}`, async () => {
        raid.position();
        for (let k = 0; k < 30; k++) {
          await sleep(2000);
          const d = distance();
          if (d != null && d <= RAID_REACH) return;
        }
        log(`task raid: the raid is ${Math.round(distance() ?? -1)} away from ${boss.name} after a minute`);
      }, 75000);
      const t0 = now();
      await step(`attack ${boss.name}`, () => raid.attack(), 30000);
      task.fight = { boss: boss.name, startedAt: t0, orders: [], deaths: 0, revives: 0, trace: [] };
      if (task.nuke) await step("nuke order", async () => raid.nuke(task.nuke), 10000);
      // An effect the group cannot cast is recorded and does not hold the fight.
      if (task.effects?.length) {
        await step("effect orders", async () => {
          for (const kind of task.effects) {
            const o = await raid.effect(kind).catch((e) => ({ kind, error: e?.message ?? String(e) }));
            task.fight.orders.push(o);
            if (o.error) log(`task raid: no ${kind} order: ${o.error}`);
          }
        }, 20000 * task.effects.length);
      }
      const bossAlive = () => (rt?.combatScene.getAliveCombatTargetList?.() ?? []).some((x) => x.spawnInstanceId === boss.spawnInstanceId);
      const outcome = await step(`fight ${boss.name}`, async () => {
        let traced = 0;
        let dead = false;
        let reviveAt = 0;
        while (now() < task.startedAt + task.minutes * 60000) {
          await sleep(2000);
          const s = raid.state();
          task.fight.roster = s.roster.map((m) => ({ name: m.name, damage: m.damage, alive: m.alive, hp: m.hp, maxHp: m.maxHp, mana: m.mana, maxMana: m.maxMana }));
          task.fight.leaderDamage = s.leaderDamage;
          task.fight.log = s.log.slice(-15);
          if (now() - traced >= 5000) {
            traced = now();
            const e = s.enemies.find((x) => x.id === boss.spawnInstanceId);
            const l = s.leader ?? {};
            task.fight.trace.push({ s: Math.round((now() - t0) / 1000), hp: l.hp, order: `${l.order}#${l.revision}`, aa: l.autoAttack, cast: l.casting, nav: l.navigating, pos: l.pos ?? null, d: distance() == null ? null : Math.round(distance()), boss: e?.hp ?? null, up: s.roster.filter((m) => m.alive).length });
            if (task.fight.trace.length > 240) task.fight.trace.shift();
          }
          if (s.leaderDead) {
            if (!dead) task.fight.deaths++;
            dead = true;
            // The fight stays open while the leader is dead, so a living member brings him back.
            if (!s.pending && now() >= reviveAt && s.roster.some((m) => m.alive)) {
              reviveAt = now() + 15000;
              await raid.revive().then(
                () => task.fight.revives++,
                (e) => log(`task raid: revive failed: ${e?.message ?? e}`),
              );
            }
            if (s.roster.some((m) => m.alive)) continue;
          } else dead = false;
          if (s.combat) continue;
          if (killedSince(i, enemyPattern(boss.name), t0) || !bossAlive()) return "killed";
          return s.leaderDead || !s.roster.some((m) => m.alive) ? "wiped" : "ended";
        }
        return "time is up";
      }, task.minutes * 60000 + 60000);
      Object.assign(task.fight, { outcome, seconds: Math.round((now() - t0) / 1000), alive: task.fight.roster?.filter((m) => m.alive).length ?? 0 });
      task.result = `${outcome} ${boss.name} in ${task.fight.seconds} s with ${task.fight.alive} of ${task.fight.roster?.length ?? 0} standing${task.fight.deaths ? `, leader died ${task.fight.deaths}x` : ""}`;
      if (outcome === "killed") alert("raid", `killed ${boss.name}`, true, { killed: boss.name });
    } finally {
      // An end that has to stop a fight waits for the server, so it gets a second try. A raid left
      // on keeps the group from leveling.
      await raid.end().catch(async (e) => {
        log(`task raid: end raid failed: ${e?.message ?? e}`);
        await sleep(10000);
        await raid.end().catch((e2) => alert("raid", `raid mode is still on: ${e2?.message ?? e2}`, true));
      });
    }
  };
  const TASKS = { handIn: questTask, quest: questTask, hunt: huntTask, raid: raidTask, gear: gearTask };
  const startQuest = (kind, members, name = kind) => {
    if (state.task?.status === "running") throw new Error(`the ${state.task.kind} task is still running`);
    if (!members.length) throw new Error(`a ${kind} needs members`);
    for (const m of members) accountCharacter(iq(), m.name);
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
    // A task takes the tab, so a running errand ends here, as finished and not failed.
    if (state.errand) endErrand(iq(), `${task.kind} task took the tab`, false);
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
          // An error that says when to come back would only repeat now.
          if (e instanceof TaskStopped || e instanceof TaskLater || attempt >= 2 || e?.retryAfterMs) throw e;
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
        if (mine() && task.status === "running") Object.assign(task, e instanceof TaskStopped ? { status: "stopped" } : e instanceof TaskLater ? { status: "waiting", result: e.message, nextAt: e.at } : { status: "failed", error: String(e?.message ?? e), ...(e?.retryAfterMs ? { nextAt: now() + e.retryAfterMs } : {}) });
      } finally {
        if (mine()) {
          task.endedAt = now();
          // A failure that says when to come back is handled by the coordinator's retry, so it only notes.
          alert("task", `${task.kind} ${task.status}${task.error ? ` at "${task.step}": ${task.error}` : task.status === "waiting" ? `: ${task.result}` : ""}; ${taskSummary(task)}`, task.status === "failed" && !task.nextAt);
          endPause(`the ${task.kind} task`);
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
  // next one when "No available enemies" persists, or when the XP per hour of play over the last 10
  // minutes falls below `rotateBelowShare` of the best since arriving, after at least
  // `rotateMinStayMin`. The coordinator sets `rotation`: the band row's zones at the leader's level
  // with the most measured XP per hour, best first, a zone other groups hunt in counting for less
  // (`assignZones` in tools/lib/coordinator.mjs).
  const xpLast10 = (i) => (i.kills ?? []).filter((k) => k.t > now() - 600000).reduce((s, k) => s + (k.xp ?? 0), 0);
  // Seconds that are not the zone's: a task, travel, a hold of the bot, the client's pause, a stop
  // nothing explains, a failed zone load, and a page signed out, which records no seconds at all.
  const NOT_PLAY = /^(task|unknown|travel(\/.*)?|idle\/(held|clientPause|off|loadFailed|unknown))$/;
  // The kills' XP over the last 10 minutes per hour of the party's play in them (`activitySeconds`
  // of src/bridge.js), or null below five minutes of play, which leaves too little to judge.
  const playRate = (i) => {
    const play = Object.entries(i.activitySeconds?.(600000) ?? {}).reduce((a, [k, s]) => a + (NOT_PLAY.test(k) ? 0 : s), 0);
    return play >= 300 ? (3600 * xpLast10(i)) / play : null;
  };
  const zoneShort = (i) => i.stores.staticData.getState().zones.find((z) => z.zoneidnumber === i.stores.combat.getState().currentZone)?.shortName;
  // A party outside its rotation, after a respawn at the bind point, a new rotation or a fresh
  // start in a home city, moves to the rotation's first zone after `outsideRotationSec`.
  const watchOutside = async (i) => {
    const list = config.rotation ?? [];
    if (!list.length || state.errand || !config.outsideRotationSec || list.includes(zoneShort(i))) return;
    if (now() - (state.zoneSince ?? now()) < config.outsideRotationSec * 1000) return;
    await moveTo(i, list[0], `${zoneShort(i)} is not in the rotation`);
  };
  const nextZone = (i) => {
    const here = zoneShort(i);
    const others = (config.rotation ?? []).filter((z) => z !== here);
    if (!others.length) return null;
    const k = (config.rotation ?? []).indexOf(here);
    // Rotation order from the zone after this one.
    return [...others.filter((z) => config.rotation.indexOf(z) > k), ...others.filter((z) => config.rotation.indexOf(z) < k)][0];
  };
  const moveTo = async (i, dest, why) => {
    if (!dest || typeof i.changeZone !== "function" || i.guard?.phase === "leaving" || i.stores.skills.getState().inCombat || now() < state.moveRetryAt) return false;
    const cb = i.stores.combat.getState();
    // A new zone starts from the target limits: a widening was for the zone the party leaves.
    const limits = config.limits ?? { minCon: cb.minCon, maxCon: cb.maxCon, maxLevelDiff: cb.maxLevelDiff };
    log(`moving to ${dest}: ${why}`);
    holdAutoLevel(cb, `the move to ${dest}`);
    try {
      const name = await i.changeZone(dest);
      setLimits(i.stores.combat.getState(), limits);
      state.widenedAt = 0;
      state.moveFails = 0;
      alert("rotate", `moved to ${name}: ${why}`);
      return true;
    } catch (e) {
      // A slow server times the request out ("Request timeout for opcode 313") and a later try goes
      // through, so failures back off like switches and only the third in a row wakes a script.
      state.moveFails++;
      state.moveRetryAt = now() + Math.min(600000, 30000 * 2 ** (state.moveFails - 1));
      alert("rotate", `move to ${dest} failed: ${e?.message ?? e}`, state.moveFails >= 3);
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
    const rate = playRate(i);
    if (rate == null) return;
    state.zoneBestRate = Math.max(state.zoneBestRate ?? 0, rate);
    if (now() - state.zoneSince < config.rotateMinStayMin * 60000 || rate >= config.rotateBelowShare * state.zoneBestRate) return;
    await rotate(i, `the last 10 minutes of play earned ${Math.round((100 * rate) / Math.max(1, state.zoneBestRate))}% of this visit's best`);
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
  // spawn list, so this waits until the party is in the zone. The range stops below the guard's
  // level gap, because the guard leaves every fight with an enemy that far above the leader: a
  // level 14 party widened to Najena's level 22 magicians escaped its first pull.
  const widenForErrand = (i, e) => {
    const rt = runtime(i);
    const cb = () => i.stores.combat.getState();
    if (!rt?.getAutoCombatLevelBounds || zoneShort(i) !== e.zone) return;
    e.range ??= rt.getAutoCombatLevelBounds();
    e.startLevel ??= i.stores.character.getState().characterProfile?.level ?? 0;
    const wanted = enemyPattern(e.keep);
    const lvl = i.stores.character.getState().characterProfile?.level ?? 0;
    const gap = i.guard?.config?.enabled ? i.guard.config.levelGap : Infinity;
    const levels = (i.zoneSpawns?.spawns ?? []).filter((s) => wanted.test(s.name ?? "")).map((s) => s.level).filter((l) => Number.isFinite(l) && l < lvl + gap);
    if (!levels.length) return;
    const lo = Math.min(...levels);
    const hi = Math.max(...levels);
    // Blue, then green, the lowest con AutoLevel pulls. The cap goes last, because the setters
    // overwrite each other in that order (docs/client-internals.md).
    if (cb().minNpcLevel > lo) cb().setMinNpcLevel(0);
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
    // An errand that runs out of time had no luck, which the coordinator retries, so it only notes.
    if (now() > e.until) return endErrand(i, e.item ? `no ${e.item} after ${e.minutes} minutes` : `${e.minutes} minutes done`, false);
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
        holdAutoLevel(cb(), "upkeep");
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
      if (stopped || state.pauseReason?.startsWith("upkeep")) endPause("upkeep");
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

  let ticking = null; // the tick in progress, which a call made meanwhile waits for
  // The watchers that serve the leader's party, in the order they act. They wait while another
  // character is active, out of the world, in a raid and under a pause.
  const serveParty = async (i) => {
    if (reconcileLeader(i)) return;
    const cb = i.stores.combat.getState();
    if (i.stores.screen.getState().currentScreen !== "game" || cb.isZoneLoading || !i.stores.character.getState().characterProfile?.id) return;
    scanEvents(i);
    watchZone(i, cb);
    await watchCursor(i);
    watchLoot(i);
    watchDeaths(i);
    if (inRaid(i)) return void watchMemory();
    if (config.respawnAfterSec > 0) await watchDeath(i);
    watchMemory();
    // A pause holds the tab for a script or a task: until it ends, the bot changes neither the
    // zone, the party, AutoLevel and its targets nor the gems and the bags.
    if (now() < state.pauseUntil) return;
    await watchErrand(i);
    await watchOutside(i);
    await watchRate(i);
    keepParty(i, cb);
    keepLimits(i, cb);
    keepTactics(i);
    avoidTargets(i);
    await upkeepIfDue(i);
    await keepReserve(i);
    await restoreBags(i);
  };
  const runTick = async () => {
    try {
      const i = iq();
      if (!i?.stores || typeof i.bagSpace !== "function") return;
      watchConnection(i);
      await watchRelease(i);
      if (state.pauseUntil && now() >= state.pauseUntil) endPause(pauseName());
      // The client options protect every character the tab plays, so they hold also while a task
      // plays another character or a pause holds the tab.
      if (i.stores.character.getState().characterProfile?.id && !i.stores.combat.getState().isZoneLoading) keepOptions(i.stores.combat.getState());
      noteHold(i);
      await serveParty(i);
      // AutoLevel and the idle remedies act after the watchers that hold the party, and also under a
      // hold, which leaves only the page's own remedies.
      await keepAutoLevel(i);
      state.lastError = null;
    } catch (e) {
      const msg = String(e?.message ?? e);
      if (state.lastError !== msg) log(`tick failed: ${msg}`);
      state.lastError = msg;
    }
  };
  const tick = () => {
    if (!config.enabled) return Promise.resolve();
    ticking ??= runTick().finally(() => {
      ticking = null;
    });
    return ticking;
  };

  // Checks of the fight state that cost time for every second they wait: a pull standing with
  // Auto Attack off, a root holding the readiness wait and a fight that makes no headway.
  const fastTick = () => {
    if (!config.enabled) return;
    try {
      const i = iq();
      if (!i?.stores) return;
      noteHold(i);
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
    waker,
    /** Roots on party members and pets with their end times, and who could dispel them. */
    roots: () => ({ roots: partyRoots(iq()), dispellers: dispellers(iq()) }),
    /** Each carried item's fate by the inventory policy: `{ keep, sell, discard }`. */
    fates: () => fates(iq()),
    /** The gems the upkeep would set for the leader's class, in gem order: [{gem, role, id, name, level}]. */
    spellPlan: () => spellPlan(iq()),
    /** The resurrection the bot would buy from `offers` ({ percent, price } in pp) with `coinPp` carried, or null to respawn. */
    recoveryChoice: (offers, coinPp) => recoveryChoice(offers, coinPp),
    /** Run the bag cleanup now, also during a pause, as below `minFreeSlots`. Resolves with the free slots after. */
    cleanup: async () => {
      await keepReserve(iq(), true);
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
     * Note" }`. A missing item is pulled from another account character, never from one in `avoid`,
     * the other characters that need it. Returns a copy of the task, which `state.task` keeps up to date.
     */
    quest({ members, steps, name = "quest", avoid = [] }) {
      if (!steps?.length) throw new Error("a quest needs steps");
      const task = startQuest("quest", (members ?? []).map((n) => ({ name: n, steps, avoid })), name);
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
     * bought only when none is left and it costs at most `maxPp`. `heal` is the heal mode, `nuke`
     * the nuke order and `effects` the effect orders (`iq.raid.heal`, `iq.raid.nuke` and
     * `iq.raid.effect`), null or empty for none. The task ends when the boss dies, the raid wipes
     * or `minutes` pass, and `task.fight` records the fight. Returns a copy of the task, which
     * `state.task` keeps up to date.
     */
    raid({ members, target = null, bossKey = null, zone = null, maxPp = 0, minutes = 15, heal = "all-balanced", nuke = "dps-balanced", effects = ["slow", "debuff"] }) {
      if (state.task?.status === "running") throw new Error(`the ${state.task.kind} task is still running`);
      if (!target === !bossKey) throw new Error("a raid needs either target or bossKey");
      if (!members?.length) throw new Error("a raid needs members");
      for (const m of members) accountCharacter(iq(), m);
      if (target) new RegExp(target);
      state.task = { id: `raid-${now().toString(36)}`, kind: "raid", members: [...members], target, bossKey, zone, maxPp, minutes, heal, nuke, effects: [...(effects ?? [])], startedAt: now() };
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
      state.task = { id: `gear-${now().toString(36)}`, kind: "gear", startedAt: now(), moves: moves.map((m) => ({ item: m.item, from: m.from, to: m.to, slot: m.slot ?? null, slotNum: m.slotNum ?? null, ...(m.buy ? { buy: { merchant: m.buy.merchant, zone: m.buy.zone, price: m.buy.price } } : {}) })) };
      log(`task gear: ${moves.length} moves`);
      return { ...runTask(state.task) };
    },
    /**
     * Stop the running task. The tab hunts again at once: a step in progress, such as a long wait for
     * an NPC, would otherwise hold the task's pause until it ends, and the task stops at its next step.
     */
    stopTask() {
      if (state.task?.status === "running") {
        state.task.status = "stopped";
        endPause(`the ${state.task.kind} task`);
      }
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
        holdAutoLevel(i.stores.combat.getState(), `the errand's move to ${zone}`);
        for (let k = 0; k < 22 && i.stores.skills.getState().inCombat; k++) await sleep(1000);
      }
      if (zoneShort(i) !== zone && !(await moveTo(i, zone, `errand: ${what}`))) {
        state.errand = null;
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
      endPause(pauseName());
      return true;
    },

    /** Draw the world for `seconds`, as a screenshot needs, after which rendering goes off again. */
    render(seconds = 30) {
      state.renderUntil = now() + seconds * 1000;
      keepOptions(iq().stores.combat.getState());
      return new Date(state.renderUntil).toISOString();
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
