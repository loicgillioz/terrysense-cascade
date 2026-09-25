/*
 * Device — one LOGR: is it live, what is on its bus (TC-1, TC-3, TC-4, TC-5),
 * and, for a user who may write the device, the commands to reconfigure it
 * (CA-4, TC-8/9). Read-only for anyone else.
 *
 * A command is written as `cmd.request`; `dl_dispatch` sends it and leaves a
 * `cmd.seq.<seq>` marker, `dl_ack` turns the device's answer into
 * `cmd.lastResult` (DOWNLINK.md).
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
var MARKER_RE = /^cmd\.seq\.(\d+)$/;
var REFRESH_MS = 60000;
var DAY_MS = 86400000;

function parseSource(key) {
  var m = SOURCE_KEY_RE.exec(key);
  return m ? {
    sourceKey: key, position: Number(m[1]), kind: m[2],
    group: m[3] !== undefined ? Number(m[3]) : 0, index: m[4] !== undefined ? Number(m[4]) : 0,
    hasGroup: m[3] !== undefined, hasIndex: m[4] !== undefined
  } : null;
}

/** `ph` -> `PH`, `drycStatus` -> `DRYC_STATUS`: the wire kind the encoder takes. */
function wireKind(kind) { return String(kind).replace(/([A-Z])/g, '_$1').toUpperCase(); }

function sourceTarget(s) {
  var t = { mode: 'SOURCE', position: s.position, kind: wireKind(s.kind) };
  if (s.hasGroup) { t.group = s.group; }
  if (s.hasIndex) { t.index = s.index; }
  return t;
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

var state = {
  device: null, client: {}, server: {}, latest: {}, faults: {}, peripherals: {}, kinds: {}, names: {},
  showBoard: false, loadedAt: 0, writable: false, me: null
};

function deviceEntity() {
  return { entityType: 'DEVICE', id: state.device.id.id, ownerId: state.device.ownerId && state.device.ownerId.id };
}

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

// -- commands (CA-4, TC-8/9) ---------------------------------------------------------------

function parseValue(raw) { return typeof raw === 'string' ? parseJson(raw) : raw; }

/** Commands still waiting for an ACK; one past its window is unanswered. */
function pending() {
  var interval = Number(state.client['status.baseIntervalSeconds']) || 0;
  var window = Math.max(DAY_MS, 2 * interval * 1000);
  return Object.keys(state.server).filter(function (k) { return MARKER_RE.test(k); }).map(function (k) {
    var m = parseValue(state.server[k]) || {};
    return { key: k, seq: m.seq, commands: m.commands || [], issuedAt: Number(m.issuedAt) || 0,
             unanswered: Date.now() - (Number(m.issuedAt) || 0) > window };
  }).sort(function (a, b) { return b.issuedAt - a.issuedAt; });
}

function targetText(t) {
  if (!t || t.mode === 'GLOBAL' || !t.mode) { return ''; }
  if (t.mode === 'POSITION') { return ' at position ' + t.position; }
  return ' of p' + t.position + '.' + camel(t.kind) + (t.group ? '.g' + t.group : '') + (t.index !== undefined ? '.i' + t.index : '');
}

function commandText(c) {
  var what = {
    SET_INTERVAL: 'Interval' + targetText(c.target) + ' → ' + c.interval_s + ' s',
    SET_ENABLED: (c.enabled ? 'Enable' : 'Disable') + targetText(c.target),
    SELF_DIAG: 'Self-diagnostic',
    REQUEST_REPORT: 'Request reports' + (c.reports ? ': ' + c.reports.join(', ') : ''),
    CREATE_SUBSCRIPTION: 'Subscribe' + targetText(c.target) + ' every ' + c.interval_s + ' s',
    DELETE_SUBSCRIPTION: 'Remove subscription' + targetText(c.target),
    PERIPHERAL_OP: 'Peripheral operation' + targetText(c.target)
  }[c.op];
  return what || String(c.op);
}

function resultText(r) {
  if (r.status !== 'OK') { return r.opcode + ': ' + (G.COMMAND_STATUS[r.status] || r.status); }
  if (r.applied_interval_s !== undefined) { return r.opcode + ': OK, now ' + r.applied_interval_s + ' s'; }
  if (r.selfdiag_faults) { return r.opcode + ': ' + (r.selfdiag_faults.length ? 'faults ' + r.selfdiag_faults.join(', ') : 'all healthy'); }
  return r.opcode + ': OK';
}

function send(commands, retryOf) {
  var list = commands.map(function (c) { return '<li>' + esc(commandText(c)) + '</li>'; }).join('');
  return ui.confirm('Send to <b>' + esc(state.device.label || state.device.name) + '</b>?<ul>' + list + '</ul>' +
    'It is delivered after the device’s next uplink.', 'Send').then(function (ok) {
    if (!ok) { return; }
    var dev = deviceEntity();
    var request = { commands: commands, by: (state.me && state.me.email) || null, issuedAt: Date.now() };
    return (retryOf ? tb.deleteAttrs(dev, [retryOf]) : Promise.resolve()).then(function () {
      return tb.saveAttrs(dev, { 'cmd.request': request });
    }).then(function () {
      ui.toast('Queued: delivered after the next uplink');
      ui.closeDrawer();
      setTimeout(refresh, 1500);
    }).catch(function (err) {
      ui.toast('Not sent: ' + (err && (err.message || (err.error && err.error.message)) || err), 'error');
    });
  });
}

function sourceDrawer(s, node) {
  var dr = ui.openDrawer(esc(sourceLabel(s, node)), '<span class="ts-mono">' + esc(s.sourceKey) + '</span>');
  var enabled = !(s.enabled === false || s.enabled === 'false');
  dr.body.appendChild(h('<div class="ts-field"><div class="ts-field-label"><span>Measurement interval</span></div>' +
    '<div class="ts-ctl"><span><input class="ts-input num" type="number" min="1" step="1"> s</span> ' +
    '<button type="button" class="ts-btn" data-a="interval">Set interval</button></div>' +
    '<div class="ts-field-hint"></div></div>'));
  var input = dr.body.querySelector('input');
  input.value = s.interval || '';
  dr.body.querySelector('.ts-field-hint').textContent = s.interval ? 'The device reports ' + s.interval + ' s.' : 'The device has not reported this interval.';
  dr.body.appendChild(h('<div class="ts-field"><div class="ts-field-label"><span>Subscription</span></div><div class="ts-ctl">' +
    '<button type="button" class="ts-btn" data-a="toggle"></button> <button type="button" class="ts-btn" data-a="remove">Remove subscription</button></div></div>'));
  dr.body.querySelector('[data-a=toggle]').textContent = enabled ? 'Disable' : 'Enable';
  dr.body.addEventListener('click', function (e) {
    var a = e.target.closest('[data-a]');
    if (!a) { return; }
    var t = sourceTarget(s);
    if (a.dataset.a === 'interval') {
      var v = Number(input.value);
      if (!(v >= 1 && v <= 65535 && Math.floor(v) === v)) { ui.toast('An interval is a whole number of seconds, 1 to 65535', 'error'); return; }
      send([{ op: 'SET_INTERVAL', target: t, interval_s: v }]);
    } else if (a.dataset.a === 'toggle') {
      send([{ op: 'SET_ENABLED', target: t, enabled: !enabled }]);
    } else if (a.dataset.a === 'remove') {
      send([{ op: 'DELETE_SUBSCRIPTION', target: t }]);
    }
  });
}

/** Catalog measures of a position that the device neither subscribes nor reports. */
function unsubscribed(pos, node, own) {
  var p = node && state.peripherals[node.type];
  if (!p) { return []; }
  var have = {};
  own.forEach(function (s) { have[s.sourceKey] = true; });
  var count = {};
  (p.measures || []).forEach(function (m) { count[m.kind] = (count[m.kind] || 0) + 1; });
  return (p.measures || []).map(function (m) {
    var indexed = count[m.kind] > 1;
    var key = 'p' + pos + '.' + camel(m.kind) + (m.group ? '.g' + m.group : '') + (indexed ? '.i' + m.index : '');
    var target = { mode: 'SOURCE', position: pos, kind: m.kind };
    if (m.group) { target.group = m.group; }
    if (indexed) { target.index = m.index; }
    return { sourceKey: key, measure: m, target: target };
  }).filter(function (c) { return !have[c.sourceKey]; });
}

function addDrawer(pos, node, own) {
  var dr = ui.openDrawer('Add a subscription', 'Position ' + pos + ' · ' + esc(node.type));
  var options = unsubscribed(pos, node, own);
  dr.body.appendChild(h('<div class="ts-field"><div class="ts-field-label"><span>Interval</span></div>' +
    '<div class="ts-ctl"><span><input class="ts-input num" type="number" min="1" step="1" value="900"> s</span></div></div>'));
  var input = dr.body.querySelector('input');
  options.forEach(function (o) {
    var entry = state.names[o.measure.defaultName] || {};
    var row = h('<div class="ts-tsrc"><div><div class="ts-row-label"></div><div class="ts-mono"></div></div><span></span>' +
      '<div class="ts-tsrc-value"><button type="button" class="ts-btn">Subscribe</button></div></div>');
    row.querySelector('.ts-row-label').textContent = entry.label || o.measure.defaultName;
    row.querySelector('.ts-mono').textContent = o.sourceKey;
    row.querySelector('button').addEventListener('click', function () {
      var v = Number(input.value);
      if (!(v >= 1 && v <= 65535 && Math.floor(v) === v)) { ui.toast('An interval is a whole number of seconds, 1 to 65535', 'error'); return; }
      send([{ op: 'CREATE_SUBSCRIPTION', target: o.target, interval_s: v }]);
    });
    dr.body.appendChild(row);
  });
}

function commandsSection() {
  var list = pending();
  var last = parseValue(state.server['cmd.lastResult']);
  if (!state.writable && !list.length && !last) { return null; }
  var sec = h('<div class="ts-section"><div class="ts-section-head">Commands ' + info('commands') + '</div></div>');
  if (state.writable) {
    var bar = h('<div class="ts-cmdbar"><button type="button" class="ts-btn" data-a="reports">Request reports</button>' +
      '<button type="button" class="ts-btn" data-a="diag">Self-diagnostic</button></div>');
    bar.addEventListener('click', function (e) {
      var a = e.target.closest('[data-a]');
      if (!a) { return; }
      send([a.dataset.a === 'reports'
        ? { op: 'REQUEST_REPORT', target: { mode: 'GLOBAL' }, reports: ['topology', 'subscriptions', 'status', 'device_info'] }
        : { op: 'SELF_DIAG', target: { mode: 'GLOBAL' } }]);
    });
    sec.appendChild(bar);
  }
  list.forEach(function (p) {
    var row = h('<div class="ts-cmd" data-cmd="' + (p.unanswered ? 'unanswered' : 'queued') + '"><div class="ts-grow"><div class="ts-row-label"></div><div class="ts-row-meta"></div></div></div>');
    row.querySelector('.ts-row-label').textContent = p.commands.map(commandText).join(' · ');
    row.querySelector('.ts-row-meta').textContent = (p.unanswered ? 'No answer, sent ' : 'Queued, sent ') + ago(p.issuedAt);
    row.insertBefore(h('<span class="ts-chip ' + (p.unanswered ? 'fault">No answer' : 'warn">Queued') + '</span>'), row.firstChild);
    if (p.unanswered && state.writable) {
      var retry = h('<button type="button" class="ts-btn">Retry</button>');
      retry.addEventListener('click', function () { send(p.commands, p.key); });
      row.appendChild(retry);
    }
    sec.appendChild(row);
  });
  if (last) {
    var row = h('<div class="ts-cmd" data-cmd="' + (last.ok ? 'delivered' : 'failed') + '"><span class="ts-chip ' + (last.ok ? 'ok">Delivered' : 'fault">Failed') + '</span>' +
      '<div class="ts-grow"><div class="ts-row-label"></div><div class="ts-row-meta"></div></div></div>');
    row.querySelector('.ts-row-label').textContent = (last.commands || []).map(commandText).join(' · ') || 'Command #' + last.seq;
    row.querySelector('.ts-row-meta').textContent = (last.results || []).map(resultText).join(' · ') + ' · answered ' + ago(last.ackedAt);
    sec.appendChild(row);
  }
  return sec;
}

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
    if (state.writable && node && unsubscribed(pos, node, own).length) {
      var add = h('<button type="button" class="ts-btn ts-add">' + ICON.plus + 'Add subscription</button>');
      add.addEventListener('click', function () { addDrawer(pos, node, own); });
      head.appendChild(add);
    }

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
  var cmds = commandsSection();
  if (cmds) { bodyEl.appendChild(cmds); }
  cardEl.classList.toggle('ts-readonly', !state.writable);
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
  if (state.writable) {
    var act = h('<button type="button" class="ts-icon-btn ts-src-act" title="Change this subscription">' + ICON.edit + '</button>');
    act.addEventListener('click', function () { sourceDrawer(s, node); });
    stateEl.appendChild(act);
  }
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
  return Promise.all([loadDefaults(), loadDevice(ds.entityId), tb.currentUser()]).then(function (got) {
    state.me = got[2];
    return tb.canWrite(deviceEntity());
  }).then(function (writable) {
    state.writable = writable;
    render();
    timer = setInterval(refresh, REFRESH_MS);
  });
}).catch(function (err) { fail('Could not load: ' + (err && err.message ? err.message : err)); });

};
