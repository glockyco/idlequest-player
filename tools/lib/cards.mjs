// Item cards by item id: the name, icon and stats of the game's item window (`itemCard` in
// tools/lib/gear-plan.mjs). iqd stores the card of every item the dashboard names, and the dashboard
// shows each item it names from its card.

export const CARDS_SCHEMA = `CREATE TABLE IF NOT EXISTS item_cards (id INTEGER PRIMARY KEY, card TEXT NOT NULL);`;

/** Store `cards`, `{ [id]: card }`, over older cards of the same items. */
export function putCards(db, cards) {
  const put = db.query("INSERT INTO item_cards (id, card) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET card = excluded.card");
  db.transaction(() => {
    for (const [id, card] of Object.entries(cards)) put.run(Number(id), JSON.stringify(card));
  })();
}

const unique = (ids) => [...new Set([...ids].filter((id) => id != null).map(Number))];

// Rows of `select` for `ids`, in statements under SQLite's limit of 999 parameters.
function byIds(db, select, ids) {
  const want = unique(ids);
  const rows = [];
  for (let k = 0; k < want.length; k += 500) {
    const part = want.slice(k, k + 500);
    rows.push(...db.query(`${select} WHERE id IN (${part.map(() => "?").join(",")})`).all(...part));
  }
  return rows;
}

/** The stored cards of the items `ids` names, `{ [id]: card }`, leaving out items without one. */
export function cardsFor(db, ids) {
  return Object.fromEntries(byIds(db, "SELECT id, card FROM item_cards", ids).map((r) => [r.id, JSON.parse(r.card)]));
}

/** The items of `ids` without a stored card. */
export function missingCards(db, ids) {
  const have = new Set(byIds(db, "SELECT id FROM item_cards", ids).map((r) => r.id));
  return unique(ids).filter((id) => !have.has(id));
}
