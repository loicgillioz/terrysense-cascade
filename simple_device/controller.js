/*
 * Simple device — a LOGR2 or any other device that is not a LOGR3 / LOGR4: is it
 * live, what it reports, which station each reading feeds, and the register
 * (DEVICE_VIEW.md §3). Such a device has no bus and no remote configuration: its
 * readings arrive under dictionary names, so binding it to a station is picking
 * the station and the readings, stored under their own names.
 *
 * Binding writes what the channel-map editor writes: the STATION -> DEVICE
 * `Contains` relation, the station's `config.channelMap`, then a resolve. A
 * station keeps one source device (CHANNEL_MAP.md §3), so connecting to a station
 * fed by another device replaces it and keeps the channels this one reports. The
 * relay controller's `drycRule.*` channels belong to the DRYC widget and are kept.
 *
 * Loads after shared/resolver.js, glossary.js, ui.js and tb_io.js.
 */

window.TerrySenseSimpleDevice = function (ctx, container) {

var resolver = window.TerrySenseResolver;
var tb = window.TerrySenseTbIo(ctx);
var root = container.querySelector('.ts-root') || container;
var ui = window.TerrySenseUi(root);
var h = ui.h, esc = ui.esc, ICON = ui.ICON, info = ui.info;

var REFRESH_MS = 60000;
var HOUR_MS = 3600000;
// Device bookkeeping, not readings: radio, uplink markers, the relay controller's own counters.
var NOT_READINGS = ['rssi', 'snr', 'uplinkCause', 'uplinkLatest', 'drycRuleCount', 'drycRulesSynced'];
var RULE_SOURCE = /^drycRule\./;
var REGISTER = [
  { key: 'register.hwVersion', label: 'Hardware version' },
  { key: 'register.hwStatus', label: 'Hardware status' },
  { key: 'register.loraFw', label: 'LoRa module firmware' },
  { key: 'register.dfu', label: 'Firmware update (DFU)', flag: true }
];
var FINE_STATUS = /^(all functional|ok|)$/i;

function parseJson(raw) {
  if (raw === undefined || raw === null || raw === '') { return null; }
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
  if (s < 7200) { return Math.round(s / 60) + ' min'; }
  if (s < 172800) { return Math.round(s / 3600) + ' h'; }
  return Math.round(s / 86400) + ' days';
}
function fmtValue(v) {
  if (v === true || v === 'true') { return 'on'; }
  if (v === false || v === 'false') { return 'off'; }
  var n = Number(v);
  return v === '' || v === null || isNaN(n) ? String(v) : String(Math.round(n * 1000) / 1000);
}
function truthyFlag(v) { return v === true || v === 'true' || v === 1; }
function errText(err) { return (err && (err.message || (err.error && err.error.message))) || String(err); }

// -- data -------------------------------------------------------------------------------

var state = {
  device: null, server: {}, latest: {}, names: {}, kinds: {},
  bindings: [], writable: false, loadedAt: 0
};

function deviceEntity() {
  return { entityType: 'DEVICE', id: state.device.id.id, ownerId: state.device.ownerId && state.device.ownerId.id };
}
function isLogr2() { return state.device.type === 'logr2'; }

function loadDefaults() {
  return tb.io.fetchDefaults().then(function (d) { return d ? tb.attrsMap(d) : {}; }).then(function (a) {
    state.names = parseJson(a['config.channelNames']) || {};
    state.kinds = parseJson(a['config.kinds']) || {};
  });
}

function loadDevice(id) {
  var dev = { entityType: 'DEVICE', id: id };
  return Promise.all([
    tb.get('/api/device/' + id),
    tb.attrsMap(dev, 'SERVER_SCOPE'),
    tb.get('/api/plugins/telemetry/DEVICE/' + id + '/keys/timeseries').catch(function () { return []; })
  ]).then(function (got) {
    state.device = got[0];
    state.server = got[1];
    var keys = (got[2] || []).filter(function (k) { return !/\.status$/.test(k); });
    return keys.length ? tb.get('/api/plugins/telemetry/DEVICE/' + id + '/values/timeseries', { keys: keys.join(',') }) : {};
  }).then(function (latest) {
    state.latest = {};
    Object.keys(latest || {}).forEach(function (k) {
      var p = latest[k] && latest[k][0];
      if (p) { state.latest[k] = { ts: Number(p.ts), value: p.value }; }
    });
    return loadBindings(id);
  }).then(function () { state.loadedAt = Date.now(); });
}

/** The stations that contain this device, each with its channel map and whether the user may write it. */
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
        return { station: station, map: parseJson(got[0]['config.channelMap']) || {}, writable: got[1] };
      });
    }));
  }).then(function (list) { state.bindings = list; });
}

// -- model ------------------------------------------------------------------------------

function readings() {
  return Object.keys(state.latest).filter(function (k) {
    return NOT_READINGS.indexOf(k) < 0 && !RULE_SOURCE.test(k);
  }).sort(function (a, b) { return labelOf(a).localeCompare(labelOf(b)); });
}

function entryOf(key) { return state.names[resolver.splitChannelKey(key).name] || null; }
function labelOf(key) { var e = entryOf(key); return (e && e.label) || key; }
function unitOf(key) {
  var e = entryOf(key);
  return e ? ((resolver.kindSpec(resolver.camelKind(e.kind), state.kinds) || {}).cloudUnit || '') : '';
}

/** The station channels a reading feeds: `[{station, channel}]`. */
function feeds(key) {
  var out = [];
  state.bindings.forEach(function (b) {
    var channels = b.map.channels || {};
    Object.keys(channels).forEach(function (c) { if (channels[c] === key) { out.push({ station: b.station.name, channel: c }); } });
  });
  return out;
}

// -- skeleton ---------------------------------------------------------------------------

root.innerHTML = '';
var cardEl = h('<div class="ts-card ts-readonly"><div class="ts-head"><div class="ts-head-icon">' + ICON.gauge + '</div><div class="ts-head-text">' +
  '<div class="ts-title"><span>Device</span></div><div class="ts-subtitle"></div></div><span class="ts-chip level" hidden></span></div>' +
  '<div class="ts-body"><div class="ts-loading">Loading…</div></div>' +
  '<div class="ts-foot"><span class="ts-summary"></span><span class="ts-spacer"></span><button type="button" class="ts-btn">' + ICON.reset + 'Refresh</button></div></div>');
root.appendChild(cardEl);
var bodyEl = cardEl.querySelector('.ts-body');
var summaryEl = cardEl.querySelector('.ts-summary');
var refreshBtn = cardEl.querySelector('.ts-foot .ts-btn');

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
  var active = truthyFlag(state.server.active);

  bodyEl.innerHTML = '';
  var banner = h('<div class="ts-banner ' + (active ? 'ok' : 'warn') + '">' + (active ? ICON.check : ICON.info) + '<span></span></div>');
  banner.querySelector('span').textContent = active ? 'Live.' : 'Not active: no uplink within the inactivity timeout.';
  bodyEl.appendChild(banner);

  function kv(label, tip, valueHtml) {
    var row = h('<div class="ts-kv"><div class="ts-kv-label">' + esc(label) + (tip ? ' ' + info(tip) : '') + '</div><div class="ts-kv-value"></div></div>');
    row.querySelector('.ts-kv-value').innerHTML = valueHtml;
    bodyEl.appendChild(row);
  }
  kv('Uplink', 'uplink', '<span class="ts-status"><span class="ts-dot" style="background:' + (active ? 'var(--ts-ok)' : 'var(--ts-danger)') + '"></span>' +
    esc((active ? 'Active, last ' : 'Inactive, last ') + ago(state.server.lastActivityTime)) + '</span>');
  if (state.latest.rssi) {
    kv('Radio', null, '<span class="ts-mono">' + esc(state.latest.rssi.value + ' dBm, SNR ' + (state.latest.snr ? state.latest.snr.value : '?') + ' dB') + '</span>');
  }

  bodyEl.appendChild(registerSection());
  bodyEl.appendChild(stationsSection());
  bodyEl.appendChild(readingsSection());
  cardEl.classList.toggle('ts-readonly', !state.writable);
  summaryEl.textContent = 'Read ' + new Date(state.loadedAt).toLocaleTimeString();
}

function readingsSection() {
  var sec = h('<div class="ts-section" data-section="readings"><div class="ts-section-head">Readings</div></div>');
  var keys = readings();
  if (!keys.length) { sec.appendChild(h('<div class="ts-empty">Nothing received from this device yet.</div>')); }
  keys.forEach(function (key) {
    var v = state.latest[key];
    var row = h('<div class="ts-tsrc"><div><div class="ts-row-label"></div><div class="ts-mono"></div></div><span></span>' +
      '<div class="ts-tsrc-value"><b></b><span class="ts-row-meta"></span></div></div>');
    row.dataset.reading = key;
    row.querySelector('.ts-row-label').textContent = labelOf(key);
    row.querySelector('.ts-mono').textContent = key + (entryOf(key) ? '' : ' · not in the dictionary');
    var f = feeds(key);
    var wire = h('<div class="ts-wire"></div>');
    wire.dataset.wired = f.length ? '1' : '0';
    wire.textContent = f.length
      ? f.map(function (x) { return '→ ' + x.station + (x.channel !== key ? ' · ' + x.channel : ''); }).join('   ')
      : 'on no station';
    row.firstChild.appendChild(wire);
    row.querySelector('b').textContent = fmtValue(v.value) + (unitOf(key) ? ' ' + unitOf(key) : '');
    row.querySelector('.ts-row-meta').textContent = ago(v.ts);
    sec.appendChild(row);
  });
  return sec;
}

function stationsSection() {
  var sec = h('<div class="ts-section" data-section="stations"><div class="ts-section-head">Stations ' + info('wiring') + '<span class="ts-spacer"></span></div></div>');
  if (state.writable) {
    var add = h('<button type="button" class="ts-btn ts-reg-edit" data-a="connect">' + ICON.plus + 'Connect to a station</button>');
    add.addEventListener('click', function () { bindDrawer(null); });
    sec.firstChild.appendChild(add);
  }
  if (!state.bindings.length) { sec.appendChild(h('<div class="ts-empty">On no station: its readings are stored on the device only.</div>')); }
  state.bindings.forEach(function (b) {
    var own = Object.keys(b.map.channels || {});
    var row = h('<div class="ts-bind"><div class="ts-grow"><div class="ts-row-label"></div><div class="ts-row-meta"></div></div><div class="ts-rule-acts"></div></div>');
    row.dataset.station = b.station.name;
    row.querySelector('.ts-row-label').textContent = b.station.name;
    row.querySelector('.ts-row-meta').textContent = own.length + (own.length === 1 ? ' channel' : ' channels');
    if (state.writable && b.writable) {
      var acts = row.querySelector('.ts-rule-acts');
      var edit = h('<button type="button" class="ts-icon-btn" data-a="edit" title="Choose the readings">' + ICON.edit + '</button>');
      edit.addEventListener('click', function () { bindDrawer(b); });
      var off = h('<button type="button" class="ts-icon-btn" data-a="disconnect" title="Disconnect">' + ICON.close + '</button>');
      off.addEventListener('click', function () { disconnect(b); });
      acts.appendChild(edit);
      acts.appendChild(off);
    }
    sec.appendChild(row);
  });
  return sec;
}

// -- binding ------------------------------------------------------------------------------

function stationsToPick() {
  var owner = state.device.ownerId;
  var customer = owner && owner.entityType === 'CUSTOMER' ? { id: owner.id } : null;
  var list = customer ? tb.io.fetchCustomerStations(customer) : tb.io.fetchAllStations();
  return Promise.resolve(list);
}

function relate(stationId) {
  return tb.post('/api/relation', {
    from: { id: stationId, entityType: 'ASSET' }, to: { id: state.device.id.id, entityType: 'DEVICE' }, type: 'Contains', typeGroup: 'COMMON'
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

/** Pick a station (new binding) or the readings of an existing one, then save. */
function bindDrawer(binding) {
  var dr = ui.openDrawer(binding ? esc(binding.station.name) : 'Connect to a station', esc(state.device.label || state.device.name));
  var picked = binding ? binding.station : null;
  var pickedMap = binding ? binding.map : null;
  var keys = readings();
  var body = dr.body;

  var stationField = h('<div class="ts-field"><div class="ts-field-label"><span>Station</span></div><div class="ts-ctl"></div><div class="ts-field-hint" data-f="hint"></div></div>');
  var hint = stationField.querySelector('[data-f=hint]');
  if (binding) {
    stationField.querySelector('.ts-ctl').appendChild(h('<b></b>')).textContent = binding.station.name;
  } else {
    var sel = h('<select class="ts-select wide" data-f="station"><option value="">Pick a station</option></select>');
    stationField.querySelector('.ts-ctl').appendChild(sel);
    stationsToPick().then(function (list) {
      var bound = {};
      state.bindings.forEach(function (b) { bound[b.station.id] = true; });
      list.filter(function (s) { return !bound[s.id]; }).sort(function (a, b) { return a.name.localeCompare(b.name); }).forEach(function (s) {
        var o = document.createElement('option'); o.value = s.id; o.textContent = s.name; o.dataset.name = s.name; sel.appendChild(o);
      });
    });
    sel.addEventListener('change', function () {
      picked = sel.value ? { entityType: 'ASSET', id: sel.value, name: sel.selectedOptions[0].dataset.name, kind: 'Station' } : null;
      pickedMap = null;
      hint.textContent = '';
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

  var list = h('<div class="ts-field"><div class="ts-field-label"><span>Readings stored on the station</span></div><div class="ts-binds"></div>' +
    '<div class="ts-field-hint">Each reading keeps its own name on the station.</div></div>');
  var boxes = list.querySelector('.ts-binds');
  keys.forEach(function (key) {
    var row = h('<label class="ts-switch"><input type="checkbox"> <span></span></label>');
    row.querySelector('input').dataset.key = key;
    row.querySelector('span').textContent = labelOf(key) + (labelOf(key) !== key ? ' (' + key + ')' : '');
    boxes.appendChild(row);
  });
  if (!keys.length) { boxes.appendChild(h('<div class="ts-empty">Nothing received from this device yet.</div>')); }
  body.appendChild(list);

  /** Tick what the station already takes from this device, else every non-diagnostic reading. */
  function tick(map) {
    var mine = map && (!map.sourceDeviceId || map.sourceDeviceId === state.device.id.id) ? map.channels || {} : null;
    boxes.querySelectorAll('input').forEach(function (b) {
      var key = b.dataset.key;
      b.checked = mine && Object.keys(mine).length
        ? Object.keys(mine).some(function (c) { return mine[c] === key; })
        : !(entryOf(key) || {}).diagnostic;
    });
  }
  tick(pickedMap);

  ui.drawerActions(dr, 'Save').addEventListener('click', function () {
    if (!picked) { ui.toast('Pick a station', 'error'); return; }
    var chosen = [];
    boxes.querySelectorAll('input').forEach(function (b) { if (b.checked) { chosen.push(b.dataset.key); } });
    if (!chosen.length) { ui.toast('Pick at least one reading', 'error'); return; }
    save(picked, pickedMap || {}, chosen);
  });
}

function save(station, map, chosen) {
  var old = map.channels || {};
  var replacing = map.sourceDeviceId && map.sourceDeviceId !== state.device.id.id;
  var channels = {};
  // The relay controller's rule channels stay with the station's device.
  if (!replacing) { Object.keys(old).forEach(function (c) { if (RULE_SOURCE.test(old[c])) { channels[c] = old[c]; } }); }
  chosen.forEach(function (key) {
    var kept = Object.keys(old).filter(function (c) { return old[c] === key; })[0];
    channels[kept || key] = key;
  });
  var text = replacing
    ? 'Replace the device of <b>' + esc(station.name) + '</b> with <b>' + esc(state.device.label || state.device.name) + '</b>? The history stays on the station.'
    : 'Store ' + chosen.length + ' reading' + (chosen.length === 1 ? '' : 's') + ' on <b>' + esc(station.name) + '</b>?';
  ui.confirm(text, 'Save').then(function (ok) {
    if (!ok) { return; }
    return stationDevices(station.id).then(function (current) {
      var others = current.filter(function (id) { return id !== state.device.id.id; });
      return Promise.all(others.map(function (id) { return unrelate(station.id, id); })).then(function () {
        return current.indexOf(state.device.id.id) < 0 ? relate(station.id) : null;
      });
    }).then(function () {
      return tb.saveAttrs(station, { 'config.channelMap': { sourceDeviceId: state.device.id.id, channels: channels } });
    }).then(function () {
      return tb.resolveStations([station]);
    }).then(function () {
      ui.toast(replacing ? 'Device replaced' : 'Saved');
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

// -- register -------------------------------------------------------------------------------

/** Hand-kept facts the device cannot report (ATTRIBUTES.md §3): the four
 * `register.*` fields of a LOGR2, and the inactivity timeout of any device. */
function registerFields() { return isLogr2() ? REGISTER : []; }

function registerSection() {
  var s = state.server;
  var sec = h('<div class="ts-section" data-section="register"><div class="ts-section-head">Register ' + info('register') +
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
  var dr = ui.openDrawer('Register', esc(state.device.name));
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
      ui.toast('Register saved');
      ui.closeDrawer();
      return refresh();
    }).catch(function (err) { ui.toast('Not saved: ' + errText(err), 'error'); });
  });
}

// -- load -------------------------------------------------------------------------------

var timer = null;
function refresh() {
  if (!root.isConnected && timer) { clearInterval(timer); return Promise.resolve(); }
  refreshBtn.disabled = true;
  return loadDevice(state.device.id.id).then(render).catch(function (err) {
    ui.toast('Refresh failed: ' + errText(err), 'error');
  }).then(function () { refreshBtn.disabled = false; });
}
refreshBtn.addEventListener('click', refresh);

tb.boundDatasource().then(function (ds) {
  if (!ds || ds.entityType !== 'DEVICE') { fail('No device bound — bind a device in the widget\'s Data tab.'); return; }
  return Promise.all([loadDefaults(), loadDevice(ds.entityId)]).then(function () {
    if (tb.isComplexDevice(state.device.type)) {
      if (!tb.openDeviceView(state.device)) { fail('A ' + state.device.type.toUpperCase() + ' opens in the Device view.'); }
      return;
    }
    return tb.canWrite(deviceEntity()).then(function (writable) {
      state.writable = writable;
      render();
      timer = setInterval(refresh, REFRESH_MS);
    });
  });
}).catch(function (err) { fail('Could not load: ' + errText(err)); });

};
