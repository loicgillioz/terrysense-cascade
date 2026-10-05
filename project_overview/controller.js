/*
 * Project — a project's stations on a map and in a list, each with its state,
 * its stale channels and the age of its last reading (EU-1). Stations close
 * together at the current zoom merge into one cluster. A station opens its
 * station view, and its charts on its own station dashboard; an editor assigns
 * one, creates one from the station's channels (shared/templates.js), places and removes a station's position
 * and draws the project area, adds a station; the row menus of the project
 * and its stations rename, move, make public or private, retire and delete
 * (shared/lifecycle.js). Retired stations fold away at the end of the list.
 * Widget: logr-product-docs/cloud/FRONTEND.md *Project dashboard*.
 *
 * `opts`, set by build_project_dashboard.py: `projectDashboardId` (its Station
 * and Settings views). A public link opens the project's own dashboard,
 * `config.homeDashboard`, created here from picked stations (shared/templates.js).
 *
 * `opts.devicesDashboardId`, the fleet, for the follow-up of a new station.
 *
 * Loads after shared/resolver.js, glossary.js, ui.js, tb_io.js, calculations.js, lifecycle.js and templates.js; loads
 * Leaflet, Leaflet.markercluster and Leaflet-Geoman itself.
 */

window.TerrySenseProjectOverview = function (ctx, container, opts) {

opts = opts || {};
var resolver = window.TerrySenseResolver;
var G = window.TerrySenseGlossary;
var tb = window.TerrySenseTbIo(ctx);
var root = container.querySelector('.ts-root') || container;
var ui = window.TerrySenseUi(root);
var calc = window.TerrySenseCalculations(ui, tb);
var life = window.TerrySenseLifecycle(ui, tb);
var templates = window.TerrySenseTemplates(ui, tb);
var h = ui.h, esc = ui.esc, ICON = ui.ICON;

var REFRESH_MS = 60000;
var LEAFLET = 'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/';
var CLUSTER = 'https://cdn.jsdelivr.net/npm/leaflet.markercluster@1.5.3/dist/';
var GEOMAN = 'https://cdn.jsdelivr.net/npm/@geoman-io/leaflet-geoman-free@2.17.0/dist/';
var SWISSTOPO = 'https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.';
var DASHBOARD_KEY = 'config.stationDashboard';
var HOME_KEY = 'config.homeDashboard';
var STATUS = {
  nodata: { label: 'No data', color: 'var(--ts-nodata)', rank: 2 },
  ok: { label: 'OK', color: 'var(--ts-ok)', rank: 1 },
  none: { label: 'No station', color: 'var(--ts-nodata)', rank: 0 },
  retired: { label: 'Retired', color: 'var(--ts-nodata)', rank: -1 }
};
var ICON_LOCK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>';
var ICON_GLOBE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>';
var ICON_CHART = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19h16"/><path d="M5 15l4-5 4 3 6-7"/></svg>';
var ICON_UNPLACE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-6-5.3-6-11a6 6 0 0 1 10.6-3.8M18 10c0 2.3-1 4.6-2.3 6.5"/><path d="M4 4l16 16"/></svg>';

function service(name) { return ctx.$scope.$injector.get(ctx.servicesMap.get(name)); }

function parseJson(raw) {
  if (!raw) { return null; }
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (e) { return null; }
}

function errText(e) { return (e && e.error && e.error.message) || (e && e.message) || String(e); }

function ago(ts) {
  var s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 90) { return 'just now'; }
  if (s < 5400) { return Math.round(s / 60) + ' min ago'; }
  if (s < 129600) { return Math.round(s / 3600) + ' h ago'; }
  return Math.round(s / 86400) + ' days ago';
}

function fmtTime(ts) {
  var d = new Date(ts);
  return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
}

function loadOnce(tag, url) {
  if (document.querySelector(tag + '[data-ts-src="' + url + '"]')) { return Promise.resolve(); }
  return new Promise(function (resolve, reject) {
    var el = document.createElement(tag);
    el.setAttribute('data-ts-src', url);
    if (tag === 'link') { el.rel = 'stylesheet'; el.href = url; } else { el.src = url; }
    el.onload = resolve;
    el.onerror = function () { reject(new Error('could not load ' + url)); };
    document.head.appendChild(el);
  });
}

function loadMapLibraries() {
  var css = Promise.all([loadOnce('link', LEAFLET + 'leaflet.css'), loadOnce('link', GEOMAN + 'leaflet-geoman.css'),
    loadOnce('link', CLUSTER + 'MarkerCluster.css')]);
  var leaflet = window.L && window.L.version && window.L.version >= '1.9' ? Promise.resolve() : loadOnce('script', LEAFLET + 'leaflet.js');
  return Promise.all([css, leaflet.then(function () {
    return Promise.all([
      window.L.PM ? null : loadOnce('script', GEOMAN + 'leaflet-geoman.js'),
      window.L.MarkerClusterGroup ? null : loadOnce('script', CLUSTER + 'leaflet.markercluster.js')
    ]);
  })]);
}

var openDashboard = tb.openDashboard;

// -- data --------------------------------------------------------------------------------

var state = {
  entity: null, owner: null, names: {}, kinds: {}, calcAttributes: {}, projectAttrs: {}, stations: [], loadedAt: 0,
  canEdit: false, canCreateDashboards: false, editMap: false, filter: null, placing: null, adding: null,
  publicReport: null, pub: null, pubDash: null, home: null, showRetired: false, followUps: {}, ghost: null
};

function loadNames() {
  return calc.loadMeta().then(function (meta) {
    state.names = meta.names;
    state.calcAttributes = meta.attributes;
    state.kinds = meta.kinds;
  });
}

function latLngOf(attrs) {
  var lat = Number(attrs.latitude), lng = Number(attrs.longitude);
  return attrs.latitude != null && attrs.longitude != null && isFinite(lat) && isFinite(lng) ? [lat, lng] : null;
}

// A deleted or unshared dashboard leaves the station on its station view.
var readableIds = {};
function readable(id) {
  if (!id) { return Promise.resolve(null); }
  return readableIds[id] || (readableIds[id] = tb.readableDashboard(id));
}

function loadStation(station) {
  var entry = { station: station };
  var url = '/api/plugins/telemetry/ASSET/' + station.id + '/values/timeseries';
  return tb.attrsMap(station).then(function (attrs) {
    entry.attrs = attrs;
    entry.latLng = latLngOf(attrs);
    entry.service = tb.serviceOf(attrs);
    var keys = Object.keys(resolver.channelsFromAttrs(attrs, state.names));
    return Promise.all([
      keys.length ? tb.get(url, { keys: keys.join(',') }).catch(function () { return {}; }) : {},
      tb.get('/api/alarm/ASSET/' + station.id, { searchStatus: 'ACTIVE', pageSize: '100', page: '0' }).catch(function () { return null; }),
      tb.containedDevices(station).catch(function () { return []; }),
      readable(attrs[DASHBOARD_KEY])
    ]);
  }).then(function (got) {
    entry.devices = got[2];
    entry.dashboardId = got[3];
    var latest = {};
    Object.keys(got[0] || {}).forEach(function (k) {
      var p = got[0][k] && got[0][k][0];
      if (p && p.value !== null && p.value !== undefined) { latest[k] = Number(p.ts); }
    });
    entry.lastTs = Object.keys(latest).reduce(function (m, k) { return Math.max(m, latest[k]); }, 0);
    entry.alarms = (got[1] && got[1].data) || [];
    entry.status = statusOf(entry);
    return tb.channelFreshness(entry.attrs, latest, state.names);
  }).then(function (fresh) {
    entry.fresh = fresh;
    return state.canEdit ? deviceFix(entry.devices) : null;
  }).then(function (fix) {
    entry.fix = fix;
    return entry;
  });
}

/** The newest GNSS fix among the devices, with the device it comes from. */
function deviceFix(devices) {
  return Promise.all(devices.map(function (d) { return tb.latestFix(d.id); })).then(function (fixes) {
    return fixes.reduce(function (best, f, i) {
      if (f) { f.device = devices[i]; }
      return f && (!best || f.ts > best.ts) ? f : best;
    }, null);
  });
}

/** The project's own dashboard, `{id, title, stations}`, the stations it shows by id; null without one. */
function loadHome(id) {
  return readable(id).then(function (readId) {
    return readId && tb.get('/api/dashboard/' + readId).then(function (d) {
      return { id: readId, title: d.title, stations: templates.homeStations(d, state.entity.id) };
    });
  }).catch(function () { return null; });
}

function load() {
  var e = state.entity;
  function members(type) { return state.canEdit ? tb.publicMembers(state.owner, type).catch(function () { return null; }) : null; }
  return Promise.all([tb.io.fetchChildren(e), tb.attrsMap(e), members('ASSET'), members('DASHBOARD')]).then(function (got) {
    state.projectAttrs = got[1];
    state.pub = got[2];
    state.pubDash = got[3];
    return Promise.all([Promise.all(got[0].filter(function (c) { return c.kind === 'Station'; }).map(loadStation)),
      state.canEdit ? loadHome(got[1][HOME_KEY]) : null]);
  }).then(function (got) {
    state.stations = got[0].sort(function (a, b) { return a.station.name.localeCompare(b.station.name); });
    state.home = got[1];
    state.loadedAt = Date.now();
  });
}

// -- model -------------------------------------------------------------------------------

/** A station's state: its worst active alarm, else No data or OK. Staleness is
 * per channel (HEALTH.md §2) and shown beside it, never as a station state. */
function statusOf(entry) {
  if (entry.service.retired) { return Object.assign({ id: 'retired' }, STATUS.retired); }
  var worst = entry.alarms.reduce(function (w, a) {
    return !w || G.rank(a.severity.toLowerCase()) > G.rank(w.toLowerCase()) ? a.severity : w;
  }, null);
  if (worst) {
    var id = worst.toLowerCase();
    return { id: 'alarm', label: G.severity(id).label, color: 'var(--sev-' + id + ')', rank: 10 + G.rank(id) };
  }
  if (!entry.lastTs) { return Object.assign({ id: 'nodata' }, STATUS.nodata); }
  return Object.assign({ id: 'ok' }, STATUS.ok);
}

function worstOf(entries) {
  return entries.reduce(function (w, s) { return !w || s.status.rank > w.rank ? s.status : w; }, null) || STATUS.none;
}

function staleText(entry) {
  if (entry.service.retired) { return ''; }
  var f = entry.fresh || {}, stale = f.stale || [];
  return stale.length ? stale.length + ' of ' + f.total + (f.total === 1 ? ' channel' : ' channels') + ' stale' : '';
}

function entryById(id) { return state.stations.filter(function (s) { return s.station.id === id; })[0] || null; }

function active() { return state.stations.filter(function (s) { return !s.service.retired; }); }
function retiredOnes() { return state.stations.filter(function (s) { return s.service.retired; }); }

function isPublic(id) { return !!state.pub && !!state.pub.ids[id]; }
function onHome(entry) { return !!state.home && !!state.home.stations[entry.station.id]; }
function dashRef(id) { return { entityType: 'DASHBOARD', id: id }; }
/** The public link is on when the project dashboard is in a public group of the owner. */
function linkOn() { return !!state.home && !!state.pubDash && !!state.pubDash.ids[state.home.id]; }

function chip(status) {
  var el = h('<span class="ts-chip ts-proj-sev"></span>');
  el.style.setProperty('--c', status.color);
  el.textContent = status.label;
  return el;
}

// -- scaffold ----------------------------------------------------------------------------

var cardEl = h(
  '<div class="ts-card ts-proj">' +
  '  <div class="ts-head"><div class="ts-head-icon">' + ICON.map + '</div>' +
  '    <div class="ts-head-text"><div class="ts-title">Project</div><div class="ts-subtitle"><span class="ts-proj-pname"></span><span class="ts-proj-count"></span></div></div>' +
  '    <span class="ts-proj-public" tabindex="0" hidden></span><span class="ts-proj-worst"></span>' +
  '    <button type="button" class="ts-btn ts-proj-edit" hidden>Edit map</button>' +
  '    <span class="ts-proj-menu"></span></div>' +
  '  <div class="ts-proj-split"><div class="ts-proj-map"></div><div class="ts-proj-list"><div class="ts-loading">Loading…</div></div></div>' +
  '  <div class="ts-foot"><span class="ts-row-meta ts-proj-updated"></span><span class="ts-spacer"></span>' +
  '    <button type="button" class="ts-btn ts-proj-refresh">Refresh</button></div>' +
  '</div>');
root.appendChild(cardEl);
window.TerrySenseNav(ctx, tb, ui, cardEl, opts);
var mapEl = cardEl.querySelector('.ts-proj-map');
var listEl = cardEl.querySelector('.ts-proj-list');
var publicEl = cardEl.querySelector('.ts-proj-public');
var editBtn = cardEl.querySelector('.ts-proj-edit');
var refreshBtn = cardEl.querySelector('.ts-proj-refresh');
var menuEl = cardEl.querySelector('.ts-proj-menu');

new ResizeObserver(function () {
  cardEl.classList.toggle('narrow', cardEl.clientWidth < 720);
  if (map) { map.invalidateSize(); }
}).observe(cardEl);

function fail(text) {
  listEl.innerHTML = '';
  listEl.appendChild(h('<div class="ts-empty"></div>')).textContent = text;
}

// -- map ---------------------------------------------------------------------------------

var map = null, clusterLayer = null, areaLayer = null, markers = {}, fitted = false;

function pinHtml(color, text, silenced) {
  return '<span class="ts-pin' + (silenced ? ' silenced' : '') + '" style="--c:' + color + '"><b>' + esc(text) + '</b>' +
    (silenced ? '<i class="ts-pin-badge">' + ICON.mute + '</i>' : '') + '</span>';
}

function initMap() {
  var L = window.L;
  map = L.map(mapEl, { zoomControl: true, attributionControl: true }).setView([46.8, 8.2], 7);
  var osm = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' });
  var swiss = L.tileLayer(SWISSTOPO + 'pixelkarte-farbe/default/current/3857/{z}/{x}/{y}.jpeg',
    { maxZoom: 19, attribution: '&copy; swisstopo' });
  var aerial = L.tileLayer(SWISSTOPO + 'swissimage/default/current/3857/{z}/{x}/{y}.jpeg',
    { maxZoom: 20, attribution: '&copy; swisstopo' });
  osm.addTo(map);
  L.control.layers({ 'Map': osm, 'Swiss map': swiss, 'Aerial': aerial }, null, { position: 'topright' }).addTo(map);
  // Stations close together at the current zoom are one cluster, coloured by the
  // worst of them (FRONTEND.md *Project dashboard*).
  clusterLayer = L.markerClusterGroup({
    showCoverageOnHover: false, maxClusterRadius: 40, zoomToBoundsOnClick: false,
    iconCreateFunction: function (cluster) {
      var entries = cluster.getAllChildMarkers().map(function (m) { return m.options.entry; });
      return L.divIcon({ className: 'ts-pin-wrap', iconSize: [30, 30], iconAnchor: [15, 15],
        html: pinHtml(worstOf(entries).color, String(entries.length)) });
    }
  }).addTo(map);
  clusterLayer.on('clusterclick', function (ev) {
    var ids = ev.layer.getAllChildMarkers().map(function (m) { return m.options.entry.station.id; });
    state.filter = ids;
    renderList();
    ev.layer.zoomToBounds({ padding: [30, 30] });
  });
  map.pm.setGlobalOptions({ allowSelfIntersection: false });
  map.on('click', onMapClick);
  map.on('pm:create', function (e) {
    if (areaLayer) { map.removeLayer(areaLayer); }
    areaLayer = e.layer;
    watchArea();
    saveArea();
  });
}

function drawArea() {
  var L = window.L;
  var points = parseJson(state.projectAttrs.perimeter);
  if (areaLayer) { map.removeLayer(areaLayer); areaLayer = null; }
  if (Array.isArray(points) && points.length >= 3) {
    areaLayer = L.polygon(points, { color: '#0277b7', weight: 2, fillOpacity: 0.06 }).addTo(map);
    watchArea();
  }
}

function watchArea() {
  areaLayer.setStyle({ color: '#0277b7', weight: 2, fillOpacity: 0.06 });
  areaLayer.on('pm:edit', saveArea);
  areaLayer.on('pm:remove', function () { areaLayer = null; saveArea(); });
}

function saveArea() {
  var e = state.entity;
  var write = areaLayer
    ? tb.saveAttrs(e, { perimeter: JSON.stringify(areaLayer.getLatLngs()[0].map(function (p) { return [p.lat, p.lng]; })) })
    : tb.deleteAttrs(e, ['perimeter']);
  write.then(function () { ui.toast(areaLayer ? 'Project area saved' : 'Project area removed'); })
    .catch(function (err) { ui.toast('Project area not saved: ' + errText(err), 'error'); });
}

function drawMarkers() {
  var L = window.L;
  clusterLayer.clearLayers();
  markers = {};
  var bounds = [];
  state.stations.forEach(function (entry) {
    if (!entry.latLng || entry.service.retired && !state.showRetired) { return; }
    var silenced = entry.service.silencedUntil;
    var icon = L.divIcon({ className: 'ts-pin-wrap', iconSize: [22, 22], iconAnchor: [11, 11],
      html: pinHtml(entry.status.color, '', silenced) });
    var m = L.marker(entry.latLng, { icon: icon, draggable: state.editMap, keyboard: true, title: entry.station.name,
      pmIgnore: true, entry: entry });
    var stale = staleText(entry);
    m.bindTooltip(esc(entry.station.name) + ' · ' + esc(entry.status.label) + (silenced ? ' · ' + esc(ui.silenceText(silenced)) : '') +
      (stale ? ' · ' + esc(stale) : ''),
      { direction: 'top', offset: [0, -10] });
    m.on('click', function (ev) {
      L.DomEvent.stopPropagation(ev);
      var only = state.filter && state.filter.length === 1 && state.filter[0] === entry.station.id;
      state.filter = only ? null : [entry.station.id];
      renderList();
      drawMarkers();
    });
    m.on('dragend', function () {
      var p = m.getLatLng();
      savePosition(entry, [p.lat, p.lng]);
    });
    clusterLayer.addLayer(m);
    if (state.filter && state.filter.length === 1 && state.filter[0] === entry.station.id && m.getElement()) {
      m.getElement().classList.add('selected');
    }
    markers[entry.station.id] = m;
    bounds.push(entry.latLng);
  });
  if (areaLayer) { bounds = bounds.concat(areaLayer.getLatLngs()[0].map(function (p) { return [p.lat, p.lng]; })); }
  if (!fitted && bounds.length) {
    fitted = true;
    if (bounds.length === 1) { map.setView(bounds[0], 15); } else { map.fitBounds(bounds, { padding: [30, 30], maxZoom: 16 }); }
  }
}

function highlight(stationId, on) {
  var m = markers[stationId];
  var el = m && (clusterLayer.getVisibleParent(m) || m).getElement();
  if (el) { el.classList.toggle('hover', on); }
}

function setEditMap(on, hint) {
  state.editMap = on;
  editBtn.textContent = on ? 'Done' : 'Edit map';
  editBtn.classList.toggle('primary', on);
  cardEl.classList.toggle('editing', on);
  state.placing = null;
  state.adding = null;
  clearGhost();
  if (on) {
    map.pm.addControls({ position: 'topleft', drawMarker: false, drawCircleMarker: false, drawPolyline: false,
      drawRectangle: false, drawCircle: false, drawText: false, cutPolygon: false, rotateMode: false,
      dragMode: false, drawPolygon: true, editMode: true, removalMode: true });
    ui.toast(hint || 'Drag a station to move it; Place puts a station without a position on the map');
  } else {
    map.pm.disableDraw();
    map.pm.disableGlobalEditMode();
    map.pm.disableGlobalRemovalMode();
    map.pm.removeControls();
  }
  drawMarkers();
  renderList();
}

function onMapClick(ev) {
  if (!state.editMap || !state.placing && !state.adding || map.pm.globalDrawModeEnabled() || map.pm.globalEditModeEnabled()
      || map.pm.globalRemovalModeEnabled()) { return; }
  var latLng = [ev.latlng.lat, ev.latlng.lng], name = state.adding, entry = entryById(state.placing);
  state.placing = null;
  state.adding = null;
  cardEl.classList.remove('placing');
  if (name) { addStation(name, latLng); } else if (entry) { savePosition(entry, latLng); }
}

/** *Add station* (CA-8): a name, then a click on the map. */
function openAdd() {
  var dr = ui.openDrawer('Add station', esc(state.entity.name));
  var f = dr.body.appendChild(h('<div class="ts-field"><div class="ts-field-label">Name</div><input class="ts-input wide" data-f="name">' +
    '<div class="ts-field-hint">Then click the map where it stands. It shows No device yet until a device is connected.</div></div>'));
  var input = f.querySelector('input'), go = ui.drawerActions(dr, 'Place on the map');
  go.disabled = true;
  input.addEventListener('input', function () { go.disabled = !input.value.trim(); });
  go.addEventListener('click', function () {
    state.adding = input.value.trim();
    state.placing = null;
    ui.closeDrawer();
    cardEl.classList.add('placing');
    ui.toast('Click the map where ' + state.adding + ' stands');
  });
  setTimeout(function () { input.focus(); }, 0);
}

function addStation(name, latLng) {
  tb.createStation(name, state.entity, { latitude: latLng[0], longitude: latLng[1] }).then(function (station) {
    state.followUps[station.id] = true;
    ui.toast(name + ' added');
    return refresh();
  }).catch(function (err) { ui.toast('Station not added: ' + errText(err), 'error'); });
}

/** *Use device position* (CA-9): a ghost marker at the fix; a click on it writes the position. */
function showGhost(entry) {
  var L = window.L, f = entry.fix;
  clearGhost();
  state.ghost = L.marker([f.lat, f.lon], { pmIgnore: true, keyboard: true,
    icon: L.divIcon({ className: 'ts-pin-wrap ts-ghost', iconSize: [22, 22], iconAnchor: [11, 11], html: '<span class="ts-pin ghost"></span>' }) }).addTo(map);
  state.ghost.bindTooltip('The device reports this position, ' + esc(ago(f.ts)) + '. Click to place ' + esc(entry.station.name) + ' here.',
    { direction: 'top', offset: [0, -10] });
  state.ghost.on('click', function (ev) {
    L.DomEvent.stopPropagation(ev);
    ui.confirm('Place <b>' + esc(entry.station.name) + '</b> where its device reports it: ' + f.lat.toFixed(5) + ', ' + f.lon.toFixed(5) +
      (f.sats ? ', ' + f.sats + ' satellites' : '') + ', ' + esc(ago(f.ts)) + '?', 'Use position').then(function (ok) {
      clearGhost();
      if (ok) { savePosition(entry, [f.lat, f.lon]); }
    });
  });
  map.setView([f.lat, f.lon], Math.max(map.getZoom(), 15));
}

function clearGhost() {
  if (state.ghost) { map.removeLayer(state.ghost); state.ghost = null; }
}

function savePosition(entry, latLng) {
  tb.saveAttrs(entry.station, { latitude: latLng[0], longitude: latLng[1] }).then(function () {
    entry.latLng = latLng;
    ui.toast(entry.station.name + ' placed');
    drawMarkers();
    renderList();
  }).catch(function (err) { ui.toast('Position not saved: ' + errText(err), 'error'); drawMarkers(); });
}

function removePosition(entry) {
  ui.confirm('Remove the position of <b>' + esc(entry.station.name) + '</b>? It leaves the map and is listed under No position.', 'Remove')
    .then(function (ok) {
      if (!ok) { return null; }
      return tb.deleteAttrs(entry.station, ['latitude', 'longitude']).then(function () {
        entry.latLng = null;
        ui.toast(entry.station.name + ' has no position');
        drawMarkers();
        renderList();
      });
    }).catch(function (err) { ui.toast('Position not removed: ' + errText(err), 'error'); });
}

// -- list --------------------------------------------------------------------------------

function renderHeader() {
  var e = state.entity, n = active().length, gone = retiredOnes().length;
  cardEl.querySelector('.ts-proj-pname').textContent = e.name;
  cardEl.querySelector('.ts-proj-count').textContent = ' · ' + n + (n === 1 ? ' station' : ' stations') + (gone ? ' · ' + gone + ' retired' : '');
  var worstEl = cardEl.querySelector('.ts-proj-worst');
  worstEl.innerHTML = '';
  if (n) { worstEl.appendChild(chip(worstOf(active()))); }
  menuEl.innerHTML = '';
  if (state.canEdit) { menuEl.appendChild(ui.rowMenu(projectItems, { title: 'Project actions' })); }
  cardEl.querySelector('.ts-proj-updated').textContent = 'Updated ' + fmtTime(state.loadedAt);
  editBtn.hidden = !state.canEdit || !map;
}

function renderList() {
  listEl.innerHTML = '';
  if (state.canEdit && state.editMap) {
    listEl.appendChild(h('<div class="ts-proj-tools"><button type="button" class="ts-btn" data-a="add-station">' + ICON.plus + ' Add station</button></div>'))
      .firstChild.addEventListener('click', openAdd);
  }
  state.stations.forEach(function (entry) {
    var card = state.followUps[entry.station.id] && followUpCard(entry);
    if (card) { listEl.appendChild(card); }
  });
  if (!state.stations.length) {
    listEl.appendChild(h('<div class="ts-empty">No station in this project yet.</div>'));
    return;
  }
  var shown = state.filter ? state.stations.filter(function (s) { return state.filter.indexOf(s.station.id) >= 0; }) : state.stations;
  if (state.filter) {
    var bar = h('<div class="ts-proj-filter"><span></span><button type="button" class="ts-icon-btn" title="Show every station">' + ICON.close + '</button></div>');
    bar.querySelector('span').textContent = shown.length === 1 ? 'Showing ' + shown[0].station.name : 'Showing ' + shown.length + ' stations';
    bar.querySelector('button').addEventListener('click', function () { state.filter = null; renderList(); drawMarkers(); });
    listEl.appendChild(bar);
  }
  var live = shown.filter(function (s) { return !s.service.retired; });
  var placed = live.filter(function (s) { return s.latLng; });
  var unplaced = live.filter(function (s) { return !s.latLng; });
  var body = listEl.appendChild(h('<div class="ts-proj-loc"><div class="ts-proj-loc-body"></div></div>')).firstChild;
  placed.forEach(function (entry) { body.appendChild(stationRow(entry)); });
  if (unplaced.length) {
    var card = listEl.appendChild(h('<div class="ts-proj-loc unplaced"></div>'));
    var head = card.appendChild(h('<div class="ts-proj-group"><span class="ts-proj-group-icon">' + ICON_UNPLACE + '</span>' +
      '<span class="ts-proj-group-name">No position</span><span class="ts-count"></span><span class="ts-spacer"></span></div>'));
    head.querySelector('.ts-count').textContent = unplaced.length;
    head.appendChild(chip(worstOf(unplaced)));
    var ubody = card.appendChild(h('<div class="ts-proj-loc-body"></div>'));
    unplaced.forEach(function (entry) { ubody.appendChild(stationRow(entry)); });
  }
  var gone = shown.filter(function (s) { return s.service.retired; });
  if (gone.length) { listEl.appendChild(retiredFold(gone)); }
}

/** Retired stations, folded at the end of the list; *Show retired* puts them back on the map. */
function retiredFold(gone) {
  var fold = h('<details class="ts-proj-loc ts-proj-retired"><summary class="ts-proj-group"><span class="ts-proj-group-icon">' + ICON.archive + '</span>' +
    '<span class="ts-proj-group-name"></span></summary><div class="ts-proj-loc-body">' +
    '<label class="ts-switch ts-proj-showretired"><input type="checkbox" data-a="show-retired"> Show retired on the map</label></div></details>');
  fold.querySelector('.ts-proj-group-name').textContent = 'Retired (' + gone.length + ')';
  fold.open = !!state.retiredOpen;
  fold.addEventListener('toggle', function () { state.retiredOpen = fold.open; });
  var box = fold.querySelector('input');
  box.checked = state.showRetired;
  box.addEventListener('change', function () { state.showRetired = box.checked; if (map) { drawMarkers(); } });
  var body = fold.querySelector('.ts-proj-loc-body');
  gone.forEach(function (entry) { body.appendChild(stationRow(entry)); });
  return fold;
}

/** The steps still open after *Add station* (FRONTEND.md *Interface conventions*, follow-up card). */
function followUpCard(entry) {
  var st = entry.station;
  var steps = [
    opts.devicesDashboardId && { a: 'device', label: 'Connect a device: Connect to a station, on the device\u2019s view', done: entry.devices.length > 0,
      action: 'Open the fleet', run: function () { openDashboard(opts.devicesDashboardId); } },
    { a: 'settings', label: 'Set its thresholds and contacts', action: 'Settings',
      done: Object.keys(entry.attrs).some(function (k) { return k.indexOf('channel.') === 0 || k.indexOf('config.notify.') === 0; }),
      run: function () { openDashboard(opts.projectDashboardId, 'settings', st); } },
    { a: 'dashboard', label: 'Assign a charts dashboard', done: !!entry.dashboardId, action: 'Assign', run: function () { openAssign(entry); } }
  ].filter(Boolean);
  if (steps.every(function (x) { return x.done; })) { delete state.followUps[st.id]; return null; }
  var card = ui.followUp(st.name + ': next steps', steps, function () { delete state.followUps[st.id]; });
  card.setAttribute('data-followup', st.name);
  return card;
}

function lastReading(entry) {
  var text = entry.lastTs ? 'Last reading ' + ago(entry.lastTs) : 'No reading yet';
  var stale = staleText(entry);
  return stale ? text + ' · ' + stale : text;
}

/** Public access of one station for the project dashboard's public link: null
 * before the check, else `{open, why}` (FRONTEND.md *Public links*). */
function publicState(entry) {
  var r = state.publicReport;
  if (!r) { return null; }
  if (!r.token) { return { open: false, why: r.reason }; }
  if (!onHome(entry)) { return { open: false, why: 'Not on the project dashboard, so its public link does not show this station.' }; }
  if (r.denied[entry.station.id]) { return { open: false, why: 'Private: on the project dashboard, but in no public group of its owner, so the public link shows it empty.' }; }
  return { open: true, why: 'Public: the project dashboard\'s public link shows this station.' };
}

function publicIcon(pub) {
  var el = h('<span class="ts-proj-access' + (pub.open ? ' open' : '') + '" tabindex="0">' + (pub.open ? ICON_GLOBE : ICON_LOCK) + '</span>');
  el.setAttribute('data-tip', pub.why);
  return el;
}

function stationRow(entry) {
  var retired = entry.service.retired;
  var el = h('<div class="ts-proj-st" tabindex="0"><div class="ts-proj-st-main"><div class="ts-proj-st-name"></div>' +
    '<div class="ts-row-meta"></div></div><div class="ts-proj-st-side"></div></div>');
  el.setAttribute('data-station', entry.station.name);
  el.querySelector('.ts-proj-st-name').textContent = entry.station.name;
  el.querySelector('.ts-row-meta').textContent = lastReading(entry);
  var fresh = entry.fresh || {};
  if ((fresh.stale || []).length) {
    el.querySelector('.ts-row-meta').setAttribute('data-tip', 'Stale: ' + fresh.stale.join(', ') +
      ' — older than three measurement intervals of their source');
  }
  var side = el.querySelector('.ts-proj-st-side');
  var pub = state.canEdit && publicState(entry);
  if (pub) { side.appendChild(publicIcon(pub)); }
  if (entry.service.silencedUntil && !retired) { side.appendChild(ui.stateChip('silenced', entry.service.silencedUntil)); }
  if (!entry.devices.length && !retired) { side.appendChild(ui.stateChip('nodevice')); }
  if (state.canEdit && !retired && linkOn() && onHome(entry) && !isPublic(entry.station.id)) { side.appendChild(ui.stateChip('private')); }
  side.appendChild(chip(entry.status));
  // The row opens the station view; without one, its charts.
  var view = opts.projectDashboardId ? [opts.projectDashboardId, 'station'] : entry.dashboardId ? [entry.dashboardId, 'station'] : null;
  if (view) {
    el.classList.add('linked');
    el.addEventListener('click', function (e) { if (!e.target.closest('button, input')) { openDashboard(view[0], view[1], entry.station); } });
    el.addEventListener('keydown', function (e) { if (e.key === 'Enter' && e.target === el) { openDashboard(view[0], view[1], entry.station); } });
  }
  if (entry.dashboardId) {
    var charts = h('<button type="button" class="ts-icon-btn" data-a="charts" title="Charts">' + ICON_CHART + '</button>');
    charts.addEventListener('click', function () { openDashboard(entry.dashboardId, 'station', entry.station); });
    side.appendChild(charts);
  } else {
    el.querySelector('.ts-row-meta').textContent += ' · No charts dashboard yet';
  }
  if (state.canEdit) {
    var assign = h('<button type="button" class="ts-icon-btn" data-a="assign" title="' + (entry.dashboardId ? 'Charts dashboard' : 'Link a charts dashboard') + '">' +
      (entry.dashboardId ? ICON.edit : ICON.plus) + '</button>');
    assign.addEventListener('click', function () { openAssign(entry); });
    side.appendChild(assign);
  }
  if (state.canEdit && state.editMap && entry.fix && !retired) {
    var fix = h('<button type="button" class="ts-btn ghost" data-a="use-fix">Use device position</button>');
    fix.addEventListener('click', function () { showGhost(entry); });
    side.appendChild(fix);
  }
  if (state.canEdit && state.editMap && !retired) {
    var place = h('<button type="button" class="ts-btn ghost">' + (entry.latLng ? 'Move' : 'Place') + '</button>');
    place.addEventListener('click', function () {
      state.placing = entry.station.id;
      cardEl.classList.add('placing');
      ui.toast('Click the map where ' + entry.station.name + ' is');
    });
    side.appendChild(place);
    if (entry.latLng) {
      var unplace = h('<button type="button" class="ts-icon-btn" title="Remove position">' + ICON_UNPLACE + '</button>');
      unplace.addEventListener('click', function () { removePosition(entry); });
      side.appendChild(unplace);
    }
  }
  if (state.canEdit) {
    var items = life.stationItems({
      station: entry.station, attrs: entry.attrs, project: state.entity, owner: state.owner, isPublic: isPublic(entry.station.id),
      projectPublic: linkOn(),
      nameEl: el.querySelector('.ts-proj-st-name'), changed: refreshAll, deleted: refreshAll
    });
    if (state.home && !onHome(entry) && !retired && state.canCreateDashboards) {
      var at = items.map(function (i) { return i && i.a; }).indexOf(isPublic(entry.station.id) ? 'private' : 'public') + 1;
      items.splice(at, 0, { a: 'add-home', label: 'Add to project dashboard…', run: function () { openAddHome(entry); } });
    }
    side.appendChild(ui.rowMenu(items, { title: 'Station actions' }));
  }
  el.addEventListener('mouseenter', function () { highlight(entry.station.id, true); });
  el.addEventListener('mouseleave', function () { highlight(entry.station.id, false); });
  return el;
}

/** The project's row menu, in the header. */
function projectItems() {
  var e = state.entity, on = linkOn();
  return [
    { a: 'rename', label: 'Rename', run: function () { life.rename(e, cardEl.querySelector('.ts-proj-pname'), renderHeader); } },
    state.canCreateDashboards && { a: 'create-home', label: 'Create project dashboard…', run: function () { openCreateHome(); } },
    state.pub && state.pubDash && { a: on ? 'link-off' : 'link-on', label: on ? 'Public link off' : 'Public link on', run: function () { setPublicLink(!on); } },
    on && { a: 'copy-link', label: 'Copy link', run: copyLink },
    !active().length && { a: 'delete', label: 'Delete\u2026', danger: true, run: function () {
      life.remove(e, retiredOnes().map(function (s) { return s.station; }), function () { openDashboard(opts.projectDashboardId); });
    } }
  ];
}

function names(stations) { return stations.map(function (s) { return '<b>' + esc(s.name) + '</b>'; }).join(', '); }

/** The project dashboard `id`, the project and `stations` into the owner's public groups. */
function publishHome(id, stations) {
  var work = tb.setPublic(dashRef(id), state.owner, true).then(function () { return tb.setPublic(state.entity, state.owner, true); });
  stations.filter(function (s) { return !isPublic(s.id); }).forEach(function (s) {
    work = work.then(function () { return tb.setPublic(s, state.owner, true); });
  });
  return work;
}

/** *Create project dashboard*; `then` follows the creation instead of opening the new dashboard. */
function openCreateHome(intro, then) {
  var was = state.home, wasPublic = linkOn();
  templates.openCreateHome({ project: state.entity, owner: state.owner, entries: active(), names: state.names, kinds: state.kinds,
    replaces: was && was.title, intro: intro,
    done: function (id, stations) {
      // A replaced dashboard hands its public link over to the new one.
      var work = wasPublic ? tb.setPublic(dashRef(was.id), state.owner, false).then(function () {
        return publishHome(id, stations);
      }) : Promise.resolve();
      work.then(refreshAll).then(function () { if (then) { then(); } else { openDashboard(id); } })
        .catch(function (err) { ui.toast('Public link not moved: ' + errText(err), 'error'); });
    } });
}

function openAddHome(entry) {
  var exposes = linkOn() && !isPublic(entry.station.id);
  templates.openAddToHome({ station: entry.station, attrs: entry.attrs, names: state.names, kinds: state.kinds, homeId: state.home.id,
    note: linkOn() ? 'The project\'s public link shows it from then on.' : '',
    done: function () {
      (exposes ? tb.setPublic(entry.station, state.owner, true) : Promise.resolve()).then(refreshAll)
        .catch(function (err) { ui.toast('Not made public: ' + errText(err), 'error'); });
    } });
}

/** *Public link* on makes the project dashboard, the project and every station
 * on the dashboard public; off takes the dashboard and the project out, each
 * station keeping its choice. With no project dashboard, on creates one first. */
function setPublicLink(on) {
  var e = state.entity, home = state.home;
  if (on && !home) {
    if (!state.canCreateDashboards) { ui.toast('A public link opens the project dashboard, and this project has none yet.', 'error'); return; }
    openCreateHome('A public link opens the project dashboard, and this project has none yet. Create it, then confirm the public link.',
      function () { setPublicLink(true); });
    return;
  }
  var shown = active().filter(onHome).map(function (s) { return s.station; });
  var left = active().filter(function (s) { return !onHome(s); }).map(function (s) { return s.station; });
  var html = on
    ? 'Turn the public link of <b>' + esc(e.name) + '</b> on? Anyone with the link opens its project dashboard <b>' + esc(home.title) + '</b>' +
      (shown.length ? ' and sees ' + (shown.length === 1 ? 'its station ' : 'its ' + shown.length + ' stations ') + names(shown) +
        ': readings, states and alarms' : '') + '.' +
      (left.length ? ' Not on the dashboard, so not shown: ' + names(left) + '.' : '')
    : 'Turn the public link of <b>' + esc(e.name) + '</b> off? The link stops opening its project dashboard; each station keeps its public or private choice.';
  ui.confirm(html, on ? 'Turn on' : 'Turn off').then(function (ok) {
    if (!ok) { return null; }
    var work = on ? publishHome(home.id, shown)
      : tb.setPublic(dashRef(home.id), state.owner, false).then(function () { return tb.setPublic(e, state.owner, false); });
    return work.then(function () {
      ui.toast(on ? 'Public link on' : 'Public link off');
      return refreshAll();
    });
  }).catch(function (err) { ui.toast('Not changed: ' + errText(err), 'error'); });
}

function copyLink() {
  var group = state.pubDash.groups.filter(function (g) { return g.members[state.home.id]; })[0];
  var link = tb.publicLink(state.home.id, group.additionalInfo.publicCustomerId);
  navigator.clipboard.writeText(link).then(function () { ui.toast('Public link copied'); },
    function (err) { ui.toast('Not copied: ' + errText(err), 'error'); });
}

/** One header icon for the whole project: public when the project dashboard's
 * public link shows every station on it, private otherwise, with what it cannot show. */
function renderPublic() {
  var r = state.publicReport;
  publicEl.hidden = !state.canEdit || !r;
  if (publicEl.hidden) { return; }
  var lines = [];
  if (!r.token) {
    lines.push(r.reason);
  } else {
    if (r.denied[state.home.id]) { lines.push('the project dashboard is in no public group'); }
    var sts = state.stations.filter(function (s) { return onHome(s) && r.denied[s.station.id]; });
    if (sts.length) { lines.push(sts.length + (sts.length === 1 ? ' station on it is' : ' stations on it are') + ' in no public group'); }
  }
  var open = !!r.token && !lines.length;
  publicEl.className = 'ts-proj-access ts-proj-public' + (open ? ' open' : '');
  publicEl.innerHTML = (open ? ICON_GLOBE : ICON_LOCK) + '<span>' + (open ? 'Public' : 'Private') + '</span>';
  publicEl.setAttribute('data-tip', open ? 'The public link opens ' + state.home.title + ' and shows every station on it.'
    : !r.token ? lines[0] : 'Private to signed-in users: ' + lines.join('; ') + '.');
}

function render() {
  renderHeader();
  renderPublic();
  renderList();
  if (map) { drawArea(); drawMarkers(); }
}

// -- public access -----------------------------------------------------------------------

/** Sign in as the owner's public customer and try every read the project
 * dashboard's public link needs (FRONTEND.md *Public links*). `denied` maps an entity id to true. */
function checkPublic() {
  var owner = state.owner, home = state.home;
  if (!home) { return Promise.resolve({ token: null, reason: 'No public link: the project has no project dashboard yet.' }); }
  return tb.get('/api/user/customers', { pageSize: '1000', page: '0' }).then(function (page) {
    var pub = ((page && page.data) || []).filter(function (c) {
      var isPub = (c.additionalInfo || {}).isPublic;
      var parent = c.parentCustomerId && c.parentCustomerId.id;
      return isPub && (owner.entityType === 'CUSTOMER' ? parent === owner.id : !parent);
    })[0];
    if (!pub) { return { token: null, reason: 'No public link can show this project: its owner has made nothing public yet.' }; }
    return fetch('/api/auth/login/public', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ publicId: pub.id.id }) }).then(function (r) { return r.json(); }).then(function (auth) {
      var headers = { 'X-Authorization': 'Bearer ' + auth.token };
      var checks = [['dashboard', home.id]].concat(state.stations.filter(onHome).map(function (s) { return ['asset', s.station.id]; }));
      var denied = {};
      return Promise.all(checks.map(function (c) {
        return fetch('/api/' + c[0] + '/' + c[1], { headers: headers }).then(function (r) { if (!r.ok) { denied[c[1]] = true; } });
      })).then(function () { return { token: auth.token, denied: denied }; });
    });
  }).catch(function () { return null; });
}

function refreshPublic() {
  if (!state.canEdit) { return Promise.resolve(); }
  return checkPublic().then(function (report) {
    state.publicReport = report;
    renderPublic();
    renderList();
  });
}

// -- templates ---------------------------------------------------------------------------

function openAssign(entry) {
  templates.openPanel({ station: entry.station, attrs: entry.attrs, owner: state.owner, names: state.names, kinds: state.kinds,
    calcAttributes: state.calcAttributes, canCreate: state.canCreateDashboards,
    open: function (id) { openDashboard(id, 'station', entry.station); }, changed: refresh });
}

// -- load --------------------------------------------------------------------------------

var timer = null;
function refresh() {
  if (!root.isConnected && timer) { clearInterval(timer); return Promise.resolve(); }
  refreshBtn.disabled = true;
  return load().then(render).catch(function (err) {
    ui.toast('Refresh failed: ' + errText(err), 'error');
  }).then(function () { refreshBtn.disabled = false; });
}

/** The stations and the public access check, which draws the public and private icons. */
function refreshAll() { return refresh().then(refreshPublic); }

refreshBtn.addEventListener('click', refreshAll);
editBtn.addEventListener('click', function () { setEditMap(!state.editMap); });

tb.boundDatasource().then(function (ds) {
  if (!ds || ds.entityType !== 'ASSET') { fail('No project bound — bind a project in the widget\'s Data tab.'); return; }
  return Promise.all([tb.loadEntity(ds), tb.getAsset(ds.entityId), loadNames(), tb.currentUser()]).then(function (got) {
    if (got[0].kind !== 'Project') { fail('This widget shows a project; ' + got[0].name + ' is a ' + got[0].kind + '.'); return null; }
    state.entity = got[0];
    state.owner = got[1].ownerId;
    state.me = got[3] || {};
    var perms = service('userPermissionsService');
    state.canCreateDashboards = !!perms && perms.hasGenericPermission('DASHBOARD', 'CREATE');
    return Promise.all([
      tb.canWrite(state.entity),
      loadMapLibraries().then(initMap).catch(function (err) {
        mapEl.appendChild(h('<div class="ts-empty"></div>')).textContent = 'The map could not load: ' + errText(err);
      })
    ]);
  }).then(function (got) {
    if (!got) { return null; }
    state.canEdit = got[0] && !state.me.isPublic;
    return load().then(function () {
      render();
      // A project just created opens with its map in edit mode (FRONTEND.md *Project list*, New project).
      if (state.canEdit && map && (ctx.stateController.getStateParams() || {}).editMap) { setEditMap(true, 'Draw the area or add stations'); }
      timer = setInterval(refresh, REFRESH_MS);
      return refreshPublic();
    });
  });
}).catch(function (err) { fail('Could not load: ' + errText(err)); });

};
