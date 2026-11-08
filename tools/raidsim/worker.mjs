// A fight process: reads one job as JSON on stdin, runs it on a fresh client and writes the result
// as JSON on stdout. A fresh process per fight keeps fights independent, because the client holds
// its combat state in module-level stores and a second fight in the same process would start from
// the first one's leftovers.
const input = await Bun.stdin.text();
const write = (message) => process.stdout.write(JSON.stringify(message));

// The client logs to the console all the time ("[IdleQuest] Build", raid lifecycle warnings).
for (const level of ["log", "info", "warn", "debug"]) console[level] = () => {};

try {
  const { runJob } = await import("./fight.mjs");
  write({ ok: true, result: await runJob(JSON.parse(input)) });
} catch (error) {
  write({ ok: false, error: String(error?.stack ?? error) });
}
process.exit(0);
