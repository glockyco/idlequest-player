// The value of one spell effect at a caster level, as the client computes it (`h2`,
// OSTsR53r.js:16737-16894 in .re/releases/20261108T004644-064bc896/pretty/), for a buff as it lands:
// the decay formulas count no elapsed ticks, and the random formula 123 takes its expected value.

/** Effect value for `formula`, `base` and `max` at caster `level`. */
export function effectValue(formula, base, max, level) {
  if (formula === 100) return base;
  const r = Math.abs(base);
  const sign = max < base && max !== 0 ? -1 : 1;
  const grow = (p) => (base > 0 && max > 0 && max < base ? r - p : sign * (r + p));
  let u;
  switch (formula) {
    case 0: u = r; break;
    case 60: case 70: u = Math.floor(r / 100); break;
    case 101: u = grow(Math.floor(level / 2)); break;
    case 102: u = grow(level); break;
    case 103: u = grow(level * 2); break;
    case 104: u = grow(level * 3); break;
    case 105: u = grow(level * 4); break;
    case 107: case 108: case 120: case 122: u = sign * r; break;
    case 109: u = grow(Math.floor(level / 4)); break;
    case 110: u = r + Math.floor(level / 6); break;
    case 111: u = grow(6 * Math.max(level - 16, 0)); break;
    case 112: u = grow(8 * Math.max(level - 24, 0)); break;
    case 113: u = grow(10 * Math.max(level - 34, 0)); break;
    case 114: u = grow(15 * Math.max(level - 44, 0)); break;
    case 115: u = r + (level > 15 ? 7 * (level - 15) : 0); break;
    case 116: u = r + (level > 24 ? 10 * (level - 24) : 0); break;
    case 117: u = r + (level > 34 ? 13 * (level - 34) : 0); break;
    case 118: u = r + (level > 44 ? 20 * (level - 44) : 0); break;
    case 119: u = r + Math.floor(level / 8); break;
    case 121: u = r + Math.floor(level / 3); break;
    case 123: u = Math.abs(max) > r ? r + (Math.abs(max) - r) / 2 : r; break;
    case 124: case 125: case 126: case 127: case 128: case 129: case 130: case 131: case 132:
      u = r + (level > 50 ? sign * [1, 2, 3, 4, 5, 10, 15, 20, 25][formula - 124] * (level - 50) : 0);
      break;
    case 139: u = r + (level > 30 ? Math.floor((level - 30) / 2) : 0); break;
    case 140: u = r + (level > 30 ? level - 30 : 0); break;
    case 141: u = r + (level > 30 ? Math.floor((3 * level - 90) / 2) : 0); break;
    case 142: u = r + (level > 30 ? 2 * level - 60 : 0); break;
    case 143: u = r + Math.floor((3 * level) / 4); break;
    case 144: u = r + level * 10 + Math.max(level - 40, 0) * 20; break;
    case 201: case 203: u = max; break;
    default:
      u = formula < 100 ? r + level * formula
        : formula > 1000 && formula < 1999 ? sign * r
        : formula >= 3001 && formula <= 3099 ? grow(Math.floor(level / (formula - 3000)))
        : formula >= 2000 && formula <= 2650 ? r * (level * (formula - 2000) + 1)
        : r;
  }
  if (max !== 0) u = sign === 1 ? Math.min(u, max) : Math.max(u, max);
  return base < 0 && u > 0 ? -u : u;
}

/** Every effect of a `spells_new` row at caster `level`: `[{ spa, value }]`, empty slots left out. */
export function spellEffects(row, level) {
  const out = [];
  for (let k = 1; k <= 12; k++) {
    const spa = row[`effectid${k}`];
    if (spa == null || spa === 254) continue;
    out.push({ spa, value: effectValue(row[`formula${k}`] ?? 100, row[`effect_base_value${k}`] ?? 0, row[`max${k}`] ?? 0, level) });
  }
  return out;
}
