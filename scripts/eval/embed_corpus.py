#!/usr/bin/env python3
"""0.29 评测：把条款/问题文本嵌入成 float32 向量（fastembed + ONNX，CPU）。

只做离线评测，不进插件运行时；产物默认写到 /tmp/kb-eval-029。

用法：
  /tmp/kb-eval312/bin/python scripts/eval/embed_corpus.py \
      --in /tmp/kb-eval-029 --out /tmp/kb-eval-029 \
      --model BAAI/bge-small-zh-v1.5 --batch 64

产物：
  clauses.f32      N×dim float32（已 L2 归一化，行序同 clauses.jsonl）
  queries.f32      Q×dim float32（带中文检索指令）
  meta.json        model/dim/count/耗时/字符统计
  --limit 只嵌前 N 条（冒烟测试，配合 --out 另一个目录）
"""

import argparse
import json
import os
import sys
import time

import numpy as np
from fastembed import TextEmbedding

DEFAULT_QUERY_PREFIX = "为这个句子生成表示以用于检索相关文章："


def read_jsonl(path):
    rows = []
    with open(path, "r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def normalize(matrix):
    norms = np.linalg.norm(matrix, axis=1, keepdims=True)
    norms[norms < 1e-9] = 1.0
    return matrix / norms


def embed_texts(model, texts, batch_size, label):
    started = time.time()
    vectors = None
    done = 0
    for vector in model.embed(texts, batch_size=batch_size):
        if vectors is None:
            vectors = np.zeros((len(texts), len(vector)), dtype=np.float32)
        vectors[done] = vector
        done += 1
        if done % 2000 == 0 or done == len(texts):
            elapsed = max(1e-6, time.time() - started)
            print(
                f"[{label}] {done}/{len(texts)}  {done / elapsed:.1f}/s  elapsed {elapsed:.0f}s",
                flush=True,
            )
    if vectors is None:
        dim = 0
        vectors = np.zeros((0, 0), dtype=np.float32)
    else:
        dim = vectors.shape[1]
    return normalize(vectors), dim, time.time() - started


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--in", dest="corpus_dir", default="/tmp/kb-eval-029")
    parser.add_argument("--out", dest="out_dir", default="")
    parser.add_argument("--model", default="BAAI/bge-small-zh-v1.5")
    parser.add_argument("--batch", type=int, default=64)
    parser.add_argument("--limit", type=int, default=0, help="只嵌前 N 条（0=全部）")
    parser.add_argument("--threads", type=int, default=0)
    parser.add_argument("--query-prefix", default=DEFAULT_QUERY_PREFIX)
    parser.add_argument("--cache", default=os.path.join(os.path.expanduser("~"), ".cache", "fastembed"))
    args = parser.parse_args()

    out_dir = args.out_dir or args.corpus_dir
    clauses = read_jsonl(os.path.join(args.corpus_dir, "clauses.jsonl"))
    if args.limit > 0:
        clauses = clauses[: args.limit]
    with open(os.path.join(args.corpus_dir, "queries.json"), "r", encoding="utf-8") as handle:
        queries = json.load(handle)

    kwargs = {"model_name": args.model, "cache_dir": args.cache}
    if args.threads > 0:
        kwargs["threads"] = args.threads
    model = TextEmbedding(**kwargs)

    texts = [row["text"] for row in clauses]
    chars = sum(len(text) for text in texts)
    print(f"model={args.model} clauses={len(texts)} avg_chars={chars / max(1, len(texts)):.1f}", flush=True)
    clause_vectors, dim, clause_seconds = embed_texts(model, texts, args.batch, "clauses")

    query_texts = [f"{args.query_prefix}{item['q']}" if args.query_prefix else item["q"] for item in queries]
    query_vectors, query_dim, query_seconds = embed_texts(model, query_texts, args.batch, "queries")

    os.makedirs(out_dir, exist_ok=True)
    clause_vectors.tofile(os.path.join(out_dir, "clauses.f32"))
    query_vectors.tofile(os.path.join(out_dir, "queries.f32"))
    meta = {
        "model": args.model,
        "dim": int(dim),
        "queryDim": int(query_dim),
        "clauses": int(len(texts)),
        "queries": int(len(queries)),
        "limit": args.limit,
        "normalized": True,
        "batch": args.batch,
        "queryPrefix": args.query_prefix,
        "clauseSeconds": round(clause_seconds, 2),
        "querySeconds": round(query_seconds, 2),
        "textsPerSecond": round(len(texts) / max(1e-6, clause_seconds), 1),
        "bytes": int(clause_vectors.nbytes + query_vectors.nbytes),
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    with open(os.path.join(out_dir, "meta.json"), "w", encoding="utf-8") as handle:
        json.dump(meta, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    print(json.dumps(meta, ensure_ascii=False, indent=2), flush=True)


if __name__ == "__main__":
    sys.exit(main())
