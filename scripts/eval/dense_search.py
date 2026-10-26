#!/usr/bin/env python3
"""0.29 评测：用 numpy 对全量条款向量做暴力余弦检索，输出每题的 top-K 条款。

只读评测产物；不写知识库、不进插件运行时。

用法：
  /tmp/kb-eval312/bin/python scripts/eval/dense_search.py \
      --in /tmp/kb-eval-029 --topk 200 --out /tmp/kb-eval-029/dense.json

产物：
  dense.json  { meta: {...}, results: [ { queryId, tookMs, hits: [{ id, score }] } ] }
"""

import argparse
import json
import os
import time

import numpy as np


def load_matrix(path, count, dim, limit=0):
    rows = count if limit <= 0 else min(count, limit)
    data = np.fromfile(path, dtype=np.float32)
    if data.size != count * dim:
        raise SystemExit(f"{path}: 期望 {count * dim} 个 float，实际 {data.size}")
    return data.reshape(count, dim)[:rows]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--in", dest="dir", default="/tmp/kb-eval-029")
    parser.add_argument("--corpus", default="", help="queries.json 所在目录（默认同 --in）")
    parser.add_argument("--topk", type=int, default=200)
    parser.add_argument("--out", default="")
    args = parser.parse_args()

    with open(os.path.join(args.dir, "meta.json"), "r", encoding="utf-8") as handle:
        meta = json.load(handle)
    count, dim = int(meta["clauses"]), int(meta["dim"])
    clauses = load_matrix(os.path.join(args.dir, "clauses.f32"), count, dim)
    queries = load_matrix(os.path.join(args.dir, "queries.f32"), int(meta["queries"]), int(meta["queryDim"]))
    corpus_dir = args.corpus or args.dir
    with open(os.path.join(corpus_dir, "queries.json"), "r", encoding="utf-8") as handle:
        question_ids = [item["id"] for item in json.load(handle)]

    topk = max(1, min(args.topk, count))
    print(f"clauses={count} dim={dim} queries={queries.shape[0]} topk={topk}", flush=True)

    # 归一化已在 embed 阶段做过；这里再保险一次（失败也不影响排序）。
    norms = np.linalg.norm(clauses, axis=1, keepdims=True)
    norms[norms < 1e-9] = 1.0
    clauses = clauses / norms

    results = []
    started = time.time()
    for index in range(queries.shape[0]):
        query = queries[index]
        query_norm = np.linalg.norm(query)
        if query_norm > 1e-9:
            query = query / query_norm
        query_started = time.time()
        scores = clauses @ query
        # argpartition 取 topk 后再排序，避免全量 O(N log N)。
        if topk < len(scores):
            candidate = np.argpartition(-scores, topk - 1)[:topk]
        else:
            candidate = np.arange(len(scores))
        order = candidate[np.argsort(-scores[candidate])]
        hits = [{"id": int(row), "score": float(scores[row])} for row in order]
        results.append({
            "queryId": question_ids[index] if index < len(question_ids) else str(index),
            "tookMs": round((time.time() - query_started) * 1000, 2),
            "hits": hits,
        })
        if (index + 1) % 10 == 0 or index + 1 == queries.shape[0]:
            print(f"[dense] {index + 1}/{queries.shape[0]} elapsed {time.time() - started:.1f}s", flush=True)

    payload = {
        "meta": {
            "model": meta.get("model"),
            "dim": dim,
            "clauses": count,
            "queries": int(queries.shape[0]),
            "topk": topk,
            "seconds": round(time.time() - started, 2),
            "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        },
        "results": results,
    }
    out = args.out or os.path.join(args.dir, "dense.json")
    with open(out, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False)
        handle.write("\n")
    print(json.dumps(payload["meta"], ensure_ascii=False, indent=2), flush=True)


if __name__ == "__main__":
    main()
