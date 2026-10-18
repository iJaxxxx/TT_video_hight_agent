import { router, useFocusEffect } from 'expo-router';
import { ChevronRight } from 'lucide-react-native';
import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { api, type JobSummary } from '../lib/api';
import { useSettings } from '../lib/settings';
import { colors as c } from '../lib/theme';
import { MonoText, ProjectThumb, type ThumbTone } from './ui';

export type Health = { state: 'checking' } | { state: 'ok'; llm: boolean } | { state: 'error'; message: string };

/** 首页 / 项目 / 我的 共用：页面获得焦点时检查服务器并拉任务列表 */
export function useServerJobs() {
  const { serverUrl, ready } = useSettings();
  const [health, setHealth] = useState<Health>({ state: 'checking' });
  const [jobs, setJobs] = useState<JobSummary[] | null>(null);

  const refresh = useCallback(async () => {
    if (!ready) return;
    try {
      const h = await api.health(serverUrl);
      setHealth({ state: 'ok', llm: h.llm_enabled });
      setJobs(await api.listJobs(serverUrl));
    } catch (e) {
      setHealth({ state: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  }, [serverUrl, ready]);

  useFocusEffect(
    useCallback(() => {
      refresh();
      // 有任务在分析时，列表上的状态每 3 秒刷新一次
      const t = setInterval(refresh, 3000);
      return () => clearInterval(t);
    }, [refresh]),
  );

  return { health, jobs, refresh };
}

const TONES: ThumbTone[] = ['warm', 'mid', 'cool'];
const BUSY: JobSummary['status'][] = ['uploading', 'queued', 'processing'];
export const isBusy = (j: JobSummary) => BUSY.includes(j.status);

function fmtDate(sec: number) {
  const d = new Date(sec * 1000);
  const now = new Date();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (d.toDateString() === now.toDateString()) return `今天 ${hm}`;
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}

/** 去掉扩展名，IMG_6921.MOV → IMG_6921 */
export const jobTitle = (filename: string) => filename.replace(/\.[^.]+$/, '');

export function ProjectRow({ job, index }: { job: JobSummary; index: number }) {
  const busy = isBusy(job);
  const meta = busy
    ? `${fmtDate(job.created)} · 分析中 ${Math.round(job.progress * 100)}%`
    : job.status === 'failed'
      ? `${fmtDate(job.created)} · 处理失败`
      : `${fmtDate(job.created)} · ${job.count} 个回合`;
  return (
    <Pressable
      accessibilityRole="button"
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: '#1a1a1d' }]}
      onPress={() => router.push({ pathname: '/job/[id]', params: { id: job.id } })}
    >
      <ProjectThumb tone={TONES[index % TONES.length]} dot={job.status === 'review'} />
      <View style={styles.copy}>
        <Text style={styles.title} numberOfLines={1}>
          {jobTitle(job.filename)}
        </Text>
        <Text style={[styles.meta, job.status === 'failed' && { color: c.danger }]}>{meta}</Text>
      </View>
      {job.status === 'review' ? <MonoText>{job.count}</MonoText> : <MonoText style={{ color: c.faint }}>—</MonoText>}
      <ChevronRight size={18} strokeWidth={1.75} color="#5b5b60" />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { minHeight: 84, paddingHorizontal: 14, paddingVertical: 12, flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: c.surface, borderRadius: 19 },
  copy: { flex: 1, minWidth: 0, gap: 6 },
  title: { color: c.fg, fontSize: 15, fontWeight: '600', letterSpacing: -0.2 },
  meta: { color: '#8d8d93', fontSize: 11 },
});
