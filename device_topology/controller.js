/*
 * Device — the technician's view of one LOGR: is it live, and what is on its
 * bus (TC-1, TC-3, TC-4, TC-5). Read-only.
 *
 * Positions come from `topology.p<POS>.*`, sources from `subscriptions.*` and
 * from the telemetry keys the device actually stored, so a bus with no report
 * yet still shows what arrives. A source's state is its latest reading: a value
 * newer than its `<sourceKey>.status` is OK, otherwise the status code is the
 * fault the device stated (HEALTH.md §1). Faults counted in the header are the
 * device's active `peripheralFault.*` alarms. Widget:
 * logr-product-docs/cloud/DEVICE_VIEW.md.
 *
 * Loads after shared/resolver.js, glossary.js, ui.js and tb_io.js.
 */

window.TerrySenseDeviceTopology = function (ctx, container) {

var resolver = window.TerrySenseResolver;
var G = window.TerrySenseGlossary;
var tb = window.TerrySenseTbIo(ctx);
var root = container.querySelector('.ts-root') || container;
var ui = window.TerrySenseUi(root);
var h = ui.h, esc = ui.esc, ICON = ui.ICON, info = ui.info;
var camel = resolver.camelKind;

var EMPTY_MARKER = '(empty)';
var TOPOLOGY_TYPE_RE = /^topology\.p(\d+)\.type$/;
var SOURCE_KEY_RE = /^p(\d+)\.([a-z][A-Za-z0-9]*)(?:\.g(\d+))?(?:\.i(\d+))?$/;
var FAULT_PREFIX = 'peripheralFault.';
var REFRESH_MS = 60000;

function parseSource(key) {
  var m = SOURCE_KEY_RE.exec(key);
  return m ? {
    sourceKey: key, position: Number(m[1]), kind: m[2],
    group: m[3] !== undefined ? Number(m[3]) : 0, index: m[4] !== undefined ? Number(m[4]) : 0
  } : null;
}

function parseJson(raw) {
  if (!raw) { return null; }
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (e) { return null; }
}

function ago(ts) {
  if (!ts) { return 'never'; }
  var s = Math.max(0, (Date.now() - Number(ts)) / 1000);
  if (s < 90) { return 'just now'; }
  if (s < 5400) { return Math.round(s / 60) + ' min ago'; }
  if (s < 129600) { return Math.round(s / 3600) + ' h ago'; }
  return Math.round(s / 86400) + ' days ago';
}

function fmtValue(v) {
  var n = Number(v);
  if (v === '' || v === null || isNaN(n)) { return String(v); }
  return String(Math.round(n * 1000) / 1000);
}

// -- data -------------------------------------------------------------------------------

var state = { device: null, client: {}, server: {}, latest: {}, faults: {}, peripherals: {}, kinds: {}, names: {}, showBoard: false, loadedAt: 0 };

function loadDefaults() {
  return tb.io.fetchDefaults().then(function (d) { return d ? tb.attrsMap(d) : {}; }).then(function (a) {
    state.peripherals = parseJson(a['config.peripherals']) || {};
    state.kinds = parseJson(a['config.kinds']) || {};
    state.names = parseJson(a['config.channelNames']) || {};
  });
}

function loadDevice(id) {
  var dev = { entityType: 'DEVICE', id: id };
  return Promise.all([
    tb.get('/api/device/' + id),
    tb.attrsMap(dev, 'CLIENT_SCOPE'),
    tb.attrsMap(dev, 'SERVER_SCOPE'),
    tb.get('/api/plugins/telemetry/DEVICE/' + id + '/keys/timeseries').catch(function () { return []; }),
    tb.get('/api/alarm/DEVICE/' + id, { searchStatus: 'ACTIVE', pageSize: '100', page: '0' }).catch(function () { return null; })
  ]).then(function (got) {
    state.device = got[0];
    state.client = got[1];
    state.server = got[2];
    state.faults = {};
    ((got[4] && got[4].data) || []).forEach(function (a) {
      if (a.type.indexOf(FAULT_PREFIX) === 0) { state.faults[a.type.slice(FAULT_PREFIX.length)] = a; }
    });
    var keys = (got[3] || []).filter(function (k) { return parseSource(k.replace(/\.status$/, '')); });
    if (!keys.length) { return {}; }
    return tb.get('/api/plugins/telemetry/DEVICE/' + id + '/values/timeseries', { keys: keys.join(',') });
  }).then(function (latest) {
    state.latest = {};
    Object.keys(latest || {}).forEach(function (k) {
      var p = latest[k] && latest[k][0];
      if (p) { state.latest[k] = { ts: Number(p.ts), value: p.value }; }
    });
    state.loadedAt = Date.now();
  });
}

// -- model ------------------------------------------------------------------------------

function topology() {
  var nodes = {};
  Object.keys(state.client).forEach(function (key) {
    var m = TOPOLOGY_TYPE_RE.exec(key);
    if (!m) { return; }
    var type = String(state.client[key] || '').trim();
    if (!type || type === EMPTY_MARKER) { return; }
    nodes[m[1]] = { position: Number(m[1]), type: type, version: state.client['topology.p' + m[1] + '.version'] };
  });
  return nodes;
}

function sources() {
  var out = {};
  function add(key) { var s = parseSource(key); if (s && !out[key]) { out[key] = s; } return out[key]; }
  Object.keys(state.client).forEach(function (key) {
    var m = /^subscriptions\.(.+)\.(enabled|interval)$/.exec(key);
    var s = m && add(m[1]);
    if (s) { s[m[2]] = state.client[key]; }
  });
  Object.keys(state.latest).forEach(function (key) { add(key.replace(/\.status$/, '')); });
  Object.keys(state.faults).forEach(add);
  return Object.keys(out).map(function (k) { return out[k]; });
}

/** ok | fault | waiting | disabled, from the latest value and status of one source. */
function sourceState(s) {
  var v = state.latest[s.sourceKey], st = state.latest[s.sourceKey + '.status'];
  if (st && (!v || st.ts >= v.ts)) { return { state: 'fault', code: String(st.value), ts: st.ts }; }
  if (v) { return { state: 'ok', value: v.value, ts: v.ts }; }
  if (s.enabled === false || s.enabled === 'false') { return { state: 'disabled' }; }
  return { state: 'waiting' };
}

function measureOf(s, node) {
  var p = node && state.peripherals[node.type];
  return p && (p.measures || []).filter(function (m) {
    return camel(m.kind) === s.kind && m.group === s.group && m.index === s.index;
  })[0];
}

function sourceLabel(s, node) {
  var m = measureOf(s, node);
  var entry = m && state.names[m.defaultName];
  return entry && entry.label ? entry.label : ((resolver.kindSpec(s.kind, state.kinds) || {}).label || s.kind);
}

function unitOf(s) { return (resolver.kindSpec(s.kind, state.kinds) || {}).cloudUnit || ''; }

// -- skeleton ---------------------------------------------------------------------------

root.innerHTML = '';
var cardEl = h('<div class="ts-card ts-readonly"><div class="ts-head"><div class="ts-head-icon">' + ICON.gauge + '</div><div class="ts-head-text">' +
  '<div class="ts-title"><span>Device</span></div><div class="ts-subtitle"></div></div><span class="ts-chip level" hidden></span></div>' +
  '<div class="ts-body"><div class="ts-loading">Loading…</div></div>' +
  '<div class="ts-foot"><span class="ts-summary"></span><span class="ts-spacer"></span><button type="button" class="ts-btn">' + ICON.reset + 'Refresh</button></div></div>');
root.appendChild(cardEl);
var bodyEl = cardEl.querySelector('.ts-body');
var summaryEl = cardEl.querySelector('.ts-summary');
var refreshBtn = cardEl.querySelector('.ts-foot .ts-btn');

function fail(text) {
  bodyEl.innerHTML = '';
  bodyEl.appendChild(h('<div class="ts-empty"></div>')).textContent = text;
}

// -- render -----------------------------------------------------------------------------

function render() {
  var d = state.device;
  cardEl.querySelector('.ts-subtitle').textContent = d.name + (d.label ? ' · ' + d.label : '');
  var chip = cardEl.querySelector('.ts-chip.level');
  chip.hidden = !d.type;
  chip.textContent = d.type || '';

  var nodes = topology();
  var srcs = sources();
  var faulting = Object.keys(state.faults);
  var active = state.server.active === true || state.server.active === 'true';

  bodyEl.innerHTML = '';
  var verdict = active && !faulting.length;
  var banner = h('<div class="ts-banner ' + (verdict ? 'ok' : 'warn') + '">' + (verdict ? ICON.check : ICON.info) + '<span></span></div>');
  banner.querySelector('span').textContent = verdict
    ? 'Live, no peripheral fault.'
    : [active ? null : 'Not active: no uplink within the inactivity timeout.',
       faulting.length ? faulting.length + (faulting.length === 1 ? ' source is' : ' sources are') + ' faulting.' : null]
      .filter(Boolean).join(' ');
  bodyEl.appendChild(banner);

  function kv(label, tip, valueHtml) {
    var row = h('<div class="ts-kv"><div class="ts-kv-label">' + esc(label) + (tip ? ' ' + info(tip) : '') + '</div><div class="ts-kv-value"></div></div>');
    row.querySelector('.ts-kv-value').innerHTML = valueHtml;
    bodyEl.appendChild(row);
  }
  kv('Uplink', 'uplink', '<span class="ts-status"><span class="ts-dot" style="background:' + (active ? 'var(--ts-ok)' : 'var(--ts-danger)') + '"></span>' +
    esc((active ? 'Active, last ' : 'Inactive, last ') + ago(state.server.lastActivityTime)) + '</span>');
  kv('Faults', 'peripheralFault', faulting.length
    ? faulting.sort().map(function (k) { return '<span class="ts-chip fault">' + esc(k) + '</span>'; }).join(' ')
    : '<span class="ts-status">none</span>');
  var fw = state.client['deviceInfo.fwVersion'], hw = state.client['deviceInfo.hwVersion'];
  if (fw || hw) { kv('Versions', null, '<span class="ts-mono">' + esc(['firmware ' + (fw || '?'), 'hardware ' + (hw || '?')].join(' · ')) + '</span>'); }

  var sec = h('<div class="ts-section"><div class="ts-section-head">Bus ' + info('position') + '</div></div>');
  var positions = {};
  Object.keys(nodes).forEach(function (p) { positions[p] = true; });
  srcs.forEach(function (s) { positions[s.position] = true; });
  var order = Object.keys(positions).map(Number).sort(function (a, b) { return a - b; });
  if (!order.length) {
    sec.appendChild(h('<div class="ts-empty">No topology report and no reading from this device yet.</div>'));
  }
  order.forEach(function (pos) {
    var node = nodes[pos];
    var own = srcs.filter(function (s) { return s.position === pos; }).sort(function (a, b) { return a.sourceKey.localeCompare(b.sourceKey); });
    var box = h('<div class="ts-pos"><div class="ts-pos-head"><span class="ts-pos-num"></span><span class="ts-pos-name"></span><span class="ts-mono"></span><span class="ts-spacer"></span></div></div>');
    var head = box.querySelector('.ts-pos-head');
    box.querySelector('.ts-pos-num').textContent = pos;
    var p = node && state.peripherals[node.type];
    box.querySelector('.ts-pos-name').textContent = pos === 0 ? 'LOGR itself' : (p ? p.displayName : node ? node.type : 'Unknown peripheral');
    box.querySelector('.ts-mono').textContent = node ? node.type + (node.version !== undefined && node.version !== null ? ' · v' + node.version : '') : '';
    if (!node) { head.appendChild(h('<span class="ts-chip warn">not in the topology report</span>')); }
    else if (!p && pos !== 0) { head.appendChild(h('<span class="ts-chip warn">not in the catalog</span>')); }
    var bad = own.filter(function (s) { return sourceState(s).state === 'fault' || state.faults[s.sourceKey]; });
    if (bad.length) { head.appendChild(h('<span class="ts-chip fault">' + bad.length + ' faulting</span>')); }

    var collapsed = pos === 0 && !bad.length && !state.showBoard;
    if (!own.length) {
      box.appendChild(h('<div class="ts-tsrc"><span class="ts-empty">No subscription and no reading from this position.</span></div>'));
    } else if (collapsed) {
      var more = h('<button type="button" class="ts-more"></button>');
      more.textContent = 'Show ' + own.length + ' on-board reading' + (own.length === 1 ? '' : 's');
      more.addEventListener('click', function () { state.showBoard = true; render(); });
      box.appendChild(more);
    } else {
      own.forEach(function (s) { box.appendChild(sourceRow(s, node)); });
    }
    sec.appendChild(box);
  });
  bodyEl.appendChild(sec);
  summaryEl.textContent = 'Read ' + new Date(state.loadedAt).toLocaleTimeString();
}

function sourceRow(s, node) {
  var st = sourceState(s);
  var row = h('<div class="ts-tsrc"><div><div class="ts-row-label"></div><div class="ts-mono"></div></div><div class="ts-tsrc-state"></div><div class="ts-tsrc-value"></div></div>');
  row.dataset.source = s.sourceKey;
  row.dataset.state = st.state;
  row.querySelector('.ts-row-label').textContent = sourceLabel(s, node);
  row.querySelector('.ts-mono').textContent = s.sourceKey + (s.interval ? ' · every ' + s.interval + ' s' : '');
  var stateEl = row.querySelector('.ts-tsrc-state'), valueEl = row.querySelector('.ts-tsrc-value');
  if (st.state === 'fault') {
    var code = G.STATUS_CODES[st.code];
    stateEl.innerHTML = '<span class="ts-chip fault"></span>';
    stateEl.firstChild.textContent = st.code;
    valueEl.innerHTML = '<span class="ts-tsrc-why"></span><span class="ts-row-meta"></span>';
    valueEl.firstChild.textContent = code || 'Unknown status code';
    valueEl.lastChild.textContent = ago(st.ts);
  } else if (st.state === 'ok') {
    stateEl.innerHTML = '<span class="ts-chip ok">OK</span>';
    valueEl.innerHTML = '<b></b><span class="ts-row-meta"></span>';
    valueEl.firstChild.textContent = fmtValue(st.value) + (unitOf(s) ? ' ' + unitOf(s) : '');
    valueEl.lastChild.textContent = ago(st.ts);
  } else if (st.state === 'disabled') {
    stateEl.innerHTML = '<span class="ts-chip">Disabled</span>';
    valueEl.innerHTML = '<span class="ts-row-meta">subscription switched off</span>';
  } else {
    stateEl.innerHTML = '<span class="ts-chip warn">No reading</span>';
    valueEl.innerHTML = '<span class="ts-row-meta">subscribed, nothing received yet</span>';
  }
  if (state.faults[s.sourceKey]) { stateEl.appendChild(h('<span class="ts-chip fault" title="Active peripheralFault alarm">' + ICON.bell + '</span>')); }
  return row;
}

// -- load -------------------------------------------------------------------------------

var timer = null;
function refresh() {
  if (!root.isConnected && timer) { clearInterval(timer); return Promise.resolve(); }
  refreshBtn.disabled = true;
  return loadDevice(state.device.id.id).then(render).catch(function (err) {
    ui.toast('Refresh failed: ' + (err && err.message ? err.message : err), 'error');
  }).then(function () { refreshBtn.disabled = false; });
}
refreshBtn.addEventListener('click', refresh);

tb.boundDatasource().then(function (ds) {
  if (!ds || ds.entityType !== 'DEVICE') { fail('No device bound — bind a device in the widget\'s Data tab.'); return; }
  return Promise.all([loadDefaults(), loadDevice(ds.entityId)]).then(function () {
    render();
    timer = setInterval(refresh, REFRESH_MS);
  });
}).catch(function (err) { fail('Could not load: ' + (err && err.message ? err.message : err)); });

};
