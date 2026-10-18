import Foundation

// macOS 上验证 LocalMediaCore：和 iOS 用的是同一套 AVFoundation 解码器 / 编码器。
//   audio  <视频> <输出.pcm>
//   export <视频> <输出.mp4> <9:16|16:9|1:1|-> <720p|1080p|-> <起-止> [<起-止> ...]
let args = CommandLine.arguments
func fail(_ m: String) -> Never {
  FileHandle.standardError.write((m + "\n").data(using: .utf8)!)
  exit(1)
}
guard args.count >= 4 else { fail("用法见 main.swift 注释") }
let video = URL(fileURLWithPath: args[2])
let out = URL(fileURLWithPath: args[3])
let t0 = Date()
switch args[1] {
case "audio":
  do {
    let n = try LocalMediaCore.extractAudio(from: video, to: out)
    print(String(format: "audio: %d samples (%.1fs) in %.2fs", n, Double(n) / 16000, Date().timeIntervalSince(t0)))
  } catch { fail("\(error)") }
case "export":
  guard args.count >= 7 else { fail("export 需要比例、清晰度和至少一个片段") }
  let ratio = args[4] == "-" ? nil : args[4]
  let quality = args[5] == "-" ? nil : args[5]
  let clips = args[6...].map { s -> ClipRange in
    let p = s.split(separator: "-").map { Double($0)! }
    return ClipRange(start: p[0], end: p[1])
  }
  let sem = DispatchSemaphore(value: 0)
  LocalMediaCore.exportClips(from: video, clips: clips, ratio: ratio, quality: quality, to: out) { r in
    switch r {
    case .success(let d): print(String(format: "export: %.1fs of video in %.2fs", d, Date().timeIntervalSince(t0)))
    case .failure(let e): fail("\(e)")
    }
    sem.signal()
  }
  sem.wait()
default:
  fail("未知命令 \(args[1])")
}
