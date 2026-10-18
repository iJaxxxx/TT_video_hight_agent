import { useSyncExternalStore } from 'react';

import type { Candidate, PickedVideo } from './api';

/**
 * 跨页面的临时状态（只在内存里，App 重启就没了）：
 * - 首页选好、还没上传的视频（Blob 不能放进路由参数）
 * - 每个任务的成片草稿：选中哪些回合、成片顺序、每段的起止时间
 */

export type ClipEdit = { n: number; start: number; end: number };
export type Draft = { clips: ClipEdit[] };

let pendingVideo: (PickedVideo & { duration?: number }) | null = null;
export const setPendingVideo = (v: typeof pendingVideo) => {
  pendingVideo = v;
};
export const getPendingVideo = () => pendingVideo;

const drafts = new Map<string, Draft>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export const clipOf = (c: Candidate): ClipEdit => ({ n: c.n, start: c.start, end: c.end });

/** 第一次进结果页时，默认选中所有标为“我赢”的回合 */
export function ensureDraft(id: string, candidates: Candidate[]) {
  if (drafts.has(id)) return;
  drafts.set(id, { clips: candidates.filter((c) => c.winner === 'me').map(clipOf) });
  emit();
}

export function setDraft(id: string, fn: (d: Draft) => Draft) {
  drafts.set(id, fn(drafts.get(id) ?? { clips: [] }));
  emit();
}

/** 回合的选中切换：选中时按时间顺序插入，保留已有的裁剪 */
export function toggleClip(id: string, c: Candidate, on?: boolean) {
  setDraft(id, (d) => {
    const has = d.clips.some((x) => x.n === c.n);
    const want = on ?? !has;
    if (want === has) return d;
    if (!want) return { clips: d.clips.filter((x) => x.n !== c.n) };
    return { clips: [...d.clips, clipOf(c)].sort((a, b) => a.start - b.start) };
  });
}

const EMPTY: Draft = { clips: [] };
export function useDraft(id: string): Draft {
  return useSyncExternalStore(subscribe, () => drafts.get(id) ?? EMPTY, () => drafts.get(id) ?? EMPTY);
}

export const clipsDuration = (clips: ClipEdit[]) => clips.reduce((s, c) => s + (c.end - c.start), 0);

export function fmtClock(s: number) {
  const t = Math.max(0, Math.round(s));
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}
