"""高光任务的处理管线：规则层（声音 → 回合 → 候选分）+ 大模型复核 + 导出。

三层分工见技术方案：
  * 规则层：击球检测、回合切分、候选窗口、缩略图、ffmpeg 剪辑（本文件）
  * 小模型层：球轨迹、球台标定（暂未接入，后续替换 ball_track.py 的规则版）
  * 大模型层：疑难分判输赢、区分练习（llm.py，Key 为空时跳过）
"""
import json
import os
import subprocess
import sys
import threading
import time
import uuid

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from common import audio_stream, detect_hits, extract_audio, group_rallies, probe  # noqa: E402

import llm  # noqa: E402
import speed  # noqa: E402

DATA_DIR = os.environ.get("DATA_DIR", os.path.join(os.path.dirname(os.path.abspath(__file__)), "data"))

STEPS = ["上传完成", "击球检测", "回合切分", "生成缩略图", "大模型复核", "待确认"]

# 候选窗口：回合第一拍前 1.5s（包含抛球）到最后一拍后 1.5s
LEAD_S = 1.5
TAIL_S = 1.5
# 判输赢用的缩略图：最后一拍前 3s 到后 1.5s，0.5s 一帧，3x3 拼图
SHEET_BEFORE_S = 3.0
SHEET_AFTER_S = 1.5

WINNERS = {"unknown", "me", "coach", "practice", "unclear"}


class JobStore:
    """任务都存在 DATA_DIR/<id>/job.json，进程重启后还能读回来。"""

    def __init__(self, root=DATA_DIR):
        self.root = root
        self.lock = threading.Lock()
        os.makedirs(root, exist_ok=True)

    def dir(self, job_id):
        return os.path.join(self.root, job_id)

    def path(self, job_id, *parts):
        return os.path.join(self.dir(job_id), *parts)

    def create(self, filename, me_side, min_hits):
        job_id = uuid.uuid4().hex[:12]
        os.makedirs(self.path(job_id, "sheets"), exist_ok=True)
        os.makedirs(self.path(job_id, "previews"), exist_ok=True)
        job = {
            "id": job_id,
            "filename": filename,
            "created": time.time(),
            "status": "uploading",
            "step": 0,
            "steps": STEPS,
            "progress": 0.0,
            "error": None,
            "params": {"me_side": me_side, "min_hits": min_hits},
            "video": None,
            "hits": 0,
            "candidates": [],
            "llm": {"enabled": llm.enabled()},
            "export": None,
            "calibration": None,
            "speeds": None,
        }
        self.save(job)
        return job

    def load(self, job_id):
        p = self.path(job_id, "job.json")
        if not os.path.exists(p):
            return None
        with open(p, encoding="utf-8") as f:
            return json.load(f)

    def save(self, job):
        p = self.path(job["id"], "job.json")
        tmp = p + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(job, f, ensure_ascii=False, indent=1)
        os.replace(tmp, p)

    def update(self, job_id, fn):
        with self.lock:
            job = self.load(job_id)
            fn(job)
            self.save(job)
            return job

    def list(self):
        jobs = []
        for name in os.listdir(self.root):
            job = self.load(name)
            if job:
                jobs.append(job)
        return sorted(jobs, key=lambda j: j["created"], reverse=True)


store = JobStore()


def _ffmpeg(args):
    subprocess.run(["ffmpeg", "-v", "error", "-y"] + args, check=True, capture_output=True)


def make_sheet(video, start, out_path, duration=SHEET_BEFORE_S + SHEET_AFTER_S):
    """从 start 起每 0.5s 取一帧，拼成 3x3 缩略图。"""
    _ffmpeg(["-ss", f"{max(0, start):.3f}", "-t", f"{duration:.3f}", "-i", video,
             "-vf", "fps=2,scale=480:-2,tile=3x3", "-frames:v", "1", "-q:v", "4", out_path])


RATIOS = {"9:16": (9, 16), "16:9": (16, 9), "1:1": (1, 1)}
QUALITIES = {"720p": 720, "1080p": 1080}


def export_filter(ratio=None, quality=None):
    """成片的画面比例（居中裁切）和清晰度（短边像素，不放大）。都为空时返回 None，保持原画。
    用 ffmpeg 表达式而不是 probe 出的宽高，竖拍视频带旋转信息时也对。"""
    vf = []
    if ratio in RATIOS:
        a, b = RATIOS[ratio]
        vf.append(f"crop=w='trunc(min(iw,ih*{a}/{b})/2)*2':h='trunc(min(ih,iw*{b}/{a})/2)*2'")
    q = QUALITIES.get(quality)
    if q:
        vf.append(f"scale=w='if(gte(iw,ih),-2,min(iw,{q}))':h='if(gte(iw,ih),min(ih,{q}),-2)'")
    return ",".join(vf) or None


def cut_clip(video, start, end, out_path, height=None, crf=20, vf=None):
    """精确剪切（重编码）。height 不为空时缩小，用于手机预览；vf 为成片的裁切/缩放滤镜。
    显式选音轨：ffmpeg 默认挑声道最多的那条，iPhone 上会选中解不了的 APAC。"""
    vf = ["-vf", vf] if vf else ["-vf", f"scale=-2:{height}"] if height else []
    a = audio_stream(video)
    maps = ["-map", "0:v:0"] + (["-map", f"0:a:{a}"] if a is not None else [])
    _ffmpeg(["-ss", f"{max(0, start):.3f}", "-i", video, "-t", f"{end - start:.3f}"] + maps + vf +
            ["-c:v", "libx264", "-preset", "veryfast", "-crf", str(crf), "-pix_fmt", "yuv420p",
             "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", out_path])


def run_job(job_id):
    try:
        _run(job_id)
    except Exception as e:  # noqa: BLE001 — 任务失败要写回状态给 App 看
        def fail(j):
            j["status"] = "failed"
            j["error"] = f"{type(e).__name__}: {e}"
        store.update(job_id, fail)


def _set(job_id, **kw):
    store.update(job_id, lambda j: j.update(kw))


def _run(job_id):
    job = store.load(job_id)
    video = store.path(job_id, job["video"])
    duration, w, h, fps = probe(video)
    _set(job_id, status="processing", step=1, progress=0.05,
         meta={"duration": duration, "width": w, "height": h, "fps": fps})

    # 规则层 1：击球检测（音频 spectral flux）
    x, sr = extract_audio(video)
    hits = [t for t, _ in detect_hits(x, sr)]
    del x
    _set(job_id, step=2, progress=0.35, hits=len(hits))

    # 规则层 2：回合切分。窗口前推到抛球，后延到死球
    rallies = [r for r in group_rallies(hits) if r["hits"] >= job["params"]["min_hits"]]
    candidates = []
    for i, r in enumerate(rallies):
        candidates.append({
            "n": i,
            "start": round(max(0.0, r["start"] - LEAD_S), 2),
            "end": round(min(duration, r["end"] + TAIL_S), 2),
            "last_hit": round(r["end"], 2),
            "hits": r["hits"],
            "hit_times": [round(t, 3) for t in r["times"]],
            "score": round(r["hits"] ** 1.5, 2),
            # 规则版谁得分需要球台标定 + 落点，目前还没有，先标 unknown
            "rule": {"winner": "unknown", "reason": "未标定球台，规则层暂不判胜负"},
            "llm": {"status": "pending" if llm.enabled() else "skipped_no_key"},
            "winner": "unknown",
            "confirmed": False,
        })
    _set(job_id, step=3, progress=0.45, candidates=candidates)

    # 规则层 3：每个候选分生成判输赢用的缩略图
    for k, c in enumerate(candidates):
        make_sheet(video, c["last_hit"] - SHEET_BEFORE_S, store.path(job_id, "sheets", f"{c['n']}.jpg"))
        _set(job_id, progress=0.45 + 0.3 * (k + 1) / max(1, len(candidates)))

    # 大模型层：Key 为空就跳过，全部交给人工确认
    _set(job_id, step=4, progress=0.75)
    if llm.enabled():
        for k, c in enumerate(candidates):
            res = llm.judge_point(store.path(job_id, "sheets", f"{c['n']}.jpg"), job["params"]["me_side"])

            def apply(j, n=c["n"], res=res):
                cand = j["candidates"][n]
                cand["llm"] = res
                if res.get("status") == "agreed" and not cand["confirmed"]:
                    cand["winner"] = res["winner"]
            store.update(job_id, apply)
            _set(job_id, progress=0.75 + 0.2 * (k + 1) / max(1, len(candidates)))

    _set(job_id, status="review", step=5, progress=1.0)
    if store.load(job_id).get("calibration"):
        start_speeds(job_id)


# ---------------------------------------------------------------- 球速（规则 + 物理拟合，见 speed.py）

def start_speeds(job_id):
    """有标定、处理完成后，在后台估算每个候选分的球速。
    重新标定会再跑一遍：gen 加一，旧线程写回前发现 gen 变了就作废，不会覆盖新结果。"""
    holder = {}

    def init(j):
        g = (j.get("speeds") or {}).get("gen", 0) + 1
        j["speeds"] = {"status": "running", "progress": 0.0, "gen": g, "warnings": [], "error": None}
        for c in j["candidates"]:
            c.pop("speed", None)
        holder["gen"] = g
    store.update(job_id, init)
    threading.Thread(target=_run_speeds, args=(job_id, holder["gen"]), daemon=True).start()


def clear_speeds(job_id):
    def clear(j):
        g = (j.get("speeds") or {}).get("gen", 0) + 1
        j["speeds"] = {"status": "idle", "gen": g}
        for c in j["candidates"]:
            c.pop("speed", None)
    store.update(job_id, clear)


def _run_speeds(job_id, gen):
    def guarded(fn):
        def apply(j):
            if (j.get("speeds") or {}).get("gen") == gen:
                fn(j)
        store.update(job_id, apply)

    try:
        job = store.load(job_id)
        video = store.path(job_id, job["video"])
        cal = job["calibration"]
        pose = speed.camera_pose(cal)
        guarded(lambda j: j["speeds"].update(warnings=pose["warnings"]))
        hits_all = None
        # 已标“我赢”的先算，用户最先看到的就是自己的球
        order = sorted(job["candidates"], key=lambda c: (c["winner"] != "me", c["n"]))
        for k, c in enumerate(order):
            hits = c.get("hit_times")
            if hits is None:  # 旧任务没存击球时刻，补算一次
                if hits_all is None:
                    x, sr = extract_audio(video)
                    hits_all = [t for t, _ in detect_hits(x, sr)]
                hits = [h for h in hits_all if c["start"] - 0.1 <= h <= c["last_hit"] + 0.01]
            try:
                res = speed.estimate_point(video, cal, job["params"]["me_side"], hits, pose)
            except Exception as e:  # noqa: BLE001 — 单个分出错不影响其他分
                res = {"status": "none", "reason": f"计算出错：{type(e).__name__}"}

            def apply(j, n=c["n"], res=res, k=k):
                j["candidates"][n]["speed"] = res
                j["speeds"]["progress"] = (k + 1) / len(order)
            guarded(apply)
        guarded(lambda j: j["speeds"].update(status="done", progress=1.0))
    except Exception as e:  # noqa: BLE001
        guarded(lambda j: j["speeds"].update(status="failed", error=f"{type(e).__name__}: {e}"))


def with_fastest(job):
    """最快一板：只在标为“我赢”的分里选，取估算值最大的。"""
    best = None
    for c in job.get("candidates", []):
        sp = c.get("speed") or {}
        if c["winner"] == "me" and sp.get("status") == "ok" and (best is None or sp["kmh"] > best["kmh"]):
            best = {"n": c["n"], **{k: sp[k] for k in ("kmh", "kmh_low", "kmh_high", "confidence")}}
    job["fastest"] = best
    return job


def preview_path(job_id, n):
    """单个候选分的 720p 预览，第一次请求时生成并缓存。"""
    out = store.path(job_id, "previews", f"{n}.mp4")
    if not os.path.exists(out):
        job = store.load(job_id)
        c = job["candidates"][n]
        cut_clip(store.path(job_id, job["video"]), c["start"], c["end"], out, height=720, crf=24)
    return out


def run_export(job_id, include, clips=None, ratio=None, quality=None):
    """把选中的候选分剪出来拼成一条成片。
    clips 为 App 编辑后的片段（顺序、起止时间）；为空时按 include 里的结果、按时间顺序全选。"""
    try:
        job = store.load(job_id)
        video = store.path(job_id, job["video"])
        if clips:
            by_n = {c["n"]: c for c in job["candidates"]}
            chosen = [{"start": max(0.0, c["start"]), "end": c["end"]} for c in clips
                      if c["n"] in by_n and c["end"] - c["start"] >= 0.3]
        else:
            chosen = [c for c in job["candidates"] if c["winner"] in include]
        if not chosen:
            raise ValueError("没有符合条件的片段，请先确认至少一个得分球")
        vf = export_filter(ratio, quality)
        parts_dir = store.path(job_id, "parts")
        os.makedirs(parts_dir, exist_ok=True)
        parts = []
        for k, c in enumerate(chosen):
            p = os.path.join(parts_dir, f"{k:03d}.mp4")
            cut_clip(video, c["start"], c["end"], p, crf=18, vf=vf)
            parts.append(p)

            def prog(j, k=k):
                j["export"]["progress"] = (k + 1) / len(chosen) * 0.95
            store.update(job_id, prog)
        lst = os.path.join(parts_dir, "list.txt")
        with open(lst, "w") as f:
            f.writelines(f"file '{p}'\n" for p in parts)
        out = store.path(job_id, "clip.mp4")
        _ffmpeg(["-f", "concat", "-safe", "0", "-i", lst, "-c", "copy", "-movflags", "+faststart", out])
        total = sum(c["end"] - c["start"] for c in chosen)

        def done(j):
            j["export"].update(status="done", progress=1.0, clips=len(chosen), duration=round(total, 1))
        store.update(job_id, done)
    except Exception as e:  # noqa: BLE001
        def fail(j):
            j["export"].update(status="failed", error=f"{type(e).__name__}: {e}")
        store.update(job_id, fail)
