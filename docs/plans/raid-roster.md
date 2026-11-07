# Raid roster plan

Which characters the raid goal needs, how to split them into leveling groups, and what is still unknown. The rules for building and running a group are in the [progression guide](../guide.md). Raid access, resets and Raid Resolve are described in [systems-research.md](systems-research.md).

`C/` is the developer's content snapshot (`~/src/github.com/brynnb/idlequest-content`), `.re/js/` the downloaded client. Boss numbers are snapshot fields, not measured fights.

## What the raids ask for

| Boss | Level | HP | Melee per hit | Weakest resist | Notes |
| --- | ---: | ---: | --- | --- | --- |
| Nanzata the Warder | 70 | 200,000 | 115-442 | cold | Frost Breath, 500 cold area damage and a dispel. |
| Ventani the Warder | 70 | 200,000 | 136-415 | disease | Rampage. Freezing Breath and a silence. |
| Tukaarak the Warder | 70 | 200,000 | 126-405 | fire | Rampage. Silence. |
| Hraashna the Warder | 70 | 200,000 | 137-509 | magic | Rampage. Stream of Acid, 500 per tick and snare. |
| Lord Vyemm | 66 | 350,000 | 250-1,200 | fire, disease | Scream of Chaos area damage, summons. |
| Cazic-Thule | 70 | 450,000 | 223-603 | cold | Rampage, slow immune, Panic proc. |
| Lord Yelinak | 70 | 500,000 | 204-804 | fire | Rampage, slow immune, Ice breath drains mana. |
| Tunare | 70 | 530,000 | 166-926 | none low | Flurry, unresistable root, 800 poison proc. |
| Vulak`Aerr | 70 | 890,000 | 355-1,400 | magic, fire, cold | Ancient Breath, area damage, summons. |
| Avatar of War | 70 | 900,000 | 299-1,154 | cold | Triple and flurry, slow immune. |
| Awakened Kerafyrm | 99 | 3,500,000 | 2,000-7,003 | all 192 | Slow immune. Destroy: unresistable 100,000 area damage. |

Sources: the `npc_types`, `npc_spells` and `spells_new` rows for the Raid Resolve boss IDs in `C/data/`, and the Resolve list in `.re/js/main.pretty.js:22711-22757`.

These are level-60 fights. Level 46 starts raids, and the client caps raid-buff scaling at level 60 (`.re/js/main.pretty.js:22686-22687`). On the first qualifying boss engaged in a fight, Raid Resolve (`encounterAid`, `.re/js/main.pretty.js:22693-22735`) doubles max HP and heals to full for Warriors, Paladins and Shadow Knights, and doubles max mana and refills to full for Clerics. It does not stack across multiple bosses in the same fight, and rune pools (`runePoolsGranted`, `.re/js/main.pretty.js:72050-72065`) are granted once per raid session rather than once per fight.

## How big a raid

Planning ranges, not measured requirements. They assume learned level-60 spells and pets, real tank gear and every unique support line present.

| Targets | Characters | Tanks / Clerics |
| --- | ---: | --- |
| The four Warders | 12-18 | 2-3 / 3-5 |
| Cazic-Thule, Yelinak | 18-24 | 3-4 / 5-6 |
| Vyemm, Tunare | 24-36 | 4-6 / 6-8 |
| Avatar of War, Vulak`Aerr | 30-42 | 5-7 / 8-10 |
| Awakened Kerafyrm | 36 (ranged/caster focus) | 5-6 / 8-10 |

### Kerafyrm and Destroy (`.re/js/BQ.pretty.js` and `C/data/`)

- Death Touch is blocked: the client explicitly filters out NPC casts of Death Touch (`24660` and `982`) via `i5 = [982, 3087, 7477, 24660, 24661, ...]` (`.re/js/BQ.pretty.js:26563-26567`).
- Destroy (`spell 1948`) is a 50-unit caster AE: Kerafyrm (`128089` and `128095`, `npc_spells_id: 489`) has a single spell entry, `Destroy` (`1948`, `recast_delay: 1800` in `npc_spells_entries`, `recast_time: 0` in `spells_new`). It deals `100,000` unresistable (`resisttype: 0`) damage to all raid members and pets within `aoerange: 50` with line of sight (`.re/js/BQ.pretty.js:4803-4900, 26428-26545`).
- Mitigation versus range: Divine Aura only covers the active player actor in raid mode (`.re/js/BQ.pretty.js:4535`), resists do not apply to `resisttype: 0`, and rune pools plus Raid Resolve tank HP are far below `100,000`. Actors standing outside 50 units (caster nukes and ranged attacks have 100 to 200 range) are outside `Destroy`'s `aoerange`.
- Roster decision: do not commit to leveling characters beyond the 36-character (6-group) raid before testing Kerafyrm at level 60, because adding more melee or tanks inside 50 units does not counter `Destroy`.

The raid shares one set of permanent support (`n8`, `.re/js/main.pretty.js:66202-66259`). Having at least one member of each class unlocks that class's full `effectTotals` and `damageAbsorbPackages` across the entire raid: Cleric (`Aegolism` and `Symbol`), Druid (`Protection of the Glades`, `Circle` resists and `Thorns`), Paladin (`Brell's` HP), Ranger (`Call of the Predator` ATK), Shaman (`Focus` and `Turgur's` slow), Enchanter (`VoG` haste, `KEI` mana regen and `Tash`), Bard (songs), Magician (`O'Keils` damage shield), and Wizard (`+700` `Spellshield` rune pool, `Ir = 700` at `.re/js/main.pretty.js:66113`). Duplicate buffs from the same family do not stack, so slots beyond the first copy of each support class go to what scales independently in raids and what makes each 6-person group level fast from 1 to 46.

### What scales in IdleQuest raids (`.re/js/main.pretty.js:27780-34945, 64069-66112`)

- Warriors (`5,200` base HP, `10,400` with Raid Resolve, `0.54x` boss damage taken, `Defensive` discipline `0.5x`), Paladins (`0.64x`, `Lay on Hands` `4,400`) and Shadow Knights (`0.65x`, `Harm Touch`, `Leechcurse`): main tanks, rampage tanks and add off-tanks.
- Clerics (`3,350` base mana, `6,700` with Raid Resolve): `Complete Heal` heals `7,500` HP for `400` mana (`10 s` cast), and the Cleric epic (`Water Sprinkler`) gives 0-mana combat resurrections.
- Rogues (`80-116` base melee DPS, `Duelist` `1.5x` discipline): highest sustained melee DPS. In IdleQuest's raid engine (`.re/js/main.pretty.js:65715`), bosses have `canDefend: false` against Rogues (no parries, ripostes, dodges or blocks) on top of `backstabAttacks`.
- Monks (`66-94` base melee DPS, `0.78x` damage taken, `24%` avoidance, `Inner Flame` `2.0x` and `Hundred Fists` `1.35x` disciplines): second-highest zero-mana melee DPS and much sturdier than Rogues.
- Magicians (`62-90` pet DPS plus `1,120` `Shock of Steel` nuke every `3.8 s`): top combined pet+nuke DPS in raids, and the water pet carries group leveling from level 4 to 46.
- Necromancers (`115` passive DoT DPS, `40-64` pet DPS, `720` lifetap, and `Covetous/Sedulous Subversion` mana transfer to healers in Raid Utilities).

## Roster and leveling groups

Every leveling group includes a tank, a Cleric, a Magician pet carry, and haste plus mana regen or slow (`Enchanter`, `Bard` or `Shaman`), so Groups 2 to 6 level at the same speed as Group 1 instead of stalling without haste, clarity or crowd control. Groups 1 to 3 (18 characters) unlock every raid buff package including Wizard `Spellshield`, Paladin `Brell's` and Druid `Protection of the Glades`:

| Order | Leveling group | What it adds to the raid |
| ---: | --- | --- |
| 1 | Magician, Warrior, Cleric, Bard, Shaman, Enchanter | Unique support core (WAR, CLR, BRD, SHM, ENC, MAG). Level 30-31 now. |
| 2 | Magician, Paladin, Cleric, Enchanter, Rogue, Druid | Unlocks Paladin (`Brell's` HP) and Druid (`PotG`/resists/DS) packages, Tank #2, Cleric #2, Rogue #1, Mag #2, with full ENC haste/clarity/mez/Nullify for leveling. |
| 3 | Magician, Shadow Knight, Cleric, Bard, Rogue, Wizard | Unlocks Shadow Knight, Wizard (`+700` `Spellshield` rune pool and Lures), Tank #3, Cleric #3, Rogue #2, Mag #3, and Bard #2 (Selo's/mana song for leveling and backup raid Bard). Completes the 18-character core. |
| 4 | Magician, Warrior, Cleric, Shaman, Monk, Ranger | Unlocks Ranger (`Call of the Predator` ATK) and Monk #1, Tank #4 (2nd Warrior), Cleric #4, Mag #4, with SHM slow/haste/regen for leveling. |
| 5 | Magician, Warrior, Cleric, Enchanter, Rogue, Necromancer | Unlocks Necromancer (`115` DoT DPS, pet and `Subversion` mana battery), Tank #5 (3rd Warrior), Cleric #5, Rogue #3, Mag #5, with ENC haste/clarity/mez. |
| 6 | Necromancer, Warrior, Cleric, Bard, Rogue, Monk | Completes the 36-character raid: Tank #6 (4th Warrior), Cleric #6, Rogue #4, Monk #2, Necromancer #2, Bard #3. |

Totals across the 36-character raid: **6 Tanks** (4 Warriors, 1 Paladin, 1 Shadow Knight), **7 Healers** (6 Clerics, 1 Druid), **7 Melee DPS** (4 Rogues, 2 Monks, 1 Ranger), **8 Caster/Pet DPS** (5 Magicians, 2 Necromancers, 1 Wizard), and **8 Support** (3 Enchanters, 3 Bards, 2 Shamans).

For race choices, Halfling lowers the XP cost of Warriors, Clerics, Druids and Rogues. Human or Iksar suits Monks, and Erudite or Gnome suits casters. Every new group gets twinked at level 1 from Group 1 via `Manage Money` and `giveItem` (8 Backpacks per character, Coldain Velium / high-ratio 1H weapons, and platinum for spells).

Epics worth chasing across the roster: the Magician's Orb of Mastery (goal requirement), the Cleric's Water Sprinkler (0-mana resurrection click), Rogue Ragebringer, the main Warrior's Jagged Blade, the Bard's Singing Short Sword, Monk Celestial Fists, and the Enchanter's Staff of the Serpent.
## How long it takes
Every level from 14 to 29 followed `1000 * (L-1)^3` cumulative XP (`3,000 * L^2` per level). At level 30 the cumulative requirement steps up by `1.1x` (`levelEnd(30) = 29,700,000 = 1.1 * 1000 * 30^3`, requiring `5,311,000` XP for level 30, about 2 hours at 2.65M XP/h in Unrest). Level 31 confirmed that non-transition levels within the `1.1x` band return to normal steps (`levelEnd(31) = 32,770,100 = 1.1 * 1000 * 31^3`, requiring `3,070,100` XP, about 1.15 hours).

## Resolved and open questions

- Character-slot limit (resolved): 9 pages of 8 slots give 72 character slots on the account.
- Concurrent sessions (resolved): two browser sessions on the same account can stay in the game world at the same time without disconnecting each other, as long as they control different characters.
- Kerafyrm's Destroy (resolved in code): `spell 1948` is a 50-unit caster AE (`100,000` unresistable damage), while single-target Death Touch (`982`, `24660`) is blocked by the client. Range (>50 units) and the client's handling of `recast_delay: 1800`, not extra tanks beyond 36, decide the fight.
- Open: the server's raid-time price at level 46 to 60, whether the server enforces a raid-size cap, and how Awakened Kerafyrm (`128089` in Sleeper's Tomb versus `114583` in Skyshrine, which has `npc_spells_id: 0`) is spawned or summoned in IdleQuest.
