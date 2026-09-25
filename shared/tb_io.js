/*
 * ThingsBoard access for the terrySense config widgets —
 * `window.TerrySenseTbIo(ctx)`. Plain-HTML html_container mode: services come
 * from `ctx.$scope.$injector.get(ctx.servicesMap.get('<name>'))`
 * (logr-product-docs/cloud/FRONTEND.md *Custom widget delivery*).
 *
 * `io` is the resolver's contract (shared/resolver.js header), plus
 * `fetchUser`.
 */
(function (root) {
'use strict';

root.TerrySenseTbIo = function (ctx) {
  var resolver = root.TerrySenseResolver;

  function getService(name) { return ctx.$scope.$injector.get(ctx.servicesMap.get(name)); }

  function toPromise(observable) {
    return new Promise(function (resolve, reject) {
      observable.subscribe({ next: function (v) { resolve(v); }, error: function (e) { reject(e); } });
    });
  }

  function get(url, params) { return toPromise(getService('http').get(url, { params: params || {} })); }
  function post(url, body) { return toPromise(getService('http').post(url, body || {})); }
  function del(url, params) { return toPromise(getService('http').delete(url, { params: params || {} })); }

  /** Every item of a paged listing, page after page. */
  function getAll(url, params) {
    var items = [];
    function page(n) {
      return get(url, Object.assign({}, params, { pageSize: '500', page: String(n) })).then(function (p) {
        items = items.concat((p && p.data) || []);
        return p && p.hasNext ? page(n + 1) : items;
      });
    }
    return page(0);
  }

  function idObj(entity) { return { entityType: entity.entityType, id: entity.id }; }

  function attrsMap(entity, scope) {
    return toPromise(getService('attributeService').getEntityAttributes(idObj(entity), scope || 'SERVER_SCOPE'))
      .then(function (list) {
        var map = {};
        (list || []).forEach(function (a) { map[a.key] = a.value; });
        return map;
      })
      .catch(function () { return {}; });
  }

  function saveAttrs(entity, attrs) {
    var pairs = Object.keys(attrs || {}).map(function (k) { return { key: k, value: attrs[k] }; });
    if (!pairs.length) { return Promise.resolve(); }
    return toPromise(getService('attributeService').saveEntityAttributes(idObj(entity), 'SERVER_SCOPE', pairs));
  }

  function deleteAttrs(entity, keys) {
    if (!keys || !keys.length) { return Promise.resolve(); }
    return toPromise(getService('attributeService').deleteEntityAttributes(idObj(entity), 'SERVER_SCOPE',
      keys.map(function (k) { return { key: k }; })));
  }

  function getAsset(id) { return toPromise(getService('assetService').getAsset(id)); }
  function assetLevel(a) { return { entityType: 'ASSET', id: a.id.id, name: a.name, kind: a.type }; }

  function relatedAssets(entityId, direction) {
    var query = {
      parameters: { rootId: entityId, rootType: 'ASSET', direction: direction, relationTypeGroup: 'COMMON', maxLevel: 1, fetchLastLevelOnly: false },
      filters: [{ relationType: 'Contains', entityTypes: ['ASSET'] }]
    };
    return toPromise(getService('entityRelationService').findByQuery(query)).then(function (relations) {
      var ids = {};
      (relations || []).forEach(function (r) {
        var other = direction === 'FROM' ? r.to : r.from;
        if (other.entityType === 'ASSET') { ids[other.id] = true; }
      });
      return Promise.all(Object.keys(ids).map(getAsset));
    });
  }

  var defaultsPromise = null;

  var io = {
    fetchAttrs: function (entity) { return attrsMap(entity); },
    fetchParent: function (entity) {
      return relatedAssets(entity.id, 'TO').then(function (assets) { return assets.length ? assetLevel(assets[0]) : null; });
    },
    fetchChildren: function (entity) {
      return relatedAssets(entity.id, 'FROM').then(function (assets) { return assets.map(assetLevel); });
    },
    // `ownerId` (not `customerId`) is the immediate owner ThingsBoard PE stamps
    // on every asset — the field config_resolver.py reads for the same lookup.
    fetchCustomer: function (entity) {
      return getAsset(entity.id).then(function (asset) {
        var owner = asset.ownerId;
        if (!owner || owner.entityType !== 'CUSTOMER') { return null; }
        return toPromise(getService('customerService').getCustomer(owner.id)).then(function (c) {
          return { entityType: 'CUSTOMER', id: owner.id, name: c.title || c.name };
        });
      });
    },
    // The one lookup with no Angular service wrapper, so it goes through http.
    fetchDefaults: function () {
      if (!defaultsPromise) {
        defaultsPromise = get('/api/user/assets', { type: 'Defaults', pageSize: '1', page: '0' }).then(function (page) {
          var item = page && page.data && page.data[0];
          return item ? { entityType: 'ASSET', id: item.id.id, name: item.name, kind: 'Defaults' } : null;
        }).catch(function () { return null; });
      }
      return defaultsPromise;
    },
    // Ownership is orthogonal to `Contains` (ENTITY_MODEL.md §1): a customer's
    // stations are found by ownership, not by walking relations.
    fetchCustomerStations: function (customer) {
      return getAll('/api/customer/' + customer.id + '/assets', { type: 'Station' }).then(function (list) { return list.map(assetLevel); });
    },
    // Every station the user can see: all of them for a tenant admin, the only
    // user who can write the DEFAULTS asset.
    fetchAllStations: function () {
      return getAll('/api/user/assets', { type: 'Station' }).then(function (list) { return list.map(assetLevel); });
    },
    fetchUser: function (id) { return get('/api/user/' + id).catch(function () { return null; }); }
  };

  /** The entity bound in the widget's Data tab, resolved through its alias. */
  function boundDatasource() {
    var live = ctx.datasources && ctx.datasources[0];
    if (live && live.entityId) { return Promise.resolve(live); }
    var configured = ctx.widget && ctx.widget.config && ctx.widget.config.datasources;
    if (!configured || !configured.length) { return Promise.resolve(null); }
    return toPromise(ctx.aliasController.resolveDatasources(JSON.parse(JSON.stringify(configured)), true))
      .then(function (resolved) { return (resolved || []).filter(function (d) { return d && d.entityId; })[0] || null; });
  }

  function loadEntity(ds) {
    if (ds.entityType === 'CUSTOMER') {
      return toPromise(getService('customerService').getCustomer(ds.entityId)).then(function (c) {
        return { entityType: 'CUSTOMER', id: ds.entityId, name: c.title || c.name, kind: 'Customer', ownerId: ds.entityId };
      });
    }
    return getAsset(ds.entityId).then(function (a) {
      var level = assetLevel(a);
      level.ownerId = a.ownerId && a.ownerId.id;
      return level;
    });
  }

  var mePromise = null, permsPromise = null;
  function currentUser() { return mePromise || (mePromise = get('/api/auth/user')); }
  function permissions() {
    return permsPromise || (permsPromise = get('/api/permissions/allowedPermissions').catch(function () { return null; }));
  }

  /** Whether the signed-in user may write this entity's attributes: a tenant
   * admin always; a customer user through a generic write permission, on an
   * entity their customer owns. Anyone else sees the widget read-only. */
  function canWrite(entity) {
    return Promise.all([currentUser(), permissions()]).then(function (got) {
      var me = got[0] || {}, perms = got[1];
      if (me.authority === 'TENANT_ADMIN') { return true; }
      if (me.authority !== 'CUSTOMER_USER' || !perms) { return false; }
      var generic = (perms.userPermissions || {}).genericPermissions || {};
      var resource = entity.entityType === 'CUSTOMER' ? 'CUSTOMER' : 'ASSET';
      var ops = (generic[resource] || []).concat(generic.ALL || []);
      var writes = ops.indexOf('ALL') >= 0 || ops.indexOf('WRITE_ATTRIBUTES') >= 0;
      var owner = perms.userOwnerId && (perms.userOwnerId.id || perms.userOwnerId);
      return writes && !!owner && owner === entity.ownerId;
    });
  }

  /** Platform users a contact can be picked from: the customer's, else the tenant's. */
  function listUsers(customerId) {
    return getAll(customerId ? '/api/customer/' + customerId + '/users' : '/api/user/users');
  }

  /** Re-resolve `stations` and write only what changed (every attribute write
   * re-triggers `station_entry`). */
  function resolveStations(stations) {
    return Promise.all(stations.map(function (station) {
      return Promise.all([resolver.resolveStation(station, io), io.fetchAttrs(station)]).then(function (r) {
        var diff = resolver.effectiveDiff(r[1], r[0]);
        return saveAttrs(station, diff.toWrite).then(function () { return deleteAttrs(station, diff.toDelete); });
      });
    }));
  }

  return {
    io: io, get: get, getAll: getAll, post: post, del: del, attrsMap: attrsMap, saveAttrs: saveAttrs, deleteAttrs: deleteAttrs,
    getAsset: getAsset, assetLevel: assetLevel, boundDatasource: boundDatasource, loadEntity: loadEntity,
    currentUser: currentUser, canWrite: canWrite, listUsers: listUsers, resolveStations: resolveStations
  };
};

})(typeof self !== 'undefined' ? self : this);
