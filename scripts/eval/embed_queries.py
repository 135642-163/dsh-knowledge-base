#!/usr/bin/env python3
"""0.30 评测：只嵌入问题（复用已有条款向量），用于新增问题集的 dense 检索。

用法：
  /tmp/kb-eval312/bin/python scripts/eval/embed_queries.py \
      --corpus /tmp/kb-eval-030 --out /tmp/kb-eval-030-queries \
      --model BAAI/bge-small-zh-v1.5

产物：queries.f32 + queries.meta.json（维度/条数/耗时）。
"""

import argparse
import json
import os
import time

import numpy as np
from fastembed import TextEmbedding

DEFAULT_QUERY_PREFIX = "为这个句子生成表示以用于检索相关文章："


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--corpus", default="/tmp/kb-eval-030")
    parser.add_argument("--out", default="/tmp/kb-eval-030-queries")
    parser.add_argument("--model", default="BAAI/bge-small-zh-v1.5")
    parser.add_argument("--batch", type=int, default=64)
    parser.add_argument("--query-prefix", default=DEFAULT_QUERY_PREFIX)
    parser.add_argument("--cache", default=os.path.join(os.path.expanduser("~"), ".cache", "fastembed"))
    args = parser.parse_args()

    with open(os.path.join(args.corpus, "queries.json"), "r", encoding="utf-8") as handle:
        questions = json.load(handle)
    texts = [f"{args.query_prefix}{item['q']}" if args.query_prefix else item["q"] for item in questions]
    model = TextEmbedding(model_name=args.model, cache_dir=args.cache)
    started = time.time()
    vectors = np.zeros((len(texts), 0), dtype=np.float32)
    for index, vector in enumerate(model.embed(texts, batch_size=args.batch)):
        if vectors.size == 0:
            vectors = np.zeros((len(texts), len(vector)), dtype=np.float32)
        vectors[index] = vector
    norms = np.linalg.norm(vectors, axis=1, keepdims=True)
    norms[norms < 1e-9] = 1.0
    vectors = vectors / norms
    os.makedirs(args.out, exist_ok=True)
    vectors.tofile(os.path.join(args.out, "queries.f32"))
    meta = {
        "model": args.model,
        "dim": int(vectors.shape[1]),
        "queries": int(len(texts)),
        "queryPrefix": args.query_prefix,
        "seconds": round(time.time() - started, 2),
        "bytes": int(vectors.nbytes),
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    with open(os.path.join(args.out, "queries.meta.json"), "w", encoding="utf-8") as handle:
        json.dump(meta, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    print(json.dumps(meta, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
