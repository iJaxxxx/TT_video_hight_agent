import { memo } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';

import { CONFIDENCE_LABEL, fmtTime, WINNER_LABEL, type Candidate, type Winner } from '../lib/api';
import { useColors, winnerColor } from '../lib/theme';
import { Card, Chip } from './ui';

const CHOICES: Winner[] = ['me', 'coach', 'practice', 'unclear'];

function llmLine(c: Candidate): { text: string; tone: 'muted' | 'llm' } {
  const r = c.llm;
  switch (r.status) {
    case 'skipped_no_key':
      return { text: '大模型：未配置 Key，请看缩略图或预览后手动选择', tone: 'muted' };
    case 'pending':
      return { text: '大模型：复核中…', tone: 'muted' };
    case 'error':
      return { text: `大模型调用失败，请手动选择（${r.error.slice(0, 60)}）`, tone: 'muted' };
    case 'agreed':
      return { text: `大模型判断：${WINNER_LABEL[r.winner]}（${r.confidence ?? '-'}）${r.evidence ? ` · ${r.evidence}` : ''}`, tone: 'llm' };
    case 'disagreed':
      return { text: `大模型两次判断不一致（${r.votes.map((v) => WINNER_LABEL[v]).join(' / ')}），请手动确认`, tone: 'llm' };
  }
}

/** 球速一行：有数显示估算值和区间；没有数说明原因；还在算显示进行中 */
function SpeedLine({ cand, speedsRunning, fastest }: { cand: Candidate; speedsRunning: boolean; fastest: boolean }) {
  const c = useColors();
  const sp = cand.speed;
  if (!sp) {
    return speedsRunning ? <Text style={[styles.hint, { color: c.muted }]}>球速：估算中…</Text> : null;
  }
  if (sp.status === 'none') {
    return <Text style={[styles.hint, { color: c.muted }]}>球速没测到：{sp.reason}</Text>;
  }
  return (
    <View style={styles.speedRow}>
      <Text style={[styles.speedNum, { color: fastest ? c.ball : c.fg }]}>≈{Math.round(sp.kmh)} km/h</Text>
      <Text style={[styles.hint, { color: c.muted, flex: 1 }]}>
        决胜一板出手速度 · {Math.round(sp.kmh_low)}–{Math.round(sp.kmh_high)} · 可信度{CONFIDENCE_LABEL[sp.confidence]}
      </Text>
      {fastest && <Chip label="最快一板" fg={c.ball} bg={c.t3bg} />}
    </View>
  );
}

export const CandidateCard = memo(function CandidateCard({
  cand,
  sheetUrl,
  onPick,
  onPreview,
  speedsRunning = false,
  fastest = false,
}: {
  cand: Candidate;
  sheetUrl: string;
  onPick: (n: number, w: Winner) => void;
  onPreview: (n: number) => void;
  speedsRunning?: boolean;
  fastest?: boolean;
}) {
  const c = useColors();
  const tag = winnerColor(c, cand.winner);
  const line = llmLine(cand);
  const status = cand.confirmed ? WINNER_LABEL[cand.winner] : cand.winner !== 'unknown' ? `${WINNER_LABEL[cand.winner]}（待确认）` : '待确认';

  return (
    <Card>
      <View style={styles.head}>
        <Text style={[styles.title, { color: c.fg }]}>第 {cand.n + 1} 分</Text>
        <Text style={[styles.meta, { color: c.muted }]}>
          {fmtTime(cand.start)} – {fmtTime(cand.end)} · {cand.hits} 拍
        </Text>
        <View style={{ flex: 1 }} />
        <Chip label={status} fg={tag.fg} bg={tag.bg} />
      </View>

      <Pressable onPress={() => onPreview(cand.n)} accessibilityRole="button" accessibilityLabel={`播放第 ${cand.n + 1} 分`}>
        <Image source={{ uri: sheetUrl }} style={[styles.sheet, { backgroundColor: c.chip }]} resizeMode="cover" />
        <View style={styles.playBadge}>
          <Text style={styles.playText}>▶ 播放这一分</Text>
        </View>
      </Pressable>
      <SpeedLine cand={cand} speedsRunning={speedsRunning} fastest={fastest} />
      <Text style={[styles.hint, { color: line.tone === 'llm' ? c.t3 : c.muted }]}>{line.text}</Text>

      <View style={styles.choices}>
        {CHOICES.map((w) => {
          const on = cand.confirmed && cand.winner === w;
          const col = winnerColor(c, w);
          return (
            <Pressable
              key={w}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
              onPress={() => onPick(cand.n, on ? 'unknown' : w)}
              style={({ pressed }) => [
                styles.choice,
                { borderColor: on ? col.fg : c.line, backgroundColor: on ? col.bg : c.surface, opacity: pressed ? 0.7 : 1 },
              ]}
            >
              <Text style={{ color: on ? col.fg : c.fg, fontWeight: on ? '700' : '500', fontSize: 14 }}>{WINNER_LABEL[w]}</Text>
            </Pressable>
          );
        })}
      </View>
    </Card>
  );
});

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  title: { fontSize: 16, fontWeight: '700' },
  meta: { fontSize: 13, fontVariant: ['tabular-nums'] },
  // 服务端缩略图是 3x3 张 16:9 小图拼成，整体也是 16:9
  sheet: { width: '100%', aspectRatio: 16 / 9, borderRadius: 8 },
  playBadge: { position: 'absolute', right: 8, bottom: 8, backgroundColor: 'rgba(0,0,0,0.6)', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4 },
  playText: { color: '#fff', fontSize: 12, fontWeight: '600' },
  hint: { fontSize: 12.5, lineHeight: 18 },
  speedRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  speedNum: { fontSize: 17, fontWeight: '700', fontVariant: ['tabular-nums'] },
  choices: { flexDirection: 'row', gap: 8 },
  choice: { flex: 1, minHeight: 40, borderWidth: 1.5, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
});
