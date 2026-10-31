// Turns Chrome DevTools Protocol network events into HAR entries, the format the
// rest of the app reads, including when a HAR file is imported.
//
// Chrome reports the headers it really sent, including Cookie and Set-Cookie, in
// separate "ExtraInfo" events that can arrive before or after the main event, and
// a redirect reuses one requestId for several hops. So events are collected per
// request, and each hop is released once its details have arrived.

const EXTRA_INFO_WAIT_MS = 250;

function headerList(headers = {}) {
  return Object.entries(headers).map(([name, value]) => ({ name, value: String(value) }));
}

function findHeader(headers, wanted) {
  const match = headers.find(({ name }) => name.toLowerCase() === wanted);
  return match?.value ?? '';
}

export class CdpCapture {
  constructor({ onEntry, getBody, getPostData }) {
    this.onEntry = onEntry;
    this.getBody = getBody;
    this.getPostData = getPostData;
    this.flows = new Map();
  }

  handle(method, params) {
    switch (method) {
      case 'Network.requestWillBeSent': this.onRequest(params); break;
      case 'Network.requestWillBeSentExtraInfo': this.addExtra(params, 'requestExtra'); break;
      case 'Network.responseReceivedExtraInfo': this.addExtra(params, 'responseExtra'); break;
      case 'Network.responseReceived': this.onResponse(params); break;
      case 'Network.loadingFinished': this.onFinished(params); break;
      case 'Network.loadingFailed': this.onFailed(params); break;
      default: break;
    }
  }

  // Drops requests still in flight, ready for the next recording.
  reset() {
    for (const flow of this.flows.values()) {
      for (const hop of flow.hops) clearTimeout(hop.timer);
    }
    this.flows.clear();
  }

  flowFor(requestId) {
    if (!this.flows.has(requestId)) {
      this.flows.set(requestId, { hops: [], spare: { requestExtra: [], responseExtra: [] } });
    }
    return this.flows.get(requestId);
  }

  onRequest(params) {
    const flow = this.flowFor(params.requestId);
    const previous = flow.hops.at(-1);
    if (params.redirectResponse && previous) {
      previous.response = params.redirectResponse;
      previous.expectExtra = params.redirectHasExtraInfo;
      previous.endTime = params.timestamp;
      this.complete(previous);
    }
    flow.hops.push({
      params,
      requestExtra: flow.spare.requestExtra.shift() ?? null,
      responseExtra: flow.spare.responseExtra.shift() ?? null,
      hasBody: false,
    });
  }

  addExtra(params, field) {
    const flow = this.flowFor(params.requestId);
    const hop = flow.hops.find((item) => !item[field]);
    if (!hop) {
      flow.spare[field].push(params);
      return;
    }
    hop[field] = params;
    if (hop.waiting && field === 'responseExtra') {
      clearTimeout(hop.timer);
      this.release(hop);
    }
  }

  currentHop(requestId) {
    return this.flows.get(requestId)?.hops.at(-1) ?? null;
  }

  onResponse({ requestId, response, hasExtraInfo, type }) {
    const hop = this.currentHop(requestId);
    if (!hop) return;
    hop.response = response;
    hop.expectExtra = hasExtraInfo;
    hop.type = type;
  }

  onFinished({ requestId, timestamp, encodedDataLength }) {
    const hop = this.currentHop(requestId);
    if (!hop) return;
    hop.endTime = timestamp;
    hop.size = encodedDataLength;
    hop.hasBody = true;
    hop.last = true;
    this.complete(hop);
  }

  onFailed({ requestId, timestamp, errorText, type }) {
    const hop = this.currentHop(requestId);
    if (!hop) return;
    hop.endTime = timestamp;
    hop.failed = errorText;
    hop.type ??= type;
    hop.expectExtra = false;
    hop.last = true;
    this.complete(hop);
  }

  complete(hop) {
    if (hop.expectExtra && !hop.responseExtra) {
      hop.waiting = true;
      hop.timer = setTimeout(() => this.release(hop), EXTRA_INFO_WAIT_MS);
    } else {
      this.release(hop);
    }
  }

  async release(hop) {
    if (hop.released) return;
    hop.released = true;
    hop.waiting = false;
    const { requestId, request } = hop.params;
    if (hop.last) this.flows.delete(requestId);
    if (!/^https?:/i.test(request.url)) return;
    let postData = request.postData ?? null;
    if (postData === null && request.hasPostData) {
      postData = await this.getPostData(requestId).catch(() => null);
    }
    this.onEntry(this.toEntry(hop, postData));
  }

  toEntry(hop, postData) {
    const { requestId, request, wallTime, timestamp, type, documentURL } = hop.params;
    const { response } = hop;
    const headers = headerList(hop.requestExtra?.headers ?? request.headers);
    const entry = {
      _resourceType: String(hop.type ?? type ?? 'other').toLowerCase(),
      _documentUrl: documentURL,
      startedDateTime: new Date(wallTime * 1000).toISOString(),
      time: Math.max(0, ((hop.endTime ?? timestamp) - timestamp) * 1000),
      timings: { wait: response?.timing?.receiveHeadersEnd ?? 0 },
      request: { method: request.method, url: request.url, headers },
      response: {
        status: hop.responseExtra?.statusCode ?? response?.status ?? 0,
        statusText: hop.failed ?? response?.statusText ?? '',
        headers: headerList(hop.responseExtra?.headers ?? response?.headers),
        content: { mimeType: response?.mimeType ?? '', size: hop.size ?? 0 },
      },
    };
    if (postData !== null) {
      entry.request.postData = { mimeType: findHeader(headers, 'content-type'), text: postData };
    }
    if (hop.hasBody) {
      entry.getContent = (done) => {
        this.getBody(requestId).then(
          ({ body, base64Encoded }) => done(body, base64Encoded ? 'base64' : undefined),
          () => done(null),
        );
      };
    }
    return entry;
  }
}
