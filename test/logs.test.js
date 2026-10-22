// -----------------------------------------------------------------------------
// What the integration writes to `docker logs`: at info, only the lifecycle
// (the start, the data lost and back), never one line per reading; a failure
// that repeats at every cycle is logged once, plus one line when it is over.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureLogs, create, createWorld, cycle } from './helpers/world.js';

const strip = (line) => line.text.replace(/^\[[^\]]+\] /, '');

test('the start is one info line', async (t) => {
  const lines = captureLogs(t, 'info');
  const world = await createWorld();
  t.after(() => world.app.stop());
  assert.deepEqual(lines.map(strip), [
    '[INFO] [irve] Started: 1 km, 0 station(s) listed, 0 station(s) added',
  ]);
});

test('a normal reading cycle writes nothing at info, one line at debug', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  await create(world, 'FRTLSP31555024');
  const lines = captureLogs(t, 'info');
  for (let i = 0; i < 5; i += 1) {
    await cycle(world);
  }
  assert.deepEqual(lines, []);
  const debug = captureLogs(t, 'debug');
  await cycle(world);
  assert.deepEqual(debug.map(strip), ['[DEBUG] [irve] 201 lines read, 25 charge points followed']);
});

test('the live data down at every cycle: one warning, then one line at recovery', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  await create(world, 'FRTLSP31555024');
  const lines = captureLogs(t, 'info');
  world.network.fail.dynamic = new TypeError('fetch failed');
  for (let i = 0; i < 4; i += 1) {
    await cycle(world);
  }
  world.network.fail = {};
  await cycle(world);
  assert.deepEqual(lines.map(strip), [
    '[WARN] [irve] Live data unavailable: proxy.transport.data.gouv.fr: fetch failed',
    '[INFO] [irve] Live data back',
  ]);
});

test('the station list down at start: one warning, then one line at recovery', async (t) => {
  const lines = captureLogs(t, 'info');
  const world = await createWorld({ connect: false });
  t.after(() => world.app.stop());
  world.network.fail.static = 502;
  await world.gladys.connect();
  await world.app.ready;
  await world.service.loading;
  await cycle(world);
  world.network.fail = {};
  await cycle(world);
  assert.deepEqual(lines.map(strip), [
    '[INFO] [irve] Started: 1 km, 0 station(s) listed, 0 station(s) added',
    '[WARN] [irve] Station list unavailable: tabular-api.data.gouv.fr: HTTP 502',
    '[INFO] [irve] Station list back',
  ]);
  assert.equal(world.fake.discoveredDevices.length, 5);
});

test('the station list down from the start: the status still shows the position', async (t) => {
  const world = await createWorld({ connect: false });
  t.after(() => world.app.stop());
  world.network.fail.static = 502;
  await world.gladys.connect();
  await world.app.ready;
  await world.service.loading;
  const ack = await world.fake.action('status', {});
  assert.match(ack.data.message.en, /^■ Around Maison, 1 km\n/);
  assert.match(ack.data.message.en, /Last error: tabular-api\.data\.gouv\.fr: HTTP 502/);
});
