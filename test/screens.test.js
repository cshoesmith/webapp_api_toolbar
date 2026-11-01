import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { buildPlan } from '../src/lib/plan.js';
import { dateStamp, recordingFolder, stepScreens } from '../src/lib/recording-files.js';
import { createScreenTaker } from '../src/lib/screen-taker.js';
import { record } from './helpers.js';

const ninePastFive = new Date(2026, 10, 1, 9, 5, 7);

// Records each picture taken. A test can replace capture to hold one open.
function taker(options = {}) {
  const shots = [];
  const screens = createScreenTaker({
    capture: async () => `shot ${shots.length + 1}`,
    onScreen: (records, data) => shots.push({ records, data }),
    settleMs: 10,
    ...options,
  });
  return { shots, screens };
}

async function until(check) {
  for (let tries = 0; tries < 500 && !check(); tries += 1) await sleep(5);
  assert.ok(check(), 'timed out');
}

test('the stamp sorts by time and is safe in a file name', () => {
  assert.equal(dateStamp(ninePastFive), '2026-11-01_09-05-07');
});

test('a recording folder names the date and the site', () => {
  assert.equal(recordingFolder(ninePastFive, 'shop.example.com'), 'api_toolbar/2026-11-01_09-05-07_shop.example.com');
});

test('a recording folder only uses characters a download path allows', () => {
  const folder = (host) => recordingFolder(ninePastFive, host).replace('api_toolbar/2026-11-01_09-05-07', '');
  assert.equal(folder('localhost:8080'), '_localhost-8080');
  assert.equal(folder('[::1]:8080'), '_1-8080');
  assert.equal(folder('example.com.'), '_example.com');
  assert.equal(folder(''), '');
  assert.equal(folder('..'), '');
});

test('each step gets a screen named after its response file', () => {
  const first = record({ url: 'https://api.test/profile', response: { id: 1 } });
  const second = record({ url: 'https://api.test/orders', response: { id: 2 } });
  const third = record({ url: 'https://api.test/basket', response: { id: 3 } });
  first.screen = 'first picture';
  third.screen = 'third picture';
  assert.deepEqual(stepScreens(buildPlan([first, second, third])), [
    { name: 'screens/01_get_profile.jpg', screen: 'first picture' },
    { name: 'screens/03_get_basket.jpg', screen: 'third picture' },
  ]);
});

test('calls made together share one picture', async () => {
  const { shots, screens } = taker();
  for (const id of [1, 2, 3]) screens.add(id);
  await until(() => shots.length > 0);
  await sleep(30);
  assert.deepEqual(shots, [{ records: [1, 2, 3], data: 'shot 1' }]);
});

test('a page that never goes quiet still gets pictures', async () => {
  const { shots, screens } = taker({ settleMs: 60000, longestWaitMs: 30 });
  const traffic = setInterval(() => screens.add('call'), 5);
  try {
    await until(() => shots.length > 0);
  } finally {
    clearInterval(traffic);
    screens.reset();
  }
});

test('calls that arrive during a capture wait for the next picture', async () => {
  let finish;
  let captures = 0;
  const { shots, screens } = taker({
    capture: () => {
      captures += 1;
      return captures > 1 ? 'second' : new Promise((done) => { finish = done; });
    },
  });
  screens.add(1);
  await until(() => captures === 1);
  screens.add(2);
  await sleep(30);
  assert.equal(captures, 1, 'one capture at a time');
  finish('first');
  await until(() => shots.length === 2);
  assert.deepEqual(shots, [{ records: [1], data: 'first' }, { records: [2], data: 'second' }]);
});

test('a capture that never finishes does not stop later ones', async () => {
  let captures = 0;
  const { shots, screens } = taker({
    timeoutMs: 20,
    capture: () => {
      captures += 1;
      return captures > 1 ? 'worked' : new Promise(() => {});
    },
  });
  screens.add('stuck');
  await until(() => captures === 1);
  await sleep(40);
  screens.add('next');
  await until(() => shots.length > 0);
  assert.deepEqual(shots, [{ records: ['next'], data: 'worked' }]);
});

test('a failed capture leaves the call without a picture', async () => {
  let captures = 0;
  const { shots, screens } = taker({
    capture: async () => {
      captures += 1;
      throw new Error('tab closed');
    },
  });
  screens.add(1);
  await until(() => captures === 1);
  await sleep(20);
  assert.deepEqual(shots, []);
});

test('reset drops calls still waiting for a picture', async () => {
  let captures = 0;
  const { screens } = taker({ capture: async () => { captures += 1; return 'shot'; } });
  screens.add(1);
  screens.reset();
  await sleep(30);
  assert.equal(captures, 0);
});
