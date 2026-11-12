// What a page's sampled call stacks (`Relay.stacks`: innermost frame first, each
// `{ fn, url, line, col }`) spend their time in: by the function a sample was in, and by every
// function on the stack, which names the loop a cost belongs to.

const label = (f) => `${f.fn} ${(f.url || "").split("/").pop().split("?")[0]}:${f.line + 1}:${f.col + 1}`;

/**
 * `{ samples, self, inclusive }` of the stacks: each list is `{ name, samples, share }`, most
 * samples first, at most `top` long. A function that recurses counts once a sample.
 */
export function summarize(stacks, { top = 25 } = {}) {
  const self = new Map();
  const inclusive = new Map();
  const add = (m, k) => m.set(k, (m.get(k) ?? 0) + 1);
  const taken = stacks.filter((s) => s.length);
  for (const s of taken) {
    add(self, label(s[0]));
    for (const name of new Set(s.map(label))) add(inclusive, name);
  }
  const rows = (m) => [...m].sort((a, b) => b[1] - a[1]).slice(0, top).map(([name, n]) => ({ name, samples: n, share: n / (taken.length || 1) }));
  return { samples: taken.length, self: rows(self), inclusive: rows(inclusive) };
}
