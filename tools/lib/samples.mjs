// One rule for the recorder's one-second samples (`sample` in src/bridge.js): an XP difference
// between two of them is the active character's gain only when both name the same character,
// because a switch puts another character's absolute XP into the next sample.

/**
 * Who is active in a sample: its character id (`cid`), or, in samples recorded before they carried
 * one, the party size and the first companion, which a switch usually changes.
 */
export const activeOf = (s) => s.cid ?? `${s.lv?.length ?? ""}/${s.party?.[1]?.[0] ?? ""}`;

/**
 * The XP the active character gained from sample `a` to `b`, its AA experience (`aaXp`) included,
 * which is all a character at level 60 gains: null without XP or across a switch.
 */
export const xpStep = (a, b) => (a.xp != null && b.xp != null && activeOf(a) === activeOf(b) ? b.xp - a.xp + (a.aaXp != null && b.aaXp != null ? b.aaXp - a.aaXp : 0) : null);
