export const META_SITE_EXCLUDE_MATCHES = [
  "*://facebook.com/*",
  "*://*.facebook.com/*",
  "*://fbcdn.net/*",
  "*://*.fbcdn.net/*",
  "*://instagram.com/*",
  "*://*.instagram.com/*",
];

export const LOCAL_COMPANION_EXCLUDE_MATCHES = ["http://127.0.0.1/*"];

export const ALWAYS_ON_CONTENT_SCRIPT_EXCLUDE_MATCHES = [
  ...META_SITE_EXCLUDE_MATCHES,
  ...LOCAL_COMPANION_EXCLUDE_MATCHES,
];
