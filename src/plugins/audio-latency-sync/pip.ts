import {
  getAudioLatencyMs,
  onAudioLatencyChange,
} from '@/plugins/utils/renderer/audio-latency';

import {
  fitPipSize,
  type DelayedFrameSink,
  type VideoDelayRenderer,
} from './video-delay';

const METADATA_TIMEOUT_MS = 1000;

const originalRequest = Object.getOwnPropertyDescriptor(
  HTMLVideoElement.prototype,
  'requestPictureInPicture',
)?.value as (this: HTMLVideoElement) => Promise<PictureInPictureWindow>;

interface ProxySession {
  container: HTMLDivElement;
  proxy: HTMLVideoElement;
  track: CanvasCaptureMediaStreamTrack;
  pipWindow: PictureInPictureWindow | null;
  pauseTimer: ReturnType<typeof setTimeout> | null;
  metadataTimer: ReturnType<typeof setTimeout> | null;
  backgroundThrottlingDisabled: boolean;
  ignoreProxyPlay: number;
  ignoreProxyPause: number;
  cleanupListeners: () => void;
}

/**
 * 動画遅延の適用中にネイティブ PiP へ遅延済み映像を流すためのプロキシ PiP 制御クラス
 */
export class DelayedPictureInPicture {
  private readonly video: HTMLVideoElement;
  private readonly renderer: VideoDelayRenderer;
  private readonly setBackgroundThrottling: (allowed: boolean) => void;
  private readonly unsubscribeLatency: () => void;

  private destroyed = false;
  private session: ProxySession | null = null;
  private startingPromise: Promise<PictureInPictureWindow> | null = null;

  constructor(
    video: HTMLVideoElement,
    renderer: VideoDelayRenderer,
    setBackgroundThrottling: (allowed: boolean) => void,
  ) {
    this.video = video;
    this.renderer = renderer;
    this.setBackgroundThrottling = setBackgroundThrottling;

    // この video 要素にのみ自前プロパティで上書きし、他要素やプロトタイプへ影響させない
    this.video.requestPictureInPicture = this.request;
    this.video.addEventListener('enterpictureinpicture', this.onVideoEnterPiP);
    this.unsubscribeLatency = onAudioLatencyChange(this.onLatencyChange);
  }

  /**
   * 遅延が有効ならプロキシ動画で PiP を開始し、失敗や無効時はネイティブ実装へフォールバックする
   */
  private readonly request = async (): Promise<PictureInPictureWindow> => {
    if (
      this.destroyed ||
      getAudioLatencyMs('video') <= 0 ||
      this.video.videoWidth <= 0 ||
      this.video.videoHeight <= 0 ||
      typeof HTMLCanvasElement.prototype.captureStream !== 'function'
    ) {
      return originalRequest.call(this.video);
    }

    if (
      this.session?.pipWindow &&
      document.pictureInPictureElement === this.session.proxy
    ) {
      return this.session.pipWindow;
    }

    try {
      if (this.startingPromise) {
        return await this.startingPromise;
      }
      return await this.startProxy();
    } catch {
      this.teardownProxy();
      return originalRequest.call(this.video);
    }
  };

  private startProxy(): Promise<PictureInPictureWindow> {
    if (this.session) {
      this.teardownProxy();
    }

    const run = async (): Promise<PictureInPictureWindow> => {
      const container = document.createElement('div');
      container.setAttribute('aria-hidden', 'true');
      container.style.cssText =
        'position:fixed;left:0;top:0;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none;z-index:-1;';

      const canvas = document.createElement('canvas');
      const { width: initW, height: initH } = fitPipSize(
        this.video.videoWidth,
        this.video.videoHeight,
      );
      canvas.width = initW;
      canvas.height = initH;

      const ctx = canvas.getContext('2d');
      if (!ctx) {
        throw new Error('Failed to get 2D context for PiP canvas');
      }

      if (
        this.video.paused &&
        this.video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
      ) {
        ctx.drawImage(this.video, 0, 0, canvas.width, canvas.height);
      } else {
        ctx.fillStyle = '#000000';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }

      const stream = canvas.captureStream(0);
      const track = stream.getVideoTracks()[0] as
        | CanvasCaptureMediaStreamTrack
        | undefined;
      if (!track) {
        throw new Error('Failed to capture video track from PiP canvas');
      }
      track.requestFrame();

      const proxy = document.createElement('video');
      proxy.muted = true;
      proxy.playsInline = true;
      proxy.srcObject = stream;

      container.append(canvas, proxy);
      document.body.append(container);

      const session: ProxySession = {
        container,
        proxy,
        track,
        pipWindow: null,
        pauseTimer: null,
        metadataTimer: null,
        backgroundThrottlingDisabled: false,
        ignoreProxyPlay: 0,
        ignoreProxyPause: 0,
        cleanupListeners: () => {},
      };
      this.session = session;

      await proxy.play();
      if (this.destroyed || this.session !== session) {
        throw new Error('Proxy PiP session aborted');
      }

      if (proxy.readyState < HTMLMediaElement.HAVE_METADATA) {
        await new Promise<void>((resolve, reject) => {
          const onLoadedMetadata = () => {
            if (session.metadataTimer !== null) {
              clearTimeout(session.metadataTimer);
              session.metadataTimer = null;
            }
            resolve();
          };
          session.metadataTimer = setTimeout(() => {
            session.metadataTimer = null;
            proxy.removeEventListener('loadedmetadata', onLoadedMetadata);
            reject(new Error('Timed out waiting for proxy video metadata'));
          }, METADATA_TIMEOUT_MS);
          proxy.addEventListener('loadedmetadata', onLoadedMetadata, {
            once: true,
          });
        });
      }

      if (this.destroyed || this.session !== session) {
        throw new Error('Proxy PiP session aborted');
      }

      const sink: DelayedFrameSink = {
        drawFrame: (bitmap) => {
          if (
            canvas.width !== bitmap.width ||
            canvas.height !== bitmap.height
          ) {
            canvas.width = bitmap.width;
            canvas.height = bitmap.height;
          }
          ctx.drawImage(bitmap, 0, 0);
          track.requestFrame();
        },
        clear: () => {
          ctx.fillStyle = '#000000';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          track.requestFrame();
        },
      };
      this.renderer.setPipSink(sink);

      const pipWindow = await originalRequest.call(proxy);
      if (this.destroyed || this.session !== session) {
        if (document.pictureInPictureElement === proxy) {
          originalRequest
            .call(this.video)
            .catch(() => document.exitPictureInPicture().catch(() => {}));
        }
        throw new Error('Proxy PiP session aborted');
      }

      session.pipWindow = pipWindow;
      // 最小化や背面化で rAF / rVFC やデコードが止まると PiP 映像が凍結するため抑制を解除する
      this.setBackgroundThrottling(false);
      session.backgroundThrottlingDisabled = true;

      const onProxyLeavePiP = () => {
        if (this.session === session) {
          this.teardownProxy();
        }
      };

      const onVideoPlay = () => {
        if (session.pauseTimer !== null) {
          clearTimeout(session.pauseTimer);
          session.pauseTimer = null;
        }
        if (proxy.paused) {
          session.ignoreProxyPlay++;
          proxy.play().catch(() => {});
        }
      };

      const onVideoPause = () => {
        if (session.pauseTimer !== null) {
          clearTimeout(session.pauseTimer);
        }
        // 遅延分の残りフレームを PiP 側へ出し切ってから一時停止させる
        session.pauseTimer = setTimeout(() => {
          session.pauseTimer = null;
          if (!proxy.paused) {
            session.ignoreProxyPause++;
            proxy.pause();
          }
        }, getAudioLatencyMs('video'));
      };

      const onProxyPlay = () => {
        if (session.ignoreProxyPlay > 0) {
          session.ignoreProxyPlay--;
          return;
        }
        if (this.video.paused) {
          this.video.play().catch(() => {});
        }
      };

      const onProxyPause = () => {
        if (session.ignoreProxyPause > 0) {
          session.ignoreProxyPause--;
          return;
        }
        if (!this.video.paused) {
          this.video.pause();
        }
      };

      proxy.addEventListener('leavepictureinpicture', onProxyLeavePiP);
      this.video.addEventListener('play', onVideoPlay);
      this.video.addEventListener('pause', onVideoPause);
      proxy.addEventListener('play', onProxyPlay);
      proxy.addEventListener('pause', onProxyPause);

      session.cleanupListeners = () => {
        proxy.removeEventListener('leavepictureinpicture', onProxyLeavePiP);
        this.video.removeEventListener('play', onVideoPlay);
        this.video.removeEventListener('pause', onVideoPause);
        proxy.removeEventListener('play', onProxyPlay);
        proxy.removeEventListener('pause', onProxyPause);
      };

      if (this.video.paused && !proxy.paused) {
        session.ignoreProxyPause++;
        proxy.pause();
      }

      return pipWindow;
    };

    const promise = run().finally(() => {
      if (this.startingPromise === promise) {
        this.startingPromise = null;
      }
    });
    this.startingPromise = promise;
    return promise;
  }

  private swapToNative(): void {
    // 既存の PiP ウィンドウがあるためユーザー操作なしでも切り替えが許可される
    originalRequest.call(this.video).catch(() => {});
  }

  private swapToProxy(): void {
    if (
      this.destroyed ||
      this.session ||
      this.startingPromise ||
      getAudioLatencyMs('video') <= 0 ||
      this.video.videoWidth <= 0 ||
      this.video.videoHeight <= 0 ||
      typeof HTMLCanvasElement.prototype.captureStream !== 'function'
    ) {
      return;
    }

    this.startProxy().catch(() => {
      this.teardownProxy();
    });
  }

  private readonly onLatencyChange = (): void => {
    if (this.destroyed) return;

    const latencyMs = getAudioLatencyMs('video');
    if (
      this.session &&
      document.pictureInPictureElement === this.session.proxy &&
      latencyMs <= 0
    ) {
      this.swapToNative();
    } else if (
      document.pictureInPictureElement === this.video &&
      latencyMs > 0
    ) {
      this.swapToProxy();
    }
  };

  private readonly onVideoEnterPiP = (): void => {
    if (this.destroyed) return;
    if (getAudioLatencyMs('video') > 0 && this.video.videoWidth > 0) {
      this.swapToProxy();
    }
  };

  private teardownProxy(): void {
    const session = this.session;
    if (!session) return;
    this.session = null;

    this.renderer.setPipSink(null);
    session.cleanupListeners();

    if (session.pauseTimer !== null) {
      clearTimeout(session.pauseTimer);
      session.pauseTimer = null;
    }
    if (session.metadataTimer !== null) {
      clearTimeout(session.metadataTimer);
      session.metadataTimer = null;
    }

    session.track.stop();
    session.proxy.pause();
    session.proxy.srcObject = null;
    session.container.remove();

    if (session.backgroundThrottlingDisabled) {
      session.backgroundThrottlingDisabled = false;
      this.setBackgroundThrottling(true);
    }
  }

  /**
   * オーバーライドとリスナーを解除し、プロキシ PiP 中ならネイティブ PiP へ戻してから破棄する
   */
  public destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;

    try {
      this.unsubscribeLatency();
      this.video.removeEventListener(
        'enterpictureinpicture',
        this.onVideoEnterPiP,
      );

      const descriptor = Object.getOwnPropertyDescriptor(
        this.video,
        'requestPictureInPicture',
      );
      if (descriptor?.value === this.request) {
        Reflect.deleteProperty(this.video, 'requestPictureInPicture');
      }

      const session = this.session;
      if (session && document.pictureInPictureElement === session.proxy) {
        // プラグイン無効化時も PiP ウィンドウを開いたまま維持するため実動画へ戻す
        originalRequest.call(this.video).then(
          () => {
            this.teardownProxy();
          },
          () => {
            document
              .exitPictureInPicture()
              .catch(() => {})
              .finally(() => {
                this.teardownProxy();
              });
          },
        );
      } else {
        this.teardownProxy();
      }
    } catch {
      this.teardownProxy();
    }
  }
}
