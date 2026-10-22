// -----------------------------------------------------------------------------
// Dashboard widget (manifest `widgets`, Gladys 5.1+).
//
// - stations: the followed stations, one status row each ("Parking Victor
//   Hugo" / "2 / 4 libres"), green with a free charge point, red when all
//   are taken or out of service, orange with no free point but occupations
//   unknown, grey without live data or out of date.
//
// Budget of the core: 8 components, 2 texts, 1 status (10 rows).
// -----------------------------------------------------------------------------

import { WIDGET_COLORS } from '@gladysassistant/integration-sdk';
import { clip, prettyName } from './devices.js';
import { allOutOfService, isFull } from './irve.js';
import { TEXT, say } from './messages.js';

export const MAX_ROWS = 10;
const MAX_LABEL = 40;

/** The color of a row. */
export function stationColor(service, reading) {
  if (!reading || reading.live === 0 || reading.total === 0 || service.isStale(reading)) {
    return WIDGET_COLORS.NEUTRAL;
  }
  if (allOutOfService(reading) || isFull(reading)) {
    return WIDGET_COLORS.DANGER;
  }
  // No free point, but some occupations unknown: not "all taken".
  return reading.free > 0 ? WIDGET_COLORS.SUCCESS : WIDGET_COLORS.WARNING;
}

async function stationsContent(service, { settings, language }) {
  await service.firstReading();
  const ttl = Math.max(60, service.config.refreshSeconds);
  const followed = service.followed();
  const chosen = Array.isArray(settings?.stations) ? settings.stations.map(String) : [];
  const entries =
    chosen.length > 0
      ? chosen.map((id) => followed.find((entry) => entry.deviceId === id)).filter(Boolean)
      : followed;
  if (entries.length === 0) {
    const key = chosen.length > 0 ? 'gone' : 'pickStation';
    return { ttl_seconds: ttl, components: [{ type: 'text', text: say(TEXT, language, key) }] };
  }
  return {
    ttl_seconds: ttl,
    components: [
      {
        type: 'status',
        items: entries.slice(0, MAX_ROWS).map((entry) => {
          const found = service.lookup(entry.deviceId);
          const reading = found?.reading ?? null;
          return {
            label: clip(found ? prettyName(found.station.name) : entry.name, MAX_LABEL),
            value: clip(service.shortText(reading, language), 40),
            color: stationColor(service, reading),
          };
        }),
      },
    ],
  };
}

export const WIDGETS = {
  stations: { get: stationsContent },
};
