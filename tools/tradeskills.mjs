// The cheapest way to raise a tradeskill with ingredients the crafting catalog sells, and what each
// recipe of the skill needs.
//
//   bun tools/tradeskills.mjs <skill> [--from 0] [--to 175] [--stat 100] [--recipes] [--json]
//   skill: baking brewing tailoring blacksmithing fletching jewelry pottery tinkering research alchemy poison fishing
//
// Reads the content snapshot (tools/lib/content.mjs): the Advanced window's recipes of the skill
// (`show_in_advanced`), their components (containers left out, because the server crafts without
// one) and the catalog's prices (`crafting_merchant_items`, copper). A component the catalog does not
// sell counts as bought when a catalog-only recipe of any skill makes it, at that recipe's cost per
// success over its yield, and otherwise the recipe is listed as needing it.
//
// The ladder walks from --from to --to and at each skill point takes the recipe whose trivial lies
// above it with the lowest expected cost per skill-up. Success below trivial follows EQEmu's rule,
// which matched the measured attempts (docs/plans/systems-research.md, section 2): skill - trivial
// + 66 percent below trivial 68, skill - 0.75 * trivial + 51.5 above, at least 5 and at most 95.
// The skill-up chance per attempt is EQEmu's, not yet measured here: (stat - 15) / rate, at least
// 2.5%, halved after a failure, times 100% below skill 15, (200 - skill) / 2 percent to 174 and
// 12.5 - 0.08 * (skill - 175) percent above, where stat is the crafter's higher of INT and WIS
// (STR for Blacksmithing, DEX for Fletching and Make Poison) and rate the skill's rate below.
import { rows } from "./lib/content.mjs";

const SKILLS = {
  fishing: { id: 55, rate: 2 },
  poison: { id: 56, rate: 2, stat: "dex" },
  tinkering: { id: 57, rate: 2 },
  research: { id: 58, rate: 1 },
  alchemy: { id: 59, rate: 2 },
  baking: { id: 60, rate: 2 },
  tailoring: { id: 61, rate: 2 },
  blacksmithing: { id: 63, rate: 2, stat: "str" },
  fletching: { id: 64, rate: 2, stat: "dex" },
  brewing: { id: 65, rate: 3 },
  jewelry: { id: 68, rate: 2 },
  pottery: { id: 69, rate: 4 },
};

/** Chance in [0.05, 0.95] that an attempt at `skill` succeeds on a recipe of `trivial`. */
export const successChance = (skill, trivial) => {
  const p = skill >= trivial ? 95 : trivial < 68 ? skill - trivial + 66 : skill - 0.75 * trivial + 51.5;
  return Math.min(95, Math.max(5, p)) / 100;
};

/** EQEmu's chance that an attempt at `skill` below trivial raises it, after a success or a failure. */
export const skillUpChance = (skill, { stat = 100, rate = 2, failed = false } = {}) => {
  const first = Math.max(0.025, (stat - 15) / (rate * (failed ? 2 : 1)) / 100);
  const second = skill < 15 ? 1 : skill < 175 ? (200 - skill) / 200 : Math.max(0, 12.5 - 0.08 * (skill - 175)) / 100;
  return Math.min(1, first) * second;
};

/** Every recipe of skill `id` with its cost per attempt in copper, or the components no source sells. */
export async function recipesOf(id, root) {
  const price = new Map();
  for await (const c of rows("crafting_merchant_items", root)) price.set(c.item_id, c.price);
  const recipes = new Map();
  for await (const r of rows("tradeskill_recipe", root)) if (r.enabled && r.show_in_advanced) recipes.set(r.id, { id: r.id, name: r.name, skill: r.tradeskill, trivial: r.trivial, nofail: Boolean(r.nofail), parts: [], yields: [] });
  for await (const e of rows("tradeskill_recipe_entries", root)) {
    const r = recipes.get(e.recipe_id);
    if (!r || e.iscontainer) continue;
    if (e.componentcount > 0) r.parts.push({ item: e.item_id, n: e.componentcount });
    if (e.successcount > 0) r.yields.push({ item: e.item_id, n: e.successcount });
  }
  const direct = (r) => (r.parts.every((p) => price.has(p.item)) ? r.parts.reduce((a, p) => a + price.get(p.item) * p.n, 0) : null);
  // A component made by a catalog-only recipe costs that recipe's price per success over its yield.
  const made = new Map();
  for (const r of recipes.values()) {
    const c = direct(r);
    if (c == null) continue;
    for (const y of r.yields) {
      const per = c / y.n / (r.nofail ? 1 : successChance(r.trivial, r.trivial));
      if (!made.has(y.item) || made.get(y.item).cost > per) made.set(y.item, { cost: per, via: r.name });
    }
  }
  const names = new Map();
  const want = new Set([...recipes.values()].filter((r) => r.skill === id).flatMap((r) => r.parts.map((p) => p.item)));
  for await (const it of rows("items", root)) if (want.has(it.id)) names.set(it.id, it.Name);
  return [...recipes.values()]
    .filter((r) => r.skill === id && r.trivial > 0)
    .map((r) => {
      let cost = 0;
      const missing = [];
      const via = [];
      for (const p of r.parts) {
        if (price.has(p.item)) cost += price.get(p.item) * p.n;
        else if (made.has(p.item)) {
          cost += made.get(p.item).cost * p.n;
          via.push(made.get(p.item).via);
        } else missing.push(names.get(p.item) ?? String(p.item));
      }
      return { id: r.id, name: r.name, trivial: r.trivial, nofail: r.nofail, cost: missing.length ? null : cost, missing, via };
    })
    .sort((a, b) => a.trivial - b.trivial);
}

/** Segments of the cheapest catalog ladder from `from` to `to`: `[{ from, to, recipe, attempts, copper }]`. */
export function ladder(recipes, { from = 0, to = 175, stat = 100, rate = 2 } = {}) {
  const usable = recipes.filter((r) => r.cost != null && !r.nofail);
  const out = [];
  for (let s = from; s < to; s++) {
    let best = null;
    for (const r of usable.filter((x) => x.trivial > s)) {
      const p = successChance(s, r.trivial);
      const up = p * skillUpChance(s, { stat, rate }) + (1 - p) * skillUpChance(s, { stat, rate, failed: true });
      const each = r.cost / up;
      if (!best || each < best.each) best = { r, attempts: 1 / up, each };
    }
    if (!best) return { segments: out, stuck: s };
    const last = out.at(-1);
    if (last?.recipe.id === best.r.id) {
      last.to = s + 1;
      last.attempts += best.attempts;
      last.copper += best.each;
    } else out.push({ from: s, to: s + 1, recipe: best.r, attempts: best.attempts, copper: best.each });
  }
  return { segments: out, stuck: null };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = (k, d) => (args.includes(`--${k}`) ? Number(args[args.indexOf(`--${k}`) + 1]) : d);
  const name = args.find((a) => !a.startsWith("--") && !/^\d+$/.test(a));
  const sk = SKILLS[name];
  if (!sk) {
    console.error(`usage: bun tools/tradeskills.mjs <${Object.keys(SKILLS).join("|")}> [--from 0] [--to 175] [--stat 100] [--recipes] [--json]`);
    process.exit(1);
  }
  const recipes = await recipesOf(sk.id);
  const plan = ladder(recipes, { from: flag("from", 0), to: flag("to", 175), stat: flag("stat", 100), rate: sk.rate });
  if (args.includes("--json")) {
    console.log(JSON.stringify({ recipes, plan }, null, 1));
    process.exit(0);
  }
  const pp = (c) => (c / 1000).toFixed(c < 10000 ? 2 : 0);
  if (args.includes("--recipes")) {
    for (const r of recipes) console.log(`${String(r.trivial).padStart(4)}  ${r.name} (${r.id})  ${r.cost != null ? `${pp(r.cost)} pp${r.via.length ? ` via ${r.via.join(", ")}` : ""}` : `needs ${r.missing.join(", ")}`}${r.nofail ? "  no-fail" : ""}`);
    console.log("");
  }
  let total = { attempts: 0, copper: 0 };
  for (const g of plan.segments) {
    total.attempts += g.attempts;
    total.copper += g.copper;
    console.log(`${String(g.from).padStart(3)} to ${String(g.to).padEnd(3)}  ${g.recipe.name} (${g.recipe.id}, trivial ${g.recipe.trivial}, ${pp(g.recipe.cost)} pp)  about ${Math.round(g.attempts)} attempts, ${pp(g.copper)} pp`);
  }
  console.log(`total about ${Math.round(total.attempts)} attempts and ${pp(total.copper)} pp (skill-up rate modeled, stat ${flag("stat", 100)})`);
  if (plan.stuck != null) console.log(`no catalog recipe gives skill-ups at ${plan.stuck}: the next ones need ${[...new Set(recipes.filter((r) => r.trivial > plan.stuck && r.cost == null).slice(0, 4).flatMap((r) => r.missing))].join(", ")}`);
}
