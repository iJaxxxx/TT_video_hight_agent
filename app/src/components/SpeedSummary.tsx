import { StyleSheet, Text, View } from 'react-native';

import { CONFIDENCE_LABEL, type Job } from '../lib/api';
import { useColors } from '../lib/theme';
import { Button, Card, ProgressBar } from './ui';

/** 任务页顶部：球速估算进度 + 最快一板（只在标为“我赢”的分里选） */
export function SpeedSummary({ job, onPlay }: { job: Job; onPlay: (n: number) => void }) {
  const c = useColors();
  const sp = job.speeds;
  if (!job.calibration || !sp || sp.status === 'idle') return null;
  const f = job.fastest;
  const meWithSpeed = job.candidates.filter((x) => x.winner === 'me' && x.speed?.status === 'ok').length;
  const meCount = job.candidates.filter((x) => x.winner === 'me').length;

  return (
    <Card>
      <View style={styles.head}>
        <Text style={[styles.title, { color: c.fg }]}>最快一板</Text>
        {sp.status === 'running' && <Text style={{ color: c.muted, fontSize: 13 }}>估算中 {Math.round((sp.progress ?? 0) * 100)}%</Text>}
      </View>
      {sp.status === 'running' && <ProgressBar value={sp.progress ?? 0} color={c.ball} />}
      {sp.status === 'failed' && <Text style={{ color: c.danger, fontSize: 13 }}>球速估算失败：{sp.error}</Text>}

      {f ? (
        <>
          <View style={styles.big}>
            <Text style={[styles.num, { color: c.ball }]}>{Math.round(f.kmh)}</Text>
            <Text style={[styles.unit, { color: c.fg }]}>km/h</Text>
            <View style={{ flex: 1 }} />
            <Text style={{ color: c.muted, fontSize: 14 }}>第 {f.n + 1} 分</Text>
          </View>
          <Text style={[styles.help, { color: c.muted }]}>
            出手速度估算，可能范围 {Math.round(f.kmh_low)}–{Math.round(f.kmh_high)} km/h，可信度{CONFIDENCE_LABEL[f.confidence]}。
            在你标为「我赢」的 {meCount} 个分里，{meWithSpeed} 个测到了球速。
          </Text>
          <Button kind="secondary" title="播放这一板" onPress={() => onPlay(f.n)} />
        </>
      ) : (
        sp.status !== 'running' && (
          <Text style={[styles.help, { color: c.muted }]}>
            {meCount === 0
              ? '把你赢的分标为「我赢」后，这里会显示其中最快的一板。'
              : '你标为「我赢」的分里，决胜一板都没测到球速，原因见每个分下方。'}
          </Text>
        )
      )}
      {!!sp.warnings?.length && (
        <Text style={[styles.help, { color: c.t3 }]}>{sp.warnings.join('；')}。可以「重新标定」把远端两个角点准，区间会变窄。</Text>
      )}
    </Card>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  title: { fontSize: 16, fontWeight: '700' },
  big: { flexDirection: 'row', alignItems: 'baseline', gap: 6 },
  num: { fontSize: 40, fontWeight: '800', fontVariant: ['tabular-nums'] },
  unit: { fontSize: 16, fontWeight: '600' },
  help: { fontSize: 13, lineHeight: 19 },
});
