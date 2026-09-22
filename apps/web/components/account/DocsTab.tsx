"use client";

// Integrate — snippets copy-paste reales (Working Memory: la key del usuario
// ya viene inyectada, no la escribe de memoria). Si no tiene keys, CTA a
// crear una primero. baseUrl ya es el del gateway — zero-config.
import { useEffect, useState } from "react";
import { listKeys, type KeyPublic } from "../../lib/account";
import { CodeBlock } from "../CodeBlock";

export function DocsTab({ base, token }: { base: string; token: string }) {
  const [key, setKey] = useState<string | null>(null);
  const [hasKeys, setHasKeys] = useState<boolean | null>(null);

  useEffect(() => {
    void listKeys(base, token)
      .then((ks: KeyPublic[]) => {
        const active = ks.find((k) => !k.revoked);
        // El secreto no se almacena: solo tenemos el id. Para snippets
        // usamos el placeholder + el id real no sirve como secret.
        // Honesto: el usuario pega el secret que guardó al crear la key.
        setHasKeys(ks.some((k) => !k.revoked));
        if (active) setKey(null);
      })
      .catch(() => setHasKeys(null));
  }, [base, token]);

  // El secret vive solo en el cliente del usuario — no podemos leerlo.
  // Placeholder claro con forma real de key.
  const k = key ?? "wvr_TU_API_KEY";

  const snippets: { title: string; lang: string; code: string }[] = [
    {
      title: "opencode",
      lang: "json",
      code: `{
  "provider": {
    "weaver": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Weaver",
      "options": {
        "baseURL": "${base}/v1",
        "apiKey": "${k}"
      },
      "models": {
        "qwen3-coder": { "name": "qwen3-coder" }
      }
    }
  }
}`,
    },
    {
      title: "pi agent",
      lang: "bash",
      code: `export OPENAI_BASE_URL=${base}/v1
export OPENAI_API_KEY=${k}
pi agent --model qwen3-coder`,
    },
    {
      title: "hermes / cualquier cliente OpenAI",
      lang: "python",
      code: `from openai import OpenAI

client = OpenAI(
    base_url="${base}/v1",
    api_key="${k}",
)

r = client.chat.completions.create(
    model="qwen3-coder",
    messages=[{"role": "user", "content": "hola"}],
    stream=True,
)
for chunk in r:
    print(chunk.choices[0].delta.content or "", end="")`,
    },
    {
      title: "curl",
      lang: "bash",
      code: `curl ${base}/v1/chat/completions \\
  -H "Authorization: Bearer ${k}" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"qwen3-coder","messages":[{"role":"user","content":"hola"}],"stream":true}'`,
    },
  ];

  return (
    <div className="space-y-4">
      <div className="border border-line bg-panel p-5">
        <div className="font-tech text-base tracking-[0.2em] text-fog">OPENAI-COMPATIBLE</div>
        <p className="mt-2 text-sm leading-relaxed text-fog">
          Weaver habla la API de OpenAI: cualquier cliente que acepte{" "}
          <span className="font-tech text-white">base_url</span> +{" "}
          <span className="font-tech text-white">api_key</span> funciona.
          base_url: <span className="font-tech text-base text-lima">{base}/v1</span>
        </p>
        <p className="mt-2 text-sm text-fog">
          {hasKeys === false
            ? "No tenés keys activas — creá una en API KEYS y pegá el secret acá:"
            : "Pegá tu key para inyectarla en los snippets (no se envía a ningún lado — solo reemplaza el texto acá):"}
        </p>
        <input
          value={key ?? ""}
          onChange={(e) => setKey(e.target.value)}
          placeholder="wvr_… (el secret que guardaste al crear la key)"
          spellCheck={false}
          autoComplete="off"
          className="mt-3 w-full border border-line bg-void px-3 py-2.5 font-tech text-base text-white outline-none placeholder:text-fog/50 focus:border-lima"
        />
      </div>

      {snippets.map((s) => (
        <CodeBlock key={s.title} title={s.title} lang={s.lang} code={s.code} />
      ))}
    </div>
  );
}
