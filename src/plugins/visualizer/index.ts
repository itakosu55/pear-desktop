import { t } from '@/i18n';
import {
  getAudioLatencyMs,
  onAudioLatencyChange,
} from '@/plugins/utils/renderer/audio-latency';
import { createPlugin } from '@/utils';

import emptyStyle from './empty-player.css?inline';
import {
  ButterchurnVisualizer as butterchurn,
  VudioVisualizer as vudio,
  WaveVisualizer as wave,
} from './visualizers';
import { type Visualizer } from './visualizers/visualizer';

type WaveColor = {
  gradient: string[];
  rotate?: number;
};

export type VisualizerPluginConfig = {
  enabled: boolean;
  type: 'butterchurn' | 'vudio' | 'wave';
  butterchurn: {
    preset: string;
    blendTimeInSeconds: number;
  };
  vudio: {
    effect: string;
    accuracy: number;
    lighting: {
      maxHeight: number;
      maxSize: number;
      lineWidth: number;
      color: string;
      shadowBlur: number;
      shadowColor: string;
      fadeSide: boolean;
      prettify: boolean;
      horizontalAlign: string;
      verticalAlign: string;
      dottify: boolean;
    };
  };
  wave: {
    animations: {
      type: string;
      config: {
        bottom?: boolean;
        top?: boolean;
        count?: number;
        cubeHeight?: number;
        lineWidth?: number;
        diameter?: number;
        fillColor?: string | WaveColor;
        lineColor?: string | WaveColor;
        radius?: number;
        frequencyBand?: string;
      };
    }[];
  };
};

const MAX_DELAY_SECONDS = 2.0;

type RenderProps = {
  visualizerInstance: Visualizer | null;
  audioContext: AudioContext | null;
  audioSource: MediaElementAudioSourceNode | null;
  delayNode: DelayNode | null;
  gainNode: GainNode | null;
  mediaStreamDest: MediaStreamAudioDestinationNode | null;
  observer: ResizeObserver | null;
  unsubscribeLatency: (() => void) | null;
  audioCanPlayHandler: ((e: CustomEvent<Compressor>) => Promise<void>) | null;
};

const cleanupVisualizer = (state: RenderProps) => {
  state.visualizerInstance?.destroy();
  state.visualizerInstance = null;

  if (state.delayNode) {
    try {
      state.audioSource?.disconnect(state.delayNode);
    } catch {}
    try {
      state.delayNode.disconnect();
    } catch {}
    state.delayNode = null;
  }

  if (state.gainNode) {
    try {
      state.gainNode.disconnect();
    } catch {}
    state.gainNode = null;
  }

  if (state.mediaStreamDest) {
    try {
      state.mediaStreamDest.disconnect();
    } catch {}
    state.mediaStreamDest = null;
  }
};

export default createPlugin({
  name: () => t('plugins.visualizer.name'),
  description: () => t('plugins.visualizer.description'),
  restartNeeded: false,
  config: {
    enabled: false,
    type: 'butterchurn',
    // Config per visualizer
    butterchurn: {
      preset: 'martin [shadow harlequins shape code] - fata morgana',
      blendTimeInSeconds: 2.7,
    },
    vudio: {
      effect: 'lighting',
      accuracy: 128,
      lighting: {
        maxHeight: 160,
        maxSize: 12,
        lineWidth: 1,
        color: '#49f3f7',
        shadowBlur: 2,
        shadowColor: 'rgba(244,244,244,.5)',
        fadeSide: true,
        prettify: false,
        horizontalAlign: 'center',
        verticalAlign: 'middle',
        dottify: true,
      },
    },
    wave: {
      animations: [
        {
          type: 'Cubes',
          config: {
            bottom: true,
            count: 30,
            cubeHeight: 5,
            fillColor: { gradient: ['#FAD961', '#F76B1C'] },
            lineColor: 'rgba(0,0,0,0)',
            radius: 20,
          },
        },
        {
          type: 'Cubes',
          config: {
            top: true,
            count: 12,
            cubeHeight: 5,
            fillColor: { gradient: ['#FAD961', '#F76B1C'] },
            lineColor: 'rgba(0,0,0,0)',
            radius: 10,
          },
        },
        {
          type: 'Circles',
          config: {
            lineColor: {
              gradient: ['#FAD961', '#FAD961', '#F76B1C'],
              rotate: 90,
            },
            lineWidth: 4,
            diameter: 20,
            count: 10,
            frequencyBand: 'base',
          },
        },
      ],
    },
  } as VisualizerPluginConfig,
  stylesheets: [emptyStyle],
  menu: async ({ getConfig, setConfig }) => {
    const config = await getConfig();
    const visualizerTypes = ['butterchurn', 'vudio', 'wave'] as const; // For bundling

    return [
      {
        label: t('plugins.visualizer.menu.visualizer-type'),
        submenu: visualizerTypes.map((visualizerType) => ({
          label: visualizerType,
          type: 'radio',
          checked: config.type === visualizerType,
          click() {
            setConfig({ type: visualizerType });
          },
        })),
      },
    ];
  },

  renderer: {
    props: {
      visualizerInstance: null,
      audioContext: null,
      audioSource: null,
      delayNode: null,
      gainNode: null,
      mediaStreamDest: null,
      observer: null,
      unsubscribeLatency: null,
      audioCanPlayHandler: null,
    } as RenderProps,

    createVisualizer(
      this: { props: RenderProps },
      config: VisualizerPluginConfig,
    ) {
      cleanupVisualizer(this.props);

      if (!this.props.audioContext || !this.props.audioSource) return;
      if (!config.enabled) return;

      const video = document.querySelector('video');
      if (!video) {
        return;
      }

      const visualizerContainer =
        document.querySelector<HTMLElement>('#player');
      if (!visualizerContainer) {
        return;
      }

      let canvas = document.querySelector<HTMLCanvasElement>('#visualizer');
      if (!canvas) {
        canvas = document.createElement('canvas');
        canvas.id = 'visualizer';
        visualizerContainer?.prepend(canvas);
      }

      // 解析用ブランチのみ遅延させ、audioContext.destination には接続しない
      const delayNode = this.props.audioContext.createDelay(MAX_DELAY_SECONDS);
      delayNode.delayTime.value = Math.min(
        MAX_DELAY_SECONDS,
        Math.max(0, getAudioLatencyMs('visualizer') / 1000),
      );

      const gainNode = this.props.audioContext.createGain();
      gainNode.gain.value = 1.25;

      this.props.audioSource.connect(delayNode);
      delayNode.connect(gainNode);
      this.props.delayNode = delayNode;
      this.props.gainNode = gainNode;

      if (config.type === 'wave') {
        this.props.visualizerInstance = new wave(
          this.props.audioContext,
          this.props.audioSource,
          canvas,
          gainNode,
          undefined,
          config,
        );
      } else if (config.type === 'butterchurn') {
        this.props.visualizerInstance = new butterchurn(
          this.props.audioContext,
          this.props.audioSource,
          canvas,
          gainNode,
          undefined,
          config,
        );
      } else {
        const dest = this.props.audioContext.createMediaStreamDestination();
        gainNode.connect(dest);
        this.props.mediaStreamDest = dest;
        this.props.visualizerInstance = new vudio(
          this.props.audioContext,
          this.props.audioSource,
          canvas,
          gainNode,
          dest.stream,
          config,
        );
      }

      const resizeVisualizer = () => {
        if (canvas && visualizerContainer) {
          const { width, height } =
            window.getComputedStyle(visualizerContainer);
          canvas.width = Math.ceil(parseFloat(width));
          canvas.height = Math.ceil(parseFloat(height));
        }
        this.props.visualizerInstance?.resize(canvas.width, canvas.height);
      };
      resizeVisualizer();

      this.props.observer?.disconnect();
      this.props.observer = new ResizeObserver(resizeVisualizer);
      this.props.observer.observe(visualizerContainer);
    },

    onConfigChange(newConfig) {
      this.createVisualizer(newConfig);
    },

    onPlayerApiReady(_, { getConfig }) {
      this.props.unsubscribeLatency?.();
      this.props.unsubscribeLatency = onAudioLatencyChange(() => {
        const { delayNode, audioContext } = this.props;
        if (!delayNode || !audioContext) return;
        const newSeconds = Math.min(
          MAX_DELAY_SECONDS,
          Math.max(0, getAudioLatencyMs('visualizer') / 1000),
        );
        delayNode.delayTime.setTargetAtTime(
          newSeconds,
          audioContext.currentTime,
          0.05,
        );
      });

      if (!this.props.audioCanPlayHandler) {
        this.props.audioCanPlayHandler = async (e) => {
          this.props.audioContext = e.detail.audioContext;
          this.props.audioSource = e.detail.audioSource;
          this.createVisualizer(await getConfig());
        };
        document.addEventListener(
          'peard:audio-can-play',
          this.props.audioCanPlayHandler,
          { passive: true },
        );
      }
    },

    stop() {
      this.props.unsubscribeLatency?.();
      this.props.unsubscribeLatency = null;
      if (this.props.audioCanPlayHandler) {
        document.removeEventListener(
          'peard:audio-can-play',
          this.props.audioCanPlayHandler,
        );
        this.props.audioCanPlayHandler = null;
      }
      this.props.observer?.disconnect();
      this.props.observer = null;
      cleanupVisualizer(this.props);
    },
  },
});
