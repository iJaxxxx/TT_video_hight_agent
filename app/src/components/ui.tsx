import { router } from 'expo-router';
import { ArrowLeft, Play } from 'lucide-react-native';
import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors as c, mono } from '../lib/theme';

export function Button({
  title,
  onPress,
  kind = 'primary',
  disabled,
  loading,
  icon,
  iconLeft,
  style,
}: {
  title: string;
  onPress: () => void;
  kind?: 'primary' | 'secondary' | 'quiet';
  disabled?: boolean;
  loading?: boolean;
  icon?: ReactNode;
  iconLeft?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const off = disabled || loading;
  const fg = kind === 'primary' ? c.onAccent : kind === 'quiet' ? c.accent : c.fg;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!off }}
      onPress={onPress}
      disabled={off}
      style={({ pressed }) => [
        styles.btn,
        kind === 'primary' && { backgroundColor: c.accent },
        kind === 'secondary' && { backgroundColor: '#2a2a2e' },
        kind === 'quiet' && { minHeight: 48 },
        { opacity: disabled ? 0.4 : 1, transform: [{ scale: pressed ? 0.97 : 1 }] },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={fg} />
      ) : (
        <>
          {iconLeft && icon}
          <Text style={[styles.btnText, { color: fg }, kind === 'quiet' && { fontSize: 14, fontWeight: '500' }]}>{title}</Text>
          {!iconLeft && icon}
        </>
      )}
    </Pressable>
  );
}

export function IconButton({
  label,
  onPress,
  children,
  filled,
  style,
}: {
  label: string;
  onPress?: () => void;
  children: ReactNode;
  filled?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={4}
      style={({ pressed }) => [
        styles.iconBtn,
        filled && { backgroundColor: 'rgba(255,255,255,0.08)' },
        pressed && { backgroundColor: '#1c1d21', transform: [{ scale: 0.97 }] },
        style,
      ]}
    >
      {children}
    </Pressable>
  );
}

/** 流程页顶栏：左返回、中间标题、右侧可选操作 */
export function TopBar({ title, right, onBack, muted }: { title?: string; right?: ReactNode; onBack?: () => void; muted?: boolean }) {
  const back = onBack ?? (() => (router.canGoBack() ? router.back() : router.replace('/')));
  return (
    <View style={styles.topbar}>
      <IconButton label="返回" onPress={back}>
        <ArrowLeft size={22} strokeWidth={1.75} color={c.fg} />
      </IconButton>
      <Text style={muted ? styles.topbarMuted : styles.topbarTitle} numberOfLines={1}>
        {title}
      </Text>
      {right ?? <View style={{ width: 44 }} />}
    </View>
  );
}

/**
 * 页面容器：黑底 + 上下安全区。
 * 底部默认让开 Home 横条，否则页面最后一个按钮会落进系统手势区，很难点；
 * 自己有底栏的页面（标签页、回合列表）传 bottomInset={false}，由底栏处理。
 */
export function Screen({
  children,
  style,
  bottomInset = true,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  bottomInset?: boolean;
}) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[{ flex: 1, backgroundColor: c.bg, paddingTop: insets.top, paddingBottom: bottomInset ? insets.bottom : 0 }, style]}>
      {children}
    </View>
  );
}

export function Eyebrow({ children, style }: { children: ReactNode; style?: StyleProp<TextStyle> }) {
  return <Text style={[styles.eyebrow, style]}>{children}</Text>;
}

export function H1({ children, size = 40, style }: { children: ReactNode; size?: number; style?: StyleProp<TextStyle> }) {
  return (
    <Text style={[styles.h1, { fontSize: size, lineHeight: Math.round(size * 1.12), letterSpacing: -size * 0.04 }, style]}>
      {children}
    </Text>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function ProgressBar({ value, color, height = 5 }: { value: number; color?: string; height?: number }) {
  return (
    <View style={[styles.track, { height, borderRadius: height }]}>
      <View
        style={{
          height,
          borderRadius: height,
          width: `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%`,
          backgroundColor: color ?? c.accent,
        }}
      />
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

const THUMB_TONES = { warm: '#332129', mid: '#282329', cool: '#292a2e' } as const;
export type ThumbTone = keyof typeof THUMB_TONES;

/** 设计稿里的小球台缩略图（项目列表用，没有真实画面时的占位） */
export function ProjectThumb({ tone = 'warm', dot = true }: { tone?: ThumbTone; dot?: boolean }) {
  return (
    <View style={[styles.thumb, { backgroundColor: THUMB_TONES[tone] }]}>
      <View style={styles.miniTable}>
        <View style={styles.miniNet} />
      </View>
      {dot && <View style={styles.thumbDot} />}
      <View style={styles.playDot}>
        <Play size={12} color="#fff" fill="#fff" strokeWidth={1.75} />
      </View>
    </View>
  );
}

/** 底部弹出的操作面板 */
export function Sheet({ visible, onClose, children }: { visible: boolean; onClose: () => void; children: ReactNode }) {
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.sheetBackdrop} onPress={onClose} accessibilityLabel="关闭" />
      <View style={[styles.sheet, { paddingBottom: 20 + insets.bottom }]}>
        <View style={styles.sheetGrip} />
        {children}
      </View>
    </Modal>
  );
}

export function MonoText({ children, size = 14, style }: { children: ReactNode; size?: number; style?: StyleProp<TextStyle> }) {
  return <Text style={[{ fontFamily: mono, fontSize: size, fontWeight: '700', color: c.fg, fontVariant: ['tabular-nums'] }, style]}>{children}</Text>;
}

const styles = StyleSheet.create({
  btn: {
    minHeight: 52,
    borderRadius: 26,
    paddingHorizontal: 20,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  btnText: { fontSize: 15, fontWeight: '600' },
  iconBtn: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  topbar: { height: 62, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  topbarTitle: { flex: 1, textAlign: 'center', color: c.fg, fontSize: 15, fontWeight: '700' },
  topbarMuted: { flex: 1, textAlign: 'center', color: '#74747a', fontSize: 12, fontWeight: '600' },
  eyebrow: { color: c.muted, fontSize: 11, fontWeight: '700', letterSpacing: 1.15, marginBottom: 7 },
  h1: { color: c.fg, fontWeight: '600' },
  card: { backgroundColor: c.surface, borderRadius: 20, padding: 16, gap: 10 },
  track: { overflow: 'hidden', backgroundColor: '#2a2a2e' },
  chip: { alignSelf: 'flex-start', borderRadius: 6, paddingHorizontal: 6, paddingVertical: 3 },
  chipText: { fontSize: 10, fontWeight: '600' },
  thumb: { width: 64, height: 56, borderRadius: 12, overflow: 'hidden' },
  miniTable: {
    position: 'absolute',
    left: 13,
    right: 13,
    top: 14,
    height: 25,
    borderWidth: 2,
    borderColor: 'rgba(120,180,245,0.55)',
    transform: [{ perspective: 50 }, { rotateX: '20deg' }],
  },
  miniNet: { position: 'absolute', left: '50%', top: 0, bottom: 0, width: 1, backgroundColor: 'rgba(255,255,255,0.6)' },
  thumbDot: { position: 'absolute', top: 9, right: 10, width: 7, height: 7, borderRadius: 4, backgroundColor: c.accent },
  playDot: {
    position: 'absolute',
    top: 15,
    left: 19,
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.6)',
  },
  sheetBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)' },
  sheet: { backgroundColor: '#1c1c1f', borderTopLeftRadius: 26, borderTopRightRadius: 26, paddingHorizontal: 20, paddingTop: 10, gap: 12 },
  sheetGrip: { alignSelf: 'center', width: 36, height: 5, borderRadius: 3, backgroundColor: '#3a3a3e', marginBottom: 6 },
});
