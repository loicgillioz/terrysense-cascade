/*
 * Cascade resolver — shared by the `config_overrides` and `channel_map_editor`
 * widgets (and their offline tests). Pure resolution logic only: every call
 * that reaches ThingsBoard goes through an injected `io` object, so this file
 * has no `ctx`/`container` dependency and loads unchanged in a browser
 * (`window.TerrySenseResolver`) or in Node (`module.exports`, see
 * `tests/test_resolver.js`).
 *
 * Port of `logr-cloud-tool/terrysense/operations/config_resolver.py` — keep
 * the two in sync by hand (`logr-product-docs/cloud/CONFIG_CASCADE.md`).
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
 *
 * Optional, for fan-out from the levels `Contains` does not reach:
 *
 *   fetchCustomerStations(customer) -> [station]      stations the customer owns
 *   fetchAllStations()              -> [station]      every station, for DEFAULTS
 *
 * `entity` / level objects carry `{entityType, id, name, kind}` — `kind` is
 * the ThingsBoard asset *type* string ("Station", "Project", "Defaults", …),
 * never the measurement kind. A resolved chain level also carries `role`:
 * `"chain"` for an ordinary Contains-linked asset (Station/Location/Project),
 * `"customer"` for the CUSTOMER rung, `"defaults"` for the DEFAULTS asset.
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
// Nearest-set `channel.<channel>.<field>` on the whole chain, else the kind's
// cloud unit from `config.kinds` for `unit` (CONFIG_CASCADE.md §1).

/** The `config.kinds` entry for `kind`, matched in either spelling. */
function kindSpec(kind, kinds) {
  var wanted = camelKind(kind);
  var names = Object.keys(kinds || {});
  for (var i = 0; i < names.length; i++) {
    if (camelKind(names[i]) === wanted) { return kinds[names[i]]; }
  }
  return {};
}

function resolveField(chain, channel, kind, field, io, cache) {
  cache = cache || createCache();
  var chanKey = CHANNEL_PREFIX + channel + '.' + field;
  return firstSet(chain, chanKey, io, cache).then(function (hit) {
    if (hit) {
      return { value: hit.value, level: hit.level, source: levelDisplay(hit.level), overrideKey: chanKey };
    }
    if (field === 'label') {
      return defaultsJson('channelNames', io, cache).then(function (names) {
        var label = (names[channel] || {}).label;
        return label ? { value: label, level: null, source: 'Channel dictionary', overrideKey: chanKey } : null;
      });
    }
    if (field !== 'unit' || !kind) { return null; }
    return defaultsJson('kinds', io, cache).then(function (kinds) {
      var unit = kindSpec(kind, kinds).cloudUnit;
      return unit ? { value: unit, level: null, source: 'Kind default (' + kind + ')', overrideKey: chanKey } : null;
    });
  });
}

/** `config.notify.contacts` as the flat list `alarm_notify` sends to — mirrors
 * `expand_contacts()` in config_resolver.py. A platform user becomes their
 * current profile name, e-mail and phone, each kept only where the contact
 * opted in; `io.fetchUser(id)` resolves the user, and a missing one is dropped
 * like a contact with no address or no severity. */
function expandContacts(raw, io) {
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
        if (!u) { return null; }
        name = [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email;
        sms = c.viaSms ? u.phone : null;
        email = c.viaEmail ? u.email : null;
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
  var contactsKey = CONFIG_PREFIX + CONTACTS_KEY;
  var work = firstSet(chain, ttlKey, io, cache).then(function (hit) {
    if (!hit) { return; }
    var n = Number(hit.value);
    entries.push({
      effectiveKey: EFFECTIVE_PREFIX + 'ttlDays', overrideKey: ttlKey,
      value: Number.isFinite(n) ? Math.trunc(n) : hit.value,
      source: levelDisplay(hit.level), level: hit.level
    });
  }).then(function () {
    return firstSet(chain, contactsKey, io, cache);
  }).then(function (hit) {
    if (!hit) { return; }
    return expandContacts(hit.value, io).then(function (contacts) {
      entries.push({
        effectiveKey: EFFECTIVE_PREFIX + CONTACTS_KEY, overrideKey: contactsKey,
        value: contacts, source: levelDisplay(hit.level), level: hit.level
      });
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

function channelsFromAttrs(attrs, names) {
  var parsed = parseJson(attrs && attrs[CONFIG_PREFIX + 'channelMap']);
  var channels = parsed && parsed.channels;
  var out = {};
  if (channels) {
    Object.keys(channels).forEach(function (c) { out[c] = (names[c] || {}).kind || null; });
  }
  return out;
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
  if (kind === 'station') { return Promise.resolve([entity]); }
  if (entity.entityType === 'CUSTOMER') {
    return io.fetchCustomerStations ? Promise.resolve(io.fetchCustomerStations(entity)) : Promise.resolve([]);
  }
  if (kind === 'defaults') {
    return io.fetchAllStations ? Promise.resolve(io.fetchAllStations()) : Promise.resolve([]);
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

// -- resolve a station --------------------------------------------------

/** Side-effect-free resolution of one STATION's full `effective.*` block. */
function resolveStation(station, io, cache) {
  cache = cache || createCache();
  return buildChain(station, io).then(function (chain) {
    return Promise.all([attrsOf(chain[0], io, cache), channelNamesOf(io, cache)]).then(function (got) {
      return Promise.resolve(channelsFromAttrs(got[0], got[1])).then(function (keys) {
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
  SEVERITIES: SEVERITIES, SCALAR_KEYS: SCALAR_KEYS, CONTACTS_KEY: CONTACTS_KEY, ALARM_FIELDS: ALARM_FIELDS, PER_KEY_FIELDS: PER_KEY_FIELDS,
  ALARM_TEXT_EVENTS: ALARM_TEXT_EVENTS,

  camelKind: camelKind,
  expandContacts: expandContacts,
  kindSpec: kindSpec,
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
  inheritedValue: inheritedValue
};

});
