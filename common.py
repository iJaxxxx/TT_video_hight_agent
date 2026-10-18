"""公共工具：读视频信息、提取音频、用声音检测击球、把击球串成回合。"""
import json
import subprocess

import numpy as np


# ---------------------------------------------------------------- 视频信息

def probe(video):
    """返回 (时长秒, 宽, 高, fps)。"""
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height,r_frame_rate:format=duration",
         "-of", "json", video],
        capture_output=True, text=True, check=True).stdout
    info = json.loads(out)
    st = info["streams"][0]
    num, den = st["r_frame_rate"].split("/")
    return float(info["format"]["duration"]), st["width"], st["height"], float(num) / float(den)


# ffmpeg 解不了的音频编码。新款 iPhone 的第一条音轨是空间音频 APAC，第二条才是普通 AAC
_UNDECODABLE_AUDIO = {"apple_apac"}


def audio_stream(video):
    """返回第一条 ffmpeg 能解码的音轨序号（用于 -map 0:a:N），没有音轨时返回 None。"""
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "a",
         "-show_entries", "stream=codec_name", "-of", "json", video],
        capture_output=True, text=True, check=True).stdout
    streams = json.loads(out).get("streams", [])
    for i, st in enumerate(streams):
        if st.get("codec_name") not in _UNDECODABLE_AUDIO:
            return i
    return None


def extract_audio(video, sr=16000, start=None, duration=None):
    """用 ffmpeg 把第一条可解码的音轨转成单声道 float32，直接读进内存（不落临时文件）。"""
    idx = audio_stream(video)
    if idx is None:
        raise ValueError("视频里没有可解码的音轨，无法按击球声检测")
    cmd = ["ffmpeg", "-v", "error"]
    if start is not None:
        cmd += ["-ss", str(start)]
    cmd += ["-i", video]
    if duration is not None:
        cmd += ["-t", str(duration)]
    cmd += ["-map", f"0:a:{idx}", "-ac", "1", "-ar", str(sr), "-f", "f32le", "-"]
    raw = subprocess.run(cmd, capture_output=True, check=True).stdout
    return np.frombuffer(raw, dtype=np.float32), sr


# ---------------------------------------------------------------- 击球检测

def _band_flux(x, sr, win, hop, band, chunk=20000):
    """高频段的 spectral flux：每个时间点相对上一个时间点、该频段能量上升了多少。
    分块计算，长视频也不会占用过多内存。"""
    n = max(0, (len(x) - win) // hop)
    f = np.fft.rfftfreq(win, 1 / sr)
    sel = (f > band[0]) & (f < band[1])
    window = np.hanning(win).astype(np.float32)
    flux = np.zeros(n, dtype=np.float32)
    prev = None
    for s in range(0, n, chunk):
        e = min(n, s + chunk)
        idx = np.arange(win)[None, :] + hop * np.arange(s, e)[:, None]
        spec = np.abs(np.fft.rfft(x[idx] * window, axis=1))[:, sel]
        E = np.log1p(100 * spec).astype(np.float32)
        if prev is not None:
            E_all = np.vstack([prev, E])
            d = np.maximum(0, np.diff(E_all, axis=0)).sum(1)
        else:
            d = np.r_[0, np.maximum(0, np.diff(E, axis=0)).sum(1)]
        flux[s:e] = d
        prev = E[-1:]
    return flux


def _running_median(v, half, chunk=20000):
    """以每个点为中心、宽 2*half 的滑动中位数（分块，避免大内存）。"""
    from numpy.lib.stride_tricks import sliding_window_view
    pad = np.pad(v, (half, half - 1), mode="edge")
    out = np.empty_like(v)
    for s in range(0, len(v), chunk):
        e = min(len(v), s + chunk)
        out[s:e] = np.median(sliding_window_view(pad[s:e + 2 * half - 1], 2 * half), axis=1)
    return out


def detect_hits(x, sr, band=(1500, 7000), hop_s=0.005, win=512,
                local_ratio=4.0, global_frac=0.35, min_gap=0.18, median_window_s=2.0):
    """在音频里找乒乓球击球声，返回 [(时间秒, 强度), ...]。

    思路：击球声又短又脆，能量集中在 1.5–7kHz。逐 5ms 计算该频段能量的突增量，
    一个时刻被算作击球需要同时满足：
      * 是局部峰值；
      * 比附近 2 秒的中位数高 local_ratio 倍（自适应，适应不同球馆的底噪）；
      * 超过全片 99 分位数的 global_frac（过滤太弱的声音）；
      * 与上一次击球间隔 >= min_gap 秒（同一声音只记一次，保留更强的那个）。
    """
    hop = int(sr * hop_s)
    flux = _band_flux(x, sr, win, hop, band)
    if len(flux) < 3:
        return []
    t = np.arange(len(flux)) * hop / sr
    half = max(1, int(median_window_s / hop_s / 2))
    med = _running_median(flux, half)
    glob = np.percentile(flux, 99)
    thr = np.maximum(med * local_ratio, glob * global_frac)
    is_peak = (flux[1:-1] > flux[:-2]) & (flux[1:-1] >= flux[2:]) & (flux[1:-1] > thr[1:-1])
    cand = np.where(is_peak)[0] + 1
    peaks = []
    for i in cand:
        if peaks and t[i] - t[peaks[-1]] < min_gap:
            if flux[i] > flux[peaks[-1]]:
                peaks[-1] = i
            continue
        peaks.append(i)
    return [(float(t[i]), float(flux[i])) for i in peaks]


# ---------------------------------------------------------------- 回合

def group_rallies(hit_times, max_gap=1.5):
    """相邻击球间隔 < max_gap 秒视为同一回合。返回 [{'start','end','hits','times'}]。"""
    rallies = []
    cur = []
    for h in sorted(hit_times):
        if cur and h - cur[-1] >= max_gap:
            rallies.append(cur)
            cur = []
        cur.append(h)
    if cur:
        rallies.append(cur)
    return [{"start": c[0], "end": c[-1], "hits": len(c), "times": c} for c in rallies]
