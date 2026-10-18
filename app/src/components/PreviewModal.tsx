import { useEventListener } from 'expo';
import { useVideoPlayer, VideoView } from 'expo-video';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { splitPreviewUrl } from '../lib/api';

/** 单个候选分的 720p 预览。服务端第一次请求时才剪，可能要等一两秒。本地任务直接从原视频的回合起点播 */
function Player({ url }: { url: string }) {
  const { uri, offset, end } = splitPreviewUrl(url);
  const player = useVideoPlayer(uri, (p) => {
    p.loop = end === undefined;
    p.timeUpdateEventInterval = 0.1;
    if (offset) p.currentTime = offset;
    p.play();
  });
  // 加载前设置的 currentTime 可能不生效，可以播放时再跳一次
  useEventListener(player, 'statusChange', ({ status }) => {
    if (status === 'readyToPlay' && offset && player.currentTime < offset - 0.5) player.currentTime = offset;
  });
  // 本地任务播的是整段原视频：到回合结尾就停，回到回合开头
  useEventListener(player, 'timeUpdate', ({ currentTime }) => {
    if (end !== undefined && currentTime >= end) {
      player.pause();
      player.currentTime = offset;
    }
  });
  return <VideoView player={player} style={styles.video} nativeControls contentFit="contain" />;
}

export function PreviewModal({ url, title, onClose }: { url: string | null; title: string; onClose: () => void }) {
  return (
    <Modal visible={!!url} animationType="slide" onRequestClose={onClose} supportedOrientations={['portrait', 'landscape']}>
      <SafeAreaView style={styles.root}>
        <View style={styles.bar}>
          <Text style={styles.title}>{title}</Text>
          <Pressable onPress={onClose} hitSlop={12} accessibilityRole="button">
            <Text style={styles.close}>关闭</Text>
          </Pressable>
        </View>
        {url && <Player url={url} />}
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  bar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 12 },
  title: { color: '#fff', fontSize: 16, fontWeight: '600' },
  close: { color: '#fff', fontSize: 16 },
  video: { flex: 1 },
});
