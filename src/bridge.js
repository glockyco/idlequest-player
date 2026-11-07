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
  const socketMethods = ["observeIncomingOpcode", "sendJsonMessage", "sendStreamJsonMessage", "sendJsonRequest", "sendCorrelatedJsonRequest"];
  if (window.iq) {
    // Wrappers are instance properties that shadow prototype methods, so deleting them restores the originals.
    for (const fn of socketMethods) if (window.iq.socket) delete window.iq.socket[fn];
  }

  const ASSET_RE = /\/assets\/[^/?#]+\.js(?:[?#]|$)/;

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

  const has = (st, ...keys) => st && keys.every((k) => k in st);
  const isStore = (v) => typeof v === "function" && typeof v.getState === "function" && typeof v.subscribe === "function";
  const STORE_SIGNATURES = {
    combat: (s) => has(s, "startAutoLevel", "setAutomatedCombatMode", "currentZone"),
    character: (s) => has(s, "characterProfile", "handleCharacterData"),
    spellbook: (s) => has(s, "scribedSpells", "memorizedSpells", "memorizeSpell"),
    companions: (s) => has(s, "companions", "summonPet", "addWarrior"),
    skills: (s) => has(s, "skills", "setInCombat"),
    screen: (s) => has(s, "currentScreen", "setScreen"),
    roster: (s) => has(s, "characters", "enterWorld", "deleteCharacter"),
    chat: (s) => has(s, "messages", "addMessage", "lastTellSender"),
    staticData: (s) => has(s, "zones", "races", "classes", "deities"),
    raid: (s) => has(s, "setGroupCommand", "isRaidOpen"),
    merchant: (s) => has(s, "merchants", "selectedMerchant", "merchantItems"),
    partyTactics: (s) => has(s, "meleeByCharacterId", "setTactic"),
    partySpells: (s) => has(s, "castingPreferences", "setPetPreference"),
  };

  const stores = {};
  let socket = null;
  for (const m of Object.values(mods)) {
    for (const v of Object.values(m)) {
      if (!socket && v && typeof v === "object" && typeof v.sendJsonRequest === "function" && "worldReady" in v) {
        socket = v;
        continue;
      }
      if (!isStore(v)) continue;
      let st;
      try {
        st = v.getState();
      } catch {
        continue;
      }
      for (const [name, test] of Object.entries(STORE_SIGNATURES)) {
        if (!stores[name] && test(st)) stores[name] = v;
      }
    }
  }
  const missing = Object.keys(STORE_SIGNATURES).filter((n) => !stores[n]);
  if (!socket || missing.length) {
    throw new Error(`bridge: could not find ${[!socket && "socket", ...missing].filter(Boolean).join(", ")}`);
  }

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
  // Kill log built from the combat messages the server broadcasts.
  const kills = window.iq?.kills ?? [];
  const KILL_RE = /^You have (?:defeated|slain) (.+?) and gained (\d+) experience/;
  const origObserve = socket.observeIncomingOpcode.bind(socket);
  socket.observeIncomingOpcode = (op, payload) => {
    try {
      const data = JSON.parse(new TextDecoder().decode(payload));
      record("in", op, data);
      const m = opName[op] === "ChatMessageBroadcast" && KILL_RE.exec(data.text ?? "");
      if (m) kills.push({ t: Date.now(), enemy: m[1], xp: Number(m[2]) });
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
  const session = window.iq?.session ?? Date.now();
  // Rows kept by an older install of this bridge carry no session. Give them one that sorts before
  // this install's, so an exporter whose file holds rows from an earlier page still collects them.
  for (const r of samples) r.ses ??= session - 1;
  for (const r of events) r.ses ??= session - 1;
  const SAMPLE_MAX = 90000; // 25 h at 1 Hz
  const EVENT_MAX = 60000;
  if (window.iq?.samplerId) clearInterval(window.iq.samplerId);
  if (window.iq?.unsubChat) window.iq.unsubChat();

  const sample = () => {
    const p = stores.character.getState().characterProfile;
    if (!p?.id) return null;
    const cb = stores.combat.getState();
    const comps = stores.companions.getState().companions ?? [];
    return {
      ses: session,
      seq: ++seqs.sample,
      t: Date.now(),
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

  // Read-only subscription; never replaces a client callback.
  let lastChatId = stores.chat.getState().nextId - 1;
  const unsubChat = stores.chat.subscribe((state) => {
    for (const m of state.messages) {
      if (m.id <= lastChatId) continue;
      lastChatId = m.id;
      events.push({ ses: session, seq: ++seqs.event, t: m.timestamp ?? Date.now(), type: m.type, text: m.text });
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
  // one the Travel window sends) and starts AutoLevel again with the same limits.
  // Triggers, each checked once a second while a mob is engaged:
  //   level   a mob is `levelGap` or more levels above the leader
  //   hit     a mob's biggest hit times `hitsToKill` reaches the lowest max HP in the party
  //   down    a party member has died since the guard last looked
  //   healer  a Cleric is below `healerManaPct` mana while someone is below `healerHpPct` HP
  const guardPrev = window.iq?.guard;
  if (guardPrev?.timerId) clearInterval(guardPrev.timerId);
  const guard = {
    config: {
      enabled: true,
      levelGap: 8,
      hitsToKill: 3,
      healerManaPct: 10,
      healerHpPct: 50,
      escalateAfter: 3, // escapes in an hour before the limits are tightened
      safeLimits: { minCon: 4, maxCon: 15, maxLevelDiff: 2 },
      retreatZone: "steamfont", // retreat to a safe zone instead of re-entering a dangerous one
      fallbackZone: null, // short name to move to when escapes continue at the safe limits
      ...guardPrev?.config,
    },
    phase: "watching", // watching | leaving
    preferred: guardPrev?.preferred ?? null, // limits to return to after a quiet hour, once tightened
    trips: guardPrev?.trips ?? [],
    knownDown: new Set(),
    timerId: null,
  };
  const guardApi = {
    /** The guard's settings, its phase and the escapes of the last hour. */
    guardStatus: () => ({ config: guard.config, phase: guard.phase, trips: guard.trips }),
    /** Change guard settings, e.g. `{ levelGap: 6 }`, `{ fallbackZone: "lfaydark" }` or `{ enabled: false }`. */
    setGuard(partial) {
      Object.assign(guard.config, partial);
      return guard.config;
    },
    /** Make the guard leave once, as if `reason` had fired, to test the escape. No setting changes. */
    testGuard(reason = "test") {
      guard.force = `test: ${reason}`;
      return true;
    },
  };
  const guardNote = (text) => events.push({ ses: session, seq: ++seqs.event, t: Date.now(), type: "guard", text: `[guard] ${text}` });
  const zoneChanger = () => Object.values(mods).map((m) => m.rs).find((f) => typeof f === "function" && String(f).includes("WorldSocket not connected") && String(f).includes("zoneName"));
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
    for (const mob of mobs) {
      if (mob.level >= p.level + cfg.levelGap) return `level: ${mob.name} L${mob.level} against leader L${p.level}`;
      const maxHit = Number((cb.currentZoneNPCs ?? []).find((n) => n.id === mob.npcId)?.maxdmg) || 0;
      if (maxHit * cfg.hitsToKill >= weakest) return `hit: ${mob.name} hits up to ${maxHit}, ${cfg.hitsToKill} hits kill a ${weakest} HP member`;
    }
    for (const m of members) {
      if (m.hp > 0) guard.knownDown.delete(m.name);
      else if (!guard.knownDown.has(m.name)) {
        guard.knownDown.add(m.name);
        return `down: ${m.name} died`;
      }
    }
    const hurt = members.some((m) => m.maxHp && (m.hp / m.maxHp) * 100 < cfg.healerHpPct && m.hp > 0);
    const dry = members.find((m) => m.cls === "Cleric" && m.maxMana && (m.mana / m.maxMana) * 100 < cfg.healerManaPct);
    if (hurt && dry) return `healer: ${dry.name} has ${dry.mana}/${dry.maxMana} mana`;
    return null;
  };
  // The game's limit setters overwrite each other (see docs/client-internals.md), so the cap goes
  // last: it sets the highest con itself, and the pair stays consistent.
  const applyLimits = (cb, l) => {
    cb.setMaxCon(l.maxCon);
    cb.setMinCon(l.minCon);
    cb.setMaxLevelDiff(l.maxLevelDiff);
  };
  const guardLeave = async (reason) => {
    const cb = stores.combat.getState();
    const cfg = guard.config;
    guard.trips = guard.trips.filter((t) => t.t > Date.now() - 3600000);
    let limits = { minCon: cb.minCon, maxCon: cb.maxCon, maxLevelDiff: cb.maxLevelDiff };
    let target = cfg.retreatZone;
    // Repeated escapes mean this spot or these limits are too hard for the party. Get more careful
    // and keep playing. First tighten the limits, then move to another zone if one is configured.
    const looser = limits.maxLevelDiff > cfg.safeLimits.maxLevelDiff || limits.minCon > cfg.safeLimits.minCon;
    if (guard.trips.length >= cfg.escalateAfter && looser) {
      guard.preferred ??= { ...limits };
      limits = { ...cfg.safeLimits };
      guardNote(`${guard.trips.length} escapes in the last hour, tightening AutoLevel to con ${limits.minCon}..${limits.maxCon}, cap ${limits.maxLevelDiff}`);
    } else if (guard.trips.length >= cfg.escalateAfter + 2 && cfg.fallbackZone) {
      target = cfg.fallbackZone;
      guardNote(`${guard.trips.length} escapes in the last hour even at the safe limits, moving to ${target}`);
    }
    guard.phase = "leaving";
    guard.trips.push({ t: Date.now(), reason, zone: cb.currentZone });
    guardNote(`leaving: ${reason}`);
    cb.setIsRunning(false);
    try {
      const zones = stores.staticData.getState().zones;
      const dest = target ? zones.find((z) => z.shortName === target) : zones.find((z) => z.zoneidnumber === cb.currentZone);
      const change = zoneChanger();
      if (!dest || !change) throw new Error("zone change function or target zone not found");
      await change(dest);
      // The zone-loading flag shows the change started. Give up waiting after 60 s.
      const t0 = Date.now();
      while (!stores.combat.getState().isZoneLoading && Date.now() - t0 < 10000) await new Promise((r) => setTimeout(r, 250));
      while (stores.combat.getState().isZoneLoading && Date.now() - t0 < 60000) await new Promise((r) => setTimeout(r, 500));
      await new Promise((r) => setTimeout(r, 4000));
    } catch (e) {
      guardNote(`zone change failed: ${e.message}`);
    }
    // Whatever happened above, AutoLevel must be running again.
    applyLimits(stores.combat.getState(), limits);
    for (let i = 0; i < 15 && !stores.combat.getState().isRunning; i++) {
      stores.combat.getState().startAutoLevel();
      await new Promise((r) => setTimeout(r, 2000));
    }
    guardNote(stores.combat.getState().isRunning ? "AutoLevel running again" : "AutoLevel did NOT restart");
    guard.phase = "watching";
  };
  guard.timerId = setInterval(() => {
    const cbNow = stores.combat.getState();
    if (!guard.config.enabled || guard.phase !== "watching" || cbNow.isZoneLoading) return;
    // `testGuard` queues a one-shot trigger, so a test never leaves a setting changed behind it.
    const reason = guard.force ?? guardDanger();
    guard.force = null;
    if (reason) {
      guardLeave(reason);
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

  const iq = {
    version: 1,
    mods,
    stores,
    socket,
    log,
    kills,
    samples,
    events,
    seqs,
    session,
    guard,
    chores,
    buyMissingSpells,
    setChores(partial) {
      return Object.assign(chores, partial);
    },
    ...guardApi,
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
     * `who` is a default bot ("cleric", "warrior", "rogue") or the name of an account character in
     * the party. The game keys these as `bot:<playerId>:<bot>` and `character:<characterId>`; a
     * bare name is stored but never read. Returns the member's overrides after the change.
     */
    setTactic(who, key, value) {
      const playerId = stores.character.getState().characterProfile.id;
      const comps = stores.companions.getState().companions ?? [];
      const byName = comps.find((c) => c.characterId && c.name.toLowerCase() === String(who).toLowerCase());
      const k = byName ? `character:${byName.characterId}` : /^\d+$/.test(String(who)) ? `character:${who}` : `bot:${playerId}:${who}`;
      stores.partySpells.getState().setTactic(k, key, value);
      return { key: k, overrides: stores.partySpells.getState().overridesByCompanion[k] };
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
      const C8 = Object.values(mods).find((m) => typeof m.l === "function" && typeof m.j === "function" && typeof m.s === "function");
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
     * Every character in the party, the player first: class, level, HP and mana, armor class and
     * equipped items (slots 0-21, name by slot). Companion gear is loaded from the client's party
     * data first, because `botInventories` stays empty until something asks for it. Pets are
     * listed separately.
     */
    async roster() {
      const cs0 = stores.companions.getState();
      const real = (cs0.companions ?? []).filter((c) => c.companionType === 2 || c.companionType === 0);
      await Promise.all(real.map((c) => cs0.loadBotItemsAndRecalc(c.id).catch(() => {})));
      const cs = stores.companions.getState();
      const classes = Object.fromEntries((stores.staticData.getState().classes ?? []).map((c) => [c.id, c.name]));
      const p = stores.character.getState().characterProfile ?? {};
      const equipped = (rows) =>
        (rows ?? [])
          .filter((i) => i.bag === 0 && i.slot >= 0 && i.slot <= 21)
          .map((i) => ({ slot: i.slot, name: i.itemDetails?.Name ?? i.itemDetails?.name ?? i.itemid }))
          .sort((a, b) => a.slot - b.slot);
      const me = { name: p.name, class: typeof p.class === "object" ? p.class?.name : classes[p.class], level: p.level, hp: [p.curHp, p.maxHp], mana: [p.mana, p.maxMana], ac: p.ac, items: equipped(p.inventory) };
      const members = (cs.companions ?? []).map((c) => {
        const stats = cs.botComputedStats?.[c.id] ?? {};
        const data = cs.botCombatDataMap?.[c.id];
        const isPet = c.companionType !== 0 && c.companionType !== 2;
        return { id: c.id, name: c.name, class: classes[data?.class], level: c.level, type: c.companionType, pet: isPet, hp: [c.curHp, c.maxHp], mana: [c.curMana, c.maxMana], ac: stats.ac, items: equipped(cs.botInventories?.[c.id]) };
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
  return iq;
})();
