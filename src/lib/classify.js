// Decides which recorded requests are API traffic rather than page furniture.

const API_MIME = /json|xml|graphql|protobuf|grpc|msgpack|event-stream|csv/i;
const STATIC_TYPE = /^(image|media|font|stylesheet|script|manifest|texttrack|ping|cspviolationreport|preflight)$/i;
const STATIC_PATH = /\.(js|mjs|css|map|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|eot|mp4|webm|mp3|wasm)$/i;

const TRACKER_HOSTS = [
  'google-analytics.com',
  'analytics.google.com',
  'googletagmanager.com',
  'doubleclick.net',
  'googlesyndication.com',
  'facebook.net',
  'connect.facebook.com',
  'segment.io',
  'segment.com',
  'sentry.io',
  'hotjar.com',
  'mixpanel.com',
  'amplitude.com',
  'datadoghq.com',
  'browser-intake-datadoghq.com',
  'newrelic.com',
  'nr-data.net',
  'fullstory.com',
  'clarity.ms',
  'intercom.io',
];

// Bot checks. A script cannot pass these, so they are never part of the API.
const CHALLENGE_HOSTS = [
  'recaptcha.net',
  'hcaptcha.com',
  'arkoselabs.com',
  'funcaptcha.com',
  'challenges.cloudflare.com',
];
const CHALLENGE_PATH = /\/recaptcha\//i;

export function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

function hostMatches(url, domains) {
  const host = hostOf(url);
  return domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

export function isTracker(record) {
  return hostMatches(record.url, TRACKER_HOSTS);
}

export function isChallenge(record) {
  return hostMatches(record.url, CHALLENGE_HOSTS) || CHALLENGE_PATH.test(record.url);
}

function siteOf(url) {
  return hostOf(url).split(':')[0].split('.').slice(-2).join('.');
}

export function sameSite(first, second) {
  return siteOf(first) === siteOf(second);
}

// A call to a different site from the page that made it, which on most sites
// means ads and analytics rather than the site's own data.
export function isThirdParty(record) {
  return Boolean(record.documentUrl) && !sameSite(record.url, record.documentUrl);
}

export function isApiRequest(record) {
  if (!/^https?:/i.test(record.url)) return false;
  if (record.method === 'OPTIONS') return false;
  if (isTracker(record) || isChallenge(record)) return false;
  if (record.resourceType === 'websocket') return false;
  if (STATIC_TYPE.test(record.resourceType)) return false;
  let path = '';
  try {
    path = new URL(record.url).pathname;
  } catch {
    return false;
  }
  if (STATIC_PATH.test(path)) return false;
  if (record.resourceType === 'xhr' || record.resourceType === 'fetch') return true;
  if (API_MIME.test(record.mimeType)) return true;
  // Many sites send their data as pages, so a page counts as a call too.
  return record.resourceType === 'document';
}
