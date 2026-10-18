"""球台标定：用户在一帧画面上点球台四个角 → 单应性矩阵（画面像素 ↔ 台面米）。

台面坐标系（单位：米）：
  x 沿球台长边，0 = 离镜头近的那条端线，2.74 = 远端端线，网在 x = 1.37
  y 沿球台短边，0 = 画面里左边那条边线，1.525 = 右边那条
用户点击顺序：近端左 → 近端右 → 远端右 → 远端左（绕球台一圈）。

坐标用 0–1 的相对值传输，与 App 显示的缩放无关；落盘时换算成原视频解码后的像素。
"""
import os
import subprocess

import cv2
import numpy as np

TABLE_L = 2.74
TABLE_W = 1.525
NET_X = TABLE_L / 2

# 与点击顺序一一对应的台面坐标
TABLE_CORNERS = np.float32([[0, 0], [0, TABLE_W], [TABLE_L, TABLE_W], [TABLE_L, 0]])

PREVIEW_WIDTH = 1280


def extract_frame(video, t, out_full, out_preview):
    """取 t 秒处的一帧：原分辨率（用于标定换算）和 1280 宽的预览（给 App 显示）。
    ffmpeg 会按旋转元数据自动转正，后面追踪球也用 ffmpeg 解码，两边坐标一致。"""
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", f"{max(0.0, t):.3f}", "-i", video,
                    "-frames:v", "1", "-q:v", "2", out_full], check=True, capture_output=True)
    img = cv2.imread(out_full)
    if img is None:
        raise ValueError(f"取不到第 {t:.1f} 秒的画面")
    h, w = img.shape[:2]
    scale = PREVIEW_WIDTH / w if w > PREVIEW_WIDTH else 1.0
    small = cv2.resize(img, (round(w * scale), round(h * scale)), interpolation=cv2.INTER_AREA)
    cv2.imwrite(out_preview, small, [cv2.IMWRITE_JPEG_QUALITY, 85])
    return w, h


def _segments_cross(a, b, c, d):
    def ccw(p, q, r):
        return (r[1] - p[1]) * (q[0] - p[0]) - (q[1] - p[1]) * (r[0] - p[0])
    return (ccw(a, c, d) * ccw(b, c, d) < 0) and (ccw(a, b, c) * ccw(a, b, d) < 0)


def order_corners(pts):
    """前两个点是近端两个角。如果后两个点点反了（四边形自相交），交换它们。"""
    p = [tuple(map(float, q)) for q in pts]
    if _segments_cross(p[1], p[2], p[3], p[0]) or _segments_cross(p[0], p[1], p[2], p[3]):
        p[2], p[3] = p[3], p[2]
    return p


def _is_convex(p):
    signs = []
    for i in range(4):
        (ax, ay), (bx, by), (cx, cy) = p[i], p[(i + 1) % 4], p[(i + 2) % 4]
        cross = (bx - ax) * (cy - by) - (by - ay) * (cx - bx)
        signs.append(np.sign(cross))
    return all(s == signs[0] and s != 0 for s in signs)


def solve(corners_norm, frame_w, frame_h):
    """corners_norm: 4 个 [u, v]（0–1），按 近左 → 近右 → 远右 → 远左。返回可直接存进 job 的 dict。"""
    if len(corners_norm) != 4:
        raise ValueError("需要正好 4 个角")
    px = [(float(u) * frame_w, float(v) * frame_h) for u, v in corners_norm]
    if any(not (0 <= x <= frame_w and 0 <= y <= frame_h) for x, y in px):
        raise ValueError("角点超出画面")
    px = order_corners(px)
    if not _is_convex(px):
        raise ValueError("四个角连起来不是凸四边形，请按 近端左 → 近端右 → 远端右 → 远端左 的顺序重新点")
    area = cv2.contourArea(np.float32(px))
    if area < 0.002 * frame_w * frame_h:
        raise ValueError("四个角太近了，球台在画面里应该更大一些")
    H = cv2.getPerspectiveTransform(np.float32(px), TABLE_CORNERS)  # 像素 → 台面
    return {
        "corners_norm": [[x / frame_w, y / frame_h] for x, y in px],
        "corners_px": [[round(x, 1), round(y, 1)] for x, y in px],
        "frame_size": [frame_w, frame_h],
        "H": H.tolist(),
        "H_inv": np.linalg.inv(H).tolist(),
    }


def to_table(calib, pts_px):
    """画面像素 → 台面米。只对台面平面上的点准确（如落台点）。"""
    H = np.float64(calib["H"])
    p = cv2.perspectiveTransform(np.float64(pts_px).reshape(-1, 1, 2), H)
    return p.reshape(-1, 2)


def to_pixels(calib, pts_m):
    Hi = np.float64(calib["H_inv"])
    p = cv2.perspectiveTransform(np.float64(pts_m).reshape(-1, 1, 2), Hi)
    return p.reshape(-1, 2)


def on_table(calib, pts_px, margin=0.0):
    """哪些像素点落在台面范围内（margin 米的容差）。用于剔除台外的“击球”弹跳。"""
    m = to_table(calib, pts_px)
    return (m[:, 0] >= -margin) & (m[:, 0] <= TABLE_L + margin) & (m[:, 1] >= -margin) & (m[:, 1] <= TABLE_W + margin)


def draw_check(calib, frame_path, out_path):
    """把标定结果画回画面：外框、中线、网，两个半台用不同颜色。线和真实球台重合说明标定准确。"""
    img = cv2.imread(frame_path)
    h, w = img.shape[:2]
    scale = PREVIEW_WIDTH / w if w > PREVIEW_WIDTH else 1.0
    img = cv2.resize(img, (round(w * scale), round(h * scale)), interpolation=cv2.INTER_AREA)

    def P(pts):
        return np.int32(to_pixels(calib, pts) * scale)

    overlay = img.copy()
    near = P([[0, 0], [0, TABLE_W], [NET_X, TABLE_W], [NET_X, 0]])
    far = P([[NET_X, 0], [NET_X, TABLE_W], [TABLE_L, TABLE_W], [TABLE_L, 0]])
    cv2.fillPoly(overlay, [near], (90, 180, 60))    # 近端半台：绿
    cv2.fillPoly(overlay, [far], (200, 120, 40))    # 远端半台：蓝
    img = cv2.addWeighted(overlay, 0.3, img, 0.7, 0)
    thick = max(2, round(img.shape[1] / 500))
    cv2.polylines(img, [P(TABLE_CORNERS)], True, (255, 255, 255), thick, cv2.LINE_AA)
    cv2.line(img, *map(tuple, P([[0, TABLE_W / 2], [TABLE_L, TABLE_W / 2]])), (255, 255, 255), max(1, thick // 2), cv2.LINE_AA)
    cv2.line(img, *map(tuple, P([[NET_X, -0.1525], [NET_X, TABLE_W + 0.1525]])), (0, 140, 255), thick + 1, cv2.LINE_AA)
    for i, (x, y) in enumerate(P(TABLE_CORNERS)):
        cv2.circle(img, (int(x), int(y)), thick * 3, (0, 140, 255), -1, cv2.LINE_AA)
        cv2.putText(img, str(i + 1), (int(x) + 8, int(y) - 8), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (255, 255, 255), 2, cv2.LINE_AA)
    cv2.imwrite(out_path, img, [cv2.IMWRITE_JPEG_QUALITY, 85])


def frame_paths(store, job_id, t):
    key = f"{t:.1f}"
    d = store.path(job_id, "frames")
    os.makedirs(d, exist_ok=True)
    return os.path.join(d, f"{key}_full.jpg"), os.path.join(d, f"{key}.jpg")
