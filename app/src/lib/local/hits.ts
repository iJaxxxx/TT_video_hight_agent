/**
 * common.py 里 detect_hits / group_rallies 的 TypeScript 版，在手机上直接跑。
 * 参数、阈值和 numpy 的语义逐条对齐（对齐脚本：app/scripts/align-hits.mjs）：
 *   * np.hanning 是对称窗（分母 N-1）
 *   * 频带用 rfftfreq 的严格不等式 1500 < f < 7000
 *   * 滑动中位数窗口宽 2*half（偶数，取中间两个数的平均），两端 edge 填充 (half, half-1)
 *   * np.percentile 默认线性插值
 * 只用 TypedArray，不依赖 Node 的 Buffer，Hermes 和 Node 跑的是同一份代码。
 */

export type Hit = { t: number; strength: number };
export type Rally = { start: number; end: number; hits: number; times: number[] };

export type DetectOptions = {
  band?: [number, number];
  hopS?: number;
  win?: number;
  localRatio?: number;
  globalFrac?: number;
  minGap?: number;
  medianWindowS?: number;
};

const DEFAULTS: Required<DetectOptions> = {
  band: [1500, 7000],
  hopS: 0.005,
  win: 512,
  localRatio: 4.0,
  globalFrac: 0.35,
  minGap: 0.18,
  medianWindowS: 2.0,
};

// ———————————————————— FFT ————————————————————

/**
 * 长度为 2 的幂的 FFT，一次变换两帧实数信号（A 放实部、B 放虚部，再拆开），只取需要的频点的幅值。
 * 手机上的 Hermes 是解释执行，FFT 占了几乎全部耗时，两帧一起算能省一半。
 */
class PairFFT {
  private n: number;
  private rev: Uint32Array;
  private cos: Float64Array;
  private sin: Float64Array;
  private re: Float64Array;
  private im: Float64Array;

  constructor(n: number) {
    if (n & (n - 1)) throw new Error('FFT 长度必须是 2 的幂');
    this.n = n;
    this.rev = new Uint32Array(n);
    const bits = Math.log2(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
    this.cos = new Float64Array(n / 2);
    this.sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / n);
      this.sin[i] = -Math.sin((2 * Math.PI * i) / n);
    }
    this.re = new Float64Array(n);
    this.im = new Float64Array(n);
  }

  /** a、b 已经乘过窗；把 |A[k]|、|B[k]|（k 在 [k0, k1)）分别写进 outA、outB */
  magnitudes(a: Float64Array, b: Float64Array, k0: number, k1: number, outA: Float64Array, outB: Float64Array) {
    const { n, rev, re, im, cos, sin } = this;
    for (let i = 0; i < n; i++) {
      const r = rev[i];
      re[i] = a[r];
      im[i] = b[r];
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let s = 0; s < n; s += size) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const p = s + j;
          const q = p + half;
          const wr = cos[k];
          const wi = sin[k];
          const tr = re[q] * wr - im[q] * wi;
          const ti = re[q] * wi + im[q] * wr;
          re[q] = re[p] - tr;
          im[q] = im[p] - ti;
          re[p] += tr;
          im[p] += ti;
        }
      }
    }
    // A[k] = (Z[k] + conj(Z[n-k])) / 2，B[k] = (Z[k] - conj(Z[n-k])) / 2i
    for (let k = k0; k < k1; k++) {
      const m = (n - k) & (n - 1);
      const ar = re[k] + re[m];
      const ai = im[k] - im[m];
      const br = im[k] + im[m];
      const bi = re[k] - re[m];
      outA[k - k0] = 0.5 * Math.sqrt(ar * ar + ai * ai);
      outB[k - k0] = 0.5 * Math.sqrt(br * br + bi * bi);
    }
  }
}

// ———————————————————— spectral flux ————————————————————

/** 逐帧算 flux，可分段调用（给 App 里让出主线程用）。对应 common._band_flux */
class BandFlux {
  readonly n: number;
  readonly flux: Float32Array;
  private fft: PairFFT;
  private window: Float64Array;
  private frameA: Float64Array;
  private frameB: Float64Array;
  private k0: number;
  private k1: number;
  private magA: Float64Array;
  private magB: Float64Array;
  private prev: Float64Array;
  private x: Float32Array;
  private win: number;
  private hop: number;
  private hasPrev = false;
  private done = 0;

  constructor(x: Float32Array, sr: number, win: number, hop: number, band: [number, number]) {
    this.x = x;
    this.win = win;
    this.hop = hop;
    this.n = Math.max(0, Math.floor((x.length - win) / hop));
    this.flux = new Float32Array(this.n);
    this.fft = new PairFFT(win);
    // np.hanning：对称窗
    this.window = new Float64Array(win);
    for (let i = 0; i < win; i++) this.window[i] = Math.fround(0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (win - 1)));
    this.frameA = new Float64Array(win);
    this.frameB = new Float64Array(win);
    // np.fft.rfftfreq(win, 1/sr)[k] = k*sr/win，严格不等式选频带
    let k0 = -1;
    let k1 = -1;
    for (let k = 0; k <= win / 2; k++) {
      const f = (k * sr) / win;
      if (f > band[0] && f < band[1]) {
        if (k0 < 0) k0 = k;
        k1 = k + 1;
      }
    }
    this.k0 = k0;
    this.k1 = k1;
    this.magA = new Float64Array(k1 - k0);
    this.magB = new Float64Array(k1 - k0);
    this.prev = new Float64Array(k1 - k0);
  }

  get progress() {
    return this.n ? this.done / this.n : 1;
  }

  /** 再算 count 帧，返回是否全部算完 */
  step(count: number): boolean {
    const { x, win, hop, window, frameA, frameB, fft, k0, k1, magA, magB } = this;
    const end = Math.min(this.n, this.done + count);
    for (let i = this.done; i < end; i += 2) {
      const hasB = i + 1 < end;
      // numpy 里是 float32 * float32
      for (let j = 0, off = i * hop; j < win; j++) frameA[j] = Math.fround(x[off + j] * window[j]);
      for (let j = 0, off = (i + 1) * hop; j < win; j++) frameB[j] = hasB ? Math.fround(x[off + j] * window[j]) : 0;
      fft.magnitudes(frameA, frameB, k0, k1, magA, magB);
      this.push(i, magA);
      if (hasB) this.push(i + 1, magB);
    }
    this.done = end;
    return end >= this.n;
  }

  /** 第 i 帧的频带能量相对上一帧的正向增量之和 */
  private push(i: number, mag: Float64Array) {
    const { prev } = this;
    let d = 0;
    for (let k = 0; k < mag.length; k++) {
      const e = Math.fround(Math.log1p(100 * mag[k]));
      if (this.hasPrev) {
        const diff = e - prev[k];
        if (diff > 0) d += diff;
      }
      prev[k] = e;
    }
    this.flux[i] = this.hasPrev ? d : 0;
    this.hasPrev = true;
  }
}

// ———————————————————— 统计 ————————————————————

/** 以每个点为中心、宽 2*half 的滑动中位数，edge 填充 (half, half-1)。对应 common._running_median。
 *  用有序窗口 + 二分插入/删除，O(N·W) 的内存搬移，10 分钟视频（12 万点 × 400）很快 */
export function runningMedian(v: Float32Array, half: number): Float32Array {
  const n = v.length;
  const w = 2 * half;
  const out = new Float32Array(n);
  if (n === 0) return out;
  const padded = (i: number) => v[Math.min(n - 1, Math.max(0, i - half))];
  const sorted = new Float64Array(w);
  for (let i = 0; i < w; i++) sorted[i] = padded(i);
  sorted.sort();
  const lowerBound = (x: number) => {
    let lo = 0;
    let hi = w;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (sorted[m] < x) lo = m + 1;
      else hi = m;
    }
    return lo;
  };
  for (let i = 0; i < n; i++) {
    if (i > 0) {
      // 窗口右移一格：去掉 padded(i-1)，加入 padded(i+w-1)
      const old = padded(i - 1);
      const add = padded(i + w - 1);
      const r = lowerBound(old);
      sorted.copyWithin(r, r + 1, w);
      // 现在有效长度 w-1，在其中找插入点
      let lo = 0;
      let hi = w - 1;
      while (lo < hi) {
        const m = (lo + hi) >> 1;
        if (sorted[m] < add) lo = m + 1;
        else hi = m;
      }
      sorted.copyWithin(lo + 1, lo, w - 1);
      sorted[lo] = add;
    }
    out[i] = (w & 1 ? sorted[w >> 1] : (sorted[w / 2 - 1] + sorted[w / 2]) / 2);
  }
  return out;
}

/** np.percentile 默认的线性插值 */
export function percentile(v: Float32Array, q: number): number {
  if (v.length === 0) return NaN;
  const s = Float64Array.from(v).sort();
  const rank = (q / 100) * (s.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.min(s.length - 1, lo + 1);
  return s[lo] + (s[hi] - s[lo]) * (rank - lo);
}

// ———————————————————— 击球 & 回合 ————————————————————

function pickPeaks(flux: Float32Array, hop: number, sr: number, o: Required<DetectOptions>): Hit[] {
  if (flux.length < 3) return [];
  const half = Math.max(1, Math.trunc(o.medianWindowS / o.hopS / 2));
  const med = runningMedian(flux, half);
  const glob = percentile(flux, 99);
  const t = (i: number) => (i * hop) / sr;
  const peaks: number[] = [];
  for (let i = 1; i < flux.length - 1; i++) {
    const thr = Math.max(med[i] * o.localRatio, glob * o.globalFrac);
    if (!(flux[i] > flux[i - 1] && flux[i] >= flux[i + 1] && flux[i] > thr)) continue;
    const last = peaks.length - 1;
    if (last >= 0 && t(i) - t(peaks[last]) < o.minGap) {
      if (flux[i] > flux[peaks[last]]) peaks[last] = i;
      continue;
    }
    peaks.push(i);
  }
  return peaks.map((i) => ({ t: t(i), strength: flux[i] }));
}

/** 在音频里找击球声。x 为单声道 float32 PCM。对应 common.detect_hits */
export function detectHits(x: Float32Array, sr: number, opts: DetectOptions = {}): Hit[] {
  const o = { ...DEFAULTS, ...opts };
  const hop = Math.trunc(sr * o.hopS);
  const bf = new BandFlux(x, sr, o.win, hop, o.band);
  bf.step(bf.n);
  return pickPeaks(bf.flux, hop, sr, o);
}

/** 同 detectHits，但每算一段就让出主线程，并回报进度（0–1） */
export async function detectHitsAsync(
  x: Float32Array,
  sr: number,
  opts: DetectOptions = {},
  onProgress?: (p: number) => void,
): Promise<Hit[]> {
  const o = { ...DEFAULTS, ...opts };
  const hop = Math.trunc(sr * o.hopS);
  const bf = new BandFlux(x, sr, o.win, hop, o.band);
  while (!bf.step(4000)) {
    onProgress?.(bf.progress * 0.95);
    await new Promise((r) => setTimeout(r, 0));
  }
  const hits = pickPeaks(bf.flux, hop, sr, o);
  onProgress?.(1);
  return hits;
}

/** 相邻击球间隔 < maxGap 秒视为同一回合。对应 common.group_rallies */
export function groupRallies(hitTimes: number[], maxGap = 1.5): Rally[] {
  const rallies: number[][] = [];
  let cur: number[] = [];
  for (const h of [...hitTimes].sort((a, b) => a - b)) {
    if (cur.length && h - cur[cur.length - 1] >= maxGap) {
      rallies.push(cur);
      cur = [];
    }
    cur.push(h);
  }
  if (cur.length) rallies.push(cur);
  return rallies.map((c) => ({ start: c[0], end: c[c.length - 1], hits: c.length, times: c }));
}
