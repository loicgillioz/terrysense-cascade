/*
 * Fleet — every device at a glance: is it live, where does it feed, what is
 * it, what is wrong with it (TC-3, TC-12). The Devices dashboard's landing view
 * and the tenant's home page. Read-only; a row opens the device view.
 *
 * One entity query brings every device of the configured profiles with its
 * activity, versions and register (ATTRIBUTES.md §3); one alarm query counts
 * the active alarms per device; the `Contains` relations name the stations a
 * device feeds. A LOGR3 or LOGR4 reports its versions (`deviceInfo.*`) and its
 * hardware state (`status.healthFaults`) and always takes a firmware update; any
 * other device shows the hand-kept `register.*`. A column header sorts by that column; an empty
 * cell (a device never heard from, on no station) sorts last either way.
 * Widget: logr-product-docs/cloud/DEVICE_VIEW.md §1.
 *
 * Loads after shared/resolver.js, glossary.js, ui.js and tb_io.js.
 */

window.TerrySenseDeviceFleet = function (ctx, container) {

var G = window.TerrySenseGlossary;
var tb = window.TerrySenseTbIo(ctx);
var root = container.querySelector('.ts-root') || container;
var ui = window.TerrySenseUi(root);
var h = ui.h, esc = ui.esc, ICON = ui.ICON;

var GROUPS = [
  { id: 'logr', label: 'LOGR', profiles: ['logr2', 'logr3', 'logr4'] },
  { id: 'other', label: 'Other devices', profiles: ['gsaa', 'gsaa2', 'whtr', 'zc-tilt', 'default'] }
];
var REPORTING = ['logr3', 'logr4'];
var ATTRS = ['active', 'lastActivityTime', 'inactivityTimeout', 'deviceInfo.hwVersion', 'deviceInfo.fwVersion',
  'status.healthFaults', 'register.hwVersion', 'register.hwStatus', 'register.loraFw', 'register.dfu'];
var FINE_STATUS = /^(all functional|ok|)$/i;
var REFRESH_MS = 60000;
var PAGE = 1000;

function ago(ts) {
  if (!ts) { return 'never'; }
  var s = Math.max(0, (Date.now() - Number(ts)) / 1000);
  if (s < 90) { return 'just now'; }
  if (s < 5400) { return Math.round(s / 60) + ' min ago'; }
  if (s < 129600) { return Math.round(s / 3600) + ' h ago'; }
  return Math.round(s / 86400) + ' days ago';
}

function fmtTime(ts) { return ts ? new Date(Number(ts)).toLocaleString() : 'never'; }
function flag(v) { return v === true || v === 'true'; }

// -- data -------------------------------------------------------------------------------

var state = { devices: [], group: 'logr', filter: 'all', search: '', sort: 'uplink', dir: -1, loadedAt: 0 };

function queryDevices() {
  var profiles = [];
  GROUPS.forEach(function (g) { profiles = profiles.concat(g.profiles); });
  return tb.post('/api/entitiesQuery/find', {
    entityFilter: { type: 'deviceType', deviceTypes: profiles, deviceNameFilter: '' },
    entityFields: ['name', 'label', 'type', 'ownerName'].map(function (k) { return { type: 'ENTITY_FIELD', key: k }; }),
    latestValues: ATTRS.map(function (k) { return { type: 'ATTRIBUTE', key: k }; }),
    pageLink: { page: 0, pageSize: PAGE, sortOrder: { key: { type: 'ENTITY_FIELD', key: 'name' }, direction: 'ASC' } }
  }).then(function (page) {
    return ((page && page.data) || []).map(function (e) {
      var f = (e.latest && e.latest.ENTITY_FIELD) || {}, a = (e.latest && e.latest.ATTRIBUTE) || {};
      function v(map, k) { var x = map[k]; return x && x.value !== '' && x.value !== null ? x.value : undefined; }
      var attrs = {};
      ATTRS.forEach(function (k) { attrs[k] = v(a, k); });
      return {
        id: e.entityId.id, name: v(f, 'name'), label: v(f, 'label'), type: v(f, 'type'), owner: v(f, 'ownerName'),
        attrs: attrs, stations: [], alarms: []
      };
    });
  });
}

function loadAlarms(byId) {
  return tb.get('/api/v2/alarms', { statusList: 'ACTIVE', pageSize: String(PAGE), page: '0' }).then(function (page) {
    ((page && page.data) || []).forEach(function (a) {
      var d = a.originator && byId[a.originator.id];
      if (d) { d.alarms.push(a); }
    });
  }).catch(function () {});
}

function loadStations(devices) {
  return Promise.all(devices.map(function (d) {
    return tb.get('/api/relations/info', { toId: d.id, toType: 'DEVICE' }).then(function (rels) {
      d.stations = (rels || []).filter(function (r) { return r.type === 'Contains' && r.from.entityType === 'ASSET'; })
        .map(function (r) { return r.fromName; }).sort();
    }).catch(function () {});
  }));
}

/** Devices and alarms first; the stations, one relation lookup per device,
 * fill in on a second render. */
function load() {
  return queryDevices().then(function (devices) {
    var byId = {};
    devices.forEach(function (d) { byId[d.id] = d; });
    return loadAlarms(byId).then(function () {
      devices.forEach(function (d) {
        var old = state.devices.filter(function (x) { return x.id === d.id; })[0];
        d.stations = old ? old.stations : null;
      });
      if (!state.loadedAt) {
        // A customer may own no LOGR: open on the first group that has a device.
        var first = GROUPS.filter(function (g) { return devices.some(function (d) { return groupOf(d).id === g.id; }); })[0];
        if (first) { state.group = first.id; }
      }
      state.devices = devices;
      state.loadedAt = Date.now();
      render();
      return loadStations(devices);
    });
  });
}

// -- model ------------------------------------------------------------------------------

function groupOf(d) { return GROUPS.filter(function (g) { return g.profiles.indexOf(d.type) >= 0; })[0] || GROUPS[1]; }
function lastTs(d) { return Number(d.attrs.lastActivityTime) || 0; }

/** live | inactive | never */
function liveness(d) {
  if (!lastTs(d)) { return 'never'; }
  return flag(d.attrs.active) ? 'live' : 'inactive';
}

function worstAlarm(d) {
  return d.alarms.map(function (a) { return a.severity; })
    .sort(function (a, b) { return G.rank(b.toLowerCase()) - G.rank(a.toLowerCase()); })[0] || null;
}

function reports(d) { return REPORTING.indexOf(d.type) >= 0; }

function version(d, reported, register) {
  if (d.attrs[reported]) { return { value: d.attrs[reported], from: 'reported' }; }
  if (register && !reports(d) && d.attrs[register]) { return { value: d.attrs[register], from: 'register' }; }
  return null;
}

function healthFaults(d) {
  try { var f = JSON.parse(d.attrs['status.healthFaults'] || '[]'); return Array.isArray(f) ? f : []; } catch (e) { return []; }
}
function hwStatus(d) { return reports(d) ? healthFaults(d).join(', ') : String(d.attrs['register.hwStatus'] || ''); }
function hwStatusBad(d) { return !FINE_STATUS.test(hwStatus(d)); }
function dfuImpossible(d) { return !reports(d) && d.attrs['register.dfu'] !== undefined && !flag(d.attrs['register.dfu']); }

/** Columns of each list: header, default direction, and the value it sorts by (null sorts last). */
var COLUMNS = {
  device: { label: 'Device', dir: 1, value: function (d) { return String(d.name || '').toLowerCase(); } },
  uplink: { label: 'Last uplink', dir: -1, value: function (d) { return lastTs(d) || null; } },
  stations: { label: 'Stations', dir: 1, value: function (d) { return d.stations && d.stations.length ? d.stations[0].toLowerCase() : null; } },
  versions: { label: 'Versions', dir: 1, value: function (d) { var v = version(d, 'deviceInfo.hwVersion', 'register.hwVersion'); return v ? String(v.value) : null; } },
  hardware: { label: 'Hardware', dir: -1, value: function (d) { return (hwStatusBad(d) ? 2 : 0) + (dfuImpossible(d) ? 1 : 0) || null; } },
  type: { label: 'Type', dir: 1, value: function (d) { return d.type || null; } },
  alarms: { label: 'Alarms', dir: -1, value: function (d) { var w = worstAlarm(d); return w ? G.rank(w.toLowerCase()) * 1000 + d.alarms.length : null; } }
};
function columnsOf(logr) {
  return ['device', 'uplink', 'stations'].concat(logr ? ['versions', 'hardware'] : ['type'], ['alarms']);
}

function needsLook(d) {
  return liveness(d) !== 'live' || d.alarms.length > 0 || hwStatusBad(d);
}

function visible() {
  var q = state.search.trim().toLowerCase();
  var list = state.devices.filter(function (d) {
    if (groupOf(d).id !== state.group) { return false; }
    if (state.filter === 'attention' && !needsLook(d)) { return false; }
    if (!q) { return true; }
    return [d.name, d.label, d.owner, d.type, hwStatus(d)].concat(d.stations || [])
      .some(function (x) { return x && String(x).toLowerCase().indexOf(q) >= 0; });
  });
  var value = COLUMNS[state.sort].value;
  return list.sort(function (a, b) {
    var va = value(a), vb = value(b);
    if ((va === null) !== (vb === null)) { return va === null ? 1 : -1; }
    var c = va === null ? 0 : (va < vb ? -1 : va > vb ? 1 : 0) * state.dir;
    return c || String(a.name).localeCompare(String(b.name));
  });
}

// -- scaffold ---------------------------------------------------------------------------

var cardEl = h(
  '<div class="ts-card ts-fleet">' +
  '  <div class="ts-head"><div class="ts-head-icon">' + ICON.gauge + '</div>' +
  '    <div class="ts-head-text"><div class="ts-title">Fleet</div><div class="ts-subtitle"></div></div></div>' +
  '  <div class="ts-fleet-bar">' +
  '    <div class="ts-seg" data-bar="group"></div>' +
  '    <div class="ts-seg" data-bar="filter"><button type="button" data-v="all">All</button><button type="button" data-v="attention">Needs a look</button></div>' +
  '    <label class="ts-fleet-search">' + ICON.search + '<input type="search" placeholder="Name, label, owner, station"></label>' +
  '  </div>' +
  '  <div class="ts-body"><div class="ts-loading">Loading…</div></div>' +
  '  <div class="ts-foot"><span class="ts-row-meta ts-fleet-updated"></span><span class="ts-spacer"></span>' +
  '    <button type="button" class="ts-btn">' + ICON.reset + 'Refresh</button></div>' +
  '</div>');
root.appendChild(cardEl);
var bodyEl = cardEl.querySelector('.ts-body');
var refreshBtn = cardEl.querySelector('.ts-foot .ts-btn');
var groupBar = cardEl.querySelector('[data-bar=group]');
GROUPS.forEach(function (g) { groupBar.appendChild(h('<button type="button" data-v="' + g.id + '"></button>')).textContent = g.label; });

cardEl.querySelector('.ts-fleet-bar').addEventListener('click', function (e) {
  var b = e.target.closest('[data-v]');
  if (!b) { return; }
  state[b.parentNode.getAttribute('data-bar')] = b.getAttribute('data-v');
  render();
});
cardEl.querySelector('.ts-fleet-search input').addEventListener('input', function (e) { state.search = e.target.value; render(); });

function fail(text) {
  bodyEl.innerHTML = '';
  bodyEl.appendChild(h('<div class="ts-empty"></div>')).textContent = text;
}

function openDevice(d) {
  var sc = ctx.stateController;
  if (sc) { sc.openState('device', { entityId: { entityType: 'DEVICE', id: d.id }, entityName: d.name }, false); }
}

// -- render -----------------------------------------------------------------------------

function render() {
  cardEl.querySelectorAll('.ts-seg button').forEach(function (b) {
    b.classList.toggle('on', state[b.parentNode.getAttribute('data-bar')] === b.getAttribute('data-v'));
  });
  var inGroup = state.devices.filter(function (d) { return groupOf(d).id === state.group; });
  var counts = { live: 0, inactive: 0, never: 0 };
  inGroup.forEach(function (d) { counts[liveness(d)]++; });
  var alarmed = inGroup.filter(function (d) { return d.alarms.length; }).length;
  cardEl.querySelector('.ts-subtitle').textContent = inGroup.length + ' devices · ' + counts.live + ' live · ' +
    counts.inactive + ' inactive' + (counts.never ? ' · ' + counts.never + ' never heard from' : '') +
    (alarmed ? ' · ' + alarmed + ' with alarms' : '');
  cardEl.querySelector('.ts-fleet-updated').textContent = 'Read ' + new Date(state.loadedAt).toLocaleTimeString();

  var list = visible();
  bodyEl.innerHTML = '';
  if (!list.length) { fail(state.search || state.filter !== 'all' ? 'No device matches.' : 'No device here yet.'); return; }
  var logr = state.group === 'logr';
  if (columnsOf(logr).indexOf(state.sort) < 0) { state.sort = 'uplink'; state.dir = -1; return render(); }
  var table = h('<div class="ts-fleet-list' + (logr ? ' logr' : '') + '"><div class="ts-fleet-row ts-fleet-headrow"></div></div>');
  var head = table.firstChild;
  columnsOf(logr).forEach(function (id) {
    var on = state.sort === id;
    var b = head.appendChild(h('<button type="button" class="ts-fleet-sorter" data-sort="' + id + '"></button>'));
    b.textContent = COLUMNS[id].label + (on ? (state.dir > 0 ? ' ▲' : ' ▼') : '');
    if (on) { b.classList.add('on'); }
    b.addEventListener('click', function () {
      if (on) { state.dir = -state.dir; } else { state.sort = id; state.dir = COLUMNS[id].dir; }
      render();
    });
  });
  list.forEach(function (d) { table.appendChild(row(d, logr)); });
  bodyEl.appendChild(table);
}

function row(d, logr) {
  var live = liveness(d);
  var el = h('<div class="ts-fleet-row" tabindex="0" role="button">' +
    '<span class="ts-fleet-dev"><span class="ts-dot"></span><span class="ts-fleet-names"><b></b><small></small></span></span>' +
    '<span class="ts-fleet-up"></span><span class="ts-fleet-st"></span>' +
    (logr ? '<span class="ts-fleet-ver"></span><span class="ts-fleet-hw"></span>' : '<span class="ts-fleet-type"></span>') +
    '<span class="ts-fleet-al"></span></div>');
  el.setAttribute('data-device', d.name);
  el.setAttribute('data-live', live);
  el.querySelector('.ts-dot').style.background = live === 'live' ? 'var(--ts-ok)' : live === 'inactive' ? 'var(--ts-danger)' : 'var(--ts-text-3)';
  el.querySelector('b').textContent = d.name;
  el.querySelector('small').textContent = [d.label, d.owner].filter(Boolean).join(' · ');
  var up = el.querySelector('.ts-fleet-up');
  up.textContent = ago(lastTs(d));
  up.title = fmtTime(lastTs(d)) + (Number(d.attrs.inactivityTimeout) > 0
    ? ' · inactive after ' + Math.round(Number(d.attrs.inactivityTimeout) / 360000) / 10 + ' h' : '');
  if (live === 'inactive') { up.classList.add('bad'); }
  var st = el.querySelector('.ts-fleet-st');
  if (!d.stations) {
    st.appendChild(h('<span class="ts-row-meta">…</span>'));
  } else if (d.stations.length) {
    d.stations.forEach(function (s) { st.appendChild(h('<span class="ts-chip"></span>')).textContent = s; });
  } else {
    st.appendChild(h('<span class="ts-chip warn">on no station</span>'));
  }
  if (logr) {
    var hw = version(d, 'deviceInfo.hwVersion', 'register.hwVersion'), fw = version(d, 'deviceInfo.fwVersion', null);
    var ver = el.querySelector('.ts-fleet-ver');
    ver.innerHTML = [hw ? 'hw ' + esc(hw.value) + (hw.from === 'register' ? ' <i title="Kept by hand">reg</i>' : '') : '',
      fw ? 'fw ' + esc(fw.value) : '', !reports(d) && d.attrs['register.loraFw'] ? 'LoRa ' + esc(d.attrs['register.loraFw']) : '']
      .filter(Boolean).join('<br>');
    var hwEl = el.querySelector('.ts-fleet-hw');
    // Only the exceptions: a status other than fine, and no firmware update possible.
    if (hwStatusBad(d)) { hwEl.appendChild(h('<span class="ts-chip warn"></span>')).textContent = hwStatus(d); }
    if (dfuImpossible(d)) { hwEl.appendChild(h('<span class="ts-chip warn" title="This unit cannot take a firmware update">DFU impossible</span>')); }
  } else {
    el.querySelector('.ts-fleet-type').textContent = d.type;
  }
  var al = el.querySelector('.ts-fleet-al');
  var worst = worstAlarm(d);
  if (worst) {
    var chip = al.appendChild(h('<span class="ts-chip ts-fleet-sev"></span>'));
    chip.style.setProperty('--sev', 'var(--sev-' + worst.toLowerCase() + ')');
    chip.textContent = d.alarms.length + ' · ' + G.severity(worst.toLowerCase()).label;
    chip.title = d.alarms.map(function (a) { return a.type; }).join(', ');
  }
  el.addEventListener('click', function () { openDevice(d); });
  el.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { openDevice(d); } });
  return el;
}

// -- load -------------------------------------------------------------------------------

var timer = null;
function refresh() {
  if (!root.isConnected && timer) { clearInterval(timer); return Promise.resolve(); }
  refreshBtn.disabled = true;
  return load().then(render).catch(function (err) {
    ui.toast('Refresh failed: ' + (err && err.message ? err.message : err), 'error');
  }).then(function () { refreshBtn.disabled = false; });
}
refreshBtn.addEventListener('click', refresh);

load().then(function () {
  render();
  timer = setInterval(refresh, REFRESH_MS);
}).catch(function (err) { fail('Could not load: ' + (err && err.message ? err.message : err)); });

};
