import prompt from 'custom-electron-prompt';

import { t } from '@/i18n';
import promptOptions from '@/providers/prompt-options';
import { createPlugin } from '@/utils';

import {
  clampManualOffsetMs,
  MAX_MANUAL_OFFSET_MS,
  MIN_MANUAL_OFFSET_MS,
} from './constants';
import { renderer } from './renderer';
import style from './style.css?inline';

export interface AudioLatencySyncPluginConfig {
  enabled: boolean;
  mode: 'auto' | 'manual' | 'auto-offset';
  manualOffsetMs: number;
  syncLyrics: boolean;
  syncVisualizer: boolean;
  syncVideo: boolean;
  detectedLatencyMs: number;
}

const defaultConfig: AudioLatencySyncPluginConfig = {
  enabled: false,
  mode: 'auto-offset',
  manualOffsetMs: 0,
  syncLyrics: true,
  syncVisualizer: true,
  syncVideo: true,
  detectedLatencyMs: 0,
};

export default createPlugin({
  name: () => t('plugins.audio-latency-sync.name'),
  description: () => t('plugins.audio-latency-sync.description'),
  restartNeeded: false,
  config: defaultConfig,
  stylesheets: [style],
  menu: async ({ getConfig, setConfig, window }) => {
    const config = await getConfig();
    const modes: AudioLatencySyncPluginConfig['mode'][] = [
      'auto',
      'manual',
      'auto-offset',
    ];

    return [
      {
        label: t('plugins.audio-latency-sync.menu.mode.label'),
        submenu: modes.map((mode) => ({
          label: t(`plugins.audio-latency-sync.menu.mode.submenu.${mode}`),
          type: 'radio',
          checked: config.mode === mode,
          click() {
            setConfig({ mode });
          },
        })),
      },
      {
        label: t('plugins.audio-latency-sync.menu.manual-offset'),
        async click() {
          const latestConfig = await getConfig();
          const response = await prompt(
            {
              title: t('plugins.audio-latency-sync.prompt.manual-offset.title'),
              label: t(
                'plugins.audio-latency-sync.prompt.manual-offset.label',
                {
                  detected: latestConfig.detectedLatencyMs,
                },
              ),
              value: latestConfig.manualOffsetMs,
              type: 'input',
              inputAttrs: {
                type: 'number',
                min: String(MIN_MANUAL_OFFSET_MS),
                max: String(MAX_MANUAL_OFFSET_MS),
                step: '10',
                required: true,
              },
              width: 420,
              ...promptOptions(),
            },
            window,
          ).catch(console.error);

          if (!response || response.trim() === '') return;

          const parsed = Number(response);
          if (!Number.isFinite(parsed)) return;

          setConfig({ manualOffsetMs: clampManualOffsetMs(parsed) });
        },
      },
      {
        label: t('plugins.audio-latency-sync.menu.calibrate'),
        click() {
          window.webContents.send('audio-latency-sync:open-calibration');
        },
      },
      {
        label: t('plugins.audio-latency-sync.menu.sync-lyrics'),
        type: 'checkbox',
        checked: config.syncLyrics,
        click(item) {
          setConfig({ syncLyrics: item.checked });
        },
      },
      {
        label: t('plugins.audio-latency-sync.menu.sync-visualizer'),
        type: 'checkbox',
        checked: config.syncVisualizer,
        click(item) {
          setConfig({ syncVisualizer: item.checked });
        },
      },
      {
        label: t('plugins.audio-latency-sync.menu.sync-video'),
        type: 'checkbox',
        checked: config.syncVideo,
        click(item) {
          setConfig({ syncVideo: item.checked });
        },
      },
    ];
  },

  renderer,
});
