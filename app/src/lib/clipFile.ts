import { File, Paths } from 'expo-file-system';
import * as MediaLibrary from 'expo-media-library';
import * as Sharing from 'expo-sharing';
import { Linking, Platform } from 'react-native';

/** 把服务端的成片下载到本地缓存。每次导出的成片不同，用 tag 区分文件名 */
async function download(url: string, name: string, onProgress?: (p: number) => void) {
  return File.downloadFileAsync(url, new File(Paths.cache, name), {
    idempotent: true,
    onProgress: ({ bytesWritten, totalBytes }) => totalBytes > 0 && onProgress?.(bytesWritten / totalBytes),
  });
}

export async function saveClipToLibrary(url: string, name: string, onProgress?: (p: number) => void) {
  if (Platform.OS === 'web') {
    Linking.openURL(url);
    return;
  }
  const perm = await MediaLibrary.requestPermissionsAsync(true);
  if (!perm.granted) throw new Error('没有相册写入权限。请在系统设置里允许「乒乓高光」访问照片。');
  const file = await download(url, name, onProgress);
  await MediaLibrary.Asset.create(file.uri);
}

export async function shareClip(url: string, name: string, onProgress?: (p: number) => void) {
  if (Platform.OS === 'web') {
    Linking.openURL(url);
    return;
  }
  if (!(await Sharing.isAvailableAsync())) throw new Error('这台设备不支持系统分享');
  const file = await download(url, name, onProgress);
  await Sharing.shareAsync(file.uri, { mimeType: 'video/mp4', UTI: 'public.mpeg-4', dialogTitle: '分享高光集锦' });
}
