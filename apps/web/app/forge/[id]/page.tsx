import { ForgeConsole } from "../../../components/forge/ForgeConsole";
import { readDeployment } from "../../../lib/deployment";
import type { ForgeView } from "../../../lib/weaver";

const GATEWAY = process.env.WEAVER_GATEWAY ?? "http://localhost:3001";
const OLLAMA = process.env.WEAVER_OLLAMA ?? "http://localhost:11434";

export default async function ForgePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [forges, deployment] = await Promise.all([
    fetch(`${GATEWAY}/v1/forges`, { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<ForgeView[]>) : null))
      .catch(() => null),
    readDeployment(),
  ]);
  const forge = forges?.find((f) => f.forgeId === id) ?? null;
  return <ForgeConsole base={GATEWAY} ollama={OLLAMA} deployment={deployment} forgeId={id} initialForge={forge} />;
}
