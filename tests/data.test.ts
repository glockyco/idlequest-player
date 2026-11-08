// Checks the data files the bot loads against each other. Run with `bun test`.
import { expect, test } from "bun:test";
import bandRotations from "../data/band-rotations.json";
import liveZones from "../data/live-zones.json";

test("every band-row zone is in the live client's zone list", () => {
  // The bot moves to these zones by short name, and a name the client lacks fails the move.
  const live = new Set(liveZones as string[]);
  const missing = (bandRotations as [number, string[]][]).flatMap(([level, zones]) => zones.filter((z) => !live.has(z)).map((z) => `${level}: ${z}`));
  expect(missing).toEqual([]);
});
