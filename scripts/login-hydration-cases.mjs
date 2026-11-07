// Language states the login page must hydrate cleanly in (used by check-login-hydration.mjs
// and by the node test that guards the case list).
// storage = what localStorage holds before the page loads, cookie = the newme-lang cookie.
export const CASES = [
  { name: "zh session, no cookie (the production failure)", storage: "zh", cookie: null, expect: "zh" },
  { name: "zh session, zh cookie", storage: "zh", cookie: "zh", expect: "zh" },
  { name: "en session, no cookie", storage: "en", cookie: null, expect: "en" },
  { name: "en session, en cookie", storage: "en", cookie: "en", expect: "en" },
  { name: "zh storage, stale en cookie", storage: "zh", cookie: "en", expect: "zh" },
  { name: "en storage, stale zh cookie", storage: "en", cookie: "zh", expect: "en" },
  { name: "nothing stored, no cookie", storage: null, cookie: null, expect: "en" },
];

