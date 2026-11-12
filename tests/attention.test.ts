// Which open attention items need a person (tools/lib/attention.mjs).
import { expect, test } from "bun:test";
import { RELOAD_MS, needsPerson } from "../tools/lib/attention.mjs";

test("a full page waits for the supervisor's reload before it asks for a person, and an unnamed kind asks at once", () => {
  // Group 10's page stood at 3,388 of 4,192 MB on 2026-11-12 and asked at once, while the page
  // supervisor reloads a page whose heap stays over half its limit.
  const alert = { severity: "act", kind: "alert-memory", t: 1000 };
  expect(needsPerson(alert, 1000 + RELOAD_MS)).toBe(false);
  expect(needsPerson(alert, 1001 + RELOAD_MS)).toBe(true);
  expect(needsPerson({ ...alert, kind: "heap" }, 1000 + 60000)).toBe(false);
  // A kind no mechanism is named for is never hidden, and information never asks.
  expect(needsPerson({ ...alert, kind: "alert-unheard-of" }, 1000)).toBe(true);
  expect(needsPerson({ ...alert, kind: "alert-unheard-of", severity: "info" }, 1000)).toBe(false);
});
