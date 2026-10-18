import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useColorScheme } from 'react-native';

import { SettingsProvider } from '../lib/settings';
import { useColors } from '../lib/theme';

export default function RootLayout() {
  const scheme = useColorScheme();
  const c = useColors();
  const base = scheme === 'dark' ? DarkTheme : DefaultTheme;
  return (
    <SettingsProvider>
      <ThemeProvider value={{ ...base, colors: { ...base.colors, primary: c.primary, background: c.bg, card: c.surface, text: c.fg, border: c.line } }}>
        <StatusBar style="auto" />
        <Stack screenOptions={{ headerBackTitle: '返回', contentStyle: { backgroundColor: c.bg } }}>
          <Stack.Screen name="index" options={{ title: '乒乓高光' }} />
          <Stack.Screen name="job/[id]" options={{ title: '确认得分球' }} />
          <Stack.Screen name="result/[id]" options={{ title: '成片' }} />
          <Stack.Screen name="calibrate/[id]" options={{ title: '球台标定', presentation: 'modal' }} />
          <Stack.Screen name="settings" options={{ title: '设置', presentation: 'modal' }} />
        </Stack>
      </ThemeProvider>
    </SettingsProvider>
  );
}
