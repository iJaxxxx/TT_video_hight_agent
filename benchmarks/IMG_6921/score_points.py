#!/usr/bin/env python3
"""按“学员（远端）的得分球”重新评各工具，并分析 TTcut 落台落在哪半台。

输入（本目录）：
  point_sheets/index.json      两段对打里每一分的起止（来自视觉真值）
  point_labels_{A,B}.json      子代理判的输赢
  point_labels_user.json       用户确认/改判（可选，优先级最高）
  ttcut_bounce_positions.json  TTcut 每次落台的球台坐标（可选）
输出：points_metrics.json，并打印汇总

一分“被剪到”= 某个片段盖住了这一分结束前 0.5 秒（决定胜负的那一板附近）。
用法（仓库根目录）：python3 benchmarks/IMG_6921/score_points.py
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import compare as C  # noqa: E402

MATCH = [(0, 127), (375, C.DURATION)]


def load(name):
    p = os.path.join(HERE, name)
    return json.load(open(p)) if os.path.exists(p) else None


def points():
    idx = {p["point"]: p for p in load("point_sheets/index.json")}
    for name in ("point_labels_A.json", "point_labels_B.json", "point_labels_user.json"):
        d = load(name)
        for lab in (d or {}).get("points", []):
            idx[lab["point"]].update({k: v for k, v in lab.items() if k != "point"},
                                     source=name.replace("point_labels_", "").replace(".json", ""))
    return list(idx.values())


def covers(clips, t):
    return any(s <= t <= e for s, e in clips)


def in_match(s, e):
    return any(e > lo and s < hi for lo, hi in MATCH)


def main():
    pts = points()
    student = [p for p in pts if p.get("winner") == "student" and p.get("how") != "not_a_point"]
    coach = [p for p in pts if p.get("winner") == "coach" and p.get("how") != "not_a_point"]
    unclear = [p for p in pts if p.get("winner") not in ("student", "coach") or p.get("how") == "not_a_point"]
    print(f"对打共 {len(pts)} 分：学员得分 {len(student)}，教练得分 {len(coach)}，未定/非比赛 {len(unclear)}")

    out = {"points": pts, "tools": {}}
    for k, v in C.tools().items():
        clips = [c for c in v["clips"] if in_match(*c)]
        got_s = [p["point"] for p in student if covers(clips, p["end"] - 0.5)]
        got_c = [p["point"] for p in coach if covers(clips, p["end"] - 0.5)]
        with_student = [c for c in clips if any(c[0] <= p["end"] - 0.5 <= c[1] for p in student)]
        kept = sum(min(e, hi) - max(s, lo) for s, e in clips for lo, hi in MATCH if e > lo and s < hi)
        m = {
            "student_points_captured": f"{len(got_s)}/{len(student)}",
            "student_recall": round(len(got_s) / len(student), 3) if student else None,
            "coach_points_captured": f"{len(got_c)}/{len(coach)}",
            "clips_in_match": len(clips),
            "clips_with_student_point": len(with_student),
            "clip_precision_student": round(len(with_student) / len(clips), 3) if clips else None,
            "kept_s_in_match": round(kept, 1),
            "seconds_per_student_point": round(kept / len(got_s), 1) if got_s else None,
            "captured": got_s,
        }
        out["tools"][k] = m
        print(f"{k:24s} 学员得分 {m['student_points_captured']:>6}  教练得分 {m['coach_points_captured']:>6}  "
              f"片段 {len(clips):>2}（含学员得分 {len(with_student)}）  对打段保留 {kept:5.0f}s")

    # TTcut 的“落台”事件实际是什么（按画面网线分边 + 网后逐张目测，见 ttcut_bounce_review.json）
    d = load("ttcut_bounce_review.json")
    if d:
        ev = d["events"]
        kinds = {}
        for x in ev:
            kinds[x["visual"]] = kinds.get(x["visual"], 0) + 1
        out["ttcut_events"] = kinds
        print(f"\nTTcut 落台事件 {len(ev)} 个：{kinds}")
        for p in student + coach:
            p["ttcut_events"] = [(x["time"], x["visual"]) for x in ev if p["start"] - 0.5 <= x["time"] <= p["end"] + 0.5]
    json.dump(out, open(os.path.join(HERE, "points_metrics.json"), "w"), ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
