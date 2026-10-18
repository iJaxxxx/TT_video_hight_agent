import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { Check, ChevronRight, Clock3, Gauge, MoreHorizontal, Play, Sparkles, Trash2, Crosshair } from 'lucide-react-native';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { PreviewModal } from '../../components/PreviewModal';
import { jobTitle } from '../../components/ProjectRow';
import { Button, Eyebrow, H1, IconButton, MonoText, ProgressBar, Screen, Sheet, TopBar } from '../../components/ui';
import { api, ApiError, CONFIDENCE_LABEL, fmtTime, WINNER_LABEL, type Candidate, type Job, type Winner } from '../../lib/api';
import { clipsDuration, ensureDraft, fmtClock, toggleClip, useDraft } from '../../lib/draft';
import { isLocalId, localMissing, localTimings } from '../../lib/local/jobs';
import { useSettings } from '../../lib/settings';
import { colors as c, mono, winnerColor } from '../../lib/theme';

type Filter = 'mine' | 'all' | 'opponent';
const FILTERS: [Filter, string][] = [
  ['mine', '我的得分'],
  ['all', '全部回合'],
  ['opponent', '对手得分'],
];

const BADGE: Record<Winner, string> = { me: '我的得分', coach: '对手得分', practice: '练习', unclear: '看不清', unknown: '待确认' };
const CHOICES: Winner[] = ['me', 'coach', 'practice', 'unclear'];

function llmLine(cand: Candidate): string {
  const r = cand.llm;
  switch (r.status) {
    case 'skipped_no_key':
      return '未配置大模型，请看预览后手动选择。';
    case 'pending':
      return '大模型复核中…';
    case 'error':
      return `大模型调用失败，请手动选择（${r.error.slice(0, 60)}）`;
    case 'agreed':
      return `AI 判断：${BADGE[r.winner]}（可信度 ${r.confidence ?? '-'}）${r.evidence ? `。${r.evidence}` : ''}`;
    case 'disagreed':
      return `AI 两次判断不一致（${r.votes.map((v) => BADGE[v]).join(' / ')}），请手动确认。`;
  }
}

// ———————————————————— 分析中 ————————————————————

function AnalysisView({ job, done, onShow }: { job: Job; done: boolean; onShow: () => void }) {
  const pct = done ? 100 : Math.round(job.progress * 100);
  const mine = job.candidates.filter((x) => x.winner === 'me').length;
  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.page} showsVerticalScrollIndicator={false}>
        <TopBar title="AI 分析" muted onBack={() => router.replace('/')} />
        <View style={styles.hero}>
          <View style={styles.orbit}>
            <Sparkles size={34} strokeWidth={1.5} color="#d9c7ce" />
          </View>
          <Eyebrow style={{ textAlign: 'center' }}>{done ? '分析完成' : '正在理解比赛'}</Eyebrow>
          <H1 size={34} style={{ textAlign: 'center' }}>
            {done ? '你的高光，准备好了。' : '精彩正在浮现。'}
          </H1>
          <Text style={styles.heroText}>AI 正在逐帧识别回合与得分，不需要停留在此页面。</Text>
        </View>

        <View style={styles.progressCard}>
          <Text style={styles.pct}>
            {pct}
            <Text style={{ color: c.muted, fontSize: 15 }}>%</Text>
          </Text>
          <View style={{ marginTop: 14, marginBottom: 22 }}>
            <ProgressBar value={pct / 100} />
          </View>
          <View style={{ gap: 16 }}>
            {job.steps.map((s, i) => {
              const isDone = done || i < job.step;
              const active = !done && i === job.step;
              return (
                <View key={s} style={styles.stepRow}>
                  <View style={[styles.stepDot, isDone && { backgroundColor: c.accent }, active && styles.stepDotActive]}>
                    {isDone && <Check size={14} strokeWidth={2.5} color="#fff" />}
                  </View>
                  <Text style={[styles.stepLabel, { color: active ? c.fg : isDone ? '#a8a8ad' : '#636368' }]}>{s}</Text>
                  {active ? (
                    <ActivityIndicator size="small" color={c.accent} />
                  ) : (
                    <Text style={[styles.stepState, { color: isDone ? '#a8a8ad' : '#636368' }]}>{isDone ? '已完成' : '等待中'}</Text>
                  )}
                </View>
              );
            })}
          </View>
          {!done && job.hits > 0 && <Text style={styles.hits}>已检测到 {job.hits} 次击球</Text>}
        </View>

        {done ? (
          <Button
            title={mine > 0 ? `查看 ${mine} 个精彩回合` : `查看 ${job.candidates.length} 个回合`}
            onPress={onShow}
            icon={<ChevronRight size={19} strokeWidth={1.75} color="#fff" />}
            style={{ marginTop: 28 }}
          />
        ) : (
          <Button kind="quiet" title="返回首页，后台继续" onPress={() => router.replace('/')} style={{ marginTop: 24 }} />
        )}
      </ScrollView>
    </Screen>
  );
}

// ———————————————————— 结果 ————————————————————

const RallyCard = memo(function RallyCard({
  cand,
  sheetUrl,
  selected,
  fastest,
  onToggle,
  onWinner,
  onPreview,
}: {
  cand: Candidate;
  sheetUrl: string;
  selected: boolean;
  fastest: boolean;
  onToggle: (c: Candidate) => void;
  onWinner: (c: Candidate) => void;
  onPreview: (n: number) => void;
}) {
  const tag = winnerColor(c, cand.winner);
  const label = cand.confirmed || cand.winner === 'unknown' ? BADGE[cand.winner] : `${BADGE[cand.winner]}？`;
  const sp = cand.speed?.status === 'ok' ? cand.speed : null;
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked: selected }}
      onPress={() => onToggle(cand)}
      style={({ pressed }) => [styles.rally, pressed && { backgroundColor: 'rgba(35,36,41,0.96)', transform: [{ scale: 0.985 }] }]}
    >
      <View style={[styles.check, selected && styles.checkOn]}>{selected && <Check size={13} strokeWidth={2.5} color="#fff" />}</View>
      <Pressable onPress={() => onPreview(cand.n)} accessibilityRole="button" accessibilityLabel={`播放第 ${cand.n + 1} 回合`}>
        <View style={styles.rallyThumb}>
          <Image source={{ uri: sheetUrl }} style={StyleSheet.absoluteFill} resizeMode="cover" />
          <View style={styles.rallyPlay}>
            <Play size={13} color="#fff" fill="#fff" />
          </View>
        </View>
      </Pressable>
      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={styles.rallyMeta}>
          <Text style={{ color: '#88888e', fontSize: 10 }}>第 {cand.n + 1} 回合</Text>
          <Pressable
            onPress={() => onWinner(cand)}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={`修改第 ${cand.n + 1} 回合的得分方`}
            style={[styles.badge, { backgroundColor: tag.bg }, !cand.confirmed && styles.badgeTodo]}
          >
            <Text style={{ color: tag.fg, fontSize: 10, fontWeight: '600' }}>{label}</Text>
          </Pressable>
        </View>
        <MonoText size={18} style={{ marginTop: 7, letterSpacing: 0.5 }}>
          {fmtTime(cand.start)}
        </MonoText>
        <View style={styles.details}>
          <Clock3 size={13} strokeWidth={1.75} color="#77777d" />
          <Text style={styles.detailText}>{fmtClock(cand.end - cand.start)}</Text>
          <View style={styles.dotSep} />
          <Text style={styles.detailText}>{cand.hits} 拍</Text>
          {sp && (
            <>
              <View style={styles.dotSep} />
              <Text style={[styles.detailText, fastest && { color: c.ball, fontWeight: '600' }]}>≈{Math.round(sp.kmh)} km/h</Text>
            </>
          )}
        </View>
      </View>
    </Pressable>
  );
});

function ResultsView({ job, reload }: { job: Job; reload: () => void }) {
  const id = job.id;
  const { serverUrl, lastCorners } = useSettings();
  const insets = useSafeAreaInsets();
  const draft = useDraft(id);
  const counts = useMemo(
    () => ({
      mine: job.candidates.filter((x) => x.winner === 'me').length,
      opponent: job.candidates.filter((x) => x.winner === 'coach').length,
      all: job.candidates.length,
    }),
    [job],
  );
  const [filter, setFilter] = useState<Filter>(counts.mine > 0 ? 'mine' : 'all');
  const [preview, setPreview] = useState<number | null>(null);
  const [judging, setJudging] = useState<Candidate | null>(null);
  const [more, setMore] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [overrides, setOverrides] = useState<Record<number, Winner>>({});

  useEffect(() => {
    ensureDraft(id, job.candidates);
  }, [id, job.candidates]);

  // 改得分方先改界面，服务端回来后以服务端为准
  const cands = useMemo(
    () => job.candidates.map((x) => (x.n in overrides ? { ...x, winner: overrides[x.n], confirmed: overrides[x.n] !== 'unknown' } : x)),
    [job.candidates, overrides],
  );
  const shown = cands.filter((x) => (filter === 'mine' ? x.winner === 'me' : filter === 'opponent' ? x.winner === 'coach' : true));
  const selected = useMemo(() => new Set(draft.clips.map((x) => x.n)), [draft]);

  const onToggle = useCallback((cand: Candidate) => toggleClip(id, cand), [id]);
  const pickWinner = async (cand: Candidate, w: Winner) => {
    setJudging(null);
    setOverrides((o) => ({ ...o, [cand.n]: w }));
    // 标为我的得分 → 自动放进集锦；改成别的 → 拿出来
    toggleClip(id, cand, w === 'me');
    try {
      await api.setWinner(serverUrl, id, cand.n, w);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      reload();
      setOverrides((o) => {
        const { [cand.n]: _, ...rest } = o;
        return rest;
      });
    }
  };

  const reuseCalibration = async () => {
    if (!lastCorners) return;
    setMore(false);
    try {
      await api.setCalibration(serverUrl, id, lastCorners, 0.5);
      reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  };

  const remove = async () => {
    if (!confirmDelete) return setConfirmDelete(true);
    try {
      await api.deleteJob(serverUrl, id);
      setMore(false);
      router.replace('/');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  };

  const total = clipsDuration(draft.clips);
  const timings = localTimings(job);
  const missing = localMissing(job);
  const f = job.fastest;
  const speedsRunning = job.speeds?.status === 'running';

  const header = (
    <View>
      <View style={styles.resultSummary}>
        <View style={{ flex: 1 }}>
          <View style={styles.success}>
            <Check size={13} strokeWidth={2.5} color={c.accent} />
            <Text style={{ color: c.accent, fontSize: 11, fontWeight: '600' }}>分析完成</Text>
          </View>
          <H1 size={30} style={{ maxWidth: 220 }}>
            高光，已经就位。
          </H1>
          <Text style={styles.summaryText}>
            {job.llm.enabled
              ? `已自动选择你的 ${counts.mine} 个得分片段`
              : isLocalId(id)
                ? '本地解析（测试）：点每个回合右上角的标签，确认是谁得分'
                : '未配置大模型：点每个回合右上角的标签，确认是谁得分'}
          </Text>
          {timings?.total !== undefined && (
            <Text style={styles.timing}>
              本地耗时 {timings.total.toFixed(1)}s（音频 {timings.audio?.toFixed(1)}s · 检测 {timings.detect?.toFixed(1)}s · 缩略图{' '}
              {timings.thumbs?.toFixed(1)}s），视频 {fmtClock(job.meta?.duration ?? 0)}，{job.hits} 次击球
            </Text>
          )}
        </View>
        <View style={{ alignItems: 'flex-end', gap: 3 }}>
          <Text style={{ color: '#6f6f75', fontSize: 10 }}>我的得分</Text>
          <MonoText size={21}>
            {counts.mine}
            <Text style={{ color: c.faint, fontSize: 14 }}> / {counts.all}</Text>
          </MonoText>
        </View>
      </View>

      {(f || speedsRunning) && (
        <Pressable style={styles.fastest} onPress={() => f && setPreview(f.n)} disabled={!f}>
          <Gauge size={18} strokeWidth={1.75} color={c.ball} />
          <Text style={{ flex: 1, color: c.fg2, fontSize: 12 }}>
            {f
              ? `最快一板 · 第 ${f.n + 1} 回合 · ${Math.round(f.kmh_low)}–${Math.round(f.kmh_high)} km/h，可信度${CONFIDENCE_LABEL[f.confidence]}`
              : `正在估算球速 ${Math.round((job.speeds?.progress ?? 0) * 100)}%`}
          </Text>
          {f && <MonoText size={15} style={{ color: c.ball }}>{Math.round(f.kmh)}</MonoText>}
        </Pressable>
      )}

      <View style={styles.filterRow}>
        <View style={styles.filterTabs}>
          {FILTERS.map(([v, label]) => {
            const on = filter === v;
            return (
              <Pressable
                key={v}
                accessibilityRole="tab"
                accessibilityState={{ selected: on }}
                onPress={() => setFilter(v)}
                style={[styles.filterTab, on && styles.filterTabOn]}
              >
                <Text style={{ color: on ? c.fg : '#7f7f85', fontSize: 11, fontWeight: on ? '600' : '400' }}>
                  {label} {counts[v]}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>
      {error && <Text style={{ color: c.danger, fontSize: 12, marginTop: 10 }}>{error}</Text>}
      {missing?.video && (
        <Text style={styles.missing}>
          原视频已经不在手机上了（可能是存储空间紧张时被系统清理），回合预览和导出都用不了。请删除这个项目，重新导入视频。
        </Text>
      )}
    </View>
  );

  return (
    <Screen bottomInset={false}>
      <View style={{ paddingHorizontal: 20 }}>
        <TopBar
          title={jobTitle(job.filename)}
          onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))}
          right={
            <IconButton label="更多选项" onPress={() => (setConfirmDelete(false), setMore(true))}>
              <MoreHorizontal size={22} strokeWidth={1.75} color={c.fg} />
            </IconButton>
          }
        />
      </View>
      <FlatList
        data={shown}
        keyExtractor={(x) => String(x.n)}
        contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 110 + insets.bottom, gap: 9 }}
        ListHeaderComponent={header}
        ListHeaderComponentStyle={{ marginBottom: 4 }}
        showsVerticalScrollIndicator={false}
        ListEmptyComponent={
          <Text style={styles.empty}>
            {filter === 'mine' ? '还没有标为「我的得分」的回合。\n切到「全部回合」，点标签确认。' : '这里没有回合。'}
          </Text>
        }
        renderItem={({ item }) => (
          <RallyCard
            cand={item}
            sheetUrl={api.sheetUrl(serverUrl, id, item.n)}
            selected={selected.has(item.n)}
            fastest={f?.n === item.n}
            onToggle={onToggle}
            onWinner={setJudging}
            onPreview={setPreview}
          />
        )}
      />

      <View style={[styles.editBar, { paddingBottom: insets.bottom + 12 }]}>
        <View style={{ gap: 4 }}>
          <Text style={{ color: c.fg, fontSize: 13, fontWeight: '600' }}>{draft.clips.length} 个片段</Text>
          <Text style={{ color: '#77777d', fontSize: 10 }}>预计 {fmtClock(total)}</Text>
        </View>
        <Button
          title="编辑集锦"
          disabled={draft.clips.length === 0}
          onPress={() => router.push({ pathname: '/editor/[id]', params: { id } })}
          icon={<ChevronRight size={18} strokeWidth={1.75} color="#fff" />}
          style={styles.compact}
        />
      </View>

      <Sheet visible={!!judging} onClose={() => setJudging(null)}>
        {judging && (
          <>
            <Text style={styles.sheetTitle}>第 {judging.n + 1} 回合是谁得分？</Text>
            <Text style={styles.sheetText}>{llmLine(judging)}</Text>
            <Button
              kind="secondary"
              title="播放这一分"
              iconLeft
              icon={<Play size={16} color={c.fg} fill={c.fg} />}
              onPress={() => (setPreview(judging.n), setJudging(null))}
            />
            <View style={styles.choices}>
              {CHOICES.map((w) => {
                const on = judging.confirmed && judging.winner === w;
                return (
                  <Pressable
                    key={w}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: on }}
                    onPress={() => pickWinner(judging, on ? 'unknown' : w)}
                    style={[styles.choice, on && { backgroundColor: c.accent }]}
                  >
                    <Text style={{ color: on ? '#fff' : c.fg, fontSize: 14, fontWeight: '600' }}>{w === 'me' ? '我的得分' : w === 'coach' ? '对手得分' : WINNER_LABEL[w]}</Text>
                  </Pressable>
                );
              })}
            </View>
          </>
        )}
      </Sheet>

      <Sheet visible={more} onClose={() => setMore(false)}>
        <Text style={styles.sheetTitle}>{jobTitle(job.filename)}</Text>
        {!isLocalId(id) && (
          <Pressable
            style={styles.sheetRow}
            onPress={() => (setMore(false), router.push({ pathname: '/calibrate/[id]', params: { id } }))}
          >
            <Crosshair size={19} strokeWidth={1.75} color={c.fg2} />
            <View style={{ flex: 1, gap: 3 }}>
              <Text style={styles.sheetRowTitle}>{job.calibration ? '重新标定球台' : '球台标定'}</Text>
              <Text style={styles.sheetRowSub}>
                {job.calibration ? '已标定，用于估算出手球速' : '点一次球台四个角，就能估算每一分的出手球速'}
              </Text>
            </View>
            <ChevronRight size={18} strokeWidth={1.75} color="#5e5e63" />
          </Pressable>
        )}
        {!isLocalId(id) && !job.calibration && lastCorners && (
          <Pressable style={styles.sheetRow} onPress={reuseCalibration}>
            <Crosshair size={19} strokeWidth={1.75} color={c.accent} />
            <View style={{ flex: 1, gap: 3 }}>
              <Text style={styles.sheetRowTitle}>沿用上次的标定</Text>
              <Text style={styles.sheetRowSub}>机位没动过时直接用</Text>
            </View>
          </Pressable>
        )}
        <Pressable style={styles.sheetRow} onPress={remove}>
          <Trash2 size={19} strokeWidth={1.75} color={c.danger} />
          <Text style={[styles.sheetRowTitle, { color: c.danger, flex: 1 }]}>{confirmDelete ? '再点一次，确认删除项目' : '删除项目'}</Text>
        </Pressable>
      </Sheet>

      <PreviewModal
        url={preview === null ? null : api.previewUrl(serverUrl, id, preview)}
        title={preview === null ? '' : `第 ${preview + 1} 回合`}
        onClose={() => setPreview(null)}
      />
    </Screen>
  );
}

// ———————————————————— 页面 ————————————————————

export default function JobScreen() {
  const { id, fresh } = useLocalSearchParams<{ id: string; fresh?: string }>();
  const { serverUrl } = useSettings();
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 在本页看着分析跑完的，先停在“分析完成”，点按钮再进结果
  const [sawBusy, setSawBusy] = useState(fresh === '1');
  const [showResults, setShowResults] = useState(false);

  const load = useCallback(async () => {
    try {
      setJob(await api.getJob(serverUrl, id));
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  }, [serverUrl, id]);

  const busy = !job || ['uploading', 'queued', 'processing'].includes(job.status) || job.speeds?.status === 'running';
  useEffect(() => {
    if (job && job.status !== 'review' && job.status !== 'failed') setSawBusy(true);
  }, [job]);
  useEffect(() => {
    load();
    if (!busy) return;
    const t = setInterval(load, 1500);
    return () => clearInterval(t);
  }, [load, busy]);
  // 从标定页回来时刷新
  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  if (!job) {
    return (
      <Screen style={{ paddingHorizontal: 20 }}>
        <TopBar />
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          {error ? <Text style={{ color: c.danger, padding: 24 }}>{error}</Text> : <ActivityIndicator color={c.muted} />}
        </View>
      </Screen>
    );
  }

  if (job.status === 'failed') {
    return (
      <Screen style={{ paddingHorizontal: 20 }}>
        <TopBar title={jobTitle(job.filename)} />
        <View style={[styles.progressCard, { marginTop: 24, gap: 8 }]}>
          <Text style={{ color: c.danger, fontSize: 16, fontWeight: '700' }}>处理失败</Text>
          <Text style={{ color: c.fg2, fontSize: 13, lineHeight: 19, fontFamily: mono }}>{job.error}</Text>
        </View>
      </Screen>
    );
  }

  if (job.status !== 'review' || (sawBusy && !showResults)) {
    return <AnalysisView job={job} done={job.status === 'review'} onShow={() => setShowResults(true)} />;
  }

  return <ResultsView job={job} reload={load} />;
}

const styles = StyleSheet.create({
  missing: { marginTop: 12, padding: 12, borderRadius: 12, color: c.danger, fontSize: 12, lineHeight: 18, backgroundColor: 'rgba(255,69,58,0.1)' },
  page: { paddingHorizontal: 20, paddingBottom: 32 },
  hero: { paddingTop: 38, alignItems: 'center' },
  orbit: {
    width: 126,
    height: 126,
    borderRadius: 63,
    marginBottom: 32,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#21171c',
    borderWidth: 16,
    borderColor: 'rgba(89,59,71,0.14)',
  },
  heroText: { maxWidth: 290, marginTop: 14, color: c.muted, fontSize: 13, lineHeight: 20, textAlign: 'center' },
  progressCard: { marginTop: 38, padding: 22, borderRadius: 24, backgroundColor: c.surface },
  pct: { color: c.fg, fontFamily: mono, fontSize: 35, fontWeight: '700' },
  stepRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  stepDot: { width: 22, height: 22, borderRadius: 11, marginRight: 6, alignItems: 'center', justifyContent: 'center', backgroundColor: '#29292d' },
  stepDotActive: { borderWidth: 2, borderColor: c.accent },
  stepLabel: { flex: 1, fontSize: 13, fontWeight: '600' },
  stepState: { fontSize: 10 },
  hits: { marginTop: 16, color: '#636368', fontSize: 11 },
  resultSummary: { marginTop: 13, flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12 },
  success: { flexDirection: 'row', alignItems: 'center', gap: 5, marginBottom: 10 },
  summaryText: { marginTop: 7, color: '#85858b', fontSize: 12, lineHeight: 17 },
  timing: { marginTop: 6, color: '#636368', fontSize: 10, lineHeight: 15 },
  fastest: { marginTop: 18, padding: 13, borderRadius: 16, backgroundColor: c.ballBg, flexDirection: 'row', alignItems: 'center', gap: 10 },
  filterRow: { marginTop: 22, flexDirection: 'row', alignItems: 'center', gap: 7 },
  filterTabs: { flex: 1, height: 42, padding: 3, flexDirection: 'row', borderRadius: 13, backgroundColor: c.surface2 },
  filterTab: { flex: 1, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  filterTabOn: { backgroundColor: 'rgba(255,255,255,0.12)' },
  rally: { minHeight: 96, padding: 10, flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: c.surface, borderRadius: 20 },
  check: {
    position: 'absolute',
    zIndex: 2,
    top: 7,
    left: 7,
    width: 21,
    height: 21,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(5,5,7,0.62)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.32)',
  },
  checkOn: { backgroundColor: c.accent, borderColor: c.accent },
  rallyThumb: { width: 104, height: 76, borderRadius: 12, overflow: 'hidden', backgroundColor: '#30232a', alignItems: 'center', justifyContent: 'center' },
  rallyPlay: { width: 29, height: 29, borderRadius: 15, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.6)' },
  rallyMeta: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 6 },
  badge: { paddingHorizontal: 7, paddingVertical: 4, borderRadius: 6 },
  badgeTodo: { borderWidth: 1, borderStyle: 'dashed', borderColor: 'rgba(255,255,255,0.25)' },
  details: { marginTop: 4, flexDirection: 'row', alignItems: 'center', gap: 4 },
  detailText: { color: '#77777d', fontSize: 10 },
  dotSep: { width: 2, height: 2, borderRadius: 1, marginHorizontal: 3, backgroundColor: '#55555a' },
  empty: { color: c.faint, textAlign: 'center', paddingVertical: 48, fontSize: 13, lineHeight: 20 },
  editBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingTop: 12,
    paddingHorizontal: 20,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: 'rgba(10,10,11,0.96)',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(255,255,255,0.08)',
  },
  compact: { minHeight: 44, paddingHorizontal: 19 },
  sheetTitle: { color: c.fg, fontSize: 17, fontWeight: '700' },
  sheetText: { color: c.fg2, fontSize: 13, lineHeight: 19 },
  choices: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  choice: { flexBasis: '48%', flexGrow: 1, minHeight: 48, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: '#2a2a2e' },
  sheetRow: { minHeight: 60, flexDirection: 'row', alignItems: 'center', gap: 13, paddingHorizontal: 14, borderRadius: 16, backgroundColor: c.surface },
  sheetRowTitle: { color: c.fg, fontSize: 14, fontWeight: '600' },
  sheetRowSub: { color: '#727277', fontSize: 11 },
});
