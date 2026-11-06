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
