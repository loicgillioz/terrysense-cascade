/*
 * Channel mapping for the terrySense config widgets — `window.TerrySenseMapping`.
 * What a device measures, the channel names each measurement may be stored
 * under on a station, and the station's `config.channelMap` after a change,
 * under the map rules of logr-product-docs/cloud/CHANNEL_MAP.md. Shared by the
 * device view's *Channels* and per-measurement editors and the station view's
 * data flow, so all apply the same rules.
 *
 * A device model `m`: `bus` (a LOGR3 or LOGR4), `device` (ThingsBoard's
 * device), `client` (its client attributes), `latest` (`{key: {ts, value}}`),
 * `faults` (`{sourceKey: alarm}`), and the defaults' `peripherals`, `kinds`
 * and `names`.
 *
 * Loads after shared/resolver.js.
 */
(function (root) {
'use strict';

var resolver = root.TerrySenseResolver;
var camel = resolver.camelKind;

var EMPTY_MARKER = '(empty)';
var TOPOLOGY_TYPE_RE = /^topology\.p(\d+)\.type$/;
var SOURCE_KEY_RE = /^p(\d+)\.([a-z][A-Za-z0-9]*)(?:\.g(\d+))?(?:\.i(\d+))?$/;
var NETWORK_KEYS = ['rssi', 'snr'];
// Device bookkeeping, not readings: radio, uplink markers, the dry contact interface's own counters.
var NOT_READINGS = ['rssi', 'snr', 'uplinkCause', 'uplinkLatest', 'dryc.drycRuleCount', 'dryc.drycRulesSynced'];
var RULE_SOURCE = /^drycRule\./;
var DRYC_KEY = /^(dryc|drycRule)\./;
// The sensors a LOGR2 can carry, by the peripheral prefix of its device keys
// (`cond.temperature`): cloud-integrations/sources/logr2.json, kept equal by
// smoke_test_config_widgets.py. `logr` is the LOGR itself.
var LOGR2_SENSORS = { phpr: 'pH probe', cond: 'Conductivity probe', dryc: 'Dry contact interface', flow: 'Flow meter',
  clmt: 'Climate sensor', inclTilt: 'Inclinometer or tiltmeter', usonRdar: 'Ultrasonic or radar level sensor' };

function parseSource(key) {
  var m = SOURCE_KEY_RE.exec(key);
  return m ? {
    sourceKey: key, position: Number(m[1]), kind: m[2],
    group: m[3] !== undefined ? Number(m[3]) : 0, index: m[4] !== undefined ? Number(m[4]) : 0,
    hasGroup: m[3] !== undefined, hasIndex: m[4] !== undefined
  } : null;
}

function isLogr2(m) { return m.device.type === 'logr2'; }

/** The stored keys whose latest value the model needs. */
function latestKeys(bus, keys) {
  return keys.filter(function (k) {
    return bus ? parseSource(k.replace(/\.status$/, '')) || NETWORK_KEYS.indexOf(k) >= 0 : !/\.status$/.test(k);
  });
}

function topology(m) {
  var nodes = {};
  Object.keys(m.client).forEach(function (key) {
    var t = TOPOLOGY_TYPE_RE.exec(key);
    if (!t) { return; }
    var type = String(m.client[key] || '').trim();
    if (!type || type === EMPTY_MARKER) { return; }
    nodes[t[1]] = { position: Number(t[1]), type: type, version: m.client['topology.p' + t[1] + '.version'] };
  });
  return nodes;
}

function sources(m) {
  var out = {};
  function add(key) { var s = parseSource(key); if (s && !out[key]) { out[key] = s; } return out[key]; }
  Object.keys(m.client).forEach(function (key) {
    var t = /^subscriptions\.(.+)\.(enabled|interval)$/.exec(key);
    var s = t && add(t[1]);
    if (s) { s[t[2]] = m.client[key]; }
  });
  Object.keys(m.latest).forEach(function (key) { add(key.replace(/\.status$/, '')); });
  Object.keys(m.faults).forEach(add);
  return Object.keys(out).map(function (k) { return out[k]; });
}

function measureOf(m, s, node) {
  var p = node && m.peripherals[node.type];
  return p && (p.measures || []).filter(function (x) {
    return camel(x.kind) === s.kind && x.group === s.group && x.index === s.index;
  })[0];
}

function sourceLabel(m, s, node) {
  var x = measureOf(m, s, node);
  var entry = x && m.names[x.defaultName];
  return entry && entry.label ? entry.label : ((resolver.kindSpec(s.kind, m.kinds) || {}).label || s.kind);
}

function unitOf(m, s) { return (resolver.kindSpec(s.kind, m.kinds) || {}).cloudUnit || ''; }

/** A LOGR2's or any other device's readings: its stored keys, dictionary names. */
function readings(m) {
  return Object.keys(m.latest).filter(function (k) {
    return NOT_READINGS.indexOf(k) < 0 && !RULE_SOURCE.test(k);
  }).sort(function (a, b) { return labelOf(m, a).localeCompare(labelOf(m, b)); });
}

/** The channel name a reading carries: a LOGR2 key after its peripheral prefix, any other key whole. */
function nameOf(m, key) { return isLogr2(m) ? key.slice(key.indexOf('.') + 1) : key; }
function entryOf(m, key) { return m.names[resolver.splitChannelKey(nameOf(m, key)).name] || null; }
function labelOf(m, key) { var e = entryOf(m, key); return (e && e.label) || key; }
function readingUnit(m, key) {
  var e = entryOf(m, key);
  return e ? ((resolver.kindSpec(camel(e.kind), m.kinds) || {}).cloudUnit || '') : '';
}

/** A LOGR2 as the LOGR and its sensors: `[{ id, label, keys }]`, the LOGR first
 * (label null), then each sensor that reported, then readings of no known part. */
function logr2Parts(keys) {
  var logger = { id: 'logr', label: null, keys: [] }, sensors = {}, rest = [];
  keys.forEach(function (key) {
    var prefix = key.slice(0, key.indexOf('.'));
    if (prefix === 'logr') { logger.keys.push(key); return; }
    if (LOGR2_SENSORS[prefix]) { (sensors[prefix] = sensors[prefix] || []).push(key); return; }
    rest.push(key);
  });
  var parts = [logger].concat(Object.keys(LOGR2_SENSORS).filter(function (g) { return sensors[g]; }).map(function (g) {
    return { id: g, label: LOGR2_SENSORS[g], keys: sensors[g] };
  }));
  if (rest.length) { parts.push({ id: 'other', label: 'Other readings', keys: rest }); }
  return parts;
}

/** The device's channels among a station's map entries: `{channel: sourceKey}`. */
function mineOf(entries, deviceId) {
  var out = {};
  Object.keys(entries || {}).forEach(function (c) {
    if (entries[c].device === deviceId) { out[c] = entries[c].key; }
  });
  return out;
}

/** The channels of `entries` another device feeds. */
function othersOf(entries, deviceId) {
  return Object.keys(entries || {}).filter(function (c) { return entries[c].device && entries[c].device !== deviceId; });
}

/** The names the device's channels carry on the stations whose entries are listed. */
function mappedNames(deviceId, entriesList) {
  var out = {};
  entriesList.forEach(function (entries) {
    Object.keys(mineOf(entries, deviceId)).forEach(function (c) { out[resolver.splitChannelKey(c).name] = true; });
  });
  return out;
}

function retiredName(m, n) { return !!(m.names[n] || {}).retired; }

/** The names a source of `kind` can be stored under: a retired name only where a channel of this device already carries it. */
function namesForKind(m, kind, mapped) {
  return Object.keys(m.names).filter(function (n) {
    var e = m.names[n];
    return camel(e.kind) === kind && !e.fixed && !e.rule && (!retiredName(m, n) || mapped[n]);
  })
    .sort(function (a, b) {
      return !!m.names[a].diagnostic - !!m.names[b].diagnostic || (m.names[a].label || a).localeCompare(m.names[b].label || b);
    });
}

/** The names a reading can be stored under: its own name first, then the other
 * vocabulary names of its kind. */
function namesForReading(m, key, mapped) {
  var own = nameOf(m, key), e = entryOf(m, key);
  if (e && e.fixed) { return [own]; }
  return [own].concat(e ? namesForKind(m, camel(e.kind), mapped).filter(function (n) { return n !== own; }) : []);
}

/** What a station can take from the device: one row per measurement, with the
 * channel name it gets by default and the names it may take instead. A LOGR3 or
 * LOGR4 source defaults to a vocabulary name of its kind; any other reading to
 * its own name, a LOGR2's without its peripheral prefix. The dry contact
 * interface's readings are its DRYC view's. */
function mappable(m, mapped) {
  if (!m.bus) {
    var parts = isLogr2(m) ? logr2Parts(readings(m)).filter(function (p) { return p.id !== 'dryc'; })
      : [{ id: 'device', label: m.device.type || 'Device', keys: readings(m) }];
    return [].concat.apply([], parts.map(function (part) {
      return part.keys.map(function (key) {
        return { key: key, label: labelOf(m, key), unit: readingUnit(m, key), group: part.id, groupLabel: part.label || 'LOGR itself',
                 names: namesForReading(m, key, mapped), name: nameOf(m, key),
                 diagnostic: part.id === 'logr' || !!(entryOf(m, key) || {}).diagnostic };
      });
    }));
  }
  var nodes = topology(m);
  return sources(m).sort(function (a, b) { return a.position - b.position || a.sourceKey.localeCompare(b.sourceKey); }).map(function (s) {
    var node = nodes[s.position], p = node && m.peripherals[node.type];
    var x = measureOf(m, s, node);
    var name = x && m.names[x.defaultName] && !retiredName(m, x.defaultName) ? x.defaultName
      : namesForKind(m, s.kind, mapped).filter(function (n) { return !retiredName(m, n); })[0] || null;
    return {
      key: s.sourceKey, label: sourceLabel(m, s, node), unit: unitOf(m, s), group: 'p' + s.position,
      groupLabel: s.position === 0 ? 'LOGR itself' : s.position + ' · ' + (p ? p.displayName : node ? node.type : 'Unknown peripheral'),
      names: namesForKind(m, s.kind, mapped), name: name, diagnostic: s.position === 0 || !!(name && (m.names[name] || {}).diagnostic)
    };
  }).filter(function (r) { return r.names.length; });
}

function channelLabel(names, key) {
  var k = resolver.splitChannelKey(key);
  return ((names[k.name] || {}).label || k.name) + (k.instance ? ' ' + k.instance : '');
}

/** The next free instance of `name` among the station's channels, `name-2` on. */
function nextInstance(name, entries) {
  var used = {};
  Object.keys(entries || {}).forEach(function (c) {
    var k = resolver.splitChannelKey(c);
    if (k.name === name) { used[k.instance || 1] = true; }
  });
  var n = 2;
  while (used[n]) { n++; }
  return name + '-' + n;
}

/** A row's channel choices on a station: its names, the channel it already
 * feeds, and for a repeatable name another device feeds there, its next
 * instance, the default so a second sensor of a kind never takes over the
 * first. `{options, value}`. */
function nameOptions(m, r, entries, channel, deviceId) {
  var others = othersOf(entries, deviceId).map(function (c) { return resolver.splitChannelKey(c).name; });
  var options = r.names.slice();
  if (channel && options.indexOf(channel) < 0) { options.unshift(channel); }
  r.names.forEach(function (n) {
    if ((m.names[n] || {}).repeatable && others.indexOf(n) >= 0) { options.splice(options.indexOf(n) + 1, 0, nextInstance(n, entries)); }
  });
  return {
    options: options,
    value: channel || (others.indexOf(r.name) >= 0 && (m.names[r.name] || {}).repeatable ? nextInstance(r.name, entries) : r.name)
  };
}

/** Channel keys for the chosen measurements `[{key, name}]`: a name picked once
 * is its own key; a repeatable name picked several times becomes numbered
 * instances, in bus order. A channel the station already has for a measurement
 * keeps its key, so its history keeps it too. Throws on a name picked twice
 * that does not repeat. */
function channelsFor(names, old, chosen) {
  var channels = {};
  // The dry contact interface's channels are its DRYC view's and stay with this device.
  Object.keys(old).forEach(function (c) { if (DRYC_KEY.test(old[c])) { channels[c] = old[c]; } });
  var byName = {};
  chosen.forEach(function (c) { (byName[c.name] = byName[c.name] || []).push(c); });
  Object.keys(byName).forEach(function (name) {
    var group = byName[name];
    if (group.length > 1 && (resolver.splitChannelKey(name).instance || !(names[name] || {}).repeatable)) {
      throw new Error(channelLabel(names, name) + ' (' + name + ') is picked twice and does not repeat');
    }
    var taken = {};
    var rest = group.filter(function (c) {
      var kept = Object.keys(old).filter(function (k) { return old[k] === c.key && resolver.splitChannelKey(k).name === name; })[0];
      if (!kept || (group.length > 1 && !resolver.splitChannelKey(kept).instance)) { return true; }
      channels[kept] = c.key;
      taken[resolver.splitChannelKey(kept).instance || 1] = true;
      return false;
    });
    if (group.length === 1) { rest.forEach(function (c) { channels[name] = c.key; }); return; }
    var n = 1;
    rest.forEach(function (c) {
      while (taken[n]) { n++; }
      taken[n] = true;
      channels[name + '-' + n] = c.key;
    });
  });
  return channels;
}

/** The station's entries once the device's channels are `channels`: its old ones
 * go, and another device's channel stays unless a name here takes it over.
 * `{next, takenOver}`. */
function withDevice(entries, deviceId, channels) {
  var next = {}, takenOver = [];
  Object.keys(entries).forEach(function (c) {
    if (entries[c].device === deviceId) { return; }
    if (channels[c] !== undefined) { takenOver.push(c); return; }
    next[c] = entries[c];
  });
  Object.keys(channels).forEach(function (c) { next[c] = { device: deviceId, key: channels[c] }; });
  return { next: next, takenOver: takenOver };
}

/** The station's entries once measurement `key` of the device is stored under
 * `target` instead of channel `from` (null when not stored yet), or leaves the
 * station when `target` is null. A channel another device feeds moves to this
 * measurement; one this device feeds from another measurement cannot.
 * `{next, takenOver}`, `takenOver` the entry it replaces, or `{own: true}`. */
function storeOne(entries, deviceId, key, from, target) {
  var next = Object.assign({}, entries);
  if (from) { delete next[from]; }
  if (!target) { return { next: next, takenOver: null }; }
  var held = next[target];
  if (held && held.device === deviceId) { return { own: true }; }
  next[target] = { device: deviceId, key: key };
  return { next: next, takenOver: held || null };
}

root.TerrySenseMapping = {
  SOURCE_KEY_RE: SOURCE_KEY_RE, NOT_READINGS: NOT_READINGS, RULE_SOURCE: RULE_SOURCE, DRYC_KEY: DRYC_KEY,
  LOGR2_SENSORS: LOGR2_SENSORS, NETWORK_KEYS: NETWORK_KEYS,
  parseSource: parseSource, latestKeys: latestKeys, topology: topology, sources: sources, measureOf: measureOf,
  sourceLabel: sourceLabel, unitOf: unitOf, readings: readings, nameOf: nameOf, entryOf: entryOf, labelOf: labelOf,
  readingUnit: readingUnit, logr2Parts: logr2Parts, mineOf: mineOf, othersOf: othersOf, mappedNames: mappedNames,
  namesForKind: namesForKind, namesForReading: namesForReading, mappable: mappable, channelLabel: channelLabel,
  nextInstance: nextInstance, nameOptions: nameOptions, channelsFor: channelsFor, withDevice: withDevice, storeOne: storeOne
};

})(typeof self !== 'undefined' ? self : this);
