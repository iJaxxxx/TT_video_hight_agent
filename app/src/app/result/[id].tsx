import { useLocalSearchParams } from 'expo-router';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useEffect, useState } from 'react';
import { Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button, Card, MonoText, ProgressBar } from '../../components/ui';
import { api, fmtSpeed, type Job } from '../../lib/api';
import { saveClipToLibrary } from '../../lib/clipFile';
import { isLocalId, localMissing } from '../../lib/local/jobs';
import { useSettings } from '../../lib/settings';
import { colors as c } from '../../lib/theme';

type SaveState = { s: 'idle' } | { s: 'downloading'; p: number } | { s: 'saved' } | { s: 'error'; msg: string };

/** 成片全屏播放 + 保存到相册 */
export default function ResultScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { serverUrl } = useSettings();
  const insets = useSafeAreaInsets();
  const url = api.clipUrl(serverUrl, id);
  const player = useVideoPlayer(url, (p) => p.play());
  const [job, setJob] = useState<Job | null>(null);
  const [save, setSave] = useState<SaveState>({ s: 'idle' });

  useEffect(() => {
    api.getJob(serverUrl, id).then(setJob, () => {});
  }, [serverUrl, id]);

  const saveToLibrary = async () => {
    try {
      setSave({ s: 'downloading', p: 0 });
      await saveClipToLibrary(url, `highlight_${id}_${job?.export?.duration ?? 0}.mp4`, (p) => setSave({ s: 'downloading', p }));
      setSave(Platform.OS === 'web' ? { s: 'idle' } : { s: 'saved' });
    } catch (e) {
      setSave({ s: 'error', msg: `保存失败：${e instanceof Error ? e.message : String(e)}` });
    }
  };

  const exp = job?.export;
  // 本地成片文件不在了（被删 / 被系统清理），播放器只会黑屏，直接说清楚
  const gone = isLocalId(id) && !!job && (!url || !!localMissing(job)?.clip);
  if (gone) {
    return (
      <View style={[styles.page, { flex: 1, justifyContent: 'center', backgroundColor: c.bg }]}>
        <Text style={{ color: c.fg, fontSize: 16, fontWeight: '700', textAlign: 'center' }}>成片文件找不到了</Text>
        <Text style={{ color: c.muted, fontSize: 13, lineHeight: 19, textAlign: 'center' }}>
          {localMissing(job)?.video
            ? '原视频也已经不在手机上（可能是存储空间紧张时被系统清理），请删除这个项目后重新导入。'
            : '可能被系统清理了。原视频还在，回到项目重新导出一次就好。'}
        </Text>
      </View>
    );
  }
  return (
    <ScrollView contentContainerStyle={[styles.page, { paddingBottom: 20 + insets.bottom }]} style={{ backgroundColor: c.bg }}>
      <VideoView player={player} style={styles.video} nativeControls contentFit="contain" allowsPictureInPicture={false} />
      {exp?.status === 'done' && (
        <Text style={{ color: c.muted, fontSize: 13 }}>
          {exp.clips} 个片段，共 {exp.duration} 秒{exp.ratio ? ` · ${exp.ratio}` : ''} · {exp.quality ?? '原画'}，H.264。
        </Text>
      )}
      {job?.fastest && (
        <Card>
          <Text style={{ color: c.muted, fontSize: 12, fontWeight: '600' }}>最快一板</Text>
          <MonoText size={30} style={{ color: c.ball }}>
            {Math.round(job.fastest.kmh)} km/h
          </MonoText>
          <Text style={{ color: c.muted, fontSize: 12 }}>
            第 {job.fastest.n + 1} 回合的决胜一板，出手速度估算（{fmtSpeed(job.fastest)}）
          </Text>
        </Card>
      )}
      <Button
        title={save.s === 'saved' ? '已保存到相册' : Platform.OS === 'web' ? '下载视频' : '保存到相册'}
        onPress={saveToLibrary}
        disabled={save.s === 'saved'}
        loading={save.s === 'downloading'}
      />
      {save.s === 'downloading' && <ProgressBar value={save.p} />}
      {save.s === 'error' && <Text style={{ color: c.danger, fontSize: 13 }}>{save.msg}</Text>}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { padding: 20, gap: 14 },
  video: { width: '100%', aspectRatio: 16 / 9, backgroundColor: '#000', borderRadius: 16 },
});
