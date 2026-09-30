/*
 * Project — a project's locations on a map and its stations in a list, each
 * station with its state and the age of its last reading (EU-1). A station
 * opens its station view, and its charts on its own station dashboard; an
 * editor assigns one, or creates a template for it, and places, renames and
 * deletes locations, and places the project area and stations. A gear opens
 * the Settings view of the project or of a location.
 * Widget: logr-product-docs/cloud/FRONTEND.md *Project dashboard*.
 *
 * `opts`, set by build_project_dashboard.py: `projectDashboardId` (its Station
 * and Settings views; checked for public access).
 *
 * Loads after shared/resolver.js, glossary.js, ui.js and tb_io.js; loads
 * Leaflet and Leaflet-Geoman itself.
 */

window.TerrySenseProjectOverview = function (ctx, container, opts) {

opts = opts || {};
var resolver = window.TerrySenseResolver;
var G = window.TerrySenseGlossary;
var tb = window.TerrySenseTbIo(ctx);
var root = container.querySelector('.ts-root') || container;
var ui = window.TerrySenseUi(root);
var h = ui.h, esc = ui.esc, ICON = ui.ICON;

var REFRESH_MS = 60000;
var MAX_DEPTH = 4;
var HOUR = 3600000;
var LEAFLET = 'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/';
var GEOMAN = 'https://cdn.jsdelivr.net/npm/@geoman-io/leaflet-geoman-free@2.17.0/dist/';
var SWISSTOPO = 'https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.';
var TEMPLATE_GROUP = 'Station dashboards';
var STARTER_TITLE = 'Station (starter)';
var STARTER_USE = 'New template';
var PLACEHOLDER = { channel: '__CHANNEL__', label: '__LABEL__', unit: '__UNIT__' };
var DASHBOARD_KEY = 'config.stationDashboard';
var HOME_KEY = 'config.homeDashboard';
var NO_LOCATION = '';
var STATUS = {
  stale: { label: 'Stale', color: 'var(--ts-stale)', rank: 3 },
  nodata: { label: 'No data', color: 'var(--ts-nodata)', rank: 2 },
  ok: { label: 'OK', color: 'var(--ts-ok)', rank: 1 },
  none: { label: 'No station', color: 'var(--ts-nodata)', rank: 0 }
};
var ICON_HOME = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/></svg>';
var ICON_LOCK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>';
var ICON_GLOBE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>';
var ICON_CHART = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19h16"/><path d="M5 15l4-5 4 3 6-7"/></svg>';
var ICON_TRASH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>';
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
  var css = Promise.all([loadOnce('link', LEAFLET + 'leaflet.css'), loadOnce('link', GEOMAN + 'leaflet-geoman.css')]);
  var leaflet = window.L && window.L.version && window.L.version >= '1.9' ? Promise.resolve() : loadOnce('script', LEAFLET + 'leaflet.js');
  return Promise.all([css, leaflet.then(function () {
    return window.L.PM ? null : loadOnce('script', GEOMAN + 'leaflet-geoman.js');
  })]);
}

var openDashboard = tb.openDashboard;

// -- data --------------------------------------------------------------------------------

var state = {
  entity: null, owner: null, names: {}, projectAttrs: {}, locations: [], stations: [], loadedAt: 0,
  canEdit: false, canCreateDashboards: false, editMap: false, filter: null, placing: null,
  publicReport: null, templates: null
};

function loadNames() {
  return tb.io.fetchDefaults().then(function (d) { return d ? tb.attrsMap(d) : {}; }).then(function (a) {
    state.names = parseJson(a['config.channelNames']) || {};
  });
}

/** Locations and stations below the bound entity over `Contains`. A station
 * belongs to its nearest location, or to none. */
function walkTree(entity) {
  var locations = [], stations = [];
  function walk(level, location, path, depth) {
    if (depth > MAX_DEPTH) { return Promise.resolve(); }
    return tb.io.fetchChildren(level).then(function (children) {
      return Promise.all(children.map(function (c) {
        if (c.kind === 'Station') { stations.push({ station: c, parent: level, locationId: location ? location.id : NO_LOCATION }); return null; }
        if (c.kind !== 'Location') { return null; }
        var loc = { entity: c, id: c.id, name: path ? path + ' › ' + c.name : c.name, parent: level };
        locations.push(loc);
        return walk(c, loc, loc.name, depth + 1);
      }));
    });
  }
  return walk(entity, null, '', 0).then(function () { return { locations: locations, stations: stations }; });
}

function loadLocation(loc) {
  return tb.attrsMap(loc.entity).then(function (a) {
    var lat = Number(a.latitude), lng = Number(a.longitude);
    loc.latLng = a.latitude != null && a.longitude != null && isFinite(lat) && isFinite(lng) ? [lat, lng] : null;
    return loc;
  });
}

function loadStation(entry) {
  var s = entry.station, url = '/api/plugins/telemetry/ASSET/' + s.id + '/values/timeseries';
  return tb.attrsMap(s).then(function (attrs) {
    entry.attrs = attrs;
    entry.dashboardId = attrs[DASHBOARD_KEY] || null;
    entry.staleAfterMs = Number(attrs['effective.staleAfterHours']) * HOUR || 0;
    var keys = Object.keys(((parseJson(attrs['config.channelMap']) || {}).channels) || {});
    return Promise.all([
      keys.length ? tb.get(url, { keys: keys.join(',') }).catch(function () { return {}; }) : {},
      tb.get('/api/alarm/ASSET/' + s.id, { searchStatus: 'ACTIVE', pageSize: '100', page: '0' }).catch(function () { return null; })
    ]);
  }).then(function (got) {
    entry.lastTs = Object.keys(got[0] || {}).reduce(function (m, k) {
      var p = got[0][k] && got[0][k][0];
      return p && p.value !== null && p.value !== undefined ? Math.max(m, Number(p.ts)) : m;
    }, 0);
    entry.alarms = (got[1] && got[1].data) || [];
    entry.status = statusOf(entry);
    return entry;
  });
}

function load() {
  var e = state.entity;
  var tree = walkTree(e);
  return Promise.all([tree, tb.attrsMap(e)]).then(function (got) {
    state.projectAttrs = got[1];
    return Promise.all([
      Promise.all(got[0].locations.map(loadLocation)),
      Promise.all(got[0].stations.map(loadStation))
    ]);
  }).then(function (got) {
    state.locations = got[0].sort(function (a, b) { return a.name.localeCompare(b.name); });
    state.stations = got[1].sort(function (a, b) { return a.station.name.localeCompare(b.station.name); });
    state.loadedAt = Date.now();
  });
}

// -- model -------------------------------------------------------------------------------

function statusOf(entry) {
  var worst = entry.alarms.reduce(function (w, a) {
    return !w || G.rank(a.severity.toLowerCase()) > G.rank(w.toLowerCase()) ? a.severity : w;
  }, null);
  if (worst) {
    var id = worst.toLowerCase();
    return { id: 'alarm', label: G.severity(id).label, color: 'var(--sev-' + id + ')', rank: 10 + G.rank(id) };
  }
  if (!entry.lastTs) { return Object.assign({ id: 'nodata' }, STATUS.nodata); }
  if (entry.staleAfterMs && Date.now() - entry.lastTs > entry.staleAfterMs) { return Object.assign({ id: 'stale' }, STATUS.stale); }
  return Object.assign({ id: 'ok' }, STATUS.ok);
}

function worstOf(entries) {
  return entries.reduce(function (w, s) { return !w || s.status.rank > w.rank ? s.status : w; }, null) || STATUS.none;
}

function stationsAt(locationId) {
  return state.stations.filter(function (s) { return s.locationId === locationId; });
}

function locationById(id) { return state.locations.filter(function (l) { return l.id === id; })[0] || null; }

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
  '    <div class="ts-head-text"><div class="ts-title">Project</div><div class="ts-subtitle"></div></div>' +
  '    <span class="ts-proj-public" tabindex="0" hidden></span><span class="ts-proj-worst"></span>' +
  '    <button type="button" class="ts-btn ts-proj-home" hidden>' + ICON_HOME + ' Project dashboard</button>' +
  '    <button type="button" class="ts-btn ts-proj-edit" hidden>Edit map</button>' +
  '    <button type="button" class="ts-icon-btn ts-proj-gear" hidden title="Settings">' + ICON.gear + '</button></div>' +
  '  <div class="ts-proj-split"><div class="ts-proj-map"></div><div class="ts-proj-list"><div class="ts-loading">Loading…</div></div></div>' +
  '  <div class="ts-foot"><span class="ts-row-meta ts-proj-updated"></span><span class="ts-spacer"></span>' +
  '    <button type="button" class="ts-btn ts-proj-refresh">Refresh</button></div>' +
  '</div>');
root.appendChild(cardEl);
var mapEl = cardEl.querySelector('.ts-proj-map');
var listEl = cardEl.querySelector('.ts-proj-list');
var publicEl = cardEl.querySelector('.ts-proj-public');
var editBtn = cardEl.querySelector('.ts-proj-edit');
var gearBtn = cardEl.querySelector('.ts-proj-gear');
var homeBtn = cardEl.querySelector('.ts-proj-home');
var refreshBtn = cardEl.querySelector('.ts-proj-refresh');

new ResizeObserver(function () {
  cardEl.classList.toggle('narrow', cardEl.clientWidth < 720);
  if (map) { map.invalidateSize(); }
}).observe(cardEl);

function fail(text) {
  listEl.innerHTML = '';
  listEl.appendChild(h('<div class="ts-empty"></div>')).textContent = text;
}

// -- map ---------------------------------------------------------------------------------

var map = null, markerLayer = null, areaLayer = null, markers = {}, fitted = false;

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
  markerLayer = L.layerGroup().addTo(map);
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
  markerLayer.clearLayers();
  markers = {};
  var bounds = [];
  state.locations.forEach(function (loc) {
    if (!loc.latLng) { return; }
    var here = stationsAt(loc.id), worst = worstOf(here);
    var icon = L.divIcon({ className: 'ts-pin-wrap', iconSize: [26, 26], iconAnchor: [13, 13],
      html: '<span class="ts-pin" style="--c:' + worst.color + '"><b>' + here.length + '</b></span>' });
    var m = L.marker(loc.latLng, { icon: icon, draggable: state.editMap, keyboard: true, title: loc.name, pmIgnore: true }).addTo(markerLayer);
    m.bindTooltip(esc(loc.name) + ' · ' + here.length + (here.length === 1 ? ' station' : ' stations') + ' · ' + esc(worst.label), { direction: 'top', offset: [0, -12] });
    m.on('click', function (ev) {
      L.DomEvent.stopPropagation(ev);
      state.filter = state.filter === loc.id ? null : loc.id;
      renderList();
      drawMarkers();
    });
    m.on('dragend', function () {
      var p = m.getLatLng();
      savePosition(loc, [p.lat, p.lng]);
    });
    m.on('add', function () { dropTarget(m.getElement(), loc.id); });
    if (m.getElement()) { dropTarget(m.getElement(), loc.id); }
    if (state.filter === loc.id) { m.getElement() && m.getElement().classList.add('selected'); }
    markers[loc.id] = m;
    bounds.push(loc.latLng);
  });
  if (areaLayer) { bounds = bounds.concat(areaLayer.getLatLngs()[0].map(function (p) { return [p.lat, p.lng]; })); }
  if (!fitted && bounds.length) {
    fitted = true;
    if (bounds.length === 1) { map.setView(bounds[0], 15); } else { map.fitBounds(bounds, { padding: [30, 30], maxZoom: 16 }); }
  }
}

function highlight(locationId, on) {
  var m = markers[locationId];
  if (m && m.getElement()) { m.getElement().classList.toggle('hover', on); }
}

function setEditMap(on) {
  state.editMap = on;
  editBtn.textContent = on ? 'Done' : 'Edit map';
  editBtn.classList.toggle('primary', on);
  cardEl.classList.toggle('editing', on);
  state.placing = null;
  if (on) {
    map.pm.addControls({ position: 'topleft', drawMarker: false, drawCircleMarker: false, drawPolyline: false,
      drawRectangle: false, drawCircle: false, drawText: false, cutPolygon: false, rotateMode: false,
      dragMode: false, drawPolygon: true, editMode: true, removalMode: true });
    ui.toast('Click the map to add a location; drag a pin to move it; drag a station onto a location');
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
  if (!state.editMap || map.pm.globalDrawModeEnabled() || map.pm.globalEditModeEnabled() || map.pm.globalRemovalModeEnabled()) { return; }
  var latLng = [ev.latlng.lat, ev.latlng.lng];
  if (state.placing) {
    var loc = locationById(state.placing);
    state.placing = null;
    cardEl.classList.remove('placing');
    savePosition(loc, latLng);
    return;
  }
  newLocationPopup(ev.latlng);
}

function newLocationPopup(latlng) {
  var form = h('<form class="ts-proj-newloc"><div class="ts-field-label">New location here</div>' +
    '<input class="ts-input" placeholder="Location name" required><div class="ts-confirm-actions">' +
    '<button type="submit" class="ts-btn primary">Create</button></div></form>');
  var popup = window.L.popup({ closeButton: true, minWidth: 220 }).setLatLng(latlng).setContent(form).openOn(map);
  var input = form.querySelector('input');
  setTimeout(function () { input.focus(); }, 0);
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var name = input.value.trim();
    if (!name) { return; }
    form.querySelector('button').disabled = true;
    createLocation(name, [latlng.lat, latlng.lng]).then(function () {
      map.closePopup(popup);
    }).catch(function (err) {
      form.querySelector('button').disabled = false;
      ui.toast('Location not created: ' + errText(err), 'error');
    });
  });
}

function createLocation(name, latLng) {
  var owner = state.owner;
  var body = { name: name, type: 'Location' };
  if (owner.entityType === 'CUSTOMER') { body.customerId = owner; }
  return tb.post('/api/asset', body).then(function (asset) {
    return tb.post('/api/relation', { from: { entityType: 'ASSET', id: state.entity.id }, to: asset.id, type: 'Contains', typeGroup: 'COMMON' })
      .then(function () { return tb.saveAttrs({ entityType: 'ASSET', id: asset.id.id }, { latitude: latLng[0], longitude: latLng[1] }); });
  }).then(function () {
    ui.toast('Location "' + name + '" created');
    return refresh();
  });
}

function savePosition(loc, latLng) {
  tb.saveAttrs(loc.entity, { latitude: latLng[0], longitude: latLng[1] }).then(function () {
    loc.latLng = latLng;
    ui.toast(loc.name + ' placed');
    drawMarkers();
    renderList();
  }).catch(function (err) { ui.toast('Position not saved: ' + errText(err), 'error'); drawMarkers(); });
}

function renameLocation(loc) {
  var dr = ui.openDrawer('Rename location', esc(loc.entity.name));
  dr.body.appendChild(h('<div class="ts-field"><div class="ts-field-label"><span>Name</span></div>' +
    '<div class="ts-ctl"><input class="ts-input" type="text" data-f="name"></div></div>'));
  var input = dr.body.querySelector('[data-f=name]');
  input.value = loc.entity.name;
  ui.drawerActions(dr, 'Save').addEventListener('click', function () {
    var name = input.value.trim();
    if (!name || name === loc.entity.name) { ui.closeDrawer(); return; }
    tb.getAsset(loc.id).then(function (asset) {
      asset.name = name;
      return tb.post('/api/asset', asset);
    }).then(function () {
      ui.toast('Location renamed');
      ui.closeDrawer();
      return refresh();
    }).catch(function (err) { ui.toast('Not renamed: ' + errText(err), 'error'); });
  });
}

/** The stations below `loc`, in its sub-locations too. */
function stationsBelow(loc) {
  function inside(l) { return !!l && (l.id === loc.id || inside(locationById(l.parent && l.parent.id))); }
  return state.stations.filter(function (s) { return inside(locationById(s.locationId)); });
}

/** Delete a location; what it contains moves up to its parent first, and the
 * stations below it re-resolve, since they now inherit from another place. */
function deleteLocation(loc) {
  var parent = loc.parent, below = stationsBelow(loc);
  ui.confirm('Delete location <b>' + esc(loc.entity.name) + '</b>?' + (below.length
    ? ' Its ' + below.length + (below.length === 1 ? ' station moves' : ' stations move') + ' to <b>' + esc(parent.name) +
      '</b> and inherit its settings: thresholds, units, texts and contacts.' : ''), 'Delete').then(function (ok) {
    if (!ok) { return null; }
    return tb.io.fetchChildren(loc.entity).then(function (children) {
      return Promise.all(children.map(function (c) {
        return tb.post('/api/relation', { from: { entityType: 'ASSET', id: parent.id }, to: { entityType: 'ASSET', id: c.id },
          type: 'Contains', typeGroup: 'COMMON' });
      }));
    }).then(function () {
      return tb.del('/api/asset/' + loc.id);
    }).then(function () {
      return tb.resolveStations(below.map(function (s) { return s.station; }));
    }).then(function () {
      if (state.filter === loc.id) { state.filter = null; }
      ui.toast('Location deleted');
      return refresh();
    });
  }).catch(function (err) { ui.toast('Location not deleted: ' + errText(err), 'error'); });
}

// -- moving a station --------------------------------------------------------------------

var dragged = null;

function dropTarget(el, locationId) {
  if (!el || el.getAttribute('data-drop')) { return; }
  el.setAttribute('data-drop', '1');
  el.addEventListener('dragover', function (e) { if (dragged) { e.preventDefault(); el.classList.add('drop'); } });
  el.addEventListener('dragleave', function () { el.classList.remove('drop'); });
  el.addEventListener('drop', function (e) {
    e.preventDefault();
    el.classList.remove('drop');
    if (dragged) { moveStation(dragged, locationId); }
  });
}

function moveStation(entry, locationId) {
  if (entry.locationId === locationId) { return; }
  var target = locationId === NO_LOCATION ? state.entity : locationById(locationId).entity;
  var where = locationId === NO_LOCATION ? 'directly under ' + esc(state.entity.name) : 'to ' + esc(target.name);
  ui.confirm('Move <b>' + esc(entry.station.name) + '</b> ' + where + '? It then inherits the settings of its new place: thresholds, units, texts and contacts.', 'Move')
    .then(function (ok) {
      if (!ok) { return null; }
      var s = entry.station;
      return tb.io.fetchParent(s).then(function (parent) {
        return parent ? tb.del('/api/relation', { fromId: parent.id, fromType: 'ASSET', relationType: 'Contains',
          relationTypeGroup: 'COMMON', toId: s.id, toType: 'ASSET' }) : null;
      }).then(function () {
        return tb.post('/api/relation', { from: { entityType: 'ASSET', id: target.id }, to: { entityType: 'ASSET', id: s.id },
          type: 'Contains', typeGroup: 'COMMON' });
      }).then(function () {
        return tb.resolveStations([s]);
      }).then(function () {
        ui.toast(s.name + ' moved');
        return refresh();
      });
    }).catch(function (err) { ui.toast('Station not moved: ' + errText(err), 'error'); });
}

// -- list --------------------------------------------------------------------------------

function renderHeader() {
  var e = state.entity;
  cardEl.querySelector('.ts-subtitle').textContent = e.name + (' · ' + state.stations.length +
    (state.stations.length === 1 ? ' station' : ' stations'));
  var worstEl = cardEl.querySelector('.ts-proj-worst');
  worstEl.innerHTML = '';
  if (state.stations.length) { worstEl.appendChild(chip(worstOf(state.stations))); }
  cardEl.querySelector('.ts-proj-updated').textContent = 'Updated ' + fmtTime(state.loadedAt);
  editBtn.hidden = !state.canEdit || !map;
  gearBtn.hidden = tb.isPublicView();
  homeBtn.hidden = !state.projectAttrs[HOME_KEY];
}

function renderList() {
  listEl.innerHTML = '';
  if (!state.stations.length && !state.locations.length) {
    fail('No station in this project yet.' + (state.canEdit && map ? ' Use Edit map to add a location.' : ''));
    return;
  }
  if (state.filter) {
    var bar = h('<div class="ts-proj-filter"><span></span><button type="button" class="ts-icon-btn" title="Show every location">' + ICON.close + '</button></div>');
    bar.querySelector('span').textContent = 'Showing ' + locationById(state.filter).name;
    bar.querySelector('button').addEventListener('click', function () { state.filter = null; renderList(); drawMarkers(); });
    listEl.appendChild(bar);
  }
  var groups = state.locations.map(function (l) { return { id: l.id, name: l.name, loc: l }; });
  groups.push({ id: NO_LOCATION, name: 'No location', loc: null });
  groups.forEach(function (g) {
    if (state.filter && state.filter !== g.id) { return; }
    var here = stationsAt(g.id);
    if (!g.loc && !here.length && !state.canEdit) { return; }
    var card = listEl.appendChild(h('<div class="ts-proj-loc' + (g.loc ? '' : ' unplaced') + '"></div>'));
    card.appendChild(groupHead(g, here));
    var body = card.appendChild(h('<div class="ts-proj-loc-body"></div>'));
    here.forEach(function (entry) { body.appendChild(stationRow(entry)); });
    if (!here.length) {
      body.appendChild(h('<div class="ts-row-meta ts-proj-none"></div>')).textContent = g.loc ? 'No station here yet.' : 'Drop a station here to take it out of its location.';
    }
    if (state.canEdit) { dropTarget(card, g.id); }
  });
}

function groupHead(g, here) {
  var el = h('<div class="ts-proj-group"><span class="ts-proj-group-icon">' + (g.loc ? ICON.map : ICON_UNPLACE) + '</span>' +
    '<span class="ts-proj-group-name"></span><span class="ts-count"></span><span class="ts-spacer"></span></div>');
  el.querySelector('.ts-proj-group-name').textContent = g.name;
  el.querySelector('.ts-count').textContent = here.length;
  if (g.loc && !g.loc.latLng) {
    el.appendChild(h('<span class="ts-row-meta">not on the map</span>'));
  }
  if (g.loc && state.editMap) {
    var place = h('<button type="button" class="ts-btn ghost">' + (g.loc.latLng ? 'Move pin' : 'Place') + '</button>');
    place.addEventListener('click', function () {
      state.placing = g.id;
      cardEl.classList.add('placing');
      ui.toast('Click the map where ' + g.loc.name + ' is');
    });
    el.appendChild(place);
    var rename = h('<button type="button" class="ts-icon-btn" data-a="rename" title="Rename">' + ICON.edit + '</button>');
    rename.addEventListener('click', function () { renameLocation(g.loc); });
    el.appendChild(rename);
    var remove = h('<button type="button" class="ts-icon-btn" data-a="delete" title="Delete">' + ICON_TRASH + '</button>');
    remove.addEventListener('click', function () { deleteLocation(g.loc); });
    el.appendChild(remove);
  }
  if (here.length) { el.appendChild(chip(worstOf(here))); }
  if (g.loc && !tb.isPublicView()) {
    var gear = h('<button type="button" class="ts-icon-btn" data-a="settings" title="Settings of this location">' + ICON.gear + '</button>');
    gear.addEventListener('click', function () { openDashboard(opts.projectDashboardId, 'settings', g.loc); });
    el.appendChild(gear);
  }
  if (g.loc) {
    el.addEventListener('mouseenter', function () { highlight(g.id, true); });
    el.addEventListener('mouseleave', function () { highlight(g.id, false); });
  }
  return el;
}

function lastReading(entry) {
  return entry.lastTs ? 'Last reading ' + ago(entry.lastTs) : 'No reading yet';
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
  var el = h('<div class="ts-proj-st" tabindex="0"><div class="ts-proj-st-main"><div class="ts-proj-st-name"></div>' +
    '<div class="ts-row-meta"></div></div><div class="ts-proj-st-side"></div></div>');
  el.setAttribute('data-station', entry.station.name);
  el.querySelector('.ts-proj-st-name').textContent = entry.station.name;
  el.querySelector('.ts-row-meta').textContent = lastReading(entry);
  var side = el.querySelector('.ts-proj-st-side');
  var pub = state.canEdit && publicState(entry);
  if (pub) { side.appendChild(publicIcon(pub)); }
  side.appendChild(chip(entry.status));
  // The row opens the station view; without one, its charts.
  var view = opts.projectDashboardId ? [opts.projectDashboardId, 'station'] : entry.dashboardId ? [entry.dashboardId, 'station'] : null;
  if (view) {
    el.classList.add('linked');
    el.addEventListener('click', function (e) { if (!e.target.closest('button')) { openDashboard(view[0], view[1], entry.station); } });
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
    var assign = h('<button type="button" class="ts-icon-btn" title="' + (entry.dashboardId ? 'Change dashboard' : 'Assign dashboard') + '">' +
      (entry.dashboardId ? ICON.edit : ICON.plus) + '</button>');
    assign.addEventListener('click', function () { openAssign(entry); });
    side.appendChild(assign);
    if (entry.locationId !== NO_LOCATION) {
      var unplace = h('<button type="button" class="ts-icon-btn" title="Take out of its location">' + ICON_UNPLACE + '</button>');
      unplace.addEventListener('click', function () { moveStation(entry, NO_LOCATION); });
      side.appendChild(unplace);
    }
    el.draggable = true;
    el.addEventListener('dragstart', function (e) {
      dragged = entry;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', entry.station.name);
      cardEl.classList.add('dragging');
    });
    el.addEventListener('dragend', function () { dragged = null; cardEl.classList.remove('dragging'); });
  }
  el.addEventListener('mouseenter', function () { highlight(entry.locationId, true); });
  el.addEventListener('mouseleave', function () { highlight(entry.locationId, false); });
  return el;
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
    var locs = state.locations.filter(function (l) { return r.denied[l.id]; });
    if (locs.length) { lines.push(locs.length + (locs.length === 1 ? ' location is' : ' locations are') + ' in no public group'); }
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
        .concat(state.locations.map(function (l) { return ['asset', l.id]; }))
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

/** The channels a template's widgets bind on the station its state carries. */
function requiredChannels(dashboard) {
  var conf = dashboard.configuration || {};
  var aliases = conf.entityAliases || {};
  var stateAliases = Object.keys(aliases).filter(function (k) { return (aliases[k].filter || {}).type === 'stateEntity'; });
  var keys = {};
  Object.keys(conf.widgets || {}).forEach(function (wid) {
    ((conf.widgets[wid].config || {}).datasources || []).forEach(function (ds) {
      if (stateAliases.indexOf(ds.entityAliasId) < 0) { return; }
      (ds.dataKeys || []).forEach(function (k) { if (k.type === 'timeseries') { keys[k.name] = true; } });
    });
  });
  return Object.keys(keys);
}

/** Every template the user can read: the tenant's and the user's own. */
function loadTemplates() {
  if (state.templates) { return Promise.resolve(state.templates); }
  return tb.get('/api/entityGroups/DASHBOARD').then(function (groups) {
    var mine = (groups || []).filter(function (g) { return g.name === TEMPLATE_GROUP; });
    return Promise.all(mine.map(function (g) {
      return tb.get('/api/entityGroup/' + g.id.id + '/dashboards', { pageSize: '200', page: '0' }).then(function (page) {
        return Promise.all(((page && page.data) || []).map(function (d) {
          return tb.get('/api/dashboard/' + d.id.id).then(function (full) {
            return { id: d.id.id, title: d.title, tenant: g.ownerId.entityType === 'TENANT', channels: requiredChannels(full) };
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

function fitOf(template, have) {
  var missing = template.channels.filter(function (c) { return have.indexOf(c) < 0; });
  return { missing: missing, fits: template.channels.length > 0 && !missing.length };
}

function openAssign(entry) {
  var dr = ui.openDrawer('Station dashboard', esc(entry.station.name));
  dr.body.appendChild(h('<div class="ts-loading">Loading the templates…</div>'));
  loadTemplates().then(function (templates) {
    dr.body.innerHTML = '';
    var have = stationChannels(entry);
    var rows = templates.map(function (t) { return { t: t, fit: fitOf(t, have) }; }).sort(function (a, b) {
      return (b.fit.fits - a.fit.fits) || (a.fit.missing.length - b.fit.missing.length) || a.t.title.localeCompare(b.t.title);
    });
    dr.body.appendChild(h('<div class="ts-row-meta">A template fits when the station carries every measurement it shows.</div>'));
    if (!rows.length) { dr.body.appendChild(h('<div class="ts-empty">No template yet.</div>')); }
    rows.forEach(function (r) {
      var o = h('<div class="ts-opt" tabindex="0"><div class="ts-opt-main"><div class="ts-opt-label"></div><div class="ts-opt-desc"></div></div>' +
        '<div class="ts-opt-side"></div></div>');
      if (r.t.id === entry.dashboardId) { o.classList.add('selected'); }
      o.querySelector('.ts-opt-label').textContent = r.t.title;
      o.querySelector('.ts-opt-desc').textContent = r.fit.fits ? 'Shows ' + r.t.channels.join(', ')
        : r.t.channels.length ? 'Misses ' + r.fit.missing.join(', ') : 'Binds no measurement';
      var side = o.querySelector('.ts-opt-side');
      side.appendChild(h('<span class="ts-chip level">' + (r.t.tenant ? 'in-terra' : 'own') + '</span>'));
      if (r.fit.fits) { side.appendChild(h('<span class="ts-chip accent">fits</span>')); }
      o.addEventListener('click', function () { assign(entry, r.t, dr); });
      o.addEventListener('keydown', function (e) { if (e.key === 'Enter') { assign(entry, r.t, dr); } });
      dr.body.appendChild(o);
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

function assign(entry, template, dr) {
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

function openCreate(entry) {
  var channels = channelList(entry);
  var dr = ui.openDrawer('Create template', esc(entry.station.name));
  var form = h('<div><div class="ts-field"><label class="ts-field-label">Name</label><div class="ts-proj-name">' +
    '<span class="ts-row-meta">Station · </span><input class="ts-input wide" placeholder="River level"></div>' +
    '<div class="ts-field-hint">What kind of station it shows, so the next station of that kind can reuse it.</div></div>' +
    '<div class="ts-section-head">A value and a chart for each of</div><div class="ts-proj-chans"></div></div>');
  var input = form.querySelector('input');
  var list = form.querySelector('.ts-proj-chans');
  channels.forEach(function (c) {
    var row = h('<div class="ts-proj-chan"><span></span><span class="ts-mono"></span></div>');
    row.firstChild.textContent = c.label + (c.unit ? ' (' + c.unit + ')' : '');
    row.lastChild.textContent = c.key;
    list.appendChild(row);
  });
  if (!channels.length) { list.appendChild(h('<div class="ts-empty">The station maps no measurement yet.</div>')); }
  form.appendChild(h('<div class="ts-row-meta">The template opens in ThingsBoard afterwards, to arrange as you like. ' +
    (state.me.authority === 'TENANT_ADMIN' ? 'It is saved with the in-terra templates, shared with every customer.' : 'Only your organisation sees it.') + '</div>'));
  dr.body.appendChild(form);
  dr.onBack(function () { openAssign(entry); });
  var go = ui.drawerActions(dr, 'Create');
  go.disabled = !channels.length;
  setTimeout(function () { input.focus(); }, 0);
  go.addEventListener('click', function () {
    var use = input.value.trim();
    if (!use) { input.focus(); return; }
    go.disabled = true;
    createTemplate(entry, use, channels).then(function (dashboardId) {
      ui.closeDrawer();
      openDashboard(dashboardId, 'station', entry.station);
    }).catch(function (err) {
      go.disabled = false;
      ui.toast('Template not created: ' + errText(err), 'error');
    });
  });
}

/** The user's own template group — the tenant's for a tenant admin. */
function ownTemplateGroup() {
  var me = state.me;
  var owner = me.authority === 'TENANT_ADMIN' ? { entityType: 'TENANT', id: me.tenantId.id } : { entityType: 'CUSTOMER', id: me.customerId.id };
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

function createTemplate(entry, use, channels) {
  var title = 'Station · ' + use;
  return Promise.all([
    tb.get('/api/user/dashboards', { pageSize: '50', page: '0', textSearch: STARTER_TITLE }),
    ownTemplateGroup()
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

refreshBtn.addEventListener('click', function () { refresh().then(refreshPublic); });
editBtn.addEventListener('click', function () { setEditMap(!state.editMap); });
gearBtn.addEventListener('click', function () { openDashboard(opts.projectDashboardId, 'settings', state.entity); });
homeBtn.addEventListener('click', function () { openDashboard(state.projectAttrs[HOME_KEY]); });

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
      load()
    ]);
  }).then(function (got) {
    if (!got) { return; }
    state.canEdit = got[0] && !state.me.isPublic;
    render();
    timer = setInterval(refresh, REFRESH_MS);
    return refreshPublic();
  });
}).catch(function (err) { fail('Could not load: ' + errText(err)); });

};
