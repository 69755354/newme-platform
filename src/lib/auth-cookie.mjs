export function parseAuthSessionCookie(cookieHeader, cookieName) {
  const match = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${cookieName}=`));
  if (!match) return null;

  const raw = match.slice(cookieName.length + 1);
  const candidates = [raw];
  try {
    candidates.push(decodeURIComponent(raw));
  } catch {
    // Keep the raw candidate when the cookie is not URI encoded.
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (
        parsed &&
        typeof parsed.access_token === "string" &&
        parsed.access_token.length > 0
      ) {
        return {
          access_token: parsed.access_token,
          expires_at:
            typeof parsed.expires_at === "number" ? parsed.expires_at : undefined,
        };
      }
    } catch {
      // Continue with the next cookie encoding candidate.
    }
  }

  return null;
}
