export function classifyRefreshFailure(status, payload) {
  const code = payload && typeof payload.code === "string" ? payload.code : "";
  const message = payload && typeof payload.message === "string" ? payload.message : "";

  if (
    code === "refresh_token_not_found" ||
    code === "invalid_grant" ||
    /invalid refresh token|refresh token not found/i.test(message)
  ) {
    return "invalid_refresh_token";
  }

  return "upstream_error";
}
