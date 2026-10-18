import { Platform } from 'react-native';

import type { Winner } from './api';

// 与 Figma 设计稿同一套颜色：纯黑底、深灰卡片、蓝色强调色。App 只有深色一种外观
const palette = {
  bg: '#000000',
  surface: '#151517',
  surface2: '#1b1c20',
  well: '#121214',
  raised: '#252528',
  fg: '#f5f5f7',
  fg2: '#aaaab0',
  muted: '#86868b',
  faint: '#6e6e73',
  line: 'rgba(255,255,255,0.07)',
  accent: '#2997ff',
  accentSoft: '#7cc0ff',
  accentBg: 'rgba(41,151,255,0.13)',
  onAccent: '#ffffff',
  warm: '#1b1317',
  warmThumb: '#332129',
  court: '#6b4554',
  danger: '#ff6961',
  dangerBg: 'rgba(255,105,97,0.13)',
  ball: '#ff9f0a',
  ballBg: 'rgba(255,159,10,0.14)',
  // 下面是旧组件（球台标定页）用到的名字，映射到新配色
  primary: '#2997ff',
  onPrimary: '#ffffff',
  chip: '#252528',
  t1: '#30d158',
  t1bg: 'rgba(48,209,88,0.14)',
  t2: '#7cc0ff',
  t2bg: 'rgba(41,151,255,0.13)',
  t3: '#ff9f0a',
  t3bg: 'rgba(255,159,10,0.14)',
};

export type Colors = typeof palette;
export const colors = palette;

export function useColors(): Colors {
  return palette;
}

export const mono = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'SFMono-Regular, Menlo, Consolas, monospace' });

export function winnerColor(c: Colors, w: Winner): { fg: string; bg: string } {
  switch (w) {
    case 'me':
      return { fg: c.accentSoft, bg: c.accentBg };
    case 'coach':
      return { fg: c.fg2, bg: '#2b2c31' };
    default:
      return { fg: c.muted, bg: '#2b2c31' };
  }
}
