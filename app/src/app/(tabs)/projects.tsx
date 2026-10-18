import { Plus, Search } from 'lucide-react-native';
import { useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { isBusy, jobTitle, ProjectRow, useServerJobs } from '../../components/ProjectRow';
import { Eyebrow, H1, IconButton, Screen } from '../../components/ui';
import { pickVideoAndContinue } from '../../lib/pick';
import { colors as c } from '../../lib/theme';

const FILTERS = ['全部', '已完成', '分析中'] as const;

export default function Projects() {
  const { jobs, health, refresh } = useServerJobs();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('全部');

  const visible = (jobs ?? []).filter((j) => {
    if (query && !jobTitle(j.filename).toLowerCase().includes(query.trim().toLowerCase())) return false;
    if (filter === '已完成') return j.status === 'review';
    if (filter === '分析中') return isBusy(j);
    return true;
  });

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={styles.page}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={false} onRefresh={refresh} tintColor={c.muted} />}
      >
        <View style={styles.header}>
          <View>
            <Eyebrow>你的比赛</Eyebrow>
            <H1 size={37}>所有项目</H1>
          </View>
          <IconButton label="导入新比赛" onPress={pickVideoAndContinue}>
            <Plus size={22} strokeWidth={1.75} color={c.fg} />
          </IconButton>
        </View>

        <View style={styles.search}>
          <Search size={18} strokeWidth={1.75} color="#77777d" />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="搜索比赛或训练"
            placeholderTextColor="#65656a"
            style={styles.input}
            autoCorrect={false}
            autoCapitalize="none"
            clearButtonMode="while-editing"
          />
        </View>

        <View style={styles.filters}>
          {FILTERS.map((f) => {
            const on = f === filter;
            return (
              <Pressable
                key={f}
                accessibilityRole="tab"
                accessibilityState={{ selected: on }}
                onPress={() => setFilter(f)}
                style={[styles.filter, on && { backgroundColor: c.fg }]}
              >
                <Text style={{ fontSize: 12, color: on ? '#09090b' : '#85858a', fontWeight: on ? '600' : '400' }}>{f}</Text>
              </Pressable>
            );
          })}
        </View>

        <View style={{ gap: 9 }}>
          {visible.map((j, i) => (
            <ProjectRow key={j.id} job={j} index={i} />
          ))}
          {jobs && visible.length === 0 && (
            <Text style={styles.empty}>{jobs.length === 0 ? '还没有项目' : '没有找到相关项目'}</Text>
          )}
          {!jobs && health.state === 'error' && <Text style={styles.empty}>没连上服务器，暂时看不到项目</Text>}
        </View>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  page: { paddingHorizontal: 20, paddingBottom: 32 },
  header: { minHeight: 108, paddingTop: 27, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  search: { height: 46, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: '#171719', borderRadius: 15 },
  input: { flex: 1, color: c.fg, fontSize: 14, height: 46 },
  filters: { marginTop: 18, marginBottom: 14, flexDirection: 'row', gap: 8 },
  filter: { minHeight: 36, paddingHorizontal: 15, borderRadius: 18, backgroundColor: '#171719', justifyContent: 'center' },
  empty: { paddingVertical: 70, color: c.faint, textAlign: 'center', fontSize: 13 },
});
