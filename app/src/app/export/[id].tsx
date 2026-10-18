import { router, useLocalSearchParams } from 'expo-router';
import { Check, CheckCircle2, Download, Gauge, Play, Share2, ImageDown } from 'lucide-react-native';
import { useCallback, useEffect, useRef, useState, type ComponentType } from 'react';
import { Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Button, Eyebrow, H1, MonoText, ProgressBar, Screen, TopBar } from '../../components/ui';
import { api, ApiError, type ExportQuality, type ExportRatio, type Job } from '../../lib/api';
import { saveClipToLibrary, shareClip } from '../../lib/clipFile';
import { clipsDuration, fmtClock, useDraft } from '../../lib/draft';
import { useSettings } from '../../lib/settings';
import { colors as c } from '../../lib/theme';

const RATIOS: ExportRatio[] = ['9:16', '16:9', '1:1'];
const PREVIEW_SIZE: Record<ExportRatio, { width: number; height: number; marginV: number }> = {
  '9:16': { width: 180, height: 285, marginV: 12 },
  '16:9': { width: 310, height: 174, marginV: 68 },
  '1:1': { width: 244, height: 244, marginV: 33 },
};
const QUALITIES: { value: ExportQuality; label: string; hint: string }[] = [
  { value: '720p', label: '720p', hint: '短边最多 720，文件更小' },
  { value: '1080p', label: '1080p', hint: '推荐 · 短边最多 1080，不放大' },
  { value: null, label: '原画', hint: '保持拍摄时的分辨率' },
];

type Busy = { kind: 'save' | 'share'; p: number } | null;

function ShareTile({ Icon, label, onPress, busy }: { Icon: ComponentType<{ size?: number; strokeWidth?: number; color?: string }>; label: string; onPress: () => void; busy?: number }) {
  return (
    <Pressable style={({ pressed }) => [styles.tile, pressed && { opacity: 0.7 }]} onPress={onPress} disabled={busy !== undefined} accessibilityRole="button">
      <Icon size={22} strokeWidth={1.75} color={c.fg} />
      <Text style={{ color: c.fg, fontSize: 11 }}>{busy !== undefined ? `${Math.round(busy * 100)}%` : label}</Text>
    </Pressable>
  );
}

export default function ExportScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { serverUrl } = useSettings();
  const { clips } = useDraft(id);
  const [ratio, setRatio] = useState<ExportRatio>('9:16');
  const [quality, setQuality] = useState<ExportQuality>('1080p');
  const [job, setJob] = useState<Job | null>(null);
  const [started, setStarted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [saved, setSaved] = useState(false);
  const doneAt = useRef(0);

  const load = useCallback(async () => {
    try {
      setJob(await api.getJob(serverUrl, id));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  }, [serverUrl, id]);

  const exp = job?.export;
  const running = exp?.status === 'running';
  useEffect(() => {
    load();
    if (!running && !started) return;
    const t = setInterval(load, 1000);
    return () => clearInterval(t);
  }, [load, running, started]);

  const done = started && exp?.status === 'done';
  useEffect(() => {
    if (done && !doneAt.current) doneAt.current = Date.now();
    if (started && exp?.status === 'failed') {
      setStarted(false);
      setError(exp.error ?? '导出失败');
    }
  }, [done, started, exp]);

  const start = async () => {
    setError(null);
    setSaved(false);
    doneAt.current = 0;
    try {
      const state = await api.startExport(serverUrl, id, {
        include: ['me'],
        clips: clips.map(({ n, start, end }) => ({ n, start, end })),
        ratio,
        quality,
      });
      // 先用返回的“导出中”覆盖上一次导出的“已完成”，免得直接跳到完成页
      setJob((j) => j && { ...j, export: state });
      setStarted(true);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  };

  const url = api.clipUrl(serverUrl, id);
  const run = async (kind: 'save' | 'share') => {
    setError(null);
    setBusy({ kind, p: 0 });
    try {
      const onP = (p: number) => setBusy({ kind, p });
      const fileName = `highlight_${id}_${doneAt.current}.mp4`;
      if (kind === 'save') {
        await saveClipToLibrary(url, fileName, onP);
        setSaved(true);
      } else {
        await shareClip(url, fileName, onP);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const total = clipsDuration(clips);
  const first = clips[0];
  const size = PREVIEW_SIZE[ratio];

  if (done && exp) {
    return (
      <Screen>
        <ScrollView contentContainerStyle={styles.page}>
          <TopBar title="导出集锦" onBack={() => setStarted(false)} />
          <View style={styles.success}>
            <View style={styles.successIcon}>
              <CheckCircle2 size={38} strokeWidth={1.5} color={c.accent} />
            </View>
            <Eyebrow style={{ textAlign: 'center' }}>导出完成</Eyebrow>
            <H1 size={35} style={{ textAlign: 'center' }}>
              准备好，去分享。
            </H1>
            <Text style={styles.successText}>
              {exp.clips} 个片段，时长 {fmtClock(exp.duration ?? total)}，{quality ?? '原画'} · {ratio}。
              {saved ? '已保存到相册。' : ''}
            </Text>
          </View>
          <View style={styles.grid}>
            <ShareTile Icon={saved ? Check : ImageDown} label={saved ? '已保存' : '存到相册'} onPress={() => run('save')} busy={busy?.kind === 'save' ? busy.p : undefined} />
            <ShareTile Icon={Share2} label="分享" onPress={() => run('share')} busy={busy?.kind === 'share' ? busy.p : undefined} />
            <ShareTile Icon={Play} label="播放" onPress={() => router.push({ pathname: '/result/[id]', params: { id } })} />
          </View>
          {error && <Text style={styles.error}>{error}</Text>}
          <Button title="完成" onPress={() => router.dismissTo('/')} style={{ marginTop: 28 }} />
        </ScrollView>
      </Screen>
    );
  }

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.page} showsVerticalScrollIndicator={false}>
        <TopBar title="导出集锦" />

        <View style={[styles.exportPreview, { width: size.width, height: size.height, marginVertical: size.marginV }]}>
          {first && (
            <Image source={{ uri: api.frameUrl(serverUrl, id, first.start + 1) }} style={StyleSheet.absoluteFill} resizeMode="cover" />
          )}
          <View style={styles.previewTag}>
            <MonoText size={11}>
              {clips.length} 段 · {fmtClock(total)}
            </MonoText>
          </View>
        </View>

        <View style={styles.section}>
          <View style={styles.optionTitle}>
            <Text style={styles.h3}>画面比例</Text>
            <Text style={{ color: '#737378', fontSize: 10 }}>居中裁切</Text>
          </View>
          <View style={styles.segmented}>
            {RATIOS.map((r) => (
              <Pressable
                key={r}
                accessibilityRole="radio"
                accessibilityState={{ selected: ratio === r }}
                onPress={() => setRatio(r)}
                style={[styles.segment, ratio === r && { backgroundColor: '#303034' }]}
              >
                <Text style={{ color: ratio === r ? '#fff' : '#85858a', fontSize: 12, fontWeight: ratio === r ? '600' : '400' }}>{r}</Text>
              </Pressable>
            ))}
          </View>
        </View>

        <View style={styles.section}>
          <View style={styles.optionTitle}>
            <Text style={styles.h3}>清晰度</Text>
            <Gauge size={18} strokeWidth={1.75} color="#737378" />
          </View>
          <View style={styles.qualityList}>
            {QUALITIES.map((q, i) => {
              const on = quality === q.value;
              return (
                <Pressable
                  key={q.label}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: on }}
                  onPress={() => setQuality(q.value)}
                  style={[styles.quality, i > 0 && styles.qualitySep]}
                >
                  <View style={{ gap: 3 }}>
                    <Text style={{ color: on ? '#fff' : '#aaaab0', fontSize: 13, fontWeight: on ? '600' : '400' }}>{q.label}</Text>
                    <Text style={{ color: '#66666b', fontSize: 10 }}>{q.hint}</Text>
                  </View>
                  {on && <Check size={17} strokeWidth={2.5} color={c.accent} />}
                </Pressable>
              );
            })}
          </View>
        </View>

        {error && <Text style={styles.error}>{error}</Text>}
        {running ? (
          <View style={{ marginTop: 28, gap: 10 }}>
            <Button title={`正在导出 ${Math.round((exp?.progress ?? 0) * 100)}%`} onPress={() => {}} disabled />
            <ProgressBar value={exp?.progress ?? 0} />
          </View>
        ) : (
          <Button
            title="导出视频"
            iconLeft
            icon={<Download size={19} strokeWidth={1.75} color="#fff" />}
            onPress={start}
            disabled={clips.length === 0}
            style={{ marginTop: 28 }}
          />
        )}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  page: { paddingHorizontal: 20, paddingBottom: 32 },
  exportPreview: { alignSelf: 'center', borderRadius: 24, overflow: 'hidden', backgroundColor: '#1d1519' },
  previewTag: { position: 'absolute', top: 12, left: 12, paddingHorizontal: 8, paddingVertical: 6, borderRadius: 8, backgroundColor: 'rgba(0,0,0,0.6)' },
  section: { marginTop: 18 },
  optionTitle: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  h3: { color: c.fg, fontSize: 15, fontWeight: '700' },
  segmented: { marginTop: 10, padding: 4, flexDirection: 'row', gap: 4, borderRadius: 15, backgroundColor: '#171719' },
  segment: { flex: 1, minHeight: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  qualityList: { marginTop: 10, borderRadius: 18, overflow: 'hidden', backgroundColor: c.surface },
  quality: { minHeight: 56, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  qualitySep: { borderTopWidth: 1, borderTopColor: c.line, marginLeft: 16, paddingLeft: 0 },
  error: { marginTop: 14, color: c.danger, fontSize: 13, lineHeight: 19 },
  success: { paddingTop: 60, alignItems: 'center' },
  successIcon: { width: 86, height: 86, borderRadius: 43, marginBottom: 34, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(41,151,255,0.12)' },
  successText: { marginTop: 14, color: '#85858a', fontSize: 13, lineHeight: 20, textAlign: 'center' },
  grid: { marginTop: 48, flexDirection: 'row', gap: 12 },
  tile: { flex: 1, minHeight: 90, borderRadius: 20, alignItems: 'center', justifyContent: 'center', gap: 10, backgroundColor: '#171719' },
});
