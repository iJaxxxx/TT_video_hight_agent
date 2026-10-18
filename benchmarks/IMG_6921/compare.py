#!/usr/bin/env python3
"""对比各工具在 IMG_6921 上的回合切分效果。

读取本目录下各工具的输出和人工（视觉）标注 gt_labels_*.json，输出：
  metrics.json  每个工具的指标
  timeline.png  全片时间轴对比图

每个工具都按它自己“导出片段”的方式加前后余量，再和真值比：
  ours           highlight.py 的回合（≥2 拍），前后各加 0.5s（它本身不导出回合，仅作参照）
  TTLab          rally start/end 已含 0.8s/0.3s 余量，直接用
  TTcut          App 默认 pre_roll 2.5s、post_roll 1s，落台模式再加 1s 尾巴，重叠的合并
  PingPongVision clip_buffer_before/after 0.5s

用法（在仓库根目录）：python3 benchmarks/IMG_6921/compare.py
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", ".."))
from common import group_rallies  # noqa: E402

DURATION = 551.3


def load(name):
    path = os.path.join(HERE, name)
    return json.load(open(path)) if os.path.exists(path) else None


def merge(intervals, gap=0.0):
    out = []
    for s, e in sorted(intervals):
        if out and s <= out[-1][1] + gap:
            out[-1][1] = max(out[-1][1], e)
        else:
            out.append([s, e])
    return [tuple(x) for x in out]


def pad(intervals, before, after):
    return merge([(max(0.0, s - before), min(DURATION, e + after)) for s, e in intervals])


# ---------------------------------------------------------------- 真值

def ground_truth():
    labels = []
    for k in "ABC":
        d = load(f"gt_labels_{k}.json")
        if d:
            labels += [(float(x["t"]), x["l"]) for x in d["labels"]]
    labels.sort()
    runs, cur = [], None
    for t, l in labels:
        if l == "R":
            if cur and t - cur[1] <= 0.5 + 1e-6:  # 只连续的 R 算同一回合；夹着 D 的两段是两次独立的球
                cur[1] = t
            else:
                cur = [t, t]
                runs.append(cur)
    return [(s - 0.25, e + 0.25) for s, e in runs], len(labels)


# ---------------------------------------------------------------- 各工具

def tools():
    out = {}
    d = load("ours_hits.json")
    if d:
        rallies = [r for r in group_rallies([t for t, _ in d["hits"]], 1.5) if r["hits"] >= 2]
        raw = [(r["start"], r["end"]) for r in rallies]
        out["ours (audio)"] = {"raw": raw, "clips": pad(raw, 0.5, 0.5),
                               "score": {(r["start"], r["end"]): r["hits"] for r in rallies},
                               "runtime_s": 6.0}
    d = load("ttlab_full.json")
    if d:
        raw = [(r["start_time"], r["end_time"]) for r in d["rallies"]]
        out["TTLab"] = {"raw": raw, "clips": merge(raw),
                        "score": {(r["start_time"], r["end_time"]): r["score"] for r in d["rallies"]},
                        "highlight": [(r["start_time"], r["end_time"]) for r in d["rallies"] if r["is_highlight"]],
                        "runtime_s": d["runtime_s"]}
    for method, key, tail in (("bounce", "TTcut 落台", 1.0), ("visibility", "TTcut 连续运动", 0.0)):
        d = load(f"ttcut_full_{method}.json")
        if d and d["event"] and d["event"]["type"] == "result":
            rs = d["event"]["data"]["rallies"]
            raw = [(r["start_time_seconds"], r["end_time_seconds"]) for r in rs]
            score = {(r["start_time_seconds"], r["end_time_seconds"]):
                     r.get("bounce_count", r["end_time_seconds"] - r["start_time_seconds"]) for r in rs}
            out[key] = {"raw": raw, "clips": pad(raw, 2.5, tail + 1.0), "score": score,
                        "runtime_s": d["runtime_s"]}
    for fname, key in (("ppv_full.json", "PingPongVision"), ("ppv_cv_full.json", "PingPongVision (CV回退)")):
        d = load(fname)
        if d:
            rs = [r for r in d["rallies"] if r.get("is_valid", True)]
            raw = [(r["start_time"], r["end_time"]) for r in rs]
            out[key] = {"raw": raw, "clips": pad(raw, 0.5, 0.5),
                        "score": {(r["start_time"], r["end_time"]): r["board_count"] for r in rs},
                        "runtime_s": d["runtime_s"]}
    return out


# ---------------------------------------------------------------- 指标

def overlap(a, b):
    return max(0.0, min(a[1], b[1]) - max(a[0], b[0]))


def evaluate(clips, gt):
    gt_s = sum(e - s for s, e in gt)
    kept = sum(e - s for s, e in clips)
    covered = sum(overlap(c, g) for c in clips for g in gt)
    detected = [g for g in gt if any(overlap(c, g) > 0 for c in clips)]
    hits_gt = [c for c in clips if any(overlap(c, g) > 0 for g in gt)]
    merged = [c for c in clips if sum(overlap(c, g) > 0 for g in gt) >= 2]
    split = [g for g in gt if sum(overlap(c, g) > 0 for c in clips) >= 2]
    long_gt = [g for g in gt if g[1] - g[0] >= 4.0]
    return {
        "clips": len(clips),
        "kept_s": round(kept, 1),
        "kept_pct": round(100 * kept / DURATION, 1),
        "rally_recall": round(len(detected) / len(gt), 3) if gt else None,
        "long_rally_recall": round(sum(g in detected for g in long_gt) / len(long_gt), 3) if long_gt else None,
        "clip_precision": round(len(hits_gt) / len(clips), 3) if clips else None,
        "time_coverage": round(covered / gt_s, 3) if gt_s else None,
        "dead_time_kept_s": round(kept - covered, 1),
        "clips_merging_2plus_rallies": len(merged),
        "rallies_split_across_clips": len(split),
    }


# 视频里的内容分段（来自标注时的观察）
SECTIONS = [("对打 0:00–2:07", 0, 127), ("发球-接发练习 2:07–3:15", 127, 195),
            ("教练喂球 3:15–6:15", 195, 375), ("对打 6:15–9:11", 375, DURATION)]


def evaluate_section(clips, gt, lo, hi):
    """只看 [lo, hi) 这一段：真值取起点落在段内的回合，片段裁到段内。"""
    gt = [g for g in gt if lo <= g[0] < hi]
    clips = [(max(s, lo), min(e, hi)) for s, e in clips if e > lo and s < hi]
    m = evaluate(clips, gt)
    return {k: m[k] for k in ("rally_recall", "time_coverage", "clip_precision", "dead_time_kept_s", "kept_s")}


def top_pick_quality(tool, gt, n=5):
    """工具按自己的打分取前 n 个回合，看命中了多少个真值里最长的 n 个回合。"""
    if not tool.get("score"):
        return None
    ranked = sorted(tool["score"].items(), key=lambda kv: -kv[1])[:n]
    best_gt = sorted(gt, key=lambda g: -(g[1] - g[0]))[:n]
    picks = [iv for iv, _ in ranked]
    return sum(any(overlap((s - 1, e + 1), g) > 0 for s, e in picks) for g in best_gt)


def plot(gt, ts, path):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    plt.rcParams["font.sans-serif"] = ["PingFang SC", "Heiti SC", "Arial Unicode MS", "DejaVu Sans"]
    rows = [("真值 (视觉标注)", gt, "#222222")] + [
        (k, v["clips"], c) for (k, v), c in zip(ts.items(), ["#4C78A8", "#F58518", "#54A24B", "#72B7B2", "#E45756", "#B279A2"])]
    fig, axes = plt.subplots(2, 1, figsize=(18, 1.0 + 0.55 * len(rows) * 2), gridspec_kw={"height_ratios": [1, 1]})
    for ax, (x0, x1, title) in zip(axes, [(0, DURATION, "全片 0:00–9:11"), (470, DURATION, "放大 7:50–9:11")]):
        for i, (name, ivs, color) in enumerate(rows):
            y = len(rows) - 1 - i
            ax.broken_barh([(s, e - s) for s, e in ivs if e > x0 and s < x1], (y - 0.35, 0.7), color=color)
        ax.set_yticks(range(len(rows)))
        ax.set_yticklabels([r[0] for r in rows][::-1])
        step = 30 if x1 - x0 > 120 else 10
        ticks = range(int(-(-x0 // step) * step), int(x1) + 1, step)
        ax.set_xticks(list(ticks))
        ax.set_xticklabels([f"{t // 60}:{t % 60:02d}" for t in ticks])
        ax.set_xlim(x0, x1)
        ax.set_title(title, loc="left")
        ax.grid(axis="x", alpha=0.3)
    fig.tight_layout()
    fig.savefig(path, dpi=110)


def main():
    gt, n_labels = ground_truth()
    ts = tools()
    report = {"ground_truth": {"labeled_frames": n_labels, "rallies": len(gt),
                               "rally_seconds": round(sum(e - s for s, e in gt), 1),
                               "intervals": [(round(s, 2), round(e, 2)) for s, e in gt]},
              "tools": {}}
    for k, v in ts.items():
        m = evaluate(v["clips"], gt) if gt else {}
        m["raw_intervals"] = len(v["raw"])
        m["runtime_s"] = round(v["runtime_s"], 1)
        m["top5_hits_longest5_gt"] = top_pick_quality(v, gt) if gt else None
        m["by_section"] = {name: evaluate_section(v["clips"], gt, lo, hi) for name, lo, hi in SECTIONS} if gt else {}
        report["tools"][k] = m
    json.dump(report, open(os.path.join(HERE, "metrics.json"), "w"), ensure_ascii=False, indent=1)
    print(json.dumps({k: {kk: vv for kk, vv in m.items() if kk != "by_section"}
                      for k, m in report["tools"].items()}, ensure_ascii=False, indent=1))
    for name, lo, hi in SECTIONS:
        n = sum(1 for g in gt if lo <= g[0] < hi)
        print(f"\n[{name}] 真值回合 {n}")
        for k, m in report["tools"].items():
            print(f"  {k:24s}", m["by_section"].get(name))
    print("GT:", {k: v for k, v in report["ground_truth"].items() if k != "intervals"})
    plot(gt, ts, os.path.join(HERE, "timeline.png"))


if __name__ == "__main__":
    main()
