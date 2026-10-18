import ExpoModulesCore

struct ClipRecord: Record {
  @Field var start: Double = 0
  @Field var end: Double = 0
}

/// 本地解析的原生部分：抽音频（给 TS 版击球检测用）、拼接导出成片。逻辑都在 LocalMediaCore 里。
public class LocalMediaModule: Module {
  public func definition() -> ModuleDefinition {
    Name("LocalMedia")

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
  }

  private func cacheFile(ext: String) -> URL {
    let dir = (appContext?.config.cacheDirectory ?? FileManager.default.temporaryDirectory).appendingPathComponent("LocalMedia")
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir.appendingPathComponent("\(UUID().uuidString).\(ext)")
  }
}
