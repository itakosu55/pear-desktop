export type AudioLatencyTarget = 'lyrics' | 'visualizer' | 'video';

const MIN_LATENCY_MS = 0;
const MAX_LATENCY_MS = 2000;

let latencyMs = 0;
let targets: Record<AudioLatencyTarget, boolean> = {
  lyrics: false,
  visualizer: false,
  video: false,
};
const listeners = new Set<() => void>();

const clampLatencyMs = (value: number): number => {
  if (!Number.isFinite(value)) return MIN_LATENCY_MS;
  return Math.min(MAX_LATENCY_MS, Math.max(MIN_LATENCY_MS, Math.round(value)));
};

const notifyListeners = () => {
  for (const listener of [...listeners]) {
    listener();
  }
};

/**
 * 音声出力の遅延時間（ms）と適用対象を更新し、変更があればリスナーへ通知する
 */
export const setAudioLatency = (
  nextLatencyMs: number,
  nextTargets: Record<AudioLatencyTarget, boolean>,
): void => {
  const clamped = clampLatencyMs(nextLatencyMs);
  const changed =
    clamped !== latencyMs ||
    nextTargets.lyrics !== targets.lyrics ||
    nextTargets.visualizer !== targets.visualizer ||
    nextTargets.video !== targets.video;

  if (!changed) return;

  latencyMs = clamped;
  targets = {
    lyrics: nextTargets.lyrics,
    visualizer: nextTargets.visualizer,
    video: nextTargets.video,
  };
  notifyListeners();
};

/**
 * 遅延時間と適用対象を初期状態（0ms / 全無効）にリセットする
 */
export const resetAudioLatency = (): void => {
  setAudioLatency(0, {
    lyrics: false,
    visualizer: false,
    video: false,
  });
};

/**
 * 指定されたターゲット向けの補正遅延時間（ms）を返す（無効時は 0）
 */
export const getAudioLatencyMs = (target: AudioLatencyTarget): number => {
  return targets[target] ? latencyMs : 0;
};

/**
 * 遅延設定の変更を購読し、解除関数を返す
 */
export const onAudioLatencyChange = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
