/*
 * Projects — every project the user can see, on a map and in a list, each with
 * its state (EU-1). A project's pin stands at the centre of its area, else at
 * the centre of its stations. Projects close together at the current zoom merge
 * into one cluster. A pin or a cluster filters the list; a row opens the
 * project's own project dashboard, else its Installation view. A list
 * spanning several owners is grouped by customer and filtered to one from the
 * list bar. A user who may create assets creates a project. Retired stations
 * count for no state.
 * Widget: logr-product-docs/cloud/FRONTEND.md *Projects dashboard*.
 *
 * `opts`, set by build_project_dashboard.py: `projectDashboardId` (its Installation views).
 *
 * Loads after shared/i18n.js, resolver.js, glossary.js, ui.js and tb_io.js; loads
 * Leaflet and Leaflet.markercluster itself.
 */

window.TerrySenseProjects = function (ctx, container, opts) {

opts = opts || {};
var G = window.TerrySenseGlossary;
var t = window.TerrySenseI18n(ctx);
var tb = window.TerrySenseTbIo(ctx);
var root = container.querySelector('.ts-root') || container;
var ui = window.TerrySenseUi(root);
var h = ui.h, esc = ui.esc, ICON = ui.ICON;

var REFRESH_MS = 300000;
var LEAFLET = 'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/';
var CLUSTER = 'https://cdn.jsdelivr.net/npm/leaflet.markercluster@1.5.3/dist/';
var SWISSTOPO = 'https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.';
var HOME_KEY = 'config.homeDashboard';
var STATUS = {
  ok: { id: 'ok', label: t('common.ok', 'OK'), color: 'var(--ts-ok)', rank: 1 },
  none: { id: 'none', label: t('common.noStation', 'No station'), color: 'var(--ts-nodata)', rank: 0 }
};
var ICON_UNPLACE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-6-5.3-6-11a6 6 0 0 1 10.6-3.8M18 10c0 2.3-1 4.6-2.3 6.5"/><path d="M4 4l16 16"/></svg>';

function service(name) { return ctx.$scope.$injector.get(ctx.servicesMap.get(name)); }

function parseJson(raw) {
  if (!raw) { return null; }
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (e) { return null; }
}

function errText(e) { return (e && e.error && e.error.message) || (e && e.message) || String(e); }

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
  var css = Promise.all([loadOnce('link', LEAFLET + 'leaflet.css'), loadOnce('link', CLUSTER + 'MarkerCluster.css')]);
  var leaflet = window.L && window.L.version && window.L.version >= '1.9' ? Promise.resolve() : loadOnce('script', LEAFLET + 'leaflet.js');
  return Promise.all([css, leaflet.then(function () {
    return window.L.MarkerClusterGroup ? null : loadOnce('script', CLUSTER + 'leaflet.markercluster.js');
  })]);
}

// -- data --------------------------------------------------------------------------------

var state = { projects: [], owners: {}, loadedAt: 0, canCreateAssets: false, me: {}, filter: null, search: '', owner: '', folded: {} };

function latLngOf(attrs) {
  var lat = Number(attrs.latitude), lng = Number(attrs.longitude);
  return attrs.latitude != null && attrs.longitude != null && isFinite(lat) && isFinite(lng) ? [lat, lng] : null;
}

function centre(points) {
  if (!points.length) { return null; }
  var sum = points.reduce(function (s, p) { return [s[0] + p[0], s[1] + p[1]]; }, [0, 0]);
  return [sum[0] / points.length, sum[1] / points.length];
}

function loadStation(station) {
  return Promise.all([
    tb.attrsMap(station),
    tb.get('/api/alarm/ASSET/' + station.id, { searchStatus: 'ACTIVE', pageSize: '100', page: '0' }).catch(function () { return null; })
  ]).then(function (got) {
    return { station: station, latLng: latLngOf(got[0]), alarms: (got[1] && got[1].data) || [], retired: tb.serviceOf(got[0]).retired };
  });
}

function ownerName(ownerId) {
  if (!ownerId || ownerId.entityType !== 'CUSTOMER') { return Promise.resolve('in-terra'); }
  if (!state.owners[ownerId.id]) {
    state.owners[ownerId.id] = tb.get('/api/customer/' + ownerId.id).then(function (c) { return c.title || c.name; })
      .catch(function () { return ''; });
  }
  return state.owners[ownerId.id];
}

function loadProject(asset) {
  var project = tb.assetLevel(asset);
  return Promise.all([tb.attrsMap(project), tb.io.fetchChildren(project), ownerName(asset.ownerId)]).then(function (got) {
    var stations = got[1].filter(function (c) { return c.kind === 'Station'; });
    return Promise.all([Promise.all(stations.map(loadStation)), tb.readableDashboard(got[0][HOME_KEY])]).then(function (more) {
      var entries = more[0];
      var area = parseJson(got[0].perimeter);
      area = Array.isArray(area) && area.length >= 3 ? area : null;
      var entry = { project: project, ownerId: asset.ownerId, owner: got[2], attrs: got[0], area: area, stations: entries,
        homeId: more[1] };
      entry.latLng = centre(area || entries.filter(function (s) { return s.latLng; }).map(function (s) { return s.latLng; }));
      entry.status = statusOf(entry);
      return entry;
    });
  });
}

function load() {
  return tb.getAll('/api/user/assets', { type: 'Project' }).then(function (assets) {
    return Promise.all(assets.map(loadProject));
  }).then(function (projects) {
    state.projects = projects.sort(function (a, b) { return a.project.name.localeCompare(b.project.name); });
    state.loadedAt = Date.now();
  });
}

// -- model -------------------------------------------------------------------------------

function inService(entry) { return entry.stations.filter(function (s) { return !s.retired; }); }

/** A project's state: the worst active alarm of its stations in service, else OK. */
function statusOf(entry) {
  if (!inService(entry).length) { return STATUS.none; }
  var worst = null;
  inService(entry).forEach(function (s) {
    s.alarms.forEach(function (a) {
      var id = a.severity.toLowerCase();
      if (!worst || G.rank(id) > G.rank(worst)) { worst = id; }
    });
  });
  if (!worst) { return STATUS.ok; }
  return { id: 'alarm', label: t.severity(worst, G.severity(worst).label), color: 'var(--sev-' + worst + ')', rank: 10 + G.rank(worst) };
}

function worstOf(entries) {
  return entries.reduce(function (w, p) { return !w || p.status.rank > w.rank ? p.status : w; }, null) || STATUS.none;
}

function inAlarm(entry) { return inService(entry).filter(function (s) { return s.alarms.length; }).length; }

function chip(status) {
  var el = h('<span class="ts-chip ts-proj-sev"></span>');
  el.style.setProperty('--c', status.color);
  el.textContent = status.label;
  return el;
}

function ownerKey(entry) { return entry.ownerId && entry.ownerId.entityType === 'CUSTOMER' ? entry.ownerId.id : 'tenant'; }

/** The owners of the projects, by name: `[{key, name, projects}]`. */
function owners() {
  var by = {};
  state.projects.forEach(function (p) {
    var k = ownerKey(p);
    (by[k] = by[k] || { key: k, name: p.owner, projects: [] }).projects.push(p);
  });
  return Object.keys(by).map(function (k) { return by[k]; }).sort(function (a, b) { return a.name.localeCompare(b.name); });
}

function manyOwners() { return owners().length > 1; }

/** The projects of the customer picked in the list bar, every one when none is. */
function visible() { return state.projects.filter(function (p) { return !state.owner || ownerKey(p) === state.owner; }); }

// -- scaffold ----------------------------------------------------------------------------

var cardEl = h(
  '<div class="ts-card ts-proj ts-projs">' +
  '  <div class="ts-head"><div class="ts-head-icon">' + ICON.map + '</div>' +
  '    <div class="ts-head-text"><div class="ts-title">' + esc(t('common.projects', 'Projects')) + '</div><div class="ts-subtitle"></div></div>' +
  '    <span class="ts-proj-worst"></span></div>' +
  '  <div class="ts-proj-split"><div class="ts-proj-map"></div><div class="ts-proj-list">' +
  '    <div class="ts-projs-bar"><div class="ts-search ts-projs-search">' + ICON.search + '<input class="ts-input" placeholder="' + esc(t('projects.search', 'Search projects')) + '"></div>' +
  '      <select class="ts-select ts-projs-owner" data-f="customer" title="' + esc(t('common.customer', 'Customer')) + '" hidden></select>' +
  '      <button type="button" class="ts-btn" data-a="new-project" hidden>' + ICON.plus + ' ' + esc(t('projects.new', 'New project')) + '</button></div>' +
  '    <div class="ts-projs-rows"><div class="ts-loading">' + esc(t('common.loading', 'Loading…')) + '</div></div></div></div>' +
  '  <div class="ts-foot"><span class="ts-row-meta ts-proj-updated"></span><span class="ts-spacer"></span>' +
  '    <button type="button" class="ts-btn ts-proj-refresh">' + esc(t('common.refresh', 'Refresh')) + '</button></div>' +
  '</div>');
root.appendChild(cardEl);
window.TerrySenseNav(ctx, tb, ui, cardEl, opts);
var mapEl = cardEl.querySelector('.ts-proj-map');
var listEl = cardEl.querySelector('.ts-projs-rows');
var searchEl = cardEl.querySelector('.ts-projs-search input');
var ownerEl = cardEl.querySelector('[data-f=customer]');
var refreshBtn = cardEl.querySelector('.ts-proj-refresh');
var newBtn = cardEl.querySelector('[data-a=new-project]');

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

function pinHtml(color, text) {
  return '<span class="ts-pin" style="--c:' + color + '"><b>' + esc(text) + '</b></span>';
}

function select(ids) {
  state.filter = ids;
  renderList();
  drawMarkers();
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
  var layers = {};
  layers[t('map.map', 'Map')] = osm;
  layers[t('map.swiss', 'Swiss map')] = swiss;
  layers[t('map.aerial', 'Aerial')] = aerial;
  L.control.layers(layers, null, { position: 'topright' }).addTo(map);
  areaLayer = L.layerGroup().addTo(map);
  clusterLayer = L.markerClusterGroup({
    showCoverageOnHover: false, maxClusterRadius: 40, zoomToBoundsOnClick: false,
    iconCreateFunction: function (cluster) {
      var entries = cluster.getAllChildMarkers().map(function (m) { return m.options.entry; });
      return L.divIcon({ className: 'ts-pin-wrap', iconSize: [30, 30], iconAnchor: [15, 15],
        html: pinHtml(worstOf(entries).color, String(entries.length)) });
    }
  }).addTo(map);
  clusterLayer.on('clusterclick', function (ev) {
    select(ev.layer.getAllChildMarkers().map(function (m) { return m.options.entry.project.id; }));
    ev.layer.zoomToBounds({ padding: [30, 30] });
  });
}

function toggle(entry) {
  var only = state.filter && state.filter.length === 1 && state.filter[0] === entry.project.id;
  select(only ? null : [entry.project.id]);
}

function drawMarkers() {
  var L = window.L;
  if (!map) { return; }
  clusterLayer.clearLayers();
  areaLayer.clearLayers();
  markers = {};
  var bounds = [];
  visible().forEach(function (entry) {
    if (!entry.latLng) { return; }
    var selected = state.filter && state.filter.length === 1 && state.filter[0] === entry.project.id;
    if (entry.area) {
      var poly = L.polygon(entry.area, { color: '#0277b7', weight: selected ? 3 : 1.5, fillOpacity: selected ? 0.12 : 0.04 });
      poly.on('click', function () { toggle(entry); });
      areaLayer.addLayer(poly);
    }
    var icon = L.divIcon({ className: 'ts-pin-wrap', iconSize: [22, 22], iconAnchor: [11, 11], html: pinHtml(entry.status.color, '') });
    var m = L.marker(entry.latLng, { icon: icon, keyboard: true, title: entry.project.name, entry: entry });
    m.bindTooltip(esc(entry.project.name) + ' · ' + esc(entry.status.label), { direction: 'top', offset: [0, -10] });
    m.on('click', function (ev) { L.DomEvent.stopPropagation(ev); toggle(entry); });
    clusterLayer.addLayer(m);
    if (selected && m.getElement()) { m.getElement().classList.add('selected'); }
    markers[entry.project.id] = m;
    bounds.push(entry.latLng);
  });
  if (!fitted && bounds.length) {
    fitted = true;
    if (bounds.length === 1) { map.setView(bounds[0], 13); } else { map.fitBounds(bounds, { padding: [30, 30], maxZoom: 14 }); }
  }
}

function highlight(projectId, on) {
  var m = markers[projectId];
  var el = m && (clusterLayer.getVisibleParent(m) || m).getElement();
  if (el) { el.classList.toggle('hover', on); }
}

// -- list --------------------------------------------------------------------------------

function renderHeader() {
  var shown = visible(), n = shown.length;
  cardEl.querySelector('.ts-subtitle').textContent = (n === 1 ? t('common.projectOne', '1 project') : t('projects.countMany', '{n} projects', { n: n })) +
    (state.owner && n ? t('projects.ofOwner', ' of {owner}', { owner: shown[0].owner }) : '');
  var worstEl = cardEl.querySelector('.ts-proj-worst');
  worstEl.innerHTML = '';
  if (n) { worstEl.appendChild(chip(worstOf(shown))); }
  cardEl.querySelector('.ts-proj-updated').textContent = t('common.updated', 'Updated {time}', { time: fmtTime(state.loadedAt) });
}

function matches(entry) {
  var q = state.search.trim().toLowerCase();
  return !q || entry.project.name.toLowerCase().indexOf(q) >= 0 || entry.owner.toLowerCase().indexOf(q) >= 0;
}

function renderList() {
  listEl.innerHTML = '';
  if (!state.projects.length) {
    fail(t('projects.none', 'No project to show.'));
    return;
  }
  var shown = visible().filter(function (p) { return (!state.filter || state.filter.indexOf(p.project.id) >= 0) && matches(p); });
  if (state.filter) {
    var bar = h('<div class="ts-proj-filter"><span></span><button type="button" class="ts-icon-btn" title="' + esc(t('projects.showAll', 'Show every project')) + '">' + ICON.close + '</button></div>');
    bar.querySelector('span').textContent = shown.length === 1 ? t('common.showingOne', 'Showing {name}', { name: shown[0].project.name })
      : t('projects.showingMany', 'Showing {n} projects', { n: shown.length });
    bar.querySelector('button').addEventListener('click', function () { select(null); });
    listEl.appendChild(bar);
  }
  if (!shown.length) {
    listEl.appendChild(h('<div class="ts-empty"></div>')).textContent = t('projects.noMatch', 'No project matches.');
    return;
  }
  if (manyOwners() && !state.owner) {
    owners().forEach(function (o) {
      var mine = shown.filter(function (p) { return ownerKey(p) === o.key; });
      if (mine.length) { listEl.appendChild(ownerGroup(o, mine)); }
    });
    return;
  }
  var placed = shown.filter(function (p) { return p.latLng; });
  var unplaced = shown.filter(function (p) { return !p.latLng; });
  if (placed.length) {
    var body = listEl.appendChild(h('<div class="ts-proj-loc"><div class="ts-proj-loc-body"></div></div>')).firstChild;
    placed.forEach(function (entry) { body.appendChild(projectRow(entry)); });
  }
  if (unplaced.length) {
    var card = listEl.appendChild(h('<div class="ts-proj-loc unplaced"></div>'));
    var head = card.appendChild(h('<div class="ts-proj-group"><span class="ts-proj-group-icon">' + ICON_UNPLACE + '</span>' +
      '<span class="ts-proj-group-name">' + esc(t('common.noPosition', 'No position')) + '</span><span class="ts-count"></span><span class="ts-spacer"></span></div>'));
    head.querySelector('.ts-count').textContent = unplaced.length;
    head.appendChild(chip(worstOf(unplaced)));
    var ubody = card.appendChild(h('<div class="ts-proj-loc-body"></div>'));
    unplaced.forEach(function (entry) { ubody.appendChild(projectRow(entry)); });
  }
}

/** One customer's projects, folding away; those with no position last, saying so. */
function ownerGroup(o, mine) {
  var el = h('<details class="ts-proj-loc ts-projs-group"><summary class="ts-proj-group"><span class="ts-chev">' + ICON.chev + '</span>' +
    '<span class="ts-proj-group-name"></span>' +
    '<span class="ts-count"></span><span class="ts-spacer"></span></summary><div class="ts-proj-loc-body"></div></details>');
  el.setAttribute('data-customer', o.name);
  el.open = !state.folded[o.key];
  el.addEventListener('toggle', function () { state.folded[o.key] = !el.open; });
  el.querySelector('.ts-proj-group-name').textContent = o.name;
  el.querySelector('.ts-count').textContent = mine.length;
  el.querySelector('summary').appendChild(chip(worstOf(mine)));
  var body = el.querySelector('.ts-proj-loc-body');
  mine.filter(function (p) { return p.latLng; }).concat(mine.filter(function (p) { return !p.latLng; }))
    .forEach(function (entry) { body.appendChild(projectRow(entry)); });
  return el;
}

function metaText(entry) {
  var n = inService(entry).length, gone = entry.stations.length - n, alarmed = inAlarm(entry);
  var parts = entry.latLng ? [] : [t('common.noPosition', 'No position')];
  parts.push(n === 1 ? t('common.stationOne', '1 station') : t('common.stationMany', '{n} stations', { n: n }));
  if (gone) { parts.push(t('common.retiredCount', '{n} retired', { n: gone })); }
  if (alarmed) { parts.push(t('projects.inAlarm', '{n} in alarm', { n: alarmed })); }
  return parts.join(' · ');
}

function projectRow(entry) {
  var el = h('<div class="ts-proj-st linked" tabindex="0"><div class="ts-proj-st-main"><div class="ts-proj-st-name"></div>' +
    '<div class="ts-row-meta"></div></div><div class="ts-proj-st-side"></div></div>');
  el.setAttribute('data-project', entry.project.name);
  el.querySelector('.ts-proj-st-name').textContent = entry.project.name;
  el.querySelector('.ts-row-meta').textContent = metaText(entry);
  var side = el.querySelector('.ts-proj-st-side');
  side.appendChild(chip(entry.status));
  function installation() { tb.openDashboard(opts.projectDashboardId, 'project', entry.project); }
  function open() { if (entry.homeId) { tb.openDashboard(entry.homeId); } else { installation(); } }
  el.addEventListener('click', function (e) { if (!e.target.closest('button')) { open(); } });
  el.addEventListener('keydown', function (e) { if (e.key === 'Enter' && e.target === el) { open(); } });
  if (entry.homeId) {
    var inst = h('<button type="button" class="ts-btn" data-a="installation">' + ICON.install + ' ' + esc(t('common.installation', 'Installation')) + '</button>');
    inst.addEventListener('click', installation);
    side.appendChild(inst);
  }
  el.addEventListener('mouseenter', function () { highlight(entry.project.id, true); });
  el.addEventListener('mouseleave', function () { highlight(entry.project.id, false); });
  return el;
}

/** *All customers*, then each owner with its project count; shown only when the list spans several. */
function renderOwners() {
  var list = owners();
  ownerEl.hidden = list.length < 2;
  if (list.every(function (o) { return o.key !== state.owner; })) { state.owner = ''; }
  ownerEl.innerHTML = '';
  ownerEl.appendChild(h('<option value=""></option>')).textContent = t('projects.allCustomers', 'All customers');
  list.forEach(function (o) {
    var opt = ownerEl.appendChild(h('<option></option>'));
    opt.value = o.key;
    opt.textContent = o.name + ' (' + o.projects.length + ')';
  });
  ownerEl.value = state.owner;
}

function render() {
  renderOwners();
  renderHeader();
  renderList();
  drawMarkers();
}

// -- new project (CA-6) ------------------------------------------------------------------

/** A name, and for the tenant the owner under *Tenant only*; then the project
 * opens in its Installation view with the map in edit mode. */
function openNew() {
  var tenant = state.me.authority === 'TENANT_ADMIN';
  var dr = ui.openDrawer(t('projects.new', 'New project'), tenant ? '' : t('projects.ownedByYou', 'Owned by your organisation'));
  dr.body.appendChild(h('<div class="ts-field"><div class="ts-field-label">' + esc(t('common.name', 'Name')) + '</div><input class="ts-input wide" data-f="name"></div>'));
  var input = dr.body.querySelector('[data-f=name]');
  var owner = null;
  if (tenant) {
    owner = h('<select class="ts-select wide" data-f="owner"><option value="">in-terra</option></select>');
    var field = h('<div class="ts-field"><div class="ts-field-label">' + esc(t('common.owner', 'Owner')) + '</div></div>');
    field.appendChild(owner);
    dr.body.appendChild(ui.tenantSection(field));
    tb.getAll('/api/customers').then(function (list) {
      list.filter(function (c) { return !(c.additionalInfo || {}).isPublic; })
        .sort(function (a, b) { return a.title.localeCompare(b.title); }).forEach(function (c) {
          var o = owner.appendChild(document.createElement('option'));
          o.value = c.id.id;
          o.textContent = c.title;
        });
    }).catch(function (err) { ui.toast(t('projects.customersFailed', 'Customers not loaded: {error}', { error: errText(err) }), 'error'); });
  }
  var go = ui.drawerActions(dr, t('common.create', 'Create'));
  go.disabled = true;
  input.addEventListener('input', function () { go.disabled = !input.value.trim(); });
  go.addEventListener('click', function () {
    var body = { name: input.value.trim(), type: 'Project' };
    var customer = tenant ? owner.value : state.me.customerId.id;
    if (customer) { body.customerId = { entityType: 'CUSTOMER', id: customer }; }
    go.disabled = true;
    tb.post('/api/asset', body).then(function (created) {
      ui.closeDrawer();
      tb.openDashboard(opts.projectDashboardId, 'project', tb.assetLevel(created), { editMap: true });
    }).catch(function (err) {
      go.disabled = false;
      ui.toast(t('projects.createFailed', 'Project not created: {error}', { error: errText(err) }), 'error');
    });
  });
  setTimeout(function () { input.focus(); }, 0);
}

// -- load --------------------------------------------------------------------------------

var timer = null;
function refresh() {
  if (!root.isConnected && timer) { clearInterval(timer); return Promise.resolve(); }
  refreshBtn.disabled = true;
  return load().then(render).catch(function (err) {
    ui.toast(t('common.refreshFailed', 'Refresh failed: {error}', { error: errText(err) }), 'error');
  }).then(function () { refreshBtn.disabled = false; });
}

refreshBtn.addEventListener('click', refresh);
searchEl.addEventListener('input', function () { state.search = searchEl.value; renderList(); });
ownerEl.addEventListener('change', function () {
  state.owner = ownerEl.value;
  state.filter = null;
  fitted = false;
  render();
});
newBtn.addEventListener('click', openNew);

tb.currentUser().then(function (me) {
  var perms = service('userPermissionsService');
  var signedIn = !(me || {}).isPublic && !tb.isPublicView() && !!perms;
  state.me = me || {};
  state.canCreateAssets = signedIn && perms.hasGenericPermission('ASSET', 'CREATE');
  newBtn.hidden = !state.canCreateAssets;
  return Promise.all([
    loadMapLibraries().then(initMap).catch(function (err) {
      mapEl.appendChild(h('<div class="ts-empty"></div>')).textContent = t('map.failed', 'The map could not load: {error}', { error: errText(err) });
    }),
    load()
  ]);
}).then(function () {
  render();
  timer = setInterval(refresh, REFRESH_MS);
}).catch(function (err) { fail(t('common.loadFailed', 'Could not load: {error}', { error: errText(err) })); });

};
