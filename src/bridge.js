// In-page bridge for the IdleQuest web client.
//
// The game simulates combat and AutoLevel inside the browser client, so the client has to keep
// running. This bridge attaches to the running client through its own modules and exposes a
// small, stable surface as `window.iq`.
//
// The release build minifies every export name and renames the chunk files, so stores are found
// by the state keys they carry, never by export name.
//
// Evaluate this file as a page expression. It returns `window.iq` and is idempotent.
(async () => {
  if (window.iq && window.iq.version) return window.iq;

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
  const record = (dir, op, data) => {
    const name = opName[op] ?? String(op);
    if (noisy.has(name)) return;
    log.entries.push({ seq: ++log.seq, t: Date.now(), dir, op, name, data });
    if (log.entries.length > log.max) log.entries.splice(0, log.entries.length - log.max);
  };
  const origObserve = socket.observeIncomingOpcode.bind(socket);
  socket.observeIncomingOpcode = (op, payload) => {
    try {
      record("in", op, JSON.parse(new TextDecoder().decode(payload)));
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

  const iq = {
    version: 1,
    mods,
    stores,
    socket,
    log,
    setOpcodeNames(table) {
      for (const [name, op] of Object.entries(table)) opName[op] = name;
    },

    /** Packets after `sinceSeq`, optionally filtered by name regex source. */
    packets(sinceSeq = 0, nameRe = null) {
      const re = nameRe && new RegExp(nameRe);
      return log.entries.filter((e) => e.seq > sinceSeq && (!re || re.test(e.name)));
    },

    /** Compact snapshot of what the client currently knows. */
    status() {
      const sc = stores.screen.getState();
      const cb = stores.combat.getState();
      const p = stores.character.getState().characterProfile ?? {};
      const sd = stores.staticData.getState();
      const zone = cb.currentZone != null ? (sd.zones.find((z) => z.zoneidnumber === cb.currentZone || z.id === cb.currentZone) ?? null) : null;
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
      };
    },
  };
  window.iq = iq;
  return iq;
})();
