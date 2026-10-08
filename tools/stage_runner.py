#!/usr/bin/env python3
# S47 fase C — stage-runner con pesos REALES (substrate de verdad).
# Un proceso = un tramo contiguo de capas [k..n) de un checkpoint HF, con KV
# cache por sesión, hablando stageproto JSON-lines por TCP — el MISMO wire que
# stageserver.ts/simStageCompute. El coordinator (PipelineExec TS) no nota la
# diferencia: activaciones f16 b64 entran, activaciones f16 b64 salen.
#
# Modos:
#   --role stage  → capas k..n con KV server-side (el trabajo distribuido real)
#   --role edge   → embed_tokens + norm + lm_head + tokenizer (el "cliente" de
#                   Petals: la única pieza además del usuario que ve plaintext;
#                   el gateway lo corre en el coordinator — trust-anchor)
#
# La firma al close ata sha256(jobId:sessionId:chain) — chain idéntico al que
# el coordinator recomputa con stageChainInit/Step en TS (ver stageproto.ts).
# --sign-seed toma el seed Stellar del daemon (S...) → el G... derivado matchea
# forgePubkey del heartbeat → dualVerify del gateway verifica sin cambios.
import argparse, asyncio, base64, hashlib, hmac, json, os, struct, sys, time
from typing import Optional

import numpy as np
import torch


# ---------- chain (idéntico a stageproto.ts — las dos partes computan lo mismo)
def chain_init(session_id: str, blocks: list[int]) -> str:
    return hashlib.sha256(f"{session_id}:{blocks[0]}-{blocks[1]}".encode()).hexdigest()


def chain_step(chain: str, seq: int, in_b64: str, out_b64: str) -> str:
    return hashlib.sha256(f"{chain}:{seq}:{in_b64}:{out_b64}".encode()).hexdigest()


def sig_preimage(job_id: str, session_id: str, chain: str) -> bytes:
    return hashlib.sha256(f"{job_id}:{session_id}:{chain}".encode()).digest()


# ---------- capability token (B1 WAN auth — idéntico a stageToken en TS)
# HMAC(secret, "jobId|coordPubkey") — el daemon del worker lo mintea ante
# stage.grant del gateway; el runner lo verifica con el MISMO secret local.
def token_ok(secret: str, job_id: str, coord_pk: str, token: str) -> bool:
    want = hmac.new(secret.encode(), f"{job_id}|{coord_pk}".encode(), hashlib.sha256).hexdigest()
    return hmac.compare_digest(want, token)


# ---------- strkey Stellar → seed ed25519 (S...) — base32 + crc16-xmodem
def _crc16(data: bytes) -> int:
    crc = 0
    for b in data:
        crc ^= b << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) & 0xFFFF if crc & 0x8000 else (crc << 1) & 0xFFFF
    return crc


def seed_from_stellar(strkey: str) -> bytes:
    raw = base64.b32decode(strkey.upper())
    if len(raw) != 35 or raw[0] != 18 << 3:  # version byte S = 144
        raise ValueError("no es un seed Stellar (S...)")
    payload, crc = raw[1:33], struct.unpack("<H", raw[33:])[0]
    if _crc16(raw[:33]) != crc:
        raise ValueError("strkey crc inválido")
    return payload


def sign_hex(preimage: bytes, seed: bytes) -> str:
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
    sk = Ed25519PrivateKey.from_private_bytes(seed)
    return sk.sign(preimage).hex()


# ---------- modelo: slice contiguo de capas con KV por sesión
class StageModel:
    """Capas k..n de un decoder HF. Cada sesión = un DynamicCache propio —
    el stage NO ve tokens ni prompts, solo hidden states (privacidad del
    pipeline: plaintext nunca cruza la frontera coordinator→stage)."""

    def __init__(self, model_id: str, k: int, n: int, dtype=torch.float32):
        from transformers import AutoModelForCausalLM
        from transformers.cache_utils import DynamicCache

        full = AutoModelForCausalLM.from_pretrained(model_id, dtype=dtype)
        full.eval()
        core = full.model  # decoder base (embed + layers + rotary + norm)
        self.layers = [core.layers[i] for i in range(k, n)]
        for i, layer in enumerate(self.layers):  # layer_idx global → slot de KV correcto
            layer.self_attn.layer_idx = k + i
        self.rotary = core.rotary_emb
        self.d = core.config.hidden_size
        self.k, self.n = k, n
        self.torch_dtype = dtype
        self._cache_cls = DynamicCache
        del full  # el resto de los pesos no queda residente en el stage

    def new_cache(self):
        return self._cache_cls()

    @torch.no_grad()
    def forward(self, cache, hidden: torch.Tensor, pos0: int) -> torch.Tensor:
        """hidden [S,d] → capas k..n → [S,d]. El cache acumula KV por sesión;
        pos0 = posición absoluta del primer token del chunk (offset acumulado)."""
        s = hidden.shape[0]
        hidden = hidden.unsqueeze(0)  # [1,S,d]
        position_ids = torch.arange(pos0, pos0 + s).unsqueeze(0)
        cos, sin = self.rotary(hidden, position_ids)
        mask = torch.full((s, s), torch.finfo(hidden.dtype).min, dtype=hidden.dtype)
        mask = torch.triu(mask, diagonal=1)  # causal
        if pos0 > 0:  # attend al pasado del KV además del chunk causal
            mask = torch.cat([torch.zeros(s, pos0, dtype=hidden.dtype), mask], dim=1)
        mask = mask[None, None, :, :]  # [1,1,S,past+S]
        for layer in self.layers:
            out = layer(hidden, attention_mask=mask, position_ids=position_ids,
                        past_key_values=cache, use_cache=True, position_embeddings=(cos, sin))
            hidden = out[0] if isinstance(out, tuple) else out
        return hidden.squeeze(0)


class EdgeModel:
    """embed + norm + lm_head + tokenizer — la punta local del coordinator.
    Stateless: embed(text)→hidden; next(hidden)→(token, done, embed_del_token).
    Sampling greedy (argmax) — determinista y testeable en e2e."""

    def __init__(self, model_id: str, dtype=torch.float32):
        from transformers import AutoModelForCausalLM, AutoTokenizer

        self.tok = AutoTokenizer.from_pretrained(model_id)
        full = AutoModelForCausalLM.from_pretrained(model_id, dtype=dtype)
        full.eval()
        core = full.model
        self.embed_tokens = core.embed_tokens
        self.norm = core.norm
        self.lm_head = full.lm_head
        self.eos_id = self.tok.eos_token_id
        self.d = core.config.hidden_size
        del core.layers, full  # el edge NO guarda capas — solo las puntas

    def embed_text(self, text: str) -> np.ndarray:
        ids = self.tok(text, return_tensors="pt").input_ids
        with torch.no_grad():
            h = self.embed_tokens(ids)  # [1,S,d]
        return h[0].numpy().astype(np.float16)

    @torch.no_grad()
    def next_token(self, hidden: np.ndarray) -> dict:
        h = torch.from_numpy(hidden.astype(np.float32))[-1:]  # última posición [1,d]
        logits = self.lm_head(self.norm(h))[0]  # [vocab]
        tid = int(logits.argmax())
        emb = self.embed_tokens(torch.tensor([[tid]]))[0]  # [1,d] — el pipeline la reenvía como step
        return {"token": self.tok.decode([tid]), "done": tid == self.eos_id,
                "embed": emb.numpy().astype(np.float16)}


# ---------- wire stageproto (JSON-lines, espejo de stageproto.ts)
def b64_to_hidden(payload: str, shape: list[int]) -> np.ndarray:
    arr = np.frombuffer(base64.b64decode(payload), dtype=np.float16)
    return arr.reshape(shape).astype(np.float32)


def hidden_to_b64(hidden) -> str:
    if isinstance(hidden, torch.Tensor):
        hidden = hidden.numpy()
    return base64.b64encode(hidden.astype(np.float16).tobytes()).decode()


class StageServer:
    def __init__(self, model: StageModel, sign_seed: Optional[bytes], tag: str, secret: Optional[str] = None):
        self.model = model
        self.sign_seed = sign_seed
        self.tag = tag
        self.secret = secret  # B1: seteado → open sin capability válida = fail
        self.sessions = {}  # sessionId → {cache, pos, chain, jobId, blocks}
        self.seen = []      # seqs recibidos — evidencia de replay para tests

    async def handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        owned = []
        try:
            async for line in reader:
                try:
                    msg = json.loads(line)
                except json.JSONDecodeError:
                    continue
                t = msg.get("type")
                try:
                    if t == "stage.open":
                        sid = msg["sessionId"]
                        k, n = msg["blocks"]
                        # B1: capability ANTES de reservar KV — un cliente de
                        # Internet sin token no abre sesión ni inyecta nada.
                        if self.secret and not token_ok(
                            self.secret, msg.get("jobId", ""), msg.get("coordPubkey", ""), msg.get("token", "")
                        ):
                            raise ValueError("stage.open sin capability válida")
                        if k < self.model.k or n > self.model.n:
                            raise ValueError(f"blocks [{k},{n}] fuera de mi rango [{self.model.k},{self.model.n}]")
                        self.sessions[sid] = {
                            "cache": self.model.new_cache(), "pos": 0,
                            "chain": chain_init(sid, [k, n]), "jobId": msg["jobId"], "blocks": [k, n],
                        }
                        owned.append(sid)
                        await self._send(writer, {"type": "stage.ack", "sessionId": sid})
                    elif t == "stage.step":
                        sid, seq = msg["sessionId"], msg["seq"]
                        s = self.sessions.get(sid)
                        if s is None:
                            raise ValueError("sin sesión — open primero")
                        self.seen.append({"sessionId": sid, "seq": seq})
                        hidden = b64_to_hidden(msg["payload"], msg["shape"])
                        t0 = time.monotonic()
                        out = self.model.forward(s["cache"], torch.from_numpy(hidden), s["pos"])
                        s["pos"] += hidden.shape[0]
                        out_b64 = hidden_to_b64(out)
                        s["chain"] = chain_step(s["chain"], seq, msg["payload"], out_b64)
                        ms = (time.monotonic() - t0) * 1000
                        await self._send(writer, {"type": "stage.out", "sessionId": sid, "seq": seq,
                                                  "shape": list(out.shape), "dtype": "f16",
                                                  "payload": out_b64, "ms": round(ms, 1)})
                    elif t == "stage.close":
                        sid = msg["sessionId"]
                        s = self.sessions.pop(sid, None)
                        if sid in owned:
                            owned.remove(sid)
                        ack = {"type": "stage.ack", "sessionId": sid}
                        if s and self.sign_seed:
                            ack["sig"] = sign_hex(sig_preimage(s["jobId"], sid, s["chain"]), self.sign_seed)
                        await self._send(writer, ack)
                except Exception as e:
                    await self._send(writer, {"type": "stage.fail", "sessionId": msg.get("sessionId", ""),
                                              "seq": msg.get("seq"), "error": str(e)})
        finally:
            for sid in owned:  # socket muerto → KV liberado (ZDR de sesiones)
                self.sessions.pop(sid, None)
            writer.close()

    @staticmethod
    async def _send(writer, obj):
        writer.write(json.dumps(obj).encode() + b"\n")
        await writer.drain()


async def edge_http(model: EdgeModel, port: int):
    """Edge stateless por HTTP minimalista (sin deps): /embed y /next."""
    async def handle(reader, writer):
        req = await reader.read(65536)
        try:
            body = req.split(b"\r\n\r\n", 1)[1]
            path = req.split(b" ", 2)[1].decode()
            data = json.loads(body or b"{}")
            if path == "/embed":
                h = model.embed_text(data["prompt"])
                out = {"shape": list(h.shape), "payload": hidden_to_b64(h)}
            elif path == "/next":
                h = b64_to_hidden(data["payload"], data["shape"])
                r = model.next_token(h)
                out = {"token": r["token"], "done": r["done"],
                       "embed": {"shape": list(r["embed"].shape), "payload": hidden_to_b64(r["embed"])}}
            else:
                raise ValueError("ruta desconocida")
            resp = json.dumps(out).encode()
            writer.write(b"HTTP/1.1 200 OK\r\ncontent-length: " + str(len(resp)).encode() + b"\r\n\r\n" + resp)
        except Exception as e:
            resp = json.dumps({"error": str(e)}).encode()
            writer.write(b"HTTP/1.1 500\r\ncontent-length: " + str(len(resp)).encode() + b"\r\n\r\n" + resp)
        await writer.drain()
        writer.close()
    srv = await asyncio.start_server(handle, "127.0.0.1", port)
    print(f"edge listo :{port} d={model.d}", flush=True)
    await srv.serve_forever()


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--role", choices=["stage", "edge"], default="stage")
    ap.add_argument("--model", default="Qwen/Qwen2.5-0.5B")
    ap.add_argument("--blocks", nargs=2, type=int, default=[0, 12])
    ap.add_argument("--port", type=int, required=True)
    ap.add_argument("--sign-seed", default=os.environ.get("STAGE_SIGN_SEED"))
    ap.add_argument("--stage-secret", default=os.environ.get("WEAVER_STAGE_SECRET"))
    ap.add_argument("--tag", default="stage")
    args = ap.parse_args()

    torch.set_num_threads(max(1, os.cpu_count() // 2))
    if args.role == "edge":
        await edge_http(EdgeModel(args.model), args.port)
        return

    seed = seed_from_stellar(args.sign_seed) if args.sign_seed else None
    model = StageModel(args.model, args.blocks[0], args.blocks[1])
    srv_state = StageServer(model, seed, args.tag, secret=args.stage_secret)
    srv = await asyncio.start_server(srv_state.handle, "0.0.0.0", args.port)
    print(f"stage {args.tag} listo :{args.port} blocks=[{args.blocks[0]},{args.blocks[1]}) d={model.d}"
          f"{' auth' if args.stage_secret else ''}", flush=True)
    await srv.serve_forever()


if __name__ == "__main__":
    asyncio.run(main())
