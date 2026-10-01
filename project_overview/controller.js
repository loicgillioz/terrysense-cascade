/*
 * Project — a project's stations on a map and in a list, each with its state,
 * its stale channels and the age of its last reading (EU-1). Stations close
 * together at the current zoom merge into one cluster. A station opens its
 * station view, and its charts on its own station dashboard; an editor assigns
 * one, or creates a template for it, places and removes a station's position
 * and draws the project area, adds a station; the row menus of the project
 * and its stations rename, move, make public or private, retire and delete
 * (shared/lifecycle.js). Retired stations fold away at the end of the list.
 * Widget: logr-product-docs/cloud/FRONTEND.md *Project dashboard*.
 *
 * `opts`, set by build_project_dashboard.py: `projectDashboardId` (its Station
 * and Settings views; checked for public access).
 *
 * `opts.devicesDashboardId`, the fleet, for the follow-up of a new station.
 *
 * Loads after shared/resolver.js, glossary.js, ui.js, tb_io.js, calculations.js and lifecycle.js; loads
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
var h = ui.h, esc = ui.esc, ICON = ui.ICON;

var REFRESH_MS = 60000;
var LEAFLET = 'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/';
var CLUSTER = 'https://cdn.jsdelivr.net/npm/leaflet.markercluster@1.5.3/dist/';
var GEOMAN = 'https://cdn.jsdelivr.net/npm/@geoman-io/leaflet-geoman-free@2.17.0/dist/';
var SWISSTOPO = 'https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.';
var TEMPLATE_GROUP = 'Station dashboards';
var STARTER_TITLE = 'Station (starter)';
var STARTER_USE = 'New template';
var PLACEHOLDER = { channel: '__CHANNEL__', label: '__LABEL__', unit: '__UNIT__' };
var DASHBOARD_KEY = 'config.stationDashboard';
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

function uuid() {
  if (window.crypto && crypto.randomUUID) { return crypto.randomUUID(); }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    var r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 3 | 8)).toString(16);
  });
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
  entity: null, owner: null, names: {}, calcAttributes: {}, projectAttrs: {}, stations: [], loadedAt: 0,
  canEdit: false, canCreateDashboards: false, editMap: false, filter: null, placing: null, adding: null,
  publicReport: null, pub: null, templates: null, showRetired: false, followUps: {}, ghost: null
};

function loadNames() {
  return calc.loadMeta().then(function (meta) {
    state.names = meta.names;
    state.calcAttributes = meta.attributes;
  });
}

function latLngOf(attrs) {
  var lat = Number(attrs.latitude), lng = Number(attrs.longitude);
  return attrs.latitude != null && attrs.longitude != null && isFinite(lat) && isFinite(lng) ? [lat, lng] : null;
}

function loadStation(station) {
  var entry = { station: station };
  var url = '/api/plugins/telemetry/ASSET/' + station.id + '/values/timeseries';
  return tb.attrsMap(station).then(function (attrs) {
    entry.attrs = attrs;
    entry.latLng = latLngOf(attrs);
    entry.dashboardId = attrs[DASHBOARD_KEY] || null;
    entry.service = tb.serviceOf(attrs);
    var keys = Object.keys(resolver.channelsFromAttrs(attrs, state.names));
    return Promise.all([
      keys.length ? tb.get(url, { keys: keys.join(',') }).catch(function () { return {}; }) : {},
      tb.get('/api/alarm/ASSET/' + station.id, { searchStatus: 'ACTIVE', pageSize: '100', page: '0' }).catch(function () { return null; }),
      tb.containedDevices(station).catch(function () { return []; })
    ]);
  }).then(function (got) {
    entry.devices = got[2];
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

function load() {
  var e = state.entity;
  return Promise.all([tb.io.fetchChildren(e), tb.attrsMap(e),
    state.canEdit ? tb.publicMembers(state.owner).catch(function () { return null; }) : null]).then(function (got) {
    state.projectAttrs = got[1];
    state.pub = got[2];
    return got;
  }).then(function (got) {
    return Promise.all(got[0].filter(function (c) { return c.kind === 'Station'; }).map(loadStation));
  }).then(function (stations) {
    state.stations = stations.sort(function (a, b) { return a.station.name.localeCompare(b.station.name); });
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

/** Public access of one station for a public link: null before the check,
 * else `{open, why}` (FRONTEND.md *Public links*). */
function publicState(entry) {
  var r = state.publicReport;
  if (!r) { return null; }
  if (!r.token) { return { open: false, why: r.reason }; }
  if (r.denied[entry.station.id]) { return { open: false, why: 'Private: a public link cannot show this station, which is in no public group of its owner.' }; }
  if (entry.dashboardId && r.denied[entry.dashboardId]) { return { open: false, why: 'Private: a public link cannot open this station\'s dashboard, which is not shared with the public users.' }; }
  return { open: true, why: 'Public: a public link shows this station' + (entry.dashboardId ? ' and opens its dashboard.' : '.') };
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
  if (state.canEdit && !retired && isPublic(state.entity.id) && !isPublic(entry.station.id)) { side.appendChild(ui.stateChip('private')); }
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
    var assign = h('<button type="button" class="ts-icon-btn" data-a="assign" title="' + (entry.dashboardId ? 'Change dashboard' : 'Assign dashboard') + '">' +
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
    side.appendChild(ui.rowMenu(life.stationItems({
      station: entry.station, attrs: entry.attrs, project: state.entity, owner: state.owner, isPublic: isPublic(entry.station.id),
      projectPublic: isPublic(state.entity.id),
      nameEl: el.querySelector('.ts-proj-st-name'), changed: refreshAll, deleted: refreshAll
    }), { title: 'Station actions' }));
  }
  el.addEventListener('mouseenter', function () { highlight(entry.station.id, true); });
  el.addEventListener('mouseleave', function () { highlight(entry.station.id, false); });
  return el;
}

/** The project's row menu, in the header. */
function projectItems() {
  var e = state.entity, on = isPublic(e.id);
  return [
    { a: 'rename', label: 'Rename', run: function () { life.rename(e, cardEl.querySelector('.ts-proj-pname'), renderHeader); } },
    state.pub && { a: on ? 'link-off' : 'link-on', label: on ? 'Public link off' : 'Public link on', run: function () { setPublicLink(!on); } },
    on && opts.projectDashboardId && { a: 'copy-link', label: 'Copy link', run: copyLink },
    !active().length && { a: 'delete', label: 'Delete\u2026', danger: true, run: function () {
      life.remove(e, retiredOnes().map(function (s) { return s.station; }), function () { openDashboard(opts.projectDashboardId); });
    } }
  ];
}

/** *Public link* on puts the project and every station in service in the
 * owner's public group; off takes the project out, each station keeping its choice. */
function setPublicLink(on) {
  var e = state.entity, stations = active().map(function (s) { return s.station; });
  var html = on
    ? 'Turn the public link of <b>' + esc(e.name) + '</b> on? Anyone with the link sees the project' +
      (stations.length ? ' and ' + (stations.length === 1 ? 'its station ' : 'its ' + stations.length + ' stations ') +
        stations.map(function (s) { return '<b>' + esc(s.name) + '</b>'; }).join(', ') + ': readings, states and dashboards' : '') +
      '. Make a station private from its row menu.'
    : 'Turn the public link of <b>' + esc(e.name) + '</b> off? The link stops opening the project; each station keeps its public or private choice.';
  ui.confirm(html, on ? 'Turn on' : 'Turn off').then(function (ok) {
    if (!ok) { return null; }
    var work = tb.setPublic(e, state.owner, on);
    (on ? stations.filter(function (s) { return !isPublic(s.id); }) : []).forEach(function (s) {
      work = work.then(function () { return tb.setPublic(s, state.owner, true); });
    });
    return work.then(function () {
      ui.toast(on ? 'Public link on' : 'Public link off');
      return refreshAll();
    });
  }).catch(function (err) { ui.toast('Not changed: ' + errText(err), 'error'); });
}

function copyLink() {
  var group = state.pub.groups.filter(function (g) { return g.members[state.entity.id]; })[0];
  var link = tb.publicLink(opts.projectDashboardId, group.additionalInfo.publicCustomerId, 'project', state.entity);
  navigator.clipboard.writeText(link).then(function () { ui.toast('Public link copied'); },
    function (err) { ui.toast('Not copied: ' + errText(err), 'error'); });
}

/** One header icon for the whole project: public when a public link shows
 * everything, private otherwise, with what it cannot show. */
function renderPublic() {
  var r = state.publicReport;
  publicEl.hidden = !state.canEdit || !r;
  if (publicEl.hidden) { return; }
  var lines = [];
  if (!r.token) {
    lines.push(r.reason);
  } else {
    if (r.denied[state.entity.id]) { lines.push('this project is in no public group'); }
    var sts = state.stations.filter(function (s) { return r.denied[s.station.id]; });
    if (sts.length) { lines.push(sts.length + (sts.length === 1 ? ' station is' : ' stations are') + ' in no public group'); }
    var dash = state.stations.filter(function (s) { return s.dashboardId && r.denied[s.dashboardId]; });
    if (dash.length) { lines.push(dash.length + (dash.length === 1 ? ' station dashboard is' : ' station dashboards are') + ' not shared with the public users'); }
    if (opts.projectDashboardId && r.denied[opts.projectDashboardId]) { lines.push('the Project dashboard is not shared with the public users'); }
  }
  var open = !!r.token && !lines.length;
  publicEl.className = 'ts-proj-access ts-proj-public' + (open ? ' open' : '');
  publicEl.innerHTML = (open ? ICON_GLOBE : ICON_LOCK) + '<span>' + (open ? 'Public' : 'Private') + '</span>';
  publicEl.setAttribute('data-tip', open ? 'A public link shows this project, its stations and their dashboards.'
    : !r.token ? lines[0] : 'Private to signed-in users: ' + lines.join('; ') + '.');
}

function render() {
  renderHeader();
  renderPublic();
  renderList();
  if (map) { drawArea(); drawMarkers(); }
}

// -- public access -----------------------------------------------------------------------

/** Sign in as the owner's public customer and try every read a public link needs
 * (FRONTEND.md *Public links*). `denied` maps an entity id to true. */
function checkPublic() {
  var owner = state.owner;
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
      var checks = [['asset', state.entity.id]]
        .concat(state.stations.map(function (s) { return ['asset', s.station.id]; }))
        .concat(state.stations.filter(function (s) { return s.dashboardId; }).map(function (s) { return ['dashboard', s.dashboardId]; }));
      if (opts.projectDashboardId) { checks.push(['dashboard', opts.projectDashboardId]); }
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

/** Every template the user can read: the tenant's and the user's own. */
function loadTemplates() {
  if (state.templates) { return Promise.resolve(state.templates); }
  return tb.get('/api/entityGroups/DASHBOARD').then(function (groups) {
    var mine = (groups || []).filter(function (g) { return g.name === TEMPLATE_GROUP; });
    return Promise.all(mine.map(function (g) {
      return tb.get('/api/entityGroup/' + g.id.id + '/dashboards', { pageSize: '200', page: '0' }).then(function (page) {
        return Promise.all(((page && page.data) || []).map(function (d) {
          return tb.get('/api/dashboard/' + d.id.id).then(function (full) {
            return { id: d.id.id, title: d.title, tenant: g.ownerId.entityType === 'TENANT', channels: resolver.dashboardChannels(full) };
          });
        }));
      });
    }));
  }).then(function (lists) {
    state.templates = [].concat.apply([], lists);
    return state.templates;
  });
}

function stationChannels(entry) {
  return Object.keys(resolver.channelsFromAttrs(entry.attrs, state.names));
}

function calcMeta() { return { names: state.names, attributes: state.calcAttributes }; }

function labelsOf(entry, keys) {
  return keys.map(function (k) { return calc.channelLabel(calcMeta(), entry.attrs, k); });
}

function attrLabels(attrs) {
  return attrs.map(function (a) { return (state.calcAttributes[a] || {}).label || a; });
}

/** A template row: its title, what it shows or lacks, and whose it is. */
function templateOption(entry, r) {
  var o = h('<div class="ts-opt" tabindex="0"><div class="ts-opt-main"><div class="ts-opt-label"></div><div class="ts-opt-desc"></div></div>' +
    '<div class="ts-opt-side"></div></div>');
  if (r.t.id === entry.dashboardId) { o.classList.add('selected'); }
  o.querySelector('.ts-opt-label').textContent = r.t.title;
  var side = o.querySelector('.ts-opt-side');
  var desc = r.fit.fits ? 'Shows ' + calc.listText(labelsOf(entry, r.t.channels))
    : !r.t.channels.length ? 'Shows no measurement'
    : r.fit.missing.length ? 'Not measured here: ' + calc.listText(labelsOf(entry, r.fit.missing))
    : 'Needs ' + calc.listText(attrLabels(r.fit.needs)) + ' to calculate ' + calc.listText(labelsOf(entry, r.t.channels.filter(function (c) {
      return !(c in resolver.channelsFromAttrs(entry.attrs, state.names));
    })));
  o.querySelector('.ts-opt-desc').textContent = desc;
  if (r.fit.fits) { side.appendChild(h('<span class="ts-chip accent">fits</span>')); }
  else if (!r.fit.missing.length && r.fit.needs.length) {
    side.appendChild(h('<span class="ts-chip">' + (r.fit.needs.length === 1 ? '1 setting' : r.fit.needs.length + ' settings') + '</span>'));
  }
  side.appendChild(h('<span class="ts-chip level">' + (r.t.tenant ? 'in-terra' : 'own') + '</span>'));
  function pick() {
    if (!r.fit.missing.length && r.fit.needs.length) { openSetup(entry, r.t, r.fit.needs); } else { assign(entry, r.t); }
  }
  o.addEventListener('click', pick);
  o.addEventListener('keydown', function (e) { if (e.key === 'Enter') { pick(); } });
  return o;
}

function openAssign(entry) {
  var dr = ui.openDrawer('Station dashboard', esc(entry.station.name));
  dr.body.appendChild(h('<div class="ts-loading">Loading the templates…</div>'));
  loadTemplates().then(function (templates) {
    dr.body.innerHTML = '';
    var rows = templates.map(function (t) { return { t: t, fit: resolver.templateFit(t.channels, entry.attrs, state.names) }; })
      .sort(function (a, b) {
        return (a.fit.missing.length - b.fit.missing.length) || (a.fit.needs.length - b.fit.needs.length) || a.t.title.localeCompare(b.t.title);
      });
    var groups = [
      ['Ready for this station', rows.filter(function (r) { return r.fit.fits; })],
      ['One step away: a setting to enter', rows.filter(function (r) { return !r.fit.fits && !r.fit.missing.length && r.fit.needs.length; })],
      ['Other templates', rows.filter(function (r) { return r.fit.missing.length || !r.t.channels.length; })]
    ];
    if (!rows.length) { dr.body.appendChild(h('<div class="ts-empty">No template yet.</div>')); }
    groups.forEach(function (g) {
      if (!g[1].length) { return; }
      var box = h('<div class="ts-opt-group"><div class="ts-section-head"></div></div>');
      box.firstChild.textContent = g[0];
      g[1].forEach(function (r) { box.appendChild(templateOption(entry, r)); });
      dr.body.appendChild(box);
    });
    dr.foot.hidden = false;
    dr.foot.innerHTML = '';
    if (entry.dashboardId) {
      var unlink = h('<button type="button" class="ts-btn">Remove the link</button>');
      unlink.addEventListener('click', function () {
        tb.deleteAttrs(entry.station, [DASHBOARD_KEY]).then(function () {
          ui.closeDrawer();
          ui.toast('Dashboard removed from ' + entry.station.name);
          return refresh();
        }).catch(function (err) { ui.toast('Not saved: ' + errText(err), 'error'); });
      });
      dr.foot.appendChild(unlink);
    }
    dr.foot.appendChild(h('<span class="ts-spacer"></span>'));
    if (state.canCreateDashboards) {
      var create = h('<button type="button" class="ts-btn primary">' + ICON.plus + ' Create template</button>');
      create.addEventListener('click', function () { openCreate(entry); });
      dr.foot.appendChild(create);
    }
  }).catch(function (err) {
    dr.body.innerHTML = '';
    dr.body.appendChild(h('<div class="ts-empty ts-error"></div>')).textContent = 'Could not load the templates: ' + errText(err);
  });
}

/** The constants `needs` names, entered on the station; `done(written)` after the save and resolve. */
function setupDrawer(entry, title, intro, needs, action, done, back) {
  var dr = ui.openDrawer(esc(title), esc(entry.station.name));
  dr.body.appendChild(h('<p class="ts-calc-intro"></p>')).textContent = intro;
  var f = calc.form(entry.station, entry.attrs, needs, calcMeta());
  dr.body.appendChild(f.el);
  dr.body.appendChild(h('<div class="ts-field-hint">Values are calculated from the latest reading on; earlier readings are not recalculated.</div>'));
  dr.onBack(back);
  var go = ui.drawerActions(dr, action);
  function check() { go.disabled = !f.values(); }
  f.onChange(check);
  check();
  setTimeout(f.focus, 0);
  go.addEventListener('click', function () {
    var write = f.values();
    if (!write) { return; }
    go.disabled = true;
    done(write).catch(function (err) {
      go.disabled = false;
      ui.toast('Not saved: ' + errText(err), 'error');
    });
  });
}

/** A template one setting away: enter the constants, then the station opens it. */
function openSetup(entry, template, needs) {
  var turnsOn = resolver.calculationPlan(entry.attrs, state.names).filter(function (p) {
    return !p.on && p.needs.every(function (a) { return needs.indexOf(a) >= 0; }) && template.channels.indexOf(p.name) >= 0;
  }).map(function (p) { return p.name; });
  setupDrawer(entry, 'Set up ' + template.title,
    template.title + ' shows ' + calc.listText(labelsOf(entry, turnsOn)) + ', calculated from this station\'s readings and the ' +
      (needs.length === 1 ? 'setting' : 'settings') + ' below.',
    needs, 'Save and assign', function (write) {
      write[DASHBOARD_KEY] = template.id;
      return calc.save(entry.station, write).then(function () {
        ui.closeDrawer();
        ui.toast(entry.station.name + ' opens ' + template.title);
        return refresh();
      });
    }, function () { openAssign(entry); });
}

function assign(entry, template) {
  tb.saveAttrs(entry.station, { 'config.stationDashboard': template.id }).then(function () {
    ui.closeDrawer();
    ui.toast(entry.station.name + ' opens ' + template.title);
    return refresh();
  }).catch(function (err) { ui.toast('Not saved: ' + errText(err), 'error'); });
}

function channelList(entry) {
  return stationChannels(entry).filter(function (c) {
    return !(state.names[resolver.splitChannelKey(c).name] || {}).diagnostic;
  }).map(function (c) {
    var base = state.names[resolver.splitChannelKey(c).name] || {};
    return { key: c, label: entry.attrs['effective.' + c + '.label'] || base.label || c, unit: entry.attrs['effective.' + c + '.unit'] || '' };
  });
}

function openCreate(entry, use) {
  var channels = channelList(entry);
  var dr = ui.openDrawer('Create template', esc(entry.station.name));
  var form = h('<div><div class="ts-field"><label class="ts-field-label">Name</label><div class="ts-proj-name">' +
    '<span class="ts-row-meta">Station · </span><input class="ts-input wide" placeholder="River level"></div>' +
    '<div class="ts-field-hint">What kind of station it shows, so the next station of that kind can reuse it.</div></div>' +
    '<div class="ts-section-head">A value and a chart for each of</div><div class="ts-proj-chans"></div></div>');
  var input = form.querySelector('input');
  input.value = use || '';
  var list = form.querySelector('.ts-proj-chans');
  channels.forEach(function (c) {
    var row = h('<div class="ts-proj-chan"><span></span><span class="ts-mono"></span></div>');
    row.firstChild.textContent = c.label + (c.unit ? ' (' + c.unit + ')' : '');
    row.lastChild.textContent = c.key;
    list.appendChild(row);
  });
  if (!channels.length) { list.appendChild(h('<div class="ts-empty">The station maps no measurement yet.</div>')); }
  var waiting = resolver.calculationPlan(entry.attrs, state.names).filter(function (p) { return !p.on; });
  if (waiting.length) {
    form.appendChild(h('<div class="ts-section-head ts-proj-waiting">Calculated, once a setting is entered</div>'));
    waiting.forEach(function (p) {
      var row = h('<div class="ts-proj-chan" data-calc-name="' + esc(p.name) + '"><span></span><button type="button" class="ts-btn ghost">Enter</button></div>');
      row.firstChild.textContent = calc.channelLabel(calcMeta(), entry.attrs, p.name) + ' — needs ' + calc.listText(attrLabels(p.needs));
      row.querySelector('button').addEventListener('click', function () {
        var typed = input.value;
        setupDrawer(entry, 'Calculated measurement', calc.channelLabel(calcMeta(), entry.attrs, p.name) + ' is calculated from this station\'s readings and the ' +
          (p.needs.length === 1 ? 'setting' : 'settings') + ' below.', p.needs, 'Save', function (write) {
          return calc.save(entry.station, write).then(function () { return tb.attrsMap(entry.station); }).then(function (attrs) {
            entry.attrs = attrs;
            openCreate(entry, typed);
          });
        }, function () { openCreate(entry, typed); });
      });
      form.appendChild(row);
    });
  }
  var tenant = state.me.authority === 'TENANT_ADMIN';
  var choose = tenant && state.owner.entityType === 'CUSTOMER';
  form.appendChild(h('<div class="ts-row-meta">The template opens in ThingsBoard afterwards, to arrange as you like. ' +
    (choose ? '' : tenant ? 'It is saved with the in-terra templates, shared with every customer.' : 'Only your organisation sees it.') + '</div>'));
  if (choose) {
    var where = h('<div class="ts-field ts-proj-tplgroup"><label class="ts-switch"><input type="radio" name="ts-tpl-group" value="tenant" checked>' +
      ' With the in-terra templates, shared with every customer</label><label class="ts-switch"><input type="radio" name="ts-tpl-group" value="owner">' +
      ' <span></span></label></div>');
    where.querySelector('span').textContent = 'With the templates of ' + state.ownerName + ', which only it sees';
    form.appendChild(ui.tenantSection(where));
  }
  dr.body.appendChild(form);
  dr.onBack(function () { openAssign(entry); });
  var go = ui.drawerActions(dr, 'Create');
  go.disabled = !channels.length;
  setTimeout(function () { input.focus(); }, 0);
  go.addEventListener('click', function () {
    var use = input.value.trim();
    if (!use) { input.focus(); return; }
    go.disabled = true;
    var toOwner = choose && form.querySelector('[name=ts-tpl-group]:checked').value === 'owner';
    createTemplate(entry, use, channels, toOwner ? state.owner : null).then(function (dashboardId) {
      ui.closeDrawer();
      openDashboard(dashboardId, 'station', entry.station);
    }).catch(function (err) {
      go.disabled = false;
      ui.toast('Template not created: ' + errText(err), 'error');
    });
  });
}

/** The template group of `owner`, else the user's own — the tenant's for a tenant admin. */
function templateGroup(owner) {
  var me = state.me;
  owner = owner || (me.authority === 'TENANT_ADMIN' ? { entityType: 'TENANT', id: me.tenantId.id } : { entityType: 'CUSTOMER', id: me.customerId.id });
  return tb.get('/api/entityGroup/' + owner.entityType + '/' + owner.id + '/DASHBOARD/' + encodeURIComponent(TEMPLATE_GROUP))
    .catch(function () { return tb.post('/api/entityGroup', { type: 'DASHBOARD', name: TEMPLATE_GROUP, ownerId: owner }); });
}

function jsonText(v) { return JSON.stringify(String(v)).slice(1, -1); }

/** The starter's configuration with its placeholder widgets repeated per channel,
 * one band of rows each, and its own id replaced by `dashboardId`. */
function expandStarter(starter, dashboardId, use, channels) {
  var text = JSON.stringify(starter.configuration).split(starter.id.id).join(dashboardId).split(STARTER_USE).join(jsonText(use));
  var conf = JSON.parse(text);
  var placeholders = Object.keys(conf.widgets).filter(function (id) { return JSON.stringify(conf.widgets[id]).indexOf(PLACEHOLDER.channel) >= 0; });
  var layout = conf.states.station.layouts.main.widgets;
  var top = Math.min.apply(null, placeholders.map(function (id) { return layout[id].row; }));
  var band = Math.max.apply(null, placeholders.map(function (id) { return layout[id].row + layout[id].sizeY; })) - top;
  channels.forEach(function (c, i) {
    placeholders.forEach(function (id) {
      var copy = JSON.stringify(conf.widgets[id]).split(PLACEHOLDER.channel).join(jsonText(c.key))
        .split(PLACEHOLDER.label).join(jsonText(c.label)).split(PLACEHOLDER.unit).join(jsonText(c.unit));
      var wid = uuid(), widget = JSON.parse(copy);
      widget.id = wid;
      conf.widgets[wid] = widget;
      layout[wid] = Object.assign({}, layout[id], { row: layout[id].row + i * band });
    });
  });
  placeholders.forEach(function (id) { delete conf.widgets[id]; delete layout[id]; });
  return conf;
}

function createTemplate(entry, use, channels, owner) {
  var title = 'Station · ' + use;
  return Promise.all([
    tb.get('/api/user/dashboards', { pageSize: '50', page: '0', textSearch: STARTER_TITLE }),
    templateGroup(owner)
  ]).then(function (got) {
    var info = ((got[0] && got[0].data) || []).filter(function (d) { return d.title === STARTER_TITLE; })[0];
    if (!info) { throw new Error('the dashboard "' + STARTER_TITLE + '" is not visible to you'); }
    var group = got[1];
    return Promise.all([
      tb.get('/api/dashboard/' + info.id.id),
      tb.post('/api/dashboard?entityGroupId=' + group.id.id, { title: title, configuration: {} })
    ]);
  }).then(function (got) {
    var created = got[1];
    created.configuration = expandStarter(got[0], created.id.id, use, channels);
    return tb.post('/api/dashboard', created);
  }).then(function (saved) {
    state.templates = null;
    return tb.saveAttrs(entry.station, { 'config.stationDashboard': saved.id.id }).then(function () { return saved.id.id; });
  });
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
      }),
      state.me.authority === 'TENANT_ADMIN' && state.owner.entityType === 'CUSTOMER'
        ? tb.get('/api/customer/' + state.owner.id).then(function (c) { state.ownerName = c.title || c.name; }) : null
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
