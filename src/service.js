// -----------------------------------------------------------------------------
// The integration at runtime: the stations around the position (static data,
// read once a day), their live states (dynamic file, read at the configured
// pace), the devices offered in the Discover tab, the states of the stations
// added to Gladys, and the scene triggers.
//
// Data flow: the position (the house of Gladys, or the one typed in the
// configuration) and the radius give the stations of the area; the stations
// listed by id and the ones already added to Gladys are read too, wherever
// they are. The stations with at least one charge point matching the filters
// and published live are offered in the Discover tab (the nearest ones,
// MAX_DISCOVERED at most); the ones the user adds are the "followed" stations:
// states, widget, triggers and scene action.
// -----------------------------------------------------------------------------

import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger } from '@gladysassistant/integration-sdk';
import { DEFAULT_CONFIG, normalizeConfig } from './config.js';
import {
  STATION_TYPE,
  buildStationDevice,
  clip,
  prettyName,
  stationIds,
  stationStates,
} from './devices.js';
import {
  allOutOfService,
  buildStations,
  distanceKm,
  readArea,
  readDynamic,
  readPages,
  searchUrl,
  stationReading,
  stationsUrl,
} from './irve.js';
import { REPORTS, TEXT, lines, render, say } from './messages.js';

const logger = createLogger({ name: 'irve' });

// Stations offered in the Discover tab, at most (the nearest).
export const MAX_DISCOVERED = 30;
// The static data is consolidated once a day.
export const STATIC_TTL_MS = 24 * 3600 * 1000;
// A station whose newest state is older than this is "out of date": shown
// grey, never offered by the scene action, never compared by the triggers.
// Operators publish a state when it changes: a quiet station may legitimately
// keep the same one for a day.
export const STALE_MS = 48 * 3600 * 1000;
// Unchanged states are sent again this often, or the dashboard shows "no
// recent value" after 48 hours.
export const HEARTBEAT_MS = 6 * 3600 * 1000;
// The station list kept in /data is used for a week at most, while the
// tabular API cannot be read (a restart does not depend on it).
export const CACHE_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
export const CACHE_FILE = 'stations.json';
// Search results listed by the "Search" action.
export const MAX_RESULTS = 8;

export const TRIGGERS = {
  POINT_FREED: 'point_freed',
  FULL: 'station_full',
  OUT_OF_SERVICE: 'station_out_of_service',
};

export class Irve {
  /**
   * @param {object} options
   * @param {object} options.gladys GladysIntegration (or the SDK's fake)
   * @param {typeof fetch} [options.fetch]
   * @param {() => number} [options.now]
   * @param {boolean} [options.timers] false in the tests: they call refresh()
   * @param {string|null} [options.dataDir] where the station list is kept, null: nowhere
   */
  constructor({ gladys, fetch = globalThis.fetch, now = Date.now, timers = true, dataDir = null }) {
    this.dataDir = dataDir;
    this.gladys = gladys;
    this.fetch = fetch;
    this.now = now;
    this.useTimers = timers;
    this.config = normalizeConfig(DEFAULT_CONFIG);
    this.center = null; // { lat, lon, name }
    this.radiusKm = null; // radius actually read (may be smaller than asked)
    this.stations = new Map(); // id → station (static)
    this.staticAt = null;
    this.staticError = null;
    this.points = new Map(); // charge point id → { state, occupation, at }
    this.dynamicAt = null;
    this.previousDynamicAt = null;
    this.dynamicError = null;
    this.readings = new Map(); // station id → reading
    this.discoveredSignature = null;
    this.publishFailed = false;
    this.discoveryFailed = false;
    this.fireFailed = false;
    this.timer = null;
    this.stopped = false;
    this.refreshing = null;
    this.loading = Promise.resolve();
  }

  // --- lifecycle --------------------------------------------------------------

  async start(config) {
    this.config = config;
    this.schedule();
    logger.info(
      `Started: ${config.radiusKm} km, ${config.stationIds.length} station(s) listed, ` +
        `${this.followed().length} station(s) added`,
    );
    // The first reading in the background: the widget and the scene action
    // wait for it.
    this.loading = this.refresh({ discover: true, reloadStatic: true });
  }

  /** Gladys restarted: everything again, the states included. */
  async resync(config) {
    this.config = config;
    this.gladys.forgetPublishedStates?.();
    await this.refresh({ discover: true, reloadStatic: true });
  }

  async reconfigure(config) {
    this.config = config;
    this.schedule();
    await this.refresh({ discover: true, reloadStatic: true });
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.refreshing;
  }

  schedule() {
    if (!this.useTimers || this.stopped) {
      return;
    }
    clearTimeout(this.timer);
    // A callback still running when the schedule changes must not start a
    // second chain: each chain only continues while it is the current one.
    this.generation = (this.generation ?? 0) + 1;
    const generation = this.generation;
    const tick = () => {
      this.timer = setTimeout(async () => {
        await this.refresh();
        if (!this.stopped && this.generation === generation) {
          tick();
        }
      }, this.config.refreshSeconds * 1000);
      this.timer.unref?.();
    };
    tick();
  }

  // --- devices ----------------------------------------------------------------

  deviceId(station) {
    return stationIds(this.gladys, station).device;
  }

  /** The station id of a device created in Gladys, from its params or its external id. */
  stationIdOf(device) {
    const param = device?.params?.find?.((p) => p.name === 'station_id')?.value;
    if (param) {
      return String(param);
    }
    const prefix = `${STATION_TYPE}:`;
    const id = String(device?.external_id ?? '');
    const at = id.indexOf(prefix);
    return at >= 0 ? id.slice(at + prefix.length) : null;
  }

  /** The stations added to Gladys: `{ deviceId, stationId, name }[]`. */
  followed() {
    return (this.gladys.devices ?? [])
      .map((device) => ({
        deviceId: device.external_id,
        stationId: this.stationIdOf(device),
        name: device.name,
      }))
      .filter((entry) => entry.stationId);
  }

  /** The station of a device: `{ station, reading }`, null if unknown. */
  lookup(deviceId) {
    for (const station of this.stations.values()) {
      if (this.deviceId(station) === deviceId) {
        return { station, reading: this.readings.get(station.id) ?? null };
      }
    }
    return null;
  }

  distance(station) {
    return this.center ? distanceKm(this.center, station) : null;
  }

  isStale(reading) {
    return !reading || reading.newestAt === null || this.now() - reading.newestAt > STALE_MS;
  }

  /** Waits for the first reading (at most `ms`), for a widget or a scene action asked at start. */
  async firstReading(ms = 10000) {
    let timer;
    await Promise.race([
      this.loading,
      new Promise((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
    ]);
    clearTimeout(timer);
  }

  /** The stations offered in the Discover tab. */
  discoverable() {
    const created = new Set(this.followed().map((entry) => entry.deviceId));
    const listed = new Set(this.config.stationIds);
    const nearby = [];
    const always = [];
    for (const station of this.stations.values()) {
      const reading = this.readings.get(station.id);
      if (created.has(this.deviceId(station)) || listed.has(station.id)) {
        always.push(station);
        continue;
      }
      // A station without a live charge point (operator without dynamic
      // data), or without a charge point matching the filters, or out of the
      // circle, is not worth a device.
      const distance = this.distance(station);
      if (reading?.live > 0 && distance !== null && distance <= this.radiusKm) {
        nearby.push({ station, distance });
      }
    }
    nearby.sort((a, b) => a.distance - b.distance || a.station.id.localeCompare(b.station.id));
    return [
      ...always,
      ...nearby.slice(0, Math.max(0, MAX_DISCOVERED - always.length)).map((n) => n.station),
    ];
  }

  async publishDiscovered({ force = false } = {}) {
    const devices = this.discoverable().map((station) =>
      buildStationDevice(this.gladys, station, this.readings.get(station.id), this.config.language),
    );
    const signature = JSON.stringify(devices.map((d) => [d.external_id, d.name, d.features]));
    if (!force && signature === this.discoveredSignature) {
      return;
    }
    try {
      await this.gladys.publishDiscoveredDevices(devices);
      this.discoveredSignature = signature;
      if (this.discoveryFailed) {
        this.discoveryFailed = false;
        logger.info('Discovered stations published again');
      }
    } catch (err) {
      if (!this.discoveryFailed) {
        logger.warn(`Cannot publish the discovered stations: ${err.message}`);
      }
      this.discoveryFailed = true;
    }
  }

  async publish(states) {
    if (states.length === 0) {
      return;
    }
    try {
      await this.gladys.publishChangedStates(states, { heartbeat: HEARTBEAT_MS });
      if (this.publishFailed) {
        this.publishFailed = false;
        logger.info('States published again');
      }
    } catch (err) {
      // Gladys restarting: said once, the next refresh sends them again.
      if (!this.publishFailed) {
        logger.warn(`Cannot publish ${states.length} state(s): ${err.message}`);
      }
      this.publishFailed = true;
    }
  }

  /** A device was just added in Gladys: its states, all of them, now. */
  async onDeviceCreated(device) {
    const found = this.lookup(device?.external_id);
    if (!found?.reading) {
      return;
    }
    await this.publish(stationStates(this.gladys, found.station, found.reading, this.now()));
    this.gladys.requestWidgetRefresh?.('stations')?.catch?.(() => {});
  }

  // --- refresh ------------------------------------------------------------------

  /** One reading; concurrent calls share it. */
  refresh({ discover = false, reloadStatic = false } = {}) {
    if (!this.refreshing) {
      this.refreshing = this.refreshAll(discover, reloadStatic)
        .catch((err) => logger.warn(`Refresh failed: ${err.message}`))
        .finally(() => {
          this.refreshing = null;
        });
      return this.refreshing;
    }
    // A reconfiguration during a refresh reads again right after it: the
    // running one may use the old position or filters.
    return discover || reloadStatic
      ? this.refreshing.then(() => this.refresh({ discover, reloadStatic }))
      : this.refreshing;
  }

  async refreshAll(forceDiscovery, reloadStatic) {
    await this.loadStatic(reloadStatic);
    const previous = this.readings;
    const read = await this.loadDynamic();
    this.readings = new Map(
      [...this.stations.values()].map((station) => [
        station.id,
        stationReading(station, this.points, this.config, this.now()),
      ]),
    );
    const events = read ? this.events(previous) : [];
    await this.publishDiscovered({ force: forceDiscovery });
    // States of every station added, even when the dynamic file could not be
    // read: its age keeps growing.
    const states = [];
    for (const entry of this.followed()) {
      const found = this.lookup(entry.deviceId);
      if (found?.reading) {
        states.push(...stationStates(this.gladys, found.station, found.reading, this.now()));
      }
    }
    await this.publish(states);
    for (const { key, data } of events) {
      await this.fire(key, data);
    }
  }

  /** The position: the one typed, else the house picked, else the first located house. */
  async resolveCenter() {
    if (this.config.position) {
      const { lat, lon } = this.config.position;
      return { lat, lon, name: `${lat.toFixed(4)}, ${lon.toFixed(4)}` };
    }
    let houses;
    try {
      houses = ((await this.gladys.getHouses()) ?? []).filter(
        (h) => Number.isFinite(h.latitude) && Number.isFinite(h.longitude),
      );
    } catch (err) {
      logger.warn(`Cannot read the position of the houses: ${err.message}`);
      return this.center;
    }
    const house =
      (this.config.house && houses.find((h) => h.selector === this.config.house)) || houses[0];
    return house ? { lat: house.latitude, lon: house.longitude, name: house.name } : null;
  }

  /**
   * The static data: the area, the stations listed and the ones added.
   * Read again once a day, on a configuration change, or when a station
   * added since is not known yet.
   */
  async loadStatic(force) {
    const followedIds = this.followed().map((entry) => entry.stationId);
    const missing = followedIds.some((id) => !this.stations.has(id));
    const fresh = this.staticAt !== null && this.now() - this.staticAt < STATIC_TTL_MS;
    if (!force && fresh && !missing) {
      return;
    }
    // Not more than once a cycle after a failure: the next cycle tries again.
    let key = null;
    try {
      this.center = await this.resolveCenter();
      key = this.staticKey(followedIds);
      const rows = [];
      this.radiusKm = null;
      if (this.center) {
        const area = await readArea(this.fetch, this.center, this.config.radiusKm);
        this.radiusKm = area.radiusKm;
        rows.push(...area.rows);
      }
      const stations = buildStations(rows);
      const elsewhere = [...new Set([...this.config.stationIds, ...followedIds])].filter(
        (id) => !stations.has(id),
      );
      if (elsewhere.length > 0) {
        const { rows: listed } = await readPages(this.fetch, (page) =>
          stationsUrl(elsewhere, page),
        );
        for (const [id, station] of buildStations(listed)) {
          stations.set(id, station);
        }
      }
      this.stations = stations;
      this.staticAt = this.now();
      if (this.staticError) {
        logger.info('Station list back');
      }
      this.staticError = null;
      logger.debug(`${stations.size} stations read (${rows.length} charge points around)`);
      await this.saveCache(key);
    } catch (err) {
      if (!this.staticError) {
        logger.warn(`Station list unavailable: ${err.message}`);
      }
      this.staticError = err.message;
      if (this.stations.size === 0) {
        await this.loadCache(key);
      }
    }
  }

  /** What the station list depends on: position, radius, station ids. */
  staticKey(followedIds) {
    const { lat, lon } = this.center ?? {};
    return JSON.stringify([lat, lon, this.config.radiusKm, this.config.stationIds, followedIds]);
  }

  async saveCache(key) {
    if (!this.dataDir) {
      return;
    }
    const file = join(this.dataDir, CACHE_FILE);
    const document = {
      key,
      at: this.staticAt,
      radiusKm: this.radiusKm,
      stations: [...this.stations.values()],
    };
    try {
      await writeFile(`${file}.tmp`, JSON.stringify(document));
      await rename(`${file}.tmp`, file);
    } catch (err) {
      logger.debug(`Cannot keep the station list: ${err.message}`);
    }
  }

  /** The station list kept in /data, if it was read for the same settings, this week. */
  async loadCache(key) {
    if (!this.dataDir) {
      return;
    }
    try {
      const document = JSON.parse(await readFile(join(this.dataDir, CACHE_FILE), 'utf8'));
      if (document.key !== key || this.now() - document.at > CACHE_MAX_AGE_MS) {
        return;
      }
      this.stations = new Map(document.stations.map((station) => [station.id, station]));
      this.radiusKm = document.radiusKm;
      logger.info(`Using the station list kept from ${new Date(document.at).toISOString()}`);
    } catch {
      // No list kept yet.
    }
  }

  /** Reads the live states of the charge points known; false when it failed. */
  async loadDynamic() {
    const wanted = new Set();
    for (const station of this.stations.values()) {
      for (const point of station.points) {
        wanted.add(point.id);
      }
    }
    if (wanted.size === 0) {
      return false;
    }
    try {
      const { points, lines: count } = await readDynamic(this.fetch, wanted);
      this.points = points;
      this.previousDynamicAt = this.dynamicAt;
      this.dynamicAt = this.now();
      if (this.dynamicError) {
        logger.info('Live data back');
      }
      this.dynamicError = null;
      logger.debug(`${count} lines read, ${points.size} charge points followed`);
      return true;
    } catch (err) {
      if (!this.dynamicError) {
        logger.warn(`Live data unavailable: ${err.message}`);
      }
      this.dynamicError = err.message;
      return false;
    }
  }

  // --- triggers ---------------------------------------------------------------

  /** The trigger events between the previous and the new readings. */
  events(previous) {
    // A comparison with a reading hours old (data back after an outage)
    // would fire changes that are no longer news.
    const recent =
      this.previousDynamicAt !== null &&
      this.dynamicAt - this.previousDynamicAt <= 2 * this.config.refreshSeconds * 1000 + 5000;
    if (!recent) {
      return [];
    }
    const events = [];
    for (const entry of this.followed()) {
      const found = this.lookup(entry.deviceId);
      const before = found && previous.get(found.station.id);
      // Only a created device can be picked by a scene; an out of date
      // station is not news either.
      if (!found?.reading || !before || this.isStale(found.reading) || this.isStale(before)) {
        continue;
      }
      events.push(...this.stationEvents(found.station, entry.deviceId, before, found.reading));
    }
    return events;
  }

  /** The variables of a station, for an event or the scene action. */
  variables(station, deviceId, reading) {
    const distance = this.distance(station);
    return {
      station: deviceId,
      station_name: prettyName(station.name),
      address: station.address,
      free: reading.free,
      total: reading.total,
      out_of_service: reading.outOfService,
      max_power: reading.maxPower,
      distance_km: distance === null ? 0 : Math.round(distance * 10) / 10,
    };
  }

  /** The events of one station between two readings. */
  stationEvents(station, deviceId, before, after) {
    const data = this.variables(station, deviceId, after);
    const events = [];
    if (!allOutOfService(before) && allOutOfService(after)) {
      events.push({ key: TRIGGERS.OUT_OF_SERVICE, data });
    }
    if (after.free > before.free) {
      const wasFull = before.free === 0 && before.inService > 0;
      events.push({ key: TRIGGERS.POINT_FREED, data: { ...data, was_full: wasFull ? '1' : '0' } });
    }
    if (before.free > 0 && after.free === 0 && after.inService > 0) {
      events.push({ key: TRIGGERS.FULL, data });
    }
    return events;
  }

  async fire(key, data) {
    try {
      await this.gladys.publishSceneEvent(key, data);
      if (this.fireFailed) {
        this.fireFailed = false;
        logger.info('Scene triggers fired again');
      }
    } catch (err) {
      if (!this.fireFailed) {
        logger.warn(`Cannot fire the ${key} trigger: ${err.message}`);
      }
      this.fireFailed = true;
    }
  }

  // --- texts ------------------------------------------------------------------

  /** "2 / 4 libres", "hors service", "donnée périmée"… for a widget row (40 characters). */
  shortText(reading, language) {
    if (!reading) {
      return '—';
    }
    if (reading.total === 0) {
      return say(TEXT, language, 'noPoint');
    }
    if (reading.live === 0) {
      return say(TEXT, language, 'noLive');
    }
    if (this.isStale(reading)) {
      return say(TEXT, language, 'stale');
    }
    if (allOutOfService(reading)) {
      return say(TEXT, language, 'outOfService');
    }
    if (reading.free === 0) {
      return say(TEXT, language, 'full');
    }
    return say(TEXT, language, 'counts', reading);
  }

  // --- configuration actions ----------------------------------------------------

  status() {
    const now = this.now();
    const blocks = [];
    if (this.center) {
      const name = clip(this.center.name, 40);
      blocks.push(render(REPORTS, 'position', { name, radius: this.config.radiusKm }));
      if (this.radiusKm !== null && this.radiusKm < this.config.radiusKm) {
        blocks.push(render(REPORTS, 'shrunk', { radius: this.radiusKm }));
      }
    } else if (this.config.stationIds.length === 0) {
      blocks.push(render(REPORTS, 'noPosition'));
    }
    // The stations of the circle and the listed ones (the box read is wider).
    const listed = new Set(this.config.stationIds);
    const shown = [...this.stations.values()].filter((station) => {
      const distance = this.distance(station);
      return listed.has(station.id) || (distance !== null && distance <= this.radiusKm);
    });
    const live = shown.filter((station) => this.readings.get(station.id)?.live > 0).length;
    blocks.push(render(REPORTS, 'stations', { count: shown.length, live }));
    const missing = this.config.stationIds.filter((id) => !this.stations.has(id));
    if (this.staticAt !== null && missing.length > 0) {
      blocks.push(render(REPORTS, 'missing', { ids: missing.join(', ') }));
    }
    blocks.push(
      this.dynamicAt === null
        ? render(REPORTS, 'waiting')
        : render(REPORTS, 'read', { age: Math.round((now - this.dynamicAt) / 1000) }),
    );
    for (const error of [this.staticError, this.dynamicError]) {
      if (error) {
        blocks.push(render(REPORTS, 'error', { error }));
      }
    }
    blocks.push(render(REPORTS, 'followed', { count: this.followed().length }));
    return lines(...blocks);
  }

  /** The stations whose address contains a text, with their ids for the "stations" field. */
  async search(fields) {
    const query = String(fields?.query ?? '').trim();
    if (query.length < 3) {
      return render(REPORTS, 'shortQuery');
    }
    const { rows } = await readPages(this.fetch, () => searchUrl(query), { maxRows: 200 });
    const stations = [...buildStations(rows).values()];
    if (stations.length === 0) {
      return render(REPORTS, 'noResult', { query: clip(query, 40) });
    }
    const results = stations.slice(0, MAX_RESULTS).map((station) =>
      render(REPORTS, 'result', {
        id: station.id,
        name: clip(prettyName(station.name), 40),
        address: clip(station.address, 60),
        points: station.points.length,
        power: station.points.reduce((max, point) => Math.max(max, point.power), 0),
      }),
    );
    const more = stations.length - MAX_RESULTS;
    return lines(...results, more > 0 ? render(REPORTS, 'more', { count: more }) : null);
  }
}
