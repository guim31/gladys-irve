// -----------------------------------------------------------------------------
// Texts sent from the container (feature names, action messages, widget
// contents, scene outputs), in the four languages of the Gladys interface.
// Entries are strings or functions of one parameter object. German says "du",
// Spanish "usted". Brand and place names never translate.
// -----------------------------------------------------------------------------

export const INIT_FAILED = {
  en: 'Initialization failed, check the integration logs.',
  fr: "L'initialisation a échoué, consultez les logs de l'intégration.",
  de: 'Initialisierung fehlgeschlagen, sieh dir die Protokolle der Integration an.',
  es: 'La inicialización ha fallado, consulte los registros de la integración.',
};

// Feature names, frozen when the device is created (configured language).
export const NAMES = {
  en: {
    free: 'Free charge points',
    total: 'Charge points',
    out_of_service: 'Out of service',
    max_power: 'Maximum power',
    age: 'Data age',
  },
  fr: {
    free: 'Points de charge libres',
    total: 'Points de charge',
    out_of_service: 'Hors service',
    max_power: 'Puissance maximale',
    age: 'Âge de la donnée',
  },
  de: {
    free: 'Freie Ladepunkte',
    total: 'Ladepunkte',
    out_of_service: 'Außer Betrieb',
    max_power: 'Maximale Leistung',
    age: 'Alter der Daten',
  },
  es: {
    free: 'Puntos de carga libres',
    total: 'Puntos de carga',
    out_of_service: 'Fuera de servicio',
    max_power: 'Potencia máxima',
    age: 'Antigüedad del dato',
  },
};

const plural = (count, one, many) => (count === 1 ? one : many);
const pluralFr = (count, one, many) => (count > 1 ? many : one);
const km = (distance, comma) => {
  const text = distance < 10 ? distance.toFixed(1) : String(Math.round(distance));
  return comma ? text.replace('.', ',') : text;
};

// Widget contents and scene outputs.
export const TEXT = {
  en: {
    counts: ({ free, total }) => `${free} / ${total} free`,
    full: 'all taken',
    outOfService: 'out of service',
    stale: 'data out of date',
    noLive: 'no live data',
    noPoint: 'no matching point',
    sentence: ({ name, free, total, distance, power }) =>
      `${name}: ${free} free charge ${plural(free, 'point', 'points')} out of ${total}` +
      `${power ? `, up to ${power} kW` : ''}${distance !== null ? `, ${km(distance)} km away` : ''}.`,
    noneFree: 'No followed charging station has a free charge point right now.',
    pickStation: 'Add a station in the Discover tab of the integration, then pick it here.',
    gone: 'This station is no longer followed.',
    noStation: 'No station is followed: add one in the Discover tab of the integration.',
  },
  fr: {
    counts: ({ free, total }) => `${free} / ${total} ${pluralFr(free, 'libre', 'libres')}`,
    full: 'tout est occupé',
    outOfService: 'hors service',
    stale: 'donnée périmée',
    noLive: 'pas de données en direct',
    noPoint: 'aucun point compatible',
    sentence: ({ name, free, total, distance, power }) =>
      `${name} : ${free} ${pluralFr(free, 'point de charge libre', 'points de charge libres')} sur ${total}` +
      `${power ? `, jusqu'à ${String(power).replace('.', ',')} kW` : ''}` +
      `${distance !== null ? `, à ${km(distance, true)} km` : ''}.`,
    noneFree: "Aucune station suivie n'a de point de charge libre en ce moment.",
    pickStation:
      "Ajoutez une station dans l'onglet Découverte de l'intégration, puis choisissez-la ici.",
    gone: "Cette station n'est plus suivie.",
    noStation:
      "Aucune station n'est suivie : ajoutez-en une dans l'onglet Découverte de l'intégration.",
  },
  de: {
    counts: ({ free, total }) => `${free} / ${total} frei`,
    full: 'alle belegt',
    outOfService: 'außer Betrieb',
    stale: 'Daten veraltet',
    noLive: 'keine Live-Daten',
    noPoint: 'kein passender Ladepunkt',
    sentence: ({ name, free, total, distance, power }) =>
      `${name}: ${free} ${plural(free, 'freier Ladepunkt', 'freie Ladepunkte')} von ${total}` +
      `${power ? `, bis ${String(power).replace('.', ',')} kW` : ''}` +
      `${distance !== null ? `, ${km(distance, true)} km entfernt` : ''}.`,
    noneFree: 'Keine verfolgte Ladestation hat gerade einen freien Ladepunkt.',
    pickStation: 'Füge eine Station im Tab „Entdecken“ der Integration hinzu und wähle sie hier.',
    gone: 'Diese Station wird nicht mehr verfolgt.',
    noStation: 'Keine Station wird verfolgt: füge eine im Tab „Entdecken“ der Integration hinzu.',
  },
  es: {
    counts: ({ free, total }) => `${free} / ${total} ${plural(free, 'libre', 'libres')}`,
    full: 'todo ocupado',
    outOfService: 'fuera de servicio',
    stale: 'dato caducado',
    noLive: 'sin datos en directo',
    noPoint: 'ningún punto compatible',
    sentence: ({ name, free, total, distance, power }) =>
      `${name}: ${free} ${plural(free, 'punto de carga libre', 'puntos de carga libres')} de ${total}` +
      `${power ? `, hasta ${String(power).replace('.', ',')} kW` : ''}` +
      `${distance !== null ? `, a ${km(distance, true)} km` : ''}.`,
    noneFree: 'Ninguna estación seguida tiene un punto de carga libre en este momento.',
    pickStation:
      'Añada una estación en la pestaña Descubrir de la integración y luego elíjala aquí.',
    gone: 'Esta estación ya no se sigue.',
    noStation: 'No se sigue ninguna estación: añada una en la pestaña Descubrir de la integración.',
  },
};

// Answers of the configuration actions ("Status", "Search").
export const REPORTS = {
  en: {
    noPosition:
      'No position: locate your house in Gladys (Settings → Houses), or enter a position or station ids above.',
    position: ({ name, radius }) => `■ Around ${name}, ${radius} km`,
    shrunk: ({ radius }) => `Too many charge points in this area: radius reduced to ${radius} km.`,
    stations: ({ count, live }) =>
      `${count} station${count === 1 ? '' : 's'} found, ${live} with live data (offered in Discover).`,
    read: ({ age }) => `Live data read ${age} s ago.`,
    waiting: 'Not read yet.',
    error: ({ error }) => `Last error: ${error}`,
    missing: ({ ids }) => `Unknown station ids: ${ids}`,
    followed: ({ count }) => `${count} station${count === 1 ? '' : 's'} added to Gladys.`,
    noResult: ({ query }) => `No station address contains "${query}".`,
    shortQuery: 'Type at least 3 characters (a town, a street).',
    result: ({ id, name, address, points, power }) =>
      `${id} · ${name} · ${address} (${points} point${points === 1 ? '' : 's'}, ${power} kW)`,
    more: ({ count }) => `…and ${count} more: refine the search.`,
  },
  fr: {
    noPosition:
      'Aucune position : localisez votre maison dans Gladys (Paramètres → Maisons), ou saisissez une position ou des identifiants de stations ci-dessus.',
    position: ({ name, radius }) => `■ Autour de ${name}, ${radius} km`,
    shrunk: ({ radius }) =>
      `Trop de points de charge dans cette zone : rayon réduit à ${String(radius).replace('.', ',')} km.`,
    stations: ({ count, live }) =>
      `${count} station${count > 1 ? 's' : ''} trouvée${count > 1 ? 's' : ''}, ${live} avec données en direct (proposées dans Découverte).`,
    read: ({ age }) => `Données en direct lues il y a ${age} s.`,
    waiting: 'Pas encore lu.',
    error: ({ error }) => `Dernière erreur : ${error}`,
    missing: ({ ids }) => `Identifiants de stations inconnus : ${ids}`,
    followed: ({ count }) =>
      `${count} station${count > 1 ? 's' : ''} ajoutée${count > 1 ? 's' : ''} à Gladys.`,
    noResult: ({ query }) => `Aucune adresse de station ne contient « ${query} ».`,
    shortQuery: 'Saisissez au moins 3 caractères (une commune, une rue).',
    result: ({ id, name, address, points, power }) =>
      `${id} · ${name} · ${address} (${points} point${points > 1 ? 's' : ''}, ${String(power).replace('.', ',')} kW)`,
    more: ({ count }) => `…et ${count} de plus : affinez la recherche.`,
  },
  de: {
    noPosition:
      'Keine Position: lege den Standort deines Hauses in Gladys fest (Einstellungen → Zuhause) oder gib oben eine Position oder Stations-IDs ein.',
    position: ({ name, radius }) => `■ Um ${name}, ${radius} km`,
    shrunk: ({ radius }) =>
      `Zu viele Ladepunkte in diesem Gebiet: Radius auf ${String(radius).replace('.', ',')} km verkleinert.`,
    stations: ({ count, live }) =>
      `${count} ${count === 1 ? 'Station' : 'Stationen'} gefunden, ${live} mit Live-Daten (in „Entdecken“ angeboten).`,
    read: ({ age }) => `Live-Daten vor ${age} s gelesen.`,
    waiting: 'Noch nicht gelesen.',
    error: ({ error }) => `Letzter Fehler: ${error}`,
    missing: ({ ids }) => `Unbekannte Stations-IDs: ${ids}`,
    followed: ({ count }) =>
      `${count} ${count === 1 ? 'Station' : 'Stationen'} zu Gladys hinzugefügt.`,
    noResult: ({ query }) => `Keine Stationsadresse enthält „${query}“.`,
    shortQuery: 'Gib mindestens 3 Zeichen ein (einen Ort, eine Straße).',
    result: ({ id, name, address, points, power }) =>
      `${id} · ${name} · ${address} (${points} ${points === 1 ? 'Ladepunkt' : 'Ladepunkte'}, ${String(power).replace('.', ',')} kW)`,
    more: ({ count }) => `…und ${count} weitere: verfeinere die Suche.`,
  },
  es: {
    noPosition:
      'Sin posición: ubique su casa en Gladys (Configuración → Viviendas), o introduzca una posición o identificadores de estaciones arriba.',
    position: ({ name, radius }) => `■ Alrededor de ${name}, ${radius} km`,
    shrunk: ({ radius }) =>
      `Demasiados puntos de carga en esta zona: radio reducido a ${String(radius).replace('.', ',')} km.`,
    stations: ({ count, live }) =>
      `${count} ${count === 1 ? 'estación encontrada' : 'estaciones encontradas'}, ${live} con datos en directo (propuestas en Descubrir).`,
    read: ({ age }) => `Datos en directo leídos hace ${age} s.`,
    waiting: 'Aún no leído.',
    error: ({ error }) => `Último error: ${error}`,
    missing: ({ ids }) => `Identificadores de estaciones desconocidos: ${ids}`,
    followed: ({ count }) =>
      `${count} ${count === 1 ? 'estación añadida' : 'estaciones añadidas'} a Gladys.`,
    noResult: ({ query }) => `Ninguna dirección de estación contiene «${query}».`,
    shortQuery: 'Introduzca al menos 3 caracteres (un municipio, una calle).',
    result: ({ id, name, address, points, power }) =>
      `${id} · ${name} · ${address} (${points} punto${points === 1 ? '' : 's'}, ${String(power).replace('.', ',')} kW)`,
    more: ({ count }) => `…y ${count} más: afine la búsqueda.`,
  },
};

/** One text of a table, in a language (English when missing). */
export function say(table, language, key, params = {}) {
  const entry = table[language]?.[key] ?? table.en[key];
  return typeof entry === 'function' ? entry(params) : entry;
}

/** The same text in every language of the table: `{ en, fr, de, es }`. */
export function render(table, key, params = {}) {
  return Object.fromEntries(
    Object.keys(table).map((language) => [language, say(table, language, key, params)]),
  );
}

/** Joins rendered messages (or plain strings), language by language, one per line. */
export function lines(...messages) {
  const languages = Object.keys(messages.find((m) => typeof m === 'object' && m) ?? { en: '' });
  return Object.fromEntries(
    languages.map((language) => [
      language,
      messages
        .filter((message) => message !== null && message !== undefined)
        .map((message) => (typeof message === 'string' ? message : message[language]))
        .join('\n'),
    ]),
  );
}
