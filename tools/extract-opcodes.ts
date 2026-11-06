// Extracts the opcode name -> number table from a prettified copy of the IdleQuest main bundle.
// Usage: bun tools/extract-opcodes.ts <main.pretty.js> <out.json>
const [src, out] = process.argv.slice(2);
const lines = (await Bun.file(src).text()).split("\n");
const nums = new Map<string, number>();
for (const line of lines) {
  const m = line.match(/^\s*(?:const |let |var )?([A-Za-z_$][\w$]*) = (\d+|1e3|1e4),?;?$/);
  if (m) nums.set(m[1], Number(m[2]));
}
const anchor = lines.findIndex((l) => /^\s*JWTLogin: /.test(l));
if (anchor < 0) throw new Error("opcode namespace object not found");
const table: Record<string, number> = {};
for (let i = anchor - 600; i < anchor + 600; i++) {
  const m = lines[i]?.match(/^\s*([A-Z][A-Za-z0-9_]*): ([A-Za-z_$][\w$]*),$/);
  if (m && nums.has(m[2])) table[m[1]] = nums.get(m[2])!;
}
await Bun.write(out, JSON.stringify(table, null, 1) + "\n");
console.log(`${Object.keys(table).length} opcodes`);
