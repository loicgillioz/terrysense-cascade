/*
 * Station dashboards drawn from a station's channels — `window.TerrySenseTemplates(ui, tb)`.
 * Each channel is drawn with its name's default chart (vocabulary.md §5),
 * copied from the tenant's "Chart models" dashboard; a template binds channel
 * names, so every station with the same names can take it.
 * logr-product-docs/cloud/FRONTEND.md *Station dashboards*.
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

  /** Append a value card and the chart of each channel below the station view's widgets. */
  function appendBands(conf, models, channels) {
    var widgets = conf.widgets, layout = stationLayout(conf);
    var mlayout = models.dashboard.configuration.states.station.layouts.main.widgets;
    var alias = stationAlias(conf);
    var row = Object.keys(layout).reduce(function (m, id) { return Math.max(m, layout[id].row + layout[id].sizeY); }, 0);
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
        where = h('<div class="ts-field ts-tpl-group"><label class="ts-switch"><input type="radio" name="ts-tpl-group" value="tenant" checked>' +
          ' With the in-terra templates, shared with every customer</label><label class="ts-switch"><input type="radio" name="ts-tpl-group" value="owner">' +
          ' <span></span></label></div>');
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

  return { CHARTS: CHARTS, chartOf: chartOf, channelsOf: channelsOf, create: create, addChannels: addChannels,
           missingFrom: missingFrom, openCreate: openCreate };
};

})(typeof self !== 'undefined' ? self : this);
