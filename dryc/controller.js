/*
 * DRYC — the dry contact interface of a station: the inputs wired on site and
 * the relays, the rules on them, and the rules sent to the device (CA-5).
 * Bound to a STATION; its device is the LOGR2 it contains. Model:
 * logr-product-docs/cloud/DRYC.md. View: logr-product-docs/cloud/FRONTEND.md
 * *Dry contact interface view*.
 *
 * Rules live in `dryc.rules` on the STATION, so a replaced device takes them
 * over; the device keeps only what was sent to it (`cmd.lastResult`,
 * `drycRuleCount`). Saving also gives each notifying rule its station channel
 * `drycRule-<n>`, mapped to `drycRule.<id>` with a boolean alarm at the rule's
 * severity, its value worded as the rule's condition unless the rule words it;
 * `station_project` fills that value on every DRYC status. The
 * labelled inputs, the outputs and the voltage go onto the station too, for
 * display and history. A device may feed several stations; when more than one
 * holds rules for its dry contact interface, the widget warns that the device
 * runs whichever set was sent last. Send writes one `cmd.request` DRYC_RULES,
 * which `dl_dispatch` sends through the LOGR2 integration. The view refreshes
 * itself when the device reports or answers.
 *
 * Loads after shared/resolver.js, glossary.js, ui.js and tb_io.js.
 */

window.TerrySenseDryc = function (ctx, container, opts) {

opts = opts || {};

var resolver = window.TerrySenseResolver;
var G = window.TerrySenseGlossary;
var tb = window.TerrySenseTbIo(ctx);
var root = container.querySelector('.ts-root') || container;
var ui = window.TerrySenseUi(root);
var h = ui.h, esc = ui.esc, ICON = ui.ICON, info = ui.info;

var INPUTS = 8, RELAYS = 2, MAX_RECORDS = 16, DAY_MS = 86400000;
// The firmware the rules checksum and supply-voltage conditions need (DRYC.md §5);
// an older logger or DRYC keeps today's behaviour and the view says what to update.
var LOGGER_FW_MIN = '0.44.0', DRYC_FW_MIN = '1.3.0';
var VOLT_OPS = { below: 1, above: 2 };
var POLL_MS = opts.pollMs || 15000;
var RULE_CHANNEL = 'drycRule';
var SEVERITY_IDS = ['critical', 'major', 'minor', 'warning', 'indeterminate'];
// The device stores them under the DRYC prefix (`dryc.drycInput1`); state.live drops it.
var LIVE_PREFIX = 'dryc.';
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
function plural(n, one) { return n + ' ' + one + (n === 1 ? '' : 's'); }

// -- model ------------------------------------------------------------------------------

var state = {
  station: null, device: null, others: [], rules: null, saved: '', live: {}, server: {}, client: {},
  writeDevice: false, writeStation: false, me: null
};

/** `v` at or past `min`, on major.minor.patch; a pre-release counts as its release. */
function versionAtLeast(v, min) {
  var a = String(v || '').split(/[-+]/)[0].split('.').map(Number), b = min.split('.').map(Number);
  if (a.length < 3 || a.some(isNaN)) { return false; }
  for (var i = 0; i < 3; i++) { if (a[i] !== b[i]) { return a[i] > b[i]; } }
  return true;
}

/** What the device's firmware can do with the rules: the logger and DRYC
 * versions it reports, and whether it checks the rules by checksum and runs
 * supply-voltage conditions. Both need the two minimum versions. */
function capability() {
  var logger = state.client['deviceInfo.fwVersion'] || null, dryc = state.client['deviceInfo.drycFwVersion'] || null;
  var loggerOk = versionAtLeast(logger, LOGGER_FW_MIN), drycOk = loggerOk && versionAtLeast(dryc, DRYC_FW_MIN);
  return { logger: logger, dryc: dryc, loggerOk: loggerOk, drycOk: drycOk, voltage: drycOk, crc: drycOk };
}

function hasVoltage(r) { return !!(r.condition && r.condition.voltage); }

/** Rules are edited on the station and sent from the device. */
function canEdit() { return state.writeStation; }
function canSend() { return !!state.device && state.writeDevice; }

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
    var c = r.condition || {}, v = c.voltage;
    var condition = { mask: c.mask & 0xFF, state: c.state & 0xFF };
    if (v && VOLT_OPS[v.op] && Number(v.volts) > 0) { condition.voltage = { op: v.op, volts: Number(v.volts) }; }
    return { id: r.id, name: r.name || '', condition: condition,
             relays: { relay1: !!(r.relays || {}).relay1, relay2: !!(r.relays || {}).relay2 },
             notify: r.notify ? { severity: r.notify.severity || 'major' } : null,
             whenActive: r.whenActive || '', whenInactive: r.whenInactive || '' };
  });
  (set.inputs || []).slice(0, INPUTS).forEach(function (x, i) { out.inputs[i] = { label: x.label || '', whenOn: x.whenOn || '', whenOff: x.whenOff || '' }; });
  (set.relays || []).slice(0, RELAYS).forEach(function (x, i) { out.relays[i] = { label: x.label || '' }; });
  return out;
}

function inputLabel(i) { return state.rules.inputs[i].label || 'Input ' + (i + 1); }
function inputText(i, on) { var x = state.rules.inputs[i]; return on ? (x.whenOn || 'On') : (x.whenOff || 'Off'); }
function relayLabel(i) { return state.rules.relays[i].label || 'Relay ' + (i + 1); }

/** The device's records, in rule order: a wake record per notifying rule, one per relay (DRYC.md §2);
 * a supply-voltage condition adds its operator and threshold in mV to each record. */
function records(set) {
  var out = [];
  set.rules.forEach(function (r) {
    var mask = r.condition.mask & 0xFF, st = r.condition.state & mask, v = r.condition.voltage;
    function rec(output) { return v ? [output, st, mask, VOLT_OPS[v.op], Math.round(v.volts * 1000)] : [output, st, mask]; }
    if (r.notify) { out.push(rec(0)); }
    if (r.relays.relay1) { out.push(rec(1)); }
    if (r.relays.relay2) { out.push(rec(2)); }
  });
  return out;
}

/** CRC-16/CCITT-FALSE of the records as the device hashes them (TRX_NANO.md §10.4). */
function recordsCrc(recs) {
  var bytes = [recs.length];
  recs.forEach(function (x) {
    bytes.push(x[0] | ((x[3] || 0) << 2), x[1], x[2]);
    if (x[3]) { bytes.push((x[4] >> 8) & 0xFF, x[4] & 0xFF); }
  });
  var crc = 0xFFFF;
  bytes.forEach(function (b) {
    crc ^= b << 8;
    for (var i = 0; i < 8; i++) { crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF; }
  });
  return crc;
}

function voltageText(v, inverse) {
  var below = (v.op === 'below') !== !!inverse;
  return 'Supply ' + (below ? (inverse ? '≤ ' : '< ') : (inverse ? '≥ ' : '> ')) + v.volts.toFixed(1) + ' V';
}

/** A rule's condition in the inputs' own wording, as its alarm reads it: "Pump = Fault, Float = High";
 * `inactive` words each input at its other state, as the cleared alarm reads it. */
function conditionText(set, r, inactive) {
  var parts = [];
  for (var i = 0; i < INPUTS; i++) {
    if (!(r.condition.mask & (1 << i))) { continue; }
    var x = set.inputs[i] || {}, on = !!(r.condition.state & (1 << i)) !== !!inactive;
    var label = (x.label || '').trim() || 'Input ' + (i + 1);
    var word = ((on ? x.whenOn : x.whenOff) || '').trim() || (on ? 'On' : 'Off');
    parts.push(label + ' = ' + word);
  }
  if (r.condition.voltage) { parts.push(voltageText(r.condition.voltage, inactive)); }
  return parts.join(', ');
}

function nextId(set) {
  var n = 0;
  set.rules.forEach(function (r) { var m = /^r(\d+)$/.exec(r.id || ''); if (m) { n = Math.max(n, Number(m[1])); } });
  return 'r' + (n + 1);
}

/** The input levels of the last status as a bitmask, null before any status. */
function levels() {
  var bits = 0, seen = false;
  for (var i = 0; i < INPUTS; i++) {
    var v = state.live['drycInput' + (i + 1)];
    if (v) { seen = true; if (truthy(v.value)) { bits |= 1 << i; } }
  }
  return seen ? bits : null;
}

/** Whether a rule matches the last status: true, false, or null with no status.
 * A voltage condition compares the last supply reading, without the device's hold time and hysteresis. */
function matching(r) {
  var lv = levels();
  if (lv === null) { return null; }
  var inputs = (lv & r.condition.mask) === (r.condition.state & r.condition.mask), v = r.condition.voltage;
  if (!v) { return inputs; }
  if (!state.live.drycVoltage) { return null; }
  var supply = Number(state.live.drycVoltage.value);
  return inputs && (v.op === 'below' ? supply < v.volts : supply > v.volts);
}

/** Where the device stands against the saved rules: `s` is the state, `short`
 * the header chip, `text` the sentence, `sent` and `confirmed` the steps' times. */
function syncState() {
  var want = JSON.stringify(records(normalise(parseJson(state.saved))));
  var n = JSON.parse(want).length;
  if (!state.device) { return { s: 'nodevice', short: 'No device', text: 'No dry contact interface feeds this station. The rules are kept here and sent once one is connected.' }; }
  var queued = parseJson(state.server['cmd.pending']);
  var pending = queued && (queued.commands || []).some(function (c) { return c.op === 'DRYC_RULES'; })
    ? { issuedAt: queued.updatedAt || queued.issuedAt } : null;
  var last = parseJson(state.server['cmd.lastResult']);
  var lastRules = last && (last.commands || [])[0] && last.commands[0].op === 'DRYC_RULES' ? last : null;
  var count = state.live.drycRuleCount ? Number(state.live.drycRuleCount.value) : null;
  if (pending) {
    if (Date.now() - (pending.issuedAt || 0) > DAY_MS) {
      return { s: 'drift', short: 'Not confirmed', sent: pending.issuedAt, text: 'Sent ' + ago(pending.issuedAt) + ' and never confirmed. Send again.' };
    }
    return { s: 'waiting', short: 'Waiting for the device', sent: pending.issuedAt, text: 'Sent ' + ago(pending.issuedAt) + '. The device takes them at its next uplink.' };
  }
  if (lastRules && !lastRules.ok) {
    return { s: 'drift', short: 'Refused', sent: lastRules.issuedAt, text: 'The device refused the last rules sent. Send again.' };
  }
  if (lastRules && JSON.stringify(lastRules.commands[0].records) !== want) {
    return { s: 'changed', short: 'Send needed', sent: lastRules.issuedAt, confirmed: lastRules.ackedAt,
             text: 'The rules changed since they were sent. The device still runs the previous ones.' };
  }
  // With the checksum the device's own rules are compared; without it, only their number.
  var cap = capability(), crc = state.client['status.drycRulesCrc16'];
  if (cap.crc && crc !== undefined && Number(crc) !== recordsCrc(JSON.parse(want))) {
    return { s: 'drift', short: 'Send needed', text: 'The device holds other rules than these. Send them.' };
  }
  if (count !== null && count !== n) {
    return { s: 'drift', short: 'Send needed', text: 'The device holds ' + plural(count, 'record') + ', these rules need ' + n + '. Send them.' };
  }
  if (lastRules) {
    return { s: 'insync', short: 'On the device', sent: lastRules.issuedAt, confirmed: lastRules.ackedAt, text: 'The device runs these rules.' };
  }
  return count === null
    ? { s: 'insync', short: 'No status yet', text: 'No status from the device yet.' }
    : { s: 'insync', short: 'On the device', confirmed: state.live.drycRuleCount.ts, text: 'The device holds ' + plural(count, 'record') + ', as these rules need.' };
}

// -- data -------------------------------------------------------------------------------

function devicesOf(stationId) {
  var query = {
    parameters: { rootId: stationId, rootType: 'ASSET', direction: 'FROM', relationTypeGroup: 'COMMON', maxLevel: 1, fetchLastLevelOnly: false },
    filters: [{ relationType: 'Contains', entityTypes: ['DEVICE'] }]
  };
  return tb.post('/api/relations', query).then(function (rels) { return (rels || []).map(function (r) { return r.to.id; }); });
}

/** Every Station that contains the device. */
function stationsOf(deviceId) {
  var query = {
    parameters: { rootId: deviceId, rootType: 'DEVICE', direction: 'TO', relationTypeGroup: 'COMMON', maxLevel: 1, fetchLastLevelOnly: false },
    filters: [{ relationType: 'Contains', entityTypes: ['ASSET'] }]
  };
  return tb.post('/api/relations', query).then(function (rels) {
    return Promise.all((rels || []).map(function (r) { return tb.getAsset(r.from.id); }));
  }).then(function (assets) {
    return assets.filter(function (a) { return a && a.type === 'Station'; }).map(function (a) { return tb.assetLevel(a); });
  });
}

/** The station's LOGR2, else null. */
function findDevice(station) {
  return devicesOf(station.id).then(function (ids) {
    return Promise.all(ids.map(function (id) { return tb.get('/api/device/' + id); }));
  }).then(function (devices) { return devices.filter(function (d) { return d.type === 'logr2'; })[0] || null; });
}

/** The station's rules, and its device's state and the other stations holding rules for it. */
function load() {
  var dev = state.device && deviceEntity();
  return Promise.all([
    tb.attrsMap(state.station),
    dev ? stationsOf(dev.id).then(function (list) {
      return Promise.all(list.filter(function (st) { return st.id !== state.station.id; }).map(function (st) {
        return tb.attrsMap(st).then(function (a) { return parseJson(a['dryc.rules']) ? st : null; });
      }));
    }) : [],
    dev ? tb.attrsMap(dev, 'SERVER_SCOPE') : {},
    dev ? tb.get('/api/plugins/telemetry/DEVICE/' + dev.id + '/values/timeseries', { keys: LIVE_KEYS.map(function (key) { return LIVE_PREFIX + key; }).join(',') })
      .catch(function () { return {}; }) : {},
    dev ? tb.attrsMap(dev, 'CLIENT_SCOPE').catch(function () { return {}; }) : {}
  ]).then(function (got) {
    state.client = got[4] || {};
    var raw = parseJson(got[0]['dryc.rules']);
    state.saved = JSON.stringify(raw || null);
    state.rules = normalise(raw);
    state.others = got[1].filter(Boolean).sort(function (a, b) { return a.name.localeCompare(b.name); });
    state.server = got[2] || {};
    state.live = {};
    Object.keys(got[3] || {}).forEach(function (key) {
      var p = got[3][key] && got[3][key][0];
      if (p && p.value !== null && p.value !== undefined) { state.live[key.slice(LIVE_PREFIX.length)] = { ts: Number(p.ts), value: p.value }; }
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
  // The dry contact interface's own channels, as {channel: sourceKey}; another
  // device's channels on the same station stay as they are (CHANNEL_MAP.md §1).
  var me = state.device ? state.device.id.id : null;
  var entries = resolver.mapEntries(stationAttrs['config.channelMap']);
  var channels = {}, others = {};
  Object.keys(entries).forEach(function (c) {
    var mine = !entries[c].device || entries[c].device === me || /^(dryc|drycRule)\./.test(entries[c].key);
    if (mine) { channels[c] = entries[c].key; } else { others[c] = entries[c]; }
  });
  var byRule = {};
  Object.keys(channels).forEach(function (key) {
    var m = /^drycRule\.(.+)$/.exec(channels[key]);
    if (m && resolver.splitChannelKey(key).name === RULE_CHANNEL) { byRule[m[1]] = key; }
  });
  var used = {};
  Object.keys(byRule).forEach(function (id) { used[byRule[id]] = true; });
  Object.keys(others).forEach(function (c) { used[c] = true; });
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
    write['channel.' + key + '.textWhenTrue'] = r.whenActive || conditionText(set, r);
    write['channel.' + key + '.textWhenFalse'] = r.whenInactive || conditionText(set, r, true);
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
  readingChannels(set, channels, stationAttrs, write, remove);
  var next = Object.assign({}, others);
  // With no device yet the entries name none; connecting one fills it in.
  Object.keys(channels).forEach(function (c) { next[c] = me ? { device: me, key: channels[c] } : channels[c]; });
  write['config.channelMap'] = resolver.buildMap(next);
  return { write: write, remove: remove };
}

/** The DRYC's readings on the station (DRYC.md §3): each labelled input, both
 * outputs and the supply voltage, each named after its input or relay. */
function readingChannels(set, channels, stationAttrs, write, remove) {
  function named(key, target, label) {
    channels[key] = target;
    if (label) { write['channel.' + key + '.label'] = label; } else if (('channel.' + key + '.label') in stationAttrs) { remove.push('channel.' + key + '.label'); }
  }
  for (var i = 1; i <= INPUTS; i++) {
    var key = 'drycInput' + i, label = ((set.inputs || [])[i - 1] || {}).label;
    if (label) { named(key, LIVE_PREFIX + key, label); } else if (channels[key] === LIVE_PREFIX + key) {
      delete channels[key];
      if (('channel.' + key + '.label') in stationAttrs) { remove.push('channel.' + key + '.label'); }
    }
  }
  for (var r = 1; r <= RELAYS; r++) { named('drycOutput' + r, LIVE_PREFIX + 'drycOutput' + r, ((set.relays || [])[r - 1] || {}).label); }
  channels.drycVoltage = LIVE_PREFIX + 'drycVoltage';
}

function save(set) {
  var body = clone(set);
  body.rules = body.rules.map(function (r) {
    var out = { id: r.id, name: r.name, condition: { mask: r.condition.mask, state: r.condition.state & r.condition.mask } };
    if (r.condition.voltage) { out.condition.voltage = r.condition.voltage; }
    if (r.relays.relay1 || r.relays.relay2) { out.relays = r.relays; }
    if (r.notify) { out.notify = r.notify; }
    if (r.whenActive) { out.whenActive = r.whenActive; }
    if (r.whenInactive) { out.whenInactive = r.whenInactive; }
    return out;
  });
  return tb.attrsMap(state.station).then(function (attrs) {
    var w = stationWrites(set, attrs);
    w.write['dryc.rules'] = body;
    return tb.saveAttrs(state.station, w.write).then(function () { return tb.deleteAttrs(state.station, w.remove); });
  }).then(function () { return tb.resolveStations([state.station]); });
}

function sendRules() {
  if (!capability().voltage && state.rules.rules.some(hasVoltage)) { return; }
  var recs = records(state.rules);
  ui.confirm('Send ' + plural(recs.length, 'record') + ' to the dry contact interface of <b>' +
    esc(state.device.label || state.device.name) + '</b>? They replace the rules it runs now, after the logger’s next uplink.', 'Send').then(function (ok) {
    if (!ok) { return; }
    var request = { commands: [{ op: 'DRYC_RULES', records: recs }], by: (state.me && state.me.email) || null, issuedAt: Date.now() };
    return tb.saveAttrs(deviceEntity(), { 'cmd.request': request }).then(function () {
      ui.toast('Sent: the device takes them at its next uplink');
      setTimeout(refresh, 1500);
    }).catch(function (err) { ui.toast('Not sent: ' + errText(err), 'error'); });
  });
}

function errText(err) { return (err && (err.message || (err.error && err.error.message))) || String(err); }

// -- skeleton ---------------------------------------------------------------------------

root.innerHTML = '';
var cardEl = h('<div class="ts-card ts-dryc"><div class="ts-head"><div class="ts-head-icon">' + ICON.settings + '</div><div class="ts-head-text">' +
  '<div class="ts-title"><span>Dry contact interface</span> ' + info('drycRules') + '</div><div class="ts-subtitle"></div></div>' +
  '<span class="ts-dryc-state" hidden></span></div>' +
  '<div class="ts-body"><div class="ts-loading">Loading…</div></div>' +
  '<div class="ts-foot" hidden><span class="ts-summary"></span><span class="ts-spacer"></span><button type="button" class="ts-btn">' + ICON.reset + 'Refresh</button></div></div>');
root.appendChild(cardEl);
window.TerrySenseNav(ctx, tb, ui, cardEl, opts);
var bodyEl = cardEl.querySelector('.ts-body');
var footEl = cardEl.querySelector('.ts-foot');
var summaryEl = cardEl.querySelector('.ts-summary');
footEl.querySelector('.ts-btn').addEventListener('click', function () { refresh(); });

function fail(text) {
  bodyEl.innerHTML = '';
  bodyEl.appendChild(h('<div class="ts-empty"></div>')).textContent = text;
}

// -- render -----------------------------------------------------------------------------

/** A numbered step: its head, a one-line hint and its body. */
function step(n, title, hint) {
  var sec = h('<div class="ts-section ts-dryc-step"><div class="ts-section-head"><span class="ts-dryc-n"></span><span class="ts-dryc-t"></span>' +
    '<span class="ts-spacer"></span></div><div class="ts-field-hint ts-dryc-hint"></div></div>');
  sec.dataset.step = n;
  sec.querySelector('.ts-dryc-n').textContent = n;
  sec.querySelector('.ts-dryc-t').textContent = title;
  sec.querySelector('.ts-dryc-hint').textContent = hint;
  return sec;
}

function render() {
  var d = state.device;
  cardEl.querySelector('.ts-subtitle').textContent = state.station.name + (d ? ' · ' + (d.label || d.name) : '');
  cardEl.classList.toggle('ts-readonly', !canEdit());
  var sync = syncState();
  var chip = cardEl.querySelector('.ts-dryc-state');
  chip.hidden = false;
  chip.dataset.s = sync.s;
  chip.textContent = sync.short;
  footEl.hidden = false;
  bodyEl.innerHTML = '';

  bodyEl.appendChild(h('<div class="ts-dryc-intro">The device switches its relays itself, from the rules it was sent. ' +
    'Rules are kept on this station: name the inputs wired on site, write the rules, then send them to the device.</div>'));
  if (state.others.length) {
    var warn = h('<div class="ts-banner warn" data-warn="competing">' + ICON.info + '<span></span></div>');
    warn.querySelector('span').innerHTML = 'Rules for this dry contact interface are also kept on <b>' +
      state.others.map(function (o) { return esc(o.name); }).join('</b>, <b>') +
      '</b>. The device runs whichever set was sent last: keep them on one station.';
    bodyEl.appendChild(warn);
  }
  firmwareBanners().forEach(function (b) { bodyEl.appendChild(b); });
  bodyEl.appendChild(wiringStep());
  bodyEl.appendChild(rulesStep());
  bodyEl.appendChild(deviceStep(sync));
  var last = state.live.drycInput1;
  summaryEl.textContent = d ? 'Last status ' + (last ? ago(last.ts) : 'never received') : 'No device';
}

/** What the device's firmware keeps from the rules, and what to update to get it. */
function firmwareBanners() {
  if (!state.device) { return []; }
  var cap = capability(), out = [];
  function banner(kind, key, html) {
    var b = h('<div class="ts-banner ' + kind + '" data-warn="' + key + '">' + ICON.info + '<span></span></div>');
    b.querySelector('span').innerHTML = html;
    out.push(b);
  }
  var blocked = state.rules.rules.filter(hasVoltage).length;
  if (blocked && !cap.voltage) {
    banner('warn', 'voltage-blocked', plural(blocked, 'rule') + ' here use the supply voltage, which this device cannot check. ' +
      'Update its firmware as below, or remove the voltage condition, before sending.');
  }
  if (!cap.loggerOk) {
    banner('warn', 'logger-fw', 'Logger firmware ' + (cap.logger ? '<b>' + esc(cap.logger) + '</b>' : 'not reported yet') +
      '. Update it to ' + LOGGER_FW_MIN + ' or later to confirm the rules the device holds and to use supply-voltage conditions. ' +
      'Until then the view compares only the number of rules.');
  } else if (!cap.drycOk) {
    banner('warn', 'dryc-fw', 'Dry contact interface firmware ' + (cap.dryc ? '<b>' + esc(cap.dryc) + '</b>' : 'not reported yet') +
      '. Update it to ' + DRYC_FW_MIN + ' or later to confirm the rules it holds and to use supply-voltage conditions.');
  }
  return out;
}

function wiringStep() {
  var sec = step(1, 'Inputs and relays', canEdit()
    ? 'Name each input wired on site, and what its on and off states mean. A named input is recorded on the station; an unnamed one is not used.'
    : 'The inputs wired on site and the relays, with their last state.');
  var grid = sec.appendChild(h('<div class="ts-live"></div>'));
  var outs = sec.appendChild(h('<div class="ts-live ts-outs"></div>'));
  for (var i = 0; i < INPUTS; i++) {
    var v = state.live['drycInput' + (i + 1)];
    var on = v && truthy(v.value), named = !!state.rules.inputs[i].label;
    var tile = h('<button type="button" class="ts-io' + (on ? ' on' : '') + (named ? '' : ' unnamed') + '" data-input="' + (i + 1) + '">' +
      '<span class="ts-io-n">IN ' + (i + 1) + '</span><span class="ts-io-l"></span><span class="ts-io-v"><span class="ts-dot"></span><span></span></span></button>');
    tile.querySelector('.ts-io-l').textContent = named ? inputLabel(i) : 'Not used';
    tile.querySelector('.ts-io-v span:last-child').textContent = v ? inputText(i, on) : '—';
    tile.disabled = !canEdit();
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
    rt.disabled = !canEdit();
    rt.addEventListener('click', namesDrawer.bind(null, 'relay', j));
    outs.appendChild(rt);
  }
  var volt = state.live.drycVoltage;
  var vt = h('<div class="ts-io"><span class="ts-io-n">SUPPLY</span><span class="ts-io-l">Supply voltage</span><span class="ts-io-v"></span></div>');
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
  if (r.condition.voltage) { chips.push('<span class="ts-cond"><b>' + esc(voltageText(r.condition.voltage)) + '</b></span>'); }
  return chips.join('<span class="ts-and">and</span>') || '<span class="ts-cond">no input</span>';
}

function actionChips(r) {
  var chips = [];
  if (r.relays.relay1) { chips.push('<span class="ts-chip accent">Switch ' + esc(relayLabel(0)) + ' on</span>'); }
  if (r.relays.relay2) { chips.push('<span class="ts-chip accent">Switch ' + esc(relayLabel(1)) + ' on</span>'); }
  if (r.notify) {
    var sev = G.severity(r.notify.severity);
    chips.push('<span class="ts-chip"><span class="ts-sev" style="background:var(--sev-' + esc(sev.id) + ')"></span>Station alarm · ' + esc(sev.label) + '</span>');
  }
  return chips.join('');
}

function rulesStep() {
  var sec = step(2, 'Rules', 'The device checks them in this order. Each rule can switch a relay on, and raise an alarm on this station, ' +
    'notified to its alarm contacts.');
  var head = sec.querySelector('.ts-section-head');
  if (canEdit()) {
    var add = h('<button type="button" class="ts-btn" data-a="add-rule">' + ICON.plus + 'Add rule</button>');
    add.disabled = records(state.rules).length >= MAX_RECORDS;
    add.addEventListener('click', function () { ruleDrawer(null); });
    head.appendChild(add);
  }
  if (!state.rules.rules.length) {
    sec.appendChild(h('<div class="ts-empty">No rule yet. A rule says which input states switch a relay or raise an alarm.</div>'));
  }
  state.rules.rules.forEach(function (r, idx) {
    var now = matching(r);
    var row = h('<div class="ts-rule" data-rule="' + esc(r.id) + '"><span class="ts-prec">' + (idx + 1) + '</span><div class="ts-grow">' +
      '<div class="ts-rule-head"><span class="ts-row-label"></span><span class="ts-chip ts-rule-now"></span></div>' +
      '<div class="ts-line"><span class="ts-k">When</span>' + conditionChips(r) + '</div>' +
      '<div class="ts-line"><span class="ts-k">Then</span>' + actionChips(r) + '</div></div><div class="ts-rule-acts"></div></div>');
    row.querySelector('.ts-row-label').textContent = r.name;
    var nowEl = row.querySelector('.ts-rule-now');
    nowEl.textContent = now === null ? 'No status yet' : now ? 'Matching now' : 'Not matching';
    nowEl.dataset.now = now === null ? 'unknown' : String(now);
    if (canEdit()) {
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
          ui.confirm('Delete the rule <b>' + esc(r.name) + '</b>? Its station alarm goes with it. The device runs it until the rules are sent again.', 'Delete')
            .then(function (ok) {
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

/** Step 3: saved here, sent, confirmed by the device; Send when the device lags. */
function deviceStep(sync) {
  var sec = step(3, 'On the device', 'Saved rules reach the device only when sent. It takes them at its next uplink and confirms.');
  var n = records(state.rules).length;
  var steps = sec.appendChild(h('<ol class="ts-dryc-track"></ol>'));
  var saved = state.saved !== 'null';
  [['saved', 'Saved on this station', saved, saved ? plural(state.rules.rules.length, 'rule') : 'no rule yet'],
   ['sent', 'Sent to the device', !!(sync.sent || sync.confirmed), sync.sent ? ago(sync.sent) : sync.confirmed ? 'earlier' : 'not yet'],
   ['confirmed', 'Confirmed by the device', !!sync.confirmed && sync.s === 'insync', sync.confirmed ? ago(sync.confirmed) : 'not yet']
  ].forEach(function (s) {
    var li = steps.appendChild(h('<li><span class="ts-dot"></span><span class="ts-grow"></span><span class="ts-row-meta"></span></li>'));
    li.dataset.track = s[0];
    li.classList.toggle('done', s[2]);
    li.querySelector('.ts-grow').textContent = s[1];
    li.querySelector('.ts-row-meta').textContent = s[3];
  });
  var strip = sec.appendChild(h('<div class="ts-sync" data-s="' + sync.s + '"><span class="ts-grow"></span><span class="ts-cap"></span></div>'));
  strip.firstChild.textContent = sync.text;
  strip.querySelector('.ts-cap').textContent = n + ' of ' + MAX_RECORDS + ' device records';
  strip.querySelector('.ts-cap').insertAdjacentHTML('beforeend', ' ' + info('drycRecords'));
  if (canSend() && sync.s !== 'waiting') {
    var needed = sync.s === 'changed' || sync.s === 'drift';
    var send = h('<button type="button" class="ts-btn' + (needed ? ' primary' : '') + '" data-a="send">Send rules to the device</button>');
    // A LOGR2 before 0.44.0 retries a rule its DRYC refuses without end: no voltage record reaches it.
    if (!capability().voltage && state.rules.rules.some(hasVoltage)) {
      send.disabled = true;
      send.title = 'A rule uses the supply voltage, which this device cannot check';
    }
    send.addEventListener('click', sendRules);
    strip.appendChild(send);
  }
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
    ? { id: nextId(state.rules), name: '', condition: { mask: 0, state: 0 }, relays: { relay1: false, relay2: false }, notify: { severity: 'major' },
        whenActive: '', whenInactive: '' }
    : clone(state.rules.rules[idx]);
  var dr = ui.openDrawer(creating ? 'New rule' : 'Rule ' + (idx + 1), 'Saved on this station; the device runs it once the rules are sent ' + info('drycSync'));
  var body = dr.body;
  body.appendChild(h('<div class="ts-field"><div class="ts-field-label"><span>Name</span></div><div class="ts-ctl"><input class="ts-input wide" data-f="name" maxlength="60" placeholder="Pump 1 failed"></div>' +
    '<div class="ts-field-hint">Also the name of the station alarm and of its notification.</div></div>'));
  var nameIn = body.querySelector('[data-f=name]');
  nameIn.value = r.name;
  var cond = h('<div class="ts-field"><div class="ts-field-label"><span>When</span></div>' +
    '<div class="ts-field-hint">Set the inputs that matter; all of them must hold at once. The others are ignored.</div><div class="ts-conds"></div></div>');
  var list = cond.querySelector('.ts-conds');
  for (var i = 0; i < INPUTS; i++) {
    var cur = (r.condition.mask & (1 << i)) ? ((r.condition.state & (1 << i)) ? 'on' : 'off') : 'any';
    var row = h('<div class="ts-condrow"><span class="ts-io-n">IN ' + (i + 1) + '</span><span class="ts-grow"></span><div class="ts-seg" data-input="' + i + '"></div></div>');
    row.classList.toggle('unnamed', !state.rules.inputs[i].label);
    row.querySelector('.ts-grow').textContent = state.rules.inputs[i].label || 'Input ' + (i + 1) + ' (not used)';
    var seg = row.querySelector('.ts-seg');
    [['any', 'Ignored'], ['on', inputText(i, true)], ['off', inputText(i, false)]].forEach(function (o) {
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
  // Offered only where the device runs it; a rule that already has one keeps it in
  // view on any device, so it can be removed.
  var cap = capability(), curV = r.condition.voltage || null;
  var volt = h('<div class="ts-field ts-dryc-volt"><div class="ts-field-label"><span>And the supply voltage</span></div>' +
    '<div class="ts-ctl"><div class="ts-seg" data-f="vop"></div>' +
    '<input class="ts-input" type="number" data-f="volts" min="0.1" max="60" step="0.1" placeholder="11.5"><span class="ts-row-meta">V</span></div>' +
    '<div class="ts-field-hint"></div></div>');
  var vseg = volt.querySelector('[data-f=vop]'), voltsIn = volt.querySelector('[data-f=volts]');
  [['any', 'Ignored'], ['below', 'Below'], ['above', 'Above']].forEach(function (o) {
    var b = h('<button type="button"></button>');
    b.dataset.v = o[0];
    b.textContent = o[1];
    b.setAttribute('aria-pressed', String(o[0] === (curV ? curV.op : 'any')));
    b.disabled = !cap.voltage && o[0] !== 'any';
    vseg.appendChild(b);
  });
  voltsIn.value = curV ? curV.volts : '';
  function vop() { return vseg.querySelector('[aria-pressed=true]').dataset.v; }
  function voltState() { voltsIn.disabled = !cap.voltage || vop() === 'any'; }
  voltState();
  volt.querySelector('.ts-field-hint').textContent = cap.voltage
    ? 'Checked by the device together with the inputs. It reacts once the voltage has stayed past the threshold for a few seconds.'
    : !state.device ? 'Needs a device on this station that runs logger firmware ' + LOGGER_FW_MIN + ' and dry contact interface firmware ' + DRYC_FW_MIN + '.'
    : 'Needs logger firmware ' + LOGGER_FW_MIN + ' and dry contact interface firmware ' + DRYC_FW_MIN + '. This device reports ' +
      (cap.logger || 'no logger version') + ' and ' + (cap.dryc || 'no interface version') + '.';
  volt.hidden = !cap.voltage && !curV;
  vseg.addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b || b.disabled) { return; }
    vseg.querySelectorAll('button').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
    voltState();
    count();
  });
  voltsIn.addEventListener('input', function () { count(); });
  body.appendChild(volt);
  var acts = h('<div class="ts-field"><div class="ts-field-label"><span>Then</span></div>' +
    '<label class="ts-switch"><input type="checkbox" data-f="relay1"> <span></span></label>' +
    '<label class="ts-switch"><input type="checkbox" data-f="relay2"> <span></span></label>' +
    '<label class="ts-switch"><input type="checkbox" data-f="notify"> <span>Raise an alarm on this station</span></label>' +
    '<div class="ts-ctl ts-dryc-sev"><span class="ts-row-meta">Severity</span><select class="ts-select" data-f="severity"></select></div>' +
    '<div class="ts-field-hint">The alarm is notified to the station’s alarm contacts and clears when the rule stops matching.</div></div>');
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
  acts.addEventListener('change', function () {
    var notify = acts.querySelector('[data-f=notify]').checked;
    sevSel.disabled = !notify;
    wording.hidden = !notify;
    count();
  });
  body.appendChild(acts);
  var wording = h('<div class="ts-field ts-dryc-wording"><div class="ts-field-label"><span>Alarm wording</span></div>' +
    '<div class="ts-ctl"><span class="ts-row-meta">When active</span><input class="ts-input wide" data-f="whenActive" maxlength="80"></div>' +
    '<div class="ts-ctl"><span class="ts-row-meta">When inactive</span><input class="ts-input wide" data-f="whenInactive" maxlength="80"></div>' +
    '<div class="ts-field-hint">The value the alarm and its message show. Left empty, it reads as the condition, each input at its other state when inactive.</div></div>');
  var activeIn = wording.querySelector('[data-f=whenActive]'), inactiveIn = wording.querySelector('[data-f=whenInactive]');
  activeIn.value = r.whenActive || '';
  inactiveIn.value = r.whenInactive || '';
  wording.hidden = !r.notify;
  body.appendChild(wording);
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
    var volts = Math.round(Number(voltsIn.value) * 10) / 10;
    if (vop() !== 'any' && volts > 0) { out.condition.voltage = { op: vop(), volts: volts }; }
    out.relays ={ relay1: acts.querySelector('[data-f=relay1]').checked, relay2: acts.querySelector('[data-f=relay2]').checked };
    out.notify = acts.querySelector('[data-f=notify]').checked ? { severity: sevSel.value } : null;
    out.whenActive = out.notify ? activeIn.value.trim() : '';
    out.whenInactive = out.notify ? inactiveIn.value.trim() : '';
    return out;
  }
  function draftSet() {
    var set = clone(state.rules);
    if (creating) { set.rules.push(read()); } else { set.rules[idx] = read(); }
    return set;
  }
  function count() {
    var nrec = records(draftSet()).length;
    countEl.textContent = 'The device holds ' + MAX_RECORDS + ' records: one per relay switched and one per alarm. These rules use ' + nrec + '.';
    countEl.classList.toggle('ts-error', nrec > MAX_RECORDS);
    activeIn.placeholder = conditionText(state.rules, read()) || 'the rule’s condition';
    inactiveIn.placeholder = conditionText(state.rules, read(), true) || 'the rule’s condition, inverted';
  }
  count();
  var primary = ui.drawerActions(dr, creating ? 'Add rule' : 'Save');
  primary.addEventListener('click', function () {
    var x = read(), volts = Number(voltsIn.value);
    var problem = !x.name ? 'Give the rule a name.'
      : vop() !== 'any' && !(volts >= 0.1 && volts <= 60) ? 'Give a supply voltage from 0.1 to 60 V.'
      : x.condition.voltage && !cap.voltage ? 'This device cannot check the supply voltage: set it to Ignored.'
      : !x.condition.mask && !x.condition.voltage ? 'Set at least one input or the supply voltage.'
      : !(x.relays.relay1 || x.relays.relay2 || x.notify) ? 'Pick what the rule does: a relay, an alarm or both.'
      : records(draftSet()).length > MAX_RECORDS ? 'That needs more than ' + MAX_RECORDS + ' records on the device.'
      : null;
    if (problem) { ui.toast(problem, 'error'); return; }
    commit(draftSet(), creating ? 'Rule added' : 'Rule saved');
  });
}

function namesDrawer(kind, i) {
  var isInput = kind === 'input';
  var dr = ui.openDrawer((isInput ? 'Input ' : 'Relay ') + (i + 1), isInput ? 'What is wired to it on site' : 'What it switches on site');
  var cur = isInput ? state.rules.inputs[i] : state.rules.relays[i];
  dr.body.appendChild(h('<div class="ts-field"><div class="ts-field-label"><span>Name</span></div><div class="ts-ctl"><input class="ts-input wide" data-f="label" maxlength="40"></div>' +
    (isInput ? '<div class="ts-field-hint">Leave it empty when nothing is wired: the input is then not used nor recorded.</div>' : '') + '</div>'));
  if (isInput) {
    dr.body.appendChild(h('<div class="ts-field"><div class="ts-field-label"><span>Wording when on</span></div><div class="ts-ctl"><input class="ts-input wide" data-f="whenOn" maxlength="30" placeholder="On"></div></div>'));
    dr.body.appendChild(h('<div class="ts-field"><div class="ts-field-label"><span>Wording when off</span></div><div class="ts-ctl"><input class="ts-input wide" data-f="whenOff" maxlength="30" placeholder="Off"></div>' +
      '<div class="ts-field-hint">Shown on the rules and in the station’s charts, e.g. "Fault" and "OK".</div></div>'));
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
  if (!state.station) { return Promise.resolve(); }
  return load().then(render).catch(function (err) { ui.toast('Refresh failed: ' + errText(err), 'error'); });
}

/** What changes when the device reports or answers a send. */
function deviceMark(server) {
  return [server.lastActivityTime, JSON.stringify(server['cmd.pending'] || null), JSON.stringify(server['cmd.lastResult'] || null)].join('|');
}

// One attribute read per tick; the full reload only when the device moved, and
// never under an open drawer or confirmation, whose edit it would replace.
var timer = null;
function poll() {
  if (!root.isConnected) { clearInterval(timer); return; }
  if (document.hidden || !state.device || cardEl.querySelector('.ts-drawer, .ts-confirm')) { return; }
  tb.attrsMap(deviceEntity(), 'SERVER_SCOPE').then(function (server) {
    if (Object.keys(server).length && deviceMark(server) !== deviceMark(state.server)) { return refresh(); }
  });
}

tb.boundDatasource().then(function (ds) {
  if (!ds || ds.entityType !== 'ASSET') { fail('Open the dry contact interface from its station.'); return; }
  return tb.loadEntity(ds).then(function (station) {
    if (station.kind !== 'Station') { fail('This view shows a station; ' + station.name + ' is a ' + station.kind + '.'); return null; }
    state.station = station;
    return Promise.all([findDevice(station), tb.currentUser(), tb.canWrite(station)]);
  }).then(function (got) {
    if (!got) { return null; }
    state.device = got[0];
    state.me = got[1];
    state.writeStation = got[2] && !(got[1] || {}).isPublic && !tb.isPublicView();
    return Promise.all([load(), state.device ? tb.canWrite(deviceEntity()) : false]).then(function (all) {
      state.writeDevice = all[1];
      render();
      timer = setInterval(poll, POLL_MS);
    });
  });
}).catch(function (err) { fail('Could not load: ' + errText(err)); });

};
