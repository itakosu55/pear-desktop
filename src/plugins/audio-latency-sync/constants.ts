export const MIN_MANUAL_OFFSET_MS = -1000;
export const MAX_MANUAL_OFFSET_MS = 2000;

/**
 * 手動オフセット値（ms）を許容範囲内に丸めてクランプする
 */
export const clampManualOffsetMs = (value: number): number =>
  Math.min(
    MAX_MANUAL_OFFSET_MS,
    Math.max(MIN_MANUAL_OFFSET_MS, Math.round(value)),
  );
