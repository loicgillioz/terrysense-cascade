/*
 * Fleet — every device at a glance: is it live, where does it feed, what is
 * it, what is wrong with it (TC-3, TC-12). The Devices dashboard's landing view
 * and the tenant's home page. A row opens a pane summing the device up; its
 * actions, for a user who may write the device, put it out of service (CA-23),
 * and under *Tenant only* reassign it to another owner (TA-6). A device out of
 * service leaves *Needs a look* for its own *Out of service* filter.
 *
 * One entity query brings every device of the configured profiles with its
 * activity, versions and register (ATTRIBUTES.md §3); one alarm query counts
 * the active alarms per device; the `Contains` relations name the stations a
 * device feeds. A LOGR3 or LOGR4 reports its versions (`deviceInfo.*`) and its
 * hardware state (`status.healthFaults`) and always takes a firmware update; any
 * other device shows the hand-kept `register.*`. A tenant admin also sees each device's customer,
 * none for a device the tenant owns. Each LOGR shows its sensor families as chips; picking
 * families, in the tag bar or on a row, keeps the LOGRs that carry all of them. A column header sorts by that column; an empty
 * cell (a device never heard from, on no station) sorts last either way. A row opens a pane
 * summing the device up, with buttons to its device view, its stations and its projects.
 *
 * `opts`, set by build_device_dashboard.py: `projectDashboardId`, whose Station
 * and Project views those buttons open.
 * Widget: logr-product-docs/cloud/DEVICE_VIEW.md §1.
 *
 * Loads after shared/resolver.js, glossary.js, ui.js, tb_io.js and lifecycle.js.
 */

window.TerrySenseDeviceFleet = function (ctx, container, opts) {

opts = opts || {};

var t = window.TerrySenseI18n(ctx);
var G = window.TerrySenseGlossary;
var tb = window.TerrySenseTbIo(ctx);
var root = container.querySelector('.ts-root') || container;
var ui = window.TerrySenseUi(root);
var life = window.TerrySenseLifecycle(ui, tb);
var h = ui.h, esc = ui.esc, ICON = ui.ICON;

var GROUPS = [
  { id: 'logr', profiles: ['logr2', 'logr3', 'logr4'] },
  { id: 'other', profiles: ['gsaa', 'gsaa2', 'whtr', 'zc-tilt', 'default'] }
];
var ATTRS = ['active', 'lastActivityTime', 'inactivityTimeout', 'deviceInfo.hwVersion', 'deviceInfo.fwVersion',
  'status.healthFaults', 'register.hwVersion', 'register.hwStatus', 'register.loraFw', 'register.dfu',
  'service.state', 'service.silencedUntil'];
var FINE_STATUS = /^(all functional|ok|)$/i;
var TOPOLOGY_TYPE_RE = /^topology\.p(\d+)\.type$/;
var EMPTY_MARKER = '(empty)';
// A LOGR2's sensors by the prefix of its device keys, as device_topology's LOGR2_SENSORS.
var LOGR2_SENSORS = {
  phpr: { code: 'PHPR' }, cond: { code: 'COND' }, dryc: { code: 'DRYC' }, flow: { code: 'FLOW' },
  clmt: { code: 'CLMT' }, inclTilt: { code: 'INCL/TILT' }, usonRdar: { code: 'USON/RDAR' }
};
function logr2SensorNames() {
  return {
    phpr: t('mapping.logr2.phpr', 'pH probe'), cond: t('mapping.logr2.cond', 'Conductivity probe'),
    dryc: t('common.dryc', 'Dry contact interface'), flow: t('mapping.logr2.flow', 'Flow meter'),
    clmt: t('mapping.logr2.clmt', 'Climate sensor'), inclTilt: t('mapping.logr2.inclTilt', 'Inclinometer or tiltmeter'),
    usonRdar: t('mapping.logr2.usonRdar', 'Ultrasonic or radar level sensor')
  };
}
var REFRESH_MS = 60000;
var PAGE = 1000;

function fmtTime(ts) { return ts ? new Date(Number(ts)).toLocaleString(t.locale()) : t('common.never', 'never'); }
function flag(v) { return v === true || v === 'true'; }

// -- data -------------------------------------------------------------------------------

var state = { devices: [], tenant: false, writable: false, group: 'logr', filter: 'all', search: '', tags: { sensor: {}, project: {} }, tagsOpen: {}, sort: 'uplink', dir: -1, loadedAt: 0 };

function queryDevices() {
  var profiles = [];
  GROUPS.forEach(function (g) { profiles = profiles.concat(g.profiles); });
  return tb.post('/api/entitiesQuery/find', {
    entityFilter: { type: 'deviceType', deviceTypes: profiles, deviceNameFilter: '' },
    entityFields: ['name', 'label', 'type', 'ownerName', 'ownerType'].map(function (k) { return { type: 'ENTITY_FIELD', key: k }; }),
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
        customer: v(f, 'ownerType') === 'CUSTOMER' ? v(f, 'ownerName') : null,
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

/** The stations a device feeds, each with its project, and the device's projects.
 * A station's project is looked up once per load, however many devices feed it.
 * An open pane redraws as its device's stations arrive. */
function loadStations(devices) {
  var projectOf = {};
  return Promise.all(devices.map(function (d) {
    return tb.deviceStations(d, projectOf).catch(function () { return []; }).then(function (refs) {
      var projects = {};
      refs.forEach(function (s) { if (s.project) { projects[s.project.id] = s.project; } });
      d.stationRefs = refs;
      d.stations = refs.map(function (s) { return s.name; });
      d.projects = Object.keys(projects).map(function (id) { return projects[id]; })
        .sort(function (a, b) { return a.name.localeCompare(b.name); });
      if (state.pane && state.pane.id === d.id) { state.pane.fill(d); }
    });
  }));
}

/** `[{ code, count, names }]`, by code: a LOGR3 or LOGR4's peripheral families
 * from `topology.p<POS>.type` past position 0, a LOGR2's from its key prefixes. */
function sensorsOf(d) {
  var byCode = {};
  function add(code, name) {
    var s = byCode[code] = byCode[code] || { code: code, count: 0, names: [] };
    s.count++;
    if (s.names.indexOf(name) < 0) { s.names.push(name); }
  }
  if (d.type === 'logr2') {
    return tb.get('/api/plugins/telemetry/DEVICE/' + d.id + '/keys/timeseries').then(function (keys) {
      var seen = {};
      tb.readingKeys(keys).forEach(function (k) { seen[k.slice(0, k.indexOf('.'))] = true; });
      var names = logr2SensorNames();
      Object.keys(LOGR2_SENSORS).forEach(function (p) { if (seen[p]) { add(LOGR2_SENSORS[p].code, names[p]); } });
      return sorted(byCode);
    });
  }
  return tb.attrsMap({ entityType: 'DEVICE', id: d.id }, 'CLIENT_SCOPE').then(function (attrs) {
    Object.keys(attrs).forEach(function (k) {
      var m = TOPOLOGY_TYPE_RE.exec(k), type = m && String(attrs[k] || '').trim();
      if (m && m[1] !== '0' && type && type !== EMPTY_MARKER) { add(type.split('-')[0].toUpperCase(), type); }
    });
    return sorted(byCode);
  });
}
function sorted(byCode) { return Object.keys(byCode).sort().map(function (c) { return byCode[c]; }); }

function loadSensors(devices) {
  return Promise.all(devices.filter(function (d) { return groupOf(d).id === 'logr'; }).map(function (d) {
    return sensorsOf(d).then(function (s) { d.sensors = s; }).catch(function () { d.sensors = []; });
  }));
}

/** Devices and alarms first; the stations and sensors, one lookup each per
 * device, fill in on a second render. */
function load() {
  return queryDevices().then(function (devices) {
    var byId = {};
    devices.forEach(function (d) { byId[d.id] = d; });
    return loadAlarms(byId).then(function () {
      devices.forEach(function (d) {
        var old = state.devices.filter(function (x) { return x.id === d.id; })[0];
        d.stations = old ? old.stations : null;
        d.stationRefs = old ? old.stationRefs : null;
        d.projects = old ? old.projects : null;
        d.sensors = old ? old.sensors : null;
      });
      if (!state.loadedAt) {
        // A customer may own no LOGR: open on the first group that has a device.
        var first = GROUPS.filter(function (g) { return devices.some(function (d) { return groupOf(d).id === g.id; }); })[0];
        if (first) { state.group = first.id; }
      }
      state.devices = devices;
      state.loadedAt = Date.now();
      render();
      return Promise.all([loadStations(devices), loadSensors(devices)]);
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

function reports(d) { return tb.isComplexDevice(d.type); }

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

/** Columns of each list: default direction, the value it sorts by (null sorts last), cell class and width. */
var COLUMNS = {
  device: { dir: 1, cell: 'ts-fleet-dev', width: 'minmax(180px, 2fr)', value: function (d) { return String(d.name || '').toLowerCase(); } },
  customer: { dir: 1, cell: 'ts-fleet-cust', width: 'minmax(110px, 1fr)', value: function (d) { return d.customer ? d.customer.toLowerCase() : null; } },
  uplink: { dir: -1, cell: 'ts-fleet-up', width: '110px', value: function (d) { return lastTs(d) || null; } },
  projects: { dir: 1, cell: 'ts-fleet-proj', width: 'minmax(110px, 1.2fr)', value: function (d) { return d.projects && d.projects.length ? d.projects[0].name.toLowerCase() : null; } },
  stations: { dir: 1, cell: 'ts-fleet-st', width: 'minmax(120px, 1.5fr)', value: function (d) { return d.stations && d.stations.length ? d.stations[0].toLowerCase() : null; } },
  sensors: { dir: 1, cell: 'ts-fleet-sens', width: 'minmax(110px, 1.2fr)', value: function (d) { return d.sensors && d.sensors.length ? codes(d).join(' ') : null; } },
  versions: { dir: 1, cell: 'ts-fleet-ver', width: 'minmax(120px, 1fr)', value: function (d) { var v = version(d, 'deviceInfo.hwVersion', 'register.hwVersion'); return v ? String(v.value) : null; } },
  hardware: { dir: -1, cell: 'ts-fleet-hw', width: 'minmax(110px, 1fr)', value: function (d) { return (hwStatusBad(d) ? 2 : 0) + (dfuImpossible(d) ? 1 : 0) || null; } },
  type: { dir: 1, cell: 'ts-fleet-type', width: '90px', value: function (d) { return d.type || null; } },
  alarms: { dir: -1, cell: 'ts-fleet-al', width: '90px', value: function (d) { var w = worstAlarm(d); return w ? G.rank(w.toLowerCase()) * 1000 + d.alarms.length : null; } }
};
function columnLabels() {
  return {
    device: t('common.device', 'Device'), customer: t('common.customer', 'Customer'), uplink: t('fleet.lastUplink', 'Last uplink'),
    projects: t('common.projects', 'Projects'), stations: t('common.stations', 'Stations'), sensors: t('fleet.sensors', 'Sensors'),
    versions: t('common.versions', 'Versions'), hardware: t('fleet.hardware', 'Hardware'), type: t('fleet.type', 'Type'), alarms: t('fleet.alarms', 'Alarms')
  };
}
function columnsOf(logr) {
  return ['device'].concat(state.tenant ? ['customer'] : [], ['uplink', 'projects', 'stations'], logr ? ['sensors', 'versions', 'hardware'] : ['type'], ['alarms']);
}

function codes(d) { return (d.sensors || []).map(function (s) { return s.code; }); }

/** A tag line longer than this folds to its first chips and the picked ones. */
var TAG_LIMIT = 12;

/** The tag lines: a LOGR keeps every sensor family picked, any device any project picked. */
var TAGS = {
  sensor: { label: 'Sensors', every: true, options: function (d) {
    return groupOf(d).id === 'logr' ? codes(d).map(function (c) { return { value: c, label: c }; }) : [];
  } },
  project: { label: 'Projects', every: false, options: function (d) {
    return (d.projects || []).map(function (p) { return { value: p.id, label: p.name }; });
  } }
};

function hasTags(d) {
  return Object.keys(TAGS).every(function (kind) {
    var picked = Object.keys(state.tags[kind]);
    if (!picked.length || (kind === 'sensor' && state.group !== 'logr')) { return true; }
    var have = TAGS[kind].options(d).map(function (o) { return o.value; });
    var held = picked.filter(function (v) { return have.indexOf(v) >= 0; }).length;
    return TAGS[kind].every ? held === picked.length : held > 0;
  });
}

function toggleTag(kind, opt) {
  if (state.tags[kind][opt.value] !== undefined) { delete state.tags[kind][opt.value]; } else { state.tags[kind][opt.value] = opt.label; }
  render();
}

/** A chip that picks or unpicks its tag, on a row as in the tag line. */
function tagChip(kind, opt, text, title) {
  var b = h('<button type="button" class="ts-chip ts-fleet-tag"></button>');
  b.setAttribute('data-kind', kind);
  b.setAttribute('data-tag', opt.value);
  b.textContent = text || opt.label;
  if (title) { b.title = title; }
  if (state.tags[kind][opt.value] !== undefined) { b.classList.add('on'); }
  b.addEventListener('click', function (e) { e.stopPropagation(); toggleTag(kind, opt); });
  b.addEventListener('keydown', function (e) { e.stopPropagation(); });
  return b;
}

function outOfService(d) { return !!tb.serviceOf(d.attrs).state; }

function needsLook(d) {
  return !outOfService(d) && (liveness(d) !== 'live' || d.alarms.length > 0 || hwStatusBad(d));
}

function visible() {
  var q = state.search.trim().toLowerCase();
  var list = state.devices.filter(function (d) {
    if (groupOf(d).id !== state.group) { return false; }
    if (state.filter === 'attention' && !needsLook(d)) { return false; }
    if (state.filter === 'outofservice' && !outOfService(d)) { return false; }
    if (!hasTags(d)) { return false; }
    if (!q) { return true; }
    return [d.name, d.label, d.owner, d.type, hwStatus(d)].concat(d.stations || [], codes(d), (d.projects || []).map(function (p) { return p.name; }))
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
  '    <div class="ts-head-text"><div class="ts-title">' + esc(t('nav.fleet', 'Fleet')) + '</div><div class="ts-subtitle"></div></div></div>' +
  '  <div class="ts-fleet-bar">' +
  '    <div class="ts-seg" data-bar="group"></div>' +
  '    <div class="ts-seg" data-bar="filter"><button type="button" data-v="all">' + esc(t('common.all', 'All')) + '</button>' +
  '      <button type="button" data-v="attention">' + esc(t('fleet.needsLook', 'Needs a look')) + '</button>' +
  '      <button type="button" data-v="outofservice">' + esc(t('common.outOfService', 'Out of service')) + '</button></div>' +
  '    <label class="ts-fleet-search">' + ICON.search + '<input type="search" placeholder="' + esc(t('fleet.search', 'Name, label, customer, project, station, sensor')) + '"></label>' +
  '  </div>' +
  '  <div class="ts-fleet-tags" data-kind="project" hidden><span class="ts-row-meta">' + esc(t('common.projects', 'Projects')) + '</span><span class="ts-fleet-taglist"></span></div>' +
  '  <div class="ts-fleet-tags" data-kind="sensor" hidden><span class="ts-row-meta">' + esc(t('fleet.sensors', 'Sensors')) + '</span><span class="ts-fleet-taglist"></span></div>' +
  '  <div class="ts-body"><div class="ts-loading">' + esc(t('common.loading', 'Loading…')) + '</div></div>' +
  '  <div class="ts-foot"><span class="ts-row-meta ts-fleet-updated"></span><span class="ts-spacer"></span>' +
  '    <button type="button" class="ts-btn">' + ICON.reset + esc(t('common.refresh', 'Refresh')) + '</button></div>' +
  '</div>');
root.appendChild(cardEl);
window.TerrySenseNav(ctx, tb, ui, cardEl, opts);
var bodyEl = cardEl.querySelector('.ts-body');
var refreshBtn = cardEl.querySelector('.ts-foot .ts-btn');
var groupBar = cardEl.querySelector('[data-bar=group]');
GROUPS.forEach(function (g) { groupBar.appendChild(h('<button type="button" data-v="' + g.id + '"></button>')).textContent = g.id === 'logr' ? 'LOGR' : t('fleet.otherDevices', 'Other devices'); });

cardEl.querySelector('.ts-fleet-bar').addEventListener('click', function (e) {
  var b = e.target.closest('[data-v]');
  if (!b) { return; }
  state[b.parentNode.getAttribute('data-bar')] = b.getAttribute('data-v');
  render();
});
cardEl.querySelector('.ts-fleet-search input').addEventListener('input', function (e) { state.search = e.target.value; render(); });
/** Each tag line: every value on the group's devices, and every picked one, so it can be unpicked. */
function renderTags() {
  Object.keys(TAGS).forEach(function (kind) {
    var line = cardEl.querySelector('.ts-fleet-tags[data-kind="' + kind + '"]');
    var all = {};
    state.devices.forEach(function (d) {
      if (groupOf(d).id === state.group) { TAGS[kind].options(d).forEach(function (o) { all[o.value] = o.label; }); }
    });
    var picked = state.tags[kind];
    Object.keys(picked).forEach(function (v) { all[v] = picked[v]; });
    var list = Object.keys(all).map(function (v) { return { value: v, label: all[v] }; })
      .sort(function (a, b) { return a.label.localeCompare(b.label); });
    line.hidden = !list.length;
    var holder = line.querySelector('.ts-fleet-taglist');
    holder.innerHTML = '';
    var open = state.tagsOpen[kind] || list.length <= TAG_LIMIT;
    var shown = open ? list : list.filter(function (o, i) { return i < TAG_LIMIT || picked[o.value] !== undefined; });
    shown.forEach(function (o) { holder.appendChild(tagChip(kind, o)); });
    if (list.length > TAG_LIMIT) {
      var more = holder.appendChild(h('<button type="button" class="ts-btn ghost ts-fleet-tagmore" data-a="tags-more"></button>'));
      more.textContent = state.tagsOpen[kind] ? t('fleet.showLess', 'Show less') : t('fleet.more', '+{n} more', { n: list.length - shown.length });
      more.addEventListener('click', function () { state.tagsOpen[kind] = !state.tagsOpen[kind]; renderTags(); });
    }
    if (Object.keys(picked).length) {
      holder.appendChild(h('<button type="button" class="ts-btn ts-fleet-tagclear">' + esc(t('fleet.clear', 'Clear')) + '</button>')).addEventListener('click', function () {
        state.tags[kind] = {};
        render();
      });
    }
  });
}

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
  cardEl.querySelector('.ts-subtitle').textContent = (inGroup.length === 1 ? t('fleet.devicesOne', '1 device') : t('fleet.devicesMany', '{n} devices', { n: inGroup.length })) + ' · ' +
    t('fleet.liveCount', '{n} live', { n: counts.live }) + ' · ' + t('fleet.inactiveCount', '{n} inactive', { n: counts.inactive }) +
    (counts.never ? ' · ' + t('fleet.neverCount', '{n} never heard from', { n: counts.never }) : '') +
    (alarmed ? ' · ' + t('fleet.alarmedCount', '{n} with alarms', { n: alarmed }) : '');
  cardEl.querySelector('.ts-fleet-updated').textContent = t('common.readAt', 'Read {time}', { time: new Date(state.loadedAt).toLocaleTimeString(t.locale()) });
  renderTags();

  var list = visible();
  bodyEl.innerHTML = '';
  var tagged = Object.keys(state.tags.sensor).length + Object.keys(state.tags.project).length;
  if (!list.length) { fail(state.search || state.filter !== 'all' || tagged ? t('fleet.noMatch', 'No device matches.') : t('fleet.none', 'No device here yet.')); return; }
  var logr = state.group === 'logr';
  if (columnsOf(logr).indexOf(state.sort) < 0) { state.sort = 'uplink'; state.dir = -1; return render(); }
  var table = h('<div class="ts-fleet-list"><div class="ts-fleet-row ts-fleet-headrow"></div></div>');
  table.style.setProperty('--ts-fleet-cols', columnsOf(logr).map(function (id) { return COLUMNS[id].width; }).join(' '));
  var head = table.firstChild, labels = columnLabels();
  columnsOf(logr).forEach(function (id) {
    var on = state.sort === id;
    var b = head.appendChild(h('<button type="button" class="ts-fleet-sorter" data-sort="' + id + '"></button>'));
    b.textContent = labels[id] + (on ? (state.dir > 0 ? ' ▲' : ' ▼') : '');
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
  var el = h('<div class="ts-fleet-row" tabindex="0" role="button">' + columnsOf(logr).map(function (id) {
    return '<span class="' + COLUMNS[id].cell + '"></span>';
  }).join('') + '</div>');
  el.querySelector('.ts-fleet-dev').innerHTML = '<span class="ts-dot"></span><span class="ts-fleet-names"><b></b><small></small></span>';
  el.setAttribute('data-device', d.name);
  el.setAttribute('data-live', live);
  el.querySelector('.ts-dot').style.background = live === 'live' ? 'var(--ts-ok)' : live === 'inactive' ? 'var(--ts-danger)' : 'var(--ts-text-3)';
  el.querySelector('b').textContent = d.name;
  el.querySelector('small').textContent = d.label || '';
  var dev = el.querySelector('.ts-fleet-dev');
  life.deviceChips(d.attrs).forEach(function (c) { dev.appendChild(c); });
  if (outOfService(d)) { el.setAttribute('data-service', tb.serviceOf(d.attrs).state); }
  var cust = el.querySelector('.ts-fleet-cust');
  if (cust) { cust.textContent = d.customer || t('fleet.noCustomer', 'none'); cust.classList.toggle('none', !d.customer); }
  var sens = el.querySelector('.ts-fleet-sens');
  if (sens && !d.sensors) {
    sens.appendChild(h('<span class="ts-row-meta">…</span>'));
  } else if (sens) {
    d.sensors.forEach(function (s) {
      sens.appendChild(tagChip('sensor', { value: s.code, label: s.code }, s.code + (s.count > 1 ? ' ×' + s.count : ''), s.names.join(', ')));
    });
  }
  var proj = el.querySelector('.ts-fleet-proj');
  if (!d.projects) {
    proj.appendChild(h('<span class="ts-row-meta">…</span>'));
  } else {
    d.projects.forEach(function (p) { proj.appendChild(tagChip('project', { value: p.id, label: p.name })); });
  }
  var up = el.querySelector('.ts-fleet-up');
  up.textContent = t.ago(lastTs(d));
  up.title = Number(d.attrs.inactivityTimeout) > 0
    ? t('fleet.inactiveAfter', '{time} · inactive after {n} h', { time: fmtTime(lastTs(d)), n: Math.round(Number(d.attrs.inactivityTimeout) / 360000) / 10 })
    : fmtTime(lastTs(d));
  if (live === 'inactive') { up.classList.add('bad'); }
  var st = el.querySelector('.ts-fleet-st');
  if (!d.stations) {
    st.appendChild(h('<span class="ts-row-meta">…</span>'));
  } else if (d.stations.length) {
    d.stations.forEach(function (s) { st.appendChild(h('<span class="ts-chip"></span>')).textContent = s; });
  } else {
    st.appendChild(h('<span class="ts-chip warn"></span>')).textContent = t('common.onNoStation', 'on no station');
  }
  if (logr) {
    var hw = version(d, 'deviceInfo.hwVersion', 'register.hwVersion'), fw = version(d, 'deviceInfo.fwVersion', null);
    var ver = el.querySelector('.ts-fleet-ver');
    ver.innerHTML = [hw ? 'hw ' + esc(hw.value) + (hw.from === 'register' ? ' <i title="' + esc(t('fleet.keptByHand', 'Kept by hand')) + '">reg</i>' : '') : '',
      fw ? 'fw ' + esc(fw.value) : '', !reports(d) && d.attrs['register.loraFw'] ? 'LoRa ' + esc(d.attrs['register.loraFw']) : '']
      .filter(Boolean).join('<br>');
    var hwEl = el.querySelector('.ts-fleet-hw');
    // Only the exceptions: a status other than fine, and no firmware update possible.
    if (hwStatusBad(d)) { hwEl.appendChild(h('<span class="ts-chip warn"></span>')).textContent = hwStatus(d); }
    if (dfuImpossible(d)) { var dfu = hwEl.appendChild(h('<span class="ts-chip warn"></span>'));
      dfu.textContent = t('fleet.dfuImpossible', 'DFU impossible');
      dfu.title = t('fleet.noUpdate', 'This unit cannot take a firmware update'); }
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
  el.addEventListener('click', function () { openPane(d); });
  el.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { openPane(d); } });
  return el;
}

function deviceRef(d) { return { entityType: 'DEVICE', id: d.id, name: d.name, label: d.label }; }


// -- pane -------------------------------------------------------------------------------

function livenessLabels() { return { live: t('fleet.live', 'Live'), inactive: t('fleet.inactive', 'Inactive'), never: t('common.neverHeard', 'Never heard from') }; }
// Battery voltage of both generations, as device_topology's BATTERY_VOLTAGE; charging is the status.charging attribute.
var BATTERY_VOLTAGE = ['p0.voltage', 'p0.voltage.i0', 'logr.batteryVoltage'];
var LINK_KEYS = ['rssi', 'snr', 'p0.percent'].concat(BATTERY_VOLTAGE);

function parseJson(v) {
  if (typeof v !== 'string') { return v === undefined ? null : v; }
  try { return JSON.parse(v); } catch (e) { return null; }
}

function fmtDuration(s) {
  s = Number(s);
  return s >= 172800 ? t('common.days', '{n} days', { n: Math.round(s / 86400) }) : s >= 7200 ? Math.round(s / 3600) + ' h' : Math.round(s / 60) + ' min';
}

/** Battery and radio, fetched when the pane opens: the device's attributes and its latest readings. */
function loadLink(d) {
  var dev = { entityType: 'DEVICE', id: d.id };
  return Promise.all([
    tb.attrsMap(dev, 'CLIENT_SCOPE').catch(function () { return {}; }),
    tb.attrsMap(dev, 'SERVER_SCOPE').catch(function () { return {}; }),
    tb.get('/api/plugins/telemetry/DEVICE/' + d.id + '/values/timeseries', { keys: LINK_KEYS.join(',') }).catch(function () { return {}; })
  ]).then(function (got) {
    // ThingsBoard answers a key never stored with a null value at the current time.
    var lat = {};
    Object.keys(got[2] || {}).forEach(function (k) { var p = got[2][k] && got[2][k][0]; if (p && p.value !== null && p.value !== undefined) { lat[k] = { ts: Number(p.ts), value: p.value }; } });
    return { client: got[0], server: got[1], latest: lat };
  });
}

function batteryLine(link) {
  var c = link.client, lat = link.latest, parts = [];
  var soc = c['status.soc'] !== undefined ? c['status.soc'] : (lat['p0.percent'] ? lat['p0.percent'].value : undefined);
  var volt = BATTERY_VOLTAGE.map(function (k) { return lat[k]; }).filter(Boolean)[0];
  var charging = c['status.charging'];
  if (soc !== undefined) { parts.push(Math.round(Number(soc)) + ' %'); }
  if (volt) { parts.push(Math.round(Number(volt.value) * 100) / 100 + ' V, ' + t.ago(volt.ts)); }
  if (charging !== undefined) { parts.push(flag(charging) ? t('fleet.charging', 'charging') : t('fleet.notCharging', 'not charging')); }
  if (Number(c['status.battRuntimeSeconds']) > 0) { parts.push(t('fleet.lasts', 'lasts about {time}', { time: fmtDuration(c['status.battRuntimeSeconds']) })); }
  return parts.join(' · ');
}

/** The uplink radio as the device view colours it, with the gateways that heard it; null when nothing is known. */
function radioLine(link) {
  var c = link.client, s = link.server, lat = link.latest, items = [];
  var sf = s.spreadingFactor !== undefined ? s.spreadingFactor : c.spreadingFactor;
  if (lat.rssi) { items.push(ui.metric(lat.rssi.value + ' dBm', ui.radioLevel('rssi', lat.rssi.value))); }
  if (lat.snr) { items.push(ui.metric('SNR ' + lat.snr.value + ' dB', ui.radioLevel('snr', lat.snr.value))); }
  if (sf !== undefined) { items.push(ui.metric('SF' + sf, ui.radioLevel('sf', sf))); }
  var gws = parseJson(c.gateways || s.gateways) || [];
  if (gws.length) { items.push(gws.length === 1 ? t('fleet.gatewayOne', '1 gateway') : t('fleet.gatewayMany', '{n} gateways', { n: gws.length })); }
  if (!items.length) { return null; }
  var line = h('<span class="ts-fleet-radio"></span>');
  items.forEach(function (x, i) {
    if (i) { line.appendChild(document.createTextNode(' · ')); }
    line.appendChild(typeof x === 'string' ? document.createTextNode(x) : x);
  });
  return line;
}

function downlinkLine(link) {
  var c = link.client;
  if (c['status.dlRssi'] === undefined) { return null; }
  var line = h('<span class="ts-fleet-radio"></span>');
  line.appendChild(ui.metric(c['status.dlRssi'] + ' dBm', ui.radioLevel('rssi', c['status.dlRssi'])));
  line.appendChild(document.createTextNode(' · '));
  line.appendChild(ui.metric('SNR ' + c['status.dlSnr'] + ' dB', ui.radioLevel('snr', c['status.dlSnr'])));
  return line;
}

function kv(parent, label, value) {
  var row = parent.appendChild(h('<div class="ts-kv"><div class="ts-kv-label"></div><div class="ts-kv-value"></div></div>'));
  row.querySelector('.ts-kv-label').textContent = label;
  var v = row.querySelector('.ts-kv-value');
  if (typeof value === 'string') { v.textContent = value; } else { v.appendChild(value); }
  return row;
}

function section(parent, title) {
  var sec = parent.appendChild(h('<div class="ts-section"><div class="ts-section-head"></div></div>'));
  sec.firstChild.textContent = title;
  return sec;
}

function navRow(parent, label, meta, button, onClick) {
  var row = parent.appendChild(h('<div class="ts-fleet-pane-row"><div class="ts-row-main"><div class="ts-row-label"></div>' +
    '<div class="ts-row-meta"></div></div></div>'));
  row.querySelector('.ts-row-label').textContent = label;
  row.querySelector('.ts-row-meta').textContent = meta || '';
  if (onClick) {
    var b = row.appendChild(h('<button type="button" class="ts-btn"></button>'));
    b.textContent = button;
    b.addEventListener('click', function () { ui.closeDrawer(); onClick(); });
  }
  return row;
}

/** Where to go from the pane, by kind: the device, the stations it feeds, their projects. */
function fillGoTo(go, d) {
  Array.prototype.slice.call(go.children, 1).forEach(function (el) { el.remove(); });
  function group(title) {
    var g = go.appendChild(h('<div class="ts-fleet-go"><div class="ts-fleet-go-kind"></div></div>'));
    g.firstChild.textContent = title;
    return g;
  }
  navRow(group(t('common.device', 'Device')), d.name, t('fleet.deviceMeta', 'Peripherals, channels and settings'), t('fleet.deviceView', 'Device view'), function () { openDevice(d); })
    .querySelector('button').setAttribute('data-a', 'device-view');
  if (!d.stationRefs) {
    go.appendChild(h('<div class="ts-row-meta"></div>')).textContent = t('fleet.loadingStations', 'Loading stations and projects…');
    return;
  }
  if (!d.stationRefs.length) {
    go.appendChild(h('<div class="ts-row-meta"></div>')).textContent = t('fleet.noStationNoProject', 'On no station, so on no project.');
    return;
  }
  var stations = group(d.stationRefs.length === 1 ? t('common.station', 'Station') : t('common.stations', 'Stations'));
  d.stationRefs.forEach(function (s) {
    navRow(stations, s.name, s.project ? t('fleet.inProject', 'in {name}', { name: s.project.name }) : t('fleet.onNoProject', 'on no project'), t('common.stationView', 'Station view'),
      opts.projectDashboardId && function () { tb.openDashboard(opts.projectDashboardId, 'station', s); }).setAttribute('data-station', s.name);
  });
  if (!d.projects.length) { return; }
  var projects = group(d.projects.length === 1 ? t('common.project', 'Project') : t('common.projects', 'Projects'));
  d.projects.forEach(function (p) {
    var n = d.stationRefs.filter(function (s) { return s.project && s.project.id === p.id; }).length;
    navRow(projects, p.name, n === 1 ? t('fleet.fedOne', '1 station fed') : t('fleet.fedMany', '{n} stations fed', { n: n }), t('fleet.projectView', 'Project view'),
      opts.projectDashboardId && function () { tb.openDashboard(opts.projectDashboardId, 'project', p); }).setAttribute('data-project', p.name);
  });
}

/** The device at a glance, as its device view has it, and the ways on from there. */
function openPane(d) {
  var live = liveness(d);
  var dr = ui.openDrawer(esc(d.name), esc([d.label, d.type].filter(Boolean).join(' · ')));
  dr.el.classList.add('ts-fleet-pane');
  dr.el.setAttribute('data-pane', d.name);
  var body = dr.body;

  var id = body.appendChild(h('<div class="ts-fleet-pane-id"><div class="ts-fleet-pane-figure"></div><div class="ts-fleet-pane-facts"></div></div>'));
  var figure = id.querySelector('.ts-fleet-pane-figure'), image = ui.productImage(d.type);
  figure.setAttribute('data-figure', image ? 'image' : 'placeholder');
  if (image) {
    var img = figure.appendChild(h('<img>'));
    img.src = image;
    img.alt = d.type;
  } else {
    figure.appendChild(h('<span class="ts-fleet-pane-model"></span>')).textContent = String(d.type || t('common.device', 'Device')).toUpperCase();
  }
  var facts = id.querySelector('.ts-fleet-pane-facts');

  var state0 = h('<span><span class="ts-dot"></span> <span></span></span>');
  state0.querySelector('.ts-dot').style.background = live === 'live' ? 'var(--ts-ok)' : live === 'inactive' ? 'var(--ts-danger)' : 'var(--ts-text-3)';
  state0.lastChild.textContent = lastTs(d) ? t('fleet.lastUplinkAgo', '{state}, last uplink {ago}', { state: livenessLabels()[live], ago: t.ago(lastTs(d)) }) : livenessLabels()[live];
  state0.title = fmtTime(lastTs(d));
  kv(facts, t('fleet.state', 'State'), state0);
  life.deviceChips(d.attrs).forEach(function (c) { state0.appendChild(c); });
  if (state.tenant) { kv(facts, t('common.customer', 'Customer'), d.customer || t('fleet.tenantOwns', 'none, the tenant owns it')); }
  if (groupOf(d).id === 'logr') {
    var hw = version(d, 'deviceInfo.hwVersion', 'register.hwVersion'), fw = version(d, 'deviceInfo.fwVersion', null);
    kv(facts, t('common.versions', 'Versions'), [hw ? (hw.from === 'register' ? t('fleet.hwKeptByHand', 'hw {version} (kept by hand)', { version: hw.value }) : 'hw ' + hw.value) : '', fw ? 'fw ' + fw.value : '',
      !reports(d) && d.attrs['register.loraFw'] ? 'LoRa ' + d.attrs['register.loraFw'] : ''].filter(Boolean).join(' · ') || t('fleet.notReported', 'not reported'));
  } else {
    kv(facts, t('fleet.type', 'Type'), d.type || '');
  }
  var faults = [hwStatusBad(d) ? hwStatus(d) : '', dfuImpossible(d) ? t('fleet.dfuImpossible', 'DFU impossible') : ''].filter(Boolean);
  if (faults.length) { kv(facts, t('fleet.hardware', 'Hardware'), faults.join(' · ')).classList.add('warn'); }
  var battery = kv(facts, t('common.battery', 'Battery'), t('common.loading', 'Loading…')), radio = kv(facts, t('fleet.radio', 'Radio'), t('common.loading', 'Loading…'));
  battery.setAttribute('data-kv', 'battery');
  radio.setAttribute('data-kv', 'radio');
  loadLink(d).then(function (link) {
    battery.querySelector('.ts-kv-value').textContent = batteryLine(link) || t('fleet.notReported', 'not reported');
    var up = radioLine(link), down = downlinkLine(link), value = radio.querySelector('.ts-kv-value');
    value.innerHTML = '';
    if (up) { value.appendChild(up); } else { value.textContent = t('fleet.noRadio', 'nothing from the network server yet'); }
    if (down) { kv(facts, t('fleet.downlink', 'Downlink'), down).setAttribute('data-kv', 'downlink'); }
  });

  if (groupOf(d).id === 'logr') {
    var sens = section(body, t('fleet.sensors', 'Sensors'));
    if (!d.sensors) { sens.appendChild(h('<div class="ts-row-meta"></div>')).textContent = t('common.loading', 'Loading…'); }
    else if (!d.sensors.length) { sens.appendChild(h('<div class="ts-row-meta"></div>')).textContent = t('fleet.noSensor', 'No sensor reported.'); }
    (d.sensors || []).forEach(function (s) {
      navRow(sens, s.code + (s.count > 1 ? ' ×' + s.count : ''), s.names.join(', '));
    });
  }

  var go = section(body, t('fleet.goTo', 'Go to'));
  state.pane = { id: d.id, fill: function (dev) { if (go.isConnected) { fillGoTo(go, dev); } } };
  fillGoTo(go, d);

  if (d.alarms.length) {
    var al = section(body, t('fleet.activeAlarms', 'Active alarms'));
    d.alarms.slice().sort(function (a, b) { return G.rank(b.severity.toLowerCase()) - G.rank(a.severity.toLowerCase()); }).forEach(function (a) {
      var row = navRow(al, a.type, '');
      var chip = row.appendChild(h('<span class="ts-chip ts-fleet-sev"></span>'));
      chip.style.setProperty('--sev', 'var(--sev-' + a.severity.toLowerCase() + ')');
      chip.textContent = G.severity(a.severity.toLowerCase()).label;
    });
  }

  if (state.writable) {
    var act = section(body, t('ui.actions', 'Actions'));
    var service = tb.serviceOf(d.attrs).state, item = life.serviceItem(deviceRef(d), d.attrs, refresh);
    navRow(act, t('fleet.service', 'Service'), service ? G.SERVICE_STATES[service] : t('fleet.inService', 'In service'), item.label, item.run)
      .querySelector('button').setAttribute('data-a', item.a);
    if (state.tenant) {
      var only = act.appendChild(ui.tenantSection(h('<div></div>'))).lastChild;
      navRow(only, t('common.owner', 'Owner'), d.customer || t('fleet.theTenant', 'the tenant'), t('lifecycle.reassign.title', 'Reassign…'), function () { life.reassign(deviceRef(d), refresh); })
        .querySelector('button').setAttribute('data-a', 'reassign');
    }
  }
}

// -- load -------------------------------------------------------------------------------

var timer = null;
function refresh() {
  if (!root.isConnected && timer) { clearInterval(timer); return Promise.resolve(); }
  refreshBtn.disabled = true;
  return load().then(render).catch(function (err) {
    ui.toast(t('common.refreshFailed', 'Refresh failed: {error}', { error: err && err.message ? err.message : err }), 'error');
  }).then(function () { refreshBtn.disabled = false; });
}
refreshBtn.addEventListener('click', refresh);

// A customer user sees only their customer's devices: one permission check covers every row.
tb.currentUser().then(function (me) {
  state.tenant = me.authority === 'TENANT_ADMIN';
  return tb.canWrite({ entityType: 'DEVICE', ownerId: me.customerId && me.customerId.id });
}).then(function (writable) { state.writable = writable; }).catch(function () {}).then(load).then(function () {
  render();
  timer = setInterval(refresh, REFRESH_MS);
}).catch(function (err) { fail(t('common.loadFailed', 'Could not load: {error}', { error: err && err.message ? err.message : err })); });

};
