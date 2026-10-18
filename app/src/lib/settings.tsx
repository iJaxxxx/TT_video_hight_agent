import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

import type { MeSide } from './api';

const KEY = 'tt-highlight-settings';
const SERVER_PORT = 8000;

export type Settings = {
  serverUrl: string;
  meSide: MeSide;
  /** 上一次确认过的球台角点（0–1 相对坐标）。机位不变时新视频可以直接沿用 */
  lastCorners: [number, number][] | null;
  /** 实验开关：本地解析（不上传，见 lib/local/jobs.ts） */
  localMode: boolean;
};

/**
 * 默认服务器地址：开发时 Expo 会告诉我们电脑的局域网 IP（hostUri 形如 192.168.1.5:8081），
 * 服务端跑在同一台电脑上，所以换成 8000 端口即可。拿不到时回退到 localhost（模拟器可用）。
 */
function defaultServerUrl() {
  const host = Constants.expoConfig?.hostUri?.split(':')[0];
  return `http://${host || 'localhost'}:${SERVER_PORT}`;
}

const defaults: Settings = { serverUrl: defaultServerUrl(), meSide: 'far', lastCorners: null, localMode: false };

type Ctx = Settings & { ready: boolean; update: (patch: Partial<Settings>) => void };
const SettingsContext = createContext<Ctx>({ ...defaults, ready: false, update: () => {} });

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings>(defaults);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    AsyncStorage.getItem(KEY)
      .then((raw) => raw && setSettings({ ...defaults, ...JSON.parse(raw) }))
      .catch(() => {})
      .finally(() => setReady(true));
  }, []);

  const update = (patch: Partial<Settings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch, serverUrl: (patch.serverUrl ?? prev.serverUrl).trim().replace(/\/+$/, '') };
      AsyncStorage.setItem(KEY, JSON.stringify(next)).catch(() => {});
      return next;
    });
  };

  return <SettingsContext.Provider value={{ ...settings, ready, update }}>{children}</SettingsContext.Provider>;
}

export const useSettings = () => useContext(SettingsContext);
