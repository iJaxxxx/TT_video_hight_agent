#!/usr/bin/env python3
"""乒乓球视频：识别球的运动轨迹，并把轨迹叠加回视频（不需要训练模型）。

原理：
  1. 三帧差分：只保留在连续三帧里都在变化的像素 —— 静止的东西（地上的散球、球台）自然被去掉；
  2. 把运动像素膨胀合并成团，整团运动量大的视为"人"并丢弃，只留下孤立的小运动点；
  3. 再按大小、亮度、饱和度筛选（白色小球）；
  4. 跟踪：用匀速模型预测下一帧位置，就近匹配候选点，连成轨迹；
     丢弃太短、太慢、太小的轨迹；每一帧取得分最高的轨迹作为"比赛用球"；
     ≤6 帧的空缺用线性插值补上；
  5. 可选：叠加声音检测到的击球时刻（HIT），并统计回合进行中有多少帧找到了球。

时间对齐：手机视频多为可变帧率（VFR），本脚本用 ffprobe 读出每一帧的真实时间戳，
帧号 ↔ 时间一律查表，不按"帧号 ÷ fps"换算，所以画面、轨迹和声音严格对齐（见 frame_times）。

已知局限（详见 README）：球贴近球员挥拍时会被当作人体运动过滤掉；被网带遮挡时会丢；
所有阈值针对固定机位 + 白球 + 室内灯光调过，换场景可能要调参。

用法：
  python3 ball_track.py clip.mp4
  python3 ball_track.py IMG_6921.mov --start 484 --duration 60 --hits
  python3 ball_track.py clip.mp4 --exclude 1050,800,1920,1080 --exclude 0,950,1920,1080
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile
from multiprocessing import Pool

import cv2
import numpy as np

from common import detect_hits, extract_audio, group_rallies, probe


# ---------------------------------------------------------------- 读帧

def frame_times(video, start, duration):
    """用 ffprobe 读出 [start, start+duration) 内每一帧的真实显示时间（秒，升序）。

    为什么需要它：手机拍的视频通常是可变帧率（VFR）。IMG_6921 标称 59.94fps，
    实际约 60fps 且帧间隔在 15–18ms 之间浮动。如果用"帧号 ÷ 标称 fps"换算时间，
    误差会随时长累积（第 484 秒处偏了 13 帧），画面就会和声音（HIT 标记）错位。
    所以帧号 ↔ 时间一律查这张表，不做任何帧率假设。"""
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-read_intervals", f"{max(0.0, start - 2):.3f}%{start + duration + 2:.3f}",
         "-show_entries", "packet=pts_time", "-of", "csv=p=0", video],
        capture_output=True, text=True, check=True).stdout
    ts = []
    for line in out.splitlines():
        v = line.split(",")[0].strip()
        if v and v != "N/A":
            ts.append(float(v))
    ts = np.unique(np.array(ts))
    return ts[(ts >= start) & (ts < start + duration)]


def read_frames(video, times, first, count, w, h):
    """解码片段内第 first 帧起的 count 帧（BGR），第 i 帧就是 times[i] 那一帧。
    按时间戳 seek 到 times[first] 前半帧，并用 -vsync 0 原样输出每一帧（不插帧、不丢帧）。"""
    dt = float(np.median(np.diff(times))) if len(times) > 1 else 1 / 30
    t0 = max(0.0, times[first] - dt / 2)
    cmd = ["ffmpeg", "-v", "error", "-ss", f"{t0:.4f}", "-i", video,
           # -fps_mode passthrough：原样输出每一帧，不插帧也不丢帧（旧写法 -vsync 0 在 ffmpeg 8+ 已移除）
           "-map", "0:v:0", "-fps_mode", "passthrough", "-frames:v", str(count),
           "-f", "image2pipe", "-c:v", "rawvideo", "-pix_fmt", "bgr24", "-"]
    err = tempfile.TemporaryFile()
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=err)
    size = w * h * 3
    try:
        for _ in range(count):
            raw = proc.stdout.read(size)
            if len(raw) < size:
                break
            yield np.frombuffer(raw, np.uint8).reshape(h, w, 3).copy()
    finally:
        proc.stdout.close()
        proc.wait()
        # VFR 源在 seek 后偶尔触发 "non monotonically increasing dts" 提示：不影响输出（已逐帧验证），过滤掉；
        # 其他 ffmpeg 报错照常打印
        err.seek(0)
        for line in err.read().decode(errors="replace").splitlines():
            if "non monotonically increasing dts" not in line:
                print(line, file=sys.stderr)
        err.close()


# ---------------------------------------------------------------- 1–3 检测候选点

def detect_range(job):
    """在片段内帧号 [a, b] 范围检测候选球点。返回 {帧号: [[x, y, 面积, 亮度, 饱和度], ...]}"""
    video, times, w, h, a, b, p = job
    first = max(a - 1, 0)
    last = min(b + 1, len(times) - 1)
    k = first
    buf, res = [], {}
    kernel_open = np.ones((2, 2), np.uint8)
    kernel_merge = np.ones((p["merge"], p["merge"]), np.uint8)
    for frame in read_frames(video, times, first, last + 1 - first, w, h):
        buf.append((k, cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY), cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)))
        k += 1
        if len(buf) > 3:
            buf.pop(0)
        if len(buf) < 3:
            continue
        (_, g0, _), (i1, g1, h1), (_, g2, _) = buf
        if i1 < a or i1 > b:
            continue
        th = p["diff"]
        m = ((cv2.absdiff(g1, g0) > th) & (cv2.absdiff(g2, g1) > th)).astype(np.uint8)
        m = cv2.morphologyEx(m, cv2.MORPH_OPEN, kernel_open)
        n, lab, st, cen = cv2.connectedComponentsWithStats(m, 8)
        # 把运动像素膨胀合并：一团里运动像素很多 → 是人，不是球
        md = cv2.dilate(m, kernel_merge)
        _, labd, _, _ = cv2.connectedComponentsWithStats(md, 8)
        cluster_px = np.bincount(labd[m > 0], minlength=labd.max() + 1)
        cands = []
        for j in range(1, n):
            x, y, w, h, area = st[j]
            if not (p["min_area"] <= area <= p["max_area"]):
                continue
            if max(w, h) > p["max_side"] or min(w, h) < 2:
                continue
            cx, cy = cen[j]
            if cluster_px[labd[int(cy), int(cx)]] > area * 1.5 + 30:
                continue
            pix = h1[y:y + h, x:x + w][lab[y:y + h, x:x + w] == j]
            v, s = pix[:, 2].mean(), pix[:, 1].mean()
            if v < p["min_v"] or s > p["max_s"]:
                continue
            cands.append([float(cx), float(cy), int(area), float(v), float(s)])
        res[i1] = cands
    return res


# ---------------------------------------------------------------- 4 跟踪

def in_excluded(c, zones):
    return any(x1 <= c[0] <= x2 and y1 <= c[1] <= y2 for x1, y1, x2, y2 in zones)


def track(det, n_frames, zones, min_len=6, min_speed=5, min_area_mean=12,
          max_miss=3, fill_gap=6, track_min_area=6):
    finished, active = [], []
    for t in range(n_frames):
        cs = [c for c in det.get(t, []) if c[2] >= track_min_area and not in_excluded(c, zones)]
        pairs = []
        for ti, tr in enumerate(active):
            lt, lx, ly = tr["pts"][-1][:3]
            gap = t - lt
            pred = np.array([lx, ly]) + tr["v"] * gap
            radius = 40 + 0.6 * np.linalg.norm(tr["v"]) * gap if len(tr["pts"]) > 1 else 110
            for ci, c in enumerate(cs):
                d = np.hypot(c[0] - pred[0], c[1] - pred[1])
                if d < radius:
                    pairs.append((d, ti, ci))
        pairs.sort()
        used_t, used_c = set(), set()
        for d, ti, ci in pairs:
            if ti in used_t or ci in used_c:
                continue
            tr = active[ti]
            lt, lx, ly = tr["pts"][-1][:3]
            nv = np.array([cs[ci][0] - lx, cs[ci][1] - ly]) / (t - lt)
            tr["v"] = nv if len(tr["pts"]) == 1 else 0.5 * tr["v"] + 0.5 * nv
            tr["pts"].append([t, cs[ci][0], cs[ci][1], cs[ci][2]])
            used_t.add(ti)
            used_c.add(ci)
        for ci, c in enumerate(cs):
            if ci not in used_c:
                active.append({"pts": [[t, c[0], c[1], c[2]]], "v": np.zeros(2)})
        still = []
        for tr in active:
            (still if t - tr["pts"][-1][0] <= max_miss else finished).append(tr)
        active = still
    finished += active

    good = []
    for tr in finished:
        P = np.array(tr["pts"])
        if len(P) < min_len:
            continue
        speed = np.hypot(np.diff(P[:, 1]), np.diff(P[:, 2])) / np.diff(P[:, 0])
        if np.median(speed) < min_speed or P[:, 3].mean() < min_area_mean:
            continue
        good.append((len(P) * np.median(P[:, 3]) ** 0.5, P))

    best = {}
    for score, P in good:
        for row in P:
            t = int(row[0])
            if t not in best or score > best[t][0]:
                best[t] = (score, (float(row[1]), float(row[2])))
    traj = {t: v[1] for t, v in best.items()}
    ts = sorted(traj)
    for a, b in zip(ts, ts[1:]):
        if 1 < b - a <= fill_gap:
            (xa, ya), (xb, yb) = traj[a], traj[b]
            for t in range(a + 1, b):
                r = (t - a) / (b - a)
                traj[t] = (xa + (xb - xa) * r, ya + (yb - ya) * r)
    return traj, len(good)


# ---------------------------------------------------------------- 5 渲染

def draw_text(img, text, org, scale, color, thick):
    cv2.putText(img, text, org, cv2.FONT_HERSHEY_SIMPLEX, scale, (0, 0, 0), thick + 3, cv2.LINE_AA)
    cv2.putText(img, text, org, cv2.FONT_HERSHEY_SIMPLEX, scale, color, thick, cv2.LINE_AA)


def render(video, out, times, w, h, traj, hit_frames, trail=14):
    n = len(times)
    dt = float(np.median(np.diff(times))) if n > 1 else 1 / 30
    rate = (n - 1) / (times[-1] - times[0]) if n > 1 else 30.0  # 按真实平均帧率输出，避免累积漂移
    cmd = ["ffmpeg", "-v", "error", "-y",
           "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{w}x{h}", "-r", f"{rate:.6f}", "-i", "-",
           "-ss", f"{times[0]:.4f}", "-t", f"{times[-1] - times[0] + dt:.4f}", "-i", video,
           "-map", "0:v", "-map", "1:a:0?", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
           "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", out]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    hit_set = set()
    for hf in hit_frames:
        hit_set.update(range(hf, hf + 6))
    for t, f in enumerate(read_frames(video, times, 0, n, w, h)):
        pts = [traj[k] for k in range(t - trail, t + 1) if k in traj]
        for i in range(1, len(pts)):
            a = tuple(map(int, pts[i - 1]))
            b = tuple(map(int, pts[i]))
            if np.hypot(a[0] - b[0], a[1] - b[1]) < 200:
                cv2.line(f, a, b, (0, 255, 255), max(1, int(4 * i / len(pts))), cv2.LINE_AA)
        if t in traj:
            cv2.circle(f, tuple(map(int, traj[t])), 14, (0, 0, 255), 3, cv2.LINE_AA)
        if t in hit_set:
            draw_text(f, "HIT (audio)", (40, h - 40), 1.4, (0, 140, 255), 3)
        draw_text(f, "ball: frame-diff + tracking, no trained model", (40, 60), 1.0, (255, 255, 255), 2)
        proc.stdin.write(f.tobytes())
    proc.stdin.close()
    proc.wait()


# ---------------------------------------------------------------- main

def parse_zone(s):
    vals = [float(v) for v in s.split(",")]
    if len(vals) != 4:
        raise argparse.ArgumentTypeError("格式应为 x1,y1,x2,y2（像素）")
    return tuple(vals)


def main():
    ap = argparse.ArgumentParser(description="乒乓球球轨迹识别 + 叠加渲染（帧差分 + 跟踪，无需训练）")
    ap.add_argument("video")
    ap.add_argument("-o", "--output", help="输出视频，默认 <原文件名>_ball_track.mp4")
    ap.add_argument("--start", type=float, default=0, help="从第几秒开始处理")
    ap.add_argument("--duration", type=float, help="处理多少秒，默认到结尾")
    ap.add_argument("--exclude", type=parse_zone, action="append", default=[],
                    help="排除区域 x1,y1,x2,y2（像素，可多次指定），例如地面上散球滚动的区域")
    ap.add_argument("--hits", action="store_true", help="叠加声音检测到的击球时刻，并统计回合内的识别覆盖率")
    ap.add_argument("--workers", type=int, default=max(1, (os.cpu_count() or 2)), help="并行进程数")
    ap.add_argument("--json", help="把逐帧球坐标存成 JSON，默认 <输出名>.json")
    ap.add_argument("--no-render", action="store_true", help="只输出 JSON，不渲染视频")
    # 检测参数
    ap.add_argument("--diff", type=int, default=18, help="帧差阈值（灰度）")
    ap.add_argument("--min-area", type=int, default=4)
    ap.add_argument("--max-area", type=int, default=300)
    ap.add_argument("--max-side", type=int, default=45, help="候选斑点最长边（像素），运动模糊会拉长球")
    ap.add_argument("--min-v", type=int, default=150, help="最低亮度（HSV 的 V），白球偏亮")
    ap.add_argument("--max-s", type=int, default=90, help="最高饱和度（HSV 的 S），白球偏灰白")
    ap.add_argument("--merge", type=int, default=31, help="合并运动像素的膨胀核大小，用来识别'人'")
    args = ap.parse_args()

    total, w, h, fps = probe(args.video)
    dur = args.duration if args.duration else total - args.start
    dur = min(dur, total - args.start)
    times = frame_times(args.video, args.start, dur)
    n = len(times)
    if n < 3:
        sys.exit("这个时间段里没有足够的视频帧")
    real_fps = (n - 1) / (times[-1] - times[0])
    out = args.output or f"{os.path.splitext(args.video)[0]}_ball_track.mp4"
    json_out = args.json or os.path.splitext(out)[0] + ".json"
    print(f"视频 {w}x{h}，标称 {fps:.2f}fps / 实测 {real_fps:.2f}fps，"
          f"处理 {args.start:.1f}s 起 {dur:.1f}s（{n} 帧），{args.workers} 进程")

    params = dict(diff=args.diff, min_area=args.min_area, max_area=args.max_area, max_side=args.max_side,
                  min_v=args.min_v, max_s=args.max_s, merge=args.merge)
    step = max(1, n // args.workers + 1)
    jobs = [(args.video, times, w, h, s, min(n - 1, s + step - 1), params) for s in range(0, n, step)]
    det = {}
    with Pool(len(jobs)) as pool:
        for part in pool.imap_unordered(detect_range, jobs):
            det.update(part)
    print(f"检测：{sum(bool(v) for v in det.values())}/{n} 帧有候选点，共 {sum(len(v) for v in det.values())} 个")

    traj, n_tracks = track(det, n, args.exclude)
    print(f"跟踪：保留 {n_tracks} 条有效轨迹，{len(traj)}/{n} 帧（{len(traj) / n:.0%}）定位到球")

    def to_frame(abs_t):  # 绝对时间 → 最近的帧号（查真实时间表）
        i = int(np.clip(np.searchsorted(times, abs_t), 1, n - 1))
        return i if abs(times[i] - abs_t) < abs(times[i - 1] - abs_t) else i - 1

    hit_frames = []
    if args.hits:
        x, sr = extract_audio(args.video, start=float(times[0]), duration=float(times[-1] - times[0]))
        hit_t = [float(times[0]) + t for t, _ in detect_hits(x, sr)]
        hit_frames = [to_frame(t) for t in hit_t]
        rally_frames = set()
        for r in group_rallies(hit_t):
            if r["hits"] >= 2:
                rally_frames.update(range(to_frame(r["start"]) - 10, to_frame(r["end"]) + 21))
        rally_frames &= set(range(n))
        if rally_frames:
            cov = np.mean([t in traj for t in rally_frames])
            print(f"声音检测到 {len(hit_t)} 次击球；回合进行中 {cov:.0%} 的帧定位到球")

    with open(json_out, "w") as f:
        json.dump({"video": os.path.abspath(args.video),
                   "note": "frames: 片段内帧号 -> [x, y, 该帧在原视频中的时间(秒)]",
                   "frames": {str(t): [round(x, 1), round(y, 1), round(float(times[t]), 4)]
                              for t, (x, y) in sorted(traj.items())},
                   "hit_times": [round(float(times[i]), 4) for i in hit_frames]}, f)
    print(f"轨迹坐标：{json_out}")

    if not args.no_render:
        render(args.video, out, times, w, h, traj, hit_frames)
        print(f"叠加视频：{out}")


if __name__ == "__main__":
    sys.exit(main())
