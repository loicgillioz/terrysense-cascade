/*
 * Device — one device of any type: is it live, what it measures and which
 * station channel each measurement feeds (TC-1 to TC-7); for a user who may
 * write it, connecting it to a station, a new one included, and choosing the
 * channels (CA-1), per station or per measurement, and on a LOGR3 or LOGR4 the commands that reconfigure it
 * (CA-4, TC-8/9). Read-only for anyone else.
 *
 * In its header, for the same user, *Silence* (CA-19) and the device's row
 * menu: *Replace device…* (CA-13), *Out of service…* or *Back in service*
 * (CA-23). After a replacement, a follow-up card lists what is still to do.
 *
 * Laid out as the product image and the device's status beside its topology:
 * the peripherals, one foldable card per position; below both, the stations it
 * feeds and their channels. The layout depends on the family:
 *   bus    LOGR3, LOGR4: positions from `topology.p<POS>.*`, position 0 from
 *          the LOGR's own catalog entry; sources from `subscriptions.*` and
 *          the stored telemetry keys, each with its interval and whether it
 *          is enabled, or *not subscribed*; configurable by command. A DRYC
 *          adds the readings unpacked from its status and its rules state.
 *   logr2  the LOGR and its one or two sensors, fixed in its firmware:
 *          readings grouped by their peripheral prefix; the data of a sensor
 *          no longer used can be deleted; the register.
 *   other  any other device: its readings in one card; the register.
 *
 * A bus source's state is its latest reading: a value newer than its
 * `<sourceKey>.status` is OK, otherwise the status code is the fault the
 * device stated (HEALTH.md §1). Faults counted in the header are the device's
 * active `peripheralFault.*` alarms. A command is written as `cmd.request`;
 * `dl_dispatch` merges it into `cmd.pending` and sends the whole set, and
 * `dl_ack` turns the answer into `cmd.lastResult` (DOWNLINK.md).
 *
 * Connecting writes the STATION -> DEVICE `Contains` relation, the station's
 * `config.channelMap`, then a resolve. A station keeps one source device (CHANNEL_MAP.md §3), so connecting to a
 * station fed by another device replaces it and keeps the channels this one
 * reports. The dry contact interface's channels belong to the station's DRYC
 * view and are kept. Widget: logr-product-docs/cloud/DEVICE_VIEW.md.
 *
 * `opts`, set by build_device_dashboard.py: `projectDashboardId`, whose Station
 * view a station opens and whose Dry contact interface view the DRYC card opens,
 * and `devicesDashboardId`.
 *
 * Loads after shared/resolver.js, glossary.js, ui.js, tb_io.js, calculations.js and lifecycle.js.
 */

window.TerrySenseDeviceTopology = function (ctx, container, opts) {

opts = opts || {};

var t = window.TerrySenseI18n(ctx);
var resolver = window.TerrySenseResolver;
var G = window.TerrySenseGlossary;
var tb = window.TerrySenseTbIo(ctx);
var root = container.querySelector('.ts-root') || container;
var ui = window.TerrySenseUi(root);
var life = window.TerrySenseLifecycle(ui, tb);
var calc = window.TerrySenseCalculations(ui, tb);
var h = ui.h, esc = ui.esc, ICON = ui.ICON, info = ui.info, metric = ui.metric;
var camel = resolver.camelKind;
var M = window.TerrySenseMapping;

var FAULT_PREFIX = 'peripheralFault.';
var REFRESH_MS = 60000;
var HOUR_MS = 3600000;
var DAY_MS = 86400000;
var BATTERY_VOLTAGE = ['p0.voltage', 'p0.voltage.i0', 'logr.batteryVoltage'];
// The LOGR's power inputs, named as the vocabulary names chargerSource's states.
function powerSources() {
  function s(token, english) { return t.state('chargerSource', token, english); }
  return { usb: s('usb', 'USB'), sp_int: s('sp_int', 'internal solar'), sp_ext: s('sp_ext', 'external solar'), bus: s('bus', 'bus'), none: s('none', 'none') };
}
// A STATUS carrying the POWERBOARD fault holds no power reading: soc, sources and estimates are not reported (TRX_NANO.md §8).
function powerUnread(c) { return (parseJson(c['status.healthFaults']) || []).indexOf('POWERBOARD') >= 0; }
// A STATUS field the LOGR sent unknown holds no reading either (ATTRIBUTES.md §2).
var UNKNOWN = 'unknown';
function sdStates() { return { ready: t('device.sdReady', 'ready'), fault: t('device.sdFault', 'fault'), not_inserted: t('device.sdNoCard', 'no card') }; }
var NEW_STATION = '__new';
// A source is silent past this many of its intervals (HEALTH.md §2).
var SILENT_INTERVALS = 3;
var NOT_READINGS = M.NOT_READINGS, RULE_SOURCE = M.RULE_SOURCE, DRYC_KEY = M.DRYC_KEY, LOGR2_SENSORS = M.LOGR2_SENSORS;
function register() {
  return [
    { key: 'register.hwVersion', label: t('device.regHwVersion', 'Hardware version') },
    { key: 'register.hwStatus', label: t('device.regHwStatus', 'Hardware status') },
    { key: 'register.loraFw', label: t('device.regLoraFw', 'LoRa module firmware') },
    { key: 'register.dfu', label: t('device.regDfu', 'Firmware update (DFU)'), flag: true }
  ];
}
var FINE_STATUS = /^(all functional|ok|)$/i;
var ICON_STATION = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21V9"/><path d="M8 21h8"/><circle cx="12" cy="6" r="3"/></svg>';
var parseSource = M.parseSource;

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

function fmtDuration(sec) {
  var s = Number(sec);
  if (!isFinite(s)) { return String(sec); }
  if (s < 120) { return Math.round(s) + ' s'; }
  if (s < 7200) { return Math.round(s / 60) + ' min'; }
  if (s < 172800) { return Math.round(s / 3600) + ' h'; }
  return t('common.days', '{n} days', { n: Math.round(s / 86400) });
}

function fmtValue(v) {
  if (v === true || v === 'true') { return t('common.valueOn', 'on'); }
  if (v === false || v === 'false') { return t('common.valueOff', 'off'); }
  var n = Number(v);
  if (v === '' || v === null || isNaN(n)) { return String(v); }
  return String(Math.round(n * 1000) / 1000);
}

function rssiLevel(v) { return ui.radioLevel('rssi', v); }
function snrLevel(v) { return ui.radioLevel('snr', v); }
function sfLevel(v) { return ui.radioLevel('sf', v); }

function errText(err) { return (err && (err.message || (err.error && err.error.message))) || String(err); }

// -- data -------------------------------------------------------------------------------

var state = {
  device: null, client: {}, server: {}, latest: {}, faults: {}, peripherals: {}, kinds: {}, names: {},
  open: {}, loadedAt: 0, writable: false, me: null,
  bindings: [], wiring: {}, calcAttributes: {}, followUp: null
};

function deviceEntity() {
  return { entityType: 'DEVICE', id: state.device.id.id, name: state.device.name, label: state.device.label,
           ownerId: state.device.ownerId && state.device.ownerId.id };
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
    state.calcAttributes = parseJson(a['config.calcAttributes']) || {};
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
    var keys = M.latestKeys(family() === 'bus', tb.readingKeys(got[3]));
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
        return { station: station, attrs: got[0], entries: resolver.mapEntries(got[0]['config.channelMap']), writable: got[1] };
      });
    }));
  }).then(function (list) {
    state.bindings = list.sort(function (a, b) { return a.station.name.localeCompare(b.station.name); });
    state.wiring = {};
    list.forEach(function (b) {
      var channels = mineOf(b.entries);
      Object.keys(channels).forEach(function (key) {
        (state.wiring[channels[key]] = state.wiring[channels[key]] || []).push({
          station: b.station.name, channel: key, label: b.attrs['effective.' + key + '.label'] || ''
        });
      });
    });
  }).catch(function () { state.bindings = []; state.wiring = {}; });
}

// -- model ------------------------------------------------------------------------------

function model() {
  return { bus: family() === 'bus', device: state.device, client: state.client, latest: state.latest, faults: state.faults,
           peripherals: state.peripherals, kinds: state.kinds, names: state.names };
}
function topology() { return M.topology(model()); }
function sources() { return M.sources(model()); }

/** ok | fault | waiting | disabled, from the latest value and status of one source. */
function sourceState(s) {
  var v = state.latest[s.sourceKey], st = state.latest[s.sourceKey + '.status'];
  if (st && (!v || st.ts >= v.ts)) { return { state: 'fault', code: String(st.value), ts: st.ts }; }
  if (v) { return { state: 'ok', value: v.value, ts: v.ts }; }
  if (s.enabled === false || s.enabled === 'false') { return { state: 'disabled' }; }
  return { state: 'waiting' };
}

function measureOf(s, node) { return M.measureOf(model(), s, node); }
function sourceLabel(s, node) { return M.sourceLabel(model(), s, node); }
function unitOf(s) { return M.unitOf(model(), s); }
function readings() { return M.readings(model()); }
function nameOf(key) { return M.nameOf(model(), key); }
function entryOf(key) { return M.entryOf(model(), key); }
function labelOf(key) { return M.labelOf(model(), key); }
function readingUnit(key) { return M.readingUnit(model(), key); }
var logr2Parts = M.logr2Parts;

/** The names this device's channels carry on its stations. */
function mappedNames() { return M.mappedNames(state.device.id.id, state.bindings.map(function (b) { return b.entries; })); }
function namesForKind(kind) { return M.namesForKind(model(), kind, mappedNames()); }
function mappable() { return M.mappable(model(), mappedNames()); }

// -- commands (CA-4, TC-8/9) ---------------------------------------------------------------

function parseValue(raw) { return typeof raw === 'string' ? parseJson(raw) : raw; }

/** The changes the device has not acknowledged, or null; past its window the set is unanswered. */
function pending() {
  var p = parseValue(state.server['cmd.pending']);
  if (!p || !(p.commands || []).length) { return null; }
  var interval = Number(state.client['status.baseIntervalSeconds']) || 0;
  var window = Math.max(DAY_MS, 2 * interval * 1000);
  var sent = Number(p.updatedAt || p.issuedAt) || 0;
  return { commands: p.commands, frames: (p.frames || []).length, sent: sent, unanswered: Date.now() - sent > window };
}

function targetText(tg) {
  if (!tg || tg.mode === 'GLOBAL' || !tg.mode) { return ''; }
  if (tg.mode === 'POSITION') { return t('device.targetPosition', ' at position {pos}', { pos: tg.position }); }
  return t('device.targetSource', ' of {source}', {
    source: 'p' + tg.position + '.' + camel(tg.kind) + (tg.group ? '.g' + tg.group : '') + (tg.index !== undefined ? '.i' + tg.index : '')
  });
}

function commandText(c) {
  var target = targetText(c.target);
  var what = {
    SET_INTERVAL: t('device.cmdInterval', 'Interval{target} → {s} s', { target: target, s: c.interval_s }),
    SET_ENABLED: c.enabled ? t('device.cmdEnable', 'Enable{target}', { target: target }) : t('device.cmdDisable', 'Disable{target}', { target: target }),
    SELF_DIAG: t('device.selfDiag', 'Self-diagnostic'),
    REQUEST_REPORT: t('device.requestReports', 'Request reports') + (c.reports ? ': ' + c.reports.join(', ') : ''),
    CREATE_SUBSCRIPTION: t('device.cmdSubscribe', 'Subscribe{target} every {s} s', { target: target, s: c.interval_s }),
    DELETE_SUBSCRIPTION: t('device.cmdUnsubscribe', 'Remove subscription{target}', { target: target }),
    PERIPHERAL_OP: t('device.cmdPeripheralOp', 'Peripheral operation{target}', { target: target })
  }[c.op];
  return what || String(c.op);
}

function resultText(r) {
  if (r.status !== 'OK') { return r.opcode + ': ' + (G.COMMAND_STATUS[r.status] || r.status); }
  if (r.applied_interval_s !== undefined) { return r.opcode + ': ' + t('device.resultInterval', 'OK, now {s} s', { s: r.applied_interval_s }); }
  if (r.selfdiag_faults) {
    return r.opcode + ': ' + (r.selfdiag_faults.length ? t('device.resultFaults', 'faults {list}', { list: r.selfdiag_faults.join(', ') }) : t('device.resultHealthy', 'all healthy'));
  }
  return r.opcode + ': OK';
}

function listOf(commands) { return '<ul>' + commands.map(function (c) { return '<li>' + esc(commandText(c)) + '</li>'; }).join('') + '</ul>'; }

function deviceName() { return '<b>' + esc(state.device.label || state.device.name) + '</b>'; }

/** Writes `cmd.request`; `dl_dispatch` merges it into the queued set and replaces the device's queue. */
function request(body, toast) {
  body.by = (state.me && state.me.email) || null;
  body.issuedAt = Date.now();
  return tb.saveAttrs(deviceEntity(), { 'cmd.request': body }).then(function () {
    ui.toast(toast);
    ui.closeDrawer();
    setTimeout(refresh, 1500);
    return true;
  }).catch(function (err) {
    ui.toast(t('common.notSent', 'Not sent: {error}', { error: err && (err.message || (err.error && err.error.message)) || err }), 'error');
    return false;
  });
}

function send(commands) {
  var queued = pending();
  var n = queued ? queued.commands.length : 0;
  return ui.confirm(t('device.sendTo', 'Send to {device}?', { device: deviceName() }) + listOf(commands) +
    (n === 1 ? t('device.queueJoinOne', 'It joins the 1 queued change; the whole set goes out after the device’s next uplink.')
       : n ? t('device.queueJoinMany', 'It joins the {n} queued changes; the whole set goes out after the device’s next uplink.', { n: n })
       : t('device.deliveredNext', 'It is delivered after the device’s next uplink.')), t('common.send', 'Send')).then(function (ok) {
    return ok ? request({ commands: commands }, t('device.queued', 'Queued: delivered after the next uplink')) : false;
  });
}

function retry(queued) {
  return ui.confirm(t('device.sendAgainTo', 'Send again to {device}?', { device: deviceName() }) + listOf(queued.commands) +
    t('device.deliveredNext', 'It is delivered after the device’s next uplink.'), t('common.send', 'Send')).then(function (ok) {
    return ok ? request({ commands: [] }, t('device.queuedAgain', 'Queued again: delivered after the next uplink')) : false;
  });
}

function discard(queued) {
  return ui.confirm(t('device.discardOn', 'Discard the queued changes on {device}?', { device: deviceName() }) + listOf(queued.commands) +
    t('device.discardNote', 'A frame the device has already received still applies.'), t('device.discard', 'Discard')).then(function (ok) {
    return ok ? request({ discard: true }, t('device.queueCleared', 'Queue cleared')) : false;
  });
}

/** Catalog measures of a position that the device neither subscribes nor reports, each
 * under the key the device reports it by: a group or index of 0 is left out (TRX_NANO.md §10). */
function unsubscribed(pos, node, own) {
  var p = node && state.peripherals[node.type];
  if (!p) { return []; }
  var have = {};
  own.forEach(function (s) { have[s.kind + '/' + s.group + '/' + s.index] = true; });
  return (p.measures || []).filter(function (m) {
    return !have[camel(m.kind) + '/' + (m.group || 0) + '/' + (m.index || 0)];
  }).map(function (m) {
    var key = 'p' + pos + '.' + camel(m.kind) + (m.group ? '.g' + m.group : '') + (m.index ? '.i' + m.index : '');
    var target = { mode: 'SOURCE', position: pos, kind: m.kind };
    if (m.group) { target.group = m.group; }
    if (m.index) { target.index = m.index; }
    return { sourceKey: key, measure: m, target: target };
  });
}

function subscribe(target, input) {
  var v = Number(input.value);
  if (!(v >= 1 && v <= 65535 && Math.floor(v) === v)) { ui.toast(t('device.intervalInvalid', 'An interval is a whole number of seconds, 1 to 65535'), 'error'); return; }
  send([{ op: 'CREATE_SUBSCRIPTION', target: target, interval_s: v }]);
}

function addDrawer(pos, node, own) {
  var dr = ui.openDrawer(t('device.addSubscriptionTitle', 'Add a subscription'), t('device.position', 'Position {pos}', { pos: pos }) + ' · ' + esc(node.type));
  var options = unsubscribed(pos, node, own);
  dr.body.appendChild(h('<div class="ts-field"><div class="ts-field-label"><span>' + esc(t('device.interval', 'Interval')) + '</span></div>' +
    '<div class="ts-ctl"><span><input class="ts-input num" type="number" min="1" step="1" value="900"> s</span></div></div>'));
  var input = dr.body.querySelector('input');
  options.forEach(function (o) {
    var entry = state.names[o.measure.defaultName] || {};
    var row = h('<div class="ts-tsrc"><div><div class="ts-row-label"></div><div class="ts-mono"></div></div><span></span>' +
      '<div class="ts-tsrc-value"><button type="button" class="ts-btn">' + esc(t('device.subscribe', 'Subscribe')) + '</button></div></div>');
    row.querySelector('.ts-row-label').textContent = entry.label ? t.channel(o.measure.defaultName, entry.label) : o.measure.defaultName;
    row.querySelector('.ts-mono').textContent = o.sourceKey;
    row.querySelector('button').addEventListener('click', function () { subscribe(o.target, input); });
    dr.body.appendChild(row);
  });
}

function commandsSection() {
  var queued = pending();
  var last = parseValue(state.server['cmd.lastResult']);
  if (!state.writable && !queued && !last) { return null; }
  var sec = h('<div class="ts-section"><div class="ts-section-head">' + esc(t('device.commands', 'Commands')) + ' ' + info('commands') + '</div></div>');
  if (state.writable) {
    var bar = h('<div class="ts-cmdbar"><button type="button" class="ts-btn" data-a="reports">' + esc(t('device.requestReports', 'Request reports')) + '</button>' +
      '<button type="button" class="ts-btn" data-a="diag">' + esc(t('device.selfDiag', 'Self-diagnostic')) + '</button></div>');
    bar.addEventListener('click', function (e) {
      var a = e.target.closest('[data-a]');
      if (!a) { return; }
      send([a.dataset.a === 'reports'
        ? { op: 'REQUEST_REPORT', target: { mode: 'GLOBAL' }, reports: ['topology', 'subscriptions', 'status', 'device_info'] }
        : { op: 'SELF_DIAG', target: { mode: 'GLOBAL' } }]);
    });
    sec.appendChild(bar);
  }
  if (queued) {
    var row = h('<div class="ts-cmd" data-cmd="' + (queued.unanswered ? 'unanswered' : 'queued') + '"><div class="ts-grow"><div class="ts-row-label"></div><div class="ts-row-meta"></div></div></div>');
    row.querySelector('.ts-row-label').textContent = queued.commands.map(commandText).join(' · ');
    row.querySelector('.ts-row-meta').textContent = (queued.unanswered ? t('device.noAnswerSent', 'No answer, sent {ago}', { ago: t.ago(queued.sent) })
      : t('device.queuedSent', 'Queued, sent {ago}', { ago: t.ago(queued.sent) })) +
      (queued.frames > 1 ? ' · ' + t('device.frames', '{n} frames', { n: queued.frames }) : '');
    row.insertBefore(h('<span class="ts-chip ' + (queued.unanswered ? 'fault">' + esc(t('device.noAnswer', 'No answer')) : 'warn">' + esc(t('device.queuedChip', 'Queued'))) + '</span>'), row.firstChild);
    if (state.writable) {
      if (queued.unanswered) {
        var again = h('<button type="button" class="ts-btn" data-a="retry">' + esc(t('device.retry', 'Retry')) + '</button>');
        again.addEventListener('click', function () { retry(queued); });
        row.appendChild(again);
      }
      var drop = h('<button type="button" class="ts-btn" data-a="discard">' + esc(t('device.discard', 'Discard')) + '</button>');
      drop.addEventListener('click', function () { discard(queued); });
      row.appendChild(drop);
    }
    sec.appendChild(row);
  }
  if (last) {
    var row = h('<div class="ts-cmd" data-cmd="' + (last.ok ? 'delivered' : 'failed') + '"><span class="ts-chip ' + (last.ok ? 'ok">' + esc(t('device.delivered', 'Delivered')) : 'fault">' + esc(t('device.failed', 'Failed'))) + '</span>' +
      '<div class="ts-grow"><div class="ts-row-label"></div><div class="ts-row-meta"></div></div></div>');
    row.querySelector('.ts-row-label').textContent = (last.commands || []).map(commandText).join(' · ') || t('device.commandNumber', 'Command #{seq}', { seq: last.seq });
    row.querySelector('.ts-row-meta').textContent = (last.results || []).map(resultText).join(' · ') + ' · ' + t('device.answered', 'answered {ago}', { ago: t.ago(last.ackedAt) });
    sec.appendChild(row);
  }
  return sec;
}

// -- stations (CA-1) -------------------------------------------------------------------------

function ownerOf() { return state.device.ownerId || {}; }

function mineOf(entries) { return M.mineOf(entries, state.device.id.id); }
function othersOf(entries) { return M.othersOf(entries, state.device.id.id); }

function relateToMap(stationId, entries) { return tb.relateToMap({ entityType: 'ASSET', id: stationId }, entries); }

function stationsToPick() {
  var owner = ownerOf();
  return owner.entityType === 'CUSTOMER' ? tb.io.fetchCustomerStations({ id: owner.id }) : tb.io.fetchAllStations();
}

/** Where a new station can go: the projects of the device's owner. */
function parentsToPick() {
  var owner = ownerOf().id;
  return tb.getAll('/api/user/assets', { type: 'Project' }).catch(function () { return []; }).then(function (list) {
    return list.filter(function (a) { return a.ownerId && a.ownerId.id === owner; }).map(function (a) {
      var level = tb.assetLevel(a);
      level.ownerId = owner;
      return level;
    }).sort(function (a, b) { return a.name.localeCompare(b.name); });
  });
}

/** Pick a station, a new one included, or the channels of one already fed;
 * `preset` `{id, name}` picks a station on opening. */
function bindDrawer(binding, preset) {
  var dr = ui.openDrawer(binding ? t('device.channelsOf', 'Channels of {station}', { station: esc(binding.station.name) }) : t('device.connectTitle', 'Connect to a station'),
    t('device.fromDevice', 'from {device}', { device: esc(state.device.label || state.device.name) }));
  dr.el.classList.add('wide');
  var picked = binding ? binding.station : null;
  var pickedEntries = binding ? binding.entries : null;
  var rows = mappable();
  var body = dr.body;

  var stationField = h('<div class="ts-field"><div class="ts-field-label"><span>' + esc(t('common.station', 'Station')) + '</span></div><div class="ts-ctl"></div><div class="ts-field-hint" data-f="hint"></div></div>');
  var hint = stationField.querySelector('[data-f=hint]');
  var newFields = h('<div data-f="new" hidden><div class="ts-field"><div class="ts-field-label"><span>' + esc(t('device.newStationName', 'Name of the new station')) + '</span></div>' +
    '<div class="ts-ctl"><input class="ts-input wide" type="text" data-f="newName"></div></div>' +
    '<div class="ts-field"><div class="ts-field-label"><span>' + esc(t('device.newStationIn', 'In')) + '</span></div><div class="ts-ctl">' +
    '<select class="ts-select wide" data-f="parent"><option value="">' + esc(t('device.pickProject', 'Pick a project')) + '</option></select></div></div></div>');
  var parents = [];
  if (binding) {
    stationField.querySelector('.ts-ctl').appendChild(h('<b></b>')).textContent = binding.station.name;
  } else {
    var sel = h('<select class="ts-select wide" data-f="station"><option value="">' + esc(t('device.pickStation', 'Pick a station')) + '</option>' +
      '<option value="' + NEW_STATION + '">' + esc(t('device.newStation', 'New station…')) + '</option></select>');
    stationField.querySelector('.ts-ctl').appendChild(sel);
    stationsToPick().then(function (list) {
      var bound = {};
      state.bindings.forEach(function (b) { bound[b.station.id] = true; });
      list.filter(function (s) { return !bound[s.id]; }).sort(function (a, b) { return a.name.localeCompare(b.name); }).forEach(function (s) {
        var o = document.createElement('option'); o.value = s.id; o.textContent = s.name; o.dataset.name = s.name; sel.appendChild(o);
      });
      if (!preset) { return; }
      if (!sel.querySelector('option[value="' + preset.id + '"]')) { ui.toast(t('device.cannotTake', '{station} cannot take this device', { station: preset.name }), 'error'); return; }
      sel.value = preset.id;
      sel.dispatchEvent(new Event('change'));
    });
    parentsToPick().then(function (list) {
      parents = list;
      var psel = newFields.querySelector('[data-f=parent]');
      list.forEach(function (p) {
        var o = document.createElement('option'); o.value = p.id; o.textContent = p.name; psel.appendChild(o);
      });
    });
    sel.addEventListener('change', function () {
      var creating = sel.value === NEW_STATION;
      newFields.hidden = !creating;
      picked = sel.value && !creating ? { entityType: 'ASSET', id: sel.value, name: sel.selectedOptions[0].dataset.name, kind: 'Station' } : null;
      pickedEntries = null;
      hint.textContent = '';
      tick(null);
      if (!picked) { return; }
      tb.attrsMap(picked).then(function (a) {
        pickedEntries = resolver.mapEntries(a['config.channelMap']);
        var others = othersOf(pickedEntries);
        hint.textContent = others.length === 1
          ? t('device.othersFeedOne', 'Other devices feed 1 channel of this station ({list}); they stay theirs. A channel name picked here that one of them uses moves to this device, its history kept.', { list: others.join(', ') })
          : others.length
          ? t('device.othersFeedMany', 'Other devices feed {n} channels of this station ({list}); they stay theirs. A channel name picked here that one of them uses moves to this device, its history kept.', { n: others.length, list: others.join(', ') })
          : '';
        tick(pickedEntries);
      });
    });
  }
  body.appendChild(stationField);
  body.appendChild(newFields);

  var list = h('<div class="ts-field"><div class="ts-field-label"><span>' + esc(t('device.measurementsToStore', 'Measurements to store')) + ' ' + info('channelName') + '</span>' +
    '<span class="ts-spacer"></span><span class="ts-bind-count"></span></div><div class="ts-field-hint"></div><div class="ts-binds"></div></div>');
  list.querySelector('.ts-field-hint').textContent = t('device.tickMeasurements', 'Tick what the station stores. On the right, the channel each measurement is stored under.');
  var boxes = list.querySelector('.ts-binds');
  var countEl = list.querySelector('.ts-bind-count');
  var groups = [], byGroup = {};
  rows.forEach(function (r) {
    if (!byGroup[r.group]) { byGroup[r.group] = { id: r.group, label: r.groupLabel, rows: [] }; groups.push(byGroup[r.group]); }
    byGroup[r.group].rows.push(r);
  });
  groups.forEach(function (g) {
    var sec = boxes.appendChild(h('<details class="ts-bind-group"><summary><span class="ts-pos-chev">' + ICON.chev + '</span><span class="ts-bind-glabel"></span>' +
      '<span class="ts-count"></span><span class="ts-spacer"></span><button type="button" class="ts-btn ghost" data-a="all">' + esc(t('common.all', 'All')) + '</button>' +
      '<button type="button" class="ts-btn ghost" data-a="none">' + esc(t('device.noneButton', 'None')) + '</button></summary></details>'));
    sec.dataset.group = g.id;
    sec.querySelector('.ts-bind-glabel').textContent = g.label;
    sec.querySelector('summary').addEventListener('click', function (e) {
      var a = e.target.closest('[data-a]');
      if (!a) { return; }
      e.preventDefault();
      sec.querySelectorAll('input[data-key]').forEach(function (b) { b.checked = a.dataset.a === 'all'; });
      update();
    });
    g.rows.forEach(function (r) {
      var row = sec.appendChild(h('<div class="ts-bindrow"><label class="ts-bind-src"><input type="checkbox"><span class="ts-grow"><span class="ts-bind-name"></span>' +
        '<span class="ts-mono"></span></span><span class="ts-bind-val"></span></label><span class="ts-dev-arrow">→</span><div class="ts-bind-dst"></div></div>'));
      row.dataset.key = r.key;
      row.querySelector('input').dataset.key = r.key;
      row.querySelector('.ts-bind-name').textContent = r.label;
      row.querySelector('.ts-mono').textContent = r.key;
      var v = state.latest[r.key];
      var unit = family() === 'bus' ? unitOf(parseSource(r.key)) : readingUnit(r.key);
      row.querySelector('.ts-bind-val').textContent = v ? fmtValue(v.value) + (unit ? ' ' + unit : '') : '';
      var dst = row.querySelector('.ts-bind-dst');
      dst.appendChild(h('<select class="ts-select"></select>')).dataset.nameFor = r.key;
      dst.appendChild(h('<span class="ts-bind-key"></span>'));
    });
  });
  if (!rows.length) { boxes.appendChild(h('<div class="ts-empty"></div>')).textContent = t('device.nothingMeasured', 'Nothing measured by this device yet.'); }
  boxes.addEventListener('change', update);
  body.appendChild(list);

  function chosenRows() {
    return rows.filter(function (r) { return boxes.querySelector('input[data-key="' + r.key + '"]').checked; }).map(function (r) {
      return { key: r.key, name: boxes.querySelector('[data-name-for="' + r.key + '"]').value };
    });
  }

  /** Dim what is not stored, name the channel key each ticked row gets, count per group. */
  function update() {
    var chosen = chosenRows(), keys = {}, error = null;
    try {
      var channels = channelsFor(mineOf(pickedEntries), chosen);
      Object.keys(channels).forEach(function (c) { keys[channels[c]] = c; });
    } catch (e) { error = e.message; }
    rows.forEach(function (r) {
      var row = boxes.querySelector('.ts-bindrow[data-key="' + r.key + '"]');
      var on = row.querySelector('input').checked;
      row.classList.toggle('off', !on);
      var names = row.querySelector('select');
      if (names) { names.disabled = !on; }
      row.querySelector('.ts-bind-key').textContent = on ? (keys[r.key] ? t('device.storedAs', 'stored as {key}', { key: keys[r.key] }) : '') : t('common.notStored', 'not stored');
    });
    groups.forEach(function (g) {
      var n = g.rows.filter(function (r) { return boxes.querySelector('input[data-key="' + r.key + '"]').checked; }).length;
      boxes.querySelector('.ts-bind-group[data-group="' + g.id + '"] .ts-count').textContent = t('device.nOf', '{n} of {total}', { n: n, total: g.rows.length });
    });
    countEl.classList.toggle('ts-error', !!error);
    countEl.textContent = error || t('device.nOfStored', '{n} of {total} stored', { n: chosen.length, total: rows.length });
  }

  /** Tick what the station already takes from this device, else every
   * non-diagnostic measurement whose name is still free or repeats. */
  function tick(entries) {
    var mine = mineOf(entries);
    var mapped = Object.keys(mine).length > 0;
    var used = {};
    rows.forEach(function (r) {
      var box = boxes.querySelector('input[data-key="' + r.key + '"]');
      var channel = Object.keys(mine).filter(function (c) { return mine[c] === r.key; })[0];
      box.checked = mapped ? !!channel : !r.diagnostic && (!used[r.name] || !!(state.names[r.name] || {}).repeatable);
      if (box.checked) { used[r.name] = true; }
      fillNames(boxes.querySelector('[data-name-for="' + r.key + '"]'), r, entries, channel);
    });
    groups.forEach(function (g) {
      boxes.querySelector('.ts-bind-group[data-group="' + g.id + '"]').open =
        g.rows.some(function (r) { return !r.diagnostic || boxes.querySelector('input[data-key="' + r.key + '"]').checked; });
    });
    update();
  }
  tick(pickedEntries);

  ui.drawerActions(dr, t('common.save', 'Save')).addEventListener('click', function () {
    var chosen = chosenRows();
    if (!chosen.length) { ui.toast(t('device.pickMeasurement', 'Pick at least one measurement'), 'error'); return; }
    if (!binding && sel.value === NEW_STATION) {
      var name = newFields.querySelector('[data-f=newName]').value.trim();
      var parent = parents.filter(function (p) { return p.id === newFields.querySelector('[data-f=parent]').value; })[0];
      if (!name || !parent) { ui.toast(t('device.nameNewStation', 'Name the new station and pick where it goes'), 'error'); return; }
      save(null, {}, chosen, { name: name, parent: parent });
      return;
    }
    if (!picked) { ui.toast(t('device.pickStation', 'Pick a station'), 'error'); return; }
    save(picked, pickedEntries || {}, chosen, null);
  });
}

function channelLabel(key) { return M.channelLabel(state.names, key); }

function fillNames(select, r, entries, channel) {
  var o = M.nameOptions(model(), r, entries, channel, state.device.id.id);
  var options = o.options;
  select.innerHTML = '';
  options.forEach(function (n) {
    var opt = document.createElement('option'); opt.value = n; opt.textContent = channelLabel(n); select.appendChild(opt);
  });
  select.value = o.value;
}

function channelsFor(old, chosen) { return M.channelsFor(state.names, old, chosen); }

function save(station, entries, chosen, create) {
  var me = state.device.id.id, channels;
  try { channels = channelsFor(mineOf(entries), chosen); } catch (e) { ui.toast(e.message, 'error'); return; }
  var merged = M.withDevice(entries, me, channels), next = merged.next, takenOver = merged.takenOver;
  var n = chosen.length === 1 ? t('device.measurementOne', '1 measurement') : t('device.measurementMany', '{n} measurements', { n: chosen.length });
  var device = deviceName();
  var text = create
    ? t('device.confirmCreate', 'Create station {station} in {parent} and store {n} of {device} on it?',
        { station: '<b>' + esc(create.name) + '</b>', parent: '<b>' + esc(create.parent.name) + '</b>', n: n, device: device })
    : t('device.confirmStore', 'Store {n} of {device} on {station}?', { n: n, device: device, station: '<b>' + esc(station.name) + '</b>' }) + (takenOver.length
      ? t('device.takenOver', ' These channels move from another device to this one, their history kept: {list}.', { list: '<b>' + takenOver.map(esc).join(', ') + '</b>' }) : '');
  ui.confirm(text, t('common.save', 'Save')).then(function (ok) {
    if (!ok) { return; }
    var map = { 'config.channelMap': resolver.buildMap(next) };
    return (create ? tb.createStation(create.name, create.parent, map) : tb.saveAttrs(station, map).then(function () { return station; })).then(function (s) {
      station = s;
      return relateToMap(station.id, next);
    }).then(function () {
      return tb.resolveStations([station]);
    }).then(function () {
      ui.toast(create ? t('device.stationCreated', 'Station created, device connected') : t('common.saved', 'Saved'));
      ui.closeDrawer();
      return refresh();
    }).catch(function (err) { ui.toast(t('common.notSaved', 'Not saved: {error}', { error: errText(err) }), 'error'); });
  });
}

function disconnect(b) {
  ui.confirm(t('device.confirmDisconnect', 'Disconnect {device} from {station}? Its channels leave the station, which keeps their history.',
    { device: deviceName(), station: '<b>' + esc(b.station.name) + '</b>' }), t('device.disconnect', 'Disconnect')).then(function (ok) {
    if (!ok) { return; }
    var next = {};
    Object.keys(b.entries).forEach(function (c) { if (b.entries[c].device !== state.device.id.id) { next[c] = b.entries[c]; } });
    return tb.saveAttrs(b.station, { 'config.channelMap': resolver.buildMap(next) }).then(function () {
      return relateToMap(b.station.id, next);
    }).then(function () {
      return tb.resolveStations([b.station]);
    }).then(function () {
      ui.toast(t('device.disconnected', 'Disconnected'));
      return refresh();
    }).catch(function (err) { ui.toast(t('device.notDisconnected', 'Not disconnected: {error}', { error: errText(err) }), 'error'); });
  });
}

/** The measurements the stations can take, by key; filled on each render for a writer. */
var storable = {};

/** One measurement on every station the device feeds: whether each stores it and
 * under which channel, the *Channels* editor read across instead of down. Every
 * other channel of the station counts as taken, this device's own included, so a
 * second source of a repeatable name gets its next instance. */
function storeDrawer(r) {
  var me = state.device.id.id;
  var dr = ui.openDrawer(t('device.storeTitle', 'Store {label}', { label: esc(r.label) }), esc(state.device.label || state.device.name) + ' · ' + esc(r.key));
  dr.el.classList.add('wide');
  var list = dr.body.appendChild(h('<div class="ts-field"><div class="ts-field-label"><span>' + esc(t('common.stations', 'Stations')) + ' ' + info('channelName') + '</span></div>' +
    '<div class="ts-field-hint"></div><div class="ts-binds"></div></div>'));
  list.querySelector('.ts-field-hint').textContent = t('device.tickStations', 'Tick the stations that store this measurement. On the right, the channel it is stored under.');
  var boxes = list.querySelector('.ts-binds');
  var rows = state.bindings.map(function (b) {
    var mine = mineOf(b.entries);
    var from = Object.keys(mine).filter(function (c) { return mine[c] === r.key; })[0] || null;
    var rest = Object.assign({}, b.entries);
    if (from) { delete rest[from]; }
    var o = M.nameOptions(model(), r, rest, from, null);
    var row = boxes.appendChild(h('<div class="ts-bindrow"><label class="ts-bind-src"><input type="checkbox"><span class="ts-grow"><span class="ts-bind-name"></span>' +
      '<span class="ts-mono"></span></span></label><span class="ts-dev-arrow">→</span><div class="ts-bind-dst"><select class="ts-select"></select>' +
      '<span class="ts-bind-key"></span></div></div>'));
    row.dataset.station = b.station.name;
    row.querySelector('.ts-bind-name').textContent = b.station.name;
    row.querySelector('.ts-mono').textContent = b.writable ? '' : t('device.readOnlyForYou', 'read-only for you');
    var box = row.querySelector('input'), sel = row.querySelector('select');
    o.options.forEach(function (n) {
      var opt = sel.appendChild(document.createElement('option')); opt.value = n; opt.textContent = channelLabel(n) + ' (' + n + ')';
    });
    sel.value = o.value;
    box.checked = !!from;
    box.disabled = !b.writable;
    return { b: b, from: from, row: row, box: box, sel: sel };
  });
  if (!rows.length) { boxes.appendChild(h('<div class="ts-empty"></div>')).textContent = t('device.feedsNoStation', 'This device feeds no station yet.'); }
  var go = ui.drawerActions(dr, t('common.save', 'Save'));
  var connect = h('<button type="button" class="ts-btn ghost" data-a="connect-more">' + ICON.plus + esc(t('device.connectOrCreate', 'Connect or create a station')) + '</button>');
  dr.foot.insertBefore(connect, dr.foot.firstChild);
  connect.addEventListener('click', function () { bindDrawer(null); });

  /** What the row changes: null for nothing, else `{next, note}` or `{error}`. */
  function plan(x) {
    var target = x.box.checked ? x.sel.value : null;
    if (target === x.from) { return null; }
    var p = M.storeOne(x.b.entries, me, r.key, x.from, target);
    if (p.own) {
      return { error: t('device.channelTaken', '{label} ({channel}) already stores another measurement of this device: change that one first.', { label: channelLabel(target), channel: target }) };
    }
    var note = !target ? t('device.leavesStation', 'leaves the station, which keeps its history')
      : x.from ? t('device.storedAsFrom', 'stored as {key}; the readings so far stay under {from}', { key: target, from: x.from }) : t('device.storedAs', 'stored as {key}', { key: target });
    if (p.takenOver) {
      note += p.takenOver.device ? t('device.takenFromDevice', '; {channel} moves from another device to this measurement, its history kept', { channel: target })
        : t('device.takenFromNone', '; {channel} moves from no device to this measurement, its history kept', { channel: target });
    }
    return { next: p.next, note: note };
  }
  function update() {
    var error = false;
    rows.forEach(function (x) {
      var p = plan(x);
      x.row.classList.toggle('off', !x.box.checked);
      x.sel.disabled = !x.box.checked || !x.b.writable;
      var key = x.row.querySelector('.ts-bind-key');
      key.classList.toggle('ts-error', !!(p && p.error));
      key.textContent = p ? p.error || p.note : x.from ? t('device.storedAs', 'stored as {key}', { key: x.from }) : t('common.notStored', 'not stored');
      error = error || !!(p && p.error);
    });
    go.disabled = error;
  }
  boxes.addEventListener('change', update);
  update();

  go.addEventListener('click', function () {
    var changes = rows.map(function (x) { return { x: x, p: plan(x) }; }).filter(function (c) { return c.p; });
    if (!changes.length) { ui.closeDrawer(); return; }
    ui.confirm(t('device.storeConfirm', '{label} of {device}:', { label: '<b>' + esc(r.label) + '</b>', device: deviceName() }) + '<ul>' + changes.map(function (c) {
      return '<li>' + esc(c.x.b.station.name) + ': ' + esc(c.p.note) + '</li>';
    }).join('') + '</ul>', t('common.save', 'Save')).then(function (ok) {
      if (!ok) { return; }
      return Promise.all(changes.map(function (c) {
        return tb.saveAttrs(c.x.b.station, { 'config.channelMap': resolver.buildMap(c.p.next) }).then(function () {
          return relateToMap(c.x.b.station.id, c.p.next);
        });
      })).then(function () {
        return tb.resolveStations(changes.map(function (c) { return c.x.b.station; }));
      }).then(function () {
        ui.toast(t('common.saved', 'Saved'));
        ui.closeDrawer();
        return refresh();
      }).catch(function (err) { ui.toast(t('common.notSaved', 'Not saved: {error}', { error: errText(err) }), 'error'); });
    });
  });
}

/** The wiring line under a measurement: the station channels it feeds, and for a
 * writer the way to change them. Empty for a diagnostic stored nowhere. */
function wireLine(key, feeds, unwired, describe) {
  var r = state.writable && storable[key];
  if (!feeds.length && !unwired && !r) { return null; }
  var wire = h('<div class="ts-wire"></div>');
  if (feeds.length || unwired) {
    wire.dataset.wired = feeds.length ? '1' : '0';
    wire.textContent = feeds.length ? feeds.map(describe).join('   ') : unwired;
  }
  if (r) {
    wire.appendChild(h('<button type="button" class="ts-btn ghost sm" data-a="store">' +
      (feeds.length ? ICON.edit + esc(t('common.stations', 'Stations')) : ICON.plus + esc(t('device.store', 'Store'))) + '</button>'))
      .addEventListener('click', function () { storeDrawer(r); });
  }
  return wire;
}

/** Every stored key of a LOGR2 sensor, its bookkeeping and the dry contact interface's
 * rule matches included. */
function sensorKeys(part) {
  return Object.keys(state.latest).filter(function (k) {
    return k.indexOf(part.id + '.') === 0 || (part.id === 'dryc' && RULE_SOURCE.test(k));
  });
}

/** A LOGR2 sensor no longer used: delete its readings on the device, and take
 * its channels off the stations the user may write. Station history stays. */
function deleteSensorData(part) {
  var keys = sensorKeys(part);
  var fed = [];
  state.bindings.forEach(function (b) {
    var channels = mineOf(b.entries);
    var gone = Object.keys(channels).filter(function (c) { return keys.indexOf(channels[c]) >= 0; });
    if (gone.length && b.writable) { fed.push({ binding: b, gone: gone }); }
  });
  var text = t('device.confirmDeleteData', 'Delete the data of the {part} on {device}? Its {n} measurements and their history on the device are deleted.',
      { part: '<b>' + esc(part.label) + '</b>', device: deviceName(), n: keys.length }) +
    (fed.length ? t('device.deleteDataChannels', ' These station channels stop receiving values and keep their history:') + ' <ul>' + fed.map(function (f) {
      return '<li>' + esc(f.binding.station.name) + ' · ' + f.gone.map(esc).join(', ') + '</li>';
    }).join('') + '</ul>' : '') +
    t('device.deleteDataReturns', ' A sensor that still reports comes back with its next reading.');
  ui.confirm(text, t('common.delete', 'Delete')).then(function (ok) {
    if (!ok) { return; }
    return tb.del('/api/plugins/telemetry/DEVICE/' + state.device.id.id + '/timeseries/delete',
      { keys: keys.join(','), deleteAllDataForKeys: 'true', rewriteLatestIfDeleted: 'false' }).then(function () {
      return Promise.all(fed.map(function (f) {
        var next = Object.assign({}, f.binding.entries);
        f.gone.forEach(function (c) { delete next[c]; });
        return tb.saveAttrs(f.binding.station, { 'config.channelMap': resolver.buildMap(next) });
      }));
    }).then(function () {
      return fed.length ? tb.resolveStations(fed.map(function (f) { return f.binding.station; })) : null;
    }).then(function () {
      ui.toast(t('device.dataDeleted', '{part} data deleted', { part: part.label }));
      return refresh();
    }).catch(function (err) { ui.toast(t('common.notDeleted', 'Not deleted: {error}', { error: errText(err) }), 'error'); });
  });
}

// -- replace device (DEVICE_VIEW.md §2, CA-13) -------------------------------------------------

var PROVENANCE_KEY = /^(uplinkCause|uplinkLatest|rssi|snr)$|\.status$/;

/** The stations whose channels this device feeds and the user may write. */
function replaceable() {
  return state.bindings.filter(function (b) { return b.writable && Object.keys(mineOf(b.entries)).length; });
}

/** Every key this device reports or feeds a station with. */
function ownKeys() {
  var keys = {};
  Object.keys(state.latest).forEach(function (k) { keys[k] = true; });
  state.bindings.forEach(function (b) {
    var mine = mineOf(b.entries);
    Object.keys(mine).forEach(function (c) { keys[mine[c]] = true; });
  });
  return Object.keys(keys);
}

/** What can go over to the replacement, each `{id, text, keys}`: its label, its
 * register, its own limits and retention. The inactivity timeout follows the
 * register's interval, as the register's own save writes it. */
function carryRows() {
  var s = state.server, rows = [];
  if (state.device.label) { rows.push({ id: 'label', text: t('device.carryLabel', 'Label: {label}', { label: state.device.label }), keys: [] }); }
  var reg = Object.keys(s).filter(function (k) { return /^register\./.test(k); }).sort();
  if (reg.length) {
    rows.push({ id: 'register', text: t('device.carryRegister', 'Register: {list}', { list: reg.map(function (k) { return k.slice('register.'.length); }).join(', ') }),
                keys: reg.concat(s['register.intervalSeconds'] !== undefined && s.inactivityTimeout !== undefined ? ['inactivityTimeout'] : []) });
  }
  var limits = Object.keys(s).filter(function (k) { return /^channel\./.test(k) || k === 'config.ttlDays'; }).sort();
  if (limits.length) {
    rows.push({ id: 'limits', text: limits.length === 1 ? t('device.carryLimitsOne', 'Own limits and retention: 1 setting')
      : t('device.carryLimitsMany', 'Own limits and retention: {n} settings', { n: limits.length }), keys: limits });
  }
  return rows;
}

/** Replace this device by another of the same owner, in one save: each channel
 * it feeds moves to a source key of the replacement — the same key when it has
 * it, else one of the same kind — and a channel left unmatched leaves its
 * station, which keeps its history. This device keeps its own. */
function replaceDrawer() {
  var me = state.device.id.id, owner = ownerOf(), bound = replaceable(), candidates = {};
  var dr = ui.openDrawer(t('device.replaceTitle', 'Replace device'), esc(state.device.label || state.device.name));
  dr.el.classList.add('wide');
  var field = dr.body.appendChild(h('<div class="ts-field"><div class="ts-field-label"><span>' + esc(t('device.replacement', 'Replacement')) + '</span></div>' +
    '<div class="ts-ctl"><select class="ts-select wide" data-f="device"><option value="">' + esc(t('device.pickDevice', 'Pick a device')) + '</option></select></div>' +
    '<div class="ts-field-hint"></div></div>'));
  field.querySelector('.ts-field-hint').textContent = bound.length
    ? t('device.replaceHintFed', 'Every channel this device feeds moves to the replacement; each station keeps its history, this device keeps its own.')
    : t('device.replaceHintFree', 'This device feeds no station: the replacement takes over what is ticked below.');
  var sel = field.querySelector('select');
  var table = dr.body.appendChild(h('<div class="ts-binds" data-f="match"></div>'));
  var unmatched = dr.body.appendChild(h('<div class="ts-field-hint" data-f="unmatched"></div>'));
  var rows = carryRows();
  if (rows.length) {
    var carry = dr.body.appendChild(h('<div class="ts-field"><div class="ts-field-label"><span>' + esc(t('device.carryOver', 'Carry over')) + '</span></div><div class="ts-carry"></div></div>'));
    rows.forEach(function (r) {
      var row = carry.querySelector('.ts-carry').appendChild(h('<label class="ts-switch"><input type="checkbox" checked> <span></span></label>'));
      row.querySelector('input').setAttribute('data-carry', r.id);
      row.querySelector('span').textContent = r.text;
    });
  }

  // The owner's devices, the free ones first, then each under the stations it feeds.
  var url = owner.entityType === 'CUSTOMER' ? '/api/customer/' + owner.id + '/devices' : '/api/tenant/devices';
  tb.getAll(url, {}).then(function (list) {
    return Promise.all(list.filter(function (d) { return d.id.id !== me && d.ownerId.id === owner.id; }).map(function (d) {
      return tb.deviceParents({ id: d.id.id }).then(function (parents) {
        d.feeds = parents.map(function (p) { return p.name; }).sort().join(', ');
        return d;
      });
    }));
  }).then(function (list) {
    var groups = {};
    list.sort(function (a, b) { return a.name.localeCompare(b.name); }).forEach(function (d) {
      candidates[d.id.id] = d;
      (groups[d.feeds] = groups[d.feeds] || []).push(d);
    });
    Object.keys(groups).sort(function (a, b) { return !!a - !!b || a.localeCompare(b); }).forEach(function (feeds) {
      var group = sel.appendChild(document.createElement('optgroup'));
      group.label = feeds ? t('common.feeding', 'Feeding {stations}', { stations: feeds }) : t('common.free', 'Free');
      groups[feeds].forEach(function (d) {
        var o = group.appendChild(document.createElement('option'));
        o.value = d.id.id;
        o.textContent = d.name + (d.label ? ' · ' + d.label : '') + ' (' + d.type + ')';
      });
    });
  });

  function showUnmatched() {
    var left = Array.prototype.filter.call(table.querySelectorAll('select[data-station]'), function (p) { return !p.value; });
    unmatched.textContent = left.length ? t('device.unmatched', 'Unmatched, leaving their station: {list}', { list: left.map(function (p) { return p.dataset.channel; }).join(', ') }) : '';
  }
  table.addEventListener('change', showUnmatched);

  sel.addEventListener('change', function () {
    table.innerHTML = '';
    unmatched.textContent = '';
    var d = candidates[sel.value];
    if (!d) { return; }
    Promise.all([
      tb.get('/api/plugins/telemetry/DEVICE/' + d.id.id + '/keys/timeseries').catch(function () { return []; }),
      tb.attrsMap({ entityType: 'DEVICE', id: d.id.id }, 'CLIENT_SCOPE')
    ]).then(function (got) {
      var how = {}, reported = tb.readingKeys(got[0]);
      reported.forEach(function (k) { how[k] = 'reports'; });
      Object.keys(got[1] || {}).forEach(function (a) {
        var m = /^subscriptions\.(.+)\.(?:enabled|interval)$/.exec(a);
        if (m && !how[m[1]]) { how[m[1]] = 'subscribes'; }
      });
      // A replacement of the same family not heard from yet will report what this one reports.
      if (d.type === state.device.type && !reported.length) {
        ownKeys().forEach(function (k) { if (!how[k]) { how[k] = 'expected'; } });
      }
      var offered = Object.keys(how).filter(function (k) { return !PROVENANCE_KEY.test(k) && NOT_READINGS.indexOf(k) < 0; }).sort();
      bound.forEach(function (b) {
        var mine = mineOf(b.entries);
        var grp = table.appendChild(h('<div class="ts-bind-group" open><div class="ts-section-head"></div></div>'));
        grp.firstChild.textContent = b.station.name;
        Object.keys(mine).sort().forEach(function (c) {
          var key = mine[c], kind = resolver.deviceKeyKind(key, state.names);
          var same = offered.filter(function (k) { return resolver.deviceKeyKind(k, state.names) === kind; });
          var guess = offered.indexOf(key) >= 0 ? key : same.length === 1 ? same[0] : '';
          var row = grp.appendChild(h('<div class="ts-bindrow"><span class="ts-grow"><span class="ts-bind-name"></span><span class="ts-mono"></span></span>' +
            '<span class="ts-dev-arrow">→</span><select class="ts-select"></select></div>'));
          row.querySelector('.ts-bind-name').textContent = c;
          row.querySelector('.ts-mono').textContent = key;
          var pick = row.querySelector('select');
          pick.dataset.station = b.station.id;
          pick.dataset.channel = c;
          pick.appendChild(h('<option value=""></option>')).textContent = t('device.leavesStationShort', 'leaves the station');
          (same.length ? same : offered).forEach(function (k) {
            var o = pick.appendChild(document.createElement('option'));
            o.value = k;
            o.textContent = k + (how[k] === 'expected' ? ' (' + t('device.expected', 'expected') + ')' : '');
          });
          pick.value = guess;
        });
      });
      showUnmatched();
    }).catch(function (err) { ui.toast(t('device.replacementUnreadable', 'Could not read the replacement: {error}', { error: errText(err) }), 'error'); });
  });

  ui.drawerActions(dr, t('device.replace', 'Replace')).addEventListener('click', function () {
    var d = candidates[sel.value];
    if (!d) { ui.toast(t('device.pickReplacement', 'Pick the replacement'), 'error'); return; }
    var target = { entityType: 'DEVICE', id: d.id.id, name: d.name, label: d.label, kind: d.type };
    var picks = Array.prototype.slice.call(table.querySelectorAll('select[data-station]'));
    var dropped = picks.filter(function (p) { return !p.value; }).map(function (p) { return p.dataset.channel; });
    var carried = rows.filter(function (r) { return dr.body.querySelector('[data-carry=' + r.id + ']').checked; });
    ui.confirm((bound.length ? (picks.length - dropped.length === 1 ? t('device.confirmMoveToOne', 'Move 1 channel to {device}?', { device: '<b>' + esc(d.name) + '</b>' })
      : t('device.confirmMoveToMany', 'Move {n} channels to {device}?', { n: picks.length - dropped.length, device: '<b>' + esc(d.name) + '</b>' }))
      : t('device.confirmReplaceBy', 'Replace by {device}?', { device: '<b>' + esc(d.name) + '</b>' })) +
      (dropped.length ? t('device.droppedChannels', ' These leave their station, which keeps their history: {list}.', { list: '<b>' + dropped.map(esc).join(', ') + '</b>' }) : '') +
      (carried.length ? t('device.takesOver', ' It takes over: {list}.', { list: carried.map(function (r) { return esc(r.text); }).join('; ') }) : ''), t('device.replace', 'Replace'))
      .then(function (ok) {
        if (!ok) { return; }
        var moved = [];
        return Promise.all(bound.map(function (b) {
          var next = {}, keys = [];
          Object.keys(b.entries).forEach(function (c) {
            if (b.entries[c].device !== me) { next[c] = b.entries[c]; return; }
            var p = picks.filter(function (x) { return x.dataset.station === b.station.id && x.dataset.channel === c; })[0];
            if (p && p.value) { next[c] = { device: target.id, key: p.value }; keys.push(b.entries[c].key); }
          });
          moved.push({ station: b.station, attrs: b.attrs, channels: Object.keys(next).filter(function (c) { return next[c].device === target.id; }), keys: keys });
          return tb.saveAttrs(b.station, { 'config.channelMap': resolver.buildMap(next) }).then(function () {
            return relateToMap(b.station.id, next);
          });
        })).then(function () {
          var write = {};
          carried.forEach(function (r) { r.keys.forEach(function (k) { write[k] = state.server[k]; }); });
          return tb.saveAttrs(target, write).then(function () {
            return carried.some(function (r) { return r.id === 'label'; }) ? tb.setLabel(target, state.device.label) : null;
          });
        }).then(function () {
          return tb.resolveStations(bound.map(function (b) { return b.station; }).concat([target]));
        }).then(function () {
          state.followUp = { target: target, steps: followUpSteps(target, moved) };
          ui.toast(t('device.replaced', 'Device replaced'));
          ui.closeDrawer();
          return refresh();
        });
      }).catch(function (err) { ui.toast(t('device.notReplaced', 'Not replaced: {error}', { error: errText(err) }), 'error'); });
  });
}

/** The `calc.*` zero references of a station's calculated channels that read a channel now fed by the replacement. */
function zeroReferences(m) {
  var fed = m.channels.map(function (c) { return resolver.splitChannelKey(c).name; }), out = [];
  resolver.calculationPlan(m.attrs, state.names).filter(function (p) { return p.on; }).forEach(function (p) {
    p.reads.forEach(function (a) {
      var spec = state.calcAttributes[a];
      if (spec && spec.reading && fed.indexOf(spec.reading) >= 0 && out.indexOf(a) < 0) { out.push(a); }
    });
  });
  return out;
}

/** What a replacement leaves to do, each step applying only where it has something to do. */
function followUpSteps(target, moved) {
  var steps = [];
  var dryc = moved.some(function (m) {
    var rules = parseJson(m.attrs['dryc.rules']);
    return rules && (rules.rules || []).length && m.keys.some(function (k) { return DRYC_KEY.test(k); });
  });
  var drycStation = moved.filter(function (m) { return parseJson(m.attrs['dryc.rules']); })[0];
  if (dryc && drycStation && opts.projectDashboardId) {
    var send = { a: 'dryc', label: t('device.stepDryc', 'Send the DRYC rules of {station} to {device}', { station: drycStation.station.name, device: target.name }),
                 action: t('device.stepSend', 'Send…') };
    send.run = function () {
      send.done = true;
      tb.openDashboard(opts.projectDashboardId, 'dryc', drycStation.station);
    };
    steps.push(send);
  }
  moved.forEach(function (m) {
    var refs = zeroReferences(m);
    if (!refs.length) { return; }
    var step = { a: 'zero', label: t('device.stepZero', 'Set the zero reference on {station}', { station: m.station.name }), action: t('device.stepSet', 'Set…') };
    step.run = function () { zeroDrawer(step, m.station, refs); };
    steps.push(step);
  });
  steps.push({ a: 'out-of-service', label: t('device.stepOutOfService', 'Mark {device} out of service', { device: state.device.label || state.device.name }),
    action: t('lifecycle.service.outMenu', 'Out of service…'),
    run: function () { life.outOfService(deviceEntity(), refresh); } });
  return steps;
}

/** The station's zero references, taken again from the replacement's readings. */
function zeroDrawer(step, station, refs) {
  var dr = ui.openDrawer(t('device.zeroTitle', 'Set the zero reference'), esc(station.name));
  dr.body.appendChild(h('<div class="ts-field-hint"></div>')).textContent = t('device.zeroHint', 'The replacement reads its own zero: take its reading as the reference, or keep the value.');
  tb.attrsMap(station).then(function (attrs) {
    var form = calc.form(station, attrs, refs, { names: state.names, attributes: state.calcAttributes });
    dr.body.appendChild(form.el);
    ui.drawerActions(dr, t('common.save', 'Save')).addEventListener('click', function () {
      var write = form.values();
      if (!write) { ui.toast(t('device.zeroInvalid', 'Enter a number for each reference'), 'error'); return; }
      calc.save(station, write).then(function () {
        step.done = true;
        ui.closeDrawer();
        ui.toast(t('device.zeroSaved', 'Zero reference saved'));
        render();
      }).catch(function (err) { ui.toast(t('common.notSaved', 'Not saved: {error}', { error: errText(err) }), 'error'); });
    });
  });
}

/** The follow-up card of the last replacement, until every step is done or it is dismissed. */
function followUpCard() {
  var f = state.followUp;
  if (!f) { return null; }
  f.steps.forEach(function (s) { if (s.a === 'out-of-service') { s.done = !!tb.serviceOf(state.server).state; } });
  if (f.steps.every(function (s) { return s.done; })) { state.followUp = null; return null; }
  var card = ui.followUp(t('device.followUp', 'Replaced by {device}: next steps', { device: f.target.name }), f.steps, function () { state.followUp = null; });
  card.setAttribute('data-followup', f.target.name);
  return card;
}

// -- bus moves (CA-14) --------------------------------------------------------------------------

/** Positions whose wired sources went silent while another position, feeding
 * no station, reports the same peripheral type — by its topology type when
 * both are listed, else by the kinds it measures: `[{from, to, since}]`. */
function busMoves(nodes, srcs) {
  var base = Number(state.client['status.baseIntervalSeconds']) || 0, byPos = {}, moves = [];
  srcs.forEach(function (s) { if (s.position) { (byPos[s.position] = byPos[s.position] || []).push(s); } });
  function ts(s) { return (state.latest[s.sourceKey] || {}).ts || 0; }
  function newest(list) { return Math.max.apply(null, list.map(ts)); }
  function silent(s) { var iv = Number(s.interval) || base; return !!iv && Date.now() - ts(s) > SILENT_INTERVALS * iv * 1000; }
  Object.keys(byPos).forEach(function (p) {
    var wired = byPos[p].filter(function (s) { return state.wiring[s.sourceKey]; });
    if (!wired.length || !newest(wired) || !wired.every(silent)) { return; }
    var kinds = wired.map(function (s) { return s.kind; });
    var to = Object.keys(byPos).filter(function (q) {
      var own = byPos[q];
      if (q === p || own.some(function (s) { return state.wiring[s.sourceKey]; }) || newest(own) <= newest(wired) || own.every(silent)) { return false; }
      return nodes[p] && nodes[q] ? nodes[p].type === nodes[q].type
        : kinds.every(function (k) { return own.some(function (s) { return s.kind === k; }); });
    })[0];
    if (to) { moves.push({ from: Number(p), to: Number(to), since: newest(wired) }); }
  });
  return moves;
}

function moveBanner(move) {
  var el = h('<div class="ts-banner warn" data-banner="move">' + ICON.info + '<span class="ts-grow"></span></div>');
  el.querySelector('span').textContent = t('device.moveBanner', 'Position {from} silent since {since}, position {to} reports the same type',
    { from: move.from, since: ui.when(move.since), to: move.to });
  if (state.writable) {
    el.appendChild(h('<button type="button" class="ts-btn" data-a="move-channels">' + esc(t('device.moveChannels', 'Move channels')) + '</button>'))
      .addEventListener('click', function () { moveChannels(move); });
  }
  return el;
}

/** Rewrite this device's map entries from one position to the other; each channel keeps its history. */
function moveChannels(move) {
  var me = state.device.id.id, from = new RegExp('^p' + move.from + '\\.'), to = 'p' + move.to + '.';
  function moving(e) { return e.device === me && from.test(e.key); }
  var touched = state.bindings.filter(function (b) {
    return b.writable && Object.keys(b.entries).some(function (c) { return moving(b.entries[c]); });
  });
  var items = [];
  touched.forEach(function (b) {
    Object.keys(b.entries).filter(function (c) { return moving(b.entries[c]); }).forEach(function (c) {
      items.push('<li>' + esc(b.station.name) + ' · ' + esc(c) + ': ' + esc(b.entries[c].key) + ' → ' + esc(b.entries[c].key.replace(from, to)) + '</li>');
    });
  });
  ui.confirm(t('device.confirmMove', 'Move these channels from position {from} to position {to}? Each keeps its history.', { from: move.from, to: move.to }) +
    '<ul>' + items.join('') + '</ul>', t('common.move', 'Move'))
    .then(function (ok) {
      if (!ok) { return; }
      return Promise.all(touched.map(function (b) {
        var next = {};
        Object.keys(b.entries).forEach(function (c) {
          var e = b.entries[c];
          next[c] = moving(e) ? { device: e.device, key: e.key.replace(from, to) } : e;
        });
        return tb.saveAttrs(b.station, { 'config.channelMap': resolver.buildMap(next) });
      })).then(function () {
        return tb.resolveStations(touched.map(function (b) { return b.station; }));
      }).then(function () {
        ui.toast(t('device.moved', 'Channels moved to position {to}', { to: move.to }));
        return refresh();
      });
    }).catch(function (err) { ui.toast(t('common.notMoved', 'Not moved: {error}', { error: errText(err) }), 'error'); });
}

// -- register -------------------------------------------------------------------------------

/** Hand-kept facts a device cannot report (ATTRIBUTES.md §3): the four
 * `register.*` fields of a LOGR2, and the measurement interval of any device
 * other than a LOGR3 or LOGR4, from which its inactivity timeout follows:
 * three intervals, as a LOGR3 or LOGR4 derives its own. */
function registerFields() { return family() === 'logr2' ? register() : []; }

function registerSection() {
  var s = state.server;
  var sec = h('<div class="ts-section" data-section="register"><div class="ts-section-head">' + esc(t('device.attributes', 'Attributes')) + ' ' + info('register') +
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
    if (f.flag) { tile(f.key, f.label, truthyFlag(v) ? t('device.possible', 'possible') : t('device.impossible', 'impossible'), !truthyFlag(v)); }
    else { tile(f.key, f.label, String(v), f.key === 'register.hwStatus' && !FINE_STATUS.test(String(v))); }
  });
  var interval = Number(s['register.intervalSeconds']);
  tile('register.intervalSeconds', t('device.measurementInterval', 'Measurement interval'), interval > 0 ? fmtDuration(interval) : t('device.notSet', 'not set'), !(interval > 0));
  var timeout = Number(s.inactivityTimeout);
  tile('inactivityTimeout', t('device.inactivityTimeout', 'Inactivity timeout'), timeout > 0 ? fmtDuration(timeout / 1000) : t('device.platformDefault', 'platform default'), false);
  if (state.writable) {
    var edit = h('<button type="button" class="ts-btn ts-reg-edit" data-a="register">' + ICON.edit + esc(t('common.edit', 'Edit')) + '</button>');
    edit.addEventListener('click', registerDrawer);
    sec.querySelector('.ts-section-head').appendChild(edit);
  }
  return sec;
}

function registerDrawer() {
  var s = state.server;
  var dr = ui.openDrawer(t('device.attributes', 'Attributes'), esc(state.device.name));
  registerFields().forEach(function (f) {
    var field = h('<div class="ts-field"><div class="ts-field-label"><span></span></div><div class="ts-ctl"></div></div>');
    field.querySelector('span').textContent = f.label;
    var input = f.flag
      ? h('<label><input type="checkbox"> ' + esc(t('device.possibleOnUnit', 'possible on this unit')) + '</label>')
      : h('<input class="ts-input" type="text">');
    var el = f.flag ? input.querySelector('input') : input;
    el.setAttribute('data-key', f.key);
    if (f.flag) { el.checked = truthyFlag(s[f.key]); } else { el.value = s[f.key] === undefined ? '' : s[f.key]; }
    field.querySelector('.ts-ctl').appendChild(input);
    dr.body.appendChild(field);
  });
  dr.body.appendChild(h('<div class="ts-field"><div class="ts-field-label"><span>' + esc(t('device.measurementInterval', 'Measurement interval')) + '</span></div>' +
    '<div class="ts-ctl"><span><input class="ts-input num" type="number" min="0" step="1" data-key="register.intervalSeconds"> min</span></div>' +
    '<div class="ts-field-hint">' + esc(t('device.intervalHint', 'How often the device measures and sends. A channel older than three intervals is stale, and the device turns inactive after three intervals without an uplink.')) +
    '</div></div>'));
  var minutes = dr.body.querySelector('[data-key="register.intervalSeconds"]');
  minutes.value = Number(s['register.intervalSeconds']) > 0 ? Number(s['register.intervalSeconds']) / 60 : '';
  ui.drawerActions(dr, t('common.save', 'Save')).addEventListener('click', function () {
    var write = {}, drop = [];
    dr.body.querySelectorAll('[data-key]').forEach(function (el) {
      var key = el.getAttribute('data-key');
      if (key === 'register.intervalSeconds') {
        if (el.value === '') {
          if (s[key] !== undefined) { drop.push(key); }
          if (s.inactivityTimeout !== undefined) { drop.push('inactivityTimeout'); }
        } else {
          write[key] = Math.round(Number(el.value) * 60);
          write.inactivityTimeout = 3 * write[key] * 1000;
        }
      } else if (el.type === 'checkbox') {
        write[key] = el.checked;
      } else if (el.value.trim()) {
        write[key] = el.value.trim();
      } else if (s[key] !== undefined) {
        drop.push(key);
      }
    });
    if (write['register.intervalSeconds'] !== undefined && !(write['register.intervalSeconds'] > 0)) { ui.toast(t('device.intervalMinutesInvalid', 'An interval is a positive number of minutes'), 'error'); return; }
    var dev = deviceEntity();
    tb.saveAttrs(dev, write).then(function () { return tb.deleteAttrs(dev, drop); }).then(function () {
      ui.toast(t('device.attributesSaved', 'Attributes saved'));
      ui.closeDrawer();
      return refresh();
    }).catch(function (err) { ui.toast(t('common.notSaved', 'Not saved: {error}', { error: errText(err) }), 'error'); });
  });
}

// -- skeleton ---------------------------------------------------------------------------

root.innerHTML = '';
var cardEl = h('<div class="ts-card ts-readonly ts-dev"><div class="ts-head"><div class="ts-head-icon">' + ICON.gauge + '</div><div class="ts-head-text">' +
  '<div class="ts-title"><span>' + esc(t('common.device', 'Device')) + '</span></div><div class="ts-subtitle"></div></div><span class="ts-dev-chips"></span>' +
  '<span class="ts-chip level" hidden></span><div class="ts-dev-acts"></div></div>' +
  '<div class="ts-body"><div class="ts-loading">' + esc(t('common.loading', 'Loading…')) + '</div></div>' +
  '<div class="ts-foot"><span class="ts-summary"></span><span class="ts-spacer"></span><button type="button" class="ts-btn">' + ICON.reset + esc(t('common.refresh', 'Refresh')) + '</button></div></div>');
root.appendChild(cardEl);
window.TerrySenseNav(ctx, tb, ui, cardEl, opts);
var bodyEl = cardEl.querySelector('.ts-body');
var summaryEl = cardEl.querySelector('.ts-summary');
var refreshBtn = cardEl.querySelector('.ts-foot .ts-btn');
var chipsEl = cardEl.querySelector('.ts-dev-chips');
var actsEl = cardEl.querySelector('.ts-dev-acts');

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
  storable = {};
  if (state.writable) { mappable().forEach(function (r) { storable[r.key] = r; }); }
  renderService();
  var follow = followUpCard();
  if (follow) { bodyEl.appendChild(follow); }
  var top = bodyEl.appendChild(h('<div class="ts-dev-top"><div class="ts-dev-status"></div><div class="ts-dev-topo"></div></div>'));
  renderStatus(top.firstChild);
  top.lastChild.appendChild(topologySection());
  renderStations(bodyEl.appendChild(h('<div class="ts-dev-stations"></div>')));
  var cmds = family() === 'bus' ? commandsSection() : null;
  if (cmds) { bodyEl.appendChild(cmds); }
  cardEl.classList.toggle('ts-readonly', !state.writable);
  summaryEl.textContent = t('common.readAt', 'Read {time}', { time: new Date(state.loadedAt).toLocaleTimeString(t.locale()) });
}

/** The service chips and the silence banner for everyone; *Silence* and the row menu for a writer. */
function renderService() {
  var sv = tb.serviceOf(state.server), until = !sv.state && sv.silencedUntil;
  chipsEl.innerHTML = '';
  life.deviceChips(state.server).forEach(function (c) { chipsEl.appendChild(c); });
  if (until) {
    var banner = bodyEl.appendChild(h('<div class="ts-banner ts-dev-silence">' + ICON.mute + '<span class="ts-grow"></span></div>'));
    banner.querySelector('span').textContent = sv.silencedBy
      ? t('device.silenceNoteBy', '{silence} by {name}: device alarms are raised and shown, nobody is notified.', { silence: ui.silenceText(until), name: sv.silencedBy })
      : t('device.silenceNote', '{silence}: device alarms are raised and shown, nobody is notified.', { silence: ui.silenceText(until) });
    if (state.writable) {
      banner.appendChild(h('<button type="button" class="ts-btn" data-a="end-silence">' + esc(t('common.endSilence', 'End now')) + '</button>'))
        .addEventListener('click', function () { life.endSilence(deviceEntity(), refresh); });
    }
  }
  actsEl.innerHTML = '';
  if (!state.writable) { return; }
  if (!sv.state) {
    var silence = actsEl.appendChild(h('<button type="button" class="ts-btn" data-a="silence">' + ICON.mute + esc(t('common.silence', 'Silence')) + '</button>'));
    silence.addEventListener('click', function () { life.silenceMenu(silence, deviceEntity(), refresh); });
  }
  actsEl.appendChild(ui.rowMenu(function () {
    return [
      { a: 'replace', label: t('device.replaceItem', 'Replace device…'), run: replaceDrawer },
      life.serviceItem(deviceEntity(), state.server, refresh)
    ];
  }, { title: t('device.actions', 'Device actions') }));
}

function firmwareOf() { return state.client['deviceInfo.fwVersion'] || null; }

/** Left pane: the product image beside its verdict (TC-3), uplink, versions and
 * operational status; for a device that cannot report them, the register below. */
function renderStatus(pane) {
  var faulting = Object.keys(state.faults);
  var active = truthyFlag(state.server.active);
  var hw = state.client['deviceInfo.hwVersion'] || state.server['register.hwVersion'], fw = firmwareOf();

  var type = String(state.device.type || '');
  var image = ui.productImage(type);
  pane = pane.appendChild(h('<div class="ts-section" data-section="device"><div class="ts-section-head">' + esc(t('common.device', 'Device')) + '</div></div>'));
  var id = pane.appendChild(h('<div class="ts-dev-id"><div class="ts-dev-figure"></div><div class="ts-dev-facts"></div></div>'));
  var figure = id.querySelector('.ts-dev-figure');
  figure.dataset.type = type;
  figure.dataset.figure = image ? 'image' : 'placeholder';
  if (image) {
    var img = figure.appendChild(h('<img>'));
    img.src = image;
    img.alt = type;
  } else {
    figure.appendChild(h('<span class="ts-dev-model"></span>')).textContent = (type || t('common.device', 'Device')).toUpperCase();
    figure.appendChild(h('<span class="ts-row-meta"></span>')).textContent = t('device.noImage', 'No product image');
  }
  var facts = id.querySelector('.ts-dev-facts');

  var verdict = active && !faulting.length;
  var banner = h('<div class="ts-banner ' + (verdict ? 'ok' : 'warn') + '">' + (verdict ? ICON.check : ICON.info) + '<span></span></div>');
  banner.querySelector('span').textContent = verdict
    ? (family() === 'bus' ? t('device.liveNoFault', 'Live, no peripheral fault.') : t('device.live', 'Live.'))
    : [active ? null : t('device.notActive', 'Not active: no uplink within the inactivity timeout.'),
       faulting.length === 1 ? t('device.faultingOne', '1 source is faulting.')
         : faulting.length ? t('device.faultingMany', '{n} sources are faulting.', { n: faulting.length }) : null]
      .filter(Boolean).join(' ');
  facts.appendChild(banner);

  function kv(label, tip, valueHtml) {
    var row = h('<div class="ts-kv"><div class="ts-kv-label">' + esc(label) + (tip ? ' ' + info(tip) : '') + '</div><div class="ts-kv-value"></div></div>');
    row.querySelector('.ts-kv-value').innerHTML = valueHtml;
    facts.appendChild(row);
  }
  kv(t('device.uplink', 'Uplink'), 'uplink', '<span class="ts-status"><span class="ts-dot" style="background:' + (active ? 'var(--ts-ok)' : 'var(--ts-danger)') + '"></span>' +
    esc(active ? t('device.activeLast', 'Active, last {ago}', { ago: t.ago(state.server.lastActivityTime) })
      : t('device.inactiveLast', 'Inactive, last {ago}', { ago: t.ago(state.server.lastActivityTime) })) + '</span>');
  if (family() === 'bus') {
    kv(t('device.faults', 'Faults'), 'peripheralFault', faulting.length
      ? faulting.sort().map(function (k) { return '<span class="ts-chip fault">' + esc(k) + '</span>'; }).join(' ')
      : '<span class="ts-status">' + esc(t('common.none', 'none')) + '</span>');
  }
  if (fw || hw) {
    kv(t('common.versions', 'Versions'), null, '<span class="ts-mono">' + esc([fw ? t('device.firmwareVersion', 'firmware {v}', { v: fw }) : '',
      hw ? t('device.hardwareVersion', 'hardware {v}', { v: hw }) : ''].filter(Boolean).join(' · ')) + '</span>');
  }
  var status = statusSection();
  if (status) { facts.appendChild(status); }
  if (family() !== 'bus') { pane.appendChild(registerSection()); }
  var logger = loggerCard();
  if (logger) { pane.appendChild(h('<div class="ts-bus ts-dev-logr"></div>')).appendChild(logger); }
}

/** Below both panes: the Stations that contain the device, one full-width card
 * each with a row per channel it feeds there, measurement to channel (TC-2), and
 * for a user who may write the device, connecting it (CA-1). */
function renderStations(pane) {
  var sec = pane.appendChild(h('<div class="ts-section" data-section="stations"><div class="ts-section-head">' + esc(t('common.stations', 'Stations')) + ' ' + info('wiring') +
    '<span class="ts-spacer"></span></div></div>'));
  if (state.writable) {
    var add = h('<button type="button" class="ts-btn ts-reg-edit" data-a="connect">' + ICON.plus + esc(t('device.connectOrCreate', 'Connect or create a station')) + '</button>');
    add.addEventListener('click', function () { bindDrawer(null); });
    sec.firstChild.appendChild(add);
  }
  if (!state.bindings.length) {
    sec.appendChild(h('<div class="ts-empty"><span class="ts-chip warn">' + esc(t('common.onNoStation', 'on no station')) + '</span> ' +
      esc(t('device.storedOnDeviceOnly', 'Its readings are stored on the device only.')) + '</div>'));
    return;
  }
  var nodes = topology();
  state.bindings.forEach(function (b) {
    var channels = mineOf(b.entries);
    var names = Object.keys(channels).sort(function (x, y) { return channels[x].localeCompare(channels[y]) || x.localeCompare(y); });
    var card = h('<details class="ts-dev-station"><summary class="ts-dev-station-head"><span class="ts-pos-chev">' + ICON.chev + '</span>' +
      '<span class="ts-dev-station-icon">' + ICON_STATION + '</span><span class="ts-dev-station-name"></span><span class="ts-count"></span>' +
      '<span class="ts-spacer"></span><div class="ts-rule-acts"></div></summary><div class="ts-dev-map"></div></details>');
    var foldId = 'station.' + b.station.id;
    card.open = !!state.open[foldId];
    card.addEventListener('toggle', function () { state.open[foldId] = card.open; });
    card.dataset.station = b.station.name;
    card.querySelector('.ts-dev-station-name').textContent = b.station.name;
    card.querySelector('.ts-count').textContent = names.length === 1 ? t('common.channelOne', '1 channel')
      : names.length ? t('common.channelMany', '{n} channels', { n: names.length }) : t('device.noChannel', 'no channel from this device');
    var sv = tb.serviceOf(b.attrs);
    if (sv.retired || sv.silencedUntil) {
      card.querySelector('.ts-count').before(sv.retired ? ui.stateChip('retired') : ui.stateChip('silenced', sv.silencedUntil));
    }
    var map = card.querySelector('.ts-dev-map');
    names.forEach(function (c) {
      var row = map.appendChild(h('<div class="ts-dev-maprow"><div class="ts-dev-from"><span></span><span class="ts-mono"></span></div>' +
        '<span class="ts-dev-arrow">→</span><div class="ts-dev-ch"><span></span><span class="ts-mono"></span></div></div>'));
      row.dataset.channel = c;
      row.querySelector('.ts-dev-from span').textContent = sourceText(channels[c], nodes);
      row.querySelector('.ts-dev-from .ts-mono').textContent = channels[c];
      var label = b.attrs['effective.' + c + '.label'] || c;
      row.querySelector('.ts-dev-ch span').textContent = t.label(c, label, state.names);
      if (label !== c) { row.querySelector('.ts-dev-ch .ts-mono').textContent = c; } else { row.querySelector('.ts-dev-ch .ts-mono').remove(); }
    });
    var acts = card.querySelector('.ts-rule-acts');
    function act(html, fn) {
      var btn = acts.appendChild(h(html));
      btn.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); fn(); });
    }
    if (state.writable && b.writable) {
      act('<button type="button" class="ts-btn ghost" data-a="edit">' + ICON.edit + esc(t('common.channels', 'Channels')) + '</button>', function () { bindDrawer(b); });
      act('<button type="button" class="ts-icon-btn" data-a="disconnect" title="' + esc(t('device.disconnect', 'Disconnect')) + '">' + ICON.close + '</button>', function () { disconnect(b); });
    }
    if (opts.projectDashboardId) {
      act('<button type="button" class="ts-btn ghost" data-a="open">' + esc(t('common.installation', 'Installation')) + ICON.chev + '</button>', function () {
        tb.openDashboard(opts.projectDashboardId, 'station', b.station);
      });
    }
    sec.appendChild(card);
  });
}

/** The device measurement a channel is fed from, in words. */
function sourceText(key, nodes) {
  var s = family() === 'bus' && parseSource(key);
  if (!s) { return labelOf(key); }
  return sourceLabel(s, nodes[s.position]) + ' · ' + (s.position ? t('device.atPosition', 'position {pos}', { pos: s.position }) : t('common.theLogr', 'the LOGR itself'));
}

/** A position or part as a foldable card; the user's folding outlives a refresh. */
function foldable(id, open) {
  var box = h('<details class="ts-pos"><summary class="ts-pos-head"><span class="ts-pos-chev">' + ICON.chev + '</span><span class="ts-pos-num"></span>' +
    '<div class="ts-grow"><div class="ts-pos-name"></div><div class="ts-mono"></div></div><span class="ts-pos-count"></span></summary></details>');
  box.open = state.open[id] !== undefined ? state.open[id] : open;
  box.addEventListener('toggle', function () { state.open[id] = box.open; });
  return box;
}

function countText(n) { return n === 1 ? t('device.readingOne', '1 reading') : t('device.readingMany', '{n} readings', { n: n }); }

/** A button in a card's summary acts without folding the card. */
/** The DRYC is set up on a station (DRYC.md §1): the card names it and opens
 * its Dry contact interface view, the station holding rules first. */
function drycNote(box) {
  var stations = state.bindings.slice().sort(function (a, b) {
    return !!parseJson(b.attrs['dryc.rules']) - !!parseJson(a.attrs['dryc.rules']);
  });
  var st = stations[0];
  if (!st) {
    box.appendChild(h('<div class="ts-field-hint ts-dryc-note"></div>')).textContent = t('device.drycNoStation', 'Inputs, relays and rules are set up on a station: connect this device to one first.');
    return;
  }
  if (!opts.projectDashboardId) { return; }
  headButton(box, '<button type="button" class="ts-btn" data-a="relays"></button>', function () {
    tb.openDashboard(opts.projectDashboardId, 'dryc', st.station);
  }).textContent = t('device.setUpOn', 'Set up on {station}', { station: st.station.name });
}

function headButton(box, html, onClick) {
  var b = box.querySelector('.ts-pos-head').appendChild(h(html));
  b.addEventListener('click', function (e) { e.preventDefault(); onClick(); });
  return b;
}

/** Right pane: the peripherals, one foldable card per position, stacked in bus
 * order (TC-1, TC-5); the LOGR itself is in the Device pane. */
function topologySection() {
  var fam = family();
  var sec = h('<div class="ts-section ts-dev-bus"><div class="ts-section-head">' + esc(t('device.peripherals', 'Peripherals')) + ' ' + info('position') + '</div><div class="ts-bus"></div></div>');
  var bus = sec.querySelector('.ts-bus');
  if (fam === 'logr2') {
    var fixed = sec.querySelector('.ts-section-head').appendChild(h('<span class="ts-chip" data-fixed="1"></span>'));
    fixed.title = t('device.fixedTip', 'Set in the LOGR2 firmware: nothing to configure from the cloud');
    fixed.textContent = t('device.fixed', 'fixed in firmware');
  }
  if (fam === 'bus') {
    var nodes = topology(), srcs = sources();
    var positions = {};
    Object.keys(nodes).forEach(function (p) { positions[p] = true; });
    srcs.forEach(function (s) { positions[s.position] = true; });
    delete positions[0];
    busMoves(nodes, srcs).forEach(function (m) { bus.appendChild(moveBanner(m)); });
    Object.keys(positions).map(Number).sort(function (a, b) { return a - b; }).forEach(function (pos) { bus.appendChild(positionCard(pos, nodes[pos], srcs)); });
  } else {
    var keys = readings();
    var parts = fam === 'logr2' ? logr2Parts(keys) : [{ id: 'device', label: state.device.type || t('common.device', 'Device'), keys: keys }];
    parts.forEach(function (part, i) {
      if (part.keys.length && part.id !== 'logr') { bus.appendChild(partCard(part, fam === 'logr2' ? i : null)); }
    });
  }
  if (!bus.childNodes.length) {
    bus.appendChild(h('<div class="ts-empty"></div>')).textContent = t('device.noPeripheral', 'No peripheral reported yet.');
  }
  return sec;
}

/** The LOGR itself, position 0, at the foot of the Device pane: a bus LOGR's
 * position 0 or a LOGR2's own readings; none for any other device. */
function loggerCard() {
  var fam = family();
  if (fam === 'bus') { return positionCard(0, topology()[0] || logrNode(), sources()); }
  return fam === 'logr2' ? partCard(logr2Parts(readings())[0], 0) : null;
}

/** Position 0 as its catalog entry, `logr-3` or `logr-4` by device type: the TOPOLOGY report lists the external positions only. */
function logrNode() {
  return { position: 0, type: String(state.device.type).replace(/^logr(\d)$/, 'logr-$1') };
}

/** A LOGR2 part or another device, read-only: its readings and the station channel each feeds. */
function partCard(part, pos) {
  var logger = part.id === 'logr';
  var box = foldable('part.' + part.id, false);
  box.dataset.part = part.id;
  var num = box.querySelector('.ts-pos-num');
  if (pos === null) { num.remove(); } else { num.textContent = pos; }
  box.querySelector('.ts-pos-name').textContent = part.label || t('mapping.logrItself', 'LOGR itself');
  box.querySelector('.ts-pos-head .ts-mono').remove();
  box.querySelector('.ts-pos-count').textContent = countText(part.keys.length);
  if (part.id === 'dryc') { drycNote(box); }
  if (LOGR2_SENSORS[part.id] && state.writable) {
    headButton(box, '<button type="button" class="ts-btn danger" data-a="delete-data">' + esc(t('device.deleteData', 'Delete data')) + '</button>', function () { deleteSensorData(part); });
  }
  if (!part.keys.length) {
    box.appendChild(h('<div class="ts-tsrc"><span class="ts-empty"></span></div>')).firstChild.textContent = t('device.noReadingYet', 'No reading yet.');
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
  row.querySelector('.ts-mono').textContent = key + (entryOf(key) ? '' : ' · ' + t('device.notInDictionary', 'not in the dictionary'));
  row.querySelector('b').textContent = fmtValue(v.value) + (readingUnit(key) ? ' ' + readingUnit(key) : '');
  row.querySelector('.ts-tsrc-value .ts-row-meta').textContent = t.ago(v.ts);
  var wire = wireLine(key, state.wiring[key] || [], diagnostic ? null : t('common.onNoStation', 'on no station'), wireText(key));
  if (wire) { row.appendChild(wire); }
  return row;
}

function wireText(key) {
  return function (f) { return '→ ' + f.station + (f.channel !== key ? ' · ' + (f.label ? t.label(f.channel, f.label, state.names) + ' (' + f.channel + ')' : f.channel) : ''); };
}

function positionCard(pos, node, srcs) {
  var own = srcs.filter(function (s) { return s.position === pos; }).sort(function (a, b) { return a.sourceKey.localeCompare(b.sourceKey); });
  var bad = own.filter(function (s) { return sourceState(s).state === 'fault' || state.faults[s.sourceKey]; });
  var box = foldable('p' + pos, false);
  box.dataset.position = pos;
  var flags = box.querySelector('.ts-pos-head .ts-grow').appendChild(h('<div class="ts-pos-flags"></div>'));
  box.querySelector('.ts-pos-num').textContent = pos;
  var p = node && state.peripherals[node.type];
  box.querySelector('.ts-pos-name').textContent = pos === 0 ? t('mapping.logrItself', 'LOGR itself') : (p ? p.displayName : node ? node.type : t('mapping.unknownPeripheral', 'Unknown peripheral'));
  box.querySelector('.ts-pos-head .ts-mono').textContent = node ? node.type + (node.version !== undefined && node.version !== null ? ' · v' + node.version : '') : '';
  var dryc = pos !== 0 && !!node && /^dryc/.test(node.type);
  var fields = dryc ? drycFields(pos) : [];
  box.querySelector('.ts-pos-count').textContent = countText(own.length + fields.length);
  if (!node) { flags.appendChild(h('<span class="ts-chip warn"></span>')).textContent = t('device.notInTopology', 'not in the topology report'); }
  else if (!p && pos !== 0) { flags.appendChild(h('<span class="ts-chip warn"></span>')).textContent = t('device.notInCatalog', 'not in the catalog'); }
  if (bad.length) { flags.appendChild(h('<span class="ts-chip fault"></span>')).textContent = t('device.faultingCount', '{n} faulting', { n: bad.length }); }
  var more = unsubscribed(pos, node, own).length;
  if (more) {
    var avail = flags.appendChild(h('<span class="ts-chip" data-available="' + more + '"></span>'));
    avail.title = t('device.availableTip', 'Measurements this peripheral offers that the LOGR does not subscribe, from the catalog');
    avail.textContent = t('device.available', '+{n} available', { n: more });
  }
  if (pos !== 0 && !own.concat(fields).some(function (x) { return state.wiring[x.sourceKey || x]; })) {
    flags.appendChild(h('<span class="ts-chip warn" data-unwired="1"></span>')).textContent = t('device.notWired', 'not wired to any station');
  }
  if (state.writable && more) {
    headButton(box, '<button type="button" class="ts-btn ts-add">' + ICON.plus + esc(t('device.addSubscription', 'Add subscription')) + '</button>', function () { addDrawer(pos, node, own); });
  }
  if (!flags.childNodes.length) { flags.remove(); }
  if (dryc) { drycNote(box); }

  if (!own.length && !fields.length) {
    box.appendChild(h('<div class="ts-tsrc"><span class="ts-empty"></span></div>')).firstChild.textContent = t('device.positionEmpty', 'No subscription and no reading from this position.');
  } else {
    own.forEach(function (s) { box.appendChild(sourceRow(s, node)); });
    fields.forEach(function (key) { box.appendChild(readingRow(key, false)); });
    if (dryc) { box.appendChild(drycRulesRow(pos)); }
  }
  return box;
}

/** A LOGR4 DRYC's inputs, outputs and supply voltage, unpacked from its status (ATTRIBUTES.md §1). */
function drycFields(pos) {
  var prefix = 'p' + pos + '.';
  return Object.keys(state.latest).filter(function (k) {
    return k.indexOf(prefix) === 0 && M.DRYC_FIELD.test(k) && !/(RuleCount|RulesSynced|RulesCrc16)$/.test(k);
  }).sort(function (a, b) { return labelOf(a).localeCompare(labelOf(b)); });
}

/** Where a LOGR4 DRYC's rules stand against the last rules set sent to its position (DRYC.md §5); null when nothing compares. */
function drycSync(pos) {
  function isRules(c) { return c.op === 'PERIPHERAL_OP' && !!c.dryc_rules && (c.target || {}).position === pos; }
  var queued = pending();
  if (queued && queued.commands.some(isRules)) {
    return queued.unanswered ? { cls: 'warn', text: t('dryc.notConfirmed', 'Not confirmed') } : { cls: 'warn', text: t('dryc.waiting', 'Waiting for the device') };
  }
  var last = parseValue(state.server['cmd.lastResult']), sent = null;
  ((last && last.commands) || []).forEach(function (c, i) {
    if (isRules(c)) { sent = { cmd: c, ok: ((last.results || [])[i] || {}).status === 'OK' }; }
  });
  if (sent && !sent.ok) { return { cls: 'fault', text: t('dryc.refused', 'Refused') }; }
  var crc = Number((state.latest['p' + pos + '.drycRulesCrc16'] || {}).value) || 0;
  if (!crc) { return { cls: '', text: t('dryc.noStatus', 'No status yet') }; }
  if (!sent || sent.cmd.rules_crc16 === undefined) { return null; }
  return sent.cmd.rules_crc16 === crc ? { cls: 'ok', text: t('dryc.onDevice', 'On the device') } : { cls: 'warn', text: t('dryc.sendNeeded', 'Send needed') };
}

/** The rule records a LOGR4 DRYC holds, its rules checksum and whether it matches the rules sent. */
function drycRulesRow(pos) {
  var count = state.latest['p' + pos + '.drycRuleCount'], crc = state.latest['p' + pos + '.drycRulesCrc16'];
  var row = h('<div class="ts-tsrc" data-dryc-rules="1"><div class="ts-tsrc-top"><div class="ts-row-label"></div><div class="ts-tsrc-value"><b></b><span class="ts-row-meta"></span></div><span class="ts-tsrc-state"></span></div>' +
    '<div class="ts-tsrc-meta"><span class="ts-mono"></span></div></div>');
  row.querySelector('.ts-row-label').textContent = t('device.drycRecords', 'Rule records');
  row.querySelector('b').textContent = count ? fmtValue(count.value) : '–';
  row.querySelector('.ts-tsrc-value .ts-row-meta').textContent = count ? t.ago(count.ts) : '';
  var crcValue = crc ? Number(crc.value) || 0 : 0;
  row.querySelector('.ts-mono').textContent = 'p' + pos + '.drycRulesCrc16 ' + (crcValue ? '0x' + ('000' + crcValue.toString(16).toUpperCase()).slice(-4) : '–');
  var sync = drycSync(pos);
  if (sync) {
    var chip = row.querySelector('.ts-tsrc-state').appendChild(h('<span class="ts-chip"></span>'));
    if (sync.cls) { chip.classList.add(sync.cls); }
    chip.dataset.drycSync = sync.cls || 'unknown';
    chip.textContent = sync.text;
  }
  return row;
}

/** TC-6 / TC-7: the unit's operational status, each value tagged with where it
 * comes from: the LOGR's own STATUS / SUBSCRIPTIONS reports, or the network
 * server (TRX_NANO_COMPLIANCE.md §3). The cloud computes none of it. */
function statusSection() {
  var c = state.client, lat = state.latest, bus = family() === 'bus';
  var srcs = bus ? sources() : [];
  var sec = h('<div class="ts-section"><div class="ts-section-head">' + esc(t('device.status', 'Status')) + ' ' + info('statusSources') + '</div><div class="ts-stat-grid"></div></div>');
  var grid = sec.querySelector('.ts-stat-grid');
  var hasStatus = c['status.baseIntervalSeconds'] !== undefined;
  var DEVICE = t('device.sourceDevice', 'device'), NETWORK = t('device.sourceNetwork', 'network');
  function card(stat, title, from, lines) {
    var el = h('<div class="ts-stat"><div class="ts-stat-head"><span></span><span class="ts-stat-from"></span></div></div>');
    el.dataset.stat = stat;
    el.querySelector('span').textContent = title;
    el.querySelector('.ts-stat-from').textContent = from;
    lines.forEach(function (l) {
      var line = el.appendChild(h('<div class="ts-stat-line"></div>'));
      [].concat(l).forEach(function (x) { line.appendChild(typeof x === 'string' ? document.createTextNode(x) : x); });
    });
    grid.appendChild(el);
  }
  var subs = srcs.filter(function (x) { return x.enabled === true || x.enabled === 'true'; });
  var intervals = subs.map(function (x) { return Number(x.interval); }).filter(function (n) { return n > 0; });
  var lo = intervals.length ? Math.min.apply(null, intervals) : 0, hi = intervals.length ? Math.max.apply(null, intervals) : 0;
  if (bus) { card('Reporting', t('device.statReporting', 'Reporting'), DEVICE, [
    hasStatus ? t('device.uplinkEvery', 'Uplink every {d}', { d: fmtDuration(c['status.baseIntervalSeconds']) }) : t('device.uplinkUnknown', 'Uplink interval not reported'),
    subs.length
      ? (subs.length === 1 ? t('device.subscriptionOne', '1 subscription') : t('device.subscriptionMany', '{n} subscriptions', { n: subs.length })) +
        (intervals.length ? t('device.subsEvery', ', every {d}', { d: fmtDuration(lo) }) + (hi !== lo ? t('device.subsTo', ' to {d}', { d: fmtDuration(hi) }) : '') : '')
      : t('device.noSubscription', 'No subscription reported')
  ]); }
  var net = [];
  var sf = state.server.spreadingFactor !== undefined ? state.server.spreadingFactor : c.spreadingFactor;
  var link = [];
  if (lat.rssi) { link.push(metric(lat.rssi.value + ' dBm', rssiLevel(lat.rssi.value))); }
  if (lat.snr) { link.push(metric('SNR ' + lat.snr.value + ' dB', snrLevel(lat.snr.value))); }
  if (sf !== undefined) { link.push(metric('SF' + sf, sfLevel(sf))); }
  if (link.length) { net.push(joined(link)); }
  var gws = parseJson(c.gateways || state.server.gateways) || [];
  if (gws.length) {
    net.push([gws.length === 1 ? t('device.gatewayOne', '1 gateway: ') : t('device.gatewayMany', '{n} gateways: ', { n: gws.length })].concat(joined(gws.slice(0, 3).map(function (g) {
      return g.rssi !== undefined && g.rssi !== null ? [g.id + ' ', metric(g.rssi + ' dBm', rssiLevel(g.rssi))] : g.id;
    }), ', ')));
  }
  if (family() !== 'other' || net.length) {
    card('Uplink radio', t('device.statUplink', 'Uplink radio'), NETWORK, net.length ? net : [t('device.nothingFromNetwork', 'Nothing from the network server yet')]);
  }
  if (hasStatus) {
    card('Downlink radio', t('device.statDownlink', 'Downlink radio'), DEVICE, [joined([metric(c['status.dlRssi'] + ' dBm', rssiLevel(c['status.dlRssi'])),
      metric('SNR ' + c['status.dlSnr'] + ' dB', snrLevel(c['status.dlSnr']))])]);
  }
  var unread = hasStatus && powerUnread(c);
  var socUnread = unread || c['status.soc'] === UNKNOWN;
  var soc = c['status.soc'] !== undefined && !socUnread ? c['status.soc'] : (lat['p0.percent'] ? lat['p0.percent'].value : undefined);
  var batt = [];
  var volt = BATTERY_VOLTAGE.map(function (k) { return lat[k]; }).filter(Boolean)[0];
  if (soc !== undefined) { batt.push(t('device.charge', 'Charge {v} %', { v: fmtValue(soc) })); }
  else if (socUnread) { batt.push(t('device.chargeUnread', 'Charge not reported: the power board did not answer')); }
  if (volt) { batt.push(fmtValue(volt.value) + ' V, ' + t.ago(volt.ts)); }
  if (!hasStatus && c['status.charging'] !== undefined) { batt.push(truthyFlag(c['status.charging']) ? t('device.charging', 'Charging') : t('device.notCharging', 'Not charging')); }
  if (!unread && Number(c['status.battRuntimeSeconds']) > 0) { batt.push(t('device.runtime', 'Lasts about {d}, the LOGR’s own estimate', { d: fmtDuration(c['status.battRuntimeSeconds']) })); }
  if (bus || batt.length) { card('Battery', t('common.battery', 'Battery'), DEVICE, batt.length ? batt : [t('device.notReported', 'Not reported')]); }
  if (hasStatus) {
    var present = parseJson(c['status.sourcesPresent']) || [], powerNames = powerSources(), source = c['status.activeSource'];
    // active_source is the charge path: with none the LOGR runs on its battery.
    var powerUnknown = unread || source === UNKNOWN;
    var power = powerUnknown ? [t('device.powerUnread', 'Power inputs not reported: the power board did not answer')]
      : [source === 'none' ? t('device.runningOnBattery', 'Running on battery') : t('device.runningOn', 'Running on {source}', { source: powerNames[source] || source }),
         t('device.connected', 'Connected: {list}', { list: present.length ? present.map(function (x) { return powerNames[x] || x; }).join(', ') : t('common.none', 'none') })];
    if (!powerUnknown && truthyFlag(c['status.charging'])) {
      power.push(Number(c['status.ttfSeconds']) > 0 ? t('device.chargingFullIn', 'Charging, full in {d}', { d: fmtDuration(c['status.ttfSeconds']) }) : t('device.charging', 'Charging'));
    }
    card('Power', t('device.statPower', 'Power'), DEVICE, power);
    var sd = c['status.sdState'];
    card('SD card', t('device.statSd', 'SD card'), DEVICE, [sd === 'ready'
      ? t('device.sdUsed', '{used} % used of {total} GiB', { used: fmtValue(c['status.sdUsedPercent']), total: c['status.sdTotalGib'] })
      : (sdStates()[sd] || String(sd))]);
  }
  var fix = lat['p0.gnssFix'] && parseJson(lat['p0.gnssFix'].value);
  if (bus) {
    card('Location', t('common.location', 'Location'), DEVICE, fix && fix.lat !== undefined
      ? [Number(fix.lat).toFixed(5) + ', ' + Number(fix.lon).toFixed(5) + ' \u00b7 ' + t('device.satellites', '{n} satellites', { n: fix.sats })]
      : [t('device.noFix', 'No GNSS fix reported')]);
  }
  if (hasStatus && c['status.reportedAt'] !== undefined) {
    sec.appendChild(h('<div class="ts-field-hint"></div>')).textContent = t('device.statusReported', 'Last STATUS report {ago}', { ago: t.ago(Number(c['status.reportedAt'])) });
  }
  if (bus && !hasStatus) {
    sec.appendChild(h('<div class="ts-field-hint"></div>')).textContent = state.writable
      ? t('device.noStatusWritable', 'No STATUS report from this LOGR yet: charge, power, SD card and downlink radio appear after its next one (Request reports below asks for it).')
      : t('device.noStatus', 'No STATUS report from this LOGR yet: charge, power, SD card and downlink radio appear after its next one.');
  }
  return grid.childNodes.length ? sec : null;
}

/** Items, each a string, a node or a list of both, flattened with `sep` between them. */
function joined(items, sep) {
  return items.reduce(function (out, x, i) { return out.concat(i ? [sep || ' · '] : [], x); }, []);
}

function truthyFlag(v) { return v === true || v === 'true' || v === 1; }

var UNITS = [{ s: 1, label: 's' }, { s: 60, label: 'min' }, { s: 3600, label: 'h' }];

/** The unit an interval reads best in: the largest that divides it. */
function unitFor(sec) {
  return UNITS.slice().reverse().filter(function (u) { return sec >= u.s && sec % u.s === 0; })[0] || UNITS[0];
}

/** The queued changes that target this source. */
function queuedFor(s) {
  var queued = pending();
  return (queued ? queued.commands : []).filter(function (c) {
    var t = c.target || {};
    return t.mode === 'SOURCE' && t.position === s.position && t.kind === wireKind(s.kind) &&
      (t.group || 0) === s.group && (t.index === undefined || t.index === s.index);
  });
}

function sourceRow(s, node) {
  var st = sourceState(s);
  var row = h('<div class="ts-tsrc"><div class="ts-tsrc-top"><div class="ts-tsrc-name"><div class="ts-row-label"></div><span class="ts-mono"></span></div>' +
    '<div class="ts-tsrc-value"></div><span class="ts-tsrc-state"></span></div><div class="ts-tsrc-meta"></div></div>');
  row.dataset.source = s.sourceKey;
  row.dataset.state = st.state;
  row.querySelector('.ts-row-label').textContent = sourceLabel(s, node);
  row.querySelector('.ts-mono').textContent = s.sourceKey;
  var meta = row.querySelector('.ts-tsrc-meta'), stateEl = row.querySelector('.ts-tsrc-state'), valueEl = row.querySelector('.ts-tsrc-value');
  if (st.state === 'fault') {
    var code = G.STATUS_CODES[st.code];
    stateEl.innerHTML = '<span class="ts-chip fault"></span>';
    stateEl.firstChild.textContent = st.code;
    valueEl.innerHTML = '<span class="ts-tsrc-why"></span><span class="ts-row-meta"></span>';
    valueEl.firstChild.textContent = code || t('device.unknownStatusCode', 'Unknown status code');
    valueEl.lastChild.textContent = t.ago(st.ts);
  } else if (st.state === 'ok') {
    stateEl.innerHTML = '<span class="ts-chip ok">OK</span>';
    valueEl.innerHTML = '<b></b><span class="ts-row-meta"></span>';
    valueEl.firstChild.textContent = fmtValue(st.value) + (unitOf(s) ? ' ' + unitOf(s) : '');
    valueEl.lastChild.textContent = t.ago(st.ts);
  } else if (st.state === 'disabled') {
    stateEl.innerHTML = '<span class="ts-chip">' + esc(t('device.disabledChip', 'Disabled')) + '</span>';
    valueEl.innerHTML = '<span class="ts-row-meta">' + esc(t('device.switchedOff', 'subscription switched off')) + '</span>';
  } else {
    stateEl.innerHTML = '<span class="ts-chip warn">' + esc(t('device.noReading', 'No reading')) + '</span>';
    valueEl.innerHTML = '<span class="ts-row-meta">' + esc(t('device.nothingReceived', 'subscribed, nothing received yet')) + '</span>';
  }
  if (state.faults[s.sourceKey]) {
    stateEl.appendChild(h('<span class="ts-chip fault">' + ICON.bell + '</span>')).title = t('device.faultAlarmTip', 'Active peripheralFault alarm');
  }
  var queued = queuedFor(s);
  if (queued.length) {
    var chip = stateEl.insertBefore(h('<span class="ts-chip warn" data-queued="1"></span>'), stateEl.firstChild);
    chip.textContent = t('device.changeQueued', 'change queued');
    chip.title = t('device.afterNextUplink', '{commands}, after the next uplink', { commands: queued.map(commandText).join(' · ') });
  }
  if (state.writable) { meta.appendChild(subscribed(s) ? sourceControls(s) : subscribeControl(s)); } else { sourceFacts(s, meta); }
  var wire = wireLine(s.sourceKey, state.wiring[s.sourceKey] || [], s.position !== 0 ? t('device.notWired', 'not wired to any station') : null, function (f) {
    return '→ ' + f.station + ' · ' + (f.label ? t.label(f.channel, f.label, state.names) + ' (' + f.channel + ')' : f.channel);
  });
  if (wire) { row.appendChild(wire); }
  return row;
}

/** Read-only: the interval and whether the subscription is on, as the device last reported. */
function sourceFacts(s, meta) {
  if (!subscribed(s)) {
    meta.appendChild(h('<span class="ts-chip" data-subscribed="false"></span>')).textContent = t('device.notSubscribed', 'not subscribed');
  }
  if (s.enabled !== undefined) {
    var on = truthyFlag(s.enabled);
    meta.appendChild(h('<span class="ts-chip' + (on ? ' ok' : '') + '" data-enabled="' + on + '"></span>')).textContent = on ? t('device.enabled', 'enabled') : t('device.disabled', 'disabled');
  }
  if (s.interval) {
    meta.appendChild(h('<span class="ts-tsrc-every" data-interval="' + esc(s.interval) + '"></span>')).textContent = t('device.everyDuration', 'every {d}', { d: fmtDuration(s.interval) });
  }
}

/** Whether the device's SUBSCRIPTIONS report names the source; a source known from its readings alone has none to switch. */
function subscribed(s) { return s.enabled !== undefined || s.interval !== undefined; }

/** For a source the device reports without a subscription: its interval and *Subscribe*. */
function subscribeControl(s) {
  var ctl = h('<div class="ts-src-act"><span class="ts-chip" data-subscribed="false"></span>' +
    '<span class="ts-tsrc-every">' + esc(t('device.every', 'every')) + ' <input class="ts-input num sm ts-src-int" type="number" min="1" step="1" value="900"> s</span>' +
    '<span class="ts-spacer"></span><button type="button" class="ts-btn sm" data-a="subscribe">' + esc(t('device.subscribe', 'Subscribe')) + '</button></div>');
  ctl.querySelector('.ts-chip').textContent = t('device.notSubscribed', 'not subscribed');
  ctl.querySelector('[data-a=subscribe]').addEventListener('click', function () { subscribe(sourceTarget(s), ctl.querySelector('input')); });
  return ctl;
}

/** A switch that enables or disables the subscription, and its interval, each sent as a command. */
function sourceControls(s) {
  var on = !(s.enabled === false || s.enabled === 'false');
  var ctl = h('<div class="ts-src-act"><label class="ts-switch ts-src-toggle"><input type="checkbox"><span></span></label>' +
    '<span class="ts-tsrc-every">' + esc(t('device.every', 'every')) + ' <input class="ts-input num sm ts-src-int" type="number" min="1" step="1">' +
    '<select class="ts-select sm ts-src-unit"></select><button type="button" class="ts-btn primary sm" data-a="interval" hidden>' + esc(t('device.set', 'Set')) + '</button></span>' +
    '<span class="ts-spacer"></span><button type="button" class="ts-icon-btn" data-a="remove" title="' + esc(t('device.removeSubscription', 'Remove this subscription')) + '">' + ICON.close + '</button></div>');
  var toggle = ctl.querySelector('.ts-src-toggle');
  toggle.dataset.enabled = String(on);
  var box = toggle.querySelector('input');
  box.checked = on;
  toggle.querySelector('span').textContent = on ? t('device.enabled', 'enabled') : t('device.disabled', 'disabled');
  box.addEventListener('change', function () {
    send([{ op: 'SET_ENABLED', target: sourceTarget(s), enabled: box.checked }]).then(function (sent) { if (!sent) { box.checked = on; } });
  });
  var every = ctl.querySelector('.ts-tsrc-every'), input = ctl.querySelector('.ts-src-int'), unit = ctl.querySelector('.ts-src-unit');
  var setBtn = ctl.querySelector('[data-a=interval]');
  UNITS.forEach(function (u) { var o = document.createElement('option'); o.value = u.s; o.textContent = u.label; unit.appendChild(o); });
  var current = Number(s.interval) || 0;
  if (current) {
    every.dataset.interval = s.interval;
    var u = unitFor(current);
    unit.value = u.s;
    input.value = current / u.s;
  } else {
    unit.value = 60;
    input.placeholder = '?';
  }
  function seconds() { return Number(input.value) * Number(unit.value); }
  function changed() { setBtn.hidden = !input.value || seconds() === current; }
  input.addEventListener('input', changed);
  unit.addEventListener('change', changed);
  setBtn.addEventListener('click', function () {
    var v = seconds();
    if (!(v >= 1 && v <= 65535 && Math.floor(v) === v)) { ui.toast(t('device.intervalInvalid', 'An interval is a whole number of seconds, 1 to 65535'), 'error'); return; }
    send([{ op: 'SET_INTERVAL', target: sourceTarget(s), interval_s: v }]);
  });
  ctl.querySelector('[data-a=remove]').addEventListener('click', function () {
    send([{ op: 'DELETE_SUBSCRIPTION', target: sourceTarget(s) }]);
  });
  return ctl;
}

// -- load -------------------------------------------------------------------------------

var timer = null;
function refresh() {
  if (!root.isConnected && timer) { clearInterval(timer); return Promise.resolve(); }
  var focus = document.activeElement;
  if (focus && bodyEl.contains(focus) && /^(INPUT|SELECT)$/.test(focus.tagName)) { return Promise.resolve(); }
  refreshBtn.disabled = true;
  return loadDevice(state.device.id.id).then(render).catch(function (err) {
    ui.toast(t('common.refreshFailed', 'Refresh failed: {error}', { error: err && err.message ? err.message : err }), 'error');
  }).then(function () { refreshBtn.disabled = false; });
}
refreshBtn.addEventListener('click', refresh);

tb.boundDatasource().then(function (ds) {
  if (!ds || ds.entityType !== 'DEVICE') { fail(t('device.noDeviceBound', 'No device bound — bind a device in the widget\'s Data tab.')); return; }
  return Promise.all([loadDefaults(), loadDevice(ds.entityId), tb.currentUser()]).then(function (got) {
    state.me = got[2];
    return tb.canWrite(deviceEntity());
  }).then(function (writable) {
    state.writable = writable;
    render();
    timer = setInterval(refresh, REFRESH_MS);
    // Opened from a station's *Connect a device*: the connect panel, that station picked.
    var connectTo = (ctx.stateController.getStateParams() || {}).connectTo;
    if (connectTo && writable) { bindDrawer(null, connectTo); }
  });
}).catch(function (err) { fail(t('common.loadFailed', 'Could not load: {error}', { error: err && err.message ? err.message : err })); });

};
