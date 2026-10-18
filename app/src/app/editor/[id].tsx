import { router, useLocalSearchParams } from 'expo-router';
import { useEvent, useEventListener } from 'expo';
import { useVideoPlayer, VideoView } from 'expo-video';
import { ChevronLeft, ChevronRight, Minus, Play, Plus, Trash2 } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Button, MonoText, Screen, TopBar } from '../../components/ui';
import { api, fmtTime, splitPreviewUrl, type Candidate, type Job } from '../../lib/api';
import { clipsDuration, fmtClock, setDraft, useDraft, type ClipEdit } from '../../lib/draft';
import { useSettings } from '../../lib/settings';
import { colors as c } from '../../lib/theme';

const STEP = 0.5; // 每次微调 0.5 秒
const SLACK = 3; // 允许在 AI 切出的范围外再多留 3 秒
const MIN_LEN = 1;

const CLIP_TONES = ['#39252e', '#25252a', '#49303b', '#2e2a33'];

/** 当前片段的预览：服务端按回合切好的 720p 预览，从裁剪后的开头播起 */
function ClipPlayer({ url, offset: clipOffset, label, total }: { url: string; offset: number; label: string; total: string }) {
  // 本地任务播的是原视频，起点要加上回合在原视频里的位置
  const { uri, offset: base } = splitPreviewUrl(url);
  const offset = base + clipOffset;
  const player = useVideoPlayer(uri, (p) => {
    p.loop = !base;
    p.currentTime = Math.max(0, offset);
  });
  const { isPlaying } = useEvent(player, 'playingChange', { isPlaying: player.playing });
  useEffect(() => {
    player.currentTime = Math.max(0, offset);
  }, [player, offset]);
  // 本地任务播的是整段原视频，加载完再跳一次到片段起点
  useEventListener(player, 'statusChange', ({ status }) => {
    if (status === 'readyToPlay' && base) player.currentTime = Math.max(0, offset);
  });
  return (
    <Pressable
      style={styles.preview}
      onPress={() => (isPlaying ? player.pause() : player.play())}
      accessibilityRole="button"
      accessibilityLabel={isPlaying ? '暂停预览' : '播放预览'}
    >
      <VideoView player={player} style={styles.fill} contentFit="contain" nativeControls={false} pointerEvents="none" />
      {!isPlaying && (
        <View style={styles.previewPlay}>
          <Play size={23} color="#fff" fill="#fff" />
        </View>
      )}
      <View style={styles.overlay}>
        <MonoText size={13}>{label}</MonoText>
      </View>
      <MonoText size={10} style={styles.previewTime}>
        {total}
      </MonoText>
    </Pressable>
  );
}

function Stepper({ label, value, onMinus, onPlus, minusOff, plusOff }: { label: string; value: string; onMinus: () => void; onPlus: () => void; minusOff: boolean; plusOff: boolean }) {
  return (
    <View style={styles.stepper}>
      <Text style={{ color: '#aaaab0', fontSize: 12, width: 34 }}>{label}</Text>
      <Pressable style={[styles.stepBtn, minusOff && { opacity: 0.3 }]} disabled={minusOff} onPress={onMinus} accessibilityLabel={`${label}提前 ${STEP} 秒`}>
        <Minus size={16} color={c.fg} />
      </Pressable>
      <MonoText size={13} style={{ flex: 1, textAlign: 'center' }}>
        {value}
      </MonoText>
      <Pressable style={[styles.stepBtn, plusOff && { opacity: 0.3 }]} disabled={plusOff} onPress={onPlus} accessibilityLabel={`${label}推后 ${STEP} 秒`}>
        <Plus size={16} color={c.fg} />
      </Pressable>
    </View>
  );
}

export default function EditorScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { serverUrl } = useSettings();
  const { clips } = useDraft(id);
  const [job, setJob] = useState<Job | null>(null);
  const [current, setCurrent] = useState(0);

  useEffect(() => {
    api.getJob(serverUrl, id).then(setJob, () => {});
  }, [serverUrl, id]);

  const byN = new Map<number, Candidate>((job?.candidates ?? []).map((x) => [x.n, x]));
  const idx = Math.min(current, clips.length - 1);
  const clip = clips[idx] as ClipEdit | undefined;
  const cand = clip ? byN.get(clip.n) : undefined;
  const total = clipsDuration(clips);

  const edit = (fn: (list: ClipEdit[]) => ClipEdit[]) => setDraft(id, (d) => ({ clips: fn(d.clips) }));
  const patch = (p: Partial<ClipEdit>) => edit((list) => list.map((x, i) => (i === idx ? { ...x, ...p } : x)));
  const move = (dir: -1 | 1) => {
    const j = idx + dir;
    if (j < 0 || j >= clips.length) return;
    edit((list) => {
      const next = [...list];
      [next[idx], next[j]] = [next[j], next[idx]];
      return next;
    });
    setCurrent(j);
  };

  const lo = cand ? Math.max(0, cand.start - SLACK) : 0;
  const hi = cand ? cand.end + SLACK : 0;

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.page} showsVerticalScrollIndicator={false}>
        <TopBar
          title="编辑集锦"
          right={
            <Pressable style={styles.textAction} onPress={() => router.push({ pathname: '/export/[id]', params: { id } })} disabled={clips.length === 0}>
              <Text style={{ color: clips.length ? c.accent : c.faint, fontSize: 13 }}>下一步</Text>
            </Pressable>
          }
        />

        {clip ? (
          <ClipPlayer
            key={clip.n}
            url={api.previewUrl(serverUrl, id, clip.n)}
            offset={cand ? clip.start - cand.start : 0}
            label={`第 ${clip.n + 1} 回合`}
            total={`${fmtClock(clip.end - clip.start)} / ${fmtClock(total)}`}
          />
        ) : (
          <View style={[styles.preview, { alignItems: 'center', justifyContent: 'center' }]}>
            <Text style={{ color: c.muted, fontSize: 13 }}>集锦里没有片段了</Text>
          </View>
        )}

        <View style={styles.timelineHead}>
          <View style={{ gap: 4 }}>
            <Text style={styles.h3}>时间轴</Text>
            <Text style={{ color: '#747479', fontSize: 10 }}>
              {clips.length} 个片段 · {fmtClock(total)}
            </Text>
          </View>
          <Pressable onPress={() => edit((list) => [...list].sort((a, b) => a.start - b.start))} style={styles.textAction}>
            <Text style={{ color: c.accent, fontSize: 12 }}>按时间排序</Text>
          </Pressable>
        </View>

        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.timeline} contentContainerStyle={{ gap: 5, padding: 6, flexGrow: 1 }}>
          {clips.map((x, i) => (
            <Pressable
              key={x.n}
              onPress={() => setCurrent(i)}
              accessibilityRole="button"
              accessibilityState={{ selected: i === idx }}
              style={[
                styles.clip,
                { flexGrow: x.end - x.start, backgroundColor: CLIP_TONES[i % CLIP_TONES.length] },
                i === idx && { borderColor: c.accent },
              ]}
            >
              <MonoText size={10} style={styles.clipNum}>
                {i + 1}
              </MonoText>
              <Pressable
                accessibilityLabel={`删除片段 ${i + 1}`}
                style={styles.clipDelete}
                hitSlop={4}
                onPress={() => {
                  edit((list) => list.filter((y) => y.n !== x.n));
                  if (i < idx) setCurrent(idx - 1);
                }}
              >
                <Trash2 size={14} strokeWidth={1.75} color="#aaaab0" />
              </Pressable>
            </Pressable>
          ))}
        </ScrollView>

        {clip && cand && (
          <View style={styles.trim}>
            <View style={styles.trimHead}>
              <Text style={{ color: '#aaaab0', fontSize: 11 }}>调整第 {idx + 1} 段</Text>
              <View style={{ flexDirection: 'row', gap: 6 }}>
                <Pressable style={[styles.moveBtn, idx === 0 && { opacity: 0.3 }]} disabled={idx === 0} onPress={() => move(-1)} accessibilityLabel="前移">
                  <ChevronLeft size={16} color={c.fg} />
                </Pressable>
                <Pressable
                  style={[styles.moveBtn, idx === clips.length - 1 && { opacity: 0.3 }]}
                  disabled={idx === clips.length - 1}
                  onPress={() => move(1)}
                  accessibilityLabel="后移"
                >
                  <ChevronRight size={16} color={c.fg} />
                </Pressable>
              </View>
            </View>
            <Stepper
              label="开头"
              value={fmtTime(clip.start)}
              minusOff={clip.start - STEP < lo}
              plusOff={clip.start + STEP > clip.end - MIN_LEN}
              onMinus={() => patch({ start: Math.max(lo, clip.start - STEP) })}
              onPlus={() => patch({ start: Math.min(clip.end - MIN_LEN, clip.start + STEP) })}
            />
            <Stepper
              label="结尾"
              value={fmtTime(clip.end)}
              minusOff={clip.end - STEP < clip.start + MIN_LEN}
              plusOff={clip.end + STEP > hi}
              onMinus={() => patch({ end: Math.max(clip.start + MIN_LEN, clip.end - STEP) })}
              onPlus={() => patch({ end: Math.min(hi, clip.end + STEP) })}
            />
            {(clip.start !== cand.start || clip.end !== cand.end) && (
              <Pressable onPress={() => patch({ start: cand.start, end: cand.end })} style={{ alignSelf: 'flex-start', paddingVertical: 4 }}>
                <Text style={{ color: c.accent, fontSize: 12 }}>恢复 AI 切出的范围</Text>
              </Pressable>
            )}
            <Text style={styles.trimNote}>预览只播 AI 切出的范围；往外延长的部分会出现在成片里。</Text>
          </View>
        )}
        {!job && <ActivityIndicator color={c.muted} style={{ marginTop: 20 }} />}

        <Button
          title="完成编辑"
          disabled={clips.length === 0}
          onPress={() => router.push({ pathname: '/export/[id]', params: { id } })}
          style={{ marginTop: 28 }}
        />
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  // 网页端 <video> 只给 inset 不会撑满，要显式宽高
  fill: { position: 'absolute', top: 0, left: 0, width: '100%', height: '100%' },
  page: { paddingHorizontal: 20, paddingBottom: 32 },
  textAction: { minWidth: 44, minHeight: 44, alignItems: 'flex-end', justifyContent: 'center' },
  preview: { height: 238, borderRadius: 26, overflow: 'hidden', backgroundColor: '#1d1519' },
  previewPlay: {
    position: 'absolute',
    alignSelf: 'center',
    top: 92,
    width: 54,
    height: 54,
    borderRadius: 27,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.58)',
  },
  overlay: { position: 'absolute', top: 15, left: 15, paddingHorizontal: 10, paddingVertical: 7, borderRadius: 9, backgroundColor: 'rgba(0,0,0,0.62)' },
  previewTime: { position: 'absolute', right: 15, bottom: 13, fontWeight: '400' },
  timelineHead: { marginTop: 24, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  h3: { color: c.fg, fontSize: 15, fontWeight: '700' },
  timeline: { height: 78, marginTop: 8, borderRadius: 16, backgroundColor: c.well, flexGrow: 0 },
  clip: { minWidth: 64, borderRadius: 11, borderWidth: 2, borderColor: 'transparent' },
  clipNum: { position: 'absolute', left: 7, bottom: 6 },
  clipDelete: {
    position: 'absolute',
    top: 4,
    right: 4,
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.42)',
  },
  trim: { marginTop: 14, paddingVertical: 15, paddingHorizontal: 17, borderRadius: 18, backgroundColor: c.surface, gap: 10 },
  trimHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  moveBtn: { width: 32, height: 32, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: c.raised },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  stepBtn: { width: 40, height: 36, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: c.raised },
  trimNote: { color: '#66666b', fontSize: 10, lineHeight: 15 },
});
