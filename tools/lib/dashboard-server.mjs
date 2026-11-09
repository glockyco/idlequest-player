// The dashboard's HTTP server: the page in tools/dashboard/ and its JSON on this machine only. It
// reads the collector database and runs the report tools, and changes nothing.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { rosterGroups } from "../iqd.mjs";
import { rows as contentRows } from "./content.mjs";
import { attentionView, coordinatorView, engineeringView, epicsView, gearSheetView, gearView, goalView, groupRowsView, hourlyView, jobsView, levelTrends, makeCatalog, minuteTotals, needsYouView, rosterView, statusView, xpRate } from "./dashboard.mjs";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const PAGE = join(REPO, "tools/dashboard");
export const DEFAULT_PORT = 4790;

/**
 * The JSON output of a report tool, run again when the last run is older than `everyMs` and a
 * request asks for it. A request never waits for a run: it gets the last result and its time.
 */
class Report {
  constructor(args, everyMs, log) {
    this.args = args;
    this.everyMs = everyMs;
    this.log = log;
    this.value = null;
    this.at = 0;
    this.running = null;
  }

  get() {
    if (!this.running && Date.now() - this.at > this.everyMs) {
      this.running = (async () => {
        try {
          const proc = Bun.spawn(["bun", ...this.args], { cwd: REPO, stdout: "pipe", stderr: "pipe" });
          const out = await new Response(proc.stdout).text();
          if ((await proc.exited) === 0) {
            this.value = JSON.parse(out);
            this.at = Date.now();
          } else this.log(`dashboard: ${this.args[0]} exited with ${proc.exitCode}`);
        } catch (e) {
          this.log(`dashboard: ${this.args[0]}: ${e.message}`);
        } finally {
          this.running = null;
        }
      })();
    }
    return { at: this.at || null, value: this.value };
  }
}

const readJson = (name, fallback) => {
  try {
    return JSON.parse(readFileSync(join(REPO, name), "utf8"));
  } catch {
    return fallback;
  }
};

/** Zone short names to long names from the content snapshot, read once. Empty without the snapshot. */
let zoneNames = null;
async function zones() {
  if (zoneNames) return zoneNames;
  const out = {};
  try {
    for await (const z of contentRows("zone")) if (z.version === 0 && !(z.short_name in out)) out[z.short_name] = z.long_name;
  } catch {
    /* the page then shows short names */
  }
  return (zoneNames = out);
}

const json = (body) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json", "cache-control": "no-store" } });

/** Serve the dashboard for `db` on 127.0.0.1:`port`. Returns the Bun server. */
export function startDashboard({ db, port = DEFAULT_PORT, log = console.log }) {
  const reports = {
    groups: new Report(["tools/groups.mjs", "--json", "--last", "60"], 120000, log),
    plan: new Report(["tools/plan.mjs", "--json", "--levels", "46,50,55,60"], 600000, log),
  };
  const files = { "/": ["index.html", "text/html"], "/app.js": ["app.js", "text/javascript"], "/gear.js": ["gear.js", "text/javascript"], "/style.css": ["style.css", "text/css"] };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(req) {
      const url = new URL(req.url);
      const file = files[url.pathname];
      // Read on each request, so an edit of the page shows without a restart.
      if (file) return new Response(readFileSync(join(PAGE, file[0])), { headers: { "content-type": file[1], "cache-control": "no-store" } });
      const now = Date.now();
      if (url.pathname === "/api/state") {
        const rosterFile = readJson("data/roster.json", { groups: [] });
        const meta = (k) => {
          const row = db.query("SELECT v FROM meta WHERE k = ?").get(k);
          return row ? JSON.parse(row.v) : null;
        };
        const groupOf = rosterGroups();
        const catalog = makeCatalog({ opportunities: readJson("data/opportunities.json", []), quests: readJson("data/quests.json", {}), farms: readJson("data/farms.json", []), drops: meta("gear")?.drops ?? [], zones: await zones() });
        const roster = rosterView(db, rosterFile);
        const report = reports.groups.get();
        const plan = reports.plan.get();
        const minutes = minuteTotals(db, now);
        const rows = groupRowsView(db, now, { roster, groupOf, catalog, report: report.value, minutes });
        const attention = attentionView(db, now);
        const needs = needsYouView(attention.open, now, groupOf);
        const daemon = meta("daemon");
        return json({
          now,
          status: statusView({ now, daemon, rows, needs, xp24: xpRate(minutes, now) }),
          needs,
          goal: goalView(db, { roster, plan: plan.value, groupOf, catalog }),
          groups: rows,
          hourly: hourlyView(minutes, now),
          coordinator: daemon?.coordinate ? coordinatorView(db, now, { catalog, rows, groupOf }) : null,
          coordinatorOn: Boolean(daemon?.coordinate),
          roster,
          gear: gearView(db, { roster }),
          epics: epicsView(meta("coordinator")),
          attention: { info: attention.info, resolved: attention.resolved, manual: attention.manual },
          engineering: engineeringView(db, now),
          jobs: jobsView(db),
          reports: { groups: report.at, plan: plan.at, planWindowMin: plan.value?.windowMin ?? null },
        });
      }
      // One character's sheet, from the gear pass's saved report.
      if (url.pathname === "/api/gear") {
        const catalog = makeCatalog({ zones: await zones() });
        return json(gearSheetView(db, url.searchParams.get("name") ?? "", { roster: rosterView(db, readJson("data/roster.json", { groups: [] })), catalog }));
      }
      if (url.pathname === "/api/trends") {
        const hours = Math.min(24 * 30, Math.max(1, Number(url.searchParams.get("hours") ?? 24)));
        const roster = readJson("data/roster.json", { groups: [] });
        return json({ now, hours, levels: levelTrends(db, roster, now - hours * 3600000, Math.max(60000, (hours * 3600000) / 300)) });
      }
      return new Response("not found", { status: 404 });
    },
  });
  log(`dashboard on http://127.0.0.1:${server.port}/`);
  return server;
}
