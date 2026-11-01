// Takes one picture of the page once a burst of calls settles, so a page that
// makes twenty calls at once costs one picture and each call still gets it.
const SETTLE_MS = 600;
const LONGEST_WAIT_MS = 2500;
const CAPTURE_TIMEOUT_MS = 3000;

export function createScreenTaker({
  capture,
  onScreen,
  settleMs = SETTLE_MS,
  longestWaitMs = LONGEST_WAIT_MS,
  timeoutMs = CAPTURE_TIMEOUT_MS,
}) {
  let waiting = [];
  let timer = null;
  let deadline = 0;
  let busy = false;

  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(take, Math.max(0, Math.min(settleMs, deadline - Date.now())));
  };

  // Captures run one at a time, so one that never finishes can't hold up the rest.
  const captureInTime = () => Promise.race([
    capture(),
    new Promise((_, fail) => { setTimeout(fail, timeoutMs); }),
  ]);

  async function take() {
    const records = waiting;
    waiting = [];
    busy = true;
    const data = await captureInTime().catch(() => null);
    busy = false;
    if (data) onScreen(records, data);
    if (waiting.length) schedule();
  }

  return {
    add(record) {
      if (!waiting.length) deadline = Date.now() + longestWaitMs;
      waiting.push(record);
      if (!busy) schedule();
    },

    reset() {
      clearTimeout(timer);
      waiting = [];
    },
  };
}
