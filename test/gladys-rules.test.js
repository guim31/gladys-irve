// -----------------------------------------------------------------------------
// Conformity with the Gladys core, on every device built from the real data
// of 2026-10-22 (30 stations around the Capitole of Toulouse, a station of an
// operator without live data, the filters on power and connector), in every
// feature-name language.
//
// The table (test/fixtures/gladys-feature-table.json) is extracted from the
// core code: a category/type couple missing there shows as "undefined" or
// without icon in Gladys, a poll frequency outside its list is a 400 on
// discovery, a feature without min/max is a 422 on "Add to Gladys".
// Do not loosen this test to make it pass: fix the integration.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { LANGUAGES } from '../src/config.js';
import { createWorld } from './helpers/world.js';

const table = JSON.parse(
  await readFile(new URL('./fixtures/gladys-feature-table.json', import.meta.url), 'utf8'),
);

const CONFIGS = [
  { radius_km: '5', stations: 'FRPKGP31555001' },
  { radius_km: '5', min_power: '50', connector: 'combo_ccs' },
];

for (const language of LANGUAGES) {
  test(`every discovered device follows the Gladys rules (${language} names)`, async (t) => {
    const devices = [];
    for (const config of CONFIGS) {
      const world = await createWorld({ config: { ...config, language } });
      t.after(() => world.app.stop());
      const ids = world.fake.discoveredDevices.map((d) => d.external_id);
      assert.equal(new Set(ids).size, ids.length, 'duplicate device external_id');
      devices.push(...world.fake.discoveredDevices);
    }
    assert.ok(devices.length >= 31, `${devices.length} devices`);
    assert.ok(devices.some((d) => d.params.some((p) => p.value === 'FRPKGP31555001')));

    const deviceIds = new Set();
    const unique = [...new Map(devices.map((d) => [d.external_id, d])).values()];
    for (const device of unique) {
      const where = device.name;
      assert.ok(!deviceIds.has(device.external_id), `${where}: duplicate device external_id`);
      deviceIds.add(device.external_id);

      // should_poll: true if and only if poll_frequency is provided, in ms.
      if (device.poll_frequency === undefined) {
        assert.notEqual(device.should_poll, true, `${where}: should_poll without poll_frequency`);
      } else {
        assert.equal(device.should_poll, true, `${where}: poll_frequency without should_poll`);
        assert.ok(
          table.poll_frequencies_ms.includes(device.poll_frequency),
          `${where}: poll_frequency ${device.poll_frequency} is not one of ${table.poll_frequencies_ms}`,
        );
      }

      assert.ok(device.features.length > 0, `${where}: no feature`);
      const externalIds = new Set();
      const names = new Set();
      for (const feature of device.features) {
        const at = `${where} / ${feature.name}`;
        const pair = table.pairs[`${feature.category}/${feature.type}`];
        assert.ok(pair, `${at}: ${feature.category}/${feature.type} is not a couple Gladys knows`);
        assert.ok(
          pair.label_en && pair.label_fr && pair.icon,
          `${at}: couple without label or icon`,
        );

        assert.equal(typeof feature.min, 'number', `${at}: min must be a number`);
        assert.equal(typeof feature.max, 'number', `${at}: max must be a number`);
        assert.ok(
          Number.isFinite(feature.min) && Number.isFinite(feature.max),
          `${at}: finite min/max`,
        );
        assert.ok(feature.min <= feature.max, `${at}: min > max`);
        assert.equal(typeof feature.read_only, 'boolean', `${at}: read_only must be a boolean`);
        assert.equal(
          typeof feature.has_feedback,
          'boolean',
          `${at}: has_feedback must be a boolean`,
        );
        if (feature.unit !== undefined) {
          assert.ok(table.units.includes(feature.unit), `${at}: unknown unit ${feature.unit}`);
        }

        assert.ok(!externalIds.has(feature.external_id), `${at}: duplicate external_id`);
        externalIds.add(feature.external_id);
        assert.ok(!names.has(feature.name), `${at}: duplicate feature name on the device`);
        names.add(feature.name);
      }
    }
  });
}
