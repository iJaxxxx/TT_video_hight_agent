"""高光剪辑服务端。App 上传视频，这里跑处理管线，再把候选分和成片返回给 App。

启动（在 server/ 目录下）：
  .venv/bin/uvicorn main:app --host 0.0.0.0 --port 8000
"""
import os
import shutil
import threading

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel


def _load_env(path=os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")):
    """读 server/.env（不覆盖已有的环境变量），免得多装一个 dotenv 依赖。"""
    if not os.path.exists(path):
        return
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip())


_load_env()

import calibrate  # noqa: E402
import llm  # noqa: E402
import pipeline  # noqa: E402
from pipeline import WINNERS, store  # noqa: E402

app = FastAPI(title="TT Highlight Server")
# 手机 App 不受 CORS 限制；这是给浏览器里调试 App（expo start --web）用的
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


def _job_or_404(job_id):
    job = store.load(job_id)
    if not job:
        raise HTTPException(404, "任务不存在")
    return job


@app.get("/health")
def health():
    return {"ok": True, "llm_enabled": llm.enabled()}


@app.get("/jobs")
def list_jobs():
    return [{k: j[k] for k in ("id", "filename", "created", "status", "progress")} | {"count": len(j["candidates"])}
            for j in store.list()]


@app.post("/jobs")
def create_job(file: UploadFile = File(...), me_side: str = Form("far"), min_hits: int = Form(2)):
    if me_side not in ("far", "near"):
        raise HTTPException(400, "me_side 只能是 far 或 near")
    job = store.create(file.filename or "video.mov", me_side, max(1, min_hits))
    ext = os.path.splitext(file.filename or "")[1].lower() or ".mov"
    name = "source" + ext
    with open(store.path(job["id"], name), "wb") as out:
        shutil.copyfileobj(file.file, out, length=8 * 1024 * 1024)
    job = store.update(job["id"], lambda j: j.update(video=name, status="queued"))
    threading.Thread(target=pipeline.run_job, args=(job["id"],), daemon=True).start()
    return job


@app.get("/jobs/{job_id}")
def get_job(job_id: str):
    return pipeline.with_fastest(_job_or_404(job_id))


@app.delete("/jobs/{job_id}")
def delete_job(job_id: str):
    _job_or_404(job_id)
    shutil.rmtree(store.dir(job_id), ignore_errors=True)
    return {"ok": True}


@app.get("/jobs/{job_id}/candidates/{n}/sheet.jpg")
def sheet(job_id: str, n: int):
    p = store.path(job_id, "sheets", f"{n}.jpg")
    if not os.path.exists(p):
        raise HTTPException(404, "缩略图还没生成")
    return FileResponse(p, media_type="image/jpeg")


@app.get("/jobs/{job_id}/candidates/{n}/preview.mp4")
def preview(job_id: str, n: int):
    job = _job_or_404(job_id)
    if not 0 <= n < len(job["candidates"]):
        raise HTTPException(404, "没有这个候选分")
    return FileResponse(pipeline.preview_path(job_id, n), media_type="video/mp4")


class Verdict(BaseModel):
    winner: str


@app.post("/jobs/{job_id}/candidates/{n}")
def set_winner(job_id: str, n: int, v: Verdict):
    if v.winner not in WINNERS:
        raise HTTPException(400, f"winner 只能是 {sorted(WINNERS)}")
    job = _job_or_404(job_id)
    if not 0 <= n < len(job["candidates"]):
        raise HTTPException(404, "没有这个候选分")

    def apply(j):
        c = j["candidates"][n]
        c["winner"] = v.winner
        c["confirmed"] = v.winner != "unknown"
    return store.update(job_id, apply)["candidates"][n]


@app.post("/jobs/{job_id}/speeds")
def rerun_speeds(job_id: str):
    job = _job_or_404(job_id)
    if not job.get("calibration"):
        raise HTTPException(409, "请先标定球台")
    if job["status"] != "review":
        raise HTTPException(409, "处理还没完成")
    pipeline.start_speeds(job_id)
    return store.load(job_id)["speeds"]


@app.get("/jobs/{job_id}/frame.jpg")
def frame(job_id: str, t: float = 0.5):
    """标定用的画面。t 可调，避开球员挡住球台角的时刻。"""
    job = _job_or_404(job_id)
    if not job.get("video"):
        raise HTTPException(409, "视频还没上传完")
    full, small = calibrate.frame_paths(store, job_id, t)
    if not os.path.exists(small):
        try:
            calibrate.extract_frame(store.path(job_id, job["video"]), t, full, small)
        except Exception as e:  # noqa: BLE001
            raise HTTPException(400, str(e))
    return FileResponse(small, media_type="image/jpeg")


class CalibrationReq(BaseModel):
    corners: list[list[float]]
    t: float = 0.5


@app.post("/jobs/{job_id}/calibration")
def set_calibration(job_id: str, req: CalibrationReq):
    job = _job_or_404(job_id)
    if not job.get("video"):
        raise HTTPException(409, "视频还没上传完")
    full, small = calibrate.frame_paths(store, job_id, req.t)
    if not os.path.exists(full):
        calibrate.extract_frame(store.path(job_id, job["video"]), req.t, full, small)
    h, w = calibrate.cv2.imread(full).shape[:2]
    try:
        calib = calibrate.solve(req.corners, w, h)
    except ValueError as e:
        raise HTTPException(400, str(e))
    calib["t"] = req.t
    calibrate.draw_check(calib, full, store.path(job_id, "calibration.jpg"))
    job = store.update(job_id, lambda j: j.update(calibration=calib))
    if job["status"] == "review":  # 处理已完成：标定一变就重算球速；还在处理的，处理完会自己算
        pipeline.start_speeds(job_id)
    return job["calibration"]


@app.delete("/jobs/{job_id}/calibration")
def clear_calibration(job_id: str):
    _job_or_404(job_id)
    store.update(job_id, lambda j: j.update(calibration=None))
    pipeline.clear_speeds(job_id)
    return None


@app.get("/jobs/{job_id}/calibration.jpg")
def calibration_check(job_id: str):
    p = store.path(job_id, "calibration.jpg")
    if not os.path.exists(p) or not (store.load(job_id) or {}).get("calibration"):
        raise HTTPException(404, "还没有标定")
    return FileResponse(p, media_type="image/jpeg")


class ExportReq(BaseModel):
    include: list[str] = ["me"]


@app.post("/jobs/{job_id}/export")
def export(job_id: str, req: ExportReq):
    job = _job_or_404(job_id)
    if job["status"] != "review":
        raise HTTPException(409, "处理还没完成")
    if job.get("export") and job["export"].get("status") == "running":
        raise HTTPException(409, "正在导出")
    store.update(job_id, lambda j: j.update(export={"status": "running", "progress": 0.0, "include": req.include}))
    threading.Thread(target=pipeline.run_export, args=(job_id, set(req.include)), daemon=True).start()
    return store.load(job_id)["export"]


@app.get("/jobs/{job_id}/clip.mp4")
def clip(job_id: str):
    p = store.path(job_id, "clip.mp4")
    job = _job_or_404(job_id)
    if not (job.get("export") or {}).get("status") == "done" or not os.path.exists(p):
        raise HTTPException(404, "成片还没导出")
    return FileResponse(p, media_type="video/mp4", filename=f"highlight_{job_id}.mp4")
