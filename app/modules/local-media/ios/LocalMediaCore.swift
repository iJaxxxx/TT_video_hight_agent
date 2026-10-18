import AVFoundation
import CoreGraphics
import Foundation

/// 本地解析用到的 AVFoundation 能力。故意不依赖 ExpoModulesCore：
/// 同一份代码在 macOS 上可以用 swiftc 直接编译成命令行工具做对齐和测速（见 modules/local-media/macos-harness）。
public enum LocalMediaError: Error, CustomStringConvertible {
  case noDecodableAudio
  case noVideo
  case readerFailed(String)
  case exportFailed(String)
  case badArgument(String)

  public var description: String {
    switch self {
    case .noDecodableAudio: return "视频里没有可解码的音轨，无法按击球声检测"
    case .noVideo: return "视频里没有画面轨道"
    case .readerFailed(let m): return "读取音频失败：\(m)"
    case .exportFailed(let m): return "导出失败：\(m)"
    case .badArgument(let m): return m
    }
  }
}

public struct ClipRange {
  public let start: Double
  public let end: Double
  public init(start: Double, end: Double) {
    self.start = start
    self.end = end
  }
}

public enum LocalMediaCore {
  // MARK: - 音频

  /// 把可解码的音轨转成单声道 float32 PCM，边读边写进 outURL（不整段放内存）。
  /// 新款 iPhone 的第一条音轨是空间音频 APAC：跳过它；某条轨 startReading 失败也换下一条。
  /// 返回写入的采样数。
  public static func extractAudio(
    from url: URL, to outURL: URL, sampleRate: Double = 16000,
    progress: ((Double) -> Void)? = nil
  ) throws -> Int {
    let asset = AVURLAsset(url: url)
    let tracks = asset.tracks(withMediaType: .audio)
    let ordered = tracks.filter { !isAPAC($0) } + tracks.filter { isAPAC($0) }
    let duration = asset.duration.seconds
    var lastError = "没有音轨"
    for track in ordered {
      do {
        return try readTrack(asset: asset, track: track, to: outURL, sampleRate: sampleRate, duration: duration, progress: progress)
      } catch {
        lastError = "\(error)"
      }
    }
    if tracks.isEmpty { throw LocalMediaError.noDecodableAudio }
    throw LocalMediaError.readerFailed(lastError)
  }

  /// 'apac'。不用 kAudioFormatAPAC：它在 iOS 18 SDK 才有，部署目标是 16.4
  static let apacFourCC: FourCharCode = 0x6170_6163

  static func isAPAC(_ track: AVAssetTrack) -> Bool {
    for case let desc as CMFormatDescription in track.formatDescriptions {
      if CMFormatDescriptionGetMediaSubType(desc) == apacFourCC { return true }
    }
    return false
  }

  private static func readTrack(
    asset: AVAsset, track: AVAssetTrack, to outURL: URL, sampleRate: Double, duration: Double,
    progress: ((Double) -> Void)?
  ) throws -> Int {
    let reader = try AVAssetReader(asset: asset)
    // 按原始采样率和声道解码，下混和重采样自己做（与 ffmpeg 一致，见 FFmpegLikeResampler）。
    // 让 AVAssetReader 直接出 16k 单声道也行，但它的重采样滤波器和 ffmpeg 不同，
    // 阈值附近的击球会有出入（实测回合一致率只有 89%）。
    let settings: [String: Any] = [
      AVFormatIDKey: kAudioFormatLinearPCM,
      AVLinearPCMBitDepthKey: 32,
      AVLinearPCMIsFloatKey: true,
      AVLinearPCMIsBigEndianKey: false,
      AVLinearPCMIsNonInterleaved: false,
    ]
    let output = AVAssetReaderTrackOutput(track: track, outputSettings: settings)
    output.alwaysCopiesSampleData = false
    guard reader.canAdd(output) else { throw LocalMediaError.readerFailed("不支持的音频格式") }
    reader.add(output)
    guard reader.startReading() else {
      throw LocalMediaError.readerFailed(reader.error?.localizedDescription ?? "startReading 失败")
    }

    FileManager.default.createFile(atPath: outURL.path, contents: nil)
    let fh = try FileHandle(forWritingTo: outURL)
    defer { try? fh.close() }

    var resampler: FFmpegLikeResampler?
    var channels = 1
    var samples = 0
    var inFrames = 0
    var lastReport = 0.0
    var interleaved = [Float]()
    var mono = [Float]()
    let write = { (out: [Float]) throws in
      guard !out.isEmpty else { return }
      try out.withUnsafeBytes { try fh.write(contentsOf: Data($0)) }
      samples += out.count
    }
    while let sb = output.copyNextSampleBuffer() {
      if resampler == nil {
        guard let fmt = CMSampleBufferGetFormatDescription(sb),
              let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(fmt)?.pointee
        else { continue }
        channels = max(1, Int(asbd.mChannelsPerFrame))
        resampler = FFmpegLikeResampler(inRate: Int(asbd.mSampleRate.rounded()), outRate: Int(sampleRate))
      }
      guard let block = CMSampleBufferGetDataBuffer(sb) else { continue }
      let len = CMBlockBufferGetDataLength(block)
      let n = len / 4
      if interleaved.count < n { interleaved = [Float](repeating: 0, count: n) }
      let status = interleaved.withUnsafeMutableBytes { raw in
        CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: len, destination: raw.baseAddress!)
      }
      guard status == kCMBlockBufferNoErr else { continue }
      let frames = n / channels
      downmix(interleaved, frames: frames, channels: channels, into: &mono)
      try write(resampler!.push(mono, count: frames))
      inFrames += frames
      if let progress, duration > 0, let r = resampler {
        let p = min(1, Double(inFrames) / Double(r.inRate) / duration)
        if p - lastReport >= 0.02 {
          lastReport = p
          progress(p)
        }
      }
    }
    if reader.status == .failed {
      throw LocalMediaError.readerFailed(reader.error?.localizedDescription ?? "读取中断")
    }
    if let r = resampler { try write(r.finish()) }
    progress?(1)
    return samples
  }

  /// ffmpeg -ac 1 的下混：立体声是 (L+R)/√2；单声道原样；更多声道取平均（iPhone 上不会遇到）
  static func downmix(_ x: [Float], frames: Int, channels: Int, into out: inout [Float]) {
    if out.count < frames { out = [Float](repeating: 0, count: frames) }
    x.withUnsafeBufferPointer { src in
      out.withUnsafeMutableBufferPointer { dst in
        switch channels {
        case 1:
          for i in 0..<frames { dst[i] = src[i] }
        case 2:
          let g = Float(0.5.squareRoot())
          for i in 0..<frames { dst[i] = (src[2 * i] + src[2 * i + 1]) * g }
        default:
          let g = 1 / Float(channels)
          for i in 0..<frames {
            var s: Float = 0
            for c in 0..<channels { s += src[i * channels + c] }
            dst[i] = s * g
          }
        }
      }
    }
  }

  // MARK: - 导出

  /// 画面比例（居中裁切）和清晰度（短边像素，不放大）。与 server/pipeline.py 的 export_filter 一致：
  ///   crop w = trunc(min(iw, ih*a/b)/2)*2, h = trunc(min(ih, iw*b/a)/2)*2
  ///   scale 短边 = min(短边, q)，长边按比例取偶数
  public static func outputGeometry(rendered: CGSize, ratio: String?, quality: String?) -> (crop: CGRect, size: CGSize) {
    let iw = rendered.width
    let ih = rendered.height
    var cw = floor(iw / 2) * 2
    var ch = floor(ih / 2) * 2
    if let ratio, let (a, b) = parseRatio(ratio) {
      cw = floor(min(iw, ih * a / b) / 2) * 2
      ch = floor(min(ih, iw * b / a) / 2) * 2
    }
    let crop = CGRect(x: floor((iw - cw) / 2), y: floor((ih - ch) / 2), width: cw, height: ch)
    var ow = cw
    var oh = ch
    if let q = quality.flatMap(parseQuality) {
      if cw >= ch {
        oh = min(ch, q)
        ow = (cw * oh / ch / 2).rounded() * 2
      } else {
        ow = min(cw, q)
        oh = (ch * ow / cw / 2).rounded() * 2
      }
    }
    return (crop, CGSize(width: ow, height: oh))
  }

  static func parseRatio(_ r: String) -> (CGFloat, CGFloat)? {
    switch r {
    case "9:16": return (9, 16)
    case "16:9": return (16, 9)
    case "1:1": return (1, 1)
    default: return nil
    }
  }

  static func parseQuality(_ q: String) -> CGFloat? {
    switch q {
    case "720p": return 720
    case "1080p": return 1080
    default: return nil
    }
  }

  /// 把若干片段按顺序拼成一个 mp4（H.264 硬件编码 + AAC 128k，码率见 videoBitrate）。progress 0–1。
  public static func exportClips(
    from url: URL, clips: [ClipRange], ratio: String?, quality: String?, to outURL: URL,
    progress: ((Double) -> Void)? = nil,
    completion: @escaping (Result<Double, Error>) -> Void
  ) {
    do {
      let asset = AVURLAsset(url: url, options: [AVURLAssetPreferPreciseDurationAndTimingKey: true])
      guard let vTrack = asset.tracks(withMediaType: .video).first else { throw LocalMediaError.noVideo }
      let aTrack = asset.tracks(withMediaType: .audio).first { !isAPAC($0) }
      guard !clips.isEmpty else { throw LocalMediaError.badArgument("没有要导出的片段") }

      let comp = AVMutableComposition()
      guard let cv = comp.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid) else {
        throw LocalMediaError.exportFailed("无法创建视频轨")
      }
      let ca = aTrack.flatMap { _ in comp.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) }
      let total = asset.duration
      var cursor = CMTime.zero
      for c in clips {
        let s = CMTime(seconds: max(0, c.start), preferredTimescale: 600)
        let e = CMTimeMinimum(CMTime(seconds: c.end, preferredTimescale: 600), total)
        guard e > s else { continue }
        let range = CMTimeRange(start: s, end: e)
        try cv.insertTimeRange(range, of: vTrack, at: cursor)
        if let ca, let aTrack { try? ca.insertTimeRange(range, of: aTrack, at: cursor) }
        cursor = cursor + range.duration
      }
      guard cursor > .zero else { throw LocalMediaError.badArgument("片段时长为 0") }

      // 旋转后的画面尺寸，再做居中裁切和缩放
      let t = vTrack.preferredTransform
      let bounds = CGRect(origin: .zero, size: vTrack.naturalSize).applying(t)
      let rendered = CGSize(width: abs(bounds.width).rounded(), height: abs(bounds.height).rounded())
      let geo = outputGeometry(rendered: rendered, ratio: ratio, quality: quality)
      let scale = geo.size.width / geo.crop.width
      let transform = t
        .concatenating(CGAffineTransform(translationX: -bounds.minX, y: -bounds.minY))
        .concatenating(CGAffineTransform(translationX: -geo.crop.minX, y: -geo.crop.minY))
        .concatenating(CGAffineTransform(scaleX: scale, y: scale))

      let layer = AVMutableVideoCompositionLayerInstruction(assetTrack: cv)
      layer.setTransform(transform, at: .zero)
      let instruction = AVMutableVideoCompositionInstruction()
      instruction.timeRange = CMTimeRange(start: .zero, duration: cursor)
      instruction.layerInstructions = [layer]
      let vc = AVMutableVideoComposition()
      vc.instructions = [instruction]
      vc.renderSize = geo.size
      let fps = vTrack.nominalFrameRate > 0 ? vTrack.nominalFrameRate : 30
      vc.frameDuration = CMTime(value: 1, timescale: CMTimeScale(fps.rounded()))

      // 和 server 一样按 SDR BT.709 出片（HDR 源在合成时转成 SDR）
      vc.colorPrimaries = AVVideoColorPrimaries_ITU_R_709_2
      vc.colorTransferFunction = AVVideoTransferFunction_ITU_R_709_2
      vc.colorYCbCrMatrix = AVVideoYCbCrMatrix_ITU_R_709_2

      let audioTrack = ca.flatMap { $0.timeRange.duration > .zero ? $0 : nil }
      try? FileManager.default.removeItem(at: outURL)
      let job = try ExportJob(
        composition: comp, videoComposition: vc, audioTrack: audioTrack, size: geo.size, fps: Double(fps),
        duration: cursor, to: outURL)
      let seconds = cursor.seconds
      DispatchQueue.global(qos: .userInitiated).async {
        job.run(progress: progress) { error in
          if let error {
            try? FileManager.default.removeItem(at: outURL)
            completion(.failure(error))
          } else {
            progress?(1)
            completion(.success(seconds))
          }
        }
      }
    } catch {
      completion(.failure(error))
    }
  }

  /// 视频码率。AVAssetExportSession 的 HighestQuality 不能设码率（成片 9–16 Mbps），这里按像素数 × 帧率定：
  /// 60fps 时 1920×1080 ≈ 8.7 Mbps、1280×720 ≈ 3.9 Mbps；30fps 每像素给多一点（帧间差异更大）。
  static func videoBitrate(size: CGSize, fps: Double) -> Int {
    let bitsPerPixel = fps > 40 ? 0.07 : 0.1
    let bps = Double(size.width * size.height) * max(fps, 1) * bitsPerPixel
    return Int(min(max(bps, 1_500_000), 12_000_000))
  }

  static let audioBitrate = 128_000
}

/// AVAssetReader（读合成后的画面和音频）→ AVAssetWriter（H.264 硬件编码 + AAC）
private final class ExportJob {
  let reader: AVAssetReader
  let writer: AVAssetWriter
  let videoOut: AVAssetReaderVideoCompositionOutput
  let videoIn: AVAssetWriterInput
  let audioOut: AVAssetReaderTrackOutput?
  let audioIn: AVAssetWriterInput?
  let duration: CMTime

  init(
    composition: AVComposition, videoComposition: AVVideoComposition, audioTrack: AVCompositionTrack?,
    size: CGSize, fps: Double, duration: CMTime, to outURL: URL
  ) throws {
    self.duration = duration
    reader = try AVAssetReader(asset: composition)
    reader.timeRange = CMTimeRange(start: .zero, duration: duration)
    writer = try AVAssetWriter(outputURL: outURL, fileType: .mp4)
    writer.shouldOptimizeForNetworkUse = true

    videoOut = AVAssetReaderVideoCompositionOutput(
      videoTracks: composition.tracks(withMediaType: .video),
      videoSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange])
    videoOut.videoComposition = videoComposition
    videoOut.alwaysCopiesSampleData = false
    guard reader.canAdd(videoOut) else { throw LocalMediaError.exportFailed("无法读取画面") }
    reader.add(videoOut)

    let compression: [String: Any] = [
      AVVideoAverageBitRateKey: LocalMediaCore.videoBitrate(size: size, fps: fps),
      AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
      AVVideoH264EntropyModeKey: AVVideoH264EntropyModeCABAC,
      AVVideoExpectedSourceFrameRateKey: fps,
      AVVideoMaxKeyFrameIntervalDurationKey: 2,
      AVVideoAllowFrameReorderingKey: true,
    ]
    videoIn = AVAssetWriterInput(mediaType: .video, outputSettings: [
      AVVideoCodecKey: AVVideoCodecType.h264,
      AVVideoWidthKey: Int(size.width),
      AVVideoHeightKey: Int(size.height),
      AVVideoCompressionPropertiesKey: compression,
      AVVideoColorPropertiesKey: [
        AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_709_2,
        AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_709_2,
        AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_709_2,
      ],
    ])
    videoIn.expectsMediaDataInRealTime = false
    guard writer.canAdd(videoIn) else { throw LocalMediaError.exportFailed("无法写入画面") }
    writer.add(videoIn)

    if let audioTrack {
      // 声道数和采样率跟源走（iPhone 上是 48k 立体声），多于两声道的下混成立体声
      var channels = 2
      var sampleRate = 48000.0
      if let desc = audioTrack.formatDescriptions.first,
         let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(desc as! CMAudioFormatDescription)?.pointee {
        channels = min(2, max(1, Int(asbd.mChannelsPerFrame)))
        if asbd.mSampleRate > 0 { sampleRate = asbd.mSampleRate }
      }
      let out = AVAssetReaderTrackOutput(track: audioTrack, outputSettings: [
        AVFormatIDKey: kAudioFormatLinearPCM,
        AVLinearPCMBitDepthKey: 16,
        AVLinearPCMIsFloatKey: false,
        AVLinearPCMIsBigEndianKey: false,
        AVLinearPCMIsNonInterleaved: false,
        AVNumberOfChannelsKey: channels,
        AVSampleRateKey: sampleRate,
      ])
      out.alwaysCopiesSampleData = false
      let input = AVAssetWriterInput(mediaType: .audio, outputSettings: [
        AVFormatIDKey: kAudioFormatMPEG4AAC,
        AVNumberOfChannelsKey: channels,
        AVSampleRateKey: sampleRate,
        AVEncoderBitRateKey: LocalMediaCore.audioBitrate,
      ])
      input.expectsMediaDataInRealTime = false
      if reader.canAdd(out), writer.canAdd(input) {
        reader.add(out)
        writer.add(input)
        audioOut = out
        audioIn = input
      } else {
        audioOut = nil
        audioIn = nil
      }
    } else {
      audioOut = nil
      audioIn = nil
    }
  }

  func run(progress: ((Double) -> Void)?, completion: @escaping (Error?) -> Void) {
    guard reader.startReading() else {
      return completion(LocalMediaError.exportFailed(reader.error?.localizedDescription ?? "读取失败"))
    }
    guard writer.startWriting() else {
      reader.cancelReading()
      return completion(LocalMediaError.exportFailed(writer.error?.localizedDescription ?? "写入失败"))
    }
    writer.startSession(atSourceTime: .zero)

    let group = DispatchGroup()
    let total = duration.seconds
    var lastReport = 0.0
    group.enter()
    pump(videoOut, into: videoIn, label: "video", done: group.leave) { pts in
      guard let progress, total > 0 else { return }
      let p = min(0.99, pts.seconds / total)
      if p - lastReport >= 0.01 {
        lastReport = p
        progress(p)
      }
    }
    if let audioOut, let audioIn {
      group.enter()
      pump(audioOut, into: audioIn, label: "audio", done: group.leave)
    }

    group.notify(queue: .global()) { [self] in
      if reader.status == .failed || writer.status == .failed {
        let e = writer.error ?? reader.error
        reader.cancelReading()
        writer.cancelWriting()
        return completion(LocalMediaError.exportFailed(e?.localizedDescription ?? "未知错误"))
      }
      writer.finishWriting { [self] in
        if writer.status == .completed {
          completion(nil)
        } else {
          completion(LocalMediaError.exportFailed(writer.error?.localizedDescription ?? "写入未完成"))
        }
      }
    }
  }

  private func pump(
    _ output: AVAssetReaderOutput, into input: AVAssetWriterInput, label: String,
    done: @escaping () -> Void, onSample: ((CMTime) -> Void)? = nil
  ) {
    let queue = DispatchQueue(label: "LocalMedia.export.\(label)")
    input.requestMediaDataWhenReady(on: queue) { [self] in
      while input.isReadyForMoreMediaData {
        guard reader.status == .reading, writer.status == .writing,
              let sb = output.copyNextSampleBuffer()
        else {
          input.markAsFinished()
          done()
          return
        }
        if !input.append(sb) {
          // writer 已失败：停读，让另一路也尽快结束
          reader.cancelReading()
          input.markAsFinished()
          done()
          return
        }
        onSample?(CMSampleBufferGetPresentationTimeStamp(sb))
      }
    }
  }
}
