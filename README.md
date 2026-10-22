# Gladys EV charging stations (IRVE)

External integration for [Gladys Assistant](https://gladysassistant.com): the
**live availability of the public EV charging stations** around your house, in
France, from the national IRVE open data: the static base of data.gouv.fr
matched with the national real-time consolidation of transport.data.gouv.fr.
**No account, no key.**

Unofficial: not affiliated with the charging operators, data.gouv.fr or
transport.data.gouv.fr. Developed without the hardware (no electric car at
hand): the data was checked live on 2026-10-22, feedback welcome.

User documentation: [English](docs/en.md) · [français](docs/fr.md) ·
[Deutsch](docs/de.md) · [español](docs/es.md).

## What you get in Gladys

| Kind                  | Content                                                                                  |
| --------------------- | ---------------------------------------------------------------------------------------- |
| Devices               | one per station added: free charge points, charge points, out of service, max power, age |
| Dashboard widget      | "Charging stations": one row per station, green when a point is free                     |
| Scene triggers        | a charge point becomes free, station all taken, station out of service                   |
| Scene action          | find the nearest followed station with a free point: a sentence and numbers              |
| Configuration actions | status (position, stations, live data, errors), find a station by town or street         |

Requires Gladys **5.2.0** or later (a house select in the configuration, and
`location: true` to read the position of the houses).

## Installation

In Gladys: **Integrations → Install from GitHub**, then
`https://github.com/guim31/gladys-irve`. Locate your house in Gladys (Settings →
Houses), pick a radius, then add your stations from the **Discover** tab.

## How it works

- **Static data**: the "Base nationale des IRVE" consolidation of data.gouv.fr,
  queried through the data.gouv.fr tabular API on the box around the circle (or
  by station ids): a few hundred rows instead of the 90 MB file, once a day.
- **Live data**: the national IRVE dynamic consolidation of
  transport.data.gouv.fr (beta, about 125,000 charge points, 1.6 MB
  compressed), read line by line every 5, 10 or 15 minutes; only the charge
  points of the stations around are kept. Devices are published with
  `should_poll: false`: the container runs its own timer.
- Only the stations with at least one charge point published live are
  offered. A station whose newest state is older than 48 hours is out of date:
  grey in the widget, never chosen by the scene action, never compared by the
  triggers; a charge point state older than 7 days is ignored.

## Limitations

- Coverage depends on the operators: many publish no live state yet (on
  2026-10-22, a little more than half of the public charge points of Toulouse
  had one).
- Public stations in France only. No prices, no booking. Read only.

## Development

```bash
npm install
npm test               # node --test, no network access
npm run lint           # ESLint
npm run format:check   # Prettier, as the CI runs it
npx github:GladysAssistant/integration-store .   # store admission checks
```

See [CLAUDE.md](CLAUDE.md) for the architecture and the conventions. The test
fixtures (`test/fixtures/irve`) are real data captured on 2026-10-22: the
charge points within 3 km of the Capitole of Toulouse and their rows of the
national dynamic file.

## Credits

- Data: [Base nationale des IRVE](https://www.data.gouv.fr/datasets/5448d3e0c751df01f85d0572/)
  (data.gouv.fr, Etalab) and the
  [IRVE dynamic consolidation](https://transport.data.gouv.fr/datasets/685965d0ab901919e14a4a1b)
  (transport.data.gouv.fr), under the Licence Ouverte 2.0.
- Built from the official
  [integration template](https://github.com/GladysAssistant/integration-template-js).

## License

[Apache 2.0](LICENSE).
