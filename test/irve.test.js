// -----------------------------------------------------------------------------
// The reading of the national files: timestamps (with and without an offset),
// powers in W or kW, duplicates, the line by line filter of the dynamic file,
// the radius shrunk in a dense area.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DYNAMIC_URL,
  MAX_ROWS,
  buildStations,
  parseTimestamp,
  powerKw,
  readArea,
  readDynamic,
  stationReading,
} from '../src/irve.js';
import { normalizeConfig, parsePosition, parseStationIds } from '../src/config.js';
import { DYNAMIC_CSV, FIXTURE_TIME, STATIC, dynamicRows } from './helpers/world.js';

test('timestamps: offsets, Z, and Paris local time without an offset', () => {
  assert.equal(
    parseTimestamp('2026-10-22 14:34:19.975143+00:00'),
    Date.parse('2026-10-22T14:34:19.975Z'),
  );
  assert.equal(parseTimestamp('2026-10-22T12:48:57Z'), Date.parse('2026-10-22T12:48:57Z'));
  assert.equal(parseTimestamp('2026-10-22T17:55:00+02:00'), Date.parse('2026-10-22T15:55:00Z'));
  // Summer time (UTC+2), winter time (UTC+1).
  assert.equal(parseTimestamp('2026-10-22 17:43:19'), Date.parse('2026-10-22T15:43:19Z'));
  assert.equal(parseTimestamp('2026-12-01 08:00:00'), Date.parse('2026-12-01T07:00:00Z'));
  assert.equal(parseTimestamp('2026-10-22 14:00:00+00'), Date.parse('2026-10-22T14:00:00Z'));
  assert.equal(parseTimestamp(''), null);
  assert.equal(parseTimestamp('yesterday'), null);
});

test('every timestamp of the real file is understood, none in the future', () => {
  for (const row of dynamicRows()) {
    const at = parseTimestamp(row.horodatage);
    assert.notEqual(at, null, row.horodatage);
    assert.ok(at <= FIXTURE_TIME, row.horodatage);
  }
});

test('powers: kW, decimals, watts', () => {
  assert.equal(powerKw(22), 22);
  assert.equal(powerKw(22.08), 22.1);
  assert.equal(powerKw('7,4'), 7.4);
  assert.equal(powerKw(22000), 22);
  assert.equal(powerKw(null), 0);
});

test('stations: charge points grouped, duplicates dropped', () => {
  const stations = buildStations(STATIC.rows);
  const capitole = stations.get('FRPKGP31555001');
  assert.equal(capitole.points.length, 47);
  assert.equal(new Set(capitole.points.map((p) => p.id)).size, 47);
  const rows = STATIC.rows.filter((r) => r.id_station_itinerance === 'FRTLSP31555050');
  assert.equal(buildStations([...rows, ...rows]).get('FRTLSP31555050').points.length, 4);
  // A two-wheeler station is dropped.
  const twoWheels = rows.map((r) => ({ ...r, station_deux_roues: true }));
  assert.equal(buildStations(twoWheels).size, 0);
});

/** A fetch serving a text body in small chunks, like a real network. */
function chunked(text, size = 1000) {
  return async (url) => {
    assert.equal(url, DYNAMIC_URL);
    const bytes = new TextEncoder().encode(text);
    let offset = 0;
    const body = new ReadableStream({
      pull(controller) {
        if (offset >= bytes.length) {
          controller.close();
          return;
        }
        controller.enqueue(bytes.slice(offset, offset + size));
        offset += size;
      },
    });
    return new Response(body);
  };
}

test('the dynamic file: only the wanted points kept, the most recent row of a duplicate', async () => {
  const header = DYNAMIC_CSV.split('\n')[0];
  const filler = Array.from(
    { length: 50000 },
    (_, i) => `FRXXXE${i},en_service,libre,2026-10-22 10:00:00+00:00,,,,`,
  );
  const text = [
    header,
    ...filler,
    'FRAAAE1,en_service,occupe,2026-10-22 10:00:00+00:00,,,,',
    'FRAAAE1,en_service,libre,2026-10-22 13:00:00,,,,',
    'FRAAAE1,hors_service,inconnu,2026-10-22 09:00:00+00:00,,,,',
    'FRBBBE1,bizarre,inconnu,2026-10-22 10:00:00Z,,,,',
  ].join('\r\n');
  const { points, lines } = await readDynamic(chunked(text, 777), new Set(['FRAAAE1', 'FRBBBE1']));
  assert.equal(lines, 50005);
  assert.deepEqual([...points.keys()], ['FRAAAE1', 'FRBBBE1']);
  // 13:00 in Paris is 11:00 UTC: more recent than 10:00 UTC.
  assert.deepEqual(points.get('FRAAAE1'), {
    state: 'en_service',
    occupation: 'libre',
    at: Date.parse('2026-10-22T11:00:00Z'),
  });
  assert.equal(points.get('FRBBBE1').state, 'inconnu');
});

test('the dynamic file with other columns: refused', async () => {
  await assert.rejects(readDynamic(chunked('a,b,c\n1,2,3\n'), new Set()), /unexpected columns/);
  await assert.rejects(readDynamic(chunked(''), new Set()), /empty file/);
});

test('a dense area: the radius shrinks until the box fits', async () => {
  const asked = [];
  const fetch = async (url) => {
    const params = new URL(url).searchParams;
    const span = Number(params.get('consolidated_latitude__less'));
    asked.push(span);
    // 20 000 rows for the first box, then few enough.
    const total = asked.length === 1 ? 4 * MAX_ROWS : 100;
    return Response.json({ data: [], links: { next: null }, meta: { total } });
  };
  const { radiusKm } = await readArea(fetch, { lat: 48.8566, lon: 2.3522 }, 20);
  assert.equal(radiusKm, 9);
  assert.equal(asked.length, 2);
});

test('a reading: free, occupied, out of service, unknown and old states', () => {
  const now = Date.parse('2026-10-22T16:00:00Z');
  const station = {
    points: ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({ id, power: 22, type_2: true })),
  };
  const points = new Map([
    ['a', { state: 'en_service', occupation: 'libre', at: now - 60000 }],
    ['b', { state: 'en_service', occupation: 'reserve', at: now - 120000 }],
    ['c', { state: 'hors_service', occupation: 'inconnu', at: now - 180000 }],
    ['d', { state: 'en_service', occupation: 'inconnu', at: now - 240000 }],
    ['e', { state: 'en_service', occupation: 'libre', at: now - 8 * 24 * 3600 * 1000 }],
  ]);
  assert.deepEqual(stationReading(station, points, { minPower: 0, connector: 'any' }, now), {
    total: 6,
    live: 4,
    free: 1,
    occupied: 1,
    outOfService: 1,
    inService: 3,
    newestAt: now - 60000,
    maxPower: 22,
  });
});

test('configuration: positions, station ids, defaults', () => {
  assert.deepEqual(parsePosition('43.6045, 1.444'), { lat: 43.6045, lon: 1.444 });
  assert.deepEqual(parsePosition('43,6045 1,444'), { lat: 43.6045, lon: 1.444 });
  assert.equal(parsePosition('Toulouse'), null);
  assert.equal(parsePosition('95, 1'), null);
  assert.deepEqual(parseStationIds('FR*TLS*P31555050, frtlsp31555024\nx'), [
    'FRTLSP31555050',
    'FRTLSP31555024',
  ]);
  const config = normalizeConfig({ radius_km: '7', connector: 'tesla' });
  assert.equal(config.radiusKm, 5);
  assert.equal(config.connector, 'any');
  assert.equal(config.refreshSeconds, 600);
  assert.equal(config.language, 'fr');
});
