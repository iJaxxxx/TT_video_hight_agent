import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CalibrationCard } from '../../components/CalibrationCard';
import { CandidateCard } from '../../components/CandidateCard';
import { PreviewModal } from '../../components/PreviewModal';
import { SpeedSummary } from '../../components/SpeedSummary';
import { Button, Card, ProgressBar } from '../../components/ui';
import { api, ApiError, type Candidate, type Job, type Winner } from '../../lib/api';
import { useSettings } from '../../lib/settings';
import { useColors } from '../../lib/theme';

type Filter = 'todo' | 'me' | 'all';
const FILTERS: [Filter, string][] = [
  ['todo', '待确认'],
  ['me', '我赢'],
  ['all', '全部'],
];

export default function JobScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { serverUrl } = useSettings();
  const c = useColors();
  const insets = useSafeAreaInsets();
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('todo');
  const [preview, setPreview] = useState<number | null>(null);
  const exportSeen = useRef(false);

  const load = useCallback(async () => {
    try {
      setJob(await api.getJob(serverUrl, id));
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  }, [serverUrl, id]);

  // 处理中或导出中时每 1.5 秒拉一次状态
  const busy =
    !job ||
    ['uploading', 'queued', 'processing'].includes(job.status) ||
    job.export?.status === 'running' ||
    job.speeds?.status === 'running';
  useEffect(() => {
    load();
    if (!busy) return;
    const t = setInterval(load, 1500);
    return () => clearInterval(t);
  }, [load, busy]);

  // 从标定页回来时刷新一次（处理完成后不再轮询）
  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  // 导出完成后自动跳到成片页（只跳一次）
  useEffect(() => {
    if (job?.export?.status === 'running') exportSeen.current = true;
    if (exportSeen.current && job?.export?.status === 'done') {
      exportSeen.current = false;
      router.push({ pathname: '/result/[id]', params: { id } });
    }
  }, [job?.export?.status, id]);

  const onPick = useCallback(
    async (n: number, winner: Winner) => {
      // 先改界面，失败再回滚
      setJob((j) =>
        j && { ...j, candidates: j.candidates.map((x) => (x.n === n ? { ...x, winner, confirmed: winner !== 'unknown' } : x)) },
      );
      try {
        await api.setWinner(serverUrl, id, n, winner);
        load(); // 最快一板由服务端按“我赢”的分重新挑选
      } catch (e) {
        setError(e instanceof ApiError ? e.message : String(e));
        load();
      }
    },
    [serverUrl, id, load],
  );

  const counts = useMemo(() => {
    const cs = job?.candidates ?? [];
    return {
      all: cs.length,
      me: cs.filter((x) => x.winner === 'me').length,
      todo: cs.filter((x) => !x.confirmed).length,
    };
  }, [job]);

  const shown = useMemo(() => {
    const cs = job?.candidates ?? [];
    if (filter === 'me') return cs.filter((x) => x.winner === 'me');
    if (filter === 'todo') return cs.filter((x) => !x.confirmed);
    return cs;
  }, [job, filter]);

  if (!job) {
    return (
      <View style={styles.center}>
        {error ? <Text style={{ color: c.danger, padding: 24 }}>{error}</Text> : <ActivityIndicator />}
      </View>
    );
  }

  if (job.status === 'failed') {
    return (
      <View style={styles.page}>
        <Card>
          <Text style={[styles.h3, { color: c.danger }]}>处理失败</Text>
          <Text style={{ color: c.fg }}>{job.error}</Text>
        </Card>
      </View>
    );
  }

  if (job.status !== 'review') {
    return (
      <View style={styles.page}>
        <Card>
          <Text style={[styles.h3, { color: c.fg }]}>{job.filename}</Text>
          <ProgressBar value={job.progress} />
          {job.steps.map((s, i) => {
            const done = i < job.step;
            const now = i === job.step;
            return (
              <View key={s} style={styles.stepRow}>
                <Text style={{ width: 22, color: done ? c.t1 : now ? c.primary : c.muted }}>{done ? '✓' : now ? '●' : '○'}</Text>
                <Text style={{ color: done || now ? c.fg : c.muted, fontWeight: now ? '700' : '400' }}>{s}</Text>
                {now && <ActivityIndicator size="small" style={{ marginLeft: 8 }} />}
              </View>
            );
          })}
          {job.hits > 0 && <Text style={{ color: c.muted, fontSize: 13 }}>已检测到 {job.hits} 次击球</Text>}
        </Card>
        {job.video && <CalibrationCard job={job} onChanged={load} />}
      </View>
    );
  }

  const exp = job.export;
  const exporting = exp?.status === 'running';

  return (
    <View style={{ flex: 1 }}>
      <FlatList
        data={shown}
        keyExtractor={(x: Candidate) => String(x.n)}
        contentContainerStyle={[styles.page, { paddingBottom: 140 + insets.bottom }]}
        ListHeaderComponent={
          <View style={{ gap: 12 }}>
            <Text style={{ color: c.muted, fontSize: 13, lineHeight: 19 }}>
              从声音里找到 {job.hits} 次击球，切出 {counts.all} 个候选分。
              {job.llm.enabled ? '大模型已预判，请核对。' : '未配置大模型，请逐个选择结果。'}
              只有标为「我赢」的分会进入成片。
            </Text>
            <SpeedSummary job={job} onPlay={setPreview} />
            <CalibrationCard job={job} onChanged={load} />
            <View style={styles.filters}>
              {FILTERS.map(([f, label]) => {
                const on = filter === f;
                return (
                  <Pressable
                    key={f}
                    onPress={() => setFilter(f)}
                    accessibilityRole="tab"
                    accessibilityState={{ selected: on }}
                    style={[styles.filter, { backgroundColor: on ? c.primary : c.chip }]}
                  >
                    <Text style={{ color: on ? c.onPrimary : c.fg, fontWeight: '600', fontSize: 14 }}>
                      {label} {counts[f]}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
            {error && <Text style={{ color: c.danger }}>{error}</Text>}
          </View>
        }
        ListEmptyComponent={
          <Text style={{ color: c.muted, textAlign: 'center', paddingVertical: 32 }}>
            {filter === 'todo' ? '全部确认完了。' : filter === 'me' ? '还没有标为「我赢」的分。' : '没有找到候选分。'}
          </Text>
        }
        renderItem={({ item }) => (
          <CandidateCard
            cand={item}
            sheetUrl={api.sheetUrl(serverUrl, id, item.n)}
            onPick={onPick}
            onPreview={setPreview}
            speedsRunning={job.speeds?.status === 'running'}
            fastest={job.fastest?.n === item.n}
          />
        )}
      />

      <View style={[styles.footer, { backgroundColor: c.surface, borderColor: c.line, paddingBottom: 12 + insets.bottom }]}>
        {exporting && <ProgressBar value={exp.progress} color={c.t1} />}
        {exp?.status === 'failed' && <Text style={{ color: c.danger, fontSize: 13 }}>{exp.error}</Text>}
        <View style={{ flexDirection: 'row', gap: 10 }}>
          {exp?.status === 'done' && (
            <Button
              kind="secondary"
              title="看成片"
              onPress={() => router.push({ pathname: '/result/[id]', params: { id } })}
              style={{ flex: 1 }}
            />
          )}
          <Button
            title={exporting ? '正在导出…' : `导出我的得分球（${counts.me}）`}
            onPress={() => api.startExport(serverUrl, id, ['me']).then(load, (e) => setError(String(e.message ?? e)))}
            disabled={counts.me === 0}
            loading={exporting}
            style={{ flex: 2 }}
          />
        </View>
      </View>

      <PreviewModal
        url={preview === null ? null : api.previewUrl(serverUrl, id, preview)}
        title={preview === null ? '' : `第 ${preview + 1} 分`}
        onClose={() => setPreview(null)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  page: { padding: 16, gap: 14 },
  h3: { fontSize: 16, fontWeight: '700' },
  stepRow: { flexDirection: 'row', alignItems: 'center' },
  filters: { flexDirection: 'row', gap: 8 },
  filter: { borderRadius: 99, paddingHorizontal: 14, paddingVertical: 7 },
  footer: { position: 'absolute', left: 0, right: 0, bottom: 0, borderTopWidth: 1, paddingHorizontal: 16, paddingTop: 12, gap: 8 },
});
