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
const IDLE_COLORS = { noTarget: "#d9822b", crowded: "#e8b64f", afterKill: "#f0d08c", lootSettle: "#e6c27a", off: "#8d5a1f", held: "#7b6a55", clientPause: "#d0562c", clientRejoin: "#b8441f", contested: "#dca15e", readyWait: "#c46f3a", waitAttack: "#b9946a", noEnemies: "#a8431f", loadFailed: "#8f2d16", unknown: "#9a9a9a", other: "#c9b08a" };
const idleColor = (cause) => IDLE_COLORS[cause] ?? IDLE_COLORS.other;
// Idle causes in the reader's words, for the group rows and the hourly bars' legend.
const IDLE_WORDS = { noTarget: "no target", crowded: "crowded", afterKill: "after a kill", lootSettle: "looting", off: "AutoLevel off", held: "held by the bot", clientPause: "client paused", clientRejoin: "rejoining", contested: "target taken", readyWait: "party not ready", waitAttack: "waiting to attack", noEnemies: "no enemies", loadFailed: "zone load failed", unknown: "unexplained", other: "other" };
const idleWord = (cause) => IDLE_WORDS[cause] ?? cause;
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
        .map((x) => `<div class="need ${x.severity === "decide" ? "decide" : "act"}"><div class="line"><span class="tag">${esc(x.label)}</span>${x.groups.map((g) => `<span class="grp">${esc(g)}</span>`).join("")}<span class="when">${ago(s.now, x.t)}</span></div><div class="txt">${esc(x.text)}</div></div>`)
        .join("")
    : `<p class="calm">Nothing needs you.</p>`;
  $("needs-handled").innerHTML = n.handledTotal ? `Handled without you: ${n.handled.map((h) => `<span title="${esc(h.how)}">${h.n} ${esc(h.label)}</span>`).join(", ")}.` : "";
}

function barRow(title, share, bar, text, after = null) {
  return `<div class="goalrow"><div class="gl"><span class="gt">${esc(title)}</span><span class="gv">${bar}</span></div>${share == null ? `<div class="meter unknown"></div>` : meter(share, "", after)}<div class="gx">${text}</div></div>`;
}

/** What moved a goal bar in the last 24 hours, as a green "+N unit" beside its value. */
const delta = (n, unit) => (n > 0 ? ` <span class="up" title="in the last 24 hours, listed under Progress">+${n} ${unit}</span>` : "");

function renderGoal(s) {
  const g = s.goal;
  const L = g.levels;
  const r = g.recent ?? {};
  const eta = L.slowest ? ` <span title="${esc(`${L.slowest.leader}'s group, ${hours(L.slowest.low)} to ${hours(L.slowest.high)}`)}">${esc(L.slowest.group ?? L.slowest.leader)} reaches ${L.target} in about ${hours(L.slowest.hours)}.</span>` : "";
  const none = () => `<span class="muted">not measured yet</span>`;
  const R = g.raids;
  const latest = s.progress?.latest;
  $("goal-bars").innerHTML = [
    barRow(`Levels to ${L.target}`, L.share, `${(100 * L.share).toFixed(1)}% of the XP${delta(r.level, "levels")}`, `${L.atTarget ? `${L.atTarget} at ${L.target}. ` : ""}Levels ${L.minLevel ?? "-"} to ${L.maxLevel ?? "-"}.${eta}`),
    g.gear.share == null
      ? barRow("Gear", null, none(), "Waiting for the first gear pass.")
      : barRow("Gear", g.gear.share, `${pct(g.gear.share)} of the target${delta(r.gear, "slots")}`, g.gear.moves ? `${g.gear.moves} queued moves raise it to ${pct(g.gear.afterMoves)}.` : "", g.gear.afterMoves),
    g.aa.share == null
      ? barRow("AA ranks", null, none(), `AA opens at ${g.aa.level}: ${g.aa.reached} of ${g.aa.characters} characters there.`)
      : barRow("AA ranks", g.aa.share, `${g.aa.trained} of ${g.aa.possible} ranks${delta(r.aa, "ranks")}`, `${g.aa.points ? `${g.aa.points} points unspent. ` : ""}${g.aa.reached} of ${g.aa.characters} characters past ${g.aa.level}.`),
    g.epics.share == null
      ? barRow("Epics", null, none(), "Waiting for the coordinator's chain summary.")
      : barRow("Epics", g.epics.share, `${g.epics.holders} of ${g.epics.holders + g.epics.needers} steps${delta(r.chain, "steps")}`, `${g.epics.needers} characters still need theirs. ${g.epics.missingCopies} pieces to find.`),
    R.share == null
      ? barRow("Raid kills", null, none(), `Raids open at ${R.level}: ${R.reached} of ${R.characters} characters there.`)
      : barRow("Raid kills", R.share, `${R.killed.length} of ${R.goal.length} bosses${delta(r.raid, "kills")}`, R.killed.length ? `Killed: ${R.killed.map(esc).join(", ")}.` : `Raids open at ${R.level}: ${R.reached} of ${R.characters} characters there.`),
    latest ? `<p class="gx latest">Latest milestone ${ago(s.now, latest.t)}: ${latest.group ? `<span class="grp">${esc(latest.group)}</span> ` : ""}${esc(latest.text)}</p>` : "",
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
  // A task's own words stand in the Task column.
  return `<span class="dot" style="background:${actColor(st.act)}"></span>${esc(st.act)}${st.why && st.act !== "task" ? ` <span class="muted">${esc(idleWord(st.why))}</span>` : ""} <span class="muted">${dur(st.forMs)}</span>`;
}

const TASK_WORD = { hunt: "hunt", errand: "errand", quest: "quest", gear: "gear moves", handIn: "hand-in", raid: "raid", farm: "farm" };
/** What the group's task is now: a running task with its time, or a failure. A finished task leaves the cell to the group's activity. */
function taskCell(now, t) {
  if (!t) return "";
  const kind = TASK_WORD[t.kind] ?? t.kind ?? "task";
  const what = t.subject ?? t.name;
  const name = what && what !== kind ? ` <span class="name">${esc(what)}</span>` : "";
  if (t.status === "running") return `<span title="${esc(`${t.name ?? ""}${t.step ? `: ${t.step}` : ""}`)}">${esc(kind)}${name} <span class="muted">${dur(t.forMs)}</span></span>`;
  if (t.status === "failed") return `<span class="bad" title="${esc(`${t.step ? `at ${t.step}: ` : ""}${t.error ?? ""}${t.retryInMs != null ? `. Retry ${inMs(t.retryInMs)}.` : ""}`)}">${esc(kind)} failed</span>${name}`;
  return "";
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
  const progress = d.progress?.length ? d.progress.map((p) => `<li class="${progressClass(p)}">${ago(s.now, p.t)} ${kindTag(p.kind)} ${withItems(esc(p.text), p.items, s.cards ?? {})}${p.detail ? ` <span class="muted">${esc(p.detail)}</span>` : ""}</li>`).join("") : `<li class="muted">nothing in two days</li>`;
  const hist = d.history.length
    ? d.history
        .map((h) => {
          const o = h.outcome ? ` <span class="${h.outcome.status === "failed" ? "bad" : "muted"}">${short(h.outcome.status === "failed" ? `failed: ${h.outcome.error ?? ""}` : (h.outcome.result ?? h.outcome.status), 60)}</span>` : "";
          return `<li>${ago(s.now, h.t)} <span class="name">${esc(h.name)}</span>${h.ms ? ` <span class="muted">${dur(h.ms)}</span>` : ""}${o}</li>`;
        })
        .join("")
    : `<li class="muted">no tasks recorded</li>`;
  return `<div class="detail">
    <div><h4>Party</h4><ul class="plainlist">${party}</ul><h4>Progress</h4><ul class="plainlist lines progress">${progress}</ul></div>
    <div><h4>Tab</h4><dl>${facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl></div>
    <div><h4>Recent decisions and alerts</h4><ul class="plainlist lines">${lines}</ul></div>
    <div><h4>Task history</h4><ul class="plainlist lines">${hist}</ul></div>
  </div>`;
}

// ---- Progress ----------------------------------------------------------------------------------

/** The page's names for the progress kinds (tools/lib/progress.mjs), in the goal's order. */
const PROGRESS_LABELS = { level: "Levels", gear: "Gear", item: "Items", chain: "Chains", aa: "AA", raid: "Raids" };
const kindTag = (k) => `<span class="ktag k-${esc(k)}">${k === "aa" ? "AA" : esc(k)}</span>`;
/** Milestones stand out and minor steps recede. */
const progressClass = (p) => (p.sig >= 2 ? "ms" : p.sig === 0 ? "minor" : "");
let progressFilter = "all";
// The merged rows open on the page, by key, so a refresh keeps them open.
const openProgress = new Set();

/**
 * A row's escaped text, with each item it names (`items` of the progress rows) as its chip, and for
 * an upgraded slot first the replaced item's icon and an arrow, an empty box for an empty slot.
 */
function withItems(html, refs, cards) {
  let out = html;
  let from = 0;
  for (const r of refs ?? []) {
    const name = esc(r.name);
    const at = out.indexOf(name, from);
    if (at < 0) continue;
    const old = !("was" in r) ? "" : `${r.was ? (cards[r.was.id] ? itemChip(cards[r.was.id], r.was.name, { iconOnly: true }) : `<span class="muted">${esc(r.was.name)}</span>`) : `<span class="ichip empty" title="the slot was empty"></span>`}<span class="swap">→</span>`;
    const chip = old + itemChip(cards[r.id], r.name);
    out = out.slice(0, at) + chip + out.slice(at + name.length);
    from = at + chip.length;
  }
  return out;
}

/** A row's text and detail, and for a row of several events a list of them that opens on a click. */
function progressText(p, cards) {
  const head = `${withItems(esc(p.text), p.items, cards)}${p.detail ? ` <span class="muted">${esc(p.detail)}</span>` : ""}`;
  if (!p.parts?.length) return head;
  const parts = p.parts.map((x) => `<li>${x.group && x.group !== p.group ? `<span class="grp">${esc(x.group)}</span> ` : ""}${withItems(esc(x.text), x.items, cards)}</li>`).join("");
  return `<details data-key="${esc(p.key)}"${openProgress.has(p.key) ? " open" : ""}><summary>${head}</summary><ul class="plainlist parts">${parts}</ul></details>`;
}

function renderProgress(s) {
  const P = s.progress;
  if (!P) return;
  const filters = [["all", "All", () => true], ["ms", "Milestones", (p) => p.sig >= 2], ...Object.entries(PROGRESS_LABELS).map(([k, label]) => [k, label, (p) => p.kind === k])];
  $("progress-filters").innerHTML = filters.map(([k, label, f]) => `<button type="button" class="fchip${progressFilter === k ? " on" : ""}" data-k="${k}">${label} <b>${P.rows.filter(f).length}</b></button>`).join("");
  const shown = P.rows.filter(filters.find(([k]) => k === progressFilter)?.[2] ?? (() => true));
  const out = [];
  let day = null;
  for (const p of shown) {
    if (dayName(p.t) !== day) out.push(`<div class="pday">${esc((day = dayName(p.t)))}</div>`);
    out.push(`<div class="prow ${progressClass(p)}"><span class="when" title="${esc(`${dayName(p.t)} ${clock(p.t)}`)}">${hhmm(p.t)}</span><span>${p.group ? `<span class="grp">${esc(p.group)}</span>` : ""}</span>${kindTag(p.kind)}<span class="ptxt">${progressText(p, s.cards ?? {})}</span></div>`);
  }
  $("progress-list").innerHTML = out.join("") || `<p class="muted">${P.rows.length ? "Nothing of this kind" : "Nothing recorded"} in the last ${P.hours} hours.</p>`;
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
        <td class="idle ${idleCls}" title="share of the last ${g.idleWindow}">${pct(g.idleShare)}${g.idleCause ? ` <span class="muted">${esc(idleWord(g.idleCause))}</span>` : ""}</td>
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

/** What the coordinator runs now and how its last tasks ended, each task by what it is after. */
function renderCoordinator(s) {
  const c = s.coordinator;
  if (!s.coordinatorOn) return void ($("coord").innerHTML = `<p class="muted">Off. Start the collector with <code>--coordinate</code> to let it queue hand-ins and hunts.</p>`);
  if (!c) return void ($("coord").innerHTML = `<p class="muted">No pass yet.</p>`);
  const list = (items, empty) => (items.length ? `<ul class="plainlist lines">${items.join("")}</ul>` : `<p class="muted small">${empty}</p>`);
  const running = c.running.map((t) => `<li title="${esc(`${t.name ?? ""}${t.step ? `: ${t.step}` : ""}`)}"><span class="grp">${esc(t.group)}</span> ${esc(TASK_WORD[t.kind] ?? t.kind ?? "task")} <span class="name">${esc(t.subject ?? t.name)}</span> <span class="muted">${dur(t.forMs)}</span></li>`);
  // The bot's results in a few words: an item got, an enemy not up, a camp waiting for its spawn.
  const ended = (o) => {
    if (o.status === "failed") return `<span class="bad" title="${esc(`${o.step ? `at ${o.step}: ` : ""}${o.error ?? ""}`)}">failed</span>`;
    const r = o.result ?? o.status;
    if (/^got /.test(r)) return `<span class="got">${esc(r)}</span>`;
    const spawn = /next spawn at (\d+:\d+)/.exec(r);
    const words = spawn ? `spawns at ${spawn[1]}` : /^none of .* up$/.test(r) ? "not up" : r === "time is up" ? "no drop in time" : short(r, 48);
    return `<span class="muted" title="${esc(r)}">${esc(words)}</span>`;
  };
  const outcomes = c.outcomes.slice(0, 8).map((o) => `<li title="${esc(o.name)}"><span class="when">${dur(o.agoMs)} ago</span> <span class="grp">${esc(o.group ?? "-")}</span> <span class="name">${esc(o.subject)}</span>: ${ended(o)}</li>`);
  const experiments = c.experiments.map((e) => `<p class="small">Experiment ${esc(e.name)} for ${dur(e.sinceMs)}: ${esc(e.a.join(", "))} against ${esc(e.b.join(", "))}.</p>`).join("");
  $("coord").innerHTML = `${experiments}<div class="trio"><div><h4>Running</h4>${list(running, "No task runs.")}</div><div><h4>Ended</h4>${list(outcomes, "No task has ended yet.")}</div></div>`;
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
  // Idle causes under 1% of the day's time merge into "other", so the legend names what matters.
  const day = {};
  for (const b of bars) for (const [k, v] of Object.entries(b.sec)) day[k] = (day[k] ?? 0) + v;
  const dayTotal = Object.values(day).reduce((x, y) => x + y, 0);
  const keyOf = (k) => (k.startsWith("idle/") && day[k] < 0.01 * dayTotal ? "idle/other" : k);
  const causes = new Set();
  const rects = bars
    .map((raw, n) => {
      const b = { ...raw, sec: {} };
      for (const [k, v] of Object.entries(raw.sec)) b.sec[keyOf(k)] = (b.sec[keyOf(k)] ?? 0) + v;
      const tot = Object.values(b.sec).reduce((x, y) => x + y, 0);
      if (!tot) return "";
      const idle = Object.keys(b.sec).filter((k) => k.startsWith("idle/")).sort((x, y) => b.sec[y] - b.sec[x]);
      idle.forEach((k) => causes.add(k.slice(5)));
      const keys = [...order.filter((k) => b.sec[k]), ...idle];
      const full = ((H - B - T) * b.groupHours) / cap;
      let y = H - B;
      const x = L + n * bw + 1;
      const idleSec = idle.reduce((x2, k) => x2 + b.sec[k], 0);
      const tip = `${hhmm(b.t)}${b.partial ? " (so far)" : ""}: ${b.groupHours.toFixed(1)} group-hours, ${keys.map((k) => `${k.startsWith("idle/") ? `idle, ${idleWord(k.slice(5))}` : k} ${pct(b.sec[k] / tot)}`).join(", ")}, idle ${pct(idleSec / tot)}${b.xp ? `, ${big(b.xp)} XP` : ""}${b.deaths ? `, ${b.deaths} death${b.deaths > 1 ? "s" : ""}` : ""}`;
      return `<g><title>${esc(tip)}</title>${keys.map((k) => { const h = (full * b.sec[k]) / tot; y -= h; return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(bw - 2).toFixed(1)}" height="${h.toFixed(1)}" fill="${segColor(k)}"${b.partial ? ' opacity="0.7"' : ""}/>`; }).join("")}</g>`;
    })
    .join("");
  const labels = bars.map((b, n) => (new Date(b.t).getHours() % 3 === 0 ? `<text x="${(L + n * bw + bw / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle">${String(new Date(b.t).getHours()).padStart(2, "0")}</text>` : "")).join("");
  const ticks = [0, 0.5, 1].map((f) => `<line class="grid" x1="${L}" x2="${W}" y1="${(H - B - (H - B - T) * f).toFixed(1)}" y2="${(H - B - (H - B - T) * f).toFixed(1)}"/><text x="${L - 4}" y="${(H - B - (H - B - T) * f + 4).toFixed(1)}" text-anchor="end">${(cap * f).toFixed(0)}</text>`).join("");
  const legend = [...ACT.filter(([n]) => n !== "idle").map(([n, c]) => `<span><i style="background:${c}"></i>${n}</span>`), ...[...causes].sort().map((c) => `<span><i style="background:${idleColor(c)}"></i>idle, ${esc(idleWord(c))}</span>`)].join("");
  $("time-body").innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%">${ticks}${rects}${labels}</svg><div class="legend wide">${legend}</div>`;
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
  $("eng-charts").title = "Manual interventions are SDK calls and notes started by hand. Stalls are the collector's stall, no-kill, gone and no-bridge items.";
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

/** The epic chains someone still needs, and how many every eligible character has finished. */
function renderEpics(s) {
  const e = s.epics;
  $("d-epics").querySelector("summary").textContent = e ? `Epic chains (${e.holders} done, ${e.needers} to go)` : "Epic chains";
  if (!e) return void ($("epics").innerHTML = `<p class="muted">The coordinator has not saved a chain summary yet.</p>`);
  const names = (list) => (list.length > 4 ? `${esc(list.slice(0, 4).join(", "))} and ${list.length - 4} more` : esc(list.join(", ")));
  const open = e.chains.filter((c) => c.needers.length).sort((a, b) => b.needers.length - a.needers.length);
  const done = e.chains.length - open.length;
  $("epics").innerHTML = table(["Class", "Chain item", "From level", "Still need it"], open.map((c) => [esc(c.class), esc(c.reward), c.minLevel, `${c.needers.length} <span class="muted">${names(c.needers)}</span>`]), [2]) + (done ? `<p class="muted small">${done} more chains are done by every character that can take them.</p>` : "");
}

/** Open jobs, and what the latest finished ones found, with each job's purpose in its hover. */
function renderJobs(s) {
  const j = s.jobs;
  const open = j.open.length ? table(["Since", "Job"], j.open.map((x) => [dur(s.now - x.started), esc(x.purpose)])) : `<p class="muted small">No job is running.</p>`;
  const done = table(["Done", "Result"], j.done.slice(0, 8).map((x) => [`${dayName(x.done)} ${hhmm(x.done)}`, `<span title="${esc(x.purpose)}">${esc(x.result ?? "")}</span>`]));
  $("jobs-list").innerHTML = `<h3>Running</h3>${open}<h3>Found</h3>${done}`;
}

/** Resolved items, one row per kind and ending, with their groups and the text in the hover. */
function renderAlerts(s) {
  $("alerts").innerHTML = table(
    ["Raised", "What", "Groups", "Ended"],
    s.attention.resolved.map((x) => [ago(s.now, x.t), `<span title="${esc(x.text)}">${esc(x.title)}${x.n > 1 ? ` <span class="muted">×${x.n}</span>` : ""}</span>`, x.groups.map((g) => `<span class="grp">${esc(g)}</span>`).join(" "), `<span class="muted">${esc(x.note ?? "")}, after ${dur(x.tookMs)}</span>`]),
  );
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
    renderProgress(s);
    renderGear(s);
    renderCoordinator(s);
    renderEpics(s);
    renderTime(s);
    renderEngineering(s);
    renderRoster(s);
    renderJobs(s);
    renderAlerts(s);
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
$("progress-filters").addEventListener("click", (e) => {
  const b = e.target.closest("button.fchip");
  if (!b) return;
  progressFilter = b.dataset.k;
  if (lastState) renderProgress(lastState);
});
// A toggle event does not bubble, so the list listens in the capture phase.
$("progress-list").addEventListener(
  "toggle",
  (e) => {
    const k = e.target.dataset?.key;
    if (!k) return;
    if (e.target.open) openProgress.add(k);
    else openProgress.delete(k);
  },
  true,
);
initGear();
$("trend-hours").addEventListener("change", renderTrends);
$("d-trends").addEventListener("toggle", renderTrends);
refresh();
setInterval(refresh, REFRESH_MS);
setInterval(renderTrends, 60000);
