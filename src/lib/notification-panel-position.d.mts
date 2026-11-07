export declare const NOTIFICATION_PANEL_WIDTH: number;
export declare function notificationPanelPosition(
  anchor: { right?: number; bottom?: number } | null | undefined,
  viewportWidth: number,
): { left: number; top: number; width: number };
