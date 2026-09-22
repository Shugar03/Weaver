import { SiteHeader } from "../../components/SiteHeader";
import { CodeBlock } from "../../components/CodeBlock";

const GATEWAY = "http://localhost:3001";

const CURL_CHAT = `curl ${GATEWAY}/v1/chat/completions \\
  -H "content-type: application/json" \\
  -d '{"model":"qwen3:4b","messages":[{"role":"user","content":"hola"}],"stream":true}'`;

const CURL_MODELS = `curl ${GATEWAY}/v1/models
# {"object":"list","data":[{"id":"qwen3:4b","object":"model","owned_by":"weaver"}]}`;

const PY_OPENAI = `from openai import OpenAI

# La key se crea en /account (wvr_…, se muestra una sola vez).
client = OpenAI(base_url="${GATEWAY}/v1", api_key="wvr_TU_API_KEY")
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
      "name": "Weaver",
      "package": "@opencode-ai/ai/providers/openai-compatible",
      "settings": { "baseURL": "${GATEWAY}/v1", "apiKey": "wvr_TU_API_KEY" },
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
      "apiKey": "wvr_TU_API_KEY",
      "models": [{ "id": "qwen3:4b", "name": "Qwen3 4B (Weaver)" }]
    }
  }
}
// apiKey real de /account — el consumo debita créditos de tu cuenta.`;

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
2. OpenAI API Key: tu wvr_… de /account
3. Override OpenAI Base URL: ${GATEWAY}/v1   (con /v1, SIN /chat/completions)
4. + Add Model: qwen3:4b
5. Verify

Límites honestos: Tab y Background Agents usan modelos de Cursor,
no tu endpoint. Si hay errores de conexión, probá HTTP/1.1
en Settings → Network → HTTP Compatibility Mode.`;

const KEYS_CURL = `# self-serve: creá tu cuenta y tu key en /account — sin pedirle nada a nadie.
# (el panel usa estas rutas debajo del capó)

# crear cuenta (una vez — el mgmt token se muestra UNA vez):
curl -X POST ${GATEWAY}/v1/accounts
# → {"accountId":"acct_...","mgmtToken":"wvr_acct_...","depositMemo":"..."}

# emitir key (con tu mgmt token):
curl -X POST ${GATEWAY}/v1/me/keys \\
  -H "Authorization: Bearer wvr_acct_..."
# → {"id":"key_...","secret":"wvr_..."}  (el secreto se muestra UNA vez)

# usar (billing por cuenta, debit medido post-stream):
curl ${GATEWAY}/v1/chat/completions \\
  -H "content-type: application/json" \\
  -H "Authorization: Bearer wvr_..." \\
  -d '{"model":"qwen3:4b","messages":[{"role":"user","content":"hola"}],"stream":true}'`;

export default function Developers() {
  return (
    <>
      <SiteHeader
        logoHref="/"
        links={[
          { label: "MODELS", href: "/models" },
          { label: "CHAT", href: "/chat" },
          { label: "CONSOLE", href: "/network" },
        ]}
        cta={{ label: "ACCOUNT", href: "/account" }}
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
            Cualquier cliente OpenAI anda. El billing es <span className="text-white">crédito prepago por cuenta</span>:
            creás una cuenta en <a href="/account" className="text-lima underline">/account</a>, fondeás con
            USDC (Stellar), emitís una key <span className="font-tech text-base text-white">wvr_…</span> y cada
            request debita tokens medidos post-stream.
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
            La key identifica <span className="text-white">quién</span> llama y a qué cuenta debita.
            Formato <span className="font-tech text-base text-white">wvr_…</span>, guardada hasheada,
            visible una sola vez al emitir. Se crea y revoca self-serve en{" "}
            <a href="/account" className="text-lima underline">/account</a>.
          </p>
          <CodeBlock title="keys" lang="bash" code={KEYS_CURL} />
        </section>

        <section className="mt-10 border border-lima/60 bg-panel p-5">
          <div className="font-tech text-lg tracking-[0.15em] text-lima">BILLING — CRÉDITOS PREPAGOS</div>
          <p className="mt-2 text-sm leading-relaxed text-fog">
            Tu cuenta tiene un balance en USDC (stroops). Fondeás mandando USDC a la deposit address con tu
            memo (todo visible en <span className="font-tech text-base text-white">/account → BILLING</span>).
            Al servir, el gateway debita <span className="text-white">prompt+completion tokens medidos</span> del
            stream real — nunca estimado si hay medición. Sin fondos: <span className="text-white">402</span> antes
            de tocar un forge. Request fallido: sin cargo. Precios públicos en{" "}
            <span className="font-tech text-base text-white">GET /v1/pricing</span>.
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
