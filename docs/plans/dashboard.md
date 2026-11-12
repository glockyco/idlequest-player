# Dashboard redesign

The dashboard (`tools/dashboard/`, served by `iqd run` on port 4790) is the one place where a person sees the account without a terminal. This plan replaces its current layout.

## What the page is for

It answers three questions, in this order, because that is the order in which they matter on a glance:

1. Is anything wrong, and does it need a person?
2. How far is the account toward the goal, and how fast is it moving?
3. What is the system doing, and did it work?

A fourth question, whether the engineering gets better (interventions, stalls and their recovery times per group-hour), matters weekly, not on every glance.

## The current page

| Section | Worth keeping | Problems |
| --- | --- | --- |
| Header | Collector and relay state | One status only. It covers the top of a section after a jump from the menu. |
| Goal tiles | XP share to 60, lowest, mean and highest level | The criteria table holds fixed text ("not collected yet") and no numbers. |
| Roster grid | All 72 characters at once | Levels 22 to 30 get nearly the same colour. It takes 12 rows for what one number per group says. |
| Hours to each level | The estimate to 60 | One row per session (24 rows after the machine restart), a range in every cell. |
| Group cards | The state badge with cause and duration, the 10-minute activity bar | No time axis, so idle stretches cannot be placed. Party lists repeat the roster. Memory and bag space show always. Two cards per group after the restart. |
| Last hour table | XP/h, shares of fight, move, recover and idle with its cause | Repeats the cards in a second form. |
| Attention | Open items | Items that a mechanism already retries look the same as items that need a person. The resolved list is 25 rows of "gone, condition cleared". |
| Interventions | Manual steps | One log for coordinator decisions, SDK calls and agent notes. |
| Coordinator | Task history | About 100 internal ids with counts ("gear-loam-encrusted-pantaloons 20"). No outcome per task. |
| Engineering | The right metrics | Two daily bars so far, one table repeating them. |
| Trends | Level lines per leader | None. |
| Jobs | Research record | Useful to agents, not on a glance. |

## Proposed page

Each built stage is shown as screenshots of the real page on live data.

From top to bottom:

1. A status line that stays at the top: collector, relay, groups playing out of 12, account XP per hour now and over 24 hours, idle share of the last hour, the number of items that need a person, and the largest tab memory. Each turns amber or red at a threshold, and the line stays calm while everything works.
2. Side by side, "Needs you" and "Goal progress".
   - "Needs you" lists only what a person must decide or fix. Failures that a mechanism retries or ends by itself are one muted summary line under it.
   - "Goal progress" shows one bar per success criterion with its numbers: levels (XP share, characters at 60, the estimate for the slowest group), gear, AA, epics and raids. Beside each bar's value, in green, is what moved it in the last 24 hours, and a line under the bars names the latest milestone.
3. Groups, one row per group with the same columns, so the twelve compare at a glance: level bar, zone, what the group does now and for how long, a timeline of the last two hours with one cell per minute coloured by activity, task spans and deaths, XP per hour, idle share with its main cause, and the current task or next retry. A click on a row opens the party with levels, bags, memory, rotation, crowded zones, the group's progress of the last two days, the bot's recent lines and this group's task history.
4. Progress: what moved the goal bars in the last two days, newest first under day headings, with a filter per kind and one for milestones ("Progress" below).
5. Gear, current against target: one row per group with a bar per character, the share of its slot score it wears against what the account's items and the wanted drops would give it. A click opens the character's slots: what it wears, the next move the gear plan queued for that slot (from whom, or bought where), and the best wanted drop for it (zone, enemy, expected hours). This answers how far each character is from the best gear the account can give it, and what moves it there.
6. Side by side, "Coordinator" (running tasks, next retries, the running experiment, recent outcomes with their reason) and "Where time goes" (24 hourly bars of all groups' time by activity and idle cause, the view for criterion 5).
7. Folded away until opened: the bosses in the open world (each with whether it is up, when it comes back, how long it stood before someone killed it, what a kill is worth and what the raid simulator says, with the look the plan sends next), the epic chains, engineering health, the roster grid, the level trend chart, experiments and jobs, and the alert history.

The page uses the full width of the window, keeps the activity colours of today's page for the same meaning everywhere, shows item and quest names instead of ids, and gives times as "3m ago" with the clock time on hover.

Removed: the fixed criteria table, the separate hours-to-level table (the estimate moves into the goal bar and the group row), the last hour table (its numbers move into the group rows and their details), the party lists on cards, the raw interventions log (the coordinator's decisions move to the coordinator panel, manual steps to engineering health), the list of missing copies (the goal bar for epics and the coordinator panel name the pieces that matter), and the resolved list (folded alert history).

## Data the page needs

1. Minute totals per group: seconds per activity and idle cause, XP gained, deaths. iqd writes them as it exports samples and keeps 14 days. The timelines, the hourly bars, XP sparklines and today against yesterday read them, not the 72 MB sample files.
2. The outcome of each coordinator task (status and reason) in its history, as iqd already copies the retry time and duration.
3. A summary of quest chains (holders, started, needers) and of the gear pass per pass, for the goal bars.
4. The gear pass's slot plan per character (worn item, queued move, wanted drop, scores now and at target), saved with each pass.
5. AA ranks, from the AA window of each tab's active character.
6. The progress record ("Progress" below).

## Progress

Progress is a change in the state a goal bar measures. iqd records each change once, where it observes that state, in the `progress` table (`tools/lib/progress.mjs`), so the feed explains the bars and cannot disagree with them.

| Kind | Source | Milestone |
| --- | --- | --- |
| level | A tab snapshot shows a character above its last stored level, one event per level gained. | Levels 46, 50, 55 and 60, which open AA and raids, higher spells and the cap. |
| gear | A gear task's equip line of a move the gear pass queued, at the time of the line. Two gear passes for what has no such line: a slot holds an item the earlier pass queued for it, or the character's set score rose. | None. |
| item | A loot line of an item the account still wants: a chain piece its needers lack copies of, an opportunity item with copies missing, or a gear target. | None. |
| chain | Two coordinator passes: a character became a holder of a chain's reward, or started a chain. | A finished chain. Starting one is a minor step. |
| aa | Two AA states of a character: a trained rank, or earned points. | None. Earned points are a minor step. |
| raid | The bot's raid alert of a kill. | A boss of `data/raid-goal.json`, whose count the raid bar shows. |

- An item counts from its loot line, because Inventory Search cannot tell a new copy from a search that missed one. A copy beyond what the account lacks is surplus and does not count: of a gear target's item the first copy since the gear pass is for the character the row names, each further one for one of the other characters that can use it, and one beyond those is not listed. A copy that goes back into the loot window, as a second copy of a lore item does, was not looted.
- A character whose party a gear pass cannot read keeps its last worn items (docs/collector.md, Gear), so a party that reappears is not counted as new gear.
- A group's ordinary level-ups of one day share a row, and so do the upgrades of one gear task or one gear pass, because twelve parties level about hourly and a task upgrades a dozen characters. A click opens the row's events. A group's level-ups to one milestone share a row within half an hour.
- An item shows as its icon and name with the game's item window on hover, and an upgrade shows the replaced item's icon before the new one, or an empty box for a slot that was empty. Rows record item ids, the loot line's from its loot packet, and the cards come from the card store (`tools/lib/cards.mjs`), which the sheet and Most wanted read too.
- The bars' green numbers count levels, gear slots, wanted items, finished chains, AA ranks and raid kills. Minor steps do not count.
- `iqd status` prints the same 24-hour counts and the latest milestone.

## Text on the page

The page is read at a glance, so its text follows these guidelines. They hold until a better way turns up, here or while a panel is built, and then they change.

1. Each panel answers one question, and an element stays only if it helps answer it.
2. A state is a short tag ("G1 next", "after G1's hunt", "too strong (level 56)"). The reasoning behind it goes into the tag's hover, if it helps at all.
3. Numbers show as bars, chips or colours where a glance compares them. Text carries only what a picture cannot.
4. Repeated facts collapse: one card for one problem on several tabs.
5. Small things shrink: an upgrade under 1% shows as an icon, not a line.
6. Names as the game shows them: zone names in full, no `#` on named enemies, no cause ids such as `clientPause`, no file paths or commands.
7. No footnotes. A panel that needs one has the wrong labels.

The coordinator and the bot hand the page states with their facts, and the page words them in one place per panel, so a wording changes in one place.

## Order of work

1. The new layout on today's data: status line, needs-you split, goal bars with the estimate, one row per group, coordinator names and folded sections.
2. Minute totals, the group timelines and the hourly time bars.
3. Task outcomes, quest chain summaries and the gear view.

Each stage tests its views on a database built in memory, is checked in the browser with a screenshot, and is committed on its own.

## Decisions

- One page, no tabs: the three questions sit on the first screen and the details are folded below, so a glance needs no click.
- Groups show as one row each with the same columns, because twelve rows compare better than twelve cards.
- The timeline covers two hours at one cell per minute, which fits a row and shows a stall while it still matters. Longer spans belong to the hourly "Where time goes" bars.
- "Needs you" holds only what no mechanism handles: a decision, a sign-in, a stall longer than ten minutes, a `bags` alert. Items a mechanism retries or ends show as one muted line.
- All stages are built in order, each checked with screenshots of the real page and committed on its own. A visible choice that remains open is shown on the real page with screenshots, never as a mockup.
- Most wanted is a short table: the enemy and its zone, a tag for its state with the reasoning in the hover, and its drops with whom each is for and how much it adds. It leaves out targets whose drops another hunt already covers.
