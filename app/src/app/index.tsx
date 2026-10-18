import * as ImagePicker from 'expo-image-picker';
import { Link, router, Stack, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Button, Card, ProgressBar } from '../components/ui';
import { api, ApiError, uploadVideo, type JobSummary, type MeSide } from '../lib/api';
import { useSettings } from '../lib/settings';
import { useColors } from '../lib/theme';

type Health = { state: 'checking' } | { state: 'ok'; llm: boolean } | { state: 'error'; message: string };

const STATUS_LABEL: Record<JobSummary['status'], string> = {
  uploading: '上传中',
  queued: '排队中',
  processing: '处理中',
  review: '待确认',
  failed: '失败',
};

export default function Home() {
  const c = useColors();
  const { serverUrl, meSide, update, ready } = useSettings();
  const [health, setHealth] = useState<Health>({ state: 'checking' });
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [upload, setUpload] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!ready) return;
    setHealth({ state: 'checking' });
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
    }, [refresh]),
  );

  const pickAndUpload = async () => {
    setError(null);
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['videos'],
      // 直接拿原文件，不让 iOS 先转码（转码又慢又可能降画质）
      preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Current,
      quality: 1,
    });
    if (res.canceled || !res.assets[0]) return;
    const a = res.assets[0];
    setUpload(0);
    try {
      const job = await uploadVideo(
        serverUrl,
        { uri: a.uri, name: a.fileName ?? 'video.mov', mimeType: a.mimeType ?? 'video/quicktime', webFile: a.file },
        { me_side: meSide, min_hits: 2 },
        setUpload,
      );
      router.push({ pathname: '/job/[id]', params: { id: job.id } });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : `上传失败：${String(e)}`);
    } finally {
      setUpload(null);
    }
  };

  return (
    <>
      <Stack.Screen
        options={{
          headerRight: () => (
            <Link href="/settings" asChild>
              <Pressable hitSlop={12} accessibilityRole="button">
                <Text style={{ color: c.primary, fontSize: 16 }}>设置</Text>
              </Pressable>
            </Link>
          ),
        }}
      />
      <ScrollView
        contentContainerStyle={styles.page}
        refreshControl={<RefreshControl refreshing={false} onRefresh={refresh} />}
      >
        <Card>
          <View style={styles.row}>
            <View
              style={[
                styles.dot,
                { backgroundColor: health.state === 'ok' ? c.t1 : health.state === 'error' ? c.danger : c.muted },
              ]}
            />
            <Text style={[styles.h3, { color: c.fg }]}>
              {health.state === 'ok' ? '服务器已连接' : health.state === 'error' ? '服务器未连接' : '正在连接服务器…'}
            </Text>
          </View>
          <Text style={[styles.small, { color: c.muted }]} selectable>
            {serverUrl}
          </Text>
          {health.state === 'ok' && (
            <Text style={[styles.small, { color: health.llm ? c.t1 : c.t3 }]}>
              {health.llm ? '大模型复核：已开启' : '大模型复核：未配置 API Key，候选分需要你手动确认'}
            </Text>
          )}
          {health.state === 'error' && (
            <>
              <Text style={[styles.small, { color: c.danger }]}>{health.message}</Text>
              <Link href="/settings" style={{ color: c.primary, fontSize: 14 }}>
                修改服务器地址
              </Link>
            </>
          )}
        </Card>

        <Card>
          <Text style={[styles.h3, { color: c.fg }]}>我在画面里的位置</Text>
          <View style={styles.segment}>
            {(
              [
                ['far', '远端', '网的另一侧'],
                ['near', '近端', '靠近镜头'],
              ] as [MeSide, string, string][]
            ).map(([value, label, hint]) => {
              const on = meSide === value;
              return (
                <Pressable
                  key={value}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: on }}
                  onPress={() => update({ meSide: value })}
                  style={[
                    styles.segItem,
                    { borderColor: on ? c.primary : c.line, backgroundColor: on ? c.t2bg : c.surface },
                  ]}
                >
                  <Text style={{ color: on ? c.primary : c.fg, fontWeight: '700', fontSize: 15 }}>{label}</Text>
                  <Text style={{ color: c.muted, fontSize: 12 }}>{hint}</Text>
                </Pressable>
              );
            })}
          </View>
          <Text style={[styles.small, { color: c.muted }]}>大模型判断谁得分时会用到。固定机位下按位置区分，不做人脸识别。</Text>
        </Card>

        <Button
          title={upload !== null ? '上传中…' : '选择视频并开始剪辑'}
          onPress={pickAndUpload}
          disabled={health.state !== 'ok' || upload !== null}
        />
        {upload !== null && (
          <View style={{ gap: 6 }}>
            <ProgressBar value={upload} />
            <Text style={[styles.small, { color: c.muted }]}>
              上传 {Math.round(upload * 100)}%。长视频文件较大，请保持 App 在前台。
            </Text>
          </View>
        )}
        {error && <Text style={[styles.small, { color: c.danger }]}>{error}</Text>}

        {jobs.length > 0 && (
          <View style={{ gap: 10 }}>
            <Text style={[styles.section, { color: c.muted }]}>最近的任务</Text>
            {jobs.map((j) => (
              <Link key={j.id} href={{ pathname: '/job/[id]', params: { id: j.id } }} asChild>
                <Pressable>
                  <Card style={styles.jobRow}>
                    <View style={{ flex: 1, gap: 2 }}>
                      <Text style={{ color: c.fg, fontSize: 15, fontWeight: '600' }} numberOfLines={1}>
                        {j.filename}
                      </Text>
                      <Text style={[styles.small, { color: c.muted }]}>
                        {new Date(j.created * 1000).toLocaleString()} · {j.count} 个候选分
                      </Text>
                    </View>
                    <Text style={{ color: j.status === 'failed' ? c.danger : c.primary, fontWeight: '600' }}>
                      {STATUS_LABEL[j.status]}
                    </Text>
                  </Card>
                </Pressable>
              </Link>
            ))}
          </View>
        )}
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  page: { padding: 16, gap: 16, paddingBottom: 48 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  h3: { fontSize: 16, fontWeight: '700' },
  small: { fontSize: 13, lineHeight: 19 },
  section: { fontSize: 13, fontWeight: '700', letterSpacing: 1 },
  segment: { flexDirection: 'row', gap: 10 },
  segItem: { flex: 1, borderWidth: 1.5, borderRadius: 10, paddingVertical: 10, alignItems: 'center', gap: 2 },
  jobRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12 },
});
