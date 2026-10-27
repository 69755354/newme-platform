export declare function shouldRecordActivity(
  key: string,
  windowMs: number,
  now?: number,
): boolean;

export declare function resetActivityThrottle(): void;

export declare function activityThrottleSize(): number;

export declare const ACTIVITY_THROTTLE_SLOTS: number;
