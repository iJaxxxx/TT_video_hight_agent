import { router } from 'expo-router';
import { useVideoPlayer, VideoView } from 'expo-video';
import { Check, Sparkles, UserRound, Video } from 'lucide-react-native';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Button, Eyebrow, H1, ProgressBar, Screen, TopBar } from '../components/ui';
import { ApiError, uploadVideo, type MeSide } from '../lib/api';
import { fmtClock, getPendingVideo, setPendingVideo } from '../lib/draft';
import { useSettings } from '../lib/settings';
import { colors as c } from '../lib/theme';

/** 选好的视频第一帧，上面叠远端 / 近端两个可点的球员标记 */
function CourtPreview({ uri, duration, selected, onSelect }: { uri: string; duration?: number; selected: MeSide; onSelect: (s: MeSide) => void }) {
  const player = useVideoPlayer(uri, (p) => {
    p.muted = true;
  });
  const Marker = ({ side, label }: { side: MeSide; label: string }) => {
    const on = selected === side;
    return (
      <Pressable
        accessibilityRole="radio"
        accessibilityState={{ selected: on }}
        onPress={() => onSelect(side)}
        style={[styles.marker, side === 'far' ? { top: 16 } : { bottom: 16 }, on && styles.markerOn]}
      >
        <UserRound size={20} strokeWidth={1.75} color={on ? '#fff' : '#d2d2d5'} />
        <Text style={{ color: on ? '#fff' : '#d2d2d5', fontSize: 12, fontWeight: on ? '600' : '400' }}>{label}</Text>
        {on && <Check size={14} strokeWidth={2.5} color="#fff" />}
      </Pressable>
    );
  };
  return (
    <View style={styles.preview}>
      <View style={styles.pillRow}>
        <Video size={14} strokeWidth={1.75} color="#aaaab0" />
        <Text style={styles.pill}>比赛视频{duration ? ` · ${fmtClock(duration)}` : ''}</Text>
      </View>
      <View style={styles.court}>
        <VideoView player={player} style={styles.fill} contentFit="cover" nativeControls={false} pointerEvents="none" />
        <View style={styles.net} pointerEvents="none" />
        <Marker side="far" label="远端球员" />
        <Marker side="near" label="近端球员" />
      </View>
    </View>
  );
}

export default function ImportScreen() {
  const { serverUrl, meSide, update } = useSettings();
  const [video] = useState(getPendingVideo);
  const [side, setSide] = useState<MeSide>(meSide);
  const [upload, setUpload] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!video) {
    // 直接打开了这个页面（比如网页刷新），回首页重新选
    return (
      <Screen style={{ paddingHorizontal: 20 }}>
        <TopBar />
        <Text style={{ color: c.muted, textAlign: 'center', marginTop: 80 }}>没有选中的视频，请回首页重新导入。</Text>
      </Screen>
    );
  }

  const start = async () => {
    setError(null);
    setUpload(0);
    update({ meSide: side });
    try {
      const job = await uploadVideo(serverUrl, video, { me_side: side, min_hits: 2 }, setUpload);
      setPendingVideo(null);
      router.replace({ pathname: '/job/[id]', params: { id: job.id, fresh: '1' } });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : `上传失败：${String(e)}`);
      setUpload(null);
    }
  };

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.page} showsVerticalScrollIndicator={false}>
        <TopBar title="1 / 2" muted />
        <View style={styles.stepTrack}>
          <View style={styles.stepFill} />
        </View>

        <View style={{ marginTop: 32 }}>
          <Eyebrow>设置识别对象</Eyebrow>
          <H1 size={34}>这一边，是你吗？</H1>
          <Text style={styles.lead}>点击球台一侧的球员，AI 将只为你保留得分高光。</Text>
        </View>

        <CourtPreview uri={video.uri} duration={video.duration} selected={side} onSelect={setSide} />

        <View style={styles.summary}>
          <View style={styles.summaryIcon}>
            <Check size={18} strokeWidth={2.5} color={c.accent} />
          </View>
          <View style={{ gap: 3 }}>
            <Text style={{ color: c.fg, fontSize: 13, fontWeight: '600' }}>已选择{side === 'near' ? '近端' : '远端'}球员</Text>
            <Text style={{ color: '#717177', fontSize: 11 }}>按位置区分，不做人脸识别</Text>
          </View>
        </View>

        {upload === null ? (
          <Button
            title="开始 AI 分析"
            onPress={start}
            icon={<Sparkles size={19} strokeWidth={1.75} color="#fff" />}
            style={{ marginTop: 28 }}
          />
        ) : (
          <View style={{ marginTop: 28, gap: 10 }}>
            <Button title={`上传中 ${Math.round(upload * 100)}%`} onPress={() => {}} disabled />
            <ProgressBar value={upload} />
          </View>
        )}
        {error && <Text style={styles.error}>{error}</Text>}
        <Text style={styles.note}>
          {upload === null ? '分析约需 3–5 分钟，可在后台继续运行' : '长视频文件较大，上传时请保持 App 在前台'}
        </Text>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  // 网页端 <video> 只给 inset 不会撑满，要显式宽高
  fill: { position: 'absolute', top: 0, left: 0, width: '100%', height: '100%' },
  page: { paddingHorizontal: 20, paddingBottom: 40 },
  stepTrack: { height: 3, borderRadius: 3, backgroundColor: '#24252a' },
  stepFill: { width: '50%', height: 3, borderRadius: 3, backgroundColor: c.accent },
  lead: { marginTop: 12, color: '#8d8d93', fontSize: 14, lineHeight: 22 },
  preview: { marginTop: 27, borderRadius: 26, overflow: 'hidden', backgroundColor: '#141214', paddingBottom: 12 },
  pillRow: { height: 37, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 6 },
  pill: { color: '#aaaab0', fontSize: 10 },
  court: { height: 260, marginHorizontal: 12, borderRadius: 16, overflow: 'hidden', backgroundColor: '#20171c' },
  net: { position: 'absolute', left: 25, right: 25, top: '50%', height: 2, backgroundColor: 'rgba(255,255,255,0.35)' },
  marker: {
    position: 'absolute',
    alignSelf: 'center',
    minWidth: 126,
    minHeight: 44,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    borderRadius: 22,
    backgroundColor: 'rgba(12,13,15,0.74)',
  },
  markerOn: { backgroundColor: c.accent },
  summary: { marginTop: 19, marginHorizontal: 3, flexDirection: 'row', alignItems: 'center', gap: 12 },
  summaryIcon: { width: 33, height: 33, borderRadius: 17, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(10,132,255,0.12)' },
  error: { marginTop: 12, color: c.danger, fontSize: 13, lineHeight: 19 },
  note: { marginTop: 10, textAlign: 'center', color: '#67676d', fontSize: 11 },
});
