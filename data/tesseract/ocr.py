#!/usr/bin/env python3
"""原生 tesseract 常驻识别进程（tesserocr 绑定）：二进制帧协议，供 dsh-knowledge-base 插件调用。

与 data/rapidocr/ocr.py 同协议：
stdin: 重复 [4字节大端长度][PNG 数据]
stdout: 重复 [4字节大端长度][UTF-8 JSON {"text": "...", "confidence": 0-100|null}]

argv: [lang] [tessdata_dir]（tessdata_dir 可省略，省略时用 tesserocr 默认路径）
引擎常驻内存：避免每页重新启动 tesseract 进程、重载语言模型。
依赖（tesseract-env 内安装）：tesserocr、Pillow
"""
import io
import json
import struct
import sys

from PIL import Image
from tesserocr import PyTessBaseAPI, PSM

lang = sys.argv[1] if len(sys.argv) > 1 else "chi_sim+eng"
tessdata_dir = sys.argv[2] if len(sys.argv) > 2 else None

kwargs = {"lang": lang, "psm": PSM.AUTO}
if tessdata_dir:
    kwargs["path"] = tessdata_dir
api = PyTessBaseAPI(**kwargs)

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
    try:
        img = Image.open(io.BytesIO(data))
        api.SetImage(img)
        text = api.GetUTF8Text().strip()
        if text:
            try:
                confidence = round(float(api.MeanTextConf()), 2)
            except Exception:  # noqa: BLE001
                confidence = None
    except Exception as exc:  # noqa: BLE001
        sys.stderr.write(f"tesserocr page error: {exc}\n")
        text = ""
        confidence = None
    payload = json.dumps({"text": text, "confidence": confidence}, ensure_ascii=False).encode("utf-8")
    stdout.write(struct.pack(">I", len(payload)))
    stdout.write(payload)
    stdout.flush()
