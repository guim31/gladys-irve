// -----------------------------------------------------------------------------
// The integration end to end, on the real data of 2026-10-22 (see
// test/helpers/world.js): discovery around the house, states, filters,
// triggers, scene action, widget, configuration actions, failures.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { STALE_MS } from '../src/service.js';
import {
  HOUSE,
  action,
  create,
  createFetch,
  createWorld,
  cycle,
  discovered,
  featureId,
  setPoints,
} from './helpers/world.js';

const stationOf = (device) => device.params.find((p) => p.name === 'station_id').value;

/** The last state published on a feature of a device. */
function lastState(world, device, key) {
  const id = featureId(device, key);
  return world.fake.states.findLast((s) => s.device_feature_external_id === id)?.state;
}

const widget = async (world, settings = {}, language = 'fr') => {
  const ack = await world.fake.widgetGet('stations', { settings, language });
  assert.equal(ack.success, true, ack.error);
  return ack.data.content;
};

// Avenue du Cimetière, 1.2 km from the house: 2 points of 22 kW (Type 2 + E/F)
// and 2 points of 180 kW (CCS); one of each is occupied.
const CIMETIERE = 'FRTLSP31555050';
// Place du Capitole, at the house: an operator without dynamic data.
const CAPITOLE = 'FRPKGP31555001';

test('discovery: the stations of the circle with live data, nearest first', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  const ids = world.fake.discoveredDevices.map(stationOf);
  assert.deepEqual(ids, [
    'FRTLSP31555040A1',
    'FRTLSP31555040A2',
    'FRTLSP31555024',
    'FRTLSP31555019',
    'FRTLSP31555044',
  ]);
  // The car park under the Capitole publishes no live data: not offered.
  assert.ok(world.service.stations.has(CAPITOLE));
  assert.equal(discovered(world, CAPITOLE), undefined);
  const device = discovered(world, 'FRTLSP31555024');
  assert.equal(device.name, "TOULOUSE - 9 Boulevard d'Arcole");
  assert.equal(device.should_poll, false);
  assert.ok(device.external_id.endsWith(':station:FRTLSP31555024'));
});

test('the radius widens the discovery, MAX_DISCOVERED at most', async (t) => {
  const world = await createWorld({ config: { radius_km: '2' } });
  t.after(() => world.app.stop());
  assert.equal(world.fake.discoveredDevices.length, 24);
  const big = await createWorld({ config: { radius_km: '5' } });
  t.after(() => big.app.stop());
  assert.equal(big.fake.discoveredDevices.length, 30);
});

test('the states of an added station: counts, power and age of the newest state', async (t) => {
  const world = await createWorld({ config: { radius_km: '2' } });
  t.after(() => world.app.stop());
  const device = await create(world, CIMETIERE);
  assert.equal(lastState(world, device, 'free'), 2);
  assert.equal(lastState(world, device, 'total'), 4);
  assert.equal(lastState(world, device, 'out_of_service'), 0);
  assert.equal(lastState(world, device, 'max_power'), 180);
  // Newest state 15:56:59 UTC, read at 15:59:49.
  assert.equal(lastState(world, device, 'age'), 2);
  assert.deepEqual(world.fake.widgetRefreshes, ['stations']);
});

test('a charge point state older than a week is ignored', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  // Lazare Carnot two-wheelers: 3 points, one "libre" since 2026-09-19.
  const reading = world.service.readings.get('FRTLSP31555040A1');
  assert.deepEqual([reading.total, reading.live, reading.free], [3, 2, 2]);
});

test('filters: minimum power and connector count only the matching points', async (t) => {
  const fast = await createWorld({ config: { radius_km: '2', min_power: '50' } });
  t.after(() => fast.app.stop());
  const reading = fast.service.readings.get(CIMETIERE);
  assert.deepEqual([reading.total, reading.free, reading.maxPower], [2, 1, 180]);
  // No 50 kW point in most stations of the city: fewer stations offered.
  assert.ok(fast.fake.discoveredDevices.length < 24);
  assert.ok(fast.fake.discoveredDevices.map(stationOf).includes(CIMETIERE));

  const chademo = await createWorld({ config: { radius_km: '2', connector: 'chademo' } });
  t.after(() => chademo.app.stop());
  assert.equal(chademo.service.readings.get(CIMETIERE).total, 0);
  assert.ok(!chademo.fake.discoveredDevices.map(stationOf).includes(CIMETIERE));
});

test('a listed station without live data is offered, and says so', async (t) => {
  const world = await createWorld({ config: { radius_km: '1', stations: CAPITOLE } });
  t.after(() => world.app.stop());
  const device = await create(world, CAPITOLE);
  assert.equal(lastState(world, device, 'total'), 47);
  assert.equal(lastState(world, device, 'free'), undefined);
  assert.equal(lastState(world, device, 'age'), undefined);
  const content = await widget(world);
  assert.deepEqual(content.components[0].items, [
    { label: 'Capitole', value: 'pas de données en direct', color: 'neutral' },
  ]);
});

test('a station listed far from the position is read by its id', async (t) => {
  const world = await createWorld({
    config: { position: '48.8566, 2.3522', radius_km: '1', stations: `${CIMETIERE}, nope` },
  });
  t.after(() => world.app.stop());
  assert.deepEqual(world.fake.discoveredDevices.map(stationOf), [CIMETIERE]);
  assert.ok(world.network.calls.some((c) => c.url.includes('id_station_itinerance__in=')));
  // 588 km from Paris.
  assert.equal(Math.round(world.service.distance(world.service.stations.get(CIMETIERE))), 588);
});

test('a station added and later out of the circle keeps being read', async (t) => {
  const first = await createWorld({ config: { radius_km: '2' } });
  const device = await create(first, CIMETIERE);
  await first.app.stop();
  const world = await createWorld({
    config: { radius_km: '1' },
    devices: [{ ...device, params: device.params }],
  });
  t.after(() => world.app.stop());
  assert.ok(world.fake.discoveredDevices.map(stationOf).includes(CIMETIERE));
  assert.equal(lastState(world, device, 'free'), 2);
});

test('triggers: a point freed, the station full, the station out of service', async (t) => {
  const world = await createWorld({ config: { radius_km: '2' } });
  t.after(() => world.app.stop());
  const device = await create(world, CIMETIERE);
  const points = ['FRTLSE315550501', 'FRTLSE315550502', 'FRTLSE315550503', 'FRTLSE315550504'];
  const at = (offset) =>
    new Date(world.clock.now() + offset).toISOString().replace('T', ' ').replace('Z', '+00:00');

  // Everything taken.
  setPoints(world, points, { occupation_pdc: 'occupe', horodatage: at(0) });
  await cycle(world);
  assert.deepEqual(
    world.fake.sceneEvents.map((e) => e.key),
    ['station_full'],
  );
  assert.equal(lastState(world, device, 'free'), 0);

  // One freed: point_freed, after full.
  setPoints(world, [points[3]], { occupation_pdc: 'libre', horodatage: at(600000) });
  await cycle(world);
  const freed = world.fake.sceneEvents.at(-1);
  assert.equal(freed.key, 'point_freed');
  assert.deepEqual(freed.data, {
    station: device.external_id,
    station_name: 'TOULOUSE - Avenue du Cimetière',
    address: 'Avenue du Cimetière, 31500 TOULOUSE',
    free: 1,
    total: 4,
    out_of_service: 0,
    max_power: 180,
    distance_km: 1.2,
    was_full: '1',
  });

  // All out of service.
  setPoints(world, points, { etat_pdc: 'hors_service', horodatage: at(1200000) });
  await cycle(world);
  assert.equal(world.fake.sceneEvents.at(-1).key, 'station_out_of_service');
  assert.equal(lastState(world, device, 'out_of_service'), 4);
  const content = await widget(world);
  assert.deepEqual(content.components[0].items, [
    { label: 'TOULOUSE - Avenue du Cimetière', value: 'hors service', color: 'danger' },
  ]);
  assert.equal(world.fake.sceneEvents.length, 3);
});

test('no trigger for a station not added, nor after a long outage', async (t) => {
  const world = await createWorld({ config: { radius_km: '2' } });
  t.after(() => world.app.stop());
  setPoints(world, ['FRTLSE315550242'], { occupation_pdc: 'occupe' });
  await cycle(world);
  assert.equal(world.fake.sceneEvents.length, 0);

  await create(world, CIMETIERE);
  world.network.fail.dynamic = 503;
  await cycle(world);
  await cycle(world);
  await cycle(world);
  world.network.fail = {};
  setPoints(world, ['FRTLSE315550502'], { occupation_pdc: 'libre' });
  await cycle(world);
  assert.equal(world.fake.sceneEvents.length, 0);
});

test('a station out of date: grey, never chosen, no trigger', async (t) => {
  const world = await createWorld({ config: { radius_km: '2' } });
  t.after(() => world.app.stop());
  const device = await create(world, CIMETIERE);
  world.clock.advance(STALE_MS);
  await world.service.refresh();
  const content = await widget(world);
  assert.deepEqual(content.components[0].items[0].value, 'donnée périmée');
  assert.equal(content.components[0].items[0].color, 'neutral');
  const ack = await world.fake.sceneAction('find_free', {});
  assert.equal(ack.data.outputs.found, 0);
  assert.ok(lastState(world, device, 'age') >= 48 * 60);
});

test('scene action: the nearest followed station with a free point', async (t) => {
  const world = await createWorld({ config: { radius_km: '2' } });
  t.after(() => world.app.stop());
  const far = await create(world, CIMETIERE);
  const near = await create(world, 'FRTLSP31555024');
  let ack = await world.fake.sceneAction('find_free', {});
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(ack.data.outputs, {
    found: 1,
    sentence:
      "TOULOUSE - 9 Boulevard d'Arcole : 2 points de charge libres sur 4, jusqu'à 22,1 kW, à 0,7 km.",
    station_name: "TOULOUSE - 9 Boulevard d'Arcole",
    address: "9 Boulevard d'Arcole, 31000 TOULOUSE",
    free: 2,
    total: 4,
    max_power: 22.1,
    distance_km: 0.7,
  });
  // The nearest one full: the next one.
  setPoints(world, ['FRTLSE315550242', 'FRTLSE315550244'], { occupation_pdc: 'occupe' });
  await cycle(world);
  ack = await world.fake.sceneAction('find_free', {
    stations: [near.external_id, far.external_id],
  });
  assert.equal(ack.data.outputs.station_name, 'TOULOUSE - Avenue du Cimetière');
  // A station no longer followed.
  ack = await world.fake.sceneAction('find_free', { stations: ['gone'] });
  assert.equal(ack.success, false);
  assert.equal(ack.error, "Cette station n'est plus suivie.");
});

test('scene action without any station followed', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  const ack = await world.fake.sceneAction('find_free', {});
  assert.equal(ack.success, false);
  assert.match(ack.error, /Aucune station n'est suivie/);
});

test('widget: one row per station, in the language of the user', async (t) => {
  const world = await createWorld({ config: { radius_km: '2' } });
  t.after(() => world.app.stop());
  let content = await widget(world);
  assert.match(content.components[0].text, /Découverte/);
  await create(world, CIMETIERE);
  await create(world, 'FRTLSP31555024');
  content = await widget(world, {}, 'en');
  assert.deepEqual(content.components[0].items, [
    { label: 'TOULOUSE - Avenue du Cimetière', value: '2 / 4 free', color: 'success' },
    { label: "TOULOUSE - 9 Boulevard d'Arcole", value: '2 / 4 free', color: 'success' },
  ]);
  assert.equal(content.ttl_seconds, 600);
});

test('widget: a station renamed in Gladys shows its new name at once', async (t) => {
  const world = await createWorld({ config: { radius_km: '2' } });
  t.after(() => world.app.stop());
  const device = await create(world, CIMETIERE);
  const refreshes = world.fake.widgetRefreshes.length;
  await world.fake.deviceUpdated({ ...device, name: 'Borne du cimetière' });
  assert.ok(world.fake.widgetRefreshes.length > refreshes);
  const content = await widget(world, {}, 'en');
  assert.equal(content.components[0].items[0].label, 'Borne du cimetière');
});

test('status: position, stations, live data, stations added', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  const message = await action(world, 'status');
  assert.equal(
    message.fr,
    [
      '■ Autour de Maison, 1 km',
      '49 stations trouvées, 5 avec données en direct (proposées dans Découverte).',
      'Données en direct lues il y a 0 s.',
      '0 station ajoutée à Gladys.',
    ].join('\n'),
  );
});

test('without a located house nor a position: said in the status, nothing read', async (t) => {
  const world = await createWorld({ houses: [{ ...HOUSE, latitude: null, longitude: null }] });
  t.after(() => world.app.stop());
  assert.equal(world.fake.discoveredDevices.length, 0);
  assert.equal(world.network.calls.length, 0);
  const message = await action(world, 'status');
  assert.match(message.en, /^No position: locate your house/);
});

test('the house picked in the configuration is the center', async (t) => {
  const other = {
    ...HOUSE,
    id: 'h2',
    name: 'Bureau',
    selector: 'bureau',
    latitude: 43.5,
    longitude: 1.3,
  };
  const world = await createWorld({
    houses: [other, HOUSE],
    config: { house: 'maison', radius_km: '1' },
  });
  t.after(() => world.app.stop());
  assert.equal(world.service.center.name, 'Maison');
  assert.equal(world.fake.discoveredDevices.length, 5);
});

test('search: stations whose address contains a text, with their ids', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  const message = await action(world, 'search', { query: 'Cimetière' });
  assert.equal(
    message.fr,
    `${CIMETIERE} · TOULOUSE - Avenue du Cimetière · Avenue du Cimetière, 31500 TOULOUSE (4 points, 180 kW)`,
  );
  assert.match((await action(world, 'search', { query: 'zz' })).fr, /au moins 3 caractères/);
  assert.match((await action(world, 'search', { query: 'Atlantide' })).en, /No station address/);
});

test('a reconfiguration reads the area again with the new radius', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  await world.fake.configUpdated({ radius_km: '2' });
  assert.equal(world.fake.discoveredDevices.length, 24);
});

test('the dynamic file down: the last states stay, the age keeps growing', async (t) => {
  const world = await createWorld({ config: { radius_km: '2' } });
  t.after(() => world.app.stop());
  const device = await create(world, CIMETIERE);
  world.network.fail.dynamic = new TypeError('fetch failed');
  await cycle(world, 3600);
  assert.equal(lastState(world, device, 'free'), 2);
  assert.equal(lastState(world, device, 'age'), 62);
  const message = await action(world, 'status');
  assert.match(message.en, /Last error: proxy\.transport\.data\.gouv\.fr: fetch failed/);
});

test('the static data is read once a day, not at every cycle', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  const tabular = () => world.network.calls.filter((c) => c.url.includes('tabular')).length;
  const before = tabular();
  await cycle(world);
  await cycle(world);
  assert.equal(tabular(), before);
  await cycle(world, 24 * 3600);
  assert.ok(tabular() > before);
});

test('the station list is kept in /data: a restart works while the tabular API is down', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'irve-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const first = await createWorld({ dataDir });
  await first.app.stop();
  const network = createFetch();
  network.fail.static = 504;
  const world = await createWorld({ dataDir, network });
  t.after(() => world.app.stop());
  assert.equal(world.fake.discoveredDevices.length, 5);
  // Another radius: the list kept does not apply.
  const other = await createWorld({ dataDir, network, config: { radius_km: '2' } });
  t.after(() => other.app.stop());
  assert.equal(other.fake.discoveredDevices.length, 0);
});

test('a tabular API page that fails once is tried again at once', async (t) => {
  const network = createFetch();
  const fetch = network.fetch;
  let failures = 1;
  network.fetch = async (url, init) => {
    if (url.includes('tabular') && failures > 0) {
      failures -= 1;
      return new Response('gateway timeout', { status: 504 });
    }
    return fetch(url, init);
  };
  const world = await createWorld({ network });
  t.after(() => world.app.stop());
  assert.equal(world.fake.discoveredDevices.length, 5);
  assert.equal(world.service.staticError, null);
});

test('an occupation unknown is not "all taken": no trigger, orange row', async (t) => {
  const world = await createWorld({ config: { radius_km: '2' } });
  t.after(() => world.app.stop());
  await create(world, CIMETIERE);
  const points = ['FRTLSE315550501', 'FRTLSE315550502', 'FRTLSE315550503', 'FRTLSE315550504'];
  setPoints(world, points.slice(0, 3), { occupation_pdc: 'occupe' });
  setPoints(world, points.slice(3), { occupation_pdc: 'inconnu' });
  await cycle(world);
  assert.deepEqual(world.fake.sceneEvents, []);
  const content = await widget(world);
  assert.deepEqual(content.components[0].items[0], {
    label: 'TOULOUSE - Avenue du Cimetière',
    value: '0 / 4 libre',
    color: 'warning',
  });
});

test('a filter change fires no trigger', async (t) => {
  const world = await createWorld({ config: { radius_km: '2' } });
  t.after(() => world.app.stop());
  await create(world, CIMETIERE);
  // No CHAdeMO point: free drops from 2 to 0 without anything happening.
  await world.fake.configUpdated({ radius_km: '2', connector: 'chademo' });
  await cycle(world);
  await world.fake.configUpdated({ radius_km: '2' });
  assert.deepEqual(world.fake.sceneEvents, []);
});

test('a reconfiguration while the tabular API is down keeps the previous area', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  world.network.fail.static = 504;
  await world.fake.configUpdated({ radius_km: '2' });
  assert.equal(world.fake.discoveredDevices.length, 5);
  assert.equal(world.service.radiusKm, 1);
  world.network.fail = {};
  await cycle(world);
  assert.equal(world.fake.discoveredDevices.length, 24);
});

test('a station added but gone from the national data is not looked for at every cycle', async (t) => {
  const first = await createWorld({ config: { radius_km: '2' } });
  const device = await create(first, CIMETIERE);
  await first.app.stop();
  const network = createFetch();
  network.rows = network.rows.filter((r) => r.id_station_itinerance !== CIMETIERE);
  const world = await createWorld({ config: { radius_km: '1' }, devices: [device], network });
  t.after(() => world.app.stop());
  const tabular = () => network.calls.filter((c) => c.url.includes('tabular')).length;
  const before = tabular();
  await cycle(world);
  await cycle(world);
  assert.equal(tabular(), before);
});

test('search: the case of the text does not matter', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  assert.match(
    (await action(world, 'search', { query: 'avenue du cimetière' })).fr,
    /FRTLSP31555050/,
  );
});
