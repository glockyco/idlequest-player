// Which commit's page code each group runs (src/deploy.mjs).
import { expect, test } from "bun:test";
import { commitFor, deployed, reverted } from "../src/deploy.mjs";

test("a canary runs the new commit while the other groups keep theirs, until it is deployed to all or reverted", () => {
  const first = deployed(null, { commit: "a", now: 1 });
  expect([commitFor(first, "G1"), commitFor(first, "G7")]).toEqual(["a", "a"]);
  const canary = deployed(first, { commit: "b", canary: ["G7"], now: 2 });
  expect([commitFor(canary, "G1"), commitFor(canary, "G7")]).toEqual(["a", "b"]);
  // A second canary commit leaves the others on what they run, not on the first canary's commit.
  const again = deployed(canary, { commit: "c", canary: ["G7"], now: 3 });
  expect([commitFor(again, "G1"), commitFor(again, "G7")]).toEqual(["a", "c"]);
  const all = deployed(again, { commit: "c", now: 4 });
  expect([commitFor(all, "G1"), commitFor(all, "G7"), all.previous]).toEqual(["c", "c", "a"]);
  // Deploying what already runs changes nothing, so a revert still goes back to the commit before.
  expect(deployed(all, { commit: "c", now: 5 })).toEqual(all);
  const back = reverted(all, 6);
  expect([commitFor(back, "G1"), commitFor(back, "G7")]).toEqual(["a", "a"]);
  // A canary that plays worse is taken back the same way, and a second revert deploys it to all.
  expect(commitFor(reverted(canary, 7), "G7")).toBe("a");
  expect(commitFor(reverted(back, 8), "G1")).toBe("c");
});
