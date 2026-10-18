"""球速估算：决胜一板的出手速度（km/h），口径与 WTT 转播一致（刚离开球拍时的速度）。

单机位只能拍到球的方向，拍不到远近，所以要靠物理和几何把尺度定下来：
  1. 由球台标定（单应性矩阵）反推相机焦距和位置，得到“台面坐标（米）→ 画面像素”的完整投影；
  2. 找决胜一板：最后一两次击球声之后，朝对方半台飞的那段球轨迹；
  3. 在画面轨迹里找落台（先往下、再弹起的拐点）。落台点在台面上，位置可以精确算出来，
     这是单机位下唯一可靠的尺度锚点；看不到落台就不给数；
  4. 固定落台点，用“重力 + 空气阻力”的飞行模型从落台时刻往回积分，拟合落台前的球轨迹，
     要求投影和画面对得上、过网时高于网、击球时刻球在击球方端线后面，得到击球时刻的速度；
  5. 焦距 ±15%、落台点 ±5cm 各试一遍，给出速度区间，区间越窄可信度越高。

没建模的：旋转带来的马格努斯力。上旋会让球下坠得比重力快，模型会把它当成“离得更近、飞得更慢”，
所以上旋球的估计偏低。这是主要的系统误差。
"""
import math
import os
import sys

import cv2
import numpy as np
from scipy.optimize import least_squares

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from ball_track import detect_range, frame_times, track  # noqa: E402

import calibrate as C  # noqa: E402

G = 9.81
K_DRAG = 0.13          # ρ·Cd·A / 2m，40mm 球、Cd≈0.45
BALL_R = 0.02
NET_CLEAR = 0.1525 + BALL_R
PIX_SIGMA = 3.0        # 球心定位误差（像素），拖影让它比 1 像素大得多
F_PRIOR = 0.74         # 焦距先验：f ≈ 0.74 × 画面宽（手机 1 倍主摄，1080p 防抖裁切后）
CORNER_SIGMA = 6.0     # 用户点角点的误差（像素）
DETECT = dict(diff=18, min_area=4, max_area=300, max_side=45, min_v=150, max_s=90, merge=31)


# ---------------------------------------------------------------- 相机

def _pnp(f, W, H, obj, img):
    Kc = np.array([[f, 0, W / 2], [0, f, H / 2], [0, 0, 1.0]])
    ok, rvec, tvec = cv2.solvePnP(obj, img, Kc, None, flags=cv2.SOLVEPNP_IPPE)
    if not ok:
        return None
    proj, _ = cv2.projectPoints(obj, rvec, tvec, Kc, None)
    err = float(np.sqrt(np.mean(np.sum((proj.reshape(-1, 2) - img) ** 2, axis=1))))
    return err, Kc, rvec, tvec


def camera_pose(cal, f_fixed=None):
    """由球台四个角反推相机：焦距 f、旋转 R、平移 t（主点取画面中心、像素为正方形）。

    4 个角给 8 个约束，相机位置和朝向用掉 6 个，剩下 2 个本可以定焦距。但远端两个角在低机位下
    常被网挡住、点不准，单靠角点解出的焦距会被带偏很多（IMG_6958 上解出 2220px，正常应 ~1420px）。
    所以加一个先验：手机 1 倍主摄约等效 24mm，1080p 防抖裁切后 f ≈ 0.74 × 画面宽，允许 ±15%。
    在先验和角点误差之间取平衡；角点误差仍偏大时给出警告。"""
    W, H = cal["frame_size"]
    obj = np.c_[C.TABLE_CORNERS, np.zeros(4)].astype(np.float64)
    img = np.float64(cal["corners_px"])
    f0 = F_PRIOR * W
    best = None
    for f in ([f_fixed] if f_fixed else np.linspace(0.5 * W, 1.2 * W, 141)):
        r = _pnp(f, W, H, obj, img)
        if not r:
            continue
        cost = (r[0] / CORNER_SIGMA) ** 2 + ((f - f0) / (0.15 * f0)) ** 2
        if best is None or cost < best[0]:
            best = (cost, f, r)
    if best is None:
        raise ValueError("标定的四个角无法还原相机，请重新标定")
    _, f, (err, Kc, rvec, tvec) = best
    R, _ = cv2.Rodrigues(rvec)
    t = tvec.ravel()
    cam = -R.T @ t
    up = 1.0 if cam[2] > 0 else -1.0  # 台面坐标系的 Z 可能朝下，统一用 up 换成“离台面的高度”
    height = up * cam[2]
    warnings = []
    if err > 8:
        warnings.append(f"四个角和手机镜头对不上（误差 {err:.0f}px），远端两个角可能没点准，球速误差会变大")
    if not 0.15 <= height <= 2.5:
        warnings.append(f"相机比台面高 {height:.2f}m，不太合理")
    return {"f": f, "K": Kc, "R": R, "t": t, "cam": cam, "up": up, "height": height,
            "reproj_px": err, "warnings": warnings}


def project(pose, P):
    X = (pose["R"] @ np.asarray(P, np.float64).T).T + pose["t"]
    uv = (pose["K"] @ X.T).T
    return uv[:, :2] / uv[:, 2:3]


# ---------------------------------------------------------------- 飞行模型

def _accel(v, up):
    return np.array([0.0, 0.0, -G * up]) - K_DRAG * np.linalg.norm(v) * v


def simulate_back(p_b, v_b, t_b, t_min, up, dt=0.003):
    """从落台时刻往回积分到 t_min，返回（时间升序）times、位置、速度。"""
    n = max(1, int(math.ceil((t_b - t_min) / dt)))
    h = -(t_b - t_min) / n
    ts, ps, vs = [t_b], [np.array(p_b, float)], [np.array(v_b, float)]
    p, v = ps[0], vs[0]
    for _ in range(n):
        k1v, k1p = _accel(v, up), v
        k2v, k2p = _accel(v + 0.5 * h * k1v, up), v + 0.5 * h * k1v
        k3v, k3p = _accel(v + 0.5 * h * k2v, up), v + 0.5 * h * k2v
        k4v, k4p = _accel(v + h * k3v, up), v + h * k3v
        v = v + h / 6 * (k1v + 2 * k2v + 2 * k3v + k4v)
        p = p + h / 6 * (k1p + 2 * k2p + 2 * k3p + k4p)
        ts.append(ts[-1] + h)
        ps.append(p)
        vs.append(v)
    return np.array(ts[::-1]), np.array(ps[::-1]), np.array(vs[::-1])


def _interp(ts, arr, t):
    return np.stack([np.interp(t, ts, arr[:, i]) for i in range(3)], axis=-1)


def ray_to_plane(pose, uv, height):
    """像素 → 射线，与“离台面 height 米”的水平面相交，返回台面坐标。"""
    d = pose["R"].T @ (np.linalg.inv(pose["K"]) @ np.array([uv[0], uv[1], 1.0]))
    z = pose["up"] * height
    s = (z - pose["cam"][2]) / d[2]
    return pose["cam"] + s * d


class ShotFit:
    """一板球的拟合。toward = -1：球往 X 减小的方向飞（从远端打向近端），+1 反之。
    obs 只放落台前的观测点；未知量为落台前速度 (vx, vy, vz) 和落台时刻的微调。"""

    def __init__(self, pose, obs, t_hit, toward):
        self.pose, self.up, self.toward = pose, pose["up"], toward
        self.obs_t = np.array([o[0] for o in obs])
        self.obs_uv = np.array([[o[1], o[2]] for o in obs])
        self.t_hit = t_hit

    def _residuals(self, x, p_b, t_b0):
        vx, vy, vz, dt = x
        v_b, t_b = np.array([vx, vy, vz * self.up]), t_b0 + dt
        ts, ps, _ = simulate_back(p_b, v_b, t_b, min(self.t_hit, self.obs_t.min()) - 0.01, self.up)
        P = _interp(ts, ps, self.obs_t)
        r = ((project(self.pose, P) - self.obs_uv) / PIX_SIGMA).ravel().tolist()
        hgt = self.up * ps[:, 2]
        # 过网：X 经过网所在平面时，球心要高于网 + 球半径
        X = ps[:, 0]
        cross = np.where(np.diff(np.sign(X - C.NET_X)) != 0)[0]
        if len(cross):
            i = cross[-1]
            w = (C.NET_X - X[i]) / (X[i + 1] - X[i])
            r.append(max(0.0, NET_CLEAR - (hgt[i] + w * (hgt[i + 1] - hgt[i]))) / 0.02)
        else:
            r.append(10.0)
        # 击球时刻：球应在击球方端线外、高度合理
        ph = _interp(ts, ps, self.t_hit)
        behind = (ph[0] - C.TABLE_L) if self.toward < 0 else (0.0 - ph[0])
        r.append(max(0.0, -behind) / 0.05)
        hh = self.up * ph[2]
        r.append(max(0.0, -0.25 - hh, hh - 1.0) / 0.05)
        return np.array(r)

    def fit(self, p_b, t_b0):
        """落台点 p_b、落台时刻 t_b0 已知（±10ms 可调），拟合落台前速度，返回击球时刻的速度。"""
        T = max(0.08, t_b0 - self.t_hit)
        hit_x = C.TABLE_L + 0.5 if self.toward < 0 else -0.5
        x0 = [(p_b[0] - hit_x) / T, 0.0, -(0.3 / T) - G * T / 2, 0.0]
        lo = [-45 if self.toward < 0 else 0.5, -15, -20, -0.012]
        hi = [-0.5 if self.toward < 0 else 45, 15, 0.0, 0.012]
        x0 = np.clip(x0, np.array(lo) + 1e-6, np.array(hi) - 1e-6)
        res = least_squares(self._residuals, x0, bounds=(lo, hi), args=(p_b, t_b0), x_scale="jac", max_nfev=200)
        vx, vy, vz, dt = res.x
        ts, ps, vs = simulate_back(p_b, np.array([vx, vy, vz * self.up]), t_b0 + dt, self.t_hit - 0.01, self.up)
        v_hit = _interp(ts, vs, self.t_hit)
        n = 2 * len(self.obs_t)
        return {"kmh": float(np.linalg.norm(v_hit) * 3.6), "t_b": float(t_b0 + dt),
                "rms_px": float(np.sqrt(np.mean((res.fun[:n] * PIX_SIGMA) ** 2))),
                "penalty": float(np.sum(res.fun[n:] ** 2))}


def _find_bounce(obs, cal, toward):
    """在画面轨迹里找落台：画面 y 先变大（往下）再变小（弹起）的拐点，且拐点落在对方半台内。
    返回 (落台时刻, 落台像素, 拐点下标) 或 None。"""
    if len(obs) < 6:
        return None
    t = np.array([o[0] for o in obs])
    u = np.array([o[1] for o in obs])
    v = np.array([o[2] for o in obs])
    half = (-0.1, C.NET_X) if toward < 0 else (C.NET_X, C.TABLE_L + 0.1)
    for i in np.argsort(-v):  # 从画面最低点开始试
        if i < 3 or i > len(obs) - 3:
            continue
        if not (v[i] - v[i - 2] > 4 and v[i] - v[i + 2] > 4):
            continue
        m = C.to_table(cal, [[u[i], v[i]]])[0]
        if not (half[0] <= m[0] <= half[1] and -0.1 <= m[1] <= C.TABLE_W + 0.1):
            continue
        # 落台前后各拟合一段，求两段最接近的时刻作为落台时刻
        a = slice(max(0, i - 4), i + 1)
        b = slice(i, min(len(obs), i + 4))
        pu, pv = np.polyfit(t[a], u[a], 2), np.polyfit(t[a], v[a], 2)
        qu, qv = np.polyfit(t[b], u[b], 1), np.polyfit(t[b], v[b], 1)
        tt = np.linspace(t[i - 1], t[i + 1], 81)
        d = np.hypot(np.polyval(pu, tt) - np.polyval(qu, tt), np.polyval(pv, tt) - np.polyval(qv, tt))
        k = int(np.argmin(d))
        uv = ((np.polyval(pu, tt[k]) + np.polyval(qu, tt[k])) / 2, (np.polyval(pv, tt[k]) + np.polyval(qv, tt[k])) / 2)
        return float(tt[k]), uv, int(i)
    return None


def estimate_shot(cal, pose, obs, t_hit, toward):
    """给定一板球落台前后的画面观测，估算出手速度和误差区间。"""
    bounce = _find_bounce(obs, cal, toward)
    if not bounce:
        return {"status": "none", "reason": "没看到这板球落台（被人挡住或出了画面）"}
    t_b, uv_b, i_b = bounce
    pre = [o for o in obs if o[0] < t_b - 0.004]
    if len(pre) < 4:
        return {"status": "none", "reason": "落台前追踪到的帧太少"}
    W = cal["frame_size"][0]
    results = []
    # 误差区间：焦距 ±15%（镜头先验的不确定度）× 落台点沿长边 ±5cm
    for fs in (0.87, 1.0, 1.15):
        ps = pose if fs == 1.0 else camera_pose(cal, f_fixed=pose["f"] * fs)
        fit = ShotFit(ps, pre, t_hit, toward)
        p0 = ray_to_plane(ps, uv_b, BALL_R)
        for dx in (-0.05, 0.0, 0.05):
            p_b = p0 + np.array([dx, 0, 0])
            r = fit.fit(p_b, t_b)
            r.update(fs=fs, dx=dx, bounce=p0[:2])
            results.append(r)
    nominal = next(r for r in results if r["fs"] == 1.0 and r["dx"] == 0.0)
    if nominal["rms_px"] > 3 * PIX_SIGMA or nominal["penalty"] > 25:
        return {"status": "none", "reason": "轨迹和飞行模型对不上，可能追错了球"}
    ok = [r for r in results if r["rms_px"] <= 3 * PIX_SIGMA and r["penalty"] <= 25]
    lo, hi = min(r["kmh"] for r in ok), max(r["kmh"] for r in ok)
    point = nominal["kmh"]
    rel = max(point - lo, hi - point) / point if point > 0 else 1
    conf = "high" if rel <= 0.15 else "medium" if rel <= 0.25 else "low"
    bx, by = nominal["bounce"]
    return {"status": "ok", "kmh": round(point, 1), "kmh_low": round(lo, 1), "kmh_high": round(hi, 1),
            "confidence": conf, "rms_px": round(nominal["rms_px"], 1), "frames": len(pre),
            "flight_s": round(nominal["t_b"] - t_hit, 3), "bounce": [round(float(bx), 2), round(float(by), 2)]}


# ---------------------------------------------------------------- 找决胜一板

def _segments(traj, times, axis):
    """把逐帧球坐标切成连续的段，返回 [(帧号列表, 朝向分量)]。朝向分量 > 0 表示朝对方半台飞。"""
    ks = sorted(traj)
    segs, cur = [], []
    for k in ks:
        if cur and k - cur[-1] > 2:
            segs.append(cur)
            cur = []
        cur.append(k)
    if cur:
        segs.append(cur)
    out = []
    for s in segs:
        if len(s) < 3:
            continue
        d = np.array(traj[s[min(len(s) - 1, 5)]]) - np.array(traj[s[0]])  # 看开头几帧的方向，落台后会转向
        nd = np.linalg.norm(d)
        out.append((s, float(d @ axis) / nd if nd > 0 else 0.0))
    return out


def _recover_tail(video, times, W, H, traj, seg, max_extra=6, radius=70):
    """人体过滤会把挨着球员手边的球一起丢掉。沿二次曲线外推，在关掉人体过滤的检测里把这几帧找回来。"""
    ks = seg[-6:]
    tt = np.array([times[k] for k in ks])
    xs = np.array([traj[k][0] for k in ks])
    ys = np.array([traj[k][1] for k in ks])
    deg = 2 if len(ks) >= 4 else 1
    px, py = np.polyfit(tt, xs, deg), np.polyfit(tt, ys, deg)
    a, b = seg[-1] + 1, min(len(times) - 1, seg[-1] + max_extra)
    if a > b:
        return []
    det = detect_range((video, times, W, H, a, b, dict(DETECT, merge=1)))
    extra = []
    for k in range(a, b + 1):
        pred = np.array([np.polyval(px, times[k]), np.polyval(py, times[k])])
        cs = [c for c in det.get(k, []) if np.hypot(c[0] - pred[0], c[1] - pred[1]) < radius]
        if not cs:
            break
        c = min(cs, key=lambda c: np.hypot(c[0] - pred[0], c[1] - pred[1]))
        extra.append((float(times[k]), c[0], c[1]))
    return extra


def estimate_point(video, cal, me_side, hit_times, pose=None):
    """估算这一分里“我”的决胜一板的出手速度。hit_times：这一分里声音检测到的击球时刻。"""
    if not hit_times:
        return {"status": "none", "reason": "这一分没有检测到击球声"}
    pose = pose or camera_pose(cal)
    W, H = cal["frame_size"]
    toward = -1 if me_side == "far" else 1  # 远端选手的球往近端（X 减小）飞
    far_mid = C.to_pixels(cal, [[C.TABLE_L, C.TABLE_W / 2]])[0]
    near_mid = C.to_pixels(cal, [[0, C.TABLE_W / 2]])[0]
    axis = (near_mid - far_mid) / np.linalg.norm(near_mid - far_mid)
    if toward > 0:
        axis = -axis

    t0 = max(0.0, hit_times[-1] - 1.2)
    times = frame_times(video, t0, hit_times[-1] + 0.9 - t0)
    if len(times) < 10:
        return {"status": "none", "reason": "取不到这段画面"}
    det = detect_range((video, times, W, H, 0, len(times) - 1, DETECT))
    traj, _ = track(det, len(times), [])
    segs = _segments(traj, times, axis)

    # 决胜一板：先看最后一次击球，再看倒数第二次（对方碰到球但下网/出界的情况）
    reason = "决胜一板没追踪到球（球慢、被人挡住或拖影太重）"
    for h in reversed(hit_times[-2:]):
        for s, dirc in segs:
            if not (dirc > 0.5 and len(s) >= 5 and 0 <= times[s[0]] - h <= 0.35):
                continue
            obs = [(float(times[k]), traj[k][0], traj[k][1]) for k in s]
            res = estimate_shot(cal, pose, obs, h, toward)
            if res["status"] != "ok":  # 落台那几帧可能被人体过滤吃掉了，找回来再试一次
                extra = _recover_tail(video, times, W, H, traj, s)
                if extra:
                    res = estimate_shot(cal, pose, obs + extra, h, toward)
            res["t_hit"] = round(h, 3)
            if res["status"] == "ok":
                if pose["warnings"]:
                    res["warnings"] = pose["warnings"]
                return res
            reason = res["reason"]
    return {"status": "none", "reason": reason}
