// Proof binding — MIRROR de packages/forge-exec/src/proofhash.ts (WebCrypto).
// El vector canónico está pinneado en tests de ambos lados: si drifta, falla.
//   promptHash = sha256(JSON.stringify({ model, messages }))
//   commitment = sha256(promptHash ‖ outputHash)  (bytes crudos)
export type CanonicalMessage = { role: string; content: string; tool_calls?: unknown; name?: string };

const sha256hex = async (data: string | Uint8Array) => {
  const buf = await crypto.subtle.digest("SHA-256", typeof data === "string" ? new TextEncoder().encode(data) : (data as BufferSource));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

export function promptHashInput(input: { model: string; prompt?: string; messages?: CanonicalMessage[] }): Promise<string> {
  const messages = input.messages ?? [{ role: "user", content: input.prompt ?? "" }];
  return sha256hex(JSON.stringify({ model: input.model, messages }));
}

const hexToBytes = (hex: string) => new Uint8Array(hex.match(/../g)!.map((b) => parseInt(b, 16)));

export async function commitProof(promptHashHex: string, outputHashHex: string): Promise<string> {
  const cat = new Uint8Array([...hexToBytes(promptHashHex), ...hexToBytes(outputHashHex)]);
  return sha256hex(cat);
}

export { sha256hex };
