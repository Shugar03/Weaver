// Cliente SSE mínimo (dirección contraria al gateway que lo emite).
// Parte frames por \n\n y devuelve payloads de líneas data:.
export async function* sseDataPayloads(res: Response): AsyncGenerator<string> {
  if (!res.ok || !res.body) throw new Error(`bench: http ${res.status}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (value) buf += dec.decode(value, { stream: !done });
    for (;;) {
      const i = buf.indexOf("\n\n");
      if (i < 0) break;
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      for (const line of frame.split("\n")) {
        const t = line.trim();
        if (t.startsWith("data:")) yield t.slice(5).trim();
      }
    }
    if (done) return;
  }
}
