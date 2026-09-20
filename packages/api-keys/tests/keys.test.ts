// S10a — API keys estilo provider (wvr_...): issue una vez, verify, revoke.
// El secreto NUNCA se guarda en claro: solo su SHA-256.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { InMemoryApiKeys } from "../src/keys.ts";

describe("S10a api-keys", () => {
  it("issue → secreto wvr_ usable una sola vez visible", async () => {
    const k = new InMemoryApiKeys();
    const issued = await k.issue("jurado-demo");
    const { id, secret } = issued;
    assert.equal(issued.owner, "jurado-demo"); // el tipo promete KeyInfo: tiene que venir
    assert.ok(secret.startsWith("wvr_"));
    assert.deepEqual(await k.verify(secret), { id, owner: "jurado-demo" });
  });

  it("secreto trucho o con otro prefijo → null", async () => {
    const k = new InMemoryApiKeys();
    assert.equal(await k.verify("wvr_trucho"), null);
    assert.equal(await k.verify("sk-otro"), null);
    assert.equal(await k.verify(""), null);
  });

  it("revoke mata la key", async () => {
    const k = new InMemoryApiKeys();
    const { id, secret } = await k.issue("temp");
    assert.equal(await k.revoke(id), true);
    assert.equal(await k.verify(secret), null);
    assert.equal(await k.revoke("key_inexistente"), false);
  });

  it("list expone TODO MENOS secreto y hash", async () => {
    const k = new InMemoryApiKeys();
    const { id, secret } = await k.issue("a");
    const list = await k.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, id);
    const raw = JSON.stringify(list[0]);
    assert.ok(!raw.includes(secret.slice(4, 12)));
    assert.ok(!("hash" in (list[0] as Record<string, unknown>)));
    assert.ok(!("secret" in (list[0] as Record<string, unknown>)));
  });

  it("seed importa un secreto conocido (OPERATOR_KEY fija entre reinicios)", async () => {
    const k = new InMemoryApiKeys();
    const info = await k.seed("operator", "wvr_operador_fija_de_env");
    assert.equal(info.owner, "operator");
    assert.deepEqual(await k.verify("wvr_operador_fija_de_env"), { id: info.id, owner: "operator" });
  });
});
