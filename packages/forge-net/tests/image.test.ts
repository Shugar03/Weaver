// S40 — imageDims: validación estructural de resultados de imagen remotos.
import { test } from "node:test";
import assert from "node:assert/strict";
import { imageDims } from "../src/image.ts";

// PNG 2x3 mínimo: magic + IHDR(len13) con w=2,h=3
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from([0, 0, 0, 13]), // IHDR length
  Buffer.from("IHDR"),
  Buffer.from([0, 0, 0, 2, 0, 0, 0, 3, 8, 6, 0, 0, 0]),
]).toString("base64");

// JPEG 4x5 mínimo: SOI + APP0(len2) + SOF0(h=5,w=4)
const JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8]),
  Buffer.from([0xff, 0xe0, 0, 2]), // APP0 len=2 (válido mínimo)
  Buffer.from([0xff, 0xc0, 0, 11, 8, 0, 5, 0, 4, 3]), // SOF0: len11, prec8, h5, w4
]).toString("base64");

test("PNG → dims del IHDR", () => {
  assert.deepEqual(imageDims(PNG), { w: 2, h: 3 });
});

test("JPEG → dims del SOF0", () => {
  assert.deepEqual(imageDims(JPEG), { w: 4, h: 5 });
});

test("basura / vacío / texto plano → null", () => {
  assert.equal(imageDims(""), null);
  assert.equal(imageDims("aGVsbG8gd29ybGQ="), null); // "hello world"
  assert.equal(imageDims("!!!"), null);
});

test("PNG truncado (sin IHDR completo) → null", () => {
  assert.equal(imageDims(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]).toString("base64")), null);
});
