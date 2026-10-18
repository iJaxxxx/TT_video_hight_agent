import Accelerate
import Foundation

/// 复刻 ffmpeg swresample 默认参数的重采样（filter_size=32, cutoff=0.97, Kaiser beta=9），
/// 让手机上抽出的 16k PCM 和服务端 ffmpeg 的结果几乎逐点一致（48k→16k 实测 RMS 误差 ~5e-6）。
/// 输出第 m 个点对应输入位置 m·in/out，每个小数相位一组滤波器，各自归一化。
/// 流式：push 一段输入，吐出能算的输出；finish 用 0 补齐尾部。
final class FFmpegLikeResampler {
  let inRate: Int
  let outRate: Int
  private let up: Int   // 约分后的 out
  private let down: Int // 约分后的 in
  private let tap: Int
  private let center: Int
  private var filters: [[Float]] // [相位][tap]
  private var buf: [Float]        // 还没用完的输入；buf[0] 对应输入序号 bufStart
  private var bufStart = 0
  private var nextOut = 0         // 下一个输出点的序号

  init(inRate: Int, outRate: Int, filterSize: Int = 32, cutoff: Double = 0.97, beta: Double = 9) {
    self.inRate = inRate
    self.outRate = outRate
    let g = Self.gcd(inRate, outRate)
    up = outRate / g
    down = inRate / g
    let factor = min(Double(outRate) * cutoff / Double(inRate), 1.0)
    let tap = max(1, Int((Double(filterSize) / factor).rounded(.up)))
    let center = (tap - 1) / 2
    let up = self.up
    self.tap = tap
    self.center = center
    filters = (0..<up).map { r in
      // 相位 r/up：输出点落在输入整数位置之后 r/up 处
      let ph = Double(r) / Double(up)
      var h = (0..<tap).map { i -> Double in
        let x = Double.pi * (Double(i - center) - ph) * factor
        var y = x == 0 ? 1.0 : sin(x) / x
        let w = 2.0 * x / (factor * Double(tap) * Double.pi)
        y *= Self.besselI0(beta * max(1 - w * w, 0).squareRoot())
        return y
      }
      let norm = h.reduce(0, +)
      h = h.map { $0 / norm }
      // 与 swresample 相同：输出 = Σ h[i]·x[q - center + i]
      return h.map(Float.init)
    }
    // 开头用 0 填充，和 ffmpeg 一样从 0 时刻起算
    buf = [Float](repeating: 0, count: tap)
    bufStart = -tap
  }

  func push(_ x: [Float], count: Int) -> [Float] {
    buf.append(contentsOf: x[0..<count])
    return drain(final: false)
  }

  func finish() -> [Float] {
    buf.append(contentsOf: [Float](repeating: 0, count: tap))
    return drain(final: true)
  }

  private var totalIn: Int { bufStart + buf.count }
  private var realIn = 0

  private func drain(final: Bool) -> [Float] {
    if !final { realIn = totalIn }
    // 输出总长度与 ffmpeg 一致：ceil(in·out/in)
    let limit = final ? (realIn * up + down - 1) / down : Int.max
    var out = [Float]()
    while nextOut < limit {
      let pos = nextOut * down
      let q = pos / up
      let r = pos % up
      // 需要的输入区间 [q - center, q - center + tap - 1]
      let lo = q - center
      let hi = lo + tap - 1
      if hi >= totalIn { break }
      let f = filters[r]
      var acc: Float = 0
      buf.withUnsafeBufferPointer { b in
        f.withUnsafeBufferPointer { fp in
          vDSP_dotpr(b.baseAddress! + (lo - bufStart), 1, fp.baseAddress!, 1, &acc, vDSP_Length(tap))
        }
      }
      out.append(acc)
      nextOut += 1
    }
    // 丢掉以后用不到的输入
    let keepFrom = (nextOut * down) / up - tap
    if keepFrom - bufStart > 65536 {
      buf.removeFirst(keepFrom - bufStart)
      bufStart = keepFrom
    }
    return out
  }

  private static func gcd(_ a: Int, _ b: Int) -> Int { b == 0 ? a : gcd(b, a % b) }

  /// 第一类修正贝塞尔函数 I0（级数展开，和 ffmpeg 的精度足够接近）
  private static func besselI0(_ x: Double) -> Double {
    var sum = 1.0
    var term = 1.0
    let q = x * x / 4
    for k in 1..<64 {
      term *= q / Double(k * k)
      sum += term
      if term < sum * 1e-17 { break }
    }
    return sum
  }
}
