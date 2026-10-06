/*
 * Station dashboards drawn from a station's channels — `window.TerrySenseTemplates(ui, tb)`.
 * Each channel is drawn with its name's default chart (vocabulary.md §5),
 * copied from the tenant's "Chart models" dashboard; a template binds channel
 * names, so every station with the same names can take it. A project dashboard
 * draws charts planned across its stations from the same models, each line
 * bound to its own station.
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
  var TABLE_FQN = 'system.cards.entities_table';
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
      if (conf.widgets[id].typeFullFqn === TABLE_FQN) { out.table = id; }
    });
    out.alias = stationAlias(conf);
    return out;
  }

  function stationAlias(conf) {
    var aliases = conf.entityAliases || {};
    return Object.keys(aliases).filter(function (k) { return (aliases[k].filter || {}).type === 'stateEntity'; })[0];
  }

  /** `obj` from a model with the placeholders of channel `c` filled in; `from`/`to` swaps an alias id too. */
  function fill(obj, c, from, to) {
    var text = JSON.stringify(obj).split(PLACEHOLDER.channel).join(jsonText(c.key))
      .split(PLACEHOLDER.label).join(jsonText(c.label)).split(PLACEHOLDER.unit).join(jsonText(c.unit));
    if (from && to) { text = text.split(from).join(to); }
    return JSON.parse(text);
  }

  /** One model widget filled in for channel `c`, bound to `alias`. */
  function copyModel(models, modelId, c, alias) {
    var copy = fill(models.dashboard.configuration.widgets[modelId], c, models.alias, alias);
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
    return tb.namedGroup(owner, 'DASHBOARD', TEMPLATE_GROUP);
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

  var PALETTE = ['#2196f3', '#ef6c00', '#43a047', '#8e24aa', '#e53935', '#00897b', '#6d4c41', '#3949ab'];
  var CHART_FQNS = ['system.time_series_chart', 'system.bar_chart_with_labels', 'system.state_chart'];
  var ICON_UP = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M6 11l6-6 6 6"/></svg>';
  var ICON_DOWN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M6 13l6 6 6-6"/></svg>';

  /** The owner's group of project dashboards, never shared, so each one is public only through its own public link. */
  function homeGroup(owner) { return tb.namedGroup(owner, 'DASHBOARD', HOME_GROUP); }

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

  function rootLayout(conf) {
    var id = Object.keys(conf.states).filter(function (k) { return conf.states[k].root; })[0] || Object.keys(conf.states)[0];
    return conf.states[id].layouts.main.widgets;
  }

  /** Every channel of the stations, by key: label, unit, chart, and the station channels behind it in `at`. `entries`: [{station, attrs}]. */
  function catalogOf(entries, names, kinds) {
    var cat = { keys: [], by: {} };
    entries.forEach(function (e) {
      channelsOf(e.attrs, names, kinds).forEach(function (c) {
        var it = cat.by[c.key];
        if (!it) {
          var vocab = names[resolver.splitChannelKey(c.key).name] || {};
          it = cat.by[c.key] = { key: c.key, label: vocab.label || c.label, unit: c.unit, chart: c.chart, at: {} };
          cat.keys.push(c.key);
        }
        it.at[e.station.id] = c;
      });
    });
    return cat;
  }

  function chartable(c) { return c.chart !== 'value'; }

  function unitsOf(cat, keys) {
    var units = [];
    keys.forEach(function (k) { var u = cat.by[k].unit || ''; if (units.indexOf(u) < 0) { units.push(u); } });
    return units;
  }

  /** Why channel `key` cannot join chart `ch`, '' when it can: one chart kind per chart,
   * at most two units on a line chart (one axis each), one on bars, one channel on a state timeline. */
  function joinBlock(cat, ch, key) {
    var c = cat.by[key];
    if (c.chart !== ch.chart) { return CHARTS[c.chart].toLowerCase() + ', not ' + CHARTS[ch.chart].toLowerCase(); }
    if (ch.chart === 'state') { return 'a state timeline shows one channel'; }
    var units = unitsOf(cat, ch.channels.concat([key]));
    if (ch.chart === 'line' && units.length > 2) { return 'a third unit'; }
    if (ch.chart !== 'line' && units.length > 1) { return 'another unit'; }
    return '';
  }

  /** One chart per channel, every station measuring it on it. */
  function starterPlan(cat, stationIds) {
    return cat.keys.filter(function (k) { return chartable(cat.by[k]); }).map(function (k) { return newChart(cat, k, stationIds); });
  }

  /** A chart of `key` with every station of `stationIds` measuring it, titled by
   * the stations' own label when they agree on one, else by the vocabulary's. */
  function newChart(cat, key, stationIds) {
    var ids = stationIds.filter(function (id) { return cat.by[key].at[id]; });
    var labels = ids.map(function (id) { return cat.by[key].at[id].label; });
    var own = labels.length && labels.every(function (l) { return l === labels[0]; }) ? labels[0] : cat.by[key].label;
    return { title: own, channels: [key], chart: cat.by[key].chart, together: true, stations: ids };
  }

  /** The chart `ch` from its model: a line per station and channel, labelled by station when several share it;
   * a second unit on a right-hand axis; alarm bands only with a single station, whose limits they are. */
  function chartWidget(models, cat, ch, stations, aliasOf, title) {
    var modelId = models.ids[ch.chart], model = models.dashboard.configuration.widgets[modelId];
    var series = [];
    stations.forEach(function (st) {
      ch.channels.forEach(function (k) { if (cat.by[k].at[st.id]) { series.push({ st: st, c: cat.by[k].at[st.id] }); } });
    });
    var w = copyModel(models, modelId, series[0].c, aliasOf(series[0].st.id));
    var mds = model.config.datasources[0], ms = model.config.settings || {}, s = w.config.settings;
    var multi = stations.length > 1, units = unitsOf(cat, ch.channels);
    function axis(key) { return units.indexOf(cat.by[key].unit || '') === 1 ? 'right' : 'default'; }
    if (units.length > 1 && s.yAxes && s.yAxes['default']) {
      Object.assign(s.yAxes['default'], { units: units[0], label: units[0] });
      s.yAxes.right = Object.assign(JSON.parse(JSON.stringify(s.yAxes['default'])), { id: 'right', position: 'right', order: 1, units: units[1], label: units[1] });
      w.config.units = '';
    }
    var n = 0;
    w.config.datasources = stations.map(function (st) {
      var mine = series.filter(function (x) { return x.st === st; });
      if (!mine.length) { return null; }
      return { type: 'entity', name: '', entityAliasId: aliasOf(st.id),
        dataKeys: mine.map(function (x) {
          var key = fill(mds.dataKeys[0], x.c);
          key.label = multi ? st.name + ' · ' + x.c.label : x.c.label;
          key.color = PALETTE[n++ % PALETTE.length];
          if (units.length > 1) { key.settings = Object.assign(key.settings || {}, { yAxisId: axis(x.c.key) }); }
          return key;
        }),
        latestDataKeys: multi ? [] : [].concat.apply([], mine.map(function (x) {
          return (mds.latestDataKeys || []).map(function (k) { return fill(k, x.c); });
        }))
      };
    }).filter(Boolean);
    if (s.thresholds) {
      s.thresholds = multi ? [] : [].concat.apply([], series.map(function (x) {
        return (ms.thresholds || []).map(function (t) { var y = fill(t, x.c); y.yAxisId = axis(x.c.key); return y; });
      }));
    }
    w.config.title = title;
    return w;
  }

  /** The latest value of each of `keys`, one row per station of alias `alias`. */
  function tableWidget(models, cat, keys, alias) {
    var w = JSON.parse(JSON.stringify(models.dashboard.configuration.widgets[models.table]));
    var ds = w.config.datasources[0];
    w.id = uuid();
    delete ds.filterId;
    ds.entityAliasId = alias;
    ds.dataKeys = [ds.dataKeys[0]].concat(keys.map(function (k) { return tableKey(cat.by[k]); }));
    w.config.actions = {};
    w.config.title = 'Latest values';
    Object.assign(w.config.settings, { entitiesTitle: 'Latest values', displayEntityLabel: false, displayEntityType: false });
    return w;
  }

  function tableKey(c) {
    return { name: c.key, type: 'timeseries', label: c.label + (c.unit ? ' (' + c.unit + ')' : ''), units: c.unit, decimals: 2, settings: {} };
  }

  /** The stations of `plan` chart `ch` draws: those still picked that measure one of its channels. */
  function chartStations(plan, ch) {
    return plan.stations.filter(function (st) {
      return ch.stations.indexOf(st.id) >= 0 && ch.channels.some(function (k) { return plan.cat.by[k].at[st.id]; });
    });
  }

  /** A dashboard titled `plan.title` in the owner's project dashboards: the map
   * and the active alarms of `plan.stations`, their latest values, then each
   * chart of `plan.charts`, together or once per station. Linked from the
   * project's `config.homeDashboard`; resolves to its id. */
  function createHome(project, owner, plan) {
    return Promise.all([loadModels(), tb.get('/api/widgetType', { fqn: MAP_FQN }), homeGroup(owner)]).then(function (got) {
      var models = modelsOf(got[0]), mconf = got[0].configuration;
      models.dashboard = got[0];
      var mlayout = mconf.states.station.layouts.main;
      // Charts stack below each other, so the layout scrolls instead of squeezing them into the screen height.
      var grid = Object.assign({}, mlayout.gridSettings, { autoFillHeight: false });
      var conf = { widgets: {}, entityAliases: {}, filters: {}, timewindow: mconf.timewindow, settings: mconf.settings,
        states: { 'default': { name: plan.title, root: true, layouts: { main: { widgets: {}, gridSettings: grid } } } } };
      var layout = conf.states['default'].layouts.main.widgets;
      function place(w, sizeX, sizeY, row, col) { conf.widgets[w.id] = w; layout[w.id] = { sizeX: sizeX, sizeY: sizeY, row: row, col: col }; }
      var listId = uuid(), aliases = {};
      conf.entityAliases[listId] = { id: listId, alias: 'Stations', filter: { type: 'entityList', resolveMultiple: true,
        entityType: 'ASSET', entityList: plan.stations.map(function (st) { return st.id; }) } };
      plan.stations.forEach(function (st) { aliases[st.id] = stationAliasOf(conf, st); });
      function aliasOf(id) { return aliases[id]; }

      place(mapWidget(got[1], listId, plan.title), models.alarms ? 14 : 24, 10, 0, 0);
      if (models.alarms) { place(copyModel(models, models.alarms, { key: '', label: 'Active alarms', unit: '' }, listId), 10, 10, 0, 14); }
      var row = 10;
      var listed = plan.cat.keys.filter(function (k) { return plan.stations.some(function (st) { return plan.cat.by[k].at[st.id]; }); });
      if (models.table && listed.length) {
        var tall = Math.min(3 + plan.stations.length, 10);
        place(tableWidget(models, plan.cat, listed, listId), 24, tall, row, 0);
        row += tall;
      }
      plan.charts.forEach(function (ch) {
        var sts = chartStations(plan, ch);
        var high = mlayout.widgets[models.ids[ch.chart]].sizeY;
        (ch.together ? [sts] : sts.map(function (st) { return [st]; })).forEach(function (g) {
          place(chartWidget(models, plan.cat, ch, g, aliasOf, ch.together || sts.length < 2 ? ch.title : g[0].name + ' · ' + ch.title), 24, high, row, 0);
          row += high;
        });
      });
      return tb.post('/api/dashboard?entityGroupId=' + got[2].id.id, { title: plan.title, configuration: conf });
    }).then(function (saved) {
      var write = {};
      write[HOME_KEY] = saved.id.id;
      return tb.saveAttrs(project, write).then(function () { return saved.id.id; });
    });
  }

  /** The charts of a project dashboard drawing one of `keys`: `{id, title, keys, stations}`, `stations` the station count. */
  function homeCharts(dashboard, keys) {
    var widgets = dashboard.configuration.widgets;
    return Object.keys(widgets).filter(function (id) { return CHART_FQNS.indexOf(widgets[id].typeFullFqn) >= 0; }).map(function (id) {
      var ds = widgets[id].config.datasources || [], drawn = [];
      ds.forEach(function (d) { (d.dataKeys || []).forEach(function (k) { if (drawn.indexOf(k.name) < 0) { drawn.push(k.name); } }); });
      return { id: id, title: widgets[id].config.title, keys: drawn.filter(function (k) { return keys.indexOf(k) >= 0; }), stations: ds.length };
    }).filter(function (c) { return c.keys.length; });
  }

  /** Station `o.station` onto project dashboard `homeId`: on the lists every
   * list-bound widget reads (map, alarms, latest values), its lines on charts
   * `o.join`, and a chart of its own per channel of `o.own`. */
  function addToHome(homeId, o) {
    return Promise.all([tb.get('/api/dashboard/' + homeId), loadModels()]).then(function (got) {
      var dash = got[0], conf = dash.configuration, models = modelsOf(got[1]), cat = o.cat, st = o.station;
      models.dashboard = got[1];
      var lists = Object.keys(conf.entityAliases).filter(function (k) {
        var f = conf.entityAliases[k].filter;
        return f.type === 'entityList' && f.entityType === 'ASSET';
      });
      lists.forEach(function (k) { conf.entityAliases[k].filter.entityList.push(st.id); });
      var alias = stationAliasOf(conf, st), layout = rootLayout(conf);

      Object.keys(conf.widgets).forEach(function (id) {
        var w = conf.widgets[id], ds = (w.config.datasources || [])[0];
        if (w.typeFullFqn !== TABLE_FQN || !ds || lists.indexOf(ds.entityAliasId) < 0) { return; }
        cat.keys.forEach(function (k) {
          if (!ds.dataKeys.some(function (x) { return x.name === k; })) { ds.dataKeys.push(tableKey(cat.by[k])); }
        });
      });

      o.join.forEach(function (id) {
        var w = conf.widgets[id], all = w.config.datasources, n = 0;
        all.forEach(function (d) { n += d.dataKeys.length; });
        // A chart that gains a second station names each line by its station and leaves the alarm bands out.
        if (all.length === 1) {
          var first = (conf.entityAliases[all[0].entityAliasId] || {}).alias;
          all[0].dataKeys.forEach(function (k) { k.label = first + ' · ' + k.label; });
          all[0].latestDataKeys = [];
          if (w.config.settings.thresholds) { w.config.settings.thresholds = []; }
        }
        var keys = [];
        all.forEach(function (d) { d.dataKeys.forEach(function (k) { if (cat.by[k.name] && !keys.some(function (x) { return x.name === k.name; })) { keys.push(k); } }); });
        all.push({ type: 'entity', name: '', entityAliasId: alias, latestDataKeys: [], dataKeys: keys.map(function (k) {
          var key = JSON.parse(JSON.stringify(k));
          key.label = st.name + ' · ' + cat.by[k.name].at[st.id].label;
          key.color = PALETTE[n++ % PALETTE.length];
          return key;
        }) });
      });

      var row = bottomRow(layout), mlayout = models.dashboard.configuration.states.station.layouts.main.widgets;
      o.own.forEach(function (k) {
        var ch = { channels: [k], chart: cat.by[k].chart, stations: [st.id] };
        var w = chartWidget(models, cat, ch, [st], function () { return alias; }, st.name + ' · ' + cat.by[k].label);
        var high = mlayout[models.ids[ch.chart]].sizeY;
        conf.widgets[w.id] = w;
        layout[w.id] = { sizeX: 24, sizeY: high, row: row, col: 0 };
        row += high;
      });
      return tb.post('/api/dashboard', dash);
    });
  }

  function chip(text, title) {
    var el = h('<span class="ts-chip ts-home-chip"><span></span><button type="button" class="ts-home-x" data-a="remove">' + ui.ICON.close + '</button></span>');
    el.firstChild.textContent = text;
    el.lastChild.title = title;
    return el;
  }

  function picker(placeholder, options, pick) {
    var sel = h('<select class="ts-select ts-home-pick"></select>');
    sel.appendChild(h('<option value=""></option>')).textContent = placeholder;
    options.forEach(function (o) {
      var opt = sel.appendChild(h('<option></option>'));
      opt.value = o.value;
      opt.textContent = o.text;
      opt.disabled = !!o.disabled;
    });
    sel.hidden = !options.length;
    sel.addEventListener('change', function () { if (sel.value) { pick(sel.value); } });
    return sel;
  }

  /** *Create project dashboard*: its name, its stations, then its charts — each
   * with its channels and stations, the stations together on one chart or one
   * chart each. `o`: project, owner, entries ([{station, attrs}]), names, kinds,
   * replaces (the current dashboard's title, optional), intro (optional),
   * done(dashboardId, stations). */
  function openCreateHome(o) {
    var dr = ui.openDrawer('Create project dashboard', esc(o.project.name));
    var cat = catalogOf(o.entries, o.names, o.kinds);
    var all = o.entries.map(function (e) { return e.station; }), ticked = {};
    all.forEach(function (st) { ticked[st.id] = true; });
    var charts = starterPlan(cat, all.map(function (st) { return st.id; }));

    if (o.intro) { dr.body.appendChild(h('<p class="ts-field-hint ts-home-intro"></p>')).textContent = o.intro; }
    var input = dr.body.appendChild(h('<div class="ts-field"><label class="ts-field-label">Name</label><input class="ts-input wide" data-f="title"></div>'))
      .querySelector('input');
    input.value = o.project.name;
    var stationsEl = dr.body.appendChild(h('<div class="ts-section"><div class="ts-section-head">Stations</div><div class="ts-home-stations"></div>' +
      '<div class="ts-field-hint">On the map, with their active alarms and a table of their latest values.</div></div>')).querySelector('.ts-home-stations');
    var chartsSec = dr.body.appendChild(h('<div class="ts-section"><div class="ts-section-head">Charts</div><div class="ts-home-charts"></div></div>'));
    var cardsEl = chartsSec.querySelector('.ts-home-charts');
    var addEl = chartsSec.appendChild(h('<div class="ts-home-addchart"></div>'));
    dr.body.appendChild(h('<div class="ts-row-meta"></div>')).textContent = 'Its public link shows exactly this. ' +
      'It opens in ThingsBoard afterwards, to arrange as you like.' +
      (o.replaces ? ' It replaces ' + o.replaces + ' as the project dashboard; that one stays in ThingsBoard, without a public link.' : '');
    var go = ui.drawerActions(dr, 'Create');

    function picked() { return all.filter(function (st) { return ticked[st.id]; }); }
    function shownOn(ch) { return chartStations({ stations: picked(), cat: cat }, ch); }
    function carried(k) { return picked().some(function (st) { return cat.by[k].at[st.id]; }); }
    function label(k) { var c = cat.by[k]; return c.label + (c.unit ? ' (' + c.unit + ')' : ''); }
    function retitle(ch) { if (!ch.titled) { ch.title = ch.channels.map(function (k) { return cat.by[k].label; }).join(' and '); } }

    function renderStations() {
      stationsEl.innerHTML = '';
      all.forEach(function (st) {
        var row = stationsEl.appendChild(h('<label class="ts-switch ts-home-st"><input type="checkbox" data-f="station"><span></span>' +
          '<span class="ts-row-meta"></span></label>'));
        row.setAttribute('data-station', st.name);
        var n = cat.keys.filter(function (k) { return cat.by[k].at[st.id]; }).length;
        row.querySelector('span').textContent = st.name;
        row.querySelector('.ts-row-meta').textContent = n ? n + (n === 1 ? ' channel' : ' channels') : 'no channel yet';
        var box = row.querySelector('input');
        box.checked = !!ticked[st.id];
        box.addEventListener('change', function () {
          ticked[st.id] = box.checked;
          // A station picked again joins the shared charts of its channels.
          if (box.checked) {
            charts.forEach(function (ch) {
              if (ch.together && ch.stations.indexOf(st.id) < 0 && ch.channels.some(function (k) { return cat.by[k].at[st.id]; })) { ch.stations.push(st.id); }
            });
          }
          render();
        });
      });
    }

    function card(ch, i) {
      var sts = shownOn(ch);
      var el = h('<div class="ts-home-chart"><div class="ts-home-chart-head"><input class="ts-input ts-home-chart-title" data-f="chart-title">' +
        '<button type="button" class="ts-icon-btn" data-a="up" title="Move up">' + ICON_UP + '</button>' +
        '<button type="button" class="ts-icon-btn" data-a="down" title="Move down">' + ICON_DOWN + '</button>' +
        '<button type="button" class="ts-icon-btn" data-a="remove-chart" title="Remove this chart">' + ICON_TRASH + '</button></div>' +
        '<div class="ts-home-row"><span class="ts-home-row-label">Channels</span><span class="ts-home-chips" data-list="channels"></span></div>' +
        '<div class="ts-home-row"><span class="ts-home-row-label">Stations</span><span class="ts-home-chips" data-list="stations"></span></div>' +
        '<div class="ts-home-row ts-home-mode"><span class="ts-home-row-label">Show</span></div>' +
        '<div class="ts-row-meta ts-home-sum"></div></div>');
      el.setAttribute('data-chart', ch.channels.join('+'));
      var title = el.querySelector('[data-f=chart-title]');
      title.value = ch.title;
      title.addEventListener('input', function () { ch.title = title.value; ch.titled = true; });
      el.querySelector('[data-a=up]').disabled = i === 0;
      el.querySelector('[data-a=down]').disabled = i === charts.length - 1;
      el.querySelector('[data-a=up]').addEventListener('click', function () { charts.splice(i - 1, 0, charts.splice(i, 1)[0]); render(); });
      el.querySelector('[data-a=down]').addEventListener('click', function () { charts.splice(i + 1, 0, charts.splice(i, 1)[0]); render(); });
      el.querySelector('[data-a=remove-chart]').addEventListener('click', function () { charts.splice(i, 1); render(); });

      var chans = el.querySelector('[data-list=channels]');
      ch.channels.forEach(function (k, j) {
        chans.appendChild(chip(label(k), 'Take ' + cat.by[k].label + ' off this chart')).setAttribute('data-channel', k);
        chans.lastChild.querySelector('button').addEventListener('click', function () {
          ch.channels.splice(j, 1);
          if (!ch.channels.length) { charts.splice(i, 1); } else { retitle(ch); }
          render();
        });
      });
      chans.appendChild(picker('Add a channel…', cat.keys.filter(function (k) { return ch.channels.indexOf(k) < 0 && chartable(cat.by[k]) && carried(k); })
        .map(function (k) { var why = joinBlock(cat, ch, k); return { value: k, text: label(k) + (why ? ' — ' + why : ''), disabled: !!why }; }),
        function (k) {
          ch.channels.push(k);
          picked().forEach(function (st) { if (ch.together && cat.by[k].at[st.id] && ch.stations.indexOf(st.id) < 0) { ch.stations.push(st.id); } });
          retitle(ch);
          render();
        })).setAttribute('data-a', 'add-channel');

      var stList = el.querySelector('[data-list=stations]');
      sts.forEach(function (st) {
        stList.appendChild(chip(st.name, 'Take ' + st.name + ' off this chart')).setAttribute('data-station', st.name);
        stList.lastChild.querySelector('button').addEventListener('click', function () {
          ch.stations.splice(ch.stations.indexOf(st.id), 1);
          render();
        });
      });
      if (!sts.length) { stList.appendChild(h('<span class="ts-home-none">None: this chart is left out</span>')); }
      stList.appendChild(picker('Add a station…', picked().filter(function (st) {
        return sts.indexOf(st) < 0 && ch.channels.some(function (k) { return cat.by[k].at[st.id]; });
      }).map(function (st) { return { value: st.id, text: st.name }; }), function (id) { ch.stations.push(id); render(); })).setAttribute('data-a', 'add-station');

      var mode = el.querySelector('.ts-home-mode');
      if (sts.length > 1) {
        [['together', 'Together, one chart'], ['apart', 'One chart per station']].forEach(function (m) {
          var r = mode.appendChild(h('<label class="ts-switch"><input type="radio"><span></span></label>'));
          var radio = r.querySelector('input');
          radio.name = 'ts-home-mode-' + i;
          radio.value = m[0];
          radio.checked = ch.together === (m[0] === 'together');
          r.querySelector('span').textContent = m[1];
          radio.addEventListener('change', function () { ch.together = m[0] === 'together'; render(); });
        });
      } else {
        mode.hidden = true;
      }

      var lines = 0;
      sts.forEach(function (st) { ch.channels.forEach(function (k) { if (cat.by[k].at[st.id]) { lines++; } }); });
      var units = unitsOf(cat, ch.channels).filter(Boolean);
      var single = sts.length === 1 || !ch.together;
      el.querySelector('.ts-home-sum').textContent = [
        CHARTS[ch.chart],
        ch.together || sts.length < 2 ? lines + (lines === 1 ? ' line' : ' lines') : sts.length + ' charts',
        units.length > 1 ? 'two axes: ' + units.join(', ') : '',
        sts.length && single && ch.chart === 'line' ? 'alarm bands' : ''
      ].filter(Boolean).join(' · ');
      return el;
    }

    function render() {
      renderStations();
      cardsEl.innerHTML = '';
      charts.forEach(function (ch, i) { cardsEl.appendChild(card(ch, i)); });
      if (!charts.length) { cardsEl.appendChild(h('<div class="ts-empty">No chart. The latest values still show in the table.</div>')); }
      addEl.innerHTML = '';
      addEl.appendChild(picker('+ Add a chart for…', cat.keys.filter(function (k) { return chartable(cat.by[k]) && carried(k); })
        .map(function (k) { return { value: k, text: label(k) }; }), function (k) {
          charts.push(newChart(cat, k, picked().map(function (st) { return st.id; })));
          render();
        })).setAttribute('data-a', 'add-chart');
      check();
    }

    function check() { go.disabled = !input.value.trim() || !picked().length; }
    input.addEventListener('input', check);
    render();

    go.addEventListener('click', function () {
      var stations = picked();
      var plan = { title: input.value.trim(), stations: stations, cat: cat,
        charts: charts.filter(function (ch) { return chartStations({ stations: stations, cat: cat }, ch).length; }) };
      go.disabled = true;
      createHome(o.project, o.owner, plan).then(function (id) {
        ui.closeDrawer();
        ui.toast(plan.title + ' created');
        o.done(id, stations);
      }).catch(function (err) {
        check();
        ui.toast('Project dashboard not created: ' + errText(err), 'error');
      });
    });
  }

  /** *Add to project dashboard*: the charts that take the station's lines, and
   * the charts of its own. `o`: station, attrs, names, kinds, homeId, note
   * (what else it changes, optional), done(). */
  function openAddToHome(o) {
    var dr = ui.openDrawer('Add to project dashboard', esc(o.station.name));
    var cat = catalogOf([{ station: o.station, attrs: o.attrs }], o.names, o.kinds);
    dr.body.appendChild(h('<div class="ts-loading">Loading the project dashboard…</div>'));
    tb.get('/api/dashboard/' + o.homeId).then(function (dash) {
      dr.body.innerHTML = '';
      dr.body.appendChild(h('<p class="ts-field-hint"></p>')).textContent = 'It joins the map, the active alarms and the latest values. ' + (o.note || '');
      var found = homeCharts(dash, cat.keys);
      var joinSec = dr.body.appendChild(h('<div class="ts-section"><div class="ts-section-head">Add its lines to</div></div>'));
      var joins = found.map(function (c) {
        var r = joinSec.appendChild(h('<label class="ts-switch ts-home-join"><input type="checkbox"><span></span><span class="ts-row-meta"></span></label>'));
        r.setAttribute('data-chart', c.title);
        r.querySelector('span').textContent = c.title;
        r.querySelector('.ts-row-meta').textContent = (c.stations === 1 ? '1 station' : c.stations + ' stations') + ' · ' +
          c.keys.map(function (k) { return cat.by[k].label; }).join(', ');
        r.querySelector('input').checked = c.stations > 1;
        return { c: c, box: r.querySelector('input') };
      });
      if (!found.length) { joinSec.appendChild(h('<div class="ts-row-meta">No chart shows its channels yet.</div>')); }
      var ownSec = dr.body.appendChild(h('<div class="ts-section"><div class="ts-section-head">Charts of its own</div></div>'));
      var own = cat.keys.filter(function (k) { return chartable(cat.by[k]); }).map(function (k) {
        var r = ownSec.appendChild(h('<label class="ts-switch ts-home-own"><input type="checkbox"><span></span><span class="ts-chip"></span></label>'));
        r.setAttribute('data-channel', k);
        r.querySelector('span').textContent = cat.by[k].label + (cat.by[k].unit ? ' (' + cat.by[k].unit + ')' : '');
        r.querySelector('.ts-chip').textContent = CHARTS[cat.by[k].chart];
        return { key: k, row: r, box: r.querySelector('input') };
      });
      if (!own.length) { ownSec.appendChild(h('<div class="ts-row-meta">No measurement to draw yet.</div>')); }
      // A channel already drawn on a ticked chart needs no chart of its own.
      function sync() {
        var covered = [];
        joins.forEach(function (j) { if (j.box.checked) { covered = covered.concat(j.c.keys); } });
        own.forEach(function (x) {
          var on = covered.indexOf(x.key) >= 0;
          x.row.classList.toggle('off', on);
          x.box.disabled = on;
          if (on) { x.box.checked = false; } else if (!x.touched) { x.box.checked = true; }
        });
      }
      joins.forEach(function (j) { j.box.addEventListener('change', sync); });
      own.forEach(function (x) { x.box.addEventListener('change', function () { x.touched = true; }); });
      sync();
      var go = ui.drawerActions(dr, 'Add');
      go.addEventListener('click', function () {
        go.disabled = true;
        addToHome(o.homeId, { station: o.station, cat: cat,
          join: joins.filter(function (j) { return j.box.checked; }).map(function (j) { return j.c.id; }),
          own: own.filter(function (x) { return x.box.checked; }).map(function (x) { return x.key; }) }).then(function () {
          ui.closeDrawer();
          ui.toast(o.station.name + ' added to the project dashboard');
          o.done();
        }).catch(function (err) {
          go.disabled = false;
          ui.toast('Not added: ' + errText(err), 'error');
        });
      });
    }).catch(function (err) {
      dr.body.innerHTML = '';
      dr.body.appendChild(h('<div class="ts-empty ts-error"></div>')).textContent = 'Could not load the project dashboard: ' + errText(err);
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
