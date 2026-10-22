// -----------------------------------------------------------------------------
// The national IRVE open data (Infrastructures de Recharge pour Véhicules
// Électriques), Licence Ouverte 2.0:
//
// - static: the consolidation of data.gouv.fr (one row per charge point,
//   "pdc": station, address, operator, position, power, connectors), read
//   through the tabular API of data.gouv.fr, filtered on the server by a box
//   around the position or by station ids: a few hundred rows instead of the
//   whole 90 MB file. Updated daily: read once a day.
// - dynamic: the national consolidation of transport.data.gouv.fr (one row per
//   charge point: `etat_pdc` en_service / hors_service / inconnu,
//   `occupation_pdc` libre / occupe / reserve / inconnu, `horodatage`), built
//   on every request from the feeds of the operators that publish one. About
//   125 000 rows, 9 MB (1.6 MB compressed): read line by line, only the
//   charge points of the stations followed are kept.
//
// Both are keyed by `id_pdc_itinerance`. Many operators publish no dynamic
// data at all: their stations are not offered.
// -----------------------------------------------------------------------------

import { HttpError, getJson, getLines } from './http.js';

// "Consolidation de la dernière version à date du schéma": the resource of the
// data.gouv.fr dataset 5448d3e0c751df01f85d0572 that always holds the latest
// consolidation (the dated resources next to it change id with the schema).
export const STATIC_RESOURCE = 'eb76d20a-8501-400e-b336-d85724de5435';
export const TABULAR_URL = `https://tabular-api.data.gouv.fr/api/resources/${STATIC_RESOURCE}/data/`;
export const DYNAMIC_URL =
  'https://proxy.transport.data.gouv.fr/resource/consolidation-nationale-irve-dynamique';

export const PAGE_SIZE = 200;
// Rows read around the position, at most (30 pages). A denser area (central
// Paris with 20 km) gets a smaller radius, said in the status.
export const MAX_ROWS = 6000;
// A charge point state older than this is unknown: some operators leave
// points "libre" for months (timestamps from 2020 in the file).
export const IGNORE_MS = 7 * 24 * 3600 * 1000;

const EARTH_KM = 6371;
const rad = (deg) => (deg * Math.PI) / 180;

/** Great-circle distance in km. */
export function distanceKm(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** The tabular API URL of the charge points in a box around `center`. */
export function boxUrl(center, radiusKm, page = 1) {
  const dLat = radiusKm / 111.32;
  const dLon = radiusKm / (111.32 * Math.cos(rad(center.lat)));
  const params = new URLSearchParams({
    consolidated_latitude__greater: (center.lat - dLat).toFixed(5),
    consolidated_latitude__less: (center.lat + dLat).toFixed(5),
    consolidated_longitude__greater: (center.lon - dLon).toFixed(5),
    consolidated_longitude__less: (center.lon + dLon).toFixed(5),
    page_size: String(PAGE_SIZE),
    page: String(page),
  });
  return `${TABULAR_URL}?${params}`;
}

/** The tabular API URL of the charge points of some stations. */
export function stationsUrl(ids, page = 1) {
  const params = new URLSearchParams({
    id_station_itinerance__in: ids.join(','),
    page_size: String(PAGE_SIZE),
    page: String(page),
  });
  return `${TABULAR_URL}?${params}`;
}

/** The tabular API URL of a search in the station addresses. */
export function searchUrl(text) {
  const params = new URLSearchParams({
    adresse_station__contains: text,
    page_size: String(PAGE_SIZE),
  });
  return `${TABULAR_URL}?${params}`;
}

// The tabular API answers in 0.2 to 16 s and sometimes 504, even for a
// trivial query (measured on 2026-10-22): a failed request is tried again
// twice, a few seconds later. The tests set the delays to 0.
export const RETRY = { delays: [2000, 5000] };

/** GET a tabular API page, tried again on a 5xx, a timeout or a network error. */
export async function getTabular(fetchImpl, url) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await getJson(fetchImpl, url, { timeoutMs: 30000 });
    } catch (err) {
      const transient = err.status === null || err.status === undefined || err.status >= 500;
      if (!transient || attempt >= RETRY.delays.length) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, RETRY.delays[attempt]));
    }
  }
}

/** Every page of a tabular API query, `maxRows` at most (`first`: page 1, already read). */
export async function readPages(fetchImpl, urlOfPage, { maxRows = MAX_ROWS, first = null } = {}) {
  const rows = [];
  let total = 0;
  for (let page = 1; rows.length < maxRows; page += 1) {
    const document = page === 1 && first ? first : await getTabular(fetchImpl, urlOfPage(page));
    if (!Array.isArray(document?.data)) {
      throw new HttpError('tabular-api.data.gouv.fr: unexpected answer');
    }
    total = Number(document.meta?.total ?? 0);
    rows.push(...document.data);
    if (document.data.length < PAGE_SIZE || !document.links?.next || rows.length >= total) {
      break;
    }
  }
  return { rows, total };
}

/**
 * The charge points around a position. When the box holds more than
 * MAX_ROWS rows, the radius shrinks until it fits (twice at most).
 * @returns {Promise<{ rows: object[], radiusKm: number }>}
 */
export async function readArea(fetchImpl, center, radiusKm) {
  let radius = radiusKm;
  for (let attempt = 0; ; attempt += 1) {
    const first = await getTabular(fetchImpl, boxUrl(center, radius, 1));
    const total = Number(first?.meta?.total ?? 0);
    if (total <= MAX_ROWS || attempt === 2) {
      const r = radius;
      const { rows } = await readPages(fetchImpl, (page) => boxUrl(center, r, page), { first });
      return { rows, radiusKm: radius };
    }
    radius = Math.max(0.5, Math.floor(radius * Math.sqrt(MAX_ROWS / total) * 9) / 10);
  }
}

/** A power in kW: some operators write watts (22000 for 22 kW). */
export function powerKw(value) {
  const number = Number(String(value ?? '').replace(',', '.'));
  if (!Number.isFinite(number) || number <= 0) {
    return 0;
  }
  const kw = number >= 1000 ? number / 1000 : number;
  return Math.round(kw * 10) / 10;
}

const yes = (value) => value === true || value === 'true' || value === 'True' || value === 1;

/** A clean id: no stars ("FR*TLS*E…"), upper case. */
export const cleanId = (value) =>
  String(value ?? '')
    .replace(/[*\s]/g, '')
    .toUpperCase();

/**
 * Groups charge point rows into stations. A charge point published twice
 * (same id in two source files) is kept once; a station needs coordinates.
 * @param {object[]} rows rows of the tabular API
 * @returns {Map<string, object>} station id → station
 */
export function buildStations(rows) {
  const stations = new Map();
  const seen = new Set();
  for (const row of rows) {
    const id = cleanId(row.id_station_itinerance);
    const pointId = cleanId(row.id_pdc_itinerance);
    const lat = Number(row.consolidated_latitude);
    const lon = Number(row.consolidated_longitude);
    // A two-wheeler station is no use to a car (the flag is rarely set).
    const unusable = yes(row.station_deux_roues) || !Number.isFinite(lat) || !Number.isFinite(lon);
    if (!id || !pointId || seen.has(pointId) || unusable) {
      continue;
    }
    seen.add(pointId);
    if (!stations.has(id)) {
      stations.set(id, {
        id,
        name: String(row.nom_station ?? '').trim() || id,
        address: String(row.adresse_station ?? '').trim(),
        operator: String(row.nom_operateur ?? row.nom_enseigne ?? '').trim(),
        lat,
        lon,
        points: [],
      });
    }
    stations.get(id).points.push({
      id: pointId,
      power: powerKw(row.puissance_nominale),
      type_2: yes(row.prise_type_2),
      combo_ccs: yes(row.prise_type_combo_ccs),
      chademo: yes(row.prise_type_chademo),
      ef: yes(row.prise_type_ef),
    });
  }
  return stations;
}

/** Does a charge point suit the filters of the configuration? */
export const pointMatches = (point, { minPower = 0, connector = 'any' } = {}) =>
  point.power >= minPower && (connector === 'any' || point[connector] === true);

// --- dynamic --------------------------------------------------------------------

const PARIS = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Paris',
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/** Offset of Paris local time from UTC at an instant, in ms. */
function parisOffsetMs(utcMs) {
  const parts = Object.fromEntries(PARIS.formatToParts(utcMs).map((p) => [p.type, p.value]));
  const local = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return local - Math.floor(utcMs / 1000) * 1000;
}

/**
 * A `horodatage` in ms. The consolidation mixes ISO dates with an offset
 * ("2026-10-22 14:34:19.975+00:00", "…T12:48:57Z") and dates without one
 * ("2026-10-22 17:43:19"), which are Paris local time: read as UTC, about a
 * tenth of them would be in the future.
 * @returns {number|null}
 */
export function parseTimestamp(value) {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(\.\d+)?\s*(Z|[+-]\d{2}:?\d{2})?$/.exec(
      String(value ?? '').trim(),
    );
  if (!match) {
    return null;
  }
  const [, y, mo, d, h, mi, s, fraction, zone] = match;
  const ms = fraction ? Math.round(Number(fraction) * 1000) : 0;
  const asUtc = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s, ms);
  if (zone === 'Z') {
    return asUtc;
  }
  if (zone) {
    const sign = zone.startsWith('-') ? -1 : 1;
    const digits = zone.slice(1).replace(':', '');
    return asUtc - sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2))) * 60000;
  }
  // Local time: the offset at the guessed instant, checked once (DST changes).
  const first = asUtc - parisOffsetMs(asUtc);
  return asUtc - parisOffsetMs(first);
}

export const STATES = ['en_service', 'hors_service', 'inconnu'];
export const OCCUPATIONS = ['libre', 'occupe', 'reserve', 'inconnu'];

/**
 * Reads the national dynamic file, keeping the charge points wanted. A point
 * listed twice (two operator feeds) keeps its most recent row.
 * @param {Set<string>} wanted charge point ids
 * @returns {Promise<{ points: Map<string, object>, lines: number }>}
 */
export async function readDynamic(fetchImpl, wanted) {
  const points = new Map();
  let columns = null;
  const lines = await getLines(fetchImpl, DYNAMIC_URL, (line) => {
    const cells = line.split(',').map((cell) => cell.replace(/^"|"$/g, ''));
    if (!columns) {
      columns = Object.fromEntries(cells.map((name, index) => [name.trim(), index]));
      for (const name of ['id_pdc_itinerance', 'etat_pdc', 'occupation_pdc', 'horodatage']) {
        if (columns[name] === undefined) {
          throw new HttpError(`${new URL(DYNAMIC_URL).host}: unexpected columns`);
        }
      }
      return;
    }
    const id = cleanId(cells[columns.id_pdc_itinerance]);
    if (!wanted.has(id)) {
      return;
    }
    const at = parseTimestamp(cells[columns.horodatage]);
    const state = cells[columns.etat_pdc];
    const occupation = cells[columns.occupation_pdc];
    if (at === null || (points.has(id) && points.get(id).at >= at)) {
      return;
    }
    points.set(id, {
      state: STATES.includes(state) ? state : 'inconnu',
      occupation: OCCUPATIONS.includes(occupation) ? occupation : 'inconnu',
      at,
    });
  });
  if (!columns) {
    throw new HttpError(`${new URL(DYNAMIC_URL).host}: empty file`);
  }
  return { points, lines };
}

/**
 * The reading of a station: its charge points matching the filters, counted
 * from their last known states.
 *   total          matching charge points
 *   live           of them, with a dynamic state younger than IGNORE_MS
 *   free           in service and free
 *   occupied       in service, occupied or reserved
 *   outOfService   out of service
 *   inService      in service, whatever the occupation
 *   newestAt       the most recent `horodatage` of the live ones (ms) or null
 *   maxPower       the most powerful matching point, kW
 */
export function stationReading(station, points, filters, now) {
  const matching = station.points.filter((point) => pointMatches(point, filters));
  const reading = {
    total: matching.length,
    live: 0,
    free: 0,
    occupied: 0,
    outOfService: 0,
    inService: 0,
    newestAt: null,
    maxPower: matching.reduce((max, point) => Math.max(max, point.power), 0),
  };
  for (const point of matching) {
    const status = points.get(point.id);
    if (!status || now - status.at > IGNORE_MS) {
      continue;
    }
    reading.live += 1;
    reading.newestAt = Math.max(reading.newestAt ?? 0, status.at);
    if (status.state === 'hors_service') {
      reading.outOfService += 1;
    } else if (status.state === 'en_service') {
      reading.inService += 1;
      if (status.occupation === 'libre') {
        reading.free += 1;
      } else if (status.occupation === 'occupe' || status.occupation === 'reserve') {
        reading.occupied += 1;
      }
    }
  }
  return reading;
}

/** Every known point out of service (and at least one known). */
export const allOutOfService = (reading) =>
  reading.live > 0 && reading.outOfService === reading.live;
