/*
 * Station — one station as a data flow: each device that feeds it, the
 * measurements the device provides, the channel each is stored under, and the
 * station's latest value of each; then the calculated channels, each from the
 * station channels and the `calc.*` settings it reads (vocabulary.md §4), with the channels gone stale; the project
 * the station stands in above. A device opens its device view. A user who may
 * write the station changes the channel a measurement is stored under, or its
 * label, stores one not stored yet, or deletes a channel, its history with it
 * if asked (shared/mapping.js); and
 * gets the header's row menu (shared/lifecycle.js), *Silence*, and
 * *Acknowledge* and *Clear* on each active alarm. A user who may create
 * dashboards creates a station dashboard from its channels (shared/templates.js).
 * Widget: logr-product-docs/cloud/FRONTEND.md *Station view*.
 *
 * Channels are the keys of `config.channelMap`, each fed by a source key of
 * the device its entry names; labels and units are `effective.<channel>.*`. A
 * channel is stale after three measurement intervals of its source (HEALTH.md
 * §2). A name
 * the vocabulary marks diagnostic is folded away unless it is in alarm. A
 * channel with an active `<channel>.max|min|state` alarm carries its severity;
 * the station's other alarms are listed under the channels. A name the
 * vocabulary marks `rule` is no measurement: those channels are listed as the
 * station's dry contact interface rules, which open its Dry contact interface
 * view.
 *
 * `opts`, set by build_project_dashboard.py: `devicesDashboardId` (the device
 * card), `projectDashboardId` (the project card).
 *
 * Loads after shared/resolver.js, mapping.js, glossary.js, ui.js, tb_io.js, lifecycle.js and templates.js.
 */

window.TerrySenseStationView = function (ctx, container, opts) {

opts = opts || {};
var t = window.TerrySenseI18n(ctx);
var resolver = window.TerrySenseResolver;
var M = window.TerrySenseMapping;
var G = window.TerrySenseGlossary;
var tb = window.TerrySenseTbIo(ctx);
var root = container.querySelector('.ts-root') || container;
var ui = window.TerrySenseUi(root);
var life = window.TerrySenseLifecycle(ui, tb);
var templates = window.TerrySenseTemplates(ui, tb);
var calc = window.TerrySenseCalculations(ui, tb);
var h = ui.h, esc = ui.esc, ICON = ui.ICON;

var REFRESH_MS = 60000;
var FAULT_PREFIX = 'peripheralFault.';
var ICON_CHART = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19h16"/><path d="M5 15l4-5 4 3 6-7"/></svg>';
var ICON_TRASH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 13h10l1-13"/><path d="M9 7V4h6v3"/></svg>';
var CHANNEL_ALARM_RE = /^(.+)\.(max|min|state)$/;
function otherAlarms() {
  return [
    { prefix: 'peripheralFault.', text: t('station.alarmSensorFault', 'Sensor fault') },
    { prefix: 'deviceEvent.movement', text: t('station.alarmMoved', 'Logger moved') },
    { prefix: 'deviceEvent.batteryCritical', text: t('station.alarmBattery', 'Logger battery critical') },
    { prefix: 'deviceEvent.power', text: t('station.alarmPower', 'Logger power changed') },
    { prefix: 'deviceHealth', text: t('station.alarmSelfTest', 'Logger self-test fault') },
    { prefix: 'pipelineError', text: t('station.alarmPipeline', 'Data processing error') }
  ];
}

function parseJson(raw) {
  if (!raw) { return null; }
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (e) { return null; }
}

function errText(e) { return (e && e.error && e.error.message) || (e && e.message) || String(e); }

function fmtNumber(n) {
  var a = Math.abs(n);
  var digits = a >= 1000 ? 0 : a >= 100 ? 1 : a >= 1 ? 2 : 3;
  var rounded = Math.round(n * Math.pow(10, digits)) / Math.pow(10, digits), locale = t.locale();
  return locale ? rounded.toLocaleString(locale, { maximumFractionDigits: digits }) : String(rounded);
}

function flag(v) { return v === true || v === 'true'; }

function worst(severities) {
  return severities.filter(Boolean).sort(function (a, b) { return G.rank(b.toLowerCase()) - G.rank(a.toLowerCase()); })[0] || null;
}

// -- data -------------------------------------------------------------------------------

var state = {
  station: null, attrs: {}, entries: {}, names: {}, kinds: {}, peripherals: {}, calcAttributes: {}, waiting: [],
  channels: [], alarms: [], devices: [], chain: [], showDiagnostic: false, loadedAt: 0,
  canWrite: false, canCreateDashboards: false, owner: null, service: null, pub: null
};

function loadDefaults() {
  return tb.io.fetchDefaults().then(function (d) { return d ? tb.attrsMap(d) : {}; }).then(function (a) {
    state.names = parseJson(a['config.channelNames']) || {};
    state.kinds = parseJson(a['config.kinds']) || {};
    state.peripherals = parseJson(a['config.peripherals']) || {};
    state.calcAttributes = parseJson(a['config.calcAttributes']) || {};
  });
}

function channelOf(name, entry, attrs, latest) {
  var base = state.names[resolver.splitChannelKey(name).name] || {};
  var raw = latest[name] && latest[name][0];
  return {
    name: name, sourceKey: entry.key, device: entry.device, stale: null,
    label: t.label(name, attrs['effective.' + name + '.label'] || base.label || name, state.names),
    unit: attrs['effective.' + name + '.unit'] || '',
    diagnostic: !!base.diagnostic,
    rule: !!base.rule,
    states: base.states || null,
    whenTrue: attrs['effective.' + name + '.textWhenTrue'],
    whenFalse: attrs['effective.' + name + '.textWhenFalse'],
    latest: raw && raw.value !== null && raw.value !== undefined ? { ts: Number(raw.ts), value: raw.value } : null,
    alarm: null, alarms: []
  };
}

/** The devices the station contains, and any its map names that no relation does. */
function loadDevices(station, entries) {
  var query = {
    parameters: { rootId: station.id, rootType: 'ASSET', direction: 'FROM', relationTypeGroup: 'COMMON', maxLevel: 1, fetchLastLevelOnly: false },
    filters: [{ relationType: 'Contains', entityTypes: ['DEVICE'] }]
  };
  return tb.post('/api/relations', query).catch(function () { return []; }).then(function (rels) {
    var ids = (rels || []).map(function (r) { return r.to.id; });
    resolver.mapDevices(entries).forEach(function (d) { if (ids.indexOf(d) < 0) { ids.push(d); } });
    return Promise.all(ids.map(loadDevice));
  });
}

/** A device, with its model for the data flow: what it measures and its latest readings. */
function loadDevice(id) {
  var dev = { entityType: 'DEVICE', id: id };
  return tb.get('/api/device/' + id).then(function (d) {
    return Promise.all([
      tb.attrsMap(dev, 'SERVER_SCOPE'), tb.attrsMap(dev, 'CLIENT_SCOPE'),
      tb.get('/api/alarm/DEVICE/' + id, { searchStatus: 'ACTIVE', pageSize: '100', page: '0' }).catch(function () { return null; }),
      tb.get('/api/plugins/telemetry/DEVICE/' + id + '/keys/timeseries').catch(function () { return []; })
    ]).then(function (got) {
      var keys = tb.readingKeys(got[3]), bus = tb.isComplexDevice(d.type);
      var wanted = M.latestKeys(bus, keys);
      return (wanted.length ? tb.get('/api/plugins/telemetry/DEVICE/' + id + '/values/timeseries', { keys: wanted.join(',') })
        .catch(function () { return {}; }) : Promise.resolve({})).then(function (values) {
        var latest = {}, faults = {}, alarms = (got[2] && got[2].data) || [];
        Object.keys(values || {}).forEach(function (k) {
          var p = values[k] && values[k][0];
          if (p) { latest[k] = { ts: Number(p.ts), value: p.value }; }
        });
        alarms.forEach(function (a) { if (a.type.indexOf(FAULT_PREFIX) === 0) { faults[a.type.slice(FAULT_PREFIX.length)] = a; } });
        return { id: id, device: d, server: got[0], client: got[1], alarms: alarms,
                 dryc: keys.some(function (k) { return k.indexOf('dryc.') === 0; }),
                 model: { bus: bus, device: d, client: got[1], latest: latest, faults: faults,
                          peripherals: state.peripherals, kinds: state.kinds, names: state.names } };
      });
    });
  }).catch(function () { return { id: id, hidden: true }; });
}

function load() {
  var s = state.station, url = '/api/plugins/telemetry/ASSET/' + s.id + '/values/timeseries';
  return Promise.all([tb.attrsMap(s), tb.ancestors(s),
    state.canWrite ? tb.publicMembers(state.owner).catch(function () { return null; }) : null]).then(function (got) {
    var attrs = got[0], entries = resolver.mapEntries(attrs['config.channelMap']);
    // The mapped channels and the calculated ones the station carries; then
    // the calculated names still waiting for a setting, read for their history.
    var names = Object.keys(resolver.channelsFromAttrs(attrs, state.names));
    var waiting = resolver.calculationPlan(attrs, state.names).filter(function (p) { return !p.on; });
    var keys = names.concat(waiting.map(function (p) { return p.name; }));
    state.attrs = attrs;
    state.entries = entries;
    state.service = tb.serviceOf(attrs);
    state.chain = got[1];
    state.pub = got[2];
    return Promise.all([
      keys.length ? tb.get(url, { keys: keys.join(',') }).catch(function () { return {}; }) : {},
      tb.get('/api/alarm/ASSET/' + s.id, { searchStatus: 'ACTIVE', pageSize: '100', page: '0' }).catch(function () { return null; }),
      loadDevices(s, entries)
    ]).then(function (r) {
      state.channels = names.map(function (n) { return channelOf(n, entries[n] || { device: null, key: null }, attrs, r[0] || {}); })
        .sort(function (a, b) { return a.label.localeCompare(b.label); });
      state.waiting = waiting.map(function (p) { return { plan: p, channel: channelOf(p.name, { device: null, key: null }, attrs, r[0] || {}) }; });
      var byName = {};
      state.channels.forEach(function (c) { byName[c.name] = c; });
      state.alarms = [];
      ((r[1] && r[1].data) || []).forEach(function (a) {
        var m = CHANNEL_ALARM_RE.exec(a.type), c = m && byName[m[1]];
        if (c) { c.alarm = worst([c.alarm, a.severity]); c.alarms.push(a); } else { state.alarms.push(a); }
      });
      state.devices = r[2];
      state.loadedAt = Date.now();
      var latest = {};
      state.channels.forEach(function (c) { if (c.latest) { latest[c.name] = c.latest.ts; } });
      return tb.channelFreshness(attrs, latest, state.names).then(function (fresh) {
        state.channels.forEach(function (c) { c.stale = !state.service.retired && (fresh.channels[c.name] || {}).stale; });
      });
    });
  });
}

// -- model ------------------------------------------------------------------------------

function display(c) {
  if (!c.latest) { return { text: '—', unit: '' }; }
  var v = c.latest.value;
  if (v === true || v === 'true' || v === false || v === 'false') {
    var on = flag(v);
    return { text: (on ? c.whenTrue : c.whenFalse) || (on ? t('common.valueOn', 'on') : t('common.valueOff', 'off')), unit: '' };
  }
  if (c.states && c.states[String(v)] !== undefined) { return { text: t.state(resolver.splitChannelKey(c.name).name, c.states[String(v)]), unit: '' }; }
  var n = Number(v);
  return isNaN(n) ? { text: String(v), unit: '' } : { text: fmtNumber(n), unit: c.unit };
}

/** What feeds a channel, in words: the measurement and, on a bus, its position and peripheral. */
function measurement(c) {
  var m = M.SOURCE_KEY_RE.exec(c.sourceKey || '');
  var dev = state.devices.filter(function (d) { return !d.hidden && d.id === c.device; })[0];
  if (!m) { return channelText(c.sourceKey) || c.sourceKey || '?'; }
  var pos = Number(m[1]), kind = m[2];
  var type = dev && dev.client['topology.p' + pos + '.type'];
  var p = type && state.peripherals[type];
  var measure = p && (p.measures || []).filter(function (x) {
    return resolver.camelKind(x.kind) === kind && (x.group || 0) === Number(m[3] || 0) && (x.index || 0) === Number(m[4] || 0);
  })[0];
  var label = (measure && channelText(measure.defaultName)) || kindLabel(kind);
  var where = pos === 0 ? t('common.theLogr', 'the LOGR itself') : t('station.position', 'position {n}', { n: pos }) + (p ? ', ' + p.displayName : type ? ', ' + type : '');
  return label + ' · ' + where;
}

/** A dictionary name's label in the reader's language, or null. */
function channelText(name) {
  var label = (state.names[name] || {}).label;
  return label ? t.channel(name, label) : null;
}

function description(name) {
  var text = (state.names[name] || {}).description;
  return text ? t.channelInfo(name, text) : '';
}

function attrLabel(a) {
  var label = (state.calcAttributes[a] || {}).label;
  return label ? t.attribute(a, label) : a;
}

function kindLabel(kind) {
  var key = Object.keys(state.kinds).filter(function (k) { return resolver.camelKind(k) === resolver.camelKind(kind); })[0];
  var label = key && state.kinds[key].label;
  return label ? t.kind(key, label) : kind;
}

function stationStatus() {
  if (state.service.retired) { return { id: 'retired', label: t('common.retired', 'Retired'), color: 'var(--ts-nodata)' }; }
  var sev = worst(state.channels.map(function (c) { return c.alarm; }).concat(state.alarms.map(function (a) { return a.severity; })));
  if (sev) { return { id: 'alarm', label: G.severity(sev.toLowerCase()).label, color: 'var(--sev-' + sev.toLowerCase() + ')' }; }
  var last = state.channels.reduce(function (m, c) { return Math.max(m, c.latest ? c.latest.ts : 0); }, 0);
  if (!last) { return { id: 'nodata', label: t('common.noData', 'No data'), color: 'var(--ts-nodata)' }; }
  return { id: 'ok', label: t('common.ok', 'OK'), color: 'var(--ts-ok)' };
}

function otherAlarmText(a) {
  var kind = otherAlarms().filter(function (o) { return a.type.indexOf(o.prefix) === 0; })[0];
  if (kind && kind.prefix === 'peripheralFault.') {
    var src = a.type.slice(kind.prefix.length);
    var c = state.channels.filter(function (x) { return x.sourceKey === src || x.name === src; })[0];
    return kind.text + (c ? ': ' + c.label : '');
  }
  return kind ? kind.text : a.type;
}

// -- scaffold ---------------------------------------------------------------------------

var cardEl = h(
  '<div class="ts-card ts-stv">' +
  '  <div class="ts-head"><div class="ts-head-icon">' + ICON.gauge + '</div>' +
  '    <div class="ts-head-text"><div class="ts-title">' + esc(t('common.station', 'Station')) + '</div><div class="ts-subtitle"></div></div>' +
  '    <span class="ts-stv-chips"></span><span class="ts-chip ts-stv-state" hidden></span><span class="ts-stv-acts"></span></div>' +
  '  <div class="ts-stv-banner" hidden></div>' +
  '  <div class="ts-stv-main"><div class="ts-loading">' + esc(t('common.loading', 'Loading…')) + '</div></div>' +
  '  <div class="ts-foot"><span class="ts-row-meta ts-stv-updated"></span><span class="ts-spacer"></span>' +
  '    <button type="button" class="ts-btn">' + ICON.reset + esc(t('common.refresh', 'Refresh')) + '</button></div>' +
  '</div>');
root.innerHTML = '';
root.appendChild(cardEl);
function renderNav() {
  var bar = cardEl.querySelector(':scope > .ts-nav');
  if (bar) { bar.remove(); }
  window.TerrySenseNav(ctx, tb, ui, cardEl, opts);
}
renderNav();
var mainEl = cardEl.querySelector('.ts-stv-main');
var refreshBtn = cardEl.querySelector('.ts-foot .ts-btn');
var chipsEl = cardEl.querySelector('.ts-stv-chips');
var actsEl = cardEl.querySelector('.ts-stv-acts');
var bannerEl = cardEl.querySelector('.ts-stv-banner');

new ResizeObserver(function () { cardEl.classList.toggle('narrow', cardEl.clientWidth < 640); }).observe(cardEl);

function fail(text) {
  mainEl.innerHTML = '';
  mainEl.appendChild(h('<div class="ts-empty"></div>')).textContent = text;
}

// -- render -----------------------------------------------------------------------------

function render() {
  cardEl.querySelector('.ts-subtitle').textContent = state.station.name;
  var st = stationStatus(), chipEl = cardEl.querySelector('.ts-stv-state');
  chipEl.hidden = false;
  chipEl.textContent = st.label;
  chipEl.style.setProperty('--c', st.color);
  chipEl.dataset.state = st.id;
  cardEl.querySelector('.ts-stv-updated').textContent = t('common.readAt', 'Read {time}', { time: new Date(state.loadedAt).toLocaleTimeString(t.locale()) });
  renderService();
  renderChannels();
}

function project() { return state.chain.filter(function (a) { return a.kind === 'Project'; })[0] || null; }

/** The silence chip and banner for everyone; *Silence* and the row menu for a writer. */
function renderService() {
  var sv = state.service, until = !sv.retired && sv.silencedUntil;
  chipsEl.innerHTML = '';
  if (until) { chipsEl.appendChild(ui.stateChip('silenced', until)); }
  bannerEl.hidden = !until;
  bannerEl.innerHTML = '';
  if (until) {
    bannerEl.appendChild(h('<span class="ts-grow"></span>')).textContent = sv.silencedBy
      ? t('station.silenceNoteBy', '{silence} by {name}: alarms are raised and shown, nobody is notified.', { silence: ui.silenceText(until), name: sv.silencedBy })
      : t('station.silenceNote', '{silence}: alarms are raised and shown, nobody is notified.', { silence: ui.silenceText(until) });
    if (state.canWrite) {
      bannerEl.appendChild(h('<button type="button" class="ts-btn" data-a="end-silence">' + esc(t('common.endSilence', 'End now')) + '</button>'))
        .addEventListener('click', function () { life.endSilence(state.station, refresh); });
    }
  }
  actsEl.innerHTML = '';
  if (!state.canWrite) { return; }
  if (!sv.retired) {
    var silence = actsEl.appendChild(h('<button type="button" class="ts-btn" data-a="silence">' + ICON.mute + esc(t('common.silence', 'Silence')) + '</button>'));
    silence.addEventListener('click', function () { life.silenceMenu(silence, state.station, refresh); });
  }
  actsEl.appendChild(ui.rowMenu(function () {
    return life.stationItems({
      station: state.station, attrs: state.attrs, project: project(), owner: state.owner,
      isPublic: !!state.pub && !!state.pub.ids[state.station.id],
      projectPublic: state.pub && project() ? !!state.pub.ids[project().id] : undefined, nameEl: cardEl.querySelector('.ts-subtitle'),
      changed: refresh, deleted: leave
    });
  }, { title: t('common.stationActions', 'Station actions') }));
}

/** After a delete: the station's project, else the landing view. */
function leave() {
  var p = project();
  tb.openDashboard(opts.projectDashboardId, p ? 'project' : null, p);
}

/** *Acknowledge* and *Clear* (CA-22) on an active alarm, for a writer. */
function alarmActions(a) {
  var el = h('<span class="ts-stv-alarm-acts"></span>');
  el.setAttribute('data-alarm', a.type);
  if (/_ACK$/.test(a.status)) {
    el.appendChild(h('<span class="ts-row-meta">' + esc(t('station.acknowledged', 'Acknowledged')) + '</span>'));
  } else {
    el.appendChild(h('<button type="button" class="ts-btn ghost" data-a="ack">' + esc(t('station.acknowledge', 'Acknowledge')) + '</button>')).addEventListener('click', function () {
      tb.ackAlarm(a).then(function () { ui.toast(t('station.alarmAcknowledged', 'Alarm acknowledged')); return refresh(); })
        .catch(function (err) { ui.toast(t('station.notAcknowledged', 'Not acknowledged: {error}', { error: errText(err) }), 'error'); });
    });
  }
  el.appendChild(h('<button type="button" class="ts-btn ghost" data-a="clear">' + esc(t('station.clear', 'Clear')) + '</button>')).addEventListener('click', function () {
    ui.confirm(t('station.clearConfirm', 'Clear this alarm? If the condition still holds, the next reading raises it again.'), t('station.clear', 'Clear')).then(function (ok) {
      if (!ok) { return null; }
      return tb.clearAlarm(a).then(function () { ui.toast(t('station.alarmCleared', 'Alarm cleared')); return refresh(); });
    }).catch(function (err) { ui.toast(t('station.notCleared', 'Not cleared: {error}', { error: errText(err) }), 'error'); });
  });
  return el;
}

/** The station's data flow (FRONTEND.md *Station view*): each device, the
 * measurements it provides, the channel each is stored under, the station's
 * value. Channels no visible device feeds close the flow. */
function renderChannels() {
  mainEl.innerHTML = '';
  renderPlace();
  var sec = mainEl.appendChild(h('<div class="ts-section ts-flow"><div class="ts-section-head">' + esc(t('station.dataFlow', 'Data flow')) + '</div>' +
    '<div class="ts-flow-cols"><span>' + esc(t('common.device', 'Device')) + '</span><span></span><span>' + esc(t('common.measurement', 'Measurement')) +
    '</span><span></span><span>' + esc(t('station.colChannel', 'Channel')) + '</span><span></span><span>' + esc(t('station.colValue', 'Station value')) + '</span></div></div>'));
  var lanes = flowLanes(), hidden = 0;
  lanes.forEach(function (lane) {
    var shown = lane.items.filter(function (it) { return state.showDiagnostic || !folded(it); });
    hidden += lane.items.length - shown.length;
    if (shown.length || !lane.calc) { sec.appendChild(laneEl(lane, shown)); }
  });
  if (!lanes.length) {
    sec.appendChild(h('<div class="ts-empty">' + esc(t('station.noChannel', 'No channel mapped yet: no measurement reaches this station.')) + '</div>'));
  }
  var foot = sec.appendChild(h('<div class="ts-flow-foot"></div>'));
  if (hidden || state.showDiagnostic && lanes.some(function (l) { return l.items.some(folded); })) {
    var more = foot.appendChild(h('<button type="button" class="ts-more"></button>'));
    more.textContent = state.showDiagnostic ? t('station.hideDiagnostic', 'Hide diagnostic measurements and waiting calculations')
      : t('station.showDiagnostic', 'Show {n} more: diagnostic measurements and calculations waiting for a setting', { n: hidden });
    more.addEventListener('click', function () { state.showDiagnostic = !state.showDiagnostic; renderChannels(); });
  }
  if (state.canWrite) {
    foot.appendChild(h('<span class="ts-spacer"></span>'));
    foot.appendChild(h('<button type="button" class="ts-btn" data-a="charts-dashboard">' + ICON_CHART + esc(t('common.chartsDashboard', 'Charts dashboard')) + '</button>'))
      .addEventListener('click', function () {
        templates.openPanel({ station: state.station, attrs: state.attrs, owner: state.owner, names: state.names, kinds: state.kinds,
          calcAttributes: state.calcAttributes, canCreate: state.canCreateDashboards, order: flowOrder(lanes),
          open: openCharts, changed: function () { renderNav(); return refresh(); } });
      });
  }
  if (state.canWrite && opts.devicesDashboardId) {
    foot.appendChild(h('<button type="button" class="ts-btn" data-a="connect-device">' + ICON.plus + esc(t('station.connect', 'Connect a device')) + '</button>'))
      .addEventListener('click', connectDrawer);
  }
  renderRules();
  if (state.alarms.length) {
    var al = mainEl.appendChild(h('<div class="ts-section"><div class="ts-section-head">' + esc(t('station.otherAlarms', 'Other alarms')) + '</div></div>'));
    state.alarms.forEach(function (a) {
      var row = al.appendChild(h('<div class="ts-stv-alarm"><span class="ts-chip ts-stv-sev"></span><span></span></div>'));
      row.firstChild.style.setProperty('--c', 'var(--sev-' + a.severity.toLowerCase() + ')');
      row.firstChild.textContent = G.severity(a.severity.toLowerCase()).label;
      row.lastChild.textContent = otherAlarmText(a);
      if (state.canWrite) { row.appendChild(alarmActions(a)); }
    });
  }
}

/** The channels in the order the flow draws them. */
function flowOrder(lanes) {
  return [].concat.apply([], lanes.map(function (l) { return l.items.filter(function (it) { return it.channel; }).map(function (it) { return it.channel.name; }); }));
}

/** A template just created: the station's charts on it. */
function openCharts(id) { tb.openDashboard(id, 'station', state.station); }

/** A diagnostic measurement folds away, unless its channel is in alarm; so does
 * a calculation waiting for a setting that has never been calculated. */
function folded(it) {
  if (it.calc) { return !it.channel && !(it.waiting && it.waiting.latest); }
  return it.channel ? it.channel.diagnostic && !it.channel.alarm : it.row.diagnostic;
}

function calcOf(name) { return (state.names[resolver.splitChannelKey(name).name] || {}).calculated || null; }

/** Every `calc.*` setting a calculated name reads, through the calculated names it reads too. */
function readsOf(name, seen) {
  var k = calcOf(name);
  seen = seen || {};
  if (!k || seen[name]) { return []; }
  seen[name] = true;
  var out = (k.attributes || []).slice();
  (k.channels || []).forEach(function (c) { readsOf(c, seen).forEach(function (a) { if (out.indexOf(a) < 0) { out.push(a); } }); });
  return out;
}

function calcMeta() { return { names: state.names, attributes: state.calcAttributes }; }

/** How many calculated names deep `name` is: a channel it reads comes before it. */
function depth(name) {
  var k = calcOf(name);
  return k ? 1 + Math.max.apply(null, [0].concat((k.channels || []).map(depth))) : 0;
}

/** One lane per visible device, its measurements in bus order, stored or not;
 * then the channels of a device not visible, or of none. Rule channels are the
 * dry contact interface's and listed apart. */
function flowLanes() {
  var byName = {}, placed = {};
  state.channels.forEach(function (c) { byName[c.name] = c; });
  var lanes = state.devices.filter(function (d) { return !d.hidden; }).map(function (d) {
    var mine = M.mineOf(state.entries, d.id);
    var rows = M.mappable(d.model, M.mappedNames(d.id, [state.entries]));
    var order = {}, stored = {};
    rows.forEach(function (r, i) { order[r.key] = i; });
    var items = Object.keys(mine).filter(function (ch) { return byName[ch] && !byName[ch].rule; }).map(function (ch) {
      placed[ch] = true;
      stored[mine[ch]] = true;
      return { channel: byName[ch], key: mine[ch], row: rows[order[mine[ch]]] || null };
    });
    rows.forEach(function (r) { if (!stored[r.key]) { items.push({ channel: null, key: r.key, row: r }); } });
    items.sort(function (a, b) {
      var oa = order[a.key] === undefined ? rows.length : order[a.key], ob = order[b.key] === undefined ? rows.length : order[b.key];
      return oa - ob || (a.channel ? a.channel.name : '').localeCompare(b.channel ? b.channel.name : '');
    });
    return { device: d, items: items };
  });
  // A calculated name is drawn from the station channels it reads, whatever its map entry says.
  var calculated = state.channels.filter(function (c) { return !c.rule && !placed[c.name] && calcOf(c.name); });
  var items = calculated.map(function (c) { placed[c.name] = true; return { calc: true, channel: c, name: c.name }; })
    .concat(state.waiting.map(function (w) { return { calc: true, channel: null, name: w.plan.name, waiting: w.channel }; }));
  if (items.length) {
    lanes.push({ device: null, calc: true, items: items.sort(function (a, b) { return depth(a.name) - depth(b.name) || a.name.localeCompare(b.name); }) });
  }
  var rest = state.channels.filter(function (c) { return !c.rule && !placed[c.name]; });
  if (rest.length) {
    var unseen = rest.some(function (c) { return c.device; });
    lanes.push({ device: null, unseen: unseen, items: rest.map(function (c) { return { channel: c, key: c.sourceKey, row: null }; }) });
  }
  return lanes;
}

function laneEl(lane, items) {
  var el = h('<div class="ts-flow-lane"><div class="ts-flow-dev"></div><div class="ts-flow-rows"></div></div>');
  var dev = el.querySelector('.ts-flow-dev');
  if (lane.device) { deviceNode(dev, lane.device); } else if (lane.calc) {
    el.classList.add('calc');
    dev.appendChild(h('<div class="ts-flow-title"></div>')).textContent = t('station.calculated', 'Calculated');
    dev.appendChild(h('<div class="ts-row-meta"></div>')).textContent = t('station.calculatedFrom', 'From this station\'s channels and settings');
  } else {
    el.classList.add('orphan');
    dev.appendChild(h('<div class="ts-flow-title"></div>')).textContent = lane.unseen ? t('station.deviceHidden', 'Device not visible to you') : t('common.noDevice', 'No device');
    dev.appendChild(h('<div class="ts-row-meta"></div>')).textContent = lane.unseen ? t('station.deviceHiddenNote', 'Its channels below') : t('station.noDeviceNote', 'Channels mapped to no device');
  }
  var rowsEl = el.querySelector('.ts-flow-rows');
  items.forEach(function (it) { rowsEl.appendChild(flowRow(lane.device, it)); });
  if (!items.length) {
    rowsEl.appendChild(h('<div class="ts-empty"></div>')).textContent = lane.items.length
      ? t('station.onlyDiagnostic', 'Only diagnostic measurements') : t('station.nothingMeasured', 'Nothing measured by this device yet');
  }
  return el;
}

/** The device, live or not, its battery and alarms; it opens the device view. */
function deviceNode(el, d) {
  var dev = d.device, live = flag(d.server.active), last = Number(d.server.lastActivityTime) || 0;
  el.dataset.device = dev.name;
  el.appendChild(h('<div class="ts-flow-title"></div>')).textContent = dev.label || dev.name;
  var up = el.appendChild(h('<div class="ts-flow-line"></div>'));
  up.textContent = last ? (live ? t('station.live', 'Live, last uplink {ago}', { ago: t.ago(last) }) : t('station.inactive', 'Inactive, last uplink {ago}', { ago: t.ago(last) }))
    : t('common.neverHeard', 'Never heard from');
  up.insertAdjacentHTML('afterbegin', '<span class="ts-dot" style="background:' + (live ? 'var(--ts-ok)' : last ? 'var(--ts-danger)' : 'var(--ts-text-3)') + '"></span>');
  el.appendChild(h('<div class="ts-row-meta"></div>')).textContent = [dev.name !== (dev.label || dev.name) ? dev.name : '', dev.type,
    d.client['deviceInfo.fwVersion'] ? t('station.firmware', 'firmware {version}', { version: d.client['deviceInfo.fwVersion'] }) : ''].filter(Boolean).join(' · ');
  if (d.client['status.soc'] !== undefined) {
    el.appendChild(h('<div class="ts-flow-line"></div>')).textContent = t('station.battery', 'Battery {soc} %', { soc: fmtNumber(Number(d.client['status.soc'])) });
  }
  var sev = worst(d.alarms.map(function (a) { return a.severity; }));
  if (sev) {
    el.appendChild(h('<div class="ts-flow-line ts-stv-bad"></div>')).textContent =
      d.alarms.length === 1 ? t('station.deviceAlarmsOne', '1 active alarm, worst {severity}', { severity: G.severity(sev.toLowerCase()).label })
        : t('station.deviceAlarmsMany', '{n} active alarms, worst {severity}', { n: d.alarms.length, severity: G.severity(sev.toLowerCase()).label });
  }
  if (opts.devicesDashboardId) {
    clickable(el, t('station.openDevice', 'Open the device view'), function () {
      tb.openDashboard(opts.devicesDashboardId, 'device', { entityType: 'DEVICE', id: d.id, name: dev.name });
    });
  }
}

function clickable(el, title, go) {
  el.classList.add('link');
  el.tabIndex = 0;
  el.setAttribute('role', 'button');
  el.title = title;
  el.addEventListener('click', function (e) { if (!e.target.closest('.ts-stv-alarm-acts')) { go(); } });
  el.addEventListener('keydown', function (e) { if (e.key === 'Enter' && e.target === el) { go(); } });
}

/** Measurement → channel → station value. A measurement stored nowhere here ends at its channel slot. */
function flowRow(device, it) {
  if (it.calc) { return calcRow(it); }
  var c = it.channel, r = it.row;
  var el = h('<div class="ts-flow-row"><div class="ts-flow-node ts-flow-meas"><div class="ts-flow-name"></div><div class="ts-row-meta"></div></div>' +
    '<span class="ts-flow-link"></span><div class="ts-flow-node ts-flow-ch"></div><span class="ts-flow-link"></span>' +
    '<div class="ts-flow-node ts-flow-val"></div></div>');
  var meas = el.querySelector('.ts-flow-meas');
  meas.title = it.key || '';
  meas.querySelector('.ts-flow-name').textContent = r ? r.label : measurement(c);
  var raw = device && it.key && device.model.latest[it.key];
  meas.querySelector('.ts-row-meta').textContent = [r ? r.groupLabel : '', it.key,
    raw ? fmtRaw(raw.value) + (r && r.unit ? ' ' + r.unit : '') : ''].filter(Boolean).join(' · ');
  var ch = el.querySelector('.ts-flow-ch'), val = el.querySelector('.ts-flow-val');
  var editable = state.canWrite && device && r && !M.DRYC_KEY.test(it.key);
  if (!c) {
    el.classList.add('off');
    el.dataset.source = it.key;
    ch.classList.add('empty');
    ch.textContent = editable ? t('station.store', 'Store…') : t('station.notStored', 'Not stored');
    val.appendChild(h('<span class="ts-row-meta"></span>')).textContent = t('common.notStored', 'not stored');
  } else {
    el.dataset.channel = c.name;
    ch.appendChild(h('<div class="ts-flow-name"></div>')).textContent = c.label;
    ch.appendChild(h('<div class="ts-mono"></div>')).textContent = c.name;
    valueNode(el, val, c);
    deleteButton(ch, c);
  }
  if (editable) {
    ch.dataset.a = 'map';
    clickable(ch, c ? t('station.changeChannel', 'Change the channel') : t('station.storeThis', 'Store this measurement'), function () { mapDrawer(device, r, c); });
  } else if (c && device && M.DRYC_KEY.test(it.key)) {
    ch.title = t('station.setInDryc', 'Set in the dry contact interface view');
  }
  return el;
}

/** The channels and settings a calculated name reads → the name → its value.
 * A writer opens its settings from the channel; one still waiting for a setting
 * names it, and shows its last value when it has a history. */
function calcRow(it) {
  var k = calcOf(it.name), c = it.channel || it.waiting, reads = readsOf(it.name);
  var needs = reads.filter(function (a) { return state.attrs[resolver.CALC_PREFIX + a] == null; });
  var el = h('<div class="ts-flow-row"><div class="ts-flow-node ts-flow-meas"><div class="ts-flow-name"></div><div class="ts-row-meta"></div></div>' +
    '<span class="ts-flow-link"></span><div class="ts-flow-node ts-flow-ch"></div><span class="ts-flow-link"></span>' +
    '<div class="ts-flow-node ts-flow-val"></div></div>');
  el.dataset.channel = it.name;
  el.dataset.calc = needs.length ? 'waiting' : 'on';
  var meas = el.querySelector('.ts-flow-meas');
  meas.querySelector('.ts-flow-name').textContent = t('station.from', 'From {list}', { list: calc.listText((k.channels || []).map(function (ch) { return calc.channelLabel(calcMeta(), state.attrs, ch); })) });
  var settings = (k.attributes || []).filter(function (a) { return state.attrs[resolver.CALC_PREFIX + a] != null; }).map(function (a) {
    var spec = state.calcAttributes[a] || {};
    return attrLabel(a) + ' ' + fmtRaw(state.attrs[resolver.CALC_PREFIX + a]) + (spec.unit ? ' ' + spec.unit : '');
  });
  meas.querySelector('.ts-row-meta').textContent = settings.join(' · ');
  var ch = el.querySelector('.ts-flow-ch'), val = el.querySelector('.ts-flow-val');
  ch.appendChild(h('<div class="ts-flow-name"></div>')).textContent = c.label;
  ch.appendChild(h('<div class="ts-mono"></div>')).textContent = it.name;
  if (needs.length) {
    el.classList.add('off');
    ch.classList.add('empty');
    var why = ch.appendChild(h('<div class="ts-row-meta ts-flow-needs"></div>'));
    why.textContent = t('common.needs', 'Needs {list}', { list: calc.listText(needs.map(attrLabel)) });
  }
  if (it.channel) { valueNode(el, val, it.channel); deleteButton(ch, it.channel); } else {
    val.appendChild(h('<span class="ts-row-meta"></span>')).textContent = c.latest
      ? t('station.lastValue', 'last {value}, {ago}', { value: display(c).text + (display(c).unit ? ' ' + display(c).unit : ''), ago: t.ago(c.latest.ts) })
      : t('station.notCalculated', 'not calculated yet');
  }
  if (state.canWrite && reads.length) {
    ch.dataset.a = 'calc';
    clickable(ch, t('station.changeSettings', 'Change its settings'), function () { calcDrawer(it.name, c.label, reads); });
  }
  return el;
}

/** The delete button on a stored channel, for a user who may write the station. */
function deleteButton(node, c) {
  if (!state.canWrite) { return; }
  var b = node.appendChild(h('<button type="button" class="ts-icon-btn ts-flow-del" data-a="delete-channel">' + ICON_TRASH + '</button>'));
  b.title = t('station.deleteChannel', 'Delete {name}', { name: c.name });
  b.addEventListener('click', function (e) { e.stopPropagation(); deleteChannel(c); });
}

/** What deleting `c` does: a channel in the map leaves it; a calculated one
 * turned on by its settings goes with them, and every calculation they turn on
 * with it. `{map, attrs, off}`. */
function deletion(c) {
  if (state.entries[c.name]) { return { map: true, attrs: [], off: [c.name] }; }
  var attrs = readsOf(c.name);
  var off = state.channels.filter(function (x) {
    return calcOf(x.name) && !state.entries[x.name] && readsOf(x.name).some(function (a) { return attrs.indexOf(a) >= 0; });
  }).map(function (x) { return x.name; });
  return { map: false, attrs: attrs, off: off };
}

function deleteChannel(c) {
  var d = deletion(c), s = state.station;
  var others = d.off.filter(function (n) { return n !== c.name; });
  var p = { label: esc(c.label), name: esc(c.name), station: esc(s.name), settings: esc(calc.listText(d.attrs.map(attrLabel))) };
  var text = d.map
    ? t('station.deleteMapped', 'Delete <b>{label}</b> ({name}) from <b>{station}</b>? It leaves the station\'s channels and its dashboards.', p)
    : (d.attrs.length === 1 ? t('station.deleteCalcOne', 'Delete <b>{label}</b> ({name})? Its setting <b>{settings}</b> is cleared, so it is no longer calculated', p)
      : t('station.deleteCalcMany', 'Delete <b>{label}</b> ({name})? Its settings <b>{settings}</b> are cleared, so it is no longer calculated', p)) +
      (others.length ? t('station.deleteCalcNor', ', nor {others}', { others: esc(calc.listText(others.map(function (n) { return calc.channelLabel(calcMeta(), state.attrs, n); }))) }) : '') + '.';
  ui.confirmTyped(text + t('station.deleteHistoryStays', ' The stored history stays unless deleted below.'), c.name, t('common.delete', 'Delete'),
    t('station.deleteHistory', 'Also delete the stored history of {names} — cannot be undone', { names: calc.listText(d.off) }))
    .then(function (answer) {
      if (!answer) { return null; }
      var next = Object.assign({}, state.entries);
      delete next[c.name];
      var work = d.map
        ? tb.saveAttrs(s, { 'config.channelMap': resolver.buildMap(next) }).then(function () { return tb.relateToMap(s, next); })
        : tb.deleteAttrs(s, d.attrs.map(function (a) { return resolver.CALC_PREFIX + a; }));
      return work.then(function () {
        return answer.checked ? tb.del('/api/plugins/telemetry/ASSET/' + s.id + '/timeseries/delete',
          { keys: d.off.join(','), deleteAllDataForKeys: 'true' }) : null;
      }).then(function () {
        return tb.resolveStations([s]);
      }).then(function () {
        ui.closeDrawer();
        ui.toast(answer.checked ? t('station.deletedWithHistory', '{name} deleted, with its history', { name: c.name }) : t('lifecycle.delete.done', '{name} deleted', { name: c.name }));
        return refresh();
      });
    }).catch(function (err) { ui.toast(t('common.notDeleted', 'Not deleted: {error}', { error: errText(err) }), 'error'); });
}

/** `name` and the calculated names it reads, the measured channels first. */
function chainOf(name, out) {
  out = out || [];
  ((calcOf(name) || {}).channels || []).forEach(function (ch) { chainOf(ch, out); });
  if (out.indexOf(name) < 0) { out.push(name); }
  return out;
}

/** How `name` is calculated, step by step from what is measured, then the
 * `calc.*` settings it reads, saved and resolved at once. */
function calcDrawer(name, label, reads) {
  var dr = ui.openDrawer(esc(label), t('station.calcDrawer', 'Calculated channel · {station}', { station: esc(state.station.name) }));
  var steps = dr.body.appendChild(h('<div class="ts-calc-steps"><div class="ts-section-head">' + esc(t('station.howCalculated', 'How it is calculated')) + '</div></div>'));
  chainOf(name).forEach(function (n) {
    var c = state.channels.filter(function (x) { return x.name === n; })[0];
    var row = steps.appendChild(h('<div class="ts-calc-step"><div class="ts-calc-step-main"><span class="ts-calc-step-name"></span>' +
      '<span class="ts-mono"></span></div><div class="ts-row-meta"></div><div class="ts-calc-step-val"></div></div>'));
    row.classList.toggle('measured', !calcOf(n));
    row.classList.toggle('this', n === name);
    row.querySelector('.ts-calc-step-name').textContent = calc.channelLabel(calcMeta(), state.attrs, n);
    row.querySelector('.ts-mono').textContent = n;
    row.querySelector('.ts-row-meta').textContent = calcOf(n) ? description(resolver.splitChannelKey(n).name) : t('station.measured', 'Measured');
    var uses = (calcOf(n) || {}).attributes || [];
    if (uses.length) {
      row.appendChild(h('<div class="ts-calc-step-uses"></div>')).textContent = t('station.uses', 'Uses {list}, set below', { list: calc.listText(uses.map(attrLabel)) });
    }
    if (c && c.latest) {
      var d = display(c);
      row.querySelector('.ts-calc-step-val').textContent = d.text + (d.unit ? ' ' + d.unit : '');
    }
  });
  dr.body.appendChild(h('<div class="ts-section-head ts-calc-settings-head"></div>')).textContent = reads.length === 1 ? t('station.setting', 'Setting') : t('common.settings', 'Settings');
  var f = calc.form(state.station, state.attrs, reads, calcMeta());
  dr.body.appendChild(f.el);
  dr.body.appendChild(h('<div class="ts-field-hint">' + esc(t('calculations.hint', 'Values are calculated from the latest reading on; earlier readings are not recalculated.')) + '</div>'));
  var go = ui.drawerActions(dr, t('common.save', 'Save'));
  function check() { go.disabled = !f.values(); }
  f.onChange(check);
  check();
  setTimeout(f.focus, 0);
  go.addEventListener('click', function () {
    var write = f.values();
    if (!write) { return; }
    go.disabled = true;
    calc.save(state.station, write).then(function () {
      ui.closeDrawer();
      ui.toast(t('common.saved', 'Saved'));
      return refresh();
    }).catch(function (err) { go.disabled = false; ui.toast(t('common.notSaved', 'Not saved: {error}', { error: errText(err) }), 'error'); });
  });
}

function fmtRaw(v) {
  if (v === true || v === 'true') { return t('common.valueOn', 'on'); }
  if (v === false || v === 'false') { return t('common.valueOff', 'off'); }
  var n = Number(v);
  return v === '' || v === null || isNaN(n) ? String(v) : fmtNumber(n);
}

function valueNode(row, el, c) {
  var d = display(c);
  el.appendChild(h('<b></b>')).textContent = d.text + (d.unit ? ' ' + d.unit : '');
  var age = el.appendChild(h('<span class="ts-row-meta"></span>'));
  age.textContent = (c.latest ? t.ago(c.latest.ts) : t('station.noReading', 'no reading yet')) + (c.stale ? t('station.stale', ' · stale') : '');
  if (c.stale) {
    row.classList.add('stale');
    age.setAttribute('data-tip', t('station.staleTip', 'Older than three measurement intervals of its source'));
  }
  if (c.alarm) {
    row.classList.add('alarm');
    row.style.setProperty('--c', 'var(--sev-' + c.alarm.toLowerCase() + ')');
    var chipEl = h('<span class="ts-chip ts-stv-sev"></span>');
    chipEl.style.setProperty('--c', 'var(--sev-' + c.alarm.toLowerCase() + ')');
    chipEl.textContent = G.severity(c.alarm.toLowerCase()).label;
    el.insertBefore(chipEl, el.firstChild);
    if (state.canWrite) { c.alarms.forEach(function (a) { el.appendChild(alarmActions(a)); }); }
  }
}

/** The station's project, with its stale channels; it opens the Project view. */
function renderPlace() {
  var p = project();
  var el = mainEl.appendChild(h('<div class="ts-stv-place" data-card="Project">' + ICON.map + '<span class="ts-stv-kind">' + esc(t('common.project', 'Project')) + '</span><b></b>' +
    '<span class="ts-row-meta"></span></div>'));
  el.querySelector('b').textContent = p ? p.name : t('station.noProject', 'No project');
  var stale = state.channels.filter(function (c) { return c.stale; }).length;
  el.querySelector('.ts-row-meta').textContent = !p ? t('station.inNoProject', 'The station is in no project.')
    : stale ? t('station.staleCount', '{stale} of {total} channels stale', { stale: stale, total: state.channels.length }) : '';
  if (p && opts.projectDashboardId) {
    el.insertAdjacentHTML('beforeend', '<span class="ts-spacer"></span><span class="ts-stv-go">' + esc(t('station.openProject', 'Open project')) + '</span>' + ICON.chev);
    clickable(el, t('station.openProjectView', 'Open the Project view'), function () { tb.openDashboard(opts.projectDashboardId, 'project', p); });
  }
}

// -- channel mapping (CHANNEL_MAP.md) -------------------------------------------------------

function deviceName(d) { return d.device.label || d.device.name; }

/** The channel one measurement of `d` is stored under, and its label on this
 * station; `c` its channel, or null for a measurement not stored here. The
 * names offered and the takeover of another device's channel follow the
 * device view's *Channels* editor (shared/mapping.js). */
function mapDrawer(d, r, c) {
  var entries = state.entries;
  var dr = ui.openDrawer(c ? t('station.channelDrawer', 'Channel {label}', { label: esc(c.label) }) : t('station.storeDrawer', 'Store a measurement'), esc(deviceName(d)) + ' · ' + esc(r.label));
  var o = M.nameOptions(d.model, r, entries, c ? c.name : null, d.id);
  var form = h('<div><div class="ts-field"><div class="ts-field-label"><span>' + esc(t('station.storedAs', 'Stored as')) + ' ' + ui.info('channelName') + '</span></div>' +
    '<div class="ts-ctl"><select class="ts-select wide" data-f="channel"></select></div><div class="ts-field-hint" data-f="hint"></div></div>' +
    '<div class="ts-field"><div class="ts-field-label"><span>' + esc(t('station.labelHere', 'Label on this station')) + '</span></div>' +
    '<div class="ts-ctl"><input class="ts-input wide" type="text" data-f="label"></div>' +
    '<div class="ts-field-hint">' + esc(t('station.labelHint', 'Left empty, the label set above the station applies.')) + '</div></div></div>');
  var sel = form.querySelector('[data-f=channel]'), hint = form.querySelector('[data-f=hint]'), label = form.querySelector('[data-f=label]');
  o.options.forEach(function (n) {
    var opt = document.createElement('option');
    opt.value = n;
    opt.textContent = M.channelLabel(state.names, n) + ' (' + n + ')';
    sel.appendChild(opt);
  });
  sel.value = o.value;
  dr.body.appendChild(form);

  function fill() {
    var own = state.attrs['channel.' + sel.value + '.label'];
    label.value = own === undefined || own === null ? '' : String(own);
    label.placeholder = M.channelLabel(state.names, sel.value);
  }
  var go;
  function check() {
    var p = plan(d, r, c, sel.value);
    hint.innerHTML = '';
    hint.classList.toggle('ts-error', !!p.error);
    hint.textContent = p.error || p.notes.join(' ');
    if (go) { go.disabled = !!p.error; }
  }
  sel.addEventListener('change', function () { fill(); check(); });
  fill();

  go = ui.drawerActions(dr, t('common.save', 'Save'));
  if (c) {
    var remove = h('<button type="button" class="ts-btn danger" data-a="unmap">' + esc(t('station.unmap', 'Remove from station')) + '</button>');
    dr.foot.insertBefore(remove, dr.foot.firstChild);
    remove.addEventListener('click', function () { unmap(d, c); });
  }
  check();
  go.addEventListener('click', function () { saveMapping(d, r, c, sel.value, label.value.trim()); });
}

/** What storing `r` under `target` changes: `{next, notes, takenOver, error}`. */
function plan(d, r, c, target) {
  var p = M.storeOne(state.entries, d.id, r.key, c ? c.name : null, target), notes = [];
  if (p.own) {
    return { error: t('station.alreadyStores', '{label} ({name}) already stores another measurement of this device: change that one first.',
      { label: M.channelLabel(state.names, target), name: target }) };
  }
  var held = p.takenOver;
  if (held) {
    var other = state.devices.filter(function (x) { return !x.hidden && x.id === held.device; })[0];
    notes.push(t('station.takeOver', '{name} is fed by {source} now; it moves to this measurement, its history kept.', { name: target,
      source: other ? deviceName(other) : held.device ? t('station.anotherDevice', 'another device') : t('station.noDeviceSource', 'no device') }));
  }
  if (c && c.name !== target) { notes.push(t('station.readingsStay', 'The readings so far stay under {old}; new readings go to {name}.', { old: c.name, name: target })); }
  return { next: p.next, notes: notes, takenOver: held ? [target] : [] };
}

function saveMapping(d, r, c, target, labelText) {
  var p = plan(d, r, c, target);
  if (p.error) { ui.toast(p.error, 'error'); return; }
  var mapChanged = !c || c.name !== target;
  var labelKey = 'channel.' + target + '.label', own = state.attrs[labelKey];
  var ownText = own === undefined || own === null ? '' : String(own);
  var labelChanged = labelText !== ownText;
  if (!mapChanged && !labelChanged) { ui.closeDrawer(); return; }
  var q = { measurement: esc(r.label), device: esc(deviceName(d)), name: esc(target), old: c ? esc(c.name) : '', station: esc(state.station.name) };
  var text = (c ? t('station.storeInstead', 'Store <b>{measurement}</b> of <b>{device}</b> as <b>{name}</b> instead of <b>{old}</b>?', q)
    : t('station.storeOn', 'Store <b>{measurement}</b> of <b>{device}</b> on <b>{station}</b> as <b>{name}</b>?', q)) +
    (p.notes.length ? ' ' + p.notes.map(esc).join(' ') : '');
  (mapChanged ? ui.confirm(text, t('common.save', 'Save')) : Promise.resolve(true)).then(function (ok) {
    if (!ok) { return null; }
    var s = state.station, write = {};
    if (mapChanged) { write['config.channelMap'] = resolver.buildMap(p.next); }
    if (labelChanged && labelText) { write[labelKey] = labelText; }
    return tb.saveAttrs(s, write).then(function () {
      return labelChanged && !labelText ? tb.deleteAttrs(s, [labelKey]) : null;
    }).then(function () {
      return mapChanged ? tb.relateToMap(s, p.next) : null;
    }).then(function () {
      return tb.resolveStations([s]);
    }).then(function () {
      ui.closeDrawer();
      ui.toast(t('common.saved', 'Saved'));
      return refresh();
    });
  }).catch(function (err) { ui.toast(t('common.notSaved', 'Not saved: {error}', { error: errText(err) }), 'error'); });
}

function unmap(d, c) {
  ui.confirm(t('station.unmapConfirm', 'Stop storing <b>{label}</b> ({name}) from <b>{device}</b>? The channel leaves the station, which keeps its history.',
    { label: esc(c.label), name: esc(c.name), device: esc(deviceName(d)) }), t('common.remove', 'Remove')).then(function (ok) {
    if (!ok) { return null; }
    var next = Object.assign({}, state.entries);
    delete next[c.name];
    var s = state.station;
    return tb.saveAttrs(s, { 'config.channelMap': resolver.buildMap(next) }).then(function () {
      return tb.relateToMap(s, next);
    }).then(function () {
      return tb.resolveStations([s]);
    }).then(function () {
      ui.closeDrawer();
      ui.toast(t('station.removed', '{name} removed', { name: c.name }));
      return refresh();
    });
  }).catch(function (err) { ui.toast(t('station.notRemoved', 'Not removed: {error}', { error: errText(err) }), 'error'); });
}

/** Whether the station has a dry contact interface to set up: rules kept here,
 * a rule channel, a DRYC reading mapped, or a LOGR2 that reports one. */
function hasDryc() {
  return !!parseJson(state.attrs['dryc.rules']) || state.channels.some(function (c) { return c.rule || /^dryc\./.test(c.sourceKey || ''); }) ||
    state.devices.some(function (d) { return d.dryc; });
}

/** The dry contact interface's notifying rules (DRYC.md §3): each with whether
 * it matches and its alarm, and the way to the Dry contact interface view. */
function renderRules() {
  if (!hasDryc()) { return; }
  var sec = mainEl.appendChild(h('<div class="ts-section ts-stv-rules"><div class="ts-section-head">' + esc(t('station.rules', 'Dry contact interface rules')) + '<span class="ts-spacer"></span></div></div>'));
  if (opts.projectDashboardId) {
    sec.firstChild.appendChild(h('<button type="button" class="ts-btn" data-a="dryc">' + ICON.settings +
      esc(state.canWrite ? t('station.setUpRules', 'Set up inputs and rules') : t('station.inputsRules', 'Inputs and rules')) + '</button>')).addEventListener('click', function () {
      tb.openDashboard(opts.projectDashboardId, 'dryc', state.station);
    });
  }
  var rules = state.channels.filter(function (c) { return c.rule; });
  if (!rules.length) {
    sec.appendChild(h('<div class="ts-empty">' + esc(t('station.noRule', 'No rule raises an alarm on this station yet.')) + '</div>'));
    return;
  }
  rules.forEach(function (c) {
    var on = c.latest ? flag(c.latest.value) || Number(c.latest.value) === 1 : null;
    var row = sec.appendChild(h('<div class="ts-stv-ch ts-stv-rule"><div class="ts-stv-ch-main"><div class="ts-row-label"></div>' +
      '<div class="ts-row-meta"></div></div><div class="ts-stv-val"><b></b></div></div>'));
    row.dataset.rule = c.name;
    row.querySelector('.ts-row-label').textContent = c.label;
    row.querySelector('.ts-row-meta').textContent = c.latest ? t('station.checked', 'Checked {ago}', { ago: t.ago(c.latest.ts) }) : t('station.notChecked', 'Not checked yet');
    row.querySelector('b').textContent = on === null ? '—' : on ? t('station.matching', 'Matching') : t('common.notMatching', 'Not matching');
    if (c.alarm) {
      row.classList.add('alarm');
      row.style.setProperty('--c', 'var(--sev-' + c.alarm.toLowerCase() + ')');
      var chipEl = h('<span class="ts-chip ts-stv-sev"></span>');
      chipEl.style.setProperty('--c', 'var(--sev-' + c.alarm.toLowerCase() + ')');
      chipEl.textContent = G.severity(c.alarm.toLowerCase()).label;
      row.querySelector('.ts-stv-val').insertBefore(chipEl, row.querySelector('b'));
      if (state.canWrite) { c.alarms.forEach(function (a) { row.querySelector('.ts-stv-val').appendChild(alarmActions(a)); }); }
    }
  });
}

// -- connect a device (CA-8) ------------------------------------------------------------

/** The owner's devices, those that measure what the station's dashboard shows
 * first. Picking one opens its device view on the connect panel, this station picked. */
function connectDrawer() {
  var dr = ui.openDrawer(t('station.connect', 'Connect a device'), esc(state.station.name));
  var hint = dr.body.appendChild(h('<div class="ts-field-hint"></div>'));
  var only = dr.body.appendChild(h('<label class="ts-switch" hidden><input type="checkbox" data-f="fits" checked> <span>' + esc(t('station.onlyFitting', 'Only devices that fit its dashboard')) + '</span></label>'));
  var list = dr.body.appendChild(h('<div data-f="devices"><div class="ts-loading">' + esc(t('common.loading', 'Loading…')) + '</div></div>'));
  var owner = state.owner, dashId = state.attrs['config.stationDashboard'];
  var url = owner.entityType === 'CUSTOMER' ? '/api/customer/' + owner.id + '/devices' : '/api/tenant/devices';
  Promise.all([tb.getAll(url, {}), dashId ? tb.get('/api/dashboard/' + dashId).catch(function () { return null; }) : null]).then(function (got) {
    var kinds = got[1] ? resolver.channelKinds(resolver.dashboardChannels(got[1]), state.names) : [];
    var devices = got[0].filter(function (d) { return d.ownerId.id === owner.id; });
    return Promise.all(devices.map(function (d) {
      return Promise.all([tb.get('/api/plugins/telemetry/DEVICE/' + d.id.id + '/keys/timeseries').catch(function () { return []; }),
        tb.deviceParents({ id: d.id.id })]).then(function (r) {
        return { device: d, fit: resolver.deviceFit(tb.readingKeys(r[0]), kinds, state.names), feeds: r[1].map(function (p) { return p.name; }).sort() };
      });
    })).then(function (rows) { return { rows: rows, kinds: kinds, dashboard: got[1] }; });
  }).then(function (r) {
    hint.textContent = r.kinds.length
      ? t('station.connectHint', 'Its dashboard {title} shows {kinds}. The device view then opens to choose what the station stores.',
        { title: r.dashboard.title, kinds: r.kinds.map(kindLabel).join(', ') })
      : t('station.connectHintPlain', 'The device view opens to choose what the station stores.');
    var fitting = r.rows.filter(function (x) { return x.fit.fits; });
    only.hidden = !fitting.length;
    r.rows.sort(function (a, b) {
      return b.fit.fits - a.fit.fits || !!a.feeds.length - !!b.feeds.length || a.device.name.localeCompare(b.device.name);
    });
    function fill() {
      list.innerHTML = '';
      var shown = r.rows.filter(function (x) { return only.hidden || !only.querySelector('input').checked || x.fit.fits; });
      shown.forEach(function (x) {
        var d = x.device;
        var o = list.appendChild(h('<div class="ts-opt" tabindex="0"><div class="ts-opt-main"><div class="ts-opt-label"></div><div class="ts-opt-desc"></div></div>' +
          '<div class="ts-opt-side"></div></div>'));
        o.setAttribute('data-device', d.name);
        o.querySelector('.ts-opt-label').textContent = (d.label || d.name) + ' (' + d.type + ')';
        o.querySelector('.ts-opt-desc').textContent = (d.label ? d.name + ' · ' : '') + (x.feeds.length ? t('common.feeding', 'Feeding {stations}', { stations: x.feeds.join(', ') }) : t('common.free', 'Free'));
        if (r.kinds.length) {
          o.querySelector('.ts-opt-side').appendChild(h('<span class="ts-chip' + (x.fit.fits ? ' accent' : '') + '"></span>')).textContent =
            x.fit.fits ? t('station.fits', 'Fits the dashboard') : t('station.measures', 'Measures {have} of {total}', { have: x.fit.have.length, total: r.kinds.length });
        }
        var go = function () {
          ui.closeDrawer();
          tb.openDashboard(opts.devicesDashboardId, 'device', { entityType: 'DEVICE', id: d.id.id, name: d.name },
            { connectTo: { id: state.station.id, name: state.station.name } });
        };
        o.addEventListener('click', go);
        o.addEventListener('keydown', function (e) { if (e.key === 'Enter') { go(); } });
      });
      if (!shown.length) { list.appendChild(h('<div class="ts-empty">' + esc(t('station.noOwnerDevice', 'No device of this owner.')) + '</div>')); }
    }
    only.querySelector('input').addEventListener('change', fill);
    fill();
  }).catch(function (err) { list.innerHTML = ''; list.appendChild(h('<div class="ts-empty"></div>')).textContent = t('station.listFailed', 'Could not list the devices: {error}', { error: errText(err) }); });
}

// -- load -------------------------------------------------------------------------------

var timer = null;
function refresh() {
  if (!root.isConnected && timer) { clearInterval(timer); return Promise.resolve(); }
  refreshBtn.disabled = true;
  return load().then(render).catch(function (err) {
    ui.toast(t('common.refreshFailed', 'Refresh failed: {error}', { error: errText(err) }), 'error');
  }).then(function () { refreshBtn.disabled = false; });
}
refreshBtn.addEventListener('click', refresh);

tb.boundDatasource().then(function (ds) {
  if (!ds || ds.entityType !== 'ASSET') { fail(t('station.notBound', 'No station bound — bind a station in the widget\'s Data tab.')); return; }
  return Promise.all([tb.loadEntity(ds), loadDefaults(), tb.getAsset(ds.entityId), tb.currentUser()]).then(function (got) {
    if (got[0].kind !== 'Station') { fail(t('station.notStation', 'This widget shows a station; {name} is a {kind}.', { name: got[0].name, kind: got[0].kind })); return null; }
    state.station = got[0];
    state.owner = got[2].ownerId;
    return tb.canWrite(state.station).then(function (w) {
      state.canWrite = w && !(got[3] || {}).isPublic && !tb.isPublicView();
      var perms = ctx.$scope.$injector.get(ctx.servicesMap.get('userPermissionsService'));
      state.canCreateDashboards = state.canWrite && !!perms && perms.hasGenericPermission('DASHBOARD', 'CREATE');
      return load();
    }).then(function () {
      render();
      timer = setInterval(refresh, REFRESH_MS);
    });
  });
}).catch(function (err) { fail(t('common.loadFailed', 'Could not load: {error}', { error: errText(err) })); });

};
