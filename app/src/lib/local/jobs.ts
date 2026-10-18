import AsyncStorage from '@react-native-async-storage/async-storage';
import { File, Paths } from 'expo-file-system';
import * as VideoThumbnails from 'expo-video-thumbnails';

import LocalMedia from '../../../modules/local-media';
import type { Candidate, ExportOptions, ExportState, Job, JobSummary, MeSide, PickedVideo, Winner } from '../api';
import { detectHitsAsync, groupRallies } from './hits';

/**
 * 本地解析（测试）：不上传，视频留在手机上。
 * 音频抽取和成片导出走原生模块 modules/local-media（AVFoundation），击球检测和回合切分是 hits.ts。
 * 任务的数据结构和服务端 Job 完全一样，结果页 / 编辑 / 导出直接复用；id 以 local_ 开头，api.ts 据此分流。
 * 大模型复核、球速估算、球台标定本期不做，得分方在结果页手动确认。
 */

export const LOCAL_PREFIX = 'local_';
export const isLocalId = (id: string) => id.startsWith(LOCAL_PREFIX);
export const localAvailable = () => LocalMedia !== null;

// 与 server/pipeline.py 一致
const LEAD_S = 1.5;
const TAIL_S = 1.5;
const SR = 16000;
const STEPS = ['读取视频', '提取音频', '击球检测', '回合切分', '生成缩略图', '待确认'];

/** 本地任务比服务端多的字段：原视频路径、缩略图、成片路径、各步骤耗时 */
export type LocalJob = Job & {
  local: {
    videoUri: string;
    thumbs: Record<number, string>;
    clipUri?: string;
    /** 各步骤耗时（秒），用于评估手机端性能 */
    timings: { audio?: number; detect?: number; thumbs?: number; total?: number; export?: number; exportDuration?: number };
  };
};

/**
 * 记录里存的是绝对路径（file:///var/mobile/Containers/Data/Application/<UUID>/Library/...）。
 * App 更新重装后 iOS 可能换掉容器 UUID，文件还在、旧路径却失效了，原视频播不了、缩略图也出不来。
 * 读记录时把旧容器前缀换成当前的。
 */
const CONTAINER_RE = /^file:\/\/\/(?:private\/)?var\/mobile\/Containers\/Data\/Application\/[^/]+\//;
function currentContainer() {
  const m = Paths.document.uri.match(CONTAINER_RE);
  return m ? m[0] : null;
}
function rebase(uri: string, root: string | null): string {
  return root && uri ? uri.replace(CONTAINER_RE, root) : uri;
}
function rebaseJob(j: LocalJob, root: string | null) {
  if (j.video) j.video = rebase(j.video, root);
  j.local.videoUri = rebase(j.local.videoUri, root);
  if (j.local.clipUri) j.local.clipUri = rebase(j.local.clipUri, root);
  j.local.thumbs = Object.fromEntries(Object.entries(j.local.thumbs).map(([k, v]) => [k, rebase(v, root)]));
}

const KEY = 'tt-highlight-local-jobs';
const jobs = new Map<string, LocalJob>();
let hydrated: Promise<void> | null = null;

function hydrate() {
  hydrated ??= AsyncStorage.getItem(KEY)
    .then((raw) => {
      if (!raw) return;
      const root = currentContainer();
      for (const j of JSON.parse(raw) as LocalJob[]) {
        rebaseJob(j, root);
        // 上次分析 / 导出到一半 App 被杀了
        if (j.status === 'processing') Object.assign(j, { status: 'failed', error: 'App 退出，本地分析中断了，请重新导入' });
        if (j.export?.status === 'running') j.export = { ...j.export, status: 'failed', error: '导出中断' };
        if (!jobs.has(j.id)) jobs.set(j.id, j);
      }
      persist();
    })
    .catch(() => {});
  return hydrated;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function persist() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    AsyncStorage.setItem(KEY, JSON.stringify([...jobs.values()])).catch(() => {});
  }, 300);
}

function patch(id: string, p: Partial<LocalJob> | ((j: LocalJob) => void)) {
  const j = jobs.get(id);
  if (!j) return;
  // 每次换新对象，页面拿到的 job 才会触发重渲染
  const next: LocalJob = { ...j, local: { ...j.local, timings: { ...j.local.timings } } };
  if (typeof p === 'function') p(next);
  else Object.assign(next, p);
  jobs.set(id, next);
  persist();
}

function snapshot(id: string): Job {
  const j = jobs.get(id);
  if (!j) throw new Error('本地任务不存在（可能已删除）');
  return j;
}

/** 等一帧，让界面有机会刷新 */
const tick = () => new Promise((r) => setTimeout(r, 0));

/** 原生模块的进度事件只有一个通道，按 task 区分 */
function onNativeProgress(task: 'audio' | 'export', fn: (p: number) => void) {
  const sub = LocalMedia?.addListener('onProgress', (e) => e.task === task && fn(e.progress));
  return () => sub?.remove();
}

// ———————————————————— 分析 ————————————————————

export async function createLocalJob(video: PickedVideo, params: { me_side: MeSide; min_hits: number }): Promise<Job> {
  if (!LocalMedia) throw new Error('本地解析需要 iOS 开发版（npx expo run:ios），Expo Go 里没有原生模块');
  await hydrate();
  const id = `${LOCAL_PREFIX}${Date.now().toString(36)}`;
  const job: LocalJob = {
    id,
    filename: video.name,
    created: Date.now() / 1000,
    status: 'processing',
    step: 0,
    steps: STEPS,
    progress: 0,
    error: null,
    params,
    video: video.uri,
    hits: 0,
    candidates: [],
    llm: { enabled: false },
    export: null,
    calibration: null,
    speeds: null,
    local: { videoUri: video.uri, thumbs: {}, timings: {} },
  };
  jobs.set(id, job);
  persist();
  analyze(id).catch((e) => patch(id, { status: 'failed', error: e instanceof Error ? e.message : String(e) }));
  return job;
}

async function analyze(id: string) {
  const t0 = Date.now();
  const { videoUri } = jobs.get(id)!.local;
  const minHits = jobs.get(id)!.params.min_hits;

  // 1. 抽音频（原生，写成 PCM 文件）
  patch(id, { step: 1, progress: 0.02 });
  const off = onNativeProgress('audio', (p) => patch(id, { progress: 0.02 + 0.28 * p }));
  let pcm;
  try {
    pcm = await LocalMedia!.extractAudio(videoUri);
  } finally {
    off();
  }
  const tAudio = Date.now();
  const file = new File(pcm.uri);
  const bytes = await file.bytes();
  file.delete();
  const x = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 2);
  const duration = x.length / SR;

  // 2. 击球检测（TS，分段让出主线程）
  patch(id, { step: 2, progress: 0.3, meta: { duration, width: 0, height: 0, fps: 0 } });
  const hits = await detectHitsAsync(x, SR, {}, (p) => patch(id, { progress: 0.3 + 0.4 * p }));
  const tDetect = Date.now();

  // 3. 回合切分，候选字段和 server/pipeline.py 一致
  patch(id, { step: 3, progress: 0.7, hits: hits.length });
  await tick();
  const rallies = groupRallies(hits.map((h) => h.t)).filter((r) => r.hits >= minHits);
  const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;
  const candidates: Candidate[] = rallies.map((r, n) => ({
    n,
    start: round(Math.max(0, r.start - LEAD_S), 2),
    end: round(Math.min(duration, r.end + TAIL_S), 2),
    last_hit: round(r.end, 2),
    hits: r.hits,
    score: round(r.hits ** 1.5, 2),
    rule: { winner: 'unknown', reason: '本地解析：未标定球台，规则层暂不判胜负' },
    llm: { status: 'skipped_no_key' },
    winner: 'unknown',
    confirmed: false,
  }));
  patch(id, { step: 4, progress: 0.72, candidates });

  // 4. 缩略图：每个回合最后一拍的那一帧
  for (const [k, c] of candidates.entries()) {
    try {
      const th = await VideoThumbnails.getThumbnailAsync(videoUri, { time: Math.round(c.last_hit * 1000), quality: 0.6 });
      patch(id, (j) => {
        j.local.thumbs = { ...j.local.thumbs, [c.n]: th.uri };
        j.progress = 0.72 + 0.26 * ((k + 1) / candidates.length);
      });
    } catch {
      // 缩略图失败不影响结果
    }
  }
  const tEnd = Date.now();
  patch(id, (j) => {
    j.status = 'review';
    j.step = 5;
    j.progress = 1;
    j.local.timings = {
      audio: (tAudio - t0) / 1000,
      detect: (tDetect - tAudio) / 1000,
      thumbs: (tEnd - tDetect) / 1000,
      total: (tEnd - t0) / 1000,
    };
  });
  console.log(`[local] ${id} 时长 ${duration.toFixed(1)}s，击球 ${hits.length}，回合 ${candidates.length}，耗时`, jobs.get(id)!.local.timings);
}

// ———————————————————— 与 api 对应的操作 ————————————————————

export const localApi = {
  async listJobs(): Promise<JobSummary[]> {
    await hydrate();
    return [...jobs.values()]
      .sort((a, b) => b.created - a.created)
      .map(({ id, filename, created, status, progress, candidates }) => ({ id, filename, created, status, progress, count: candidates.length }));
  },

  async getJob(id: string): Promise<Job> {
    await hydrate();
    return snapshot(id);
  },

  async deleteJob(id: string) {
    await hydrate();
    const j = jobs.get(id);
    for (const uri of [...Object.values(j?.local.thumbs ?? {}), j?.local.clipUri]) {
      try {
        if (uri) new File(uri).delete();
      } catch {}
    }
    jobs.delete(id);
    persist();
    return { ok: true };
  },

  async setWinner(id: string, n: number, winner: Winner): Promise<Candidate> {
    await hydrate();
    patch(id, (j) => {
      j.candidates = j.candidates.map((c) => (c.n === n ? { ...c, winner, confirmed: winner !== 'unknown' } : c));
    });
    return snapshot(id).candidates.find((c) => c.n === n)!;
  },

  async startExport(id: string, opts: ExportOptions): Promise<ExportState> {
    await hydrate();
    const j = jobs.get(id);
    if (!j) throw new Error('本地任务不存在');
    if (!LocalMedia) throw new Error('本地导出需要 iOS 开发版');
    const clips = opts.clips ?? j.candidates.filter((c) => opts.include.includes(c.winner)).map(({ start, end }) => ({ start, end }));
    if (!clips.length) throw new Error('没有选中的片段');
    const state: ExportState = { status: 'running', progress: 0, include: opts.include, ratio: opts.ratio, quality: opts.quality, clips: clips.length };
    patch(id, { export: state });

    const old = j.local.clipUri;
    const off = onNativeProgress('export', (p) => patch(id, (x) => x.export && (x.export = { ...x.export, progress: p })));
    const t0 = Date.now();
    LocalMedia.exportClips(j.local.videoUri, clips.map(({ start, end }) => ({ start, end })), opts.ratio ?? null, opts.quality ?? null)
      .then((r) => {
        patch(id, (x) => {
          x.export = { ...state, status: 'done', progress: 1, duration: Math.round(r.duration * 10) / 10 };
          x.local.clipUri = r.uri;
          x.local.timings.export = (Date.now() - t0) / 1000;
          x.local.timings.exportDuration = r.duration;
        });
        console.log(`[local] ${id} 导出 ${r.duration.toFixed(1)}s 成片，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
        try {
          if (old) new File(old).delete();
        } catch {}
      })
      .catch((e) => patch(id, { export: { ...state, status: 'failed', error: e instanceof Error ? e.message : String(e) } }))
      .finally(off);
    return state;
  },

  /** 缩略图（同步，任务已经通过 getJob 读进内存） */
  sheetUrl: (id: string, n: number) => jobs.get(id)?.local.thumbs[n] ?? '',

  /** 某个时间点的画面：取包含它的回合的缩略图 */
  frameUrl: (id: string, t: number) => {
    const j = jobs.get(id);
    if (!j) return '';
    const c = j.candidates.find((x) => x.start <= t && t <= x.end) ?? j.candidates[0];
    return (c && j.local.thumbs[c.n]) || '';
  },

  /** 预览不剪片，直接播原视频：用 #t=起点 告诉播放器从哪开始（见 api.splitPreviewUrl） */
  previewUrl: (id: string, n: number) => {
    const j = jobs.get(id);
    const c = j?.candidates.find((x) => x.n === n);
    return j && c ? `${j.local.videoUri}#t=${c.start}` : '';
  },

  clipUrl: (id: string) => jobs.get(id)?.local.clipUri ?? '',
};

export const localTimings = (job: Job) => (job as Partial<LocalJob>).local?.timings;
