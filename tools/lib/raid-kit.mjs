// The raid kit: which gear swaps between the account's items and the roster's slots make the raid
// simulator's fight against one boss go better. Pure parts: the swaps that are allowed, the state a
// run of accepted swaps leaves, the roster entries of a variant and the order of outcomes. The
// search that runs fights is tools/raid-kit.mjs.
//
// A swap puts a carried copy of an item into a roster member's slot. The copy comes from the member's
// own bags or from another roster member's bags, a copy serves one swap, and a member holds one
// copy of a lore item. The item the slot held stays in the member's bags and is not offered again.
import { ARMOR_SLOTS, PRIMARY, SECONDARY, TWO_HANDED, fits, isLore, rosterPeople } from "./gear-plan.mjs";
import { offhandChance } from "./gear-data.mjs";

// The slots the raid simulator fits: armor and jewelry, and both hands. Charm, ranged and ammo stay
// empty in its kits (tools/raidsim/kits.mjs).
export const KIT_SLOTS = [...ARMOR_SLOTS.filter((s) => s !== 0), PRIMARY, SECONDARY];

// Why a carried row cannot be handed to another character (`blockReason` of the survey). A row on
// the wearer's own character needs no transfer, so any reason but "Already on this character." only
// blocks it for others.
const FREE_REASONS = new Set(["", "Already on this character."]);

/** The lore key of an item: its lore group when it has one, else the item, and null for an item without lore. */
export const loreKey = (item) => (!isLore(item) ? null : item.loregroup > 0 ? `group:${item.loregroup}` : `item:${item.id}`);

/** Whether the simulator can wear the item at all: a wearable item, not an augment, and without a deity (its characters have none). */
const wearable = (item) => item && item.itemclass === 0 && !(item.augtype > 0) && !item.deity && !(item.bagslots > 0);

/**
 * The state the swaps start from. `rows`: the account survey (`runs/state/account-items.json`),
 * `items`: item id to content row, `names`: the roster members. Returns `{ items, people, worn, copies, bags }`:
 * `people` by name (`{ name, cls, race, level }` as `fits` takes them), `worn` the item id in each slot
 * by name, `copies` the carried copies not yet used (instance id to `{ holder, itemId }`) and `bags`
 * the item ids each member carries that no swap may use again (displaced items).
 */
export function kitState({ rows, items, names }) {
  const members = new Set(names);
  const race = new Map(rows.filter((r) => r.race).map((r) => [r.characterName, r.race]));
  const people = new Map(rosterPeople(rows, members, race).map((p) => [p.name, p]));
  const worn = new Map([...people.keys()].map((n) => [n, new Map()]));
  const copies = new Map();
  for (const r of rows) {
    if (!people.has(r.characterName)) continue;
    if (r.location === "Equipped") worn.get(r.characterName).set(r.slot, r.itemId);
    else if (r.location === "Carried" && items.has(r.itemId) && wearable(items.get(r.itemId))) copies.set(r.itemInstanceId, { holder: r.characterName, itemId: r.itemId, free: FREE_REASONS.has(r.blockReason ?? "") });
  }
  return { items, people, worn, copies, bags: new Map([...people.keys()].map((n) => [n, []])) };
}

/** The lore keys a member holds: worn, in its bags (unused copies and displaced items). */
function heldLore(state, name) {
  const keys = new Set();
  const add = (id) => {
    const k = loreKey(state.items.get(id));
    if (k) keys.add(k);
  };
  for (const id of state.worn.get(name).values()) add(id);
  for (const c of state.copies.values()) if (c.holder === name) add(c.itemId);
  for (const id of state.bags.get(name)) add(id);
  return keys;
}

/**
 * The copy that serves `name` with `itemId`: its own, else another member's that can be handed over
 * and that does not give `name` a second copy of a lore item. Null when there is none.
 */
export function copyFor(state, name, itemId) {
  const key = loreKey(state.items.get(itemId));
  let other = null;
  for (const [id, c] of state.copies) {
    if (c.itemId !== itemId) continue;
    if (c.holder === name) return id;
    if (other === null && c.free) other = id;
  }
  if (other !== null && key && heldLore(state, name).has(key)) return null;
  return other;
}

/** Whether `item` may go into `slot` of `name` beside what it wears: the fit rules of the gear plan, a two-hander only with an empty off hand, and a weapon in the off hand only with Dual Wield. */
function allowed(state, person, item, slot) {
  if (!fits(item, person, slot)) return false;
  const worn = state.worn.get(person.name);
  const held = (s) => state.items.get(worn.get(s));
  if (slot === PRIMARY && TWO_HANDED.has(item.itemtype) && worn.get(SECONDARY)) return false;
  if (slot === SECONDARY && TWO_HANDED.has(held(PRIMARY)?.itemtype)) return false;
  if (slot === SECONDARY && item.damage > 0 && !(offhandChance(person.cls, person.level) > 0)) return false;
  return true;
}

/**
 * Every swap the state allows: `[{ character, slot, itemId, name, from, fromName }]`, one per
 * member, slot and item, where `from` is the item id the slot holds now (null when empty).
 */
export function candidates(state) {
  const out = [];
  const ids = [...new Set([...state.copies.values()].map((c) => c.itemId))];
  for (const person of state.people.values()) {
    const worn = state.worn.get(person.name);
    for (const itemId of ids) {
      const item = state.items.get(itemId);
      for (const slot of KIT_SLOTS) {
        if (worn.get(slot) === itemId || !allowed(state, person, item, slot) || copyFor(state, person.name, itemId) === null) continue;
        out.push({ character: person.name, slot, itemId, name: item.Name, from: worn.get(slot) ?? null, fromName: state.items.get(worn.get(slot))?.Name ?? null });
      }
    }
  }
  return out;
}

/** Takes a swap into the state: the copy that serves it is used and the displaced item stays in the member's bags. Returns the copy's holder. */
export function applySwap(state, swap) {
  const id = copyFor(state, swap.character, swap.itemId);
  if (id === null) throw new Error(`no copy of ${swap.name} for ${swap.character}`);
  const { holder } = state.copies.get(id);
  state.copies.delete(id);
  const worn = state.worn.get(swap.character);
  const displaced = worn.get(swap.slot);
  if (displaced !== undefined) state.bags.get(swap.character).push(displaced);
  worn.set(swap.slot, swap.itemId);
  return holder;
}

/** Roster entries with the swaps' items worn: a new array, only the changed entries copied. */
export function withSwaps(entries, swaps) {
  return entries.map((e) => {
    const mine = swaps.filter((s) => s.character === e.name);
    return mine.length ? { ...e, items: { ...e.items, ...Object.fromEntries(mine.map((s) => [s.slot, s.itemId])) } } : e;
  });
}

/** The outcome of a summary (`summarize` in tools/raidsim/report.mjs) as the order uses it. */
export const outcomeOf = (s) => ({ killChance: s.fights ? s.kills / s.fights : 0, killSec: s.kills ? s.killSec.mean : null, hpLeft: s.bossHpLeftMean ?? 0 });

/**
 * The order of outcomes: a higher kill chance first, then a lower mean kill time, and when neither
 * kills, less boss hit points left. Negative when `a` is better than `b`, 0 when they tie.
 */
export function compareOutcomes(a, b) {
  const x = a.killChance === undefined ? outcomeOf(a) : a;
  const y = b.killChance === undefined ? outcomeOf(b) : b;
  if (x.killChance !== y.killChance) return y.killChance - x.killChance;
  if (x.killChance > 0) return x.killSec - y.killSec;
  return x.hpLeft - y.hpLeft;
}

/** What `after` changed against `before`: kill chance and boss hit points left (positive is better for the first, negative for the second), and kill time in seconds (negative is better), null without kills on either side. */
export function outcomeDelta(before, after) {
  const x = outcomeOf(before);
  const y = outcomeOf(after);
  return { killChance: y.killChance - x.killChance, killSec: x.killSec !== null && y.killSec !== null ? Math.round((y.killSec - x.killSec) * 10) / 10 : null, hpLeft: Math.round(y.hpLeft - x.hpLeft) };
}

// What an item adds, point for point: more is never worse. Weapon delay is the one lower-is-better field.
const STAT_FIELDS = ["ac", "hp", "mana", "astr", "asta", "adex", "aagi", "aint", "awis", "acha", "mr", "fr", "cr", "dr", "pr", "attack", "haste", "regen", "manaregen", "damage", "damageshield", "avoidance", "accuracy", "spelldmg", "healamt", "shielding", "dotshielding", "strikethrough", "stunresist", "spellshield", "extradmgamt", "backstabdmg", "bardvalue"];
// Spell effects of an item (proc, click, worn, focus, bard): an effect is never traded for stats.
const EFFECT_FIELDS = ["proceffect", "clickeffect", "worneffect", "focuseffect", "bardeffect"];

/**
 * Whether the item `r` is at least as good as `a` in every stat, has every effect `a` has, and is
 * the same kind of weapon or instrument. Wearing `a` instead of `r` then cannot help in any fight.
 */
export function dominates(r, a) {
  if (STAT_FIELDS.some((f) => (r[f] ?? 0) < (a[f] ?? 0))) return false;
  if ((a.damage > 0 || r.damage > 0) && (r.itemtype !== a.itemtype || (r.delay || Infinity) > (a.delay || Infinity))) return false;
  if (a.bardvalue > 0 && r.bardtype !== a.bardtype) return false;
  return EFFECT_FIELDS.every((f) => !(a[f] > 0) || r[f] === a[f]);
}

/**
 * The swaps no other choice for the same member and slot beats in every stat: a swap is dropped when
 * the worn item or another swap's item dominates it, and of two equal items the lower id stays.
 * This needs no weights, because it only says that more of a stat never hurts.
 */
export function undominated(state, swaps) {
  const groups = new Map();
  for (const s of swaps) {
    const key = `${s.character}:${s.slot}`;
    (groups.get(key) ?? groups.set(key, []).get(key)).push(s);
  }
  const out = [];
  for (const group of groups.values()) {
    for (const s of group) {
      const item = state.items.get(s.itemId);
      const worn = state.items.get(s.from);
      if (worn && dominates(worn, item)) continue;
      const beaten = group.some((o) => {
        if (o === s) return false;
        const other = state.items.get(o.itemId);
        return dominates(other, item) && !(dominates(item, other) && o.itemId > s.itemId);
      });
      if (!beaten) out.push(s);
    }
  }
  return out;
}

/** A copy of the state that swaps can be applied to without touching the original. */
export function cloneState(state) {
  return { items: state.items, people: state.people, worn: new Map([...state.worn].map(([n, w]) => [n, new Map(w)])), copies: new Map([...state.copies].map(([id, c]) => [id, { ...c }])), bags: new Map([...state.bags].map(([n, b]) => [n, [...b]])) };
}

/**
 * Probe rounds for the screen: round `p` holds the `p`-th swap of every member, so each fight
 * changes one item per member and the members' own results tell the swaps apart.
 */
export function probeRounds(swaps) {
  const queues = new Map();
  for (const s of swaps) (queues.get(s.character) ?? queues.set(s.character, []).get(s.character)).push(s);
  const rounds = [];
  for (const queue of queues.values()) queue.forEach((s, p) => (rounds[p] ??= []).push(s));
  return rounds;
}

/** What a roster member did to the boss and for the raid in a fight: its damage plus its healing, both in hit points. */
export const memberOutput = (m) => Object.values(m.damage).reduce((a, b) => a + b, 0) + m.healed;

/**
 * A batch of swaps from `ranked` (best first): at most one per member, never into a slot a swap of
 * `kit` or the batch holds, each with a copy of its own. Returns the swaps in ranked order.
 */
export function buildBatch(state, kit, ranked, limit = Infinity) {
  const next = cloneState(state);
  const taken = new Set(kit.map((s) => `${s.character}:${s.slot}`));
  const members = new Set();
  const batch = [];
  for (const s of ranked) {
    if (batch.length >= limit) break;
    if (members.has(s.character) || taken.has(`${s.character}:${s.slot}`)) continue;
    if (!allowed(next, next.people.get(s.character), next.items.get(s.itemId), s.slot)) continue;
    if (copyFor(next, s.character, s.itemId) === null) continue;
    applySwap(next, s);
    members.add(s.character);
    batch.push(s);
  }
  return batch;
}

/** Spearman rank correlation of two equally long lists (average ranks for ties), null under three pairs or without spread. */
export function spearman(xs, ys) {
  if (xs.length !== ys.length || xs.length < 3) return null;
  const ranks = (v) => {
    const order = v.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]);
    const r = new Array(v.length);
    for (let i = 0; i < order.length; ) {
      let j = i;
      while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++;
      for (let k = i; k <= j; k++) r[order[k][1]] = (i + j) / 2;
      i = j + 1;
    }
    return r;
  };
  const a = ranks(xs);
  const b = ranks(ys);
  const mean = (r) => r.reduce((x, y) => x + y, 0) / r.length;
  const ma = mean(a);
  const mb = mean(b);
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < a.length; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return da && db ? num / Math.sqrt(da * db) : null;
}

// The goal bosses of docs/plans/raid-roster.md by npc_types id.
export const GOAL_BOSSES = [
  { name: "Cazic-Thule", npc: 72003 },
  { name: "Tunare", npc: 127098 },
  { name: "The Avatar of War", npc: 113457 },
  { name: "Vulak`Aerr", npc: 124155 },
  { name: "Lord Yelinak", npc: 114106 },
  { name: "Nanzata the Warder", npc: 128090 },
  { name: "Ventani the Warder", npc: 128091 },
  { name: "Tukaarak the Warder", npc: 128092 },
  { name: "Hraashna the Warder", npc: 128093 },
];

/** The entry of `[{ boss, summary }]` whose outcome is best by `compareOutcomes`, the first on a tie. Bosses differ in size, so the boss hit points left count as a share of the boss's. */
export const closestToKill = (rows) => {
  const share = (s) => ({ ...outcomeOf(s), hpLeft: s.bossHpLeftMean / s.bossMaxHp });
  return rows.reduce((best, r) => (compareOutcomes(share(r.summary), share(best.summary)) < 0 ? r : best));
};

/**
 * The room fights leave for chance: the standard error of the boss hit points left and of the kill
 * time over `fights`, times `factor`. Without it a swap that moves the mean by less would be taken
 * for an improvement.
 */
export function margins(fights, factor = 1) {
  const se = (xs) => {
    if (xs.length < 2) return 0;
    const m = xs.reduce((a, b) => a + b, 0) / xs.length;
    return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1) / xs.length);
  };
  return { hpLeft: factor * se(fights.map((f) => f.bossHpLeft)), killSec: factor * se(fights.filter((f) => f.outcome === "kill").map((f) => f.seconds)) };
}

/** Whether `after` beats `before` by `compareOutcomes` and, where chance or kill time decide it, by more than the `margin` of `margins`. A higher kill chance counts without a margin. */
export function improves(before, after, margin = {}) {
  const x = outcomeOf(before);
  const y = outcomeOf(after);
  if (x.killChance !== y.killChance) return y.killChance > x.killChance;
  if (x.killChance > 0) return x.killSec - y.killSec > (margin.killSec ?? 0);
  return x.hpLeft - y.hpLeft > (margin.hpLeft ?? 0);
}
