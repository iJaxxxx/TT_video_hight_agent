import { File, UploadType } from 'expo-file-system';
import { Platform } from 'react-native';

import { isLocalId, localApi } from './local/jobs';

// 与 server/main.py、server/pipeline.py 的数据结构一一对应

export type Winner = 'unknown' | 'me' | 'coach' | 'practice' | 'unclear';
export type MeSide = 'far' | 'near';

export type LlmResult =
  | { status: 'pending' | 'skipped_no_key' }
  | { status: 'error'; error: string }
  | {
      status: 'agreed' | 'disagreed';
      winner: Winner;
      confidence?: string;
      evidence?: string;
      votes: Winner[];
    };

/** 决胜一板的出手速度估算（km/h）。status 为 none 时 reason 说明为什么没有数 */
export type Speed =
  | {
      status: 'ok';
      kmh: number;
      kmh_low: number;
      kmh_high: number;
      confidence: 'high' | 'medium' | 'low';
      t_hit: number;
      flight_s: number;
      frames: number;
    }
  | { status: 'none'; reason: string; t_hit?: number };

export type SpeedsState = {
  status: 'idle' | 'running' | 'done' | 'failed';
  progress?: number;
  warnings?: string[];
  error?: string | null;
};

export type Fastest = { n: number; kmh: number; kmh_low: number; kmh_high: number; confidence: 'high' | 'medium' | 'low' };

export type Candidate = {
  n: number;
  start: number;
  end: number;
  last_hit: number;
  hits: number;
  score: number;
  rule: { winner: Winner; reason: string };
  llm: LlmResult;
  winner: Winner;
  confirmed: boolean;
  speed?: Speed;
};

export type ExportRatio = '9:16' | '16:9' | '1:1';
/** null 为原画 */
export type ExportQuality = '720p' | '1080p' | null;

export type ExportOptions = {
  include: Winner[];
  /** 编辑后的片段，按成片顺序 */
  clips?: { n: number; start: number; end: number }[];
  ratio?: ExportRatio | null;
  quality?: ExportQuality;
};

export type ExportState = {
  status: 'running' | 'done' | 'failed';
  progress: number;
  include: Winner[];
  ratio?: ExportRatio | null;
  quality?: ExportQuality | null;
  clips?: number;
  duration?: number;
  error?: string;
};

/** 球台标定。corners_norm 为 0–1 相对坐标，顺序：近端左 → 近端右 → 远端右 → 远端左 */
export type Calibration = {
  corners_norm: [number, number][];
  corners_px: [number, number][];
  frame_size: [number, number];
  t: number;
};

export type Job = {
  id: string;
  filename: string;
  created: number;
  status: 'uploading' | 'queued' | 'processing' | 'review' | 'failed';
  step: number;
  steps: string[];
  progress: number;
  error: string | null;
  params: { me_side: MeSide; min_hits: number };
  meta?: { duration: number; width: number; height: number; fps: number };
  video: string | null;
  hits: number;
  candidates: Candidate[];
  llm: { enabled: boolean };
  export: ExportState | null;
  calibration?: Calibration | null;
  speeds?: SpeedsState | null;
  /** 只在标为“我赢”的分里选，服务端算好 */
  fastest?: Fastest | null;
};

export type JobSummary = Pick<Job, 'id' | 'filename' | 'created' | 'status' | 'progress'> & { count: number };

export class ApiError extends Error {}

async function request<T>(base: string, path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(base + path, init);
  } catch {
    throw new ApiError(`连不上服务器 ${base}。请确认电脑上的服务已启动，手机和电脑在同一个 Wi-Fi 下。`);
  }
  if (!res.ok) {
    let detail = `${res.status}`;
    try {
      detail = (await res.json()).detail ?? detail;
    } catch {}
    throw new ApiError(String(detail));
  }
  return res.json() as Promise<T>;
}

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

const server = {
  health: (base: string) => request<{ ok: boolean; llm_enabled: boolean }>(base, '/health'),
  listJobs: (base: string) => request<JobSummary[]>(base, '/jobs'),
  getJob: (base: string, id: string) => request<Job>(base, `/jobs/${id}`),
  deleteJob: (base: string, id: string) => request<{ ok: boolean }>(base, `/jobs/${id}`, { method: 'DELETE' }),
  setWinner: (base: string, id: string, n: number, winner: Winner) =>
    request<Candidate>(base, `/jobs/${id}/candidates/${n}`, json({ winner })),
  startExport: (base: string, id: string, opts: ExportOptions) =>
    request<ExportState>(base, `/jobs/${id}/export`, json(opts)),
  setCalibration: (base: string, id: string, corners: [number, number][], t: number) =>
    request<Calibration>(base, `/jobs/${id}/calibration`, json({ corners, t })),
  clearCalibration: (base: string, id: string) => request<null>(base, `/jobs/${id}/calibration`, { method: 'DELETE' }),
  frameUrl: (base: string, id: string, t: number) => `${base}/jobs/${id}/frame.jpg?t=${t}`,
  /** 标定检查图；v 用角点拼出来，重新标定后 URL 会变，避免拿到旧缓存 */
  calibrationImageUrl: (base: string, id: string, c: Calibration) =>
    `${base}/jobs/${id}/calibration.jpg?v=${c.corners_norm.flat().map((x) => x.toFixed(4)).join(',')}`,
  sheetUrl: (base: string, id: string, n: number) => `${base}/jobs/${id}/candidates/${n}/sheet.jpg`,
  previewUrl: (base: string, id: string, n: number) => `${base}/jobs/${id}/candidates/${n}/preview.mp4`,
  clipUrl: (base: string, id: string) => `${base}/jobs/${id}/clip.mp4`,
};

/** 页面统一用这个：id 以 local_ 开头的是本地解析的任务（lib/local/jobs.ts），其余走服务器 */
export const api = {
  ...server,
  getJob: (base: string, id: string) => (isLocalId(id) ? localApi.getJob(id) : server.getJob(base, id)),
  deleteJob: (base: string, id: string) => (isLocalId(id) ? localApi.deleteJob(id) : server.deleteJob(base, id)),
  setWinner: (base: string, id: string, n: number, winner: Winner) =>
    isLocalId(id) ? localApi.setWinner(id, n, winner) : server.setWinner(base, id, n, winner),
  startExport: (base: string, id: string, opts: ExportOptions) =>
    isLocalId(id) ? localApi.startExport(id, opts) : server.startExport(base, id, opts),
  setCalibration: (base: string, id: string, corners: [number, number][], t: number) =>
    isLocalId(id) ? Promise.reject(new ApiError('本地解析暂不支持球台标定')) : server.setCalibration(base, id, corners, t),
  clearCalibration: (base: string, id: string) => (isLocalId(id) ? Promise.resolve(null) : server.clearCalibration(base, id)),
  frameUrl: (base: string, id: string, t: number) => (isLocalId(id) ? localApi.frameUrl(id, t) : server.frameUrl(base, id, t)),
  sheetUrl: (base: string, id: string, n: number) => (isLocalId(id) ? localApi.sheetUrl(id, n) : server.sheetUrl(base, id, n)),
  previewUrl: (base: string, id: string, n: number) => (isLocalId(id) ? localApi.previewUrl(id, n) : server.previewUrl(base, id, n)),
  clipUrl: (base: string, id: string) => (isLocalId(id) ? localApi.clipUrl(id) : server.clipUrl(base, id)),
};

/**
 * 本地任务的预览直接播原视频，URL 带 #t=起点,终点（媒体片段语法）；
 * 服务端的预览是剪好的片段，起点为 0、没有终点。
 */
export function splitPreviewUrl(url: string): { uri: string; offset: number; end?: number } {
  const m = url.match(/^(.*)#t=([\d.]+)(?:,([\d.]+))?$/);
  if (!m) return { uri: url, offset: 0 };
  return { uri: m[1], offset: Number(m[2]), end: m[3] === undefined ? undefined : Number(m[3]) };
}

export type PickedVideo = { uri: string; name: string; mimeType: string; webFile?: Blob };

/** 上传视频并创建任务。原生端用 expo-file-system 的上传任务（大文件不进 JS 内存，有进度）。 */
export async function uploadVideo(
  base: string,
  video: PickedVideo,
  params: { me_side: MeSide; min_hits: number },
  onProgress: (fraction: number) => void,
): Promise<Job> {
  const fields = { me_side: params.me_side, min_hits: String(params.min_hits) };

  if (Platform.OS === 'web') {
    const form = new FormData();
    form.append('file', video.webFile ?? (await (await fetch(video.uri)).blob()), video.name);
    Object.entries(fields).forEach(([k, v]) => form.append(k, v));
    return request<Job>(base, '/jobs', { method: 'POST', body: form });
  }

  let result;
  try {
    const task = new File(video.uri).createUploadTask(`${base}/jobs`, {
      uploadType: UploadType.MULTIPART,
      fieldName: 'file',
      mimeType: video.mimeType,
      parameters: fields,
      sessionType: 'foreground',
      onProgress: ({ bytesSent, totalBytes }) => totalBytes > 0 && onProgress(bytesSent / totalBytes),
    });
    result = await task.uploadAsync();
  } catch {
    throw new ApiError(`上传失败，连不上服务器 ${base}。`);
  }
  if (result.status < 200 || result.status >= 300) {
    throw new ApiError(`上传失败（${result.status}）：${result.body.slice(0, 200)}`);
  }
  return JSON.parse(result.body) as Job;
}

export const WINNER_LABEL: Record<Winner, string> = {
  unknown: '待确认',
  me: '我赢',
  coach: '教练赢',
  practice: '练习',
  unclear: '看不清',
};

export const CONFIDENCE_LABEL = { high: '高', medium: '中', low: '低' } as const;

export function fmtSpeed(s: { kmh: number; kmh_low: number; kmh_high: number; confidence: keyof typeof CONFIDENCE_LABEL }) {
  return `${Math.round(s.kmh_low)}–${Math.round(s.kmh_high)} km/h，可信度${CONFIDENCE_LABEL[s.confidence]}`;
}

export function fmtTime(s: number) {
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  return `${m}:${sec.toFixed(1).padStart(4, '0')}`;
}
