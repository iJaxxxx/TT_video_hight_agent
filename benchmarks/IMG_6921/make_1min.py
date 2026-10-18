#!/usr/bin/env python3
"""给每个工具出一个 1 分钟高光，方便对比。

规则：按工具自己的高光打分从高到低挑片段（片段按工具自己的导出余量），
总长不超过 60 秒，放不下的跳过、继续试下一个；最后按原片时间顺序拼接。
  TTLab          (is_highlight, highlight_score, score)
  TTcut 落台     (bounce_count, 时长)          —— App 高光模式按落台次数筛选
  TTcut 连续运动 (时长)                        —— App 高光模式按时长分档
  ours           highlight.py 的最佳连续 60 秒窗口

画面叠加：左上 工具/片段/原片时间；右上 这一段里的得分归属（来自 points_metrics.json）；
左下 真值 打球中/死球。

用法（仓库根目录）：python3 benchmarks/IMG_6921/make_1min.py <原视频> <输出目录>
"""
import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "..", ".."))
import compare as C  # noqa: E402
from common import group_rallies  # noqa: E402
from highlight import find_windows  # noqa: E402

FONT = "/System/Library/Fonts/STHeiti Medium.ttc"
TARGET = 60.0
fmt = lambda t: f"{int(t // 60)}:{t % 60:04.1f}"


def load(name):
    return json.load(open(os.path.join(HERE, name)))


def merge_scored(items):
    """items: [(s, e, key)]，重叠的合并，key 取最大。"""
    out = []
    for s, e, k in sorted(items):
        if out and s <= out[-1][1]:
            out[-1] = (out[-1][0], max(out[-1][1], e), max(out[-1][2], k))
        else:
            out.append((s, e, k))
    return out


def pick(items):
    chosen, total = [], 0.0
    for s, e, k in sorted(items, key=lambda x: x[2], reverse=True):
        if total + (e - s) <= TARGET + 1e-6:
            chosen.append((s, e)); total += e - s
    return sorted(chosen)


def selections():
    sel = {}
    d = load("ttlab_full.json")
    sel["TTLab"] = pick(merge_scored([(r["start_time"], r["end_time"],
                                       (r["is_highlight"], r["highlight_score"], r["score"])) for r in d["rallies"]]))
    for mode, key, tail in (("bounce", "TTcut落台", 1.0), ("visibility", "TTcut连续运动", 0.0)):
        rs = load(f"ttcut_full_{mode}.json")["event"]["data"]["rallies"]
        items = []
        for r in rs:
            s, e = r["start_time_seconds"], r["end_time_seconds"]
            k = (r.get("bounce_count", 0), e - s) if mode == "bounce" else (e - s,)
            items.append((max(0.0, s - 2.5), min(C.DURATION, e + tail + 1.0), k))
        sel[key] = pick(merge_scored(items))
    hits = [t for t, _ in load("ours_hits.json")["hits"]]
    start = find_windows(group_rallies(hits, 1.5), C.DURATION, TARGET)[0][0]
    sel["ours"] = [(start, start + TARGET)]
    return sel


def png(path, text, bg, size=32):
    from PIL import Image, ImageDraw, ImageFont
    font = ImageFont.truetype(FONT, size)
    im = Image.new("RGBA", (font.getbbox(text)[2] + 28, size + 22), bg)
    ImageDraw.Draw(im).text((14, 8), text, font=font, fill=(255, 255, 255, 255))
    im.save(path)


def render(src, name, segs, out):
    gt, _ = C.ground_truth()
    pts = [p for p in load("points_metrics.json")["points"] if p.get("winner") in ("student", "coach")
           and p.get("how") != "not_a_point"]
    tmp = tempfile.mkdtemp()
    offs, o = [], 0.0
    for s, e in segs:
        offs.append(o); o += e - s
    to_out = lambda t, i: offs[i] + t - segs[i][0]
    overlays = []  # (png, x, y, enable_expr)
    for i, (s, e) in enumerate(segs):
        p = os.path.join(tmp, f"seg{i}.png")
        png(p, f"{name} 1分钟  ·  片段 {i + 1}/{len(segs)}  ·  原片 {fmt(s)}–{fmt(e)}", (0, 0, 0, 170))
        overlays.append((p, "20", "20", f"between(t,{offs[i]:.3f},{to_out(e, i):.3f})"))
    for p in pts:
        decisive = p["end"] - 0.5
        for i, (s, e) in enumerate(segs):
            if s <= decisive <= e:
                student = p["winner"] == "student"
                path = os.path.join(tmp, f"{p['point']}.png")
                png(path, f"{'你的得分球' if student else '教练得分'} {p['point']}",
                    (30, 150, 70, 220) if student else (200, 50, 50, 220))
                a, b = to_out(max(s, p["start"]), i), to_out(min(e, p["end"] + 1.0), i)
                overlays.append((path, "W-w-20", "20", f"between(t,{a:.3f},{b:.3f})"))
    inside = []
    for i, (s, e) in enumerate(segs):
        for gs, ge in gt:
            a, b = max(s, gs), min(e, ge)
            if b > a:
                inside.append((to_out(a, i), to_out(b, i)))
    in_expr = "+".join(f"between(t,{a:.3f},{b:.3f})" for a, b in inside) or "0"
    png(os.path.join(tmp, "in.png"), "真值：打球中", (30, 150, 70, 210))
    png(os.path.join(tmp, "out.png"), "真值：死球", (200, 50, 50, 210))
    overlays += [(os.path.join(tmp, "in.png"), "20", "H-h-20", in_expr),
                 (os.path.join(tmp, "out.png"), "20", "H-h-20", f"not({in_expr})")]

    sel = "+".join(f"between(t,{s:.3f},{e:.3f})" for s, e in segs)
    fc = [f"[0:v]select='{sel}',setpts=N/(60000/1001)/TB,scale=1280:720[v0]",
          f"[0:a]aselect='{sel}',asetpts=N/SR/TB[aout]"]
    cur = "v0"
    for k, (_, x, y, en) in enumerate(overlays):
        fc.append(f"[{cur}][{k + 1}:v]overlay={x}:{y}:enable='{en}'[v{k + 1}]"); cur = f"v{k + 1}"
    script = os.path.join(tmp, "fc.txt")
    open(script, "w").write(";\n".join(fc))
    cmd = ["ffmpeg", "-v", "error", "-y", "-i", src] + sum((["-i", ov[0]] for ov in overlays), []) + [
        "-/filter_complex", script, "-map", f"[{cur}]", "-map", "[aout]", "-c:v", "h264_videotoolbox", "-b:v", "4M",
        "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", out]
    subprocess.run(cmd, check=True)
    return o


def main():
    src, out_dir = sys.argv[1], os.path.expanduser(sys.argv[2])
    pts = {p["point"]: p for p in load("points_metrics.json")["points"]}
    summary = {}
    for name, segs in selections().items():
        out = os.path.join(out_dir, f"IMG_6921_1分钟_{name}.mp4")
        dur = render(src, name, segs, out)
        covered = [k for k, p in pts.items() if p.get("winner") in ("student", "coach") and p.get("how") != "not_a_point"
                   and any(s <= p["end"] - 0.5 <= e for s, e in segs)]
        summary[name] = {"segments": [(round(s, 2), round(e, 2)) for s, e in segs], "seconds": round(dur, 1),
                         "student_points": [k for k in covered if pts[k]["winner"] == "student"],
                         "coach_points": [k for k in covered if pts[k]["winner"] == "coach"]}
        print(f"{name:10s} {len(segs)} 段 {dur:5.1f}s  你的得分球 {summary[name]['student_points']}  "
              f"教练得分 {summary[name]['coach_points']}")
    json.dump(summary, open(os.path.join(HERE, "1min_selection.json"), "w"), ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
