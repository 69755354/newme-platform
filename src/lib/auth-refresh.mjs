export function classifyRefreshFailure(status, payload) {
  const values = payload && typeof payload === "object"
    ? [payload.code, payload.error_code, payload.error, payload.message, payload.msg]
        .filter((value) => typeof value === "string")
        .map((value) => value.toLowerCase())
    : [];
  const details = values.join(" ");

  if (
    values.includes("refresh_token_not_found") ||
    values.includes("invalid_grant") ||
    /invalid refresh token|refresh token (?:is )?not valid|refresh token not found/.test(details)
  ) {
    return "invalid_refresh_token";
  }

  return "upstream_error";
}
