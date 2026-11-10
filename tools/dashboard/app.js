// The dashboard page: polls /api/state and /api/trends and renders them. Read-only. The server
// builds every view (tools/lib/dashboard.mjs), so this file only formats and lays them out.
const REFRESH_MS = 15000;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const big = (n) => (n == null ? "-" : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(Math.round(n)));
const pct = (x) => (x == null ? "-" : `${Math.round(100 * x)}%`);
const dur = (ms) => (ms == null ? "-" : ms < 90000 ? `${Math.round(ms / 1000)}s` : ms < 5400000 ? `${Math.round(ms / 60000)}m` : ms < 172800000 ? `${(ms / 3600000).toFixed(1)}h` : `${(ms / 86400000).toFixed(1)}d`);
const hours = (h) => (h == null ? "-" : h < 48 ? `${Math.round(h)} h` : `${(h / 24).toFixed(1)} d`);
// Times are the browser's local time on a 24-hour clock, like the collector's log lines.
const clock = (t) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
const hhmm = (t) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const dayName = (t) => new Date(t).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
/** "3m ago" with the clock time on hover. */
const ago = (now, t) => `<span title="${esc(`${dayName(t)} ${clock(t)}`)}">${dur(now - t)} ago</span>`;
/** "in 3m" or "due" for a span to a time ahead. */
const inMs = (ms) => (ms <= 0 ? "due" : `in ${dur(ms)}`);
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
// Idle time in the hourly bars is split by cause, in shades of the idle colour.
const IDLE_COLORS = { noTarget: "#d9822b", crowded: "#e8b64f", afterKill: "#f0d08c", off: "#8d5a1f", readyWait: "#c46f3a", waitAttack: "#b9946a", noEnemies: "#a8431f", other: "#c9b08a" };
const idleColor = (cause) => IDLE_COLORS[cause] ?? IDLE_COLORS.other;
const actColor = (act) => ACT.find(([, , t]) => t(act))?.[1] ?? "var(--task)";
const groupColor = (i, n) => `hsl(${Math.round((360 * i) / n)} 65% 50%)`;
// Level 1 to 60 from cool to warm, so the roster grid reads as progress at a glance.
const levelColor = (l) => `hsl(${Math.round(220 - (Math.min(60, l ?? 1) / 60) * 200)} 70% 50%)`;

function table(head, rows, numeric = []) {
  const th = head.map((h, i) => `<th class="${numeric.includes(i) ? "n" : ""}">${esc(h)}</th>`).join("");
  const tr = rows.map((r) => `<tr>${r.map((c, i) => `<td class="${numeric.includes(i) ? "n" : ""}">${c}</td>`).join("")}</tr>`).join("");
  return `<table class="plain"><thead><tr>${th}</tr></thead><tbody>${tr || `<tr><td colspan="${head.length}" class="muted">none</td></tr>`}</tbody></table>`;
}

/** `text` cut to `n` characters, with the whole text on hover. */
const short = (text, n = 70) => (text == null ? "" : String(text).length > n ? `<span title="${esc(text)}">${esc(String(text).slice(0, n - 1))}~</span>` : esc(text));

const meter = (share, cls = "", after = null) => `<div class="meter ${cls}">${after == null ? "" : `<i class="after" style="width:${(100 * Math.max(0, Math.min(1, after))).toFixed(1)}%"></i>`}<i style="width:${(100 * Math.max(0, Math.min(1, share ?? 0))).toFixed(1)}%"></i></div>`;

// ---- Status line -------------------------------------------------------------------------------

function renderStatus(s) {
  const text = {
    xp: (v) => big(v.value),
    xp24: (v) => (v.value == null ? "-" : big(v.value)),
    idle: (v) => pct(v.value),
    memory: (v) => (v.value == null ? "-" : `${v.value} MB${v.tab ? ` <small>${esc(v.tab)}</small>` : ""}`),
  };
  const chips = s.status.map((v) => `<div class="chip ${v.level}"${v.title || v.share != null ? ` title="${esc(v.title ?? `${pct(v.share)} of the page's heap limit`)}"` : ""}><span class="k">${esc(v.label)}</span><span class="v">${text[v.id] ? text[v.id](v) : esc(v.value)}</span></div>`).join("");
  $("status").innerHTML = `<h1>IdleQuest account</h1><div class="chips">${chips}</div><div class="stamp muted" title="The page refreshes every ${REFRESH_MS / 1000} seconds">updated ${clock(s.now)}</div>`;
}

// ---- Needs you and goal progress -------------------------------------------------------------

function renderNeeds(s) {
  const n = s.needs;
  $("needs-list").innerHTML = n.needs.length
    ? n.needs
        .map((x) => `<div class="need ${x.severity === "decide" ? "decide" : "act"}"><div class="line"><span class="tag">${esc(x.label)}</span>${x.group ? `<span class="grp">${esc(x.group)}</span>` : ""}<span class="when">${ago(s.now, x.t)}</span></div><div class="txt">${esc(x.text)}</div></div>`)
        .join("")
    : `<p class="calm">Nothing needs you.</p>`;
  $("needs-handled").textContent = n.handledTotal ? `Handled without you: ${n.handled.map((h) => `${h.label} ${h.n} (${h.how})`).join(", ")}.` : "";
}

function barRow(title, share, bar, text, after = null) {
  return `<div class="goalrow"><div class="gl"><span class="gt">${esc(title)}</span><span class="gv">${bar}</span></div>${share == null ? `<div class="meter unknown"></div>` : meter(share, "", after)}<div class="gx">${text}</div></div>`;
}

function renderGoal(s) {
  const g = s.goal;
  const L = g.levels;
  const eta = L.slowest
    ? `The slowest group (${esc(L.slowest.group ?? "?")}, ${esc(L.slowest.leader)}) needs about ${hours(L.slowest.hours)} to level ${L.target}, range ${hours(L.slowest.low)} to ${hours(L.slowest.high)}.`
    : s.reports.plan
      ? "No estimate for the slowest group."
      : "The estimate for the slowest group is not ready yet.";
  const none = (what) => `<span class="muted">not measured yet</span>`;
  $("goal-bars").innerHTML = [
    barRow(`Levels to ${L.target}`, L.share, `${(100 * L.share).toFixed(1)}% of the XP`, `${L.atTarget} of ${L.characters} characters at ${L.target}. Levels ${L.minLevel ?? "-"} to ${L.maxLevel ?? "-"}, mean ${L.meanLevel?.toFixed(1) ?? "-"}. ${eta}`),
    g.gear.share == null
      ? barRow("Gear", null, none(), `The gear pass has not saved its report yet. The pass runs once an hour.`)
      : barRow("Gear", g.gear.share, `${pct(g.gear.share)} of the target score`, `The average character of ${g.gear.characters} wears ${pct(g.gear.share)} of the armor and jewelry score that the account's items, merchants and wanted drops give it, and ${pct(g.gear.afterMoves)} once the ${g.gear.moves ?? "?"} queued moves are done. ${g.gear.drops ?? "?"} wanted drops are listed. Pass ${ago(s.now, g.gear.passT)}.`, g.gear.afterMoves),
    g.aa.share == null
      ? barRow("AA ranks", null, none(), `No character past level ${g.aa.level} has been recorded yet. ${g.aa.reached} of ${g.aa.characters} characters have reached it, where AA opens.`)
      : barRow("AA ranks", g.aa.share, `${g.aa.trained} of ${g.aa.possible} ranks`, `${g.aa.recorded} recorded characters past level ${g.aa.level} have trained ${g.aa.trained} of the catalog's ${g.aa.possible} ranks and hold ${g.aa.points} unspent points. Their XP goes to AA only from level 60. ${g.aa.reached} of ${g.aa.characters} characters have reached ${g.aa.level}. Pass ${ago(s.now, g.aa.passT)}.`),
    g.epics.share == null
      ? barRow("Epics", null, none(), `The coordinator has not saved its chain summary yet. The last pass ${g.epics.passT ? ago(s.now, g.epics.passT) : "never"} found ${g.epics.missingCopies} copies of ${g.epics.missingPieces} epic pieces still missing.`)
      : barRow("Epics", g.epics.share, `${g.epics.holders} of ${g.epics.holders + g.epics.needers} steps`, `${g.epics.holders} characters hold an epic chain's item, ${g.epics.started} have started one and ${g.epics.needers} still need one, over ${g.epics.chains} chains (characters of the class at the chain's level). ${g.epics.missingCopies} copies of ${g.epics.missingPieces} chain pieces are still missing. Pass ${ago(s.now, g.epics.passT)}.`),
    barRow("Raid kills", null, none(), `Kills are not collected. Raids open at level ${g.raids.level}, reached by ${g.raids.reached} of ${g.raids.characters} characters.`),
  ].join("");
}

// ---- Groups ------------------------------------------------------------------------------------

const openGroups = new Set();

function stateCell(g) {
  const st = g.state;
  if (st.kind === "gone") return `<span class="pill bad">gone ${dur(st.forMs)}</span>`;
  if (st.kind === "parked") return `<span class="pill task">parked</span>`;
  if (st.kind === "raid") return `<span class="pill accent">raid</span>`;
  if (st.kind === "none") return `<span class="pill bad">no tab</span>`;
  if (st.kind === "off") return `<span class="pill warn">AutoLevel off</span>`;
  if (st.kind === "running") return `<span class="dot" style="background:var(--fight)"></span>AutoLevel on`;
  return `<span class="dot" style="background:${actColor(st.act)}"></span>${esc(st.act)}${st.why ? ` <span class="muted">${esc(st.why)}</span>` : ""} <span class="muted">${dur(st.forMs)}</span>`;
}

function taskCell(now, t) {
  if (!t) return `<span class="muted">no task yet</span>`;
  const retry = t.retryInMs == null ? "" : ` <span class="muted">· retry ${inMs(t.retryInMs)}</span>`;
  if (t.status === "running") return `<span class="name">${esc(t.name)}</span> <span class="muted">${short(t.step, 40)} · ${dur(t.forMs)}</span>`;
  if (t.status === "failed") return `<span class="bad">${esc(t.name)} failed${t.step ? ` at ${esc(t.step)}` : ""}</span><span class="muted">: ${short(t.error)}</span>${retry}`;
  const what = t.status === "done" || t.status === "waiting" ? (t.result ?? t.status) : t.status;
  return `<span class="name">${esc(t.name)}</span><span class="muted">: ${short(what, 48)}${t.agoMs != null ? `, ${dur(t.agoMs)} ago` : ""}</span>${retry}`;
}

/** "fight 45s, recover 15s" from a minute's seconds per activity group. */
const mixText = (mix) => Object.entries(mix).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k} ${v}s`).join(", ");

/** The two-hour timeline: one cell per minute coloured by its main activity, task spans below and death marks across. */
function timeline(tl) {
  // A server older than the page sends no timeline, and the row stays readable without it.
  if (!tl?.cells) return "";
  const H = 14;
  const cells = tl.cells
    .filter((c) => c.k)
    .map((c) => `<rect x="${c.m}" y="0" width="1" height="10" fill="${c.k === "idle" && c.i ? idleColor(c.i) : (ACT.find(([n]) => n === c.k)?.[1] ?? "var(--task)")}"><title>${hhmm(tl.start + c.m * 60000)} ${esc(mixText(c.mix))}${c.x ? `, ${big(c.x)} XP` : ""}</title></rect>`)
    .join("");
  const spans = tl.spans.map((x) => `<rect x="${x.from.toFixed(2)}" y="11" width="${Math.max(0.5, x.to - x.from).toFixed(2)}" height="3" fill="${x.status === "failed" ? "var(--bad)" : "var(--task)"}"><title>${esc(x.name)}${x.status === "running" ? " (running)" : x.status === "failed" ? " (failed)" : ""}</title></rect>`).join("");
  const deaths = tl.cells.filter((c) => c.d).map((c) => `<rect x="${c.m}" y="0" width="1.4" height="${H}" fill="var(--mark)"><title>${hhmm(tl.start + c.m * 60000)} ${c.d} death${c.d > 1 ? "s" : ""}</title></rect>`).join("");
  return `<svg class="tlsvg" viewBox="0 0 ${tl.minutes} ${H}" preserveAspectRatio="none" shape-rendering="crispEdges"><rect x="0" y="0" width="${tl.minutes}" height="10" fill="var(--border)"/>${cells}${[30, 60, 90].map((m) => `<rect x="${m}" y="0" width="0.3" height="10" fill="var(--card)" opacity="0.8"/>`).join("")}${spans}${deaths}</svg>`;
}

function details(s, g) {
  const d = g.details;
  const party = d.party.length ? d.party.map((m) => `<li><a href="#gear" class="gearlink name" data-char="${esc(m.name)}" title="Show the gear sheet">${esc(m.name)}</a> <span class="muted">${esc(SHORT[m.class] ?? m.class ?? "")}</span> <b>${m.level ?? "?"}</b></li>`).join("") : `<li class="muted">no party known</li>`;
  const rotation = d.rotation.length ? d.rotation.map((z) => `${esc(z.zone)}${z.crowdedMs != null ? ` <span class="warn">crowded ${dur(z.crowdedMs)} ago</span>` : ""}`).join(", ") : `<span class="muted">none</span>`;
  const facts = [
    ["Bags", d.bags ? `${d.bags.free} free of ${d.bags.capacity}${d.bags.cursor ? `, cursor holds ${esc(d.bags.cursor)}` : ""}` : "-"],
    ["Memory", d.heap ? `${d.heap.used} of ${d.heap.limit} MB` : "-"],
    ["Rotation", rotation],
    ...(d.crowded.length ? [["Crowded", d.crowded.map((z) => `${esc(z.zone)} ${dur(z.crowdedMs)} ago`).join(", ")]] : []),
    ["Last kill", g.lastKillMs != null ? `${dur(g.lastKillMs)} ago` : "-"],
    ...(g.waitedFor ? [["Waited for", esc(g.waitedFor)]] : []),
    ...(d.pause ? [["Paused", `${dur(d.pause.untilMs)} more: ${esc(d.pause.reason ?? "")}`]] : []),
    ...(d.errand ? [["Errand", `${esc(d.errand.item ?? d.errand.keep ?? "")} in ${esc(d.errand.zone)}`]] : []),
  ];
  const lines = d.lines.length ? d.lines.map((x) => `<li>${ago(s.now, x.t)} <span class="src">${esc(x.source)}</span> ${esc(x.text)}</li>`).join("") : `<li class="muted">nothing recorded</li>`;
  const hist = d.history.length
    ? d.history
        .map((h) => {
          const o = h.outcome ? ` <span class="${h.outcome.status === "failed" ? "bad" : "muted"}">${short(h.outcome.status === "failed" ? `failed: ${h.outcome.error ?? ""}` : (h.outcome.result ?? h.outcome.status), 60)}</span>` : "";
          return `<li>${ago(s.now, h.t)} <span class="name">${esc(h.name)}</span>${h.ms ? ` <span class="muted">${dur(h.ms)}</span>` : ""}${o}</li>`;
        })
        .join("")
    : `<li class="muted">no tasks recorded</li>`;
  return `<div class="detail">
    <div><h4>Party</h4><ul class="plainlist">${party}</ul></div>
    <div><h4>Tab</h4><dl>${facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl></div>
    <div><h4>Recent decisions and alerts</h4><ul class="plainlist lines">${lines}</ul></div>
    <div><h4>Task history</h4><ul class="plainlist lines">${hist}</ul></div>
  </div>`;
}

function renderGroups(s) {
  $("act-legend").innerHTML = ACT.map(([n, c]) => `<span><i style="background:${c}"></i>${n}</span>`).join("");
  const head = ["Group", "Level", "Zone", "Doing now", "XP/h", "Idle", "Last 2 hours", "Task"];
  const rows = s.groups
    .map((g) => {
      const open = openGroups.has(g.id);
      const idleCls = g.idleShare != null && g.idleShare >= 0.3 ? "bad" : g.idleShare != null && g.idleShare >= 0.15 ? "warn" : "";
      return `<tr class="grow${g.stuck ? " stuck" : ""}${open ? " open" : ""}" data-g="${esc(g.id)}" tabindex="0" role="button" aria-expanded="${open}">
        <td class="gid"><span class="caret"></span><b>${esc(g.id)}</b> <span class="muted">${esc(g.leader)}</span></td>
        <td class="lvl" title="${g.partyMin != null ? `party levels ${g.partyMin} to ${g.partyMax}, ` : ""}${pct(g.share)} of the XP to level 60"><b>${g.level ?? "?"}</b>${g.xpPct != null ? `<span class="muted"> ${Math.round(g.xpPct)}%</span>` : ""}${meter(g.share)}</td>
        <td class="zone">${esc(g.zone ?? "-")}</td>
        <td class="state">${stateCell(g)}<div class="zone2 muted small">${esc(g.zone ?? "-")}</div></td>
        <td class="n">${big(g.xpPerHour)}</td>
        <td class="idle ${idleCls}" title="share of the last ${g.idleWindow}">${pct(g.idleShare)}${g.idleCause ? ` <span class="muted">${esc(g.idleCause)}</span>` : ""}</td>
        <td class="tl">${timeline(g.timeline)}</td>
        <td class="task">${taskCell(s.now, g.task)}</td></tr>
        ${open ? `<tr class="drow"><td colspan="${head.length}">${details(s, g)}</td></tr>` : ""}`;
    })
    .join("");
  $("group-table").innerHTML = `<thead><tr>${head.map((h, i) => `<th class="${i === 4 ? "n" : ""}">${h}</th>`).join("")}</tr></thead><tbody>${rows}</tbody>`;
}

function toggleGroup(row) {
  const id = row?.dataset.g;
  if (!id) return;
  if (openGroups.has(id)) openGroups.delete(id);
  else openGroups.add(id);
  if (lastState) renderGroups(lastState);
}

// ---- Coordinator and time ----------------------------------------------------------------------

function renderCoordinator(s) {
  const c = s.coordinator;
  if (!s.coordinatorOn) return void ($("coord").innerHTML = `<p class="muted">Off. Start the collector with <code>--coordinate</code> to let it queue hand-ins and hunts.</p>`);
  if (!c) return void ($("coord").innerHTML = `<p class="muted">No pass yet.</p>`);
  const stock = Object.entries(c.stock).map(([k, v]) => `${v} ${k}`).join(", ") || "none";
  const list = (items, empty) => (items.length ? `<ul class="plainlist lines">${items.join("")}</ul>` : `<p class="muted small">${empty}</p>`);
  const running = c.running.map((t) => `<li><span class="grp">${esc(t.group)}</span> <span class="name">${esc(t.name)}</span> <span class="muted">${esc(t.step ?? "")} · ${dur(t.forMs)}</span></li>`);
  const retries = c.retries.slice(0, 8).map((r) => `<li><span class="when">${inMs(r.inMs)}</span> <span class="grp">${esc(r.group ?? "-")}</span> ${esc(r.name)}</li>`);
  const outcomes = c.outcomes.slice(0, 6).map((o) => `<li><span class="when">${dur(o.agoMs)} ago</span> <span class="grp">${esc(o.group)}</span> ${esc(o.name)}: <span class="${o.status === "failed" ? "bad" : "muted"}">${short(o.status === "failed" ? `failed at ${o.step ?? "?"}, ${o.error ?? ""}` : (o.result ?? o.status), 60)}</span></li>`);
  const decisions = c.decisions.slice(0, 6).map((d) => `<li><span class="when">${ago(s.now, d.t)}</span> ${d.group ? `<span class="grp">${esc(d.group)}</span> ` : ""}<span title="${esc(d.text)}">${esc(d.text)}</span></li>`);
  const ex = c.experiment;
  const experiment = ex.running.length ? ex.running.map((e) => `${esc(e.name)} since ${dur(e.sinceMs)} (A ${esc(e.a.join(", "))}, B ${esc(e.b.join(", "))})`).join("; ") : `none running${ex.lastEnded ? `, last: ${esc(ex.lastEnded.name)} ended ${dur(ex.lastEnded.agoMs)} ago` : ""}`;
  $("coord").innerHTML = `<p class="small muted">Pass ${dur(c.passAgeMs)} ago. Lightstones on the account: ${esc(stock)}. Experiment: ${experiment}.</p>
    <div class="trio">
      <div><h4>Running</h4>${list(running, "No task runs.")}<h4>Next retries</h4>${list(retries, "Nothing is waiting.")}</div>
      <div><h4>Recent outcomes</h4>${list(outcomes, "No task has ended yet.")}<h4>Recent decisions</h4>${list(decisions, "No decisions yet.")}</div>
    </div>`;
}

/** The hourly bars: height is the group-hours recorded in the hour, segments are the shares of each activity and idle cause. */
function renderTime(s) {
  const bars = s.hourly;
  if (!bars.some((b) => b.groupHours > 0)) {
    $("time-body").innerHTML = `<div class="note">No minute totals yet. The collector writes them while it runs, and <code>bun tools/iqd.mjs minutes</code> fills the past from the recorded samples.</div>`;
    return;
  }
  const W = 560, H = 210, L = 34, B = 22, T = 10;
  const cap = Math.max(s.groups.length, ...bars.map((b) => b.groupHours));
  const bw = (W - L - 4) / bars.length;
  const order = ["fight", "recover", "move", "task", "dead"];
  const segColor = (k) => (k.startsWith("idle/") ? idleColor(k.slice(5)) : (ACT.find(([n]) => n === k)?.[1] ?? "var(--task)"));
  const causes = new Set();
  const rects = bars
    .map((b, n) => {
      const tot = Object.values(b.sec).reduce((x, y) => x + y, 0);
      if (!tot) return "";
      const idle = Object.keys(b.sec).filter((k) => k.startsWith("idle/")).sort((x, y) => b.sec[y] - b.sec[x]);
      idle.forEach((k) => causes.add(k.slice(5)));
      const keys = [...order.filter((k) => b.sec[k]), ...idle];
      const full = ((H - B - T) * b.groupHours) / cap;
      let y = H - B;
      const x = L + n * bw + 1;
      const idleSec = idle.reduce((x2, k) => x2 + b.sec[k], 0);
      const tip = `${hhmm(b.t)}${b.partial ? " (so far)" : ""}: ${b.groupHours.toFixed(1)} group-hours, ${keys.map((k) => `${k.replace("idle/", "idle ")} ${pct(b.sec[k] / tot)}`).join(", ")}, idle ${pct(idleSec / tot)}${b.xp ? `, ${big(b.xp)} XP` : ""}${b.deaths ? `, ${b.deaths} death${b.deaths > 1 ? "s" : ""}` : ""}`;
      return `<g><title>${esc(tip)}</title>${keys.map((k) => { const h = (full * b.sec[k]) / tot; y -= h; return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(bw - 2).toFixed(1)}" height="${h.toFixed(1)}" fill="${segColor(k)}"${b.partial ? ' opacity="0.7"' : ""}/>`; }).join("")}</g>`;
    })
    .join("");
  const labels = bars.map((b, n) => (new Date(b.t).getHours() % 3 === 0 ? `<text x="${(L + n * bw + bw / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle">${String(new Date(b.t).getHours()).padStart(2, "0")}</text>` : "")).join("");
  const ticks = [0, 0.5, 1].map((f) => `<line class="grid" x1="${L}" x2="${W}" y1="${(H - B - (H - B - T) * f).toFixed(1)}" y2="${(H - B - (H - B - T) * f).toFixed(1)}"/><text x="${L - 4}" y="${(H - B - (H - B - T) * f + 4).toFixed(1)}" text-anchor="end">${(cap * f).toFixed(0)}</text>`).join("");
  const legend = [...ACT.filter(([n]) => n !== "idle").map(([n, c]) => `<span><i style="background:${c}"></i>${n}</span>`), ...[...causes].sort().map((c) => `<span><i style="background:${idleColor(c)}"></i>idle ${esc(c)}</span>`)].join("");
  $("time-body").innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%">${ticks}${rects}${labels}</svg><div class="legend wide">${legend}</div><p class="muted small">Bar height is the group-hours recorded in each hour (axis: group-hours), segments are shares of that time. The last bar is the current hour so far. Hover a bar for its numbers.</p>`;
}

// ---- Folded sections ---------------------------------------------------------------------------

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
  $("manual").innerHTML = table(["Time", "Actor", "Tab", "What"], s.attention.manual.map((x) => [ago(s.now, x.t), esc(x.actor), esc(x.session ?? ""), esc(x.text)]));
}

function renderRoster(s) {
  const r = s.roster;
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
}

function renderEpics(s) {
  const e = s.epics;
  $("d-epics").querySelector("summary").textContent = e ? `Epic chains (${e.chains.length}, ${e.holders} done, ${e.needers} to go)` : "Epic chains";
  if (!e) return void ($("epics").innerHTML = `<p class="muted">The coordinator has not saved a chain summary yet.</p>`);
  const names = (list) => (list.length > 4 ? `${esc(list.slice(0, 4).join(", "))} and ${list.length - 4} more` : esc(list.join(", ")) || "-");
  $("epics").innerHTML = table(["Class", "Chain item", "From level", "Hold it", "Started", "Still need it"], e.chains.map((c) => [esc(c.class), esc(c.reward), c.minLevel, c.holders.length, c.started.length, `${c.needers.length} <span class="muted">${names(c.needers)}</span>`]), [2, 3, 4]) + `<p class="muted small">Holders carry the chain's reward or an item that stands for it. Needers are the characters of the class at the chain's level who do not hold it.</p>`;
}

function renderJobs(s) {
  const j = s.jobs;
  $("jobs-list").innerHTML =
    `<h3>Open</h3>` + table(["#", "Since", "Purpose", "Output"], j.open.map((x) => [x.id, dur(s.now - x.started), esc(x.purpose), esc(x.output ?? "")])) + `<h3>Done</h3>` + table(["#", "Done", "Purpose", "Result"], j.done.map((x) => [x.id, `${dayName(x.done)} ${hhmm(x.done)}`, esc(x.purpose), esc(x.result ?? "")]));
}

function renderAlerts(s) {
  const a = s.attention;
  const info = Object.entries(a.info).map(([k, n]) => `${n} ${k}`).join(", ");
  $("alerts").innerHTML = table(["#", "Raised", "Took", "Kind", "Tab", "Text", "Note"], a.resolved.map((x) => [x.id, ago(s.now, x.t), dur(x.resolved - x.t), esc(x.kind), esc(x.session ?? ""), esc(x.text), esc(x.note ?? "")])) + (info ? `<p class="muted">Open info items: ${esc(info)}.</p>` : "");
}

async function renderTrends() {
  if (!$("d-trends").open) return;
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
    grid += `<text x="${X(tt)}" y="${H - 6}" text-anchor="middle">${hoursBack > 48 ? new Date(tt).toLocaleDateString([], { day: "numeric", month: "numeric" }) + " " : ""}${hhmm(tt)}</text>`;
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

// ---- Loop --------------------------------------------------------------------------------------

let lastState = null;
// The page files' version this page was loaded with (`page` in the state).
let pageVersion = null;

async function refresh() {
  let reached = false;
  try {
    const r = await fetch("/api/state");
    reached = true;
    const s = await r.json();
    if (s.error) throw new Error(`the collector's state failed: ${s.error}`);
    // Code that changed since this page loaded may read the state differently, so the page loads it anew.
    pageVersion ??= s.page;
    if (s.page !== pageVersion) return location.reload();
    lastState = s;
    renderStatus(s);
    renderNeeds(s);
    renderGoal(s);
    renderGroups(s);
    renderGear(s);
    renderCoordinator(s);
    renderEpics(s);
    renderTime(s);
    renderEngineering(s);
    renderRoster(s);
    renderJobs(s);
    renderAlerts(s);
    $("d-alerts").querySelector("summary").textContent = `Alert history (${s.attention.resolved.length})`;
  } catch (e) {
    $("status").innerHTML = `<h1>IdleQuest account</h1><div class="chip bad"><span class="k">Dashboard</span><span class="v">${reached ? "" : "not reachable: "}${esc(e.message)}</span></div>`;
  }
}

$("group-table").addEventListener("click", (e) => toggleGroup(e.target.closest("tr.grow")));
$("group-table").addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    toggleGroup(e.target.closest("tr.grow"));
  }
});
initGear();
$("trend-hours").addEventListener("change", renderTrends);
$("d-trends").addEventListener("toggle", renderTrends);
refresh();
setInterval(refresh, REFRESH_MS);
setInterval(renderTrends, 60000);
