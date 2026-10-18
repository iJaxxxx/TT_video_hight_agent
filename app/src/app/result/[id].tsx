import { File, Paths } from 'expo-file-system';
import * as MediaLibrary from 'expo-media-library';
import { useLocalSearchParams } from 'expo-router';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useEffect, useState } from 'react';
import { Linking, Platform, ScrollView, StyleSheet, Text } from 'react-native';

import { Button, Card, ProgressBar } from '../../components/ui';
import { api, fmtSpeed, type Job } from '../../lib/api';
import { useSettings } from '../../lib/settings';
import { useColors } from '../../lib/theme';

type SaveState = { s: 'idle' } | { s: 'downloading'; p: number } | { s: 'saved' } | { s: 'error'; msg: string };

export default function ResultScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { serverUrl } = useSettings();
  const c = useColors();
  const url = api.clipUrl(serverUrl, id);
  const player = useVideoPlayer(url, (p) => p.play());
  const [job, setJob] = useState<Job | null>(null);
  const [save, setSave] = useState<SaveState>({ s: 'idle' });

  useEffect(() => {
    api.getJob(serverUrl, id).then(setJob, () => {});
  }, [serverUrl, id]);

  const saveToLibrary = async () => {
    if (Platform.OS === 'web') {
      Linking.openURL(url);
      return;
    }
    try {
      const perm = await MediaLibrary.requestPermissionsAsync(true);
      if (!perm.granted) {
        setSave({ s: 'error', msg: '没有相册写入权限。请在系统设置里允许「乒乓高光」访问照片。' });
        return;
      }
      setSave({ s: 'downloading', p: 0 });
      const file = await File.downloadFileAsync(url, new File(Paths.cache, `highlight_${id}.mp4`), {
        idempotent: true,
        onProgress: ({ bytesWritten, totalBytes }) => totalBytes > 0 && setSave({ s: 'downloading', p: bytesWritten / totalBytes }),
      });
      await MediaLibrary.Asset.create(file.uri);
      setSave({ s: 'saved' });
    } catch (e) {
      setSave({ s: 'error', msg: `保存失败：${e instanceof Error ? e.message : String(e)}` });
    }
  };

  const exp = job?.export;
  return (
    <ScrollView contentContainerStyle={styles.page}>
      <VideoView player={player} style={styles.video} nativeControls contentFit="contain" allowsPictureInPicture={false} />
      {exp?.status === 'done' && (
        <Text style={{ color: c.muted, fontSize: 14 }}>
          {exp.clips} 个得分球，共 {exp.duration} 秒。原分辨率，H.264。
        </Text>
      )}
      {job?.fastest && (
        <Card>
          <Text style={{ color: c.muted, fontSize: 13, fontWeight: '700' }}>最快一板</Text>
          <Text style={{ color: c.ball, fontSize: 32, fontWeight: '800', fontVariant: ['tabular-nums'] }}>
            {Math.round(job.fastest.kmh)} km/h
          </Text>
          <Text style={{ color: c.muted, fontSize: 13 }}>
            第 {job.fastest.n + 1} 分的决胜一板，出手速度估算（{fmtSpeed(job.fastest)}）
          </Text>
        </Card>
      )}
      <Card>
        <Button
          title={save.s === 'saved' ? '已保存到相册' : Platform.OS === 'web' ? '下载视频' : '保存到相册'}
          onPress={saveToLibrary}
          disabled={save.s === 'saved'}
          loading={save.s === 'downloading'}
        />
        {save.s === 'downloading' && <ProgressBar value={save.p} color={c.t1} />}
        {save.s === 'error' && <Text style={{ color: c.danger, fontSize: 13 }}>{save.msg}</Text>}
      </Card>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { padding: 16, gap: 14 },
  video: { width: '100%', aspectRatio: 16 / 9, backgroundColor: '#000', borderRadius: 10 },
});
