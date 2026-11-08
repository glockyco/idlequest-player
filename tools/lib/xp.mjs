// The level XP curve and the race and class factors, shared by the planner and the dashboard.

// XP to reach the start of level L for a factor of 1.00. The table is EQEmu's GetEXPForLevel, which
// the server's experienceProgress matches (start of 35 at 43,234,400, end at 51,450,000).
const MOD = (L) => (L < 31 ? 1.0 : L < 36 ? 1.1 : L < 41 ? 1.2 : L < 46 ? 1.3 : L < 52 ? 1.4 : ({ 52: 1.5, 53: 1.6, 54: 1.7, 55: 1.9, 56: 2.1, 57: 2.3, 58: 2.5, 59: 2.7, 60: 3.0 })[L] ?? 3.1);
export const xpStart = (L) => (L <= 1 ? 0 : Math.round((L - 1) ** 3 * MOD(L) * 1000));

// Race and class factors from the wiki (experience-and-zones, "Race and class requirements").
const RACE = { Troll: 1.2, Iksar: 1.2, Ogre: 1.15, Barbarian: 1.05, Halfling: 0.95 };
const CLASS = { Warrior: 0.9, Rogue: 0.91 };
export const factor = (race, cls) => (RACE[race] ?? 1) * (CLASS[cls] ?? 1);

/** XP a character with factor 1.00 has at `level` and `pct` percent into it. */
export const xpAt = (level, pct = 0) => xpStart(level) + ((xpStart(level + 1) - xpStart(level)) * pct) / 100;
