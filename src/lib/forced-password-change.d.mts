export declare const FORCED_SESSION_ALLOWED_API_PATHS: ReadonlySet<string>;
export declare const FORCED_SESSION_ALLOWED_PAGE_PATHS: ReadonlySet<string>;
export declare const FORCED_SESSION_REDIRECT_PATH: string;
export declare const FORCED_SESSION_ERROR: "password_change_required";
export declare function isForcedPasswordChange(
  profile: { force_password_change?: boolean | null } | null | undefined,
): boolean;
export declare function isForcedSessionAllowedPath(pathname: string): boolean;
