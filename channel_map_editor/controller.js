/*
 * Channel map editor — the CA-1 widget. An always-rendered panel (not a
 * click-triggered dialog): every other widget in this bundle
 * (`alarm_cascade_editor`, `config_overrides`) is a `static`/`latest`
 * html_container bound to a dashboard entity via its Data tab, and a panel
 * keeps this one on the same model — one mount point, one `ctx`/`container`
 * pair, no extra open/close plumbing on top of what html_container already
 * gives for free. A dialog would only pay for itself if the same dashboard
 * needed the editor to *not* take up permanent space; CA-1 is a deliberate,
 * infrequent admin flow reached by navigating to its own tab, not something
 * that needs to hide behind a button on a crowded screen.
 *
 * Bind this widget's datasource to:
 *  - a PROJECT or LOCATION -> "new" mode: pick/create a Station under it.
 *  - a STATION -> "swap" mode: prefilled from that station's own
 *    `config.channelMap`; changing the device moves the `Contains`
 *    STATION->DEVICE relation instead of creating a second one.
 *
 * Same runtime shape as the sibling widgets (html_container, Plain-HTML,
 * `window.<fn>(ctx, container)`, services via
 * `ctx.$scope.$injector.get(ctx.servicesMap.get('<name>'))` — see
 * `alarm_cascade_editor/controller.js`'s header and `widget_deploy.py`'s
 * module docstring) and depends on `resources/widgets/shared/resolver.js`
 * being loaded first, exactly like `config_overrides/controller.js`.
 *
 * Unlike the v2-onboarding Streamlit flow (`app/app_pages/onboarding.py`),
 * this widget does not load the peripheral catalog client-side (no
 * `logr-peripheral-catalog/catalog.json` fetch, no extra CDN dependency): a
 * device's active sources are read straight off its own
 * `subscriptions.<sourceKey>.enabled` attributes, and each source key is
 * exactly the `config.channelMap` value (CHANNEL_MAP.md §1).
 */

window.TerrySenseChannelMapEditor = function (ctx, container) {

var resolver = window.TerrySenseResolver;

function getService(name) {
  return ctx.$scope.$injector.get(ctx.servicesMap.get(name));
}

function toPromise(observable) {
  return new Promise(function (resolve, reject) {
    observable.subscribe({ next: function (v) { resolve(v); }, error: function (e) { reject(e); } });
  });
}

function entityIdObj(entityType, id) { return { entityType: entityType, id: id }; }

function httpGet(url, params) { return toPromise(getService('http').get(url, { params: params })); }
function httpPost(url, body) { return toPromise(getService('http').post(url, body || {})); }
function httpDelete(url, params) { return toPromise(getService('http').delete(url, { params: params })); }

function getAttrsMap(entityType, id, scope) {
  return toPromise(getService('attributeService').getEntityAttributes(entityIdObj(entityType, id), scope))
    .then(function (list) {
      var map = {};
      (list || []).forEach(function (a) { map[a.key] = a.value; });
      return map;
    })
    .catch(function () { return {}; });
}

function getAsset(id) { return toPromise(getService('assetService').getAsset(id)); }

// -- IO for resolver.buildChain/resolveStation -------------------------

var defaultsPromise = null;

var io = {
  fetchAttrs: function (entity) { return getAttrsMap(entity.entityType, entity.id, 'SERVER_SCOPE'); },
  fetchParent: function (entity) {
    var query = {
      parameters: { rootId: entity.id, rootType: 'ASSET', direction: 'TO', relationTypeGroup: 'COMMON', maxLevel: 1, fetchLastLevelOnly: false },
      filters: [{ relationType: 'Contains', entityTypes: ['ASSET'] }]
    };
    return toPromise(getService('entityRelationService').findByQuery(query)).then(function (relations) {
      if (!relations || !relations.length) { return null; }
      return getAsset(relations[0].from.id).then(function (asset) {
        return { entityType: 'ASSET', id: asset.id.id, name: asset.name, kind: asset.type };
      });
    });
  },
  fetchChildren: function (entity) {
    var query = {
      parameters: { rootId: entity.id, rootType: 'ASSET', direction: 'FROM', relationTypeGroup: 'COMMON', maxLevel: 1, fetchLastLevelOnly: false },
      filters: [{ relationType: 'Contains', entityTypes: ['ASSET'] }]
    };
    return toPromise(getService('entityRelationService').findByQuery(query)).then(function (relations) {
      var ids = {};
      (relations || []).forEach(function (r) { if (r.to.entityType === 'ASSET') { ids[r.to.id] = true; } });
      return Promise.all(Object.keys(ids).map(function (id) { return getAsset(id); }));
    }).then(function (assets) {
      return assets.map(function (a) { return { entityType: 'ASSET', id: a.id.id, name: a.name, kind: a.type }; });
    });
  },
  // `ownerId` (not `customerId`) is the field config_resolver.py's own
  // `_ancestors_nearest_first` reads for the same lookup — see
  // config_overrides/controller.js's `fetchCustomer` for why.
  fetchCustomer: function (entity) {
    return getAsset(entity.id).then(function (asset) {
      var owner = asset.ownerId;
      if (!owner || owner.entityType !== 'CUSTOMER') { return null; }
      return toPromise(getService('customerService').getCustomer(owner.id)).then(function (customer) {
        return { entityType: 'CUSTOMER', id: owner.id, name: customer.title || customer.name };
      });
    });
  },
  fetchDefaults: function () {
    if (!defaultsPromise) {
      defaultsPromise = httpGet('/api/user/assets', { type: 'Defaults', pageSize: '1', page: '0' }).then(function (page) {
        var item = page && page.data && page.data[0];
        return item ? { entityType: 'ASSET', id: item.id.id, name: item.name } : null;
      }).catch(function () { return null; });
    }
    return defaultsPromise;
  }
};

// -- devices / relations, not part of the resolver's IO contract --------

function findStationDeviceRelation(stationId) {
  var query = {
    parameters: { rootId: stationId, rootType: 'ASSET', direction: 'FROM', relationTypeGroup: 'COMMON', maxLevel: 1, fetchLastLevelOnly: false },
    filters: [{ relationType: 'Contains', entityTypes: ['DEVICE'] }]
  };
  return toPromise(getService('entityRelationService').findByQuery(query)).then(function (relations) {
    return (relations && relations.length) ? relations[0].to.id : null;
  });
}

function fetchDevice(id) { return httpGet('/api/device/' + id, {}); }

function listCustomerDevices(customerId) {
  return httpGet('/api/customer/' + customerId + '/devices', { pageSize: '200', page: '0' }).then(function (p) { return (p && p.data) || []; });
}
function listTenantDevices() {
  return httpGet('/api/tenant/devices', { pageSize: '200', page: '0' }).then(function (p) { return (p && p.data) || []; });
}

function createRelation(fromId, fromType, toId, toType) {
  return httpPost('/api/relation', {
    from: { id: fromId, entityType: fromType }, to: { id: toId, entityType: toType },
    type: 'Contains', typeGroup: 'COMMON'
  });
}
function deleteRelation(fromId, fromType, toId, toType) {
  return httpDelete('/api/relation', {
    fromId: fromId, fromType: fromType, toId: toId, toType: toType,
    relationType: 'Contains', relationTypeGroup: 'COMMON'
  });
}

// A customer admin can only create assets owned by their own customer.
function createStationAsset(name, customerId) {
  var body = { name: name, type: 'Station' };
  if (customerId) { body.customerId = { id: customerId, entityType: 'CUSTOMER' }; }
  return httpPost('/api/asset', body);
}

function saveServerAttrs(entity, attrs) {
  var pairs = Object.keys(attrs).map(function (k) { return { key: k, value: attrs[k] }; });
  if (!pairs.length) { return Promise.resolve(); }
  return toPromise(getService('attributeService').saveEntityAttributes(entityIdObj(entity.entityType, entity.id), 'SERVER_SCOPE', pairs));
}
function deleteServerAttrs(entity, keys) {
  if (!keys.length) { return Promise.resolve(); }
  return toPromise(getService('attributeService').deleteEntityAttributes(entityIdObj(entity.entityType, entity.id), 'SERVER_SCOPE', keys));
}

// -- device topology / subscriptions parsing (mirrors app/lib/catalog.py) --

var EMPTY_MARKER = '(empty)';
var TOPOLOGY_TYPE_RE = /^topology\.p(\d+)\.type$/;
var SOURCE_KEY_RE = /^p(\d+)\.([a-z][A-Za-z0-9]*)(?:\.g(\d+))?(?:\.i(\d+))?$/;

function topologyFromAttrs(attrs) {
  var nodes = [];
  Object.keys(attrs).forEach(function (key) {
    var m = TOPOLOGY_TYPE_RE.exec(key);
    if (!m) { return; }
    var pos = Number(m[1]);
    var type = String(attrs[key] || '').trim();
    if (!type || type === EMPTY_MARKER) { return; }
    nodes.push({ position: pos, type: type, version: attrs['topology.p' + pos + '.version'] });
  });
  return nodes.sort(function (a, b) { return a.position - b.position; });
}

function parseSourceKey(key) {
  var m = SOURCE_KEY_RE.exec(key);
  if (!m) { return null; }
  return {
    position: Number(m[1]), kind: m[2],
    group: m[3] !== undefined ? Number(m[3]) : 0,
    index: m[4] !== undefined ? Number(m[4]) : 0,
    indexed: m[4] !== undefined
  };
}

function activeSourcesFromAttrs(attrs) {
  var enabled = {};
  Object.keys(attrs).forEach(function (key) {
    if (key.indexOf('subscriptions.') !== 0) { return; }
    if (key.slice(-8) !== '.enabled') { return; }
    if (attrs[key] !== true && attrs[key] !== 'true') { return; }
    var sourceKey = key.slice('subscriptions.'.length, -'.enabled'.length);
    enabled[sourceKey] = true;
  });
  return Object.keys(enabled).map(function (sourceKey) {
    var parsed = parseSourceKey(sourceKey);
    if (!parsed) { return null; }
    return {
      sourceKey: sourceKey, position: parsed.position, kind: parsed.kind,
      group: parsed.group, index: parsed.index, indexed: parsed.indexed,
      interval_s: attrs['subscriptions.' + sourceKey + '.interval']
    };
  }).filter(Boolean).sort(function (a, b) { return a.position - b.position || a.sourceKey.localeCompare(b.sourceKey); });
}

function channelsOfAttrValue(raw) {
  var parsed = null;
  if (raw) { try { parsed = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (e) { parsed = null; } }
  return (parsed && parsed.channels) || {};
}

function namesForKind(dictionary, kind) {
  var camel = resolver.camelKind(kind);
  return Object.keys(dictionary || {}).filter(function (name) {
    return resolver.camelKind(dictionary[name].kind) === camel;
  }).sort();
}

// -- DOM ----------------------------------------------------------------

var root = container;
var els = {
  title: root.querySelector('.cme-title'),
  mode: root.querySelector('.cme-mode'),
  loading: root.querySelector('.cme-loading'),
  message: root.querySelector('.cme-message'),
  content: root.querySelector('.cme-content'),

  deviceCurrent: root.querySelector('.cme-device-current'),
  deviceCurrentName: root.querySelector('.cme-device-current-name'),
  deviceChange: root.querySelector('.cme-device-change'),
  devicePicker: root.querySelector('.cme-device-picker'),
  deviceSelect: root.querySelector('.cme-device-select'),

  topology: root.querySelector('.cme-topology'),

  stationFixed: root.querySelector('.cme-station-fixed'),
  stationFixedName: root.querySelector('.cme-station-fixed-name'),
  stationPicker: root.querySelector('.cme-station-picker'),
  stationSelect: root.querySelector('.cme-station-select'),
  stationName: root.querySelector('.cme-station-name'),

  mapBody: root.querySelector('.cme-map-body'),
  mapEmpty: root.querySelector('.cme-map-empty'),

  previewJson: root.querySelector('.cme-preview-json'),

  save: root.querySelector('.cme-save'),
  footerMessage: root.querySelector('.cme-footer-message')
};

var state = {
  origin: null, mode: 'new', customer: null,
  devices: [], device: null,
  clientAttrs: {}, topology: [], activeSources: [],
  dictionary: {},
  stationMode: 'existing', stations: [], selectedStation: null,
  savedChannelMap: null, savedNamesBySourceKey: {},
  names: {}
};

function setMessage(text, cls) {
  els.message.hidden = !text;
  els.message.textContent = text || '';
  els.message.className = 'cme-message' + (cls ? ' ' + cls : '');
}

function setFooterMessage(text, cls) {
  els.footerMessage.textContent = text || '';
  els.footerMessage.className = 'cme-footer-message' + (cls ? ' ' + cls : '');
}

// -- load -----------------------------------------------------------------

function resolveOriginatorDatasource() {
  var live = ctx.datasources && ctx.datasources[0];
  if (live && live.entityId) { return Promise.resolve(live); }
  var configured = ctx.widget && ctx.widget.config && ctx.widget.config.datasources;
  if (!configured || !configured.length) { return Promise.resolve(null); }
  return toPromise(ctx.aliasController.resolveDatasources(JSON.parse(JSON.stringify(configured)), true))
    .then(function (resolved) { return (resolved || []).filter(function (d) { return d && d.entityId; })[0] || null; });
}

function load() {
  els.loading.hidden = false;
  els.content.hidden = true;
  setMessage('');

  resolveOriginatorDatasource().then(function (ds) {
    if (!ds || ds.entityType !== 'ASSET') {
      els.loading.textContent = 'No entity bound to this widget — bind a PROJECT, LOCATION or STATION in the widget\'s Data tab.';
      return;
    }
    return getAsset(ds.entityId).then(function (asset) {
      state.origin = { entityType: 'ASSET', id: asset.id.id, name: asset.name, kind: asset.type };
      state.mode = String(asset.type || '').toLowerCase() === 'station' ? 'swap' : 'new';
      els.title.textContent = state.origin.kind + ' · ' + state.origin.name;
      els.mode.textContent = state.mode === 'swap' ? 'Swap mode' : 'New station';

      return resolver.buildChain(state.origin, io).then(function (chain) {
        var custLevel = chain.filter(function (l) { return l.role === 'customer'; })[0];
        state.customer = custLevel ? { id: custLevel.id, name: custLevel.name } : null;

        return Promise.all([
          state.customer ? listCustomerDevices(state.customer.id) : listTenantDevices(),
          io.fetchDefaults().then(function (d) { return d ? io.fetchAttrs(d) : {}; }),
          state.mode === 'swap' ? io.fetchAttrs(state.origin) : Promise.resolve(null),
          state.mode === 'new' ? io.fetchChildren(state.origin) : Promise.resolve([])
        ]);
      }).then(function (results) {
        state.devices = results[0];
        state.dictionary = (function (attrs) {
          var raw = attrs['config.channelNames'];
          if (!raw) { return {}; }
          try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (e) { return {}; }
        })(results[1]);
        var ownAttrs = results[2];
        var children = results[3] || [];
        state.stations = children.filter(function (e) { return String(e.kind || '').toLowerCase() === 'station'; });

        if (!Object.keys(state.dictionary).length) {
          // Same empty-dictionary state onboarding.py treats as a hard stop
          // (app/app_pages/onboarding.py step 2): either the tenant's
          // `config.channelNames` was never seeded, or (new in this model)
          // the Defaults asset isn't shared with this customer yet, so
          // `/api/user/assets?type=Defaults` came back empty. Warn rather
          // than block — the device/station steps above are still useful on
          // their own.
          setMessage('The channel-name dictionary is empty — no active source can be named until a tenant admin seeds config.channelNames on the Defaults asset (or shares it with this customer).', 'cme-error');
        }

        if (state.mode === 'swap') {
          state.selectedStation = state.origin;
          state.savedChannelMap = channelsOfAttrValue(ownAttrs['config.channelMap']);
          state.savedNamesBySourceKey = {};
          Object.keys(state.savedChannelMap).forEach(function (name) {
            state.savedNamesBySourceKey[state.savedChannelMap[name]] = name;
          });
          var savedDeviceId = (function () {
            var raw = ownAttrs['config.channelMap'];
            var parsed = null;
            if (raw) { try { parsed = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (e) { parsed = null; } }
            return parsed && parsed.sourceDeviceId;
          })();
          if (savedDeviceId) {
            return fetchDevice(savedDeviceId).then(function (device) {
              return selectDevice({ id: { id: device.id.id }, name: device.name, type: device.type }, { silent: true });
            }).then(renderAll);
          }
        }
        renderAll();
      });
    });
  }).catch(function (err) {
    els.loading.textContent = 'Failed to load: ' + (err && err.message ? err.message : err);
  });
}

// -- device selection -----------------------------------------------------

function selectDevice(device, opts) {
  state.device = { id: device.id.id, name: device.name, type: device.type };
  return getAttrsMap('DEVICE', state.device.id, 'CLIENT_SCOPE').then(function (attrs) {
    state.clientAttrs = attrs;
    state.topology = topologyFromAttrs(attrs);
    state.activeSources = activeSourcesFromAttrs(attrs);
    state.names = {};
    state.activeSources.forEach(function (s) {
      var preferred = state.savedNamesBySourceKey[s.sourceKey];
      if (preferred) { state.names[s.sourceKey] = preferred; }
    });
    if (!opts || !opts.silent) { renderAll(); }
  });
}

// -- render -----------------------------------------------------------------

function renderDevicePicker() {
  var showCurrent = state.mode === 'swap' && state.device;
  els.deviceCurrent.hidden = !showCurrent;
  if (showCurrent) { els.deviceCurrentName.textContent = state.device.name; }
  els.devicePicker.hidden = showCurrent && !els.devicePicker.dataset.forced;

  els.deviceSelect.innerHTML = '<option value="">(select a device)</option>';
  state.devices.forEach(function (d) {
    var id = d.id && d.id.id ? d.id.id : d.id;
    var o = document.createElement('option');
    o.value = id; o.textContent = d.name + (d.type ? ' (' + d.type + ')' : '');
    if (state.device && state.device.id === id) { o.selected = true; }
    els.deviceSelect.appendChild(o);
  });
}

function renderTopology() {
  els.topology.innerHTML = '';
  if (!state.device) {
    els.topology.innerHTML = '<p class="cme-map-empty">Pick a device above.</p>';
    return;
  }
  if (!state.topology.length) {
    els.topology.innerHTML = '<p class="cme-map-empty">This device has reported no bus topology yet.</p>';
  }
  state.topology.forEach(function (node) {
    var sources = state.activeSources.filter(function (s) { return s.position === node.position; });
    var div = document.createElement('div'); div.className = 'cme-topology-pos';
    var head = document.createElement('div'); head.className = 'cme-pos-head';
    head.textContent = 'Position ' + node.position + ' · ' + node.type + (node.version ? ' v' + node.version : '');
    var srcs = document.createElement('div'); srcs.className = 'cme-pos-sources';
    srcs.textContent = sources.length
      ? sources.map(function (s) { return s.sourceKey + ' (' + s.kind + ')'; }).join(', ')
      : 'no active sources';
    div.appendChild(head); div.appendChild(srcs);
    els.topology.appendChild(div);
  });
}

function renderStationPicker() {
  var swap = state.mode === 'swap';
  els.stationFixed.hidden = !swap;
  els.stationPicker.hidden = swap;
  if (swap) { els.stationFixedName.textContent = state.origin.name; return; }

  els.stationSelect.innerHTML = '<option value="">(select a station)</option>';
  state.stations.forEach(function (s) {
    var o = document.createElement('option'); o.value = s.id; o.textContent = s.name;
    els.stationSelect.appendChild(o);
  });
  els.stationSelect.hidden = state.stationMode !== 'existing';
  els.stationName.hidden = state.stationMode !== 'new';
}

function renderMapRows() {
  els.mapBody.innerHTML = '';
  els.mapEmpty.hidden = !!state.activeSources.length;
  state.activeSources.forEach(function (s) {
    var options = namesForKind(state.dictionary, s.kind);
    var tr = document.createElement('tr');
    var tdSrc = document.createElement('td'); tdSrc.textContent = s.sourceKey;
    var tdKind = document.createElement('td'); tdKind.textContent = s.kind;
    var tdPos = document.createElement('td'); tdPos.textContent = String(s.position);
    var tdName = document.createElement('td');
    var select = document.createElement('select');
    select.innerHTML = '<option value="">(select a name)</option>';
    if (!options.length) {
      select.disabled = true;
      select.innerHTML = '<option value="">no dictionary name for kind ' + s.kind + '</option>';
    } else {
      options.forEach(function (name) {
        var o = document.createElement('option'); o.value = name;
        var entry = state.dictionary[name];
        o.textContent = entry && entry.label ? entry.label + ' (' + name + ')' : name;
        if (state.names[s.sourceKey] === name) { o.selected = true; }
        select.appendChild(o);
      });
    }
    select.addEventListener('change', function () {
      if (select.value) { state.names[s.sourceKey] = select.value; } else { delete state.names[s.sourceKey]; }
      renderPreviewAndSaveState();
    });
    tdName.appendChild(select);
    tr.appendChild(tdSrc); tr.appendChild(tdKind); tr.appendChild(tdPos); tr.appendChild(tdName);
    els.mapBody.appendChild(tr);
  });
}

function buildChannelMap() {
  var channels = {};
  state.activeSources.forEach(function (s) {
    var name = state.names[s.sourceKey];
    if (!name) { return; }
    channels[name] = s.sourceKey;
  });
  return { sourceDeviceId: state.device ? state.device.id : null, channels: channels };
}

function validate() {
  var problems = [];
  if (!state.device) { problems.push('Pick a device.'); }
  var channelMap = buildChannelMap();
  var names = Object.keys(channelMap.channels);
  if (!names.length) { problems.push('Name at least one active source.'); }
  if (state.mode === 'new') {
    if (state.stationMode === 'existing' && !state.selectedStation) { problems.push('Pick an existing station, or switch to "Create a new station".'); }
    if (state.stationMode === 'new' && !(els.stationName.value || '').trim()) { problems.push('Name the new station.'); }
  }
  return problems;
}

function renderPreviewAndSaveState() {
  var channelMap = buildChannelMap();
  els.previewJson.textContent = JSON.stringify(channelMap, null, 2);
  var problems = validate();
  els.save.disabled = problems.length > 0;
  setFooterMessage(problems.length ? problems[0] : '');
}

function renderAll() {
  els.loading.hidden = true;
  els.content.hidden = false;
  renderDevicePicker();
  renderTopology();
  renderStationPicker();
  renderMapRows();
  renderPreviewAndSaveState();
}

// -- events -----------------------------------------------------------------

els.deviceChange.addEventListener('click', function () {
  els.devicePicker.dataset.forced = '1';
  els.devicePicker.hidden = false;
});

els.deviceSelect.addEventListener('change', function () {
  var id = els.deviceSelect.value;
  if (!id) { return; }
  var picked = state.devices.filter(function (d) { return (d.id.id || d.id) === id; })[0];
  if (!picked) { return; }
  selectDevice(picked);
});

Array.prototype.forEach.call(root.querySelectorAll('input[name="cme-station-mode"]'), function (radio) {
  radio.addEventListener('change', function () {
    if (radio.checked) { state.stationMode = radio.value; renderStationPicker(); renderPreviewAndSaveState(); }
  });
});
els.stationSelect.addEventListener('change', function () {
  var id = els.stationSelect.value;
  state.selectedStation = state.stations.filter(function (s) { return s.id === id; })[0] || null;
  renderPreviewAndSaveState();
});
els.stationName.addEventListener('input', renderPreviewAndSaveState);

els.save.addEventListener('click', function () {
  var problems = validate();
  if (problems.length) { setFooterMessage(problems[0], 'cme-error'); return; }
  els.save.disabled = true;
  setFooterMessage('Saving…');

  saveAll().then(function () {
    setFooterMessage('Saved — station config.channelMap updated and resolved.', 'cme-ok');
    load();
  }).catch(function (err) {
    setFooterMessage('Save failed: ' + (err && err.message ? err.message : err), 'cme-error');
    els.save.disabled = false;
  });
});

function ensureStation() {
  if (state.mode === 'swap') { return Promise.resolve(state.origin); }
  if (state.stationMode === 'existing') { return Promise.resolve(state.selectedStation); }

  var name = els.stationName.value.trim();
  return createStationAsset(name, state.customer ? state.customer.id : null).then(function (created) {
    var station = { entityType: 'ASSET', id: created.id.id, name: created.name, kind: 'Station' };
    return createRelation(state.origin.id, 'ASSET', station.id, 'ASSET').then(function () { return station; });
  });
}

function ensureDeviceRelation(station) {
  return findStationDeviceRelation(station.id).then(function (existingDeviceId) {
    if (existingDeviceId === state.device.id) { return; }
    var work = Promise.resolve();
    if (existingDeviceId) {
      work = work.then(function () { return deleteRelation(station.id, 'ASSET', existingDeviceId, 'DEVICE'); });
    }
    return work.then(function () { return createRelation(station.id, 'ASSET', state.device.id, 'DEVICE'); });
  });
}

function saveAll() {
  var channelMap = buildChannelMap();
  var station;
  return ensureStation().then(function (s) {
    station = s;
    if (!station) { throw new Error('No station to save to.'); }
    return ensureDeviceRelation(station);
  }).then(function () {
    return saveServerAttrs(station, { 'config.channelMap': channelMap });
  }).then(function () {
    return Promise.all([resolver.resolveStation(station, io), io.fetchAttrs(station)]);
  }).then(function (r) {
    var resolved = r[0], currentAttrs = r[1];
    var diff = resolver.effectiveDiff(currentAttrs, resolved);
    return saveServerAttrs(station, diff.toWrite).then(function () { return deleteServerAttrs(station, diff.toDelete); });
  });
}

load();

};
