import { Tabs, type BottomTabBarProps } from 'expo-router/js-tabs';
import { Folder, Home, UserRound } from 'lucide-react-native';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors as c } from '../../lib/theme';

const TABS = {
  index: { label: '首页', Icon: Home },
  projects: { label: '项目', Icon: Folder },
  profile: { label: '我的', Icon: UserRound },
} as const;

function TabBar({ state, navigateToTab }: BottomTabBarProps) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.bar, { paddingBottom: Math.max(insets.bottom, 12) }]} accessibilityRole="tablist">
      {state.routes.map((route, i) => {
        const tab = TABS[route.name as keyof typeof TABS];
        if (!tab) return null;
        const on = state.index === i;
        const color = on ? c.accent : '#73737a';
        return (
          <Pressable
            key={route.key}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            style={styles.item}
            onPress={() => !on && navigateToTab(route.key)}
          >
            <tab.Icon size={21} strokeWidth={1.75} color={color} />
            <Text style={[styles.label, { color }]}>{tab.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export default function TabsLayout() {
  return (
    <Tabs tabBar={(p) => <TabBar {...p} />} screenOptions={{ headerShown: false, sceneStyle: { backgroundColor: c.bg } }}>
      <Tabs.Screen name="index" />
      <Tabs.Screen name="projects" />
      <Tabs.Screen name="profile" />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 52,
    paddingTop: 9,
    backgroundColor: 'rgba(10,10,11,0.96)',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(255,255,255,0.06)',
  },
  item: { width: 58, alignItems: 'center', gap: 4 },
  label: { fontSize: 10 },
});
