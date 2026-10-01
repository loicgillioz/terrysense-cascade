/*
 * Fleet — every device at a glance: is it live, where does it feed, what is
 * it, what is wrong with it (TC-3, TC-12). The Devices dashboard's landing view
 * and the tenant's home page. A row opens a pane summing the device up; its row
 * menu, for a user who may write the device, puts it out of service (CA-23),
 * and under *Tenant only* reassigns it to another owner (TA-6). A device out of
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

var G = window.TerrySenseGlossary;
var tb = window.TerrySenseTbIo(ctx);
var root = container.querySelector('.ts-root') || container;
var ui = window.TerrySenseUi(root);
var life = window.TerrySenseLifecycle(ui, tb);
var h = ui.h, esc = ui.esc, ICON = ui.ICON;

var GROUPS = [
  { id: 'logr', label: 'LOGR', profiles: ['logr2', 'logr3', 'logr4'] },
  { id: 'other', label: 'Other devices', profiles: ['gsaa', 'gsaa2', 'whtr', 'zc-tilt', 'default'] }
];
var ATTRS = ['active', 'lastActivityTime', 'inactivityTimeout', 'deviceInfo.hwVersion', 'deviceInfo.fwVersion',
  'status.healthFaults', 'register.hwVersion', 'register.hwStatus', 'register.loraFw', 'register.dfu',
  'service.state', 'service.silencedUntil'];
var FINE_STATUS = /^(all functional|ok|)$/i;
var TOPOLOGY_TYPE_RE = /^topology\.p(\d+)\.type$/;
var EMPTY_MARKER = '(empty)';
// A LOGR2's sensors by the prefix of its device keys, as device_topology's LOGR2_SENSORS.
var LOGR2_SENSORS = {
  phpr: { code: 'PHPR', name: 'pH probe' }, cond: { code: 'COND', name: 'Conductivity probe' },
  dryc: { code: 'DRYC', name: 'Dry contact interface' }, flow: { code: 'FLOW', name: 'Flow meter' },
  clmt: { code: 'CLMT', name: 'Climate sensor' }, inclTilt: { code: 'INCL/TILT', name: 'Inclinometer or tiltmeter' },
  usonRdar: { code: 'USON/RDAR', name: 'Ultrasonic or radar level sensor' }
};
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

var state = { devices: [], tenant: false, writable: false, group: 'logr', filter: 'all', search: '', tags: { sensor: {}, project: {} }, sort: 'uplink', dir: -1, loadedAt: 0 };

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
 * A station's project is looked up once per load, however many devices feed it. */
function loadStations(devices) {
  var projectOf = {};
  function project(st) {
    return projectOf[st.id] || (projectOf[st.id] = tb.ancestors(st).then(function (chain) {
      return chain.filter(function (a) { return a.kind === 'Project'; })[0] || null;
    }));
  }
  return Promise.all(devices.map(function (d) {
    return tb.get('/api/relations/info', { toId: d.id, toType: 'DEVICE' }).then(function (rels) {
      var refs = (rels || []).filter(function (r) { return r.type === 'Contains' && r.from.entityType === 'ASSET'; })
        .map(function (r) { return { entityType: 'ASSET', id: r.from.id, name: r.fromName }; })
        .sort(function (a, b) { return a.name.localeCompare(b.name); });
      return Promise.all(refs.map(function (s) { return project(s).then(function (p) { s.project = p; }); })).then(function () {
        var projects = {};
        refs.forEach(function (s) { if (s.project) { projects[s.project.id] = s.project; } });
        d.stationRefs = refs;
        d.stations = refs.map(function (s) { return s.name; });
        d.projects = Object.keys(projects).map(function (id) { return projects[id]; })
          .sort(function (a, b) { return a.name.localeCompare(b.name); });
      });
    }).catch(function () {});
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
      Object.keys(LOGR2_SENSORS).forEach(function (p) { if (seen[p]) { add(LOGR2_SENSORS[p].code, LOGR2_SENSORS[p].name); } });
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

/** Columns of each list: header, default direction, the value it sorts by (null sorts last), cell class and width. */
var COLUMNS = {
  device: { label: 'Device', dir: 1, cell: 'ts-fleet-dev', width: 'minmax(180px, 2fr)', value: function (d) { return String(d.name || '').toLowerCase(); } },
  customer: { label: 'Customer', dir: 1, cell: 'ts-fleet-cust', width: 'minmax(110px, 1fr)', value: function (d) { return d.customer ? d.customer.toLowerCase() : null; } },
  uplink: { label: 'Last uplink', dir: -1, cell: 'ts-fleet-up', width: '110px', value: function (d) { return lastTs(d) || null; } },
  projects: { label: 'Projects', dir: 1, cell: 'ts-fleet-proj', width: 'minmax(110px, 1.2fr)', value: function (d) { return d.projects && d.projects.length ? d.projects[0].name.toLowerCase() : null; } },
  stations: { label: 'Stations', dir: 1, cell: 'ts-fleet-st', width: 'minmax(120px, 1.5fr)', value: function (d) { return d.stations && d.stations.length ? d.stations[0].toLowerCase() : null; } },
  sensors: { label: 'Sensors', dir: 1, cell: 'ts-fleet-sens', width: 'minmax(110px, 1.2fr)', value: function (d) { return d.sensors && d.sensors.length ? codes(d).join(' ') : null; } },
  versions: { label: 'Versions', dir: 1, cell: 'ts-fleet-ver', width: 'minmax(120px, 1fr)', value: function (d) { var v = version(d, 'deviceInfo.hwVersion', 'register.hwVersion'); return v ? String(v.value) : null; } },
  hardware: { label: 'Hardware', dir: -1, cell: 'ts-fleet-hw', width: 'minmax(110px, 1fr)', value: function (d) { return (hwStatusBad(d) ? 2 : 0) + (dfuImpossible(d) ? 1 : 0) || null; } },
  type: { label: 'Type', dir: 1, cell: 'ts-fleet-type', width: '90px', value: function (d) { return d.type || null; } },
  alarms: { label: 'Alarms', dir: -1, cell: 'ts-fleet-al', width: '90px', value: function (d) { var w = worstAlarm(d); return w ? G.rank(w.toLowerCase()) * 1000 + d.alarms.length : null; } }
};
function columnsOf(logr) {
  return ['device'].concat(state.tenant ? ['customer'] : [], ['uplink', 'projects', 'stations'], logr ? ['sensors', 'versions', 'hardware'] : ['type'], ['alarms']);
}

function codes(d) { return (d.sensors || []).map(function (s) { return s.code; }); }

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
  '    <div class="ts-head-text"><div class="ts-title">Fleet</div><div class="ts-subtitle"></div></div></div>' +
  '  <div class="ts-fleet-bar">' +
  '    <div class="ts-seg" data-bar="group"></div>' +
  '    <div class="ts-seg" data-bar="filter"><button type="button" data-v="all">All</button><button type="button" data-v="attention">Needs a look</button>' +
  '      <button type="button" data-v="outofservice">Out of service</button></div>' +
  '    <label class="ts-fleet-search">' + ICON.search + '<input type="search" placeholder="Name, label, customer, project, station, sensor"></label>' +
  '  </div>' +
  '  <div class="ts-fleet-tags" data-kind="project" hidden><span class="ts-row-meta">Projects</span><span class="ts-fleet-taglist"></span></div>' +
  '  <div class="ts-fleet-tags" data-kind="sensor" hidden><span class="ts-row-meta">Sensors</span><span class="ts-fleet-taglist"></span></div>' +
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
    list.forEach(function (o) { holder.appendChild(tagChip(kind, o)); });
    if (Object.keys(picked).length) {
      holder.appendChild(h('<button type="button" class="ts-btn ts-fleet-tagclear">Clear</button>')).addEventListener('click', function () {
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
  cardEl.querySelector('.ts-subtitle').textContent = inGroup.length + ' devices · ' + counts.live + ' live · ' +
    counts.inactive + ' inactive' + (counts.never ? ' · ' + counts.never + ' never heard from' : '') +
    (alarmed ? ' · ' + alarmed + ' with alarms' : '');
  cardEl.querySelector('.ts-fleet-updated').textContent = 'Read ' + new Date(state.loadedAt).toLocaleTimeString();
  renderTags();

  var list = visible();
  bodyEl.innerHTML = '';
  var tagged = Object.keys(state.tags.sensor).length + Object.keys(state.tags.project).length;
  if (!list.length) { fail(state.search || state.filter !== 'all' || tagged ? 'No device matches.' : 'No device here yet.'); return; }
  var logr = state.group === 'logr';
  if (columnsOf(logr).indexOf(state.sort) < 0) { state.sort = 'uplink'; state.dir = -1; return render(); }
  var table = h('<div class="ts-fleet-list"><div class="ts-fleet-row ts-fleet-headrow"></div></div>');
  table.style.setProperty('--ts-fleet-cols', columnsOf(logr).map(function (id) { return COLUMNS[id].width; }).join(' '));
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
  if (state.writable) { dev.appendChild(ui.rowMenu(function () { return menuItems(d); }, { tenant: state.tenant, title: 'Device actions' })); }
  var cust = el.querySelector('.ts-fleet-cust');
  if (cust) { cust.textContent = d.customer || 'none'; cust.classList.toggle('none', !d.customer); }
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
  el.addEventListener('click', function () { openPane(d); });
  el.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { openPane(d); } });
  return el;
}

function deviceRef(d) { return { entityType: 'DEVICE', id: d.id, name: d.name, label: d.label }; }

/** The row menu: the device's service state, then *Reassign…* for the tenant. */
function menuItems(d) {
  return [
    life.serviceItem(deviceRef(d), d.attrs, refresh),
    { a: 'reassign', label: 'Reassign…', tenantOnly: true, run: function () { life.reassign(deviceRef(d), refresh); } }
  ];
}

// -- pane -------------------------------------------------------------------------------

var LIVENESS = { live: 'Live', inactive: 'Inactive', never: 'Never heard from' };
// Battery readings of both generations, as device_topology's BATTERY_VOLTAGE and BATTERY_CHARGING.
var BATTERY_VOLTAGE = ['p0.voltage', 'p0.voltage.i0', 'logr.batteryVoltage'];
var BATTERY_CHARGING = ['p0.boolean', 'logr.batteryCharging'];
var LINK_KEYS = ['rssi', 'snr', 'p0.percent'].concat(BATTERY_VOLTAGE, BATTERY_CHARGING);

function parseJson(v) {
  if (typeof v !== 'string') { return v === undefined ? null : v; }
  try { return JSON.parse(v); } catch (e) { return null; }
}

function fmtDuration(s) {
  s = Number(s);
  return s >= 172800 ? Math.round(s / 86400) + ' days' : s >= 7200 ? Math.round(s / 3600) + ' h' : Math.round(s / 60) + ' min';
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
  var charging = c['status.charging'] !== undefined ? c['status.charging'] : (BATTERY_CHARGING.map(function (k) { return lat[k]; }).filter(Boolean)[0] || {}).value;
  if (soc !== undefined) { parts.push(Math.round(Number(soc)) + ' %'); }
  if (volt) { parts.push(Math.round(Number(volt.value) * 100) / 100 + ' V, ' + ago(volt.ts)); }
  if (charging !== undefined) { parts.push(flag(charging) ? 'charging' : 'not charging'); }
  if (Number(c['status.battRuntimeSeconds']) > 0) { parts.push('lasts about ' + fmtDuration(c['status.battRuntimeSeconds'])); }
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
  if (gws.length) { items.push(gws.length + (gws.length === 1 ? ' gateway' : ' gateways')); }
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
    figure.appendChild(h('<span class="ts-fleet-pane-model"></span>')).textContent = String(d.type || 'device').toUpperCase();
  }
  var facts = id.querySelector('.ts-fleet-pane-facts');

  var state0 = h('<span><span class="ts-dot"></span> <span></span></span>');
  state0.querySelector('.ts-dot').style.background = live === 'live' ? 'var(--ts-ok)' : live === 'inactive' ? 'var(--ts-danger)' : 'var(--ts-text-3)';
  state0.lastChild.textContent = LIVENESS[live] + (lastTs(d) ? ', last uplink ' + ago(lastTs(d)) : '');
  state0.title = fmtTime(lastTs(d));
  kv(facts, 'State', state0);
  life.deviceChips(d.attrs).forEach(function (c) { state0.appendChild(c); });
  if (state.tenant) { kv(facts, 'Customer', d.customer || 'none, the tenant owns it'); }
  if (groupOf(d).id === 'logr') {
    var hw = version(d, 'deviceInfo.hwVersion', 'register.hwVersion'), fw = version(d, 'deviceInfo.fwVersion', null);
    kv(facts, 'Versions', [hw ? 'hw ' + hw.value + (hw.from === 'register' ? ' (kept by hand)' : '') : '', fw ? 'fw ' + fw.value : '',
      !reports(d) && d.attrs['register.loraFw'] ? 'LoRa ' + d.attrs['register.loraFw'] : ''].filter(Boolean).join(' · ') || 'not reported');
  } else {
    kv(facts, 'Type', d.type || '');
  }
  var faults = [hwStatusBad(d) ? hwStatus(d) : '', dfuImpossible(d) ? 'DFU impossible' : ''].filter(Boolean);
  if (faults.length) { kv(facts, 'Hardware', faults.join(' · ')).classList.add('warn'); }
  var battery = kv(facts, 'Battery', 'Loading…'), radio = kv(facts, 'Radio', 'Loading…');
  battery.setAttribute('data-kv', 'battery');
  radio.setAttribute('data-kv', 'radio');
  loadLink(d).then(function (link) {
    battery.querySelector('.ts-kv-value').textContent = batteryLine(link) || 'not reported';
    var up = radioLine(link), down = downlinkLine(link), value = radio.querySelector('.ts-kv-value');
    value.innerHTML = '';
    if (up) { value.appendChild(up); } else { value.textContent = 'nothing from the network server yet'; }
    if (down) { kv(facts, 'Downlink', down).setAttribute('data-kv', 'downlink'); }
  });

  if (groupOf(d).id === 'logr') {
    var sens = section(body, 'Sensors');
    if (!d.sensors) { sens.appendChild(h('<div class="ts-row-meta">Loading…</div>')); }
    else if (!d.sensors.length) { sens.appendChild(h('<div class="ts-row-meta">No sensor reported.</div>')); }
    (d.sensors || []).forEach(function (s) {
      navRow(sens, s.code + (s.count > 1 ? ' ×' + s.count : ''), s.names.join(', '));
    });
  }

  // Where to go from here: the device view, then each project and station the device feeds.
  var go = section(body, 'Go to');
  navRow(go, d.name, 'Peripherals, channels and settings', 'Device view', function () { openDevice(d); })
    .querySelector('button').setAttribute('data-a', 'device-view');
  if (!d.stationRefs) {
    go.appendChild(h('<div class="ts-row-meta">Loading projects and stations…</div>'));
  } else {
    d.projects.forEach(function (p) {
      var n = d.stationRefs.filter(function (s) { return s.project && s.project.id === p.id; }).length;
      navRow(go, p.name, 'Project · ' + n + (n === 1 ? ' station' : ' stations') + ' fed', 'Project',
        opts.projectDashboardId && function () { tb.openDashboard(opts.projectDashboardId, 'project', p); }).setAttribute('data-project', p.name);
    });
    d.stationRefs.forEach(function (s) {
      navRow(go, s.name, 'Station · ' + (s.project ? s.project.name : 'on no project'), 'Station',
        opts.projectDashboardId && function () { tb.openDashboard(opts.projectDashboardId, 'station', s); }).setAttribute('data-station', s.name);
    });
    if (!d.stationRefs.length) { go.appendChild(h('<div class="ts-row-meta">On no station, so on no project.</div>')); }
  }

  if (d.alarms.length) {
    var al = section(body, 'Active alarms');
    d.alarms.slice().sort(function (a, b) { return G.rank(b.severity.toLowerCase()) - G.rank(a.severity.toLowerCase()); }).forEach(function (a) {
      var row = navRow(al, a.type, '');
      var chip = row.appendChild(h('<span class="ts-chip ts-fleet-sev"></span>'));
      chip.style.setProperty('--sev', 'var(--sev-' + a.severity.toLowerCase() + ')');
      chip.textContent = G.severity(a.severity.toLowerCase()).label;
    });
  }
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

// A customer user sees only their customer's devices: one permission check covers every row.
tb.currentUser().then(function (me) {
  state.tenant = me.authority === 'TENANT_ADMIN';
  return tb.canWrite({ entityType: 'DEVICE', ownerId: me.customerId && me.customerId.id });
}).then(function (writable) { state.writable = writable; }).catch(function () {}).then(load).then(function () {
  render();
  timer = setInterval(refresh, REFRESH_MS);
}).catch(function (err) { fail('Could not load: ' + (err && err.message ? err.message : err)); });

};
