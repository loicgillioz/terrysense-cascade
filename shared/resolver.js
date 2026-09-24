/*
 * Cascade resolver — shared by the `config_overrides` and `channel_map_editor`
 * widgets (and their offline tests). Pure resolution logic only: every call
 * that reaches ThingsBoard goes through an injected `io` object, so this file
 * has no `ctx`/`container` dependency and loads unchanged in a browser
 * (`window.TerrySenseResolver`) or in Node (`module.exports`, see
 * `tests/test_resolver.js`).
 *
 * Port of `logr-cloud-tool/terrysense/operations/config_resolver.py`, extended
 * per `logr-product-docs/cloud/CONFIG_CASCADE.md` with the CUSTOMER and
 * DEFAULTS rungs the Python resolver does not have yet (another change is
 * adding those there separately — keep this in sync by hand meanwhile, the
 * same trade-off `alarm_cascade_editor/controller.js` already lived with for
 * the STATION/LOCATION/PROJECT/TENANT chain).
 *
 * Chain (nearest first): STATION -> (LOCATION) -> PROJECT, via `Contains`,
 * then CUSTOMER (the top asset's owner, skipped when tenant-owned), then the
 * DEFAULTS asset (tenant-owned, shared read-only with customers). The TENANT
 * entity itself is never read — a customer-admin user gets 403 on it.
 *
 * `io` contract (every method returns a Promise, so this loads identically
 * against real ThingsBoard services or a synchronous test fixture wrapped in
 * `Promise.resolve`):
 *
 *   fetchAttrs(entity)     -> {key: value}            SERVER_SCOPE attributes
 *   fetchParent(entity)    -> {entityType:'ASSET', id, name, kind} | null
 *   fetchChildren(entity)  -> [{entityType:'ASSET', id, name, kind}]
 *   fetchCustomer(entity)  -> {entityType:'CUSTOMER', id, name} | null
 *   fetchDefaults()        -> {entityType:'ASSET', id, name} | null
 *   fetchTimeseriesKinds(entity) -> {channel: kind|null}   optional
 *
 * `entity` / level objects carry `{entityType, id, name, kind}` — `kind` is
 * the ThingsBoard asset *type* string ("Station", "Project", "Defaults", …),
 * never the measurement kind. A resolved chain level also carries `role`:
 * `"chain"` for an ordinary Contains-linked asset (Station/Location/Project),
 * `"customer"` for the CUSTOMER rung, `"defaults"` for the DEFAULTS asset —
 * that role, not the TB type string, is what decides channel-axis eligibility
 * below, so the chain walk works whatever a tenant calls its asset types.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.TerrySenseResolver = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

var CONFIG_PREFIX = 'config.';
var CHANNEL_PREFIX = 'channel.';
var KIND_PREFIX = 'kind.';
var EFFECTIVE_PREFIX = 'effective.';

var PER_KEY_FIELDS = ['unit', 'hysteresis', 'textWhenTrue', 'textWhenFalse'];
var SEVERITIES = ['warning', 'minor', 'major', 'critical'];
var ALARM_FIELDS = ['thresholdMax', 'thresholdMin', 'state', 'debounce'];
var ALARM_TEXT_EVENTS = ['created', 'cleared'];

// Axis-less scalars beyond ttlDays, which is handled apart (the only one the
// hot path consumes as a unit — CONFIG_RESOLVER.md §3).
var SCALAR_KEYS = ['language', 'url', 'sms.recipients', 'sms.enabled', 'email.recipients', 'email.enabled']
  .concat(ALARM_TEXT_EVENTS.map(function (e) { return 'alarmText.' + e; }));

// Decoder SI units per kind — CONFIG_CASCADE.md §1, mirrors config_resolver.py.
var DECODER_UNITS = {
  temperature: '°C', humidity: '%', pressure: 'hPa', ph: 'pH', conductivity: 'µS/cm',
  distance: 'm', flow: 'm³/h', volume: 'm³', angle: '°', voltage: 'V', current: 'A',
  power: 'W', percent: '%', duration: 's'
};

// CONFIG_CASCADE.md §4: derived channels sharing one kind across incompatible
// scales, deliberately left off the kind axis — never offered as an
// "Add override" target.
var NEVER_KIND_TARGETS = ['ANGLE', 'DISTANCE'];

// -- kind spelling ------------------------------------------------------
// Wire kind (SNAKE_CASE / UPPER) -> cloud kind (camelCase). Idempotent, mirrors
// camel_kind() in terrysense/utils/keys.py and camelKind() in the decoder.

function segment(token) {
  return token === token.toUpperCase() ? token.toLowerCase() : token;
}

function camelKind(kind) {
  var parts = String(kind || '').trim().split('_').filter(function (p) { return p; });
  if (!parts.length) { return ''; }
  var head = segment(parts[0]);
  head = head.charAt(0).toLowerCase() + head.slice(1);
  return head + parts.slice(1).map(function (p) {
    var s = segment(p);
    return s.charAt(0).toUpperCase() + s.slice(1);
  }).join('');
}

/** Cloud kind -> catalog wire spelling: the inverse of `camelKind`, so a
 * `config.channelMap` entry written from a device's own (already-camelCased)
 * `subscriptions.<sourceKey>` uses the exact same `kind` string
 * `app/lib/catalog.py::channel_entry` writes for a v2-onboarding-built map —
 * one schema for both write paths, not two. Splits at each lower-to-upper
 * boundary, matching every kind in `logr-peripheral-catalog/catalog.json`
 * today (verified by round-trip against the full catalog kind list, see
 * `tests/test_resolver.js`); idempotent on an already-wire-spelled input,
 * same as `camelKind`. */
function wireKind(kind) {
  return String(kind || '').replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
}

// -- override key categories --------------------------------------------
// The vocabulary the `config_overrides` widget's "Add override" stepper and
// list grouping both read from, so the two never drift apart. `field` names
// the channel/kind-axis field; `scalarField` names the axis-less `config.`
// field. Exactly one of the two is set.

var CATEGORIES = [
  { id: 'alarmMax', label: 'Alarm limit · max', perMeasurement: true, numeric: true, field: 'alarm.critical.thresholdMax' },
  { id: 'alarmMin', label: 'Alarm limit · min', perMeasurement: true, numeric: true, field: 'alarm.critical.thresholdMin' },
  { id: 'unit', label: 'Unit', perMeasurement: true, numeric: false, field: 'unit' },
  { id: 'hysteresis', label: 'Hysteresis', perMeasurement: true, numeric: true, field: 'hysteresis' },
  { id: 'retention', label: 'Retention', perMeasurement: false, numeric: true, scalarField: 'ttlDays', suffix: 'day' },
  { id: 'alarmTextCreated', label: 'Alarm text · created', perMeasurement: false, scalarField: 'alarmText.created' },
  { id: 'alarmTextCleared', label: 'Alarm text · cleared', perMeasurement: false, scalarField: 'alarmText.cleared' },
  { id: 'language', label: 'Language', perMeasurement: false, scalarField: 'language' },
  { id: 'smsRecipients', label: 'SMS recipients', perMeasurement: false, scalarField: 'sms.recipients', list: true },
  { id: 'emailRecipients', label: 'E-mail recipients', perMeasurement: false, scalarField: 'email.recipients', list: true },
  { id: 'smsEnabled', label: 'SMS on/off', perMeasurement: false, scalarField: 'sms.enabled', boolean: true },
  { id: 'emailEnabled', label: 'E-mail on/off', perMeasurement: false, scalarField: 'email.enabled', boolean: true }
];

// Alarm-text template tokens (FRONTEND.md / ALARMING.md wording), offered
// verbatim by the "Add override" stepper next to the created/cleared inputs.
var ALARM_TEXT_TOKENS = ['${channel}', '${value}', '${unit}', '${threshold}', '${stationName}', '${ssUrl}'];

function categoryByField(field) {
  for (var i = 0; i < CATEGORIES.length; i++) {
    if (CATEGORIES[i].field === field) { return CATEGORIES[i]; }
  }
  return null;
}

function categoryByScalarField(field) {
  for (var i = 0; i < CATEGORIES.length; i++) {
    if (CATEGORIES[i].scalarField === field) { return CATEGORIES[i]; }
  }
  return null;
}

// -- override key parsing -------------------------------------------------

function parseOverrideKey(key) {
  if (key.indexOf(CHANNEL_PREFIX) === 0) {
    var crest = key.slice(CHANNEL_PREFIX.length);
    var cdot = crest.indexOf('.');
    if (cdot < 0) { return null; }
    return { axis: 'channel', target: crest.slice(0, cdot), field: crest.slice(cdot + 1) };
  }
  if (key.indexOf(KIND_PREFIX) === 0) {
    var krest = key.slice(KIND_PREFIX.length);
    var kdot = krest.indexOf('.');
    if (kdot < 0) { return null; }
    return { axis: 'kind', target: krest.slice(0, kdot), field: krest.slice(kdot + 1) };
  }
  if (key.indexOf(CONFIG_PREFIX) === 0) {
    return { axis: 'config', target: null, field: key.slice(CONFIG_PREFIX.length) };
  }
  return null;
}

/** Plain-words label + grouping key for one override key, for the list view. */
function describeOverride(key) {
  var parsed = parseOverrideKey(key);
  if (!parsed) { return { label: key, group: key }; }
  if (parsed.axis === 'config') {
    var scalarCat = categoryByScalarField(parsed.field);
    var label = scalarCat ? scalarCat.label : parsed.field;
    return { label: label, group: label, category: scalarCat };
  }
  var cat = categoryByField(parsed.field);
  var base = cat ? cat.label : parsed.field;
  if (parsed.axis === 'kind') {
    return { label: base + ' · ' + parsed.target + ' (all ' + parsed.target + ' sensors)', group: base, category: cat };
  }
  return { label: base + ' · ' + parsed.target, group: base, category: cat };
}

/** Every override key set on `attrs` that maps to an editable category —
 * structural keys (`config.channelMap`, `config.channelNames`), `config.url`
 * and unknown fields are never listed. */
function listOverrides(attrs) {
  var out = [];
  Object.keys(attrs || {}).forEach(function (key) {
    if (describeOverride(key).category) { out.push({ key: key, value: attrs[key] }); }
  });
  out.sort(function (a, b) { return a.key < b.key ? -1 : a.key > b.key ? 1 : 0; });
  return out;
}

// -- channel field list ---------------------------------------------------
// Every `<field>` a channel is resolved for, kind-agnostic — mirrors
// config_resolver.py's `_channel_fields()`. A field unset anywhere on the
// chain simply produces no entry; nothing here decides what is *applicable*
// for a kind (that is a UI concern, not a resolution one).

function channelFields() {
  var fields = PER_KEY_FIELDS.slice();
  SEVERITIES.forEach(function (sev) {
    ALARM_FIELDS.forEach(function (f) { fields.push('alarm.' + sev + '.' + f); });
  });
  return fields;
}

// -- chain walk -------------------------------------------------------------

function levelDisplay(level) {
  // Mirrors Level.display in config_resolver.py exactly — the two resolvers
  // must agree on these strings, since a UI showing "replaces X from Y" is
  // meaningless if Y reads differently depending on which resolver produced it.
  if (level.role === 'customer') { return 'Customer defaults · ' + level.name; }
  if (level.role === 'defaults') { return 'in-terra defaults'; }
  return (level.kind || 'Asset') + ' · ' + level.name;
}

/** Nearest-first chain for `origin` — a STATION/LOCATION/PROJECT asset, the
 * CUSTOMER entity, or the DEFAULTS asset itself. Walks `Contains` up from an
 * ordinary asset, then appends CUSTOMER (unless tenant-owned) and DEFAULTS. */
function buildChain(origin, io) {
  if (origin.entityType === 'CUSTOMER') {
    return appendDefaults([{ entityType: 'CUSTOMER', id: origin.id, name: origin.name, kind: 'Customer', role: 'customer' }], io);
  }
  if (String(origin.kind || '').toLowerCase() === 'defaults') {
    return Promise.resolve([{ entityType: 'ASSET', id: origin.id, name: origin.name, kind: origin.kind, role: 'defaults' }]);
  }

  var chain = [{ entityType: 'ASSET', id: origin.id, name: origin.name, kind: origin.kind, role: 'chain' }];
  var seen = {}; seen[origin.id] = true;

  function step(current, depth) {
    if (depth > 12) { return Promise.resolve(); }
    return io.fetchParent(current).then(function (parent) {
      if (!parent || seen[parent.id]) { return; }
      seen[parent.id] = true;
      chain.push({ entityType: 'ASSET', id: parent.id, name: parent.name, kind: parent.kind, role: 'chain' });
      return step(parent, depth + 1);
    });
  }

  return step(origin, 0).then(function () {
    var top = chain[chain.length - 1];
    return io.fetchCustomer(top);
  }).then(function (customer) {
    if (customer) {
      chain.push({ entityType: 'CUSTOMER', id: customer.id, name: customer.name, kind: 'Customer', role: 'customer' });
    }
    return appendDefaults(chain, io);
  });
}

function appendDefaults(chain, io) {
  return io.fetchDefaults().then(function (defaults) {
    if (defaults) {
      chain.push({ entityType: 'ASSET', id: defaults.id, name: defaults.name, kind: 'Defaults', role: 'defaults' });
    }
    return chain;
  });
}

function chainEligible(level) { return level.role === 'chain'; }

// -- attribute reads, cached per entity --------------------------------

function createCache() { return {}; }

function attrsOf(level, io, cache) {
  var key = level.entityType + ':' + level.id;
  if (!cache[key]) { cache[key] = io.fetchAttrs(level); }
  return cache[key];
}

/** Nearest level in `chain` whose attribute `attrKey` is set (not null/undefined). */
function firstSet(chain, attrKey, io, cache) {
  var i = 0;
  function next() {
    if (i >= chain.length) { return Promise.resolve(null); }
    var level = chain[i++];
    return attrsOf(level, io, cache).then(function (attrs) {
      var value = attrs ? attrs[attrKey] : undefined;
      if (value !== undefined && value !== null) { return { value: value, level: level }; }
      return next();
    });
  }
  return next();
}

// -- field resolution -----------------------------------------------------
// Specificity-major, two passes (CONFIG_CASCADE.md §1): channel axis nearest-
// set on the chain-eligible rungs only, else kind axis nearest-set on the
// WHOLE chain (including CUSTOMER/DEFAULTS), else the decoder SI unit.

function resolveKindAxis(chain, kind, field, io, cache) {
  var camel = camelKind(kind);
  if (!camel) { return Promise.resolve(null); }
  var kindKey = KIND_PREFIX + camel + '.' + field;
  return firstSet(chain, kindKey, io, cache).then(function (hit) {
    if (hit) {
      return { value: hit.value, level: hit.level, source: levelDisplay(hit.level) + ' · kind ' + camel, overrideKey: kindKey };
    }
    if (field === 'unit' && DECODER_UNITS[camel]) {
      return { value: DECODER_UNITS[camel], level: null, source: 'Decoder default (SI, ' + camel + ')', overrideKey: kindKey };
    }
    return null;
  });
}

function resolveField(chain, channel, kind, field, io, cache) {
  var chanKey = CHANNEL_PREFIX + channel + '.' + field;
  return firstSet(chain.filter(chainEligible), chanKey, io, cache).then(function (hit) {
    if (hit) {
      return { value: hit.value, level: hit.level, source: levelDisplay(hit.level) + ' · channel', overrideKey: chanKey };
    }
    return resolveKindAxis(chain, kind, field, io, cache);
  });
}

function resolveScalars(chain, io, cache) {
  var entries = [];
  var ttlKey = CONFIG_PREFIX + 'ttlDays';
  var work = firstSet(chain, ttlKey, io, cache).then(function (hit) {
    if (!hit) { return; }
    var n = Number(hit.value);
    entries.push({
      effectiveKey: EFFECTIVE_PREFIX + 'ttlDays', overrideKey: ttlKey,
      value: Number.isFinite(n) ? Math.trunc(n) : hit.value,
      source: levelDisplay(hit.level), level: hit.level
    });
  });

  SCALAR_KEYS.forEach(function (name) {
    var overrideKey = CONFIG_PREFIX + name;
    work = work.then(function () {
      return firstSet(chain, overrideKey, io, cache).then(function (hit) {
        if (!hit) { return; }
        entries.push({
          effectiveKey: EFFECTIVE_PREFIX + name, overrideKey: overrideKey,
          value: hit.value, source: levelDisplay(hit.level), level: hit.level
        });
      });
    });
  });

  return work.then(function () { return entries; });
}

// -- channel discovery ------------------------------------------------------
// Station: its own config.channelMap. Location/Project: union across
// descendant stations (mirrors the read side of descendant_stations()).

function channelsFromAttrs(attrs) {
  var raw = attrs && attrs[CONFIG_PREFIX + 'channelMap'];
  var parsed = null;
  if (raw) {
    try { parsed = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (e) { parsed = null; }
  }
  var channels = parsed && parsed.channels;
  var out = {};
  if (channels) {
    Object.keys(channels).forEach(function (c) { out[c] = (channels[c] || {}).kind || null; });
  }
  return out;
}

function channelMapOf(entity, io) {
  return io.fetchAttrs(entity).then(function (attrs) {
    var channels = channelsFromAttrs(attrs);
    if (Object.keys(channels).length) { return channels; }
    return io.fetchTimeseriesKinds ? Promise.resolve(io.fetchTimeseriesKinds(entity)).then(function (m) { return m || {}; }) : {};
  });
}

function descendantAssets(entity, io, maxDepth) {
  maxDepth = maxDepth || 12;
  var seen = {};
  function walk(e, depth) {
    if (depth > maxDepth) { return Promise.resolve([]); }
    return io.fetchChildren(e).then(function (children) {
      var fresh = (children || []).filter(function (c) {
        if (seen[c.id]) { return false; }
        seen[c.id] = true;
        return true;
      });
      return Promise.all(fresh.map(function (c) { return walk(c, depth + 1); })).then(function (nested) {
        return fresh.concat.apply(fresh, nested);
      });
    });
  }
  return walk(entity, 0);
}

/** Every STATION reached by `Contains` under `entity` — itself, if it already
 * is one. The fan-out target for a PROJECT/LOCATION/CUSTOMER config change
 * (CONFIG_RESOLVER.md §5). CUSTOMER is not itself `Contains`-linked to
 * anything (ownership is the orthogonal axis, ENTITY_MODEL.md §1), so that
 * case goes through the optional `io.fetchCustomerStations` instead of the
 * `Contains` walk. */
function affectedStations(entity, io) {
  if (String(entity.kind || '').toLowerCase() === 'station') { return Promise.resolve([entity]); }
  if (entity.entityType === 'CUSTOMER') {
    return io.fetchCustomerStations ? Promise.resolve(io.fetchCustomerStations(entity)) : Promise.resolve([]);
  }
  return descendantAssets(entity, io).then(function (all) {
    return all.filter(function (e) { return String(e.kind || '').toLowerCase() === 'station'; });
  });
}

/** `{channel: kind}` reachable from `entity`: its own map at STATION level,
 * the union of descendant stations' maps otherwise. */
function discoverChannels(entity, io) {
  return affectedStations(entity, io).then(function (stations) {
    return Promise.all(stations.map(function (s) { return channelMapOf(s, io); })).then(function (maps) {
      var union = {};
      maps.forEach(function (m) {
        Object.keys(m).forEach(function (c) { if (!(c in union)) { union[c] = m[c]; } });
      });
      return { channels: union, stations: stations };
    });
  });
}

// -- resolve a station --------------------------------------------------

/** Side-effect-free resolution of one STATION's full `effective.*` block. */
function resolveStation(station, io, cache) {
  cache = cache || createCache();
  return buildChain(station, io).then(function (chain) {
    return attrsOf(chain[0], io, cache).then(function (ownAttrs) {
      var measuredKeys = channelsFromAttrs(ownAttrs);
      var measuredKeysWork = Object.keys(measuredKeys).length || !io.fetchTimeseriesKinds
        ? Promise.resolve(measuredKeys)
        : Promise.resolve(io.fetchTimeseriesKinds(station)).then(function (m) { return m || {}; });

      return measuredKeysWork.then(function (keys) {
        var channelEntries = [];
        var fields = channelFields();
        var work = Promise.resolve();
        Object.keys(keys).forEach(function (channel) {
          var kind = keys[channel];
          fields.forEach(function (field) {
            work = work.then(function () {
              return resolveField(chain, channel, kind, field, io, cache).then(function (hit) {
                if (hit) {
                  channelEntries.push({
                    effectiveKey: EFFECTIVE_PREFIX + channel + '.' + field,
                    overrideKey: hit.overrideKey, value: hit.value, source: hit.source, level: hit.level
                  });
                }
              });
            });
          });
        });

        return work.then(function () { return resolveScalars(chain, io, cache); }).then(function (scalarEntries) {
          var entries = scalarEntries.concat(channelEntries);
          var effective = {};
          entries.forEach(function (e) { effective[e.effectiveKey] = e.value; });
          return { station: station, chain: chain, measuredKeys: keys, entries: entries, effective: effective };
        });
      });
    });
  });
}

/** What to write/delete on `station` to bring its `effective.*` block in
 * line with `resolved` — pure, no I/O: the caller writes `toWrite` and
 * deletes `toDelete`. */
function effectiveDiff(currentAttrs, resolved) {
  var toWrite = resolved.effective;
  var produced = Object.keys(toWrite);
  var toDelete = Object.keys(currentAttrs || {}).filter(function (k) {
    return k.indexOf(EFFECTIVE_PREFIX) === 0 && produced.indexOf(k) < 0;
  });
  return { toWrite: toWrite, toDelete: toDelete };
}

// -- "replaces" lookup ----------------------------------------------------

/** The value `entity` would inherit for one field if it had no override of
 * its own — i.e. the same resolution `resolveField`/scalar lookup would
 * produce, walking from entity's PARENT upward. Used for the override
 * widget's "replaces <value> from <level>" line and to prefill the "Add
 * override" stepper. `descriptor` is `{axis:'channel', channel, kind, field}`,
 * `{axis:'kind', kind, field}` or `{axis:'config', field}`. */
function inheritedValue(entity, descriptor, io, cache) {
  cache = cache || createCache();
  return buildChain(entity, io).then(function (chain) {
    var ancestors = chain.slice(1);
    if (descriptor.axis === 'config') {
      return firstSet(ancestors, CONFIG_PREFIX + descriptor.field, io, cache).then(function (hit) {
        return hit ? { value: hit.value, level: hit.level, source: levelDisplay(hit.level) } : null;
      });
    }
    if (descriptor.axis === 'channel') {
      return resolveField(ancestors, descriptor.channel, descriptor.kind, descriptor.field, io, cache);
    }
    return resolveKindAxis(ancestors, descriptor.kind, descriptor.field, io, cache);
  });
}

return {
  CONFIG_PREFIX: CONFIG_PREFIX, CHANNEL_PREFIX: CHANNEL_PREFIX, KIND_PREFIX: KIND_PREFIX,
  EFFECTIVE_PREFIX: EFFECTIVE_PREFIX,
  SEVERITIES: SEVERITIES, ALARM_FIELDS: ALARM_FIELDS, PER_KEY_FIELDS: PER_KEY_FIELDS,
  ALARM_TEXT_EVENTS: ALARM_TEXT_EVENTS, ALARM_TEXT_TOKENS: ALARM_TEXT_TOKENS,
  DECODER_UNITS: DECODER_UNITS, NEVER_KIND_TARGETS: NEVER_KIND_TARGETS,
  CATEGORIES: CATEGORIES,

  camelKind: camelKind,
  wireKind: wireKind,
  channelFields: channelFields,
  levelDisplay: levelDisplay,
  buildChain: buildChain,
  createCache: createCache,
  resolveField: resolveField,
  resolveStation: resolveStation,
  effectiveDiff: effectiveDiff,
  affectedStations: affectedStations,
  discoverChannels: discoverChannels,
  inheritedValue: inheritedValue,
  parseOverrideKey: parseOverrideKey,
  describeOverride: describeOverride,
  listOverrides: listOverrides
};

});
