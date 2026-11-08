// The dashboard page: polls /api/state and /api/trends and renders them. Read-only.
const REFRESH_MS = 15000;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const big = (n) => (n == null ? "-" : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(Math.round(n)));
const pct = (x) => (x == null ? "-" : `${Math.round(100 * x)}%`);
const dur = (ms) => (ms == null ? "-" : ms < 90000 ? `${Math.round(ms / 1000)}s` : ms < 5400000 ? `${Math.round(ms / 60000)}m` : ms < 172800000 ? `${(ms / 3600000).toFixed(1)}h` : `${(ms / 86400000).toFixed(1)}d`);
const hours = (h) => (h == null ? "-" : h < 48 ? `${Math.round(h)} h` : `${(h / 24).toFixed(1)} d`);
const clock = (t) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const dayName = (t) => new Date(t).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
const SHORT = { Warrior: "War", Cleric: "Clr", Paladin: "Pal", Ranger: "Rng", "Shadow Knight": "SK", Druid: "Dru", Monk: "Mnk", Bard: "Brd", Rogue: "Rog", Shaman: "Shm", Necromancer: "Nec", Wizard: "Wiz", Magician: "Mag", Enchanter: "Enc" };
// The page's activity labels grouped as the goal measures time: fighting, moving, recovering, idle, dead, tasks.
const ACT = [
  ["fight", "var(--fight)", (k) => k === "fight"],
  ["move", "var(--move)", (k) => k === "approach" || k.startsWith("travel")],
  ["recover", "var(--recover)", (k) => k === "recover"],
  ["idle", "var(--idle)", (k) => k.startsWith("idle")],
  ["dead", "var(--dead)", (k) => k === "dead"],
  ["task", "var(--task)", (k) => k === "task"],
];
const groupColor = (i, n) => `hsl(${Math.round((360 * i) / n)} 65% 50%)`;
// Level 1 to 60 from cool to warm, so the roster grid reads as progress at a glance.
const levelColor = (l) => `hsl(${Math.round(220 - (Math.min(60, l ?? 1) / 60) * 200)} 70% 50%)`;

function table(head, rows, numeric = []) {
  const th = head.map((h, i) => `<th class="${numeric.includes(i) ? "n" : ""}">${esc(h)}</th>`).join("");
  const tr = rows.map((r) => `<tr>${r.map((c, i) => `<td class="${numeric.includes(i) ? "n" : ""}">${c}</td>`).join("")}</tr>`).join("");
  return `<table><thead><tr>${th}</tr></thead><tbody>${tr || `<tr><td colspan="${head.length}" class="muted">none</td></tr>`}</tbody></table>`;
}

function renderDaemon(s) {
  const d = s.daemon;
  const age = d?.last ? s.now - d.last : null;
  const alive = d && age != null && age < (d.intervalSec * 3 + 10) * 1000;
  $("daemon").innerHTML = `collector <span class="${alive ? "ok" : "bad"}">${alive ? `running, last cycle ${dur(age)} ago` : "not running"}</span>${d && !d.relay ? ' <span class="bad">relay down</span>' : ""} · updated ${clock(s.now)}`;
}

function renderGoal(s) {
  const r = s.roster;
  const tiles = [
    [`${r.atTarget} / ${r.characters}`, `characters at level ${r.target}`],
    [`${(100 * r.progress).toFixed(1)}%`, `of the XP to level ${r.target}`],
    [r.minLevel ?? "-", "lowest level"],
    [r.meanLevel == null ? "-" : r.meanLevel.toFixed(1), "mean level"],
    [r.maxLevel ?? "-", "highest level"],
    [s.attention.open.length, "open attention items"],
  ];
  $("goal-tiles").innerHTML = tiles.map(([v, l]) => `<div class="tile"><div class="v">${esc(v)}</div><div class="l">${esc(l)}</div></div>`).join("");
  const crit = [
    ["Level 60 for every roster character", `${r.atTarget} of ${r.characters}, lowest ${r.minLevel ?? "-"}`],
    ["AA ranks", r.maxLevel >= 46 ? "AA unlocked for the highest characters, ranks not collected yet" : `unlocks at level 46, highest is ${r.maxLevel ?? "-"}`],
    ["Raid kills", r.maxLevel >= 46 ? "raid level reached, kills not collected yet" : "raids start at level 46, kills not collected yet"],
    ["Epics", "not collected by the collector yet, see docs/plans/epics.md"],
  ];
  $("criteria").innerHTML = table(["Criterion", "State"], crit.map(([a, b]) => [esc(a), esc(b)]));
  const cells = r.groups
    .map((g) => {
      const members = g.members
        .map((m) => {
          const frac = m.level == null ? 0 : Math.min(1, (m.level - 1 + (m.xpPct ?? 0) / 100) / (r.target - 1));
          return `<div class="cell" title="${esc(`${m.name}, ${m.race ?? "?"} ${m.class ?? "?"}, level ${m.level ?? "?"}${m.xpPct != null ? ` and ${m.xpPct.toFixed(0)}%` : ""}${m.seen ? `, seen ${dur(s.now - m.seen)} ago` : ""}`)}">
            <div class="fill" style="width:${(100 * frac).toFixed(1)}%;background:${levelColor(m.level)}"></div>
            <div class="t"><span class="nm">${esc(m.name)}</span><span class="lv">${m.level ?? "?"}</span></div>
            <div class="cl">${esc(SHORT[m.class] ?? m.class ?? "?")}</div></div>`;
        })
        .join("");
      return `<div class="g">${esc(g.id)}</div>${members}`;
    })
    .join("");
  $("roster").innerHTML = `<div class="roster">${cells}</div>`;
  const plan = s.reports.plan;
  if (!plan.value) $("eta").innerHTML = `<p class="muted">The planner (tools/plan.mjs) has not reported yet.</p>`;
  else {
    const p = plan.value;
    const rows = p.groups.map((g) => [esc(g.leader), g.level, big(g.rateNow), esc(g.slowest), ...p.targets.map((t) => (g.eta[t] ? `${hours(g.eta[t].hours)} <span class="muted">(${hours(g.eta[t].low)} to ${hours(g.eta[t].high)})</span>` : "-"))]);
    $("eta").innerHTML = table(["Leader", "Level", "XP/h", "Slowest member", ...p.targets.map((t) => `to ${t}`)], rows, [1, 2]) + `<p class="muted">tools/plan.mjs over the last ${p.windowMin} min of AutoLevel, as of ${clock(plan.at)}. Ranges are one standard deviation.${p.idle.length ? ` No estimate for ${esc(p.idle.join(", "))}.` : ""}</p>`;
  }
}

function activityBar(sec) {
  const total = Object.values(sec ?? {}).reduce((a, b) => a + b, 0);
  if (!total) return "";
  return `<div class="bar">${ACT.map(([name, color, test]) => {
    const v = Object.entries(sec).filter(([k]) => test(k)).reduce((a, [, x]) => a + x, 0);
    return v ? `<span title="${name} ${Math.round((100 * v) / total)}%" style="width:${(100 * v) / total}%;background:${color}"></span>` : "";
  }).join("")}</div>`;
}

function renderGroups(s) {
  const legend = `<div class="legend">${ACT.map(([n, c]) => `<span><i style="background:${c}"></i>${n}</span>`).join("")}<span>bars: last 10 minutes</span></div>`;
  $("group-cards").innerHTML =
    s.groups
      .map((g) => {
        const act = g.activity;
        const state = g.goneMs != null ? ["gone", "var(--bad)"] : g.parked ? ["parked", "var(--task)"] : g.raid ? ["raid", "var(--accent)"] : act ? [`${act.act}${act.why ? ` (${act.why})` : ""} ${dur(act.forMs)}`, ACT.find(([, , t]) => t(act.act))?.[1] ?? "var(--task)"] : ["no activity", "var(--task)"];
        const stuck = g.goneMs != null || (act && (act.act === "idle" || act.act === "dead") && act.forMs > 120000) || g.lastKillMs > 300000;
        const levels = g.party.map((m) => m.level).filter((l) => l != null);
        const note = g.pause ? `paused ${dur(g.pause.untilMs)}: ${g.pause.reason ?? ""}` : g.errand ? `errand: ${g.errand.item ?? g.errand.keep ?? ""} in ${g.errand.zone}` : "";
        return `<div class="card${stuck ? " alert" : ""}">
          <div class="top"><span class="name">${esc(g.group ?? "--")} ${esc(g.leader)}</span><span class="badge" style="background:${state[1]}">${esc(state[0])}</span></div>
          <div class="muted">${esc(g.zone ?? "?")} · levels ${levels.length ? `${Math.min(...levels)} to ${Math.max(...levels)}` : "?"}${g.xpPct != null ? ` · leader ${g.xpPct.toFixed(0)}%` : ""}</div>
          <div class="kv"><span class="k">XP/h</span><span>${big(g.xpPerHour)}</span><span class="k">kills/h</span><span>${g.killsPerHour == null ? "-" : Math.round(g.killsPerHour)}</span>
          <span class="k">idle</span><span>${pct(g.idleShare)}</span><span class="k">last kill</span><span>${dur(g.lastKillMs)}</span>
          <span class="k">memory</span><span>${g.heap ? `${g.heap.used} MB` : "-"}</span><span class="k">bags free</span><span>${g.bags?.free ?? "-"}</span></div>
          ${activityBar(g.activitySec)}
          ${note ? `<div class="party">${esc(note)}</div>` : ""}
          <div class="party">${g.party.map((m) => `${esc(m.name)} ${esc(SHORT[m.class] ?? "")} ${m.level ?? ""}`).join(" · ")}</div>
        </div>`;
      })
      .join("") || `<p class="muted">No open sessions.</p>`;
  if (!$("act-legend")) $("group-cards").insertAdjacentHTML("beforebegin", `<div id="act-legend">${legend}</div>`);
  const rep = s.reports.groups;
  if (!rep.value) $("group-hour").innerHTML = `<p class="muted">tools/groups.mjs has not reported yet.</p>`;
  else
    $("group-hour").innerHTML =
      table(
        ["Group", "Leader", "Level", "Mix", "Zone", "XP/h", "Kills/min", "Fight", "Move", "Recover", "Idle (cause)", "Escapes", "Deaths (leader)", "Waited for"],
        rep.value.map((r) => [esc(r.group), esc(r.leader), r.level ?? "-", esc(r.mix), esc(r.zone ?? "-"), big(r.xpPerHour), r.killsPerMin ?? "-", pct(r.combat), pct(r.move), pct(r.recover), `${pct(r.idle)} ${r.idleCause ? `<span class="muted">${esc(r.idleCause)}</span>` : ""}`, r.escapes ?? "-", `${r.deaths ?? "-"} (${r.leaderDeaths ?? "-"})`, esc(r.waitedFor ?? "")]),
        [2, 5, 6, 7, 8, 9, 11],
      ) + `<p class="muted">tools/groups.mjs over the last 60 minutes, as of ${clock(rep.at)}.</p>`;
}

function renderAttention(s) {
  const a = s.attention;
  const info = Object.entries(a.info).map(([k, n]) => `${n} ${k}`).join(", ");
  $("attention-open").innerHTML = table(["#", "Time", "Severity", "Kind", "Tab", "Text"], a.open.map((x) => [x.id, clock(x.t), `<span class="sev-${esc(x.severity)}">${esc(x.severity)}</span>`, esc(x.kind), esc(x.session ?? ""), esc(x.text)])) + (info ? `<p class="muted">Open info items: ${esc(info)}.</p>` : "");
  $("attention-resolved").innerHTML = table(["#", "Raised", "Took", "Kind", "Text", "Note"], a.resolved.map((x) => [x.id, clock(x.t), dur(x.resolved - x.t), esc(x.kind), esc(x.text), esc(x.note ?? "")]));
  $("interventions").innerHTML = table(["Time", "Actor", "Tab", "What"], a.interventions.map((x) => [clock(x.t), esc(x.actor), esc(x.session ?? ""), esc(x.text)]));
}

/** A bar chart of `rows` by day, one value per row from `value`. */
function dayBars(title, rows, value, fmt) {
  const W = 520, H = 170, L = 36, B = 22, T = 18;
  const vals = rows.map(value);
  const max = Math.max(...vals.filter((v) => v != null), 0) || 1;
  const bw = (W - L - 8) / rows.length;
  const bars = rows
    .map((r, i) => {
      const v = vals[i];
      if (v == null) return "";
      const h = ((H - B - T) * v) / max;
      return `<rect x="${L + i * bw + 2}" y="${H - B - h}" width="${bw - 4}" height="${h}" fill="var(--accent)"><title>${dayName(r.day)}: ${fmt(v)}</title></rect>`;
    })
    .join("");
  const labels = rows.map((r, i) => (i % Math.ceil(rows.length / 7) === 0 ? `<text x="${L + i * bw + bw / 2}" y="${H - 6}" text-anchor="middle">${new Date(r.day).getDate()}.${new Date(r.day).getMonth() + 1}.</text>` : "")).join("");
  return `<div><h3>${esc(title)}</h3><svg viewBox="0 0 ${W} ${H}" width="100%"><line class="grid" x1="${L}" x2="${W}" y1="${H - B}" y2="${H - B}"/><text x="${L - 4}" y="${T + 4}" text-anchor="end">${fmt(max)}</text>${bars}${labels}</svg></div>`;
}

function renderEngineering(s) {
  const rows = s.engineering;
  const two = (v) => v.toFixed(2);
  $("eng-charts").innerHTML = dayBars("Manual interventions per group-hour", rows, (r) => r.interventionsPerGroupHour, two) + dayBars("Stalls per group-hour", rows, (r) => r.stallsPerGroupHour, two);
  $("eng-table").innerHTML = table(
    ["Day", "Group-hours", "Interventions", "per group-hour", "Stalls", "per group-hour", "Minutes to resolve", "Deaths"],
    rows.filter((r) => r.groupHours > 0).reverse().map((r) => [dayName(r.day), r.groupHours.toFixed(1), r.interventions, r.interventionsPerGroupHour?.toFixed(2) ?? "-", r.stalls, r.stallsPerGroupHour?.toFixed(3) ?? "-", r.stallMinutes?.toFixed(1) ?? "-", r.deaths]),
    [1, 2, 3, 4, 5, 6, 7],
  );
}

function renderJobs(s) {
  const j = s.jobs;
  $("jobs-list").innerHTML =
    `<h3>Open</h3>` + table(["#", "Since", "Purpose", "Output"], j.open.map((x) => [x.id, dur(s.now - x.started), esc(x.purpose), esc(x.output ?? "")])) + `<h3>Done</h3>` + table(["#", "Done", "Purpose", "Result"], j.done.map((x) => [x.id, new Date(x.done).toLocaleString(), esc(x.purpose), esc(x.result ?? "")]));
}

async function renderTrends() {
  const hoursBack = Number($("trend-hours").value);
  const t = await (await fetch(`/api/trends?hours=${hoursBack}`)).json();
  const W = 1100, H = 360, L = 40, R = 110, T = 10, B = 26;
  const x0 = t.now - hoursBack * 3600000;
  const pts = t.levels.flatMap((s) => s.points);
  if (!pts.length) return void ($("trend-chart").innerHTML = `<p class="muted">No snapshots in this window.</p>`);
  const lo = Math.floor(Math.min(...pts.map((p) => p[1]))), hi = Math.ceil(Math.max(...pts.map((p) => p[1])));
  const X = (tt) => L + ((tt - x0) / (t.now - x0)) * (W - L - R);
  const Y = (v) => T + (1 - (v - lo) / Math.max(1, hi - lo)) * (H - T - B);
  const step = Math.max(1, Math.ceil((hi - lo) / 8));
  let grid = "";
  for (let v = lo; v <= hi; v += step) grid += `<line class="grid" x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}"/><text x="${L - 6}" y="${Y(v) + 4}" text-anchor="end">${v}</text>`;
  for (let i = 0; i <= 6; i++) {
    const tt = x0 + (i / 6) * (t.now - x0);
    grid += `<text x="${X(tt)}" y="${H - 6}" text-anchor="middle">${hoursBack > 48 ? new Date(tt).toLocaleDateString([], { day: "numeric", month: "numeric" }) + " " : ""}${new Date(tt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</text>`;
  }
  // End labels sit at their line's last value, pushed apart where groups share a level.
  const ends = t.levels
    .map((s, i) => ({ s, c: groupColor(i, t.levels.length), y: s.points.length ? Y(s.points.at(-1)[1]) + 4 : null }))
    .filter((e) => e.y != null)
    .sort((a, b) => a.y - b.y);
  for (let k = 1; k < ends.length; k++) ends[k].y = Math.max(ends[k].y, ends[k - 1].y + 12);
  const lines = ends
    .map(({ s, c, y }) => {
      const d = s.points.map((p, k) => `${k ? "L" : "M"}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join("");
      return `<path d="${d}" fill="none" stroke="${c}" stroke-width="2"><title>${esc(s.group)} ${esc(s.leader)}</title></path><text x="${W - R + 6}" y="${y}" style="fill:${c}">${esc(s.group)} ${s.points.at(-1)[1].toFixed(1)}</text>`;
    })
    .join("");
  $("trend-chart").innerHTML = `<svg viewBox="0 0 ${W} ${Math.max(H, (ends.at(-1)?.y ?? 0) + 8)}" width="100%">${grid}${lines}</svg>`;
}

async function refresh() {
  try {
    const s = await (await fetch("/api/state")).json();
    renderDaemon(s);
    renderGoal(s);
    renderGroups(s);
    renderAttention(s);
    renderEngineering(s);
    renderJobs(s);
  } catch (e) {
    $("daemon").innerHTML = `<span class="bad">dashboard server not reachable: ${esc(e.message)}</span>`;
  }
}

$("trend-hours").addEventListener("change", renderTrends);
refresh();
renderTrends();
setInterval(refresh, REFRESH_MS);
setInterval(renderTrends, 60000);
