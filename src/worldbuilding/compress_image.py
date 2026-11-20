#!/usr/bin/env python3
"""Compress a map image before upload to Foundry (see upload.ts).

Why: the Entry Hall map was a 3.9 MB PNG and may have hung Dave's scene
switch ("resources finish loading"). A scene background is displayed at
most ~1600 px, so anything bigger is wasted bytes.

Rules (safe by construction, never fail the upload):
- Small enough already (<= --max-bytes and <= --max-dimension on both
  sides): copied as-is, changed=false.
- Opaque image (no real alpha): resized if needed and saved as JPEG
  quality --jpeg-quality. Maps are opaque backgrounds; JPEG is ~5-10x
  smaller than a photo-like PNG at no visible loss.
- Image with real transparency: kept as PNG (resized if needed,
  optimize=True) — JPEG cannot carry alpha.
- Any error at all (no PIL, corrupt file, ...): the input is copied
  as-is and the error is reported in JSON. The caller uploads the
  original; compression must never fail an upload.

Usage:
  python3 compress_image.py <input> <outdir>
      [--max-dimension 1600] [--jpeg-quality 82] [--max-bytes 1048576]
Prints one JSON object to stdout.
"""
import argparse
import json
import os
import shutil
import sys


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("input")
    p.add_argument("outdir")
    p.add_argument("--max-dimension", type=int, default=1600)
    p.add_argument("--jpeg-quality", type=int, default=82)
    p.add_argument("--max-bytes", type=int, default=1024 * 1024)
    args = p.parse_args()

    src = args.input
    stem = os.path.splitext(os.path.basename(src))[0]
    original_bytes = os.path.getsize(src)
    result = {
        "changed": False,
        "path": os.path.join(args.outdir, os.path.basename(src)),
        "format": None,
        "originalBytes": original_bytes,
        "outputBytes": original_bytes,
        "width": None,
        "height": None,
        "error": None,
    }
    try:
        from PIL import Image

        with Image.open(src) as im:
            width, height = im.size
            result["width"] = width
            result["height"] = height
            needs_work = (
                original_bytes > args.max_bytes
                or width > args.max_dimension
                or height > args.max_dimension
            )
            if not needs_work:
                shutil.copyfile(src, result["path"])
                result["format"] = im.format or "PNG"
                return 0

            has_alpha = False
            if im.mode in ("RGBA", "LA"):
                alpha = im.getchannel("A")
                has_alpha = alpha.getextrema()[0] < 255
            elif im.mode == "P":
                has_alpha = "transparency" in im.info

            # Resize first (LANCZOS), only if over the dimension cap.
            scale = min(1.0, args.max_dimension / max(width, height))
            work = im
            if scale < 1.0:
                work = im.resize(
                    (round(width * scale), round(height * scale)),
                    Image.LANCZOS,
                )
            if has_alpha:
                out_path = os.path.join(args.outdir, stem + ".png")
                work.convert("RGBA").save(out_path, format="PNG", optimize=True)
                result.update({"changed": True, "path": out_path, "format": "PNG"})
            else:
                out_path = os.path.join(args.outdir, stem + ".jpg")
                work.convert("RGB").save(
                    out_path, format="JPEG", quality=args.jpeg_quality, optimize=True
                )
                result.update({"changed": True, "path": out_path, "format": "JPEG"})
            result["outputBytes"] = os.path.getsize(result["path"])
            result["width"], result["height"] = Image.open(result["path"]).size
            return 0
    except Exception as e:  # noqa: BLE001 — fall back to the original file
        result["error"] = str(e)[:200]
        try:
            shutil.copyfile(src, result["path"])
            result["outputBytes"] = os.path.getsize(result["path"])
        except Exception as e2:  # noqa: BLE001
            result["error"] = f"{result['error']}; copy failed: {e2}"[:200]
            result["path"] = src
        return 0
    finally:
        print(json.dumps(result))


if __name__ == "__main__":
    sys.exit(main())
