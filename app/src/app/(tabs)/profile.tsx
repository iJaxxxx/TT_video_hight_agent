import { router } from 'expo-router';
import { Brain, ChevronRight, HelpCircle, Server, Smartphone, UserRound } from 'lucide-react-native';
import { useState, type ComponentType } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';

import { isBusy, useServerJobs } from '../../components/ProjectRow';
import { Eyebrow, H1, MonoText, Screen, Sheet } from '../../components/ui';
import type { MeSide } from '../../lib/api';
import { localAvailable } from '../../lib/local/jobs';
import { useSettings } from '../../lib/settings';
import { colors as c } from '../../lib/theme';

type IconT = ComponentType<{ size?: number; strokeWidth?: number; color?: string }>;

function Row({
  Icon,
  title,
  detail,
  onPress,
  right,
}: {
  Icon: IconT;
  title: string;
  detail: string;
  onPress?: () => void;
  right?: React.ReactNode;
}) {
  return (
    <Pressable onPress={onPress} disabled={!onPress} style={({ pressed }) => [styles.row, pressed && { backgroundColor: '#1a1a1d' }]}>
      <View style={styles.rowIcon}>
        <Icon size={19} strokeWidth={1.75} color={c.fg2} />
      </View>
      <View style={{ flex: 1, gap: 4 }}>
        <Text style={styles.rowTitle}>{title}</Text>
        <Text style={styles.rowDetail} numberOfLines={1}>
          {detail}
        </Text>
      </View>
      {right ?? (onPress ? <ChevronRight size={18} strokeWidth={1.75} color="#5e5e63" /> : null)}
    </Pressable>
  );
}

function SideToggle({ value, onChange }: { value: MeSide; onChange: (v: MeSide) => void }) {
  return (
    <View style={styles.toggle}>
      {(
        [
          ['far', '远端'],
          ['near', '近端'],
        ] as [MeSide, string][]
      ).map(([v, label]) => (
        <Pressable
          key={v}
          accessibilityRole="radio"
          accessibilityState={{ selected: value === v }}
          onPress={() => onChange(v)}
          style={[styles.toggleItem, value === v && { backgroundColor: c.accent }]}
        >
          <Text style={{ fontSize: 11, color: value === v ? '#fff' : '#85858a', fontWeight: '600' }}>{label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

export default function Profile() {
  const { serverUrl, meSide, localMode, update } = useSettings();
  const canLocal = localAvailable();
  const { health, jobs } = useServerJobs();
  const [help, setHelp] = useState(false);
  const list = jobs ?? [];
  const done = list.filter((j) => j.status === 'review');
  const rounds = done.reduce((s, j) => s + j.count, 0);

  const statusText =
    health.state === 'ok' ? '已连接' : health.state === 'error' ? '未连接' : '连接中…';
  const statusColor = health.state === 'ok' ? c.t1 : health.state === 'error' ? c.danger : c.muted;

  return (
    <Screen bottomInset={false}>
      <ScrollView contentContainerStyle={styles.page} showsVerticalScrollIndicator={false}>
        <View style={styles.header}>
          <View>
            <Eyebrow>PINGPONG ID</Eyebrow>
            <H1 size={37}>我的</H1>
          </View>
        </View>

        <Pressable style={styles.account} onPress={() => router.push('/settings')} accessibilityRole="button">
          <View style={styles.avatar}>
            <UserRound size={26} strokeWidth={1.75} color="#1b1518" />
          </View>
          <View style={{ flex: 1, gap: 5 }}>
            <Text style={styles.accountTitle}>剪辑服务器</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <View style={[styles.dot, { backgroundColor: statusColor }]} />
              <Text style={styles.accountSub} numberOfLines={1}>
                {statusText} · {serverUrl.replace(/^https?:\/\//, '')}
              </Text>
            </View>
          </View>
          <ChevronRight size={19} strokeWidth={1.75} color="#626267" />
        </Pressable>

        <View style={styles.stats}>
          {(
            [
              [list.length, '比赛'],
              [rounds, '回合'],
              [list.filter(isBusy).length, '分析中'],
            ] as [number, string][]
          ).map(([n, label], i) => (
            <View key={label} style={[styles.stat, i > 0 && styles.statDivider]}>
              <MonoText size={18}>{jobs ? n : '–'}</MonoText>
              <Text style={styles.statLabel}>{label}</Text>
            </View>
          ))}
        </View>

        <View style={styles.group}>
          <Row
            Icon={UserRound}
            title="我在画面里的默认位置"
            detail={meSide === 'far' ? '远端 · 网的另一侧' : '近端 · 靠近镜头'}
            right={<SideToggle value={meSide} onChange={(v) => update({ meSide: v })} />}
          />
          <View style={styles.sep} />
          <Row
            Icon={Brain}
            title="大模型复核"
            detail={
              health.state === 'ok'
                ? health.llm
                  ? '已开启，自动判断每分是谁赢'
                  : '未配置 API Key，需要手动确认得分'
                : '连上服务器后可见'
            }
          />
          <View style={styles.sep} />
          <Row Icon={Server} title="服务器地址" detail={serverUrl} onPress={() => router.push('/settings')} />
          <View style={styles.sep} />
          <Row
            Icon={Smartphone}
            title="本地解析（测试）"
            detail={
              !canLocal
                ? '需要 iOS 开发版（npx expo run:ios），Expo Go 里不可用'
                : localMode
                  ? '已开启：视频不上传，在手机上找回合、导出'
                  : '关闭：视频上传到服务器分析'
            }
            right={
              <Switch
                value={localMode && canLocal}
                disabled={!canLocal}
                onValueChange={(v) => update({ localMode: v })}
                accessibilityLabel="本地解析（测试）"
              />
            }
          />
          <View style={styles.sep} />
          <Row Icon={HelpCircle} title="帮助" detail="拍摄与剪辑指南" onPress={() => setHelp(true)} />
        </View>

        <Text style={styles.version}>PingPong Highlights 1.0</Text>
      </ScrollView>

      <Sheet visible={help} onClose={() => setHelp(false)}>
        <Text style={styles.sheetTitle}>拍摄与剪辑指南</Text>
        {[
          '手机横放或竖放都行，固定在球台一端，完整拍到双方球员和整张球台。',
          '开始分析前选好你在画面里的位置（远端 / 近端），AI 只为你保留得分高光。',
          '没配置大模型时，在结果页点每个回合右上角的标签，手动选“我赢 / 对手赢”。',
          '想测出手球速：结果页右上角 ··· → 球台标定，点一次球台四个角即可。',
        ].map((t) => (
          <Text key={t} style={styles.sheetText}>
            · {t}
          </Text>
        ))}
      </Sheet>
    </Screen>
  );
}

const styles = StyleSheet.create({
  page: { paddingHorizontal: 20, paddingBottom: 32 },
  header: { minHeight: 108, paddingTop: 27 },
  account: { minHeight: 94, padding: 16, flexDirection: 'row', alignItems: 'center', gap: 14, backgroundColor: '#1b1518', borderRadius: 24 },
  avatar: { width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center', backgroundColor: '#d9cbd1' },
  accountTitle: { color: c.fg, fontSize: 17, fontWeight: '600' },
  accountSub: { color: '#8d8d93', fontSize: 11, flexShrink: 1 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  stats: { marginTop: 12, marginBottom: 27, paddingVertical: 17, paddingHorizontal: 10, flexDirection: 'row', borderRadius: 20, backgroundColor: c.well },
  stat: { flex: 1, alignItems: 'center', gap: 5 },
  statDivider: { borderLeftWidth: 1, borderLeftColor: c.line },
  statLabel: { color: '#737378', fontSize: 10 },
  group: { overflow: 'hidden', borderRadius: 22, backgroundColor: c.surface },
  row: { minHeight: 66, paddingHorizontal: 16, paddingVertical: 10, flexDirection: 'row', alignItems: 'center', gap: 13 },
  rowIcon: { width: 30, height: 30, borderRadius: 9, alignItems: 'center', justifyContent: 'center', backgroundColor: c.raised },
  rowTitle: { color: c.fg, fontSize: 13, fontWeight: '600' },
  rowDetail: { color: '#727277', fontSize: 10 },
  sep: { height: 1, marginLeft: 59, backgroundColor: c.line },
  toggle: { flexDirection: 'row', padding: 2, borderRadius: 14, backgroundColor: '#3a3a3e' },
  toggleItem: { paddingHorizontal: 10, height: 24, borderRadius: 12, justifyContent: 'center' },
  version: { marginTop: 22, color: '#4f4f54', textAlign: 'center', fontSize: 10 },
  sheetTitle: { color: c.fg, fontSize: 17, fontWeight: '700', marginBottom: 4 },
  sheetText: { color: c.fg2, fontSize: 13, lineHeight: 20 },
});
