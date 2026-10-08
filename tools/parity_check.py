#!/usr/bin/env python3
# C0 — paridad numérica: capas k..n sueltas + DynamicCache ≡ forward monolítico.
# Si esto no cuadra, todo lo demás de fase C es falso. fp32 → tolerancia ~1e-4.
import sys, torch
sys.path.insert(0, ".")
from tools.stage_runner import StageModel, EdgeModel

MODEL = "Qwen/Qwen2.5-0.5B"

def main():
    from transformers import AutoModelForCausalLM, AutoTokenizer
    from transformers.cache_utils import DynamicCache

    tok = AutoTokenizer.from_pretrained(MODEL)
    full = AutoModelForCausalLM.from_pretrained(MODEL, dtype=torch.float32).eval()
    text = "The capital of France is"
    ids = tok(text, return_tensors="pt").input_ids
    S = ids.shape[1]
    print(f"prompt: {text!r} → {S} tokens")

    # Referencia: forward monolítico, capturo hidden states por capa.
    with torch.no_grad():
        ref = full(ids, output_hidden_states=True, use_cache=True)
    ref_hidden = ref.hidden_states  # tuple [25] de [1,S,d] — [0]=embed, [i]=post-capa i-1
    print(f"ref logits top1: {tok.decode([int(ref.logits[0,-1].argmax())])!r}")

    # Pipeline de 2 stages: A=capas 0..12, B=capas 12..24, caches propios.
    a = StageModel(MODEL, 0, 12)
    b = StageModel(MODEL, 12, 24)
    ca, cb = a.new_cache(), b.new_cache()
    h = a.embed_tokens_par = None
    with torch.no_grad():
        emb = full.model.embed_tokens(ids)[0]  # [S,d]
    ha = a.forward(ca, emb.clone(), 0)
    hb = b.forward(cb, ha.clone(), 0)
    d_half = (ha - ref_hidden[12][0]).abs().max().item()
    # hidden_states[-1] de HF ya viene con norm aplicado — el stage produce el
    # output CRUDO de la capa (el edge aplica norm+lm_head). Comparo normed.
    with torch.no_grad():
        hb_normed = full.model.norm(hb)
    d_full = (hb_normed - ref_hidden[24][0]).abs().max().item()
    print(f"stage A vs ref capa 12: max|Δ| = {d_half:.2e}")
    print(f"stage B (post-norm) vs ref final: max|Δ| = {d_full:.2e}")
    assert d_half < 1e-4, "stage A diverge del monolítico"
    assert d_full < 1e-4, "stage B diverge del monolítico"

    # Decode autoregresivo: monolítico greedy vs pipeline A→B→head.
    with torch.no_grad():
        gen = full.generate(ids, max_new_tokens=8, do_sample=False, pad_token_id=tok.eos_token_id)
    ref_text = tok.decode(gen[0, S:])
    print(f"ref generate: {ref_text!r}")

    edge = EdgeModel(MODEL)
    outs = []
    # Caches FRESCOS — el flujo real es: prefill [5,d] → next → decode [1,d]...
    ca, cb = a.new_cache(), b.new_cache()
    hidden = emb.clone()
    pos_a = pos_b = 0
    for _ in range(8):  # 1 prefill + 7 decode steps = 8 tokens como el ref
        ha = a.forward(ca, hidden, pos_a); pos_a += hidden.shape[0]
        hb = b.forward(cb, ha, pos_b); pos_b += ha.shape[0]
        r = edge.next_token(hb.numpy())
        if r["done"]:
            break
        outs.append(r["token"])
        hidden = torch.from_numpy(r["embed"].astype('float32')).unsqueeze(0)  # [1,d]
    pipe_text = "".join(outs)
    print(f"pipeline decode: {pipe_text!r}")
    assert pipe_text == ref_text, f"pipeline diverge: {pipe_text!r} vs {ref_text!r}"
    print("PARIDAD OK — slice de capas + KV por sesión ≡ monolítico")

if __name__ == "__main__":
    main()
