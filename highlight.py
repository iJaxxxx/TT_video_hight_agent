#!/usr/bin/env python3
"""乒乓球视频：自动截取一段连续的高光片段（默认 60 秒）。

原理（只靠声音，不需要训练模型）：
  1. 从音轨里检测每一次击球（见 common.detect_hits）；
  2. 相邻击球间隔 < 1.5 秒串成一个回合；
  3. 用一个 N 秒的窗口沿时间轴滑动打分：窗口内每个回合得分 = 拍数^1.5
     （长回合权重更高），窗口边界切到回合中间则扣分；
  4. 取最高分窗口，用 ffmpeg 重新编码精确剪切（保留原分辨率和帧率）。

用法：
  python3 highlight.py IMG_6921.mov                 # 剪出 60 秒，存在原视频旁边
  python3 highlight.py IMG_6921.mov -d 30 -o out.mp4
  python3 highlight.py IMG_6921.mov --dry-run       # 只打印候选时间段，不导出
  python3 highlight.py IMG_6921.mov --save-hits hits.json   # 保存击球时刻，供 ball_track.py 叠加
"""
import argparse
import json
import os
import subprocess
import sys

import numpy as np

from common import detect_hits, extract_audio, group_rallies, probe


def score_window(rallies, s, e, exponent, cut_penalty):
    score = 0.0
    for r in rallies:
        if r["start"] >= s and r["end"] <= e:
            score += r["hits"] ** exponent if r["hits"] >= 2 else 0.3
        elif r["end"] > s and r["start"] < e:  # 窗口边界切到了这个回合
            score -= cut_penalty
    return score


def find_windows(rallies, total, duration, step=0.5, exponent=1.5, cut_penalty=5.0,
                 top=5, min_separation=20.0):
    if total <= duration:
        return [(0.0, score_window(rallies, 0, total, exponent, cut_penalty))]
    scored = [(score_window(rallies, s, s + duration, exponent, cut_penalty), float(s))
              for s in np.arange(0, total - duration + 1e-6, step)]
    scored.sort(reverse=True)
    picked = []
    for sc, s in scored:
        if all(abs(s - p) > min_separation for p, _ in picked):
            picked.append((s, sc))
        if len(picked) >= top:
            break
    return picked


def fmt(t):
    return f"{int(t // 60)}:{t % 60:04.1f}"


def cut(video, start, duration, out, crf=18, preset="slow"):
    cmd = ["ffmpeg", "-v", "error", "-y", "-ss", f"{start:.3f}", "-i", video,
           "-t", f"{duration:.3f}", "-map", "0:v:0", "-map", "0:a:0?",
           "-c:v", "libx264", "-preset", preset, "-crf", str(crf), "-pix_fmt", "yuv420p",
           "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", out]
    subprocess.run(cmd, check=True)


def main():
    ap = argparse.ArgumentParser(description="乒乓球视频自动截取连续高光片段（基于击球声）")
    ap.add_argument("video", help="输入视频路径")
    ap.add_argument("-d", "--duration", type=float, default=60, help="高光片段时长（秒），默认 60")
    ap.add_argument("-o", "--output", help="输出路径，默认 <原文件名>_highlight_<时长>s.mp4")
    ap.add_argument("--dry-run", action="store_true", help="只分析并打印候选时间段，不导出视频")
    ap.add_argument("--start", type=float, help="不用自动选择，直接从这一秒开始导出（可先 --dry-run 看候选）")
    ap.add_argument("--save-hits", help="把检测到的击球时刻（秒，相对原视频）存成 JSON")
    ap.add_argument("--rally-gap", type=float, default=1.5, help="相邻击球间隔小于此值算同一回合（秒）")
    ap.add_argument("--exponent", type=float, default=1.5, help="回合得分 = 拍数^exponent，越大越偏爱长回合")
    ap.add_argument("--cut-penalty", type=float, default=5.0, help="窗口边界切到回合中间时的扣分")
    ap.add_argument("--crf", type=int, default=18, help="x264 画质，越小越清晰、文件越大")
    ap.add_argument("--preset", default="slow", help="x264 编码速度档位（veryfast / fast / slow ...）")
    args = ap.parse_args()

    total, w, h, fps = probe(args.video)
    print(f"视频：{w}x{h} @ {fps:.2f}fps，时长 {fmt(total)}")

    x, sr = extract_audio(args.video)
    hits = detect_hits(x, sr)
    hit_times = [t for t, _ in hits]
    rallies = group_rallies(hit_times, args.rally_gap)
    longest = sorted(rallies, key=lambda r: -r["hits"])[:5]
    print(f"检测到 {len(hit_times)} 次击球，{sum(r['hits'] >= 3 for r in rallies)} 个 ≥3 拍的回合")
    print("最长的回合：" + "，".join(f"{fmt(r['start'])} {r['hits']}拍" for r in longest))

    if args.save_hits:
        with open(args.save_hits, "w") as f:
            json.dump({"video": os.path.abspath(args.video), "hits": hits}, f)
        print(f"击球时刻已保存：{args.save_hits}")

    windows = find_windows(rallies, total, args.duration, exponent=args.exponent,
                           cut_penalty=args.cut_penalty)
    print("候选窗口（按得分）：")
    for s, sc in windows:
        inside = [r for r in rallies if r["start"] >= s and r["end"] <= s + args.duration]
        big = sorted((r["hits"] for r in inside), reverse=True)[:3]
        print(f"  {fmt(s)} – {fmt(min(total, s + args.duration))}  得分 {sc:6.1f}  主要回合拍数 {big}")

    if args.dry_run or not windows:
        return
    start = args.start if args.start is not None else windows[0][0]
    out = args.output or f"{os.path.splitext(args.video)[0]}_highlight_{int(args.duration)}s.mp4"
    print(f"导出 {fmt(start)} 起 {args.duration:g} 秒 → {out}")
    cut(args.video, start, min(args.duration, total - start), out, args.crf, args.preset)
    print("完成")


if __name__ == "__main__":
    sys.exit(main())
