// -----------------------------------------------------------------------------
// The Gladys device of a charging station and its states. Counts are over the
// charge points matching the filters of the configuration (power, connector):
//   free            counter-sensor/integer   charge points in service and free
//   total           counter-sensor/integer   charge points
//   out_of_service  counter-sensor/integer   charge points out of service
//   max_power       energy-sensor/power, kW  most powerful charge point
//   age             duration/integer, min    age of the newest state published
//                                            by the operator
//
// Read-only, no polling: the integration reads the national files on its own
// timer (src/service.js), Gladys never polls (`should_poll: false`).
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { NAMES } from './messages.js';

export const STATION_TYPE = 'station';
export const MAX_DEVICE_NAME = 80;
// A week, in minutes: an older state is ignored anyway (IGNORE_MS).
export const MAX_AGE_MINUTES = 10080;
export const MAX_POWER_KW = 400;

export const FEATURE_KEYS = ['free', 'total', 'out_of_service', 'max_power', 'age'];

/** Shortens a text to `max` characters, with an ellipsis. */
export function clip(text, max) {
  const value = String(text ?? '');
  return value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`;
}

/** A piece of an external id: letters, digits, "_" and "-" only. */
export const slug = (value) =>
  String(value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');

/** "Parking Victor Hugo" from the operator's "PARKING VICTOR HUGO"; names already in mixed case stay. */
export function prettyName(name) {
  const small = new Set(['de', 'du', 'des', 'la', 'le', 'les', 'et', 'sur', 'aux', 'au', 'en']);
  const value = String(name ?? '').trim();
  if (value !== value.toUpperCase() || !/\p{L}{2}/u.test(value)) {
    return value;
  }
  return value
    .toLowerCase()
    .split(/(\s+|-|'|’)/)
    .map((word, index, words) => {
      if (!/\p{L}/u.test(word)) {
        return word;
      }
      if ((word === 'd' || word === 'l') && /^['’]$/.test(words[index + 1] ?? '') && index > 0) {
        return word;
      }
      if (small.has(word) && index > 0) {
        return word;
      }
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join('');
}

/** Display bound of the counters: the station size rounded up to the ten. */
export const countMax = (total) => Math.max(10, Math.ceil((total ?? 0) / 10) * 10);

export const stationIds = (gladys, station) => gladys.externalIds(STATION_TYPE, slug(station.id));

/**
 * The device of a station.
 * @param {object} gladys
 * @param {object} station from buildStations
 * @param {object} reading from stationReading
 * @param {string} language
 */
export function buildStationDevice(gladys, station, reading, language) {
  const ids = stationIds(gladys, station);
  const names = NAMES[language] ?? NAMES.en;
  const max = countMax(station.points.length);
  const counter = { category: C.COUNTER_SENSOR, type: T.SENSOR.INTEGER, min: 0, max };
  const definitions = {
    free: counter,
    total: counter,
    out_of_service: counter,
    max_power: {
      category: C.ENERGY_SENSOR,
      type: T.ENERGY_SENSOR.POWER,
      unit: U.KILOWATT,
      min: 0,
      max: MAX_POWER_KW,
    },
    age: {
      category: C.DURATION,
      type: T.DURATION.INTEGER,
      unit: U.MINUTES,
      min: 0,
      max: MAX_AGE_MINUTES,
    },
  };
  return {
    name: clip(prettyName(station.name), MAX_DEVICE_NAME),
    external_id: ids.device,
    should_poll: false,
    params: [
      { name: 'station_id', value: station.id },
      ...(station.operator ? [{ name: 'operator', value: station.operator }] : []),
      ...(station.address ? [{ name: 'address', value: station.address }] : []),
    ],
    features: FEATURE_KEYS.map((key) => ({
      name: names[key],
      external_id: ids.feature(key),
      ...definitions[key],
      read_only: true,
      has_feedback: false,
    })),
  };
}

/**
 * The states of a station device. Without any live charge point, only the
 * static values (total, power) are published: the last counts stay.
 */
export function stationStates(gladys, station, reading, now) {
  const ids = stationIds(gladys, station);
  const live = reading.live > 0;
  const values = {
    free: live ? reading.free : null,
    total: reading.total,
    out_of_service: live ? reading.outOfService : null,
    max_power: reading.maxPower,
    age: live
      ? Math.min(MAX_AGE_MINUTES, Math.max(0, Math.floor((now - reading.newestAt) / 60000)))
      : null,
  };
  return FEATURE_KEYS.filter((key) => values[key] !== null).map((key) => ({
    device_feature_external_id: ids.feature(key),
    state: values[key],
  }));
}
