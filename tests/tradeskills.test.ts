// Checks the tradeskill planner's rules (tools/tradeskills.mjs). Run with `bun test`.
import { expect, test } from "bun:test";
import { ladder, successChance } from "../tools/tradeskills.mjs";

test("success follows the measured rule and its bounds", () => {
  // Skill 1 against trivial 21: 46%, as 8 of 20 Bog Juice and about half the Edible Goo attempts.
  expect(successChance(1, 21)).toBeCloseTo(0.46);
  // From trivial 68 the rule changes slope: skill 148 against the Rebreather's 175.
  expect(successChance(148, 175)).toBeCloseTo(0.6825);
  expect(successChance(0, 300)).toBe(0.05);
  expect(successChance(200, 175)).toBe(0.95);
});

test("the ladder takes the cheapest recipe that still gives skill-ups and says where it gets stuck", () => {
  const recipes = [
    { id: 1, name: "cheap", trivial: 20, cost: 10, nofail: false },
    { id: 2, name: "dear", trivial: 40, cost: 1000, nofail: false },
    { id: 3, name: "free", trivial: 60, cost: 0, nofail: true },
    { id: 4, name: "dropped", trivial: 80, cost: null, nofail: false },
  ];
  const plan = ladder(recipes, { from: 0, to: 60 });
  expect(plan.segments.map((g) => [g.from, g.to, g.recipe.id])).toEqual([[0, 20, 1], [20, 40, 2]]);
  // A no-fail recipe gives no skill-ups and a recipe without a catalog source cannot be bought.
  expect(plan.stuck).toBe(40);
});
