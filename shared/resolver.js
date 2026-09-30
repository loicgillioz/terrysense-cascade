/*
 * Cascade resolver — shared by the terrySense widgets (and their offline
 * tests). Pure resolution logic only: every call
 * that reaches ThingsBoard goes through an injected `io` object, so this file
 * has no `ctx`/`container` dependency and loads unchanged in a browser
 * (`window.TerrySenseResolver`) or in Node (`module.exports`, see
 * `tests/test_resolver.js`).
 *
 * Port of `logr-cloud-tool/terrysense/operations/config_resolver.py` — keep
 * the two in sync by hand (`logr-product-docs/cloud/CONFIG_CASCADE.md`).
 *
 * Chain (nearest first): STATION -> PROJECT, via `Contains`, then CUSTOMER
 * (the project's owner, skipped when tenant-owned), then the DEFAULTS asset
 * (tenant-owned, shared read-only with customers). A DEVICE: the device, the
 * DeviceDefaults asset named after its profile, then DEFAULTS
 * (CONFIG_CASCADE.md §1). The TENANT entity itself is never read — a
 * customer-admin user gets 403 on it.
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
 *
 * Optional, for fan-out from the levels `Contains` does not reach:
 *
 *   fetchCustomerStations(customer) -> [station]      stations the customer owns
 *   fetchAllStations()              -> [station]      every station, for DEFAULTS
 *   fetchAllDevices()               -> [device]       every device, for DEFAULTS
 *
 * For the device branch:
 *
 *   fetchDeviceDefaults(profile)    -> {entityType:'ASSET', id, name} | null
 *   fetchProfileDevices(profile)    -> [device]       the devices of one profile
 *
 * `entity` / level objects carry `{entityType, id, name, kind}` — `kind` is
 * the ThingsBoard asset *type* string ("Station", "Project", "Defaults", …),
 * never the measurement kind. A resolved chain level also carries `role`:
 * `"chain"` for an ordinary Contains-linked asset (Station/Project),
 * `"customer"` for the CUSTOMER rung, `"defaults"` for the DEFAULTS asset,
 * `"device"` for a DEVICE (its `kind` is the device profile) and
 * `"deviceDefaults"` for a DeviceDefaults asset.
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
var CALC_PREFIX = 'calc.';
var EFFECTIVE_PREFIX = 'effective.';

// `label` falls back to the dictionary label and fills `${alarmLabel}`.
var PER_KEY_FIELDS = ['label', 'unit', 'hysteresis', 'textWhenTrue', 'textWhenFalse'];
// Low -> high; INDETERMINATE is a band whose severity nobody chose.
var SEVERITIES = ['indeterminate', 'warning', 'minor', 'major', 'critical'];
var ALARM_FIELDS = ['thresholdMax', 'thresholdMin', 'state', 'debounce'];
var ALARM_TEXT_EVENTS = ['created', 'cleared'];

// Entity scalars beyond ttlDays (the only one the hot path consumes as a unit —
// CONFIG_RESOLVER.md §3) and notify.contacts (platform users are expanded to
// their addresses), which are handled apart.
var SCALAR_KEYS = ['language', 'url', 'sms.enabled', 'email.enabled']
  .concat(ALARM_TEXT_EVENTS.map(function (e) { return 'alarmText.' + e; }))
  .concat(ALARM_TEXT_EVENTS.map(function (e) { return 'emailText.' + e; }));
var CONTACTS_KEY = 'notify.contacts';
// Who receives the device alarms of a station's devices, resolved on its own so
// a station replacing one list keeps the other (ALARMING.md §1.2).
var DEVICE_CONTACTS_KEY = 'notify.deviceContacts';
var DEVICE_DEFAULTS_KIND = 'DeviceDefaults';
// The DEFAULTS asset's alarm texts per language: {lang: {'alarmText.created': …}}
// (ALARMING.md §4). A text set below DEFAULTS wins over it.
var TEXT_CATALOGUE_KEY = 'alarmTextByLanguage';
var DEFAULT_LANGUAGE = 'en';

function isTextKey(name) { return /^(alarmText|emailText)\./.test(name); }

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
  if (level.role === 'deviceDefaults') { return 'Device defaults · ' + level.name; }
  if (level.role === 'device') { return 'Device · ' + level.name; }
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
  if (origin.kind === DEVICE_DEFAULTS_KIND) {
    return appendDefaults([{ entityType: 'ASSET', id: origin.id, name: origin.name, kind: DEVICE_DEFAULTS_KIND, role: 'deviceDefaults' }], io);
  }
  if (origin.entityType === 'DEVICE') {
    var own = [{ entityType: 'DEVICE', id: origin.id, name: origin.name, kind: origin.kind, role: 'device' }];
    var profileDefaults = io.fetchDeviceDefaults ? Promise.resolve(io.fetchDeviceDefaults(origin.kind)) : Promise.resolve(null);
    return profileDefaults.then(function (dd) {
      if (dd) { own.push({ entityType: 'ASSET', id: dd.id, name: dd.name, kind: DEVICE_DEFAULTS_KIND, role: 'deviceDefaults' }); }
      return appendDefaults(own, io);
    });
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

// -- channel keys ----------------------------------------------------------
// A station channel key is a name, or `<name>-<n>` for instance n of a
// repeatable name (measurement/vocabulary.md §3). Mirrors split_channel_key()
// in keys.py.

var CHANNEL_KEY_RE = /^([a-z][A-Za-z0-9]*)(?:-([1-9][0-9]*))?$/;

/** `"tiltX-7"` -> `{name: "tiltX", instance: 7}`; `"ph"` -> `{name: "ph", instance: null}`. */
function splitChannelKey(key) {
  var m = CHANNEL_KEY_RE.exec(key || '');
  return m ? { name: m[1], instance: m[2] ? Number(m[2]) : null } : { name: key, instance: null };
}

// -- attribute reads, cached per entity --------------------------------

function createCache() { return {}; }

function attrsOf(level, io, cache) {
  var key = level.entityType + ':' + level.id;
  if (!cache[key]) { cache[key] = io.fetchAttrs(level); }
  return cache[key];
}

/** Nearest level in `chain` whose attribute `attrKey` is set (not null/undefined).
 * `attrKey` may be a list: each level is asked for them in order. */
function firstSet(chain, attrKey, io, cache) {
  var keys = Array.isArray(attrKey) ? attrKey : [attrKey];
  var i = 0;
  function next() {
    if (i >= chain.length) { return Promise.resolve(null); }
    var level = chain[i++];
    return attrsOf(level, io, cache).then(function (attrs) {
      for (var k = 0; k < keys.length; k++) {
        var value = attrs ? attrs[keys[k]] : undefined;
        if (value !== undefined && value !== null) { return { value: value, level: level, key: keys[k] }; }
      }
      return next();
    });
  }
  return next();
}

// -- field resolution -----------------------------------------------------
// Nearest-set `channel.<channel>.<field>` on the whole chain, else the kind's
// cloud unit from `config.kinds` for `unit` (CONFIG_CASCADE.md §1). For an
// instance key each level is asked for the instance key, then the name.

/** The `config.kinds` entry for `kind`, matched in either spelling. */
function kindSpec(kind, kinds) {
  var wanted = camelKind(kind);
  var names = Object.keys(kinds || {});
  for (var i = 0; i < names.length; i++) {
    if (camelKind(names[i]) === wanted) { return kinds[names[i]]; }
  }
  return {};
}

// -- units ------------------------------------------------------------------
// A value is stored in its kind's cloudUnit; a display unit is a key of the
// kind's `units` with the factor that turns it into cloudUnit (vocabulary.md
// §2). A unit the kind cannot convert is shown as it is, factor 1.

function unitFactor(kind, unit, kinds) {
  var spec = kindSpec(kind, kinds);
  var f = unit ? (spec.units || {})[unit] : 1;
  return typeof f === 'number' && f > 0 ? f : 1;
}

// toPrecision drops the float noise of a division (3.9840000000000004).
function toDisplay(value, kind, unit, kinds) {
  var f = unitFactor(kind, unit, kinds);
  return f === 1 ? value : Number((value / f).toPrecision(12));
}

function fromDisplay(value, kind, unit, kinds) {
  var f = unitFactor(kind, unit, kinds);
  return f === 1 ? value : Number((value * f).toPrecision(12));
}

function resolveField(chain, channel, kind, field, io, cache) {
  cache = cache || createCache();
  // A device source key (`logr.batteryVoltage`) falls back to the name after
  // its prefix; it has no instances.
  var split = channel.indexOf('.') >= 0 ? { name: channel.split('.').pop(), instance: null } : splitChannelKey(channel);
  var chanKey = CHANNEL_PREFIX + channel + '.' + field;
  if (split.instance && field === 'label') {
    // An instance keeps its number unless it has a label of its own.
    return firstSet(chain, chanKey, io, cache).then(function (hit) {
      if (hit) { return { value: hit.value, level: hit.level, source: levelDisplay(hit.level), overrideKey: chanKey }; }
      return resolveField(chain, split.name, kind, field, io, cache).then(function (base) {
        return base ? { value: base.value + ' ' + split.instance, level: base.level, source: base.source, overrideKey: chanKey } : null;
      });
    });
  }
  var keys = split.instance ? [chanKey, CHANNEL_PREFIX + split.name + '.' + field] : [chanKey];
  return firstSet(chain, keys, io, cache).then(function (hit) {
    if (hit) {
      return { value: hit.value, level: hit.level, source: levelDisplay(hit.level), overrideKey: hit.key };
    }
    if (field === 'label') {
      return defaultsJson('channelNames', io, cache).then(function (names) {
        var label = (names[split.name] || {}).label;
        return label ? { value: label, level: null, source: 'Channel dictionary', overrideKey: chanKey } : null;
      });
    }
    if (field !== 'unit') { return null; }
    return defaultsJson('channelNames', io, cache).then(function (names) {
      var own = (names[split.name] || {}).unit;
      if (own) { return { value: own, level: null, source: 'Channel dictionary', overrideKey: chanKey }; }
      if (!kind) { return null; }
      return defaultsJson('kinds', io, cache).then(function (kinds) {
        var unit = kindSpec(kind, kinds).cloudUnit;
        return unit ? { value: unit, level: null, source: 'Kind default (' + kind + ')', overrideKey: chanKey } : null;
      });
    });
  });
}

/** `config.notify.contacts` as the flat list `alarm_notify` sends to — mirrors
 * `expand_contacts()` in config_resolver.py. A platform user becomes their
 * current profile name, e-mail and phone, each kept only where the contact
 * opted in and the user's own switch (`u.switches`) is not off;
 * `io.fetchUser(id)` resolves the user, and a missing one is dropped like a
 * contact with no address or no severity. */
function expandContacts(raw, io) {
  function off(u, key) { return String((u.switches || {})[CONFIG_PREFIX + key]).toLowerCase() === 'false'; }
  var list = parseJson(raw);
  if (!Array.isArray(list)) { return Promise.resolve([]); }
  return Promise.all(list.map(function (c) {
    if (!c || typeof c !== 'object') { return null; }
    var severities = (c.severities || []).filter(function (x) { return SEVERITIES.indexOf(x) >= 0; });
    var user = c.type === 'user'
      ? (io.fetchUser ? Promise.resolve(io.fetchUser(String(c.userId || ''))).catch(function () { return null; }) : Promise.resolve(null))
      : Promise.resolve(undefined);
    return user.then(function (u) {
      var name, sms, email;
      if (c.type === 'user') {
        if (!u || off(u, 'notify.enabled')) { return null; }
        name = [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email;
        sms = c.viaSms && !off(u, 'sms.enabled') ? u.phone : null;
        email = c.viaEmail && !off(u, 'email.enabled') ? u.email : null;
      } else {
        name = c.name; sms = c.sms; email = c.email;
      }
      sms = String(sms || '').trim() || null;
      email = String(email || '').trim() || null;
      if (!severities.length || !(sms || email)) { return null; }
      return { name: String(name || ''), sms: sms, email: email, severities: severities };
    });
  })).then(function (out) { return out.filter(Boolean); });
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
  [CONTACTS_KEY, DEVICE_CONTACTS_KEY].forEach(function (name) {
    var key = CONFIG_PREFIX + name;
    work = work.then(function () { return firstSet(chain, key, io, cache); }).then(function (hit) {
      if (!hit) { return; }
      return expandContacts(hit.value, io).then(function (contacts) {
        entries.push({
          effectiveKey: EFFECTIVE_PREFIX + name, overrideKey: key,
          value: contacts, source: levelDisplay(hit.level), level: hit.level
        });
      });
    });
  });

  var language = DEFAULT_LANGUAGE;
  var defaultsLevel = chain.filter(function (l) { return l.role === 'defaults'; })[0] || null;
  SCALAR_KEYS.forEach(function (name) {
    var overrideKey = CONFIG_PREFIX + name;
    work = work.then(function () {
      return firstSet(chain, overrideKey, io, cache).then(function (hit) {
        if (name === 'language' && hit) { language = String(hit.value); }
        if (isTextKey(name) && (!hit || hit.level.role === 'defaults') && defaultsLevel) {
          return attrsOf(defaultsLevel, io, cache).then(function (attrs) {
            var text = ((parseJson(attrs && attrs[CONFIG_PREFIX + TEXT_CATALOGUE_KEY]) || {})[language] || {})[name];
            if (text) {
              entries.push({
                effectiveKey: EFFECTIVE_PREFIX + name, overrideKey: CONFIG_PREFIX + TEXT_CATALOGUE_KEY,
                value: text, source: levelDisplay(defaultsLevel) + ' · ' + language, level: defaultsLevel
              });
            } else if (hit) {
              entries.push({
                effectiveKey: EFFECTIVE_PREFIX + name, overrideKey: overrideKey,
                value: hit.value, source: levelDisplay(hit.level), level: hit.level
              });
            }
          });
        }
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

/** A device resolves only its retention among the scalars. */
function resolveDeviceScalars(chain, io, cache) {
  var ttlKey = CONFIG_PREFIX + 'ttlDays';
  return firstSet(chain, ttlKey, io, cache).then(function (hit) {
    if (!hit) { return []; }
    var n = Number(hit.value);
    return [{
      effectiveKey: EFFECTIVE_PREFIX + 'ttlDays', overrideKey: ttlKey,
      value: Number.isFinite(n) ? Math.trunc(n) : hit.value,
      source: levelDisplay(hit.level), level: hit.level
    }];
  });
}

// -- channel discovery ------------------------------------------------------
// Station: its own config.channelMap, each channel's kind from the tenant
// dictionary (`config.channelNames` on the DEFAULTS asset). Location/Project:
// union across descendant stations. A station without a map has no channels.

function parseJson(raw) {
  if (!raw) { return null; }
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (e) { return null; }
}

/** A JSON attribute of the DEFAULTS asset: `channelNames` or `kinds`. */
function defaultsJson(name, io, cache) {
  return io.fetchDefaults().then(function (defaults) {
    if (!defaults) { return {}; }
    return attrsOf({ entityType: 'ASSET', id: defaults.id }, io, cache).then(function (attrs) {
      return parseJson(attrs && attrs[CONFIG_PREFIX + name]) || {};
    });
  });
}

function channelNamesOf(io, cache) { return defaultsJson('channelNames', io, cache); }

/** A station's map as `{channel: {device, key}}` (CHANNEL_MAP.md §1). A plain
 * string entry is the source key of the map's `sourceDeviceId`. Mirrors
 * `channel_maps.entries()` in logr-cloud-tool. */
function mapEntries(raw) {
  var parsed = parseJson(raw) || {};
  var out = {};
  Object.keys(parsed.channels || {}).forEach(function (c) {
    var e = parsed.channels[c];
    if (e && typeof e === 'object') { out[c] = { device: e.device || null, key: e.key }; }
    else if (typeof e === 'string') { out[c] = { device: parsed.sourceDeviceId || null, key: e }; }
  });
  return out;
}

/** `entries` as the `config.channelMap` value — the one shape the tools write. */
function buildMap(entries) {
  var channels = {};
  Object.keys(entries).forEach(function (c) { channels[c] = { device: entries[c].device, key: entries[c].key }; });
  return JSON.stringify({ channels: channels });
}

/** The devices a map names, in first-use order — the station's `Contains`. */
function mapDevices(entries) {
  var seen = [];
  Object.keys(entries).forEach(function (c) {
    var d = entries[c].device;
    if (d && seen.indexOf(d) < 0) { seen.push(d); }
  });
  return seen;
}

function channelsFromAttrs(attrs, names) {
  var parsed = parseJson(attrs && attrs[CONFIG_PREFIX + 'channelMap']);
  var channels = parsed && parsed.channels;
  var out = {};
  if (channels) {
    Object.keys(channels).forEach(function (c) { out[c] = (names[splitChannelKey(c).name] || {}).kind || null; });
    calculatedChannels(channels, attrs, names).forEach(function (c) { out[c] = names[c].kind || null; });
  }
  return out;
}

/** The calculated names a station carries: every input channel mapped or itself
 * a calculated name the station carries, and every `calc.<attribute>` set —
 * mirrors `calculated_channels()` in config_resolver.py. */
function calculatedChannels(mapped, attrs, names) {
  var known = Object.assign({}, mapped), found = [], added = true;
  while (added) {
    var fresh = Object.keys(names).filter(function (name) {
      var calc = (names[name] || {}).calculated;
      return !!calc && !(name in known)
        && (calc.channels || []).every(function (c) { return c in known; })
        && (calc.attributes || []).every(function (a) { return attrs[CALC_PREFIX + a] != null; });
    });
    fresh.forEach(function (name) { known[name] = true; found.push(name); });
    added = fresh.length > 0;
  }
  return found;
}

function channelMapOf(entity, names, io) {
  return io.fetchAttrs(entity).then(function (attrs) { return channelsFromAttrs(attrs, names); });
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
 * (CONFIG_RESOLVER.md §5). Neither CUSTOMER nor DEFAULTS is `Contains`-linked
 * to anything (ownership is the orthogonal axis, ENTITY_MODEL.md §1), so they
 * go through the optional `io.fetchCustomerStations` / `io.fetchAllStations`. */
function affectedStations(entity, io) {
  var kind = String(entity.kind || '').toLowerCase();
  if (kind === 'station' || entity.entityType === 'DEVICE') { return Promise.resolve([entity]); }
  if (entity.kind === DEVICE_DEFAULTS_KIND) {
    return io.fetchProfileDevices ? Promise.resolve(io.fetchProfileDevices(entity.name)) : Promise.resolve([]);
  }
  if (entity.entityType === 'CUSTOMER') {
    return io.fetchCustomerStations ? Promise.resolve(io.fetchCustomerStations(entity)) : Promise.resolve([]);
  }
  if (kind === 'defaults') {
    return Promise.all([
      io.fetchAllStations ? Promise.resolve(io.fetchAllStations()) : [],
      io.fetchAllDevices ? Promise.resolve(io.fetchAllDevices()) : []
    ]).then(function (got) { return got[0].concat(got[1]); });
  }
  return descendantAssets(entity, io).then(function (all) {
    return all.filter(function (e) { return String(e.kind || '').toLowerCase() === 'station'; });
  });
}

/** `{channel: kind}` reachable from `entity`: its own map at STATION level,
 * the union of descendant stations' maps otherwise. */
function discoverChannels(entity, io) {
  return Promise.all([affectedStations(entity, io), channelNamesOf(io, createCache())]).then(function (got) {
    var stations = got[0], names = got[1];
    return Promise.all(stations.map(function (s) { return channelMapOf(s, names, io); })).then(function (maps) {
      var union = {};
      maps.forEach(function (m) {
        Object.keys(m).forEach(function (c) { if (!(c in union)) { union[c] = m[c]; } });
      });
      return { channels: union, stations: stations };
    });
  });
}

// -- device branch ----------------------------------------------------------

/** The source key a device-branch override names —
 * `channel.logr.batteryVoltage.alarm.warning.thresholdMin` -> `logr.batteryVoltage`
 * — or null. Mirrors `device_source_key()` in config_resolver.py. */
function deviceSourceKey(attrKey) {
  if (String(attrKey).indexOf(CHANNEL_PREFIX) !== 0) { return null; }
  var parts = String(attrKey).substring(CHANNEL_PREFIX.length).split('.');
  var at = parts.indexOf('alarm', 1);
  if (at > 0 && parts.length >= at + 3) { return parts.slice(0, at).join('.'); }
  if (parts.length >= 2 && PER_KEY_FIELDS.indexOf(parts[parts.length - 1]) >= 0) { return parts.slice(0, -1).join('.'); }
  return null;
}

/** A device source key's kind: the kind segment of a LOGR key, else the
 * vocabulary kind of the name after its prefix, or of the key itself. */
function deviceKeyKind(key, names) {
  var m = /^p\d+\.([a-z][A-Za-z0-9]*)/.exec(key);
  if (m) { return m[1]; }
  return (names[String(key).split('.').pop()] || {}).kind || null;
}

/** `{sourceKey: kind}` configured on a device's own levels — the device and its
 * DeviceDefaults asset, never the DEFAULTS asset's station channel names. */
function deviceChannels(chain, io, cache) {
  var own = chain.filter(function (l) { return l.role === 'device' || l.role === 'deviceDefaults'; });
  return Promise.all(own.map(function (l) { return attrsOf(l, io, cache); }).concat([channelNamesOf(io, cache)])).then(function (got) {
    var names = got.pop(), out = {};
    got.forEach(function (attrs) {
      Object.keys(attrs || {}).forEach(function (k) {
        var key = deviceSourceKey(k);
        if (key) { out[key] = deviceKeyKind(key, names); }
      });
    });
    return out;
  });
}

// -- resolve a station --------------------------------------------------

/** Side-effect-free resolution of one STATION's full `effective.*` block — or
 * a DEVICE's: its own limits and retention, no notification key. */
function resolveStation(station, io, cache) {
  cache = cache || createCache();
  var device = station.entityType === 'DEVICE';
  return buildChain(station, io).then(function (chain) {
    return Promise.all([attrsOf(chain[0], io, cache), channelNamesOf(io, cache)]).then(function (got) {
      return (device ? deviceChannels(chain, io, cache) : Promise.resolve(channelsFromAttrs(got[0], got[1]))).then(function (keys) {
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

        return work.then(function () { return device ? resolveDeviceScalars(chain, io, cache) : resolveScalars(chain, io, cache); }).then(function (scalarEntries) {
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
 * deletes `toDelete`. Unchanged values are left out: every attribute write
 * re-triggers `station_entry`. */
function effectiveDiff(currentAttrs, resolved) {
  var toWrite = {};
  Object.keys(resolved.effective).forEach(function (k) {
    if (JSON.stringify((currentAttrs || {})[k]) !== JSON.stringify(resolved.effective[k])) { toWrite[k] = resolved.effective[k]; }
  });
  var produced = Object.keys(resolved.effective);
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
 * override" stepper. `descriptor` is `{axis:'channel', channel, kind, field}`
 * or `{axis:'config', field}`. */
function inheritedValue(entity, descriptor, io, cache) {
  cache = cache || createCache();
  return buildChain(entity, io).then(function (chain) {
    var ancestors = chain.slice(1);
    if (descriptor.axis === 'config') {
      return firstSet(ancestors, CONFIG_PREFIX + descriptor.field, io, cache).then(function (hit) {
        return hit ? { value: hit.value, level: hit.level, source: levelDisplay(hit.level) } : null;
      });
    }
    return resolveField(ancestors, descriptor.channel, descriptor.kind, descriptor.field, io, cache);
  });
}

return {
  CONFIG_PREFIX: CONFIG_PREFIX, CHANNEL_PREFIX: CHANNEL_PREFIX,
  EFFECTIVE_PREFIX: EFFECTIVE_PREFIX,
  SEVERITIES: SEVERITIES, SCALAR_KEYS: SCALAR_KEYS, CONTACTS_KEY: CONTACTS_KEY, DEVICE_CONTACTS_KEY: DEVICE_CONTACTS_KEY,
  DEVICE_DEFAULTS_KIND: DEVICE_DEFAULTS_KIND, ALARM_FIELDS: ALARM_FIELDS, PER_KEY_FIELDS: PER_KEY_FIELDS,
  ALARM_TEXT_EVENTS: ALARM_TEXT_EVENTS, TEXT_CATALOGUE_KEY: TEXT_CATALOGUE_KEY, DEFAULT_LANGUAGE: DEFAULT_LANGUAGE,

  camelKind: camelKind,
  splitChannelKey: splitChannelKey,
  expandContacts: expandContacts,
  kindSpec: kindSpec,
  unitFactor: unitFactor,
  toDisplay: toDisplay,
  fromDisplay: fromDisplay,
  defaultsJson: defaultsJson,
  channelFields: channelFields,
  levelDisplay: levelDisplay,
  buildChain: buildChain,
  createCache: createCache,
  resolveField: resolveField,
  resolveStation: resolveStation,
  effectiveDiff: effectiveDiff,
  affectedStations: affectedStations,
  discoverChannels: discoverChannels,
  channelsFromAttrs: channelsFromAttrs,
  calculatedChannels: calculatedChannels,
  mapEntries: mapEntries,
  buildMap: buildMap,
  mapDevices: mapDevices,
  deviceSourceKey: deviceSourceKey,
  deviceKeyKind: deviceKeyKind,
  deviceChannels: deviceChannels,
  inheritedValue: inheritedValue
};

});
