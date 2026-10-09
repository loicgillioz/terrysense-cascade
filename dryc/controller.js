/*
 * DRYC — the dry contact interface of a station: the inputs wired on site and
 * the relays, the rules on them, and the rules sent to the device (CA-5).
 * Bound to a STATION; its device is the LOGR2 or LOGR4 it contains. Model:
 * logr-product-docs/cloud/DRYC.md. View: logr-product-docs/cloud/FRONTEND.md
 * *Dry contact interface view*.
 *
 * Rules live in `dryc.rules` on the STATION, so a replaced device takes them
 * over; the device keeps only what was sent to it (`cmd.lastResult`,
 * `drycRuleCount`, `drycRulesCrc16`). A LOGR4 DRYC sits on a bus position, which
 * the rule set names. Saving also gives each notifying rule its station channel
 * `drycRule-<n>`, mapped to `drycRule.<id>` with a boolean alarm at the rule's
 * severity, its value worded as the rule's condition unless the rule words it;
 * `station_project` fills that value on every DRYC status. The
 * labelled inputs, the outputs and the voltage go onto the station too, for
 * display and history. A device may feed several stations; when more than one
 * holds rules for its dry contact interface, the widget warns that the device
 * runs whichever set was sent last. Send writes one `cmd.request`: DRYC_RULES
 * for a LOGR2, a PERIPHERAL_OP with `dryc_rules` at the DRYC's position for a
 * LOGR4, which `dl_dispatch` sends through the family's integration. The view
 * refreshes itself when the device reports or answers.
 *
 * Loads after shared/resolver.js, glossary.js, ui.js and tb_io.js.
 */

window.TerrySenseDryc = function (ctx, container, opts) {

opts = opts || {};
var t = window.TerrySenseI18n(ctx);

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
// A LOGR4 runs supply-voltage records from logr-logic 1.19.0 and reports no DRYC firmware (TRX_NANO.md §10.4).
var NANO_FW_MIN = '1.19.0';
var VOLT_OPS = { below: 1, above: 2 };
var POLL_MS = opts.pollMs || 15000;
var RULE_CHANNEL = 'drycRule';
var SEVERITY_IDS = ['critical', 'major', 'minor', 'warning', 'indeterminate'];
// The device stores them under the DRYC prefix, `dryc.` on a LOGR2, `p<position>.` on a LOGR4; state.live drops it.
var LIVE_KEYS = [];
for (var k = 1; k <= INPUTS; k++) { LIVE_KEYS.push('drycInput' + k); }
LIVE_KEYS = LIVE_KEYS.concat(['drycOutput1', 'drycOutput2', 'drycVoltage', 'drycRuleCount', 'drycRulesSynced', 'drycRulesCrc16']);
var DRYC_SOURCE = /^(dryc|p\d+)\.dryc(Input|Output|Voltage)\d*$/;
var DEVICE_TYPES = ['logr2', 'logr3', 'logr4'];

function parseJson(raw) {
  if (raw === undefined || raw === null || raw === '') { return null; }
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (e) { return null; }
}
function truthy(v) { return v === true || v === 1 || v === '1' || v === 'true'; }
function clone(o) { return JSON.parse(JSON.stringify(o)); }

// -- model ------------------------------------------------------------------------------

var state = {
  station: null, device: null, position: null, others: [], rules: null, saved: '', live: {}, server: {}, client: {},
  writeDevice: false, writeStation: false, me: null
};

/** A TRX Nano logger (LOGR3, LOGR4): its DRYC sits on a bus position and takes rules as a PERIPHERAL_OP. */
function nano() { return !!state.device && String(state.device.type).toLowerCase() !== 'logr2'; }
function livePrefix() { return nano() ? (state.position ? 'p' + state.position + '.' : null) : 'dryc.'; }
function loggerMin() { return nano() ? NANO_FW_MIN : LOGGER_FW_MIN; }

/** The DRYC's bus position: the one the rule set names, else the first the device's topology reports. */
function drycPosition(set) {
  if (!nano()) { return null; }
  if (set && Number(set.position) > 0) { return Number(set.position); }
  var found = Object.keys(state.client).map(function (key) {
    var m = /^topology\.p(\d+)\.type$/.exec(key);
    return m && /^dryc/.test(String(state.client[key])) ? Number(m[1]) : null;
  }).filter(Boolean).sort(function (a, b) { return a - b; });
  return found[0] || null;
}

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
  // An older DRYC behind a LOGR4 refuses a voltage record and the ACK says so: only the logger gates.
  if (nano()) {
    var ok = versionAtLeast(logger, NANO_FW_MIN);
    return { logger: logger, dryc: null, loggerOk: ok, drycOk: ok, voltage: ok, crc: ok };
  }
  var loggerOk = versionAtLeast(logger, LOGGER_FW_MIN), drycOk = loggerOk && versionAtLeast(dryc, DRYC_FW_MIN);
  return { logger: logger, dryc: dryc, loggerOk: loggerOk, drycOk: drycOk, voltage: drycOk, crc: drycOk };
}

function hasVoltage(r) { return !!(r.condition && r.condition.voltage); }

/** Rules are edited on the station and sent from the device. */
function canEdit() { return state.writeStation; }
function canSend() { return !!state.device && state.writeDevice && (!nano() || !!state.position); }

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

// The terminals' own names are the vocabulary's drycInput<n> / drycOutput<n> labels.
function inputName(i) { return t.channel('drycInput' + (i + 1), 'Input ' + (i + 1)); }
function relayName(i) { return t.channel('drycOutput' + (i + 1), 'Relay ' + (i + 1)); }
function inputLabel(i) { return state.rules.inputs[i].label || inputName(i); }
function inputText(i, on) { var x = state.rules.inputs[i]; return on ? (x.whenOn || t('common.on', 'On')) : (x.whenOff || t('common.off', 'Off')); }
function relayLabel(i) { return state.rules.relays[i].label || relayName(i); }

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

/** The records as a LOGR4 PERIPHERAL_OP carries them (TRX_NANO.md §10.4), and back. */
function drycRules(recs) {
  return recs.map(function (x) {
    return x[3] ? { output: x[0], condition: x[1], mask: x[2], vop: x[3], threshold_mv: x[4] } : { output: x[0], condition: x[1], mask: x[2] };
  });
}
function recordsOf(c) {
  return c.records || (c.dryc_rules || []).map(function (r) { return r.vop ? [r.output, r.condition, r.mask, r.vop, r.threshold_mv] : [r.output, r.condition, r.mask]; });
}
/** A command that sets this station's DRYC rules. */
function isRulesCommand(c) {
  return nano() ? c.op === 'PERIPHERAL_OP' && !!c.dryc_rules && (c.target || {}).position === state.position : c.op === 'DRYC_RULES';
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
  if (!state.device) { return { s: 'nodevice', short: t('common.noDevice', 'No device'), text: t('dryc.syncNoDevice', 'No dry contact interface feeds this station. The rules are kept here and sent once one is connected.') }; }
  if (nano() && !state.position) { return { s: 'nodevice', short: t('dryc.noInterface', 'No interface reported'), text: t('dryc.syncNoPosition', 'The device reports no dry contact interface on its bus. Rules are sent once it reports one.') }; }
  var queued = parseJson(state.server['cmd.pending']);
  var pending = queued && (queued.commands || []).some(isRulesCommand)
    ? { issuedAt: queued.updatedAt || queued.issuedAt } : null;
  var last = parseJson(state.server['cmd.lastResult']);
  var lastRules = null;
  (last && last.commands || []).forEach(function (c, i) {
    if (!isRulesCommand(c)) { return; }
    var res = (last.results || [])[i];
    lastRules = { cmd: c, ok: nano() ? !!res && res.status === 'OK' : last.ok, issuedAt: last.issuedAt, ackedAt: last.ackedAt };
  });
  var count = state.live.drycRuleCount ? Number(state.live.drycRuleCount.value) : null;
  if (pending) {
    if (Date.now() - (pending.issuedAt || 0) > DAY_MS) {
      return { s: 'drift', short: t('dryc.notConfirmed', 'Not confirmed'), sent: pending.issuedAt, text: t('dryc.syncNotConfirmed', 'Sent {ago} and never confirmed. Send again.', { ago: t.ago(pending.issuedAt) }) };
    }
    return { s: 'waiting', short: t('dryc.waiting', 'Waiting for the device'), sent: pending.issuedAt, text: t('dryc.syncWaiting', 'Sent {ago}. The device takes them at its next uplink.', { ago: t.ago(pending.issuedAt) }) };
  }
  if (lastRules && !lastRules.ok) {
    return { s: 'drift', short: t('dryc.refused', 'Refused'), sent: lastRules.issuedAt, text: t('dryc.syncRefused', 'The device refused the last rules sent. Send again.') };
  }
  if (lastRules && JSON.stringify(recordsOf(lastRules.cmd)) !== want) {
    return { s: 'changed', short: t('dryc.sendNeeded', 'Send needed'), sent: lastRules.issuedAt, confirmed: lastRules.ackedAt,
             text: t('dryc.syncChanged', 'The rules changed since they were sent. The device still runs the previous ones.') };
  }
  // With the checksum the device's own rules are compared to those sent; without it, only their number. 0 is unknown.
  var cap = capability();
  var crc = nano() ? (state.live.drycRulesCrc16 ? Number(state.live.drycRulesCrc16.value) : 0) : Number(state.client['status.drycRulesCrc16'] || 0);
  var sentCrc = lastRules && lastRules.cmd.rules_crc16 !== undefined ? lastRules.cmd.rules_crc16 : recordsCrc(JSON.parse(want));
  if (cap.crc && crc && crc !== sentCrc) {
    return { s: 'drift', short: t('dryc.sendNeeded', 'Send needed'), text: t('dryc.syncOtherRules', 'The device holds other rules than these. Send them.') };
  }
  if (cap.crc && crc) {
    return { s: 'insync', short: t('dryc.onDevice', 'On the device'), sent: lastRules && lastRules.issuedAt,
             confirmed: (lastRules && lastRules.ackedAt) || (state.live.drycRulesCrc16 || state.live.drycRuleCount || {}).ts || null,
             text: t('dryc.syncCrc', 'The device runs these rules: its rules checksum matches.') };
  }
  if (count !== null && count !== n) {
    return { s: 'drift', short: t('dryc.sendNeeded', 'Send needed'), text: count === 1
      ? t('dryc.syncCountOtherOne', 'The device holds 1 record, these rules need {n}. Send them.', { n: n })
      : t('dryc.syncCountOtherMany', 'The device holds {count} records, these rules need {n}. Send them.', { count: count, n: n }) };
  }
  if (lastRules) {
    return { s: 'insync', short: t('dryc.onDevice', 'On the device'), sent: lastRules.issuedAt, confirmed: lastRules.ackedAt, text: t('dryc.syncInSync', 'The device runs these rules.') };
  }
  return count === null
    ? { s: 'insync', short: t('dryc.noStatus', 'No status yet'), text: t('dryc.syncNoStatus', 'No status from the device yet.') }
    : { s: 'insync', short: t('dryc.onDevice', 'On the device'), confirmed: state.live.drycRuleCount.ts, text: count === 1
      ? t('dryc.syncCountOne', 'The device holds 1 record, as these rules need.')
      : t('dryc.syncCountMany', 'The device holds {n} records, as these rules need.', { n: count }) };
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

/** The station's LOGR2 or LOGR4, else null. */
function findDevice(station) {
  return devicesOf(station.id).then(function (ids) {
    return Promise.all(ids.map(function (id) { return tb.get('/api/device/' + id); }));
  }).then(function (devices) { return devices.filter(function (d) { return DEVICE_TYPES.indexOf(String(d.type).toLowerCase()) >= 0; })[0] || null; });
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
    dev ? tb.attrsMap(dev, 'CLIENT_SCOPE').catch(function () { return {}; }) : {}
  ]).then(function (got) {
    state.client = got[3] || {};
    var raw = parseJson(got[0]['dryc.rules']);
    state.saved = JSON.stringify(raw || null);
    state.rules = normalise(raw);
    state.position = drycPosition(raw);
    state.others = got[1].filter(Boolean).sort(function (a, b) { return a.name.localeCompare(b.name); });
    state.server = got[2] || {};
    var prefix = livePrefix();
    return dev && prefix ? tb.get('/api/plugins/telemetry/DEVICE/' + dev.id + '/values/timeseries', { keys: LIVE_KEYS.map(function (key) { return prefix + key; }).join(',') })
      .catch(function () { return {}; }) : {};
  }).then(function (series) {
    var prefix = livePrefix();
    state.live = {};
    Object.keys(series || {}).forEach(function (key) {
      var p = series[key] && series[key][0];
      if (p && p.value !== null && p.value !== undefined) { state.live[key.slice(prefix.length)] = { ts: Number(p.ts), value: p.value }; }
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
    var mine = !entries[c].device || entries[c].device === me || /^(dryc|drycRule)\./.test(entries[c].key) || DRYC_SOURCE.test(entries[c].key);
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
  var prefix = livePrefix();
  if (!prefix) { return; }
  function named(key, target, label) {
    channels[key] = target;
    if (label) { write['channel.' + key + '.label'] = label; } else if (('channel.' + key + '.label') in stationAttrs) { remove.push('channel.' + key + '.label'); }
  }
  for (var i = 1; i <= INPUTS; i++) {
    var key = 'drycInput' + i, label = ((set.inputs || [])[i - 1] || {}).label;
    if (label) { named(key, prefix + key, label); } else if (DRYC_SOURCE.test(channels[key] || '')) {
      delete channels[key];
      if (('channel.' + key + '.label') in stationAttrs) { remove.push('channel.' + key + '.label'); }
    }
  }
  for (var r = 1; r <= RELAYS; r++) { named('drycOutput' + r, prefix + 'drycOutput' + r, ((set.relays || [])[r - 1] || {}).label); }
  channels.drycVoltage = prefix + 'drycVoltage';
}

function save(set) {
  var body = clone(set);
  delete body.position;
  if (nano() && state.position) { body.position = state.position; }
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
  var device = esc(state.device.label || state.device.name);
  ui.confirm(recs.length === 1
    ? t('dryc.sendConfirmOne', 'Send 1 record to the dry contact interface of <b>{device}</b>? They replace the rules it runs now, after the logger’s next uplink.', { device: device })
    : t('dryc.sendConfirmMany', 'Send {n} records to the dry contact interface of <b>{device}</b>? They replace the rules it runs now, after the logger’s next uplink.', { n: recs.length, device: device }),
    t('common.send', 'Send')).then(function (ok) {
    if (!ok) { return; }
    var command = nano() ? { op: 'PERIPHERAL_OP', target: { mode: 'POSITION', position: state.position }, dryc_rules: drycRules(recs) }
      : { op: 'DRYC_RULES', records: recs };
    var request = { commands: [command], by: (state.me && state.me.email) || null, issuedAt: Date.now() };
    return tb.saveAttrs(deviceEntity(), { 'cmd.request': request }).then(function () {
      ui.toast(t('dryc.sent', 'Sent: the device takes them at its next uplink'));
      setTimeout(refresh, 1500);
    }).catch(function (err) { ui.toast(t('common.notSent', 'Not sent: {error}', { error: errText(err) }), 'error'); });
  });
}

function errText(err) { return (err && (err.message || (err.error && err.error.message))) || String(err); }

// -- skeleton ---------------------------------------------------------------------------

root.innerHTML = '';
var cardEl = h('<div class="ts-card ts-dryc"><div class="ts-head"><div class="ts-head-icon">' + ICON.settings + '</div><div class="ts-head-text">' +
  '<div class="ts-title"><span>' + esc(t('common.dryc', 'Dry contact interface')) + '</span> ' + info('drycRules') + '</div><div class="ts-subtitle"></div></div>' +
  '<span class="ts-dryc-state" hidden></span></div>' +
  '<div class="ts-body"><div class="ts-loading">' + esc(t('common.loading', 'Loading…')) + '</div></div>' +
  '<div class="ts-foot" hidden><span class="ts-summary"></span><span class="ts-spacer"></span><button type="button" class="ts-btn">' + ICON.reset + esc(t('common.refresh', 'Refresh')) + '</button></div></div>');
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

  bodyEl.appendChild(h('<div class="ts-dryc-intro"></div>')).textContent =
    t('dryc.intro', 'The device switches its relays itself, from the rules it was sent. Rules are kept on this station: name the inputs wired on site, write the rules, then send them to the device.');
  if (state.others.length) {
    var warn = h('<div class="ts-banner warn" data-warn="competing">' + ICON.info + '<span></span></div>');
    warn.querySelector('span').innerHTML = t('dryc.competing', 'Rules for this dry contact interface are also kept on <b>{stations}</b>. The device runs whichever set was sent last: keep them on one station.',
      { stations: state.others.map(function (o) { return esc(o.name); }).join('</b>, <b>') });
    bodyEl.appendChild(warn);
  }
  firmwareBanners().forEach(function (b) { bodyEl.appendChild(b); });
  bodyEl.appendChild(wiringStep());
  bodyEl.appendChild(rulesStep());
  bodyEl.appendChild(deviceStep(sync));
  var last = state.live.drycInput1;
  summaryEl.textContent = !d ? t('common.noDevice', 'No device')
    : last ? t('dryc.lastStatus', 'Last status {ago}', { ago: t.ago(last.ts) }) : t('dryc.lastStatusNever', 'Last status never received');
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
    banner('warn', 'voltage-blocked', esc(blocked === 1
      ? t('dryc.voltageBlockedOne', '1 rule here uses the supply voltage, which this device cannot check. Update its firmware as below, or remove the voltage condition, before sending.')
      : t('dryc.voltageBlockedMany', '{n} rules here use the supply voltage, which this device cannot check. Update its firmware as below, or remove the voltage condition, before sending.', { n: blocked })));
  }
  function version(v) { return v ? '<b>' + esc(v) + '</b>' : esc(t('dryc.notReported', 'not reported yet')); }
  if (!cap.loggerOk) {
    banner('warn', 'logger-fw', t('dryc.loggerFw', 'Logger firmware {version}. Update it to {min} or later to confirm the rules the device holds and to use supply-voltage conditions. Until then the view compares only the number of rules.',
      { version: version(cap.logger), min: loggerMin() }));
  } else if (nano() && blocked) {
    banner('warn', 'dryc-fw-unknown', esc(t('dryc.drycFwUnknown', 'A supply-voltage condition needs dry contact interface firmware {min} or later, which this logger does not report. An older interface refuses the rules, and this view then shows Refused.', { min: DRYC_FW_MIN })));
  } else if (!cap.drycOk) {
    banner('warn', 'dryc-fw', t('dryc.drycFw', 'Dry contact interface firmware {version}. Update it to {min} or later to confirm the rules it holds and to use supply-voltage conditions.',
      { version: version(cap.dryc), min: DRYC_FW_MIN }));
  }
  return out;
}

function wiringStep() {
  var sec = step(1, t('dryc.wiring', 'Inputs and relays'), canEdit()
    ? t('dryc.wiringHint', 'Name each input wired on site, and what its on and off states mean. A named input is recorded on the station; an unnamed one is not used.')
    : t('dryc.wiringHintRead', 'The inputs wired on site and the relays, with their last state.'));
  var grid = sec.appendChild(h('<div class="ts-live"></div>'));
  var outs = sec.appendChild(h('<div class="ts-live ts-outs"></div>'));
  for (var i = 0; i < INPUTS; i++) {
    var v = state.live['drycInput' + (i + 1)];
    var on = v && truthy(v.value), named = !!state.rules.inputs[i].label;
    var tile = h('<button type="button" class="ts-io' + (on ? ' on' : '') + (named ? '' : ' unnamed') + '" data-input="' + (i + 1) + '">' +
      '<span class="ts-io-n">IN ' + (i + 1) + '</span><span class="ts-io-l"></span><span class="ts-io-v"><span class="ts-dot"></span><span></span></span></button>');
    tile.querySelector('.ts-io-l').textContent = named ? inputLabel(i) : t('dryc.notUsed', 'Not used');
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
    rt.querySelector('.ts-io-v span:last-child').textContent = rv ? (ron ? t('common.on', 'On') : t('common.off', 'Off')) : '—';
    rt.disabled = !canEdit();
    rt.addEventListener('click', namesDrawer.bind(null, 'relay', j));
    outs.appendChild(rt);
  }
  var volt = state.live.drycVoltage;
  var vt = h('<div class="ts-io"><span class="ts-io-n">SUPPLY</span><span class="ts-io-l"></span><span class="ts-io-v"></span></div>');
  vt.querySelector('.ts-io-l').textContent = t('dryc.supplyVoltage', 'Supply voltage');
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
  var v = r.condition.voltage;
  if (v) {
    var supply = v.op === 'below' ? t('dryc.supplyBelow', 'Supply < {volts} V', { volts: v.volts.toFixed(1) })
      : t('dryc.supplyAbove', 'Supply > {volts} V', { volts: v.volts.toFixed(1) });
    chips.push('<span class="ts-cond"><b>' + esc(supply) + '</b></span>');
  }
  return chips.join('<span class="ts-and">' + esc(t('dryc.and', 'and')) + '</span>') || '<span class="ts-cond">' + esc(t('dryc.noInput', 'no input')) + '</span>';
}

function actionChips(r) {
  var chips = [];
  if (r.relays.relay1) { chips.push('<span class="ts-chip accent">' + esc(t('dryc.switchOn', 'Switch {relay} on', { relay: relayLabel(0) })) + '</span>'); }
  if (r.relays.relay2) { chips.push('<span class="ts-chip accent">' + esc(t('dryc.switchOn', 'Switch {relay} on', { relay: relayLabel(1) })) + '</span>'); }
  if (r.notify) {
    var sev = G.severity(r.notify.severity);
    chips.push('<span class="ts-chip"><span class="ts-sev" style="background:var(--sev-' + esc(sev.id) + ')"></span>' + esc(t('dryc.stationAlarm', 'Station alarm · {severity}', { severity: sev.label })) + '</span>');
  }
  return chips.join('');
}

function rulesStep() {
  var sec = step(2, t('dryc.rules', 'Rules'), t('dryc.rulesHint', 'The device checks them in this order. Each rule can switch a relay on, and raise an alarm on this station, notified to its alarm contacts.'));
  var head = sec.querySelector('.ts-section-head');
  if (canEdit()) {
    var add = h('<button type="button" class="ts-btn" data-a="add-rule">' + ICON.plus + esc(t('dryc.addRule', 'Add rule')) + '</button>');
    add.disabled = records(state.rules).length >= MAX_RECORDS;
    add.addEventListener('click', function () { ruleDrawer(null); });
    head.appendChild(add);
  }
  if (!state.rules.rules.length) {
    sec.appendChild(h('<div class="ts-empty"></div>')).textContent = t('dryc.noRule', 'No rule yet. A rule says which input states switch a relay or raise an alarm.');
  }
  state.rules.rules.forEach(function (r, idx) {
    var now = matching(r);
    var row = h('<div class="ts-rule" data-rule="' + esc(r.id) + '"><span class="ts-prec">' + (idx + 1) + '</span><div class="ts-grow">' +
      '<div class="ts-rule-head"><span class="ts-row-label"></span><span class="ts-chip ts-rule-now"></span></div>' +
      '<div class="ts-line"><span class="ts-k">' + esc(t('dryc.when', 'When')) + '</span>' + conditionChips(r) + '</div>' +
      '<div class="ts-line"><span class="ts-k">' + esc(t('dryc.then', 'Then')) + '</span>' + actionChips(r) + '</div></div><div class="ts-rule-acts"></div></div>');
    row.querySelector('.ts-row-label').textContent = r.name;
    var nowEl = row.querySelector('.ts-rule-now');
    nowEl.textContent = now === null ? t('dryc.noStatus', 'No status yet') : now ? t('dryc.matching', 'Matching now') : t('common.notMatching', 'Not matching');
    nowEl.dataset.now = now === null ? 'unknown' : String(now);
    if (canEdit()) {
      var acts = row.querySelector('.ts-rule-acts');
      [['up', '↑', t('dryc.earlier', 'Earlier')], ['down', '↓', t('dryc.later', 'Later')], ['edit', null, t('common.edit', 'Edit')], ['del', null, t('common.delete', 'Delete')]].forEach(function (a) {
        var b = h('<button type="button" class="ts-icon-btn" data-a="' + a[0] + '" title="' + esc(a[2]) + '"></button>');
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
          ui.confirm(t('dryc.deleteConfirm', 'Delete the rule <b>{name}</b>? Its station alarm goes with it. The device runs it until the rules are sent again.', { name: esc(r.name) }), t('common.delete', 'Delete'))
            .then(function (ok) {
              if (!ok) { return; }
              set.rules.splice(idx, 1);
              commit(set, t('dryc.ruleDeleted', 'Rule deleted'));
            });
          return;
        }
        var to = b.dataset.a === 'up' ? idx - 1 : idx + 1;
        var moved = set.rules.splice(idx, 1)[0];
        set.rules.splice(to, 0, moved);
        commit(set, t('dryc.orderSaved', 'Order saved'));
      });
    }
    sec.appendChild(row);
  });
  return sec;
}

/** Step 3: saved here, sent, confirmed by the device; Send when the device lags. */
function deviceStep(sync) {
  var sec = step(3, t('dryc.onDevice', 'On the device'), t('dryc.onDeviceHint', 'Saved rules reach the device only when sent. It takes them at its next uplink and confirms.'));
  var n = records(state.rules).length;
  var steps = sec.appendChild(h('<ol class="ts-dryc-track"></ol>'));
  var saved = state.saved !== 'null';
  var nrules = state.rules.rules.length;
  [['saved', t('dryc.trackSaved', 'Saved on this station'), saved, !saved ? t('dryc.noRuleYet', 'no rule yet')
     : nrules === 1 ? t('dryc.ruleCountOne', '1 rule') : t('dryc.ruleCountMany', '{n} rules', { n: nrules })],
   ['sent', t('dryc.trackSent', 'Sent to the device'), !!(sync.sent || sync.confirmed), sync.sent ? t.ago(sync.sent) : sync.confirmed ? t('dryc.earlierTime', 'earlier') : t('dryc.notYet', 'not yet')],
   ['confirmed', t('dryc.trackConfirmed', 'Confirmed by the device'), !!sync.confirmed && sync.s === 'insync', sync.confirmed ? t.ago(sync.confirmed) : t('dryc.notYet', 'not yet')]
  ].forEach(function (s) {
    var li = steps.appendChild(h('<li><span class="ts-dot"></span><span class="ts-grow"></span><span class="ts-row-meta"></span></li>'));
    li.dataset.track = s[0];
    li.classList.toggle('done', s[2]);
    li.querySelector('.ts-grow').textContent = s[1];
    li.querySelector('.ts-row-meta').textContent = s[3];
  });
  var strip = sec.appendChild(h('<div class="ts-sync" data-s="' + sync.s + '"><span class="ts-grow"></span><span class="ts-cap"></span></div>'));
  strip.firstChild.textContent = sync.text;
  strip.querySelector('.ts-cap').textContent = t('dryc.recordUse', '{n} of {max} device records', { n: n, max: MAX_RECORDS });
  strip.querySelector('.ts-cap').insertAdjacentHTML('beforeend', ' ' + info('drycRecords'));
  if (canSend() && sync.s !== 'waiting') {
    var needed = sync.s === 'changed' || sync.s === 'drift';
    var send = h('<button type="button" class="ts-btn' + (needed ? ' primary' : '') + '" data-a="send"></button>');
    send.textContent = t('dryc.sendRules', 'Send rules to the device');
    // A LOGR2 before 0.44.0 retries a rule its DRYC refuses without end: no voltage record reaches it.
    if (!capability().voltage && state.rules.rules.some(hasVoltage)) {
      send.disabled = true;
      send.title = t('dryc.sendBlocked', 'A rule uses the supply voltage, which this device cannot check');
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
  }).catch(function (err) { ui.toast(t('common.notSaved', 'Not saved: {error}', { error: errText(err) }), 'error'); });
}

function ruleDrawer(idx) {
  var creating = idx === null;
  var r = creating
    ? { id: nextId(state.rules), name: '', condition: { mask: 0, state: 0 }, relays: { relay1: false, relay2: false }, notify: { severity: 'major' },
        whenActive: '', whenInactive: '' }
    : clone(state.rules.rules[idx]);
  var dr = ui.openDrawer(creating ? t('dryc.newRule', 'New rule') : t('dryc.ruleN', 'Rule {n}', { n: idx + 1 }),
    esc(t('dryc.ruleDrawerHint', 'Saved on this station; the device runs it once the rules are sent')) + ' ' + info('drycSync'));
  var body = dr.body;
  body.appendChild(h('<div class="ts-field"><div class="ts-field-label"><span>' + esc(t('common.name', 'Name')) + '</span></div><div class="ts-ctl"><input class="ts-input wide" data-f="name" maxlength="60" placeholder="' + esc(t('dryc.namePlaceholder', 'Pump 1 failed')) + '"></div>' +
    '<div class="ts-field-hint">' + esc(t('dryc.nameHint', 'Also the name of the station alarm and of its notification.')) + '</div></div>'));
  var nameIn = body.querySelector('[data-f=name]');
  nameIn.value = r.name;
  var cond = h('<div class="ts-field"><div class="ts-field-label"><span>' + esc(t('dryc.when', 'When')) + '</span></div>' +
    '<div class="ts-field-hint">' + esc(t('dryc.whenHint', 'Set the inputs that matter; all of them must hold at once. The others are ignored.')) + '</div><div class="ts-conds"></div></div>');
  var list = cond.querySelector('.ts-conds');
  for (var i = 0; i < INPUTS; i++) {
    var cur = (r.condition.mask & (1 << i)) ? ((r.condition.state & (1 << i)) ? 'on' : 'off') : 'any';
    var row = h('<div class="ts-condrow"><span class="ts-io-n">IN ' + (i + 1) + '</span><span class="ts-grow"></span><div class="ts-seg" data-input="' + i + '"></div></div>');
    row.classList.toggle('unnamed', !state.rules.inputs[i].label);
    row.querySelector('.ts-grow').textContent = state.rules.inputs[i].label || t('dryc.inputNotUsed', 'Input {n} (not used)', { n: i + 1 });
    var seg = row.querySelector('.ts-seg');
    [['any', t('dryc.ignored', 'Ignored')], ['on', inputText(i, true)], ['off', inputText(i, false)]].forEach(function (o) {
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
  var volt = h('<div class="ts-field ts-dryc-volt"><div class="ts-field-label"><span>' + esc(t('dryc.andSupply', 'And the supply voltage')) + '</span></div>' +
    '<div class="ts-ctl"><div class="ts-seg" data-f="vop"></div>' +
    '<input class="ts-input" type="number" data-f="volts" min="0.1" max="60" step="0.1" placeholder="11.5"><span class="ts-row-meta">V</span></div>' +
    '<div class="ts-field-hint"></div></div>');
  var vseg = volt.querySelector('[data-f=vop]'), voltsIn = volt.querySelector('[data-f=volts]');
  [['any', t('dryc.ignored', 'Ignored')], ['below', t('common.below', 'Below')], ['above', t('common.above', 'Above')]].forEach(function (o) {
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
    ? t('dryc.voltHint', 'Checked by the device together with the inputs. It reacts once the voltage has stayed past the threshold for a few seconds.')
    : !state.device ? t('dryc.voltNeedsDevice', 'Needs a device on this station that runs logger firmware {loggerMin} and dry contact interface firmware {drycMin}.', { loggerMin: LOGGER_FW_MIN, drycMin: DRYC_FW_MIN })
    : t('dryc.voltNeedsFw', 'Needs logger firmware {loggerMin} and dry contact interface firmware {drycMin}. This device reports {logger} and {dryc}.', {
      loggerMin: loggerMin(), drycMin: DRYC_FW_MIN,
      logger: cap.logger || t('dryc.noLoggerVersion', 'no logger version'), dryc: cap.dryc || t('dryc.noDrycVersion', 'no interface version') });
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
  var acts = h('<div class="ts-field"><div class="ts-field-label"><span>' + esc(t('dryc.then', 'Then')) + '</span></div>' +
    '<label class="ts-switch"><input type="checkbox" data-f="relay1"> <span></span></label>' +
    '<label class="ts-switch"><input type="checkbox" data-f="relay2"> <span></span></label>' +
    '<label class="ts-switch"><input type="checkbox" data-f="notify"> <span>' + esc(t('dryc.raiseAlarm', 'Raise an alarm on this station')) + '</span></label>' +
    '<div class="ts-ctl ts-dryc-sev"><span class="ts-row-meta">' + esc(t('common.severity', 'Severity')) + '</span><select class="ts-select" data-f="severity"></select></div>' +
    '<div class="ts-field-hint">' + esc(t('dryc.alarmHint', 'The alarm is notified to the station’s alarm contacts and clears when the rule stops matching.')) + '</div></div>');
  acts.querySelectorAll('.ts-switch span')[0].textContent = t('dryc.switchOn', 'Switch {relay} on', { relay: relayLabel(0) });
  acts.querySelectorAll('.ts-switch span')[1].textContent = t('dryc.switchOn', 'Switch {relay} on', { relay: relayLabel(1) });
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
  var wording = h('<div class="ts-field ts-dryc-wording"><div class="ts-field-label"><span>' + esc(t('dryc.alarmWording', 'Alarm wording')) + '</span></div>' +
    '<div class="ts-ctl"><span class="ts-row-meta">' + esc(t('dryc.whenActive', 'When active')) + '</span><input class="ts-input wide" data-f="whenActive" maxlength="80"></div>' +
    '<div class="ts-ctl"><span class="ts-row-meta">' + esc(t('dryc.whenInactive', 'When inactive')) + '</span><input class="ts-input wide" data-f="whenInactive" maxlength="80"></div>' +
    '<div class="ts-field-hint">' + esc(t('dryc.wordingHint', 'The value the alarm and its message show. Left empty, it reads as the condition, each input at its other state when inactive.')) + '</div></div>');
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
    countEl.textContent = t('dryc.recordCount', 'The device holds {max} records: one per relay switched and one per alarm. These rules use {n}.', { max: MAX_RECORDS, n: nrec });
    countEl.classList.toggle('ts-error', nrec > MAX_RECORDS);
    activeIn.placeholder = conditionText(state.rules, read()) || t('dryc.ruleCondition', 'the rule’s condition');
    inactiveIn.placeholder = conditionText(state.rules, read(), true) || t('dryc.ruleConditionInverted', 'the rule’s condition, inverted');
  }
  count();
  var primary = ui.drawerActions(dr, creating ? t('dryc.addRule', 'Add rule') : t('common.save', 'Save'));
  primary.addEventListener('click', function () {
    var x = read(), volts = Number(voltsIn.value);
    var problem = !x.name ? t('dryc.needName', 'Give the rule a name.')
      : vop() !== 'any' && !(volts >= 0.1 && volts <= 60) ? t('dryc.needVolts', 'Give a supply voltage from 0.1 to 60 V.')
      : x.condition.voltage && !cap.voltage ? t('dryc.cannotVolts', 'This device cannot check the supply voltage: set it to Ignored.')
      : !x.condition.mask && !x.condition.voltage ? t('dryc.needCondition', 'Set at least one input or the supply voltage.')
      : !(x.relays.relay1 || x.relays.relay2 || x.notify) ? t('dryc.needAction', 'Pick what the rule does: a relay, an alarm or both.')
      : records(draftSet()).length > MAX_RECORDS ? t('dryc.tooManyRecords', 'That needs more than {max} records on the device.', { max: MAX_RECORDS })
      : null;
    if (problem) { ui.toast(problem, 'error'); return; }
    commit(draftSet(), creating ? t('dryc.ruleAdded', 'Rule added') : t('dryc.ruleSaved', 'Rule saved'));
  });
}

function namesDrawer(kind, i) {
  var isInput = kind === 'input';
  var dr = ui.openDrawer(isInput ? inputName(i) : relayName(i),
    isInput ? t('dryc.inputDrawerHint', 'What is wired to it on site') : t('dryc.relayDrawerHint', 'What it switches on site'));
  var cur = isInput ? state.rules.inputs[i] : state.rules.relays[i];
  dr.body.appendChild(h('<div class="ts-field"><div class="ts-field-label"><span>' + esc(t('common.name', 'Name')) + '</span></div><div class="ts-ctl"><input class="ts-input wide" data-f="label" maxlength="40"></div>' +
    (isInput ? '<div class="ts-field-hint">' + esc(t('dryc.inputNameHint', 'Leave it empty when nothing is wired: the input is then not used nor recorded.')) + '</div>' : '') + '</div>'));
  if (isInput) {
    dr.body.appendChild(h('<div class="ts-field"><div class="ts-field-label"><span>' + esc(t('dryc.wordingOn', 'Wording when on')) + '</span></div><div class="ts-ctl"><input class="ts-input wide" data-f="whenOn" maxlength="30" placeholder="' + esc(t('common.on', 'On')) + '"></div></div>'));
    dr.body.appendChild(h('<div class="ts-field"><div class="ts-field-label"><span>' + esc(t('dryc.wordingOff', 'Wording when off')) + '</span></div><div class="ts-ctl"><input class="ts-input wide" data-f="whenOff" maxlength="30" placeholder="' + esc(t('common.off', 'Off')) + '"></div>' +
      '<div class="ts-field-hint">' + esc(t('dryc.wordingHintIo', 'Shown on the rules and in the station’s charts, e.g. "Fault" and "OK".')) + '</div></div>'));
  }
  dr.body.querySelectorAll('[data-f]').forEach(function (n) { n.value = cur[n.dataset.f] || ''; });
  ui.drawerActions(dr, t('common.save', 'Save')).addEventListener('click', function () {
    var set = clone(state.rules);
    var target = isInput ? set.inputs[i] : set.relays[i];
    dr.body.querySelectorAll('[data-f]').forEach(function (n) { target[n.dataset.f] = n.value.trim(); });
    commit(set, t('dryc.nameSaved', 'Name saved'));
  });
}

// -- load -------------------------------------------------------------------------------

function refresh() {
  if (!state.station) { return Promise.resolve(); }
  return load().then(render).catch(function (err) { ui.toast(t('common.refreshFailed', 'Refresh failed: {error}', { error: errText(err) }), 'error'); });
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
  if (!ds || ds.entityType !== 'ASSET') { fail(t('dryc.openFromStation', 'Open the dry contact interface from its station.')); return; }
  return tb.loadEntity(ds).then(function (station) {
    if (station.kind !== 'Station') { fail(t('dryc.notStation', 'This view shows a station; {name} is a {kind}.', { name: station.name, kind: station.kind })); return null; }
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
}).catch(function (err) { fail(t('common.loadFailed', 'Could not load: {error}', { error: errText(err) })); });

};
