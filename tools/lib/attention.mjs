// Which open attention items need a person (docs/plans/dashboard.md, "Needs you"). The collector
// raises an item for every trouble it sees, and a mechanism handles most of them: the bot's
// remedies, the page supervisor, the coordinator's retries. An item needs a person when it is a
// decision, when no mechanism is named for its kind, or when it is still open after the time its
// mechanism takes. The dashboard's "Needs you", `iqd status` and `iqd wait` all read this, so they
// agree on what waits for someone.

import { PAGE } from "./page.mjs";
import { DEFAULTS } from "./coordinator.mjs";

/** A trouble still open after this needs a person: the mechanisms run in its first minutes. */
export const HANDLED_MS = 10 * 60000;
/**
 * What renewal can take: the heap window, a task up to the coordinator's stop limit,
 * the quarter hour after a raid and all twelve pages' turns in the fleet.
 */
export const RELOAD_MS = (PAGE.heapWindowMin + DEFAULTS.taskStopMin + 15 + 12 * PAGE.reloadGapMin) * 60000;

/**
 * What each open attention kind is called and the mechanism that handles it (`how`). A kind with
 * `needsAfterMs` needs a person once an item is that old, and a kind this table does not name
 * needs one at once, so a new kind is never hidden. On 2026-11-11 the server dropped every tab
 * three times and the supervisor signed all of them in again, the longest in seven minutes.
 */
export const KINDS = {
  "alert-task": { label: "failed tasks", how: "retried by the coordinator" },
  "alert-cursor": { label: "items on the cursor", how: "the bot puts them away" },
  "alert-lootFull": { label: "loot left on corpses", how: "the bot clears bag space" },
  "alert-guard": { label: "guard escapes", how: "the guard re-enters the zone" },
  "alert-errand": { label: "ended errands", how: "the rotation takes over" },
  "alert-crowded": { label: "crowded zones", how: "the rotation moves on" },
  "alert-rotate": { label: "rotation moves", how: "the rotation moves on" },
  "alert-autoLevelRestarted": { label: "AutoLevel restarts", how: "the bot restarts it" },
  "alert-deaths": { label: "death costs", how: "the rotation changes zones" },
  death: { label: "deaths", how: "the bot buys a resurrection" },
  longtask: { label: "long tasks", how: "the coordinator stops them" },
  "alert-clientUpdate": { label: "client updates", how: "the collector checks each new release" },
  stall: { label: "stalls", how: "the bot restarts AutoLevel", needsAfterMs: HANDLED_MS },
  nokill: { label: "no kill", how: "the bot restarts AutoLevel", needsAfterMs: HANDLED_MS },
  gone: { label: "tabs gone", how: "the tab may answer again", needsAfterMs: HANDLED_MS },
  nobridge: { label: "tabs without bridge", how: "the collector injects the bridge again", needsAfterMs: HANDLED_MS },
  "alert-switch": { label: "failed switches", how: "the bot tries again", needsAfterMs: HANDLED_MS },
  "alert-offline": { label: "signed-out tabs", how: "the collector signs them in", needsAfterMs: HANDLED_MS },
  "alert-idle": { label: "idle groups", how: "the rotation moves on", needsAfterMs: HANDLED_MS },
  "alert-memory": { label: "full page memory", how: "the collector gives the tab a new process", needsAfterMs: RELOAD_MS },
  heap: { label: "full page memory", how: "the collector gives the tab a new process", needsAfterMs: RELOAD_MS },
};

/** Whether the open item `a` (`{ severity, kind, t }`) needs a person at `now`. Information never does. */
export function needsPerson(a, now) {
  if (a.severity === "info") return false;
  const k = KINDS[a.kind];
  return a.severity === "decide" || !k || (k.needsAfterMs != null && now - a.t > k.needsAfterMs);
}
