import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { useColors } from '../lib/theme';

export function Button({
  title,
  onPress,
  kind = 'primary',
  disabled,
  loading,
  style,
}: {
  title: string;
  onPress: () => void;
  kind?: 'primary' | 'secondary';
  disabled?: boolean;
  loading?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const c = useColors();
  const primary = kind === 'primary';
  const off = disabled || loading;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={off}
      style={({ pressed }) => [
        styles.btn,
        primary ? { backgroundColor: c.primary } : { backgroundColor: c.surface, borderColor: c.line, borderWidth: 1 },
        { opacity: off ? 0.5 : pressed ? 0.8 : 1 },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={primary ? c.onPrimary : c.primary} />
      ) : (
        <Text style={[styles.btnText, { color: primary ? c.onPrimary : c.fg }]}>{title}</Text>
      )}
    </Pressable>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const c = useColors();
  return <View style={[styles.card, { backgroundColor: c.surface, borderColor: c.line }, style]}>{children}</View>;
}

export function ProgressBar({ value, color }: { value: number; color?: string }) {
  const c = useColors();
  return (
    <View style={[styles.track, { backgroundColor: c.chip }]}>
      <View style={[styles.fill, { width: `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%`, backgroundColor: color ?? c.primary }]} />
    </View>
  );
}

export function Chip({ label, fg, bg }: { label: string; fg: string; bg: string }) {
  return (
    <View style={[styles.chip, { backgroundColor: bg }]}>
      <Text style={[styles.chipText, { color: fg }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  btn: { minHeight: 48, borderRadius: 10, paddingHorizontal: 18, alignItems: 'center', justifyContent: 'center' },
  btnText: { fontSize: 16, fontWeight: '600' },
  card: { borderWidth: 1, borderRadius: 12, padding: 16, gap: 10 },
  track: { height: 8, borderRadius: 4, overflow: 'hidden' },
  fill: { height: 8, borderRadius: 4 },
  chip: { alignSelf: 'flex-start', borderRadius: 99, paddingHorizontal: 10, paddingVertical: 3 },
  chipText: { fontSize: 12, fontWeight: '700' },
});
