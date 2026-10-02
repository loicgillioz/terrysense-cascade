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
        function pick() { if (!r.fit.missing.length && r.fit.needs.length) { openSetup(r.t, r.fit.needs); } else { assign(r.t); } }
        el.addEventListener('click', pick);
        el.addEventListener('keydown', function (e) { if (e.key === 'Enter') { pick(); } });
        return el;
      }

      /** The linked dashboard: open it, add the station's new channels to it, unlink it. */
      function linkedCard(t) {
        var card = h('<div class="ts-section ts-tpl-current"><div class="ts-section-head">Linked now</div>' +
          '<div class="ts-tpl-current-row"><div class="ts-opt-main"><div class="ts-opt-label"></div><div class="ts-opt-desc"></div></div>' +
          '<div class="ts-tpl-current-acts"></div></div></div>');
        var acts = card.querySelector('.ts-tpl-current-acts');
        if (!t) {
          card.querySelector('.ts-opt-label').textContent = 'A dashboard that no longer exists or that you cannot read';
          card.querySelector('.ts-opt-desc').textContent = 'The station opens its station view instead. Pick a template below, or unlink it.';
        } else {
          card.querySelector('.ts-opt-label').textContent = t.title;
          card.querySelector('.ts-opt-desc').textContent = t.fit ? describe({ t: t, fit: t.fit }) : 'A dashboard outside the station templates';
          acts.appendChild(h('<button type="button" class="ts-btn" data-a="open-dashboard">Open</button>'))
            .addEventListener('click', function () { ui.closeDrawer(); o.open(t.id); });
          var missing = t.channels && mayEdit(t) ? missingFrom(t.channels, charts()) : [];
          if (missing.length) {
            var add = acts.appendChild(h('<button type="button" class="ts-btn" data-a="add-channels"></button>'));
            add.textContent = 'Add this station\'s channels (' + missing.length + ')';
            add.title = missing.map(function (c) { return c.label; }).join(', ');
            add.addEventListener('click', function () { addTo(t, missing); });
          }
        }
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
          if (!others.length) { dr.body.appendChild(h('<div class="ts-empty">' + (current ? 'No other template yet.' : 'No template yet.') + '</div>')); }
          groups.forEach(function (g) {
            if (!g[1].length) { return; }
            var box = h('<div class="ts-opt-group"><div class="ts-section-head"></div></div>');
            box.firstChild.textContent = current ? 'Or link another: ' + g[0].charAt(0).toLowerCase() + g[0].slice(1) : g[0];
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
           missingFrom: missingFrom, openCreate: openCreate, openPanel: openPanel };
};

})(typeof self !== 'undefined' ? self : this);
