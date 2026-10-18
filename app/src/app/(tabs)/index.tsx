import { router } from 'expo-router';
import { ChevronRight, Plus, Sparkles, UserRound, WifiOff } from 'lucide-react-native';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';

import { ProjectRow, useServerJobs } from '../../components/ProjectRow';
import { Eyebrow, H1, IconButton, Screen } from '../../components/ui';
import { pickVideoAndContinue } from '../../lib/pick';
import { colors as c } from '../../lib/theme';

export default function Home() {
  const { health, jobs, refresh } = useServerJobs();
  const recent = (jobs ?? []).slice(0, 3);

  return (
    <Screen bottomInset={false}>
      <ScrollView
        contentContainerStyle={styles.page}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={false} onRefresh={refresh} tintColor={c.muted} />}
      >
        <View style={styles.header}>
          <View>
            <Eyebrow>PINGPONG HIGHLIGHTS</Eyebrow>
            <H1>{'把每一分，\n变成高光。'}</H1>
          </View>
          <IconButton label="我的" filled onPress={() => router.navigate('/profile')}>
            <UserRound size={20} strokeWidth={1.75} color={c.fg} />
          </IconButton>
        </View>

        {health.state === 'error' && (
          <Pressable style={styles.banner} onPress={() => router.push('/settings')} accessibilityRole="button">
            <WifiOff size={18} strokeWidth={1.75} color={c.danger} />
            <View style={{ flex: 1, gap: 3 }}>
              <Text style={styles.bannerTitle}>没连上剪辑服务器</Text>
              <Text style={styles.bannerText} numberOfLines={2}>
                确认电脑上的服务已启动、手机和电脑在同一个 Wi-Fi。点此修改地址
              </Text>
            </View>
            <ChevronRight size={18} strokeWidth={1.75} color="#5b5b60" />
          </Pressable>
        )}

        <Pressable
          style={({ pressed }) => [styles.importCard, pressed && { transform: [{ scale: 0.97 }] }]}
          onPress={pickVideoAndContinue}
          accessibilityRole="button"
        >
          <View style={styles.ball} />
          <View style={styles.importIcon}>
            <Plus size={25} strokeWidth={2} color="#fff" />
          </View>
          <View style={{ flex: 1, gap: 5 }}>
            <Text style={styles.importTitle}>导入一场比赛</Text>
            <Text style={styles.importSub}>让 AI 找出只属于你的精彩时刻</Text>
          </View>
          <ChevronRight size={22} strokeWidth={1.75} color={c.accent} />
        </Pressable>

        <View style={styles.sectionHead}>
          <Text style={styles.h2}>最近项目</Text>
          <Pressable onPress={() => router.navigate('/projects')} hitSlop={10}>
            <Text style={{ color: c.accent, fontSize: 13 }}>查看全部</Text>
          </Pressable>
        </View>

        <View style={{ gap: 9 }}>
          {recent.map((j, i) => (
            <ProjectRow key={j.id} job={j} index={i} />
          ))}
          {jobs && recent.length === 0 && <Text style={styles.empty}>还没有项目，先导入一场比赛吧。</Text>}
        </View>

        <View style={styles.tip}>
          <Sparkles size={20} strokeWidth={1.75} color={c.accent} />
          <View style={{ flex: 1 }}>
            <Text style={styles.tipTitle}>拍摄小技巧</Text>
            <Text style={styles.tipText}>手机固定在球台一端，完整拍到双方球员，识别会更准确。</Text>
          </View>
        </View>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  page: { paddingHorizontal: 20, paddingBottom: 32 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', paddingTop: 30 },
  banner: { marginTop: 22, padding: 14, borderRadius: 18, backgroundColor: c.dangerBg, flexDirection: 'row', alignItems: 'center', gap: 12 },
  bannerTitle: { color: c.fg, fontSize: 13, fontWeight: '600' },
  bannerText: { color: '#a7a7ac', fontSize: 11, lineHeight: 16 },
  importCard: {
    marginTop: 31,
    minHeight: 172,
    paddingTop: 95,
    paddingHorizontal: 22,
    paddingBottom: 22,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 15,
    backgroundColor: c.warm,
    borderRadius: 28,
  },
  // 设计稿里卡片右上角的那颗“球”
  ball: {
    position: 'absolute',
    top: -34,
    right: 34,
    width: 112,
    height: 112,
    borderRadius: 56,
    backgroundColor: '#d8d4d4',
    borderWidth: 14,
    borderColor: 'rgba(121,94,105,0.18)',
  },
  importIcon: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: c.accent },
  importTitle: { color: c.fg, fontSize: 19, fontWeight: '700', letterSpacing: -0.45 },
  importSub: { color: '#8d8d93', fontSize: 12 },
  sectionHead: { marginTop: 38, marginBottom: 14, marginHorizontal: 2, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  h2: { color: c.fg, fontSize: 20, fontWeight: '700', letterSpacing: -0.4 },
  empty: { color: c.faint, fontSize: 13, textAlign: 'center', paddingVertical: 28 },
  tip: { flexDirection: 'row', gap: 13, marginTop: 16, padding: 17, backgroundColor: c.well, borderRadius: 18 },
  tipTitle: { color: '#e5e5e7', fontSize: 13, fontWeight: '600' },
  tipText: { color: '#a7a7ac', fontSize: 12, lineHeight: 18, marginTop: 4 },
});
