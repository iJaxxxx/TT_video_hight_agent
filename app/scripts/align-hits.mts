/**
 * 精度对齐：同一段音频分别跑 Python（common.py）和 TS（src/lib/local/hits.ts），比较击球时间点和回合切分。
 *
 *   node scripts/align-hits.mts <视频> [--start 秒] [--duration 秒] [--pcm 文件]
 *
 * 默认两边都用 ffmpeg 抽的同一份 16kHz 单声道 PCM，差异只来自算法实现。
 * 传 --pcm（float32 小端，16kHz 单声道，比如 iOS 原生模块 / macOS 验证程序导出的）时，
 * TS 改用这份 PCM，得到的就是「手机端解码 + TS 算法」对「服务端 ffmpeg + Python」的一致率。
 * Python 解释器用 $PYTHON，默认 python3（需要装好 numpy）。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { detectHits, groupRallies, type Rally } from '../src/lib/local/hits.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SR = 16000;
const TOL = 0.03;
const MIN_HITS = 2; // 与 server/pipeline.py 里 App 传的 min_hits 一致

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const video = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
if (!video) {
  console.error('用法：node scripts/align-hits.mts <视频> [--start 秒] [--duration 秒] [--pcm 文件]');
  process.exit(1);
}
const start = opt('start');
const duration = opt('duration');
const pcmPath = opt('pcm');

// ———— Python 版 ————
const py = `
import json, sys, time
sys.path.insert(0, ${JSON.stringify(ROOT)})
from common import extract_audio, detect_hits, group_rallies
start = ${start ?? 'None'}; duration = ${duration ?? 'None'}
x, sr = extract_audio(${JSON.stringify(video)}, start=start, duration=duration)
t0 = time.time()
hits = detect_hits(x, sr)
el = time.time() - t0
times = [t for t, _ in hits]
print(json.dumps({"samples": len(x), "hits": times, "rallies": group_rallies(times), "seconds": el}))
`;
const pyOut = JSON.parse(
  execFileSync(process.env.PYTHON ?? 'python3', ['-c', py], { maxBuffer: 1 << 30 }).toString(),
) as { samples: number; hits: number[]; rallies: Rally[]; seconds: number };

// ———— TS 版：和 common.extract_audio 完全相同的 ffmpeg 命令 ————
function ffmpegPcm(): Float32Array {
  const streams = JSON.parse(
    execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=codec_name', '-of', 'json', video!]).toString(),
  ).streams as { codec_name: string }[];
  const idx = streams.findIndex((s) => s.codec_name !== 'apple_apac');
  if (idx < 0) throw new Error('没有可解码的音轨');
  const cmd = ['-v', 'error'];
  if (start) cmd.push('-ss', start);
  cmd.push('-i', video!);
  if (duration) cmd.push('-t', duration);
  cmd.push('-map', `0:a:${idx}`, '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-');
  const buf = execFileSync('ffmpeg', cmd, { maxBuffer: 2 ** 31 });
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

function readPcm(path: string): Float32Array {
  const buf = readFileSync(path);
  let x = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  // 原生端抽的是整条音轨，按 --start/--duration 截出同一段
  const s0 = Math.round(Number(start ?? 0) * SR);
  const s1 = duration ? s0 + Math.round(Number(duration) * SR) : x.length;
  return x.subarray(s0, Math.min(x.length, s1));
}

const x = pcmPath ? readPcm(pcmPath) : ffmpegPcm();
const t0 = performance.now();
const tsHits = detectHits(x, SR).map((h) => h.t);
const tsSeconds = (performance.now() - t0) / 1000;
const tsRallies = groupRallies(tsHits);

// ———— 比较 ————
/** 按时间顺序贪心配对，容差 ±TOL */
function matchHits(a: number[], b: number[]) {
  let i = 0;
  let j = 0;
  let matched = 0;
  const offsets: number[] = [];
  const onlyA: number[] = [];
  const onlyB: number[] = [];
  while (i < a.length && j < b.length) {
    const d = b[j] - a[i];
    if (Math.abs(d) <= TOL) {
      matched++;
      offsets.push(d);
      i++;
      j++;
    } else if (d < 0) onlyB.push(b[j++]);
    else onlyA.push(a[i++]);
  }
  onlyA.push(...a.slice(i));
  onlyB.push(...b.slice(j));
  return { matched, offsets, onlyA, onlyB };
}

function matchRallies(a: Rally[], b: Rally[]) {
  let same = 0;
  for (const r of a) {
    if (b.some((q) => q.hits === r.hits && Math.abs(q.start - r.start) <= TOL && Math.abs(q.end - r.end) <= TOL)) same++;
  }
  return same;
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const h = matchHits(pyOut.hits, tsHits);
const hitAgree = h.matched / Math.max(1, Math.max(pyOut.hits.length, tsHits.length));
const pyR = pyOut.rallies.filter((r) => r.hits >= MIN_HITS);
const tsR = tsRallies.filter((r) => r.hits >= MIN_HITS);
const rSame = matchRallies(pyR, tsR);
const rallyAgree = rSame / Math.max(1, Math.max(pyR.length, tsR.length));
const meanOff = h.offsets.length ? h.offsets.reduce((s, v) => s + v, 0) / h.offsets.length : 0;
const maxOff = h.offsets.reduce((m, v) => Math.max(m, Math.abs(v)), 0);

console.log(`音频：${pcmPath ? `PCM 文件 ${pcmPath}` : 'ffmpeg'}，${(x.length / SR).toFixed(1)} 秒（Python ${(pyOut.samples / SR).toFixed(1)} 秒）`);
console.log(`击球：Python ${pyOut.hits.length}，TS ${tsHits.length}，±${TOL * 1000}ms 内配对 ${h.matched}，一致率 ${pct(hitAgree)}`);
console.log(`  配对的时间差：平均 ${(meanOff * 1000).toFixed(2)}ms，最大 ${(maxOff * 1000).toFixed(2)}ms`);
if (h.onlyA.length) console.log(`  只有 Python 有：${h.onlyA.map((t) => t.toFixed(3)).join(', ')}`);
if (h.onlyB.length) console.log(`  只有 TS 有：${h.onlyB.map((t) => t.toFixed(3)).join(', ')}`);
console.log(`回合（≥${MIN_HITS} 拍）：Python ${pyR.length}，TS ${tsR.length}，起止 ±${TOL * 1000}ms 且拍数相同 ${rSame}，一致率 ${pct(rallyAgree)}`);
console.log(`检测耗时：Python ${pyOut.seconds.toFixed(2)}s，TS(Node) ${tsSeconds.toFixed(2)}s`);
const ok = hitAgree >= 0.95 && rallyAgree >= 0.95;
console.log(ok ? '结论：达标（≥95%）' : '结论：未达标（<95%）');
process.exit(ok ? 0 : 2);
