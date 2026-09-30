/*
 * Navigation — the button bar above a view, linking the views of one LOGR
 * installation to each other.
 * Widget: logr-product-docs/cloud/FRONTEND.md *Navigation*.
 *
 * `opts`, set by the dashboard builders: `links`, a list of
 *   fleet     the Devices dashboard's landing view
 *   device    the device view of the bound device
 *   relays    the relay controller view of the bound device, a LOGR2
 *   projects  the Project dashboard's landing view
 *   project   the Project view of the bound project, or of the project above it
 *   station   the station view of the bound station
 *   charts    the station's own template dashboard, `config.stationDashboard`
 *   settings  the Settings view of the bound customer, project, location or
 *             station; never on a public link
 * and `devicesDashboardId`, `projectDashboardId`. A link that does not apply to
 * the bound entity is left out.
 *
 * Loads after shared/resolver.js, glossary.js, ui.js and tb_io.js.
 */

window.TerrySenseNavigation = function (ctx, container, opts) {

opts = opts || {};
var tb = window.TerrySenseTbIo(ctx);
var root = container.querySelector('.ts-root') || container;
var ui = window.TerrySenseUi(root);
var h = ui.h, ICON = ui.ICON;

var ICON_CHART = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19h16"/><path d="M5 15l4-5 4 3 6-7"/></svg>';
var ICON_STATION = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21V9"/><path d="M8 21h8"/><circle cx="12" cy="6" r="3"/></svg>';

root.innerHTML = '';
var bar = root.appendChild(h('<div class="ts-nav"></div>'));

function button(id, icon, text, onClick) {
  var b = h('<button type="button" class="ts-btn ts-nav-btn">' + icon + '<span></span></button>');
  b.dataset.nav = id;
  b.querySelector('span').textContent = text;
  b.addEventListener('click', onClick);
  bar.appendChild(b);
  return b;
}

function missing(id, text) {
  var el = bar.appendChild(h('<span class="ts-nav-none"></span>'));
  el.dataset.nav = id;
  el.textContent = text;
}

function onDashboard(id) { return !!id && window.location.pathname.indexOf(id) >= 0; }

var ICON_RELAY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="8" width="18" height="8" rx="4"/><circle cx="16" cy="12" r="2"/></svg>';

function fleet() {
  button('fleet', ICON.back, 'Fleet', function () {
    var sc = ctx.stateController;
    if (onDashboard(opts.devicesDashboardId) && sc) { sc.resetState(); } else { tb.openDashboard(opts.devicesDashboardId); }
  });
}

function device(e) {
  if (e.entityType !== 'DEVICE') { return; }
  button('device', ICON.back, e.name, function () { tb.openDashboard(opts.devicesDashboardId, 'device', e); });
}

function relays(e) {
  if (e.entityType !== 'DEVICE' || e.kind !== 'logr2') { return; }
  button('relays', ICON_RELAY, 'Relay controller', function () { tb.openDashboard(opts.devicesDashboardId, 'relays', e); });
}

function projects() {
  button('projects', ICON.back, 'Projects', function () { tb.openDashboard(opts.projectDashboardId); });
}

function project(e) {
  if (e.entityType !== 'ASSET') { return; }
  if (e.kind === 'Project') {
    button('project', ICON.back, 'Project: ' + e.name, function () { tb.openDashboard(opts.projectDashboardId, 'project', e); });
    return;
  }
  return tb.ancestors(e).then(function (chain) {
    var p = chain.filter(function (a) { return a.kind === 'Project'; })[0];
    if (!p) { missing('project', 'On no project'); return; }
    button('project', ICON.back, 'Project: ' + p.name, function () { tb.openDashboard(opts.projectDashboardId, 'project', p); });
  });
}

function stationLink(e) {
  if (e.kind !== 'Station') { return; }
  button('station', ICON_STATION, 'Station', function () { tb.openDashboard(opts.projectDashboardId, 'station', e); });
}

function charts(e) {
  if (e.kind !== 'Station') { return; }
  return tb.attrsMap(e).then(function (attrs) {
    var id = attrs['config.stationDashboard'];
    if (!id) { missing('charts', 'No charts dashboard yet'); return; }
    button('charts', ICON_CHART, 'Charts', function () { tb.openDashboard(id, 'station', e); });
  });
}

function settings(e) {
  if (tb.isPublicView() || e.entityType === 'DEVICE') { return; }
  button('settings', ICON.gear, 'Settings', function () { tb.openDashboard(opts.projectDashboardId, 'settings', e); });
}

var LINKS = { fleet: fleet, device: device, relays: relays, projects: projects, project: project,
  station: stationLink, charts: charts, settings: settings };

function bound(ds) {
  if (!ds) { return Promise.resolve(null); }
  if (ds.entityType === 'DEVICE') {
    return tb.get('/api/device/' + ds.entityId).then(function (d) {
      return { entityType: 'DEVICE', id: ds.entityId, name: d.name, kind: d.type };
    });
  }
  return tb.loadEntity(ds);
}

var links = opts.links || [];
var needsEntity = links.some(function (l) { return l !== 'fleet' && l !== 'projects'; });
tb.boundDatasource().then(function (ds) {
  return needsEntity ? bound(ds) : null;
}).then(function (e) {
  if (needsEntity && !e) { return; }
  // One after the other, so the bar keeps the order of `links`.
  return links.reduce(function (done, link) {
    return done.then(function () { return LINKS[link](e); });
  }, Promise.resolve());
}).catch(function () {});

};
