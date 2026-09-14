// pnpm --filter @weaver/benchmarks bench
// Gateway en :3001 + ollama arriba. Imprime tabla md y guarda json+md en results/.
import { mkdir, writeFile } from "node:fs/promises";
import { DirectTarget, GatewayTarget } from "./targets.ts";
import { runBench } from "./runner.ts";
import type { Summary } from "./types.ts";

const PROMPTS = [
  "Respondé en una línea: ¿qué es Weaver?",
  "Nombrá 3 planetas del sistema solar, en una línea.",
  "¿Cuánto es 17 por 24? Respondé solo el número.",
];

function table(ss: Summary[]): string {
  const head = "| target | n | ok | p50 TTFT ms | max total ms | chars |\n|---|---|---|---|---|---|";
  const rows = ss.map((s) => `| ${s.name} | ${s.n} | ${s.ok} | ${s.p50ttft} | ${s.maxtotal} | ${s.chars} |`);
  const gw = ss.find((s) => s.name === "weaver-gateway");
  const direct = ss.find((s) => s.name === "ollama-direct");
  const overhead =
    gw && direct && gw.p50ttft >= 0 && direct.p50ttft >= 0
      ? `\n\ndiferencia cruda p50 (gateway − directo): **${gw.p50ttft - direct.p50ttft} ms** — n=${PROMPTS.length}, NO concluyente como overhead (ver nota)`
      : "";
  return `${head}\n${rows.join("\n")}${overhead}`;
}

const gateway = process.env.WEAVER_GATEWAY ?? "http://localhost:3001";
const summaries = await runBench([new GatewayTarget(gateway), new DirectTarget()], PROMPTS);
const md = `# Bench Weaver ${new Date().toISOString()}\n\nPrompts: ${PROMPTS.length} cortos, modelo qwen3:4b, n=${PROMPTS.length} por target.\n\n${table(summaries)}\n`;
console.log(md);

const dir = new URL("../results/", import.meta.url);
await mkdir(dir, { recursive: true });
const stamp = Date.now();
await writeFile(new URL(`bench-${stamp}.md`, dir), md);
await writeFile(new URL(`bench-${stamp}.json`, dir), JSON.stringify({ prompts: PROMPTS, summaries }, null, 2));
console.log(`guardado en packages/benchmarks/results/bench-${stamp}.*`);
