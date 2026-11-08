// The dashboard's HTTP server: the page in tools/dashboard/ and its JSON on this machine only. It
// reads the collector database and runs the report tools, and changes nothing.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { rosterGroups } from "../iqd.mjs";
import { attentionView, engineeringView, groupsView, jobsView, levelTrends, rosterView } from "./dashboard.mjs";

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

const json = (body) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json", "cache-control": "no-store" } });

/** Serve the dashboard for `db` on 127.0.0.1:`port`. Returns the Bun server. */
export function startDashboard({ db, port = DEFAULT_PORT, log = console.log }) {
  const reports = {
    groups: new Report(["tools/groups.mjs", "--json", "--last", "60"], 120000, log),
    plan: new Report(["tools/plan.mjs", "--json", "--levels", "46,50,55,60"], 600000, log),
  };
  const files = { "/": ["index.html", "text/html"], "/app.js": ["app.js", "text/javascript"], "/style.css": ["style.css", "text/css"] };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch(req) {
      const url = new URL(req.url);
      const file = files[url.pathname];
      // Read on each request, so an edit of the page shows without a restart.
      if (file) return new Response(readFileSync(join(PAGE, file[0])), { headers: { "content-type": file[1], "cache-control": "no-store" } });
      const now = Date.now();
      if (url.pathname === "/api/state") {
        const roster = JSON.parse(readFileSync(join(REPO, "data/roster.json"), "utf8"));
        const daemon = db.query("SELECT v FROM meta WHERE k = 'daemon'").get();
        return json({
          now,
          daemon: daemon ? JSON.parse(daemon.v) : null,
          roster: rosterView(db, roster),
          groups: groupsView(db, now, rosterGroups()),
          attention: attentionView(db, now),
          engineering: engineeringView(db, now),
          jobs: jobsView(db),
          reports: { groups: reports.groups.get(), plan: reports.plan.get() },
        });
      }
      if (url.pathname === "/api/trends") {
        const hours = Math.min(24 * 30, Math.max(1, Number(url.searchParams.get("hours") ?? 24)));
        const roster = JSON.parse(readFileSync(join(REPO, "data/roster.json"), "utf8"));
        return json({ now, hours, levels: levelTrends(db, roster, now - hours * 3600000, Math.max(60000, (hours * 3600000) / 300)) });
      }
      return new Response("not found", { status: 404 });
    },
  });
  log(`dashboard on http://127.0.0.1:${server.port}/`);
  return server;
}
