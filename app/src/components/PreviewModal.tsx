import { useVideoPlayer, VideoView } from 'expo-video';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { splitPreviewUrl } from '../lib/api';

/** 单个候选分的 720p 预览。服务端第一次请求时才剪，可能要等一两秒。本地任务直接从原视频的回合起点播 */
function Player({ url }: { url: string }) {
  const { uri, offset } = splitPreviewUrl(url);
  const player = useVideoPlayer(uri, (p) => {
    p.loop = !offset;
    if (offset) p.currentTime = offset;
    p.play();
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
