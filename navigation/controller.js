/*
 * Navigation — the button bar above a device, station or station-template
 * view, linking the views of one LOGR installation to each other.
 * Widget: logr-product-docs/cloud/FRONTEND.md *Navigation*.
 *
 * `opts`, set by the dashboard builders: `links`, a list of
 *   fleet    the Devices dashboard's landing view
 *   project  the Project view of the bound station's project
 *   station  the Project dashboard's Station view of the bound station
 *   charts   the station's own template dashboard, `config.stationDashboard`
 * and `devicesDashboardId`, `projectDashboardId`.
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

function fleet() {
  button('fleet', ICON.back, 'Fleet', function () {
    var sc = ctx.stateController;
    if (onDashboard(opts.devicesDashboardId) && sc) { sc.resetState(); } else { tb.openDashboard(opts.devicesDashboardId); }
  });
}

function project(station) {
  return tb.ancestors(station).then(function (chain) {
    var p = chain.filter(function (a) { return a.kind === 'Project'; })[0];
    if (!p) { missing('project', 'On no project'); return; }
    button('project', ICON.back, p.name, function () { tb.openDashboard(opts.projectDashboardId, 'project', p); });
  });
}

function stationLink(station) {
  button('station', ICON_STATION, 'Station', function () { tb.openDashboard(opts.projectDashboardId, 'station', station); });
}

function charts(station) {
  return tb.attrsMap(station).then(function (attrs) {
    var id = attrs['config.stationDashboard'];
    if (!id) { missing('charts', 'No charts dashboard yet'); return; }
    button('charts', ICON_CHART, 'Charts', function () { tb.openDashboard(id, 'station', station); });
  });
}

tb.boundDatasource().then(function (ds) {
  var links = opts.links || [];
  var needsStation = links.some(function (l) { return l !== 'fleet'; });
  var station = ds && ds.entityType === 'ASSET' ? { entityType: 'ASSET', id: ds.entityId, name: ds.entityName } : null;
  if (needsStation && !station) { return; }
  // One after the other, so the bar keeps the order of `links`.
  return links.reduce(function (done, link) {
    return done.then(function () {
      if (link === 'fleet') { return fleet(); }
      if (link === 'project') { return project(station); }
      if (link === 'station') { return stationLink(station); }
      if (link === 'charts') { return charts(station); }
    });
  }, Promise.resolve());
}).catch(function () {});

};
