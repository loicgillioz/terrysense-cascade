/*
 * Settings — the CA-2/CA-3 widget. One widget type, bound to a CUSTOMER,
 * PROJECT or STATION, or on the device branch to a DEVICE or a DeviceDefaults
 * asset: shows only what is set on that entity, grouped into measurements,
 * notifications and retention, and edits it in side panels. A device has
 * alarm limits on its own source keys and retention only (CONFIG_CASCADE.md §1).
 * Every save re-resolves the stations or devices it reaches (CONFIG_RESOLVER.md §5).
 * A customer, and the DEFAULTS asset for the tenant, also show the owner's
 * address book (CA-20); a customer or project row a lower level replaces
 * carries a badge (CA-21).
 *
 * Loads after shared/resolver.js, glossary.js, ui.js, tb_io.js and calculations.js; styles are
 * shared/theme.css. Design: logr-product-docs/cloud/CASCADE_EDITOR.md.
 */

window.TerrySenseConfigOverrides = function (ctx, container, opts) {

opts = opts || {};
var t = window.TerrySenseI18n(ctx);

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
  { key: 'config.notify.contacts', label: t('glossary.setting.contacts', 'Measurement alarm contacts'), section: 'notifications', type: 'contacts', tip: 'contacts' },
  { key: 'config.notify.deviceContacts', label: t('glossary.setting.deviceContacts', 'Device alarm contacts'), section: 'notifications', type: 'contacts', tip: 'deviceContacts' },
  { key: 'config.sms.enabled', label: t('glossary.setting.smsEnabled', 'SMS'), section: 'notifications', type: 'bool', tip: 'channels' },
  { key: 'config.email.enabled', label: t('glossary.setting.emailEnabled', 'E-mail'), section: 'notifications', type: 'bool', tip: 'channels' },
  { key: 'config.alarmText.created', label: t('glossary.setting.alarmTextCreated', 'Message when an alarm starts'), section: 'notifications', type: 'text', tip: 'alarmText', sms: true },
  { key: 'config.emailText.created', label: t('glossary.setting.emailTextCreated', 'E-mail when an alarm starts'), section: 'notifications', type: 'text', nestedIn: 'config.alarmText.created' },
  { key: 'config.alarmText.cleared', label: t('glossary.setting.alarmTextCleared', 'Message when an alarm ends'), section: 'notifications', type: 'text', tip: 'alarmText', sms: true },
  { key: 'config.emailText.cleared', label: t('glossary.setting.emailTextCleared', 'E-mail when an alarm ends'), section: 'notifications', type: 'text', nestedIn: 'config.alarmText.cleared' },
  { key: 'config.language', label: t('glossary.setting.language', 'Message language'), section: 'notifications', type: 'lang' },
  { key: 'config.ttlDays', label: t('glossary.setting.ttlDays', 'Keep data for'), section: 'retention', type: 'days', tip: 'retention' }
];
// [id, title, the title inside a sentence]
var ALL_SECTIONS = [
  ['notifications', t('settings.notifications', 'Notifications'), t('settings.notificationsInline', 'notifications')],
  ['retention', t('settings.retention', 'Data retention'), t('settings.retentionInline', 'data retention')]
];
var SECTIONS = ALL_SECTIONS;
var LIST_KEYS = ['config.notify.contacts', 'config.notify.deviceContacts'];
var BOOK = resolver.CONTACT_BOOK_KEY;
var BOOK_NAME = 'terrySense contact book';
// Assets that never hold a contact list (ATTRIBUTES.md §4, §7).
var NOT_HOLDERS = ['Defaults', resolver.DEVICE_DEFAULTS_KIND, resolver.CONTACT_BOOK_KIND];
var LEVEL_ORDER = ['project', 'location', 'station'];

var state = {
  origin: null, own: {}, ancestors: [], names: {}, kinds: {}, channelKinds: {},
  stationCount: 0, readOnly: true, showInherited: false, customerId: null, users: null, defaultsShared: true,
  deviceBranch: false, sourceKeys: [], calcMeta: { names: {}, attributes: {} },
  // book: the owner's address book — `holder` the CUSTOMER or the tenant's
  // ContactBook asset, `usage` {entryId: [{level, attrs, key}]} where a section shows it.
  // below: the levels under a customer or project with their attributes, for CA-21.
  book: { holder: null, entries: {}, usage: null, section: false }, below: null
};
// Entries created by *New contact* in the open notifications panel, written with it.
var pendingBook = {};

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

// resolver.levelDisplay in the reader's language.
function levelLabel(level) {
  if (level.role === 'customer') { return t('settings.levelCustomer', 'Customer defaults · {name}', { name: level.name }); }
  if (level.role === 'defaults') { return t('settings.levelDefaults', 'in-terra defaults'); }
  if (level.role === 'deviceDefaults') { return t('settings.levelDeviceDefaults', 'Device defaults · {name}', { name: level.name }); }
  if (level.role === 'device') { return t('settings.levelDevice', 'Device · {name}', { name: level.name }); }
  return kindName(level.kind || 'Asset') + ' · ' + level.name;
}

/** An entity's kind as shown: the levels' own names translated, a device profile as named. */
function kindName(kind) {
  switch (kind) {
    case 'Customer': return t('common.customer', 'Customer');
    case 'Project': return t('common.project', 'Project');
    case 'Location': return t('common.location', 'Location');
    case 'Station': return t('common.station', 'Station');
    case 'Defaults': return t('settings.kindDefaults', 'Defaults');
    case 'DeviceDefaults': return t('settings.kindDeviceDefaults', 'DeviceDefaults');
    case 'Asset': return t('settings.kindAsset', 'Asset');
    default: return kind;
  }
}
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
  if (ch.indexOf('.') >= 0) { return entryOf(ch).label ? t.channel(nameOf(ch), entryOf(ch).label) : ch; }
  var split = resolver.splitChannelKey(ch);
  var label = entryOf(ch).label || split.name;
  return t.label(ch, split.instance ? label + ' ' + split.instance : label, state.names);
}
function kindLabel(ch) {
  var spec = kindSpec(ch);
  return spec.label ? t.kind(channelKind(ch), spec.label) : channelKind(ch) || t('common.unknownKind', 'Unknown kind');
}

// The unit a channel is stored in, which its thresholds and hysteresis are
// entered in: a station channel's name's unit, else its kind's cloud unit; a
// device source key's the cloud unit (vocabulary.md §2.3).
function unitOf(ch) { return (ch.indexOf('.') < 0 && entryOf(ch).unit) || kindSpec(ch).cloudUnit || ''; }

function stateText(ch, v) {
  if (alarmClass(ch) === 'boolean') {
    var f = CH + ch + '.' + (v === true || v === 'true' || v === 1 ? 'textWhenTrue' : 'textWhenFalse');
    if (isOwn(f)) { return ownVal(f); }
    var hit = inherited(f);
    return hit ? hit.value : String(v === true || v === 'true' || v === 1);
  }
  var states = entryOf(ch).states || {};
  return states[String(v)] !== undefined ? t.state(nameOf(ch), states[String(v)]) : String(v);
}

// Every per-channel key this widget manages.
var ALARM_RE = /^alarm\.([a-z]+)\.(thresholdMax|thresholdMin|state)$/;
var FIELDS = ['label', 'hysteresis', 'textWhenTrue', 'textWhenFalse'];
// The channel may hold dots on the device branch, so the field is matched from the end.
var KEY_RE = /^channel\.(.+?)\.(alarm\.[a-z]+\.(?:thresholdMax|thresholdMin|state)|label|hysteresis|textWhenTrue|textWhenFalse)$/;
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
  '<div class="ts-title">' + esc(t('common.settings', 'Settings')) + ' ' + info('cascade') + '</div><div class="ts-subtitle"></div></div><span class="ts-chip level" hidden></span></div>' +
  '<div class="ts-body"><div class="ts-loading">' + esc(t('common.loading', 'Loading…')) + '</div></div>' +
  '<div class="ts-foot" hidden><span class="ts-foot-left"></span><span class="ts-spacer"></span>' +
  '<label class="ts-switch ts-summary"><input type="checkbox" class="ts-show-inh"> ' + esc(t('settings.showInherited', 'Show inherited')) + '</label></div></div>');
root.appendChild(cardEl);
window.TerrySenseNav(ctx, tb, ui, cardEl, opts);
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
  if (tb.isPublicView()) { fail(t('settings.publicLink', 'Settings are not shown on a public link.')); return Promise.resolve(); }
  return tb.boundDatasource().then(function (ds) {
    if (!ds) { fail(t('settings.noEntity', 'No entity bound — bind a customer, project, station or device in the widget\'s Data tab.')); return; }
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
        return loadBook().then(loadBelow);
      }).then(function () {
        renderHead();
        render();
      });
    });
  }).catch(function (err) { fail(t('common.loadFailed', 'Could not load: {error}', { error: err && err.message ? err.message : err })); });
}

/** The address book this level's lists name: its customer's, else the tenant's. */
function loadBook() {
  var o = state.origin;
  state.book = { holder: null, entries: {}, usage: null, section: false };
  if (state.deviceBranch) { return Promise.resolve(); }
  var customer = o.entityType === 'CUSTOMER' ? { level: o, attrs: state.own }
    : state.ancestors.filter(function (a) { return a.level.role === 'customer'; })[0];
  var holder = customer ? Promise.resolve(customer) : Promise.resolve(io.fetchTenantBook()).then(function (b) {
    return b ? io.fetchAttrs(b).then(function (attrs) { return { level: b, attrs: attrs || {} }; }) : null;
  });
  return holder.then(function (hd) {
    state.book.holder = hd ? hd.level : null;
    state.book.entries = parseVal((hd ? hd.attrs : {})[BOOK]) || {};
    state.book.section = o.entityType === 'CUSTOMER' || (o.kind === 'Defaults' && !state.readOnly);
  });
}

/** The assets the owner of this level owns: a customer's, or the tenant's own on the Tenant view. */
function ownedLevels() {
  var o = state.origin;
  var list = o.entityType === 'CUSTOMER' ? tb.getAll('/api/customer/' + o.id + '/assets', {})
    : tb.getAll('/api/tenant/assets', {}).then(function (l) { return l.filter(function (a) { return a.ownerId && a.ownerId.entityType === 'TENANT'; }); });
  return list.then(function (assets) {
    return assets.filter(function (a) { return NOT_HOLDERS.indexOf(a.type) < 0; }).map(tb.assetLevel);
  });
}

/** The levels below a customer or project (CA-21), and where each book entry is used (CA-20). */
function loadBelow() {
  var o = state.origin, badges = o.entityType === 'CUSTOMER' || o.kind === 'Project';
  state.below = null;
  if (!badges && !state.book.section) { return Promise.resolve(); }
  return (o.kind === 'Project' ? resolver.descendantAssets(o, io) : ownedLevels()).then(function (levels) {
    return Promise.all(levels.map(function (l) { return io.fetchAttrs(l).then(function (a) { return { level: l, attrs: a || {} }; }); }));
  }).then(function (below) {
    if (badges) { state.below = below; }
    if (state.book.section) { state.book.usage = bookUsage((o.entityType === 'CUSTOMER' ? [{ level: o, attrs: state.own }] : []).concat(below)); }
  });
}

function bookUsage(holders) {
  var usage = {};
  holders.forEach(function (hd) {
    LIST_KEYS.forEach(function (key) {
      (parseVal(hd.attrs[key]) || []).forEach(function (c) {
        if (c && c.type === 'book') { (usage[c.entryId] = usage[c.entryId] || []).push({ level: hd.level, attrs: hd.attrs, key: key }); }
      });
    });
  });
  return usage;
}

function renderHead() {
  var next = state.ancestors[0];
  cardEl.querySelector('.ts-subtitle').textContent = state.origin.name +
    (next ? t('settings.inheritsFrom', ' · inherits from {name}', { name: next.level.role === 'defaults' ? t('settings.levelDefaults', 'in-terra defaults') : next.level.name }) : '');
  var chip = cardEl.querySelector('.ts-chip.level');
  chip.hidden = false;
  chip.textContent = kindName(state.origin.kind);
  cardEl.classList.toggle('ts-readonly', state.readOnly);
  footEl.hidden = false;
  var left = footEl.querySelector('.ts-foot-left');
  left.innerHTML = '';
  if (state.readOnly) {
    left.appendChild(h('<span class="ts-summary">' + esc(t('settings.readOnly', 'Read only')) + '</span>'));
  } else {
    var add = h('<button type="button" class="ts-btn primary">' + ICON.plus + esc(t('settings.addSetting', 'Add setting')) + '</button>');
    add.addEventListener('click', openAdd);
    left.appendChild(add);
  }
}

/** The source keys a device reports — for a DeviceDefaults asset, those of a
 * few devices of its profile. Provenance and fault keys carry no limit. */
function sourceKeysOf(origin) {
  var skip = /^(uplinkCause|uplinkLatest|rssi|snr|service\.silencedNotice)$|\.status$/;
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
    var txt = p.dir === 'is' ? '= ' + esc(stateText(ch, v)) : (p.dir === 'above' ? '&gt; ' : '&lt; ') + esc(Number(v)) + ' ' + esc(unit);
    return chip(sevDot(p.sev) + txt, s.label + ': ' + s.desc);
  });
  var has = function (f) { return keys.indexOf(CH + ch + '.' + f) >= 0; };
  if (has('hysteresis')) { conds.push(chip('± ' + esc(Number(source(CH + ch + '.hysteresis'))) + ' ' + esc(unit))); }
  if (has('textWhenTrue')) { conds.push(chip('true = ' + esc(source(CH + ch + '.textWhenTrue')))); }
  if (has('textWhenFalse')) { conds.push(chip('false = ' + esc(source(CH + ch + '.textWhenFalse')))); }
  if (has('label')) { conds.push(chip('“' + esc(source(CH + ch + '.label')) + '”', t('settings.nameInAlarms', 'Name in alarm messages'))); }
  return conds.join('');
}

function fmtScalar(def, v) {
  if (def.type === 'contacts') { return Array.isArray(v) ? esc(v.length === 1 ? t('common.contactOne', '1 contact') : t('common.contactMany', '{n} contacts', { n: v.length })) : ''; }
  if (def.type === 'bool') { return esc(v === true || v === 'true' ? t('common.on', 'On') : t('common.off', 'Off')); }
  if (def.type === 'days') { return esc(t('common.days', '{n} days', { n: v })); }
  if (def.type === 'hours') { return esc(t('settings.hoursValue', '{n} hours', { n: v })); }
  if (def.type === 'lang') { return esc(G.LANGUAGES[v] || v); }
  if (def.type === 'text') { var s = String(v); return '<i>“' + esc(s.slice(0, 38)) + (s.length > 38 ? '…' : '') + '”</i>'; }
  return esc(v);
}

/** A rule channel carries a dry contact interface rule, set in its DRYC view, not a measurement. */
function isRule(ch) { return !!(state.names[resolver.splitChannelKey(ch).name] || {}).rule; }

function emptyLine(what) {
  var el = h('<div class="ts-empty">' + esc(t('settings.nothingSet', 'Nothing set here, all inherited.')) + (state.readOnly ? '' : ' <a>' + esc(t('common.add', 'Add')) + '</a>') + '</div>');
  var a = el.querySelector('a');
  if (a) { a.addEventListener('click', function () { if (what === 'measurement') { openMeasurementPicker(false); } else { openScalar(what, false); } }); }
  return el;
}

function render() {
  bodyEl.innerHTML = '';
  if (!state.defaultsShared) {
    bodyEl.appendChild(h('<div class="ts-banner warn">' + ICON.info + '<span>' + esc(t('settings.notShared', 'The in-terra defaults are not shared with this customer, so tenant defaults and the measurement names do not load. A tenant admin shares the “Shared defaults” group.')) + '</span></div>'));
  }

  var sec = h('<div class="ts-section"><div class="ts-section-head">' + esc(t('settings.measurements', 'Measurements')) + ' ' + info('measurements') + '</div></div>');
  var own = channelsWith(state.own);
  var rules = Object.keys(own).filter(isRule);
  Object.keys(own).filter(function (ch) { return !isRule(ch); }).sort(function (a, b) { return chLabel(a).localeCompare(chLabel(b)); }).forEach(function (ch) {
    var row = h('<div class="ts-row" tabindex="0"><div class="ts-row-main"><div class="ts-row-label"></div><div class="ts-row-meta"></div></div>' +
      '<div class="ts-row-value">' + channelChips(ch, own[ch], ownVal) + '</div>' +
      (state.readOnly ? '' : '<div class="ts-row-actions"><button type="button" class="ts-icon-btn" title="' + esc(t('common.edit', 'Edit')) + '">' + ICON.edit + '</button></div>') + '</div>');
    row.querySelector('.ts-row-label').textContent = chLabel(ch);
    row.querySelector('.ts-row-meta').textContent = kindLabel(ch);
    var keys = Object.keys(state.own).filter(function (k) { return k.indexOf(CH + ch + '.') === 0; });
    lowerBadge(row, chLabel(ch), keys);
    if (!state.readOnly) { row.addEventListener('click', function () { openChannel(ch, false); }); }
    sec.appendChild(row);
  });
  if (state.showInherited) {
    var inh = {};
    state.ancestors.forEach(function (a) {
      var byCh = channelsWith(a.attrs);
      Object.keys(byCh).forEach(function (ch) {
        if (own[ch] || isRule(ch)) { return; }
        byCh[ch].forEach(function (k) { if ((inh[ch] = inh[ch] || []).indexOf(k) < 0) { inh[ch].push(k); } });
      });
    });
    Object.keys(inh).sort(function (a, b) { return chLabel(a).localeCompare(chLabel(b)); }).forEach(function (ch) {
      var from = inherited(inh[ch][0]).from;
      var row = h('<div class="ts-row inherited"><div class="ts-row-main"><div class="ts-row-label"></div><div class="ts-row-meta"></div></div>' +
        '<div class="ts-row-value">' + channelChips(ch, inh[ch], function (k) { var x = inherited(k); return x ? x.value : ''; }) + '</div>' +
        (state.readOnly ? '' : '<div class="ts-row-actions"><button type="button" class="ts-btn ghost">' + esc(t('settings.changeHere', 'Change here')) + '</button></div>') + '</div>');
      row.querySelector('.ts-row-label').textContent = chLabel(ch);
      row.querySelector('.ts-row-meta').textContent = t('settings.from', 'from {level}', { level: levelLabel(from) });
      if (!state.readOnly) { row.querySelector('.ts-btn').addEventListener('click', function () { openChannel(ch, false); }); }
      sec.appendChild(row);
    });
  }
  if (!sec.querySelector('.ts-row')) { sec.appendChild(emptyLine('measurement')); }
  if (rules.length) {
    sec.appendChild(h('<div class="ts-field-hint" data-rules="' + rules.length + '"></div>')).textContent =
      rules.length === 1 ? t('settings.rulesOne', '1 dry contact interface rule raises alarms here; their names and severities are set in the station’s Dry contact interface view.')
        : t('settings.rulesMany', '{n} dry contact interface rules raise alarms here; their names and severities are set in the station’s Dry contact interface view.', { n: rules.length });
  }
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
        ? (hit ? t('settings.replacesFrom', 'replaces {what} from {level}', {
          what: d.type === 'text' ? t('settings.theWording', 'the wording') : fmtScalar(d, hit.value).replace(/<[^>]+>/g, ''), level: levelLabel(hit.from) }) : '')
        : t('settings.from', 'from {level}', { level: levelLabel(hit.from) });
      var row = h('<div class="ts-row' + (mine ? '' : ' inherited') + '" tabindex="0"><div class="ts-row-main"><div class="ts-row-label"></div>' +
        '<div class="ts-row-meta"></div></div><div class="ts-row-value">' + fmtScalar(d, v) + '</div>' +
        (state.readOnly ? '' : mine
          ? '<div class="ts-row-actions"><button type="button" class="ts-icon-btn" data-act="reset" title="' + esc(t('settings.resetToInherited', 'Reset to inherited')) + '">' + ICON.reset + '</button>' +
            '<button type="button" class="ts-icon-btn" title="' + esc(t('common.edit', 'Edit')) + '">' + ICON.edit + '</button></div>'
          : '<div class="ts-row-actions"><button type="button" class="ts-btn ghost">' + esc(t('settings.changeHere', 'Change here')) + '</button></div>') + '</div>');
      row.querySelector('.ts-row-label').textContent = d.label;
      row.querySelector('.ts-row-meta').textContent = meta;
      if (!meta) { row.querySelector('.ts-row-meta').remove(); }
      if (mine) { lowerBadge(row, d.label, [d.key]); }
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
  if (state.book.section) { renderBook(); }
}

// -- set lower down (CA-21) ---------------------------------------------------------------

// A station key replaces a key of the same field for its channel name, or for
// one instance of it (`channel.tiltX-3.…` under `channel.tiltX.…`).
var CH_KEY_RE = /^channel\.([^.]+)\.(.+)$/;
function replaces(lowerKey, ownKey) {
  if (lowerKey === ownKey) { return true; }
  var a = CH_KEY_RE.exec(ownKey), b = CH_KEY_RE.exec(lowerKey);
  return !!a && !!b && a[2] === b[2] && !resolver.splitChannelKey(a[1]).instance && resolver.splitChannelKey(b[1]).name === a[1];
}

function lowerFor(keys) {
  var out = [];
  (state.below || []).forEach(function (b) {
    var hit = Object.keys(b.attrs).filter(function (k) {
      return b.attrs[k] !== null && keys.some(function (own) { return replaces(k, own); });
    });
    if (hit.length) { out.push({ level: b.level, keys: hit }); }
  });
  return out;
}

function levelCount(k, n) {
  switch (k) {
    case 'project': return n === 1 ? t('common.projectOne', '1 project') : t('settings.projectMany', '{n} projects', { n: n });
    case 'location': return n === 1 ? t('settings.locationOne', '1 location') : t('settings.locationMany', '{n} locations', { n: n });
    case 'station': return n === 1 ? t('common.stationOne', '1 station') : t('common.stationMany', '{n} stations', { n: n });
    default: return n + ' ' + k + (n > 1 ? 's' : '');
  }
}

function lowerLevels(list) {
  var counts = {};
  list.forEach(function (l) { var k = String(l.level.kind || 'level').toLowerCase(); counts[k] = (counts[k] || 0) + 1; });
  return Object.keys(counts).sort(function (a, b) { return LEVEL_ORDER.indexOf(a) - LEVEL_ORDER.indexOf(b); })
    .map(function (k) { return levelCount(k, counts[k]); }).join(', ');
}

function lowerText(list) { return t('settings.replacedOn', 'replaced on {levels}', { levels: lowerLevels(list) }); }

function lowerBadge(row, label, keys) {
  var list = lowerFor(keys);
  if (!list.length) { return; }
  var badge = h('<button type="button" class="ts-chip ts-lower" data-a="lower"></button>');
  badge.textContent = lowerText(list);
  row.querySelector('.ts-row-value').insertBefore(badge, row.querySelector('.ts-row-value').firstChild);
  badge.addEventListener('click', function (e) { e.stopPropagation(); openLower(badge, label, list); });
}

function openLower(anchor, label, list) {
  var box = h('<div><div class="ts-subhead">' + esc(t('settings.setLower', 'Set lower down')) + '</div></div>');
  list.forEach(function (l) {
    var o = h('<div class="ts-opt" tabindex="0"><div class="ts-opt-main"><div class="ts-opt-label"></div><div class="ts-opt-desc"></div></div></div>');
    o.setAttribute('data-level', l.level.name);
    o.querySelector('.ts-opt-label').textContent = l.level.name;
    o.querySelector('.ts-opt-desc').textContent = t('settings.opensSettings', '{kind} · opens its settings', { kind: kindName(l.level.kind) });
    o.addEventListener('click', function () {
      ctx.stateController.updateState('settings', { entityId: { entityType: l.level.entityType, id: l.level.id }, entityName: l.level.name });
    });
    box.appendChild(o);
  });
  var pop;
  if (!state.readOnly) {
    var reset = h('<div class="ts-add-row"><button type="button" class="ts-btn ghost" data-a="reset-lower">' + ICON.reset + esc(t('settings.resetToInherit', 'Reset to inherit')) + '</button></div>');
    reset.querySelector('button').addEventListener('click', function () {
      pop.close();
      ui.confirm(t('settings.resetLowerConfirm', 'Delete the value of <b>{label}</b> set on {levels}? They then inherit it from {name}.',
        { label: esc(label), levels: esc(lowerLevels(list)), name: esc(state.origin.name) }), t('settings.resetToInherit', 'Reset to inherit')).then(function (ok) { if (ok) { resetLower(list); } });
    });
    box.appendChild(reset);
  }
  pop = ui.popover(anchor, box);
}

function uniqueStations(levels) {
  return Promise.all(levels.map(function (l) { return resolver.affectedStations(l, io); })).then(function (lists) {
    var seen = {}, out = [];
    lists.forEach(function (l) { l.forEach(function (s) { if (!seen[s.id]) { seen[s.id] = true; out.push(s); } }); });
    return out;
  });
}

function failed(err) { ui.toast(t('settings.saveFailed', 'Save failed: {error}', { error: err && (err.message || (err.error && err.error.message)) || err }), 'error'); }

function resetLower(list) {
  return Promise.all(list.map(function (l) { return tb.deleteAttrs(l.level, l.keys); }))
    .then(function () { return uniqueStations(list.map(function (l) { return l.level; })); })
    .then(function (stations) { return tb.resolveStations(stations); })
    .then(function () { ui.toast(t('settings.resetToInherit', 'Reset to inherit')); return load(); })
    .catch(failed);
}

// -- address book (CA-20) ---------------------------------------------------------------------

function entryName(e) { return (e && (e.name || e.sms || e.email)) || t('settings.unknownEntry', 'Unknown entry'); }
function useText(u) {
  return u.key === LIST_KEYS[0] ? t('settings.usedMeasurement', '{name} (measurement alarms)', { name: u.level.name })
    : t('settings.usedDevice', '{name} (device alarms)', { name: u.level.name });
}

function renderBook() {
  var b = state.book;
  var sec = h('<div class="ts-section ts-book"><div class="ts-section-head">' + esc(t('settings.externalContacts', 'External contacts')) + ' ' + info('addressBook') + '</div></div>');
  var ids = Object.keys(b.entries).sort(function (x, y) { return entryName(b.entries[x]).localeCompare(entryName(b.entries[y])); });
  ids.forEach(function (id) {
    var e = b.entries[id], uses = (b.usage || {})[id] || [];
    var row = h('<div class="ts-row static"><div class="ts-row-main"><div class="ts-row-label"></div><div class="ts-row-meta"></div>' +
      '<div class="ts-row-meta ts-used"></div></div>' + (state.readOnly ? '' : '<div class="ts-row-actions">' +
      '<button type="button" class="ts-icon-btn" data-a="edit" title="' + esc(t('common.edit', 'Edit')) + '">' + ICON.edit + '</button>' +
      '<button type="button" class="ts-btn ghost" data-a="replace">' + esc(t('settings.replaceWith', 'Replace with…')) + '</button>' +
      '<button type="button" class="ts-btn ghost" data-a="remove">' + esc(t('settings.removeEverywhere', 'Remove everywhere')) + '</button></div>') + '</div>');
    row.setAttribute('data-entry', id);
    row.querySelector('.ts-row-label').textContent = entryName(e);
    row.querySelector('.ts-row-meta').textContent = [e.sms, e.email].filter(Boolean).join(' · ') +
      (e.sms && !E164.test(e.sms) ? t('settings.numberNotE164', ' — number not in international format, SMS will fail') : '');
    row.querySelector('.ts-used').textContent = uses.length ? t('settings.usedIn', 'Used in {lists}', { lists: uses.map(useText).join(', ') }) : t('settings.inNoList', 'Not in any list');
    if (!state.readOnly) {
      row.querySelector('[data-a=edit]').addEventListener('click', function () { openEntry(id); });
      row.querySelector('[data-a=replace]').addEventListener('click', function () { openReplace(id); });
      row.querySelector('[data-a=remove]').addEventListener('click', function () { removeEntry(id); });
    }
    sec.appendChild(row);
  });
  if (!ids.length) { sec.appendChild(h('<div class="ts-empty">' + t('settings.noBookEntry', 'No external contact yet. <i>New external contact</i> in a contact list adds one.') + '</div>')); }
  bodyEl.appendChild(sec);
}

/** Name, SMS and e-mail inputs bound to `entry`, numbers checked as E.164. */
function entryFields(entry, onChange) {
  var el = h('<div><div class="ts-contact-grid"><input class="ts-input" data-f="name" placeholder="' + esc(t('settings.nameOrRole', 'Name or role')) + '">' +
    '<input class="ts-input" data-f="sms" placeholder="' + esc(t('settings.smsExample', 'SMS: +41 79 123 45 67')) + '">' +
    '<input class="ts-input" data-f="email" placeholder="' + esc(t('settings.emailExample', 'E-mail: name@example.ch')) + '"></div>' +
    '<div class="ts-field-error"></div></div>');
  var err = el.querySelector('.ts-field-error');
  function check() {
    err.textContent = entry.sms && !E164.test(entry.sms) ? t('settings.smsInvalid', 'SMS number must be international: + country code, no spaces (e.g. +41791234567).')
      : entry.email && !EMAIL.test(entry.email) ? t('settings.emailInvalid', 'Not a valid e-mail address.') : '';
  }
  el.querySelectorAll('[data-f]').forEach(function (inp) {
    var fld = inp.getAttribute('data-f');
    inp.value = entry[fld] || '';
    inp.addEventListener('input', function () {
      entry[fld] = fld === 'sms' ? inp.value.replace(/\s+/g, '') : inp.value.trim();
      check(); onChange();
    });
  });
  check();
  return el;
}
function entryValid(e) { return !(e.sms && !E164.test(e.sms)) && !(e.email && !EMAIL.test(e.email)) && !!(e.name || e.sms || e.email); }

/** Write the book (when `entries`) and the rewritten lists, then resolve every
 * station the entry's lists reach; asks first when `always` or more than one. */
function bookCommit(what, entries, rewrites, uses, button, always) {
  if (button) { button.disabled = true; }
  return uniqueStations(uses.map(function (u) { return u.level; })).then(function (stations) {
    var n = stations.length;
    var ask = always || n > 1
      ? ui.confirm(what + (n === 1 ? t('settings.updatesStationOne', ' This updates <b>1 station</b>.') : n ? t('settings.updatesStationMany', ' This updates <b>{n} stations</b>.', { n: n }) : ''),
        n > 1 ? t('settings.applyStations', 'Apply to {n} stations', { n: n }) : t('settings.apply', 'Apply'))
      : Promise.resolve(true);
    return ask.then(function (ok) {
      if (!ok) { if (button) { button.disabled = false; } return; }
      return saveBook(entries)
        .then(function () { return Promise.all(rewrites.map(function (r) { return tb.saveAttrs(r.level, r.write); })); })
        .then(function () { return tb.resolveStations(stations); })
        .then(function () {
          ui.closeDrawer();
          ui.toast(n === 0 ? t('common.saved', 'Saved') : n === 1 ? t('settings.stationUpdatedOne', '1 station updated') : t('settings.stationUpdatedMany', '{n} stations updated', { n: n }));
          return load();
        });
    });
  }).catch(function (err) { if (button) { button.disabled = false; } failed(err); });
}

/** The tenant's book is created on its first entry. */
function saveBook(entries) {
  if (!entries) { return Promise.resolve(); }
  var made = state.book.holder ? Promise.resolve(state.book.holder)
    : tb.post('/api/asset', { name: BOOK_NAME, type: resolver.CONTACT_BOOK_KIND }).then(tb.assetLevel);
  return made.then(function (level) {
    state.book.holder = level;
    var w = {};
    w[BOOK] = entries;
    return tb.saveAttrs(level, w);
  });
}

function bookCopy() { return JSON.parse(JSON.stringify(state.book.entries)); }

/** `fn(list)` applied to every list that names the entry, grouped per level. */
function rewritesFor(uses, fn) {
  var byLevel = {};
  uses.forEach(function (u) {
    var r = byLevel[u.level.id] = byLevel[u.level.id] || { level: u.level, write: {} };
    r.write[u.key] = fn(JSON.parse(JSON.stringify(parseVal(u.attrs[u.key]))));
  });
  return Object.keys(byLevel).map(function (k) { return byLevel[k]; });
}

function openEntry(id) {
  var entry = Object.assign({ name: '', sms: '', email: '' }, state.book.entries[id]);
  var dr = ui.openDrawer(esc(t('settings.editContact', 'Edit contact')), esc(entryName(entry)));
  var save = ui.drawerActions(dr);
  dr.body.appendChild(entryFields(entry, function () { save.disabled = !entryValid(entry); }));
  dr.body.appendChild(h('<div class="ts-field-hint">' + esc(t('settings.editContactHint', 'Changes this contact in every list that names it.')) + '</div>'));
  save.addEventListener('click', function () {
    var entries = bookCopy();
    entries[id] = { name: entry.name, sms: entry.sms, email: entry.email };
    bookCommit(t('settings.editContactConfirm', 'Change <b>{name}</b> in every list that names it?', { name: esc(entryName(entry)) }), entries, [], (state.book.usage || {})[id] || [], save);
  });
}

function contactKey(c) { return c.type === 'user' ? 'u:' + c.userId : c.type === 'book' ? 'b:' + c.entryId : null; }

/** `list` with entry `id` swapped for `make(contact)`; a contact already listed takes its severities. */
function replaceIn(list, id, make) {
  var out = [];
  list.forEach(function (c) {
    var n = c && c.type === 'book' && c.entryId === id ? make(c) : c;
    var twin = contactKey(n) && out.filter(function (x) { return contactKey(x) === contactKey(n); })[0];
    if (!twin) { out.push(n); return; }
    (n.severities || []).forEach(function (s) { if (twin.severities.indexOf(s) < 0) { twin.severities.push(s); } });
    twin.viaSms = twin.viaSms || n.viaSms;
    twin.viaEmail = twin.viaEmail || n.viaEmail;
  });
  return out;
}

/** The contact naming `target` that keeps what `c` asked for, where `target` has the address. */
function swapped(c, target, hasSms, hasEmail) {
  var viaSms = !!c.viaSms && hasSms, viaEmail = !!c.viaEmail && hasEmail;
  if (!viaSms && !viaEmail) { viaSms = hasSms; viaEmail = hasEmail; }
  return Object.assign(target, { viaSms: viaSms, viaEmail: viaEmail, severities: (c.severities || []).slice() });
}

function openReplace(id) {
  var ready = state.users === null ? tb.listUsers(state.customerId).then(function (u) { state.users = u; }).catch(function () { state.users = []; }) : Promise.resolve();
  ready.then(function () {
    var dr = ui.openDrawer(esc(t('settings.replaceWith', 'Replace with…')), esc(entryName(state.book.entries[id])));
    var uses = (state.book.usage || {})[id] || [];
    function pick(label, make) {
      bookCommit(t('settings.replaceConfirm', 'Replace <b>{name}</b> with <b>{other}</b> in every list that names it?', { name: esc(entryName(state.book.entries[id])), other: esc(label) }),
        null, rewritesFor(uses, function (list) { return replaceIn(list, id, make); }), uses, null, true);
    }
    function option(label, desc, attr, value, onPick) {
      var o = h('<div class="ts-opt" tabindex="0"><span class="ts-avatar"></span><div class="ts-opt-main"><div class="ts-opt-label"></div><div class="ts-opt-desc"></div></div></div>');
      o.setAttribute(attr, value);
      o.querySelector('.ts-avatar').textContent = initials(label);
      o.querySelector('.ts-opt-label').textContent = label;
      o.querySelector('.ts-opt-desc').textContent = desc;
      o.addEventListener('click', onPick);
      dr.body.appendChild(o);
    }
    var others = Object.keys(state.book.entries).filter(function (k) { return k !== id; });
    if (others.length) { dr.body.appendChild(h('<div class="ts-subhead">' + esc(t('settings.externalContacts', 'External contacts')) + '</div>')); }
    others.forEach(function (k) {
      var e = state.book.entries[k];
      option(entryName(e), [e.sms, e.email].filter(Boolean).join(' · '), 'data-entry', k, function () {
        pick(entryName(e), function (c) { return swapped(c, { type: 'book', entryId: k }, !!e.sms, !!e.email); });
      });
    });
    if ((state.users || []).length) { dr.body.appendChild(h('<div class="ts-subhead">' + esc(t('settings.platformUsers', 'Platform users')) + '</div>')); }
    (state.users || []).forEach(function (u) {
      option(userName(u), u.email + (u.phone ? ' · ' + u.phone : t('settings.noPhone', ' · no phone')), 'data-user', u.id.id, function () {
        pick(userName(u), function (c) { return swapped(c, { type: 'user', userId: u.id.id }, !!u.phone, !!u.email); });
      });
    });
    if (!dr.body.children.length) { dr.body.appendChild(h('<div class="ts-empty">' + esc(t('settings.nothingToReplace', 'No other entry and no platform user to replace it with.')) + '</div>')); }
  });
}

function removeEntry(id) {
  var entries = bookCopy(), uses = (state.book.usage || {})[id] || [];
  var name = entryName(entries[id]);
  delete entries[id];
  bookCommit(t('settings.removeConfirm', 'Remove <b>{name}</b> from the external contacts and from every list that names it?', { name: esc(name) }), entries,
    rewritesFor(uses, function (list) { return list.filter(function (c) { return !(c && c.type === 'book' && c.entryId === id); }); }), uses, null, true);
}

// -- calculated measurements (measurement/vocabulary.md §4) ---------------------------

function calcOwnAttributes(name) { return ((state.names[name] || {}).calculated || {}).attributes || []; }
function calcAttrName(attr) { var label = (state.calcMeta.attributes[attr] || {}).label; return label ? t.attribute(attr, label) : attr; }
function calcDescription(name) { var desc = (state.names[name] || {}).description; return desc && t.channelInfo(name, desc); }
function calcInputs(name) {
  return (((state.names[name] || {}).calculated || {}).channels || []).map(function (c) { return calc.channelLabel(state.calcMeta, state.own, c); });
}

function renderCalculations() {
  var plan = resolver.calculationPlan(state.own, state.names);
  if (!plan.length) { return; }
  var sec = h('<div class="ts-section ts-calc"><div class="ts-section-head">' + esc(t('settings.calculated', 'Calculated measurements')) + '</div></div>');
  plan.forEach(function (p) {
    var set = p.reads.filter(function (a) { return state.own[resolver.CALC_PREFIX + a] != null; }).map(function (a) {
      var spec = state.calcMeta.attributes[a] || {};
      return calcAttrName(a) + ' ' + state.own[resolver.CALC_PREFIX + a] + (spec.unit ? ' ' + spec.unit : '');
    });
    var needs = p.on ? [] : [t('common.needs', 'Needs {list}', { list: calc.listText(p.needs.map(calcAttrName)) })];
    var meta = [calcDescription(p.name)].concat(needs, p.reads.length ? set : [t('settings.automaticFrom', 'Automatic from {list}', { list: calc.listText(calcInputs(p.name)) })]);
    var editable = !state.readOnly && p.reads.length > 0;
    var row = h('<div class="ts-row' + (editable ? '' : ' static') + '"' + (editable ? ' tabindex="0"' : '') + ' data-calc-name="' + esc(p.name) + '">' +
      '<div class="ts-row-main"><div class="ts-row-label"></div><div class="ts-row-meta"></div></div><div class="ts-row-value"></div></div>');
    row.querySelector('.ts-row-label').textContent = calc.channelLabel(state.calcMeta, state.own, p.name);
    row.querySelector('.ts-row-meta').textContent = meta.filter(Boolean).join(' · ');
    row.querySelector('.ts-row-value').appendChild(h(p.on ? '<span class="ts-chip accent">' + esc(t('common.on', 'On')) + '</span>' : '<span class="ts-chip">' + esc(t('common.off', 'Off')) + '</span>'));
    if (editable) { row.addEventListener('click', function () { openCalculation(p, plan); }); }
    sec.appendChild(row);
  });
  bodyEl.appendChild(sec);
}

function openCalculation(p, plan) {
  var station = state.origin, label = calc.channelLabel(state.calcMeta, state.own, p.name);
  var dr = ui.openDrawer(esc(t('settings.calculatedOne', 'Calculated measurement')), esc(station.name));
  var intro = h('<p class="ts-calc-intro"></p>');
  var desc = calcDescription(p.name), inputs = calc.listText(calcInputs(p.name));
  intro.textContent = (desc ? desc + '. ' : '') + (p.reads.length > 1
    ? t('settings.calculatedFromMany', 'Calculated from {inputs} and the settings below.', { inputs: inputs })
    : t('settings.calculatedFromOne', 'Calculated from {inputs} and the setting below.', { inputs: inputs }));
  dr.body.appendChild(intro);
  var form = calc.form(station, state.own, p.reads, state.calcMeta);
  dr.body.appendChild(form.el);
  dr.body.appendChild(h('<div class="ts-field-hint">' + esc(t('calculations.hint', 'Values are calculated from the latest reading on; earlier readings are not recalculated.')) + '</div>'));
  var save = ui.drawerActions(dr, p.needs.length ? t('common.turnOn', 'Turn on') : t('common.save', 'Save'));
  function sync() { save.disabled = !form.values(); }
  form.onChange(sync);
  sync();
  save.addEventListener('click', function () {
    save.disabled = true;
    calc.save(station, form.values()).then(function () {
      ui.closeDrawer();
      ui.toast(p.needs.length ? t('settings.isOn', '{name} is on', { name: label }) : t('common.saved', 'Saved'));
      return load();
    }).catch(function (err) {
      save.disabled = false;
      failed(err);
    });
  });
  var own = calcOwnAttributes(p.name);
  if (own.length && own.every(function (a) { return state.own[resolver.CALC_PREFIX + a] != null; })) {
    var off = h('<button type="button" class="ts-btn" data-a="turn-off">' + esc(t('common.turnOff', 'Turn off')) + '</button>');
    dr.foot.insertBefore(off, dr.foot.firstChild);
    off.addEventListener('click', function () {
      var goes = plan.filter(function (q) {
        return q.on && q.reads.some(function (a) { return own.indexOf(a) >= 0; });
      }).map(function (q) { return calc.channelLabel(state.calcMeta, state.own, q.name); });
      ui.confirm(t('settings.turnOffConfirm', 'Turn off <b>{names}</b> on {station}? The values stored so far are kept.', { names: esc(calc.listText(goes)), station: esc(station.name) }),
        t('common.turnOff', 'Turn off'))
        .then(function (ok) {
          if (!ok) { return; }
          off.disabled = true;
          return calc.clear(station, own).then(function () {
            ui.closeDrawer();
            ui.toast(t('settings.isOff', '{name} is off', { name: label }));
            return load();
          });
        }).catch(function (err) {
          off.disabled = false;
          failed(err);
        });
    });
  }
  form.focus();
}

// -- saving ------------------------------------------------------------------------

/** Write `write`, delete `remove` on the bound entity, re-resolve every station
 * below; asks first when more than one station is affected. `before`, when
 * given, runs once confirmed and before the write. */
function commit(write, remove, what, button, before) {
  if (button) { button.disabled = true; }
  var devices = state.deviceBranch;
  return resolver.affectedStations(state.origin, io).then(function (stations) {
    var n = stations.length;
    var p = { what: esc(what), n: n, name: esc(state.origin.name) };
    var ask = n > 1
      ? (devices ? ui.confirm(t('settings.changesDevices', 'This changes <b>{what}</b> for <b>{n} devices</b> under {name}.', p), t('settings.applyDevices', 'Apply to {n} devices', p))
        : ui.confirm(t('settings.changesStations', 'This changes <b>{what}</b> for <b>{n} stations</b> under {name}.', p), t('settings.applyStations', 'Apply to {n} stations', p)))
      : Promise.resolve(true);
    return ask.then(function (ok) {
      if (!ok) { if (button) { button.disabled = false; } return; }
      return (before ? before() : Promise.resolve())
        .then(function () { return tb.saveAttrs(state.origin, write); })
        .then(function () { return tb.deleteAttrs(state.origin, remove.filter(isOwn)); })
        .then(function () { return tb.resolveStations(stations); })
        .then(function () {
          ui.closeDrawer();
          ui.toast(n === 0 ? t('common.saved', 'Saved')
            : devices ? (n === 1 ? t('settings.deviceUpdatedOne', '1 device updated') : t('settings.deviceUpdatedMany', '{n} devices updated', { n: n }))
            : n === 1 ? t('settings.stationUpdatedOne', '1 station updated') : t('settings.stationUpdatedMany', '{n} stations updated', { n: n }));
          return load();
        });
    });
  }).catch(function (err) {
    if (button) { button.disabled = false; }
    failed(err);
  });
}

function resetScalar(d) {
  var hit = inherited(d.key);
  ui.confirm(hit ? t('settings.resetConfirm', 'Reset <b>{label}</b> to the value inherited from {level}?', { label: esc(d.label), level: esc(levelLabel(hit.from)) })
    : t('settings.resetConfirmNothing', 'Reset <b>{label}</b> to nothing (not set anywhere above)?', { label: esc(d.label) }), t('settings.reset', 'Reset'))
    .then(function (ok) { if (ok) { commit({}, [d.key], d.label); } });
}

// -- add ----------------------------------------------------------------------------

function openAdd() {
  var dr = ui.openDrawer(esc(t('settings.addSetting', 'Add setting')), esc(kindName(state.origin.kind) + ' · ' + state.origin.name));
  var tiles = h('<div class="ts-tiles"></div>');
  [['measurement', ICON.gauge, t('common.measurement', 'Measurement'), state.deviceBranch ? t('settings.tileDeviceMeasurement', 'Alarm limits on one of the device\'s own readings')
     : t('settings.tileMeasurement', 'Alarm thresholds or conditions, unit and hysteresis for one measurement')],
   ['notifications', ICON.bell, t('settings.notifications', 'Notifications'), t('settings.tileNotifications', 'Contacts for measurement and device alarms, SMS and e-mail on or off, message wording, language')],
   ['retention', ICON.archive, t('settings.retention', 'Data retention'), t('settings.tileRetention', 'How long measured data is kept')]].filter(function (tile) {
    return !state.deviceBranch || tile[0] !== 'notifications';
  }).forEach(function (tile) {
    var el = h('<button type="button" class="ts-tile"><span class="ts-tile-icon">' + tile[1] + '</span><span><b>' + esc(tile[2]) + '</b><span>' + esc(tile[3]) + '</span></span></button>');
    el.addEventListener('click', function () { if (tile[0] === 'measurement') { openMeasurementPicker(true); } else { openScalar(tile[0], true); } });
    tiles.appendChild(el);
  });
  dr.body.appendChild(tiles);
}

function openMeasurementPicker(fromAdd) {
  if (state.deviceBranch) { openSourcePicker(fromAdd); return; }
  var dr = ui.openDrawer(esc(t('settings.chooseMeasurement', 'Choose a measurement')), esc(t('settings.groupedByKind', 'Grouped by kind')));
  if (fromAdd) { dr.onBack(openAdd); }
  var own = channelsWith(state.own);
  var measurable = {};
  Object.keys(state.names).forEach(function (n) { if (!state.names[n].rule) { measurable[n] = state.names[n]; } });
  dr.body.appendChild(ui.namePicker({
    names: measurable,
    kinds: state.kinds,
    allowKind: function (spec) { return !spec || spec.alarm !== 'none'; },
    inUse: Object.keys(state.channelKinds).map(function (k) { return resolver.splitChannelKey(k).name; }),
    badge: function (n) { return own[n] ? '<span class="ts-chip">' + esc(t('settings.setHereChip', 'set here')) + '</span>' : ''; },
    onPick: function (n) { openChannel(n, fromAdd); }
  }));
  // A name sets every instance at once; an instance key overrides one of them.
  var instances = Object.keys(state.channelKinds).filter(function (k) { return resolver.splitChannelKey(k).instance && !isRule(k); })
    .sort(function (a, b) { return a.localeCompare(b, undefined, { numeric: true }); });
  if (instances.length) {
    dr.body.appendChild(h('<div class="ts-subhead">' + esc(t('settings.oneInstance', 'One instance only')) + '</div>'));
    instances.forEach(function (k) {
      var o = ui.nameOption(k, { label: chLabel(k), description: t('settings.overridesInstance', 'Overrides {name} for this instance', { name: chLabel(resolver.splitChannelKey(k).name) }) },
        own[k] ? '<span class="ts-chip">' + esc(t('settings.setHereChip', 'set here')) + '</span>' : '', '');
      o.addEventListener('click', function () { openChannel(k, fromAdd); });
      dr.body.appendChild(o);
    });
  }
}

/** The device branch: pick one of the device's own source keys, the LOGR's
 * diagnostics included — they are what a device alarm is about. */
function openSourcePicker(fromAdd) {
  var dr = ui.openDrawer(esc(t('settings.chooseReading', 'Choose a reading')), esc(state.origin.name));
  if (fromAdd) { dr.onBack(openAdd); }
  var own = channelsWith(state.own);
  var keys = state.sourceKeys.slice();
  Object.keys(own).forEach(function (k) { if (keys.indexOf(k) < 0) { keys.push(k); } });
  if (!keys.length) { dr.body.appendChild(h('<div class="ts-empty">' + esc(t('settings.noReading', 'No reading stored yet.')) + '</div>')); return; }
  keys.sort().forEach(function (k) {
    var o = ui.nameOption(k, { label: chLabel(k), description: kindLabel(k) }, own[k] ? '<span class="ts-chip">' + esc(t('settings.setHereChip', 'set here')) + '</span>' : '', '');
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
function channelTextField(ch, field, label, tip, draft, onChange) {
  var key = CH + ch + '.' + field;
  var hit = inherited(key);
  var el = h('<div class="ts-field"><div class="ts-field-label"><span></span> ' + info(tip) + '<button type="button" class="ts-reset" hidden>' + esc(t('settings.resetToInherited', 'Reset to inherited')) + '</button></div>' +
    '<input class="ts-input wide"><div class="ts-field-hint"></div></div>');
  el.querySelector('.ts-field-label span').textContent = label;
  var input = el.querySelector('input'), reset = el.querySelector('.ts-reset');
  input.value = draft[field] || '';
  input.placeholder = hit ? String(hit.value) : (field === 'label' ? chLabel(ch) : '');
  el.querySelector('.ts-field-hint').textContent = hit ? t('settings.inheritedValue', 'Inherited: {value} from {level}', { value: hit.value, level: levelLabel(hit.from) })
    : field === 'label' ? t('settings.standardName', 'Standard name: {name}', { name: chLabel(ch) }) : '';
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
  var el = h('<div class="ts-field ts-debounce"><div class="ts-field-label">' + esc(t('settings.confirmAfter', 'Confirm after')) + ' ' + info('debounce') + '<button type="button" class="ts-reset" hidden>' + esc(t('settings.resetToInherited', 'Reset to inherited')) + '</button></div>' +
    '<span><input class="ts-input num" type="number" step="1" min="1"> ' + esc(t('settings.readingsInRow', 'readings in a row')) + '</span><div class="ts-field-hint"></div><div class="ts-field-error"></div></div>');
  var input = el.querySelector('input'), reset = el.querySelector('.ts-reset');
  input.value = draft.debounce || '';
  input.placeholder = hit ? String(hit.value) : '1';
  el.querySelector('.ts-field-hint').textContent = hit ? t('settings.inheritedValue', 'Inherited: {value} from {level}', { value: hit.value, level: levelLabel(hit.from) })
    : t('settings.debounceUnset', 'Not set above: the first reading alarms');
  reset.hidden = !draft.debounce;
  function check() {
    var bad = draft.debounce !== '' && !(Number(draft.debounce) >= 1 && Math.floor(Number(draft.debounce)) === Number(draft.debounce));
    el.querySelector('.ts-field-error').textContent = bad ? t('settings.debounceInvalid', 'A whole number of readings, 1 or more.') : '';
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
  var draft = { conds: [], hysteresis: '', label: '', debounce: '' };
  G.SEVERITIES.forEach(function (s) { ['above', 'below'].forEach(function (dir) {
    var k = condKey(ch, s.id, dir);
    if (isOwn(k)) { draft.conds.push({ sev: s.id, dir: dir, value: String(Number(ownVal(k))) }); }
  }); });
  ['hysteresis', 'label'].forEach(function (f) { if (isOwn(CH + ch + '.' + f)) { draft[f] = String(ownVal(CH + ch + '.' + f)); } });

  var thr = h('<div class="ts-field"><div class="ts-field-label">' + esc(t('settings.thresholds', 'Alarm thresholds')) + ' ' + info('thresholds') + '</div><div class="ts-scale"></div>' +
    '<div class="ts-thr-list"></div><button type="button" class="ts-btn ghost ts-thr-add">' + ICON.plus + esc(t('settings.addThreshold', 'Add threshold')) + '</button><div class="ts-field-error"></div></div>');
  var hyst = h('<div class="ts-field"><div class="ts-field-label">' + esc(t('settings.hysteresis', 'Hysteresis')) + ' ' + info('hysteresis') + '<button type="button" class="ts-reset" hidden>' + esc(t('settings.resetToInherited', 'Reset to inherited')) + '</button></div>' +
    '<span><input class="ts-input num" type="number" step="any" min="0"> <span class="ts-thr-unit"></span></span><div class="ts-field-hint"></div><div class="ts-field-error"></div></div>');
  dr.body.appendChild(thr);
  dr.body.appendChild(hyst);
  var deb = debounceField(ch, draft, function () { validate(); });
  dr.body.appendChild(deb);
  dr.body.appendChild(channelTextField(ch, 'label', t('settings.nameInMessages', 'Name in messages'), 'label', draft));

  var hystKey = CH + ch + '.hysteresis', hystHit = inherited(hystKey);
  var hystInput = hyst.querySelector('input'), hystReset = hyst.querySelector('.ts-reset');
  hystInput.value = draft.hysteresis;
  hystInput.placeholder = hystHit ? String(hystHit.value) : '0';
  hyst.querySelector('.ts-thr-unit').textContent = unitOf(ch);
  hyst.querySelector('.ts-field-hint').textContent = hystHit ? t('settings.inheritedValue', 'Inherited: {value} from {level}', { value: hystHit.value, level: levelLabel(hystHit.from) })
    : t('settings.hysteresisUnset', 'Not set above: no margin');
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
      if (hit) { out.push({ sev: s.id, dir: dir, value: Number(hit.value), from: hit.from }); }
    }); });
    return out;
  }
  function shadowed(t) { return draft.conds.some(function (d) { return d.sev === t.sev && d.dir === t.dir; }); }

  function renderList() {
    list.innerHTML = '';
    var u = unitOf(ch);
    draft.conds.forEach(function (d, i) {
      var row = h('<div class="ts-thr"><select class="ts-select ts-dir"><option value="above">' + esc(t('common.above', 'Above')) + '</option><option value="below">' + esc(t('common.below', 'Below')) + '</option></select>' +
        '<input class="ts-input num ts-thr-val" type="number" step="any"><span class="ts-thr-unit"></span>' +
        '<span class="ts-sev-select">' + sevDot(d.sev) + '<select class="ts-select ts-sev">' +
        G.SEVERITIES.slice().reverse().map(function (s) { return '<option value="' + s.id + '">' + s.label + '</option>'; }).join('') +
        '</select>' + info('severity') + '</span><button type="button" class="ts-icon-btn ts-thr-rm" title="' + esc(t('common.remove', 'Remove')) + '">' + ICON.close + '</button></div>');
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
    inh.forEach(function (th) {
      var s = G.severity(th.sev);
      var row = h('<div class="ts-thr inherited' + (shadowed(th) ? ' shadowed' : '') + '"><span class="ts-thr-static">' + esc(th.dir === 'above' ? t('common.above', 'Above') : t('common.below', 'Below')) + '</span>' +
        '<span class="ts-thr-static" style="text-align:right">' + esc(th.value) + '</span><span class="ts-thr-unit">' + esc(u) + '</span>' +
        '<span class="ts-sev-select">' + sevDot(th.sev) + esc(s.label) + '</span><span></span><span class="ts-thr-from"></span></div>');
      row.querySelector('.ts-thr-from').textContent = shadowed(th) ? t('settings.replacedHere', 'replaced here') : t('settings.inheritedFrom', 'inherited from {level}', { level: levelLabel(th.from) });
      list.appendChild(row);
    });
    if (!draft.conds.length && !inh.length) { list.appendChild(h('<div class="ts-empty">' + esc(t('settings.noThreshold', 'No threshold: this measurement never raises an alarm.')) + '</div>')); }
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
      if (seen[d.sev + d.dir]) {
        err = d.dir === 'above' ? t('settings.onlyOneAbove', 'Only one {severity} threshold above per measurement.', { severity: G.severity(d.sev).label })
          : t('settings.onlyOneBelow', 'Only one {severity} threshold below per measurement.', { severity: G.severity(d.sev).label });
      }
      seen[d.sev + d.dir] = true;
      if (d.value === '' || !isFinite(Number(d.value))) { err = err || t('settings.valueMissing', 'Enter a value for every threshold.'); }
    });
    var eff = effective();
    eff.forEach(function (a) { eff.forEach(function (b) {
      if (a.dir !== b.dir || a.sev === 'indeterminate' || b.sev === 'indeterminate' || G.rank(a.sev) <= G.rank(b.sev)) { return; }
      if ((a.dir === 'above' && a.value < b.value) || (a.dir === 'below' && a.value > b.value)) {
        err = err || t('settings.severityOrder', '{higher} should be reached after {lower}, not before.', { higher: G.severity(a.sev).label, lower: G.severity(b.sev).label });
      }
    }); });
    var hystErr = draft.hysteresis !== '' && !(Number(draft.hysteresis) >= 0) ? t('settings.hysteresisInvalid', 'Hysteresis is an absolute margin: zero or positive.') : '';
    msg.textContent = err;
    hyst.querySelector('.ts-field-error').textContent = hystErr;
    save.disabled = !!(err || hystErr) || !deb.valid();
  }

  save.addEventListener('click', function () {
    var write = {}, remove = [];
    G.SEVERITIES.forEach(function (s) { ['above', 'below'].forEach(function (dir) { remove.push(condKey(ch, s.id, dir)); }); });
    draft.conds.forEach(function (d) { write[condKey(ch, d.sev, d.dir)] = Number(d.value); });
    if (draft.hysteresis !== '') { write[hystKey] = Number(draft.hysteresis); } else { remove.push(hystKey); }
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

  var sec = h('<div class="ts-field"><div class="ts-field-label">' + esc(t('settings.alarmWhen', 'Alarm when')) + ' ' + info(isBool ? 'boolAlarm' : 'stateAlarm') + '</div>' +
    '<div class="ts-thr-list"></div><button type="button" class="ts-btn ghost">' + ICON.plus + esc(t('settings.addCondition', 'Add condition')) + '</button><div class="ts-field-error"></div></div>');
  dr.body.appendChild(sec);
  var list = sec.querySelector('.ts-thr-list'), msg = sec.querySelector('.ts-field-error');
  var addBtn = sec.querySelector('.ts-btn');
  if (!values().length) {
    addBtn.hidden = true;
    list.appendChild(h('<div class="ts-empty">' + esc(t('settings.noStates', 'This measurement declares no states, so no condition can be set. A tenant admin adds them in the peripheral catalog.')) + '</div>'));
  }

  if (isBool) {
    var ws = h('<div class="ts-field"><div class="ts-field-label">' + esc(t('settings.wording', 'Wording')) + ' ' + info('boolText') + '</div><div class="ts-wording">' +
      '<label>' + esc(t('settings.whenTrue', 'When true (1)')) + '<input class="ts-input wide" data-f="textWhenTrue"></label>' +
      '<label>' + esc(t('settings.whenFalse', 'When false (0)')) + '<input class="ts-input wide" data-f="textWhenFalse"></label></div></div>');
    ws.querySelectorAll('input').forEach(function (inp) {
      var f = inp.getAttribute('data-f');
      var hit = inherited(CH + ch + '.' + f);
      inp.placeholder = hit ? t('settings.inheritedPlaceholder', '{value} (inherited)', { value: hit.value }) : (f === 'textWhenTrue' ? 'true' : 'false');
      inp.value = draft[f];
      inp.addEventListener('input', function () { draft[f] = inp.value.trim(); renderList(); });
    });
    dr.body.appendChild(ws);
  }
  var deb = debounceField(ch, draft, function () { validate(); });
  dr.body.appendChild(deb);
  dr.body.appendChild(channelTextField(ch, 'label', t('settings.nameInMessages', 'Name in messages'), 'label', draft));
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
      var row = h('<div class="ts-thr ts-thr-state"><span class="ts-thr-static">' + esc(t('settings.is', 'Is')) + '</span><select class="ts-select ts-val"></select>' +
        '<span class="ts-sev-select">' + sevDot(d.sev) + '<select class="ts-select ts-sev">' +
        G.SEVERITIES.slice().reverse().map(function (s) { return '<option value="' + s.id + '">' + s.label + '</option>'; }).join('') +
        '</select>' + info('severity') + '</span><button type="button" class="ts-icon-btn ts-thr-rm" title="' + esc(t('common.remove', 'Remove')) + '">' + ICON.close + '</button></div>');
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
      var row = h('<div class="ts-thr ts-thr-state inherited' + (sh ? ' shadowed' : '') + '"><span class="ts-thr-static">' + esc(t('settings.is', 'Is')) + '</span><span class="ts-thr-static"></span>' +
        '<span class="ts-sev-select">' + sevDot(s.id) + esc(s.label) + '</span><span></span><span class="ts-thr-from"></span></div>');
      row.querySelectorAll('.ts-thr-static')[1].textContent = label(hit.value);
      row.querySelector('.ts-thr-from').textContent = sh ? t('settings.conditionReplacedHere', 'replaced here') : t('settings.conditionInheritedFrom', 'inherited from {level}', { level: levelLabel(hit.from) });
      list.appendChild(row);
    });
    if (!draft.conds.length && !any) { list.appendChild(h('<div class="ts-empty">' + esc(t('settings.noCondition', 'No condition: this measurement never raises an alarm.')) + '</div>')); }
    validate();
  }

  function validate() {
    var seen = {}, err = '';
    draft.conds.forEach(function (d) {
      if (seen[d.sev]) { err = t('settings.onlyOneCondition', 'Only one {severity} condition per measurement.', { severity: G.severity(d.sev).label }); }
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
  var sec = SECTIONS.filter(function (x) { return x[0] === section; })[0], title = sec[1];
  var needsUsers = section === 'notifications' && state.users === null;
  var ready = needsUsers
    ? tb.listUsers(state.customerId).then(function (u) { state.users = u; }).catch(function () { state.users = []; })
    : Promise.resolve();
  ready.then(function () {
    var dr = ui.openDrawer(esc(title), esc(kindName(state.origin.kind) + ' · ' + state.origin.name));
    if (fromAdd) { dr.onBack(openAdd); }
    var draft = {};
    pendingBook = {};
    var defs = SCALARS.filter(function (d) { return d.section === section; });
    defs.forEach(function (d) { if (isOwn(d.key)) { draft[d.key] = JSON.parse(JSON.stringify(ownVal(d.key))); } });
    if (section === 'notifications' && state.ancestors.length) {
      var b = h('<div class="ts-banner">' + ICON.info + '<span></span></div>');
      b.querySelector('span').textContent = t('settings.notificationsBanner', 'Only what you change here replaces the inherited settings; everything else keeps coming from {level}. A list you change here replaces the whole inherited list.',
        { level: levelLabel(state.ancestors[0].level) });
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
      commit(write, remove, sec[2], save, newEntries(write));
    });
  });
}

/** The book write for the entries *New contact* added to `write`'s lists: in
 * `write` itself on a customer, else a step before it. */
function newEntries(write) {
  var used = {};
  LIST_KEYS.forEach(function (k) {
    (write[k] || []).forEach(function (c) { if (c.type === 'book' && pendingBook[c.entryId]) { used[c.entryId] = pendingBook[c.entryId]; } });
  });
  if (!Object.keys(used).length) { return null; }
  var entries = Object.assign(bookCopy(), used);
  if (state.book.holder && state.book.holder.id === state.origin.id) { write[BOOK] = entries; return null; }
  return function () { return saveBook(entries); };
}

function tokenChips(ta, onChange) {
  var box = h('<div class="ts-tokens"></div>');
  G.TOKENS.forEach(function (tok) {
    var c = h('<button type="button" class="ts-chip"></button>');
    c.textContent = '+ ' + tok.label;
    c.title = t('settings.insertToken', 'Insert {token}', { token: tok.token });
    c.addEventListener('click', function () {
      var at = ta.selectionStart === undefined ? ta.value.length : ta.selectionStart;
      ta.value = ta.value.slice(0, at) + tok.token + ta.value.slice(ta.selectionEnd || at);
      onChange(); ta.focus();
    });
    box.appendChild(c);
  });
  return box;
}

function scalarField(d, draft) {
  var hit = inherited(d.key);
  var f = h('<div class="ts-field"><div class="ts-field-label"><span></span> ' + (d.tip ? info(d.tip) : '') +
    '<button type="button" class="ts-reset" hidden>' + esc(t('settings.resetToInherited', 'Reset to inherited')) + '</button></div><div class="ts-ctl"></div><div class="ts-field-hint"></div></div>');
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
      ? (hit ? t('settings.replacesFromHint', 'Replaces {what} from {level}', {
        what: d.type === 'text' ? t('settings.inheritedWording', 'the inherited wording') : d.type === 'contacts' ? t('settings.inheritedList', 'the inherited list')
          : fmtScalar(d, hit.value).replace(/<[^>]+>/g, ''), level: levelLabel(hit.from) }) : t('settings.setHere', 'Set here'))
      : (hit ? t('settings.inheritedFromHint', 'Inherited from {level}', { level: levelLabel(hit.from) })
        : d.type === 'bool' ? t('settings.unsetOff', 'Not set anywhere above: off') : t('settings.unset', 'Not set anywhere above'));
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
      sw.querySelector('span').textContent = cb.checked ? t('common.on', 'On') : t('common.off', 'Off');
      cb.addEventListener('change', function () { sw.querySelector('span').textContent = cb.checked ? t('common.on', 'On') : t('common.off', 'Off'); set(cb.checked); });
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
      var n = h('<span><input class="ts-input num" type="number" min="1" step="1"> ' + esc(d.type === 'days' ? t('settings.days', 'days') : t('settings.hours', 'hours')) + '</span>');
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
    counter.innerHTML = esc(t('settings.smsChars', '≈ {len} / {single} characters', { len: si.len, single: si.single })) + ' · ' +
      esc(over ? t('settings.smsTooLong', 'too long: at most {max} SMS', { max: si.maxParts }) : si.parts === 1 ? t('settings.smsOne', '1 SMS')
        : t('settings.smsMany', 'sent as {n} SMS', { n: si.parts })) +
      (si.gsm ? '' : esc(t('settings.smsSpecial', ' · special characters, 70 per SMS'))) + ' ' + info('smsLength');
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
  var adv = h('<details class="ts-adv"><summary>' + esc(t('settings.longerEmail', 'Longer text for e-mail')) + '</summary><div class="ts-adv-body">' +
    '<textarea class="ts-textarea" style="min-height:110px"></textarea><div class="ts-field-hint"></div></div></details>');
  var nta = adv.querySelector('textarea');
  nta.value = nested.key in draft ? draft[nested.key] : '';
  nta.placeholder = nHit ? t('settings.inheritedEmail', 'Inherited e-mail text from {level}', { level: levelLabel(nHit.from) }) : t('settings.emailEmpty', 'Empty: the e-mail uses the SMS text above');
  adv.querySelector('.ts-field-hint').textContent = t('settings.emailHint', 'No length limit. Leave empty to send the SMS text by e-mail too.');
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
  var picking = null;
  function allSev() { return G.SEVERITIES.map(function (s) { return s.id; }); }
  // A legacy external contact, or an entry New contact is adding: still edited in place.
  function inline(c) { return c.type === 'book' ? pendingBook[c.entryId] : c.type === 'user' ? null : c; }
  function problems() {
    return people.some(function (c) {
      var e = inline(c);
      return !!e && ((e.sms && !E164.test(e.sms)) || (e.email && !EMAIL.test(e.email)));
    });
  }
  function commitPeople() {
    set(people.filter(function (c) { var e = inline(c); return !e || e.name || e.sms || e.email; }));
    setValid(!problems());
  }

  function sevToggles(c) {
    var sevs = h('<div class="ts-sevs"></div>');
    G.SEVERITIES.slice().reverse().forEach(function (sv) {
      var btn = h('<button type="button" class="ts-sev-toggle">' + sevDot(sv.id) + esc(sv.label) + '</button>');
      btn.classList.toggle('on', c.severities.indexOf(sv.id) >= 0);
      btn.addEventListener('click', function () {
        var k = c.severities.indexOf(sv.id);
        if (k >= 0) { c.severities.splice(k, 1); } else { c.severities.push(sv.id); }
        btn.classList.toggle('on', k < 0);
        commitPeople();
      });
      sevs.appendChild(btn);
    });
    return sevs;
  }

  /** A platform user or a book entry: name and addresses from their source, the channels to use. */
  function personCard(c, person, kind, missing) {
    var el = h('<div class="ts-contact"><div class="ts-contact-user"><span class="ts-avatar"></span><div class="ts-grow"><div class="ts-row-label"></div>' +
      '<div class="ts-row-meta"></div></div><span class="ts-chip"></span></div><div class="ts-contact-via"></div></div>');
    el.querySelector('.ts-chip').textContent = kind;
    if (!person) {
      el.querySelector('.ts-avatar').textContent = '?';
      el.querySelector('.ts-row-label').textContent = missing;
      el.querySelector('.ts-row-meta').textContent = t('settings.contactGone', 'No longer exists, or not visible to you; no message reaches it.');
      return el;
    }
    el.querySelector('.ts-avatar').textContent = initials(person.name);
    el.querySelector('.ts-row-label').textContent = person.name;
    el.querySelector('.ts-row-meta').textContent = [person.email, person.phone].filter(Boolean).join(' · ') +
      (person.phone && !E164.test(person.phone) ? t('settings.phoneNotE164', ' — phone not in international format, SMS will fail') : '');
    var via = el.querySelector('.ts-contact-via');
    [['viaSms', t('glossary.setting.smsEnabled', 'SMS'), !!person.phone], ['viaEmail', t('glossary.setting.emailEnabled', 'E-mail'), !!person.email]].forEach(function (x) {
      var tip = !x[2] && x[0] === 'viaSms' && c.type === 'user' ? ' data-tip="noPhone"' : '';
      var lab = h('<label class="ts-switch' + (x[2] ? '' : ' off') + '"' + tip + '><input type="checkbox"> ' + esc(x[1]) + '</label>');
      var cb = lab.querySelector('input');
      cb.disabled = !x[2];
      cb.checked = !!c[x[0]] && x[2];
      cb.addEventListener('change', function () { c[x[0]] = cb.checked; commitPeople(); });
      via.appendChild(lab);
    });
    return el;
  }

  function render() {
    box.innerHTML = '';
    people.forEach(function (c, i) {
      c.severities = c.severities || allSev();
      var head = h('<div class="ts-contact-head"><span class="ts-summary">' + esc(t('settings.receives', 'Receives')) + '</span> ' + info('severity') +
        '<span class="ts-spacer"></span><button type="button" class="ts-icon-btn" title="' + esc(t('settings.removeContact', 'Remove contact')) + '">' + ICON.close + '</button></div>');
      var el, e = inline(c);
      if (c.type === 'user') {
        var u = userById(c.userId);
        el = personCard(c, u && { name: userName(u), email: u.email, phone: u.phone }, t('settings.platformUser', 'Platform user'), t('settings.unknownUser', 'Unknown user'));
      } else if (!e) {
        var b = state.book.entries[c.entryId];
        el = personCard(c, b && { name: entryName(b), email: b.email, phone: b.sms }, t('settings.externalContact', 'External contact'), t('settings.unknownEntry', 'Unknown entry'));
      } else {
        el = h('<div class="ts-contact"></div>');
        el.appendChild(entryFields(e, function () {
          if (c.type === 'book') { c.viaSms = !!e.sms; c.viaEmail = !!e.email; }
          commitPeople();
        }));
        if (c.type === 'book') { el.appendChild(h('<div class="ts-field-hint">' + esc(t('settings.newExternal', 'New external contact')) + '</div>')); }
      }
      el.appendChild(head);
      el.appendChild(sevToggles(c));
      head.querySelector('.ts-icon-btn').addEventListener('click', function () { people.splice(i, 1); commitPeople(); render(); });
      box.appendChild(el);
    });

    if (picking) {
      var taken = people.map(contactKey);
      var pick = h('<div class="ts-user-pick"><div class="ts-search">' + ICON.search + '<input class="ts-input"></div><div></div></div>');
      var q = pick.querySelector('input'), ul = pick.lastChild;
      q.placeholder = picking === 'user' ? t('settings.searchUsers', 'Search users') : t('settings.searchExternal', 'Search external contacts');
      var candidates = picking === 'user'
        ? (state.users || []).map(function (u) {
          return { key: 'u:' + u.id.id, name: userName(u), desc: u.email + (u.phone ? ' · ' + u.phone : t('settings.noPhone', ' · no phone')),
                   contact: { type: 'user', userId: u.id.id, viaSms: !!u.phone, viaEmail: true } };
        })
        : Object.keys(state.book.entries).map(function (id) {
          var b = state.book.entries[id];
          return { key: 'b:' + id, name: entryName(b), desc: [b.sms, b.email].filter(Boolean).join(' · '),
                   contact: { type: 'book', entryId: id, viaSms: !!b.sms, viaEmail: !!b.email } };
        });
      var fill = function () {
        ul.innerHTML = '';
        candidates.filter(function (x) {
          return taken.indexOf(x.key) < 0 && (x.name + ' ' + x.desc).toLowerCase().indexOf(q.value.toLowerCase()) >= 0;
        }).forEach(function (x) {
          var o = h('<div class="ts-opt" tabindex="0"><span class="ts-avatar"></span><div class="ts-opt-main"><div class="ts-opt-label"></div><div class="ts-opt-desc"></div></div></div>');
          o.setAttribute('data-pick', x.key);
          o.querySelector('.ts-avatar').textContent = initials(x.name);
          o.querySelector('.ts-opt-label').textContent = x.name;
          o.querySelector('.ts-opt-desc').textContent = x.desc;
          o.addEventListener('click', function () {
            people.push(Object.assign({ severities: allSev() }, x.contact));
            picking = null; commitPeople(); render();
          });
          ul.appendChild(o);
        });
        if (!ul.children.length) { ul.appendChild(h('<div class="ts-empty">' + (picking === 'user' ? esc(t('settings.noOtherUser', 'No other user.')) : Object.keys(state.book.entries).length
          ? esc(t('settings.noOtherExternal', 'No other external contact.')) : t('settings.noExternalYet', 'No external contact yet: <i>New external contact</i> adds one.')) + '</div>')); }
      };
      q.addEventListener('input', fill);
      fill();
      box.appendChild(pick);
      setTimeout(function () { q.focus(); }, 0);
    }

    var add = h('<div class="ts-add-row"><button type="button" class="ts-btn ghost" data-a="user">' + ICON.plus + esc(t('settings.platformUser', 'Platform user')) + '</button>' +
      '<button type="button" class="ts-btn ghost" data-a="book">' + ICON.plus + esc(t('settings.addFromBook', 'Add from known external contacts')) + '</button>' +
      '<button type="button" class="ts-btn ghost" data-a="ext">' + ICON.plus + esc(t('settings.newExternal', 'New external contact')) + '</button></div>');
    add.querySelector('[data-a=user]').addEventListener('click', function () { picking = picking === 'user' ? null : 'user'; render(); });
    add.querySelector('[data-a=book]').addEventListener('click', function () { picking = picking === 'book' ? null : 'book'; render(); });
    add.querySelector('[data-a=ext]').addEventListener('click', function () {
      picking = null;
      var id = 'b' + Math.random().toString(36).slice(2, 10);
      pendingBook[id] = { name: '', sms: '', email: '' };
      people.push({ type: 'book', entryId: id, viaSms: false, viaEmail: false, severities: allSev() });
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
