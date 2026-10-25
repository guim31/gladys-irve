# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [1.0.1] - 2026-10-25

### Fixed

- The widget shows the name given to a station in Gladys (Devices tab), and
  follows a rename at once, instead of the operator's name.

## [1.0.0] - 2026-10-22

### Added

- Live availability of the public EV charging stations around your house in
  France, from the national IRVE open data (data.gouv.fr and
  transport.data.gouv.fr): no account, no key.
- The stations within 1 to 20 km of your house (or of a position you type), or
  listed by id, that publish their live state show in the Discover tab: one
  device each with free charge points, charge points, out of service, maximum
  power and data age, read every 5, 10 or 15 minutes. Filters on the minimum
  power and the connector.
- Dashboard widget "Charging stations": one row per station, green when a
  charge point is free, red when all are taken or out of service, grey without
  live data or out of date.
- Scene triggers: a charge point becomes free (optionally only after the
  station was all taken), station all taken, station out of service.
- Scene action "Find the nearest free station", with a sentence ready to send.
- Configuration actions "Status" and "Find a station" (by town or street, to
  follow a station far from home).
- Texts and documentation in English, French, German and Spanish.

[Unreleased]: https://github.com/guim31/gladys-irve/compare/v1.0.1...HEAD
[1.0.1]: https://github.com/guim31/gladys-irve/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/guim31/gladys-irve/releases/tag/v1.0.0
