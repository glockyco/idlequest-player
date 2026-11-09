// The gear section of the dashboard: a compact summary per group and a character sheet with the
// paper doll of the inventory window. Loaded before app.js, which calls `initGear` and `renderGear`
// and provides `$`, `esc`, `pct` and the other helpers these functions use when they run.

const ICON_URL = (n) => `https://idlequest.net/icons/${n}.gif`;
// The layout of EverQuest's inventory window, by slot number: the left column, the right column and the bottom row.
const DOLL = {
  left: [1, 5, 3, 2, 6, 7, 8, 9, 10, 11],
  right: [4, 15, 16, 17, 12, 20, 18, 19],
  bottom: [13, 14, 21, 0],
};
const SLOT_LABEL = { 0: "Charm", 1: "Ear", 2: "Head", 3: "Face", 4: "Ear", 5: "Neck", 6: "Shoulders", 7: "Arms", 8: "Back", 9: "Wrist", 10: "Wrist", 11: "Range", 12: "Hands", 13: "Primary", 14: "Secondary", 15: "Finger", 16: "Finger", 17: "Chest", 18: "Legs", 19: "Feet", 20: "Waist", 21: "Ammo" };
const CLASS_BITS = [["WAR", 1], ["CLR", 2], ["PAL", 4], ["RNG", 8], ["SHD", 16], ["DRU", 32], ["MNK", 64], ["BRD", 128], ["ROG", 256], ["SHM", 512], ["NEC", 1024], ["WIZ", 2048], ["MAG", 4096], ["ENC", 8192]];
const RACE_BITS = [["HUM", 1], ["BAR", 2], ["ERU", 4], ["ELF", 8], ["HIE", 16], ["DEF", 32], ["HEF", 64], ["DWF", 128], ["TRL", 256], ["OGR", 512], ["HFL", 1024], ["GNM", 2048], ["IKS", 4096], ["VAH", 8192]];
const ITEM_TYPE = { 0: "1H Slashing", 1: "2H Slashing", 2: "1H Piercing", 3: "1H Blunt", 4: "2H Blunt", 5: "Archery", 7: "Throwing", 8: "Shield", 10: "Armor", 11: "Misc", 23: "Wind Instrument", 24: "Stringed Instrument", 25: "Brass Instrument", 26: "Percussion Instrument", 29: "Jewelry", 35: "2H Piercing", 36: "Hand to Hand", 45: "Hand to Hand", 50: "Singing" };
const ALL_CLASSES = 16383;

/** The mask's names, or `all` when it holds every class or race. */
const maskNames = (mask, table, all) => ((mask & ALL_CLASSES) === ALL_CLASSES ? all : table.filter(([, b]) => mask & b).map(([n]) => n).join(" "));

/** The tooltip body for an item card, in the layout of the game's item window. */
function itemTip(c) {
  const stat = (label, v) => (v ? `${label}: ${v > 0 ? "+" : ""}${v}` : "");
  // A line of the parts that are not empty, or nothing.
  const row = (...parts) => (parts.some(Boolean) ? `<div>${parts.filter(Boolean).join("&nbsp;&nbsp;")}</div>` : "");
  const flags = c.flags ?? [];
  const lines = [
    flags.length ? `<div class="tflags">${flags.map(esc).join(" &nbsp; ")}</div>` : "",
    c.slots?.length ? `<div>Slot: ${esc(c.slots.join(" ").toUpperCase())}</div>` : "",
    c.damage ? `<div>${esc(ITEM_TYPE[c.type] ?? "Weapon")} &nbsp; Atk Delay: ${c.delay ?? "-"}</div><div>DMG: ${c.damage}${c.delay ? ` &nbsp; <span class="muted">(${(c.damage / c.delay).toFixed(3)} per delay)</span>` : ""}</div>` : c.type === 8 ? "<div>Shield</div>" : "",
    row(c.ac ? `AC: ${c.ac}` : "", stat("HP", c.hp), stat("MANA", c.mana), stat("END", c.endur)),
    row(stat("STR", c.astr), stat("STA", c.asta), stat("AGI", c.aagi), stat("DEX", c.adex)),
    row(stat("WIS", c.awis), stat("INT", c.aint), stat("CHA", c.acha), stat("ATK", c.attack)),
    row(stat("SV MAGIC", c.mr), stat("SV FIRE", c.fr), stat("SV COLD", c.cr), stat("SV DISEASE", c.dr), stat("SV POISON", c.pr)),
    c.haste ? `<div>Haste: +${c.haste}%</div>` : "",
    row(stat("HP Regen", c.regen), stat("Mana Regen", c.manaregen)),
    c.bardvalue ? `<div>Instrument modifier: ${c.bardvalue * 10}%</div>` : "",
    c.weight ? `<div>WT: ${(c.weight / 10).toFixed(1)}</div>` : "",
    `<div>Class: ${esc(maskNames(c.classes, CLASS_BITS, "ALL"))}</div>`,
    `<div>Race: ${esc(maskNames(c.races, RACE_BITS, "ALL"))}</div>`,
    c.reqlevel ? `<div>Required level of ${c.reqlevel}.</div>` : "",
  ];
  return `<div class="tname">${esc(c.name)}</div>${lines.join("")}`;
}

/** Where the optimal item of a slot comes from, as lines for its tooltip. */
function sourceTip(slot) {
  const o = slot.optimal;
  if (!o) return "";
  if (o.kind === "drop") {
    const d = slot.drop;
    return `<div class="tsrc">Wanted drop: ${esc(d.zoneName ?? d.zone)}, ${esc(d.npc)}, about ${d.hours >= 10 ? Math.round(d.hours) : d.hours.toFixed(1)} h of hunting per copy. Raises the slot score by ${d.gain}.</div>${slot.move ? `<div class="tsrc muted">Until then the queued move gives ${esc(slot.move.item)} ${slot.move.buy ? "from a merchant" : `from ${esc(slot.move.from)}`}.</div>` : ""}`;
  }
  const m = slot.move;
  return o.kind === "buy"
    ? `<div class="tsrc">Queued purchase: ${esc(m.buy.merchant)} in ${esc(m.buy.zoneName ?? m.buy.zone)} for ${m.buy.price} pp. Raises the slot score by ${m.gain}.</div>`
    : `<div class="tsrc">Queued move from ${esc(m.from)}. Raises the slot score by ${m.gain}.</div>`;
}

/** The text of an optimal item's source for the list beside the doll. */
function sourceText(slot) {
  const o = slot.optimal;
  if (o.kind === "drop") return `wanted drop: ${slot.drop.zoneName ?? slot.drop.zone}, ${slot.drop.npc}, about ${slot.drop.hours >= 10 ? Math.round(slot.drop.hours) : slot.drop.hours.toFixed(1)} h per copy`;
  if (o.kind === "buy") return `queued purchase from ${slot.move.buy.merchant} in ${slot.move.buy.zoneName ?? slot.move.buy.zone} for ${slot.move.buy.price} pp`;
  return `queued move from ${slot.move.from}`;
}

// The stats the totals table adds up over the worn items, and over the optimal items.
const TOTALS = [["ac", "AC"], ["hp", "HP"], ["mana", "Mana"], ["astr", "STR"], ["asta", "STA"], ["aagi", "AGI"], ["adex", "DEX"], ["awis", "WIS"], ["aint", "INT"], ["acha", "CHA"], ["mr", "SV Magic"], ["fr", "SV Fire"], ["cr", "SV Cold"], ["dr", "SV Disease"], ["pr", "SV Poison"]];

/** The totals table: what the worn items add up to, and what the sheet would add up to with every optimal item. */
function totalsTable(sheet) {
  const sum = (pick) => Object.fromEntries(TOTALS.map(([k]) => [k, sheet.slots.reduce((a, s) => a + (pick(s)?.[k] ?? 0), 0)]));
  const now = sum((s) => (s.worn ? sheet.items[s.worn.itemId] : null));
  const best = sum((s) => (s.optimal ? sheet.items[s.optimal.itemId] : s.worn ? sheet.items[s.worn.itemId] : null));
  const rows = TOTALS.filter(([k]) => now[k] || best[k]).map(([k, label]) => {
    const d = best[k] - now[k];
    return `<tr><td>${label}</td><td class="n">${now[k]}</td><td class="n">${best[k]}</td><td class="n ${d > 0 ? "up" : d < 0 ? "down" : ""}">${d ? (d > 0 ? "+" : "") + d : ""}</td></tr>`;
  });
  return `<table class="totals"><thead><tr><th>Worn items add up to</th><th class="n">now</th><th class="n">optimal</th><th class="n"></th></tr></thead><tbody>${rows.join("")}</tbody></table>`;
}

const tips = new Map();
let sheetName = null;
let sheetJson = "";

function icon(card, cls = "") {
  // An icon the server does not have shows the item's initials.
  return card ? `<img class="${cls}" src="${ICON_URL(card.icon)}" alt="" loading="lazy" data-n="${esc(card.name.slice(0, 2))}" onerror="this.replaceWith(Object.assign(document.createElement('span'), { className: 'noicon', textContent: this.dataset.n }))">` : "";
}

/** One slot of the doll: the worn item's icon, or an empty box, with the optimal item as a small icon at its corner. */
function slotBox(sheet, n) {
  const slot = sheet.slots.find((x) => x.slotNum === n);
  const worn = slot?.worn ? (sheet.items[slot.worn.itemId] ?? { id: slot.worn.itemId, name: slot.worn.name, icon: 0, classes: 16383, races: 16383, slots: [] }) : null;
  const best = slot?.optimal ? sheet.items[slot.optimal.itemId] : null;
  if (worn) tips.set(`w${n}`, itemTip(worn));
  if (best) tips.set(`o${n}`, `<div class="thead">Optimal for ${esc(SLOT_LABEL[n])}</div>${itemTip(best)}${sourceTip(slot)}`);
  return `<div class="slot${worn ? "" : " empty"}${best ? " upgrade" : ""}">
    <div class="box" ${worn ? `data-tip="w${n}"` : ""}>${worn ? icon(worn) : `<span class="sl">${SLOT_LABEL[n]}</span>`}</div>
    ${best ? `<div class="opt" data-tip="o${n}">${icon(best)}</div>` : ""}</div>`;
}

function renderSheet(sheet) {
  const el = $("sheet");
  tips.clear();
  if (!sheet?.found) {
    el.innerHTML = `<p class="muted">${sheet?.name ? `${esc(sheet.name)} has no sheet yet. The gear pass saves one for every character it surveys, once an hour.` : "Pick a character."}</p>`;
    return;
  }
  const sc = sheet.score;
  const head = sc
    ? `Gear score <b>${sc.now}</b> of <b>${sc.target}</b> (${pct(sheet.share)}) now, <b>${sc.moves}</b> (${pct(sheet.afterMoves)}) once the queued moves are done.`
    : "No score for this character.";
  const changes = sheet.slots.filter((s) => s.optimal);
  const list = changes.length
    ? changes
        .map((s) => {
          const best = sheet.items[s.optimal.itemId];
          const own = s.worn ? esc(s.worn.name) : "empty";
          return `<li><span class="sn">${esc(SLOT_LABEL[s.slotNum])}</span> ${own} <span class="muted">to</span> <b>${esc(best?.name ?? s.optimal.item)}</b> <span class="muted">${esc(sourceText(s))}</span></li>`;
        })
        .join("")
    : `<li class="muted">No item from the account, the merchants or the wanted drops beats a worn one by enough: 0.5% of the wearer's output for a move, 1% for a drop. Armor and jewelry that add only AC and HP are worth almost nothing to XP per hour while leveling.</li>`;
  el.innerHTML = `<div class="sheet-head"><span class="cname">${esc(sheet.name)}</span><span class="muted">${esc(sheet.group)} · ${esc(sheet.race ?? "?")} ${esc(sheet.class ?? "?")} · level ${sheet.level ?? "?"}${sheet.xpPct != null ? ` (${Math.round(sheet.xpPct)}%)` : ""}</span></div>
    <div class="sheet-score">${head}</div>
    <div class="sheet-body">
      <div class="doll">
        <div class="col">${DOLL.left.map((n) => slotBox(sheet, n)).join("")}</div>
        <div class="mid"><div class="portrait"><b>${esc(sheet.class ?? "")}</b><span>${esc(sheet.race ?? "")}</span><span>Level ${sheet.level ?? "?"}</span></div>
          <div class="legend2"><span class="box mini"></span> worn<br><span class="optsample"></span> optimal item</div></div>
        <div class="col">${DOLL.right.map((n) => slotBox(sheet, n)).join("")}</div>
        <div class="bottom">${DOLL.bottom.map((n) => slotBox(sheet, n)).join("")}</div>
      </div>
      <div class="changes"><h4>What lifts the score</h4><ul class="plainlist">${list}</ul>
        <div class="totals-wrap">${totalsTable(sheet)}</div>
        <p class="muted small">Items are valued by the share of the wearer's output they add (outputValue and weaponRatio in tools/lib/gear-data.mjs). Optimal is the best the account's items, the merchants and the wanted drops give, not the best in the game. Hover a slot for its item.</p></div>
    </div>`;
}

async function loadSheet() {
  if (!sheetName) return;
  const sheet = await (await fetch(`/api/gear?name=${encodeURIComponent(sheetName)}`)).json();
  const json = JSON.stringify(sheet);
  if (json === sheetJson) return;
  sheetJson = json;
  renderSheet(sheet);
}

/** Show `name`'s sheet and keep it selected across refreshes. */
function pickCharacter(name, scroll = false) {
  sheetName = name;
  sheetJson = "";
  try {
    localStorage.setItem("gear-sheet", name);
  } catch {
    /* storage can be off */
  }
  $("gear-select").value = name;
  document.querySelectorAll(".gchip").forEach((b) => b.classList.toggle("sel", b.dataset.char === name));
  loadSheet();
  if (scroll) $("gear").scrollIntoView({ behavior: "smooth" });
}

/** The summary rows (one per group, a chip per character) and the selector of all characters. */
function renderGear(s) {
  const g = s.gear;
  if (!sheetName) {
    let saved = null;
    try {
      saved = localStorage.getItem("gear-sheet");
    } catch {
      /* storage can be off */
    }
    const first = g.groups[0]?.characters[0]?.name;
    sheetName = g.groups.some((x) => x.characters.some((c) => c.name === saved)) ? saved : first;
  }
  $("gear-select").innerHTML = g.groups.map((grp) => `<optgroup label="${esc(grp.id)}">${grp.characters.map((c) => `<option value="${esc(c.name)}"${c.name === sheetName ? " selected" : ""}>${esc(c.name)} (${esc(SHORT[c.class] ?? c.class ?? "?")} ${c.level ?? "?"})</option>`).join("")}</optgroup>`).join("");
  $("gear-rows").innerHTML = g.groups
    .map(
      (grp) =>
        `<div class="grow2"><div class="gname"><b>${esc(grp.id)}</b> <span class="muted">${pct(grp.share)}</span></div><div class="chipsrow">${grp.characters
          .map(
            (c) =>
              `<button type="button" class="gchip${c.name === sheetName ? " sel" : ""}" data-char="${esc(c.name)}" title="${esc(c.name)}: ${c.planned ? `gear score ${c.now} of ${c.target} (${pct(c.share)}), ${c.moves} after the queued moves` : "not in the last gear pass"}"><span class="cn">${esc(c.name)} <span class="muted">${esc(SHORT[c.class] ?? c.class ?? "")} ${c.level ?? ""}</span></span><span class="meter">${c.planned ? `<i class="after" style="width:${(100 * (c.afterMoves ?? 0)).toFixed(1)}%"></i><i style="width:${(100 * (c.share ?? 0)).toFixed(1)}%"></i>` : ""}</span></button>`,
          )
          .join("")}</div></div>`,
    )
    .join("");
  renderWanted(g.wanted ?? []);
  loadSheet();
}

/** The most wanted enemies: one row each, with every wanted item, its taker and its gain. */
function renderWanted(rows) {
  const head = `<thead><tr><th>Enemy</th><th>Zone</th><th>Status</th><th>Items (best taker, gain, hours per copy, characters it would serve)</th></tr></thead>`;
  const hours = (h) => (h >= 10 ? `${Math.round(h)} h` : `${h.toFixed(1)} h`);
  const body = rows.length
    ? rows
        .map((t) => `<tr><td>${esc(t.npc)}</td><td>${esc(t.zone)}</td><td class="${/^(hunting|errand|camp|visit)/.test(t.status ?? "") ? "" : "muted"}">${esc(t.status ?? "not weighed yet")}</td><td>${t.items.map((w) => `${esc(w.item)} <span class="muted">(${esc(w.to)}${w.group ? ` ${esc(w.group)}` : ""}, ${w.gain.toFixed(1)}%, ${hours(w.hours)}${w.takers > 1 ? `, ${w.takers} characters` : ""})</span>`).join("<br>")}</td></tr>`)
        .join("")
    : `<tr><td colspan="4" class="muted">No wanted drops in the last gear pass.</td></tr>`;
  $("wanted").innerHTML = head + `<tbody>${body}</tbody>`;
}

function initGear() {
  $("gear-rows").addEventListener("click", (e) => {
    const b = e.target.closest(".gchip");
    if (b) pickCharacter(b.dataset.char);
  });
  $("gear-select").addEventListener("change", (e) => pickCharacter(e.target.value));
  // A party member's name in a group's details opens the sheet.
  document.addEventListener("click", (e) => {
    const a = e.target.closest("a.gearlink");
    if (!a) return;
    e.preventDefault();
    e.stopPropagation();
    pickCharacter(a.dataset.char, true);
  });
  const tip = $("tip");
  const move = (e) => {
    const pad = 14;
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    tip.style.left = `${Math.max(4, Math.min(window.innerWidth - w - 4, e.clientX + pad))}px`;
    tip.style.top = `${Math.max(4, Math.min(window.innerHeight - h - 4, e.clientY + pad))}px`;
  };
  document.addEventListener("mouseover", (e) => {
    const t = e.target.closest("[data-tip]");
    if (!t || !tips.has(t.dataset.tip)) return void (tip.hidden = true);
    tip.innerHTML = tips.get(t.dataset.tip);
    tip.hidden = false;
    move(e);
  });
  document.addEventListener("mousemove", (e) => {
    if (!tip.hidden) move(e);
  });
  document.addEventListener("mouseout", (e) => {
    if (e.target.closest("[data-tip]") && !e.relatedTarget?.closest?.("[data-tip]")) tip.hidden = true;
  });
}
