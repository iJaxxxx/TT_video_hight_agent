import { DarkTheme, Stack, ThemeProvider } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

import { SettingsProvider } from '../lib/settings';
import { colors as c } from '../lib/theme';

export default function RootLayout() {
  return (
    <SettingsProvider>
      <ThemeProvider
        value={{ ...DarkTheme, colors: { ...DarkTheme.colors, primary: c.accent, background: c.bg, card: '#0a0a0b', text: c.fg, border: c.line } }}
      >
        <StatusBar style="light" />
        <Stack screenOptions={{ headerShown: false, headerBackTitle: '返回', contentStyle: { backgroundColor: c.bg } }}>
          <Stack.Screen name="(tabs)" />
          <Stack.Screen name="import" />
          <Stack.Screen name="job/[id]" />
          <Stack.Screen name="editor/[id]" />
          <Stack.Screen name="export/[id]" />
          <Stack.Screen name="result/[id]" options={{ headerShown: true, title: '成片' }} />
          <Stack.Screen name="calibrate/[id]" options={{ headerShown: true, title: '球台标定', presentation: 'modal' }} />
          <Stack.Screen name="settings" options={{ headerShown: true, title: '服务器', presentation: 'modal' }} />
        </Stack>
      </ThemeProvider>
    </SettingsProvider>
  );
}
