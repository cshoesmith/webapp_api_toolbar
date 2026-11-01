// Records a tab through chrome.debugger. Chrome shows its "started debugging" banner for as long as this is attached.
import { CdpCapture } from '../lib/cdp-capture.js';

const PROTOCOL_VERSION = '1.3';
const NETWORK_OPTIONS = {
  maxTotalBufferSize: 256 * 1024 * 1024,
  maxResourceBufferSize: 16 * 1024 * 1024,
  maxPostDataSize: 2 * 1024 * 1024,
};

export function createTabRecorder({ onEntry, onDetach }) {
  let target = null;

  const send = (method, params) => chrome.debugger.sendCommand(target, method, params);
  const capture = new CdpCapture({
    onEntry,
    getBody: (requestId) => send('Network.getResponseBody', { requestId }),
    getPostData: async (requestId) => (await send('Network.getRequestPostData', { requestId })).postData,
  });

  chrome.debugger.onEvent.addListener((source, method, params) => {
    if (source.tabId === target?.tabId) capture.handle(method, params);
  });
  chrome.debugger.onDetach.addListener((source, reason) => {
    if (source.tabId !== target?.tabId) return;
    target = null;
    capture.reset();
    onDetach(reason);
  });

  return {
    // Resolves with the host being recorded, or rejects if Chrome refuses, as
    // it does for chrome:// pages and the extension store.
    async start(tabId) {
      await chrome.debugger.attach({ tabId }, PROTOCOL_VERSION);
      target = { tabId };
      await send('Network.enable', NETWORK_OPTIONS);
      // Chrome only reports the full headers of calls that reach the network.
      await send('Network.setCacheDisabled', { cacheDisabled: true });
      const info = await send('Target.getTargetInfo').catch(() => null);
      return info?.targetInfo?.url ?? '';
    },

    // JPEG, so a long recording stays small enough to hold in memory.
    async captureScreen() {
      const { data } = await send('Page.captureScreenshot', { format: 'jpeg', quality: 70 });
      return data;
    },

    async stop() {
      if (!target) return;
      const tab = target;
      target = null;
      capture.reset();
      await chrome.debugger.detach(tab).catch(() => {});
    },
  };
}
