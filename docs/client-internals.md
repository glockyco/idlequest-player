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
  runs `prepareAutomatedCombat`, which summons pets and then waits until every party member and pet
  has full HP and, for mana users, full mana (`waitForPartyReady`, up to 2 minutes). The wait
  happens standing still before the walk to the next target.
- Direct starts skip the gate: `castSpellAtSelectedTarget(gem)` (a manual spell cast, mode
  `manual-spell`) and `commandPetAttackSelectedTarget()` (mode `pet-command`) call
  `startCombatWithEntity` directly. The companions then assist the player's target with their own
  tactics. A manual pull at about 430 units started the fight at once and all five alts joined.
- Live targets: `combatScene.getAliveCombatTargetList()` returns `{spawnInstanceId, npcId, name,
  level, distance}` sorted by distance. `combatScene.navigateToCombatTarget(spawnInstanceId, onError)`
  walks with the client's own navigation, and `clearNavigationTarget()` stops it.
- Do not call `warpPlayerToCombatEntity` or `teleportPlayerToEQPosition`. They exist for debugging and
  are not something a player can do.

## Party tactics

- Default bot tactics are keyed `bot:<characterId>:<bot>` in the party spells store. A bare bot name
  is stored and never read.
- A level 1 recruit gets about half the XP share of a level 5 leader on the same kill, because shares
  are level-weighted.
