# local-media：本地解析的原生模块（iOS）

「本地解析（测试）」开关打开后，视频不上传，在手机上完成「找回合 + 导出集锦」：

| 步骤 | 在哪做 | 代码 |
| --- | --- | --- |
| 抽音频：可解码音轨 → 16kHz 单声道 float32 PCM | 原生（AVAssetReader） | `ios/LocalMediaCore.swift`、`ios/Resampler.swift` |
| 击球检测、回合切分 | JS（Hermes） | `src/lib/local/hits.ts` |
| 缩略图 | expo-video-thumbnails | `src/lib/local/jobs.ts` |
| 拼接导出（居中裁切、限制短边） | 原生（AVMutableComposition → AVAssetReader + AVAssetWriter，H.264 硬件编码，码率按像素数×帧率，AAC 128k） | `ios/LocalMediaCore.swift` |

大模型复核、球速估算、球台标定不做，得分方在结果页手动确认。

## 文件放在哪

- 原视频：选中后 expo-image-picker 复制到 `Library/Caches/ImagePicker/`。建项目时用原生 `persistFile` 移到
  `Library/Application Support/LocalMedia/`（同一个卷内改名，不复制；目录排除 iCloud 备份），缓存目录在存储紧张时会被 iOS 清掉。
- 成片：导出到 `Library/Caches/LocalMedia/`，完成后同样移到 `Application Support/LocalMedia/`。缩略图留在缓存里，丢了只是不显示。
- 启动后第一次读记录时（`jobs.ts` 的 `tidyFiles`）：把老项目还在缓存里的原视频 / 成片挪过去，再删掉
  `Caches/ImagePicker`、`Caches/LocalMedia` 里不属于任何项目的文件（导入页上正在用的那个除外）。
- 删除项目时原视频、缩略图、成片一起删。文件已经不在时，结果页 / 成片页给出提示。

## 和服务端对齐的细节

- 音轨：跳过 iPhone 的 APAC 空间音频轨，选第一条能解码的；`startReading` 失败也换下一条。
- 下混：和 `ffmpeg -ac 1` 一样，立体声是 (L+R)/√2。
- 重采样：不用 AVAssetReader 自带的（滤波器和 ffmpeg 不同，阈值附近的击球会翻转，实测回合一致率只有 89%），
  而是复刻 swresample 默认参数（filter_size 32、cutoff 0.97、Kaiser β=9）。48k→16k 与 ffmpeg 逐点 RMS 误差约 3.5e-6，长度一致。
- 检测参数和 numpy 语义（对称 Hanning 窗、严格频带、偶数窗口中位数、线性插值分位数）逐条对齐，见 `hits.ts` 顶部注释。

## 验证

精度对齐（Python 用 `$PYTHON`，需要 numpy）：

```bash
node scripts/align-hits.mts "<视频>" --duration 120
```

用原生模块抽的 PCM 对齐（不用 Xcode，macOS 上编译同一份 Swift）：

```bash
swiftc -O -o /tmp/localmedia modules/local-media/ios/LocalMediaCore.swift modules/local-media/ios/Resampler.swift modules/local-media/macos-harness/main.swift
/tmp/localmedia audio "<视频>" /tmp/swift.pcm
node scripts/align-hits.mts "<视频>" --pcm /tmp/swift.pcm
/tmp/localmedia export "<视频>" /tmp/out.mp4 9:16 1080p 10-22 60-75
```

App 里需要开发版（Expo Go 没有这个原生模块）：`npx expo run:ios`。
