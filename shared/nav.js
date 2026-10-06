/*
 * Navigation — the button row at the top of every terrySense widget, linking
 * the views of one LOGR installation to each other. The navigation widget
 * carries the same row alone, above the native widgets of a station dashboard.
 * Contract: logr-product-docs/cloud/FRONTEND.md *Navigation*.
 *
 * `opts`, set by the dashboard builders: `links`, a list of
 *   fleet     the Fleet dashboard's landing view
 *   firmware  the Fleet dashboard's firmware view
 *   device    the device view of the bound device
 *   relays    the Dry contact interface view of the bound station, when it
 *             keeps DRYC rules or contains a LOGR2 that has reported a DRYC
 *             reading
 *   projects  the Projects dashboard's landing view; never on a public link
 *   project   *Project:* and the name of the project above the bound
 *             station, or of each project the bound device feeds: its project
 *             dashboard, else its Installation view
 *   home      the bound project's own home dashboard, `config.homeDashboard`,
 *             when the user can read it
 *   station   *Station:* and the name of each station the bound device feeds:
 *             its charts, else its Installation view; on a bound station, as
 *             `installation`
 *   installation  the Installation view of the bound project or station; never
 *             on a public link
 *   charts    the station's own template dashboard, `config.stationDashboard`
 *   settings  the Settings view of the bound customer, project or station, in
 *             the Projects dashboard; of the bound device, in the Fleet
 *             dashboard; never on a public link
 *   customer  *Settings* on the signed-in user's own customer, whatever the
 *             widget is bound to; not for the tenant, never on a public link
 * and `devicesDashboardId`, `projectDashboardId`. A link that does not apply to
 * the bound entity is left out.
 *
 * Loads after shared/i18n.js, resolver.js, glossary.js, ui.js and tb_io.js.
 */

(function (root) {
'use strict';

var ICON_CHART = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19h16"/><path d="M5 15l4-5 4 3 6-7"/></svg>';
var ICON_STATION = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21V9"/><path d="M8 21h8"/><circle cx="12" cy="6" r="3"/></svg>';
var ICON_RELAY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="8" width="18" height="8" rx="4"/><circle cx="16" cy="12" r="2"/></svg>';
var ICON_CHIP = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="6" width="12" height="12" rx="1"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/></svg>';
var ICON_HOME = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/></svg>';
var ICON_PROJECT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4L3 6v14l6-2 6 2 6-2V4l-6 2-6-2z"/><path d="M9 4v14M15 6v14"/></svg>';

/** Puts the navigation row on top of `card`, for the entity the widget is
 * bound to; nothing when `opts.links` is empty. */
root.TerrySenseNav = function (ctx, tb, ui, card, opts) {
  opts = opts || {};
  var links = opts.links || [];
  if (!links.length) { return; }
  var h = ui.h, ICON = ui.ICON, t = root.TerrySenseI18n(ctx);
  var bar = card.insertBefore(h('<nav class="ts-nav"></nav>'), card.firstChild);

  function button(id, icon, text, onClick) {
    var b = h('<button type="button" class="ts-btn ghost ts-nav-btn">' + icon + '<span></span></button>');
    b.dataset.nav = id;
    b.querySelector('span').textContent = text;
    b.title = text;
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

  function landing(dashboardId) {
    var sc = ctx.stateController;
    if (onDashboard(dashboardId) && sc) { sc.resetState(); } else { tb.openDashboard(dashboardId); }
  }

  // A device's stations, looked up once for both the station and the project buttons.
  var stationsOfDevice = null;
  function deviceStations(e) { return stationsOfDevice || (stationsOfDevice = tb.deviceStations(e).catch(function () { return []; })); }

  function openProject(p) { button('project', ICON_PROJECT, t('nav.projectOf', 'Project: {name}', { name: p.name }), function () { tb.openProject(opts.projectDashboardId, p); }); }

  var LINKS = {
    fleet: function () { button('fleet', ICON.back, t('nav.fleet', 'Fleet'), function () { landing(opts.devicesDashboardId); }); },
    firmware: function () {
      button('firmware', ICON_CHIP, t('nav.firmware', 'Firmware'), function () {
        var sc = ctx.stateController;
        if (onDashboard(opts.devicesDashboardId) && sc) { sc.openState('firmware', {}, false); } else { tb.openDashboard(opts.devicesDashboardId); }
      });
    },
    device: function (e) {
      if (e.entityType !== 'DEVICE') { return; }
      button('device', ICON.gauge, t('nav.deviceOf', 'Device: {name}', { name: e.name }), function () { tb.openDashboard(opts.devicesDashboardId, 'device', e); });
    },
    relays: function (e) {
      if (e.kind !== 'Station') { return; }
      var go = function () { button('relays', ICON_RELAY, t('common.dryc', 'Dry contact interface'), function () { tb.openDashboard(opts.projectDashboardId, 'dryc', e); }); };
      return tb.attrsMap(e).then(function (attrs) {
        if (attrs['dryc.rules']) { go(); return null; }
        // A LOGR2 has a DRYC once it has reported a `dryc.` reading.
        return tb.post('/api/relations', { parameters: { rootId: e.id, rootType: 'ASSET', direction: 'FROM', relationTypeGroup: 'COMMON', maxLevel: 1 },
          filters: [{ relationType: 'Contains', entityTypes: ['DEVICE'] }] }).then(function (rels) {
          return Promise.all((rels || []).map(function (r) {
            return tb.get('/api/plugins/telemetry/DEVICE/' + r.to.id + '/keys/timeseries').catch(function () { return []; });
          }));
        }).then(function (lists) {
          if (lists.some(function (keys) { return (keys || []).some(function (k) { return k.indexOf('dryc.') === 0; }); })) { go(); }
        });
      });
    },
    projects: function () {
      if (tb.isPublicView()) { return; }
      button('projects', ICON.back, t('common.projects', 'Projects'), function () { landing(opts.projectDashboardId); });
    },
    project: function (e) {
      if (e.entityType === 'DEVICE') {
        return deviceStations(e).then(function (stations) {
          var seen = {};
          stations.forEach(function (s) { if (s.project && !seen[s.project.id]) { seen[s.project.id] = true; openProject(s.project); } });
        });
      }
      if (e.entityType !== 'ASSET') { return; }
      if (e.kind === 'Project') { openProject(e); return; }
      return tb.ancestors(e).then(function (chain) {
        var p = chain.filter(function (a) { return a.kind === 'Project'; })[0];
        if (p) { openProject(p); } else { missing('project', t('nav.noProject', 'On no project')); }
      });
    },
    home: function (e) {
      if (e.kind !== 'Project') { return; }
      return tb.attrsMap(e).then(function (attrs) { return tb.readableDashboard(attrs['config.homeDashboard']); }).then(function (id) {
        if (id) { button('home', ICON_HOME, t('nav.home', 'Project dashboard'), function () { tb.openDashboard(id); }); }
      });
    },
    station: function (e) {
      if (e.entityType === 'DEVICE') {
        return deviceStations(e).then(function (stations) {
          if (!stations.length) { missing('station', t('nav.noStation', 'On no station')); }
          stations.forEach(function (s) {
            button('station', ICON_STATION, t('nav.stationOf', 'Station: {name}', { name: s.name }), function () { tb.openStation(opts.projectDashboardId, s); });
          });
        });
      }
      // Templates copied from older chart models name the Installation view `station`.
      if (e.kind === 'Station') { return LINKS.installation(e); }
    },
    installation: function (e) {
      if (tb.isPublicView() || (e.kind !== 'Station' && e.kind !== 'Project')) { return; }
      button('installation', ICON.install, t('common.installation', 'Installation'), function () {
        tb.openDashboard(opts.projectDashboardId, e.kind === 'Station' ? 'station' : 'project', e);
      });
    },
    charts: function (e) {
      if (e.kind !== 'Station') { return; }
      return tb.attrsMap(e).then(function (attrs) { return tb.readableDashboard(attrs['config.stationDashboard']); }).then(function (id) {
        if (!id) { missing('charts', t('nav.noCharts', 'No charts dashboard yet')); return; }
        button('charts', ICON_CHART, t('common.charts', 'Charts'), function () { tb.openDashboard(id, 'station', e); });
      });
    },
    customer: function () {
      if (tb.isPublicView()) { return; }
      return tb.currentUser().then(function (me) {
        if (me.authority === 'TENANT_ADMIN' || !me.customerId) { return; }
        var c = { entityType: 'CUSTOMER', id: me.customerId.id };
        button('settings', ICON.gear, t('common.settings', 'Settings'), function () { tb.openDashboard(opts.projectDashboardId, 'settings', c); });
      });
    },
    settings: function (e) {
      if (tb.isPublicView()) { return; }
      var dashboard = e.entityType === 'DEVICE' ? opts.devicesDashboardId : opts.projectDashboardId;
      button('settings', ICON.gear, t('common.settings', 'Settings'), function () { tb.openDashboard(dashboard, 'settings', e); });
    }
  };

  function bound(ds) {
    if (!ds) { return Promise.resolve(null); }
    if (ds.entityType === 'DEVICE') {
      return tb.get('/api/device/' + ds.entityId).then(function (d) {
        return { entityType: 'DEVICE', id: ds.entityId, name: d.name, kind: d.type };
      });
    }
    return tb.loadEntity(ds);
  }

  var needsEntity = links.some(function (l) { return ['fleet', 'firmware', 'projects', 'customer'].indexOf(l) < 0; });
  tb.boundDatasource().then(function (ds) {
    return needsEntity ? bound(ds) : null;
  }).then(function (e) {
    if (needsEntity && !e) { return; }
    // One after the other, so the row keeps the order of `links`.
    return links.reduce(function (done, link) {
      return done.then(function () { return LINKS[link](e); });
    }, Promise.resolve());
  }).catch(function () {});
};

})(typeof self !== 'undefined' ? self : this);
