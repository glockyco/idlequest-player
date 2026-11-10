// In-page bridge for the IdleQuest web client.
//
// The game simulates combat and AutoLevel inside the browser client, so the client has to keep
// running. This bridge attaches to the running client through its own modules and exposes a
// small, stable surface as `window.iq`.
//
// The release build minifies every export name and renames the chunk files, so stores are found
// by the state keys they carry, never by export name.
//
// Evaluate this file as a page expression. It returns `window.iq`. Evaluating it again replaces
// the previous install after removing its socket wrappers.
(async () => {
  // BEGIN CLIENT_SURFACE
  // Everything the SDK and the bot need from the client, in one place. The check
  // (tools/check-client.mjs) and the snapshot tool evaluate this block on their own, so it has to
  // stay self-contained. A store is found by the `find` keys of its state, and with `exact` by a
  // state of those keys alone. `actions` are the functions of that state the SDK calls, `state` the
  // values it reads. A store, the socket or the dispatcher that is missing stops the bridge. Any
  // other missing name is listed in `missingApi`.
  const CLIENT_SURFACE = (() => {
    const ASSET_RE = /\/assets\/[^/?#]+\.js(?:[?#]|$)/;
    const STORES = {
      combat: {
        find: ["startAutoLevel", "setAutomatedCombatMode", "currentZone"],
        actions: ["setMinCon", "setMaxCon", "setMaxLevelDiff", "setIsRunning", "setPlayerSitting", "toggleSpellbook", "toggleNote", "toggleMerchantList", "openManageMoney", "closeManageMoney", "openInventorySearch", "closeInventorySearch", "setCombatSkillMacrosOpen", "toggleAutoUpgradeCompanions"],
        state: ["isRunning", "isZoneLoading", "isPlayerSitting", "isSpellbookOpen", "isNoteOpen", "isMerchantListOpen", "isCombatSkillMacrosOpen", "isAutoAttacking", "isAutoAttackEnabled", "currentZoneNPCs", "engagedMobs", "minCon", "maxCon", "maxLevelDiff", "noAutoSellBagInstanceIds", "automatedCombatMode", "companionAggression", "activeCombatTargetSpawnInstanceId", "targetNPC"],
      },
      character: {
        find: ["characterProfile", "handleCharacterData"],
        actions: ["moveItemToSlot"],
        state: ["characterProfileLoaded"],
      },
      spellbook: {
        find: ["scribedSpells", "memorizedSpells", "memorizeSpell"],
        actions: ["scribeSpell", "unmemorizeSpell"],
        state: [],
      },
      companions: {
        find: ["companions", "summonPet", "addWarrior"],
        actions: ["addCleric", "addRogue", "dismissPet", "transferHeldItem", "controlAccountCharacter", "requestAccountCharacterAvailability", "loadBotItemsAndRecalc", "releaseAccountCharactersForCamp"],
        state: ["botInventories", "botCombatDataMap", "botComputedStats"],
      },
      skills: { find: ["skills", "setInCombat"], actions: [], state: ["inCombat"] },
      screen: { find: ["currentScreen", "setScreen"], actions: [], state: [] },
      roster: { find: ["characters", "enterWorld", "deleteCharacter"], actions: [], state: [] },
      chat: { find: ["messages", "addMessage", "lastTellSender"], actions: [], state: ["nextId"] },
      staticData: { find: ["zones", "races", "classes", "deities"], actions: [], state: [] },
      raid: { find: ["setGroupCommand", "isRaidOpen"], actions: ["openRaid", "closeRaid", "endRaid", "addGuildMembers", "setAllCommand"], state: ["raidModeActive", "combatActive", "leaderDead", "lifecyclePending", "roster", "engagedEnemies", "eventLog"] },
      // The Raid Time section's quote and expiry, which raid mode reads before it starts a fight.
      raidTime: { find: ["priceCopper", "renewalAttemptedFor"], actions: [], state: ["expiresAtMs", "busy", "error"] },
      // The failed zone load that the loading overlay shows as Loading Failed, and the retry its
      // TRY AGAIN button calls.
      loadFailure: { find: ["retryToken", "fail", "retry"], actions: ["retry"], state: ["message"] },
      // The inventory's transactions: `busy` until the server confirms an item action. Meanwhile the
      // client refuses a destroy, and a slow server pauses item actions for minutes.
      inventory: { find: ["busy"], exact: true, actions: [], state: ["busy"] },
      merchant: { find: ["merchants", "selectedMerchant", "merchantItems"], actions: [], state: [] },
      partyTactics: { find: ["meleeByCharacterId", "setTactic"], actions: [], state: ["overridesByCharacterId"] },
      partySpells: { find: ["castingPreferences", "setPetPreference"], actions: ["setTactic", "setCastingPreferences"], state: ["overridesByCompanion"] },
    };
    const SOCKET = {
      find: ["sendJsonRequest", "worldReady"],
      // Wrapped by the traffic log, so `window.iq` removes the wrappers before it installs again.
      methods: ["observeIncomingOpcode", "sendJsonMessage", "sendStreamJsonMessage", "sendJsonRequest", "sendCorrelatedJsonRequest"],
      other: ["buildConnectionQuery"],
      state: ["isConnected"],
    };
    // The command dispatcher carries this error code. `session.createCharacter` is the command the SDK sends.
    const DISPATCHER = "command-error";
    // The dialogue functions of `talk`, found by their minified export names.
    const isDialogue = (m) => typeof m.l === "function" && typeof m.j === "function" && typeof m.s === "function";
    // Client functions, found by pieces of their source because the release build renames exports:
    // every string of a list must occur in it, or a RegExp must match all of it.
    const FUNCTIONS = {
      sell: ["Sale confirmation was interrupted"], // the sale the Sell Item button and merchant windows send, (bag, slot)
      autoBank: ["courier-based banking fees"], // the Auto Bank macro's courier to the tradeskill bank
      autoPlace: ["Auto-placing"], // puts the cursor item into the bags
      zoneChange: ["WorldSocket not connected", "zoneName"], // the Travel window's zone request
      raidTime: ["Raid time reply belongs to another character"], // the Raid Time section's RaidAccess request, (action, autoRenew), which updates `raidTime`
      // What a click on an NPC sends, (npcId, name), a function that passes its three parameters on.
      // Releases rename the parameters, and Bun reformats the sources it loads, so the pattern allows both.
      hail: /^function [\w$]+\(\s*([\w$]+),\s*([\w$]+),\s*([\w$]+)\s*=\s*\{\}\s*\)\s*\{\s*return [\w$]+\(\s*\1,\s*\2,\s*\3\s*\);?\s*\}$/,
      // The control state of an entity from its active effects, ({ effects }) => { isRooted, ... }:
      // the readiness wait's root test ("Waiting for root to wear off the party").
      rootState: /^function [\w$]+\(\s*\w+\s*\)\s*\{[\s\S]{0,500}remainingTicks[\s\S]{0,300}stunMs[\s\S]{0,200}hardControlled[\s\S]{0,100}feignDeath[\s\S]{0,40}\}$/,
    };
    // Client service objects, found by one method and pieces of its source like FUNCTIONS. The
    // bundle also exports a stand-in whose every method returns false, so a name is not enough.
    const SERVICES = {
      combat: { method: "abandonRaid", needle: ["Raid abandonment was not confirmed"] }, // raid fights, the raid leader's death and End Raid
      effects: { method: "getEffects", needle: ["records.get", "effects"] }, // the effects registry: every entity's active effects by entity id
    };
    const matches = (needle, src) => (needle instanceof RegExp ? needle.test(src) : needle.every((s) => src.includes(s)));
    const isService = (v, { method, needle }) => {
      try {
        return typeof v[method] === "function" && matches(needle, Function.prototype.toString.call(v[method]));
      } catch {
        return false;
      }
    };

    const isStore = (v) => typeof v === "function" && typeof v.getState === "function" && typeof v.subscribe === "function";
    const stateOf = (store) => {
      try {
        return store.getState();
      } catch {
        return null;
      }
    };

    /** Finds the stores, the socket, the dispatcher, the dialogue module, the game clock, the client functions and the client services among the loaded modules `{ file: exports }`. */
    function discover(mods) {
      const stores = {};
      let socket = null;
      let clock = null; // the game's time of day, which night-only spawns and spells follow
      const fns = [];
      const objects = [];
      for (const m of Object.values(mods)) {
        for (const v of Object.values(m)) {
          if (typeof v === "function") fns.push(v);
          else if (v && typeof v === "object") objects.push(v);
          if (!clock && v && typeof v === "object" && typeof v.getTimeOfDay === "function" && typeof v.isSynchronized === "boolean") clock = v;
          if (!socket && v && typeof v === "object" && SOCKET.find.every((k) => k in v) && typeof v.sendJsonRequest === "function") {
            socket = v;
            continue;
          }
          if (!isStore(v)) continue;
          const st = stateOf(v);
          if (!st) continue;
          for (const [name, spec] of Object.entries(STORES)) {
            if (!stores[name] && spec.find.every((k) => k in st) && (!spec.exact || Object.keys(st).length === spec.find.length)) stores[name] = v;
          }
        }
      }
      const command = fns.find((v) => String(v).includes(`"${DISPATCHER}"`)) ?? null;
      const dialogue = Object.values(mods).find(isDialogue) ?? null;
      const sources = fns.map((f) => [f, Function.prototype.toString.call(f)]);
      const functions = Object.fromEntries(Object.entries(FUNCTIONS).map(([name, needle]) => [name, sources.find(([, src]) => matches(needle, src))?.[0] ?? null]));
      const services = Object.fromEntries(Object.entries(SERVICES).map(([name, spec]) => [name, objects.find((v) => isService(v, spec)) ?? null]));
      return { stores, socket, command, dialogue, clock, functions, services };
    }

    /** One row `{ kind, name, ok }` for every part of the surface, in a fixed order. */
    function audit({ stores, socket, command, dialogue, clock, functions, services }) {
      const rows = [];
      const row = (kind, name, ok) => rows.push({ kind, name, ok: Boolean(ok) });
      row("socket", "socket", socket);
      if (socket) {
        for (const k of [...SOCKET.methods, ...SOCKET.other]) row("socket", `socket.${k}`, typeof socket[k] === "function");
        for (const k of SOCKET.state) row("socket", `socket.${k}`, k in socket);
      }
      for (const [name, spec] of Object.entries(STORES)) {
        row("store", name, stores[name]);
        const st = stores[name] && stateOf(stores[name]);
        if (!st) continue;
        for (const k of spec.actions) row("action", `${name}.${k}`, typeof st[k] === "function");
        for (const k of spec.state) row("state", `${name}.${k}`, k in st);
      }
      row("dispatcher", "dispatcher", command);
      row("module", "dialogue", dialogue);
      row("module", "clock", clock);
      for (const name of Object.keys(FUNCTIONS)) row("function", `fn.${name}`, functions?.[name]);
      for (const name of Object.keys(SERVICES)) row("service", `service.${name}`, services?.[name]);
      return rows;
    }

    // Compact form of an ISO time: 2026-11-08T00:46:44.564Z -> 20261108T004644.
    const compactTime = (t) => String(t).replace(/\.\d+Z$/, "").replace(/[-:]/g, "");
    // 53-bit string hash (cyrb53), the same in the page and in Bun.
    const hash = (str) => {
      let h1 = 0xdeadbeef;
      let h2 = 0x41c6ce57;
      for (let i = 0; i < str.length; i++) {
        const c = str.charCodeAt(i);
        h1 = Math.imul(h1 ^ c, 2654435761);
        h2 = Math.imul(h2 ^ c, 1597334677);
      }
      h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
      h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
      return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
    };

    return {
      STORES,
      SOCKET,
      DISPATCHER,
      FUNCTIONS,
      SERVICES,
      ASSET_RE,
      discover,
      audit,
      /** Sorted, unique file names of the /assets/*.js entries in a list of URLs. */
      assetNames: (urls) => [...new Set(urls.filter((u) => ASSET_RE.test(u)).map((u) => u.split(/[?#]/)[0].split("/").pop()))].sort(),
      /** The release string the page HTML carries in its `<!-- Build v... -->` comment. */
      buildTag: (html) => /<!--\s*Build v(\S+?)\s*-->/.exec(html)?.[1] ?? null,
      /** Names a client build: its release time and a hash of the entry script names. */
      releaseId: (clientRelease, names) => `${clientRelease ? compactTime(clientRelease) : "unknown"}-${hash(names.join("\n")).slice(0, 8)}`,
      /** The module scripts a page's HTML declares, which for the client is the one entry bundle. */
      declaredInHtml: (html) => [...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]).filter((t) => /\btype="module"/.test(t)).map((t) => /\bsrc="([^"]+)"/.exec(t)?.[1]).filter(Boolean),
    };
  })();
  // END CLIENT_SURFACE

  const socketMethods = CLIENT_SURFACE.SOCKET.methods;
  if (window.iq) {
    // Wrappers are instance properties that shadow prototype methods, so deleting them restores the originals.
    for (const fn of socketMethods) if (window.iq.socket) delete window.iq.socket[fn];
  }

  const ASSET_RE = CLIENT_SURFACE.ASSET_RE;

  // Import only modules the page already loaded, so nothing new is fetched or evaluated.
  const urls = [
    ...new Set(
      performance
        .getEntriesByType("resource")
        .filter((e) => ASSET_RE.test(e.name))
        .map((e) => e.name.split(/[?#]/)[0]),
    ),
  ];
  const mods = {};
  for (const url of urls) {
    try {
      mods[url.split("/").pop()] = await import(url);
    } catch {
      /* non-module asset */
    }
  }

  const { stores, socket, command, dialogue, clock, functions, services } = CLIENT_SURFACE.discover(mods);
  const surfaceReport = CLIENT_SURFACE.audit({ stores, socket, command, dialogue, clock, functions, services });
  /** The client function `name` of `CLIENT_SURFACE`'s FUNCTIONS, or an error naming it. */
  const clientFn = (name) => {
    const f = functions[name];
    if (!f) throw new Error(`client function ${name} not found`);
    return f;
  };
  const missingStores = surfaceReport.filter((r) => !r.ok && (r.kind === "store" || r.kind === "socket")).map((r) => r.name);
  if (missingStores.length) throw new Error(`bridge: could not find ${missingStores.join(", ")}`);
  // Anything else the SDK calls that this client lacks is reported, not fatal: the rest keeps working.
  const missingApi = surfaceReport.filter((r) => !r.ok).map((r) => r.name);

  // ---- Release ------------------------------------------------------------------------------
  // `release` names the client build: its release string plus the name of the entry script the
  // page HTML declares. The bundler hashes the entry name over everything it imports, so the name
  // changes with any change of the client. The set of loaded files cannot name a build, because
  // it grows as screens open and the bundler adds preload links at run time. The bot compares the
  // id with the one of the previous page to notice an update. `assets` lists what is loaded now.
  const declared = [...document.querySelectorAll("script[type=module][src]")].map((e) => e.src);
  let clientRelease = null;
  try {
    clientRelease = new URLSearchParams(socket.buildConnectionQuery()).get("client_release");
  } catch {
    /* the client no longer builds its connection query this way */
  }
  if (!clientRelease) {
    // The page HTML names the build in a comment.
    const comments = document.createTreeWalker(document, NodeFilter.SHOW_COMMENT);
    for (let c = comments.nextNode(); c && !clientRelease; c = comments.nextNode()) clientRelease = CLIENT_SURFACE.buildTag(`<!--${c.data}-->`);
  }
  const release = CLIENT_SURFACE.releaseId(clientRelease, CLIENT_SURFACE.assetNames(declared));
  const assets = CLIENT_SURFACE.assetNames(urls);

  // ---- Traffic log -------------------------------------------------------------------------
  // Tee packets by wrapping instance methods. NEVER assign to socket.onJson or any other
  // callback slot: the game's own packet dispatch lives there and replacing it stalls the client.
  const log = { seq: 0, max: 4000, entries: [] };
  const opName = {};
  const noisy = new Set(["Heartbeat"]);
  let lastPos = window.iq?.lastPos ?? null;
  let label = window.iq?.label ?? "";
  let zoneSpawns = window.iq?.zoneSpawns ?? null; // last ZoneSpawns packet: where every spawn of the zone stands
  const record = (dir, op, data) => {
    if (dir === "out" && opName[op] === "PlayerPositionUpdate") lastPos = { x: data.x, y: data.y, z: data.z, st: data.movementState };
    if (dir === "in" && opName[op] === "GetZoneSpawnsResponse") zoneSpawns = { t: Date.now(), spawns: data.spawns ?? [] };
    const name = opName[op] ?? String(op);
    if (noisy.has(name)) return;
    log.entries.push({ seq: ++log.seq, t: Date.now(), dir, op, name, data });
    if (log.entries.length > log.max) log.entries.splice(0, log.entries.length - log.max);
  };
  // Kill log built from the combat messages the server broadcasts, and the item ids of the loot
  // packets by item name, which the loot lines printed from them lack (`lootOf`). `faults` names the
  // client's faults the page supervisor reloads a page for (tools/lib/page.mjs): `lootless` counts
  // the kills in a row without a "You loot" line, which a failed zone load can stop.
  const kills = window.iq?.kills ?? [];
  const faults = window.iq?.faults ?? { lootless: 0 };
  const KILL_RE = /^You have (?:defeated|slain) (.+?) and gained (\d+) experience/;
  const lootIds = new Map();
  const origObserve = socket.observeIncomingOpcode.bind(socket);
  socket.observeIncomingOpcode = (op, payload) => {
    try {
      const data = JSON.parse(new TextDecoder().decode(payload));
      record("in", op, data);
      const m = opName[op] === "ChatMessageBroadcast" && KILL_RE.exec(data.text ?? "");
      if (m) {
        kills.push({ t: Date.now(), enemy: m[1], xp: Number(m[2]) });
        faults.lootless++;
      }
      if (opName[op] === "LootGenerated") for (const it of data.items ?? []) lootIds.set(it.name, it.itemId);
    } catch {
      /* not JSON */
    }
    return origObserve(op, payload);
  };
  for (const fn of ["sendJsonMessage", "sendStreamJsonMessage"]) {
    const orig = socket[fn].bind(socket);
    socket[fn] = (op, payload, ...rest) => (record("out", op, payload), orig(op, payload, ...rest));
  }
  for (const fn of ["sendJsonRequest", "sendCorrelatedJsonRequest"]) {
    const orig = socket[fn].bind(socket);
    socket[fn] = (op, replyOp, payload, ...rest) => (record("out", op, payload), orig(op, replyOp, payload, ...rest));
  }

  // ---- Recorder -----------------------------------------------------------------------------
  // Everything the analysis needs, with sequence numbers so a reader can drain incrementally and
  // resume after its own restart. Buffers live in the page and survive reinstalls.
  //   samples: one row per second of play state (see `sample()`)
  //   events:  every chat/combat line the client shows, with the client's own timestamp
  const samples = window.iq?.samples ?? [];
  const events = window.iq?.events ?? [];
  const seqs = window.iq?.seqs ?? { sample: 0, event: 0 };
  // Changes whenever the page reloads, because the buffers and the sequence numbers restart then.
  // The supervisor installs several pages within one millisecond, so a random part keeps their
  // sessions apart, and the id still sorts by install time.
  const session = window.iq?.session ?? Date.now() * 1000 + Math.floor(Math.random() * 1000);
  // Rows kept by an older install of this bridge carry no session. Give them one that sorts before
  // this install's, so an exporter whose file holds rows from an earlier page still collects them.
  for (const r of samples) r.ses ??= session - 1;
  for (const r of events) r.ses ??= session - 1;
  const SAMPLE_MAX = 90000; // 25 h at 1 Hz
  const EVENT_MAX = 60000;
  // An older install's jobs read positions and chat from its own sampler, which stops here, so they
  // are told to stop too: their next pause throws, and a bot task that ran them resumes on this one.
  window.iq?.dispose?.();
  if (window.iq?.samplerId) clearInterval(window.iq.samplerId);
  if (window.iq?.unsubChat) window.iq.unsubChat();

  // ---- Activity -----------------------------------------------------------------------------
  // One label for every second of play, so the time a tab loses is measured instead of guessed
  // (docs/plans/controller.md), and every idle second carries the cause the page shows for it
  // (docs/plans/fault-handling.md). `ACTIVITY_RULES.label` decides from what `activityView` reads:
  //   dead       the active character is dead
  //   travel     zoning (why "zone"), an escape of the guard ("escape"), or AutoLevel's own trip
  //              to a merchant ("restock") or back after a death ("deathReturn")
  //   fight      in combat
  //   task       the bot is paused for a script, why is the pause reason
  //   approach   walking to the enemy AutoLevel or the Enemy Targets list picked
  //   recover    the readiness wait before a pull (HP, mana, pets, cures) or its retry, or someone
  //              below full HP or mana while AutoLevel runs, as in its 5 s pause after each kill
  //   idle       nothing happens, and why names what holds the party:
  //     loadFailed   a zone load failed and its Loading Failed window is open, so nothing plays
  //     held         AutoLevel off since one of the bot's holds (`autoLevelHold` in src/bot.js)
  //     clientPause  AutoLevel off since the client paused it ("AutoLevel paused: ...")
  //     clientRejoin AutoLevel off since the client paused it until the character camps and enters
  //                  again ("... Camp and re-enter your character, or reload, before trying again.")
  //     contested    AutoLevel off since the client gave up a target another player holds
  //     noEnemies    AutoLevel off since the client found no enemy within its limits in the zone
  //     off          AutoLevel off with none of these since it last ran
  //     waitAttack   AutoLevel at its target with Auto Attack off
  //     readyWait    AutoLevel retrying its readiness wait with the party full
  //     afterKill    the client's pause after a won fight, with the party full
  //     lootSettle   AutoLevel waiting for a kill's loot to settle
  //     crowded      AutoLevel waiting for an enemy that other players or its deferrals hold
  //     noTarget     AutoLevel on with nothing to approach, no loot pending and no enemy to wait for
  //     unknown      the client's combat runtime is not found, so the rules cannot place the second
  // BEGIN ACTIVITY_RULES
  // Pure and self-contained, so tests/activity.test.ts evaluates this block on its own.
  const ACTIVITY_RULES = (() => {
    // AutoLevel waits this long after each won fight before it looks for the next enemy (`Dt`,
    // 5 s, in the client's combat runtime), plus a second of sampling slack.
    const AFTER_KILL_MS = 6000;
    // The client's lines that stop AutoLevel (CAUokwED.js): its supervisor's pause, the target
    // approach's abandon when AutoLevel had stopped or fought a single target (while AutoLevel
    // runs, the client tries another target after 500 ms), and the target search that found nothing.
    const STOP_LINES = [
      [/^AutoLevel paused: .*Camp and re-enter your character/, "clientRejoin"],
      [/^AutoLevel paused: /, "clientPause"],
      [/ Looking for another target\.$/, "contested"],
      [/^No available enemies found in this zone/, "noEnemies"],
    ];
    /** The cause a chat line gives for a stop of AutoLevel, or null. Only the client's system lines count. */
    const stopCause = (e) => (/^SYSTEM/.test(e?.type ?? "") ? (STOP_LINES.find(([re]) => re.test(e.text ?? ""))?.[1] ?? null) : null);
    /**
     * Why AutoLevel is off: the latest evidence since it last ran at `ranAt`, the client's latest
     * stop line `stop` (`{ t, cause }`) or the bot's latest hold at `heldAt`.
     */
    const offCause = ({ ranAt, stop, heldAt }) => {
      const line = stop && stop.t >= ranAt ? stop : null;
      if (heldAt > ranAt && heldAt >= (line?.t ?? 0)) return "held";
      return line?.cause ?? "off";
    };
    /** The label `[act, why]` of one second of play, from the page view of `activityView`. */
    const label = (v) => {
      if (v.loadFailed) return ["idle", "loadFailed"];
      if (v.dead) return ["dead"];
      if (v.zoneLoading) return ["travel", "zone"];
      if (v.escaping) return ["travel", "escape"];
      if (v.inCombat) return ["fight"];
      if (v.pause != null) return ["task", v.pause];
      if (v.trip) return ["travel", v.trip === "death-return" ? "deathReturn" : "restock"];
      const rt = v.runtime;
      if (!rt) return ["idle", "unknown"];
      if (rt.attempt) return rt.attempt === "waiting-to-attack" ? ["idle", "waitAttack"] : ["approach"];
      if (rt.buffPhase) return ["recover"];
      if (rt.retrying) return v.partyFull ? ["idle", "readyWait"] : ["recover"];
      if (!v.running) return ["idle", offCause(v)];
      if (!v.partyFull) return ["recover"];
      if (v.sinceKillMs < AFTER_KILL_MS) return ["idle", "afterKill"];
      if (rt.pendingLoot > 0) return ["idle", "lootSettle"];
      if (rt.waitingTargets) return ["idle", "crowded"];
      return ["idle", "noTarget"];
    };
    return { stopCause, offCause, label };
  })();
  // END ACTIVITY_RULES
  /** True when the leader and every living companion and pet are at full HP and mana. */
  const partyFull = () => {
    const p = stores.character.getState().characterProfile ?? {};
    const cs = stores.companions.getState();
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
  let journeyHelper; // the client's restock and death-return helper, undefined until searched
  const journey = () => {
    if (journeyHelper === undefined) journeyHelper = allExports().find((g) => g && typeof g === "object" && typeof g.beforeFight === "function" && "returningAfterDeath" in g) ?? null;
    return journeyHelper;
  };
  // When AutoLevel last ran and the client's latest line that stopped it, which the rules weigh
  // against the bot's holds. A reinstall takes both from the buffers.
  let ranAt = samples.findLast((s) => s.run)?.t ?? 0;
  let lastStop = null;
  const noteStop = (e) => {
    const cause = ACTIVITY_RULES.stopCause(e);
    if (cause) lastStop = { t: e.t, cause };
  };
  for (const e of events) noteStop(e);
  /** What the label rules read: the client's stores and combat runtime, and the bot's pause and holds. */
  const activityView = () => {
    const p = stores.character.getState().characterProfile;
    const cb = stores.combat.getState();
    const t = Date.now();
    if (cb.isRunning) ranAt = t;
    const bot = window.iqBot?.state;
    const rt = runtime();
    const attempt = rt?.combatApproach?.attempt;
    return {
      loadFailed: Boolean(stores.loadFailure.getState().message),
      dead: !(p?.curHp > 0),
      zoneLoading: Boolean(cb.isZoneLoading),
      escaping: guard.phase === "leaving",
      inCombat: Boolean(stores.skills.getState().inCombat),
      pause: (bot?.pauseUntil ?? 0) > t ? String(bot.pauseReason ?? "").slice(0, 40) : null,
      trip: journey()?.phase ?? null,
      runtime: rt
        ? {
            attempt: attempt ? (attempt.phase ?? "approaching") : null,
            buffPhase: Boolean(rt.buffPhaseActive),
            retrying: rt.preparationRetryTimer != null,
            pendingLoot: rt.pendingAutoLevelLoot?.size ?? 0,
            waitingTargets: Boolean(rt.waitingForAutoLevelTargets),
          }
        : null,
      running: Boolean(cb.isRunning),
      partyFull: partyFull(),
      sinceKillMs: t - (kills.at(-1)?.t ?? 0),
      ranAt,
      stop: lastStop,
      heldAt: Number(bot?.heldAt) || 0,
    };
  };
  // The current label and when it began, `{ act, why, since }`, which the sampler and every reader
  // bring up to date. A fault in the rules must not stop the recorder, so it shows as its own label.
  let activity = window.iq?.activity?.() ?? null;
  const readActivity = () => {
    let lab;
    try {
      lab = ACTIVITY_RULES.label(activityView());
    } catch {
      lab = ["unknown"];
    }
    const [act, why = null] = lab;
    if (activity?.act !== act || activity?.why !== why) activity = { act, why, since: Date.now() };
    return activity;
  };
  const sample = () => {
    const p = stores.character.getState().characterProfile;
    if (!p?.id) return null;
    const cb = stores.combat.getState();
    const comps = stores.companions.getState().companions ?? [];
    const t = Date.now();
    const { act, why } = readActivity();
    // A task or an errand changes what the party fights, so the measured zone rates leave that
    // time out (tools/lib/rates.mjs).
    const bot = window.iqBot?.state;
    const busy = bot?.errand ? "errand" : (bot?.pauseUntil ?? 0) > t ? "task" : null;
    return {
      ses: session,
      seq: ++seqs.sample,
      t,
      act,
      ...(why ? { why } : {}),
      ...(busy ? { busy } : {}),
      // The active character, so an XP difference never spans a switch (tools/lib/samples.mjs).
      cid: p.id,
      lvl: p.level,
      xp: p.experienceProgress?.current ?? null, // absolute XP, continuous across levels
      zone: cb.currentZone,
      // The profile's x/y is only set on zone entry. The client's own position packets are the truth.
      x: lastPos?.x ?? null,
      y: lastPos?.y ?? null,
      z: lastPos?.z ?? null,
      pst: lastPos?.st ?? null,
      combat: !!stores.skills.getState().inCombat,
      label,
      tgtId: cb.activeCombatTargetSpawnInstanceId ?? null,
      autoAtk: !!cb.isAutoAttacking,
      run: !!cb.isRunning,
      mode: cb.automatedCombatMode,
      sit: !!cb.isPlayerSitting,
      target: cb.targetNPC?.name ?? null,
      minCon: cb.minCon,
      maxCon: cb.maxCon,
      aggr: cb.companionAggression,
      // Party members as [name, hp, maxHp, mana, maxMana]; the player first.
      party: [["me", p.curHp, p.maxHp, p.mana, p.maxMana], ...comps.map((c) => [c.name, c.curHp, c.maxHp, c.curMana, c.maxMana])],
      // Levels in the same order as `party`, so level-ups cannot hide inside a comparison block.
      lv: [p.level, ...comps.map((c) => c.level)],
      // Carried coin in copper (1 platinum = 1000), so income per hour can be measured.
      cp: (p.platinum ?? 0) * 1000 + (p.gold ?? 0) * 100 + (p.silver ?? 0) * 10 + (p.copper ?? 0),
      // 1 while the tab is visible. Browsers throttle timers in hidden tabs, and the client simulates combat.
      vis: document.visibilityState === "visible" ? 1 : 0,
    };
  };
  const samplerId = setInterval(() => {
    try {
      applyShims();
      const s = sample();
      if (!s) return;
      samples.push(s);
      if (samples.length > SAMPLE_MAX) samples.splice(0, SAMPLE_MAX / 5);
    } catch {
      /* store not ready */
    }
  }, 1000);

  // ---- Chores -------------------------------------------------------------------------------
  // Things the game asks the player to do that need no standing still. They run in the page, so
  // they happen whether or not a script is attached.
  const chores = { autoBuySpells: true, ...window.iq?.chores };
  let buying = false;
  let lastSpellBuy = 0;
  const choreNote = (text) => events.push({ ses: session, seq: ++seqs.event, t: Date.now(), type: "chore", text: `[chore] ${text}` });
  /**
   * Buy and scribe every missing merchant spell for the player and the same-account companions in
   * the party. It sends the request the macro buttons Buy Spells and Buy Companion Spells send
   * (ScribeAvailableSpells). Returns one line per scope with the server's reply.
   */
  const buyMissingSpells = async (scopes = ["self", "companions"]) => {
    if (buying) return ["a purchase is already running"];
    const opId = Number(Object.entries(opName).find(([, n]) => n === "ScribeAvailableSpells")?.[0]);
    if (!opId) throw new Error("opcode table not loaded");
    buying = true;
    const lines = [];
    try {
      const id = stores.character.getState().characterProfile.id;
      for (const scope of scopes) {
        const r = await socket.sendCorrelatedJsonRequest(opId, opId, { characterId: id, scope, syncOnly: false });
        lines.push(`${scope}: ${r.error || r.message || (r.success ? "ok" : "no confirmation")}`);
      }
    } finally {
      buying = false;
    }
    return lines;
  };

  // Who dealt an outgoing damage line, for each member's share of the party's damage (the gear
  // value's damage shares, docs/plans/gear-acquisition.md): `by` the member, or a pet's owner, and
  // `kind` "melee" or "spell" for the member's own, which its gear raises, "pet" for its pet's and
  // "shield" for a damage shield it wears, which come from the pet's own power and from buffs. Pets
  // carry generated names that change at each summon, so the owner is looked up as the line arrives.
  // Melee, damage over time and shields come as COMBAT_OUTGOING lines, and a direct-damage spell as
  // a SPELL_CAST line ("Hufiazun's Ice Shock hit gnomish_miner for 310 points of damage."), a type
  // other casters' lines share, so those count only for the party.
  const DAMAGE_LINES = {
    COMBAT_OUTGOING: [
      [/^(You|[A-Z][\w`']*) [a-z]+(?: on)? .+? for (\d+) damage\.$/, "melee"],
      [/^.+? has taken (\d+) damage from (your|[A-Z][\w`']*'s) spell\.$/, "spell"],
      [/^(Your|[A-Z][\w`']*'s) damage shield [a-z]+ .+? for (\d+) points\.$/, "shield"],
    ],
    SPELL_CAST: [[/^(Your|[A-Z][\w`']*'s) .+? hit .+? for (\d+) points of damage\.$/, "spell"]],
  };
  const damageOf = (type, text) => {
    for (const [re, kind] of DAMAGE_LINES[type] ?? []) {
      const m = re.exec(text);
      if (!m) continue;
      const [who, n] = /has taken/.test(re.source) ? [m[2], m[1]] : [m[1], m[2]];
      const me = stores.character.getState().characterProfile;
      const companions = stores.companions.getState().companions ?? [];
      const name = /^(You|your|Your)$/.test(who) ? me?.name : who.replace(/'s$/, "");
      if (type === "SPELL_CAST" && name !== me?.name && !companions.some((c) => c.name === name)) return null;
      const pet = companions.find((c) => c.name === name && c.petOwnerId);
      if (!pet) return { by: name, kind, dmg: Number(n) };
      const owner = pet.petOwnerCharacterId === me?.id ? me?.name : companions.find((c) => c.id === pet.petOwnerId)?.name;
      return owner ? { by: owner, kind: "pet", dmg: Number(n) } : null;
    }
    return null;
  };
  // The item a "You loot" line names, by the id its loot packet gave (the chat message holds only
  // the text). "You loot 3 gold!" is coin.
  const LOOT_LINE = /^You loot (?!\d)(.+)!$/;
  const lootOf = (type, text) => {
    const itemId = type === "LOOT" ? lootIds.get(LOOT_LINE.exec(text ?? "")?.[1]) : undefined;
    return itemId != null ? { itemId } : null;
  };

  // Read-only subscription; never replaces a client callback.
  let lastChatId = stores.chat.getState().nextId - 1;
  const unsubChat = stores.chat.subscribe((state) => {
    // Camping clears the chat and numbers its messages from 1 again.
    if (state.nextId - 1 < lastChatId) lastChatId = 0;
    for (const m of state.messages) {
      if (m.id <= lastChatId) continue;
      lastChatId = m.id;
      const e = { ses: session, seq: ++seqs.event, t: m.timestamp ?? Date.now(), type: m.type, text: m.text, ...damageOf(m.type, m.text), ...lootOf(m.type, m.text) };
      events.push(e);
      noteStop(e);
      // Only a coin or item line ends a run, because a client without its loot messages still shows
      // lines such as "Uncollected items remain on the corpse".
      if (e.type === "LOOT" && /^You loot /.test(e.text ?? "")) faults.lootless = 0;
      // The game reminds the player when merchant spells are missing, after a level-up and every ten minutes.
      if (chores.autoBuySpells && /missing \d+ merchant spells?/i.test(m.text) && Date.now() - lastSpellBuy > 30000) {
        lastSpellBuy = Date.now();
        buyMissingSpells()
          .then((lines) => choreNote(`bought spells: ${lines.join(" | ")}`))
          .catch((e) => choreNote(`spell purchase failed: ${e.message}`));
      }
    }
    if (events.length > EVENT_MAX) events.splice(0, EVENT_MAX / 5);
  });

  // ---- Guard --------------------------------------------------------------------------------
  // Lives in the page, so it keeps working while no script is attached. When a fight turns
  // dangerous it stops AutoLevel, leaves the fight with the game's own zone-change request (the
  // one the Travel window sends) and, when AutoLevel was running, starts it again with the same limits.
  // Triggers, each checked once a second while a mob is engaged:
  //   level   a mob is `levelGap` or more levels above the leader, or `levelGapLow` while it fights
  //           the party and the leader is at most level `lowLevelMax`
  //   hit     a mob's biggest hit times `hitsToKill` reaches the lowest max HP in the party, from
  //           leader level `hitFromLevel`: below it members have 35 to 60 HP, so nearly every
  //           mob qualifies and the party would escape instead of fighting
  //   dying   the leader is at or below `dyingHpPct` HP and, at the HP it lost over the last
  //           `dyingWindowSec`, dead within `dyingSec`
  //   down    a party member has died since the guard last looked
  //   healer  a Cleric is below `healerManaPct` mana while someone is below `healerHpPct` HP
  const guardPrev = window.iq?.guard;
  if (guardPrev?.timerId) clearInterval(guardPrev.timerId);
  const GUARD_DEFAULTS = {
    enabled: true,
    levelGap: 8,
    hitsToKill: 3,
    hitFromLevel: 6,
    healerManaPct: 10,
    healerHpPct: 50,
    escalateAfter: 3, // escapes in an hour before the guard gets more careful
    minLevelDiff: 1, // tightening lowers the level cap one step per escape, not below this
    retreatZone: null, // short name to leave to, or null to re-enter the current zone
    loopSec: 30, // a second escape this soon in the same zone leaves for another rotation zone
    avoidMin: 10, // after an escape, AutoLevel skips the mobs of that fight this long (0 = never)
    // The engaged list also holds mobs of the encounter that stand idle without a target, and
    // city guards and sentinels that fight other NPCs ("npc:<id>"). Both set off most level
    // escapes at low levels. With this on, the level and hit triggers only count mobs that
    // target, chase or hate the leader, a companion or a pet.
    fightingOnly: true,
    // At leader levels 1 to 8 most fights against mobs that hit someone from 6 or 7 levels up
    // ended in a death (tools/fights.mjs), so there a mob fighting the party counts from
    // `levelGapLow`.
    lowLevelMax: 8,
    levelGapLow: 6,
    // From level 5 the leader's death costs level squared times 666.67 XP. In the recorded
    // fights this rule fired before most leader deaths and rarely in fights that were won.
    dyingHpPct: 50,
    dyingSec: 4,
    dyingWindowSec: 6,
  };
  // Only the settings changed with `setGuard` carry over to the next install, so a changed
  // default reaches every tab with the next attach.
  const guardOverrides = guardPrev?.overrides ?? {};
  const guard = {
    config: { ...GUARD_DEFAULTS, ...guardOverrides },
    overrides: guardOverrides,
    phase: "watching", // watching | leaving
    preferred: guardPrev?.preferred ?? null, // limits to return to after a quiet hour, once tightened
    trips: guardPrev?.trips ?? [],
    knownDown: new Set(),
    hp: [], // the leader's HP once a second over the last 10 s, for the dying trigger
    timerId: null,
  };
  const guardApi = {
    /** The guard's settings, its phase and the escapes of the last hour. */
    guardStatus: () => ({ config: guard.config, overrides: guard.overrides, phase: guard.phase, trips: guard.trips }),
    /**
     * Change guard settings, e.g. `{ levelGap: 6 }`, `{ retreatZone: "lfaydark" }` or
     * `{ enabled: false }`. `null` restores a setting's default.
     */
    setGuard(partial) {
      for (const [k, v] of Object.entries(partial)) {
        if (v === null) {
          delete guard.overrides[k];
          guard.config[k] = GUARD_DEFAULTS[k];
        } else {
          guard.overrides[k] = v;
          guard.config[k] = v;
        }
      }
      return guard.config;
    },
    /** Make the guard leave once, as if `reason` had fired, to test the escape. No setting changes. */
    testGuard(reason = "test") {
      guard.force = `test: ${reason}`;
      return true;
    },
    /** Leave the fight at hand the way the guard leaves a dangerous one, for `reason`, such as a fight that makes no headway. */
    leaveFight(reason) {
      guard.force = reason;
      return true;
    },
  };
  const guardNote = (text) => events.push({ ses: session, seq: ++seqs.event, t: Date.now(), type: "guard", text: `[guard] ${text}` });
  // Minified export names change with every client release, so search every export by content.
  const allExports = () => Object.values(mods).flatMap((m) => Object.values(m));
  // The combat runtime singleton: the chunk export whose instance has the live combat scene. The
  // activity sampler asks every second, so the export is kept once found.
  let runtimeExport = null;
  const runtime = () => {
    runtimeExport ??= allExports().find((g) => typeof g?.getInstance === "function" && (() => { try { return g.getInstance()?.combatScene; } catch { return false; } })()) ?? null;
    return runtimeExport?.getInstance();
  };

  // ---- Shims --------------------------------------------------------------------------------
  // Compensations for documented client defects (docs/plans/fault-handling.md, "Client defects are
  // shims"). A shim runs only the client's own code, leaves the client's healthy path alone and
  // counts how often it stood in for the client in `shimCounts`, which the snapshot carries.
  // BEGIN SHIMS
  // tools/check-client.mjs evaluates this block on its own and looks in a release's minified source
  // for each shim's `anchor`, the client code the shim relies on, and its `defect`, the code that has
  // the defect. A release without the anchor breaks the shim. One without the defect may have fixed
  // it, and the shim goes once its count stays at zero on that release.
  const SHIMS = {
    // After a kill the client asks the scene for an auto-loot preview and collects the loot, with its
    // "You loot" lines, in the preview's callback, which comes after a 1 s delay and a 2 s preview
    // (AUTO_LOOT_DELAY_MS, AUTO_LOOT_PREVIEW_MS). A zone load that failed and was tried again leaves
    // the preview with a disposed scene, which returns without calling back (docs/client-internals.md,
    // Loot messages). The shim calls back at `ms` when the client has not, which AutoLevel's 5 s
    // pause after a kill hides, and counts the previews the client still had not answered at `dropMs`.
    lootPreview: {
      ms: 3500,
      dropMs: 15000,
      anchor: /\.combatScene\.previewAutoLootNearCorpse\(\w+,\(\)=>\{this\.collectAutoLoot\(/,
      defect: /previewAutoLootNearCorpse\(\w+,\w+\)\{if\(!this\.disposed\)\{/,
    },
  };
  // END SHIMS
  const shimCounts = window.iq?.shimCounts ?? {};
  for (const k of Object.keys(SHIMS)) shimCounts[k] ??= 0;
  // This install's mark on what it wrapped, so a newer install wraps it again.
  const INSTALL = Symbol("bridge install");
  // The wrapped runtime is a plain object, and its preview an own property. The first wrapper keeps
  // the client's function there for every later install to wrap. The runtime lasts as long as the
  // page, through zone changes, and the sampler wraps any new one it finds.
  const shimLootPreview = () => {
    const inner = runtime()?.combatScene?.runtime;
    if (typeof inner?.previewAutoLootNearCorpse !== "function" || inner.__iqShim === INSTALL) return;
    const preview = (inner.__iqLootPreview ??= inner.previewAutoLootNearCorpse);
    const { ms, dropMs } = SHIMS.lootPreview;
    inner.previewAutoLootNearCorpse = (loot, done) => {
      let finished = false;
      let answered = false;
      const once = () => {
        if (finished) return;
        finished = true;
        done();
      };
      try {
        preview(loot, () => {
          answered = true;
          once();
        });
      } finally {
        setTimeout(once, ms);
        setTimeout(() => {
          if (!answered) shimCounts.lootPreview++;
        }, dropMs);
      }
    };
    inner.__iqShim = INSTALL;
  };
  const applyShims = () => shimLootPreview();

  // The raid window's command panel `id` ("heal", "debuff", "slow", "mez", ...), opened as a click
  // on its tile opens it. The window can close during a fight while the fight goes on, so its combat
  // view opens first, as the client's own returnFromLoot does after the loot window.
  const raidPanel = async (id) => {
    const wait = (ms) => new Promise((res) => setTimeout(res, ms));
    const r = stores.raid.getState();
    if (!r.isRaidOpen || r.view !== "combat") {
      if (typeof r.returnFromLoot === "function") r.returnFromLoot();
      else stores.raid.setState({ isRaidOpen: true, view: "combat" });
      await wait(300);
    }
    if (stores.raid.getState().commandPanel !== id) stores.raid.getState().toggleCommandPanel(id);
    await wait(400);
    const panel = document.querySelector("[data-raid-action-panel]");
    if (!panel) throw new Error(`the raid window shows no ${id} panel`);
    return panel;
  };
  // The panel groups of each raid effect and the button that keeps it up, where the window has one.
  const RAID_EFFECTS = {
    slow: { panel: "slow", group: "Single-Target Slows", keep: "KEEP SLOWED" },
    mez: { panel: "mez", group: "Single-Target Mez", keep: "KEEP MEZZED" },
    debuff: { panel: "debuff", group: "Resistance Debuffs" },
    snare: { panel: "debuff", group: "Snares" },
  };
  const guardDanger = () => {
    const cfg = guard.config;
    const cb = stores.combat.getState();
    const mobs = Object.values(cb.engagedMobs ?? {}).filter((m) => m.state === "alive");
    if (!mobs.length) return null;
    const p = stores.character.getState().characterProfile;
    const cs = stores.companions.getState();
    const classes = Object.fromEntries((stores.staticData.getState().classes ?? []).map((c) => [c.id, c.name]));
    const members = [{ name: p.name, hp: p.curHp, maxHp: p.maxHp }];
    for (const c of cs.companions ?? []) {
      if (c.companionType !== 0 && c.companionType !== 2) continue;
      members.push({ name: c.name, hp: c.curHp, maxHp: c.maxHp, mana: c.curMana, maxMana: c.maxMana, cls: classes[cs.botCombatDataMap?.[c.id]?.class] });
    }
    const weakest = Math.min(...members.map((m) => m.maxHp || Infinity));
    // A mob fights the party when it targets, chases or hates "player", "character-<id>" or a pet
    // ("pet_<...>"). Ids of the form "npc:<id>" are other NPCs, such as a guard fighting a kobold.
    const atParty = (id) => id != null && !String(id).startsWith("npc:");
    const fighting = (m) => atParty(m.hateTargetId) || atParty(m.currentTargetId) || atParty(m.chaseTargetId);
    const gap = (m) => (p.level <= cfg.lowLevelMax && fighting(m) ? Math.min(cfg.levelGap, cfg.levelGapLow) : cfg.levelGap);
    for (const mob of cfg.fightingOnly ? mobs.filter(fighting) : mobs) {
      if (mob.level >= p.level + gap(mob)) return { reason: `level: ${mob.name} L${mob.level} against leader L${p.level}`, mob };
      const maxHit = Number((cb.currentZoneNPCs ?? []).find((n) => n.id === mob.npcId)?.maxdmg) || 0;
      if (p.level >= (cfg.hitFromLevel ?? 0) && maxHit * cfg.hitsToKill >= weakest) return { reason: `hit: ${mob.name} hits up to ${maxHit}, ${cfg.hitsToKill} hits kill a ${weakest} HP member`, mob };
    }
    const back = guard.hp.find((s) => s.t >= Date.now() - cfg.dyingWindowSec * 1000);
    if (back && p.maxHp && p.curHp > 0 && p.curHp * 100 <= p.maxHp * cfg.dyingHpPct) {
      const perSec = (back.hp - p.curHp) / Math.max(1, (Date.now() - back.t) / 1000);
      if (perSec > 0 && p.curHp / perSec <= cfg.dyingSec) {
        const mob = mobs.find((m) => m.currentTargetId === "player" || m.hateTargetId === "player") ?? mobs[0];
        return { reason: `dying: leader at ${p.curHp}/${p.maxHp} HP, losing ${Math.round(perSec)} HP/s`, mob };
      }
    }
    for (const m of members) {
      if (m.hp > 0) guard.knownDown.delete(m.name);
      else if (!guard.knownDown.has(m.name)) {
        guard.knownDown.add(m.name);
        return { reason: `down: ${m.name} died`, mob: mobs[0] };
      }
    }
    const hurt = members.some((m) => m.maxHp && (m.hp / m.maxHp) * 100 < cfg.healerHpPct && m.hp > 0);
    const dry = members.find((m) => m.cls === "Cleric" && m.maxMana && (m.mana / m.maxMana) * 100 < cfg.healerManaPct);
    if (hurt && dry) return { reason: `healer: ${dry.name} has ${dry.mana}/${dry.maxMana} mana`, mob: mobs[0] };
    return null;
  };
  // The game's limit setters overwrite each other (see docs/client-internals.md), so the cap goes
  // last: it sets the highest con itself, and the pair stays consistent.
  const applyLimits = (cb, l) => {
    cb.setMaxCon(l.maxCon);
    cb.setMinCon(l.minCon);
    cb.setMaxLevelDiff(l.maxLevelDiff);
  };
  /**
   * Change zone with the request the Travel window sends, and wait until the new zone has loaded.
   * `shortName` null re-enters the current zone at its safe spot, which drops every engaged mob.
   * Stop AutoLevel first. Gives up waiting for the load after 60 s.
   */
  const changeZone = async (shortName) => {
    const cb = stores.combat.getState();
    const zones = stores.staticData.getState().zones;
    const dest = shortName ? zones.find((z) => z.shortName === shortName) : zones.find((z) => z.zoneidnumber === cb.currentZone);
    const change = functions.zoneChange;
    if (!dest || !change) throw new Error(`zone change function or zone ${shortName ?? cb.currentZone} not found`);
    await change(dest);
    const t0 = Date.now();
    while (stores.combat.getState().isZoneLoading && Date.now() - t0 < 60000) await new Promise((r) => setTimeout(r, 500));
    await new Promise((r) => setTimeout(r, 2000));
    return dest.longName;
  };
  const guardLeave = async (reason, mob) => {
    const cb = stores.combat.getState();
    const cfg = guard.config;
    const leader = stores.character.getState().characterProfile.level;
    guard.trips = guard.trips.filter((t) => t.t > Date.now() - 3600000);
    let limits = { minCon: cb.minCon, maxCon: cb.maxCon, maxLevelDiff: cb.maxLevelDiff };
    // Re-entering puts the party at the zone's safe spot. When a mob camps there, the party is in
    // the same fight seconds later and re-entry repeats every six seconds, so a second escape
    // within `loopSec` leaves for the best other zone of the rotation, which lists the best first.
    const last = guard.trips.at(-1);
    const looping = last && last.zone === cb.currentZone && Date.now() - last.t < cfg.loopSec * 1000;
    const here = stores.staticData.getState().zones.find((z) => z.zoneidnumber === cb.currentZone)?.shortName;
    const others = (window.iqBot?.config?.rotation ?? []).filter((z) => z !== here);
    const elsewhere = others[0] ?? null;
    const target = cfg.retreatZone ?? (looping ? elsewhere : null);
    // A mob inside AutoLevel's own level range means our pulls are too hard, and a lower cap
    // helps. A wanderer far above the cap joins whatever we pull, and lower limits would not keep
    // it away, so escaping is all the guard does about those. Whether the zone still pays is for
    // the measured XP per hour to decide (`analyze.mjs` counts escapes and their cost), not the
    // guard. Absolute "safe" limits do not work across levels: they can leave nothing to fight.
    const ownPull = mob && mob.level <= leader + limits.maxLevelDiff;
    if (ownPull && guard.trips.length >= cfg.escalateAfter && limits.maxLevelDiff > cfg.minLevelDiff) {
      guard.preferred ??= { ...limits };
      limits = { ...limits, maxLevelDiff: limits.maxLevelDiff - 1 };
      guardNote(`${guard.trips.length} escapes in the last hour, lowering the AutoLevel cap to ${limits.maxLevelDiff}`);
    }
    guard.phase = "leaving";
    guard.trips.push({ t: Date.now(), reason, zone: cb.currentZone });
    guardNote(`leaving: ${reason}${target ? ` (to ${target}${looping && !cfg.retreatZone ? ", the last escape here was moments ago" : ""})` : ""}`);
    // AutoLevel picks the nearest target, so after re-entering it would pull the same camp and
    // the same dangerous mob would join again, every few seconds. The client skips spawns it has
    // deferred (its own use is spawns it cannot reach), and spawn ids are spawn points, so they
    // survive the zone change. Defer every mob of this fight.
    const rt = runtime();
    const skip = [
      ...new Set(
        [
          ...Object.values(cb.engagedMobs ?? {}).map((m) => m.spawnInstanceId),
          cb.activeCombatTargetSpawnInstanceId,
          cb.targetNPC?.spawnInstanceId,
          rt?.combatApproach?.attempt?.spawnInstanceId,
          rt?.automatedCombatFocusSpawnInstanceId,
        ].filter((id) => Number.isInteger(id) && id > 0),
      ),
    ];
    if (rt?.deferAutoLevelSpawn && skip.length && cfg.avoidMin > 0) {
      for (const id of skip) rt.deferAutoLevelSpawn(id, cfg.avoidMin * 60000);
      guardNote(`AutoLevel skips ${skip.length} mob(s) of that fight for ${cfg.avoidMin} min`);
    }
    // The escape is one of the bot's holds, so the bot starts AutoLevel again once it ends.
    cb.setIsRunning(false);
    try {
      await changeZone(target ?? null);
    } catch (e) {
      guardNote(`zone change failed: ${e.message}`);
    }
    applyLimits(stores.combat.getState(), limits);
    guardNote("escape done");
    guard.phase = "watching";
  };
  guard.timerId = setInterval(() => {
    const cbNow = stores.combat.getState();
    // Raid bosses stand far above the leader by design, and the raid controls command each fight.
    if (!guard.config.enabled || guard.phase !== "watching" || cbNow.isZoneLoading || stores.raid?.getState?.().raidModeActive) return;
    guard.hp.push({ t: Date.now(), hp: stores.character.getState().characterProfile?.curHp ?? 0 });
    while (guard.hp[0].t < Date.now() - 10000) guard.hp.shift();
    // `testGuard` queues a one-shot trigger, so a test never leaves a setting changed behind it.
    const danger = guard.force ? { reason: guard.force } : guardDanger();
    guard.force = null;
    if (danger) {
      guardLeave(danger.reason, danger.mob);
      return;
    }
    // A quiet hour after the limits were tightened: go back to the limits that were in use before.
    guard.trips = guard.trips.filter((t) => t.t > Date.now() - 3600000);
    if (guard.preferred && guard.trips.length === 0 && !Object.keys(cbNow.engagedMobs ?? {}).length) {
      applyLimits(cbNow, guard.preferred);
      guardNote(`no escapes for an hour, AutoLevel back to con ${guard.preferred.minCon}..${guard.preferred.maxCon}, cap ${guard.preferred.maxLevelDiff}`);
      guard.preferred = null;
    }
  }, 1000);

  // ---- Quest NPCs and items -----------------------------------------------------------------
  // Checked actions on the game's own windows: walk to a quest NPC with the Path To list and open
  // its dialogue, trade items to it with Give Items, pull an item from another account character
  // with Inventory Search, and sell what the cursor holds. They can take minutes, so scripts start
  // them as jobs (below), and the bot's tasks call them directly.
  let disposed = false;
  const pause = (ms) => new Promise((r, reject) => setTimeout(() => (disposed ? reject(new Error("the bridge was reinstalled")) : r()), ms));
  const looseName = (s) => String(s ?? "").replace(/[_`']/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
  const itemName = (row) => row.itemDetails?.Name ?? row.itemDetails?.name;
  const inBags = (row) => row.bag > 0 || (row.bag === 0 && row.slot >= 22 && row.slot <= 29);

  // ---- Queries ------------------------------------------------------------------------------
  // The server's read-only requests, the only ones that are safe to ask again. A slow server times
  // one out now and then, so `query` asks up to three times with a growing pause
  // (docs/plans/fault-handling.md, "One query for read-only requests"). A request that changes the
  // game keeps its caller's effect check instead, because only the caller knows whether it took
  // effect. Each entry names the reply's opcode, how long one answer may take and, for a request
  // that can also act, which payloads only read.
  const READS = {
    1062: { reply: 1063, ms: 9000 }, // the zone's spawns, as the client asks on entry and for Spawn Camp
    1222: { reply: 1223, ms: 10000, reads: (p) => !p.bossKey }, // the daily raid bosses: with a bossKey it summons one
    1225: { reply: 1225, ms: 10000, reads: (p) => p.action === "read" }, // a tradeskill bank's contents
    1237: { reply: 1238, ms: 10000, reads: (p) => p.action === "get" }, // the Alternate Advancement state
    1241: { reply: 1241, ms: 8000, reads: (p) => p.action === "search" }, // Inventory Search over the account
  };
  const query = async (op, payload) => {
    const read = READS[op];
    if (!read || (read.reads && !read.reads(payload))) throw new Error(`opcode ${op} with this payload is not a read-only request`);
    for (let k = 0; ; k++) {
      try {
        return await socket.sendCorrelatedJsonRequest(op, read.reply, payload, read.ms);
      } catch (e) {
        if (k >= 2) throw e;
        await pause(2000 * (k + 1));
      }
    }
  };
  /** Copies of `name` in the active character's bags and general slots. */
  const carried = (name) => (stores.character.getState().characterProfile?.inventory ?? []).filter((x) => inBags(x) && itemName(x) === name).reduce((s, x) => s + (x.quantity || 1), 0);
  const buttonByText = (re, root = document) => [...root.querySelectorAll("button")].find((b) => re.test((b.textContent ?? "").trim())) ?? null;
  const giveItemsReady = () => {
    const b = buttonByText(/^Give Items$/i);
    return b && !b.disabled ? b : null;
  };
  const dialogueLoading = () => [...document.querySelectorAll(".dialogue-entry")].some((el) => /^Loading$/i.test(el.textContent.trim()));
  const dialogueOpen = () => !dialogueLoading() && (document.querySelectorAll('[data-testid="quest-npc-dialogue"], [data-testid="quest-dialogue-option"]').length > 0 || Boolean(giveItemsReady()));
  // Several NPCs can share a name and a spawn point (West Freeport's two prisoners), and only the
  // one standing there can talk, so the spawned one comes first.
  const spawnOf = (name) => {
    const all = (zoneSpawns?.spawns ?? []).filter((x) => looseName(x.name).includes(looseName(name)));
    return all.find((x) => x.state === "alive") ?? all[0] ?? null;
  };
  // The scene's world-interaction port, which the client hands to its UI through a React context,
  // read from the provider's props in the React tree. It walks the party (`navigateToGroundPositionEQ`)
  // and calls couriers (`summonCourier`).
  const worldPort = () => {
    for (const el of document.querySelectorAll("body *")) {
      const key = Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
      for (let f = key ? el[key] : null; f; f = f.return) {
        const v = f.memoizedProps?.value;
        if (v && typeof v.summonCourier === "function") return v;
      }
    }
    throw new Error("world interaction port not found");
  };
  // The client's zone sync state (`current` with `stateSessionId` and `zoneRevision`), which its own
  // spawn requests send along.
  let zoneSync;
  const findZoneSync = () => {
    if (zoneSync === undefined) zoneSync = allExports().find((v) => { try { return v && typeof v === "object" && v.current && "zoneRevision" in v.current; } catch { return false; } }) ?? null;
    return zoneSync;
  };
  /**
   * Ask the server for the zone's spawns now (GetZoneSpawnsRequest, read-only, the request the
   * client sends on zone entry and for Spawn Camp) and keep them as the zone's spawn list, because
   * the list otherwise holds only what stood there at entry. Resolves with the number of spawns.
   */
  const refreshSpawns = async () => {
    const e = findZoneSync()?.current;
    if (!e) throw new Error("the client's zone sync state was not found");
    const cb = stores.combat.getState();
    const zone = stores.staticData.getState().zones.find((z) => z.zoneidnumber === cb.currentZone)?.shortName;
    const r = await query(1062, { zoneName: zone, stateSessionId: e.stateSessionId, zoneRevision: e.zoneRevision, sourceZoneId: e.zoneId, sourceInstanceId: e.zoneInstance, questMovementVersion: 7 });
    if (!r?.success) throw new Error(r?.error ?? "no zone spawns");
    zoneSpawns = { t: Date.now(), spawns: r.spawns ?? [] };
    return zoneSpawns.spawns.length;
  };
  const pathToRow = (name) => [...document.querySelectorAll(".merchant-name")].map((el) => el.parentElement).find((p) => p && /QUEST NPC/i.test(p.textContent ?? "") && looseName(p.querySelector(".merchant-name")?.textContent).includes(looseName(name)));
  /**
   * The Path To list row `find()` returns, or null. Right after a zone change the list can still show
   * the old zone, so it is opened afresh once, and a zone whose NPC data failed to load has an empty
   * list until the client fetches it again (`updateCurrentZoneNPCs`), which the second attempt asks for.
   */
  const pathToFind = async (find) => {
    const cb = () => stores.combat.getState();
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt) {
        if (cb().isMerchantListOpen) cb().toggleMerchantList();
        if (!(cb().currentZoneNPCs ?? []).length) await cb().updateCurrentZoneNPCs?.().catch(() => {});
        await pause(500);
      }
      if (!cb().isMerchantListOpen) cb().toggleMerchantList();
      for (let k = 0; k < 40; k++) {
        const row = find();
        if (row) return row;
        await pause(300);
      }
    }
    return null;
  };
  /**
   * Walk towards quest NPC `name`. The client only opens the dialogue of an NPC loaded in the scene
   * near the party, so a spawned NPC is walked to by its spawn position with the client's own ground
   * navigation, which also finds ways into places such as a jail cell. Without a spawn record the
   * Path To row walks there.
   */
  const walkTowards = async (name) => {
    const spawn = spawnOf(name);
    if (spawn?.state === "alive" && Number.isFinite(spawn.x)) {
      worldPort().navigateToGroundPositionEQ({ x: spawn.x, y: spawn.y, z: spawn.z ?? 0 }, () => {}, () => {});
      return;
    }
    const row = await pathToFind(() => pathToRow(name));
    if (!row) throw new Error(`quest NPC "${name}" is not in the Path To list`);
    row.click();
  };
  /**
   * Walk the party to `pos` (`{ x, y, z }`, such as a spawn record) with the client's own ground
   * navigation, and resolve once it stands within `radius` units. Rejects when it stays still for
   * `stillMs`, such as at a blocked path.
   */
  const walkTo = async (pos, { radius = 40, stillMs = 20000 } = {}) => {
    worldPort().navigateToGroundPositionEQ({ x: pos.x, y: pos.y, z: pos.z ?? 0 }, () => {}, () => {});
    let was = lastPos;
    let stillSince = Date.now();
    for (;;) {
      await pause(1000);
      if (lastPos && Math.hypot(lastPos.x - pos.x, lastPos.y - pos.y) <= radius) return true;
      if (was && lastPos && Math.hypot(lastPos.x - was.x, lastPos.y - was.y) > 2) stillSince = Date.now();
      was = lastPos;
      if (Date.now() - stillSince > stillMs) throw new Error(`the party stopped ${lastPos ? Math.round(Math.hypot(lastPos.x - pos.x, lastPos.y - pos.y)) : "?"} units short of ${Math.round(pos.x)}, ${Math.round(pos.y)}`);
    }
  };
  /**
   * Walk to quest NPC `name` in this zone and open its dialogue, which arriving does for most
   * quest NPCs. A walk cut short by a fight or a blocked path is repeated, and when the party
   * stands near the NPC without a dialogue (Smith Tv`ysa in South Ro) the client's hail opens it.
   * `timeoutMs` counts only the time the party does not move, because a walk across a large zone
   * (Tenal Redblade lies 7,000 units from the East Karana entry) takes minutes. Then each of
   * `keywords` is clicked in turn. Resolves with the NPC's lines, its options and whether Give
   * Items is available.
   */
  const talkToNpc = async (name, keywords = [], { timeoutMs = 120000 } = {}) => {
    await refreshSpawns().catch(() => {});
    await walkTowards(name);
    let still = 0;
    let walks = 1;
    let hailedAt = 0;
    let was = null;
    for (let end = Date.now() + timeoutMs; !dialogueOpen(); ) {
      if (Date.now() > end) {
        const spawn = spawnOf(name);
        const distance = spawn && lastPos ? Math.round(Math.hypot(lastPos.x - spawn.x, lastPos.y - spawn.y)) : null;
        const at = lastPos ? `${Math.round(lastPos.x)}, ${Math.round(lastPos.y)}, ${Math.round(lastPos.z ?? 0)}` : "unknown";
        throw new Error(`the dialogue of ${name} did not open: ${spawn ? `${distance ?? "?"} units from its spawn at ${Math.round(spawn.x)}, ${Math.round(spawn.y)}, ${Math.round(spawn.z ?? 0)}` : "not in the spawn list"}, party at ${at} after ${walks} walk(s)${hailedAt ? ", hailed" : ", never hailed"}`);
      }
      await pause(1000);
      // A run against an obstacle keeps the run state, so a party that has not moved counts as still.
      const moved = was && lastPos ? Math.hypot(lastPos.x - was.x, lastPos.y - was.y) > 2 : true;
      was = lastPos ? { x: lastPos.x, y: lastPos.y } : null;
      still = lastPos?.st === "run" && moved ? 0 : still + 1;
      if (!still) end = Date.now() + timeoutMs;
      // A hail that opened nothing is repeated after 15 seconds.
      if (still < 6 || Date.now() - hailedAt < 15000 || dialogueLoading()) continue;
      const spawn = spawnOf(name);
      const distance = spawn && lastPos ? Math.hypot(lastPos.x - spawn.x, lastPos.y - spawn.y) : null;
      // A trade from afar is refused, so a stop short of the NPC walks again before hailing.
      if (distance != null && distance > 40 && walks < 4) {
        walks++;
        still = 0;
        await walkTowards(name);
        continue;
      }
      hailedAt = Date.now();
      // The spawned NPC is the one that answers. The zone's NPC list can lag a zone change and
      // lists every NPC of the name, also those not standing in the zone.
      const listed = (stores.combat.getState().currentZoneNPCs ?? []).find((n) => looseName(n.name).includes(looseName(name)));
      const npc = spawn ? { id: spawn.npcId ?? spawn.id, name: spawn.name } : listed && { id: listed.id, name: listed.name };
      if (!npc) throw new Error(`${name} is not in this zone`);
      await clientFn("hail")(npc.id, String(npc.name).replace(/_/g, " "));
    }
    for (const kw of keywords) {
      const opt = [...document.querySelectorAll('[data-testid="quest-dialogue-option"]')].find((b) => looseName(b.textContent).includes(looseName(kw)));
      if (!opt) throw new Error(`dialogue option "${kw}" not found on ${name}`);
      opt.click();
      await pause(300);
      for (let k = 0; k < 40 && !dialogueOpen(); k++) await pause(400);
    }
    return {
      npcName: name,
      dialogues: [...document.querySelectorAll('[data-testid="quest-npc-dialogue"]')].map((el) => el.textContent.trim()),
      options: [...document.querySelectorAll('[data-testid="quest-dialogue-option"]')].map((el) => el.textContent.trim()),
      canGive: Boolean(giveItemsReady()),
    };
  };
  /**
   * Trade up to four carried items (`items`, one slot each) to the NPC whose dialogue is open,
   * with its Give Items window. Resolves with the NPC's last lines and the chat lines the trade
   * brought. `closeNote: false` leaves the dialogue open for the next trade.
   */
  const giveToNpc = async (items, { closeNote = true } = {}) => {
    if (!items.length || items.length > 4) throw new Error("a trade takes 1 to 4 items");
    const since = seqs.event;
    const open = giveItemsReady();
    if (!open) throw new Error("Give Items is not available");
    open.click();
    let win = null;
    for (let k = 0; k < 20 && !(win = document.querySelector('[data-testid="quest-give-window"]')); k++) await pause(200);
    if (!win) throw new Error("the Give Items window did not open");
    const slots = [...win.querySelectorAll('[data-testid^="quest-give-slot-"]')].map((el) => Number(el.getAttribute("data-testid").replace("quest-give-slot-", "")));
    const ch = () => stores.character.getState();
    // Each trade slot holds one item, as the quest scripts count them (Tykar Renlin takes four Drom's
    // Champagnes in four slots), so a stack gives one unit through the cursor and keeps the rest.
    const cursorRow = () => (ch().characterProfile?.inventory ?? []).find((x) => x.bag === 0 && x.slot === 30);
    for (let k = 0; k < items.length; k++) {
      const found = (ch().characterProfile?.inventory ?? []).find((x) => inBags(x) && itemName(x) === items[k]);
      if (!found) throw new Error(`no ${items[k]} in the bags`);
      let from = { bag: found.bag, slot: found.slot };
      if ((found.quantity ?? 1) > 1) {
        ch().splitItemToCursor(from, 1);
        for (let j = 0; j < 20 && !cursorRow(); j++) await pause(200);
        if (!cursorRow()) throw new Error(`could not take one ${items[k]} from its stack`);
        await pause(400);
        from = { bag: 0, slot: 30 };
      }
      ch().moveItemToSlot(from, { bag: 0, slot: slots[k] });
      await pause(800);
    }
    const give = buttonByText(/^Give$/i, win);
    if (!give || give.disabled) throw new Error("the Give button is disabled");
    give.click();
    for (let k = 0; k < 30 && document.querySelector('[data-testid="quest-give-window"]'); k++) await pause(300);
    await pause(600);
    const dialogues = [...document.querySelectorAll('[data-testid="quest-npc-dialogue"]')].map((el) => el.textContent.trim());
    if (closeNote && stores.combat.getState().isNoteOpen) stores.combat.getState().toggleNote();
    // The server refuses a trade whose items do not match its view of the bags, as after a pull a
    // moment before, and refreshes the inventory, so the caller can trade again.
    if (events.some((e) => e.seq > since && /^The NPC does not want these items/.test(e.text))) throw new Error("the NPC did not want these items");
    return { dialogues: dialogues.slice(-2), lines: events.filter((e) => e.seq > since && /experience|loot|receive|faction|quest|level/i.test(e.text)).map((e) => e.text) };
  };
  /** Sell what the cursor holds with the client's own sale. Resolves with its reply, or null for an empty cursor. */
  const sellCursor = async () => {
    const held = (stores.character.getState().characterProfile?.inventory ?? []).some((x) => x.bag === 0 && x.slot === 30);
    return held ? ((await clientFn("sell")(0, 30))?.message ?? "sold") : null;
  };
  /**
   * After a trade, whatever the NPC put on the cursor goes into the bags, because a held cursor
   * blocks the next trade: a quest reward such as Power of the Elements, or an item of the trade
   * that came back. The bot's bag upkeep decides later what is surplus. An item the bags cannot
   * take, such as the Concordance of Research container Smith Tv`ysa gives with every lightstone
   * trade when no top-level slot is free, is sold if the bot's sale rules allow it (tradable, with
   * a merchant price, not in `keepItemIds` or the quest items). Anything else throws, so a reward
   * is never sold or dropped.
   */
  const clearCursorAfterTrade = async () => {
    const held = () => (stores.character.getState().characterProfile?.inventory ?? []).find((x) => x.bag === 0 && x.slot === 30);
    const row = held();
    if (!row) return null;
    await clientFn("autoPlace")();
    for (let k = 0; k < 10 && held(); k++) await pause(200);
    if (!held()) return itemName(row);
    const d = row.itemDetails ?? {};
    const kept = [...(window.iqBot?.config?.keepItemIds ?? []), ...(window.iq?.questItems ?? [])];
    if (d.nodrop !== 0 && d.norent !== 0 && d.price > 0 && !kept.includes(row.itemid)) {
      await clientFn("sell")(0, 30);
      return `sold ${itemName(row)}`;
    }
    throw new Error(`no bag room for ${itemName(row)} from the trade`);
  };
  /**
   * Hand carried items to quest NPC `name`, up to `counts[item]` copies of each, for repeatable
   * single-item quests. Each trade holds one copy of every item still due, because the NPC's script
   * pays each of them in the same trade, while two copies of one item pay once (Smith Tv`ysa in
   * South Ro gave 411,600 XP for a Greater Lightstone and a Lightstone together). Only the active
   * character gets the reward, and the chat does not report it, so the XP is read from the
   * character's XP counter. Resolves with the trades, the items handed in and the XP gained.
   */
  const handInEach = async (name, counts) => {
    const xpNow = () => stores.character.getState().characterProfile?.experienceProgress?.current ?? 0;
    const xp0 = xpNow();
    const due = { ...counts };
    let trades = 0;
    let items = 0;
    await clearCursorAfterTrade(); // an earlier trade's leftover would block this one
    await talkToNpc(name);
    for (;;) {
      const have = Object.fromEntries(Object.keys(due).map((n) => [n, carried(n)]));
      const names = Object.keys(due).filter((n) => due[n] > 0 && have[n] > 0).slice(0, 4);
      if (!names.length) break;
      const trade = async () => {
        if (!giveItemsReady()) await talkToNpc(name); // the dialogue closed between trades
        await giveToNpc(names, { closeNote: false });
        await clearCursorAfterTrade();
        await pause(500);
        return names.filter((n) => carried(n) < have[n]);
      };
      let got = await trade();
      // A trade from too far away comes back: walk up again and give once more.
      if (!got.length) {
        await talkToNpc(name);
        got = await trade();
      }
      if (!got.length) throw new Error(`the trade of ${names.join(" and ")} to ${name} was not taken`);
      for (const n of got) due[n]--;
      trades++;
      items += got.length;
    }
    // The counter can trail the last trade by a moment.
    for (let k = 0; k < 6 && items && xpNow() === xp0; k++) await pause(500);
    await closeWindows();
    return { trades, items, xp: xpNow() - xp0 };
  };
  /**
   * Pull one carried or banked `item` of another account character (`from`, or the first one the
   * window lists that is not in `avoid`) to the active character with Inventory Search's Transfer
   * button. Needs a free bag slot. Resolves with the window's reply, the giver and whether the
   * item arrived.
   */
  const pullItem = async (item, { from = null, avoid = [], timeoutMs = 20000 } = {}) => {
    const cb = () => stores.combat.getState();
    cb().openInventorySearch();
    try {
      let panel = null;
      for (let k = 0; k < 25 && !(panel = document.querySelector('[data-testid="inventory-search-panel"]')); k++) await pause(200);
      if (!panel) throw new Error("Inventory Search did not open");
      const input = panel.querySelector("input");
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, item);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      const me = stores.character.getState().characterProfile?.name;
      const prefix = `Transfer ${item} from `;
      const usable = (b) => {
        const l = b.getAttribute("aria-label") ?? "";
        return !b.disabled && l.startsWith(prefix) && (from ? l === prefix + from : l !== prefix + me && !avoid.some((n) => l === prefix + n));
      };
      const end = Date.now() + timeoutMs;
      let btn = null;
      while (Date.now() < end && !(btn = [...panel.querySelectorAll("button")].find(usable))) await pause(300);
      if (!btn) throw new Error(`no transferable ${item}${from ? ` on ${from}` : ""}`);
      const giver = btn.getAttribute("aria-label").slice(prefix.length);
      const before = carried(item);
      btn.click();
      // The window first shows "Transferring item…", then the result.
      let reply = null;
      while (Date.now() < end && (!reply || /…$|^Transferring/.test(reply) || (!panel.querySelector('[role="alert"]') && carried(item) === before))) {
        await pause(300);
        reply = panel.querySelector('[role="status"]')?.textContent || panel.querySelector('[role="alert"]')?.textContent || null;
      }
      return { reply, from: giver, got: carried(item) > before };
    } finally {
      cb().closeInventorySearch();
    }
  };
  const cursorItem = () => {
    const c = (stores.character.getState().characterProfile?.inventory ?? []).find((x) => x.bag === 0 && x.slot === 30);
    return c ? itemName(c) : null;
  };
  /**
   * Buy `count` of `item` from `merchant` in the current zone: walk there through the Path To
   * window (the merchant's row), wait for its goods, then press PURCHASE once per item. A purchase
   * lands in a free general or bag slot. Stops early when a purchase adds nothing, such as for
   * want of coin. Resolves with the number bought and the platinum left.
   */
  const buyItem = async (item, merchant, count = 1) => {
    const cb = () => stores.combat.getState();
    const ms = () => stores.merchant.getState();
    // The client selects a merchant and opens its window only once the party stands in range
    // (`openMerchantForEntity`), and the selection with its goods outlives the window. So a merchant
    // left selected by an earlier visit would pass for an arrival while the party still walks: the
    // window is closed and the selection cleared first, and the wait is for the open window.
    if (cb().isMerchantWindowOpen) cb().closeMerchantWindow();
    ms().setSelectedMerchant(null);
    // Every purchase closes the merchant's window at its end, which removes the PURCHASE button
    // while the merchant can stay selected with its goods, so the merchant is selected every time.
    const row = await pathToFind(() => [...document.querySelectorAll(".merchant-name")].find((el) => el.textContent.trim() === merchant && !/QUEST NPC/i.test(el.parentElement?.textContent ?? "")));
    if (!row) throw new Error(`merchant ${merchant} is not in the Path To list`);
    row.parentElement.click();
    let goods = null;
    for (let end = Date.now() + 180000; !goods; await pause(1000)) {
      if (Date.now() > end) throw new Error(`${merchant} did not open`);
      const m = ms();
      if (!cb().isMerchantWindowOpen || m.selectedMerchant?.name !== merchant || m.isLoadingItems || !(m.merchantItems ?? []).length) continue;
      goods = m.merchantItems.find((g) => g.item?.name === item) ?? false;
      if (goods === false) throw new Error(`${merchant} does not sell ${item}`);
    }
    let bought = 0;
    for (; bought < count; bought++) {
      // The PURCHASE button buys what the merchant's window considered when it last rendered. The
      // window considers its first item once its goods load, which replaces a consider made before
      // it (a Long Sword was bought for a Hand Drum), so this one waits for that, and the button is
      // pressed only once the window shows this item and the button is enabled again, since it stays
      // disabled for a moment after a consider while the client is busy.
      for (let k = 0; k < 20 && !ms().consideredItem; k++) await pause(250);
      ms().setConsideredItem({ item: goods.item, price: goods.price, source: "merchant", slot: goods.slot });
      const shown = () => ms().consideredItem?.item?.id === goods.item.id && [...document.querySelectorAll("body *")].some((el) => el.childElementCount === 0 && el.textContent.trim() === item);
      let button = null;
      for (let k = 0; k < 20 && !(shown() && (button = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "PURCHASE" && !b.disabled))); k++) await pause(250);
      if (!button || !shown()) break;
      const before = carried(item);
      button.click();
      for (let k = 0; k < 20 && carried(item) === before; k++) await pause(200);
      if (carried(item) === before) break;
    }
    // The merchant's window stays open after a purchase and keeps an NPC's dialogue from opening.
    await closeWindows();
    return { bought, platinum: stores.character.getState().characterProfile?.platinum ?? null };
  };
  /**
   * Craft tradeskill recipe `recipeId` with the Advanced recipe window's own requests
   * (docs/plans/systems-research.md, section 2), up to `quantity` attempts and until `until`
   * successes: each attempt buys the catalog ingredients the Tradeskill Bank lacks for one set and
   * crafts once (the server accepts no container, 0). Then `output` is withdrawn from the bank into
   * the bags. The catalog answers for one set only, so a batch would run out after the first
   * attempt whenever the bank held exactly one set. Resolves with the attempts' counts and the
   * number withdrawn.
   */
  const craftItem = async (recipeId, { quantity = 1, until = Infinity, skillId, containerItemId = 0, output = null }) => {
    const p = () => stores.character.getState().characterProfile;
    const done = { attempted: 0, successes: 0, failures: 0, skillUp: null, newSkillValue: null };
    while (done.attempted < quantity && done.successes < until) {
      const cat = await socket.sendJsonRequest(1045, 1046, { recipeId });
      if (cat?.purchasable?.length) {
        const b = await socket.sendJsonRequest(1047, 1048, { recipeId, quantity: 1 }, 10000);
        if (!b?.success) throw new Error(`buying the ingredients failed: ${b?.error ?? "no reply"}`);
      }
      const r = await socket.sendCorrelatedJsonRequest(1043, 1044, { characterId: p().id, recipeId, quantity: 1, skillId, containerItemId }, 30000);
      // A failed skill roll answers success false ("All 1 attempts failed."), which is an attempt that
      // used up its components, so the next attempt follows. Anything else is an error, except once an
      // attempt ran: a component the catalog does not sell can run out mid-way, which ends the attempts.
      const rolled = r && !r.success && (r.attempted > 0 || r.failures > 0 || /attempts? failed/i.test(r.error ?? r.message ?? ""));
      if (rolled) {
        done.attempted += r.attempted ?? 1;
        done.failures += r.failures ?? 1;
        continue;
      }
      if (!r?.success) {
        if (done.attempted > 0) break;
        throw new Error(`the craft failed: ${r?.error || r?.message || (r ? JSON.stringify(r).slice(0, 300) : "no reply")}`);
      }
      done.attempted += r.attempted ?? 1;
      done.successes += r.successes ?? 0;
      done.failures += r.failures ?? 0;
      done.skillUp = r.skillUp ?? done.skillUp;
      done.newSkillValue = r.newSkillValue ?? done.newSkillValue;
    }
    let withdrawn = 0;
    if (output != null && done.successes > 0) {
      const bank = await query(1225, { characterId: p().id, kind: "ingredients", action: "read" });
      const w = await socket.sendCorrelatedJsonRequest(1225, 1225, { characterId: p().id, kind: "ingredients", action: "withdrawToCursor", itemId: output, quantity: done.successes, revision: bank?.revision }, 10000);
      if (!w?.success) throw new Error(`withdrawing the result failed: ${w?.error ?? "no reply"}`);
      await pause(700);
      await clientFn("autoPlace")();
      await pause(700);
      withdrawn = w.quantity ?? done.successes;
    }
    return { ...done, withdrawn };
  };
  /**
   * Give a carried `item` to account character `characterId`, in the party or not, equipped when
   * `equip` is true: the item goes onto the cursor with the character store's slot move and the
   * client's held-item transfer sends it. A refused transfer puts the item back. Resolves with
   * the transfer's answer and the chat lines it brought.
   */
  const giveItem = async (item, characterId, { equip = true } = {}) => {
    const ch = () => stores.character.getState();
    // An item left on the cursor, such as by a give that a reinstall cut short, would block this
    // one, so it goes back into the bags first.
    if (cursorItem() && cursorItem() !== item) {
      await clientFn("autoPlace")();
      await pause(900);
      if (cursorItem()) throw new Error(`${cursorItem()} is on the cursor and found no bag slot`);
    }
    const row = (ch().characterProfile?.inventory ?? []).find((x) => inBags(x) && itemName(x) === item);
    if (!row) throw new Error(`no ${item} in the bags`);
    const from = { bag: row.bag, slot: row.slot };
    const since = seqs.event;
    ch().moveItemToSlot(from, { bag: 0, slot: 30 });
    await pause(900);
    if (cursorItem() !== item) throw new Error(`the cursor holds ${cursorItem() ?? "nothing"} instead of ${item}`);
    const ok = await stores.companions.getState().transferHeldItem(characterId, equip);
    await pause(900);
    if (cursorItem()) {
      ch().moveItemToSlot({ bag: 0, slot: 30 }, from);
      await pause(700);
    }
    if (cursorItem()) throw new Error(`${cursorItem()} is still on the cursor`);
    const lines = events.filter((x) => x.seq > since && /equips|transfer|give|cannot|space/i.test(x.text ?? "")).map((x) => x.text);
    return { ok: Boolean(ok), lines };
  };
  /**
   * Equip a carried `item` on the active character in worn slot `slotNum`, since a transfer to
   * oneself is refused. As the client's own equip does, an occupied slot swaps with the item's bag
   * slot, so the worn item lands where the new one was, and an empty slot takes a move. Resolves
   * with `{ ok }`, whether the slot holds the item afterwards.
   */
  const equipOwn = async (item, slotNum) => {
    const ch = () => stores.character.getState();
    const inv = () => ch().characterProfile?.inventory ?? [];
    const row = inv().find((x) => inBags(x) && itemName(x) === item);
    if (!row) throw new Error(`no ${item} in the bags`);
    const from = { bag: row.bag, slot: row.slot };
    const to = { bag: 0, slot: slotNum };
    await (inv().some((x) => x.bag === 0 && x.slot === slotNum) ? ch().swapItems(from, to) : ch().moveItemToSlot(from, to));
    await pause(900);
    if (cursorItem()) throw new Error(`${cursorItem()} is on the cursor`);
    const worn = (ch().characterProfile?.inventory ?? []).find((x) => x.bag === 0 && x.slot === slotNum);
    return { ok: Boolean(worn) && itemName(worn) === item };
  };
  /**
   * Inventory Search (opcode 1241, action "search") for each of `words`, four at a time, merged by
   * owner, item instance and bank. A search matches names anywhere and lists at most 200 rows, so
   * the words are item kinds and name parts. A word whose search `query` could not get is missed
   * instead of failing the whole survey. Resolves with the rows, the words whose search was cut off
   * at 200 and the missed words.
   */
  const searchItems = async (words) => {
    const p = stores.character.getState().characterProfile;
    const seen = new Map();
    const capped = [];
    const missed = [];
    const todo = [...new Set(words)];
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        while (todo.length) {
          const word = todo.shift();
          const r = await query(1241, { characterId: p.id, stateSessionId: p.stateSessionId, action: "search", query: word }).catch(() => null);
          if (!r) {
            missed.push(word);
            continue;
          }
          if (r.more) capped.push(word);
          for (const m of r.matches ?? []) seen.set(`${m.characterId}:${m.itemInstanceId}:${m.bankKind ?? ""}`, m);
        }
      }),
    );
    return { rows: [...seen.values()], capped, missed };
  };
  /** Close windows that hide the right-hand buttons: Done and Close buttons, merchant, Path To, the quest dialogue and the combat macro bar. */
  const closeWindows = async () => {
    // Toggles flip a window, so they run once, before the buttons are clicked.
    const s = stores.combat.getState();
    if (s.isCombatSkillMacrosOpen) s.setCombatSkillMacrosOpen(false);
    if (s.isNoteOpen) s.toggleNote();
    if (s.isMerchantListOpen) s.toggleMerchantList();
    for (let k = 0; k < 4; k++) {
      const open = [...document.querySelectorAll("button")].filter((b) => /^(done|close)$/i.test(b.textContent.trim()));
      if (!open.length) return;
      open.forEach((b) => b.click());
      await pause(600);
    }
  };

  // ---- Jobs ---------------------------------------------------------------------------------
  // One script call into the page may last about 30 s, so a script starts a longer action as a
  // job: `job(name, ...args)` starts one of JOBS and returns its id at once, and `jobs[id]` holds
  // its progress and result. The last 20 jobs are kept.
  const jobs = window.iq?.jobs ?? {};
  const JOBS = { talkToNpc, giveToNpc, handInEach, pullItem, giveItem, buyItem, craftItem, searchItems, closeWindows, sellCursor };
  const job = (name, ...args) => {
    const fn = JOBS[name];
    if (!fn) throw new Error(`no job named ${name}`);
    const id = `${name}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const j = (jobs[id] = { id, name, startedAt: Date.now(), done: false, ok: null, result: null, error: null });
    for (const old of Object.keys(jobs).slice(0, -20)) delete jobs[old];
    fn(...args).then(
      (result) => Object.assign(j, { done: true, ok: true, result }),
      (e) => Object.assign(j, { done: true, ok: false, error: String(e?.message ?? e) }),
    );
    return id;
  };

  const iq = {
    version: 1,
    mods,
    stores,
    socket,
    query,
    command,
    /** Client build id (release time and hash of the declared files), stable for the life of a page. */
    release,
    clientRelease,
    /** File names of the /assets/*.js modules loaded so far. */
    assets,
    /** Parts of the client surface (CLIENT_SURFACE) this client lacks. Empty when the SDK fits. */
    missingApi,
    surface: CLIENT_SURFACE,
    log,
    kills,
    faults,
    shimCounts,
    samples,
    events,
    seqs,
    session,
    /**
     * What the party does now, `{ act, why, since }` (see "Activity" above), or the last label while no
     * character is in the world, unless a load failed there, such as the character select's, which the
     * remedy table answers with Try Again wherever it happens.
     */
    activity: () => (stores.character.getState().characterProfile?.id || stores.loadFailure.getState().message ? readActivity() : activity),
    /** True when the leader and every living companion and pet are at full HP and mana. */
    partyFull,
    /**
     * The game's hour of day, 0 to 24, or null before the server synchronized the clock. The
     * client counts 5 to 20 as day (`main.pretty.js` spell time rules), and at the server's usual
     * rate of 0.01 game hours per real second a game day lasts 40 minutes.
     */
    gameHour: () => (clock?.isSynchronized ? clock.getTimeOfDay() : null),
    /**
     * Seconds of each activity over the last `ms` of samples, keyed `act` or `act/why` for travel
     * and idle, e.g. `{ fight: 300, approach: 120, "idle/crowded": 90 }`.
     */
    activitySeconds(ms = 600000) {
      const out = {};
      const from = Date.now() - ms;
      for (let k = samples.length - 1; k > 0 && samples[k].t >= from; k--) {
        const s = samples[k];
        if (!s.act || s.ses !== samples[k - 1].ses) continue;
        const dt = s.t - samples[k - 1].t;
        if (dt > 3500) continue; // a gap in the recording is not play time
        const key = s.why && (s.act === "idle" || s.act === "travel") ? `${s.act}/${s.why}` : s.act;
        out[key] = (out[key] ?? 0) + dt / 1000;
      }
      for (const key of Object.keys(out)) out[key] = Math.round(out[key]);
      return out;
    },
    guard,
    chores,
    buyMissingSpells,
    setChores(partial) {
      return Object.assign(chores, partial);
    },
    ...guardApi,
    changeZone,
    /** The client function `name` of `surface.FUNCTIONS`, such as `clientFn("sell")(bag, slot)`. */
    clientFn,
    carried,
    talkToNpc,
    /** Stop this install's running jobs, as a newer install of the bridge does. */
    dispose() {
      disposed = true;
    },
    giveToNpc,
    handInEach,
    pullItem,
    giveItem,
    equipOwn,
    buyItem,
    refreshSpawns,
    worldPort,
    walkTo,
    craftItem,
    sellCursor,
    closeWindows,
    job,
    jobs,
    samplerId,
    unsubChat,
    get zoneSpawns() {
      return zoneSpawns;
    },
    /**
     * Raw hunting-ground data for the current zone: every spawn the client received on entry
     * (`GetZoneSpawnsResponse`) plus the zone's NPC definitions for class and merchant flags.
     * Metrics are computed offline by `tools/zones.mjs`, so one visit serves every level.
     */
    zoneSnapshot() {
      const cb = stores.combat.getState();
      const sd = stores.staticData.getState().zones.find((z) => z.zoneidnumber === cb.currentZone);
      return {
        zone: sd?.longName ?? String(cb.currentZone),
        shortName: sd?.shortName,
        safe: sd ? { x: sd.safeX, y: sd.safeY } : null,
        takenAt: zoneSpawns?.t ?? null,
        spawns: (zoneSpawns?.spawns ?? []).map((s) => ({ npcId: s.npcId, name: s.name, level: s.level, x: Math.round(s.x), y: Math.round(s.y), aggro: s.aggroRadius, grid: s.pathgridId })),
        defs: (cb.currentZoneNPCs ?? []).map((n) => ({ id: n.id, cls: n.class, merchant: n.merchantId, quest: n.isquest, body: n.bodytype })),
      };
    },
    /**
     * Set a party tactic (cast, melee, range, heal, cure, healPets, rez, manaRecovery, nuke, dot,
     * debuff, cc, root, fear) for one party member.
     * `who` is the active character (its name or id), a default bot ("cleric", "warrior", "rogue")
     * or the name of an account character in the party. The active character's tactics live in
     * their own store, keyed by character id. Party members are keyed `bot:<playerId>:<bot>` and
     * `character:<characterId>` in the party spells store, and a bare name there is stored but
     * never read. Returns the member's overrides after the change.
     */
    setTactic(who, key, value) {
      const me = stores.character.getState().characterProfile;
      if (String(who).toLowerCase() === String(me.name).toLowerCase() || String(who) === String(me.id)) {
        stores.partyTactics.getState().setTactic(me.id, key, value);
        return { key: String(me.id), overrides: stores.partyTactics.getState().overridesByCharacterId[me.id] };
      }
      const comps = stores.companions.getState().companions ?? [];
      const byName = comps.find((c) => c.characterId && c.name.toLowerCase() === String(who).toLowerCase());
      const k = byName ? `character:${byName.characterId}` : /^\d+$/.test(String(who)) ? `character:${who}` : `bot:${me.id}:${who}`;
      stores.partySpells.getState().setTactic(k, key, value);
      return { key: k, overrides: stores.partySpells.getState().overridesByCompanion[k] };
    },
    /**
     * The roots on the leader, the account companions and their pets, as the readiness wait sees
     * them in the client's effects registry: `[{ id, app, spellId, casterLevel, endsAt }]`, where
     * `app` names one application of the root. Runtime roots count down in 6-second ticks.
     */
    roots() {
      const reg = services.effects;
      const rootState = functions.rootState;
      if (!reg || !rootState) return [];
      const ids = reg.records instanceof Map ? [...reg.records.keys()] : Object.keys(reg.records ?? {});
      const out = [];
      for (const id of ids) {
        if (!/^(character|pet):/.test(id)) continue;
        // A runtime root's `effectId` repeats for the same spell, so it names the application.
        for (const e of reg.getEffects(id)?.active ?? []) if (rootState({ effects: [e] }).isRooted) out.push({ id, app: e.applicationId ?? `${id}|${e.effectId}`, spellId: e.spellId, casterLevel: e.casterLevel ?? 0, endsAt: e.expiresAtMs ?? Date.now() + (e.remainingTicks ?? 0) * 6000 });
      }
      return out;
    },
    /**
     * The raid window's own actions (docs/client-internals.md, "How a raid fight runs" and "Running
     * a raid from a script"). Each checks its effect and throws when the client refused, with the
     * client's reason where it gives one. The bot's raid task decides roster, target, orders and
     * when to stop.
     */
    raid: {
      /**
       * Raid mode, the fight, the roster and the engaged enemies, for a script to follow a raid.
       * `leader` holds what the leader's frame loop moves and swings by: the order, auto attack,
       * casting and whether another navigation runs. `heal` and `nuke` are the standing orders.
       */
      state() {
        const r = stores.raid.getState();
        const c = stores.combat.getState();
        const p = stores.character.getState().characterProfile ?? {};
        const scene = (() => {
          try {
            return runtime()?.combatScene ?? null;
          } catch {
            return null;
          }
        })();
        const near = (() => {
          try {
            return scene?.getAliveCombatTargetList?.() ?? [];
          } catch {
            return [];
          }
        })();
        let navigating = null;
        try {
          navigating = scene?.isAutoNavigating?.() ?? null;
        } catch {
          /* the scene is loading */
        }
        return {
          active: Boolean(r.raidModeActive),
          open: Boolean(r.isRaidOpen),
          view: r.view ?? null,
          combat: Boolean(r.combatActive),
          leaderDead: Boolean(r.leaderDead),
          pending: Boolean(r.lifecyclePending),
          error: r.lifecycleError ?? null,
          leaderDamage: r.leaderDamageDone ?? 0,
          leader: { hp: p.curHp ?? null, maxHp: p.maxHp ?? null, mana: p.mana ?? null, maxMana: p.maxMana ?? null, order: r.playerOrder?.command ?? null, revision: r.playerOrder?.revision ?? null, autoAttack: Boolean(c.isAutoAttackEnabled), casting: Boolean(c.isCasting), navigating, pos: lastPos ? [Math.round(lastPos.x), Math.round(lastPos.y)] : null },
          heal: r.autoHealMode ?? null,
          nuke: r.autoNukeOrder ? { mode: r.autoNukeOrder.mode, preparing: Boolean(r.autoNukeOrder.preparing) } : null,
          roster: (r.roster ?? []).map((m) => ({ id: m.id, characterId: m.source?.characterId ?? null, name: m.displayName ?? null, className: m.className ?? null, role: m.role ?? null, level: m.level, hp: m.hp, maxHp: m.maxHp, mana: m.mana ?? null, maxMana: m.maxMana ?? null, alive: m.alive !== false, command: m.command ?? null, rangeState: m.rangeState ?? null, damage: m.damageDone ?? 0, hate: m.hate ?? 0 })),
          enemies: (r.engagedEnemies ?? []).map((e) => ({ id: e.spawnInstanceId, name: e.name ?? e.npcName ?? null, level: e.level ?? null, hp: e.hp ?? e.curHp ?? null, maxHp: e.maxHp ?? null, fleeing: Boolean(e.fleeing), distance: near.find((a) => a.spawnInstanceId === e.spawnInstanceId)?.distance ?? null })),
          log: (r.eventLog ?? []).slice(-30).map((e) => (typeof e === "string" ? e : (e.text ?? e.message ?? JSON.stringify(e)))),
        };
      },
      /** The account's raid time: the price of an hour in platinum and when the bought time ends. Only reads. */
      async time() {
        const ok = await clientFn("raidTime")("status", false);
        const t = stores.raidTime.getState();
        return { ok, pricePp: (t.priceCopper ?? 0) / 1000, expiresAt: t.expiresAtMs || 0, active: (t.expiresAtMs ?? 0) > Date.now() + (t.clockOffsetMs ?? 0), error: t.error || null };
      },
      /** Buy one hour of raid time, as the Raid Time section's Start Raid button does, if it costs at most `maxPp`. */
      async buyHour(maxPp) {
        const before = await this.time();
        if (!before.pricePp) throw new Error(`no raid price: ${before.error ?? "the status request failed"}`);
        if (before.pricePp > maxPp) throw new Error(`an hour of raid time costs ${before.pricePp}pp, more than ${maxPp}pp`);
        const ok = await clientFn("raidTime")("start", false);
        const after = stores.raidTime.getState();
        if (!ok || !(after.expiresAtMs > before.expiresAt)) throw new Error(`raid time not bought: ${after.error || "no reply"}`);
        return { pricePp: before.pricePp, expiresAt: after.expiresAtMs };
      },
      /**
       * Start Raid in the party panel: release the account characters from the party, open the
       * raid window and turn raid mode on, which needs a leader of level 46 or more and raid time.
       * When raid mode does not start, the window closes again and the party stays released.
       */
      async open() {
        await stores.companions.getState().releaseAccountCharactersForCamp();
        stores.raid.getState().openRaid();
        if (!stores.raid.getState().raidModeActive) {
          stores.raid.getState().closeRaid();
          throw new Error(`raid mode did not start (leader level ${stores.character.getState().characterProfile?.level}, raid time ${stores.raidTime.getState().expiresAtMs > Date.now() ? "bought" : "not bought"})`);
        }
        return this.state();
      },
      /** Add account characters by id, four at a time like Add All. Resolves with the character ids in the roster. */
      async recruit(characterIds) {
        const r = stores.raid.getState();
        await r.addGuildMembers(characterIds, r.leaderLevel ?? stores.character.getState().characterProfile.level);
        return stores.raid.getState().roster.map((m) => m.source?.characterId).filter((id) => id != null);
      },
      /**
       * Run To Target: the leader and every member not already fighting walk to the leader's target
       * (`combat.targetNPC`) without attacking.
       */
      position() {
        const npc = stores.combat.getState().targetNPC;
        if (!npc?.spawnInstanceId) throw new Error("the leader has no target");
        stores.raid.getState().positionAtTarget();
        if (stores.raid.getState().positioningTarget?.spawnInstanceId !== npc.spawnInstanceId) throw new Error(`the raid did not move to ${npc.name}: ${stores.chat.getState().messages.at(-1)?.text ?? "no reason given"}`);
        return this.state();
      },
      /**
       * All Attack: the leader and every member attack the leader's target (`combat.targetNPC`, set
       * by the Enemy Targets action, which only targets in raid mode), an NPC above level 50 or an
       * engaged enemy. Melee members walk to melee range and casters to their spell range, where
       * they wait for orders. The first fight with recruits checks the roster with the server first,
       * so this resolves once the fight has started.
       */
      async attack() {
        const npc = stores.combat.getState().targetNPC;
        if (!npc?.spawnInstanceId) throw new Error("the leader has no target");
        stores.raid.getState().setAllCommand("attacking", npc);
        for (let k = 0; k < 30 && !stores.raid.getState().combatActive; k++) await new Promise((res) => setTimeout(res, 500));
        if (!stores.raid.getState().combatActive) throw new Error(`the raid did not attack ${npc.name}: ${stores.chat.getState().messages.at(-1)?.text ?? "no reason given"}`);
        return this.state();
      },
      /**
       * The Heal & Revive panel's automatic healing: "clr-balanced" and "clr-all-out" heal with
       * Clerics, "all-balanced" and "all-all-out" with every member that has a heal, and null turns
       * it off. Balanced keeps each class's mana reserve. The mode stays set across fights.
       */
      heal(mode) {
        if (mode !== null && !["clr-balanced", "all-balanced", "clr-all-out", "all-all-out"].includes(mode)) throw new Error(`unknown heal mode ${mode}`);
        if (!stores.raid.getState().raidModeActive) throw new Error("raid mode is off");
        // The panel's setRaidAutoHealing sets this field, which the raid engine reads every tick.
        stores.raid.setState({ autoHealMode: mode });
        return this.state();
      },
      /**
       * The Nuke panel's order against the running fight's target: "dps-balanced" and "dps-all-out"
       * nuke with Necromancers, Wizards and Magicians, "all-all-out" with every member that has a
       * nuke, healers included. The client ends the order with the fight.
       */
      nuke(mode) {
        if (!["dps-balanced", "dps-all-out", "all-all-out"].includes(mode)) throw new Error(`unknown nuke mode ${mode}`);
        const r = stores.raid.getState();
        const target = r.focusTarget ?? r.openingTarget;
        if (!r.combatActive || !target?.spawnInstanceId) throw new Error("no running fight to nuke in");
        // The panel's startRaidAutoNuking ends with this order once the fight is prepared, which a
        // running fight is. The raid engine nukes for it while its target is engaged.
        stores.raid.setState({ autoNukeOrder: { id: `${r.raidSessionId}:auto-nuke:iq-${Date.now()}`, mode, target, preparing: false } });
        return this.state();
      },
      /**
       * Heal & Revive for the dead leader, as in the raid window: open the panel, choose its first
       * revive spell a living member can cast, then the leader in the roster. Resolves once the
       * leader stands again.
       */
      async revive() {
        const wait = (ms) => new Promise((res) => setTimeout(res, ms));
        if (!stores.raid.getState().leaderDead) return this.state();
        // The client records the death with the server first and takes no revive until it has.
        for (let k = 0; k < 20 && stores.raid.getState().lifecyclePending; k++) await wait(500);
        await raidPanel("heal");
        const spell = document.querySelector('[aria-label="Revive"] button:not([disabled])');
        if (!spell) throw new Error("no living raid member can revive the leader");
        spell.click();
        await wait(400);
        const leader = document.querySelector('[data-testid="raid-member-player"]');
        if (!leader) throw new Error("the raid roster shows no leader to revive");
        (leader.querySelector("button") ?? leader).click();
        for (let k = 0; k < 30 && stores.raid.getState().leaderDead; k++) await wait(500);
        if (stores.raid.getState().leaderDead) throw new Error(`the leader was not revived: ${stores.chat.getState().messages.at(-1)?.text ?? "no reason given"}`);
        return this.state();
      },
      /**
       * A Slow, Mez, Debuff or Snare order against the running fight's target, as in the raid
       * window: the first spell of the panel's group for `kind` that a living member can cast,
       * kept up for "slow" and "mez" (KEEP SLOWED and KEEP MEZZED recast it when it wears off) and
       * cast once for "debuff" (resist debuffs such as Tash and Malo) and "snare", then the target
       * in the engaged enemies. Resolves with the spell and whether it is kept up.
       */
      async effect(kind) {
        const wait = (ms) => new Promise((res) => setTimeout(res, ms));
        const spec = RAID_EFFECTS[kind];
        if (!spec) throw new Error(`unknown raid effect ${kind}`);
        const r = stores.raid.getState();
        const target = r.focusTarget ?? r.openingTarget;
        if (!r.combatActive || !target?.spawnInstanceId) throw new Error("no running fight for an effect");
        const panel = await raidPanel(spec.panel);
        const group = panel.querySelector(`[aria-label="${spec.group}"]`);
        if (!group) throw new Error(`no raid member has ${spec.group.toLowerCase()}`);
        const buttons = [...group.querySelectorAll("button:not([disabled])")];
        const button = spec.keep ? buttons.find((b) => b.textContent.trim().toUpperCase() === spec.keep) : buttons[0];
        if (!button) throw new Error(`no ${spec.group.toLowerCase()} can be cast now`);
        const spell = (spec.keep ? button.closest("[aria-label]")?.getAttribute("aria-label") : null) ?? button.textContent.trim().replace(/\s+/g, " ").slice(0, 40);
        const before = { kept: (stores.raid.getState().ongoingActions ?? []).length, queued: (stores.raid.getState().pendingActions ?? []).length };
        button.click();
        await wait(300);
        // The spell button starts a target pick, which the target's row in the engaged enemies ends.
        const row = [...document.querySelectorAll('[data-raid-target="true"][aria-label^="Target "]')].find((e) => e.getAttribute("aria-label") === `Target ${target.name}`);
        if (!row) throw new Error(`the raid window does not list ${target.name}`);
        row.click();
        for (let k = 0; k < 10; k++) {
          await wait(300);
          const s = stores.raid.getState();
          if ((s.ongoingActions ?? []).length > before.kept || (s.pendingActions ?? []).length > before.queued) return { kind, spell, kept: Boolean(spec.keep) };
        }
        throw new Error(`the ${kind} order did not start: ${stores.chat.getState().messages.at(-1)?.text ?? "no reason given"}`);
      },
      /** The daily raid bosses of the current zone (`DailyRaidBossesRequest`), or with `bossKey` summon that boss. */
      async bosses(bossKey) {
        const p = stores.character.getState().characterProfile;
        const payload = { characterId: p.id, zoneId: stores.combat.getState().currentZone, ...(bossKey ? { bossKey } : {}) };
        const r = bossKey ? await socket.sendCorrelatedJsonRequest(1222, 1223, payload, 10000) : await query(1222, payload);
        if (!r?.success) throw new Error(r?.error || "the daily boss list did not load");
        return { resetsRemaining: r.resetsRemaining, nextResetAt: r.nextResetAtMs ?? null, spawnInstanceId: r.spawnInstanceId ?? null, bosses: (r.bosses ?? []).map((b) => ({ key: b.key, name: b.name, zone: b.zoneName, status: b.status, availableAt: b.availableAtMs ?? null, expiresAt: b.expiresAtMs ?? null, disabled: b.disabledReason ?? null })) };
      },
      /**
       * End Raid. Out of a fight the raid store ends raid mode in the page, which needs no server
       * request. A running fight, a dead leader or an unfinished end go through the combat
       * service's `abandonRaid()` as the End Raid button does: it stops the fight on the server
       * (`StopCombat`) or releases the dead leader, then ends raid mode.
       */
      async end() {
        const r = stores.raid.getState();
        if (r.raidModeActive && (r.combatActive || r.leaderDead || r.lifecyclePending)) {
          if (!services.combat) throw new Error("client combat service not found");
          if (!(await services.combat.abandonRaid())) throw new Error(`the raid was not abandoned: ${stores.raid.getState().lifecycleError ?? "no reason given"}`);
        } else if (r.raidModeActive) r.endRaid();
        stores.raid.getState().closeRaid();
        if (stores.raid.getState().raidModeActive) throw new Error("raid mode is still on");
        return this.state();
      },
    },
    /** Tag every following sample, so configurations can be compared with `analyze.mjs --label`. */
    setLabel(l) {
      label = String(l);
      return label;
    },
    get label() {
      return label;
    },
    setOpcodeNames(table) {
      for (const [name, op] of Object.entries(table)) opName[op] = name;
    },

    /** Packets after `sinceSeq`, optionally filtered by name regex source. */
    packets(sinceSeq = 0, nameRe = null) {
      const re = nameRe && new RegExp(nameRe);
      return log.entries.filter((e) => e.seq > sinceSeq && (!re || re.test(e.name)));
    },

    /**
     * Inventory rows: bag, slot, item id, name, quantity and where the row is. Bag 0 holds the
     * equipment (slots 0-21), the eight general slots (22-29) and the cursor (30). Bag N is the
     * container in general slot N-1. Slots 3000+ are the quest give window.
     */
    inventory() {
      const p = stores.character.getState().characterProfile;
      const where = (i) => (i.bag > 0 ? "bag" : i.slot <= 21 ? "equipped" : i.slot <= 29 ? "general" : i.slot === 30 ? "cursor" : "other");
      return (p.inventory ?? []).map((i) => ({ bag: i.bag, slot: i.slot, loc: where(i), id: i.itemid, name: i.itemDetails?.Name ?? i.itemDetails?.name, quantity: i.quantity, instanceId: i.itemInstanceId }));
    },

    /**
     * Room for loot: free slots in the bags plus empty general slots, the total, and the name of
     * the item on the cursor, if any. A loose item in a general slot adds no room, a bag on the
     * cursor takes its slots out of the count, and looting and cleanup need a free cursor.
     */
    bagSpace() {
      const inv = stores.character.getState().characterProfile?.inventory ?? [];
      let capacity = 0;
      let free = 0;
      for (let slot = 22; slot <= 29; slot++) {
        const r = inv.find((i) => i.bag === 0 && i.slot === slot);
        const size = r ? r.itemDetails?.bagslots || 0 : 1;
        capacity += size;
        free += r ? size - inv.filter((i) => i.bag === slot + 1).length : 1;
      }
      const cursor = inv.find((i) => i.bag === 0 && i.slot === 30);
      return { free, capacity, cursor: cursor ? (cursor.itemDetails?.Name ?? cursor.itemDetails?.name ?? cursor.itemid) : null };
    },

    /** Last chat lines the client shows. */
    chatTail(n = 20) {
      return stores.chat.getState().messages.slice(-n).map((m) => m.text);
    },

    /**
     * Scribe every spell scroll in the inventory, then memorize the named spells into gems 0..n-1.
     * The client only allows this while sitting with the spellbook open, and sitting does not hold
     * while a fight is still ending. Call it out of combat; it waits at most 20 s for a fight to end
     * so it stays inside one page call. A spell already in another gem is skipped by the client.
     */
    async scribeAndMemorize(memorize = []) {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      for (let i = 0; i < 20 && stores.skills.getState().inCombat; i++) await wait(1000);
      if (stores.skills.getState().inCombat) throw new Error("still in combat after 20 s; stop AutoLevel first");
      for (let i = 0; i < 5 && !stores.combat.getState().isPlayerSitting; i++) {
        stores.combat.getState().setPlayerSitting(true);
        await wait(600);
      }
      if (!stores.combat.getState().isSpellbookOpen) stores.combat.getState().toggleSpellbook();
      await wait(800);
      const p = stores.character.getState().characterProfile;
      const scribed = [];
      for (const it of p.inventory.filter((i) => (i.itemDetails?.Name ?? "").startsWith("Spell:"))) {
        const ok = await stores.spellbook.getState().scribeSpell(it.itemDetails.scrolleffect, { characterId: p.id, itemBag: it.bag, itemSlot: it.slot, itemInstanceId: it.itemInstanceId });
        scribed.push({ name: it.itemDetails.Name, ok });
      }
      const book = stores.spellbook.getState().scribedSpells;
      const memorized = [];
      for (const [gem, name] of memorize.entries()) {
        const sp = book.find((x) => x.spell?.name === name);
        memorized.push({ name, ok: sp ? await stores.spellbook.getState().memorizeSpell(sp.spellId, gem) : false });
      }
      if (stores.combat.getState().isSpellbookOpen) stores.combat.getState().toggleSpellbook();
      stores.combat.getState().setPlayerSitting(false);
      return { scribed, memorized };
    },

    /** Start a conversation with an NPC in the current zone, or say a keyword to the current one. */
    async talk(npcName, keyword = null) {
      const C8 = dialogue;
      if (!C8) throw new Error("bridge: dialogue functions not found");
      const npc = stores.combat.getState().currentZoneNPCs.find((n) => n.name.replace(/_/g, " ").toLowerCase() === npcName.toLowerCase().replace(/_/g, " "));
      if (!npc) throw new Error(`no NPC named ${npcName} in this zone`);
      const info = keyword ? await C8.j(keyword, keyword) : await C8.l(npc.id, npc.name);
      return info && { greeting: info.greeting, options: (info.availableOptions ?? []).map((o) => o.keyword), hasTurnIn: info.hasTurnIn, error: info.error };
    },

    /** Recruit the free Warrior, Rogue and Cleric helpers. */
    async recruitDefaultParty() {
      for (const f of ["addWarrior", "addCleric", "addRogue"]) {
        await stores.companions.getState()[f]();
        await new Promise((r) => setTimeout(r, 1200));
      }
      return stores.companions.getState().companions.map((c) => ({ name: c.name, level: c.level }));
    },

    /** Recorder rows after the given { ses, seq } cursors, for incremental export. */
    drain(sampleCursor = { ses: 0, seq: 0 }, eventCursor = { ses: 0, seq: 0 }) {
      // Sequence numbers restart when the page reloads, so a cursor is a (session, seq) pair.
      const after = (x, c) => (x.ses ?? 0) > c.ses || ((x.ses ?? 0) === c.ses && x.seq > c.seq);
      return {
        samples: samples.filter((x) => after(x, sampleCursor)),
        events: events.filter((x) => after(x, eventCursor)),
      };
    },

    /**
     * Every character in the party, the player first: class, race, level, HP and mana, armor class
     * and equipped items (slots 0-21, name by slot). Companion gear is loaded from the client's
     * party data first, because `botInventories` stays empty until something asks for it.
     * Companion races come from the account's character list. Pets are listed separately.
     */
    async roster() {
      const cs0 = stores.companions.getState();
      const real = (cs0.companions ?? []).filter((c) => c.companionType === 2 || c.companionType === 0);
      await Promise.all(real.map((c) => cs0.loadBotItemsAndRecalc(c.id).catch(() => {})));
      const cs = stores.companions.getState();
      const sd = stores.staticData.getState();
      const classes = Object.fromEntries((sd.classes ?? []).map((c) => [c.id, c.name]));
      const races = Object.fromEntries((sd.races ?? []).map((r) => [r.id, r.name]));
      const accountRace = Object.fromEntries((stores.roster?.getState?.().characters ?? []).map((c) => [c.name, races[c.race]]));
      const p = stores.character.getState().characterProfile ?? {};
      const equipped = (rows) =>
        (rows ?? [])
          .filter((i) => i.bag === 0 && i.slot >= 0 && i.slot <= 21)
          .map((i) => ({ slot: i.slot, name: i.itemDetails?.Name ?? i.itemDetails?.name ?? i.itemid }))
          .sort((a, b) => a.slot - b.slot);
      const me = { name: p.name, class: typeof p.class === "object" ? p.class?.name : classes[p.class], race: (typeof p.race === "object" ? p.race?.name : races[p.race]) ?? accountRace[p.name] ?? null, level: p.level, hp: [p.curHp, p.maxHp], mana: [p.mana, p.maxMana], ac: p.ac, items: equipped(p.inventory) };
      const members = (cs.companions ?? []).map((c) => {
        const stats = cs.botComputedStats?.[c.id] ?? {};
        const data = cs.botCombatDataMap?.[c.id];
        const isPet = c.companionType !== 0 && c.companionType !== 2;
        return { id: c.id, name: c.name, class: classes[data?.class], race: accountRace[c.name] ?? null, level: c.level, type: c.companionType, pet: isPet, hp: [c.curHp, c.maxHp], mana: [c.curMana, c.maxMana], ac: stats.ac, items: equipped(cs.botInventories?.[c.id]) };
      });
      return { me, party: members.filter((m) => !m.pet), pets: members.filter((m) => m.pet) };
    },

    /** Compact snapshot of what the client currently knows. */
    status() {
      const sc = stores.screen.getState();
      const cb = stores.combat.getState();
      const p = stores.character.getState().characterProfile ?? {};
      const sd = stores.staticData.getState();
      const zone = cb.currentZone != null ? (sd.zones.find((z) => z.zoneidnumber === cb.currentZone) ?? null) : null;
      return {
        screen: sc.currentScreen,
        connected: socket.isConnected,
        worldReady: socket.worldReady,
        sessionId: socket.sessionId,
        zoneLoading: cb.isZoneLoading,
        zone: zone ? (zone.longName ?? zone.shortName) : cb.currentZone,
        profileLoaded: stores.character.getState().characterProfileLoaded,
        character: p.id
          ? { id: p.id, name: p.name, level: p.level, class: p.class, race: p.race, hp: p.curHp, maxHp: p.maxHp, mana: p.mana, maxMana: p.maxMana, xp: p.experienceProgress }
          : null,
        autoLevel: { running: cb.isRunning, mode: cb.automatedCombatMode, autoAttack: cb.isAutoAttackEnabled },
        inCombat: stores.skills.getState().inCombat,
        bags: p.id ? iq.bagSpace() : null,
      };
    },
  };
  window.iq = iq;
  // A small result, because the relay returns an evaluation's value by value and `window.iq` holds
  // references too deep for that.
  return { installed: true, release: iq.release, missingApi: iq.missingApi };
})();
