// Which commit's page code plays the account (README, "Deploying page code"). The collector
// installs `src/bridge.js`, `src/bot.js` and their two tables from a commit that was deployed on
// purpose, never from the working tree, so an edit plays only once it is committed, tested and
// deployed. The state is `{ commit, previous, canary, at }` in `runs/state/deploy.json`: every
// group runs `commit`, or, while `canary` names groups, those run `commit` and the others still
// run `previous`. `iqd deploy` and `iqd revert` store what `deployed` and `reverted` return.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const file = (runs) => join(runs, "state/deploy.json");

/** The stored state, or null before the first deploy. */
export async function readDeploy(runs) {
  return readFile(file(runs), "utf8").then(JSON.parse, () => null);
}

export async function writeDeploy(runs, state) {
  await mkdir(dirname(file(runs)), { recursive: true });
  await writeFile(file(runs), JSON.stringify(state, null, 1) + "\n");
}

/** The commit `group` runs: the deployed one, or the one before it for a group outside a canary. */
export const commitFor = (state, group) => (state.canary?.length && !state.canary.includes(group) ? state.previous : state.commit);

/**
 * The state after deploying `commit`, to the groups `canary` names first or, without any, to every
 * group. Deploying a canary's commit without a canary gives it to the rest. `previous` is what
 * the groups outside the canary ran before, which `reverted` goes back to.
 */
export function deployed(state, { commit, canary = [], now }) {
  if (!state) return { commit, previous: commit, canary, at: now };
  if (state.commit === commit && !canary.length) return state.canary?.length ? { ...state, canary: [], at: now } : state;
  return { commit, previous: commitFor(state, null), canary, at: now };
}

/** The state after going back: every group runs what the groups outside a canary ran before the last deploy. */
export const reverted = (state, now) => ({ commit: state.previous, previous: state.commit, canary: [], at: now });
