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

export function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

export function isTracker(record) {
  const host = hostOf(record.url);
  return TRACKER_HOSTS.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

export function isApiRequest(record) {
  if (!/^https?:/i.test(record.url)) return false;
  if (record.method === 'OPTIONS') return false;
  if (isTracker(record)) return false;
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
  // Form posts that navigate the page are API calls in all but name.
  return record.resourceType === 'document' && record.method !== 'GET';
}
