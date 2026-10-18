import ExpoModulesCore
import UniformTypeIdentifiers

struct ClipRecord: Record {
  @Field var start: Double = 0
  @Field var end: Double = 0
}

/// 本地解析的原生部分：抽音频（给 TS 版击球检测用）、拼接导出成片。逻辑都在 LocalMediaCore 里。
public class LocalMediaModule: Module {
  public func definition() -> ModuleDefinition {
    Name("LocalMedia")

    /// 分享成片：在微信里显示为视频而不是文件（见 shareVideo）
    AsyncFunction("shareVideo") { (uri: URL, promise: Promise) in
      self.shareVideo(uri, promise: promise)
    }
    .runOnQueue(.main)

    Events("onProgress")

    /// 抽出 16kHz 单声道 float32 PCM，写到缓存目录。PCM 走文件不走桥：10 分钟就有 38MB
    AsyncFunction("extractAudio") { (uri: URL, promise: Promise) in
      let out = self.cacheFile(ext: "pcm")
      let t0 = Date()
      do {
        let n = try LocalMediaCore.extractAudio(from: uri, to: out) { p in
          self.sendEvent("onProgress", ["task": "audio", "progress": p])
        }
        promise.resolve([
          "uri": out.absoluteString,
          "samples": n,
          "sampleRate": 16000,
          "seconds": Date().timeIntervalSince(t0),
        ])
      } catch {
        promise.reject(Exception(name: "ExtractAudioFailed", description: "\(error)"))
      }
    }

    /// 按顺序拼接片段，居中裁切成 ratio（9:16 / 16:9 / 1:1，null 不裁），短边最多 quality（720p / 1080p，null 原画）
    AsyncFunction("exportClips") { (uri: URL, clips: [ClipRecord], ratio: String?, quality: String?, promise: Promise) in
      let out = self.cacheFile(ext: "mp4")
      let t0 = Date()
      LocalMediaCore.exportClips(
        from: uri, clips: clips.map { ClipRange(start: $0.start, end: $0.end) },
        ratio: ratio, quality: quality, to: out,
        progress: { p in self.sendEvent("onProgress", ["task": "export", "progress": p]) }
      ) { result in
        switch result {
        case .success(let duration):
          promise.resolve([
            "uri": out.absoluteString,
            "duration": duration,
            "seconds": Date().timeIntervalSince(t0),
          ])
        case .failure(let error):
          promise.reject(Exception(name: "ExportFailed", description: "\(error)"))
        }
      }
    }

    /// 把文件移到 Library/Application Support/LocalMedia/：缓存目录在存储紧张时会被 iOS 清掉。
    /// 同一个卷内 moveItem 只是改名，不复制；目录排除 iCloud 备份（视频动辄几 GB）。已经在里面的原样返回
    AsyncFunction("persistFile") { (uri: URL) -> String in
      let dir = try FileManager.default
        .url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        .appendingPathComponent("LocalMedia", isDirectory: true)
      try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
      var dirURL = dir
      var values = URLResourceValues()
      values.isExcludedFromBackup = true
      try dirURL.setResourceValues(values)
      if uri.standardizedFileURL.deletingLastPathComponent().resolvingSymlinksInPath().path
        == dir.resolvingSymlinksInPath().path {
        return uri.absoluteString
      }
      // 保留扩展名，AVFoundation 靠它判断格式
      let ext = uri.pathExtension.isEmpty ? "mov" : uri.pathExtension
      let out = dir.appendingPathComponent("\(UUID().uuidString).\(ext)")
      try FileManager.default.moveItem(at: uri, to: out)
      return out.absoluteString
    }
  }

  /// 以「视频」而不是「文件」分享：只登记 MPEG-4 视频类型的 NSItemProvider，不带文件链接。
  /// 直接把文件 URL 交给分享面板（expo-sharing 的做法）时，微信等 App 会把它当文件发送。
  private func shareVideo(_ url: URL, promise: Promise) {
    guard let vc = appContext?.utilities?.currentViewController() else {
      return promise.reject(Exception(name: "ShareFailed", description: "找不到当前页面，无法弹出分享"))
    }
    let controller: UIActivityViewController
    if #available(iOS 17.0, *) {
      let provider = NSItemProvider()
      provider.suggestedName = url.deletingPathExtension().lastPathComponent
      provider.registerFileRepresentation(forTypeIdentifier: UTType.mpeg4Movie.identifier, fileOptions: [], visibility: .all) { done in
        done(url, false, nil)
        return nil
      }
      controller = UIActivityViewController(activityItemsConfiguration: UIActivityItemsConfiguration(itemProviders: [provider]))
    } else {
      controller = UIActivityViewController(activityItems: [url], applicationActivities: nil)
    }
    controller.completionWithItemsHandler = { _, _, _, _ in promise.resolve(nil) }
    if let pop = controller.popoverPresentationController {
      pop.sourceView = vc.view
      pop.sourceRect = CGRect(x: vc.view.bounds.midX, y: vc.view.bounds.maxY, width: 0, height: 0)
    }
    vc.present(controller, animated: true)
  }

  private func cacheFile(ext: String) -> URL {
    let dir = (appContext?.config.cacheDirectory ?? FileManager.default.temporaryDirectory).appendingPathComponent("LocalMedia")
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir.appendingPathComponent("\(UUID().uuidString).\(ext)")
  }
}
