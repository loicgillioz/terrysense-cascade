/*
 * Device — one device of any type: is it live, what it measures and which
 * station channel each measurement feeds (TC-1 to TC-7); for a user who may
 * write it, connecting it to a station, a new one included, and choosing the
 * channels (CA-1), and on a LOGR3 or LOGR4 the commands that reconfigure it
 * (CA-4, TC-8/9). Read-only for anyone else.
 *
 * Laid out as the device's status beside the stations it feeds, above its
 * topology: the LOGR and what hangs off it, one card per position. The layout
 * depends on the family:
 *   bus    LOGR3, LOGR4: positions from `topology.p<POS>.*`, sources from
 *          `subscriptions.*` and the stored telemetry keys, each with its
 *          interval and whether it is enabled; configurable by command.
 *   logr2  the LOGR and its one or two sensors, fixed in its firmware:
 *          readings grouped by their peripheral prefix; a sensor no longer
 *          used can be removed, its readings deleted; the register.
 *   other  any other device: its readings in one card; the register.
 *
 * A bus source's state is its latest reading: a value newer than its
 * `<sourceKey>.status` is OK, otherwise the status code is the fault the
 * device stated (HEALTH.md §1). Faults counted in the header are the device's
 * active `peripheralFault.*` alarms. A command is written as `cmd.request`;
 * `dl_dispatch` sends it and `dl_ack` turns the answer into `cmd.lastResult`
 * (DOWNLINK.md).
 *
 * Connecting writes the STATION -> DEVICE `Contains` relation, the station's
 * `config.channelMap`, then a resolve. A station keeps one source device (CHANNEL_MAP.md §3), so connecting to a
 * station fed by another device replaces it and keeps the channels this one
 * reports. The relay controller's `drycRule.*` channels belong to the DRYC
 * widget and are kept. Widget: logr-product-docs/cloud/DEVICE_VIEW.md.
 *
 * `opts`, set by build_device_dashboard.py: `projectDashboardId`, whose Station
 * view a station opens.
 *
 * Loads after shared/resolver.js, glossary.js, ui.js and tb_io.js.
 */

window.TerrySenseDeviceTopology = function (ctx, container, opts) {

opts = opts || {};

var resolver = window.TerrySenseResolver;
var G = window.TerrySenseGlossary;
var tb = window.TerrySenseTbIo(ctx);
var root = container.querySelector('.ts-root') || container;
var ui = window.TerrySenseUi(root);
var h = ui.h, esc = ui.esc, ICON = ui.ICON, info = ui.info;
var camel = resolver.camelKind;

var EMPTY_MARKER = '(empty)';
var TOPOLOGY_TYPE_RE = /^topology\.p(\d+)\.type$/;
var SOURCE_KEY_RE = /^p(\d+)\.([a-z][A-Za-z0-9]*)(?:\.g(\d+))?(?:\.i(\d+))?$/;
var FAULT_PREFIX = 'peripheralFault.';
var MARKER_RE = /^cmd\.seq\.(\d+)$/;
var REFRESH_MS = 60000;
var HOUR_MS = 3600000;
var DAY_MS = 86400000;
var NETWORK_KEYS = ['rssi', 'snr'];
var BATTERY_VOLTAGE = ['p0.voltage', 'p0.voltage.i0', 'logr.batteryVoltage'];
var BATTERY_CHARGING = ['p0.boolean', 'logr.batteryCharging'];
var POWER_SOURCES = { usb: 'USB', sp_int: 'internal solar', sp_ext: 'external solar', bus: 'bus', none: 'none' };
var SD_STATES = { ready: 'ready', fault: 'fault', not_inserted: 'no card' };
var NEW_STATION = '__new';
// Device bookkeeping, not readings: radio, uplink markers, the relay controller's own counters.
var NOT_READINGS = ['rssi', 'snr', 'uplinkCause', 'uplinkLatest', 'dryc.drycRuleCount', 'dryc.drycRulesSynced'];
var RULE_SOURCE = /^drycRule\./;
var REGISTER = [
  { key: 'register.hwVersion', label: 'Hardware version' },
  { key: 'register.hwStatus', label: 'Hardware status' },
  { key: 'register.loraFw', label: 'LoRa module firmware' },
  { key: 'register.dfu', label: 'Firmware update (DFU)', flag: true }
];
var FINE_STATUS = /^(all functional|ok|)$/i;
// The sensors a LOGR2 can carry, by the peripheral prefix of its device keys
// (`cond.temperature`): cloud-integrations/sources/logr2.json, kept equal by
// smoke_test_config_widgets.py. `logr` is the LOGR itself.
var LOGR2_SENSORS = { phpr: 'pH probe', cond: 'Conductivity probe', dryc: 'Relay controller', flow: 'Flow meter',
  clmt: 'Climate sensor', inclTilt: 'Inclinometer or tiltmeter', usonRdar: 'Ultrasonic or radar level sensor' };

function parseSource(key) {
  var m = SOURCE_KEY_RE.exec(key);
  return m ? {
    sourceKey: key, position: Number(m[1]), kind: m[2],
    group: m[3] !== undefined ? Number(m[3]) : 0, index: m[4] !== undefined ? Number(m[4]) : 0,
    hasGroup: m[3] !== undefined, hasIndex: m[4] !== undefined
  } : null;
}

/** `ph` -> `PH`, `drycStatus` -> `DRYC_STATUS`: the wire kind the encoder takes. */
function wireKind(kind) { return String(kind).replace(/([A-Z])/g, '_$1').toUpperCase(); }

function sourceTarget(s) {
  var t = { mode: 'SOURCE', position: s.position, kind: wireKind(s.kind) };
  if (s.hasGroup) { t.group = s.group; }
  if (s.hasIndex) { t.index = s.index; }
  return t;
}

function parseJson(raw) {
  if (!raw) { return null; }
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (e) { return null; }
}

function ago(ts) {
  if (!ts) { return 'never'; }
  var s = Math.max(0, (Date.now() - Number(ts)) / 1000);
  if (s < 90) { return 'just now'; }
  if (s < 5400) { return Math.round(s / 60) + ' min ago'; }
  if (s < 129600) { return Math.round(s / 3600) + ' h ago'; }
  return Math.round(s / 86400) + ' days ago';
}

function fmtDuration(sec) {
  var s = Number(sec);
  if (!isFinite(s)) { return String(sec); }
  if (s < 120) { return Math.round(s) + ' s'; }
  if (s < 7200) { return Math.round(s / 60) + ' min'; }
  if (s < 172800) { return Math.round(s / 3600) + ' h'; }
  return Math.round(s / 86400) + ' days';
}

function fmtValue(v) {
  if (v === true || v === 'true') { return 'on'; }
  if (v === false || v === 'false') { return 'off'; }
  var n = Number(v);
  if (v === '' || v === null || isNaN(n)) { return String(v); }
  return String(Math.round(n * 1000) / 1000);
}

function errText(err) { return (err && (err.message || (err.error && err.error.message))) || String(err); }

// -- data -------------------------------------------------------------------------------

var state = {
  device: null, client: {}, server: {}, latest: {}, faults: {}, peripherals: {}, kinds: {}, names: {},
  showBoard: false, loadedAt: 0, writable: false, me: null,
  bindings: [], wiring: {}
};

function deviceEntity() {
  return { entityType: 'DEVICE', id: state.device.id.id, ownerId: state.device.ownerId && state.device.ownerId.id };
}

/** bus | logr2 | other: how the device is laid out and what it lets change. */
function family() {
  if (tb.isComplexDevice(state.device.type)) { return 'bus'; }
  return state.device.type === 'logr2' ? 'logr2' : 'other';
}

function loadDefaults() {
  return tb.io.fetchDefaults().then(function (d) { return d ? tb.attrsMap(d) : {}; }).then(function (a) {
    state.peripherals = parseJson(a['config.peripherals']) || {};
    state.kinds = parseJson(a['config.kinds']) || {};
    state.names = parseJson(a['config.channelNames']) || {};
  });
}

function loadDevice(id) {
  var dev = { entityType: 'DEVICE', id: id };
  return Promise.all([
    tb.get('/api/device/' + id),
    tb.attrsMap(dev, 'CLIENT_SCOPE'),
    tb.attrsMap(dev, 'SERVER_SCOPE'),
    tb.get('/api/plugins/telemetry/DEVICE/' + id + '/keys/timeseries').catch(function () { return []; }),
    tb.get('/api/alarm/DEVICE/' + id, { searchStatus: 'ACTIVE', pageSize: '100', page: '0' }).catch(function () { return null; })
  ]).then(function (got) {
    state.device = got[0];
    state.client = got[1];
    state.server = got[2];
    state.faults = {};
    ((got[4] && got[4].data) || []).forEach(function (a) {
      if (a.type.indexOf(FAULT_PREFIX) === 0) { state.faults[a.type.slice(FAULT_PREFIX.length)] = a; }
    });
    var bus = family() === 'bus';
    var keys = (got[3] || []).filter(function (k) {
      return bus ? parseSource(k.replace(/\.status$/, '')) || NETWORK_KEYS.indexOf(k) >= 0 : !/\.status$/.test(k);
    });
    if (!keys.length) { return {}; }
    return tb.get('/api/plugins/telemetry/DEVICE/' + id + '/values/timeseries', { keys: keys.join(',') });
  }).then(function (latest) {
    state.latest = {};
    Object.keys(latest || {}).forEach(function (k) {
      var p = latest[k] && latest[k][0];
      if (p) { state.latest[k] = { ts: Number(p.ts), value: p.value }; }
    });
    return loadBindings(id);
  }).then(function () {
    state.loadedAt = Date.now();
  });
}

/** The Stations that contain the device, each with its channel map and whether
 * the user may write it; and which station channel each source feeds (TC-2,
 * CHANNEL_MAP.md). */
function loadBindings(id) {
  var query = {
    parameters: { rootId: id, rootType: 'DEVICE', direction: 'TO', relationTypeGroup: 'COMMON', maxLevel: 1, fetchLastLevelOnly: false },
    filters: [{ relationType: 'Contains', entityTypes: ['ASSET'] }]
  };
  return tb.post('/api/relations', query).then(function (rels) {
    return Promise.all((rels || []).map(function (r) { return tb.getAsset(r.from.id); }));
  }).then(function (assets) {
    return Promise.all(assets.filter(function (a) { return a && a.type === 'Station'; }).map(function (a) {
      var station = tb.assetLevel(a);
      station.ownerId = a.ownerId && a.ownerId.id;
      return Promise.all([tb.attrsMap(station), tb.canWrite(station)]).then(function (got) {
        return { station: station, attrs: got[0], map: parseJson(got[0]['config.channelMap']) || {}, writable: got[1] };
      });
    }));
  }).then(function (list) {
    state.bindings = list.sort(function (a, b) { return a.station.name.localeCompare(b.station.name); });
    state.wiring = {};
    list.forEach(function (b) {
      var channels = b.map.channels || {};
      Object.keys(channels).forEach(function (key) {
        (state.wiring[channels[key]] = state.wiring[channels[key]] || []).push({
          station: b.station.name, channel: key, label: b.attrs['effective.' + key + '.label'] || ''
        });
      });
    });
  }).catch(function () { state.bindings = []; state.wiring = {}; });
}

// -- model ------------------------------------------------------------------------------

function topology() {
  var nodes = {};
  Object.keys(state.client).forEach(function (key) {
    var m = TOPOLOGY_TYPE_RE.exec(key);
    if (!m) { return; }
    var type = String(state.client[key] || '').trim();
    if (!type || type === EMPTY_MARKER) { return; }
    nodes[m[1]] = { position: Number(m[1]), type: type, version: state.client['topology.p' + m[1] + '.version'] };
  });
  return nodes;
}

function sources() {
  var out = {};
  function add(key) { var s = parseSource(key); if (s && !out[key]) { out[key] = s; } return out[key]; }
  Object.keys(state.client).forEach(function (key) {
    var m = /^subscriptions\.(.+)\.(enabled|interval)$/.exec(key);
    var s = m && add(m[1]);
    if (s) { s[m[2]] = state.client[key]; }
  });
  Object.keys(state.latest).forEach(function (key) { add(key.replace(/\.status$/, '')); });
  Object.keys(state.faults).forEach(add);
  return Object.keys(out).map(function (k) { return out[k]; });
}

/** ok | fault | waiting | disabled, from the latest value and status of one source. */
function sourceState(s) {
  var v = state.latest[s.sourceKey], st = state.latest[s.sourceKey + '.status'];
  if (st && (!v || st.ts >= v.ts)) { return { state: 'fault', code: String(st.value), ts: st.ts }; }
  if (v) { return { state: 'ok', value: v.value, ts: v.ts }; }
  if (s.enabled === false || s.enabled === 'false') { return { state: 'disabled' }; }
  return { state: 'waiting' };
}

function measureOf(s, node) {
  var p = node && state.peripherals[node.type];
  return p && (p.measures || []).filter(function (m) {
    return camel(m.kind) === s.kind && m.group === s.group && m.index === s.index;
  })[0];
}

function sourceLabel(s, node) {
  var m = measureOf(s, node);
  var entry = m && state.names[m.defaultName];
  return entry && entry.label ? entry.label : ((resolver.kindSpec(s.kind, state.kinds) || {}).label || s.kind);
}

function unitOf(s) { return (resolver.kindSpec(s.kind, state.kinds) || {}).cloudUnit || ''; }

/** A LOGR2's or any other device's readings: its stored keys, dictionary names. */
function readings() {
  return Object.keys(state.latest).filter(function (k) {
    return NOT_READINGS.indexOf(k) < 0 && !RULE_SOURCE.test(k);
  }).sort(function (a, b) { return labelOf(a).localeCompare(labelOf(b)); });
}

/** The channel name a reading carries: a LOGR2 key after its peripheral prefix, any other key whole. */
function nameOf(key) { return family() === 'logr2' ? key.slice(key.indexOf('.') + 1) : key; }
function entryOf(key) { return state.names[resolver.splitChannelKey(nameOf(key)).name] || null; }
function labelOf(key) { var e = entryOf(key); return (e && e.label) || key; }
function readingUnit(key) {
  var e = entryOf(key);
  return e ? ((resolver.kindSpec(camel(e.kind), state.kinds) || {}).cloudUnit || '') : '';
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

function namesForKind(kind) {
  return Object.keys(state.names).filter(function (n) { return camel(state.names[n].kind) === kind; })
    .sort(function (a, b) {
      return !!state.names[a].diagnostic - !!state.names[b].diagnostic || (state.names[a].label || a).localeCompare(state.names[b].label || b);
    });
}

/** What a station can take from this device: one row per measurement, with the
 * channel name it gets by default. A LOGR3 or LOGR4 source is renamed to a
 * vocabulary name of its kind; any other reading keeps its own name, a LOGR2's
 * without its peripheral prefix. */
function mappable() {
  if (family() !== 'bus') {
    return readings().map(function (key) {
      return { key: key, label: labelOf(key), names: null, name: nameOf(key), diagnostic: !!(entryOf(key) || {}).diagnostic };
    });
  }
  var nodes = topology();
  return sources().sort(function (a, b) { return a.position - b.position || a.sourceKey.localeCompare(b.sourceKey); }).map(function (s) {
    var m = measureOf(s, nodes[s.position]);
    var name = m && state.names[m.defaultName] ? m.defaultName : namesForKind(s.kind)[0] || null;
    return {
      key: s.sourceKey, label: sourceLabel(s, nodes[s.position]) + (s.position ? ' · position ' + s.position : ' · the LOGR itself'),
      names: namesForKind(s.kind), name: name, diagnostic: s.position === 0 || !!(name && (state.names[name] || {}).diagnostic)
    };
  }).filter(function (r) { return r.names.length; });
}


// -- commands (CA-4, TC-8/9) ---------------------------------------------------------------

function parseValue(raw) { return typeof raw === 'string' ? parseJson(raw) : raw; }

/** Commands still waiting for an ACK; one past its window is unanswered. */
function pending() {
  var interval = Number(state.client['status.baseIntervalSeconds']) || 0;
  var window = Math.max(DAY_MS, 2 * interval * 1000);
  return Object.keys(state.server).filter(function (k) { return MARKER_RE.test(k); }).map(function (k) {
    var m = parseValue(state.server[k]) || {};
    return { key: k, seq: m.seq, commands: m.commands || [], issuedAt: Number(m.issuedAt) || 0,
             unanswered: Date.now() - (Number(m.issuedAt) || 0) > window };
  }).sort(function (a, b) { return b.issuedAt - a.issuedAt; });
}

function targetText(t) {
  if (!t || t.mode === 'GLOBAL' || !t.mode) { return ''; }
  if (t.mode === 'POSITION') { return ' at position ' + t.position; }
  return ' of p' + t.position + '.' + camel(t.kind) + (t.group ? '.g' + t.group : '') + (t.index !== undefined ? '.i' + t.index : '');
}

function commandText(c) {
  var what = {
    SET_INTERVAL: 'Interval' + targetText(c.target) + ' → ' + c.interval_s + ' s',
    SET_ENABLED: (c.enabled ? 'Enable' : 'Disable') + targetText(c.target),
    SELF_DIAG: 'Self-diagnostic',
    REQUEST_REPORT: 'Request reports' + (c.reports ? ': ' + c.reports.join(', ') : ''),
    CREATE_SUBSCRIPTION: 'Subscribe' + targetText(c.target) + ' every ' + c.interval_s + ' s',
    DELETE_SUBSCRIPTION: 'Remove subscription' + targetText(c.target),
    PERIPHERAL_OP: 'Peripheral operation' + targetText(c.target)
  }[c.op];
  return what || String(c.op);
}

function resultText(r) {
  if (r.status !== 'OK') { return r.opcode + ': ' + (G.COMMAND_STATUS[r.status] || r.status); }
  if (r.applied_interval_s !== undefined) { return r.opcode + ': OK, now ' + r.applied_interval_s + ' s'; }
  if (r.selfdiag_faults) { return r.opcode + ': ' + (r.selfdiag_faults.length ? 'faults ' + r.selfdiag_faults.join(', ') : 'all healthy'); }
  return r.opcode + ': OK';
}

function send(commands, retryOf) {
  var list = commands.map(function (c) { return '<li>' + esc(commandText(c)) + '</li>'; }).join('');
  return ui.confirm('Send to <b>' + esc(state.device.label || state.device.name) + '</b>?<ul>' + list + '</ul>' +
    'It is delivered after the device’s next uplink.', 'Send').then(function (ok) {
    if (!ok) { return; }
    var dev = deviceEntity();
    var request = { commands: commands, by: (state.me && state.me.email) || null, issuedAt: Date.now() };
    return (retryOf ? tb.deleteAttrs(dev, [retryOf]) : Promise.resolve()).then(function () {
      return tb.saveAttrs(dev, { 'cmd.request': request });
    }).then(function () {
      ui.toast('Queued: delivered after the next uplink');
      ui.closeDrawer();
      setTimeout(refresh, 1500);
    }).catch(function (err) {
      ui.toast('Not sent: ' + (err && (err.message || (err.error && err.error.message)) || err), 'error');
    });
  });
}

function sourceDrawer(s, node) {
  var dr = ui.openDrawer(esc(sourceLabel(s, node)), '<span class="ts-mono">' + esc(s.sourceKey) + '</span>');
  var enabled = !(s.enabled === false || s.enabled === 'false');
  dr.body.appendChild(h('<div class="ts-field"><div class="ts-field-label"><span>Measurement interval</span></div>' +
    '<div class="ts-ctl"><span><input class="ts-input num" type="number" min="1" step="1"> s</span> ' +
    '<button type="button" class="ts-btn" data-a="interval">Set interval</button></div>' +
    '<div class="ts-field-hint"></div></div>'));
  var input = dr.body.querySelector('input');
  input.value = s.interval || '';
  dr.body.querySelector('.ts-field-hint').textContent = s.interval ? 'The device reports ' + s.interval + ' s.' : 'The device has not reported this interval.';
  dr.body.appendChild(h('<div class="ts-field"><div class="ts-field-label"><span>Subscription</span></div><div class="ts-ctl">' +
    '<button type="button" class="ts-btn" data-a="toggle"></button> <button type="button" class="ts-btn" data-a="remove">Remove subscription</button></div></div>'));
  dr.body.querySelector('[data-a=toggle]').textContent = enabled ? 'Disable' : 'Enable';
  dr.body.addEventListener('click', function (e) {
    var a = e.target.closest('[data-a]');
    if (!a) { return; }
    var t = sourceTarget(s);
    if (a.dataset.a === 'interval') {
      var v = Number(input.value);
      if (!(v >= 1 && v <= 65535 && Math.floor(v) === v)) { ui.toast('An interval is a whole number of seconds, 1 to 65535', 'error'); return; }
      send([{ op: 'SET_INTERVAL', target: t, interval_s: v }]);
    } else if (a.dataset.a === 'toggle') {
      send([{ op: 'SET_ENABLED', target: t, enabled: !enabled }]);
    } else if (a.dataset.a === 'remove') {
      send([{ op: 'DELETE_SUBSCRIPTION', target: t }]);
    }
  });
}

/** Catalog measures of a position that the device neither subscribes nor reports. */
function unsubscribed(pos, node, own) {
  var p = node && state.peripherals[node.type];
  if (!p) { return []; }
  var have = {};
  own.forEach(function (s) { have[s.sourceKey] = true; });
  var count = {};
  (p.measures || []).forEach(function (m) { count[m.kind] = (count[m.kind] || 0) + 1; });
  return (p.measures || []).map(function (m) {
    var indexed = count[m.kind] > 1;
    var key = 'p' + pos + '.' + camel(m.kind) + (m.group ? '.g' + m.group : '') + (indexed ? '.i' + m.index : '');
    var target = { mode: 'SOURCE', position: pos, kind: m.kind };
    if (m.group) { target.group = m.group; }
    if (indexed) { target.index = m.index; }
    return { sourceKey: key, measure: m, target: target };
  }).filter(function (c) { return !have[c.sourceKey]; });
}

function addDrawer(pos, node, own) {
  var dr = ui.openDrawer('Add a subscription', 'Position ' + pos + ' · ' + esc(node.type));
  var options = unsubscribed(pos, node, own);
  dr.body.appendChild(h('<div class="ts-field"><div class="ts-field-label"><span>Interval</span></div>' +
    '<div class="ts-ctl"><span><input class="ts-input num" type="number" min="1" step="1" value="900"> s</span></div></div>'));
  var input = dr.body.querySelector('input');
  options.forEach(function (o) {
    var entry = state.names[o.measure.defaultName] || {};
    var row = h('<div class="ts-tsrc"><div><div class="ts-row-label"></div><div class="ts-mono"></div></div><span></span>' +
      '<div class="ts-tsrc-value"><button type="button" class="ts-btn">Subscribe</button></div></div>');
    row.querySelector('.ts-row-label').textContent = entry.label || o.measure.defaultName;
    row.querySelector('.ts-mono').textContent = o.sourceKey;
    row.querySelector('button').addEventListener('click', function () {
      var v = Number(input.value);
      if (!(v >= 1 && v <= 65535 && Math.floor(v) === v)) { ui.toast('An interval is a whole number of seconds, 1 to 65535', 'error'); return; }
      send([{ op: 'CREATE_SUBSCRIPTION', target: o.target, interval_s: v }]);
    });
    dr.body.appendChild(row);
  });
}

function commandsSection() {
  var list = pending();
  var last = parseValue(state.server['cmd.lastResult']);
  if (!state.writable && !list.length && !last) { return null; }
  var sec = h('<div class="ts-section"><div class="ts-section-head">Commands ' + info('commands') + '</div></div>');
  if (state.writable) {
    var bar = h('<div class="ts-cmdbar"><button type="button" class="ts-btn" data-a="reports">Request reports</button>' +
      '<button type="button" class="ts-btn" data-a="diag">Self-diagnostic</button></div>');
    bar.addEventListener('click', function (e) {
      var a = e.target.closest('[data-a]');
      if (!a) { return; }
      send([a.dataset.a === 'reports'
        ? { op: 'REQUEST_REPORT', target: { mode: 'GLOBAL' }, reports: ['topology', 'subscriptions', 'status', 'device_info'] }
        : { op: 'SELF_DIAG', target: { mode: 'GLOBAL' } }]);
    });
    sec.appendChild(bar);
  }
  list.forEach(function (p) {
    var row = h('<div class="ts-cmd" data-cmd="' + (p.unanswered ? 'unanswered' : 'queued') + '"><div class="ts-grow"><div class="ts-row-label"></div><div class="ts-row-meta"></div></div></div>');
    row.querySelector('.ts-row-label').textContent = p.commands.map(commandText).join(' · ');
    row.querySelector('.ts-row-meta').textContent = (p.unanswered ? 'No answer, sent ' : 'Queued, sent ') + ago(p.issuedAt);
    row.insertBefore(h('<span class="ts-chip ' + (p.unanswered ? 'fault">No answer' : 'warn">Queued') + '</span>'), row.firstChild);
    if (p.unanswered && state.writable) {
      var retry = h('<button type="button" class="ts-btn">Retry</button>');
      retry.addEventListener('click', function () { send(p.commands, p.key); });
      row.appendChild(retry);
    }
    sec.appendChild(row);
  });
  if (last) {
    var row = h('<div class="ts-cmd" data-cmd="' + (last.ok ? 'delivered' : 'failed') + '"><span class="ts-chip ' + (last.ok ? 'ok">Delivered' : 'fault">Failed') + '</span>' +
      '<div class="ts-grow"><div class="ts-row-label"></div><div class="ts-row-meta"></div></div></div>');
    row.querySelector('.ts-row-label').textContent = (last.commands || []).map(commandText).join(' · ') || 'Command #' + last.seq;
    row.querySelector('.ts-row-meta').textContent = (last.results || []).map(resultText).join(' · ') + ' · answered ' + ago(last.ackedAt);
    sec.appendChild(row);
  }
  return sec;
}

// -- stations (CA-1) -------------------------------------------------------------------------

function ownerOf() { return state.device.ownerId || {}; }

function stationsToPick() {
  var owner = ownerOf();
  return owner.entityType === 'CUSTOMER' ? tb.io.fetchCustomerStations({ id: owner.id }) : tb.io.fetchAllStations();
}

/** Where a new station can go: the projects and locations of the device's owner. */
function parentsToPick() {
  var owner = ownerOf().id;
  return Promise.all(['Project', 'Location'].map(function (type) {
    return tb.getAll('/api/user/assets', { type: type }).catch(function () { return []; });
  })).then(function (got) {
    return got[0].concat(got[1]).filter(function (a) { return a.ownerId && a.ownerId.id === owner; }).map(function (a) {
      var level = tb.assetLevel(a);
      level.ownerId = owner;
      return level;
    }).sort(function (a, b) { return a.kind.localeCompare(b.kind) * -1 || a.name.localeCompare(b.name); });
  });
}

function relate(fromId, toId, toType) {
  return tb.post('/api/relation', {
    from: { id: fromId, entityType: 'ASSET' }, to: { id: toId, entityType: toType }, type: 'Contains', typeGroup: 'COMMON'
  });
}
function unrelate(stationId, deviceId) {
  return tb.del('/api/relation', { fromId: stationId, fromType: 'ASSET', toId: deviceId, toType: 'DEVICE', relationType: 'Contains', relationTypeGroup: 'COMMON' });
}
function stationDevices(stationId) {
  var query = {
    parameters: { rootId: stationId, rootType: 'ASSET', direction: 'FROM', relationTypeGroup: 'COMMON', maxLevel: 1, fetchLastLevelOnly: false },
    filters: [{ relationType: 'Contains', entityTypes: ['DEVICE'] }]
  };
  return tb.post('/api/relations', query).then(function (rels) { return (rels || []).map(function (r) { return r.to.id; }); });
}

/** A new station, owned by the device's owner, `Contains`-related from its parent. */
function createStation(name, parent) {
  var owner = ownerOf();
  var body = { name: name, type: 'Station' };
  if (owner.entityType === 'CUSTOMER') { body.customerId = { id: owner.id, entityType: 'CUSTOMER' }; }
  return tb.post('/api/asset', body).then(function (created) {
    var station = { entityType: 'ASSET', id: created.id.id, name: created.name, kind: 'Station' };
    return relate(parent.id, station.id, 'ASSET').then(function () { return station; });
  });
}

/** Pick a station, a new one included, or the channels of one already fed. */
function bindDrawer(binding) {
  var dr = ui.openDrawer(binding ? esc(binding.station.name) : 'Connect to a station', esc(state.device.label || state.device.name));
  var picked = binding ? binding.station : null;
  var pickedMap = binding ? binding.map : null;
  var rows = mappable();
  var body = dr.body;

  var stationField = h('<div class="ts-field"><div class="ts-field-label"><span>Station</span></div><div class="ts-ctl"></div><div class="ts-field-hint" data-f="hint"></div></div>');
  var hint = stationField.querySelector('[data-f=hint]');
  var newFields = h('<div data-f="new" hidden><div class="ts-field"><div class="ts-field-label"><span>Name of the new station</span></div>' +
    '<div class="ts-ctl"><input class="ts-input wide" type="text" data-f="newName"></div></div>' +
    '<div class="ts-field"><div class="ts-field-label"><span>In</span></div><div class="ts-ctl">' +
    '<select class="ts-select wide" data-f="parent"><option value="">Pick a project or location</option></select></div></div></div>');
  var parents = [];
  if (binding) {
    stationField.querySelector('.ts-ctl').appendChild(h('<b></b>')).textContent = binding.station.name;
  } else {
    var sel = h('<select class="ts-select wide" data-f="station"><option value="">Pick a station</option>' +
      '<option value="' + NEW_STATION + '">New station…</option></select>');
    stationField.querySelector('.ts-ctl').appendChild(sel);
    stationsToPick().then(function (list) {
      var bound = {};
      state.bindings.forEach(function (b) { bound[b.station.id] = true; });
      list.filter(function (s) { return !bound[s.id]; }).sort(function (a, b) { return a.name.localeCompare(b.name); }).forEach(function (s) {
        var o = document.createElement('option'); o.value = s.id; o.textContent = s.name; o.dataset.name = s.name; sel.appendChild(o);
      });
    });
    parentsToPick().then(function (list) {
      parents = list;
      var psel = newFields.querySelector('[data-f=parent]');
      list.forEach(function (p) {
        var o = document.createElement('option'); o.value = p.id; o.textContent = p.name + ' (' + p.kind.toLowerCase() + ')'; psel.appendChild(o);
      });
    });
    sel.addEventListener('change', function () {
      var creating = sel.value === NEW_STATION;
      newFields.hidden = !creating;
      picked = sel.value && !creating ? { entityType: 'ASSET', id: sel.value, name: sel.selectedOptions[0].dataset.name, kind: 'Station' } : null;
      pickedMap = null;
      hint.textContent = '';
      tick(null);
      if (!picked) { return; }
      tb.attrsMap(picked).then(function (a) {
        pickedMap = parseJson(a['config.channelMap']) || {};
        var other = pickedMap.sourceDeviceId && pickedMap.sourceDeviceId !== state.device.id.id;
        hint.textContent = other
          ? 'This station is fed by another device. Connecting replaces it: the station keeps its history and the channels this device also reports.'
          : '';
        tick(pickedMap);
      });
    });
  }
  body.appendChild(stationField);
  body.appendChild(newFields);

  var list = h('<div class="ts-field"><div class="ts-field-label"><span>Measurements stored on the station ' + info('channelName') + '</span></div><div class="ts-binds"></div>' +
    '<div class="ts-field-hint"></div></div>');
  list.querySelector('.ts-field-hint').textContent = family() === 'bus'
    ? 'Each measurement is stored under the channel name picked beside it.'
    : 'Each reading keeps its own name on the station.';
  var boxes = list.querySelector('.ts-binds');
  rows.forEach(function (r) {
    var row = h('<div class="ts-bindrow"><label class="ts-switch"><input type="checkbox"> <span></span></label></div>');
    row.querySelector('input').dataset.key = r.key;
    row.querySelector('span').textContent = r.label + (r.label !== r.key ? ' (' + r.key + ')' : '');
    if (r.names) {
      var names = h('<select class="ts-select"></select>');
      names.dataset.nameFor = r.key;
      r.names.forEach(function (n) {
        var o = document.createElement('option'); o.value = n; o.textContent = (state.names[n].label || n) + ' (' + n + ')'; names.appendChild(o);
      });
      names.value = r.name;
      row.appendChild(names);
    }
    boxes.appendChild(row);
  });
  if (!rows.length) { boxes.appendChild(h('<div class="ts-empty">Nothing measured by this device yet.</div>')); }
  body.appendChild(list);

  /** Tick what the station already takes from this device, else every
   * non-diagnostic measurement whose name is still free or repeats. */
  function tick(map) {
    var mine = map && (!map.sourceDeviceId || map.sourceDeviceId === state.device.id.id) ? map.channels || {} : {};
    var mapped = Object.keys(mine).length > 0;
    var used = {};
    rows.forEach(function (r) {
      var box = boxes.querySelector('input[data-key="' + r.key + '"]');
      var channel = Object.keys(mine).filter(function (c) { return mine[c] === r.key; })[0];
      box.checked = mapped ? !!channel : !r.diagnostic && (!used[r.name] || !!(state.names[r.name] || {}).repeatable);
      if (box.checked) { used[r.name] = true; }
      var names = boxes.querySelector('[data-name-for="' + r.key + '"]');
      if (names) { names.value = channel && r.names.indexOf(resolver.splitChannelKey(channel).name) >= 0 ? resolver.splitChannelKey(channel).name : r.name; }
    });
  }
  tick(pickedMap);

  ui.drawerActions(dr, 'Save').addEventListener('click', function () {
    var chosen = [];
    rows.forEach(function (r) {
      if (!boxes.querySelector('input[data-key="' + r.key + '"]').checked) { return; }
      var names = boxes.querySelector('[data-name-for="' + r.key + '"]');
      chosen.push({ key: r.key, name: names ? names.value : r.name, fixed: !names });
    });
    if (!chosen.length) { ui.toast('Pick at least one measurement', 'error'); return; }
    if (!binding && sel.value === NEW_STATION) {
      var name = newFields.querySelector('[data-f=newName]').value.trim();
      var parent = parents.filter(function (p) { return p.id === newFields.querySelector('[data-f=parent]').value; })[0];
      if (!name || !parent) { ui.toast('Name the new station and pick where it goes', 'error'); return; }
      save(null, {}, chosen, { name: name, parent: parent });
      return;
    }
    if (!picked) { ui.toast('Pick a station', 'error'); return; }
    save(picked, pickedMap || {}, chosen, null);
  });
}

/** Channel keys for the chosen measurements: a name picked once is its own key;
 * a repeatable name picked several times becomes numbered instances, in bus
 * order. A channel the station already has for a measurement keeps its key, so
 * its history keeps it too. */
function channelsFor(old, chosen, replacing) {
  var channels = {};
  // The relay controller's rule channels stay with the station's device.
  if (!replacing) { Object.keys(old).forEach(function (c) { if (RULE_SOURCE.test(old[c])) { channels[c] = old[c]; } }); }
  var byName = {};
  chosen.forEach(function (c) { (byName[c.name] = byName[c.name] || []).push(c); });
  Object.keys(byName).forEach(function (name) {
    var group = byName[name];
    if (group.length > 1 && !(state.names[name] || {}).repeatable) { throw new Error((state.names[name] || {}).label + ' (' + name + ') is picked twice and does not repeat'); }
    var taken = {};
    var rest = group.filter(function (c) {
      var kept = Object.keys(old).filter(function (k) { return old[k] === c.key && (c.fixed || resolver.splitChannelKey(k).name === name); })[0];
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

function save(station, map, chosen, create) {
  var old = map.channels || {};
  var replacing = !!(map.sourceDeviceId && map.sourceDeviceId !== state.device.id.id);
  var channels;
  try { channels = channelsFor(old, chosen, replacing); } catch (e) { ui.toast(e.message, 'error'); return; }
  var n = chosen.length + (chosen.length === 1 ? ' measurement' : ' measurements');
  var device = esc(state.device.label || state.device.name);
  var text = create
    ? 'Create station <b>' + esc(create.name) + '</b> in <b>' + esc(create.parent.name) + '</b> and store ' + n + ' of <b>' + device + '</b> on it?'
    : replacing
      ? 'Replace the device of <b>' + esc(station.name) + '</b> with <b>' + device + '</b>? The history stays on the station.'
      : 'Store ' + n + ' on <b>' + esc(station.name) + '</b>?';
  ui.confirm(text, 'Save').then(function (ok) {
    if (!ok) { return; }
    return (create ? createStation(create.name, create.parent) : Promise.resolve(station)).then(function (s) {
      station = s;
      return stationDevices(station.id);
    }).then(function (current) {
      var others = current.filter(function (id) { return id !== state.device.id.id; });
      return Promise.all(others.map(function (id) { return unrelate(station.id, id); })).then(function () {
        return current.indexOf(state.device.id.id) < 0 ? relate(station.id, state.device.id.id, 'DEVICE') : null;
      });
    }).then(function () {
      return tb.saveAttrs(station, { 'config.channelMap': { sourceDeviceId: state.device.id.id, channels: channels } });
    }).then(function () {
      return tb.resolveStations([station]);
    }).then(function () {
      ui.toast(create ? 'Station created, device connected' : replacing ? 'Device replaced' : 'Saved');
      ui.closeDrawer();
      return refresh();
    }).catch(function (err) { ui.toast('Not saved: ' + errText(err), 'error'); });
  });
}

function disconnect(b) {
  ui.confirm('Disconnect <b>' + esc(state.device.label || state.device.name) + '</b> from <b>' + esc(b.station.name) +
    '</b>? The station keeps its history and its channel names, and stops receiving values.', 'Disconnect').then(function (ok) {
    if (!ok) { return; }
    var map = Object.assign({}, b.map, { sourceDeviceId: null });
    return unrelate(b.station.id, state.device.id.id).then(function () {
      return tb.saveAttrs(b.station, { 'config.channelMap': map });
    }).then(function () {
      ui.toast('Disconnected');
      return refresh();
    }).catch(function (err) { ui.toast('Not disconnected: ' + errText(err), 'error'); });
  });
}

/** Every stored key of a LOGR2 sensor, its bookkeeping and the relay controller's
 * rule matches included. */
function sensorKeys(part) {
  return Object.keys(state.latest).filter(function (k) {
    return k.indexOf(part.id + '.') === 0 || (part.id === 'dryc' && RULE_SOURCE.test(k));
  });
}

/** A LOGR2 sensor no longer used: delete its readings on the device, and take
 * its channels off the stations the user may write. Station history stays. */
function removeSensor(part) {
  var keys = sensorKeys(part);
  var fed = [];
  state.bindings.forEach(function (b) {
    var channels = b.map.channels || {};
    var gone = Object.keys(channels).filter(function (c) { return keys.indexOf(channels[c]) >= 0; });
    if (gone.length && b.writable) { fed.push({ binding: b, gone: gone }); }
  });
  var device = esc(state.device.label || state.device.name);
  var text = 'Remove the <b>' + esc(part.label) + '</b> from <b>' + device + '</b>? Its ' + keys.length +
    ' measurements and their history on the device are deleted.' +
    (fed.length ? ' These station channels stop receiving values and keep their history: <ul>' + fed.map(function (f) {
      return '<li>' + esc(f.binding.station.name) + ' · ' + f.gone.map(esc).join(', ') + '</li>';
    }).join('') + '</ul>' : '') +
    ' A sensor that still reports comes back with its next reading.';
  ui.confirm(text, 'Remove').then(function (ok) {
    if (!ok) { return; }
    return tb.del('/api/plugins/telemetry/DEVICE/' + state.device.id.id + '/timeseries/delete',
      { keys: keys.join(','), deleteAllDataForKeys: 'true', rewriteLatestIfDeleted: 'false' }).then(function () {
      return Promise.all(fed.map(function (f) {
        var channels = Object.assign({}, f.binding.map.channels);
        f.gone.forEach(function (c) { delete channels[c]; });
        return tb.saveAttrs(f.binding.station, { 'config.channelMap': Object.assign({}, f.binding.map, { channels: channels }) });
      }));
    }).then(function () {
      return fed.length ? tb.resolveStations(fed.map(function (f) { return f.binding.station; })) : null;
    }).then(function () {
      ui.toast(part.label + ' removed');
      return refresh();
    }).catch(function (err) { ui.toast('Not removed: ' + errText(err), 'error'); });
  });
}

// -- register -------------------------------------------------------------------------------

/** Hand-kept facts a device cannot report (ATTRIBUTES.md §3): the four
 * `register.*` fields of a LOGR2, and the inactivity timeout of any device
 * other than a LOGR3 or LOGR4. */
function registerFields() { return family() === 'logr2' ? REGISTER : []; }

function registerSection() {
  var s = state.server;
  var sec = h('<div class="ts-section" data-section="register"><div class="ts-section-head">Attributes ' + info('register') +
    '<span class="ts-spacer"></span></div><div class="ts-reg-grid"></div></div>');
  var grid = sec.querySelector('.ts-reg-grid');
  function tile(key, label, value, warn) {
    var el = h('<div class="ts-reg' + (warn ? ' warn' : '') + '"><div class="ts-reg-label"></div><div class="ts-reg-value"></div></div>');
    el.setAttribute('data-register', key);
    el.querySelector('.ts-reg-label').textContent = label;
    el.querySelector('.ts-reg-value').textContent = value;
    grid.appendChild(el);
  }
  registerFields().forEach(function (f) {
    var v = s[f.key];
    if (v === undefined || v === '') { return; }
    if (f.flag) { tile(f.key, f.label, truthyFlag(v) ? 'possible' : 'impossible', !truthyFlag(v)); }
    else { tile(f.key, f.label, String(v), f.key === 'register.hwStatus' && !FINE_STATUS.test(String(v))); }
  });
  var timeout = Number(s.inactivityTimeout);
  tile('inactivityTimeout', 'Inactivity timeout', timeout > 0 ? fmtDuration(timeout / 1000) : 'platform default', false);
  if (state.writable) {
    var edit = h('<button type="button" class="ts-btn ts-reg-edit" data-a="register">' + ICON.edit + 'Edit</button>');
    edit.addEventListener('click', registerDrawer);
    sec.querySelector('.ts-section-head').appendChild(edit);
  }
  return sec;
}

function registerDrawer() {
  var s = state.server;
  var dr = ui.openDrawer('Attributes', esc(state.device.name));
  registerFields().forEach(function (f) {
    var field = h('<div class="ts-field"><div class="ts-field-label"><span></span></div><div class="ts-ctl"></div></div>');
    field.querySelector('span').textContent = f.label;
    var input = f.flag
      ? h('<label><input type="checkbox"> possible on this unit</label>')
      : h('<input class="ts-input" type="text">');
    var el = f.flag ? input.querySelector('input') : input;
    el.setAttribute('data-key', f.key);
    if (f.flag) { el.checked = truthyFlag(s[f.key]); } else { el.value = s[f.key] === undefined ? '' : s[f.key]; }
    field.querySelector('.ts-ctl').appendChild(input);
    dr.body.appendChild(field);
  });
  dr.body.appendChild(h('<div class="ts-field"><div class="ts-field-label"><span>Inactivity timeout</span></div>' +
    '<div class="ts-ctl"><span><input class="ts-input num" type="number" min="0" step="0.5" data-key="inactivityTimeout"> h</span></div>' +
    '<div class="ts-field-hint">Empty: the platform default. The device turns inactive after this long without an uplink.</div></div>'));
  var hours = dr.body.querySelector('[data-key=inactivityTimeout]');
  hours.value = Number(s.inactivityTimeout) > 0 ? Number(s.inactivityTimeout) / HOUR_MS : '';
  ui.drawerActions(dr, 'Save').addEventListener('click', function () {
    var write = {}, drop = [];
    dr.body.querySelectorAll('[data-key]').forEach(function (el) {
      var key = el.getAttribute('data-key');
      if (key === 'inactivityTimeout') {
        if (el.value === '') { if (s.inactivityTimeout !== undefined) { drop.push(key); } } else { write[key] = Math.round(Number(el.value) * HOUR_MS); }
      } else if (el.type === 'checkbox') {
        write[key] = el.checked;
      } else if (el.value.trim()) {
        write[key] = el.value.trim();
      } else if (s[key] !== undefined) {
        drop.push(key);
      }
    });
    if (write.inactivityTimeout !== undefined && !(write.inactivityTimeout > 0)) { ui.toast('A timeout is a positive number of hours', 'error'); return; }
    var dev = deviceEntity();
    tb.saveAttrs(dev, write).then(function () { return tb.deleteAttrs(dev, drop); }).then(function () {
      ui.toast('Attributes saved');
      ui.closeDrawer();
      return refresh();
    }).catch(function (err) { ui.toast('Not saved: ' + errText(err), 'error'); });
  });
}

// -- skeleton ---------------------------------------------------------------------------

root.innerHTML = '';
var cardEl = h('<div class="ts-card ts-readonly ts-dev"><div class="ts-head"><div class="ts-head-icon">' + ICON.gauge + '</div><div class="ts-head-text">' +
  '<div class="ts-title"><span>Device</span></div><div class="ts-subtitle"></div></div><span class="ts-chip level" hidden></span></div>' +
  '<div class="ts-body"><div class="ts-loading">Loading…</div></div>' +
  '<div class="ts-foot"><span class="ts-summary"></span><span class="ts-spacer"></span><button type="button" class="ts-btn">' + ICON.reset + 'Refresh</button></div></div>');
root.appendChild(cardEl);
var bodyEl = cardEl.querySelector('.ts-body');
var summaryEl = cardEl.querySelector('.ts-summary');
var refreshBtn = cardEl.querySelector('.ts-foot .ts-btn');

new ResizeObserver(function () { cardEl.classList.toggle('narrow', cardEl.clientWidth < 720); }).observe(cardEl);

function fail(text) {
  bodyEl.innerHTML = '';
  bodyEl.appendChild(h('<div class="ts-empty"></div>')).textContent = text;
}

// -- render -----------------------------------------------------------------------------

function render() {
  var d = state.device;
  cardEl.querySelector('.ts-subtitle').textContent = d.name + (d.label ? ' · ' + d.label : '');
  var chip = cardEl.querySelector('.ts-chip.level');
  chip.hidden = !d.type;
  chip.textContent = d.type || '';

  bodyEl.innerHTML = '';
  var top = bodyEl.appendChild(h('<div class="ts-dev-top"><div class="ts-dev-status"></div><div class="ts-dev-stations"></div></div>'));
  renderStatus(top.firstChild);
  renderStations(top.lastChild);
  bodyEl.appendChild(topologySection());
  var cmds = family() === 'bus' ? commandsSection() : null;
  if (cmds) { bodyEl.appendChild(cmds); }
  cardEl.classList.toggle('ts-readonly', !state.writable);
  summaryEl.textContent = 'Read ' + new Date(state.loadedAt).toLocaleTimeString();
}

function firmwareOf() {
  if (state.client['deviceInfo.fwVersion']) { return state.client['deviceInfo.fwVersion']; }
  var parts = ['logr.firmwareMajor', 'logr.firmwareMinor', 'logr.firmwarePatch'].map(function (k) { return state.latest[k] && state.latest[k].value; });
  return parts[0] !== undefined ? parts.map(function (p) { return p === undefined ? '?' : p; }).join('.') : null;
}

/** Left pane: the product beside its verdict (TC-3), then its operational
 * status and, for a device that cannot report them, the register. */
function renderStatus(pane) {
  var faulting = Object.keys(state.faults);
  var active = truthyFlag(state.server.active);
  var hw = state.client['deviceInfo.hwVersion'] || state.server['register.hwVersion'], fw = firmwareOf();

  var id = pane.appendChild(h('<div class="ts-dev-id"><div class="ts-dev-figure" data-figure="placeholder"><span class="ts-dev-model"></span>' +
    '<span class="ts-row-meta">Product image</span></div><div class="ts-dev-facts"></div></div>'));
  // The product image goes here, 2:3 portrait, chosen by device type.
  id.querySelector('.ts-dev-figure').dataset.type = state.device.type || '';
  id.querySelector('.ts-dev-model').textContent = String(state.device.type || 'device').toUpperCase();
  var facts = id.querySelector('.ts-dev-facts');

  var verdict = active && !faulting.length;
  var banner = h('<div class="ts-banner ' + (verdict ? 'ok' : 'warn') + '">' + (verdict ? ICON.check : ICON.info) + '<span></span></div>');
  banner.querySelector('span').textContent = verdict
    ? (family() === 'bus' ? 'Live, no peripheral fault.' : 'Live.')
    : [active ? null : 'Not active: no uplink within the inactivity timeout.',
       faulting.length ? faulting.length + (faulting.length === 1 ? ' source is' : ' sources are') + ' faulting.' : null]
      .filter(Boolean).join(' ');
  facts.appendChild(banner);

  function kv(label, tip, valueHtml) {
    var row = h('<div class="ts-kv"><div class="ts-kv-label">' + esc(label) + (tip ? ' ' + info(tip) : '') + '</div><div class="ts-kv-value"></div></div>');
    row.querySelector('.ts-kv-value').innerHTML = valueHtml;
    facts.appendChild(row);
  }
  kv('Uplink', 'uplink', '<span class="ts-status"><span class="ts-dot" style="background:' + (active ? 'var(--ts-ok)' : 'var(--ts-danger)') + '"></span>' +
    esc((active ? 'Active, last ' : 'Inactive, last ') + ago(state.server.lastActivityTime)) + '</span>');
  if (family() === 'bus') {
    kv('Faults', 'peripheralFault', faulting.length
      ? faulting.sort().map(function (k) { return '<span class="ts-chip fault">' + esc(k) + '</span>'; }).join(' ')
      : '<span class="ts-status">none</span>');
  }
  if (fw || hw) { kv('Versions', null, '<span class="ts-mono">' + esc([fw ? 'firmware ' + fw : '', hw ? 'hardware ' + hw : ''].filter(Boolean).join(' · ')) + '</span>'); }
  var status = statusSection();
  if (status) { pane.appendChild(status); }
  if (family() !== 'bus') { pane.appendChild(registerSection()); }
}

/** Right pane: the Stations that contain the device, the channels it feeds in
 * each (TC-2), and for a user who may write the device, connecting it (CA-1). */
function renderStations(pane) {
  var sec = pane.appendChild(h('<div class="ts-section" data-section="stations"><div class="ts-section-head">Stations ' + info('wiring') + '<span class="ts-spacer"></span></div></div>'));
  if (state.writable) {
    var add = h('<button type="button" class="ts-btn ts-reg-edit" data-a="connect">' + ICON.plus + 'Connect or create a station</button>');
    add.addEventListener('click', function () { bindDrawer(null); });
    sec.firstChild.appendChild(add);
  }
  if (!state.bindings.length) {
    sec.appendChild(h('<div class="ts-empty"><span class="ts-chip warn">on no station</span> Its readings are stored on the device only.</div>'));
    return;
  }
  state.bindings.forEach(function (b) {
    var channels = b.map.sourceDeviceId === undefined || b.map.sourceDeviceId === null || b.map.sourceDeviceId === state.device.id.id ? b.map.channels || {} : {};
    var fed = Object.keys(channels).map(function (c) { return b.attrs['effective.' + c + '.label'] || c; }).sort();
    var row = h('<div class="ts-dev-station"><div class="ts-grow"><div class="ts-row-label"></div><div class="ts-row-meta"></div></div><div class="ts-rule-acts"></div></div>');
    row.dataset.station = b.station.name;
    row.querySelector('.ts-row-label').textContent = b.station.name;
    row.querySelector('.ts-row-meta').textContent = fed.length
      ? fed.length + (fed.length === 1 ? ' channel: ' : ' channels: ') + fed.join(', ')
      : 'no channel from this device';
    var acts = row.querySelector('.ts-rule-acts');
    if (state.writable && b.writable) {
      var edit = h('<button type="button" class="ts-icon-btn" data-a="edit" title="Choose the channels">' + ICON.edit + '</button>');
      edit.addEventListener('click', function (e) { e.stopPropagation(); bindDrawer(b); });
      var off = h('<button type="button" class="ts-icon-btn" data-a="disconnect" title="Disconnect">' + ICON.close + '</button>');
      off.addEventListener('click', function (e) { e.stopPropagation(); disconnect(b); });
      acts.appendChild(edit);
      acts.appendChild(off);
    }
    if (opts.projectDashboardId) {
      row.classList.add('link');
      row.tabIndex = 0;
      row.setAttribute('role', 'button');
      acts.appendChild(h('<span class="ts-dev-go">' + ICON.chev + '</span>'));
      var go = function () { tb.openDashboard(opts.projectDashboardId, 'station', b.station); };
      row.addEventListener('click', go);
      row.addEventListener('keydown', function (e) { if (e.key === 'Enter' && e.target === row) { go(); } });
    }
    sec.appendChild(row);
  });
}

/** Full width: the LOGR and what hangs off it, one card per position (TC-1, TC-5). */
function topologySection() {
  var fam = family();
  var sec = h('<div class="ts-section ts-dev-bus"><div class="ts-section-head">Topology ' + info('position') + '</div><div class="ts-bus"></div></div>');
  var bus = sec.querySelector('.ts-bus');
  if (fam === 'logr2') {
    sec.querySelector('.ts-section-head').appendChild(h('<span class="ts-chip" data-fixed="1" title="Set in the LOGR2 firmware: nothing to configure from the cloud">fixed in firmware</span>'));
  }
  if (fam === 'bus') {
    var nodes = topology(), srcs = sources();
    var positions = {};
    Object.keys(nodes).forEach(function (p) { positions[p] = true; });
    srcs.forEach(function (s) { positions[s.position] = true; });
    Object.keys(positions).map(Number).sort(function (a, b) { return a - b; }).forEach(function (pos) { bus.appendChild(positionCard(pos, nodes[pos], srcs)); });
  } else {
    var keys = readings();
    var parts = fam === 'logr2' ? logr2Parts(keys) : [{ id: 'device', label: state.device.type || 'Device', keys: keys }];
    parts.forEach(function (part, i) {
      if (part.keys.length || part.id === 'logr') { bus.appendChild(partCard(part, fam === 'logr2' ? i : null)); }
    });
  }
  if (!bus.childNodes.length) {
    bus.appendChild(h('<div class="ts-empty">No topology report and no reading from this device yet.</div>'));
  }
  return sec;
}

/** A LOGR2 part or another device, read-only: its readings and the station channel each feeds. */
function partCard(part, pos) {
  var box = h('<div class="ts-pos"><div class="ts-pos-head"><span class="ts-pos-num"></span><div class="ts-grow"><div class="ts-pos-name"></div></div></div></div>');
  box.dataset.part = part.id;
  var num = box.querySelector('.ts-pos-num');
  if (pos === null) { num.remove(); } else { num.textContent = pos; }
  box.querySelector('.ts-pos-name').textContent = part.label || 'LOGR itself';
  var logger = part.id === 'logr';
  if (LOGR2_SENSORS[part.id] && state.writable) {
    var drop = h('<button type="button" class="ts-btn" data-a="remove-sensor">Remove sensor</button>');
    drop.addEventListener('click', function () { removeSensor(part); });
    box.querySelector('.ts-pos-head').appendChild(drop);
  }
  if (!part.keys.length) {
    box.appendChild(h('<div class="ts-tsrc"><span class="ts-empty">No reading yet.</span></div>'));
  } else if (logger && !state.showBoard) {
    var show = h('<button type="button" class="ts-more"></button>');
    show.textContent = 'Show ' + part.keys.length + ' on-board reading' + (part.keys.length === 1 ? '' : 's');
    show.addEventListener('click', function () { state.showBoard = true; render(); });
    box.appendChild(show);
  } else {
    part.keys.slice().sort(function (a, b) { return labelOf(a).localeCompare(labelOf(b)); })
      .forEach(function (key) { box.appendChild(readingRow(key, logger)); });
  }
  return box;
}

function readingRow(key, diagnostic) {
  var v = state.latest[key];
  var row = h('<div class="ts-tsrc"><div class="ts-tsrc-top"><div class="ts-row-label"></div><div class="ts-tsrc-value"><b></b><span class="ts-row-meta"></span></div></div>' +
    '<div class="ts-tsrc-meta"><span class="ts-mono"></span></div></div>');
  row.dataset.reading = key;
  row.querySelector('.ts-row-label').textContent = labelOf(key);
  row.querySelector('.ts-mono').textContent = key + (entryOf(key) ? '' : ' · not in the dictionary');
  row.querySelector('b').textContent = fmtValue(v.value) + (readingUnit(key) ? ' ' + readingUnit(key) : '');
  row.querySelector('.ts-tsrc-value .ts-row-meta').textContent = ago(v.ts);
  var feeds = state.wiring[key] || [];
  if (feeds.length || !diagnostic) {
    var wire = row.appendChild(h('<div class="ts-wire"></div>'));
    wire.dataset.wired = feeds.length ? '1' : '0';
    wire.textContent = feeds.length ? feeds.map(wireText(key)).join('   ') : 'on no station';
  }
  return row;
}

function wireText(key) {
  return function (f) { return '→ ' + f.station + (f.channel !== key ? ' · ' + (f.label ? f.label + ' (' + f.channel + ')' : f.channel) : ''); };
}

function positionCard(pos, node, srcs) {
  var own = srcs.filter(function (s) { return s.position === pos; }).sort(function (a, b) { return a.sourceKey.localeCompare(b.sourceKey); });
  var box = h('<div class="ts-pos"><div class="ts-pos-head"><span class="ts-pos-num"></span><div class="ts-grow"><div class="ts-pos-name"></div><div class="ts-mono"></div></div></div>' +
    '<div class="ts-pos-flags"></div></div>');
  box.dataset.position = pos;
  var head = box.querySelector('.ts-pos-head'), flags = box.querySelector('.ts-pos-flags');
  box.querySelector('.ts-pos-num').textContent = pos;
  var p = node && state.peripherals[node.type];
  box.querySelector('.ts-pos-name').textContent = pos === 0 ? 'LOGR itself' : (p ? p.displayName : node ? node.type : 'Unknown peripheral');
  box.querySelector('.ts-mono').textContent = node ? node.type + (node.version !== undefined && node.version !== null ? ' · v' + node.version : '') : '';
  if (!node) { flags.appendChild(h('<span class="ts-chip warn">not in the topology report</span>')); }
  else if (!p && pos !== 0) { flags.appendChild(h('<span class="ts-chip warn">not in the catalog</span>')); }
  var bad = own.filter(function (s) { return sourceState(s).state === 'fault' || state.faults[s.sourceKey]; });
  if (bad.length) { flags.appendChild(h('<span class="ts-chip fault">' + bad.length + ' faulting</span>')); }
  var more = node && pos !== 0 ? unsubscribed(pos, node, own).length : 0;
  if (more) { flags.appendChild(h('<span class="ts-chip" data-available="' + more + '" title="Measurements this peripheral offers that the LOGR does not subscribe, from the catalog">+' + more + ' available</span>')); }
  if (pos !== 0 && !own.some(function (x) { return state.wiring[x.sourceKey]; })) {
    flags.appendChild(h('<span class="ts-chip warn" data-unwired="1">not wired to any station</span>'));
  }
  if (state.writable && node && unsubscribed(pos, node, own).length) {
    var add = h('<button type="button" class="ts-btn ts-add">' + ICON.plus + 'Add subscription</button>');
    add.addEventListener('click', function () { addDrawer(pos, node, own); });
    head.appendChild(add);
  }
  if (!flags.childNodes.length) { flags.remove(); }

  var collapsed = pos === 0 && !bad.length && !state.showBoard;
  if (!own.length) {
    box.appendChild(h('<div class="ts-tsrc"><span class="ts-empty">No subscription and no reading from this position.</span></div>'));
  } else if (collapsed) {
    var show = h('<button type="button" class="ts-more"></button>');
    show.textContent = 'Show ' + own.length + ' on-board reading' + (own.length === 1 ? '' : 's');
    show.addEventListener('click', function () { state.showBoard = true; render(); });
    box.appendChild(show);
  } else {
    own.forEach(function (s) { box.appendChild(sourceRow(s, node)); });
  }
  return box;
}

/** TC-6 / TC-7: the unit's operational status, each value tagged with where it
 * comes from: the LOGR's own STATUS / SUBSCRIPTIONS reports, or the network
 * server (TRX_NANO_COMPLIANCE.md §3). The cloud computes none of it. */
function statusSection() {
  var c = state.client, lat = state.latest, bus = family() === 'bus';
  var srcs = bus ? sources() : [];
  var sec = h('<div class="ts-section"><div class="ts-section-head">Status ' + info('statusSources') + '</div><div class="ts-stat-grid"></div></div>');
  var grid = sec.querySelector('.ts-stat-grid');
  var hasStatus = c['status.baseIntervalSeconds'] !== undefined;
  function card(title, from, lines) {
    var el = h('<div class="ts-stat"><div class="ts-stat-head"><span></span><span class="ts-stat-from"></span></div></div>');
    el.dataset.stat = title;
    el.querySelector('span').textContent = title;
    el.querySelector('.ts-stat-from').textContent = from;
    lines.forEach(function (l) { el.appendChild(h('<div class="ts-stat-line"></div>')).textContent = l; });
    grid.appendChild(el);
  }
  var subs = srcs.filter(function (x) { return x.enabled === true || x.enabled === 'true'; });
  var intervals = subs.map(function (x) { return Number(x.interval); }).filter(function (n) { return n > 0; });
  var lo = intervals.length ? Math.min.apply(null, intervals) : 0, hi = intervals.length ? Math.max.apply(null, intervals) : 0;
  if (bus) { card('Reporting', 'device', [
    hasStatus ? 'Uplink every ' + fmtDuration(c['status.baseIntervalSeconds']) : 'Uplink interval not reported',
    subs.length
      ? subs.length + ' subscription' + (subs.length === 1 ? '' : 's') + (intervals.length ? ', every ' + fmtDuration(lo) + (hi !== lo ? ' to ' + fmtDuration(hi) : '') : '')
      : 'No subscription reported'
  ]); }
  var net = [];
  if (lat.rssi) { net.push('Uplink ' + lat.rssi.value + ' dBm, SNR ' + (lat.snr ? lat.snr.value : '?') + ' dB'); }
  var sf = state.server.spreadingFactor !== undefined ? state.server.spreadingFactor : c.spreadingFactor;
  if (sf !== undefined) { net.push('Spreading factor ' + sf); }
  var gws = parseJson(c.gateways || state.server.gateways) || [];
  if (gws.length) {
    net.push('Heard by ' + gws.length + (gws.length === 1 ? ' gateway: ' : ' gateways, best: ') + gws.slice(0, 3).map(function (g) {
      return g.id + (g.rssi !== undefined && g.rssi !== null ? ' (' + g.rssi + ' dBm)' : '');
    }).join(', '));
  }
  if (family() !== 'other' || net.length) { card('Uplink radio', 'network', net.length ? net : ['Nothing from the network server yet']); }
  if (hasStatus) {
    card('Downlink radio', 'device', ['RSSI ' + c['status.dlRssi'] + ' dBm, SNR ' + c['status.dlSnr'] + ' dB']);
  }
  var soc = c['status.soc'] !== undefined ? c['status.soc'] : (lat['p0.percent'] ? lat['p0.percent'].value : undefined);
  var batt = [];
  var volt = BATTERY_VOLTAGE.map(function (k) { return lat[k]; }).filter(Boolean)[0];
  var charging = BATTERY_CHARGING.map(function (k) { return lat[k]; }).filter(Boolean)[0];
  if (soc !== undefined) { batt.push('Charge ' + fmtValue(soc) + ' %'); }
  if (volt) { batt.push(fmtValue(volt.value) + ' V, ' + ago(volt.ts)); }
  if (!hasStatus && charging) { batt.push(truthyFlag(charging.value) ? 'Charging' : 'Not charging'); }
  if (Number(c['status.battRuntimeSeconds']) > 0) { batt.push('Lasts about ' + fmtDuration(c['status.battRuntimeSeconds']) + ', the LOGR\u2019s own estimate'); }
  if (bus || batt.length) { card('Battery', 'device', batt.length ? batt : ['Not reported']); }
  if (hasStatus) {
    var present = parseJson(c['status.sourcesPresent']) || [];
    var power = ['Running on ' + (POWER_SOURCES[c['status.activeSource']] || c['status.activeSource']),
                 'Connected: ' + (present.length ? present.map(function (x) { return POWER_SOURCES[x] || x; }).join(', ') : 'none')];
    if (truthyFlag(c['status.charging'])) { power.push('Charging' + (Number(c['status.ttfSeconds']) > 0 ? ', full in ' + fmtDuration(c['status.ttfSeconds']) : '')); }
    card('Power', 'device', power);
    var sd = c['status.sdState'];
    card('SD card', 'device', [sd === 'ready'
      ? fmtValue(c['status.sdUsedPercent']) + ' % used of ' + c['status.sdTotalGib'] + ' GiB'
      : (SD_STATES[sd] || String(sd))]);
  }
  var fix = lat['p0.gnssFix'] && parseJson(lat['p0.gnssFix'].value);
  if (bus) {
    card('Location', 'device', fix && fix.lat !== undefined
      ? [Number(fix.lat).toFixed(5) + ', ' + Number(fix.lon).toFixed(5) + ' \u00b7 ' + fix.sats + ' satellites']
      : ['No GNSS fix reported']);
  }
  if (bus && !hasStatus) {
    sec.appendChild(h('<div class="ts-field-hint">No STATUS report from this LOGR yet: charge, power, SD card and downlink radio appear after its next one' +
      (state.writable ? ' (Request reports below asks for it).' : '.') + '</div>'));
  }
  return grid.childNodes.length ? sec : null;
}

function truthyFlag(v) { return v === true || v === 'true' || v === 1; }

function sourceRow(s, node) {
  var st = sourceState(s);
  var row = h('<div class="ts-tsrc"><div class="ts-tsrc-top"><div class="ts-row-label"></div><div class="ts-tsrc-value"></div></div>' +
    '<div class="ts-tsrc-meta"><span class="ts-mono"></span><span class="ts-tsrc-state"></span></div></div>');
  row.dataset.source = s.sourceKey;
  row.dataset.state = st.state;
  row.querySelector('.ts-row-label').textContent = sourceLabel(s, node);
  row.querySelector('.ts-mono').textContent = s.sourceKey;
  var meta = row.querySelector('.ts-tsrc-meta'), stateEl = row.querySelector('.ts-tsrc-state'), valueEl = row.querySelector('.ts-tsrc-value');
  if (s.interval) {
    meta.insertBefore(h('<span class="ts-tsrc-every" data-interval="' + esc(s.interval) + '"></span>'), stateEl).textContent = 'every ' + fmtDuration(s.interval);
  }
  if (s.enabled !== undefined && st.state !== 'disabled') {
    var on = truthyFlag(s.enabled);
    meta.insertBefore(h('<span class="ts-chip' + (on ? '' : ' warn') + '" data-enabled="' + on + '">' + (on ? 'enabled' : 'disabled') + '</span>'), stateEl);
  }
  if (st.state === 'fault') {
    var code = G.STATUS_CODES[st.code];
    stateEl.innerHTML = '<span class="ts-chip fault"></span>';
    stateEl.firstChild.textContent = st.code;
    valueEl.innerHTML = '<span class="ts-tsrc-why"></span><span class="ts-row-meta"></span>';
    valueEl.firstChild.textContent = code || 'Unknown status code';
    valueEl.lastChild.textContent = ago(st.ts);
  } else if (st.state === 'ok') {
    stateEl.innerHTML = '<span class="ts-chip ok">OK</span>';
    valueEl.innerHTML = '<b></b><span class="ts-row-meta"></span>';
    valueEl.firstChild.textContent = fmtValue(st.value) + (unitOf(s) ? ' ' + unitOf(s) : '');
    valueEl.lastChild.textContent = ago(st.ts);
  } else if (st.state === 'disabled') {
    stateEl.innerHTML = '<span class="ts-chip">Disabled</span>';
    valueEl.innerHTML = '<span class="ts-row-meta">subscription switched off</span>';
  } else {
    stateEl.innerHTML = '<span class="ts-chip warn">No reading</span>';
    valueEl.innerHTML = '<span class="ts-row-meta">subscribed, nothing received yet</span>';
  }
  if (state.faults[s.sourceKey]) { stateEl.appendChild(h('<span class="ts-chip fault" title="Active peripheralFault alarm">' + ICON.bell + '</span>')); }
  if (state.writable) {
    var act = h('<button type="button" class="ts-icon-btn ts-src-act" title="Change this subscription">' + ICON.edit + '</button>');
    act.addEventListener('click', function () { sourceDrawer(s, node); });
    stateEl.appendChild(act);
  }
  var feeds = state.wiring[s.sourceKey] || [];
  if (feeds.length || s.position !== 0) {
    var wire = row.appendChild(h('<div class="ts-wire"></div>'));
    wire.dataset.wired = feeds.length ? '1' : '0';
    wire.textContent = feeds.length
      ? feeds.map(function (f) { return '→ ' + f.station + ' · ' + (f.label ? f.label + ' (' + f.channel + ')' : f.channel); }).join('   ')
      : 'not wired to any station';
  }
  return row;
}

// -- load -------------------------------------------------------------------------------

var timer = null;
function refresh() {
  if (!root.isConnected && timer) { clearInterval(timer); return Promise.resolve(); }
  refreshBtn.disabled = true;
  return loadDevice(state.device.id.id).then(render).catch(function (err) {
    ui.toast('Refresh failed: ' + (err && err.message ? err.message : err), 'error');
  }).then(function () { refreshBtn.disabled = false; });
}
refreshBtn.addEventListener('click', refresh);

tb.boundDatasource().then(function (ds) {
  if (!ds || ds.entityType !== 'DEVICE') { fail('No device bound — bind a device in the widget\'s Data tab.'); return; }
  return Promise.all([loadDefaults(), loadDevice(ds.entityId), tb.currentUser()]).then(function (got) {
    state.me = got[2];
    return tb.canWrite(deviceEntity());
  }).then(function (writable) {
    state.writable = writable;
    render();
    timer = setInterval(refresh, REFRESH_MS);
  });
}).catch(function (err) { fail('Could not load: ' + (err && err.message ? err.message : err)); });

};
