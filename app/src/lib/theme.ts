import { useColorScheme } from 'react-native';

import type { Winner } from './api';

// 与技术方案页同一套颜色：球台蓝为主色，规则 / 小模型 / 大模型三层各一色
const light = {
  bg: '#f6f8fb',
  surface: '#ffffff',
  fg: '#16202e',
  muted: '#5a6779',
  line: '#d9e0ea',
  primary: '#1d4f8c',
  onPrimary: '#ffffff',
  ball: '#d9661f',
  danger: '#c0392b',
  t1: '#2f7a57',
  t1bg: '#e6f2ec',
  t2: '#2a5fae',
  t2bg: '#e7eef9',
  t3: '#b8561a',
  t3bg: '#fbeee4',
  chip: '#eef2f7',
};

const dark: typeof light = {
  bg: '#0f141c',
  surface: '#161d28',
  fg: '#e3e8ef',
  muted: '#98a4b5',
  line: '#2a3442',
  primary: '#7fa9e6',
  onPrimary: '#0f141c',
  ball: '#f09a5c',
  danger: '#ef7d70',
  t1: '#6cc79b',
  t1bg: '#17291f',
  t2: '#86aef0',
  t2bg: '#18233a',
  t3: '#f0a06a',
  t3bg: '#2e1f14',
  chip: '#1d2633',
};

export type Colors = typeof light;

export function useColors(): Colors {
  return useColorScheme() === 'dark' ? dark : light;
}

export function winnerColor(c: Colors, w: Winner): { fg: string; bg: string } {
  switch (w) {
    case 'me':
      return { fg: c.t1, bg: c.t1bg };
    case 'coach':
      return { fg: c.ball, bg: c.t3bg };
    case 'practice':
    case 'unclear':
      return { fg: c.muted, bg: c.chip };
    default:
      return { fg: c.primary, bg: c.t2bg };
  }
}
