import { For, Show, createSignal, onCleanup, onMount, untrack } from 'solid-js';
import { render } from 'solid-js/web';

import { t } from '@/i18n';

const MIN_SLIDER_MS = 0;
const MAX_SLIDER_MS = 1000;
const FLASH_DURATION_MS = 80;
const OVERDUE_DROP_MS = 1000;
const SCHEDULER_INTERVAL_MS = 25;
const SCHEDULE_AHEAD_S = 0.2;
const BEEP_PERIOD_S = 1.0;
const FIRST_BEEP_DELAY_S = 0.3;
const STEP_DELTAS = [-10, -1, 1, 10] as const;

export interface CalibrationOptions {
  initialMs: number;
  autoMs: number;
  audioContext?: AudioContext;
  onApply: (valueMs: number) => void;
  onClose?: () => void;
}

interface CalibrationProps {
  initialMs: number;
  autoMs: number;
  audioContext?: AudioContext;
  hasSharedAudioContext: boolean;
  onApply: (valueMs: number) => void;
  onCancel: () => void;
}

const clampSliderValue = (ms: number): number => {
  if (!Number.isFinite(ms)) return MIN_SLIDER_MS;
  return Math.min(MAX_SLIDER_MS, Math.max(MIN_SLIDER_MS, Math.round(ms)));
};

const Calibration = (props: CalibrationProps) => {
  const [value, setValue] = createSignal(
    clampSliderValue(untrack(() => props.initialMs)),
  );
  const [isFlashing, setIsFlashing] = createSignal(false);

  const adjustValue = (delta: number) => {
    setValue((prev) => clampSliderValue(prev + delta));
  };

  onMount(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      event.stopPropagation();

      const step = event.shiftKey ? 10 : 1;
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        adjustValue(-step);
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        adjustValue(step);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        props.onCancel();
      } else if (event.key === 'Enter') {
        event.preventDefault();
        props.onApply(value());
      }
    };

    window.addEventListener('keydown', onKeyDown, true);

    const isFallback = !props.audioContext;
    const audioContext = props.audioContext ?? new AudioContext();
    if (audioContext.state === 'suspended') {
      audioContext.resume().catch(() => {});
    }

    const activeNodes = new Set<{ osc: OscillatorNode; gain: GainNode }>();
    const pendingFlashes: number[] = [];
    let nextBeepTime = audioContext.currentTime + FIRST_BEEP_DELAY_S;
    let flashUntil = -Infinity;

    const scheduleBeep = (contextTime: number) => {
      const osc = audioContext.createOscillator();
      const gain = audioContext.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(1000, contextTime);

      gain.gain.value = 0;
      gain.gain.setValueAtTime(0, contextTime);
      gain.gain.linearRampToValueAtTime(0.25, contextTime + 0.003);
      gain.gain.exponentialRampToValueAtTime(0.0001, contextTime + 0.06);

      osc.connect(gain);
      gain.connect(audioContext.destination);

      const entry = { osc, gain };
      activeNodes.add(entry);
      osc.addEventListener('ended', () => {
        osc.disconnect();
        gain.disconnect();
        activeNodes.delete(entry);
      });

      osc.start(contextTime);
      osc.stop(contextTime + 0.08);

      // ビープのスケジュール時点で AudioContext 時刻を performance.now() 基準へ一度だけ変換する
      const deltaMs = (contextTime - audioContext.currentTime) * 1000;
      const perfTime = performance.now() + deltaMs;
      pendingFlashes.push(perfTime);
    };

    const runScheduler = () => {
      if (audioContext.state !== 'running') return;

      const currentTime = audioContext.currentTime;
      if (nextBeepTime < currentTime) {
        const missed =
          Math.floor((currentTime - nextBeepTime) / BEEP_PERIOD_S) + 1;
        nextBeepTime += missed * BEEP_PERIOD_S;
      }

      const horizon = currentTime + SCHEDULE_AHEAD_S;
      while (nextBeepTime <= horizon) {
        scheduleBeep(nextBeepTime);
        nextBeepTime += BEEP_PERIOD_S;
      }
    };

    const schedulerId = setInterval(runScheduler, SCHEDULER_INTERVAL_MS);

    let rafId = 0;
    const onFrame = () => {
      rafId = requestAnimationFrame(onFrame);

      const now = performance.now();
      const offsetMs = value();

      while (
        pendingFlashes.length > 0 &&
        now - (pendingFlashes[0] + offsetMs) > OVERDUE_DROP_MS
      ) {
        pendingFlashes.shift();
      }

      if (pendingFlashes.length > 0 && now >= pendingFlashes[0] + offsetMs) {
        pendingFlashes.shift();
        flashUntil = now + FLASH_DURATION_MS;
      }

      setIsFlashing(now < flashUntil);
    };
    rafId = requestAnimationFrame(onFrame);

    onCleanup(() => {
      window.removeEventListener('keydown', onKeyDown, true);
      clearInterval(schedulerId);
      cancelAnimationFrame(rafId);

      for (const { osc, gain } of activeNodes) {
        try {
          osc.stop();
        } catch {
          // すでに停止済みのオシレータは無視する
        }
        osc.disconnect();
        gain.disconnect();
      }
      activeNodes.clear();
      pendingFlashes.length = 0;

      if (isFallback) {
        audioContext.close().catch(() => {});
      }
    });
  });

  return (
    <div aria-modal="true" class="als-overlay" role="dialog">
      <div class="als-panel">
        <h2 class="als-title">
          {t('plugins.audio-latency-sync.prompt.calibration.title')}
        </h2>
        <p class="als-description">
          {t('plugins.audio-latency-sync.prompt.calibration.description')}
        </p>

        <div class="als-flash-stage">
          <div
            class={
              isFlashing() ? 'als-circle als-circle--active' : 'als-circle'
            }
          />
        </div>

        <div class="als-controls">
          <div class="als-readout">
            {t('plugins.audio-latency-sync.prompt.calibration.value', {
              value: value(),
            })}
          </div>
          <input
            class="als-slider"
            max={MAX_SLIDER_MS}
            min={MIN_SLIDER_MS}
            onInput={(e) =>
              setValue(clampSliderValue(Number(e.currentTarget.value)))
            }
            step={1}
            type="range"
            value={value()}
          />
          <div class="als-step-buttons">
            <For each={STEP_DELTAS}>
              {(step) => (
                <button
                  class="als-step-btn"
                  onClick={() => adjustValue(step)}
                  type="button"
                >
                  {step < 0 ? `−${Math.abs(step)}` : `+${step}`}
                </button>
              )}
            </For>
          </div>
        </div>

        <p class="als-info">
          {t('plugins.audio-latency-sync.prompt.calibration.detected', {
            detected: Math.round(props.autoMs),
          })}
        </p>

        <Show when={!props.hasSharedAudioContext}>
          <p class="als-warning">
            {t(
              'plugins.audio-latency-sync.prompt.calibration.no-audio-context',
            )}
          </p>
        </Show>

        <div class="als-actions">
          <button
            class="als-btn als-btn--cancel"
            onClick={() => props.onCancel()}
            type="button"
          >
            {t('plugins.audio-latency-sync.prompt.calibration.cancel')}
          </button>
          <button
            class="als-btn als-btn--apply"
            onClick={() => props.onApply(value())}
            type="button"
          >
            {t('plugins.audio-latency-sync.prompt.calibration.apply')}
          </button>
        </div>
      </div>
    </div>
  );
};

/**
 * テスト信号による音声遅延キャリブレーション画面を開き、閉じる関数を返す
 */
export const openCalibration = (options: CalibrationOptions): (() => void) => {
  const video = document.querySelector<HTMLVideoElement>(
    '.html5-video-container > video',
  );
  const wasPlaying = Boolean(video && !video.paused);
  if (wasPlaying) {
    video?.pause();
  }

  const container = document.createElement('div');
  document.body.append(container);

  let closed = false;
  let dispose: (() => void) | undefined;

  const close = () => {
    if (closed) return;
    closed = true;
    dispose?.();
    container.remove();
    if (wasPlaying) {
      video?.play().catch(() => {});
    }
    options.onClose?.();
  };

  dispose = render(
    () => (
      <Calibration
        audioContext={options.audioContext}
        autoMs={options.autoMs}
        hasSharedAudioContext={Boolean(options.audioContext)}
        initialMs={options.initialMs}
        onApply={(valueMs) => {
          options.onApply(valueMs);
          close();
        }}
        onCancel={close}
      />
    ),
    container,
  );

  return close;
};
