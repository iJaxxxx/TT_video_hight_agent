import { NativeModule, requireOptionalNativeModule } from 'expo-modules-core';

export type ClipRange = { start: number; end: number };
export type ProgressEvent = { task: 'audio' | 'export'; progress: number };

declare class LocalMediaModule extends NativeModule<{ onProgress: (e: ProgressEvent) => void }> {
  /** 16kHz 单声道 float32 小端 PCM，写在缓存目录里 */
  extractAudio(uri: string): Promise<{ uri: string; samples: number; sampleRate: number; seconds: number }>;
  /** 按顺序拼接片段导出 mp4（H.264 + AAC） */
  exportClips(
    uri: string,
    clips: ClipRange[],
    ratio: '9:16' | '16:9' | '1:1' | null,
    quality: '720p' | '1080p' | null,
  ): Promise<{ uri: string; duration: number; seconds: number }>;
  /** 移到 Library/Application Support/LocalMedia/（不会被系统清理、不进 iCloud 备份），返回新路径 */
  persistFile(uri: string): Promise<string>;
  /** 以视频（而不是文件）弹出系统分享，微信里会显示为视频 */
  shareVideo(uri: string): Promise<void>;
}

/** Expo Go、网页和 Android 上没有这个原生模块（需要 iOS dev build），此时为 null */
export default requireOptionalNativeModule<LocalMediaModule>('LocalMedia');
