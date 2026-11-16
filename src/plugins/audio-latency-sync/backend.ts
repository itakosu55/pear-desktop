import { createBackend } from '@/utils';

import type { AudioLatencySyncPluginConfig } from './index';

const CHANNEL_SET_BACKGROUND_THROTTLING =
  'audio-latency-sync:set-background-throttling';

export const backend = createBackend<unknown, AudioLatencySyncPluginConfig>({
  start(ctx) {
    // 二重登録で ipcMain.handle が例外を投げないよう既存ハンドラを先に解除する
    ctx.ipc.removeHandler(CHANNEL_SET_BACKGROUND_THROTTLING);
    ctx.ipc.handle(CHANNEL_SET_BACKGROUND_THROTTLING, (allowed: boolean) => {
      if (!ctx.window.isDestroyed()) {
        ctx.window.webContents.setBackgroundThrottling(Boolean(allowed));
      }
    });
  },
  stop(ctx) {
    ctx.ipc.removeHandler(CHANNEL_SET_BACKGROUND_THROTTLING);
    if (!ctx.window.isDestroyed()) {
      ctx.window.webContents.setBackgroundThrottling(true);
    }
  },
});
