#!/usr/bin/env python3
"""RapidOCR 常驻识别进程：二进制帧协议，供 dsh-knowledge-base 插件调用。

stdin: 重复 [4字节大端长度][PNG 数据]
stdout: 重复 [4字节大端长度][UTF-8 JSON {"text": "...", "confidence": 0-100|null}]
"""
import json
import struct
import sys

from rapidocr_onnxruntime import RapidOCR

engine = RapidOCR()
stdin = sys.stdin.buffer
stdout = sys.stdout.buffer

while True:
    header = stdin.read(4)
    if len(header) < 4:
        break
    (size,) = struct.unpack(">I", header)
    data = stdin.read(size)
    if len(data) < size:
        break
    confidence = None
    lines = []
    try:
        result, _ = engine(data)
        if result:
            text = "\n".join(str(line[1]) for line in result)
            scores = []
            for line in result:
                if len(line) > 2 and line[2] is not None:
                    try:
                        scores.append(float(line[2]))
                    except (TypeError, ValueError):
                        pass
                box = line[0] if len(line) > 0 else None
                if box:
                    try:
                        lines.append({
                            "text": str(line[1]),
                            "box": [[round(float(p[0]), 1), round(float(p[1]), 1)] for p in box],
                            "score": float(line[2]) if len(line) > 2 and line[2] is not None else None,
                        })
                    except (TypeError, ValueError, IndexError):
                        pass
            if scores:
                confidence = round(sum(scores) / len(scores) * 100, 2)
        else:
            text = ""
    except Exception as exc:  # noqa: BLE001
        sys.stderr.write(f"rapidocr page error: {exc}\n")
        text = ""
        confidence = None
        lines = []
    payload = json.dumps({"text": text, "confidence": confidence, "lines": lines}, ensure_ascii=False).encode("utf-8")
    stdout.write(struct.pack(">I", len(payload)))
    stdout.write(payload)
    stdout.flush()
