# IdleQuest client internals

What the web client does, as needed to drive it. Source: the shipped bundles under
`https://idlequest.net/assets/`, prettified locally into `.re/js/`. A reference such as
`OK.pretty.js:8405` is a line in that snapshot, because minified names are bundle-local. A claim
marked "Unverified" has no client code or run behind it. A claim marked "Server" is decided by the
game server, so the client only sends a request.

## Where the game runs

- Combat, AutoLevel and party tactics run in the browser. The server authorizes each spell
  completion (`BQ.pretty.js:23918-23930`) and owns the account, inventory, zone and session
  state. A running tab is required for automation.
- State lives in zustand stores. Each store has `getState()` and `subscribe()`, and its actions are
  functions on the state. `src/bridge.js` locates stores by state keys (`CLIENT_SURFACE`)
  because export names and chunk file names change on every release.
- A client build is named by `window.iq.release`: the compact release time the client sends as
  `client_release` (`main.pretty.js:3553`, also the page's `<!-- Build v... -->` comment) and a
  hash of the entry script's file name. The bundler hashes that name over everything the entry
  imports, so any client change changes it, and the set of loaded files cannot serve instead
  because it grows as screens open. `CLIENT_SURFACE` in `src/bridge.js` is the one list of what
  the SDK needs from a build (stores, the actions and state keys it uses, the socket methods, the
  command dispatcher, the dialogue functions, and the client functions and service objects found
  by pieces of their source, such as the sale, the hail and the combat service), and
  `tools/check-client.mjs` runs its discovery on a saved release. A method name alone does not
  identify a service: the bundle also exports a stand-in whose every method returns false.

## Transport

- `GET /api/transport/credentials` returns a certificate hash. The client opens WebTransport to the
  game server with it, and falls back to `wss://<host>/ws?session=&client_release=&state_protocol=`
  when that fails (`main.pretty.js:2327`, `2934-2944`, `2996-3008`, `3287`, `3550-3555`).
- Reliable frames (the control stream and the WebSocket): `uint32le length`, `uint16le opcode`,
  JSON payload. A datagram has no length prefix (`main.pretty.js:2708-2720`, `3011-3021`).
- Opcode `0xFFFF` wraps a compressed packet: `uint16le inner opcode`, `uint32le size`, raw
  deflate data (`main.pretty.js:2653-2672`).
- `data/opcodes.json` maps opcode names to numbers.
- Requests go through `socket.sendJsonRequest(op, replyOp, payload)` or the correlated variant
  `sendCorrelatedJsonRequest` (`main.pretty.js:3051`, `engine.pretty.js:419359`). Server pushes are
  dispatched to handlers registered by the client.

## Authentication

- `JWTLogin` with `{authType: "login", email, password, clientRelease}`, or `authType: "guest"`
  (`"guest_merge"` when several guest tokens exist) with a `guestToken` kept in `localStorage`
  (`main.pretty.js:51778-51815`, `51698-51704`). The reply `JWTResponse` carries the session id in
  `status` and a resume token.
- The session id and resume token are fields of the socket object, so they live in page memory
  only. If the connection drops and the server rejects the resume (`SessionResumeRejected`), the
  client returns to the login screen (`main.pretty.js:3564-3573`).

## Entering the world

`EnterWorld` with `{name, stateProtocol, tutorial, returnHome}` returns `PostEnterWorld`
(`main.pretty.js:51847-51855`). The server then pushes `CharacterData`, `CharacterInventory`,
`CharacterSkills`, `CharacterCurrency`, `CharacterBind`, `CharacterStatsData`,
`CharacterSpellbook` and `ZonePlayerSnapshot`, which the client applies through its own handlers
(`C8.pretty.js:1060`, `1209-1254`). `socket.worldReady` turns true when `CharacterData` loads
(`C8.pretty.js:1218`) and the zone and 3D scene load after that.

## Camping, switching and creating characters

- Camp (`Ia` and `va`, `C8.pretty.js:1542-1614`, the right sidebar's Camp button at
  `engine.pretty.js:400172-400177`) saves and releases every account companion, sends the camp
  request, resets the session and the game instance and shows character select. If the release
  fails the camp is cancelled with a chat message.
- Character select (`engine.pretty.js:1368-1500`) lists eight characters per page as buttons named
  after them. ENTER WORLD calls the roster store's `enterWorld(name)` (`main.pretty.js:51993-52013`).
  The same screen has the delete button, which opens a confirmation.
- The command dispatcher (below) has both steps: `session.camp` runs the Camp button's function
  and `session.enterWorld` enters as the character its `selector` names, then waits until the
  world is ready (`B7YhzEJy.js:3322-3360`, `3417-3424`). A selector of digits picks by position in
  the character list, not by id, so the bot's switch (`switchTo` in `src/bot.js`) passes the name.
- After entering, the party holds no account characters. `requestAccountCharacterAvailability()`
  and `controlAccountCharacter(id)` bring them back, which the bot's `partyIds` repeats.
- The client has one command dispatcher for its UI (`Fa`, `C8.pretty.js:2463-2718`), exposed by
  the bridge as `window.iq.command`. Its `session.createCharacter` (`3085-3122`) resolves race,
  class, deity and start zone names against the creation combinations, applies the stat
  allocation the server lists for the combination (`4393-4480`) and switches to character
  select. Commands named `debug.*` need a test mode and fail otherwise. The combinations hold the
  fourteen classic classes only: Beastlord and Berserker exist in the class list without any.
- `session.deleteCharacter` with `selector` set to a name (`C8.pretty.js:3123-3148`) deletes that
  character immediately, without a confirmation. It also runs while another character is in the
  world, but after nine deletions there the world session stopped confirming combat requests
  ("The combat request could not be confirmed") and camping failed with "World session is not
  ready", so only a reload and a new login recovered it. Delete only at character select, and
  check the name and level before sending it.

## Combat runtime and AutoLevel

The combat runtime is a singleton: `G.getInstance()` exported from the chunk that holds the string
`Waiting for party to be ready` (`OK.pretty.js:6095`, export at `:8896`, found by
`src/bridge.js` `runtime()`). Its `combatScene` exposes the live world. Find the runtime by method
names such as `castSpellAtSelectedTarget` and `getAliveCombatTargetList` when export names change.

### Target picking and the deferral list

- AutoLevel pulls through `startSpatialCombat` (`OK.pretty.js:8405-8479`). It takes
  `combatScene.findClosestCombatTarget(npcId, excludedSpawnIds, filters)`
  (`engine.pretty.js:464700-464711`), which scans every alive spawn and keeps the one with the
  smallest straight-line 3D distance (`engine.pretty.js:442449-442483`). It does not weigh XP,
  nearby danger, water, the route or whether the spawn can be reached.
- A spawn is skipped when it is flagged `automatedCombatExcluded` or `autoLevelExcluded`, is on the
  deferral list or charmed by the party, has a level outside the limits, is evading or owned by
  another character's combat, or (with Farm Items active) lies outside the chosen category
  (`engine.pretty.js:442453-442475`, `OK.pretty.js:8428-8434`).
- The level limits come from the active character's level, `minCon`, `maxCon` and `maxLevelDiff`
  (`OK.pretty.js:5283-5340`, `8739-8752`). The minimum level is the low edge of the `minCon`
  colour and the maximum is the high edge of the `maxCon` colour, capped at level plus
  `maxLevelDiff` when that is above 0. White is the character's own level, Yellow is one to two
  levels above (three above level 50, four above 53, five above 56), and Blue and Green lie below
  by the offsets in `OK.pretty.js:5341-5366`. Defaults are `minCon` Blue, `maxCon` White and
  `maxLevelDiff` 0 (`main.pretty.js:190671-190673`).
- The limit setters overwrite each other (`main.pretty.js:190674-190717`). `setMaxLevelDiff(n)`
  sets the highest con (0 gives White, 1 or 2 Yellow, 3 or more Red). `setMaxCon(c)` resets the cap
  (White 0, Yellow 2, Red 5). `setMinCon(c)` raises `maxCon` when `c` is above it. Set `maxCon`,
  then `minCon`, then the cap, and read all three back (`applyLimits` in `src/bridge.js`).
- Reachability enters only after a pick. When an approach is abandoned the client defers that spawn
  with `deferAutoLevelSpawn(spawnInstanceId, ms)` for 5 minutes, or 15 seconds when the target
  became unavailable (`OK.pretty.js:5373-5374`, `5484-5497`). It also defers the current target
  when its supervisor sees no progress and after some won fights (`OK.pretty.js:5615-5618`,
  `6960`).
- `deferAutoLevelSpawn` keeps the later expiry per spawn instance id in a map in page memory
  (`OK.pretty.js:5587-5592`). Expired entries are removed at each pick (`OK.pretty.js:8410-8411`)
  and nothing clears the map on a zone change. Unverified: whether a spawn instance id is the same
  after the zone is re-entered. The bot depends on it in `guardLeave`.
- When every candidate is deferred or owned, the client says "Waiting for an available enemy" and
  retries. When there is no candidate at all it says "No available enemies found in this zone" and
  stops AutoLevel (`OK.pretty.js:8436-8478`).
- `combatScene.getAliveCombatTargetList()` returns `{spawnInstanceId, npcId, name, level, distance}`
  sorted by distance. It applies no con, level or deferral filter, only `automatedCombatExcluded`
  (`engine.pretty.js:464758-464786`).
- `combatScene.navigateToCombatTarget(spawnInstanceId, onError)` walks with the client's own
  navigation and `clearNavigationTarget()` stops it (`engine.pretty.js:464916`, `464953`).

### Readiness wait and cure passes

- Every start through AutoLevel (`startCombat`), the Enemy Targets list (`selectEnemyTarget`) or
  the Auto Attack button, when no fight is active, runs `prepareAutomatedCombat`
  (`OK.pretty.js:7581-7634`, `7933`, `8394`). It summons pets (`executeBuffPhase`,
  `OK.pretty.js:498-529`) and then runs `waitForPartyReady` (`OK.pretty.js:690-844`). It casts no
  buffs.
- The wait ends when every member and pet is ready and the support pass `Nz`
  (`BQ.pretty.js:24128-24378`) reports that it did nothing. Ready means that the leader, every
  active companion and every pet owned by the leader or an active companion has full HP, has full
  mana if it is a mana class, and is not rooted (`OK.pretty.js:725-742`, `804-826`). A dead member
  has less than full HP, so it holds the wait too. While a root is active the wait shows "Waiting
  for root to wear off the party." and the time it lasts does not count against the limit.
- Between fights every member regenerates every 600 ms by the same rule (release
  20261108T004644, `0eakiHJI.js:20217-20231`, `24442-24632`): 2.5% of its maximum HP or mana,
  raised by up to twice as its HP regeneration nears 100 or its mana regeneration (spell plus item
  `ManaRegen`) nears 50, and a third of that for a starving leader. A full bar takes 24 seconds
  without regeneration and 12 at 50. Mana comes back only 5 seconds after the member's last cast,
  and HP 5 seconds after it last took damage. Level, class, Meditate and sitting do not enter, so
  the wait depends on the share of the bar a fight spends.
- The wait gives up after 2 minutes plus the time spent rooted and returns false
  (`OK.pretty.js:704`, `843`). So does a monitor that sees no HP, mana, root or cast progress for
  45 seconds (`OK.pretty.js:324`, `353-360`, `BQ.pretty.js:14439-14454`). The preparation result
  is then "interrupted" or "stalled", and AutoLevel retries after 5 seconds, then 10 seconds, and
  pauses at the third failure in a row with "AutoLevel paused after preparation repeatedly
  failed" (`OK.pretty.js:393-418`, `7589-7611`). Unverified in a live run: that a bare root with
  nothing to dispel stalls out at 45 seconds.
- The support pass runs once per wait pass (every 600 ms, `OK.pretty.js:420`, `841`) and does
  nothing in raid mode or while hostiles are active (`BQ.pretty.js:24130`). For the leader and each active companion that is not
  a pet it considers a cure or dispel when the member's `cure` tactic is on, and Cleric
  resurrection of dead companions when `rez` is on (`BQ.pretty.js:24165-24196`, `24325-24375`).
  Cure and dispel spells must be known to the caster: memorized for the leader, scribed for a
  recruit, not excluded, in level, with components and with a mana cost at most the caster's
  maximum mana (`BQ.pretty.js:24198-24223`).
- The pass chooses per target. It plans the cheapest set of cure spells for the target's active
  effects (`BQ.pretty.js:20627-20675`) and, when none applies, the dispel with the best mana per
  chance among those with a chance above 0 (`BQ.pretty.js:24263-24280`). A caster must be idle,
  have the mana and have the spell off cooldown. One cast per caster and one caster per target at
  a time run (`BQ.pretty.js:24283-24320`).
- The pass counts as busy whenever any caster has a candidate for any target, even when no caster
  can cast now (`BQ.pretty.js:24281-24282`). A cure that has no mana, is on cooldown or keeps
  failing therefore holds the whole party until the effect wears off or the wait gives up. A spell
  is struck from the caster and target pair for the character's session after an outcome other
  than completed, fizzled, interrupted or insufficient mana (`BQ.pretty.js:24301-24315`).
- Dispel chance per effect is 32% plus 7% per level of `casterLevel + levelModifier - 1 -
  effectCasterLevel` when that is above 0, or 2% per level when below, clamped to 10-100%
  (`main.pretty.js:19666-19677`). Dispel-protected effects are skipped (`main.pretty.js:19682`, `19696`).
  Against same-level or higher casters a modifier 1 dispel mostly fails. `analyze.mjs` reports waits
  with cure or dispel casts separately ("Between pulls").
- Roots between pulls: the wait reads each member's and pet's active effects from the effects
  registry (`getEffects(entityId).active`, `OK.pretty.js:804-809`). Entity ids are
  `character:<id>`, `bot:<owner>:<id>` and `pet:<owner>:<summonInstanceId>`
  (`main.pretty.js:3820-3833`). Each effect carries `spellId`, `casterLevel` and `remainingTicks`
  (`BQ.pretty.js:20683-20692`), so the remaining root time and the dispel chance are known in
  advance. The bot uses this to turn cures on only for roots worth dispelling (`dispelRoots` in
  `src/bot.js`).

### Auto Attack, pulls and direct starts

- AutoLevel's pulls do not start the fight on arrival by themselves. The approach starts it only
  while Auto Attack is on (`canStartCombat`, `OK.pretty.js:5446`) and otherwise stands in phase
  `waiting-to-attack` (`OK.pretty.js:4396-4403`). The AutoLevel supervisor does not count that as
  idle, so it has no timeout (`OK.pretty.js:4265-4266`, `5597-5610`).
- When every enemy left in a fight is mezzed, `adoptActiveEncounterForAutoLevel` turns Auto Attack
  off, because `canAutomaticallyFocusNpc` excludes mezzed enemies (`OK.pretty.js:5823-5850`).
  Nothing in the code read turns it back on, so the next pull stands still. The bot presses it
  when a pull waits like that (`keepAutoAttack` in `src/bot.js`). `attackSelectedTarget` toggles
  Auto Attack, so press it only while it is off (`OK.pretty.js:8020-8023`).
- The supervisor restarts AutoLevel after 30 seconds without progress and recovers a defeat that
  has not settled after 15 seconds (`OK.pretty.js:4238-4239`, `4254-4272`).
- Direct starts skip the readiness wait. `castSpellAtSelectedTarget(gem)` starts a combat with
  mode `manual-spell` when no fight on that target is running, and refuses while a preparation phase
  is active (`OK.pretty.js:8078-8142`). `commandPetAttackSelectedTarget()` commands the pet and
  retries every 350 ms until the pet is in melee range, then starts mode `pet-command`
  (`OK.pretty.js:8061-8077`, `8209-8247`).
- Companions join the player's target by the option `companionEngagementDistance`. Its default is
  `infinite`, and the other values are `combat`, `combat-x5` and `spell`
  (`main.pretty.js:189360`, `191345`, `61823`, `OK.pretty.js:5933-5970`).
- Clicking a row in the Enemy Targets list calls `selectEnemyTarget`. With the option
  `enemyTargetAttackOnArrival` off, which is the default, it stops AutoLevel, walks to the closest
  alive spawn of that NPC and targets it without pulling (`main.pretty.js:189390`,
  `OK.pretty.js:7757-7821`). Auto Attack then starts the fight.
- `warpPlayerToCombatEntity` and `teleportPlayerToEQPosition` move the player without walking.
  The client itself uses them for respawn, for a debug command and as a fallback when chase
  navigation fails (`OK.pretty.js:7050`, `C8.pretty.js:2898`, `engine.pretty.js:462662`). The bot
  does not call them.
- Enemy HP, melee damage and AC are per-NPC rows in `C/data/npc_types`. Ordinary mobs at one level
  often share a value, but named, boss and variant rows differ. A mob well above the camp's level
  can stand among ordinary ones and joins when the camp is pulled. A level 30 Minotaur Sentry
  (1200 HP, hits up to 64, `C/data/npc_types` id 56149) joined a pull of level 10 minotaur slavers
  and the Warrior died (`runs/2026-11-06-tox-ab/events.jsonl:28397`, `:29059`).
- Zone change: the Travel window calls `requestZoneChange(zone)` (`main.pretty.js:188597-188634`,
  found by `zoneChanger()` in `src/bridge.js`). The function has no combat check, and the server
  can still reject the request (`main.pretty.js:24248`). It sends the zone's safe spot with
  instance 0, so changing to the zone you are in re-enters it at the safe spot. The client's
  `setCurrentZone` then clears the target and all engaged mobs, stops AutoLevel unless a merchant
  trip expected the zone, and drops an active Farm Items plan when the zone differs
  (`main.pretty.js:189476-189497`). That makes it the escape from a bad fight.

### Melee damage

Line numbers are in `.re/releases/20261108T004644-064bc896/pretty/OSTsR53r.js`.

- The player and account companions swing the same way. `recalcBotStats` (53735-53800) builds a
  companion's stats with the player's `Bt` (21847) from its own inventory and skills, so worn
  weapons and trained skills count for companions as they do for the leader.
- A weapon's damage is capped by level at stat build and again at each hit (`OD` 20905, `XY`
  62289-62307, `U3` 62958-62963): casters 6, 10, 12, 18 and 20, priests 9, 12, 20, 26 and 40, all
  other classes 10, 14, 30, 60 and 100, below levels 10, 20, 30 and 40 and from 40. Ranged skills
  skip the cap at hit time. `capFor` in `tools/lib/gear-data.mjs` holds the same table.
- An empty main hand fights with fists (`YL` 22170-22260): damage 1 at 36 delay, and for a Monk
  a level table (`di` 21713-21754) of 6 at 10 to 14, 7 at 15 to 19 and 8 at 20 to 24, all at 36.
  A Monk with Dual Wield, nothing in the off hand and no two-hander also swings an off-hand fist.
  Skills missing from a character default to five per level, and offense and accuracy come from
  the weapon's skill (`x1` 21999), so a weapon type the character has not trained hits less.
- A hit is the capped damage times an offense against AC factor of 0.1 to 2.0 (`tp` 62216-62266),
  plus a flat bonus from level 28 for melee classes that is larger for two-handers (`sd`
  16699-16706). STR enters only through offense. Haste divides the delay (`g9` 62778-62790).

### Off hand and dual wield

Line numbers are in `.re/releases/20261108T004644-064bc896/pretty/OSTsR53r.js` unless named.

- What may go in slot 14 (Secondary) is decided at equip time in `wt` (`B7YhzEJy.js` 2335-2380).
  The item's `slots` bit must include Secondary and the item's `classes` and `races` must fit.
  A two-handed main hand (`itemtype` 1, 4 or 35) refuses any off-hand item, and a two-hander
  refuses to go on while the off hand is full. A one-hander of `itemtype` 0, 2, 3 or 36 also
  needs a Dual Wield skill (skill 22) of at least 1 in the character's skills. Shields (`itemtype`
  8), instruments and other off-hand items need no skill. The check reads the character's
  trained skill value and not a level, so a class that has the skill only has it from the level
  its cap row becomes non-zero.
- A class's Dual Wield cap per level is not in the client or in `idlequest-content`. The client
  asks the server (`GET /api/skill-caps?class=<id>&level=<n>`, `CVEP2_Ra.js` 422736), which
  returns the cap of every skill by id, index 22 for Dual Wield. `data/skill-caps.json` keeps
  only levels 46 to 60. Read from the server for every level, the skill first has a cap above
  zero at level 1 for Monk (12), 13 for Warrior (70) and Rogue (83), and 17 for Ranger (90) and
  Bard (90). Cleric, Paladin, Shadow Knight, Druid, Shaman, Necromancer, Wizard, Magician and
  Enchanter never have it. The cap at 60 is 240 Warrior, 240 Ranger, 210 Bard, 245 Rogue and
  252 Monk.
- `YL` (22170-22262) reads the equipped items. A weapon in the off hand with `damage` above 0
  sets `hasOffhand` and takes `offhandDamage` (capped at the level's weapon cap like the main
  hand), `offhandDelayMs` (`delay` times 100) and `offhandSkillId` from its `itemtype`. An
  `itemtype` 8 item sets `hasShield` instead and nothing else. An item with no `damage`, such
  as an instrument, sets neither. Stat build does not look at the Dual Wield skill, so
  `hasOffhand` is true for a Warrior at level 1 holding a weapon, and the skill is checked at
  swing time.
- A Monk with Dual Wield above 0, an empty off hand (any item in slot 14 blocks it) and a main
  hand that is not a two-hander gets an off-hand fist (`YL` 22231-22239): the same fist table as
  the main hand, hand-to-hand skill, no proc.
- Fists come from `di` (21748-21754), which takes the level and the race. Iksar (race 128, `OL`)
  use the table `UL` and every other Monk race uses `jL` (21713-21747). `jL` is a table by
  level: damage 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14 from level 1, 5, 10, 15, 20, 25, 30, 35,
  40, 45, 50, delay 36 below 25, then 35, 34, 33, 32, 31, 30 at 25, 30, 35, 40, 45, 50, and
  29, 28, 27, 26 at 53, 56, 59, 60. `UL` is the same but one delay step later.
- The off hand has its own swing timer. `CZ` (63220-63255) swings it whenever `hasOffhand`,
  `offhandDelayMs` is above 0 and its timer is at 0, then restarts it at the off-hand delay with
  haste and slow applied (`g9`), so a faster off hand swings more often than the main hand.
- A due off-hand swing goes through `IZ` (63049-63062) before it hits. It fails if the Dual Wield
  skill is 0, if the main hand is two-handed (`weaponTwoHanded`, or a main-hand skill of 2, 3
  or 77, the two-handed skills), or, when a discipline does not force it, if `tZ` (62364) rolls against `Rt`
  (16696-16698). The chance is `min(1, (skill + level) / 400)`. The skill is the character's
  current Dual Wield value, so with the cap at 60 it is 0.75 for a Warrior or Ranger, 0.76 for
  a Rogue, 0.68 for a Bard and 0.78 for a Monk, and at level 13 with a cap of 70 about 0.21.
  The class does not enter. A failed roll costs the swing and the timer, and nothing else.
- A successful off-hand swing `bZ` (63029) is one `U3(..., true)` hit, then a Double Attack roll
  as for the main hand (`kZ`), so the off hand can swing two or three times. `U3` uses the
  off-hand damage, skill accuracy and `offhandWrath`, but not the flat melee bonus of `sd`
  (`aZ` is skipped for the off hand), and the off-hand weapon's proc is rolled separately.
  Backstab and the other skills use the main hand only.
- Any one-hander of types 0, 2, 3 and 36 fits the off hand of a class with the skill. Only the
  main hand has to be piercing for a Rogue's Backstab (`sZ` requires weapon skill 36).
- A shield counts for its stats, `ac` among them, like any worn item, and for nothing else in
  the swing code. No block or parry chance reads `hasShield`. It enables Bash: `rp` (62395) is
  true for Warrior, Paladin and Shadow Knight (class 1, 3, 5) with `hasShield`, and for those
  classes without a shield when the race is Barbarian, Troll or Ogre (race 2, 9, 10). Bash also
  needs the Bash skill above 0. The shield's own `magic` flag is kept as `shieldMagic` for
  the magic-weapon check.
- A two-hander does not lose an off hand to anything but the equip rule. Swapping from a
  dual-wield pair to a two-hander means unequipping the off hand first.

### Bard instruments

Line numbers are in `.re/releases/20261108T004644-064bc896/pretty/OSTsR53r.js` unless named.

- A song's modifier is the highest `bardvalue` among the Bard's worn items whose `bardtype`
  matches the song's skill (`W8` 21171-21184): wind (skill 54) type 23, strings (49) 24, brass
  (12) 25, percussion (70) 26, singing (41) 50, and type 51 matches all. Any equipment slot from
  charm to ammo counts, for the leader and for companion Bards alike, and values do not add up.
  The modifier is at least 10 and at most 36, and singing songs add the Bard's Amplification.
- An effect scales by modifier over 10 (`H8` 16899-16901), so a Drum (20) doubles a percussion
  song. Only HP (damage, heals, DoT and regeneration ticks), AC, attack, movement, stats,
  resists, runes, damage shields, maximum HP and magic absorption scale (`_E` 16896). Haste and
  mana regeneration never do. The Bard's song skills do not enter the modifier.
- A weapon does not cancel an instrument. Most instruments fit only the main or off hand, so
  wielding a weapon there keeps the instrument off, while a ring or mask with a `bardtype`
  counts without that cost.
- Songs reach the party two ways, and worn instruments count in both. Cast songs (damage,
  DoTs, heals, crowd control) use `W8` on worn items only. Buff songs (Chant of Battle, regen,
  resist and haste songs) apply as party support (`Dt` 20095-20135, `wt` in `CAUokwED.js:1952-1966`),
  which also takes one strings, brass or percussion instrument from the bags, by situation
  (`Tt` `CAUokwED.js:1870-1881`): none in raids, out of combat strings when someone is hurt and
  percussion otherwise, and in combat brass only while the Bard's melee and range are off,
  which holds for a companion Bard by default but not for a Bard leader. Singing songs get the
  Amplification bonus only when cast.

## Guard

`iq.guard` (`src/bridge.js`, `guardDanger` and `guardLeave`) runs once a second inside the page, so
it works while no script is attached. While a mob is engaged it checks five things: a mob
`levelGap` or more levels above the leader (`levelGapLow` for a mob fighting the party while the
leader is at most level `lowLevelMax`), a mob whose biggest hit times `hitsToKill` reaches the
lowest max HP in the party, a leader at `dyingHpPct` HP or less who would be dead within
`dyingSec` at the HP lost over the last `dyingWindowSec`, a party member newly dead, and a Cleric
under `healerManaPct` mana while someone
is under `healerHpPct` HP. With `fightingOnly` the level and hit checks count only mobs whose
`hateTargetId`, `currentTargetId` or `chaseTargetId` names the party: `player`,
`character-<id>` or a pet. The engaged list also holds idle mobs of the encounter with no target
and guards fighting other NPCs (`npc:<id>`). On a trigger it stops AutoLevel, re-enters the current
zone (or changes to `retreatZone` if set), and starts AutoLevel again with the same limits about
nine seconds later, if it was running before the escape, so a script or task that holds the party
keeps it still. Before it leaves it defers every mob of that fight, the target and the pull
target with `deferAutoLevelSpawn` for `avoidMin` minutes (see the deferral list above), because
AutoLevel picks the nearest target and would otherwise pull the same camp again right after
re-entering. After `escalateAfter` escapes in an hour, an escape caused by a mob inside AutoLevel's
own level range lowers the level cap by one (not below `minLevelDiff`), because those pulls are
too hard, and a quiet hour restores the earlier limits. Escapes from wanderers above the cap change
nothing, because lower limits would not keep them away. Whether a zone still pays with its escapes
is for the measured XP per hour to decide: `analyze.mjs` counts escapes and the seconds they cost.
`guardStatus()` shows the phase, the settings changed from `GUARD_DEFAULTS` and recent escapes,
`setGuard({...})` changes settings (`null` restores a default) and `testGuard()` forces one escape
without touching a setting. Only changed settings carry over when the bridge is installed again, so
a new default reaches every tab with the next attach. Each escape is a `guard` line in the event
log.

## In-page chores

`window.iq.chores.autoBuySpells` defaults to `true`. The client posts "You are missing N merchant
spells." and "Your party companions are missing N merchant spells." every 10 minutes
(`engine.pretty.js:402448`, `402474-402524`). When that text appears, the page sends the same
`ScribeAvailableSpells` request as the Buy Spells and Buy Companion Spells macros, scope `self` and
`companions`, at most once in 30 seconds (`engine.pretty.js:402404-402420`, `src/bridge.js`
`chores`). It needs no attached script. Use the SDK's `setChores({ autoBuySpells: false })` to
disable it, or `buySpells()` to run the requests manually. Chore results are recorded as `chore`
event lines. Spells that need research, quests or drops are not bought
(`engine.pretty.js:423143`).

## Party tactics

- Party members' tactics are in the party spells store (`overridesByCompanion`), keyed
  `character:<characterId>` for account characters and `bot:<hostCharacterId>:<bot>` for default
  bots (`BQ.pretty.js:9976-9981`, `13584-13624`). A key without the host id, such as a bare bot
  name, is stored and never read.
- The active character's own tactics are in a separate store (`overridesByCharacterId`, with
  `meleeByCharacterId`), keyed by the plain character id (`BQ.pretty.js:13453-13478`,
  `13521-13543`). An `overridesByCompanion` entry for the active character is ignored.
  `iq.setTactic` picks the right store. Casting preferences for the active character, keyed
  `character:<id>`, are still read from the party spells store (`BQ.pretty.js:24172`).
- Both stores are persisted under the names `companion-tactics-storage` and
  `player-automation-tactics-storage` (`BQ.pretty.js:13481`, `13627`). Unverified: the storage
  backend.
- Experience on a kill is split among the party's characters in proportion to their levels, so a
  low-level recruit takes a small share (`tools/predict.mjs:30`, fit to measured kills). The
  client holds no split code, so this is a server rule.

### How companions choose and cast spells

- The spell list of a member comes from one of two sources (`BQ.pretty.js:10096-10127`). The
  leader and default bots use the generated class table, which exists for the Cleric, Paladin,
  Ranger, Shadow Knight, Druid, Bard, Shaman, Necromancer, Wizard, Magician and Enchanter only
  (`BQ.pretty.js:9940-9952`). Account characters that have a control lease and pets use the
  server's `autoCastData`. The leader casts only the spells it has memorized, while account
  characters cast from their scribed spellbook (`BQ.pretty.js:24176-24183`, `36018-36029`,
  `engine.pretty.js:423148`).
- Tactic flags remove spells from the list (`BQ.pretty.js:10062-10091`): `cast` off removes all,
  `cure` off removes cures, `rez` allows resurrections, `manaRecovery` allows mana-recovery spells,
  and `heal`, `nuke`, `dot`, `debuff`, `cc`, `root` and `fear` remove their categories.
- Defaults for a recruit come from what its class can do (`BQ.pretty.js:9983-10050`).
  Resurrection is off for everyone until the `rez` tactic is set (`BQ.pretty.js:10037`,
  `13683`). The leader's defaults are all on except `rez`, `fear` and `range`
  (`BQ.pretty.js:13521-13543`).
- Casting preferences are a second per-member record (`rez`, `slow`, `mez`, `stun`, `snare`,
  `charm`, `excludedSpellIds`, `epicRezOnly`, `bardSongIds`) and default from the tactic flags
  (`BQ.pretty.js:13586-13599`, `13678-13689`).
- Between fights only the support pass above casts. It casts no buffs and no songs. In a fight,
  members choose spells from the filtered list on their own. Unverified: the order in which the
  fight AI ranks spells, and whether companions cast buffs at the start of a fight
  (`BQ.pretty.js:36031-36120`).

## Macro bar, account sharing and options

### Built-in macro bar actions

The macro action map (`engine.pretty.js:403161-403257`) defines the player actions in slots 1 to
24. Slots above 30 are debug and GM actions. The rows a script is likely to use:

| Slot | Button | Handler | What it does |
|---:|---|---|---|
| 1 | Path To... | `toggleMerchantList()` | Opens in-zone NPC navigation (Merchants, Bankers, Guildmasters, Quest NPCs) |
| 2 | Enemy Targets | `openCombatTargetList()` | Opens the live enemy list. Clicking a row targets and walks to that spawn (see above) |
| 5 | Loot Closest | `/lootclosest` chat command | Server: opens the nearest unlooted corpse |
| 6 | Tradeskill Bank | `openTradeskills()` | Opens the account-shared ingredient bank and recipe crafter |
| 7 | Buy Spells | `ScribeAvailableSpells` scope `self` | Buys and scribes missing merchant spells for the active character, lowest level first |
| 8 | Buy Companion Spells | `ScribeAvailableSpells` scope `companions` | The same for grouped account companions |
| 9 | Spell Bank | `openSpellBank()` | Opens the account-shared spell scroll bank |
| 10 | Delete Clutter | one stream message | Server: deletes low value NO DROP items |
| 11 | Auto Sell | courier flow `HLe("merchant")` | Calls a merchant courier to sell eligible items for a 20% fee. Respects the cleanup protections |
| 12 | Auto Bank | courier flow `HLe("banker")` | Calls a banker courier for ingredients and scrolls. Free below level 30, 1pp at 30, 2pp at 40, 3pp at 50 |
| 18 | Farm Items | `setIsFarmingDisplayOpen(true)` | Recommends zones and filters AutoLevel targets by material category |
| 19 | Manage Money | `openManageMoney()` | Pulls any other character's coin to the active character |
| 20 | Inventory Search | `openInventorySearch()` | Searches the account's items and transfers them to the active character |
| 21 | Alt Adv | `openAbilities("advancement")` | Opens the Alternate Advancement window |

The rest are Stuck, Bind Soul, Fish, Forage, Casino, Pizza, Guild and the report and rename
panels. `/stuck` is a chat command the server handles. Unverified: what it does beyond the help
text "If you become stuck" (`engine.pretty.js:423199-423202`).

The courier flows refuse while another inventory service runs, and abort on a zone change
(`engine.pretty.js:402658-402728`). The Farm Items categories are listed in `engine.pretty.js:419900-419918`.
With the option `autoLevelMerchantTravelEnabled` off, AutoLevel sells and buys through couriers
instead of walking to a merchant.

### Account-wide sharing rules

- Held-item transfer: `transferHeldItem(characterId, equip)` (`main.pretty.js:53376-53420`) needs the
  item on the cursor, a target that differs from the active character and is in
  `stores.roster.getState().characters`, and no transfer in flight. It then sends the item to the
  server with `equip`. The recipient does not have to be in the party, so offline characters and
  characters of a second party qualify, and the bot's `giveItem` relies on that. Server: which slot
  an equip replaces, and what happens to the replaced item. Unverified for this call: the
  message "That character has no inventory space for the replaced item" was seen only with
  Auto-Upgrade Companions (`diary/2026-11-07-f.md`, section "Companion bags").
- Manage Money (`engine.pretty.js:419664-419899`): sends `{ action: "read" }` and gets one row per
  other account character (`carried`, `bank`, `totalCopper`). Sending `{ action: "transfer",
  sourceCharacterId, revision, operationId }` moves all carried and bank coin of that character to
  the active character's wallet. The button is disabled for rows with no coin. A reply for another
  character session is rejected. The SDK drives the panel through the DOM
  (`iq.manageMoney({ transferFrom })`, `src/client.mjs:136`).
- Inventory Search (`engine.pretty.js:419313-419661`): the query is up to 80 characters and is sent
  after 500 ms without typing as `{ action: "search", query }`. A reply lists at most 200 rows
  with a `blockReason` that disables transfer. `slot:<name>` searches equipped gear, one slot per
  search, and leaves out bags, banks and appearance gear. `{ action: "transfer", sourceCharacterId,
  itemInstanceId, itemId, quantity, charges, bag, slot }` pulls one row to the active character.
  Shared-bank rows use the bank withdraw request instead (`engine.pretty.js:419334-419356`). Only
  one transfer runs at a time.
- Shared Tradeskill and Spell Banks: both banks are shared across all characters on the account.
  The help text says eligible banked scrolls teach the active character and its grouped account
  characters missing spells (`engine.pretty.js:423172`). Unverified: the interval, the order and
  any timer, since the client has no code for it and the server probably runs it.
- Personal bank: slots 2000 to 2007 of bag 0, and a bag in bank slot `s` keeps its contents in bag
  `s + 1` (`OSTsR53r.js:15789-15799`). `moveItemToSlot({bag: 0, slot: from}, {bag: 0, slot: to})`
  moves an item or a whole bag between a general slot (22 to 29) and a bank slot without a banker
  or the bank window. The client refuses a container inside another container and a move onto an
  occupied slot. A move can also end without a change or a message, as one did in a live test, so
  a script checks the target slot and sends the move again.

### Key Options and AutoLevel settings (`stores.combat`)

Defaults are the store's initial values (`main.pretty.js:189296-189392`). The server's saved options
replace them after login (`main.pretty.js:191052-191064`). The effect text is the option tooltip
in `engine.pretty.js:412150-412340`.

| State field | Setter | Default | Effect |
|---|---|---:|---|
| `autoUpgradeCompanionsEnabled` | `toggleAutoUpgradeCompanions()` | `false` | During automatic looting, gives an item that is no upgrade for the active character to a grouped same-account companion. Replaced gear stays in the companion's inventory |
| `autoUpgradeEnabled` | `toggleAutoUpgrade()` | `true` | Equips newly looted upgrades on the active character |
| `keepEpicQuestItemsEnabled` | `toggleKeepEpicQuestItems()` | `true` | Protects epic items and Velious armor from automatic and bulk cleanup |
| `keepValuableGearEnabled` | `toggleKeepValuableGear()` | `true` | Keeps gear with a keep score of 50 or more from bulk selling and decluttering |
| `autoSellEnabled` | `toggleAutoSell()` | `false`, saved `true` on this account | Sells everything in a full general inventory that the options here do not protect. The client sends only the switch, and the server decides when the bags are full. The bot keeps it off, because it sold gear the roster gear plan was about to move |
| `autoSellBowsEnabled` / `autoSellPoisonsEnabled` / `autoSellSpellsEnabled` | `toggleAutoSellBows()` / `toggleAutoSellPoisons()` / `toggleAutoSellSpells()` | `true` / `true` / `false` | Lets the Auto-Sell above take bows, poisons and spell scrolls |
| `loreCleanupEnabled` | `toggleLoreCleanup()` | `true` | Lets LORE and quest items through the cleanup rules, so Auto-Sell and Declutter can take them |
| `deleteNoDrop` | `toggleDeleteNoDrop()` | `true` | Delete Clutter: when inventory is full, deletes items without a merchant price outside bags marked No Declutter ("Auto-deleted N clutter items to make room"). The tooltip says NO DROP items that are not quest items, but the server also deleted tradable Krode's Shawls and items the content flags as quest items, such as Giant Wood Spider Femurs |
| `autoBankIngredientsEnabled` | `toggleAutoBankIngredients()` | `true` | Banks tradeskill ingredients when inventory is full |
| `autoSpellBankEnabled` | `toggleAutoSpellBank()` | `true` | Sends overflow spell loot to the Spell Bank |
| `autoLevelMerchantTravelEnabled` | `toggleAutoLevelMerchantTravel()` | `false` | Walks to a merchant to sell and restock, may cross zones. Off keeps sales and purchases remote |
| `autoBuyBagsEnabled` | `toggleAutoBuyBags()` | `true` | Buys backpacks when space opens and the currency is there |
| `autoBuySuppliesEnabled` | `toggleAutoBuySupplies()` | `true` | Buys a full stack of Rations or Water Flasks when the carried reserve falls below 20 |
| `autoLevelRezEnabled` / `autoLevelRezPercent` | `setAutoLevelRezEnabled(v)` / `setAutoLevelRezPercent(50\|90\|96)` | `false` / `50` | After the active character dies, requests its own automatic resurrection that restores that percent of the lost XP (free when a free group rez covers it, otherwise for platinum), then restarts AutoLevel only when `autoLevelRestartEnabled` is on and the character is level 10 or higher |
| `autoLevelRestartEnabled` | not set by the bot | `false` | Also triggers the recovery above and restarts AutoLevel with a continuation potion, limited by `autoLevelMaxContinuations` (default -1) |
| `companionCoinSplitEnabled` | `toggleCompanionCoinSplit()` | `false` | Splits defeated-enemy coin evenly with same-account characters in the party |
| `companionEngagementDistance` | `setCompanionEngagementDistance(v)` | `infinite` | How far from the player a companion engages the player's target |
| `enemyTargetAttackOnArrival` | `main.pretty.js:189392` | `false` | Whether a click in the Enemy Targets list pulls on arrival |
| `noAutoSellBagInstanceIds` / `noDeclutterBagInstanceIds` | `toggleNoAutoSellBag(id)` / `toggleNoDeclutterBag(id)` | `[]` | Per-bag protection from Auto Sell, Auto Bank and Declutter, sent to the server at world entry (`C8.pretty.js:1203-1206`) |

The recovery after a death is `OK.pretty.js:1247-1431` and the Resurrection dialog is
`engine.pretty.js:4413-4470`. Without `autoLevelRezEnabled` or `autoLevelRestartEnabled`, the dead
leader stays at the dialog and AutoLevel stays stopped.

## Raid mode

- Raid mode fights an NPC above level 50 that the leader targets in the current zone. The gate is
  `Vd` (level 51 or above, `main.pretty.js:50654-50656`). Attack and spell commands are accepted for
  such an NPC or for an enemy that is already engaged, and need a loaded, non-empty roster and
  unexpired raid time (`main.pretty.js:72034-72060`, `72325-72337`).
- AutoLevel is unavailable in raid mode, so `startAutoLevel` and the Auto Attack button refuse
  (`main.pretty.js:72310-72314`, `189895-189905`, `OK.pretty.js:8013-8018`). In raid mode `selectEnemyTarget` only
  targets (`OK.pretty.js:7797-7801`), and the leader's own spells are not controlled directly
  (`main.pretty.js:72347-72348`). The readiness wait watches the raid roster and its pets, runs no
  support pass and fails when the raid session changes or a fight starts
  (`OK.pretty.js:500`, `703-711`, `754-777`, `820-826`).
- The client has no raid member limit. Recruits carry `cost: 0`, and the raid catalog `MB` and
  budgets `IB` (`main.pretty.js:25085`, `27779`) are never read apart from a discarded Map
  (`main.pretty.js:50646`).
- Raid time costs platinum per hour for the whole account, priced by its highest-level character,
  and auto-renews only while raiding (`engine.pretty.js:8944-8955`).
- The daily boss list comes from the server: two free resets per account in a rolling 24 hours, one
  kill per boss, and a private copy that lasts 24 hours with free resumes and retries
  (`engine.pretty.js:414979`). `OK.pretty.js:4663-5008` is the casino potion boss table, not the
  daily list.
- Recruits join as `guildCharacter` snapshots (`yQ`, `main.pretty.js:64332-64376`). They give raid
  buffs from their scribed spells (`QQ`, `main.pretty.js:65539-65616`), and a duplicate or weaker
  buff of the same family does not stack (`main.pretty.js:20210-20235`).
- The leader joins as a `kind: "player"` member (`Yt`, `main.pretty.js:54123-54163`). Members that
  are not guild characters add their class's generated package once per class in `n8`
  (`main.pretty.js:66202-66259`), and a Wizard gives a 700-point Spellshield rune (`Ir`,
  `main.pretty.js:66113`, `66234-66236`).
- Kerafyrm's `npc_types` rows (ids 114583, 128089, 128095) are `untargetable: 1`, and his quest
  scripts in `C/effective/quests/sleeper` and `skyshrine` are empty files, so nothing is
  sized on him.

### How a raid fight runs

Read from the release in `.re/releases/20261108T004644-064bc896/pretty/` (abbreviations below).
Raid mode is not AutoLevel with more members: a member acts only on its command and on the
orders the raid holds, and nothing else moves or casts.

- Melee: only Warriors, Paladins, Shadow Knights, Rangers, Monks, Bards and Rogues swing (`OQ`,
  `OST` 65209-65214), and only in melee range of their target (`isRaidActorInMeleeRange`, `CVE`
  5895, 5924). Pets swing when their command is attacking.
- Casting needs an order. A member casts only for the automatic heal mode (`autoHealMode`), the
  nuke order (`autoNukeOrder`), a maintained effect (`ongoingActions`, slows, debuffs and mezzes
  that are recast when they wear off) or a queued single cast (`pendingActions`). A Cleric,
  Druid, Shaman, Wizard, Magician, Necromancer or Enchanter under "attacking" with no order does
  nothing: in the first raid four of them dealt 0 damage in 15 minutes.
- Roles decide who nukes. The class templates give Necromancer, Wizard and Magician the role
  "Caster DPS", Cleric and Druid "Healers", Shaman, Bard and Enchanter "Utility", Warrior, Paladin
  and Shadow Knight "Tanks", and Ranger, Monk and Rogue "Melee DPS" (`OST` 27801-34390). The nuke
  modes "DPS: Balanced" and "DPS: All Out" nuke with Caster DPS only, "All: All Out" with every
  member that has a nuke, healers included (`s61`, `OST` 65206-65208).
- Heal modes: "CLR" modes heal with Clerics only and "All" modes with every member that has a
  heal (`CVE` 5450). "Balanced" keeps the class's mana reserve, "All Out" spends to zero. The mode
  stays set across fights, and healing runs between fights too. "All: Balanced" kept the leader
  alive in the first raid.
- The raid engine's order functions (`setRaidAutoHealing`, `startRaidAutoNuking`,
  `startRaidOngoingAction`, `requestRaidSpell`, `queueRaidCategorySpell`, `CVE` 8378-8387) are not
  exported from their chunk, so a script reaches them only through the raid window or the raid
  store's state. `setRaidAutoHealing(mode)` sets `autoHealMode` and nothing else that matters
  (`XL`, `CVE` 7049). `startRaidAutoNuking(mode, target)` sets `autoNukeOrder` to `{ id, mode,
  target, preparing }`, prepares the fight and clears `preparing` (`CVE` 6960). The engine nukes
  for the order while its target is engaged and `combatActive` is on (`CVE` 7015-7020). In the
  window, a nuke mode's radio only starts a target pick, and the order starts when an enemy is
  clicked (`CVE` 10720-10729).
- Range: the store writes `rangeState: "inCombatRange"` with every attack command (`OST` 71046)
  and never measures it, so it says nothing about distance. Real range is the 3D scene's.
- Moving: All Attack gives every member the target as its raid target. Melee members walk to melee
  range, and casters whose spells give them a range walk to that range and wait there for an order
  (`CVE` 427651-427691). `positionAtTarget(target)` (Run To Target, `OST` 71904-71940) sends every
  member and the leader toward the target without attacking, except members already attacking in
  a fight.
- The leader moves through a loop that runs with each rendered frame (`CVE` 438211-438323). A new
  `playerOrder` revision turns the leader's auto attack on for "attacking". The loop then walks to
  melee range of the leader's raid target, but it stands still while that target is missing or
  dead, while the combat store's `isCasting` is on and while another navigation runs. With Run To
  Target first and one All Attack that the script waits on, the leader stood at the target with
  auto attack on from the first second. In the first raid, with two All Attack calls and no Run
  To Target, he stood 12 minutes in a visible tab at 60 frames per second, and which condition
  held him is open.
- End of a fight: `finishCombat` runs when no engaged enemy remains (`OST` 72130) and clears the
  nuke order, maintained effects and queued casts, but not the heal mode. A fleeing enemy stays
  engaged, and melee skips it: an unkempt fanatic fled 85 units at 22% HP, out of melee and spell
  range, while the leader navigated toward it without closing in, and came back a minute later.
  Root and blind stop a flee, a mez, stun, fear or charm keeps one from starting, and undead never
  flee (`0ea` 4399-4466). While the leader is dead the fight stays open until a revive or a
  release. Recruits keep their HP and mana between fights, and fallen recruits get up at 10 HP
  once no enemy is left ("1 fallen raid member gets back up to rest.", `CVE` 7688). A kill gives
  the leader normal kill XP with the usual line, "You have defeated an unkempt fanatic and gained
  270400 experience!", after "Raid combat ended: no engaged enemies remaining."
- The leader's death: `RaidLeaderLifecycle` (1226) records the death, a revive or a release. In
  the window, Heal & Revive, a revive spell and then the leader in the roster lets a living member
  cast it, and the leader comes back with the spell's share of HP and no mana. Two raid deaths of
  the leader cost no XP. A release respawns the leader at the bind point after 15 seconds and
  keeps raid mode on.
- Raid time is checked when a fight starts. The client does not end a fight when the hour runs
  out.
- The raid window can close during a fight while raid mode and the fight go on (`isRaidOpen`
  false, view "setup", cause open). The command panels exist only in the open window on the
  combat view, so a script that uses them opens that view first, as the client's own
  `returnFromLoot()` does.

### Running a raid from a script

Read from the release in `.re/releases/20261108T004644-064bc896/pretty/` (`OST` OSTsR53r.js, `CVE`
CVEP2_Ra.js, `0ea` 0eakiHJI.js, `CAU` CAUokwED.js). The bridge's `iq.raid` wraps these steps and the
bot's raid task (`iqBot.raid`, `iq.raid()` in the SDK) runs them in order. With group 1's leader at
46, buying time, recruiting five account characters, attacking an unkempt fanatic and a kill have
run once.

- Start: the party panel's Start Raid (`CVE` 415903) releases the account companions
  (`releaseAccountCharactersForCamp`, "Your party has been disbanded."), then calls the raid store's
  `openRaid()`, which calls `activateRaid()` (`OST` 71213-71240). `activateRaid` needs the window
  open, a leader of level 46 or more and unexpired raid time, then sets `raidModeActive` and turns
  AutoLevel off (`OST` ~72300).
- Raid time: `RaidAccess` (1236) with `{ characterId, action, autoRenew, operationId,
  expectedExpiresAtMs }`, where `action` is `status` (read only), `start`, `renew` or `settings`
  (`OST` 70810). `operationId` is one UUID per purchase attempt, reused on retry. The reply carries
  `priceCopper`, `expiresAtMs`, `serverNowMs`, `autoRenew` and `chargedCopper`. The button is "Start
  Raid for Nk" in the Raid Time section of the combat view (`CVE` 9082-9105). Its request function
  (`M11`, `OST` 70820) keeps the quote and expiry in a store (`i2`), which raid mode reads before a
  fight, so a script calls that function (`raidTime` in the bridge) and not the bare request.
- Recruits: `addGuildMember(characterId, leaderLevel)` (`OST` 71607) loads the character's snapshot
  with `GuildRaidCharacterProjectionRequest` (1194) and appends it. It refuses during combat and for
  characters outside the account and guild. Only the recruit list hides characters below 46: the
  store adds them, and the server accepted recruits at levels 44 and 45. `addGuildMembers(ids,
  leaderLevel)` is Add All, four at a time. `removeMember(memberId)` takes the member id, not the
  character id, and works only in the setup view. Before the first fight the roster must be
  validated, which the attack path does by itself.
- Attack: `setAllCommand("attacking", target)` (`OST` 71957-71990) prepares the roster and calls
  `beginCombatForTarget(target)` (`OST` 72063). That needs raid time, a non-empty validated roster,
  and an NPC of level 51 or more or an engaged enemy, then sets `openingTarget`. A watcher sends
  `StartCombat` (1025) with `singleFight: true` for that target (`CVE` 5770, `0ea` 44025). Without
  a target argument it attacks the leader's target, `combat.targetNPC`, which the Enemy Targets
  action sets in raid mode (`selectEnemyTarget` with the NPC type id). The first fight with
  recruits validates the roster with the server first (`prepareCombatForTarget`, `OST`
  71510-71540), so the fight starts a few seconds after the call, and `iq.raid.attack()` waits
  for `combatActive`. A second attack call in that window raced the first in the first raid.
- Orders: `iq.raid.heal(mode)` sets `autoHealMode` and `iq.raid.nuke(mode)` sets `autoNukeOrder`
  for the running fight's target, the fields the window's panels set through the raid engine.
  `iq.raid.position()` is Run To Target (`positionAtTarget`). `iq.raid.revive()` opens Heal &
  Revive (`toggleCommandPanel("heal")`), picks the first revive spell in the panel's Revive group
  and then `raid-member-player`, the steps a person takes in the window. `iq.raid.state().leader`
  holds the leader's order, auto attack, casting and navigation, which decide whether his frame
  loop moves him.
- Daily bosses: `DailyRaidBossesRequest` (1222) with `{ characterId, zoneId }` lists them, and the
  same request with `bossKey` summons one (`CVE` 415155). The reply holds `resetsRemaining`,
  `nextResetAtMs` and `bosses[{ key, name, zoneName, status, availableAtMs, expiresAtMs,
  disabledReason }]`, and a summon returns the boss's `spawnInstanceId`.
- End of a fight: the store's `finishCombat` runs once no enemy is engaged ("Raid combat ended:
  ..."), and a kill sends `CombatClientEnd` (1113) with `victory` and `raidMemberCount`, answered
  by `CombatEnded` (1029) and the loot in the RAID LOOT tab. A dead leader goes through
  `RaidLeaderLifecycle` (1226) and can still command the raid. A wipe releases the leader.
- End: the End Raid button calls the combat service's `abandonRaid()` (`0ea` 42793), which
  stops a running fight with `StopCombat` (1026) or releases a dead leader, then calls the
  store's `endRaid()`. The store's `endRaid()` alone ends raid mode in the page and refuses while a
  fight runs, the leader is dead or an end is pending (`OST` 71247-71251). Outside a
  fight the server left `StopCombat` unanswered for 10 seconds, and the pending end then blocked
  `endRaid()` until the page reloaded, so the bridge's `iq.raid.end()` uses `endRaid()` out of a
  fight. Nothing brings the party back or restarts AutoLevel afterwards. The bot's party and
  AutoLevel keepers do that once the raid task ends.
- State for scripts (`stores.raid`): `raidModeActive`, `isRaidOpen`, `view` (`setup` or `combat`),
  `combatActive`, `leaderDead`, `lifecyclePending`, `lifecycleError`, `roster[]`, `engagedEnemies[]`,
  `focusTarget`, `openingTarget` and `eventLog`. A roster member carries `displayName`,
  `source.characterId`, `className`, `role`, `level`, `hp`, `maxHp`, `mana`, `maxMana`, `alive`,
  `command`, `rangeState`, `damageDone` and `hate` (`yQ`, `OST` 64324-64400). A recruit
  joins at full HP and mana. DOM test ids: `raid-setup-panel`, `raid-recruit-<characterId>`,
  `raid-member-<id>` and `raid-loot-window`.
- Open: whether the server caps the roster, and whether a raid stays active after a wipe.
