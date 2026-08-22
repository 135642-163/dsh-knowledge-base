#!/usr/bin/env python3
"""RapidOCR 常驻识别进程：二进制帧协议，供 dsh-knowledge-base 插件调用。

stdin: 重复 [4字节大端长度][PNG 数据]
stdout: 重复 [4字节大端长度][UTF-8 识别文本]（识别失败时文本为空串）
"""
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
    try:
        result, _ = engine(data)
        text = "\n".join(str(line[1]) for line in result) if result else ""
    except Exception as exc:  # noqa: BLE001
        sys.stderr.write(f"rapidocr page error: {exc}\n")
        text = ""
    payload = text.encode("utf-8")
    stdout.write(struct.pack(">I", len(payload)))
    stdout.write(payload)
    stdout.flush()
