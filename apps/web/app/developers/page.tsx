import { SiteHeader } from "../../components/SiteHeader";
import { CodeBlock } from "../../components/CodeBlock";

const GATEWAY = "http://localhost:3001";

const CURL_CHAT = `curl ${GATEWAY}/v1/chat/completions \\
  -H "content-type: application/json" \\
  -d '{"model":"qwen3:4b","messages":[{"role":"user","content":"hola"}],"stream":true}'`;

const CURL_MODELS = `curl ${GATEWAY}/v1/models
# {"object":"list","data":[{"id":"qwen3:4b","object":"model","owned_by":"weaver"}]}`;

const PY_OPENAI = `from openai import OpenAI

client = OpenAI(base_url="${GATEWAY}/v1", api_key="weaver")
stream = client.chat.completions.create(
    model="qwen3:4b",
    messages=[{"role": "user", "content": "hola"}],
    stream=True,
)
for chunk in stream:
    print(chunk.choices[0].delta.content or "", end="")`;

// opencode v2 (docs actuales). En v1 la forma es provider/npm/options.
const OPENCODE = `// opencode.jsonc — Weaver como provider custom (docs: opencode.ai, v2)
{
  "$schema": "https://opencode.ai/config.json",
  "providers": {
    "weaver": {
      "name": "Weaver (local)",
      "package": "@opencode-ai/ai/providers/openai-compatible",
      "settings": { "baseURL": "${GATEWAY}/v1" },
      "models": {
        "qwen3:4b": { "name": "Qwen3 4B (Weaver)" }
      }
    }
  }
}
// El id del modelo debe coincidir con GET /v1/models.
// En opencode v1: "provider" + "npm" + "options" en vez de
// "providers" + "package" + "settings".`;

const PI_AGENT = `// ~/.pi/agent/models.json — Weaver en pi (docs: pi.dev)
{
  "providers": {
    "weaver": {
      "baseUrl": "${GATEWAY}/v1",
      "api": "openai-completions",
      "apiKey": "weaver",
      "models": [{ "id": "qwen3:4b", "name": "Qwen3 4B (Weaver)" }]
    }
  }
}
// apiKey es dummy pero obligatorio: sin auth pi no lista el modelo en /model.`;

const HERMES_QUICK = `# camino rápido (wizard recomendado por sus docs)
hermes model
# → "Custom endpoint" → base URL: ${GATEWAY}/v1
# → API key: wvr_TU_KEY → model: qwen3:4b

# o manual en ~/.hermes/config.yaml:
#   model: qwen3:4b
#   provider: custom
#   base_url: ${GATEWAY}/v1
#   api_key: wvr_TU_KEY

# auto-detect: /model custom lee GET /v1/models y,
# como Weaver expone un solo ID, elige qwen3:4b solo.`;

const HERMES_PLUGIN = `# camino first-class: provider plugin (docs: hermes-agent.nousresearch.com)
# $HERMES_HOME/plugins/model-providers/weaver/__init__.py
from providers import register_provider
from providers.base import ProviderProfile

register_provider(ProviderProfile(
    name="weaver",
    aliases=("weaver-local",),
    display_name="Weaver",
    description="Weaver — OpenAI-compatible routed compute",
    signup_url="https://github.com/Shugar03/Weaver",
    env_vars=("WEAVER_API_KEY", "WEAVER_BASE_URL"),
    base_url="${GATEWAY}/v1",
    auth_type="api_key",
    fallback_models=("qwen3:4b",),
))

# $HERMES_HOME/plugins/model-providers/weaver/plugin.yaml
# name: weaver
# kind: model-provider
# version: 1.0.0
# description: Weaver — OpenAI-compatible routed compute
# → aparece en el picker, --provider, y hermes doctor lo chequea
# contra {base_url}/models (nuestro endpoint lo sirve).`;

const CURSOR_STEPS = `1. Cursor Settings (Cmd+Shift+J) → Models
2. OpenAI API Key: cualquier texto no vacío (ej. "weaver")
3. Override OpenAI Base URL: ${GATEWAY}/v1   (con /v1, SIN /chat/completions)
4. + Add Model: qwen3:4b
5. Verify

Límites honestos: Tab y Background Agents usan modelos de Cursor,
no tu endpoint. Si hay errores de conexión, probá HTTP/1.1
en Settings → Network → HTTP Compatibility Mode.`;

const KEYS_CURL = `# emitir (solo operador con acceso al gateway)
curl -X POST ${GATEWAY}/v1/admin/keys \\
  -H "content-type: application/json" \\
  -d '{"owner":"jurado-demo"}'
# → {"id":"key_...","secret":"wvr_..."}  (el secreto se muestra UNA vez)

# usar (identifica y mete en allowlist del paywall):
curl ${GATEWAY}/v1/jobs \\
  -H "content-type: application/json" \\
  -H "Authorization: Bearer wvr_..." \\
  -d '{"model":"qwen3:4b"}'

# revocar:
curl -X POST ${GATEWAY}/v1/admin/keys/key_.../revoke`;

export default function Developers() {
  return (
    <>
      <SiteHeader
        logoHref="/"
        links={[
          { label: "CHAT", href: "/chat" },
          { label: "CONSOLE", href: "/dashboard" },
          { label: "DOCS", href: "https://github.com/Shugar03/Weaver" },
        ]}
        cta={{ label: "RUN LIVE DEMO →", href: "/dashboard" }}
      />
      <main className="mx-auto max-w-5xl px-4 pb-16 md:px-6">
        <section className="pt-10">
          <div className="font-tech text-lg tracking-[0.2em] text-fog">
            <span className="text-lima">{"//"}</span> DEVELOPERS
          </div>
          <h1 className="mt-4 text-4xl leading-[1.02] font-bold tracking-tight md:text-6xl">
            Build on Weaver<span className="text-lima">.</span>
          </h1>
          <p className="mt-4 max-w-[62ch] text-sm leading-relaxed text-fog">
            El gateway habla OpenAI-compatible: <span className="text-white">chat completions + models</span>.
            Cualquier cliente OpenAI anda. En dev local está abierto; en testnet cobra $0.01 por request vía
            x402 (header <span className="font-tech text-base text-white">x-payment</span>).
          </p>
        </section>

        <section className="pt-10">
          <div className="font-tech text-lg tracking-[0.2em] text-fog">
            <span className="text-lima">01</span> {"//"} ENDPOINTS
          </div>
          <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-3">
            {[
              ["POST", "/v1/chat/completions", "stream SSE OpenAI"],
              ["GET", "/v1/models", "lista para discovery"],
              ["GET", "/v1/forges", "fleet HOT/COLD + ETR"],
            ].map(([m, p, d]) => (
              <div key={p} className="border border-line bg-panel p-4">
                <div className="font-tech text-lg">
                  <span className="text-lima">{m}</span> <span className="text-white">{p}</span>
                </div>
                <div className="mt-1 font-tech text-base text-fog">{d}</div>
              </div>
            ))}
          </div>
        </section>

        <section className="space-y-6 pt-10">
          <div className="font-tech text-lg tracking-[0.2em] text-fog">
            <span className="text-lima">02</span> {"//"} CONECTÁ TU AGENTE
          </div>
          <CodeBlock title="opencode" lang="jsonc" code={OPENCODE} />
          <CodeBlock title="pi agent" lang="json" code={PI_AGENT} />
          <CodeBlock title="hermes agent" lang="terminal" code={HERMES_QUICK} />
          <CodeBlock title="hermes plugin" lang="python" code={HERMES_PLUGIN} />
          <CodeBlock title="Cursor" lang="pasos" code={CURSOR_STEPS} />
          <CodeBlock title="curl" lang="bash" code={`${CURL_MODELS}\n\n${CURL_CHAT}`} />
          <CodeBlock title="python (openai lib)" lang="python" code={PY_OPENAI} />
        </section>

        <section className="space-y-6 pt-10">
          <div className="font-tech text-lg tracking-[0.2em] text-fog">
            <span className="text-lima">03</span> {"//"} API KEYS
          </div>
          <p className="-mt-2 max-w-[62ch] text-sm leading-relaxed text-fog">
            La key identifica <span className="text-white">quién</span> llama (metering, allowlist, revoke).
            El cobro va por x402. Formato <span className="font-tech text-base text-white">wvr_…</span>, guardada
            hasheada, visible una sola vez al emitir.
          </p>
          <CodeBlock title="keys" lang="bash" code={KEYS_CURL} />
        </section>

        <section className="mt-10 border border-lima/60 bg-panel p-5">
          <div className="font-tech text-lg tracking-[0.15em] text-lima">PAGOS x402 (SOLO TESTNET)</div>
          <p className="mt-2 text-sm leading-relaxed text-fog">
            Contra el gateway con paywall, cada request sin pago devuelve <span className="text-white">402</span> con
            los requisitos (<span className="font-tech text-base text-white">exact / stellar:testnet / $0.01</span>).
            Firmás el transfer USDC, lo mandás en el header <span className="font-tech text-base text-white">x-payment</span> y
            el facilitador verifica. En local, todo abierto.
          </p>
        </section>
      </main>
      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-5xl flex-col gap-2 px-4 py-6 font-tech text-base tracking-[0.15em] text-fog md:flex-row md:items-center md:justify-between md:px-6">
          <span className="font-bold tracking-[0.3em] text-white">WEAVER</span>
          <span>OPEN COMPUTE. HIGHER INTELLIGENCE.</span>
          <span>EST. 2024</span>
        </div>
      </footer>
    </>
  );
}
