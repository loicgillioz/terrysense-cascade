/*
 * Settings — the CA-2/CA-3 widget. One widget type, bound to a CUSTOMER,
 * PROJECT or STATION, or on the device branch to a DEVICE or a DeviceDefaults
 * asset: shows only what is set on that entity, grouped into measurements,
 * notifications and retention, and edits it in side panels. A device has
 * alarm limits on its own source keys and retention only (CONFIG_CASCADE.md §1).
 * Every save re-resolves the stations or devices it reaches (CONFIG_RESOLVER.md §5).
 *
 * Loads after shared/resolver.js, glossary.js, ui.js, tb_io.js and calculations.js; styles are
 * shared/theme.css. Design: logr-product-docs/cloud/CASCADE_EDITOR.md.
 */

window.TerrySenseConfigOverrides = function (ctx, container) {

var resolver = window.TerrySenseResolver;
var G = window.TerrySenseGlossary;
var tb = window.TerrySenseTbIo(ctx);
var io = tb.io;
var root = container.querySelector('.ts-root') || container;
var ui = window.TerrySenseUi(root);
var calc = window.TerrySenseCalculations(ui, tb);
var h = ui.h, esc = ui.esc, ICON = ui.ICON, info = ui.info, sevDot = ui.sevDot;

var CH = resolver.CHANNEL_PREFIX;
var E164 = /^\+[1-9]\d{6,14}$/;
var EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// The settings this widget edits outside the per-measurement ones.
var SCALARS = [
  { key: 'config.notify.contacts', label: 'Measurement alarm contacts', section: 'notifications', type: 'contacts', tip: 'contacts' },
  { key: 'config.notify.deviceContacts', label: 'Device alarm contacts', section: 'notifications', type: 'contacts', tip: 'deviceContacts' },
  { key: 'config.sms.enabled', label: 'SMS', section: 'notifications', type: 'bool', tip: 'channels' },
  { key: 'config.email.enabled', label: 'E-mail', section: 'notifications', type: 'bool', tip: 'channels' },
  { key: 'config.alarmText.created', label: 'Message when an alarm starts', section: 'notifications', type: 'text', tip: 'alarmText', sms: true },
  { key: 'config.emailText.created', label: 'E-mail when an alarm starts', section: 'notifications', type: 'text', nestedIn: 'config.alarmText.created' },
  { key: 'config.alarmText.cleared', label: 'Message when an alarm ends', section: 'notifications', type: 'text', tip: 'alarmText', sms: true },
  { key: 'config.emailText.cleared', label: 'E-mail when an alarm ends', section: 'notifications', type: 'text', nestedIn: 'config.alarmText.cleared' },
  { key: 'config.language', label: 'Message language', section: 'notifications', type: 'lang' },
  { key: 'config.ttlDays', label: 'Keep data for', section: 'retention', type: 'days', tip: 'retention' }
];
var ALL_SECTIONS = [['notifications', 'Notifications'], ['retention', 'Data retention']];
var SECTIONS = ALL_SECTIONS;

var state = {
  origin: null, own: {}, ancestors: [], names: {}, kinds: {}, channelKinds: {},
  stationCount: 0, readOnly: true, showInherited: false, customerId: null, users: null, defaultsShared: true,
  deviceBranch: false, sourceKeys: [], calcMeta: { names: {}, attributes: {} }
};

// -- values and lookups ------------------------------------------------------

function parseVal(v) {
  if (typeof v === 'string' && /^\s*[\[{]/.test(v)) { try { return JSON.parse(v); } catch (e) { return v; } }
  return v;
}

function nearest(key) {
  for (var i = 0; i < state.ancestors.length; i++) {
    var v = state.ancestors[i].attrs[key];
    if (v !== undefined && v !== null) { return { value: parseVal(v), from: state.ancestors[i].level }; }
  }
  return null;
}

// An alarm text left to the in-terra defaults comes from their catalogue, in
// this level's language (ALARMING.md §4); the resolver does the same.
function inherited(key) {
  var hit = nearest(key);
  var m = /^config\.((alarmText|emailText)\..+)$/.exec(key);
  if (!m || (hit && hit.from.role !== 'defaults')) { return hit; }
  var defaults = state.ancestors.filter(function (a) { return a.level.role === 'defaults'; })[0];
  if (!defaults) { return hit; }
  var lang = ownVal('config.language') || (nearest('config.language') || {}).value || resolver.DEFAULT_LANGUAGE;
  var text = ((parseVal(defaults.attrs['config.' + resolver.TEXT_CATALOGUE_KEY]) || {})[lang] || {})[m[1]];
  return text ? { value: text, from: defaults.level } : hit;
}

function levelLabel(level) { return resolver.levelDisplay(level); }
function ownVal(key) { return parseVal(state.own[key]); }
function isOwn(key) { return state.own[key] !== undefined && state.own[key] !== null; }

// A channel is a station key: a name, or `<name>-<n>` for one instance of a
// repeatable name. Its dictionary entry is the name's (measurement/vocabulary.md §3).
// On the device branch a channel is a device source key (`logr.batteryVoltage`,
// `p0.voltage`); its entry is the vocabulary name after its prefix.
function nameOf(ch) { return ch.indexOf('.') >= 0 ? ch.split('.').pop() : resolver.splitChannelKey(ch).name; }
function entryOf(ch) { return state.names[nameOf(ch)] || {}; }
function channelKind(ch) {
  return entryOf(ch).kind || state.channelKinds[ch] || (ch.indexOf('.') >= 0 ? resolver.deviceKeyKind(ch, state.names) : null);
}
function kindSpec(ch) { return resolver.kindSpec(channelKind(ch), state.kinds) || {}; }
function alarmClass(ch) { return kindSpec(ch).alarm || 'numeric'; }
function chLabel(ch) {
  if (ch.indexOf('.') >= 0) { return entryOf(ch).label || ch; }
  var split = resolver.splitChannelKey(ch);
  var label = entryOf(ch).label || split.name;
  return split.instance ? label + ' ' + split.instance : label;
}
function kindLabel(ch) { return kindSpec(ch).label || channelKind(ch) || 'Unknown kind'; }

function unitOf(ch, draftUnit) {
  if (draftUnit) { return draftUnit; }
  if (isOwn(CH + ch + '.unit')) { return ownVal(CH + ch + '.unit'); }
  var hit = inherited(CH + ch + '.unit');
  return hit ? hit.value : (entryOf(ch).unit || kindSpec(ch).cloudUnit || '');
}

// Thresholds and hysteresis are stored in the kind's cloudUnit and read and
// entered in the channel's display unit.
function shown(ch, v, draftUnit) { return resolver.toDisplay(Number(v), channelKind(ch), unitOf(ch, draftUnit), state.kinds); }
function stored(ch, v, draftUnit) { return resolver.fromDisplay(Number(v), channelKind(ch), unitOf(ch, draftUnit), state.kinds); }

function stateText(ch, v) {
  if (alarmClass(ch) === 'boolean') {
    var f = CH + ch + '.' + (v === true || v === 'true' || v === 1 ? 'textWhenTrue' : 'textWhenFalse');
    if (isOwn(f)) { return ownVal(f); }
    var hit = inherited(f);
    return hit ? hit.value : String(v === true || v === 'true' || v === 1);
  }
  var states = entryOf(ch).states || {};
  return states[String(v)] !== undefined ? states[String(v)] : String(v);
}

// Every per-channel key this widget manages.
var ALARM_RE = /^alarm\.([a-z]+)\.(thresholdMax|thresholdMin|state)$/;
var FIELDS = ['label', 'unit', 'hysteresis', 'textWhenTrue', 'textWhenFalse'];
// The channel may hold dots on the device branch, so the field is matched from the end.
var KEY_RE = /^channel\.(.+?)\.(alarm\.[a-z]+\.(?:thresholdMax|thresholdMin|state)|label|unit|hysteresis|textWhenTrue|textWhenFalse)$/;
function parseKey(key) {
  var m = KEY_RE.exec(key);
  if (!m) { return null; }
  var a = ALARM_RE.exec(m[2]);
  if (a && G.rank(a[1]) >= 0) {
    return { channel: m[1], field: m[2], sev: a[1], dir: { thresholdMax: 'above', thresholdMin: 'below', state: 'is' }[a[2]] };
  }
  return FIELDS.indexOf(m[2]) >= 0 ? { channel: m[1], field: m[2], sev: null, dir: null } : null;
}
function condKey(ch, sev, dir) {
  return CH + ch + '.alarm.' + sev + '.' + (dir === 'is' ? 'state' : dir === 'above' ? 'thresholdMax' : 'thresholdMin');
}

function channelsWith(attrs) {
  var out = {};
  Object.keys(attrs).forEach(function (k) {
    var p = parseKey(k);
    if (p && attrs[k] !== null && attrs[k] !== undefined) { (out[p.channel] = out[p.channel] || []).push(k); }
  });
  return out;
}

// -- skeleton ------------------------------------------------------------------

root.innerHTML = '';
var cardEl = h('<div class="ts-card"><div class="ts-head"><div class="ts-head-icon">' + ICON.settings + '</div><div class="ts-head-text">' +
  '<div class="ts-title">Settings ' + info('cascade') + '</div><div class="ts-subtitle"></div></div><span class="ts-chip level" hidden></span></div>' +
  '<div class="ts-body"><div class="ts-loading">Loading…</div></div>' +
  '<div class="ts-foot" hidden><span class="ts-foot-left"></span><span class="ts-spacer"></span>' +
  '<label class="ts-switch ts-summary"><input type="checkbox" class="ts-show-inh"> Show inherited</label></div></div>');
root.appendChild(cardEl);
var bodyEl = cardEl.querySelector('.ts-body');
var footEl = cardEl.querySelector('.ts-foot');
cardEl.querySelector('.ts-show-inh').addEventListener('change', function (e) { state.showInherited = e.target.checked; render(); });

function fail(text) {
  bodyEl.innerHTML = '';
  bodyEl.appendChild(h('<div class="ts-empty"></div>')).textContent = text;
}

// -- load ------------------------------------------------------------------------

function load() {
  // The contacts' phone numbers and addresses stay off a public link.
  if (tb.isPublicView()) { fail('Settings are not shown on a public link.'); return Promise.resolve(); }
  return tb.boundDatasource().then(function (ds) {
    if (!ds) { fail('No entity bound — bind a customer, project, station or device in the widget\'s Data tab.'); return; }
    return tb.loadEntity(ds).then(function (origin) {
      state.origin = origin;
      state.deviceBranch = origin.entityType === 'DEVICE' || origin.kind === resolver.DEVICE_DEFAULTS_KIND;
      SECTIONS = state.deviceBranch ? ALL_SECTIONS.filter(function (x) { return x[0] === 'retention'; }) : ALL_SECTIONS;
      return Promise.all([
        resolver.buildChain(origin, io), io.fetchAttrs(origin),
        state.deviceBranch ? Promise.resolve({ channels: {}, stations: [] }) : resolver.discoverChannels(origin, io),
        tb.canWrite(origin), state.deviceBranch ? sourceKeysOf(origin) : Promise.resolve([])
      ]);
    }).then(function (got) {
      var chain = got[0];
      state.own = got[1];
      state.channelKinds = got[2].channels;
      state.stationCount = got[2].stations.length;
      state.sourceKeys = got[4];
      state.readOnly = !got[3];
      var customer = chain.filter(function (l) { return l.role === 'customer'; })[0];
      state.customerId = state.origin.entityType === 'CUSTOMER' ? state.origin.id : (customer ? customer.id : null);
      var levels = chain.slice(1);
      return Promise.all(levels.map(function (l) { return io.fetchAttrs(l); })).then(function (attrs) {
        state.ancestors = levels.map(function (l, i) { return { level: l, attrs: attrs[i] || {} }; });
        var defaults = chain[0].role === 'defaults' ? { level: chain[0], attrs: state.own }
          : state.ancestors.filter(function (a) { return a.level.role === 'defaults'; })[0];
        state.defaultsShared = !!defaults;
        state.names = parseVal((defaults || { attrs: {} }).attrs['config.channelNames']) || {};
        state.kinds = parseVal((defaults || { attrs: {} }).attrs['config.kinds']) || {};
        state.calcMeta = { names: state.names, attributes: parseVal((defaults || { attrs: {} }).attrs['config.calcAttributes']) || {} };
        renderHead();
        render();
      });
    });
  }).catch(function (err) { fail('Could not load: ' + (err && err.message ? err.message : err)); });
}

function renderHead() {
  var next = state.ancestors[0];
  cardEl.querySelector('.ts-subtitle').textContent = state.origin.name +
    (next ? ' · inherits from ' + (next.level.role === 'defaults' ? 'in-terra defaults' : next.level.name) : '');
  var chip = cardEl.querySelector('.ts-chip.level');
  chip.hidden = false;
  chip.textContent = state.origin.kind;
  cardEl.classList.toggle('ts-readonly', state.readOnly);
  footEl.hidden = false;
  var left = footEl.querySelector('.ts-foot-left');
  left.innerHTML = '';
  if (state.readOnly) {
    left.appendChild(h('<span class="ts-summary">Read only</span>'));
  } else {
    var add = h('<button type="button" class="ts-btn primary">' + ICON.plus + 'Add setting</button>');
    add.addEventListener('click', openAdd);
    left.appendChild(add);
  }
}

/** The source keys a device reports — for a DeviceDefaults asset, those of a
 * few devices of its profile. Provenance and fault keys carry no limit. */
function sourceKeysOf(origin) {
  var skip = /^(uplinkCause|uplinkLatest|rssi|snr)$|\.status$/;
  var devices = origin.entityType === 'DEVICE' ? Promise.resolve([origin])
    : (io.fetchProfileDevices ? io.fetchProfileDevices(origin.name) : Promise.resolve([])).then(function (l) { return l.slice(0, 8); });
  return devices.then(function (list) {
    return Promise.all(list.map(function (d) {
      return tb.get('/api/plugins/telemetry/DEVICE/' + d.id + '/keys/timeseries').catch(function () { return []; });
    }));
  }).then(function (lists) {
    var seen = {};
    lists.forEach(function (l) { (l || []).forEach(function (k) { if (!skip.test(k)) { seen[k] = true; } }); });
    return Object.keys(seen).sort();
  });
}

// -- main list ---------------------------------------------------------------------

function chip(html, tip) { return '<span class="ts-chip"' + (tip ? ' data-tip="' + esc(tip) + '"' : '') + '>' + html + '</span>'; }

function channelChips(ch, keys, source) {
  var unit = unitOf(ch);
  var conds = keys.map(parseKey).filter(function (p) { return p.sev; }).sort(function (a, b) {
    if (a.dir === 'is' || b.dir === 'is') { return (a.dir === 'is') - (b.dir === 'is') || G.rank(b.sev) - G.rank(a.sev); }
    return Number(source(condKey(ch, a.sev, a.dir))) - Number(source(condKey(ch, b.sev, b.dir)));
  }).map(function (p) {
    var v = source(condKey(ch, p.sev, p.dir));
    var s = G.severity(p.sev);
    var txt = p.dir === 'is' ? '= ' + esc(stateText(ch, v)) : (p.dir === 'above' ? '&gt; ' : '&lt; ') + esc(shown(ch, v)) + ' ' + esc(unit);
    return chip(sevDot(p.sev) + txt, s.label + ': ' + s.desc);
  });
  var has = function (f) { return keys.indexOf(CH + ch + '.' + f) >= 0; };
  if (has('unit')) { conds.push(chip('unit ' + esc(source(CH + ch + '.unit')))); }
  if (has('hysteresis')) { conds.push(chip('± ' + esc(shown(ch, source(CH + ch + '.hysteresis'))) + ' ' + esc(unit))); }
  if (has('textWhenTrue')) { conds.push(chip('true = ' + esc(source(CH + ch + '.textWhenTrue')))); }
  if (has('textWhenFalse')) { conds.push(chip('false = ' + esc(source(CH + ch + '.textWhenFalse')))); }
  if (has('label')) { conds.push(chip('“' + esc(source(CH + ch + '.label')) + '”', 'Name in alarm messages')); }
  return conds.join('');
}

function fmtScalar(def, v) {
  if (def.type === 'contacts') { return Array.isArray(v) ? (v.length === 1 ? '1 contact' : v.length + ' contacts') : ''; }
  if (def.type === 'bool') { return v === true || v === 'true' ? 'On' : 'Off'; }
  if (def.type === 'days' || def.type === 'hours') { return esc(v) + ' ' + def.type; }
  if (def.type === 'lang') { return esc(G.LANGUAGES[v] || v); }
  if (def.type === 'text') { var t = String(v); return '<i>“' + esc(t.slice(0, 38)) + (t.length > 38 ? '…' : '') + '”</i>'; }
  return esc(v);
}

function emptyLine(what) {
  var el = h('<div class="ts-empty">Nothing set here, all inherited.' + (state.readOnly ? '' : ' <a>Add</a>') + '</div>');
  var a = el.querySelector('a');
  if (a) { a.addEventListener('click', function () { if (what === 'measurement') { openMeasurementPicker(false); } else { openScalar(what, false); } }); }
  return el;
}

function render() {
  bodyEl.innerHTML = '';
  if (!state.defaultsShared) {
    bodyEl.appendChild(h('<div class="ts-banner warn">' + ICON.info + '<span>The in-terra defaults are not shared with this customer, so tenant defaults and the measurement names do not load. A tenant admin shares the “Shared defaults” group.</span></div>'));
  }

  var sec = h('<div class="ts-section"><div class="ts-section-head">Measurements ' + info('measurements') + '</div></div>');
  var own = channelsWith(state.own);
  Object.keys(own).sort(function (a, b) { return chLabel(a).localeCompare(chLabel(b)); }).forEach(function (ch) {
    var row = h('<div class="ts-row" tabindex="0"><div class="ts-row-main"><div class="ts-row-label"></div><div class="ts-row-meta"></div></div>' +
      '<div class="ts-row-value">' + channelChips(ch, own[ch], ownVal) + '</div>' +
      (state.readOnly ? '' : '<div class="ts-row-actions"><button type="button" class="ts-icon-btn" title="Edit">' + ICON.edit + '</button></div>') + '</div>');
    row.querySelector('.ts-row-label').textContent = chLabel(ch);
    row.querySelector('.ts-row-meta').textContent = kindLabel(ch);
    if (!state.readOnly) { row.addEventListener('click', function () { openChannel(ch, false); }); }
    sec.appendChild(row);
  });
  if (state.showInherited) {
    var inh = {};
    state.ancestors.forEach(function (a) {
      var byCh = channelsWith(a.attrs);
      Object.keys(byCh).forEach(function (ch) {
        if (own[ch]) { return; }
        byCh[ch].forEach(function (k) { if ((inh[ch] = inh[ch] || []).indexOf(k) < 0) { inh[ch].push(k); } });
      });
    });
    Object.keys(inh).sort(function (a, b) { return chLabel(a).localeCompare(chLabel(b)); }).forEach(function (ch) {
      var from = inherited(inh[ch][0]).from;
      var row = h('<div class="ts-row inherited"><div class="ts-row-main"><div class="ts-row-label"></div><div class="ts-row-meta"></div></div>' +
        '<div class="ts-row-value">' + channelChips(ch, inh[ch], function (k) { var x = inherited(k); return x ? x.value : ''; }) + '</div>' +
        (state.readOnly ? '' : '<div class="ts-row-actions"><button type="button" class="ts-btn ghost">Change here</button></div>') + '</div>');
      row.querySelector('.ts-row-label').textContent = chLabel(ch);
      row.querySelector('.ts-row-meta').textContent = 'from ' + levelLabel(from);
      if (!state.readOnly) { row.querySelector('.ts-btn').addEventListener('click', function () { openChannel(ch, false); }); }
      sec.appendChild(row);
    });
  }
  if (!sec.querySelector('.ts-row')) { sec.appendChild(emptyLine('measurement')); }
  bodyEl.appendChild(sec);
  if (state.origin.kind === 'Station') { renderCalculations(); }

  SECTIONS.forEach(function (s) {
    var el = h('<div class="ts-section"><div class="ts-section-head">' + s[1] + ' ' + info(s[0]) + '</div></div>');
    SCALARS.filter(function (d) { return d.section === s[0]; }).forEach(function (d) {
      var mine = isOwn(d.key);
      var hit = inherited(d.key);
      if (!mine && !(state.showInherited && hit)) { return; }
      var v = mine ? ownVal(d.key) : hit.value;
      var meta = mine
        ? (hit ? 'replaces ' + (d.type === 'text' ? 'the wording' : fmtScalar(d, hit.value).replace(/<[^>]+>/g, '')) + ' from ' + levelLabel(hit.from) : '')
        : 'from ' + levelLabel(hit.from);
      var row = h('<div class="ts-row' + (mine ? '' : ' inherited') + '" tabindex="0"><div class="ts-row-main"><div class="ts-row-label"></div>' +
        '<div class="ts-row-meta"></div></div><div class="ts-row-value">' + fmtScalar(d, v) + '</div>' +
        (state.readOnly ? '' : mine
          ? '<div class="ts-row-actions"><button type="button" class="ts-icon-btn" data-act="reset" title="Reset to inherited">' + ICON.reset + '</button>' +
            '<button type="button" class="ts-icon-btn" title="Edit">' + ICON.edit + '</button></div>'
          : '<div class="ts-row-actions"><button type="button" class="ts-btn ghost">Change here</button></div>') + '</div>');
      row.querySelector('.ts-row-label').textContent = d.label;
      row.querySelector('.ts-row-meta').textContent = meta;
      if (!meta) { row.querySelector('.ts-row-meta').remove(); }
      if (!state.readOnly) {
        row.addEventListener('click', function (e) {
          if (e.target.closest('[data-act=reset]')) { e.stopPropagation(); resetScalar(d); return; }
          openScalar(d.section, false);
        });
      }
      el.appendChild(row);
    });
    if (!el.querySelector('.ts-row')) { el.appendChild(emptyLine(s[0])); }
    bodyEl.appendChild(el);
  });
}

// -- calculated measurements (measurement/vocabulary.md §4) ---------------------------

function calcOwnAttributes(name) { return ((state.names[name] || {}).calculated || {}).attributes || []; }
function calcAttrName(attr) { return (state.calcMeta.attributes[attr] || {}).label || attr; }
function calcInputs(name) {
  return (((state.names[name] || {}).calculated || {}).channels || []).map(function (c) { return calc.channelLabel(state.calcMeta, state.own, c); });
}

function renderCalculations() {
  var plan = resolver.calculationPlan(state.own, state.names);
  if (!plan.length) { return; }
  var sec = h('<div class="ts-section ts-calc"><div class="ts-section-head">Calculated measurements</div></div>');
  plan.forEach(function (p) {
    var set = p.reads.filter(function (a) { return state.own[resolver.CALC_PREFIX + a] != null; }).map(function (a) {
      var spec = state.calcMeta.attributes[a] || {};
      return calcAttrName(a) + ' ' + state.own[resolver.CALC_PREFIX + a] + (spec.unit ? ' ' + spec.unit : '');
    });
    var meta = [(state.names[p.name] || {}).description].concat(p.reads.length ? set : ['Automatic from ' + calc.listText(calcInputs(p.name))]);
    var editable = !state.readOnly && p.reads.length > 0;
    var row = h('<div class="ts-row' + (editable ? '' : ' static') + '"' + (editable ? ' tabindex="0"' : '') + ' data-calc-name="' + esc(p.name) + '">' +
      '<div class="ts-row-main"><div class="ts-row-label"></div><div class="ts-row-meta"></div></div><div class="ts-row-value"></div></div>');
    row.querySelector('.ts-row-label').textContent = calc.channelLabel(state.calcMeta, state.own, p.name);
    row.querySelector('.ts-row-meta').textContent = meta.filter(Boolean).join(' · ');
    var badge = row.querySelector('.ts-row-value').appendChild(h('<span class="ts-chip ' + (p.on ? 'accent' : 'warn') + '"></span>'));
    badge.textContent = p.on ? 'On' : 'Needs ' + calc.listText(p.needs.map(calcAttrName));
    if (editable) { row.addEventListener('click', function () { openCalculation(p, plan); }); }
    sec.appendChild(row);
  });
  bodyEl.appendChild(sec);
}

function openCalculation(p, plan) {
  var station = state.origin, label = calc.channelLabel(state.calcMeta, state.own, p.name);
  var dr = ui.openDrawer('Calculated measurement', esc(station.name));
  var intro = h('<p class="ts-calc-intro"></p>');
  var desc = (state.names[p.name] || {}).description;
  intro.textContent = (desc ? desc + '. ' : '') + 'Calculated from ' + calc.listText(calcInputs(p.name)) +
    ' and the setting' + (p.reads.length > 1 ? 's' : '') + ' below.';
  dr.body.appendChild(intro);
  var form = calc.form(station, state.own, p.reads, state.calcMeta);
  dr.body.appendChild(form.el);
  dr.body.appendChild(h('<div class="ts-field-hint">Values are calculated from the latest reading on; earlier readings are not recalculated.</div>'));
  var save = ui.drawerActions(dr, p.needs.length ? 'Turn on' : 'Save');
  function sync() { save.disabled = !form.values(); }
  form.onChange(sync);
  sync();
  save.addEventListener('click', function () {
    save.disabled = true;
    calc.save(station, form.values()).then(function () {
      ui.closeDrawer();
      ui.toast(p.needs.length ? label + ' is on' : 'Saved');
      return load();
    }).catch(function (err) {
      save.disabled = false;
      ui.toast('Save failed: ' + (err && (err.message || (err.error && err.error.message)) || err), 'error');
    });
  });
  var own = calcOwnAttributes(p.name);
  if (own.length && own.every(function (a) { return state.own[resolver.CALC_PREFIX + a] != null; })) {
    var off = h('<button type="button" class="ts-btn" data-a="turn-off">Turn off</button>');
    dr.foot.insertBefore(off, dr.foot.firstChild);
    off.addEventListener('click', function () {
      var goes = plan.filter(function (q) {
        return q.on && q.reads.some(function (a) { return own.indexOf(a) >= 0; });
      }).map(function (q) { return calc.channelLabel(state.calcMeta, state.own, q.name); });
      ui.confirm('Turn off <b>' + esc(calc.listText(goes)) + '</b> on ' + esc(station.name) + '? The values stored so far are kept.', 'Turn off')
        .then(function (ok) {
          if (!ok) { return; }
          off.disabled = true;
          return calc.clear(station, own).then(function () {
            ui.closeDrawer();
            ui.toast(label + ' is off');
            return load();
          });
        }).catch(function (err) {
          off.disabled = false;
          ui.toast('Save failed: ' + (err && (err.message || (err.error && err.error.message)) || err), 'error');
        });
    });
  }
  form.focus();
}

// -- saving ------------------------------------------------------------------------

/** Write `write`, delete `remove` on the bound entity, re-resolve every station
 * below; asks first when more than one station is affected. */
function commit(write, remove, what, button) {
  if (button) { button.disabled = true; }
  var noun = state.deviceBranch ? 'device' : 'station';
  return resolver.affectedStations(state.origin, io).then(function (stations) {
    var n = stations.length;
    var ask = n > 1
      ? ui.confirm('This changes <b>' + esc(what) + '</b> for <b>' + n + ' ' + noun + 's</b> under ' + esc(state.origin.name) + '.', 'Apply to ' + n + ' ' + noun + 's')
      : Promise.resolve(true);
    return ask.then(function (ok) {
      if (!ok) { if (button) { button.disabled = false; } return; }
      return tb.saveAttrs(state.origin, write)
        .then(function () { return tb.deleteAttrs(state.origin, remove.filter(isOwn)); })
        .then(function () { return tb.resolveStations(stations); })
        .then(function () {
          ui.closeDrawer();
          ui.toast(n === 0 ? 'Saved' : n === 1 ? '1 ' + noun + ' updated' : n + ' ' + noun + 's updated');
          return load();
        });
    });
  }).catch(function (err) {
    if (button) { button.disabled = false; }
    ui.toast('Save failed: ' + (err && (err.message || (err.error && err.error.message)) || err), 'error');
  });
}

function resetScalar(d) {
  var hit = inherited(d.key);
  ui.confirm('Reset <b>' + esc(d.label) + '</b> to ' + (hit ? 'the value inherited from ' + esc(levelLabel(hit.from)) : 'nothing (not set anywhere above)') + '?', 'Reset')
    .then(function (ok) { if (ok) { commit({}, [d.key], d.label); } });
}

// -- add ----------------------------------------------------------------------------

function openAdd() {
  var dr = ui.openDrawer('Add setting', esc(state.origin.kind + ' · ' + state.origin.name));
  var tiles = h('<div class="ts-tiles"></div>');
  [['measurement', ICON.gauge, 'Measurement', state.deviceBranch ? 'Alarm limits on one of the device\'s own readings'
     : 'Alarm thresholds or conditions, unit and hysteresis for one measurement'],
   ['notifications', ICON.bell, 'Notifications', 'Contacts for measurement and device alarms, SMS and e-mail on or off, message wording, language'],
   ['retention', ICON.archive, 'Data retention', 'How long measured data is kept']].filter(function (t) {
    return !state.deviceBranch || t[0] !== 'notifications';
  }).forEach(function (t) {
    var el = h('<button type="button" class="ts-tile"><span class="ts-tile-icon">' + t[1] + '</span><span><b>' + t[2] + '</b><span>' + t[3] + '</span></span></button>');
    el.addEventListener('click', function () { if (t[0] === 'measurement') { openMeasurementPicker(true); } else { openScalar(t[0], true); } });
    tiles.appendChild(el);
  });
  dr.body.appendChild(tiles);
}

function openMeasurementPicker(fromAdd) {
  if (state.deviceBranch) { openSourcePicker(fromAdd); return; }
  var dr = ui.openDrawer('Choose a measurement', 'Grouped by kind');
  if (fromAdd) { dr.onBack(openAdd); }
  var own = channelsWith(state.own);
  dr.body.appendChild(ui.namePicker({
    names: state.names,
    kinds: state.kinds,
    allowKind: function (spec) { return !spec || spec.alarm !== 'none'; },
    inUse: Object.keys(state.channelKinds).map(function (k) { return resolver.splitChannelKey(k).name; }),
    badge: function (n) { return own[n] ? '<span class="ts-chip">set here</span>' : ''; },
    onPick: function (n) { openChannel(n, fromAdd); }
  }));
  // A name sets every instance at once; an instance key overrides one of them.
  var instances = Object.keys(state.channelKinds).filter(function (k) { return resolver.splitChannelKey(k).instance; })
    .sort(function (a, b) { return a.localeCompare(b, undefined, { numeric: true }); });
  if (instances.length) {
    dr.body.appendChild(h('<div class="ts-subhead">One instance only</div>'));
    instances.forEach(function (k) {
      var o = ui.nameOption(k, { label: chLabel(k), description: 'Overrides ' + chLabel(resolver.splitChannelKey(k).name) + ' for this instance' },
        own[k] ? '<span class="ts-chip">set here</span>' : '', '');
      o.addEventListener('click', function () { openChannel(k, fromAdd); });
      dr.body.appendChild(o);
    });
  }
}

/** The device branch: pick one of the device's own source keys, the LOGR's
 * diagnostics included — they are what a device alarm is about. */
function openSourcePicker(fromAdd) {
  var dr = ui.openDrawer('Choose a reading', esc(state.origin.name));
  if (fromAdd) { dr.onBack(openAdd); }
  var own = channelsWith(state.own);
  var keys = state.sourceKeys.slice();
  Object.keys(own).forEach(function (k) { if (keys.indexOf(k) < 0) { keys.push(k); } });
  if (!keys.length) { dr.body.appendChild(h('<div class="ts-empty">No reading stored yet.</div>')); return; }
  keys.sort().forEach(function (k) {
    var o = ui.nameOption(k, { label: chLabel(k), description: kindLabel(k) }, own[k] ? '<span class="ts-chip">set here</span>' : '', '');
    o.addEventListener('click', function () { openChannel(k, fromAdd); });
    dr.body.appendChild(o);
  });
}

function openChannel(ch, fromAdd) {
  var cls = alarmClass(ch);
  var dr = ui.openDrawer(esc(chLabel(ch)), esc(kindLabel(ch)) + ' · <span class="ts-mono">' + esc(ch) + '</span>');
  if (fromAdd) { dr.onBack(function () { openMeasurementPicker(true); }); }
  if (cls === 'numeric') { numericEditor(ch, dr); } else { conditionEditor(ch, dr, cls === 'boolean'); }
}

// A text field bound to one per-channel key, with its inherited value as placeholder.
function unitChoices(ch) {
  var spec = kindSpec(ch);
  var others = Object.keys(spec.units || {}).filter(function (u) { return u !== spec.cloudUnit; });
  return others.length ? '; also ' + others.join(', ') : '';
}

function channelTextField(ch, field, label, tip, draft, onChange) {
  var key = CH + ch + '.' + field;
  var hit = inherited(key);
  var el = h('<div class="ts-field"><div class="ts-field-label"><span></span> ' + info(tip) + '<button type="button" class="ts-reset" hidden>Reset to inherited</button></div>' +
    '<input class="ts-input wide"><div class="ts-field-hint"></div></div>');
  el.querySelector('.ts-field-label span').textContent = label;
  var input = el.querySelector('input'), reset = el.querySelector('.ts-reset');
  input.value = draft[field] || '';
  input.placeholder = hit ? String(hit.value) : (field === 'label' ? chLabel(ch) : field === 'unit' ? (kindSpec(ch).cloudUnit || '') : '');
  el.querySelector('.ts-field-hint').textContent = hit ? 'Inherited: ' + hit.value + ' from ' + levelLabel(hit.from)
    : field === 'label' ? 'Standard name: ' + chLabel(ch) : field === 'unit' ? 'Standard unit: ' + (kindSpec(ch).cloudUnit || 'none') + unitChoices(ch) : '';
  function sync() { reset.hidden = !draft[field]; if (onChange) { onChange(); } }
  input.addEventListener('input', function () { draft[field] = input.value.trim(); sync(); });
  reset.addEventListener('click', function () { draft[field] = ''; input.value = ''; sync(); });
  reset.hidden = !draft[field];
  return el;
}

// Debounce (ALARMING.md §2.5): consecutive triggering readings before an alarm
// is announced. One value for the measurement, written to every severity.
function debKey(ch, sev) { return CH + ch + '.alarm.' + sev + '.debounce'; }

function debounceField(ch, draft, onChange) {
  G.SEVERITIES.some(function (sv) { if (isOwn(debKey(ch, sv.id))) { draft.debounce = String(ownVal(debKey(ch, sv.id))); return true; } return false; });
  var hit = null;
  G.SEVERITIES.some(function (sv) { hit = inherited(debKey(ch, sv.id)); return !!hit; });
  var el = h('<div class="ts-field ts-debounce"><div class="ts-field-label">Confirm after ' + info('debounce') + '<button type="button" class="ts-reset" hidden>Reset to inherited</button></div>' +
    '<span><input class="ts-input num" type="number" step="1" min="1"> readings in a row</span><div class="ts-field-hint"></div><div class="ts-field-error"></div></div>');
  var input = el.querySelector('input'), reset = el.querySelector('.ts-reset');
  input.value = draft.debounce || '';
  input.placeholder = hit ? String(hit.value) : '1';
  el.querySelector('.ts-field-hint').textContent = hit ? 'Inherited: ' + hit.value + ' from ' + levelLabel(hit.from) : 'Not set above: the first reading alarms';
  reset.hidden = !draft.debounce;
  function check() {
    var bad = draft.debounce !== '' && !(Number(draft.debounce) >= 1 && Math.floor(Number(draft.debounce)) === Number(draft.debounce));
    el.querySelector('.ts-field-error').textContent = bad ? 'A whole number of readings, 1 or more.' : '';
    return !bad;
  }
  input.addEventListener('input', function () { draft.debounce = input.value; reset.hidden = draft.debounce === ''; onChange(); });
  reset.addEventListener('click', function () { draft.debounce = ''; input.value = ''; reset.hidden = true; onChange(); });
  el.valid = check;
  return el;
}

function debounceWrites(ch, draft, write, remove) {
  G.SEVERITIES.forEach(function (sv) {
    if (draft.debounce !== '' && draft.debounce !== undefined) { write[debKey(ch, sv.id)] = Number(draft.debounce); } else { remove.push(debKey(ch, sv.id)); }
  });
}

function numericEditor(ch, dr) {
  var draft = { conds: [], unit: '', hysteresis: '', label: '', debounce: '' };
  G.SEVERITIES.forEach(function (s) { ['above', 'below'].forEach(function (dir) {
    var k = condKey(ch, s.id, dir);
    if (isOwn(k)) { draft.conds.push({ sev: s.id, dir: dir, value: String(shown(ch, ownVal(k))) }); }
  }); });
  ['unit', 'hysteresis', 'label'].forEach(function (f) { if (isOwn(CH + ch + '.' + f)) { draft[f] = String(ownVal(CH + ch + '.' + f)); } });
  if (draft.hysteresis !== '') { draft.hysteresis = String(shown(ch, draft.hysteresis)); }

  var thr = h('<div class="ts-field"><div class="ts-field-label">Alarm thresholds ' + info('thresholds') + '</div><div class="ts-scale"></div>' +
    '<div class="ts-thr-list"></div><button type="button" class="ts-btn ghost ts-thr-add">' + ICON.plus + 'Add threshold</button><div class="ts-field-error"></div></div>');
  var hyst = h('<div class="ts-field"><div class="ts-field-label">Hysteresis ' + info('hysteresis') + '<button type="button" class="ts-reset" hidden>Reset to inherited</button></div>' +
    '<span><input class="ts-input num" type="number" step="any" min="0"> <span class="ts-thr-unit"></span></span><div class="ts-field-hint"></div><div class="ts-field-error"></div></div>');
  dr.body.appendChild(thr);
  dr.body.appendChild(channelTextField(ch, 'unit', 'Display unit', 'unit', draft, function () { renderList(); hyst.querySelector('.ts-thr-unit').textContent = unitOf(ch, draft.unit); }));
  dr.body.appendChild(hyst);
  var deb = debounceField(ch, draft, function () { validate(); });
  dr.body.appendChild(deb);
  dr.body.appendChild(channelTextField(ch, 'label', 'Name in messages', 'label', draft));

  var hystKey = CH + ch + '.hysteresis', hystHit = inherited(hystKey);
  var hystInput = hyst.querySelector('input'), hystReset = hyst.querySelector('.ts-reset');
  hystInput.value = draft.hysteresis;
  hystInput.placeholder = hystHit ? String(shown(ch, hystHit.value)) : '0';
  hyst.querySelector('.ts-thr-unit').textContent = unitOf(ch, draft.unit);
  hyst.querySelector('.ts-field-hint').textContent = hystHit ? 'Inherited: ' + shown(ch, hystHit.value) + ' from ' + levelLabel(hystHit.from) : 'Not set above: no margin';
  hystReset.hidden = draft.hysteresis === '';
  hystInput.addEventListener('input', function () { draft.hysteresis = hystInput.value; hystReset.hidden = draft.hysteresis === ''; validate(); });
  hystReset.addEventListener('click', function () { draft.hysteresis = ''; hystInput.value = ''; hystReset.hidden = true; validate(); });

  var list = thr.querySelector('.ts-thr-list'), msg = thr.querySelector('.ts-field-error');
  var save = ui.drawerActions(dr);

  thr.querySelector('.ts-thr-add').addEventListener('click', function () {
    var taken = draft.conds.map(function (d) { return d.sev + d.dir; });
    draft.conds.push({ sev: 'indeterminate', dir: taken.indexOf('indeterminateabove') >= 0 ? 'below' : 'above', value: '' });
    renderList();
    var inputs = list.querySelectorAll('.ts-thr-val');
    if (inputs.length) { inputs[inputs.length - 1].focus(); }
  });

  function inheritedConds() {
    var out = [];
    G.SEVERITIES.forEach(function (s) { ['above', 'below'].forEach(function (dir) {
      var hit = inherited(condKey(ch, s.id, dir));
      if (hit) { out.push({ sev: s.id, dir: dir, value: shown(ch, hit.value, draft.unit), from: hit.from }); }
    }); });
    return out;
  }
  function shadowed(t) { return draft.conds.some(function (d) { return d.sev === t.sev && d.dir === t.dir; }); }

  function renderList() {
    list.innerHTML = '';
    var u = unitOf(ch, draft.unit);
    draft.conds.forEach(function (d, i) {
      var row = h('<div class="ts-thr"><select class="ts-select ts-dir"><option value="above">Above</option><option value="below">Below</option></select>' +
        '<input class="ts-input num ts-thr-val" type="number" step="any"><span class="ts-thr-unit"></span>' +
        '<span class="ts-sev-select">' + sevDot(d.sev) + '<select class="ts-select ts-sev">' +
        G.SEVERITIES.slice().reverse().map(function (s) { return '<option value="' + s.id + '">' + s.label + '</option>'; }).join('') +
        '</select>' + info('severity') + '</span><button type="button" class="ts-icon-btn ts-thr-rm" title="Remove">' + ICON.close + '</button></div>');
      var dirSel = row.querySelector('.ts-dir'), sevSel = row.querySelector('.ts-sev'), val = row.querySelector('.ts-thr-val');
      dirSel.value = d.dir; sevSel.value = d.sev; val.value = d.value;
      row.querySelector('.ts-thr-unit').textContent = u;
      dirSel.addEventListener('change', function () { d.dir = dirSel.value; renderList(); });
      sevSel.addEventListener('change', function () { d.sev = sevSel.value; renderList(); });
      val.addEventListener('input', function () { d.value = val.value; renderScale(); validate(); });
      row.querySelector('.ts-thr-rm').addEventListener('click', function () { draft.conds.splice(i, 1); renderList(); });
      list.appendChild(row);
    });
    var inh = inheritedConds();
    inh.forEach(function (t) {
      var s = G.severity(t.sev);
      var row = h('<div class="ts-thr inherited' + (shadowed(t) ? ' shadowed' : '') + '"><span class="ts-thr-static">' + (t.dir === 'above' ? 'Above' : 'Below') + '</span>' +
        '<span class="ts-thr-static" style="text-align:right">' + esc(t.value) + '</span><span class="ts-thr-unit">' + esc(u) + '</span>' +
        '<span class="ts-sev-select">' + sevDot(t.sev) + esc(s.label) + '</span><span></span><span class="ts-thr-from"></span></div>');
      row.querySelector('.ts-thr-from').textContent = shadowed(t) ? 'replaced here' : 'inherited from ' + levelLabel(t.from);
      list.appendChild(row);
    });
    if (!draft.conds.length && !inh.length) { list.appendChild(h('<div class="ts-empty">No threshold: this measurement never raises an alarm.</div>')); }
    renderScale();
    validate();
  }

  function effective() {
    var eff = draft.conds.filter(function (d) { return d.value !== '' && isFinite(Number(d.value)); })
      .map(function (d) { return { sev: d.sev, dir: d.dir, value: Number(d.value) }; });
    inheritedConds().forEach(function (t) { if (!shadowed(t)) { eff.push(t); } });
    return eff;
  }

  function renderScale() {
    var sc = thr.querySelector('.ts-scale');
    var eff = effective();
    sc.hidden = !eff.length;
    if (!eff.length) { sc.innerHTML = ''; return; }
    var vals = eff.map(function (t) { return t.value; });
    var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
    var pad = (hi - lo) * 0.25 || Math.abs(hi) * 0.2 || 1;
    lo -= pad; hi += pad;
    function x(v) { return ((v - lo) / (hi - lo) * 100).toFixed(2) + '%'; }
    var zones = eff.slice().sort(function (a, b) { return G.rank(a.sev) - G.rank(b.sev); }).map(function (t) {
      var pos = t.dir === 'above' ? 'left:' + x(t.value) + ';right:0' : 'left:0;right:calc(100% - ' + x(t.value) + ')';
      return '<div class="ts-scale-zone" style="' + pos + ';background:var(--sev-' + t.sev + ')"></div>';
    }).join('');
    var ticks = eff.map(function (t) {
      return '<div class="ts-scale-tick" style="left:' + x(t.value) + ';background:var(--sev-' + t.sev + ')"></div>' +
        '<div class="ts-scale-label" style="left:' + x(t.value) + '">' + esc(t.value) + '</div>';
    }).join('');
    sc.innerHTML = '<div class="ts-scale-track">' + zones + '</div>' + ticks;
  }

  function validate() {
    var seen = {}, err = '';
    draft.conds.forEach(function (d) {
      if (seen[d.sev + d.dir]) { err = 'Only one ' + G.severity(d.sev).label + ' threshold ' + d.dir + ' per measurement.'; }
      seen[d.sev + d.dir] = true;
      if (d.value === '' || !isFinite(Number(d.value))) { err = err || 'Enter a value for every threshold.'; }
    });
    var eff = effective();
    eff.forEach(function (a) { eff.forEach(function (b) {
      if (a.dir !== b.dir || a.sev === 'indeterminate' || b.sev === 'indeterminate' || G.rank(a.sev) <= G.rank(b.sev)) { return; }
      if ((a.dir === 'above' && a.value < b.value) || (a.dir === 'below' && a.value > b.value)) {
        err = err || G.severity(a.sev).label + ' should be reached after ' + G.severity(b.sev).label + ', not before.';
      }
    }); });
    var hystErr = draft.hysteresis !== '' && !(Number(draft.hysteresis) >= 0) ? 'Hysteresis is an absolute margin: zero or positive.' : '';
    var units = Object.keys(kindSpec(ch).units || {});
    if (draft.unit && units.length && units.indexOf(draft.unit) < 0) {
      err = err || 'Display unit ' + draft.unit + ' is not one of ' + units.join(', ') + '.';
    }
    msg.textContent = err;
    hyst.querySelector('.ts-field-error').textContent = hystErr;
    save.disabled = !!(err || hystErr) || !deb.valid();
  }

  save.addEventListener('click', function () {
    var write = {}, remove = [];
    G.SEVERITIES.forEach(function (s) { ['above', 'below'].forEach(function (dir) { remove.push(condKey(ch, s.id, dir)); }); });
    draft.conds.forEach(function (d) { write[condKey(ch, d.sev, d.dir)] = stored(ch, d.value, draft.unit); });
    if (draft.unit) { write[CH + ch + '.unit'] = draft.unit; } else { remove.push(CH + ch + '.unit'); }
    if (draft.hysteresis !== '') { write[hystKey] = stored(ch, draft.hysteresis, draft.unit); } else { remove.push(hystKey); }
    if (draft.label) { write[CH + ch + '.label'] = draft.label; } else { remove.push(CH + ch + '.label'); }
    debounceWrites(ch, draft, write, remove);
    commit(write, remove.filter(function (k) { return !(k in write); }), chLabel(ch), save);
  });
  renderList();
}

function conditionEditor(ch, dr, isBool) {
  var draft = { conds: [], textWhenTrue: '', textWhenFalse: '', label: '', debounce: '' };
  G.SEVERITIES.forEach(function (s) {
    var k = condKey(ch, s.id, 'is');
    if (isOwn(k)) { draft.conds.push({ sev: s.id, value: ownVal(k) }); }
  });
  ['textWhenTrue', 'textWhenFalse', 'label'].forEach(function (f) { if (isOwn(CH + ch + '.' + f)) { draft[f] = String(ownVal(CH + ch + '.' + f)); } });

  function values() {
    if (isBool) { return [true, false]; }
    return Object.keys(entryOf(ch).states || {}).map(Number).sort(function (a, b) { return a - b; });
  }
  function label(v) {
    if (!isBool) { return stateText(ch, v); }
    var f = v === true || v === 'true' ? 'textWhenTrue' : 'textWhenFalse';
    if (draft[f]) { return draft[f]; }
    var hit = inherited(CH + ch + '.' + f);
    return hit ? hit.value : String(v === true || v === 'true');
  }
  function parse(v) { return isBool ? v === 'true' : Number(v); }

  var sec = h('<div class="ts-field"><div class="ts-field-label">Alarm when ' + info(isBool ? 'boolAlarm' : 'stateAlarm') + '</div>' +
    '<div class="ts-thr-list"></div><button type="button" class="ts-btn ghost">' + ICON.plus + 'Add condition</button><div class="ts-field-error"></div></div>');
  dr.body.appendChild(sec);
  var list = sec.querySelector('.ts-thr-list'), msg = sec.querySelector('.ts-field-error');
  var addBtn = sec.querySelector('.ts-btn');
  if (!values().length) {
    addBtn.hidden = true;
    list.appendChild(h('<div class="ts-empty">This measurement declares no states, so no condition can be set. A tenant admin adds them in the peripheral catalog.</div>'));
  }

  if (isBool) {
    var ws = h('<div class="ts-field"><div class="ts-field-label">Wording ' + info('boolText') + '</div><div class="ts-wording">' +
      '<label>When true (1)<input class="ts-input wide" data-f="textWhenTrue"></label><label>When false (0)<input class="ts-input wide" data-f="textWhenFalse"></label></div></div>');
    ws.querySelectorAll('input').forEach(function (inp) {
      var f = inp.getAttribute('data-f');
      var hit = inherited(CH + ch + '.' + f);
      inp.placeholder = hit ? hit.value + ' (inherited)' : (f === 'textWhenTrue' ? 'true' : 'false');
      inp.value = draft[f];
      inp.addEventListener('input', function () { draft[f] = inp.value.trim(); renderList(); });
    });
    dr.body.appendChild(ws);
  }
  var deb = debounceField(ch, draft, function () { validate(); });
  dr.body.appendChild(deb);
  dr.body.appendChild(channelTextField(ch, 'label', 'Name in messages', 'label', draft));
  var save = ui.drawerActions(dr);

  addBtn.addEventListener('click', function () {
    var used = draft.conds.map(function (d) { return d.sev; });
    var free = G.SEVERITIES.map(function (s) { return s.id; }).filter(function (id) { return used.indexOf(id) < 0; });
    if (!free.length) { return; }
    draft.conds.push({ sev: free[0], value: values()[0] });
    renderList();
  });

  function renderList() {
    if (!values().length) { validate(); return; }
    list.innerHTML = '';
    draft.conds.forEach(function (d, i) {
      var row = h('<div class="ts-thr ts-thr-state"><span class="ts-thr-static">Is</span><select class="ts-select ts-val"></select>' +
        '<span class="ts-sev-select">' + sevDot(d.sev) + '<select class="ts-select ts-sev">' +
        G.SEVERITIES.slice().reverse().map(function (s) { return '<option value="' + s.id + '">' + s.label + '</option>'; }).join('') +
        '</select>' + info('severity') + '</span><button type="button" class="ts-icon-btn ts-thr-rm" title="Remove">' + ICON.close + '</button></div>');
      var valSel = row.querySelector('.ts-val'), sevSel = row.querySelector('.ts-sev');
      values().forEach(function (v) {
        var o = document.createElement('option');
        o.value = String(v); o.textContent = label(v);
        valSel.appendChild(o);
      });
      valSel.value = String(d.value);
      sevSel.value = d.sev;
      valSel.addEventListener('change', function () { d.value = parse(valSel.value); validate(); });
      sevSel.addEventListener('change', function () { d.sev = sevSel.value; renderList(); });
      row.querySelector('.ts-thr-rm').addEventListener('click', function () { draft.conds.splice(i, 1); renderList(); });
      list.appendChild(row);
    });
    var any = false;
    G.SEVERITIES.forEach(function (s) {
      var hit = inherited(condKey(ch, s.id, 'is'));
      if (!hit) { return; }
      any = true;
      var sh = draft.conds.some(function (d) { return d.sev === s.id; });
      var row = h('<div class="ts-thr ts-thr-state inherited' + (sh ? ' shadowed' : '') + '"><span class="ts-thr-static">Is</span><span class="ts-thr-static"></span>' +
        '<span class="ts-sev-select">' + sevDot(s.id) + esc(s.label) + '</span><span></span><span class="ts-thr-from"></span></div>');
      row.querySelectorAll('.ts-thr-static')[1].textContent = label(hit.value);
      row.querySelector('.ts-thr-from').textContent = sh ? 'replaced here' : 'inherited from ' + levelLabel(hit.from);
      list.appendChild(row);
    });
    if (!draft.conds.length && !any) { list.appendChild(h('<div class="ts-empty">No condition: this measurement never raises an alarm.</div>')); }
    validate();
  }

  function validate() {
    var seen = {}, err = '';
    draft.conds.forEach(function (d) {
      if (seen[d.sev]) { err = 'Only one ' + G.severity(d.sev).label + ' condition per measurement.'; }
      seen[d.sev] = true;
    });
    msg.textContent = err;
    save.disabled = !!err || !deb.valid();
  }

  save.addEventListener('click', function () {
    var write = {}, remove = [];
    G.SEVERITIES.forEach(function (s) { remove.push(condKey(ch, s.id, 'is')); });
    draft.conds.forEach(function (d) { write[condKey(ch, d.sev, 'is')] = d.value; });
    ['textWhenTrue', 'textWhenFalse', 'label'].forEach(function (f) {
      if (draft[f]) { write[CH + ch + '.' + f] = draft[f]; } else { remove.push(CH + ch + '.' + f); }
    });
    debounceWrites(ch, draft, write, remove);
    commit(write, remove.filter(function (k) { return !(k in write); }), chLabel(ch), save);
  });
  renderList();
}

// -- notifications and retention -------------------------------------------------------

function openScalar(section, fromAdd) {
  var title = SECTIONS.filter(function (x) { return x[0] === section; })[0][1];
  var needsUsers = section === 'notifications' && state.users === null;
  var ready = needsUsers
    ? tb.listUsers(state.customerId).then(function (u) { state.users = u; }).catch(function () { state.users = []; })
    : Promise.resolve();
  ready.then(function () {
    var dr = ui.openDrawer(title, esc(state.origin.kind + ' · ' + state.origin.name));
    if (fromAdd) { dr.onBack(openAdd); }
    var draft = {};
    var defs = SCALARS.filter(function (d) { return d.section === section; });
    defs.forEach(function (d) { if (isOwn(d.key)) { draft[d.key] = JSON.parse(JSON.stringify(ownVal(d.key))); } });
    if (section === 'notifications' && state.ancestors.length) {
      var b = h('<div class="ts-banner">' + ICON.info + '<span></span></div>');
      b.querySelector('span').textContent = 'Only what you change here replaces the inherited settings; everything else keeps coming from ' +
        levelLabel(state.ancestors[0].level) + '. A list you change here replaces the whole inherited list.';
      dr.body.appendChild(b);
    }
    defs.filter(function (d) { return !d.nestedIn; }).forEach(function (d) { dr.body.appendChild(scalarField(d, draft)); });
    var save = ui.drawerActions(dr);
    function checkValidity() { save.disabled = !!dr.body.querySelector('[data-invalid="1"]'); }
    dr.body.addEventListener('validity', checkValidity);
    checkValidity();
    save.addEventListener('click', function () {
      var write = {}, remove = [];
      defs.forEach(function (d) { if (d.key in draft) { write[d.key] = draft[d.key]; } else { remove.push(d.key); } });
      commit(write, remove, title.toLowerCase(), save);
    });
  });
}

function tokenChips(ta, onChange) {
  var box = h('<div class="ts-tokens"></div>');
  G.TOKENS.forEach(function (t) {
    var c = h('<button type="button" class="ts-chip"></button>');
    c.textContent = '+ ' + t.label;
    c.title = 'Insert ' + t.token;
    c.addEventListener('click', function () {
      var at = ta.selectionStart === undefined ? ta.value.length : ta.selectionStart;
      ta.value = ta.value.slice(0, at) + t.token + ta.value.slice(ta.selectionEnd || at);
      onChange(); ta.focus();
    });
    box.appendChild(c);
  });
  return box;
}

function scalarField(d, draft) {
  var hit = inherited(d.key);
  var f = h('<div class="ts-field"><div class="ts-field-label"><span></span> ' + (d.tip ? info(d.tip) : '') +
    '<button type="button" class="ts-reset" hidden>Reset to inherited</button></div><div class="ts-ctl"></div><div class="ts-field-hint"></div></div>');
  f.querySelector('.ts-field-label span').textContent = d.label;
  var ctl = f.querySelector('.ts-ctl'), hint = f.querySelector('.ts-field-hint'), reset = f.querySelector('.ts-reset');

  function current() { return d.key in draft ? draft[d.key] : (hit ? hit.value : null); }
  function setValid(ok) {
    f.dataset.invalid = ok ? '' : '1';
    f.dispatchEvent(new Event('validity', { bubbles: true }));
  }
  function sync() {
    reset.hidden = !(d.key in draft);
    hint.textContent = d.key in draft
      ? (hit ? 'Replaces ' + (d.type === 'text' || d.type === 'contacts' ? 'the inherited ' + (d.type === 'text' ? 'wording' : 'list') : fmtScalar(d, hit.value).replace(/<[^>]+>/g, '')) + ' from ' + levelLabel(hit.from) : 'Set here')
      : (hit ? 'Inherited from ' + levelLabel(hit.from) : d.type === 'bool' ? 'Not set anywhere above: off' : 'Not set anywhere above');
  }
  function set(v) { draft[d.key] = v; sync(); }
  reset.addEventListener('click', function () { delete draft[d.key]; build(); sync(); setValid(true); });

  function build() {
    ctl.innerHTML = '';
    var v = current();
    if (d.type === 'bool') {
      var sw = h('<label class="ts-switch"><input type="checkbox"> <span></span></label>');
      var cb = sw.querySelector('input');
      cb.checked = v === true || v === 'true';
      sw.querySelector('span').textContent = cb.checked ? 'On' : 'Off';
      cb.addEventListener('change', function () { sw.querySelector('span').textContent = cb.checked ? 'On' : 'Off'; set(cb.checked); });
      ctl.appendChild(sw);
    } else if (d.type === 'contacts') {
      ctl.appendChild(contactsEditor(Array.isArray(v) ? v : [], set, setValid));
    } else if (d.type === 'text') {
      textEditor(d, draft, v, set, setValid, ctl);
    } else if (d.type === 'lang') {
      var sel = h('<select class="ts-select"></select>');
      Object.keys(G.LANGUAGES).forEach(function (k) {
        var o = document.createElement('option'); o.value = k; o.textContent = G.LANGUAGES[k]; sel.appendChild(o);
      });
      sel.value = v || 'en';
      sel.addEventListener('change', function () { set(sel.value); });
      ctl.appendChild(sel);
    } else if (d.type === 'days' || d.type === 'hours') {
      var n = h('<span><input class="ts-input num" type="number" min="1" step="1"> ' + d.type + '</span>');
      var inp = n.querySelector('input');
      inp.value = v === null ? '' : v;
      inp.addEventListener('input', function () {
        var ok = /^\d+$/.test(inp.value) && Number(inp.value) >= 1;
        if (ok) { set(Number(inp.value)); }
        setValid(ok);
      });
      ctl.appendChild(n);
    }
  }
  build(); sync();
  return f;
}

function textEditor(d, draft, v, set, setValid, ctl) {
  var ta = h('<textarea class="ts-textarea"></textarea>');
  ta.value = v || '';
  var counter = d.sms ? h('<div class="ts-sms-count"></div>') : null;
  function count() {
    if (!counter) { return; }
    var si = G.smsInfo(ta.value);
    var over = si.parts > si.maxParts;
    counter.className = 'ts-sms-count' + (over ? ' over' : si.parts > 1 ? ' warn' : '');
    counter.innerHTML = '≈ ' + si.len + ' / ' + si.single + ' characters · ' +
      (over ? 'too long: at most ' + si.maxParts + ' SMS' : si.parts === 1 ? '1 SMS' : 'sent as ' + si.parts + ' SMS') +
      (si.gsm ? '' : ' · special characters, 70 per SMS') + ' ' + info('smsLength');
    setValid(!over);
  }
  function changed() { set(ta.value); count(); }
  ta.addEventListener('input', changed);
  ctl.appendChild(ta);
  ctl.appendChild(tokenChips(ta, changed));
  if (counter) { ctl.appendChild(counter); count(); }

  var nested = SCALARS.filter(function (x) { return x.nestedIn === d.key; })[0];
  if (!nested) { return; }
  var nHit = inherited(nested.key);
  var adv = h('<details class="ts-adv"><summary>Longer text for e-mail</summary><div class="ts-adv-body">' +
    '<textarea class="ts-textarea" style="min-height:110px"></textarea><div class="ts-field-hint"></div></div></details>');
  var nta = adv.querySelector('textarea');
  nta.value = nested.key in draft ? draft[nested.key] : '';
  nta.placeholder = nHit ? 'Inherited e-mail text from ' + levelLabel(nHit.from) : 'Empty: the e-mail uses the SMS text above';
  adv.querySelector('.ts-field-hint').textContent = 'No length limit. Leave empty to send the SMS text by e-mail too.';
  if (nta.value) { adv.open = true; }
  function nset() { if (nta.value.trim()) { draft[nested.key] = nta.value; } else { delete draft[nested.key]; } }
  nta.addEventListener('input', nset);
  adv.querySelector('.ts-adv-body').insertBefore(tokenChips(nta, nset), adv.querySelector('.ts-field-hint'));
  ctl.appendChild(adv);
}

function userById(id) { return (state.users || []).filter(function (u) { return u.id && u.id.id === id; })[0]; }
function userName(u) { return [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email; }
function initials(n) { return String(n || '?').split(/[\s@.]+/).map(function (w) { return w.charAt(0); }).join('').slice(0, 2).toUpperCase(); }

function contactsEditor(initial, set, setValid) {
  var people = JSON.parse(JSON.stringify(initial));
  var box = h('<div></div>');
  var picking = false;
  function allSev() { return G.SEVERITIES.map(function (s) { return s.id; }); }
  function problems() {
    return people.some(function (c) {
      if (c.type === 'user') { return false; }
      return (c.sms && !E164.test(c.sms)) || (c.email && !EMAIL.test(c.email));
    });
  }
  function commitPeople() {
    set(people.filter(function (c) { return c.type === 'user' || c.name || c.sms || c.email; }));
    setValid(!problems());
  }

  function sevToggles(c) {
    var sevs = h('<div class="ts-sevs"></div>');
    G.SEVERITIES.slice().reverse().forEach(function (sv) {
      var t = h('<button type="button" class="ts-sev-toggle">' + sevDot(sv.id) + esc(sv.label) + '</button>');
      t.classList.toggle('on', c.severities.indexOf(sv.id) >= 0);
      t.addEventListener('click', function () {
        var k = c.severities.indexOf(sv.id);
        if (k >= 0) { c.severities.splice(k, 1); } else { c.severities.push(sv.id); }
        t.classList.toggle('on', k < 0);
        commitPeople();
      });
      sevs.appendChild(t);
    });
    return sevs;
  }

  function render() {
    box.innerHTML = '';
    people.forEach(function (c, i) {
      c.severities = c.severities || allSev();
      var head = h('<div class="ts-contact-head"><span class="ts-summary">Receives</span> ' + info('severity') +
        '<span class="ts-spacer"></span><button type="button" class="ts-icon-btn" title="Remove contact">' + ICON.close + '</button></div>');
      var el;
      if (c.type === 'user') {
        var u = userById(c.userId);
        el = h('<div class="ts-contact"><div class="ts-contact-user"><span class="ts-avatar"></span><div class="ts-grow"><div class="ts-row-label"></div>' +
          '<div class="ts-row-meta"></div></div><span class="ts-chip">Platform user</span></div><div class="ts-contact-via"></div></div>');
        if (!u) {
          el.querySelector('.ts-avatar').textContent = '?';
          el.querySelector('.ts-row-label').textContent = 'Unknown user';
          el.querySelector('.ts-row-meta').textContent = 'No longer exists, or not visible to you; no message reaches it.';
        } else {
          el.querySelector('.ts-avatar').textContent = initials(userName(u));
          el.querySelector('.ts-row-label').textContent = userName(u);
          el.querySelector('.ts-row-meta').textContent = [u.email, u.phone].filter(Boolean).join(' · ') +
            (u.phone && !E164.test(u.phone) ? ' — phone not in international format, SMS will fail' : '');
          var via = el.querySelector('.ts-contact-via');
          [['viaSms', 'SMS', !!u.phone], ['viaEmail', 'E-mail', !!u.email]].forEach(function (x) {
            var lab = h('<label class="ts-switch' + (x[2] ? '' : ' off') + '"' + (x[2] || x[0] !== 'viaSms' ? '' : ' data-tip="noPhone"') + '><input type="checkbox"> ' + x[1] + '</label>');
            var cb = lab.querySelector('input');
            cb.disabled = !x[2];
            cb.checked = !!c[x[0]] && x[2];
            cb.addEventListener('change', function () { c[x[0]] = cb.checked; commitPeople(); });
            via.appendChild(lab);
          });
        }
      } else {
        el = h('<div class="ts-contact"><div class="ts-contact-grid"><input class="ts-input" data-f="name" placeholder="Name or role">' +
          '<input class="ts-input" data-f="sms" placeholder="SMS: +41 79 123 45 67"><input class="ts-input" data-f="email" placeholder="E-mail: name@example.ch"></div>' +
          '<div class="ts-field-error"></div></div>');
        var err = el.querySelector('.ts-field-error');
        var check = function () {
          err.textContent = c.sms && !E164.test(c.sms) ? 'SMS number must be international: + country code, no spaces (e.g. +41791234567).'
            : c.email && !EMAIL.test(c.email) ? 'Not a valid e-mail address.' : '';
        };
        el.querySelectorAll('[data-f]').forEach(function (inp) {
          var fld = inp.getAttribute('data-f');
          inp.value = c[fld] || '';
          inp.addEventListener('input', function () {
            c[fld] = fld === 'sms' ? inp.value.replace(/\s+/g, '') : inp.value.trim();
            check(); commitPeople();
          });
        });
        check();
      }
      el.appendChild(head);
      el.appendChild(sevToggles(c));
      head.querySelector('.ts-icon-btn').addEventListener('click', function () { people.splice(i, 1); commitPeople(); render(); });
      box.appendChild(el);
    });

    if (picking) {
      var taken = people.filter(function (c) { return c.type === 'user'; }).map(function (c) { return c.userId; });
      var pick = h('<div class="ts-user-pick"><div class="ts-search">' + ICON.search + '<input class="ts-input" placeholder="Search users"></div><div></div></div>');
      var q = pick.querySelector('input'), ul = pick.lastChild;
      var fill = function () {
        ul.innerHTML = '';
        (state.users || []).filter(function (u) {
          return taken.indexOf(u.id.id) < 0 && (userName(u) + ' ' + u.email).toLowerCase().indexOf(q.value.toLowerCase()) >= 0;
        }).forEach(function (u) {
          var o = h('<div class="ts-opt" tabindex="0"><span class="ts-avatar"></span><div class="ts-opt-main"><div class="ts-opt-label"></div><div class="ts-opt-desc"></div></div></div>');
          o.querySelector('.ts-avatar').textContent = initials(userName(u));
          o.querySelector('.ts-opt-label').textContent = userName(u);
          o.querySelector('.ts-opt-desc').textContent = u.email + (u.phone ? ' · ' + u.phone : ' · no phone');
          o.addEventListener('click', function () {
            people.push({ type: 'user', userId: u.id.id, viaSms: !!u.phone, viaEmail: true, severities: allSev() });
            picking = false; commitPeople(); render();
          });
          ul.appendChild(o);
        });
        if (!ul.children.length) { ul.appendChild(h('<div class="ts-empty">No other user.</div>')); }
      };
      q.addEventListener('input', fill);
      fill();
      box.appendChild(pick);
      setTimeout(function () { q.focus(); }, 0);
    }

    var add = h('<div class="ts-add-row"><button type="button" class="ts-btn ghost" data-a="user">' + ICON.plus + 'Platform user</button>' +
      '<button type="button" class="ts-btn ghost" data-a="ext">' + ICON.plus + 'External contact</button></div>');
    add.querySelector('[data-a=user]').addEventListener('click', function () { picking = !picking; render(); });
    add.querySelector('[data-a=ext]').addEventListener('click', function () {
      picking = false;
      people.push({ type: 'external', name: '', sms: '', email: '', severities: allSev() });
      render();
      var ins = box.querySelectorAll('.ts-contact [data-f=name]');
      ins[ins.length - 1].focus();
    });
    box.appendChild(add);
  }
  render();
  setValid(!problems());
  return box;
}

load();

};
