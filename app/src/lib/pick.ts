import * as ImagePicker from 'expo-image-picker';
import { router } from 'expo-router';

import { getPendingVideo, setPendingVideo } from './draft';
import { discardPickedCopy } from './local/jobs';

/** 选视频 → 进入“这一边是你吗”页面。首页和项目页共用 */
export async function pickVideoAndContinue() {
  const res = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['videos'],
    // 直接拿原文件，不让 iOS 先转码（转码又慢又可能降画质）
    preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Current,
    quality: 1,
  });
  if (res.canceled || !res.assets[0]) return;
  const a = res.assets[0];
  // 上一个选了没导入的，它在缓存里的副本没用了
  const prev = getPendingVideo();
  if (prev && prev.uri !== a.uri) discardPickedCopy(prev.uri);
  setPendingVideo({
    uri: a.uri,
    name: a.fileName ?? 'video.mov',
    mimeType: a.mimeType ?? 'video/quicktime',
    webFile: a.file,
    duration: a.duration ? a.duration / 1000 : undefined,
  });
  router.push('/import');
}
