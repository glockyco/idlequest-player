# idlequest-player

Tools for playing [IdleQuest](https://idlequest.net/play), a browser recreation of classic EverQuest
with an AutoLevel mode, and a diary of the character played with them.

## How it works

The game simulates combat, AutoLevel and party tactics inside the browser client. The server holds
the account, inventory and zone state. A standalone program that talks to the server directly would
have to reimplement the combat engine, so this project drives the real client instead:

- `src/bridge.js` is evaluated inside the game page. It finds the client's state stores and its
  server socket and exposes them as `window.iq`.
- `src/client.mjs` injects the bridge into a browser tab and calls it from a script.

Protocol and client internals: [docs/client-internals.md](docs/client-internals.md).

## Setup

1. Open https://idlequest.net/play in Chrome and sign in.
2. Attach a tab object that has `evaluate(expression)`, for example one from omp's `browser` tool
   with the relay enabled, then:

```js
import { attach } from "./src/client.mjs";
const iq = await attach(tab);
console.log(await iq.status());
```

## Rules for contributors

- Never assign to `socket.onJson` or another callback slot on the game's objects. The client's own
  packet dispatch lives there, and replacing it leaves the world stuck on the loading screen.
  Tee traffic by wrapping instance methods, as `src/bridge.js` does.
- Avoid reloading or navigating the game tab while signed in. The page keeps no credentials in
  cookies, localStorage or IndexedDB, so a lost session means signing in again.
- `.re/` holds downloaded copies of the game client for reverse engineering and is not committed.
  Regenerate `data/opcodes.json` with `tools/extract-opcodes.ts` after a client release.

## Diary

[diary/](diary/) has one entry per session, with screenshots in `diary/media/`.
