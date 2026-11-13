// Reads of the run logs (runs/live/<leader>/samples.jsonl and events.jsonl): one JSON object a
// line, appended in the order of their time `t`. A leader's two logs held 400 to 500 MB after six
// days of play on 2026-11-12, and the reports ask for their last hours. Read whole and parsed, they
// took a process one to two gigabytes, for each of the twelve groups in turn and for several
// reports at a time, on a machine whose swap was nearly full that day. So a reader finds where
// its window starts and reads from there.
import { closeSync, fstatSync, openSync, readSync } from "node:fs";

const CHUNK = 1 << 16;
// Lines of different sources can lie a little out of order, so the search stops this far ahead of
// the time asked for.
const SLACK_MS = 60000;

/** `t` of the first whole line that starts after byte `pos`, or null when none does or it has none. */
function timeAfter(fd, size, pos) {
  for (let len = CHUNK; ; len *= 4) {
    const buf = Buffer.alloc(Math.min(len, size - pos));
    const n = readSync(fd, buf, 0, buf.length, pos);
    const text = buf.toString("utf8", 0, n);
    const whole = pos + n >= size;
    const from = pos === 0 ? 0 : text.indexOf("\n") + 1;
    if (pos > 0 && from === 0) {
      if (whole) return null;
      continue;
    }
    const to = text.indexOf("\n", from);
    if (to < 0 && !whole) continue;
    try {
      return JSON.parse(text.slice(from, to < 0 ? undefined : to)).t ?? null;
    } catch {
      return null;
    }
  }
}

const readFrom = (fd, size, pos) => {
  const buf = Buffer.alloc(size - pos);
  for (let got = 0; got < buf.length; ) {
    const n = readSync(fd, buf, got, buf.length - got, pos + got);
    if (!n) return buf.toString("utf8", 0, got);
    got += n;
  }
  return buf.toString("utf8");
};

/**
 * The rows of the JSONL file `path` with `t >= since`, in the file's order, found by a search over
 * the file's bytes and read from there to the end, not from the start. A file that does not exist
 * throws as a read does.
 */
export function readJsonlSince(path, since) {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    let lo = 0;
    let hi = size;
    while (hi - lo > CHUNK) {
      const mid = lo + Math.floor((hi - lo) / 2);
      const t = timeAfter(fd, size, mid);
      if (t == null || t >= since - SLACK_MS) hi = mid;
      else lo = mid;
    }
    const text = readFrom(fd, size, lo);
    const rows = [];
    for (const line of (lo > 0 ? text.slice(text.indexOf("\n") + 1) : text).split("\n")) {
      if (!line) continue;
      try {
        const row = JSON.parse(line);
        if (row.t >= since) rows.push(row);
      } catch {
        /* an interrupted append can leave a cut or glued line */
      }
    }
    return rows;
  } finally {
    closeSync(fd);
  }
}

/** The last parseable row of the JSONL file `path`, or null when none exists. */
export function lastJsonl(path) {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    for (let len = CHUNK; ; len *= 4) {
      const pos = Math.max(0, size - len);
      const lines = readFrom(fd, size, pos).split("\n");
      // The first line of a chunk that starts inside the file may be cut.
      for (let k = lines.length - 1; k >= (pos > 0 ? 1 : 0); k--) {
        if (!lines[k]) continue;
        try {
          return JSON.parse(lines[k]);
        } catch {
          /* keep looking before an interrupted append */
        }
      }
      if (pos === 0) return null;
    }
  } finally {
    closeSync(fd);
  }
}
