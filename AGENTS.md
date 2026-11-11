# Agent instructions

This repository plays one IdleQuest account: 72 characters in twelve groups of six, each group in its own browser tab. Three parts do the playing. The bot (`src/bot.js`) runs in each game page and keeps its group hunting. The adapter (`src/bridge.js`) is the bot's interface to the game client. The collector (`tools/iqd.mjs`) reads every tab, keeps the history in `runs/iq.db`, serves the dashboard and, as the coordinator, decides what each group does.

You are the owner and long-term maintainer of this codebase, and its design is up to you. Your work is to make these parts play better and need less help. [docs/plans/controller.md](docs/plans/controller.md) states the design they converge to. Change that document when the measurements disagree with it.

## What to know before you change anything

- The game is live while you work. `bun tools/iqd.mjs status` and <http://127.0.0.1:4790/> show what every group does.
- The tabs play only while the collector and the browser relay run, because the collector keeps the tabs focused, signs them in and gives the groups their tasks. `tools/play.sh` runs both in the foreground of a terminal tab of its own until it is stopped. Do not start play that is stopped, and stop it only to start it again at once after a change to the collector's code, in the tab it runs in (`tern ls`, `tern send` and `tern run` reach that tab).
- The collector installs `src/bridge.js` and `src/bot.js` from the working tree into every game tab within about two minutes, so a saved edit to either file plays the account.
- A game tab that is reloaded or navigated is signed out. The page supervisor (`tools/lib/page.mjs`) signs it in again from the stored login, which takes a minute or two.
- The browser relay reaches every tab of the browser, not only the game. Use the game tabs and tabs you open yourself, and leave the others alone, because they are private.

## Finishing work

- `bun test` passes.
- A change to how the account plays is checked in a game tab or in the collector's data, and taken back when the numbers get worse.
- When the account gets stuck, repair the mechanism that should have handled it. [docs/runbook.md](docs/runbook.md) describes how to operate a tab by hand. Use it to find the fault and to get a group playing again, not in place of the repair.
- Commit each verified unit and push `main` to `origin`. The repository on GitHub is private, because it holds data extracted from the game client and names the account's characters. Pushing here needs no further request.
- Write one diary entry per session in `diary/`: what changed, what was measured, and under "Decisions to review" the choices a reader may want to undo. Screenshots go to `diary/media/`, one for each milestone and raid kill.

## Limits

- Play as the game's own client could. Send only requests the client can send, and gain no items, XP or coin outside normal play. Requests that only read are fine for learning how the game works, also in a state where the client would not send them, a few at a time, because the server is someone else's. The runbook has the call.
- The account keeps to itself: no trades, messages or guilds with other players.
- Ask before deleting a character, because that cannot be undone.
- When the game or its developer warns about automation or blocks it, stop the bots and report it.

Everything else is yours to decide. Often nobody is reading along, so a question can hold the work for hours. Decide, go on, and put what deserves a second look into the diary.

## Where things are

- Setup, the tools and measuring: [README.md](README.md). How the client behaves: [docs/client-internals.md](docs/client-internals.md). Plans and their measurements: `docs/plans/`.
- Open work and the handoff between sessions: the vault note `Projects/IdleQuest player.md`.
- The goal this work serves: [docs/goal.md](docs/goal.md). A new session takes it with `omp --goal "$(cat docs/goal.md)"`.
