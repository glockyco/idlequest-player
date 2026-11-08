// Runs fight jobs, one fresh process each, a few at a time. Results keep the order of the jobs.
// Fight processes run at the lowest priority, so the game tabs and the rest of the machine stay
// responsive while a sweep runs.
import { availableParallelism, setPriority } from "node:os";

const WORKER = new URL("./worker.mjs", import.meta.url).pathname;
// A quarter of the cores by default: game tabs share the machine with the simulator.
export const DEFAULT_JOBS = Math.max(1, Math.floor(availableParallelism() / 4));

async function runOne(payload) {
  const started = performance.now();
  const child = Bun.spawn([process.execPath, WORKER], { stdin: new Blob([payload]), stdout: "pipe", stderr: "pipe" });
  try {
    setPriority(child.pid, 19);
  } catch {
    // A process that already exited cannot be reprioritized, and its result is read below.
  }
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  let message;
  try {
    message = JSON.parse(out);
  } catch {
    throw new Error(`fight process exited with ${code} and no result${err ? `: ${err.trim().split("\n").slice(-3).join(" | ")}` : ""}`);
  }
  if (!message.ok) throw new Error(message.error);
  return { ...message.result, wallMs: Math.round(performance.now() - started) };
}

export async function runJobs(jobs, concurrency = DEFAULT_JOBS, onDone = () => {}) {
  const results = new Array(jobs.length);
  let next = 0;
  let done = 0;
  const lane = async () => {
    while (next < jobs.length) {
      const i = next++;
      results[i] = await runOne(JSON.stringify(jobs[i]));
      onDone(++done, jobs.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, lane));
  return results;
}
