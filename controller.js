/*
 * Alarm cascade editor — CA-2 pattern-B widget (ALARMING.md §5, FRONTEND.md).
 *
 * Runs as a "terrySense" library widget built on ThingsBoard's stock HTML
 * Container widget type (Plain HTML mode). Two runtime API points confirmed
 * against ThingsBoard PE's own docs (thingsboard.io/docs/pe/reference/widgets
 * /html-widgets/html-container/) after two wrong guesses each:
 *
 * - This script is the BODY of a function called with two arguments: `ctx`
 *   (the WidgetContext) and `container` (the widget's DOM element, Plain HTML
 *   mode only). `ctx.$container` is Angular-mode-only and is undefined here —
 *   use the `container` argument directly.
 * - `ctx` does NOT expose `attributeService`/`entityRelationService`/
 *   `assetService` as direct properties. Reach any Angular service through
 *   `ctx.$scope.$injector.get(ctx.servicesMap.get('<serviceName>'))` — see
 *   `getService()` below. This is the same pattern the "Potfrei Module DRYC"
 *   dashboard's own Add/Edit/Delete asset actions already use live on this
 *   tenant (`terrysense/operations/widget_deploy.py`'s module docstring has
 *   the fuller trail).
 *
 * This is a JS port of `logr-cloud-tool/terrysense/operations/config_resolver.py`
 * (ConfigResolver._ancestors_nearest_first / _attrs_of / _first_set /
 * _resolve_field, plus descendant_stations reversed into a channel-discovery
 * union). It resolves AND WRITES `effective.*` client-side, on save — the
 * deliberate trade-off recorded in the `pure-jumping-forest.md` plan: no new
 * backend service, at the cost of the algorithm now living in two languages.
 * Keep this in sync by hand if CONFIG_CASCADE.md's resolution rules change.
 *
 * Scope: CRITICAL severity only (v1 parity, see the plan). Extending to
 * warning/minor/major is additive — fields are already severity-namespaced
 * here and in the Python resolver.
 *
 * Packaging: this file is uploaded as ONE ThingsBoard JS resource (Resources
 * library, EXTENSION sub-type — a classic script, not an ES module, so a
 * top-level `var`/`function` here would otherwise leak into the global scope
 * shared with every other loaded resource). Wrapping the whole thing in one
 * function assigned to `window.TerrySenseAlarmCascadeEditor` keeps everything
 * else private and gives the widget's own tiny `settings.js` stub
 * (`window.TerrySenseAlarmCascadeEditor(ctx, container);`) one call to make.
 * `terrysense/operations/widget_deploy.py` uploads/updates this resource and
 * wires the widget type's descriptor `resources` to load it — this file is
 * the single source of truth; nowhere else embeds a copy of the logic.
 */

window.TerrySenseAlarmCascadeEditor = function (ctx, container) {

function getService(name) {
  return ctx.$scope.$injector.get(ctx.servicesMap.get(name));
}

var SEVERITY = 'critical';
var PER_KEY_FIELDS_NUMERIC = ['unit', 'hysteresis'];
var ALARM_FIELDS_NUMERIC = ['alarm.' + SEVERITY + '.thresholdMin', 'alarm.' + SEVERITY + '.thresholdMax'];
var FIELDS_BOOLEAN = ['textWhenTrue', 'textWhenFalse', 'alarm.' + SEVERITY + '.state'];

var DECODER_UNITS = {
  temperature: '°C', humidity: '%', pressure: 'hPa', ph: 'pH', conductivity: 'µS/cm',
  distance: 'm', flow: 'm³/h', volume: 'm³', angle: '°', voltage: 'V', current: 'A',
  power: 'W', percent: '%', duration: 's'
};
var BOOLEAN_KINDS = { boolean: true };

function camelKind(kind) {
  return kind ? String(kind) : null;
}

function kindClass(kind) {
  return BOOLEAN_KINDS[camelKind(kind)] ? 'boolean' : 'numeric';
}

function channelFields(kind) {
  return kindClass(kind) === 'boolean'
    ? FIELDS_BOOLEAN.slice()
    : PER_KEY_FIELDS_NUMERIC.concat(ALARM_FIELDS_NUMERIC);
}

// -- Promise wrapper over TB's Observable-returning Angular services --------

function toPromise(observable) {
  return new Promise(function (resolve, reject) {
    observable.subscribe({
      next: function (v) { resolve(v); },
      error: function (e) { reject(e); }
    });
  });
}

function entityIdObj(entityType, id) {
  return { entityType: entityType, id: id };
}

function getAttrsMap(entityType, id) {
  return toPromise(getService('attributeService').getEntityAttributes(entityIdObj(entityType, id), 'SERVER_SCOPE'))
    .then(function (list) {
      var map = {};
      (list || []).forEach(function (a) { map[a.key] = a.value; });
      return map;
    })
    .catch(function () { return {}; }); // an entity with no readable attrs resolves empty, not fatal
}

function getAsset(id) {
  return toPromise(getService('assetService').getAsset(id));
}

function getTenantId() {
  var user = getService('userService').getCurrentUser();
  return Promise.resolve(user.tenantId.id);
}

// -- Cascade walk (port of config_resolver.py lines 335-381) ----------------

var attrCache = {}; // "TYPE:id" -> Promise<map>, cleared after every save

function attrsOfCached(entityType, id) {
  var key = entityType + ':' + id;
  if (!attrCache[key]) { attrCache[key] = getAttrsMap(entityType, id); }
  return attrCache[key];
}

function findParentAssetId(assetId) {
  var query = {
    parameters: {
      rootId: assetId, rootType: 'ASSET', direction: 'TO',
      relationTypeGroup: 'COMMON', maxLevel: 1, fetchLastLevelOnly: false
    },
    filters: [{ relationType: 'Contains', entityTypes: ['ASSET'] }]
  };
  return toPromise(getService('entityRelationService').findByQuery(query)).then(function (relations) {
    if (!relations || !relations.length) { return null; }
    return relations[0].from.id;
  });
}

function ancestorsNearestFirst(originatorType, originatorId, originatorName, originatorKind) {
  var chain = [{ entityType: originatorType, id: originatorId, kind: originatorKind || originatorType, name: originatorName }];
  var seen = {}; seen[originatorId] = true;

  function step(currentId, depth) {
    if (depth > 12) { return Promise.resolve(); }
    return findParentAssetId(currentId).then(function (parentId) {
      if (!parentId || seen[parentId]) { return; }
      seen[parentId] = true;
      return getAsset(parentId).then(function (asset) {
        chain.push({ entityType: 'ASSET', id: parentId, kind: asset.type || 'Asset', name: asset.name });
        return step(parentId, depth + 1);
      });
    });
  }

  return step(originatorId, 0).then(function () {
    return getTenantId();
  }).then(function (tenantId) {
    chain.push({ entityType: 'TENANT', id: tenantId, kind: 'Tenant', name: 'tenant defaults' });
    return chain;
  });
}

function levelDisplay(level) {
  return level.entityType === 'TENANT' ? 'Tenant default' : (level.kind + ' · ' + level.name);
}

function firstSet(chain, key) {
  var i = 0;
  function next() {
    if (i >= chain.length) { return Promise.resolve(null); }
    var level = chain[i++];
    return attrsOfCached(level.entityType, level.id).then(function (attrs) {
      if (Object.prototype.hasOwnProperty.call(attrs, key) && attrs[key] !== null && attrs[key] !== undefined) {
        return { value: attrs[key], level: level };
      }
      return next();
    });
  }
  return next();
}

// Port of ConfigResolver._resolve_field (config_resolver.py lines 442-477).
function resolveField(chain, channel, kind, field) {
  var chanKey = 'channel.' + channel + '.' + field;
  return firstSet(chain, chanKey).then(function (hit) {
    if (hit) { return { value: hit.value, source: levelDisplay(hit.level) + ' · channel', overrideKey: chanKey }; }

    var camel = camelKind(kind);
    if (!camel) { return null; }
    var kindKey = 'kind.' + camel + '.' + field;
    return firstSet(chain, kindKey).then(function (hit2) {
      if (hit2) { return { value: hit2.value, source: levelDisplay(hit2.level) + ' · kind ' + camel, overrideKey: kindKey }; }
      if (field === 'unit' && DECODER_UNITS[camel]) {
        return { value: DECODER_UNITS[camel], source: 'Decoder default (SI, ' + camel + ')', overrideKey: kindKey };
      }
      return null;
    });
  });
}

// -- Channel discovery --------------------------------------------------
// Station: its own config.channelMap. Project/Location: union across
// descendant Station assets (reversed port of descendant_stations(), lines
// 308-331 — there it fans out to WRITE; here it only discovers to READ).

function channelMapOf(stationId) {
  return getAttrsMap('ASSET', stationId).then(function (attrs) {
    var raw = attrs['config.channelMap'];
    if (!raw) { return {}; }
    try {
      var parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      var out = {};
      Object.keys(parsed).forEach(function (channel) { out[channel] = (parsed[channel] || {}).kind || null; });
      return out;
    } catch (e) { return {}; }
  });
}

function findDescendantStations(rootId) {
  var query = {
    parameters: {
      rootId: rootId, rootType: 'ASSET', direction: 'FROM',
      relationTypeGroup: 'COMMON', maxLevel: 10, fetchLastLevelOnly: false
    },
    filters: [{ relationType: 'Contains', entityTypes: ['ASSET'] }]
  };
  return toPromise(getService('entityRelationService').findByQuery(query)).then(function (relations) {
    var ids = {};
    (relations || []).forEach(function (r) { ids[r.to.id] = true; });
    return Promise.all(Object.keys(ids).map(function (id) { return getAsset(id); }));
  }).then(function (assets) {
    return assets.filter(function (a) { return (a.type || '').toLowerCase() === 'station'; });
  });
}

function discoverChannels(originator) {
  if ((originator.subType || '').toLowerCase() === 'station') {
    return channelMapOf(originator.id).then(function (map) { return { channels: map, stations: [originator] }; });
  }
  return findDescendantStations(originator.id).then(function (stations) {
    return Promise.all(stations.map(function (s) { return channelMapOf(s.id); })).then(function (maps) {
      var union = {};
      maps.forEach(function (m) { Object.keys(m).forEach(function (c) { if (!(c in union)) { union[c] = m[c]; } }); });
      return { channels: union, stations: stations };
    });
  });
}

// -- Rendering ----------------------------------------------------------

var root = container;
var els = {
  title: root.querySelector('.ace-title'),
  status: root.querySelector('.ace-status'),
  loading: root.querySelector('.ace-loading'),
  table: root.querySelector('.ace-table'),
  tbody: root.querySelector('.ace-table tbody'),
  save: root.querySelector('.ace-save'),
  message: root.querySelector('.ace-message')
};

var currentOriginator = null;
var currentChain = null;
var currentStations = [];

function setMessage(text, cls) {
  els.message.textContent = text || '';
  els.message.className = 'ace-message' + (cls ? ' ' + cls : '');
}

function renderRows(originator, channels, resolved, overrides) {
  els.tbody.innerHTML = '';
  var channelNames = Object.keys(channels).sort();
  if (!channelNames.length) {
    els.tbody.innerHTML = '<tr><td colspan="5">No channels found ' +
      ((originator.subType || '').toLowerCase() === 'station' ? '(config.channelMap is empty).' : '(no descendant stations with a channelMap).') +
      '</td></tr>';
  }
  channelNames.forEach(function (channel) {
    var kind = channels[channel];
    var fields = channelFields(kind);
    fields.forEach(function (field, idx) {
      var tr = document.createElement('tr');
      if (idx === 0) { tr.className = 'ace-channel-first'; }
      var effKey = channel + '.' + field;
      var res = resolved[effKey];
      var overrideKey = 'channel.' + channel + '.' + field;
      var currentOverride = overrides[overrideKey];

      var tdChannel = document.createElement('td'); tdChannel.textContent = idx === 0 ? (channel + ' (' + (kind || '?') + ')') : '';
      var tdField = document.createElement('td'); tdField.textContent = field;
      var tdEff = document.createElement('td'); tdEff.className = 'ace-effective';
      tdEff.textContent = res ? String(res.value) : '—';
      var tdSource = document.createElement('td'); tdSource.className = 'ace-source';
      tdSource.textContent = res ? res.source : 'unset';
      var tdOverride = document.createElement('td');
      var input = document.createElement('input');
      input.className = 'ace-override';
      input.type = 'text';
      input.value = currentOverride === undefined || currentOverride === null ? '' : String(currentOverride);
      input.setAttribute('data-override-key', overrideKey);
      input.setAttribute('data-original', input.value);
      input.addEventListener('input', function () {
        input.classList.toggle('ace-dirty', input.value !== input.getAttribute('data-original'));
        updateSaveEnabled();
      });
      tdOverride.appendChild(input);

      tr.appendChild(tdChannel); tr.appendChild(tdField); tr.appendChild(tdEff);
      tr.appendChild(tdSource); tr.appendChild(tdOverride);
      els.tbody.appendChild(tr);
    });
  });
}

function updateSaveEnabled() {
  var dirty = root.querySelectorAll('.ace-override.ace-dirty');
  els.save.disabled = dirty.length === 0;
}

// -- Load / resolve / render ---------------------------------------------

function load() {
  els.loading.hidden = false;
  els.table.hidden = true;
  setMessage('');

  var ds = ctx.datasources && ctx.datasources[0];
  if (!ds || !ds.entityId) {
    els.loading.textContent = 'No entity bound to this widget.';
    return;
  }

  var originator = { id: ds.entityId, entityType: ds.entityType, name: ds.entityName, subType: ds.entityType };
  getAsset(ds.entityId).then(function (asset) {
    originator.subType = asset.type || 'Asset';
    originator.name = asset.name;
    els.title.textContent = originator.subType + ' · ' + originator.name;
    currentOriginator = originator;

    return Promise.all([
      ancestorsNearestFirst('ASSET', originator.id, originator.name, originator.subType),
      discoverChannels(originator),
      attrsOfCached('ASSET', originator.id) // own overrides, read directly (not through the chain)
    ]);
  }).then(function (results) {
    var chain = results[0], discovery = results[1], ownAttrs = results[2];
    currentChain = chain;
    currentStations = discovery.stations;
    els.status.textContent = chain.map(levelDisplay).join(' → ');

    var channelNames = Object.keys(discovery.channels);
    var resolvedKeys = [];
    channelNames.forEach(function (channel) {
      channelFields(discovery.channels[channel]).forEach(function (field) {
        resolvedKeys.push({ channel: channel, field: field });
      });
    });

    return Promise.all(
      resolvedKeys.map(function (k) { return resolveField(chain, k.channel, discovery.channels[k.channel], k.field); })
    ).then(function (values) {
      var resolved = {};
      resolvedKeys.forEach(function (k, i) {
        if (values[i]) { resolved[k.channel + '.' + k.field] = values[i]; }
      });
      els.loading.hidden = true;
      els.table.hidden = false;
      renderRows(originator, discovery.channels, resolved, ownAttrs);
      updateSaveEnabled();
    });
  }).catch(function (err) {
    els.loading.textContent = 'Failed to resolve: ' + (err && err.message ? err.message : err);
  });
}

// -- Save: write overrides, then re-resolve + write effective.* on every
// affected station (port of ConfigResolver.resolve_station + .apply(),
// config_resolver.py lines 274-306). --------------------------------------

function save() {
  var dirtyInputs = root.querySelectorAll('.ace-override.ace-dirty');
  if (!dirtyInputs.length || !currentOriginator) { return; }

  els.save.disabled = true;
  setMessage('Saving…');

  var overrideAttrs = [];
  dirtyInputs.forEach(function (input) {
    var key = input.getAttribute('data-override-key');
    var raw = input.value;
    var value = raw === '' ? null : (isNaN(Number(raw)) ? raw : Number(raw));
    overrideAttrs.push({ key: key, value: value });
  });

  var originatorIdObj = entityIdObj('ASSET', currentOriginator.id);
  toPromise(getService('attributeService').saveEntityAttributes(originatorIdObj, 'SERVER_SCOPE', overrideAttrs))
    .then(function () {
      attrCache = {}; // the write invalidates every cached level below/at the originator
      var stations = currentStations.length ? currentStations : [currentOriginator];
      return Promise.all(stations.map(function (station) { return resolveAndApply(station); }));
    })
    .then(function () {
      setMessage('Saved — ' + (currentStations.length || 1) + ' station(s) re-resolved.', 'ace-ok');
      load();
    })
    .catch(function (err) {
      setMessage('Save failed: ' + (err && err.message ? err.message : err), 'ace-error');
      els.save.disabled = false;
    });
}

function resolveAndApply(station) {
  return ancestorsNearestFirst('ASSET', station.id, station.name, station.type || 'Station')
    .then(function (chain) {
      return channelMapOf(station.id).then(function (channels) {
        var keys = [];
        Object.keys(channels).forEach(function (channel) {
          channelFields(channels[channel]).forEach(function (field) { keys.push({ channel: channel, field: field }); });
        });
        return Promise.all(keys.map(function (k) { return resolveField(chain, k.channel, channels[k.channel], k.field); }))
          .then(function (values) {
            var effectiveAttrs = [];
            keys.forEach(function (k, i) {
              if (values[i]) { effectiveAttrs.push({ key: 'effective.' + k.channel + '.' + k.field, value: values[i].value }); }
            });
            if (!effectiveAttrs.length) { return; }
            return toPromise(getService('attributeService').saveEntityAttributes(
              entityIdObj('ASSET', station.id), 'SERVER_SCOPE', effectiveAttrs
            ));
          });
      });
    });
}

els.save.addEventListener('click', save);
load();

};
