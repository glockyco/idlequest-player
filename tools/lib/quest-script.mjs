// The quest script analyzer (docs/plans/epic-model.md, "Steps from the scripts"): one NPC script of
// the content snapshot as its events, each event as branches with the conditions that lead to them
// and the actions they take, read from the script's syntax tree. A condition or an action the
// analyzer cannot classify stays as `unread` with its line, which the epic check lists.
import luaparse from "luaparse";

/** The script events by their Lua function names. */
export const EVENTS = {
  event_say: "say",
  event_trade: "trade",
  event_spawn: "spawn",
  event_timer: "timer",
  event_death: "death",
  event_death_complete: "death",
  event_signal: "signal",
  event_combat: "combat",
  event_enter: "enter",
  event_waypoint_arrive: "waypoint",
  event_hp: "hp",
  event_loot: "loot",
  event_click_door: "door",
  event_enter_zone: "enterZone",
  event_slay: "slay",
};

// Statement calls that change nothing the epic model follows: speech, emotes, faction, combat
// tuning, movement, and the trade's return of unmatched items.
const IGNORED = /^(e\.self|e\.other|npc|client|mob|el|eq\.get_entity_list\(\))[:.](Say|QuestSay|Emote|Shout|Message|Ding|Faction|GiveCash|CastSpell|SpellFinished|CastedSpellFinished|SetSpecialAbility|ModSkillDmgTaken|ModifyNPCStat|SetRunning|MoveTo|GotoBind|CastToNPC|SetAppearance|WipeHateList|SetHP|SetOOCRegen|GMMove|ProcessMovement|SetTexture|SetRace|SetGender|SetSize|Stun|SetInvul|SetPseudoRoot|StopTimer|ResumeTimer|PauseTimer|Heal|SetBodyType|ChangeSize|AssignToInstance|SetEntityVariable|SignalClient|SetNPCFactionID|CameraEffect|SendIllusionPacket|RemoveAllNimbusEffects|SetHeading|SaveGuardSpot|SetLevel|DoAnim|SendAppearanceEffect|SetFlyMode|SetSlotTint|SetTarget|MovePC|SetGlobal|AddLootTable|TempName|ClearSpecialAbilities|NPCSpecialAttacks|SetFollowID|SetPetSpellID|BuffFadeAll)$|^eq\.(zone_emote|local_emote|GM_Message|debug|set_proximity|clear_proximity|start|stop|resume|pause|moveto|set_anim|follow|stop_follow|update_spawn_timer|world_emote|enable_spawn2|disable_spawn2|get_qglobals|say_link|ChooseRandom|set_next_hp_event|set_next_inc_hp_event|register_npc_event|unregister_npc_event|repop_zone|toggle_spawn_event|get_entity_list|depop_with_timer|set_data|get_data|clear_spawn_timers|get_zone_short_name|attack|spawn_condition|modify_npc_stat|set_proximity_range|pause_timer|resume_timer)$|^(item_lib|items|lib)\.return_items$|^(string|math|table)\./;

// The client's class numbers, which `GetClass()` compares against and a spell's `classes1` to `classes14` use.
export const CLASS_BY_NUMBER = { 1: "Warrior", 2: "Cleric", 3: "Paladin", 4: "Ranger", 5: "Shadow Knight", 6: "Druid", 7: "Monk", 8: "Bard", 9: "Rogue", 10: "Shaman", 11: "Necromancer", 12: "Wizard", 13: "Magician", 14: "Enchanter" };

const valueOf = (node, locals, depth = 0) => {
  if (!node || depth > 4) return null;
  if (node.type === "NumericLiteral") return node.value;
  if (node.type === "StringLiteral") return node.value;
  if (node.type === "BooleanLiteral") return node.value;
  if (node.type === "UnaryExpression" && node.operator === "-" && node.argument.type === "NumericLiteral") return -node.argument.value;
  if (node.type === "Identifier" && locals.has(node.name)) return valueOf(locals.get(node.name), locals, depth + 1);
  return null;
};

// A call's dotted name: `e.message:findi`, `item_lib.check_turn_in`, `eq.spawn2`.
const nameOf = (node) => {
  if (!node) return "?";
  if (node.type === "Identifier") return node.name;
  if (node.type === "MemberExpression") return `${nameOf(node.base)}${node.indexer}${node.identifier.name}`;
  if (node.type === "CallExpression") return `${nameOf(node.base)}()`;
  if (node.type === "IndexExpression") return `${nameOf(node.base)}[]`;
  return node.type;
};

const fieldsOf = (table, locals) => {
  const out = {};
  for (const f of table?.fields ?? []) {
    if (f.type === "TableKeyString") out[f.key.name] = valueOf(f.value, locals);
    else if (f.type === "TableKey") out[valueOf(f.key, locals)] = valueOf(f.value, locals);
  }
  return out;
};

/** Whether value `a` passes the test `op` against `b` the way Lua compares, "truthy" and "falsy" for a bare test. */
export const meets = (op, a, b) => {
  if (op === "truthy") return a != null && a !== false;
  if (op === "falsy") return a == null || a === false;
  if (op === "==") return a === b;
  if (op === "~=") return a !== b;
  if (typeof a !== "number" || typeof b !== "number") return false;
  return op === ">" ? a > b : op === ">=" ? a >= b : op === "<" ? a < b : op === "<=" ? a <= b : false;
};

// The item inputs of a `check_turn_in` table, `{ item1 = 20373 }` and `{[20373] = 2}`, and its coin.
const tradeOf = (table, locals) => {
  const items = {};
  const coin = {};
  for (const [k, v] of Object.entries(fieldsOf(table, locals))) {
    if (/^item\d+$/.test(k) && v) items[v] = (items[v] ?? 0) + 1;
    else if (/^\d+$/.test(k)) items[k] = (items[k] ?? 0) + Number(v ?? 1);
    else if (["platinum", "gold", "silver", "copper"].includes(k) && v) coin[k] = v;
  }
  return { items, ...(Object.keys(coin).length ? { coin } : {}) };
};

/**
 * Parse one script, `text`, into `{ events, functions, unread }`: `events` maps an event (`EVENTS`)
 * to its branches, each `{ when, actions, line }`. `when` lists the conditions every enclosing
 * `if` puts on the branch, each one of:
 * `{ say: [keyword] }`, `{ trade: { items, coin? } }`, `{ class: name }`, `{ flag, op, value }`,
 * `{ spell: id }`, `{ random: text, p? }` with `p` the chance of a roll the analyzer reads,
 * `{ faction: text }`, `{ time: text }` for a window of the zone's hour, `{ npcType: id }` for a
 * branch that runs only for one of the script's NPCs,
 * `{ var, op, value, initial }` for a test of a script variable (`op` "truthy" or "falsy" for a bare
 * test), `{ never: text }` for a test no value the event gives can pass, `{ otherwise: true }` for
 * an else branch, `{ any: [conditions] }` for an `or`, whose parts are `{ all: [conditions] }`
 * where a part has several, or `{ unread: text }`.
 * Actions are `{ give: [itemId] }` (one of them when the script chooses at random), `{ exp }`,
 * `{ spawn: npcId }`, `{ setFlag, value }`, `{ deleteFlag }`, `{ setVar, value }`, `{ setTimer, ms }`,
 * `{ stopTimer }`, `{ signal: npcId, n }`, `{ attack: true }`, `{ depop: true }` or `{ unread: text }`.
 */
export function parseScript(text) {
  const ast = luaparse.parse(text, { luaVersion: "5.1", encodingMode: "pseudo-latin1", locations: true, ranges: true });
  const src = (node) => text.slice(node.range[0], node.range[1]).replace(/\s+/g, " ").slice(0, 160);
  const functions = new Map();
  for (const s of ast.body) {
    if (s.type === "FunctionDeclaration" && s.identifier) functions.set(nameOf(s.identifier), s);
  }
  const unread = [];

  // Variables. A top-level variable holding a literal that a function assigns is a script variable,
  // such as `local spawn_trakanon = false`, which a trade sets and a death tests, and the rest of
  // the top-level literals are constants the events read. A variable an event declares with a
  // literal is the event's own, such as Tykar Renlin's `morechampagne`: `assigned` keeps, for the
  // event being read, each value it gives such a variable with the conditions it gives it under.
  const isLiteral = (n) => !!n && (["NumericLiteral", "StringLiteral", "BooleanLiteral", "NilLiteral"].includes(n.type) || (n.type === "UnaryExpression" && n.operator === "-" && n.argument.type === "NumericLiteral"));
  const literalOf = (n) => (n == null || n.type === "NilLiteral" ? null : valueOf(n, new Map()));
  const visit = (node, f) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach((x) => visit(x, f));
    if (node.type) f(node);
    for (const k in node) if (k !== "loc" && k !== "range") visit(node[k], f);
  };
  // A variable a function also gives a computed value, such as a counter's `n = n + 1`, has values
  // the analyzer cannot list, so a test of it stays unread.
  const reassigned = new Set();
  const computed = new Set();
  for (const fn of functions.values()) {
    visit(fn.body, (n) => n.type === "AssignmentStatement" && n.variables.forEach((v, k) => v.type === "Identifier" && (isLiteral(n.init[k]) ? reassigned : computed).add(v.name)));
  }
  const scriptVars = new Map();
  const constants = new Map();
  for (const s of ast.body) {
    if (s.type !== "LocalStatement" && s.type !== "AssignmentStatement") continue;
    s.variables.forEach((v, k) => {
      if (v.type !== "Identifier" || !isLiteral(s.init[k]) || computed.has(v.name)) return;
      if (reassigned.has(v.name)) scriptVars.set(v.name, literalOf(s.init[k]));
      else constants.set(v.name, s.init[k]);
    });
  }
  let assigned = new Map();
  // A test of a variable, or null for another name. An event's own variable stands for the
  // conditions of the assignments that give it a passing value, and nothing when its declared value
  // passes. A script variable is a condition on the script's state, which other branches set.
  const varTest = (name, op, value, node) => {
    if (assigned.has(name)) {
      const values = assigned.get(name);
      if (values.some((x) => x.computed)) return [{ unread: src(node), line: node.loc.start.line }];
      const passing = values.filter((x) => meets(op, x.value, value));
      if (!passing.length) return [{ never: src(node), line: node.loc.start.line }];
      if (passing.some((x) => x.declared)) return [];
      if (passing.length === 1) return passing[0].when;
      return [{ any: passing.map((x) => ({ all: x.when })) }];
    }
    if (scriptVars.has(name)) return [{ var: name, op, value, initial: scriptVars.get(name), line: node.loc.start.line }];
    return null;
  };

  // A test of a random roll, `local roll = math.random(100); if (roll <= 80)`: the roll's name, its
  // range of whole numbers and the values that pass, or null for another condition.
  const rollTest = (c, locals) => {
    if (c?.type !== "BinaryExpression" || c.right.type !== "NumericLiteral") return null;
    const call = c.left.type === "Identifier" && locals.has(c.left.name) ? locals.get(c.left.name) : c.left;
    if (call?.type !== "CallExpression" || nameOf(call.base) !== "math.random") return null;
    const args = call.arguments.map((a) => valueOf(a, locals));
    if (!args.length || args.some((a) => !Number.isInteger(a))) return null;
    const [lo, hi] = args.length === 1 ? [1, args[0]] : args;
    if (!(hi >= lo) || hi - lo > 100000) return null;
    const values = [];
    for (let v = lo; v <= hi; v++) if (meets(c.operator, v, c.right.value)) values.push(v);
    return { name: src(c.left), size: hi - lo + 1, values };
  };

  const conditionsOf = (c, locals) => {
    if (!c) return [];
    if (c.type === "LogicalExpression" && c.operator === "and") return [...conditionsOf(c.left, locals), ...conditionsOf(c.right, locals)];
    if (c.type === "LogicalExpression" && c.operator === "or") {
      const parts = [c.left, c.right].map((x) => conditionsOf(x, locals));
      if (parts.every((p) => p.length === 1 && p[0].say)) return [{ say: parts.flatMap((p) => p[0].say) }];
      return [{ any: parts.map((p) => (p.length === 1 ? p[0] : { all: p })) }];
    }
    if (c.type === "Identifier") {
      const test = varTest(c.name, "truthy", null, c);
      if (test) return test;
      if (locals.has(c.name)) return conditionsOf(locals.get(c.name), locals);
    }
    if (c.type === "CallExpression") {
      const n = nameOf(c.base);
      if (/^e\.message:findi?$/.test(n)) return [{ say: [valueOf(c.arguments[0], locals)] }];
      if (/check_turn_in$/.test(n) || n === "eq.handin") return [{ trade: tradeOf(c.arguments.find((a) => a.type === "TableConstructorExpression"), locals) }];
      if (/:HasItem$/.test(n)) return [{ has: valueOf(c.arguments[0], locals) }];
      if (/:HasSpellScribed$/.test(n)) return [{ spell: valueOf(c.arguments[0], locals) }];
      if (/:IsMobSpawnedByNpcTypeID$/.test(n)) return [{ spawned: valueOf(c.arguments[0], locals) }];
    }
    if (c.type === "MemberExpression" && nameOf(c) === "e.joined") return [{ combat: true }];
    if (c.type === "UnaryExpression" && c.operator === "not" && c.argument.type === "MemberExpression" && nameOf(c.argument) === "e.joined") return [{ combat: false }];
    if (c.type === "UnaryExpression" && c.operator === "not" && c.argument.type === "Identifier") {
      const test = varTest(c.argument.name, "falsy", null, c);
      if (test) return test;
    }
    if (c.type === "UnaryExpression" && c.operator === "not") {
      const inner = conditionsOf(c.argument, locals);
      return inner.length === 1 && !inner[0].unread ? [{ not: inner[0] }] : [{ unread: src(c), line: c.loc.start.line }];
    }
    if (c.type === "BinaryExpression") {
      const { left, right, operator: op } = c;
      if (left.type === "Identifier" && isLiteral(right)) {
        const test = varTest(left.name, op, literalOf(right), c);
        if (test) return test;
      }
      const lhs = left.type === "Identifier" && locals.has(left.name) ? locals.get(left.name) : left;
      const ln = nameOf(lhs.type === "CallExpression" ? lhs.base : lhs);
      const rv = valueOf(right, locals);
      // The zone's hour: `local time = eq.get_zone_time(); local hour = time["zone_hour"]`.
      const zoneHour = (x, depth = 0) => {
        if (!x || depth > 4) return false;
        if (x.type === "Identifier") return locals.has(x.name) && zoneHour(locals.get(x.name), depth + 1);
        if (x.type === "IndexExpression" || x.type === "MemberExpression") return zoneHour(x.base, depth + 1);
        return x.type === "CallExpression" && nameOf(x.base) === "eq.get_zone_time";
      };
      if (zoneHour(left) || zoneHour(right)) return [{ time: src(c) }];
      if (ln === "e.timer" && op === "==") return [{ timer: rv }];
      if (ln === "e.signal" && op === "==") return [{ signal: rv }];
      if (ln === "e.wp" && op === "==") return [{ waypoint: rv }];
      if (ln === "e.hp_event" && op === "==") return [{ hpEvent: rv }];
      if (/:(Class|GetClassName)$/.test(ln) && op === "==") return [{ class: rv }];
      if (/:GetClass$/.test(ln) && op === "==") return [{ class: CLASS_BY_NUMBER[rv] ?? rv }];
      if (/:GetNPCTypeID$/.test(ln) && op === "==") return [{ npcType: rv }];
      if (/:(GetBaseRace|GetRace)$/.test(ln) && op === "==") return [{ race: rv }];
      if (/:GetLevel$/.test(ln)) return [{ level: [op, rv] }];
      if (/:Get\w*Faction/.test(ln)) return [{ faction: src(c) }];
      if (/random/.test(ln) || (lhs.type === "Identifier" && /^ran/.test(lhs.name))) {
        const roll = rollTest(c, locals);
        return [{ random: src(c), ...(roll ? { p: roll.values.length / roll.size } : {}) }];
      }
      // A quest flag: `qglobals["name"]` or `qglobals.name`, also through tonumber().
      const flagOf = (x) => {
        const y = x.type === "CallExpression" && nameOf(x.base) === "tonumber" ? x.arguments[0] : x;
        if (y.type === "IndexExpression" && /qglobals/.test(nameOf(y.base))) return valueOf(y.index, locals);
        if (y.type === "MemberExpression" && /qglobals/.test(nameOf(y.base))) return y.identifier.name;
        return null;
      };
      const flag = flagOf(lhs);
      if (flag != null) return [{ flag, op, value: rv }];
    }
    if ((c.type === "IndexExpression" || c.type === "MemberExpression") && /qglobals/.test(nameOf(c.base))) {
      return [{ flag: c.type === "IndexExpression" ? valueOf(c.index, locals) : c.identifier.name, op: "~=", value: null }];
    }
    return [{ unread: src(c), line: c.loc.start.line }];
  };

  const actionOf = (call, locals) => {
    // A method chained on a call's result, such as `eq.spawn2(...):AddToHateList(e.other, 1)`: the
    // inner call acts, and of the outer method only an attack on the player matters.
    if (call.base.type === "MemberExpression" && call.base.base.type === "CallExpression") {
      return [...actionOf(call.base.base, locals), ...(/^(AddToHateList|Attack)$/.test(call.base.identifier.name) ? [{ attack: true }] : [])];
    }
    const n = nameOf(call.base);
    const arg = (k) => valueOf(call.arguments[k], locals);
    if (/:SummonItem$/.test(n)) {
      const a = call.arguments[0];
      if (a?.type === "CallExpression" && /ChooseRandom$/.test(nameOf(a.base))) return [{ give: a.arguments.map((x) => valueOf(x, locals)).filter((x) => x != null) }];
      const id = arg(0);
      return id != null ? [{ give: [id] }] : [{ unread: src(call), line: call.loc.start.line }];
    }
    if (/:QuestReward$/.test(n)) {
      const table = call.arguments.find((a) => a.type === "TableConstructorExpression");
      if (table) {
        const f = fieldsOf(table, locals);
        const items = [f.itemid, ...(table.fields.find((x) => x.key?.name === "items")?.value?.fields ?? []).map((x) => valueOf(x.value, locals))].filter((x) => x > 0);
        return [...items.map((id) => ({ give: [id] })), ...(f.exp > 0 ? [{ exp: f.exp }] : [])];
      }
      // QuestReward(e.self, copper, silver, gold, platinum, itemid, exp)
      const id = arg(5);
      const exp = arg(6);
      return [...(id > 0 ? [{ give: [id] }] : []), ...(exp > 0 ? [{ exp }] : [])];
    }
    if (/:AddEXP$/.test(n)) return [{ exp: arg(0) }];
    if (/^eq\.(spawn2|unique_spawn)$/.test(n)) return [{ spawn: arg(0) }];
    if (n === "eq.set_global") return [{ setFlag: arg(0), value: arg(1) }];
    if (n === "eq.delete_global") return [{ deleteFlag: arg(0) }];
    if (n === "eq.set_timer") return [{ setTimer: arg(0), ms: arg(1) }];
    if (n === "eq.stop_timer") return [{ stopTimer: arg(0) }];
    if (n === "eq.signal") return [{ signal: arg(0), n: arg(1) }];
    if (/:(AddToHateList|Attack)$/.test(n) || n === "eq.attack") return [{ attack: true }];
    if (n === "eq.depop" || n === "eq.depop_all" || /:Depop$/.test(n)) return [{ depop: true }];
    if (IGNORED.test(n)) return [];
    return [{ unread: src(call), line: call.loc.start.line }];
  };

  // The branches of a block: the block's own actions under `when`, and each `if` clause's under its
  // conditions as well. A call to a function of the same script reads that function's body in
  // place, up to three calls deep.
  const branchesOf = (body, when, locals, depth = 0) => {
    const out = [];
    const here = { when, actions: [], line: body[0]?.loc.start.line ?? 0 };
    out.push(here);
    for (const s of body) {
      if (s.type === "LocalStatement" || s.type === "AssignmentStatement") {
        s.variables.forEach((v, k) => {
          if (v.type !== "Identifier") return;
          const init = s.init[k];
          if (s.type === "LocalStatement" && (init == null || isLiteral(init))) assigned.set(v.name, [{ value: literalOf(init), when, declared: true }]);
          else if (s.type === "AssignmentStatement" && assigned.has(v.name)) assigned.get(v.name).push(isLiteral(init) ? { value: literalOf(init), when } : { computed: true });
          else if (s.type === "AssignmentStatement" && isLiteral(init) && scriptVars.has(v.name)) here.actions.push({ setVar: v.name, value: literalOf(init) });
          if (init) locals.set(v.name, init);
        });
        // A call whose result a script keeps, such as `local mob = eq.spawn2(...)`, still acts. Its
        // other calls are lookups, such as `e.self:GetX()`, which change nothing.
        for (const init of s.init) if (init?.type === "CallExpression") here.actions.push(...actionOf(init, locals).filter((a) => !a.unread));
      } else if (s.type === "CallStatement") {
        const call = s.expression;
        const local = functions.get(nameOf(call.base));
        if (local && depth < 3) out.push(...branchesOf(local.body, when, new Map(locals), depth + 1));
        else here.actions.push(...actionOf(call, locals));
      } else if (s.type === "IfStatement") {
        // Clauses that test one random roll split its values: each takes those it passes that no
        // clause before it took, and an else takes the rest.
        let roll = null;
        const taken = new Set();
        for (const clause of s.clauses) {
          let cond;
          if (clause.type === "ElseClause") {
            cond = [{ otherwise: true }, ...(roll ? [{ random: `the rest of ${roll.name}`, p: (roll.size - taken.size) / roll.size }] : [])];
          } else {
            cond = conditionsOf(clause.condition, locals);
            const r = rollTest(clause.condition, locals);
            if (r && (!roll || roll.name === r.name)) {
              roll ??= r;
              const fresh = r.values.filter((v) => !taken.has(v));
              for (const v of fresh) taken.add(v);
              cond = cond.map((x) => (x.random != null ? { ...x, p: fresh.length / r.size } : x));
            }
          }
          out.push(...branchesOf(clause.body, [...when, ...cond], new Map(locals), depth));
        }
      } else if (["ForNumericStatement", "ForGenericStatement", "WhileStatement", "RepeatStatement", "DoStatement"].includes(s.type)) {
        out.push(...branchesOf(s.body, when, new Map(locals), depth));
      }
    }
    return out.filter((b) => b.actions.length);
  };

  const events = {};
  for (const [name, fn] of functions) {
    const event = EVENTS[name];
    if (!event) continue;
    assigned = new Map();
    const branches = branchesOf(fn.body, [], new Map(constants));
    for (const b of branches) {
      for (const c of b.when) if (c.unread) unread.push({ event, line: c.line, text: c.unread });
      for (const a of b.actions) if (a.unread) unread.push({ event, line: a.line, text: a.unread });
    }
    events[event] = [...(events[event] ?? []), ...branches];
  }
  return { events, unread };
}

/**
 * The NPC a script file belongs to, from its path under `effective/quests`: `{ zone, npc, npcId }`.
 * File names encode a leading `#` as `%23`, and a script named by number belongs to that NPC id. A
 * trailing underscore, as in `Spirit_Sentinel_.lua`, is no part of the name.
 */
export function scriptOwner(path) {
  const [zone, file] = path.split("/");
  const base = decodeURIComponent(file.replace(/\.lua$/, "")).replace(/^#/, "");
  return /^\d+$/.test(base) ? { zone, npc: null, npcId: Number(base) } : { zone, npc: base.replace(/_/g, " ").trim(), npcId: null };
}
