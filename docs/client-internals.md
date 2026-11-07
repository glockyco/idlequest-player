# IdleQuest client internals

What the web client does, as needed to drive it. Source: the shipped bundles under
`https://idlequest.net/assets/`, prettified locally into `.re/`.

## Where the game runs

- Combat, AutoLevel and party tactics run in the browser. The server confirms results and owns the
  account, inventory, zone and session state. A running tab is required for automation.
- State lives in zustand stores. Each store has `getState()` and `subscribe()`, and its actions are
  functions on the state. `src/bridge.js` locates stores by state keys because export names and
  chunk file names change on every release.

## Transport

- `GET /api/transport/credentials` returns a certificate hash. The client opens WebTransport to
  the game server with it, and falls back to `wss://idlequest.net/ws?session=&client_release=&state_protocol=`
  when WebTransport is unavailable.
- Frame: `uint32le length`, `uint16le opcode`, JSON payload. Opcode `0xFFFF` wraps a compressed
  packet: `uint16le inner opcode`, `uint32le size`, raw deflate data.
- `data/opcodes.json` maps opcode names to numbers (about 820 of them).
- Requests go through `socket.sendJsonRequest(op, replyOp, payload)` or the `_requestId`
  correlated variant. Server pushes are dispatched to handlers registered by the client.

## Authentication

- `JWTLogin` (4) with `{authType: "login", email, password, clientRelease}`, or `authType: "guest"`
  with a `guestToken` kept in `localStorage`. The reply `JWTResponse` (3) carries the session id and
  a resume token.
- The session id and resume token are held in page memory only. If the connection drops and the
  server rejects the resume (`SessionResumeRejected`), the client returns to the login screen.

## Entering the world

`EnterWorld` (14) with the character name returns `PostEnterWorld`. The server then pushes
`CharacterData`, `CharacterInventory`, `CharacterSkills`, `CharacterCurrency`, `CharacterBind`,
`CharacterStatsData`, `CharacterSpellbook` and `ZonePlayerSnapshot`. The client applies them
through its own handlers and sets `socket.worldReady`. The zone and 3D scene load after that.

## Combat runtime and AutoLevel

The combat runtime is a singleton: `G.getInstance()` exported from the chunk that holds the string
`Waiting for party to be ready` (the bridge reaches it through `iq.mods`). Its `combatScene`
exposes the live world. Chunk and export names change per release, so find it by method names such
as `castSpellAtSelectedTarget` and `getAliveCombatTargetList`.

- Target picker: AutoLevel takes `combatScene.findClosestCombatTarget` filtered by con, level cap and
  reachability. It does not weigh XP, nearby danger, water or the route.
- Readiness gate: every start through AutoLevel, the Enemy Targets list or the Auto Attack button
  runs `prepareAutomatedCombat`, which summons pets and then waits standing still
  (`waitForPartyReady`, up to 2 minutes plus any time spent rooted). It ends only when every party
  member and pet has full HP and, for mana users, full mana, nobody is rooted ("Waiting for root to
  wear off the party."), and the support pass cast no cure or dispel. So one member whose cure
  keeps failing holds the whole party until the effect wears off.
- Dispels such as the Enchanter's Cancel Magic succeed with a chance per effect of 32% plus 7% per
  level the caster is above the effect's caster, or minus 2% per level below, clamped to 10-100%
  (dispel `levelModifier` added to the caster's level, minus one). Against same-level or higher
  casters most attempts fail. `analyze.mjs` reports waits with cure or dispel casts separately
  ("Between pulls").
- Roots between pulls: the readiness wait reads each member's and pet's active effects from the
  effects registry (`l.getEffects(entityId).active`, entity ids `character:<id>` and
  `pet:<owner>:<name>`), and `cm({effects})` classifies them. Each effect carries `spellId`,
  `casterLevel` and `expiresAtMs`, so the remaining root time and the dispel chance are known in
  advance. The bot uses this to turn cures on only for roots worth dispelling (`dispelRoots`).
- Auto Attack and AutoLevel: AutoLevel's pulls (`startSpatialCombat`) do not start the fight on
  arrival by themselves. The target approach starts it only while Auto Attack is on, and otherwise
  stands in phase `waiting-to-attack` without a timeout. The client turns Auto Attack off when every
  enemy left in a fight is mezzed (`adoptActiveEncounterForAutoLevel`, because
  `canAutomaticallyFocusNpc` excludes mezzed enemies) and does not turn it back on, so after an
  Enchanter mezzed the adds the next pull stood still until something pressed Auto Attack. The bot
  presses it (`attackSelectedTarget`, the button's handler) when a pull waits like that.
- Direct starts skip the gate: `castSpellAtSelectedTarget(gem)` (a manual spell cast, mode
  `manual-spell`) and `commandPetAttackSelectedTarget()` (mode `pet-command`) call
  `startCombatWithEntity` directly. The companions then assist the player's target with their own
  tactics. A manual pull at about 430 units started the fight at once and all five alts joined.
- Live targets: `combatScene.getAliveCombatTargetList()` returns `{spawnInstanceId, npcId, name,
  level, distance}` sorted by distance. `combatScene.navigateToCombatTarget(spawnInstanceId, onError)`
  walks with the client's own navigation, and `clearNavigationTarget()` stops it.
- Do not call `warpPlayerToCombatEntity` or `teleportPlayerToEQPosition`. They exist for debugging and
  are not something a player can do.
- AutoLevel limits are coupled. `setMaxLevelDiff(n)` also sets the highest con (0 gives White, 1 or 2
  Yellow, 3 or more Red) and `setMaxCon(c)` resets the level cap (White 0, Yellow 2, Red 5). Set the
  cap and the minimum con together, then read both back.
- Enemy HP, melee damage and AC are a function of level alone in the game data, so same-level
  enemies are identical. A high level named enemy can still stand in a camp of ordinary ones. A
  level 30 Minotaur Sentry (1,200 HP, hits up to 64) joined a fight with level 10 slavers in
  Steamfont and killed the Warrior.
- Zone change: `rs(zone)` in the chunk that also holds the character profile helpers sends the same
  request as the Travel window. It has no combat check. Changing to the zone you are in re-enters it
  at the safe spot and drops all engaged mobs, which makes it the escape from a bad fight.

## Guard

`iq.guard` runs once a second inside the page, so it works while no script is attached. While a
mob is engaged it checks four things: a mob `levelGap` or more levels above the leader, a mob whose
biggest hit times `hitsToKill` reaches the lowest max HP in the party, a party member newly dead,
and a Cleric under `healerManaPct` mana while someone is under `healerHpPct` HP. On a trigger it
stops AutoLevel, re-enters the current zone (or changes to `retreatZone` if set), and starts
AutoLevel again with the same limits, about nine seconds later. Before it leaves it defers every
mob of that fight with the client's `deferAutoLevelSpawn` for `avoidMin` minutes, the skip list the
client uses for spawns it cannot reach, because AutoLevel picks the nearest target and would
otherwise pull the same camp again right after re-entering. After `escalateAfter` escapes in an
hour, an escape caused by a mob inside AutoLevel's own level range lowers the level cap by one (not
below `minLevelDiff`), because those pulls are too hard, and a quiet hour restores the earlier
limits. Escapes from wanderers above the cap change nothing, because lower limits would not keep
them away. Whether a zone still pays with its escapes is for the measured XP per hour to decide:
`analyze.mjs` counts escapes and the seconds they cost. `guardStatus()` shows the phase and recent
escapes, `setGuard({...})` changes the settings and `testGuard()` forces one escape without
touching a setting. Each escape is a `guard` line in the event log.

## In-page chores

`window.iq.chores.autoBuySpells` defaults to `true`. When the game adds its missing merchant-spell
reminder, the page sends the same `ScribeAvailableSpells` requests as the Buy Spells and Buy
Companion Spells macros, for the active character and its party companions. It needs no attached
script. Use the SDK's `setChores({ autoBuySpells: false })` to disable it, or `buySpells()` to run
the requests manually. Chore results are recorded as `chore` event lines.

## Party tactics

- Party members' tactics are in the party spells store (`overridesByCompanion`), keyed
  `bot:<characterId>:<bot>` for default bots and `character:<characterId>` for account characters.
  A bare bot name is stored and never read.
- The active character's own tactics are in a separate store (`overridesByCharacterId`, with
  `meleeByCharacterId`), keyed by the plain character id. An entry for the active character in the
  party spells store is ignored. `iq.setTactic` picks the right store.
- A level 1 recruit gets about half the XP share of a level 5 leader on the same kill, because shares
  are level-weighted.

## Macro bar, account sharing and options

### Built-in macro bar actions

The macro action map (`engine.pretty.js:403130-403250`) defines 24 player actions across the default
pages:

| Slot | Button | Store / handler | What it does |
|---:|---|---|---|
| 1 | Path To... / Merchant List | `stores.combat.toggleMerchantList()` | Opens in-zone NPC navigation (Merchants, Bankers, Guildmasters, Quest NPCs) |
| 2 | Enemy Targets | `stores.combat.openCombatTargetList()` | Opens the live enemy list. Clicking a row walks to and pulls that spawn |
| 3 | Stuck | `stores.chat.sendMessage("/stuck")` | Teleports out of geometry traps |
| 4 | Bind Soul | Bind handler | Binds the character's respawn point |
| 5 | Loot Closest | `stores.chat.sendMessage("/lootclosest")` | Opens the nearest unlooted corpse |
| 6 | Tradeskill Bank | `stores.combat.openTradeskills()` | Opens the account-shared ingredient bank and recipe crafter |
| 7 | Buy Spells | `ScribeAvailableSpells` (`"self"`) | Buys and scribes missing merchant spells for the active character |
| 8 | Buy Companion Spells | `ScribeAvailableSpells` (`"companions"`) | Buys and scribes missing merchant spells for grouped account companions |
| 9 | Spell Bank | `stores.combat.openSpellBank()` | Opens the account-shared spell scroll bank |
| 10 | Delete Clutter | Declutter handler | Destroys unprotected low-value NO DROP items and banks research ingredients instead |
| 11 | Auto Sell | `ShopPlayerSell` bulk runner | Sells unprotected sellable bag items with a 20% courier fee when away from a merchant |
| 12 | Auto Bank | Ingredient/scroll banker | Moves tradeskill ingredients and spell scrolls into the shared account banks |
| 13-14 | Fish / Forage | Skill handlers | Uses Fishing or Foraging |
| 15-17 | Casino / Pizza / Guild | Panel openers | Opens the Casino, Pizza or Guild pane |
| 18 | Farm Items | `stores.combat.setIsFarmingDisplayOpen(true)` | Recommends zones and filters AutoLevel targets for 16 material and research categories (`WizardRunes`, `NecroWords`, `EnchPages`, `MageParts`, `Alchemy`, `HighQualityOre`, `Velium`, etc.) |
| 19 | Manage Money | `stores.combat.openManageMoney()` | Lists carried and bank coin for every character on the account and pulls any character's coin to the active character |
| 20 | Inventory Search | `stores.combat.openInventorySearch()` | Searches carried bags, equipped slots (`slot:legs`, etc.), personal banks and shared banks across all account characters, and transfers matching items to the active character |
| 21 | Alt Adv | `stores.combat.openAbilities("advancement")` | Opens the Alternate Advancement window |
| 22-24 | Bug / Feature / Edit Name | Panel openers | Opens player report or character rename |

### Account-wide sharing rules

- **Held-item transfer (`transferHeldItem(characterId, equip)`, `main.pretty.js:53376`):** checks
  `stores.roster.getState().characters.some(c => c.id === characterId)`. The recipient does not need
  to be in the current party: items and bags can be given or equipped onto offline characters or
  characters in a second party. `equip: true` replaces the weakest eligible occupied slot and puts
  the old item into the recipient's inventory (which fails with `"That character has no inventory
  space for the replaced item"` if the recipient has no free slot). `equip: false` fills an empty
  equipment slot or places the item (including empty or populated bags) into a free inventory slot.
- **Manage Money (`engine.pretty.js:419664-419899`):** queries `{ action: "read" }` for all
  characters on the account (`carried`, `bank`, `totalCopper`) and `{ action: "transfer",
  sourceCharacterId, revision, operationId }` to pull all carried and bank coin from another
  character into the active character's wallet. Exposed in the SDK as `iq.manageMoney({ transferFrom
  })`.
- **Inventory Search (`engine.pretty.js:419315-419660`):** queries `{ action: "search", query }`
  across all account characters and shared banks, and `{ action: "transfer", sourceCharacterId,
  itemInstanceId, ... }` (or shared-bank withdraw) to pull an item directly to the active character.
- **Shared Tradeskill and Spell Banks (`engine.pretty.js:423167`):** both banks are shared across
  all characters on the account. Banked spell scrolls automatically teach missing spells every 5
  seconds to the active character first, then to grouped same-account companions in recruitment
  order.

### Key Options and AutoLevel settings (`stores.combat`)

| State field | Setter | Default | Effect |
|---|---|---:|---|
| `autoUpgradeCompanionsEnabled` | `toggleAutoUpgradeCompanions()` | `false` | Hands down newly looted upgrades to grouped same-account companions |
| `autoUpgradeEnabled` | `toggleAutoUpgrade()` | `true` | Equips newly looted upgrades on the active character |
| `keepEpicQuestItemsEnabled` | `toggleKeepEpicQuestItems()` | `true` | Protects epic and Velious quest items from Auto Sell and Declutter |
| `keepValuableGearEnabled` | `toggleKeepValuableGear()` | `false` | Protects valuable equipment from Auto Sell |
| `autoBankIngredientsEnabled` | `toggleAutoBankIngredients()` | `true` | Automatically banks tradeskill ingredients during cleanup |
| `autoSpellBankEnabled` | `toggleAutoSpellBank()` | `true` | Automatically banks unneeded spell scrolls during cleanup |
| `autoLevelMerchantTravelEnabled` | `toggleAutoLevelMerchantTravel()` | `false` | Walks to a merchant to sell and restock bags/supplies when full |
| `autoBuyBagsEnabled` | `toggleAutoBuyBags()` | `true` | Buys bags for empty top-level slots during a merchant maintenance trip |
| `autoBuySuppliesEnabled` | `toggleAutoBuySupplies()` | `true` | Restocks food, drink, pet reagents and ammo during a merchant trip |
| `autoLevelRezEnabled` / `autoLevelRezPercent` | `setAutoLevelRezEnabled(v)` / `setAutoLevelRezPercent(50\|90\|96)` | `false` / `50` | Casts Resurrection on dead party members between fights |
| `companionCoinSplitEnabled` | `toggleCompanionCoinSplit()` | `false` | Splits looted coin among party companions instead of keeping it on the leader |
| `noAutoSellBagInstanceIds` / `noDeclutterBagInstanceIds` | `toggleNoAutoSellBag(id)` / `toggleNoDeclutterBag(id)` | `[]` | Per-bag protection from Auto Sell, Auto Bank and Declutter |
