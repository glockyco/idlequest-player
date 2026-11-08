// One simulated fight, run inside a worker that holds one booted client. It builds the raid in
// the client's own stores, starts it the way the raid UI does and lets the client's raid tick and
// boss engine run on the virtual clock. Header of tools/raidsim.mjs lists what is replaced.
import { advance, callCounts, clock, countCalls, flush, inBq, inEngine, inMain, main, seededRandom } from "./env.mjs";
import { SKILL_IDS } from "./classes.mjs";
import { BOSS_SPAWN_ID } from "./boss.mjs";
import { snapshotOf } from "./roster.mjs";

const LEADER_ID = 1;
// A zone for the leader when the boss is not one of the client's Raid Resolve bosses.
const DEFAULT_ZONE_ID = 1;

// Client functions whose calls are counted, by bundle. Only `function` declarations can be
// rebound; the rest of what a fight runs (spell casting and NPC casting among it) is reached
// through these and counted by what it drives.
const COUNTED = {
  engine: ["qd", "IGe", "CGe", "Nu", "aGe", "I_", "xOt", "Uxe", "Gxe", "zxe", "wOt", "NOt", "iOt", "tOt", "OOt", "DOt", "IOt", "ROt", "COt", "uOt", "lOt", "jP", "pOt", "mOt", "_Ot"],
  main: ["dr", "yQ", "kp", "Pt", "vJ", "n8", "QQ", "t8", "p6", "U0", "V8", "Qs", "Ep", "o61", "c61", "m61", "mQ"],
  bq: ["MO", "vO", "yO", "WO", "XO", "JO", "Ve", "sb", "_P"],
};
const COUNTED_L2 = ["tick", "createPrimaryEncounter", "applyRaidMeleeToNpc", "applyRaidDamageToNpc", "applyRaidSpellToNpc", "applyRaidHeal", "upsertRaidMemberActor", "getNpcMeleeTargetStats"];

// The CombatInit the server sends for a boss: the npc_types row in the client's field names.
function bossInit({ row, spells }) {
  const c1 = main.H;
  const Zt = inMain("Zt");
  const hp = Number(row.hp);
  const npcSpells = spells.flatMap((e) => {
    const spell = c1.get(e.spellId);
    const built = spell && Zt(e.spellId, e.category, e.minLevel, spell.targetType, row.level);
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
    npcAccuracy: row.accuracy ?? 0,
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
  const c1 = main.H;
  // Stub: the item service. The client loads item definitions from the server by id.
  const loadItemById = async (id) => {
    const row = items[id];
    return row ? { ...row, name: row.Name } : null;
  };

  // Stub: the network. Streamed messages are dropped and requests that need an answer fail,
  // which the client treats as a lost connection.
  const socket = inMain("z");
  socket.sendStreamJsonMessage = async () => ({});
  socket.sendJsonMessage = async () => ({});
  socket.sendCorrelatedJsonRequest = async () => {
    throw new Error("offline simulator");
  };

  // Stub: the server's answer to a combat start request, the CombatInit for the target.
  const pi = inEngine("pi");
  globalThis.__raidsimCombatStart = (request) => {
    setTimeout(() => pi.handleCombatInit({ ...init, _requestId: request._requestId }), 100);
    return Promise.resolve();
  };
  inBq("$L = (request) => globalThis.__raidsimCombatStart(request)");

  // Stub: the 3D scene. The raid code asks the scene whether a member is in melee or ranged
  // range and which areas hold targets. Everyone in the raid is in melee range of the boss.
  const sceneCalls = new Map();
  const known = {
    isCombatEntityInRange: () => true,
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
  pi.bindScenePorts(scene, inBq("W2"));

  // Observation, not a stub: every damage, heal, mana and death event the combat state records
  // passes through G2 in main, which this wrapper reads before forwarding.
  const events = [];
  main.__scope("globalThis.__raidsimG2 = G2");
  const g2 = globalThis.__raidsimG2;
  globalThis.__raidsimEvent = function (runtime, event, options) {
    events.push({ at: clock.now, ...event });
    return g2(runtime, event, options);
  };
  main.__scope("G2 = globalThis.__raidsimEvent");

  // Observation: call counters.
  const skipped = [...countCalls("engine", COUNTED.engine), ...countCalls("main", COUNTED.main), ...countCalls("bq", COUNTED.bq)];
  if (skipped.length) throw new Error(`cannot count ${skipped.join(", ")}: not function declarations`);
  const L2 = inBq("L2");
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
  const D = inMain("t1");
  D.setState({ characterProfile: { ...inMain("z6")(), ...leaderProfile(member, items, zoneId) } });
  D.getState().recalcStats();
  D.setState((st) => ({ characterProfile: { ...st.characterProfile, curHp: st.characterProfile.maxHp, mana: st.characterProfile.maxMana }, characterProfileLoaded: true }));
  const gems = member.gems.slice(0, member.cls === 8 ? 3 : 8);
  inMain("Ht").setState({
    ownerCharacterId: LEADER_ID,
    scribedSpells: member.spells.map((spellId, i) => ({ spellId, bookSlot: i, spell: c1.get(spellId) })),
    memorizedSpells: gems.map((spellId, gemSlot) => ({ gemSlot, spellId, spell: c1.get(spellId) })),
  });
  // The leader fights on auto attack, as a player in the raid view does.
  inMain("S1").setState({ isAutoAttackEnabled: true, currentZone: zoneId });
}

// How a damage event on the boss counts, by the client's `damageType`: the raid tick's own melee
// and DoT rolls, pet melee, spell damage, and weapon or item procs.
const DAMAGE_KIND = { melee: "melee", "raid-melee": "melee", "raid-pet-melee": "pet", "raid-dot": "dot", dot: "dot", spell: "nuke", proc: "proc" };

export async function runJob(job) {
  const { members, boss, items, compact, seed, maxSec, dpsMode, healMode } = job;
  main.H.hydrate(inMain("JE")(JSON.parse(compact)));
  const sc = inMain("Sc");
  for (const [name, id] of Object.entries(SKILL_IDS)) {
    if (sc[id] !== name) throw new Error(`skill ${name} is ${sc[id]} in the client, not ${id}; update SKILL_IDS in classes.mjs`);
  }
  const init = bossInit(boss);
  const stubs = installStubs({ items, init });
  const { pi, c1 } = stubs;
  Math.random = seededRandom(seed);

  const leader = members.find((m) => m.leader);
  // Raid Resolve applies in the zone of the client's Resolve bosses (`Ed` in main.pretty.js), and
  // the client reads that zone from the leader's character, so the leader stands there.
  const resolveBoss = inMain("Ed").find((entry) => entry.npcId === init.npcId);
  installLeader(leader, items, c1, resolveBoss?.zoneId ?? DEFAULT_ZONE_ID);
  // Stub: raid time. The client lets a raid start only while the account holds raid time.
  inMain("i2").setState({ scope: inMain("v5")(), loaded: true, expiresAtMs: clock.now + 1e12, clockOffsetMs: 0 });

  const rt = inEngine("rt");
  const sessionId = rt.getState().raidSessionId;
  const dr = inMain("dr");
  const built = [];
  for (const [i, spec] of members.filter((m) => !m.leader).entries()) {
    const member = await dr({ snapshot: snapshotOf(spec, 100 + i), raidSessionId: sessionId, ordinal: i + 1, loadItemById: stubs.loadItemById });
    built.push({ spec, member });
  }
  const roster = built.map((b) => b.member);
  const level = leader.level;
  rt.setState({
    roster,
    pets: inMain("K7")(roster, level, []),
    leaderLevel: level,
    nextMemberOrdinal: roster.length + 1,
    raidModeActive: true,
    isRaidOpen: true,
    playerOrder: { ...rt.getState().playerOrder, control: "raid" },
    // Stub: the roster check the client does against the server before combat.
    validatedRosterSessionId: sessionId,
  });
  rt.getState().syncRaidBuffs(level);

  const target = bossTarget(init);
  if (!rt.getState().beginCombatForTarget(target)) throw new Error("the client refused to begin raid combat (beginCombatForTarget returned false)");
  rt.getState().setAllCommand("attacking", target);
  inEngine("qd")();
  if (healMode) inEngine("XL")(healMode);
  if (dpsMode) await inEngine("gGe")(dpsMode, target);

  const startedAt = clock.now;
  const bossActorId = `npc:${init.spawnInstanceId}`;
  const bossState = () => pi.getRuntimeSnapshot().actors.find((a) => a.id === bossActorId);
  const leaderAlive = () => (inMain("t1").getState().characterProfile.curHp ?? 0) > 0;
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
  return summarize({ stubs, members, built, leader, bossActorId, bossHpLeft: b ? Math.max(0, b.hp) : 0, init, startedAt, maxSec, seed, anyAlive, rt });
}

function summarize({ stubs, members, built, leader, bossActorId, bossHpLeft, init, startedAt, maxSec, seed, anyAlive, rt }) {
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
    clockErrors: clock.errors.map((e) => String(e?.stack ?? e).split("\n").slice(0, 4).join(" | ")),
    calls: Object.fromEntries(callCounts),
    sceneCalls: Object.fromEntries(stubs.sceneCalls),
  };
}
