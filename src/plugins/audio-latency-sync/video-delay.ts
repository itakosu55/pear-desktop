import { t } from '@/i18n';
import {
  getAudioLatencyMs,
  onAudioLatencyChange,
} from '@/plugins/utils/renderer/audio-latency';

const MAX_CANVAS_WIDTH = 1920;
const PIP_MAX_WIDTH = 1280;
const PIP_MAX_HEIGHT = 720;
const MAX_QUEUE_SIZE = 120;

export interface DelayedFrameSink {
  drawFrame(bitmap: ImageBitmap): void;
  clear(): void;
}

/**
 * PiP 向けに動画の元解像度を最大 1280x720 に拡大なしでアスペクト比維持フィットさせる
 */
export const fitPipSize = (
  videoW: number,
  videoH: number,
): { width: number; height: number } => {
  const scale = Math.min(1, PIP_MAX_WIDTH / videoW, PIP_MAX_HEIGHT / videoH);
  return {
    width: Math.min(PIP_MAX_WIDTH, Math.max(1, Math.round(videoW * scale))),
    height: Math.min(PIP_MAX_HEIGHT, Math.max(1, Math.round(videoH * scale))),
  };
};

interface DelayedFrame {
  t: number;
  bitmap: ImageBitmap;
}

/**
 * 音声の遅延時間に合わせて映像フレームを遅延描画するオーバーレイレンダラー
 */
export class VideoDelayRenderer {
  private readonly video: HTMLVideoElement;
  private readonly supported: boolean;

  private destroyed = false;
  private active = false;
  private isIntersecting = false;
  private generation = 0;

  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private pipSink: DelayedFrameSink | null = null;

  private queue: DelayedFrame[] = [];
  private currentBitmap: ImageBitmap | null = null;
  private currentDisplayedT = -Infinity;
  private hasClearedCanvas = false;

  private vfcId: number | null = null;
  private rafId: number | null = null;

  private readonly intersectionObserver: IntersectionObserver | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private styleObserver: MutationObserver | null = null;
  private readonly unsubscribeLatency: (() => void) | null = null;

  constructor(video: HTMLVideoElement) {
    this.video = video;
    this.supported =
      typeof video.requestVideoFrameCallback === 'function' &&
      typeof video.cancelVideoFrameCallback === 'function';

    if (!this.supported) return;

    this.intersectionObserver = new IntersectionObserver((entries) => {
      const latest = entries.at(-1);
      if (!latest) return;
      this.isIntersecting = latest.isIntersecting;
      this.update();
    });
    this.intersectionObserver.observe(this.video);

    this.unsubscribeLatency = onAudioLatencyChange(() => {
      this.update();
    });

    this.video.addEventListener(
      'enterpictureinpicture',
      this.onPictureInPictureChange,
    );
    this.video.addEventListener(
      'leavepictureinpicture',
      this.onPictureInPictureChange,
    );

    this.update();
  }

  /**
   * 遅延フレームの出力先シンク（PiP 用）を設定または解除する
   */
  public setPipSink(sink: DelayedFrameSink | null): void {
    this.pipSink = sink;
    this.update();

    if (this.pipSink && this.currentBitmap && !this.hasClearedCanvas) {
      this.pipSink.drawFrame(this.currentBitmap);
    }

    if (this.active) {
      if (this.pipSink) {
        this.drawPlaceholder();
      } else if (this.currentBitmap && !this.hasClearedCanvas) {
        this.drawBitmap(this.currentBitmap);
      } else if (this.ctx && this.canvas) {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      }
    }
  }

  /**
   * 現在の遅延設定と可視状態に応じてオーバーレイの有効・無効を切り替える
   */
  public update(): void {
    if (!this.supported || this.destroyed) return;

    const shouldBeActive =
      getAudioLatencyMs('video') > 0 &&
      document.pictureInPictureElement !== this.video &&
      (this.isIntersecting || this.pipSink !== null);
    if (shouldBeActive && !this.active) {
      this.activate();
    } else if (!shouldBeActive && this.active) {
      this.deactivate();
    }
  }

  /**
   * すべてのコールバック・監視・保持中のフレーム・DOM要素を破棄する
   */
  public destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;

    this.deactivate();

    this.video.removeEventListener(
      'enterpictureinpicture',
      this.onPictureInPictureChange,
    );
    this.video.removeEventListener(
      'leavepictureinpicture',
      this.onPictureInPictureChange,
    );
    this.intersectionObserver?.disconnect();
    this.unsubscribeLatency?.();
  }

  private activate(): void {
    if (this.active || this.destroyed || !this.video.parentElement) return;

    const canvas = document.createElement('canvas');
    canvas.className = 'audio-latency-sync-video';
    canvas.style.position = 'absolute';
    canvas.style.pointerEvents = 'none';

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    this.active = true;
    this.generation++;
    this.currentDisplayedT = -Infinity;
    this.hasClearedCanvas = false;
    this.canvas = canvas;
    this.ctx = ctx;

    // プレイヤーの操作UIや字幕が上に重なるよう、同じ親要素内の video 直後に挿入する
    this.video.after(canvas);
    this.syncCanvasGeometry();
    if (this.pipSink) {
      this.drawPlaceholder();
    }

    this.resizeObserver = new ResizeObserver(() => {
      this.syncCanvasGeometry();
    });
    this.resizeObserver.observe(this.video);

    this.styleObserver = new MutationObserver(() => {
      this.syncCanvasGeometry();
    });
    this.styleObserver.observe(this.video, {
      attributes: true,
      attributeFilter: ['style'],
    });

    this.video.addEventListener('seeking', this.onSeeking);
    this.video.addEventListener('emptied', this.onMediaReset);
    this.video.addEventListener('loadstart', this.onMediaReset);

    this.vfcId = this.video.requestVideoFrameCallback(this.onVideoFrame);
    this.rafId = requestAnimationFrame(this.onAnimationFrame);
  }

  private deactivate(): void {
    this.active = false;
    // 進行中の非同期 createImageBitmap が解決した際に破棄できるよう世代を進める
    this.generation++;

    if (this.vfcId !== null) {
      this.video.cancelVideoFrameCallback(this.vfcId);
      this.vfcId = null;
    }

    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }

    this.resizeObserver?.disconnect();
    this.resizeObserver = null;

    this.styleObserver?.disconnect();
    this.styleObserver = null;

    this.video.removeEventListener('seeking', this.onSeeking);
    this.video.removeEventListener('emptied', this.onMediaReset);
    this.video.removeEventListener('loadstart', this.onMediaReset);

    this.clearQueue();
    this.pipSink?.clear();

    this.currentBitmap?.close();
    this.currentBitmap = null;
    this.currentDisplayedT = -Infinity;
    this.hasClearedCanvas = false;

    this.canvas?.remove();
    this.canvas = null;
    this.ctx = null;
  }

  private syncCanvasGeometry(): void {
    if (!this.canvas) return;

    const cssLeft = this.video.offsetLeft;
    const cssTop = this.video.offsetTop;
    const cssWidth = this.video.offsetWidth;
    const cssHeight = this.video.offsetHeight;

    this.canvas.style.left = `${cssLeft}px`;
    this.canvas.style.top = `${cssTop}px`;
    this.canvas.style.width = `${cssWidth}px`;
    this.canvas.style.height = `${cssHeight}px`;

    const dpr = window.devicePixelRatio || 1;
    let pixelWidth = Math.round(cssWidth * dpr);
    let pixelHeight = Math.round(cssHeight * dpr);

    if (pixelWidth > MAX_CANVAS_WIDTH) {
      const scale = MAX_CANVAS_WIDTH / pixelWidth;
      pixelWidth = MAX_CANVAS_WIDTH;
      pixelHeight = Math.round(pixelHeight * scale);
    }

    if (
      this.canvas.width !== pixelWidth ||
      this.canvas.height !== pixelHeight
    ) {
      this.canvas.width = pixelWidth;
      this.canvas.height = pixelHeight;

      // サイズ再設定により描画内容が消去されるため、PiP 中はプレースホルダー、通常時は表示中のフレームを再描画する
      if (this.pipSink) {
        this.drawPlaceholder();
      } else if (this.currentBitmap && !this.hasClearedCanvas) {
        this.drawBitmap(this.currentBitmap);
      }
    }
  }

  private readonly onVideoFrame = (
    _now: DOMHighResTimeStamp,
    metadata: VideoFrameCallbackMetadata,
  ): void => {
    if (!this.active || this.destroyed) {
      this.vfcId = null;
      return;
    }

    // requestVideoFrameCallback はワンショットのため毎回再登録する
    this.vfcId = this.video.requestVideoFrameCallback(this.onVideoFrame);

    const videoW = this.video.videoWidth;
    const videoH = this.video.videoHeight;
    if (
      videoW <= 0 ||
      videoH <= 0 ||
      this.video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA
    ) {
      return;
    }

    let resizeWidth: number;
    let resizeHeight: number;
    if (this.pipSink) {
      ({ width: resizeWidth, height: resizeHeight } = fitPipSize(
        videoW,
        videoH,
      ));
    } else {
      const canvas = this.canvas;
      if (!canvas) return;
      const canvasW = canvas.width;
      const canvasH = canvas.height;
      if (canvasW <= 0 || canvasH <= 0) return;

      const scale = Math.min(canvasW / videoW, canvasH / videoH);
      resizeWidth = Math.min(canvasW, Math.max(1, Math.round(videoW * scale)));
      resizeHeight = Math.min(canvasH, Math.max(1, Math.round(videoH * scale)));
    }

    const frameTime = metadata.expectedDisplayTime;
    const gen = this.generation;

    // VideoFrame を保持するとハードウェアデコーダが枯渇するため ImageBitmap へ複製する
    createImageBitmap(this.video, {
      resizeWidth,
      resizeHeight,
      resizeQuality: 'medium',
    }).then(
      (bitmap) => {
        if (
          !this.active ||
          this.destroyed ||
          gen !== this.generation ||
          frameTime <= this.currentDisplayedT
        ) {
          bitmap.close();
          return;
        }

        this.insertFrame({ t: frameTime, bitmap });
      },
      () => {
        // デコード不可などで取得に失敗したフレームはスキップする
      },
    );
  };

  private insertFrame(frame: DelayedFrame): void {
    let idx = this.queue.length;
    while (idx > 0 && this.queue[idx - 1].t > frame.t) {
      idx--;
    }
    this.queue.splice(idx, 0, frame);

    while (this.queue.length > MAX_QUEUE_SIZE) {
      const oldest = this.queue.shift();
      oldest?.bitmap.close();
    }
  }

  private readonly onAnimationFrame = (): void => {
    if (!this.active || this.destroyed) {
      this.rafId = null;
      return;
    }

    this.rafId = requestAnimationFrame(this.onAnimationFrame);

    const now = performance.now();
    const latencyMs = getAudioLatencyMs('video');

    let dueIndex = -1;
    for (let i = this.queue.length - 1; i >= 0; i--) {
      if (this.queue[i].t + latencyMs <= now) {
        dueIndex = i;
        break;
      }
    }

    if (dueIndex < 0) return;

    const target = this.queue[dueIndex];
    const consumed = this.queue.splice(0, dueIndex + 1);
    for (let i = 0; i < consumed.length - 1; i++) {
      consumed[i].bitmap.close();
    }

    if (target.bitmap !== this.currentBitmap) {
      if (this.pipSink) {
        this.pipSink.drawFrame(target.bitmap);
      } else {
        this.drawBitmap(target.bitmap);
      }
      this.currentBitmap?.close();
      this.currentBitmap = target.bitmap;
      this.currentDisplayedT = target.t;
      this.hasClearedCanvas = false;
    } else {
      target.bitmap.close();
    }
  };

  private drawBitmap(bitmap: ImageBitmap): void {
    if (!this.ctx || !this.canvas) return;

    const canvasW = this.canvas.width;
    const canvasH = this.canvas.height;
    this.ctx.clearRect(0, 0, canvasW, canvasH);

    if (
      canvasW <= 0 ||
      canvasH <= 0 ||
      bitmap.width <= 0 ||
      bitmap.height <= 0
    ) {
      return;
    }

    const scale = Math.min(canvasW / bitmap.width, canvasH / bitmap.height);
    const drawW = bitmap.width * scale;
    const drawH = bitmap.height * scale;
    const drawX = (canvasW - drawW) / 2;
    const drawY = (canvasH - drawH) / 2;

    this.ctx.drawImage(bitmap, drawX, drawY, drawW, drawH);
  }

  private drawPlaceholder(): void {
    if (!this.ctx || !this.canvas) return;

    const canvasW = this.canvas.width;
    const canvasH = this.canvas.height;
    if (canvasW <= 0 || canvasH <= 0) return;

    this.ctx.fillStyle = '#000000';
    this.ctx.fillRect(0, 0, canvasW, canvasH);

    const dpr = window.devicePixelRatio || 1;
    this.ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
    this.ctx.font = `${Math.round(14 * dpr)}px Roboto, Arial, sans-serif`;
    this.ctx.textAlign = 'center';
    this.ctx.textBaseline = 'middle';
    this.ctx.fillText(
      t('plugins.audio-latency-sync.pip-placeholder'),
      canvasW / 2,
      canvasH / 2,
    );
  }

  private clearQueue(): void {
    for (const entry of this.queue) {
      entry.bitmap.close();
    }
    this.queue.length = 0;
  }

  private readonly onPictureInPictureChange = (): void => {
    this.update();
  };

  private readonly onSeeking = (): void => {
    this.generation++;
    this.currentDisplayedT = -Infinity;
    this.clearQueue();
    this.pipSink?.clear();
  };

  private readonly onMediaReset = (): void => {
    this.generation++;
    this.currentDisplayedT = -Infinity;
    this.clearQueue();
    this.pipSink?.clear();

    if (this.ctx && this.canvas) {
      if (this.pipSink) {
        this.drawPlaceholder();
      } else {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      }
      this.hasClearedCanvas = true;
    }
  };
}
