import { router } from 'expo-router';
import { useState } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';

import { api, ApiError, type Job } from '../lib/api';
import { useSettings } from '../lib/settings';
import { useColors } from '../lib/theme';
import { Button, Card } from './ui';

/** 任务页上的球台标定入口：已标定 → 显示检查图；没标定 → 沿用上次 / 去点四个角 */
export function CalibrationCard({ job, onChanged }: { job: Job; onChanged: () => void }) {
  const c = useColors();
  const { serverUrl, lastCorners } = useSettings();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cal = job.calibration;
  const open = () => router.push({ pathname: '/calibrate/[id]', params: { id: job.id } });

  const reuse = async () => {
    if (!lastCorners) return;
    setBusy(true);
    setError(null);
    try {
      await api.setCalibration(serverUrl, job.id, lastCorners, 0.5);
      onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <View style={styles.head}>
        <Text style={[styles.title, { color: c.fg }]}>球台标定</Text>
        <Text style={{ color: cal ? c.t1 : c.t3, fontSize: 13, fontWeight: '600' }}>{cal ? '已标定' : '未标定'}</Text>
      </View>
      {cal ? (
        <>
          <Image
            source={{ uri: api.calibrationImageUrl(serverUrl, job.id, cal) }}
            style={{ width: '100%', aspectRatio: cal.frame_size[0] / cal.frame_size[1], borderRadius: 8, backgroundColor: c.chip }}
            resizeMode="contain"
          />
          <Text style={[styles.help, { color: c.muted }]}>白框应贴住真实的球台边线。机位动过的话请重新标定。</Text>
          <Button kind="secondary" title="重新标定" onPress={open} />
        </>
      ) : (
        <>
          <Text style={[styles.help, { color: c.muted }]}>
            在画面上点一次球台的四个角，用来测球速、判断落点。同一个机位只需要点一次。
          </Text>
          {lastCorners && <Button title="沿用上次的标定" onPress={reuse} loading={busy} />}
          <Button kind={lastCorners ? 'secondary' : 'primary'} title="点四个角标定" onPress={open} />
          {error && <Text style={{ color: c.danger, fontSize: 13 }}>{error}</Text>}
        </>
      )}
    </Card>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  title: { fontSize: 16, fontWeight: '700' },
  help: { fontSize: 13, lineHeight: 19 },
});
