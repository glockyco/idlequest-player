// One simulated fight, run inside a worker that holds one booted client. It builds the raid in
// the client's own stores, starts it the way the raid UI does and lets the client's raid tick and
// boss engine run on the virtual clock. Header of tools/raidsim.mjs lists what is replaced.
import { advance, callCounts, client, clock, countCalls, flush, inBq, inEngine, inMain, seededRandom } from "./env.mjs";
import { SKILL_IDS } from "./classes.mjs";
import { BOSS_SPAWN_ID } from "./boss.mjs";
import { snapshotOf } from "./roster.mjs";

const LEADER_ID = 1;
// A zone for the leader when the boss is not one of the client's Raid Resolve bosses.
const DEFAULT_ZONE_ID = 1;

// The client's own names for what a fight reads (clients.mjs).
const N = client.names;
// Client functions whose calls are counted (clients.mjs). Only `function` declarations can be
// rebound; the rest of what a fight runs (spell casting and NPC casting among it) is reached
// through these and counted by what it drives.
const COUNTED = client.counted;
const COUNTED_L2 = ["tick", "createPrimaryEncounter", "applyRaidMeleeToNpc", "applyRaidDamageToNpc", "applyRaidSpellToNpc", "applyRaidHeal", "upsertRaidMemberActor", "getNpcMeleeTargetStats"];

// The CombatInit the server sends for a boss: the npc_types row in the client's field names.
function bossInit({ row, spells }) {
  const c1 = inMain(N.main.spellStore);
  const buildNpcSpell = inMain(N.main.npcSpellBuilder);
  const hp = Number(row.hp);
  const npcSpells = spells.flatMap((e) => {
    const spell = c1.get(e.spellId);
    const built = spell && buildNpcSpell(e.spellId, e.category, e.minLevel, spell.targetType, row.level);
    return built ? [built] : [];
  });
  return {
    npcId: row.id,
    spawnInstanceId: BOSS_SPAWN_ID,
    spawn2Id: 0,
    npcName: row.name.replace(/#/g, "").replace(/_/g, " "),
    npcRace: row.race,
    npcBodyType: row.bodytype,
    npcHp: hp,
    npcMaxHp: hp,
    npcMana: Number(row.mana),
    npcAc: row.AC,
    npcMinDmg: row.mindmg,
    npcMaxDmg: row.maxdmg,
    npcAttackDelay: row.attack_delay,
    npcAttackCount: row.attack_count,
    npcLevel: row.level,
    npcClass: row.class,
    npcSpecialAbilities: row.special_abilities,
    npcMr: row.MR,
    npcFr: row.FR,
    npcCr: row.CR,
    npcPr: row.PR,
    npcDr: row.DR,
    npcPhR: row.PhR,
    npcStr: row.STR,
    npcAgi: row.AGI,
    npcDex: row.DEX,
    npcAccuracy: row.Accuracy ?? 0,
    npcAtk: row.ATK ?? 0,
    // Stub: the server's rule for extra attacks is not in the client. A boss attacks twice at
    // times and gets triple, quad and flurry only from its special abilities.
    npcCanDoubleAttack: true,
    npcCanTripleAttack: false,
    npcSpells: npcSpells.length ? { spells: npcSpells } : null,
    conColor: 0,
    conMessage: "",
    factionMessage: "",
    combatSkills: [],
  };
}

const bossTarget = (init) => ({
  name: init.npcName,
  npcId: init.npcId,
  spawnInstanceId: init.spawnInstanceId,
  level: init.npcLevel,
  bodyType: init.npcBodyType,
  hp: init.npcHp,
  maxHp: init.npcMaxHp,
  position: { x: 0, y: 0, z: 0 },
  targetType: "npc",
});

function installStubs({ items, init }) {
  const c1 = inMain(N.main.spellStore);
  // Stub: the item service. The client loads item definitions from the server by id.
  const loadItemById = async (id) => {
    const row = items[id];
    return row ? { ...row, name: row.Name } : null;
  };

  // Stub: the network. Streamed messages are dropped and requests that need an answer fail,
  // which the client treats as a lost connection.
  const socket = inMain(N.main.socket);
  socket.sendStreamJsonMessage = async () => ({});
  socket.sendJsonMessage = async () => ({});
  socket.sendCorrelatedJsonRequest = async () => {
    throw new Error("offline simulator");
  };

  // Stub: the server's answer to a combat start request, the CombatInit for the target.
  const pi = inEngine(N.engine.runtime);
  globalThis.__raidsimCombatStart = (request) => {
    setTimeout(() => pi.handleCombatInit({ ...init, _requestId: request._requestId }), 100);
    return Promise.resolve();
  };
  inBq(`${N.bq.combatStartRequest} = (request) => globalThis.__raidsimCombatStart(request)`);

  // Stub: the 3D scene. The raid code asks the scene whether a member is in melee or ranged
  // range and which areas hold targets. Everyone in the raid is in melee range of the boss, and the
  // boss's spells reach everyone (`canCombatEntityBeCastOn`, which the boss's own casts ask for:
  // answering false there kept the boss from casting). A method not listed answers false.
  const sceneCalls = new Map();
  const known = {
    isCombatEntityInRange: () => true,
    canCombatEntityBeCastOn: () => true,
    hasCombatEntitySpellLineOfSight: () => true,
    getAliveCombatEntities: () => [],
    getAliveCombatTargetList: () => [],
    getCombatEntityDistanceSquared: () => 100,
    getNpcAttackDenialReason: () => null,
    withSpatialQueryCache: (fn) => fn(),
    getCombatStartRange: () => 20,
    getCombatVerticalRange: () => 15,
  };
  const scene = new Proxy(
    {},
    {
      get: (_, key) => {
        if (key in known) return known[key];
        if (typeof key === "string" && /^(getCombatTarget|getCombatEntity|getOwnedNpc|findClosest|getNavigation|getQuest)/.test(key)) return () => null;
        return () => {
          sceneCalls.set(String(key), (sceneCalls.get(String(key)) ?? 0) + 1);
          return false;
        };
      },
    },
  );
  pi.bindScenePorts(scene, inBq(N.bq.sceneStandIn));

  // Observation, not a stub: every damage, heal, mana and death event the combat state records
  // passes through G2 in main, which this wrapper reads before forwarding.
  const events = [];
  inMain(`globalThis.__raidsimG2 = ${N.main.eventRecorder}`);
  const g2 = globalThis.__raidsimG2;
  globalThis.__raidsimEvent = function (runtime, event, options) {
    events.push({ at: clock.now, ...event });
    return g2(runtime, event, options);
  };
  inMain(`${N.main.eventRecorder} = globalThis.__raidsimEvent`);

  // Observation: call counters.
  const skipped = [...countCalls("engine", COUNTED.engine), ...countCalls("main", COUNTED.main), ...countCalls("bq", COUNTED.bq)];
  if (skipped.length) throw new Error(`cannot count ${skipped.join(", ")}: not function declarations`);
  const L2 = inBq(N.bq.encounterClass);
  for (const method of COUNTED_L2) {
    const original = L2.prototype[method];
    const key = `L2.${method}`;
    callCounts.set(key, 0);
    L2.prototype[method] = function (...args) {
      callCounts.set(key, callCounts.get(key) + 1);
      return original.apply(this, args);
    };
  }
  return { pi, events, sceneCalls, loadItemById, c1 };
}

function leaderProfile(member, items, zoneId) {
  const skills = new Array(100).fill(0);
  for (const [id, value] of Object.entries(member.skills)) skills[+id] = value;
  const inventory = Object.entries(member.equipped).map(([slot, id]) => ({
    bag: 0,
    slot: +slot,
    itemid: id,
    quantity: 1,
    itemDetails: { ...items[id], name: items[id].Name },
  }));
  return {
    id: LEADER_ID,
    name: member.name,
    level: member.level,
    class: { id: member.cls },
    race: { id: member.race },
    ...member.stats,
    skills,
    inventory,
    aaBonuses: {},
    activeBuffs: [],
    zoneId,
    zoneInstance: 0,
    curHp: 1e9,
    mana: 1e9,
  };
}

// The leader is the logged-in character. The client reads it from its character and spellbook
// stores, so those get the leader's data, and the character store computes its stats.
function installLeader(member, items, c1, zoneId) {
  const D = inMain(N.main.characterStore);
  D.setState({ characterProfile: { ...inMain(N.main.defaultProfile)(), ...leaderProfile(member, items, zoneId) } });
  D.getState().recalcStats();
  D.setState((st) => ({ characterProfile: { ...st.characterProfile, curHp: st.characterProfile.maxHp, mana: st.characterProfile.maxMana }, characterProfileLoaded: true }));
  const gems = member.gems.slice(0, member.cls === 8 ? 3 : 8);
  inMain(N.main.spellbookStore).setState({
    ownerCharacterId: LEADER_ID,
    scribedSpells: member.spells.map((spellId, i) => ({ spellId, bookSlot: i, spell: c1.get(spellId) })),
    memorizedSpells: gems.map((spellId, gemSlot) => ({ gemSlot, spellId, spell: c1.get(spellId) })),
  });
  // The leader fights on auto attack, as a player in the raid view does.
  inMain(N.main.gameStore).setState({ isAutoAttackEnabled: true, currentZone: zoneId });
}

// How a damage event on the boss counts, by the client's `damageType`: the raid tick's own melee
// and DoT rolls, pet melee, spell damage, and weapon or item procs.
const DAMAGE_KIND = { melee: "melee", "raid-melee": "melee", "raid-pet-melee": "pet", "raid-dot": "dot", dot: "dot", spell: "nuke", proc: "proc" };

export async function runJob(job) {
  const { members, boss, items, compact, seed, maxSec, dpsMode, healMode } = job;
  inMain(N.main.spellStore).hydrate(inMain(N.main.hydrateSpells)(JSON.parse(compact)));
  const sc = inMain(N.main.skillNames);
  for (const [name, id] of Object.entries(SKILL_IDS)) {
    if (sc[id] !== name) throw new Error(`skill ${name} is ${sc[id]} in the client, not ${id}; update SKILL_IDS in classes.mjs`);
  }
  const init = bossInit(boss);
  const stubs = installStubs({ items, init });
  const { pi, c1 } = stubs;
  Math.random = seededRandom(seed);

  const leader = members.find((m) => m.leader);
  // Raid Resolve applies in the zone of the client's Resolve bosses (`resolveBosses` in clients.mjs), and
  // the client reads that zone from the leader's character, so the leader stands there.
  const resolveBoss = inMain(N.main.resolveBosses).find((entry) => entry.npcId === init.npcId);
  installLeader(leader, items, c1, resolveBoss?.zoneId ?? DEFAULT_ZONE_ID);
  // Stub: raid time. The client lets a raid start only while the account holds raid time.
  inMain(N.main.raidTimeStore).setState({ scope: inMain(N.main.raidTimeScope)(), loaded: true, expiresAtMs: clock.now + 1e12, clockOffsetMs: 0 });

  const rt = inEngine(N.engine.raidStore);
  const sessionId = rt.getState().raidSessionId;
  const buildMember = inMain(N.main.memberFromSnapshot);
  const built = [];
  for (const [i, spec] of members.filter((m) => !m.leader).entries()) {
    const member = await buildMember({ snapshot: snapshotOf(spec, 100 + i), raidSessionId: sessionId, ordinal: i + 1, loadItemById: stubs.loadItemById });
    built.push({ spec, member });
  }
  const roster = built.map((b) => b.member);
  const level = leader.level;
  rt.setState({
    roster,
    pets: inMain(N.main.petsForRoster)(roster, level, []),
    leaderLevel: level,
    nextMemberOrdinal: roster.length + 1,
    raidModeActive: true,
    isRaidOpen: true,
    playerOrder: { ...rt.getState().playerOrder, control: "raid" },
    // Stub: the roster check the client does against the server before combat.
    validatedRosterSessionId: sessionId,
  });
  rt.getState().syncRaidBuffs(level);
  // Stub: the rest before the pull. A member is built at its unbuffed maximum and the raid buffs
  // raise that maximum, so out of combat the client's raid regeneration (`tickRaidRegen` in
  // the combat service) fills hit points and mana over a few minutes. The fight starts after that.
  rt.setState((st) => ({
    roster: st.roster.map((m) => ({ ...m, hp: m.maxHp, mana: m.maxMana })),
    pets: st.pets.map((p) => ({ ...p, hp: p.maxHp })),
  }));

  const target = bossTarget(init);
  if (!rt.getState().beginCombatForTarget(target)) throw new Error("the client refused to begin raid combat (beginCombatForTarget returned false)");
  rt.getState().setAllCommand("attacking", target);
  inEngine(N.engine.raidTick)();
  if (healMode) inEngine(N.engine.setAutoHeal)(healMode);
  if (dpsMode) await inEngine(N.engine.setAutoDps)(dpsMode, target);

  const startedAt = clock.now;
  const bossActorId = `npc:${init.spawnInstanceId}`;
  const bossState = () => pi.getRuntimeSnapshot().actors.find((a) => a.id === bossActorId);

  // Trace of one member (job.trace is its roster index): once a second its hit points, its place in
  // the boss's hate list, whether the boss has it targeted and the mana of the Clerics.
  const traceId = job.trace === undefined ? null : job.trace === members.indexOf(leader) ? "player" : built[members.filter((m) => !m.leader).indexOf(members[job.trace])].member.id;
  const samples = [];
  if (traceId) {
    setInterval(() => {
      const { actors } = pi.getRuntimeSnapshot();
      const me = actors.find((a) => a.id === traceId);
      const boss = actors.find((a) => a.id === bossActorId);
      const hate = [...(boss?.hateEntries ?? [])].sort((a, b) => b.hate - a.hate);
      samples.push({
        at: clock.now,
        hp: me?.hp ?? 0,
        maxHp: me?.maxHp ?? 0,
        rank: hate.findIndex((h) => h.entityId === traceId) + 1,
        targeted: boss?.targetId === traceId,
        clericMana: rt.getState().roster.filter((m) => m.eqClassId === 2 && m.alive).reduce((total, m) => total + m.mana, 0),
      });
    }, 1000);
  }
  const leaderAlive = () => (inMain(N.main.characterStore).getState().characterProfile.curHp ?? 0) > 0;
  const anyAlive = () => rt.getState().roster.some((m) => m.alive) || leaderAlive();
  let bossSeen = false;
  const over = () => {
    const b = bossState();
    if (b) bossSeen = true;
    return (bossSeen && (!b || !b.alive || b.hp <= 0)) || (bossSeen && !anyAlive());
  };
  while (clock.now - startedAt < maxSec * 1000 && !over()) {
    await advance(1000, over);
    if (!bossSeen && clock.now - startedAt > 10_000) throw new Error("the boss never entered the combat engine");
  }
  await flush();
  const b = bossState();
  return summarize({ stubs, members, built, leader, bossActorId, bossHpLeft: b ? Math.max(0, b.hp) : 0, init, startedAt, maxSec, seed, anyAlive, rt, traceId, samples });
}

function summarize({ stubs, members, built, leader, bossActorId, bossHpLeft, init, startedAt, maxSec, seed, anyAlive, rt, traceId, samples }) {
  const owner = new Map([["player", "player"]]);
  for (const b of built) owner.set(b.member.id, b.member.id);
  for (const pet of rt.getState().pets) owner.set(pet.id, pet.ownerId);
  const isMember = new Set(owner.values());
  const stats = new Map();
  const row = (id) => {
    if (!stats.has(id)) stats.set(id, { damage: { melee: 0, pet: 0, nuke: 0, dot: 0, proc: 0, other: 0 }, healed: 0, manaSpent: 0, died: null, taken: 0 });
    return stats.get(id);
  };
  let lastBossDamageAt = startedAt;
  const otherDamage = new Map();
  const eventTypes = {};
  for (const e of stubs.events) {
    eventTypes[e.type] = (eventTypes[e.type] ?? 0) + 1;
    if (e.type === "damage") {
      if (e.targetId === bossActorId) {
        lastBossDamageAt = e.at;
        const who = owner.get(e.sourceId);
        if (!who) continue;
        let kind = DAMAGE_KIND[e.damageType];
        if (!kind) {
          kind = "other";
          otherDamage.set(e.damageType, (otherDamage.get(e.damageType) ?? 0) + e.amount);
        }
        if (kind === "proc" && e.sourceId.startsWith("raid:pet:")) kind = "pet";
        row(who).damage[kind] += e.amount;
      } else if (owner.has(e.targetId) && isMember.has(e.targetId)) {
        row(e.targetId).taken += e.amount;
      }
    } else if (e.type === "heal") {
      const who = owner.get(e.sourceId);
      if (who) row(who).healed += e.amount;
    } else if (e.type === "mana" && e.reason !== "regen" && e.sourceId === e.targetId) {
      const who = owner.get(e.sourceId);
      if (who) row(who).manaSpent += -e.amount;
    } else if (e.type === "actor-died" && isMember.has(e.targetId) && row(e.targetId).died === null) {
      row(e.targetId).died = Math.round((e.at - startedAt) / 100) / 10;
    }
  }
  const bossDead = bossHpLeft <= 0;
  const wiped = !bossDead && !anyAlive();
  const lastDeath = Math.max(0, ...[...isMember].map((id) => row(id).died ?? 0));
  const seconds = bossDead ? Math.round((lastBossDamageAt - startedAt) / 100) / 10 : wiped ? lastDeath : maxSec;
  return {
    seed,
    outcome: bossDead ? "kill" : wiped ? "wipe" : "timeout",
    seconds,
    bossHpLeft,
    bossMaxHp: init.npcMaxHp,
    members: [
      { name: leader.name, cls: leader.cls, leader: true, ...row("player") },
      ...built.map((b) => ({ name: b.spec.name, cls: b.spec.cls, leader: false, ...row(b.member.id) })),
    ],
    resolve: !!rt.getState().encounterAid?.granted,
    otherDamage: Object.fromEntries(otherDamage),
    eventTypes,
    trace: traceId ? traceBuckets({ events: stubs.events, samples, traceId, startedAt, bossActorId, names: new Map([["player", leader.name], ...built.map((b) => [b.member.id, b.spec.name])]), spellName: (id) => stubs.c1.get(id)?.name ?? `spell ${id}` }) : null,
    clockErrors: clock.errors.map((e) => String(e?.stack ?? e).split("\n").slice(0, 4).join(" | ")),
    calls: Object.fromEntries(callCounts),
    sceneCalls: Object.fromEntries(stubs.sceneCalls),
  };
}

// The traced member's fight in 10 s rows: hit points at the start of the row, damage taken,
// healing received by caster and spell, hate rank, seconds the boss had it targeted and the
// Clerics' mana at the end of the row.
function traceBuckets({ events, samples, traceId, startedAt, bossActorId, names, spellName }) {
  const rows = new Map();
  const row = (at) => {
    const from = Math.floor((at - startedAt) / 10_000) * 10;
    if (!rows.has(from)) rows.set(from, { from, hp: null, maxHp: 0, rank: null, taken: 0, hits: 0, healed: 0, heals: {}, targetedSec: 0, clericMana: null, died: false });
    return rows.get(from);
  };
  for (const s of samples) {
    const r = row(s.at);
    if (r.hp === null) Object.assign(r, { hp: s.hp, maxHp: s.maxHp, rank: s.rank || null });
    if (s.targeted) r.targetedSec++;
    r.clericMana = s.clericMana;
  }
  for (const e of events) {
    if (e.targetId !== traceId) continue;
    if (e.type === "damage" && e.sourceId === bossActorId) {
      const r = row(e.at);
      r.taken += e.amount;
      r.hits++;
    } else if (e.type === "heal") {
      const r = row(e.at);
      r.healed += e.amount;
      const key = e.spellId ? `${names.get(e.sourceId) ?? e.sourceId}: ${spellName(e.spellId)}` : "regeneration";
      r.heals[key] = (r.heals[key] ?? 0) + e.amount;
    } else if (e.type === "actor-died") row(e.at).died = true;
  }
  return [...rows.values()].sort((a, b) => a.from - b.from);
}
