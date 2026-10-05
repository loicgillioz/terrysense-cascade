/*
 * Station dashboards drawn from a station's channels — `window.TerrySenseTemplates(ui, tb)`.
 * Each channel is drawn with its name's default chart (vocabulary.md §5),
 * copied from the tenant's "Chart models" dashboard; a template binds channel
 * names, so every station with the same names can take it. A project dashboard
 * draws picked stations the same way, each bound to its own station.
 * logr-product-docs/cloud/FRONTEND.md *Station dashboards*, *Project home dashboards*.
 *
 * Loads after shared/resolver.js, ui.js and tb_io.js.
 */
(function (root) {
'use strict';

root.TerrySenseTemplates = function (ui, tb) {
  var resolver = root.TerrySenseResolver;
  var h = ui.h, esc = ui.esc;

  var MODELS_TITLE = 'Chart models';
  var TEMPLATE_GROUP = 'Station dashboards';
  var PLACEHOLDER = { channel: '__CHANNEL__', label: '__LABEL__', unit: '__UNIT__' };
  var CHARTS = { line: 'Line', 'bars:1h': 'Hourly sums', 'bars:1d': 'Daily sums', state: 'State timeline', value: 'Value only' };
  var BY_ALARM = { numeric: 'line', boolean: 'state', state: 'state' };
  var ALARMS_FQN = 'system.alarm_widgets.alarms_table';
  var MAP_FQN = 'system.map';
  var HOME_GROUP = 'Project home dashboards';
  var HOME_KEY = 'config.homeDashboard';

  function uuid() {
    if (root.crypto && root.crypto.randomUUID) { return root.crypto.randomUUID(); }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 3 | 8)).toString(16);
    });
  }

  function jsonText(v) { return JSON.stringify(String(v)).slice(1, -1); }

  /** A name's `chart`, else its kind's, else what its kind's alarm type suggests. */
  function chartOf(channel, names, kinds) {
    var e = names[resolver.splitChannelKey(channel).name] || {};
    if (e.chart) { return e.chart; }
    var k = resolver.kindSpec(e.kind, kinds);
    return k.chart || BY_ALARM[k.alarm] || 'value';
  }

  /** The channels a template drawn from the station shows: every one but a
   * diagnostic or rule channel, calculated ones included, in `order` first. */
  function channelsOf(attrs, names, kinds, order) {
    order = order || [];
    function rank(c) { var i = order.indexOf(c); return i < 0 ? order.length : i; }
    return Object.keys(resolver.channelsFromAttrs(attrs, names)).filter(function (c) {
      var e = names[resolver.splitChannelKey(c).name] || {};
      return !e.diagnostic && !e.rule;
    }).sort(function (a, b) { return rank(a) - rank(b); }).map(function (c) {
      var e = names[resolver.splitChannelKey(c).name] || {};
      return {
        key: c, label: attrs['effective.' + c + '.label'] || e.label || c, unit: attrs['effective.' + c + '.unit'] || '',
        chart: chartOf(c, names, kinds), states: e.states || null,
        whenTrue: attrs['effective.' + c + '.textWhenTrue'], whenFalse: attrs['effective.' + c + '.textWhenFalse']
      };
    }).filter(function (c) { return c.chart !== 'none'; });
  }

  function loadModels() {
    return tb.get('/api/user/dashboards', { pageSize: '50', page: '0', textSearch: MODELS_TITLE }).then(function (page) {
      var info = ((page && page.data) || []).filter(function (d) { return d.title === MODELS_TITLE; })[0];
      if (!info) { throw new Error('the dashboard "' + MODELS_TITLE + '" is not visible to you'); }
      return tb.get('/api/dashboard/' + info.id.id);
    });
  }

  /** The model widget of each chart, by its title, and the station alias they bind. */
  function modelsOf(dashboard) {
    var conf = dashboard.configuration, out = { ids: {} };
    Object.keys(conf.widgets).forEach(function (id) {
      var title = (conf.widgets[id].config || {}).title;
      if (CHARTS[title]) { out.ids[title] = id; }
      if (conf.widgets[id].typeFullFqn === ALARMS_FQN) { out.alarms = id; }
    });
    out.alias = stationAlias(conf);
    return out;
  }

  function stationAlias(conf) {
    var aliases = conf.entityAliases || {};
    return Object.keys(aliases).filter(function (k) { return (aliases[k].filter || {}).type === 'stateEntity'; })[0];
  }

  /** One model widget filled in for channel `c`, bound to `alias`. */
  function copyModel(models, modelId, c, alias) {
    var w = models.dashboard.configuration.widgets[modelId];
    var text = JSON.stringify(w).split(PLACEHOLDER.channel).join(jsonText(c.key))
      .split(PLACEHOLDER.label).join(jsonText(c.label)).split(PLACEHOLDER.unit).join(jsonText(c.unit));
    if (models.alias && alias) { text = text.split(models.alias).join(alias); }
    var copy = JSON.parse(text);
    copy.id = uuid();
    copy.config.title = c.label;
    if (copy.typeFullFqn === 'system.state_chart') {
      copy.config.settings.states = c.states
        ? Object.keys(c.states).map(function (v) { return { label: c.states[v], value: Number(v), sourceType: 'constant', sourceValue: Number(v) }; })
        : [{ label: c.whenFalse || 'Off', value: 0, sourceType: 'constant', sourceValue: false },
           { label: c.whenTrue || 'On', value: 1, sourceType: 'constant', sourceValue: true }];
    }
    return copy;
  }

  /** The view a template draws a station in: its "station" view, else its first. */
  function stationLayout(conf) {
    var st = conf.states.station || conf.states[Object.keys(conf.states)[0]];
    st.layouts.main.widgets = st.layouts.main.widgets || {};
    return st.layouts.main.widgets;
  }

  function bottomRow(layout) {
    return Object.keys(layout).reduce(function (m, id) { return Math.max(m, layout[id].row + layout[id].sizeY); }, 0);
  }

  /** Append a value card and the chart of each channel below the station view's widgets. */
  function appendBands(conf, models, channels) {
    var layout = stationLayout(conf);
    placeBands(conf.widgets, layout, models, channels, stationAlias(conf), bottomRow(layout));
  }

  /** A value card and the chart of each channel, bound to `alias`, from `row` down. Returns the row below them. */
  function placeBands(widgets, layout, models, channels, alias, row) {
    var mlayout = models.dashboard.configuration.states.station.layouts.main.widgets;
    var card = mlayout[models.ids.value];
    channels.forEach(function (c) {
      var band = card.sizeY;
      var v = copyModel(models, models.ids.value, c, alias);
      widgets[v.id] = v;
      layout[v.id] = { sizeX: card.sizeX, sizeY: card.sizeY, row: row, col: 0 };
      var chartId = c.chart !== 'value' && models.ids[c.chart];
      if (chartId) {
        var at = mlayout[chartId], w = copyModel(models, chartId, c, alias);
        widgets[w.id] = w;
        layout[w.id] = { sizeX: at.sizeX, sizeY: at.sizeY, row: row, col: card.sizeX };
        band = Math.max(band, at.sizeY);
      }
      row += band;
    });
    return row;
  }

  /** The template group of `owner`, else the user's own — the tenant's for a tenant admin. */
  function templateGroup(owner, me) {
    owner = owner || (me.authority === 'TENANT_ADMIN' ? { entityType: 'TENANT', id: me.tenantId.id } : { entityType: 'CUSTOMER', id: me.customerId.id });
    return tb.get('/api/entityGroup/' + owner.entityType + '/' + owner.id + '/DASHBOARD/' + encodeURIComponent(TEMPLATE_GROUP))
      .catch(function () { return tb.post('/api/entityGroup', { type: 'DASHBOARD', name: TEMPLATE_GROUP, ownerId: owner }); });
  }

  /** A template named "Station · <use>" drawing `channels`, in the group of
   * `owner` (null: the user's own), assigned to `station`. Resolves to its id. */
  function create(station, channels, use, owner, me) {
    return Promise.all([loadModels(), templateGroup(owner, me)]).then(function (got) {
      var models = modelsOf(got[0]);
      models.dashboard = got[0];
      return tb.post('/api/dashboard?entityGroupId=' + got[1].id.id, { title: 'Station · ' + use, configuration: {} }).then(function (created) {
        var conf = JSON.parse(JSON.stringify(got[0].configuration).split(got[0].id.id).join(created.id.id)
          .split(MODELS_TITLE).join(jsonText(use)));
        var layout = conf.states.station.layouts.main.widgets;
        Object.keys(models.ids).forEach(function (chart) { delete conf.widgets[models.ids[chart]]; delete layout[models.ids[chart]]; });
        appendBands(conf, models, channels);
        created.configuration = conf;
        return tb.post('/api/dashboard', created);
      });
    }).then(function (saved) {
      return tb.saveAttrs(station, { 'config.stationDashboard': saved.id.id }).then(function () { return saved.id.id; });
    });
  }

  /** The channels of `channels` template `templateId` binds nowhere, appended with their charts. Resolves to how many. */
  function addChannels(templateId, channels) {
    return Promise.all([tb.get('/api/dashboard/' + templateId), loadModels()]).then(function (got) {
      var bound = resolver.dashboardChannels(got[0]);
      var missing = channels.filter(function (c) { return bound.indexOf(c.key) < 0; });
      if (!missing.length) { return 0; }
      var models = modelsOf(got[1]);
      models.dashboard = got[1];
      appendBands(got[0].configuration, models, missing);
      return tb.post('/api/dashboard', got[0]).then(function () { return missing.length; });
    });
  }

  /** The channels of `channels` the template binding `bound` lacks. */
  function missingFrom(bound, channels) { return channels.filter(function (c) { return bound.indexOf(c.key) < 0; }); }

  /** *Create from this station*: the name, the charts it draws and, for the
   * tenant on a customer's station, whose group keeps it. `o`: station, owner
   * (the station's owner id), channels, back, done(dashboardId). */
  function openCreate(o) {
    var dr = ui.openDrawer('Create from this station', esc(o.station.name));
    var form = h('<div><div class="ts-field"><label class="ts-field-label">Name</label><div class="ts-tpl-name">' +
      '<span class="ts-row-meta">Station · </span><input class="ts-input wide" placeholder="River level"></div>' +
      '<div class="ts-field-hint">What kind of station it shows, so the next station of that kind can reuse it.</div></div>' +
      '<div class="ts-section-head">Each measurement with its chart</div><div class="ts-tpl-chans"></div></div>');
    var input = form.querySelector('input'), list = form.querySelector('.ts-tpl-chans');
    o.channels.forEach(function (c) {
      var row = list.appendChild(h('<div class="ts-tpl-chan"><span></span><span class="ts-chip"></span></div>'));
      row.setAttribute('data-channel', c.key);
      row.firstChild.textContent = c.label + (c.unit ? ' (' + c.unit + ')' : '');
      row.lastChild.textContent = CHARTS[c.chart] || c.chart;
    });
    if (!o.channels.length) { list.appendChild(h('<div class="ts-empty">The station has no measurement to draw yet.</div>')); }
    dr.body.appendChild(form);
    if (o.back) { dr.onBack(o.back); }
    var go = ui.drawerActions(dr, 'Create');
    go.disabled = !o.channels.length;
    tb.currentUser().then(function (me) {
      me = me || {};
      var tenant = me.authority === 'TENANT_ADMIN', choose = tenant && o.owner && o.owner.entityType === 'CUSTOMER';
      var note = form.appendChild(h('<div class="ts-row-meta"></div>'));
      note.textContent = 'The template opens in ThingsBoard afterwards, to arrange as you like. ' +
        (choose ? '' : tenant ? 'It is saved with the in-terra templates, shared with every customer.' : 'Only your organisation sees it.');
      var where = null;
      if (choose) {
        // A template drawn from one customer's station stays that customer's unless published on purpose.
        where = h('<div class="ts-field ts-tpl-group"><label class="ts-switch"><input type="radio" name="ts-tpl-group" value="owner" checked>' +
          ' <span></span></label><label class="ts-switch"><input type="radio" name="ts-tpl-group" value="tenant">' +
          ' With the in-terra templates, shared with every customer</label></div>');
        form.appendChild(ui.tenantSection(where));
        tb.get('/api/customer/' + o.owner.id).then(function (c) {
          where.querySelector('span').textContent = 'With the templates of ' + (c.title || c.name) + ', which only it sees';
        }).catch(function () { where.querySelector('span').textContent = 'With the templates of the station\'s owner, which only it sees'; });
      }
      setTimeout(function () { input.focus(); }, 0);
      go.addEventListener('click', function () {
        var use = input.value.trim();
        if (!use) { input.focus(); return; }
        go.disabled = true;
        var toOwner = where && where.querySelector('[name=ts-tpl-group]:checked').value === 'owner';
        create(o.station, o.channels, use, toOwner ? o.owner : null, me).then(function (id) {
          ui.closeDrawer();
          ui.toast('Station · ' + use + ' created and assigned');
          o.done(id);
        }).catch(function (err) {
          go.disabled = false;
          ui.toast('Template not created: ' + ((err && err.message) || err), 'error');
        });
      });
    });
  }

  // -- project dashboards (FRONTEND.md *Project home dashboards*) ---------------------------

  /** The owner's group of project dashboards, never shared, so each one is public only through its own public link. */
  function homeGroup(owner) {
    return tb.get('/api/entityGroup/' + owner.entityType + '/' + owner.id + '/DASHBOARD/' + encodeURIComponent(HOME_GROUP))
      .catch(function () { return tb.post('/api/entityGroup', { type: 'DASHBOARD', name: HOME_GROUP, ownerId: owner }); });
  }

  /** The stations a project dashboard shows: every asset its aliases name but the project. */
  function homeStations(dashboard, projectId) {
    var ids = {};
    Object.keys(dashboard.configuration.entityAliases || {}).forEach(function (k) {
      var f = dashboard.configuration.entityAliases[k].filter || {};
      if (f.type === 'singleEntity' && f.singleEntity && f.singleEntity.entityType === 'ASSET') { ids[f.singleEntity.id] = true; }
      if (f.type === 'entityList' && f.entityType === 'ASSET') { (f.entityList || []).forEach(function (id) { ids[id] = true; }); }
    });
    delete ids[projectId];
    return ids;
  }

  function stationAliasOf(conf, station) {
    var id = uuid();
    conf.entityAliases[id] = { id: id, alias: station.name,
      filter: { type: 'singleEntity', resolveMultiple: false, singleEntity: { entityType: 'ASSET', id: station.id } } };
    return id;
  }

  /** The stock map, one marker per station of alias `alias` at its `latitude` / `longitude`. */
  function mapWidget(stock, alias, title) {
    var conf = JSON.parse(stock.descriptor.defaultConfig);
    var marker = Object.assign(conf.settings.markers[0], {
      dsType: 'entity', dsLabel: '', dsEntityAliasId: alias, dsDeviceId: null, dsFilterId: null, additionalDataKeys: [],
      xKey: { name: 'latitude', label: 'latitude', type: 'attribute', settings: {}, color: '#2196f3' },
      yKey: { name: 'longitude', label: 'longitude', type: 'attribute', settings: {}, color: '#2196f3' },
      label: { show: true, type: 'pattern', pattern: '${entityName}' },
      click: { type: 'doNothing' }, markerType: 'shape'
    });
    marker.tooltip = Object.assign(marker.tooltip || {}, { show: false });
    marker.markerShape = Object.assign(marker.markerShape || {}, { color: { type: 'constant', color: '#0277b7' } });
    conf.settings.markers = [marker];
    conf.datasources = [];
    conf.title = title;
    return { id: uuid(), typeFullFqn: MAP_FQN, type: stock.descriptor.type, sizeX: 24, sizeY: 10, config: conf };
  }

  /** One station from `row` down: its active alarms titled by its name, then each picked channel. Returns the row below. */
  function stationBand(conf, layout, models, pick, row) {
    var alias = stationAliasOf(conf, pick.station);
    if (models.alarms) {
      var at = models.dashboard.configuration.states.station.layouts.main.widgets[models.alarms];
      var w = copyModel(models, models.alarms, { key: '', label: pick.station.name, unit: '' }, alias);
      conf.widgets[w.id] = w;
      layout[w.id] = { sizeX: at.sizeX, sizeY: at.sizeY, row: row, col: 0 };
      row += at.sizeY;
    }
    return placeBands(conf.widgets, layout, models, pick.channels, alias, row);
  }

  function rootLayout(conf) {
    var id = Object.keys(conf.states).filter(function (k) { return conf.states[k].root; })[0] || Object.keys(conf.states)[0];
    return conf.states[id].layouts.main.widgets;
  }

  /** A dashboard titled `title` in the owner's project dashboards: the map of the
   * picked stations, then a band per station. `picks`: [{station, channels}].
   * Linked from the project's `config.homeDashboard`; resolves to its id. */
  function createHome(project, owner, picks, title) {
    return Promise.all([loadModels(), tb.get('/api/widgetType', { fqn: MAP_FQN }), homeGroup(owner)]).then(function (got) {
      var models = modelsOf(got[0]), mconf = got[0].configuration;
      models.dashboard = got[0];
      var grid = (mconf.states.station.layouts.main || {}).gridSettings;
      var conf = { widgets: {}, entityAliases: {}, filters: {}, timewindow: mconf.timewindow, settings: mconf.settings,
        states: { 'default': { name: title, root: true, layouts: { main: { widgets: {}, gridSettings: grid } } } } };
      var layout = conf.states['default'].layouts.main.widgets;
      var listId = uuid();
      conf.entityAliases[listId] = { id: listId, alias: 'Stations', filter: { type: 'entityList', resolveMultiple: true,
        entityType: 'ASSET', entityList: picks.map(function (p) { return p.station.id; }) } };
      var map = mapWidget(got[1], listId, title);
      conf.widgets[map.id] = map;
      layout[map.id] = { sizeX: map.sizeX, sizeY: map.sizeY, row: 0, col: 0 };
      picks.reduce(function (row, p) { return stationBand(conf, layout, models, p, row); }, map.sizeY);
      return tb.post('/api/dashboard?entityGroupId=' + got[2].id.id, { title: title, configuration: conf });
    }).then(function (saved) {
      var write = {};
      write[HOME_KEY] = saved.id.id;
      return tb.saveAttrs(project, write).then(function () { return saved.id.id; });
    });
  }

  /** `pick` appended to project dashboard `homeId`: on its map and in a band below everything else. */
  function addToHome(homeId, pick) {
    return Promise.all([tb.get('/api/dashboard/' + homeId), loadModels()]).then(function (got) {
      var dash = got[0], conf = dash.configuration, models = modelsOf(got[1]);
      models.dashboard = got[1];
      Object.keys(conf.entityAliases).forEach(function (k) {
        var f = conf.entityAliases[k].filter;
        if (f.type === 'entityList' && f.entityType === 'ASSET') { f.entityList.push(pick.station.id); }
      });
      var layout = rootLayout(conf);
      stationBand(conf, layout, models, pick, bottomRow(layout));
      return tb.post('/api/dashboard', dash);
    });
  }

  /** A checkbox per channel, ticked, with its chart. Returns a function giving the ticked ones. */
  function channelChecks(box, channels) {
    channels.forEach(function (c) {
      var r = box.appendChild(h('<label class="ts-switch"><input type="checkbox" checked><span></span><span class="ts-chip"></span></label>'));
      r.setAttribute('data-channel', c.key);
      r.querySelector('span').textContent = c.label + (c.unit ? ' (' + c.unit + ')' : '');
      r.querySelector('.ts-chip').textContent = CHARTS[c.chart] || c.chart;
    });
    if (!channels.length) { box.appendChild(h('<div class="ts-row-meta">On the map with its alarms; no measurement to draw yet.</div>')); }
    return function () {
      var boxes = box.querySelectorAll('input');
      return channels.filter(function (c, i) { return boxes[i].checked; });
    };
  }

  /** *Create project dashboard*: its name, the stations on it and what each
   * shows. `o`: project, owner, entries ([{station, attrs}]), names, kinds,
   * replaces (the current dashboard's title, optional), intro (optional),
   * done(dashboardId, picks). */
  function openCreateHome(o) {
    var dr = ui.openDrawer('Create project dashboard', esc(o.project.name));
    if (o.intro) { dr.body.appendChild(h('<p class="ts-field-hint"></p>')).textContent = o.intro; }
    var form = dr.body.appendChild(h('<div><div class="ts-field"><label class="ts-field-label">Name</label><input class="ts-input wide" data-f="title"></div>' +
      '<div class="ts-section-head">Stations, and what each shows</div><div class="ts-home-stations"></div></div>'));
    var input = form.querySelector('input'), list = form.querySelector('.ts-home-stations');
    input.value = o.project.name;
    var rows = o.entries.map(function (e) {
      var box = list.appendChild(h('<div class="ts-home-st"><label class="ts-switch ts-home-st-name"><input type="checkbox" data-f="station" checked>' +
        '<span></span></label><div class="ts-home-chans"></div></div>'));
      box.setAttribute('data-station', e.station.name);
      box.querySelector('span').textContent = e.station.name;
      var chans = box.querySelector('.ts-home-chans'), on = box.querySelector('[data-f=station]');
      var picked = channelChecks(chans, channelsOf(e.attrs, o.names, o.kinds));
      on.addEventListener('change', function () { chans.hidden = !on.checked; check(); });
      return { station: e.station, on: on, picked: picked };
    });
    if (!rows.length) { list.appendChild(h('<div class="ts-empty">The project has no station in service yet.</div>')); }
    dr.body.appendChild(h('<div class="ts-row-meta"></div>')).textContent = 'Its public link shows exactly what is ticked here. ' +
      'It opens in ThingsBoard afterwards, to arrange as you like.' +
      (o.replaces ? ' It replaces ' + o.replaces + ' as the project dashboard; that one stays in ThingsBoard, without a public link.' : '');
    var go = ui.drawerActions(dr, 'Create');
    function picks() {
      return rows.filter(function (r) { return r.on.checked; }).map(function (r) { return { station: r.station, channels: r.picked() }; });
    }
    function check() { go.disabled = !input.value.trim() || !picks().length; }
    input.addEventListener('input', check);
    check();
    go.addEventListener('click', function () {
      var title = input.value.trim(), chosen = picks();
      go.disabled = true;
      createHome(o.project, o.owner, chosen, title).then(function (id) {
        ui.closeDrawer();
        ui.toast(title + ' created');
        o.done(id, chosen);
      }).catch(function (err) {
        check();
        ui.toast('Project dashboard not created: ' + errText(err), 'error');
      });
    });
  }

  /** *Add to project dashboard*: the station's channels to show. `o`: station,
   * attrs, names, kinds, homeId, note (what else it changes, optional), done(). */
  function openAddToHome(o) {
    var dr = ui.openDrawer('Add to project dashboard', esc(o.station.name));
    dr.body.appendChild(h('<div class="ts-section-head">What it shows</div>'));
    var picked = channelChecks(dr.body.appendChild(h('<div class="ts-home-chans"></div>')), channelsOf(o.attrs, o.names, o.kinds));
    dr.body.appendChild(h('<div class="ts-row-meta"></div>')).textContent = 'On the map, then below the other stations, with its alarms. ' +
      (o.note || '');
    var go = ui.drawerActions(dr, 'Add');
    go.addEventListener('click', function () {
      go.disabled = true;
      addToHome(o.homeId, { station: o.station, channels: picked() }).then(function () {
        ui.closeDrawer();
        ui.toast(o.station.name + ' added to the project dashboard');
        o.done();
      }).catch(function (err) {
        go.disabled = false;
        ui.toast('Not added: ' + errText(err), 'error');
      });
    });
  }

  var ICON_TRASH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 13h10l1-13"/><path d="M9 7V4h6v3"/></svg>';

  function errText(e) { return (e && e.error && e.error.message) || (e && e.message) || String(e); }

  var listed = null;
  /** Every template the user can read, and those of `owner` for a tenant admin on a customer's station. */
  function loadTemplates(owner, me) {
    if (listed) { return listed; }
    var lists = [tb.get('/api/entityGroups/DASHBOARD')];
    if (me.authority === 'TENANT_ADMIN' && owner && owner.entityType === 'CUSTOMER') {
      lists.push(tb.get('/api/entityGroups/CUSTOMER/' + owner.id + '/DASHBOARD').catch(function () { return []; }));
    }
    listed = Promise.all(lists).then(function (got) {
      var seen = {};
      var groups = [].concat.apply([], got).filter(function (g) {
        if (!g || g.name !== TEMPLATE_GROUP || seen[g.id.id]) { return false; }
        seen[g.id.id] = true;
        return true;
      });
      return Promise.all(groups.map(function (g) {
        return tb.get('/api/entityGroup/' + g.id.id + '/dashboards', { pageSize: '200', page: '0' }).then(function (page) {
          return Promise.all(((page && page.data) || []).map(function (d) {
            return tb.get('/api/dashboard/' + d.id.id).then(function (full) {
              return { id: d.id.id, title: d.title, tenant: g.ownerId.entityType === 'TENANT', channels: resolver.dashboardChannels(full) };
            });
          }));
        });
      }));
    }).then(function (lists) { return [].concat.apply([], lists); });
    listed.catch(function () { listed = null; });
    return listed;
  }

  /** *Charts dashboard*: the station's linked template, the templates it can open
   * by fit, and *Create from this station*. `o`: station, attrs, owner, names,
   * kinds, calcAttributes, canCreate, order (channel order, optional),
   * open(dashboardId), changed() after a write. */
  function openPanel(o) {
    var calc = root.TerrySenseCalculations(ui, tb);
    var meta = { names: o.names, attributes: o.calcAttributes };
    var current = o.attrs['config.stationDashboard'] || null;
    var dr = ui.openDrawer('Charts dashboard', esc(o.station.name));
    dr.body.appendChild(h('<div class="ts-loading">Loading the templates…</div>'));
    function charts() { return channelsOf(o.attrs, o.names, o.kinds, o.order); }
    function labelsOf(keys) { return keys.map(function (k) { return calc.channelLabel(meta, o.attrs, k); }); }
    function attrLabels(attrs) { return attrs.map(function (a) { return (o.calcAttributes[a] || {}).label || a; }); }

    tb.currentUser().then(function (me) {
      me = me || {};
      var tenantAdmin = me.authority === 'TENANT_ADMIN';
      function mayEdit(t) { return o.canCreate && (tenantAdmin || !t.tenant); }
      function whose(t) { return t.tenant ? 'in-terra' : tenantAdmin ? 'customer' : 'own'; }

      function assign(t) {
        tb.saveAttrs(o.station, { 'config.stationDashboard': t.id }).then(function () {
          ui.closeDrawer();
          ui.toast(o.station.name + ' opens ' + t.title);
          o.changed();
        }).catch(function (err) { ui.toast('Not saved: ' + errText(err), 'error'); });
      }

      /** A template one setting away: enter the constants, then the station opens it. */
      function openSetup(t, needs) {
        var turnsOn = resolver.calculationPlan(o.attrs, o.names).filter(function (p) {
          return !p.on && p.needs.every(function (a) { return needs.indexOf(a) >= 0; }) && t.channels.indexOf(p.name) >= 0;
        }).map(function (p) { return p.name; });
        var sd = ui.openDrawer(esc('Set up ' + t.title), esc(o.station.name));
        sd.body.appendChild(h('<p class="ts-calc-intro"></p>')).textContent = t.title + ' shows ' + calc.listText(labelsOf(turnsOn)) +
          ', calculated from this station\'s readings and the ' + (needs.length === 1 ? 'setting' : 'settings') + ' below.';
        var f = calc.form(o.station, o.attrs, needs, meta);
        sd.body.appendChild(f.el);
        sd.body.appendChild(h('<div class="ts-field-hint">Values are calculated from the latest reading on; earlier readings are not recalculated.</div>'));
        sd.onBack(function () { openPanel(o); });
        var go = ui.drawerActions(sd, 'Save and assign');
        function check() { go.disabled = !f.values(); }
        f.onChange(check);
        check();
        setTimeout(f.focus, 0);
        go.addEventListener('click', function () {
          var write = f.values();
          if (!write) { return; }
          go.disabled = true;
          write['config.stationDashboard'] = t.id;
          calc.save(o.station, write).then(function () {
            ui.closeDrawer();
            ui.toast(o.station.name + ' opens ' + t.title);
            o.changed();
          }).catch(function (err) {
            go.disabled = false;
            ui.toast('Not saved: ' + errText(err), 'error');
          });
        });
      }

      function addTo(t, missing) {
        ui.confirm('Add ' + missing.length + (missing.length === 1 ? ' channel' : ' channels') + ' to <b>' + esc(t.title) + '</b>, below its widgets? ' +
          'Every station that opens it shows them.', 'Add').then(function (ok) {
          if (!ok) { return null; }
          return addChannels(t.id, missing).then(function (n) {
            listed = null;
            ui.closeDrawer();
            ui.toast(n + (n === 1 ? ' channel' : ' channels') + ' added to ' + t.title);
            o.open(t.id);
          });
        }).catch(function (err) { ui.toast('Not added: ' + errText(err), 'error'); });
      }

      function unlink() {
        tb.deleteAttrs(o.station, ['config.stationDashboard']).then(function () {
          ui.closeDrawer();
          ui.toast('Charts dashboard unlinked from ' + o.station.name);
          o.changed();
        }).catch(function (err) { ui.toast('Not saved: ' + errText(err), 'error'); });
      }

      function describe(r) {
        return r.fit.fits ? 'Shows ' + calc.listText(labelsOf(r.t.channels))
          : !r.t.channels.length ? 'Shows no measurement'
          : r.fit.missing.length ? 'Not measured here: ' + calc.listText(labelsOf(r.fit.missing))
          : 'Needs ' + calc.listText(attrLabels(r.fit.needs)) + ' to calculate ' + calc.listText(labelsOf(r.t.channels.filter(function (c) {
            return !(c in resolver.channelsFromAttrs(o.attrs, o.names));
          })));
      }

      function option(r) {
        var el = h('<div class="ts-opt" tabindex="0"><div class="ts-opt-main"><div class="ts-opt-label"></div><div class="ts-opt-desc"></div></div>' +
          '<div class="ts-opt-side"></div></div>');
        el.querySelector('.ts-opt-label').textContent = r.t.title;
        el.querySelector('.ts-opt-desc').textContent = describe(r);
        var side = el.querySelector('.ts-opt-side');
        if (r.fit.fits) { side.appendChild(h('<span class="ts-chip accent">fits</span>')); }
        else if (!r.fit.missing.length && r.fit.needs.length) {
          side.appendChild(h('<span class="ts-chip">' + (r.fit.needs.length === 1 ? '1 setting' : r.fit.needs.length + ' settings') + '</span>'));
        }
        side.appendChild(h('<span class="ts-chip level">' + whose(r.t) + '</span>'));
        if (mayEdit(r.t)) { el.appendChild(ownerButtons(r.t)); }
        function pick() { if (!r.fit.missing.length && r.fit.needs.length) { openSetup(r.t, r.fit.needs); } else { assign(r.t); } }
        el.addEventListener('click', pick);
        el.addEventListener('keydown', function (e) { if (e.key === 'Enter') { pick(); } });
        return el;
      }

      /** Every station that opens `t`, among those the user can read. */
      function stationsOf(t) {
        return tb.post('/api/entitiesQuery/find', {
          entityFilter: { type: 'assetType', assetTypes: ['Station'], assetNameFilter: '' },
          entityFields: [{ type: 'ENTITY_FIELD', key: 'name' }],
          keyFilters: [{ key: { type: 'SERVER_ATTRIBUTE', key: 'config.stationDashboard' }, valueType: 'STRING',
            predicate: { type: 'STRING', operation: 'EQUAL', value: { defaultValue: t.id }, ignoreCase: false } }],
          pageLink: { page: 0, pageSize: 1000, sortOrder: { key: { type: 'ENTITY_FIELD', key: 'name' }, direction: 'ASC' } }
        }).then(function (page) {
          return ((page && page.data) || []).map(function (e) {
            return { entityType: 'ASSET', id: e.entityId.id, name: ((e.latest.ENTITY_FIELD || {}).name || {}).value || e.entityId.id };
          });
        });
      }

      /** Delete `t`: the stations that open it are unlinked first, so none keeps a link to nothing. */
      function remove(t) {
        stationsOf(t).then(function (stations) {
          var names = stations.slice(0, 5).map(function (st) { return '<b>' + esc(st.name) + '</b>'; });
          var who = !stations.length ? 'No station opens it.'
            : (stations.length === 1 ? '1 station opens it: ' : stations.length + ' stations open it: ') + calc.listText(names) +
              (stations.length > 5 ? ' and ' + (stations.length - 5) + ' more' : '') + '. They go back to their station view.';
          return ui.confirm('Delete the template <b>' + esc(t.title) + '</b>? ' + who + ' This cannot be undone.', 'Delete').then(function (ok) {
            if (!ok) { return null; }
            return Promise.all(stations.map(function (st) { return tb.deleteAttrs(st, ['config.stationDashboard']); })).then(function () {
              return tb.del('/api/dashboard/' + t.id);
            }).then(function () {
              listed = null;
              ui.closeDrawer();
              ui.toast(t.title + ' deleted');
              o.changed();
            });
          });
        }).catch(function (err) { ui.toast('Not deleted: ' + errText(err), 'error'); });
      }

      /** Open `t` on its landing view: ThingsBoard edits a dashboard only when no view state names an entity. */
      function edit(t) {
        ui.closeDrawer();
        ui.toast('Click the pencil at the bottom right of ' + t.title + ', then pick its "station" view in the view list. Every station that opens it follows.');
        tb.openDashboard(t.id);
      }

      /** Edit and Delete for a template the user may change. */
      function ownerButtons(t) {
        var box = h('<span class="ts-tpl-own"></span>');
        box.appendChild(h('<button type="button" class="ts-icon-btn" data-a="edit-template" title="Edit this template">' + ui.ICON.edit + '</button>'))
          .addEventListener('click', function (e) { e.stopPropagation(); edit(t); });
        box.appendChild(h('<button type="button" class="ts-icon-btn ts-tpl-del" data-a="delete-template" title="Delete this template">' + ICON_TRASH + '</button>'))
          .addEventListener('click', function (e) { e.stopPropagation(); remove(t); });
        return box;
      }

      /** The linked dashboard: Edit and Delete beside its title, what it shows here, then Open, add the station's other channels, Unlink. */
      function linkedCard(t) {
        var card = h('<div class="ts-section ts-tpl-current"><div class="ts-section-head">Linked now</div>' +
          '<div class="ts-tpl-current-box"><div class="ts-tpl-current-title"><span class="ts-opt-label"></span></div>' +
          '<div class="ts-tpl-current-lines"></div><div class="ts-tpl-current-acts"></div></div></div>');
        var title = card.querySelector('.ts-tpl-current-title'), lines = card.querySelector('.ts-tpl-current-lines');
        var acts = card.querySelector('.ts-tpl-current-acts');
        function line(text, warn) {
          var l = lines.appendChild(h('<div class="ts-opt-desc"></div>'));
          l.textContent = text;
          if (warn) { l.classList.add('ts-tpl-warn'); }
        }
        var own = t && t.fit && mayEdit(t);
        if (!t) {
          title.firstChild.textContent = 'A dashboard that no longer exists or that you cannot read';
          line('The station opens its station view instead. Link a template below, or unlink it.', true);
        } else {
          title.firstChild.textContent = t.title;
          if (t.fit) {
            title.appendChild(h('<span class="ts-chip level">' + whose(t) + '</span>'));
            if (own) { title.appendChild(ownerButtons(t)).classList.add('ts-tpl-current-own'); }
            var shown = t.channels.filter(function (c) { return t.fit.missing.indexOf(c) < 0; });
            if (shown.length) { line('Shows ' + calc.listText(labelsOf(shown))); }
            if (t.fit.missing.length) { line('Stays empty for ' + calc.listText(labelsOf(t.fit.missing)) + ': this station does not measure them', true); }
            else if (t.fit.needs.length) { line('Waits for ' + calc.listText(attrLabels(t.fit.needs)) + ' to calculate what it shows', true); }
          } else {
            line('A dashboard outside the station templates');
          }
          acts.appendChild(h('<button type="button" class="ts-btn" data-a="open-dashboard">Open</button>'))
            .addEventListener('click', function () { ui.closeDrawer(); o.open(t.id); });
          var missing = t.channels ? missingFrom(t.channels, charts()) : [];
          if (missing.length) {
            line('Not shown: ' + calc.listText(missing.map(function (c) { return c.label; })));
            if (own) {
              var add = acts.appendChild(h('<button type="button" class="ts-btn" data-a="add-channels"></button>'));
              add.textContent = missing.length === 1 ? 'Add ' + missing[0].label : 'Add these ' + missing.length;
              add.title = 'Append to the template, below its widgets';
              add.addEventListener('click', function () { addTo(t, missing); });
            }
          }
        }
        acts.appendChild(h('<span class="ts-spacer"></span>'));
        acts.appendChild(h('<button type="button" class="ts-btn ghost" data-a="unlink">Unlink</button>')).addEventListener('click', unlink);
        return card;
      }

      return loadTemplates(o.owner, me).then(function (list) {
        var rows = list.map(function (t) { return { t: t, fit: resolver.templateFit(t.channels, o.attrs, o.names) }; })
          .sort(function (a, b) {
            return (a.fit.missing.length - b.fit.missing.length) || (a.fit.needs.length - b.fit.needs.length) || a.t.title.localeCompare(b.t.title);
          });
        var linked = rows.filter(function (r) { return r.t.id === current; })[0];
        var others = rows.filter(function (r) { return r !== linked; });
        var outside = current && !linked ? tb.get('/api/dashboard/info/' + current).catch(function () { return null; }) : Promise.resolve(null);
        return outside.then(function (info) {
          dr.body.innerHTML = '';
          if (current) {
            dr.body.appendChild(linkedCard(linked ? Object.assign({ fit: linked.fit }, linked.t) : info && { id: current, title: info.title }));
          }
          var ready = others.filter(function (r) { return r.fit.fits; });
          var groups = [
            ['Ready for this station', ready],
            ['One step away: a setting to enter', others.filter(function (r) { return !r.fit.fits && !r.fit.missing.length && r.fit.needs.length; })],
            ['Other templates', others.filter(function (r) { return r.fit.missing.length || !r.t.channels.length; })]
          ];
          dr.body.appendChild(h('<div class="ts-section-head ts-tpl-list-head"></div>')).textContent = current ? 'Link another template' : 'Link a template';
          if (!current) {
            dr.body.appendChild(h('<p class="ts-field-hint ts-tpl-intro">The station\'s <i>Charts</i> button opens the template linked here. ' +
              'A template shows channels by name, so one serves every station that has them.</p>'));
          }
          if (!others.length) { dr.body.appendChild(h('<div class="ts-empty">' + (current ? 'No other template yet.' : 'No template yet.') + '</div>')); }
          groups.forEach(function (g) {
            if (!g[1].length) { return; }
            var box = h('<div class="ts-opt-group"><div class="ts-subhead"></div></div>');
            box.firstChild.textContent = g[0];
            g[1].forEach(function (r) { box.appendChild(option(r)); });
            dr.body.appendChild(box);
          });
          if (!o.canCreate) { return; }
          dr.foot.hidden = false;
          dr.foot.innerHTML = '<span class="ts-row-meta"></span><span class="ts-spacer"></span>';
          if (ready.length) { dr.foot.firstChild.textContent = ready.length === 1 ? 'A template above already fits.' : ready.length + ' templates above already fit.'; }
          dr.foot.appendChild(h('<button type="button" class="ts-btn' + (ready.length || linked ? '' : ' primary') + '" data-a="create-template">' +
            ui.ICON.plus + ' Create from this station</button>')).addEventListener('click', function () {
            openCreate({ station: o.station, owner: o.owner, channels: charts(), back: function () { openPanel(o); },
              done: function (id) { listed = null; o.open(id); } });
          });
        });
      });
    }).catch(function (err) {
      dr.body.innerHTML = '';
      dr.body.appendChild(h('<div class="ts-empty ts-error"></div>')).textContent = 'Could not load the templates: ' + errText(err);
    });
  }

  return { CHARTS: CHARTS, chartOf: chartOf, channelsOf: channelsOf, create: create, addChannels: addChannels,
           missingFrom: missingFrom, openCreate: openCreate, openPanel: openPanel,
           homeStations: homeStations, openCreateHome: openCreateHome, openAddToHome: openAddToHome };
};

})(typeof self !== 'undefined' ? self : this);
