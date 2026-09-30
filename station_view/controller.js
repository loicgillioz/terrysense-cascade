/*
 * Station — one station: which measurement feeds each of its channels, and
 * the latest value of each (left); the device that measures them and the
 * project the station stands in, with its location (right). Read-only for everyone.
 * Widget: logr-product-docs/cloud/FRONTEND.md *Station view*.
 *
 * Channels are the keys of `config.channelMap`, each fed by a source key of
 * the station's device; labels and units are `effective.<channel>.*`. A name
 * the vocabulary marks diagnostic is folded away unless it is in alarm. A
 * channel with an active `<channel>.max|min|state` alarm carries its severity;
 * the station's other alarms are listed under the channels.
 *
 * `opts`, set by build_project_dashboard.py: `devicesDashboardId` (the device
 * card), `projectDashboardId` (the project card).
 *
 * Loads after shared/resolver.js, glossary.js, ui.js and tb_io.js.
 */

window.TerrySenseStationView = function (ctx, container, opts) {

opts = opts || {};
var resolver = window.TerrySenseResolver;
var G = window.TerrySenseGlossary;
var tb = window.TerrySenseTbIo(ctx);
var root = container.querySelector('.ts-root') || container;
var ui = window.TerrySenseUi(root);
var h = ui.h, esc = ui.esc, ICON = ui.ICON;

var REFRESH_MS = 60000;
var HOUR = 3600000;
var SOURCE_KEY_RE = /^p(\d+)\.([a-z][A-Za-z0-9]*)(?:\.g(\d+))?(?:\.i(\d+))?$/;
var CHANNEL_ALARM_RE = /^(.+)\.(max|min|state)$/;
var OTHER_ALARMS = [
  { prefix: 'peripheralFault.', text: 'Sensor fault' },
  { prefix: 'deviceEvent.movement', text: 'Logger moved' },
  { prefix: 'deviceEvent.batteryCritical', text: 'Logger battery critical' },
  { prefix: 'deviceEvent.power', text: 'Logger power changed' },
  { prefix: 'deviceHealth', text: 'Logger self-test fault' },
  { prefix: 'pipelineError', text: 'Data processing error' }
];

function parseJson(raw) {
  if (!raw) { return null; }
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (e) { return null; }
}

function errText(e) { return (e && e.error && e.error.message) || (e && e.message) || String(e); }

function ago(ts) {
  if (!ts) { return 'never'; }
  var s = Math.max(0, (Date.now() - Number(ts)) / 1000);
  if (s < 90) { return 'just now'; }
  if (s < 5400) { return Math.round(s / 60) + ' min ago'; }
  if (s < 129600) { return Math.round(s / 3600) + ' h ago'; }
  return Math.round(s / 86400) + ' days ago';
}

function fmtNumber(n) {
  var a = Math.abs(n);
  var digits = a >= 1000 ? 0 : a >= 100 ? 1 : a >= 1 ? 2 : 3;
  return String(Math.round(n * Math.pow(10, digits)) / Math.pow(10, digits));
}

function flag(v) { return v === true || v === 'true'; }

function worst(severities) {
  return severities.filter(Boolean).sort(function (a, b) { return G.rank(b.toLowerCase()) - G.rank(a.toLowerCase()); })[0] || null;
}

// -- data -------------------------------------------------------------------------------

var state = {
  station: null, attrs: {}, names: {}, kinds: {}, peripherals: {},
  channels: [], alarms: [], devices: [], chain: [], showDiagnostic: false, loadedAt: 0
};

function loadDefaults() {
  return tb.io.fetchDefaults().then(function (d) { return d ? tb.attrsMap(d) : {}; }).then(function (a) {
    state.names = parseJson(a['config.channelNames']) || {};
    state.kinds = parseJson(a['config.kinds']) || {};
    state.peripherals = parseJson(a['config.peripherals']) || {};
  });
}

function channelOf(name, sourceKey, attrs, latest) {
  var base = state.names[resolver.splitChannelKey(name).name] || {};
  var raw = latest[name] && latest[name][0];
  return {
    name: name, sourceKey: sourceKey,
    label: attrs['effective.' + name + '.label'] || base.label || name,
    unit: attrs['effective.' + name + '.unit'] || '',
    diagnostic: !!base.diagnostic,
    states: base.states || null,
    whenTrue: attrs['effective.' + name + '.textWhenTrue'],
    whenFalse: attrs['effective.' + name + '.textWhenFalse'],
    latest: raw && raw.value !== null && raw.value !== undefined ? { ts: Number(raw.ts), value: raw.value } : null,
    alarm: null
  };
}

/** The devices the station contains, plus the map's `sourceDeviceId` if no relation names it. */
function loadDevices(station, map) {
  var query = {
    parameters: { rootId: station.id, rootType: 'ASSET', direction: 'FROM', relationTypeGroup: 'COMMON', maxLevel: 1, fetchLastLevelOnly: false },
    filters: [{ relationType: 'Contains', entityTypes: ['DEVICE'] }]
  };
  return tb.post('/api/relations', query).catch(function () { return []; }).then(function (rels) {
    var ids = (rels || []).map(function (r) { return r.to.id; });
    if (map.sourceDeviceId && ids.indexOf(map.sourceDeviceId) < 0) { ids.push(map.sourceDeviceId); }
    return Promise.all(ids.map(loadDevice));
  });
}

function loadDevice(id) {
  var dev = { entityType: 'DEVICE', id: id };
  return tb.get('/api/device/' + id).then(function (d) {
    return Promise.all([
      tb.attrsMap(dev, 'SERVER_SCOPE'), tb.attrsMap(dev, 'CLIENT_SCOPE'),
      tb.get('/api/alarm/DEVICE/' + id, { searchStatus: 'ACTIVE', pageSize: '100', page: '0' }).catch(function () { return null; })
    ]).then(function (got) {
      return { id: id, device: d, server: got[0], client: got[1], alarms: (got[2] && got[2].data) || [] };
    });
  }).catch(function () { return { id: id, hidden: true }; });
}

function load() {
  var s = state.station, url = '/api/plugins/telemetry/ASSET/' + s.id + '/values/timeseries';
  return Promise.all([tb.attrsMap(s), tb.ancestors(s)]).then(function (got) {
    var attrs = got[0], map = parseJson(attrs['config.channelMap']) || {};
    var channels = map.channels || {};
    var names = Object.keys(channels);
    state.attrs = attrs;
    state.chain = got[1];
    return Promise.all([
      names.length ? tb.get(url, { keys: names.join(',') }).catch(function () { return {}; }) : {},
      tb.get('/api/alarm/ASSET/' + s.id, { searchStatus: 'ACTIVE', pageSize: '100', page: '0' }).catch(function () { return null; }),
      loadDevices(s, map)
    ]).then(function (r) {
      state.channels = names.map(function (n) { return channelOf(n, channels[n], attrs, r[0] || {}); })
        .sort(function (a, b) { return a.label.localeCompare(b.label); });
      var byName = {};
      state.channels.forEach(function (c) { byName[c.name] = c; });
      state.alarms = [];
      ((r[1] && r[1].data) || []).forEach(function (a) {
        var m = CHANNEL_ALARM_RE.exec(a.type), c = m && byName[m[1]];
        if (c) { c.alarm = worst([c.alarm, a.severity]); } else { state.alarms.push(a); }
      });
      state.devices = r[2];
      state.loadedAt = Date.now();
    });
  });
}

// -- model ------------------------------------------------------------------------------

function display(c) {
  if (!c.latest) { return { text: '—', unit: '' }; }
  var v = c.latest.value;
  if (v === true || v === 'true' || v === false || v === 'false') {
    var on = flag(v);
    return { text: (on ? c.whenTrue : c.whenFalse) || (on ? 'on' : 'off'), unit: '' };
  }
  if (c.states && c.states[String(v)] !== undefined) { return { text: c.states[String(v)], unit: '' }; }
  var n = Number(v);
  return isNaN(n) ? { text: String(v), unit: '' } : { text: fmtNumber(n), unit: c.unit };
}

/** What feeds a channel, in words: the measurement and, on a bus, its position and peripheral. */
function measurement(c) {
  var m = SOURCE_KEY_RE.exec(c.sourceKey || '');
  var dev = state.devices.filter(function (d) { return !d.hidden; })[0];
  if (!m) { return ((state.names[c.sourceKey] || {}).label) || c.sourceKey || '?'; }
  var pos = Number(m[1]), kind = m[2];
  var type = dev && dev.client['topology.p' + pos + '.type'];
  var p = type && state.peripherals[type];
  var measure = p && (p.measures || []).filter(function (x) {
    return resolver.camelKind(x.kind) === kind && (x.group || 0) === Number(m[3] || 0) && (x.index || 0) === Number(m[4] || 0);
  })[0];
  var label = (measure && (state.names[measure.defaultName] || {}).label) || (resolver.kindSpec(kind, state.kinds) || {}).label || kind;
  var where = pos === 0 ? 'the LOGR itself' : 'position ' + pos + (p ? ', ' + p.displayName : type ? ', ' + type : '');
  return label + ' · ' + where;
}

function stationStatus() {
  var sev = worst(state.channels.map(function (c) { return c.alarm; }).concat(state.alarms.map(function (a) { return a.severity; })));
  if (sev) { return { id: 'alarm', label: G.severity(sev.toLowerCase()).label, color: 'var(--sev-' + sev.toLowerCase() + ')' }; }
  var last = state.channels.reduce(function (m, c) { return Math.max(m, c.latest ? c.latest.ts : 0); }, 0);
  if (!last) { return { id: 'nodata', label: 'No data', color: 'var(--ts-nodata)' }; }
  var staleMs = Number(state.attrs['effective.staleAfterHours']) * HOUR || 0;
  if (staleMs && Date.now() - last > staleMs) { return { id: 'stale', label: 'Stale', color: 'var(--ts-stale)' }; }
  return { id: 'ok', label: 'OK', color: 'var(--ts-ok)' };
}

function otherAlarmText(a) {
  var kind = OTHER_ALARMS.filter(function (o) { return a.type.indexOf(o.prefix) === 0; })[0];
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
  '    <div class="ts-head-text"><div class="ts-title">Station</div><div class="ts-subtitle"></div></div>' +
  '    <span class="ts-chip ts-stv-state" hidden></span></div>' +
  '  <div class="ts-stv-split"><div class="ts-stv-main"><div class="ts-loading">Loading…</div></div><div class="ts-stv-side"></div></div>' +
  '  <div class="ts-foot"><span class="ts-row-meta ts-stv-updated"></span><span class="ts-spacer"></span>' +
  '    <button type="button" class="ts-btn">' + ICON.reset + 'Refresh</button></div>' +
  '</div>');
root.innerHTML = '';
root.appendChild(cardEl);
var mainEl = cardEl.querySelector('.ts-stv-main');
var sideEl = cardEl.querySelector('.ts-stv-side');
var refreshBtn = cardEl.querySelector('.ts-foot .ts-btn');

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
  cardEl.querySelector('.ts-stv-updated').textContent = 'Read ' + new Date(state.loadedAt).toLocaleTimeString();
  renderChannels();
  renderSide();
}

function renderChannels() {
  mainEl.innerHTML = '';
  var sec = mainEl.appendChild(h('<div class="ts-section"><div class="ts-section-head">Channels</div></div>'));
  if (!state.channels.length) {
    sec.appendChild(h('<div class="ts-empty">No channel mapped yet: no measurement reaches this station.</div>'));
  }
  var shown = state.channels.filter(function (c) { return state.showDiagnostic || !c.diagnostic || c.alarm; });
  shown.forEach(function (c) { sec.appendChild(channelRow(c)); });
  var hidden = state.channels.length - shown.length;
  if (hidden || state.showDiagnostic && state.channels.some(function (c) { return c.diagnostic; })) {
    var more = sec.appendChild(h('<button type="button" class="ts-more"></button>'));
    more.textContent = state.showDiagnostic ? 'Hide diagnostic channels' : 'Show ' + hidden + ' diagnostic channel' + (hidden === 1 ? '' : 's');
    more.addEventListener('click', function () { state.showDiagnostic = !state.showDiagnostic; renderChannels(); });
  }
  if (state.alarms.length) {
    var al = mainEl.appendChild(h('<div class="ts-section"><div class="ts-section-head">Other alarms</div></div>'));
    state.alarms.forEach(function (a) {
      var row = al.appendChild(h('<div class="ts-stv-alarm"><span class="ts-chip ts-stv-sev"></span><span></span></div>'));
      row.firstChild.style.setProperty('--c', 'var(--sev-' + a.severity.toLowerCase() + ')');
      row.firstChild.textContent = G.severity(a.severity.toLowerCase()).label;
      row.lastChild.textContent = otherAlarmText(a);
    });
  }
}

function channelRow(c) {
  var row = h('<div class="ts-stv-ch"><div class="ts-stv-ch-main"><div class="ts-row-label"></div>' +
    '<div class="ts-stv-src"><span class="ts-stv-meas"></span> → <span class="ts-mono"></span></div></div>' +
    '<div class="ts-stv-val"><b></b><span class="ts-row-meta"></span></div></div>');
  row.dataset.channel = c.name;
  row.querySelector('.ts-row-label').textContent = c.label;
  row.querySelector('.ts-stv-meas').textContent = measurement(c);
  row.querySelector('.ts-stv-meas').title = c.sourceKey || '';
  row.querySelector('.ts-mono').textContent = c.name;
  var d = display(c);
  row.querySelector('b').textContent = d.text + (d.unit ? ' ' + d.unit : '');
  row.querySelector('.ts-stv-val .ts-row-meta').textContent = c.latest ? ago(c.latest.ts) : 'no reading yet';
  if (c.alarm) {
    row.classList.add('alarm');
    row.style.setProperty('--c', 'var(--sev-' + c.alarm.toLowerCase() + ')');
    var chipEl = h('<span class="ts-chip ts-stv-sev"></span>');
    chipEl.style.setProperty('--c', 'var(--sev-' + c.alarm.toLowerCase() + ')');
    chipEl.textContent = G.severity(c.alarm.toLowerCase()).label;
    row.querySelector('.ts-stv-val').insertBefore(chipEl, row.querySelector('b'));
  }
  return row;
}

function sideCard(kind, icon, title) {
  var el = sideEl.appendChild(h('<div class="ts-stv-card"><div class="ts-stv-card-head">' + icon + '<span class="ts-stv-kind"></span></div>' +
    '<div class="ts-stv-card-title"></div><div class="ts-stv-card-body"></div></div>'));
  el.dataset.card = kind;
  el.querySelector('.ts-stv-kind').textContent = kind;
  el.querySelector('.ts-stv-card-title').textContent = title;
  return el;
}

function linkCard(el, go) {
  el.classList.add('link');
  el.tabIndex = 0;
  el.setAttribute('role', 'button');
  el.querySelector('.ts-stv-card-head').insertAdjacentHTML('beforeend', '<span class="ts-spacer"></span>' + ICON.chev);
  el.addEventListener('click', go);
  el.addEventListener('keydown', function (e) { if (e.key === 'Enter') { go(); } });
}

function line(el, text, cls) {
  var l = el.querySelector('.ts-stv-card-body').appendChild(h('<div class="ts-stv-line"></div>'));
  if (cls) { l.classList.add(cls); }
  l.textContent = text;
  return l;
}

function renderSide() {
  sideEl.innerHTML = '';
  if (!state.devices.length) {
    line(sideCard('Device', ICON.gauge, 'No device'), 'No device feeds this station.');
  }
  state.devices.forEach(function (d) {
    if (d.hidden) { line(sideCard('Device', ICON.gauge, 'Device'), 'Not visible to you.'); return; }
    var dev = d.device, live = flag(d.server.active), last = Number(d.server.lastActivityTime) || 0;
    var el = sideCard('Device', ICON.gauge, dev.label || dev.name);
    el.dataset.device = dev.name;
    var up = line(el, (last ? (live ? 'Live, last uplink ' : 'Inactive, last uplink ') + ago(last) : 'Never heard from'), 'ts-stv-live');
    up.insertAdjacentHTML('afterbegin', '<span class="ts-dot" style="background:' + (live ? 'var(--ts-ok)' : last ? 'var(--ts-danger)' : 'var(--ts-text-3)') + '"></span>');
    line(el, [dev.name !== (dev.label || dev.name) ? dev.name : '', dev.type,
      d.client['deviceInfo.fwVersion'] ? 'firmware ' + d.client['deviceInfo.fwVersion'] : ''].filter(Boolean).join(' · '), 'ts-row-meta');
    if (d.client['status.soc'] !== undefined) { line(el, 'Battery ' + fmtNumber(Number(d.client['status.soc'])) + ' %'); }
    var sev = worst(d.alarms.map(function (a) { return a.severity; }));
    if (sev) { line(el, d.alarms.length + ' active alarm' + (d.alarms.length === 1 ? '' : 's') + ', worst ' + G.severity(sev.toLowerCase()).label, 'ts-stv-bad'); }
    if (opts.devicesDashboardId) {
      linkCard(el, function () {
        tb.openDashboard(opts.devicesDashboardId, 'device', { entityType: 'DEVICE', id: d.id, name: dev.name });
      });
    }
  });

  var parent = state.chain[0], project = state.chain.filter(function (a) { return a.kind === 'Project'; })[0];
  if (!project) {
    line(sideCard('Project', ICON.map, 'No project'), 'The station is in no project.');
    return;
  }
  var pr = sideCard('Project', ICON.map, project.name);
  line(pr, parent && parent.kind === 'Location' ? 'Location: ' + parent.name : 'At no location', 'ts-row-meta');
  if (opts.projectDashboardId) {
    linkCard(pr, function () { tb.openDashboard(opts.projectDashboardId, 'project', project); });
    pr.querySelector('.ts-stv-card-head .ts-spacer').insertAdjacentHTML('afterend', '<span class="ts-stv-go">Open project</span>');
  }
}

// -- load -------------------------------------------------------------------------------

var timer = null;
function refresh() {
  if (!root.isConnected && timer) { clearInterval(timer); return Promise.resolve(); }
  refreshBtn.disabled = true;
  return load().then(render).catch(function (err) {
    ui.toast('Refresh failed: ' + errText(err), 'error');
  }).then(function () { refreshBtn.disabled = false; });
}
refreshBtn.addEventListener('click', refresh);

tb.boundDatasource().then(function (ds) {
  if (!ds || ds.entityType !== 'ASSET') { fail('No station bound — bind a station in the widget\'s Data tab.'); return; }
  return Promise.all([tb.loadEntity(ds), loadDefaults()]).then(function (got) {
    if (got[0].kind !== 'Station') { fail('This widget shows a station; ' + got[0].name + ' is a ' + got[0].kind + '.'); return; }
    state.station = got[0];
    return load().then(function () {
      render();
      timer = setInterval(refresh, REFRESH_MS);
    });
  });
}).catch(function (err) { fail('Could not load: ' + errText(err)); });

};
