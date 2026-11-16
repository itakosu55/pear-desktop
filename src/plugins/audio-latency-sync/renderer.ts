import {
  resetAudioLatency,
  setAudioLatency,
} from '@/plugins/utils/renderer/audio-latency';
import { createRenderer } from '@/utils';
import { waitForElement } from '@/utils/wait-for-element';

import { VideoDelayRenderer } from './video-delay';

import type { AudioLatencySyncPluginConfig } from './index';
import type { RendererContext } from '@/types/contexts';

const SAMPLE_WINDOW = 8;
const SAMPLE_INTERVAL_MS = 500;
const DETECTED_PERSIST_THRESHOLD_MS = 5;
const MIN_EFFECTIVE_MS = 0;
const MAX_EFFECTIVE_MS = 2000;

const getMedian = (values: number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[mid];
  }
  return (sorted[mid - 1] + sorted[mid]) / 2;
};

export const renderer = createRenderer<
  {
    ctx?: RendererContext<AudioLatencySyncPluginConfig>;
    config?: AudioLatencySyncPluginConfig;
    audioContext?: AudioContext;
    sampleInterval?: ReturnType<typeof setInterval>;
    samples: number[];
    autoMs: number;
    lastLoggedEffectiveMs?: number;
    videoDelay?: VideoDelayRenderer;
    runId: number;
    audioCanPlayHandler: (event: CustomEvent<Compressor>) => void;
    sample: () => void;
    recompute: () => void;
  },
  AudioLatencySyncPluginConfig
>({
  samples: [],
  autoMs: 0,
  runId: 0,

  audioCanPlayHandler(event) {
    this.audioContext = event.detail.audioContext;
  },

  sample() {
    if (!this.audioContext || this.audioContext.state !== 'running') return;

    const raw =
      ((this.audioContext.outputLatency || 0) +
        (this.audioContext.baseLatency || 0)) *
      1000;
    if (!Number.isFinite(raw)) return;

    this.samples.push(raw);
    if (this.samples.length > SAMPLE_WINDOW) {
      this.samples.shift();
    }

    this.autoMs = getMedian(this.samples);
    this.recompute();

    const roundedAutoMs = Math.round(this.autoMs);
    if (
      this.config &&
      this.ctx &&
      Math.abs(roundedAutoMs - this.config.detectedLatencyMs) >=
        DETECTED_PERSIST_THRESHOLD_MS
    ) {
      // IPC 応答待ちの間に毎ティック再送信しないよう先にキャッシュを更新する
      this.config.detectedLatencyMs = roundedAutoMs;
      this.ctx.setConfig({ detectedLatencyMs: roundedAutoMs });
    }
  },

  recompute() {
    if (!this.config) return;

    const { mode, manualOffsetMs, syncLyrics, syncVisualizer, syncVideo } =
      this.config;
    const effective =
      mode === 'manual'
        ? manualOffsetMs
        : mode === 'auto'
          ? this.autoMs
          : this.autoMs + manualOffsetMs;

    setAudioLatency(effective, {
      lyrics: syncLyrics,
      visualizer: syncVisualizer,
      video: syncVideo,
    });
    this.videoDelay?.update();

    const clamped = Math.min(
      MAX_EFFECTIVE_MS,
      Math.max(MIN_EFFECTIVE_MS, Math.round(effective)),
    );
    if (clamped !== this.lastLoggedEffectiveMs) {
      this.lastLoggedEffectiveMs = clamped;
      console.debug('[audio-latency-sync] Effective latency:', clamped, 'ms');
    }
  },

  async start(ctx) {
    const runId = ++this.runId;
    if (this.sampleInterval) {
      clearInterval(this.sampleInterval);
      this.sampleInterval = undefined;
    }
    this.videoDelay?.destroy();
    this.videoDelay = undefined;
    document.removeEventListener(
      'peard:audio-can-play',
      this.audioCanPlayHandler,
    );

    this.ctx = ctx;
    const config = await ctx.getConfig();
    if (runId !== this.runId) return;

    this.config = config;
    this.samples = [];
    this.autoMs = 0;
    this.lastLoggedEffectiveMs = undefined;

    document.addEventListener(
      'peard:audio-can-play',
      this.audioCanPlayHandler,
      { passive: true },
    );

    this.recompute();
    this.sampleInterval = setInterval(this.sample, SAMPLE_INTERVAL_MS);

    waitForElement<HTMLVideoElement>('.html5-video-container > video').then(
      (video) => {
        // waitForElement 完了前に stop() や再 start() が呼ばれた場合は生成しない
        if (runId !== this.runId) return;
        this.videoDelay = new VideoDelayRenderer(video);
        this.videoDelay.update();
      },
    );
  },

  onConfigChange(newConfig) {
    this.config = newConfig;
    this.recompute();
  },

  stop() {
    this.runId++;
    if (this.sampleInterval) {
      clearInterval(this.sampleInterval);
      this.sampleInterval = undefined;
    }
    this.videoDelay?.destroy();
    this.videoDelay = undefined;
    document.removeEventListener(
      'peard:audio-can-play',
      this.audioCanPlayHandler,
    );
    this.audioContext = undefined;
    this.ctx = undefined;
    this.samples = [];
    this.autoMs = 0;
    this.lastLoggedEffectiveMs = undefined;
    resetAudioLatency();
  },
});
