// Proof binding — el commitment que firma el forge.
// resultHash on-chain = sha256(promptHash ‖ outputHash): la firma ata el
// output servido AL INPUT DESPACHADO, no solo a un texto cualquiera. Un forge
// que responde otra cosa, o que dice "me pidieron X" cuando le llegó Y,
// produce un commitment distinto — verificable on-chain en release y
// client-side en el ProofChip.
//
// Canónico (misma regla en daemon, proven y web — los tests pinnean el vector):
//   promptHash = sha256(JSON.stringify({ model, messages }))
//   messages  = el array OpenAI si vino; si no, [{ role:"user", content: prompt }]
//   outputHash = sha256(concatenación de chunks kind !== "think")
//   commitment = sha256(promptHash ‖ outputHash)  (bytes crudos concatenados)
import { createHash } from "node:crypto";

export type CanonicalMessage = { role: string; content: string; tool_calls?: unknown; name?: string };

export function promptHashOf(input: { model: string; prompt: string; messages?: CanonicalMessage[] }): Buffer {
  const messages = input.messages ?? [{ role: "user", content: input.prompt }];
  return createHash("sha256").update(JSON.stringify({ model: input.model, messages }), "utf8").digest();
}

export function commitProof(promptHash: Buffer, outputHash: Buffer): Buffer {
  return createHash("sha256").update(Buffer.concat([promptHash, outputHash])).digest();
}
