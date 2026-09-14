import { ForgeConsole } from "../../components/forge/ForgeConsole";
import { readDeployment } from "../../lib/site";

export default async function ForgePage() {
  const base = process.env.WEAVER_GATEWAY ?? "http://localhost:3001";
  const ollama = process.env.WEAVER_OLLAMA ?? "http://localhost:11434";
  const deployment = await readDeployment();
  return <ForgeConsole base={base} ollama={ollama} deployment={deployment} />;
}
