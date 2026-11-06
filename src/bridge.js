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
  const record = (dir, op, data) => {
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

  const iq = {
    version: 1,
    mods,
    stores,
    socket,
    log,
    kills,
    setOpcodeNames(table) {
      for (const [name, op] of Object.entries(table)) opName[op] = name;
    },

    /** Packets after `sinceSeq`, optionally filtered by name regex source. */
    packets(sinceSeq = 0, nameRe = null) {
      const re = nameRe && new RegExp(nameRe);
      return log.entries.filter((e) => e.seq > sinceSeq && (!re || re.test(e.name)));
    },

    /** Inventory rows: bag, slot, item id, name and quantity. Slots 3000+ are the quest give window. */
    inventory() {
      const p = stores.character.getState().characterProfile;
      return (p.inventory ?? []).map((i) => ({ bag: i.bag, slot: i.slot, id: i.itemid, name: i.itemDetails?.Name ?? i.itemDetails?.name, quantity: i.quantity, instanceId: i.itemInstanceId }));
    },

    /** Last chat lines the client shows. */
    chatTail(n = 20) {
      return stores.chat.getState().messages.slice(-n).map((m) => m.text);
    },

    /**
     * Scribe every spell scroll in the inventory, then memorize the named spells into gems 0..n-1.
     * The client only allows this while sitting with the spellbook open, so both are set here.
     */
    async scribeAndMemorize(memorize = []) {
      const combat = stores.combat.getState();
      combat.setPlayerSitting(true);
      if (!stores.combat.getState().isSpellbookOpen) stores.combat.getState().toggleSpellbook();
      await new Promise((r) => setTimeout(r, 1000));
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
      };
    },
  };
  window.iq = iq;
  return iq;
})();
