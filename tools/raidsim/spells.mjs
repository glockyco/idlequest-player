// spells_new rows to the client's compact spell record (the shape of its static spells asset,
// read by `JE` in main.pretty.js), so the client's own spell store can hold the content snapshot.
import { table } from "./content.mjs";

const range = (n) => Array.from({ length: n }, (_, i) => i + 1);

// The compact record keeps effect slots up to the last one that is not SPA 254 (empty).
function effects(r) {
  const slots = range(12).map((i) => [r[`effectid${i}`], r[`effect_base_value${i}`], r[`formula${i}`], r[`max${i}`], r[`effect_limit_value${i}`] ?? 0]);
  while (slots.length && slots[slots.length - 1][0] === 254) slots.pop();
  return slots;
}

export function compactSpell(r) {
  const components = range(4)
    .filter((i) => r[`components${i}`] > 0)
    .map((i) => [r[`components${i}`], r[`component_counts${i}`], r[`NoexpendReagent${i}`] > 0 ? 1 : 0]);
  return {
    id: r.id,
    n: r.name,
    icon: r.new_icon ?? r.icon,
    m: r.mana,
    rng: r.range,
    aer: r.aoerange,
    aed: r.AEDuration,
    ct: r.cast_time,
    rt: r.recovery_time,
    rct: r.recast_time,
    tt: r.targettype,
    rst: r.resisttype,
    rd: r.ResistDiff,
    minr: r.MinResist,
    maxr: r.MaxResist,
    npr: r.no_partial_resist,
    ge: r.goodEffect,
    bd: r.buffduration,
    bdf: r.buffdurationformula,
    sk: r.skill,
    bdiff: r.basediff,
    unint: r.uninterruptable,
    refl: r.reflectable,
    zt: r.zonetype,
    tod: r.TimeOfDay,
    hc: components.length > 0,
    c: components,
    nd: r.nodispell,
    rc: r.RecourseLink,
    e: effects(r),
    cl: range(16).map((i) => r[`classes${i}`] ?? 255),
    coy: r.cast_on_you || undefined,
    coo: r.cast_on_other || undefined,
    sf: r.spell_fades || undefined,
  };
}

export async function compactSpells() {
  return (await table("spells_new")).map(compactSpell);
}
