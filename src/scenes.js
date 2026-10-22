// -----------------------------------------------------------------------------
// Scene actions (manifest `scene_actions`, Gladys 5.1+).
//
// - find_free: among the followed stations (all of them, or the ones picked),
//   the nearest one with a free charge point, as numbers for a "Continue only
//   if" step and as a sentence ready for a message or a speaker
//   ("Parking Victor Hugo : 2 points de charge libres sur 4, à 1,2 km.").
//
// A scene action does not receive the user's language: the sentence follows
// the `language` of the configuration. Outputs are numbers, never booleans:
// the core's "Continue only if" compares with ===. A station without live
// data, out of date, or without a free charge point is never chosen. Without
// a position, the station with the most free charge points wins.
// -----------------------------------------------------------------------------

import { TEXT, say } from './messages.js';

export class SceneError extends Error {}

const chosenIds = (value) =>
  (Array.isArray(value) ? value : value ? [value] : []).map(String).filter(Boolean);

const EMPTY = {
  station_name: '',
  address: '',
  free: 0,
  total: 0,
  max_power: 0,
  distance_km: 0,
};

export const SCENE_ACTIONS = {
  async find_free(service, { fields }) {
    const language = service.config.language;
    // Asked right at start: the first reading, not "nothing free".
    await service.firstReading();
    const followed = service.followed().map((entry) => entry.deviceId);
    if (followed.length === 0) {
      throw new SceneError(say(TEXT, language, 'noStation'));
    }
    const asked = chosenIds(fields?.stations);
    const chosen = asked.filter((id) => followed.includes(id));
    if (asked.length > 0 && chosen.length === 0) {
      throw new SceneError(say(TEXT, language, 'gone'));
    }
    let best = null;
    for (const deviceId of chosen.length > 0 ? chosen : followed) {
      const found = service.lookup(deviceId);
      const reading = found?.reading;
      if (!reading || reading.free === 0 || service.isStale(reading)) {
        continue;
      }
      const distance = service.distance(found.station);
      const better =
        !best ||
        (distance !== null && best.distance !== null
          ? distance < best.distance
          : reading.free > best.reading.free);
      if (better) {
        best = { ...found, deviceId, distance };
      }
    }
    if (!best) {
      return { found: 0, sentence: say(TEXT, language, 'noneFree'), ...EMPTY };
    }
    const { station, reading, deviceId, distance } = best;
    const variables = service.variables(station, deviceId, reading);
    return {
      found: 1,
      sentence: say(TEXT, language, 'sentence', {
        name: variables.station_name,
        free: reading.free,
        total: reading.total,
        power: reading.maxPower,
        distance,
      }),
      station_name: variables.station_name,
      address: variables.address,
      free: variables.free,
      total: variables.total,
      max_power: variables.max_power,
      distance_km: variables.distance_km,
    };
  },
};
