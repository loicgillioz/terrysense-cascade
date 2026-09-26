/*
 * DRYC — the relay controller of a LOGR2: its live inputs and relays, its rules,
 * and sending them to the device (CA-5). Bound to a STATION (its LOGR2) or to
 * the LOGR2 DEVICE itself. Model: logr-product-docs/cloud/DRYC.md.
 *
 * Rules live in `dryc.rules` (SHARED_SCOPE) on the DEVICE. Saving also gives
 * each notifying rule its station channel `drycRule-<n>`, mapped to
 * `drycRule.<id>` with a boolean alarm at the rule's severity; `dryc_rules`
 * fills that value on every DRYC status. Send writes one `cmd.request`
 * DRYC_RULES, which `dl_dispatch` sends through the LOGR2 integration.
 *
 * Loads after shared/resolver.js, glossary.js, ui.js and tb_io.js.
 */

window.TerrySenseDryc = function (ctx, container) {

var resolver = window.TerrySenseResolver;
var G = window.TerrySenseGlossary;
var tb = window.TerrySenseTbIo(ctx);
var root = container.querySelector('.ts-root') || container;
var ui = window.TerrySenseUi(root);
var h = ui.h, esc = ui.esc, ICON = ui.ICON, info = ui.info;

var INPUTS = 8, RELAYS = 2, MAX_RECORDS = 16, DAY_MS = 86400000;
var RULE_CHANNEL = 'drycRule';
var SEVERITY_IDS = ['critical', 'major', 'minor', 'warning', 'indeterminate'];
var LIVE_KEYS = [];
for (var k = 1; k <= INPUTS; k++) { LIVE_KEYS.push('drycInput' + k); }
LIVE_KEYS = LIVE_KEYS.concat(['drycOutput1', 'drycOutput2', 'drycVoltage', 'drycRuleCount', 'drycRulesSynced']);

function parseJson(raw) {
  if (raw === undefined || raw === null || raw === '') { return null; }
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
function truthy(v) { return v === true || v === 1 || v === '1' || v === 'true'; }
function clone(o) { return JSON.parse(JSON.stringify(o)); }

// -- model ------------------------------------------------------------------------------

var state = {
  device: null, station: null, rules: null, saved: '', live: {}, server: {},
  writeDevice: false, writeStation: false, me: null, error: null
};

function emptySet() {
  var inputs = [], relays = [];
  for (var i = 0; i < INPUTS; i++) { inputs.push({ label: '', whenOn: '', whenOff: '' }); }
  for (var j = 0; j < RELAYS; j++) { relays.push({ label: '' }); }
  return { rules: [], inputs: inputs, relays: relays };
}

function normalise(set) {
  var out = emptySet();
  if (!set) { return out; }
  out.rules = (set.rules || []).map(function (r) {
    return { id: r.id, name: r.name || '', condition: { mask: (r.condition || {}).mask & 0xFF, state: (r.condition || {}).state & 0xFF },
             relays: { relay1: !!(r.relays || {}).relay1, relay2: !!(r.relays || {}).relay2 },
             notify: r.notify ? { severity: r.notify.severity || 'major' } : null };
  });
  (set.inputs || []).slice(0, INPUTS).forEach(function (x, i) { out.inputs[i] = { label: x.label || '', whenOn: x.whenOn || '', whenOff: x.whenOff || '' }; });
  (set.relays || []).slice(0, RELAYS).forEach(function (x, i) { out.relays[i] = { label: x.label || '' }; });
  return out;
}

function inputLabel(i) { return state.rules.inputs[i].label || 'Input ' + (i + 1); }
function inputText(i, on) { var x = state.rules.inputs[i]; return on ? (x.whenOn || 'On') : (x.whenOff || 'Off'); }
function relayLabel(i) { return state.rules.relays[i].label || 'Relay ' + (i + 1); }

/** The device's records, in rule order: a wake record per notifying rule, one per relay (DRYC.md §2). */
function records(set) {
  var out = [];
  set.rules.forEach(function (r) {
    var mask = r.condition.mask & 0xFF, st = r.condition.state & mask;
    if (r.notify) { out.push([0, st, mask]); }
    if (r.relays.relay1) { out.push([1, st, mask]); }
    if (r.relays.relay2) { out.push([2, st, mask]); }
  });
  return out;
}

function nextId(set) {
  var n = 0;
  set.rules.forEach(function (r) { var m = /^r(\d+)$/.exec(r.id || ''); if (m) { n = Math.max(n, Number(m[1])); } });
  return 'r' + (n + 1);
}

/** Where the device stands against the saved rules. */
function syncState() {
  var want = JSON.stringify(records(normalise(parseJson(state.saved))));
  var pendingKeys = Object.keys(state.server).filter(function (key) { return /^cmd\.seq\.\d+$/.test(key); });
  var pending = pendingKeys.map(function (key) { return parseJson(state.server[key]) || {}; }).filter(function (m) {
    return (m.commands || [])[0] && m.commands[0].op === 'DRYC_RULES';
  }).sort(function (a, b) { return (b.issuedAt || 0) - (a.issuedAt || 0); })[0];
  var last = parseJson(state.server['cmd.lastResult']);
  var lastRules = last && (last.commands || [])[0] && last.commands[0].op === 'DRYC_RULES' ? last : null;
  var count = state.live.drycRuleCount ? Number(state.live.drycRuleCount.value) : null;
  var n = JSON.parse(want).length;
  if (pending) {
    if (Date.now() - (pending.issuedAt || 0) > DAY_MS) { return { s: 'drift', text: 'Sent ' + ago(pending.issuedAt) + ' and never confirmed. Send again.' }; }
    return { s: 'waiting', text: 'Sent ' + ago(pending.issuedAt) + '. Delivered after the logger’s next uplink.' };
  }
  if (lastRules && !lastRules.ok) { return { s: 'drift', text: 'The relay controller refused the last rules sent. Send again.' }; }
  if (lastRules && JSON.stringify(lastRules.commands[0].records) !== want) { return { s: 'changed', text: 'Rules changed since they were last sent. The relay controller still runs the previous ones.' }; }
  if (count !== null && count !== n) { return { s: 'drift', text: 'The relay controller reports ' + count + ' record' + (count === 1 ? '' : 's') + ', these rules need ' + n + '. Send them.' }; }
  if (lastRules) { return { s: 'insync', text: 'On the relay controller: these rules, confirmed ' + ago(lastRules.ackedAt) + '.' }; }
  return { s: 'insync', text: count === null ? 'No status from the relay controller yet.' : 'The relay controller holds ' + count + ' record' + (count === 1 ? '' : 's') + ', as these rules need.' };
}

// -- data -------------------------------------------------------------------------------

function devicesOf(stationId) {
  var query = {
    parameters: { rootId: stationId, rootType: 'ASSET', direction: 'FROM', relationTypeGroup: 'COMMON', maxLevel: 1, fetchLastLevelOnly: false },
    filters: [{ relationType: 'Contains', entityTypes: ['DEVICE'] }]
  };
  return tb.post('/api/relations', query).then(function (rels) { return (rels || []).map(function (r) { return r.to.id; }); });
}

function stationOf(deviceId) {
  var query = {
    parameters: { rootId: deviceId, rootType: 'DEVICE', direction: 'TO', relationTypeGroup: 'COMMON', maxLevel: 1, fetchLastLevelOnly: false },
    filters: [{ relationType: 'Contains', entityTypes: ['ASSET'] }]
  };
  return tb.post('/api/relations', query).then(function (rels) {
    var first = (rels || [])[0];
    return first ? tb.loadEntity({ entityType: 'ASSET', entityId: first.from.id }) : null;
  });
}

function findDevice(ds) {
  if (ds.entityType === 'DEVICE') {
    return Promise.all([tb.get('/api/device/' + ds.entityId), stationOf(ds.entityId)]);
  }
  return tb.loadEntity(ds).then(function (station) {
    return devicesOf(station.id).then(function (ids) {
      return Promise.all(ids.map(function (id) { return tb.get('/api/device/' + id); }));
    }).then(function (devices) {
      return [devices.filter(function (d) { return d.type === 'logr2'; })[0] || null, station];
    });
  });
}

function loadDevice() {
  var dev = deviceEntity();
  return Promise.all([
    tb.attrsMap(dev, 'SHARED_SCOPE'),
    tb.attrsMap(dev, 'SERVER_SCOPE'),
    tb.get('/api/plugins/telemetry/DEVICE/' + dev.id + '/values/timeseries', { keys: LIVE_KEYS.join(',') }).catch(function () { return {}; })
  ]).then(function (got) {
    state.saved = JSON.stringify(parseJson(got[0]['dryc.rules']) || null);
    state.rules = normalise(parseJson(got[0]['dryc.rules']));
    state.server = got[1];
    state.live = {};
    Object.keys(got[2] || {}).forEach(function (key) {
      var p = got[2][key] && got[2][key][0];
      if (p) { state.live[key] = { ts: Number(p.ts), value: p.value }; }
    });
  });
}

function deviceEntity() {
  return { entityType: 'DEVICE', id: state.device.id.id, ownerId: state.device.ownerId && state.device.ownerId.id };
}

// -- saving -----------------------------------------------------------------------------

/** The station side of the rules: a `drycRule-<n>` channel per notifying rule,
 * keeping the key a rule already has so its stored series stays continuous. */
function stationWrites(set, stationAttrs) {
  var map = parseJson(stationAttrs['config.channelMap']) || {};
  var channels = Object.assign({}, map.channels || {});
  var byRule = {};
  Object.keys(channels).forEach(function (key) {
    var m = /^drycRule\.(.+)$/.exec(channels[key]);
    if (m && resolver.splitChannelKey(key).name === RULE_CHANNEL) { byRule[m[1]] = key; }
  });
  var used = {};
  Object.keys(byRule).forEach(function (id) { used[byRule[id]] = true; });
  var write = {}, remove = [];
  var keep = {};
  set.rules.forEach(function (r) {
    if (!r.notify) { return; }
    var key = byRule[r.id];
    if (!key) {
      var n = 1;
      while (used[RULE_CHANNEL + '-' + n] || channels[RULE_CHANNEL + '-' + n]) { n++; }
      key = RULE_CHANNEL + '-' + n;
      used[key] = true;
    }
    keep[key] = true;
    channels[key] = 'drycRule.' + r.id;
    write['channel.' + key + '.label'] = r.name;
    SEVERITY_IDS.forEach(function (sev) {
      var attr = 'channel.' + key + '.alarm.' + sev + '.state';
      if (sev === r.notify.severity) { write[attr] = 'true'; } else if (attr in stationAttrs) { remove.push(attr); }
    });
  });
  Object.keys(byRule).forEach(function (id) {
    var key = byRule[id];
    if (keep[key]) { return; }
    delete channels[key];
    Object.keys(stationAttrs).forEach(function (a) { if (a.indexOf('channel.' + key + '.') === 0) { remove.push(a); } });
  });
  map.channels = channels;
  write['config.channelMap'] = map;
  return { write: write, remove: remove };
}

function save(set) {
  var body = clone(set);
  body.rules = body.rules.map(function (r) {
    var out = { id: r.id, name: r.name, condition: { mask: r.condition.mask, state: r.condition.state & r.condition.mask } };
    if (r.relays.relay1 || r.relays.relay2) { out.relays = r.relays; }
    if (r.notify) { out.notify = r.notify; }
    return out;
  });
  return tb.saveAttrs(deviceEntity(), { 'dryc.rules': body }, 'SHARED_SCOPE').then(function () {
    if (!state.station || !state.writeStation) { return; }
    return tb.attrsMap(state.station).then(function (attrs) {
      var w = stationWrites(set, attrs);
      return tb.saveAttrs(state.station, w.write).then(function () { return tb.deleteAttrs(state.station, w.remove); });
    }).then(function () { return tb.resolveStations([state.station]); });
  });
}

function sendRules() {
  var recs = records(state.rules);
  ui.confirm('Send ' + recs.length + ' record' + (recs.length === 1 ? '' : 's') + ' to the relay controller of <b>' +
    esc(state.device.label || state.device.name) + '</b>? They replace the rules it runs now, after the logger’s next uplink.', 'Send').then(function (ok) {
    if (!ok) { return; }
    var request = { commands: [{ op: 'DRYC_RULES', records: recs }], by: (state.me && state.me.email) || null, issuedAt: Date.now() };
    return tb.saveAttrs(deviceEntity(), { 'cmd.request': request }).then(function () {
      ui.toast('Sent: delivered after the next uplink');
      setTimeout(refresh, 1500);
    }).catch(function (err) { ui.toast('Not sent: ' + errText(err), 'error'); });
  });
}

function errText(err) { return (err && (err.message || (err.error && err.error.message))) || String(err); }

// -- skeleton ---------------------------------------------------------------------------

root.innerHTML = '';
var cardEl = h('<div class="ts-card"><div class="ts-head"><div class="ts-head-icon">' + ICON.settings + '</div><div class="ts-head-text">' +
  '<div class="ts-title"><span>Relay controller</span> ' + info('drycRules') + '</div><div class="ts-subtitle"></div></div><span class="ts-chip level" hidden></span></div>' +
  '<div class="ts-body"><div class="ts-loading">Loading…</div></div>' +
  '<div class="ts-foot" hidden><span class="ts-summary"></span><span class="ts-spacer"></span><button type="button" class="ts-btn">' + ICON.reset + 'Refresh</button></div></div>');
root.appendChild(cardEl);
var bodyEl = cardEl.querySelector('.ts-body');
var footEl = cardEl.querySelector('.ts-foot');
var summaryEl = cardEl.querySelector('.ts-summary');
footEl.querySelector('.ts-btn').addEventListener('click', function () { refresh(); });

function fail(text) {
  bodyEl.innerHTML = '';
  bodyEl.appendChild(h('<div class="ts-empty"></div>')).textContent = text;
}

// -- render -----------------------------------------------------------------------------

function render() {
  var d = state.device;
  cardEl.querySelector('.ts-subtitle').textContent = (d.label || d.name) + (state.station ? ' · ' + state.station.name : '');
  var chip = cardEl.querySelector('.ts-chip.level');
  chip.hidden = false;
  chip.textContent = 'LOGR2';
  cardEl.classList.toggle('ts-readonly', !state.writeDevice);
  footEl.hidden = false;
  bodyEl.innerHTML = '';

  var sync = syncState();
  var n = records(state.rules).length;
  var strip = h('<div class="ts-sync" data-s="' + sync.s + '"><span class="ts-grow"></span><span class="ts-cap"></span></div>');
  strip.firstChild.textContent = sync.text;
  strip.querySelector('.ts-cap').textContent = n + ' of ' + MAX_RECORDS + ' records';
  strip.querySelector('.ts-cap').insertAdjacentHTML('beforeend', ' ' + info('drycRecords'));
  if (state.writeDevice && sync.s !== 'waiting') {
    var needed = sync.s === 'changed' || sync.s === 'drift';
    var send = h('<button type="button" class="ts-btn' + (needed ? ' primary' : '') + '">Send to relay controller</button>');
    send.addEventListener('click', sendRules);
    strip.appendChild(send);
  }
  bodyEl.appendChild(strip);

  bodyEl.appendChild(livePanel());
  bodyEl.appendChild(rulesSection());
  if (state.writeDevice && !state.writeStation && state.station) {
    bodyEl.appendChild(h('<div class="ts-banner warn">' + ICON.info + '<span>You can change the rules but not the station, so saving does not update its alarms.</span></div>'));
  }
  if (!state.station) {
    bodyEl.appendChild(h('<div class="ts-banner warn">' + ICON.info + '<span>This device is on no station, so its rules raise no alarm and notify nobody.</span></div>'));
  }
  var last = state.live.drycInput1;
  summaryEl.textContent = 'Status ' + (last ? ago(last.ts) : 'never received');
}

function livePanel() {
  var sec = h('<div class="ts-section"><div class="ts-section-head">Inputs and relays</div><div class="ts-live"></div><div class="ts-live ts-outs"></div></div>');
  var grid = sec.querySelector('.ts-live'), outs = sec.querySelector('.ts-outs');
  for (var i = 0; i < INPUTS; i++) {
    var v = state.live['drycInput' + (i + 1)];
    var on = v && truthy(v.value);
    var tile = h('<button type="button" class="ts-io' + (on ? ' on' : '') + (state.rules.inputs[i].label ? '' : ' unnamed') + '" data-input="' + (i + 1) + '">' +
      '<span class="ts-io-n">IN ' + (i + 1) + '</span><span class="ts-io-l"></span><span class="ts-io-v"><span class="ts-dot"></span><span></span></span></button>');
    tile.querySelector('.ts-io-l').textContent = inputLabel(i);
    tile.querySelector('.ts-io-v span:last-child').textContent = v ? inputText(i, on) : '—';
    tile.disabled = !state.writeDevice;
    tile.addEventListener('click', namesDrawer.bind(null, 'input', i));
    grid.appendChild(tile);
  }
  for (var j = 0; j < RELAYS; j++) {
    var rv = state.live['drycOutput' + (j + 1)];
    var ron = rv && truthy(rv.value);
    var rt = h('<button type="button" class="ts-io relay' + (ron ? ' on' : '') + '" data-relay="' + (j + 1) + '"><span class="ts-io-n">REL ' + (j + 1) + '</span>' +
      '<span class="ts-io-l"></span><span class="ts-io-v"><span class="ts-dot"></span><span></span></span></button>');
    rt.querySelector('.ts-io-l').textContent = relayLabel(j);
    rt.querySelector('.ts-io-v span:last-child').textContent = rv ? (ron ? 'On' : 'Off') : '—';
    rt.disabled = !state.writeDevice;
    rt.addEventListener('click', namesDrawer.bind(null, 'relay', j));
    outs.appendChild(rt);
  }
  var volt = state.live.drycVoltage;
  var vt = h('<div class="ts-io"><span class="ts-io-n">AN 1</span><span class="ts-io-l">Supply voltage</span><span class="ts-io-v"></span></div>');
  vt.querySelector('.ts-io-v').textContent = volt ? Number(volt.value).toFixed(1) + ' V' : '—';
  outs.appendChild(vt);
  return sec;
}

function conditionChips(r) {
  var chips = [];
  for (var i = 0; i < INPUTS; i++) {
    if (!(r.condition.mask & (1 << i))) { continue; }
    var on = !!(r.condition.state & (1 << i));
    chips.push('<span class="ts-cond">' + esc(inputLabel(i)) + ' = <b>' + esc(inputText(i, on)) + '</b></span>');
  }
  return chips.join('') || '<span class="ts-cond">no input</span>';
}

function actionChips(r) {
  var chips = [];
  if (r.relays.relay1) { chips.push('<span class="ts-chip accent">' + esc(relayLabel(0)) + ' on</span>'); }
  if (r.relays.relay2) { chips.push('<span class="ts-chip accent">' + esc(relayLabel(1)) + ' on</span>'); }
  if (r.notify) {
    var sev = G.severity(r.notify.severity);
    chips.push('<span class="ts-chip"><span class="ts-sev" style="background:var(--sev-' + esc(sev.id) + ')"></span>Notify · ' + esc(sev.label) + '</span>');
  }
  return chips.join('');
}

function rulesSection() {
  var sec = h('<div class="ts-section"><div class="ts-section-head">Rules <span class="ts-spacer"></span></div></div>');
  if (state.writeDevice) {
    var add = h('<button type="button" class="ts-btn">' + ICON.plus + 'Add rule</button>');
    add.disabled = records(state.rules).length >= MAX_RECORDS;
    add.addEventListener('click', function () { ruleDrawer(null); });
    sec.firstChild.appendChild(add);
  }
  if (!state.rules.rules.length) {
    sec.appendChild(h('<div class="ts-empty">No rule yet.</div>'));
  }
  state.rules.rules.forEach(function (r, idx) {
    var row = h('<div class="ts-rule" data-rule="' + esc(r.id) + '"><span class="ts-prec">' + (idx + 1) + '</span><div class="ts-grow">' +
      '<div class="ts-row-label"></div><div class="ts-line"><span class="ts-k">When</span>' + conditionChips(r) + '</div>' +
      '<div class="ts-line"><span class="ts-k">Then</span>' + actionChips(r) + '</div></div><div class="ts-rule-acts"></div></div>');
    row.querySelector('.ts-row-label').textContent = r.name;
    if (state.writeDevice) {
      var acts = row.querySelector('.ts-rule-acts');
      [['up', '↑', 'Earlier'], ['down', '↓', 'Later'], ['edit', null, 'Edit'], ['del', null, 'Delete']].forEach(function (a) {
        var b = h('<button type="button" class="ts-icon-btn" data-a="' + a[0] + '" title="' + a[2] + '"></button>');
        if (a[0] === 'edit') { b.innerHTML = ICON.edit; } else if (a[0] === 'del') { b.innerHTML = ICON.close; } else { b.textContent = a[1]; }
        b.disabled = (a[0] === 'up' && idx === 0) || (a[0] === 'down' && idx === state.rules.rules.length - 1);
        acts.appendChild(b);
      });
      acts.addEventListener('click', function (e) {
        var b = e.target.closest('[data-a]');
        if (!b) { return; }
        var set = clone(state.rules);
        if (b.dataset.a === 'edit') { ruleDrawer(idx); return; }
        if (b.dataset.a === 'del') {
          ui.confirm('Delete the rule <b>' + esc(r.name) + '</b>? Its station alarm goes with it.', 'Delete').then(function (ok) {
            if (!ok) { return; }
            set.rules.splice(idx, 1);
            commit(set, 'Rule deleted');
          });
          return;
        }
        var to = b.dataset.a === 'up' ? idx - 1 : idx + 1;
        var moved = set.rules.splice(idx, 1)[0];
        set.rules.splice(to, 0, moved);
        commit(set, 'Order saved');
      });
    }
    sec.appendChild(row);
  });
  return sec;
}

function commit(set, message) {
  return save(set).then(function () {
    ui.toast(message);
    ui.closeDrawer();
    return refresh();
  }).catch(function (err) { ui.toast('Not saved: ' + errText(err), 'error'); });
}

function ruleDrawer(idx) {
  var creating = idx === null;
  var r = creating
    ? { id: nextId(state.rules), name: '', condition: { mask: 0, state: 0 }, relays: { relay1: false, relay2: false }, notify: { severity: 'major' } }
    : clone(state.rules.rules[idx]);
  var dr = ui.openDrawer(creating ? 'New rule' : 'Edit rule ' + (idx + 1), 'Saved here; Send puts the rules on the relay controller ' + info('drycSync'));
  var body = dr.body;
  body.appendChild(h('<div class="ts-field"><div class="ts-field-label"><span>Name</span></div><div class="ts-ctl"><input class="ts-input wide" data-f="name" maxlength="60"></div></div>'));
  var nameIn = body.querySelector('[data-f=name]');
  nameIn.value = r.name;
  var cond = h('<div class="ts-field"><div class="ts-field-label"><span>When all of these hold</span></div><div class="ts-conds"></div>' +
    '<div class="ts-field-hint">Every input set to On or Off must hold. The relay controller evaluates the rule itself.</div></div>');
  var list = cond.querySelector('.ts-conds');
  for (var i = 0; i < INPUTS; i++) {
    var cur = (r.condition.mask & (1 << i)) ? ((r.condition.state & (1 << i)) ? 'on' : 'off') : 'any';
    var row = h('<div class="ts-condrow"><span class="ts-io-n">IN ' + (i + 1) + '</span><span class="ts-grow"></span><div class="ts-seg" data-input="' + i + '"></div></div>');
    row.querySelector('.ts-grow').textContent = inputLabel(i);
    var seg = row.querySelector('.ts-seg');
    [['any', 'Any'], ['on', inputText(i, true)], ['off', inputText(i, false)]].forEach(function (o) {
      var b = h('<button type="button"></button>');
      b.dataset.v = o[0];
      b.textContent = o[1];
      b.setAttribute('aria-pressed', String(o[0] === cur));
      seg.appendChild(b);
    });
    list.appendChild(row);
  }
  list.addEventListener('click', function (e) {
    var b = e.target.closest('.ts-seg button');
    if (!b) { return; }
    b.parentNode.querySelectorAll('button').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
    count();
  });
  body.appendChild(cond);
  var acts = h('<div class="ts-field"><div class="ts-field-label"><span>Then</span></div>' +
    '<label class="ts-switch"><input type="checkbox" data-f="relay1"> <span></span></label>' +
    '<label class="ts-switch"><input type="checkbox" data-f="relay2"> <span></span></label>' +
    '<label class="ts-switch"><input type="checkbox" data-f="notify"> <span>Notify, through the station’s alarm contacts</span></label>' +
    '<div class="ts-ctl"><select class="ts-select" data-f="severity"></select></div></div>');
  acts.querySelectorAll('.ts-switch span')[0].textContent = 'Switch ' + relayLabel(0) + ' on';
  acts.querySelectorAll('.ts-switch span')[1].textContent = 'Switch ' + relayLabel(1) + ' on';
  var sevSel = acts.querySelector('[data-f=severity]');
  G.SEVERITIES.slice().reverse().forEach(function (s) {
    var o = document.createElement('option'); o.value = s.id; o.textContent = s.label; sevSel.appendChild(o);
  });
  acts.querySelector('[data-f=relay1]').checked = r.relays.relay1;
  acts.querySelector('[data-f=relay2]').checked = r.relays.relay2;
  acts.querySelector('[data-f=notify]').checked = !!r.notify;
  sevSel.value = r.notify ? r.notify.severity : 'major';
  sevSel.disabled = !r.notify;
  acts.addEventListener('change', function () { sevSel.disabled = !acts.querySelector('[data-f=notify]').checked; count(); });
  body.appendChild(acts);
  var countEl = h('<div class="ts-field-hint ts-reccount"></div>');
  body.appendChild(countEl);

  function read() {
    var out = clone(r);
    out.name = nameIn.value.trim();
    out.condition = { mask: 0, state: 0 };
    list.querySelectorAll('.ts-seg').forEach(function (seg) {
      var i = Number(seg.dataset.input);
      var v = seg.querySelector('[aria-pressed=true]').dataset.v;
      if (v !== 'any') { out.condition.mask |= 1 << i; }
      if (v === 'on') { out.condition.state |= 1 << i; }
    });
    out.relays = { relay1: acts.querySelector('[data-f=relay1]').checked, relay2: acts.querySelector('[data-f=relay2]').checked };
    out.notify = acts.querySelector('[data-f=notify]').checked ? { severity: sevSel.value } : null;
    return out;
  }
  function draftSet() {
    var set = clone(state.rules);
    if (creating) { set.rules.push(read()); } else { set.rules[idx] = read(); }
    return set;
  }
  function count() {
    var nrec = records(draftSet()).length;
    countEl.textContent = 'Relay controller records: ' + nrec + ' of ' + MAX_RECORDS + '.';
    countEl.classList.toggle('ts-error', nrec > MAX_RECORDS);
  }
  count();
  var primary = ui.drawerActions(dr, creating ? 'Add rule' : 'Save');
  primary.addEventListener('click', function () {
    var x = read();
    var problem = !x.name ? 'Give the rule a name.'
      : !x.condition.mask ? 'Set at least one input to On or Off.'
      : !(x.relays.relay1 || x.relays.relay2 || x.notify) ? 'Pick at least one action.'
      : records(draftSet()).length > MAX_RECORDS ? 'That needs more than ' + MAX_RECORDS + ' records on the relay controller.'
      : null;
    if (problem) { ui.toast(problem, 'error'); return; }
    commit(draftSet(), creating ? 'Rule added' : 'Rule saved');
  });
}

function namesDrawer(kind, i) {
  var isInput = kind === 'input';
  var dr = ui.openDrawer((isInput ? 'Input ' : 'Relay ') + (i + 1), 'The name used in rules and on this panel');
  var cur = isInput ? state.rules.inputs[i] : state.rules.relays[i];
  dr.body.appendChild(h('<div class="ts-field"><div class="ts-field-label"><span>Name</span></div><div class="ts-ctl"><input class="ts-input wide" data-f="label" maxlength="40"></div></div>'));
  if (isInput) {
    dr.body.appendChild(h('<div class="ts-field"><div class="ts-field-label"><span>Wording when on</span></div><div class="ts-ctl"><input class="ts-input wide" data-f="whenOn" maxlength="30" placeholder="On"></div></div>'));
    dr.body.appendChild(h('<div class="ts-field"><div class="ts-field-label"><span>Wording when off</span></div><div class="ts-ctl"><input class="ts-input wide" data-f="whenOff" maxlength="30" placeholder="Off"></div></div>'));
  }
  dr.body.querySelectorAll('[data-f]').forEach(function (n) { n.value = cur[n.dataset.f] || ''; });
  ui.drawerActions(dr, 'Save').addEventListener('click', function () {
    var set = clone(state.rules);
    var target = isInput ? set.inputs[i] : set.relays[i];
    dr.body.querySelectorAll('[data-f]').forEach(function (n) { target[n.dataset.f] = n.value.trim(); });
    commit(set, 'Name saved');
  });
}

// -- load -------------------------------------------------------------------------------

function refresh() {
  if (!state.device) { return Promise.resolve(); }
  return loadDevice().then(render).catch(function (err) { ui.toast('Refresh failed: ' + errText(err), 'error'); });
}

tb.boundDatasource().then(function (ds) {
  if (!ds || (ds.entityType !== 'DEVICE' && ds.entityType !== 'ASSET')) { fail('No station or device bound.'); return; }
  return findDevice(ds).then(function (got) {
    state.device = got[0];
    state.station = got[1];
    if (!state.device) { fail('This station’s device has no relay controller.'); return; }
    return Promise.all([
      loadDevice(), tb.currentUser(), tb.canWrite(deviceEntity()),
      state.station ? tb.canWrite(state.station) : Promise.resolve(false)
    ]).then(function (all) {
      state.me = all[1];
      state.writeDevice = all[2];
      state.writeStation = all[3];
      render();
    });
  });
}).catch(function (err) { fail('Could not load: ' + errText(err)); });

};
