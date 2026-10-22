// -----------------------------------------------------------------------------
// A complete test world: the SDK's fake Gladys (with a located house), a fake
// `fetch` serving the real data captured on 2026-10-22 at 15:59:49 UTC
// (test/fixtures/irve: the charge points within 3 km of the Capitole of
// Toulouse from the tabular API of data.gouv.fr, trimmed to the columns read,
// and their rows of the national dynamic file), a manual clock, and the
// integration wired on top through registerHandlers. Nothing touches the
// network.
//
// The fake tabular API applies the filters the integration sends (box, ids,
// address search) and paginates like the real one.
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { registerHandlers } from '../../src/app.js';
import { DYNAMIC_URL, RETRY, TABULAR_URL } from '../../src/irve.js';

process.env.LOG_LEVEL ??= 'silent';
RETRY.delays = [0, 0];

const fixture = (name) =>
  readFileSync(new URL(`../fixtures/irve/${name}`, import.meta.url), 'utf8');

export const STATIC = JSON.parse(fixture('static.json'));
export const DYNAMIC_CSV = fixture('dynamic.csv');

// The time of the capture.
export const FIXTURE_TIME = Date.parse('2026-10-22T15:59:49Z');

// The Capitole of Toulouse, the center of the capture.
export const HOUSE = {
  id: 'house-1',
  name: 'Maison',
  selector: 'maison',
  latitude: 43.6045,
  longitude: 1.444,
};

/** The rows of the dynamic fixture, as objects. */
export function dynamicRows(text = DYNAMIC_CSV) {
  const [header, ...lines] = text.trim().split('\n');
  const columns = header.split(',');
  return lines.map((line) => Object.fromEntries(line.split(',').map((v, i) => [columns[i], v])));
}

/** Rows back into a CSV file. */
export function dynamicCsv(rows) {
  const columns = Object.keys(rows[0]);
  return [columns.join(','), ...rows.map((row) => columns.map((c) => row[c]).join(','))].join('\n');
}

/** The fake tabular API: filters, then one page. */
export function tabular(rows, url) {
  const params = new URL(url).searchParams;
  const number = (key) => Number(params.get(key));
  let found = rows;
  if (params.has('consolidated_latitude__greater')) {
    found = found.filter(
      (r) =>
        r.consolidated_latitude > number('consolidated_latitude__greater') &&
        r.consolidated_latitude < number('consolidated_latitude__less') &&
        r.consolidated_longitude > number('consolidated_longitude__greater') &&
        r.consolidated_longitude < number('consolidated_longitude__less'),
    );
  }
  if (params.has('id_station_itinerance__in')) {
    const ids = params.get('id_station_itinerance__in').split(',');
    found = found.filter((r) => ids.includes(r.id_station_itinerance));
  }
  if (params.has('adresse_station__contains')) {
    const text = params.get('adresse_station__contains');
    found = found.filter((r) => String(r.adresse_station ?? '').includes(text));
  }
  const size = number('page_size') || 20;
  const page = number('page') || 1;
  const data = found.slice((page - 1) * size, page * size);
  const next =
    page * size < found.length ? `${url.replace(/&page=\d+/, '')}&page=${page + 1}` : null;
  return {
    data,
    links: { next, prev: null },
    meta: { page, page_size: size, total: found.length },
  };
}

/**
 * A fake `fetch`. `state.rows` are the static rows, `state.dynamic` the
 * dynamic file (text); `state.fail` maps 'static' / 'dynamic' to an Error or
 * a status to answer instead. Every call is recorded in `calls`.
 */
export function createFetch() {
  const state = { rows: STATIC.rows, dynamic: DYNAMIC_CSV, fail: {}, calls: [] };
  state.fetch = async (url, init = {}) => {
    state.calls.push({ url, headers: init.headers ?? {} });
    const kind = url.startsWith(TABULAR_URL) ? 'static' : url === DYNAMIC_URL ? 'dynamic' : null;
    const failure = state.fail[kind];
    if (failure instanceof Error) {
      throw failure;
    }
    if (typeof failure === 'number') {
      return new Response('error', { status: failure });
    }
    if (kind === 'static') {
      return Response.json(tabular(state.rows, url));
    }
    if (kind === 'dynamic') {
      return new Response(state.dynamic, { headers: { 'content-type': 'text/csv' } });
    }
    return new Response('not found', { status: 404 });
  };
  return state;
}

/** A manual clock. */
export function createClock(start = FIXTURE_TIME) {
  const clock = {
    time: start,
    now: () => clock.time,
    advance(ms) {
      clock.time += ms;
    },
  };
  return clock;
}

/**
 * @param {object} [options]
 * @param {object} [options.config] raw integration config
 * @param {Array} [options.houses] houses of Gladys
 * @param {Array} [options.devices] devices already created in Gladys
 * @param {string|null} [options.dataDir] where the station list is kept (null: nowhere)
 */
export async function createWorld({
  config = { radius_km: '1' },
  houses = [HOUSE],
  network = createFetch(),
  devices = [],
  connect = true,
  clock = createClock(),
  dataDir = null,
} = {}) {
  const gladys = createFakeGladys({ config, devices, houses });
  const app = registerHandlers(gladys, {
    fetch: network.fetch,
    timers: false,
    now: clock.now,
    dataDir,
  });
  const world = { gladys, fake: gladys.fake, app, service: app.service, network, clock };
  if (connect) {
    await gladys.connect();
    await app.ready;
    await app.service.loading;
  }
  return world;
}

/** Run a configuration action; resolves with its message (multi-language). */
export async function action(world, key, fields = {}) {
  const ack = await world.fake.action(key, fields);
  if (!ack.success) {
    throw new Error(`${key} failed: ${ack.error}`);
  }
  return ack.data.message;
}

/** The device published for a station id, from the last discovery list. */
export const discovered = (world, stationId) =>
  world.fake.discoveredDevices.find((d) =>
    d.params.some((p) => p.name === 'station_id' && p.value === stationId),
  );

/** Create a discovered device in Gladys, as the user would. */
export async function create(world, stationId) {
  const device = discovered(world, stationId);
  if (!device) {
    throw new Error(`${stationId} is not in the discovered devices`);
  }
  await world.fake.deviceCreated(device);
  return device;
}

/** External id of one feature of a device. */
export const featureId = (device, key) =>
  device.features.find((feature) => feature.external_id.endsWith(`:${key}`))?.external_id;

/** One refresh cycle, `seconds` later. */
export async function cycle(world, seconds = 600) {
  world.clock.advance(seconds * 1000);
  await world.service.refresh();
}

/** Changes the dynamic rows of some charge points (ids), e.g. `{ occupation_pdc: 'libre' }`. */
export function setPoints(world, ids, changes) {
  const rows = dynamicRows(world.network.dynamic).map((row) =>
    ids.includes(row.id_pdc_itinerance)
      ? { ...row, ...(typeof changes === 'function' ? changes(row) : changes) }
      : row,
  );
  world.network.dynamic = dynamicCsv(rows);
}

/** Captures what the integration logs, at a level. */
export function captureLogs(t, level = 'info') {
  const previous = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = level;
  const lines = [];
  const record = (...args) => {
    const text = args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(' ');
    const match = /^\[[^\]]+\] \[(\w+)\]/.exec(text);
    lines.push({ level: match ? match[1].toLowerCase() : 'raw', text });
  };
  t.mock.method(console, 'log', record);
  t.mock.method(console, 'error', record);
  t.after(() => {
    process.env.LOG_LEVEL = previous;
  });
  return lines;
}
