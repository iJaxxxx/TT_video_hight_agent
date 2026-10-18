import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Image, Pressable, ScrollView, StyleSheet, Text, View, type GestureResponderEvent, type LayoutChangeEvent } from 'react-native';

import { Button, Card } from '../../components/ui';
import { api, ApiError, type Calibration } from '../../lib/api';
import { useSettings } from '../../lib/settings';
import { useColors } from '../../lib/theme';

type Pt = [number, number]; // 0–1 相对坐标

const STEPS = ['近端左角', '近端右角', '远端右角', '远端左角'];
const FRAME_TIMES = [0.5, 5, 15, 30, 45, 60, 90, 120];
const LOUPE = 120;
const ZOOM = 3;

/** 两点之间的一条线：一个旋转过的细长 View */
function Segment({ a, b, color }: { a: { x: number; y: number }; b: { x: number; y: number }; color: string }) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  return (
    <View
      pointerEvents="none"
      style={{
        position: 'absolute',
        left: (a.x + b.x) / 2 - len / 2,
        top: (a.y + b.y) / 2 - 1,
        width: len,
        height: 2,
        backgroundColor: color,
        transform: [{ rotate: `${Math.atan2(dy, dx)}rad` }],
      }}
    />
  );
}

export default function CalibrateScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { serverUrl, update } = useSettings();
  const c = useColors();
  const [tIndex, setTIndex] = useState(0);
  const [duration, setDuration] = useState<number | null>(null);
  const [aspect, setAspect] = useState(16 / 9);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [pts, setPts] = useState<Pt[]>([]);
  // 4 个角都放好后，要调整哪一个角（由下方的编号按钮选择）
  const [active, setActive] = useState<number | null>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const [result, setResult] = useState<Calibration | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dragRef = useRef<number | null>(null);
  // 按下时记下画面左上角在页面里的位置。拖动时手指下面可能换成别的元素，
  // locationX 就不可靠了，统一用 pageX 减这个原点
  const origin = useRef({ x: 0, y: 0 });

  useEffect(() => {
    api.getJob(serverUrl, id).then((j) => setDuration(j.meta?.duration ?? null), () => {});
  }, [serverUrl, id]);

  const times = FRAME_TIMES.filter((t) => duration === null || t < duration - 0.5);
  const t = times[tIndex % Math.max(1, times.length)] ?? 0.5;
  const frameUrl = api.frameUrl(serverUrl, id, t);

  // 按画面真实宽高比显示，竖拍的视频也能对上坐标
  useEffect(() => {
    Image.getSize(frameUrl, (w, h) => h > 0 && setAspect(w / h), () => {});
  }, [frameUrl]);

  const toNorm = (pageX: number, pageY: number): Pt => [
    Math.min(1, Math.max(0, (pageX - origin.current.x) / box.w)),
    Math.min(1, Math.max(0, (pageY - origin.current.y) / box.h)),
  ];
  const toPx = (p: Pt) => ({ x: p[0] * box.w, y: p[1] * box.h });

  // 不满 4 个角：按下就放下一个角，按住可以继续拖；满 4 个：移动当前选中的那个角
  const onGrant = (e: GestureResponderEvent) => {
    const { pageX, pageY, locationX, locationY } = e.nativeEvent;
    origin.current = { x: pageX - locationX, y: pageY - locationY };
    const p = toNorm(pageX, pageY);
    let i: number | null;
    if (pts.length < 4) {
      i = pts.length;
      setPts([...pts, p]);
    } else {
      i = active;
      if (i !== null) setPts(pts.map((q, k) => (k === i ? p : q)));
    }
    dragRef.current = i;
    setDrag(i);
  };
  const onMove = (e: GestureResponderEvent) => {
    const i = dragRef.current;
    if (i === null) return;
    const p = toNorm(e.nativeEvent.pageX, e.nativeEvent.pageY);
    setPts((prev) => prev.map((q, k) => (k === i ? p : q)));
  };
  const onRelease = () => {
    dragRef.current = null;
    setDrag(null);
  };
  const undo = () => {
    setPts(pts.slice(0, -1));
    setActive(null);
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      setResult(await api.setCalibration(serverUrl, id, pts, t));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const accept = () => {
    if (result) update({ lastCorners: result.corners_norm });
    router.back();
  };

  if (result) {
    return (
      <ScrollView contentContainerStyle={styles.page}>
        <Text style={[styles.title, { color: c.fg }]}>线和球台对齐了吗？</Text>
        <Text style={[styles.help, { color: c.muted }]}>
          白框是算出来的球台边线，橙线是网。绿色是近端半台，蓝色是远端半台。白框和中线贴住真实的球台，就说明标定准确。
        </Text>
        <Image
          source={{ uri: api.calibrationImageUrl(serverUrl, id, result) }}
          style={{ width: '100%', aspectRatio: result.frame_size[0] / result.frame_size[1], borderRadius: 8, backgroundColor: c.chip }}
          resizeMode="contain"
        />
        <View style={styles.row}>
          <Button kind="secondary" title="重新点" onPress={() => setResult(null)} style={{ flex: 1 }} />
          <Button title="对齐了，保存" onPress={accept} style={{ flex: 1 }} />
        </View>
      </ScrollView>
    );
  }

  const dragPt = drag !== null ? pts[drag] : null;

  return (
    <ScrollView contentContainerStyle={styles.page} scrollEnabled={drag === null}>
      <Card>
        <Text style={[styles.title, { color: c.fg }]}>
          {pts.length < 4 ? `第 ${pts.length + 1} 步：点球台的${STEPS[pts.length]}` : '四个角都点好了'}
        </Text>
        {/* 固定高度：切换提示文字时画面不跳动，正在拖的角不会错位 */}
        <Text style={[styles.help, styles.stepHelp, { color: c.muted }]}>
          {pts.length < 4
            ? '近端 = 离镜头近的那条端线。按 近端左 → 近端右 → 远端右 → 远端左 的顺序绕球台一圈。角被人挡住时，可以换一帧。'
            : active === null
              ? '要微调的话，先在下面选一个角，再在画面上点或拖到准确位置。拖动时会出现放大镜。'
              : `正在调整${STEPS[active]}：在画面上点或拖到准确位置。`}
        </Text>
      </Card>

      <View
        onLayout={(e: LayoutChangeEvent) => setBox({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}
        onStartShouldSetResponder={() => true}
        onMoveShouldSetResponder={() => true}
        onResponderTerminationRequest={() => false}
        onResponderGrant={onGrant}
        onResponderMove={onMove}
        onResponderRelease={onRelease}
        onResponderTerminate={onRelease}
        style={[styles.frame, { aspectRatio: aspect, backgroundColor: c.chip }]}
      >
        <Image
          source={{ uri: frameUrl }}
          style={StyleSheet.absoluteFill}
          resizeMode="stretch"
          pointerEvents="none"
        />
        {box.w > 0 &&
          pts.map((p, i) => (i > 0 ? <Segment key={`s${i}`} a={toPx(pts[i - 1])} b={toPx(p)} color={c.ball} /> : null))}
        {box.w > 0 && pts.length === 4 && <Segment a={toPx(pts[3])} b={toPx(pts[0])} color={c.ball} />}
        {box.w > 0 &&
          pts.map((p, i) => {
            const { x, y } = toPx(p);
            return (
              <View
                key={`p${i}`}
                pointerEvents="none"
                style={[styles.dot, { left: x - 11, top: y - 11, borderColor: active === i ? '#ffffff' : c.ball }]}
              >
                <Text style={styles.dotText}>{i + 1}</Text>
              </View>
            );
          })}
        {dragPt && box.w > 0 && (
          // 放大镜：把手指下面的区域放大 3 倍，方便对准角点
          <View pointerEvents="none" style={[styles.loupe, { borderColor: c.ball }, dragPt[0] < 0.4 && dragPt[1] < 0.5 ? { right: 8 } : { left: 8 }]}>
            <Image
              source={{ uri: frameUrl }}
              resizeMode="stretch"
              style={{
                position: 'absolute',
                width: box.w * ZOOM,
                height: box.h * ZOOM,
                left: LOUPE / 2 - dragPt[0] * box.w * ZOOM,
                top: LOUPE / 2 - dragPt[1] * box.h * ZOOM,
              }}
            />
            <View style={[styles.cross, { width: 1, height: LOUPE, left: LOUPE / 2 }]} />
            <View style={[styles.cross, { height: 1, width: LOUPE, top: LOUPE / 2 }]} />
          </View>
        )}
      </View>

      {pts.length === 4 && (
        <View style={styles.row}>
          {STEPS.map((label, i) => {
            const on = active === i;
            return (
              <Pressable
                key={label}
                accessibilityRole="radio"
                accessibilityState={{ selected: on }}
                onPress={() => setActive(on ? null : i)}
                style={[styles.corner, { borderColor: on ? c.ball : c.line, backgroundColor: on ? c.t3bg : c.surface }]}
              >
                <Text style={{ color: on ? c.ball : c.fg, fontWeight: '700' }}>{i + 1}</Text>
                <Text style={{ color: c.muted, fontSize: 11 }}>{label.replace('角', '')}</Text>
              </Pressable>
            );
          })}
        </View>
      )}

      {error && <Text style={{ color: c.danger, fontSize: 13 }}>{error}</Text>}

      <View style={styles.row}>
        <Button kind="secondary" title="撤销" onPress={undo} disabled={pts.length === 0} style={{ flex: 1 }} />
        <Button
          kind="secondary"
          title={`换一帧（${t}s）`}
          onPress={() => {
            setTIndex((i) => i + 1);
          }}
          style={{ flex: 1.4 }}
        />
      </View>
      <Button title="计算标定" onPress={submit} disabled={pts.length < 4} loading={busy} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { padding: 16, gap: 14 },
  title: { fontSize: 16, fontWeight: '700' },
  help: { fontSize: 13, lineHeight: 19 },
  stepHelp: { minHeight: 57 },
  row: { flexDirection: 'row', gap: 10 },
  frame: { width: '100%', borderRadius: 8, overflow: 'hidden' },
  dot: {
    position: 'absolute',
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  dotText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  loupe: { position: 'absolute', top: 8, width: LOUPE, height: LOUPE, borderRadius: LOUPE / 2, borderWidth: 2, overflow: 'hidden', backgroundColor: '#000' },
  cross: { position: 'absolute', backgroundColor: 'rgba(255,255,255,0.8)' },
  corner: { flex: 1, borderWidth: 1.5, borderRadius: 8, paddingVertical: 6, alignItems: 'center', gap: 1 },
});
