// S6 (review 4d #1): place the notification panel under the bell but always
// fully inside the viewport. Width shrinks to the viewport minus margins on
// phones (works down to 320 px); on wider screens the panel stays 380 px and
// right-aligned with the bell.
export const NOTIFICATION_PANEL_WIDTH = 380;
const MARGIN = 8;
const GAP = 8;

export function notificationPanelPosition(anchor, viewportWidth) {
  const vw = Number.isFinite(viewportWidth) && viewportWidth > 0 ? viewportWidth : NOTIFICATION_PANEL_WIDTH + 2 * MARGIN;
  const width = Math.max(0, Math.min(NOTIFICATION_PANEL_WIDTH, vw - 2 * MARGIN));
  const right = Number.isFinite(anchor?.right) ? anchor.right : vw - MARGIN;
  const preferredLeft = right - width;
  const left = Math.min(Math.max(preferredLeft, MARGIN), vw - MARGIN - width);
  const top = (Number.isFinite(anchor?.bottom) ? anchor.bottom : 0) + GAP;
  return { left, top, width };
}
