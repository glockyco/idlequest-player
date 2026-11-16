// Checks the coin ledger (tools/lib/coin.mjs). Run with `bun test`.
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { COIN_SCHEMA, coinDays, coinEntries, recordCoin, recordPurse } from "../tools/lib/coin.mjs";

const T = new Date(2026, 10, 14, 12).getTime();
const e = (type: string, text: string, t = T) => ({ t, type, text });

test("the ledger reads each kind of coin line once, and nothing from lines that only mention coin", () => {
  const entries = coinEntries([
    e("LOOT", "You loot 5 platinum, 7 gold, 7 silver, 3 copper!"),
    e("LOOT", "You loot 6 silver, 7 copper."),
    e("LOOT", "You loot Gold lined heretic cloak!"),
    e("bot", "[bot] sold 7 surplus item(s) for 58019 copper (2 Russet Oxide, Crystallized Sulfur); 15 slots free"),
    e("SYSTEM", "You are charged 20pp for courier-based banking fees."),
    e("LOCAL_CHAT", "Banker Letharion says, 'The courier fee for this visit is 30 platinum, payable only if I bank something.'"),
    e("SYSTEM", "Raid time purchased: one hour for 10,000 platinum."),
    e("bot", "[bot] task raid: bought an hour of raid time for 10000pp"),
    e("bot", "[bot] note task: casino done; won a boss credit in 3 rolls for 1800pp, Tagujazolu holds credits for Lady Vox (1)"),
    e("bot", "[bot] casino: won a boss credit in 3 rolls for 1800pp"),
    // The upkeep's alert line comes with every purchase and is the one counted, its log line only sometimes.
    e("bot", "[bot] upkeep: spells: self: Bought and scribed 5 spell(s) for you for 550pp 0gp 0sp 0cp. | companions: Bought and scribed 3 spell(s) for your companions for 309pp 5gp 0sp 0cp., gem 1 Spirit Tap"),
    e("bot", "[bot] note upkeep: level or spells changed: spells: self: Bought and scribed 5 spell(s) for you for 550pp 0gp 0sp 0cp. | companions: Bought and scribed 3 spell(s) for your companions for 309pp 5gp 0sp 0cp., gem 1 Spirit Tap"),
    e("chore", "[chore] bought spells: self: No missing merchant spells for the current class and level. | companions: Bought and scribed 1 spell(s) for your companions for 145pp 0gp 0sp 0cp."),
    e("bot", "[bot] cursor item Plasmatic Priest Robe: sold: You sold 1 x Plasmatic Priest Robe for 12pp 5gp total."),
    e("SYSTEM", "You purchased Cloth Shirt for 5gp."),
    e("bot", "[bot] quest: Hargrimol gave 500 platinum to Dirkog Steelhand, which answered: Thank ye, laddie!"),
    e("bot", "[bot] quest: Hargrimol took Pivorandel's coin for a hand-in of 500 platinum"),
    e("SYSTEM", "Resurrected: recovered 963000 experience (90%). 200pp charged."),
    e("bot", "[bot] craft: Tinkering 148 after 281 attempts for about 2950 pp, carries 10 Rebreather"),
    e("bot", "[bot] craft: pulled Tagujazolu (4100pp)"),
    e("bot", "[bot] craft: sold 100 Powered Gloves for 3400 pp"),
  ]);
  const by = Object.fromEntries(entries.map((x) => [x.kind, Math.round(x.pp * 1000) / 1000]));
  expect(entries).toHaveLength(14);
  expect(by).toEqual({ loot: 0.067, sales: 3400, courier: -20, "raid time": -10000, casino: -1800, spells: -145, purchases: -0.5, "hand-ins": -500, resurrection: -200, crafts: -2950 });
  expect(entries.filter((x) => x.kind === "spells").map((x) => x.pp)).toEqual([-859.5, -145]);
  expect(entries.filter((x) => x.kind === "sales").map((x) => x.pp)).toEqual([58.019, 12.5, 3400]);
  expect(entries[0].pp).toBeCloseTo(5.773);
});

test("a day's ledger sums the groups' lines, and what the account's total changed beyond them is other", () => {
  const db = new Database(":memory:");
  db.run(COIN_SCHEMA);
  recordPurse(db, T - 86400000, 100000);
  recordCoin(db, coinEntries([e("bot", "[bot] sold 2 surplus item(s) for 30000000 copper (A, B); 9 slots free"), e("SYSTEM", "Raid time purchased: one hour for 10,000 platinum.")]), "G1");
  recordCoin(db, coinEntries([e("bot", "[bot] sold 1 surplus item(s) for 5000000 copper (C); 9 slots free")]), "G2");
  recordCoin(db, [{ t: T, kind: "AA ranks", pp: -2000 }], "G1");
  recordPurse(db, T + 3600000, 121000);
  const [day] = coinDays(db, 2, T + 7200000);
  expect(day.kinds).toEqual({ sales: { pp: 35000, n: 2 }, "raid time": { pp: -10000, n: 1 }, "AA ranks": { pp: -2000, n: 1 } });
  expect(day).toMatchObject({ income: 35000, spent: -12000, purse: 121000, change: 21000, other: -2000 });
});
