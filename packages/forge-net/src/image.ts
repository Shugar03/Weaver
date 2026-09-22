// S40 — validación de resultados de imagen remotos.
// El contenido no es determinista (no hay hash que comparar) — lo verificable
// honestamente: que el b64 decodifique a una imagen real con dimensiones.
// PNG: magic + IHDR (w,h en offset 16). JPEG: SOI + SOF0/2 (h,w en el frame).

export function imageDims(b64: string): { w: number; h: number } | null {
  let buf: Buffer;
  try {
    buf = Buffer.from(b64, "base64");
  } catch {
    return null;
  }
  if (buf.length < 10) return null;
  // PNG: 89 50 4E 47 0D 0A 1A 0A + IHDR
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    if (buf.length < 24 || buf.toString("ascii", 12, 16) !== "IHDR") return null;
    const w = buf.readUInt32BE(16);
    const h = buf.readUInt32BE(20);
    return w > 0 && h > 0 ? { w, h } : null;
  }
  // JPEG: FF D8 … segments hasta SOF0 (FFC0) / SOF2 (FFC2)
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = buf[i + 1];
      if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
        const h = buf.readUInt16BE(i + 5);
        const w = buf.readUInt16BE(i + 7);
        return w > 0 && h > 0 ? { w, h } : null;
      }
      if (marker === 0xd9 || marker === 0xda) break; // EOI / SOS: sin SOF
      const len = buf.readUInt16BE(i + 2);
      if (len < 2) break;
      i += 2 + len;
    }
    return null;
  }
  // WebP: RIFF....WEBP — VP8/VP8L/VP8X difieren; validamos el contenedor.
  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
    // VP8X: canvas w-1/h-1 little-endian en bytes 24-29
    if (buf.toString("ascii", 12, 16) === "VP8X" && buf.length >= 30) {
      const w = 1 + buf.readUIntLE(24, 3);
      const h = 1 + buf.readUIntLE(27, 3);
      return { w, h };
    }
    return null; // VP8/VP8L sin parsear — formato válido pero sin dims
  }
  return null;
}
