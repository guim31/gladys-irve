// -----------------------------------------------------------------------------
// Integration configuration: defaults (they mirror the `default` values of the
// manifest `config_schema`, see test/manifest.test.js) and normalization, so
// the rest of the code never deals with strings, blanks or `undefined`.
// -----------------------------------------------------------------------------

export const LANGUAGES = ['en', 'fr', 'de', 'es'];

// Seconds between two readings of the national dynamic file (1.6 MB
// compressed): five to fifteen minutes. The integration drives its own timer
// (devices are published with should_poll: false).
export const REFRESH_INTERVALS = ['300', '600', '900'];

// Search radius around the position, in km.
export const RADII = ['1', '2', '5', '10', '20'];

// Minimum power of a charge point, in kW (0: any).
export const MIN_POWERS = ['0', '7', '22', '50', '150'];

// Connector wanted: the `prise_type_*` columns of the national IRVE schema.
export const CONNECTORS = ['any', 'type_2', 'combo_ccs', 'chademo', 'ef'];

// Stations listed by id in the configuration, at most.
export const MAX_LISTED = 20;

export const DEFAULT_CONFIG = {
  house: '',
  position: '',
  radius_km: '5',
  min_power: '0',
  connector: 'any',
  stations: '',
  language: 'fr',
  refresh_interval: '600',
};

/** "43.6045, 1.444" (or "43,6045 1,444") into `{ lat, lon }`, else null. */
export function parsePosition(value) {
  const numbers = String(value ?? '')
    .trim()
    .match(/-?\d+(?:[.,]\d+)?/g);
  if (!numbers || numbers.length !== 2) {
    return null;
  }
  const [lat, lon] = numbers.map((n) => Number(n.replace(',', '.')));
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return null;
  }
  return { lat, lon };
}

/** Station ids (`id_station_itinerance`), separated by commas, spaces or lines. */
export function parseStationIds(value) {
  const ids = String(value ?? '')
    .split(/[\s,;]+/)
    .map((id) => id.trim().toUpperCase().replace(/\*/g, ''))
    .filter((id) => /^[A-Z0-9]{5,40}$/.test(id));
  return [...new Set(ids)].slice(0, MAX_LISTED);
}

const pick = (value, allowed, fallback) =>
  allowed.includes(String(value)) ? String(value) : fallback;

/**
 * @param {Record<string, unknown>} raw the configuration returned by the SDK
 */
export function normalizeConfig(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    house: typeof source.house === 'string' ? source.house.trim() : '',
    position: parsePosition(source.position),
    radiusKm: Number(pick(source.radius_km, RADII, DEFAULT_CONFIG.radius_km)),
    minPower: Number(pick(source.min_power, MIN_POWERS, DEFAULT_CONFIG.min_power)),
    connector: pick(source.connector, CONNECTORS, DEFAULT_CONFIG.connector),
    stationIds: parseStationIds(source.stations),
    language: pick(source.language, LANGUAGES, DEFAULT_CONFIG.language),
    refreshSeconds: Number(
      pick(source.refresh_interval, REFRESH_INTERVALS, DEFAULT_CONFIG.refresh_interval),
    ),
  };
}
