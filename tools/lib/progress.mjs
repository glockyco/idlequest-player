// Progress: the changes in what the goal measures (docs/plans/dashboard.md, "Progress"). Each kind
// is the change of one goal bar's state between two observations of it, recorded where the
// collector observes that state, so the dashboard can show what moved the bars and when:
//
//   level  a character's level, from the tab snapshots (`levelUps`)
//   gear   the items a character wears, from a gear task's equip lines (`equipProgress`) and, for what those miss, from two gear passes (`gearChanges`)
//   item   a copy of an item the account wants, from the loot lines of the tabs' event streams (`lootProgress`)
//   chain  a character that finished or started a quest chain, from two coordinator passes (`chainChanges`)
//   aa     a trained AA rank or earned AA points, from two AA states (`aaChanges`)
//   raid   a boss a raid task killed, from the bot's raid alert (`snapshotProgress`)
//
// Every detector is pure and returns events `{ t, kind, sig, name, text, item?, data, key }`, where
// `sig` is 2 for a milestone, 1 for progress and 0 for a minor step, and `key` makes an event count
// once however often it is observed. `recordProgress` stores them.

export const PROGRESS_SCHEMA = `
CREATE TABLE IF NOT EXISTS progress (
  id INTEGER PRIMARY KEY AUTOINCREMENT, t INTEGER NOT NULL, kind TEXT NOT NULL, sig INTEGER NOT NULL,
  name TEXT, grp TEXT, item TEXT, text TEXT NOT NULL, data TEXT, key TEXT NOT NULL UNIQUE);
CREATE INDEX IF NOT EXISTS progress_t ON progress (t);
`;

/** The kinds in the order the goal lists its criteria. */
export const PROGRESS_KINDS = ["level", "gear", "item", "chain", "aa", "raid"];

/** Levels that open something: AA and raids at 46, the higher spell tiers at 50 and 55, and the cap. */
export const MILESTONE_LEVELS = [46, 50, 55, 60];

/** A name for matching across the client's spellings: lowercase letters only, without a leading "the". */
export const looseName = (s) => String(s ?? "").toLowerCase().replace(/^the[\s_]+/, "").replace(/[^a-z]/g, "");

/** The boss of the raid goal (`goal`, names from data/raid-goal.json) that `name` is, or null. */
export const goalBoss = (name, goal = []) => goal.find((g) => looseName(g) === looseName(name)) ?? null;

/**
 * Store `events`, each once by its `key`, with the roster group of its character from `groupOf`
 * (name to group) unless the event names one. Returns how many were new.
 */
export function recordProgress(db, events, groupOf = new Map()) {
  if (!events.length) return 0;
  const insert = db.query("INSERT OR IGNORE INTO progress (t, kind, sig, name, grp, item, text, data, key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
  let added = 0;
  db.transaction(() => {
    for (const e of events) added += insert.run(e.t, e.kind, e.sig, e.name ?? null, e.grp ?? groupOf.get(e.name) ?? null, e.item ?? null, e.text, e.data ? JSON.stringify(e.data) : null, e.key).changes;
  })();
  return added;
}

/**
 * The leader and party members of a tab snapshot whose level is above the one last stored for them
 * (`levels`, character id to level), once each. A character without a stored level is new to the
 * collector, not one that gained a level. The attention rules and the progress feed both use it.
 */
export function levelUps(snap, levels) {
  const chars = [...(snap.leader ? [snap.leader] : []), ...(snap.party ?? []).filter((m) => m.type === 2 && m.id != null)];
  return [...new Map(chars.map((c) => [c.id, c])).values()].filter((c) => levels[c.id] != null && c.level > levels[c.id]).map((c) => ({ id: c.id, name: c.name, class: c.class ?? null, level: c.level, from: levels[c.id] }));
}

/** One event per level gained, so a character that gained two levels between looks counts both. */
export function levelEvents(ups, t) {
  return ups.flatMap((u) =>
    Array.from({ length: u.level - u.from }, (_, k) => u.from + 1 + k).map((level) => ({
      t,
      kind: "level",
      sig: MILESTONE_LEVELS.includes(level) ? 2 : 1,
      name: u.name,
      text: `${u.name} reached level ${level}`,
      data: { level, class: u.class },
      key: `level:${u.name}:${level}`,
    })),
  );
}

/**
 * The progress a tab snapshot shows: level-ups against `levels`, and raid kills from the bot's
 * alerts (`killed`). `goal` is the raid goal's boss list.
 */
export function snapshotProgress({ snap, levels, now, goal = [] }) {
  const out = levelEvents(levelUps(snap, levels), now);
  const by = snap.leader?.name ?? null;
  // A bridge reinstalled by a code update starts a new page session and the snapshot sends the
  // bot's last quarter hour of alerts again, so an alert's key is its leader and time, not its seq.
  for (const a of snap.bot?.alerts ?? []) {
    if (!a.killed) continue;
    const boss = goalBoss(a.killed, goal);
    out.push({ t: a.t, kind: "raid", sig: boss ? 2 : 1, name: by, text: `${by ?? "A raid"}'s raid killed ${a.killed}`, data: { boss: a.killed, goal: boss }, key: `raid:${by}:${a.t}` });
  }
  return out;
}

// "You loot Ink of the Dark!" names an item and "You loot 3 gold, 2 silver!" coin. A raid corpse's
// item, taken from the RAID LOOT tab, ends with a period: "You loot Kedge Backbone."
const LOOT_LINE = /^You loot (?!\d)(.+)[!.]$/;
// A copy the character cannot hold, such as a second one of a lore item, goes back to the corpse.
const RETURN_LINE = /^You return (.+) to the loot window\.$/;

/**
 * The items the account wants among a tab's new event rows (`events`, as the bridge exports them,
 * each loot line with its item's id), from their loot lines. `itemFor(item, nth)` says what the
 * copy is for, where `nth` counts the copies of the item earlier in these rows: `{ for, piece }`
 * for a copy with a named taker, `{ more }` for a further copy that `more` other characters can
 * use, or null for a copy nobody wants. `name` is the character that looted, the tab's active
 * character. A copy put back into the loot window was not looted: its row is left out, or, when
 * its loot line came with earlier rows, `unloot(item, t)` takes it back. A loot line names the
 * copy at the moment it came in, which hunts, errands and drops during leveling all produce, and
 * a later move between characters adds nothing. The key is the row's page session and sequence,
 * because a tab that switches characters can export one row into the logs of several characters.
 */
export function lootProgress({ events, name, itemFor, unloot = () => {} }) {
  const out = [];
  const seen = new Map();
  for (const e of events) {
    if (e.type !== "LOOT") continue;
    const back = RETURN_LINE.exec(e.text ?? "")?.[1];
    if (back) {
      const at = out.findLastIndex((r) => r.item === back);
      if (at < 0) unloot(back, e.t);
      else {
        out.splice(at, 1);
        seen.set(back, seen.get(back) - 1);
      }
      continue;
    }
    const item = LOOT_LINE.exec(e.text ?? "")?.[1];
    const nth = seen.get(item) ?? 0;
    const w = item ? itemFor(item, nth) : null;
    if (!w) continue;
    seen.set(item, nth + 1);
    const text = w.more ? `${name} looted another ${item}, which ${w.more} other character${w.more === 1 ? "" : "s"} can use` : `${name} looted ${item}${w.for ? ` for ${w.for}` : ""}`;
    out.push({ t: e.t, kind: "item", sig: 1, name, item, text, data: { item, itemId: e.itemId ?? null, for: w.for ?? null, piece: Boolean(w.piece) }, key: `loot:${e.ses}:${e.seq}` });
  }
  return out;
}

/**
 * The quest chains a character finished (became a holder of) or started between two chain
 * summaries of the coordinator (`chainSummary`). Nothing is reported for a chain the earlier
 * summary lacks, since its holders were not known then.
 */
export function chainChanges(before, after, t) {
  if (!before) return [];
  const out = [];
  for (const [id, c] of Object.entries(after ?? {})) {
    const b = before[id];
    if (!b) continue;
    const label = `the ${c.class} chain for ${c.reward}`;
    for (const name of c.holders) if (!b.holders.includes(name)) out.push({ t, kind: "chain", sig: 2, name, item: c.reward, text: `${name} finished ${label}`, data: { chain: id, reward: c.reward, class: c.class }, key: `chain:${id}:${name}` });
    for (const name of c.started) if (!b.started.includes(name) && !b.holders.includes(name)) out.push({ t, kind: "chain", sig: 0, name, text: `${name} started ${label}`, data: { chain: id, reward: c.reward, class: c.class, started: true }, key: `chain-start:${id}:${name}` });
  }
  return out;
}

/**
 * The upgrades a character wears since the gear pass before: `before` and `after` are
 * `{ sheets, scores }`, the slots of `gearSheets` (worn item, queued move and wanted drop per slot)
 * and the set scores of `gearPlan` (`{ now, target }`) by name. A slot counts when it holds a new
 * item that the earlier pass queued for it (its move or wanted drop, whose `gain` it then carries)
 * or when the character's set score rose, so an item that only left for someone else is not progress.
 */
export function gearChanges({ before, after, t }) {
  if (!before?.sheets) return [];
  const out = [];
  for (const [name, slots] of Object.entries(after.sheets ?? {})) {
    const old = before.sheets[name];
    if (!old) continue;
    const changed = [];
    for (const s of slots) {
      const o = old.find((x) => x.slotNum === s.slotNum);
      if (!s.worn || o?.worn?.itemId === s.worn.itemId) continue;
      const planned = [o?.move, o?.drop].find((p) => p?.itemId === s.worn.itemId);
      changed.push({ slot: s.slot, item: s.worn.name, itemId: s.worn.itemId, was: o?.worn?.name ?? null, wasId: o?.worn?.itemId ?? null, gain: planned?.gain ?? null });
    }
    if (!changed.length) continue;
    const sb = before.scores?.[name];
    const sa = after.scores?.[name];
    const rose = sb && sa && sa.now > sb.now;
    const planned = changed.filter((c) => c.gain > 0);
    if (!rose && !planned.length) continue;
    const shown = rose ? changed : planned;
    out.push({ t, kind: "gear", sig: 1, name, text: `${name} wears ${shown.map((c) => `${c.item} (${c.slot})`).join(", ")}`, data: { slots: shown, score: sb && sa ? { before: sb.now, after: sa.now, target: sa.target } : null }, key: `gear:${name}:${t}` });
  }
  return out;
}

// A transfer that equips, as a gear task's moves do, logs "Tagujazolu equips Club of the Ice Ocean."
const EQUIP_LINE = /^(\S+) equips (.+)\.$/;

/**
 * The planned moves a tab's new event rows show carried out: an equip line whose character has
 * the item as the queued move of a slot in `sheets` (the slots of `gearSheets`). The event carries
 * the time of the line, the move's `gain` and `task`, the start of the gear task that ran it, by
 * which the feed puts one task's upgrades into one row. An equip the plan did not queue is left to
 * `gearChanges`, which knows whether it raised the set score.
 */
export function equipProgress({ events, sheets, task = null }) {
  const out = [];
  for (const e of events) {
    const [, name, item] = (e.type === "SYSTEM" ? EQUIP_LINE.exec(e.text ?? "") : null) ?? [];
    const s = sheets?.[name]?.find((x) => x.move?.item === item);
    if (!s) continue;
    out.push({ t: e.t, kind: "gear", sig: 1, name, text: `${name} wears ${item} (${s.slot})`, data: { slots: [{ slot: s.slot, item, itemId: s.move.itemId, was: s.worn?.name ?? null, wasId: s.worn?.itemId ?? null, gain: s.move.gain ?? null }], score: null, task }, key: `equip:${e.ses}:${e.seq}` });
  }
  return out;
}

/** `sheets` with the upgrades of `equipProgress` worn and their moves done, so the next gear pass finds nothing new in those slots. */
export function wornSheets(sheets, equips) {
  const done = new Map(equips.flatMap((e) => e.data.slots.map((s) => [`${e.name}:${s.slot}:${s.itemId}`, s])));
  return Object.fromEntries(Object.entries(sheets).map(([name, slots]) => [name, slots.map((x) => (done.has(`${name}:${x.slot}:${x.move?.itemId}`) ? { ...x, worn: { itemId: x.move.itemId, name: x.move.item }, move: null } : x))]));
}

/**
 * AA ranks a character trained and points it earned between two AA states (the meta key `aa`, by
 * name: `ranks` by ability id, `points` unspent, `spent`, `names` by ability id), one event per rank.
 */
export function aaChanges(before, after, t) {
  const out = [];
  for (const [name, s] of Object.entries(after ?? {})) {
    const b = before?.[name];
    if (!b) continue;
    for (const [id, rank] of Object.entries(s.ranks ?? {})) {
      for (let r = Number(b.ranks?.[id] ?? 0) + 1; r <= Number(rank); r++) {
        const ability = s.names?.[id] ?? `ability ${id}`;
        out.push({ t, kind: "aa", sig: 1, name, text: `${name} trained ${ability} to rank ${r}`, data: { ability, id, rank: r }, key: `aa:${name}:${id}:${r}` });
      }
    }
    const earned = (s.points ?? 0) + (s.spent ?? 0);
    if (earned > (b.points ?? 0) + (b.spent ?? 0)) out.push({ t, kind: "aa", sig: 0, name, text: `${name} earned AA points (${s.points ?? 0} unspent)`, data: { earned, points: s.points ?? 0 }, key: `aa-points:${name}:${earned}` });
  }
  return out;
}

/**
 * What moved each goal bar since `since`, by kind: levels gained, gear slots upgraded, wanted items
 * got, quest chains finished, AA ranks trained and raid kills. Minor steps do not count.
 */
export function progressCounts(db, since) {
  const out = Object.fromEntries(PROGRESS_KINDS.map((k) => [k, 0]));
  for (const r of db.query("SELECT kind, data FROM progress WHERE t >= ? AND sig >= 1").all(since)) out[r.kind] += r.kind === "gear" ? (JSON.parse(r.data ?? "{}").slots?.length ?? 1) : 1;
  return out;
}
