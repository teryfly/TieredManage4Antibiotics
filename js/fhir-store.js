/* =====================================================================
 * fhir-store.js —— FHIR 资源库：本地镜像 + 异步写穿（可接真实服务端）
 * ---------------------------------------------------------------------
 * 对外接口与 main 分支的纯内存实现保持一致（create / read / update / patch /
 * remove / search / count / bundle / canonical / canonicalAll / types /
 * subscribe / seed / reset），因此 services.js 与各页面组件里同步取数的写法
 * 不需要改成 async —— 这是本分支能小改接上真实服务端的原因。
 *
 *   mode=local   纯内存演示，行为与 main 分支一致，不发任何请求。
 *   mode=remote  读走本地镜像；写「先落镜像、再排队穿透到 FHIR R4 服务端」。
 *                镜像供界面即时渲染，服务端是持久化真相源，两者经写队列收敛。
 *
 * 队列按「类型阶段」优先调度：被引用方（Organization / Patient /
 * Practitioner）先落服务端再写引用方（Task 等）——服务端开启了引用完整性
 * 校验，顺序颠倒会让整单写入被 400 拒收。同阶段内 FIFO，同一资源的写串行。
 *
 * 该库不依赖任何框架，挂载到 window.FHIR。
 * ===================================================================== */
(function (global) {
  'use strict';

  var Client = global.FHIRClient, R4 = global.FHIRR4, Conf = global.AmrConfig;

  function nowISO() { return new Date().toISOString(); }
  function deepClone(obj) { return obj == null ? obj : JSON.parse(JSON.stringify(obj)); }

  var db = {};        // resourceType -> { id -> 规范化 FHIR 资源（extension 形态，无 ext 投影）}
  var counters = {};  // resourceType -> number
  var listeners = []; // 变更/同步订阅者（用于 UI 响应式刷新）

  // 预取与写入的类型顺序 = 引用依赖顺序：任何被引用的类型必须先落服务端，
  // 否则服务端引用完整性校验会整单拒收（HAPI-1094）。
  // Communication/CommunicationRequest 的 subject 指向 Task，故必须排在 Task 之后。
  var REMOTE_TYPES = ['StructureDefinition', 'CodeSystem', 'ValueSet', 'Organization', 'Patient',
    'Practitioner', 'Medication', 'MedicationKnowledge', 'PractitionerRole', 'Encounter',
    'Basic', 'PlanDefinition', 'MedicationRequest', 'DetectedIssue', 'Observation',
    'Task', 'CommunicationRequest', 'Communication', 'Provenance', 'AuditEvent', 'Endpoint',
    'MedicationAdministration'];
  var PHASE = {};
  REMOTE_TYPES.forEach(function (t, i) { PHASE[t] = i; });

  var sync = {
    mode: 'local', server: '', fhirVersion: '', status: 'idle', loadedByIds: null,
    queued: 0, inflight: 0, done: 0, failed: 0,
    lastError: null, errors: [], bootstrappedAt: null, loadedCount: 0, loadedTypes: 0, pushed: 0, reconciled: 0, seedSkipped: false
  };
  var ops = [];         // 待执行写操作
  var busy = {};        // resourceKey -> 阶段号（undefined 表示未在途），保证同资源串行
  var busyPhase = {};   // phase -> 在途数量，用于阻止引用方抢先落库
  var localOnly = {};   // 只存在于本地镜像的资源键（演示用大数据集，不落服务端）
  var loadedKeys = {};  // 本次 bootstrap 从服务端取回的资源键
  var capabilities = null; // CapabilityStatement 摘要（SRS §10.2 支持性检查）
  var CONCURRENCY = 6;

  function keyOf(type, id) { return type + '/' + id; }
  /* 阶段号决定落库先后（引用完整性由服务端校验）。同一类型内部还有相互引用：
   * 审批节点 Task 的 partOf 指向流程主 Task，主任务必须先于节点任务写入 ——
   * 只按类型分阶段不够，故给节点任务一个稍后的阶段号。 */
  function phaseOf(type, canonical) {
    var p = PHASE[type];
    if (p === undefined) p = REMOTE_TYPES.length;
    if (type === 'Task' && canonical && canonical.ext) {
      try {
        var ext = canonical.ext;
        if (ext.taskKind === 'node') return p + 0.5;
        if (ext.taskKind === 'main') return p + 0.25;
      } catch (e) { /* ext 已由上层展开，异常时退回类型阶段号 */ }
    }
    return p;
  }

  function ensure(type) {
    if (!db[type]) db[type] = {};
    return db[type];
  }

  /* 写入前：把友好的 ext 投影编码为标准 FHIR extension/modifierExtension，
   * 并从资源上移除非标准的 ext 字段，使内部存储为纯 FHIR 资源。 */
  function toCanonical(resource) {
    var r = deepClone(resource);
    var ext = r.ext; delete r.ext;
    delete r.extension; delete r.modifierExtension;
    if (global.FHIRExt && ext) {
      var enc = global.FHIRExt.encode(r.resourceType, ext);
      if (enc.extension.length) r.extension = enc.extension;
      if (enc.modifierExtension.length) r.modifierExtension = enc.modifierExtension;
    }
    return r;
  }

  /* 读取时：在纯 FHIR 资源上解码出友好的 ext 投影，便于上层使用。 */
  function materialize(canonical) {
    if (!canonical) return canonical;
    var r = deepClone(canonical);
    if (global.FHIRExt) r.ext = global.FHIRExt.decode(r.resourceType, r);
    return r;
  }

  function nextId(type) {
    counters[type] = (counters[type] || 0) + 1;
    return type + '-' + String(counters[type]).padStart(4, '0');
  }

  function emit(evt) {
    listeners.forEach(function (fn) {
      try { fn(evt); } catch (e) { console.error('FHIR listener error', e); }
    });
  }

  function exists(type, id) { return !!(db[type] && db[type][id]); }
  var ctx = { exists: exists };

  /* 这条服务端资源是不是本系统本作用域写进去的。公共演示服务器是所有人共用的，
   * 任何"全量列表兜底"和"按 id 精确读回"都必须先过这一关 —— 否则别人的数据会被
   * 灌进本地镜像，界面既读到它、又可能回写覆盖它。 */
  function ownedByScope(wire) {
    var tags = ((wire && wire.meta || {}).tag) || [];
    var scope = R4.scopeCode();
    for (var i = 0; i < tags.length; i++) {
      if (tags[i].system === R4.SCOPE_SYSTEM && tags[i].code === scope) return true;
    }
    return false;
  }

  /* 读取某类型的「本系统数据」。
   * 公共演示服务器上是全组织共享的（别人也往里写 Patient/Task），若按类型全量
   * 拉取会把无关资源灌进本地镜像，界面就会读到一堆不相干的数据。本系统写入
   * 时给每条资源打了 meta.tag[demo-scope]，按 _tag 检索只取自己的数据；
   * 服务端不支持 _tag 检索时才退回全量。 */
  function fetchType(base, type) {
    var scope = R4.scopeCode();
    return Client.fetchAllByTag(base, type, R4.SCOPE_SYSTEM, scope)
      .catch(function () {
        return Client.fetchAll(base, type).then(function (all) { return all.filter(ownedByScope); });
      });
  }

  /* ---------------- 写队列 ---------------- */

  /* 收集本资源引用到的其他资源键。同一类型内部的相互引用（组织上下级、
   * 流程主任务与节点任务）无法只靠"按类型分阶段"保证先后，并发写出时
   * 被引用方可能还没落库，服务端会以 HAPI-1094（找不到）或 HAPI-1096
   * （只有删除痕迹）拒收整条资源。引用方据此等同批次中被引用方写出后再执行。 */
  function depsOf(canonical) {
    var out = [];
    (function walk(node) {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) { for (var i = 0; i < node.length; i++) walk(node[i]); return; }
      Object.keys(node).forEach(function (k) {
        var v = node[k];
        if (k === 'reference' && typeof v === 'string') {
          var m = /^([A-Za-z]+)\/([^/?#]+)/.exec(v);
          if (m) out.push(keyOf(m[1], m[2]));
        } else walk(v);
      });
    })(canonical);
    return out;
  }

  function enqueue(spec) {
    if (sync.mode !== 'remote') return;
    spec.key = keyOf(spec.type, spec.id);
    spec.wireType = R4.TO_R4[spec.type] || spec.type;
    spec.phase = phaseOf(spec.wireType, spec.canonical);
    spec.deps = spec.action === 'delete' ? [] : depsOf(spec.canonical).filter(function (k) { return k !== spec.key; });
    spec.attempt = 3;      // 网络/5xx 与引用竞态各有独立的重试预算，见 run()
    spec.refAttempt = 3;   // 引用目标状态在服务端尚未可见时再试一次
    ops.push(spec);
    sync.queued++;
    emitSync();
    drain();
  }

  function wireOf(op) {
    // 剥离 meta.versionId / lastUpdated：这两个由服务端维护，带上会触发乐观锁冲突
    var payload = deepClone(op.canonical);
    if (payload.meta) { delete payload.meta.versionId; delete payload.meta.lastUpdated; }
    return R4.toWire(payload, ctx);
  }

  /* 取下一个可执行操作。可执行的条件是：不存在「阶段号更小」的排队中或在途操作
   * —— 引用完整性由服务端校验，Task.for 指向的 Patient 必须已经在服务端存在，
   * 仅看队列不够，还要等在途的前序写完成，否则会拿到 HAPI-1094。 */
  function minInflightPhase() {
    var m = Infinity;
    Object.keys(busyPhase).forEach(function (p) { if (busyPhase[p] > 0 && +p < m) m = +p; });
    return m;
  }

  var holdTimer = null;
  function scheduleDrain(ms) {
    if (holdTimer) return;
    holdTimer = setTimeout(function () { holdTimer = null; drain(); }, ms);
  }

  /* 本批次里还没写出的资源键 -> 阶段号；在途的记为 -1（一定会结束，不算死锁）。 */
  function pendingMap() {
    var m = {};
    for (var i = 0; i < ops.length; i++) {
      var o = ops[i];
      if (busy[o.key] !== undefined) continue;
      if (m[o.key] === undefined || o.phase < m[o.key]) m[o.key] = o.phase;
    }
    Object.keys(busy).forEach(function (k) { m[k] = -1; });
    return m;
  }

  /* 被引用方还在队列里排在后面（阶段号不小于自己）就必须等它；
   * 若被引用方阶段更晚，说明这不是真正的先后依赖（例如相互引用），跳过以免卡死。 */
  function depPending(op, pend) {
    for (var i = 0; i < op.deps.length; i++) {
      var p = pend[op.deps[i]];
      if (p !== undefined && p <= op.phase) return true;
    }
    return false;
  }

  function nextOp() {
    var minPhase = minInflightPhase();
    var now = Date.now();
    for (var i = 0; i < ops.length; i++) {
      if (busy[ops[i].key] !== undefined) continue;
      if (ops[i].holdUntil && ops[i].holdUntil > now) continue;
      if (ops[i].phase < minPhase) minPhase = ops[i].phase;
    }
    if (minPhase === Infinity) return null;
    var pend = pendingMap();
    var wait = 0, firstHeld = -1;
    for (var j = 0; j < ops.length; j++) {
      if (busy[ops[j].key] !== undefined) continue;
      if (ops[j].phase !== minPhase) continue;
      if (ops[j].holdUntil && ops[j].holdUntil > now) { wait = Math.max(wait, ops[j].holdUntil - now); continue; }
      if (ops[j].deps && depPending(ops[j], pend)) { if (firstHeld < 0) firstHeld = j; continue; }
      return ops.splice(j, 1)[0];
    }
    // 依赖互相指向（或指向了永不写出的键）时不能一直等下去：没有任何请求在途就说明
    // 等待不会带来进展，此时照原样写出，由服务端的判定和上面的引用重试兜底。
    if (firstHeld >= 0 && sync.inflight === 0) return ops.splice(firstHeld, 1)[0];
    if (firstHeld >= 0) wait = Math.max(wait, 60);  // 依赖方马上会写出，稍后再查一次
    if (wait) scheduleDrain(wait + 10);
    return null;
  }

  function markBusy(op) {
    busy[op.key] = op.phase;
    busyPhase[op.phase] = (busyPhase[op.phase] || 0) + 1;
  }
  function markIdle(op) {
    delete busy[op.key];
    busyPhase[op.phase] = (busyPhase[op.phase] || 0) - 1;
    if (busyPhase[op.phase] <= 0) delete busyPhase[op.phase];
  }

  function drain() {
    if (sync.mode !== 'remote') return;
    while (sync.inflight < CONCURRENCY) {
      var op = nextOp();
      if (!op) break;
      markBusy(op);
      sync.queued--;
      sync.inflight++;
      run(op);
    }
    emitSync();
  }

  function run(op) {
    var base = Conf.baseUrl();
    var p = op.action === 'delete'
      ? Client.remove(base, op.wireType, op.id)
      : Client.put(base, op.wireType, op.id, wireOf(op));
    p.then(function () {
      sync.inflight--; sync.done++; markIdle(op);
      // 同一资源重写成功即视为该故障已消解，清掉提示；其他资源的失败仍保留可见
      if (sync.lastError && sync.lastError.type === op.type && sync.lastError.id === op.id) {
        sync.lastError = null;
      }
      drain();
    }, function (err) {
      sync.inflight--; markIdle(op);
      var retriable = err.unreachable || err.timeout || (err.status >= 500);
      if (op.attempt > 1 && retriable) { op.attempt--; ops.unshift(op); sync.queued++; drain(); return; }
      if (op.status === 409 && retriable) { /* 事务未提交引起的偶发冲突，交给上面的重试 */ }
      // HAPI-1094 = 引用目标查不到，HAPI-1096 = 引用目标只剩删除痕迹。两者都发生在
      // 「被引用方正在被同一批次重写」的瞬间（清理后重灌尤其明显），故挪到队尾再试；
      // 仍失败才计为写入失败，绝不静默当成成功。
      var refMiss = err.hapiCode === 'HAPI-1094' || err.hapiCode === 'HAPI-1096';
      if (op.refAttempt > 1 && refMiss) {
        op.refAttempt--;
        op.holdUntil = Date.now() + 500 * (4 - op.refAttempt);
        ops.push(op); sync.queued++; drain(); return;
      }
      sync.failed++;
      sync.lastError = { type: op.type, id: op.id, action: op.action, message: err.message, hapiCode: err.hapiCode };
      sync.errors = (sync.errors || []).concat([{ type: op.type, id: op.id, message: err.message, hapiCode: err.hapiCode }]).slice(-20);
      console.error('[FHIR] 写入失败', op.action, op.type + '/' + op.id, err.message);
      emitSync();
      drain();
    });
  }

  function emitSync() { emit({ action: 'sync', stats: FHIR.stats() }); }

  /* ---------------- 对外接口 ---------------- */
  var FHIR = {
    /* 订阅资源变更与同步状态，返回取消订阅函数 */
    subscribe: function (fn) {
      listeners.push(fn);
      return function () {
        var i = listeners.indexOf(fn);
        if (i >= 0) listeners.splice(i, 1);
      };
    },

    stats: function () {
      return {
        mode: sync.mode, server: sync.server, fhirVersion: sync.fhirVersion, status: sync.status,
        queued: sync.queued, inflight: sync.inflight, done: sync.done, failed: sync.failed,
        lastError: sync.lastError, errors: (sync.errors || []).slice(), bootstrappedAt: sync.bootstrappedAt,
        loadedCount: sync.loadedCount, loadedTypes: sync.loadedTypes,
        pushed: sync.pushed, reconciled: sync.reconciled, seedSkipped: sync.seedSkipped,
        loadedByIds: sync.loadedByIds || null
      };
    },

    /* 直接植入资源（带 id），用于种子数据初始化，不触发事件。
     * opts.local=true 表示只进本地镜像、不落服务端（演示用的大数据集走这条）。 */
    seed: function (resource, opts) {
      var type = resource.resourceType;
      ensure(type);
      if (!resource.id) resource.id = nextId(type);
      // 维持 counter 单调递增，避免后续生成 id 冲突
      var m = /-(\d+)$/.exec(resource.id);
      if (m) counters[type] = Math.max(counters[type] || 0, parseInt(m[1], 10));
      var canonical = toCanonical(resource);
      canonical.meta = canonical.meta || {};
      canonical.meta.versionId = canonical.meta.versionId || '1';
      canonical.meta.lastUpdated = canonical.meta.lastUpdated || nowISO();
      db[type][canonical.id] = canonical;
      if (opts && opts.local) {
        localOnly[keyOf(type, canonical.id)] = true;
      } else {
        enqueue({ action: 'create', type: type, id: canonical.id, canonical: deepClone(canonical) });
      }
      return materialize(canonical);
    },

    /* FHIR: create —— POST [base]/{type}（本实现改用 PUT，以保留语义化 id） */
    create: function (resource) {
      var type = resource.resourceType;
      if (!type) throw new Error('resourceType 缺失');
      ensure(type);
      if (!resource.id) resource.id = nextId(type);
      var canonical = toCanonical(resource);
      canonical.meta = { versionId: '1', lastUpdated: nowISO() };
      db[type][canonical.id] = canonical;
      enqueue({ action: 'create', type: type, id: canonical.id, canonical: deepClone(canonical) });
      emit({ action: 'create', resourceType: type, id: canonical.id, resource: deepClone(canonical) });
      return materialize(canonical);
    },

    /* FHIR: read —— GET [base]/{type}/{id}（返回带 ext 投影的资源） */
    read: function (type, id) {
      return db[type] && db[type][id] ? materialize(db[type][id]) : undefined;
    },

    /* 读取纯 FHIR 资源（不含 ext 投影，仅 extension/modifierExtension）——
     * 供 FHIR 资源查看器展示规范化形态 */
    canonical: function (type, id) {
      return db[type] && db[type][id] ? deepClone(db[type][id]) : undefined;
    },
    canonicalAll: function (type) {
      return db[type] ? Object.keys(db[type]).map(function (k) { return deepClone(db[type][k]); }) : [];
    },
    types: function () { return Object.keys(db).sort(); },

    /* FHIR: update —— PUT [base]/{type}/{id} */
    update: function (resource) {
      var type = resource.resourceType, id = resource.id;
      if (!type || !id) throw new Error('update 需要 resourceType 与 id');
      ensure(type);
      var prev = db[type][id];
      var ver = prev && prev.meta ? String(parseInt(prev.meta.versionId || '1', 10) + 1) : '1';
      var canonical = toCanonical(resource);
      canonical.meta = { versionId: ver, lastUpdated: nowISO() };
      db[type][id] = canonical;
      enqueue({ action: 'update', type: type, id: id, canonical: deepClone(canonical) });
      emit({ action: 'update', resourceType: type, id: id, resource: deepClone(canonical) });
      return materialize(canonical);
    },

    /* FHIR: patch —— 局部更新（合并字段） */
    patch: function (type, id, partial) {
      var cur = this.read(type, id);
      if (!cur) throw new Error('资源不存在: ' + type + '/' + id);
      Object.assign(cur, partial);
      return this.update(cur);
    },

    /* FHIR: delete —— DELETE [base]/{type}/{id} */
    remove: function (type, id) {
      if (db[type] && db[type][id]) {
        var res = db[type][id];
        delete db[type][id];
        enqueue({ action: 'delete', type: type, id: id, canonical: deepClone(res) });
        emit({ action: 'delete', resourceType: type, id: id, resource: deepClone(res) });
        return true;
      }
      return false;
    },

    /* FHIR: search —— GET [base]/{type}?...
     * predicate 为可选过滤函数 (resource) => boolean
     * 返回资源数组（已克隆）。远端模式下数据已在 bootstrap 时进入本地镜像。 */
    search: function (type, predicate) {
      var coll = db[type] ? Object.keys(db[type]).map(function (k) { return materialize(db[type][k]); }) : [];
      if (predicate) coll = coll.filter(predicate);
      return coll;
    },

    /* 返回某类型资源数量 */
    count: function (type, predicate) {
      return this.search(type, predicate).length;
    },

    /* 以 Bundle 形式返回（更贴近 FHIR searchset 语义） */
    bundle: function (type, predicate) {
      var entries = this.search(type, predicate);
      return {
        resourceType: 'Bundle',
        type: 'searchset',
        total: entries.length,
        entry: entries.map(function (r) {
          return { fullUrl: type + '/' + r.id, resource: r };
        })
      };
    },

    /* 调试用：导出全部数据 */
    dump: function () { return deepClone(db); },
    reset: function () {
      db = {}; counters = {}; ops = []; busy = {}; busyPhase = {}; localOnly = {}; loadedKeys = {};
      sync.queued = 0; sync.inflight = 0; sync.done = 0; sync.failed = 0;
      sync.lastError = null; sync.errors = []; sync.loadedCount = 0; sync.pushed = 0; sync.reconciled = 0; sync.seedSkipped = false;
      capabilities = null;
    },

    /* ---------- 本地镜像 ⇄ 服务端 ---------- */

    /* 把服务端取回的资源写入镜像（按友好 id 归档，同 id 覆盖） */
    absorb: function (wireResources) {
      var n = 0;
      wireResources.forEach(function (w) {
        var internal = R4.fromWire(w);
        if (!internal || !internal.resourceType) return;
        var id = R4.wireIdOf(internal) || internal.id;
        if (!id) return;
        ensure(internal.resourceType);
        internal.id = id;
        internal.meta = internal.meta || {};
        internal.meta.versionId = internal.meta.versionId || '1';
        internal.meta.lastUpdated = internal.meta.lastUpdated || nowISO();
        db[internal.resourceType][id] = internal;
        loadedKeys[keyOf(internal.resourceType, id)] = true;
        delete localOnly[keyOf(internal.resourceType, id)];
        var m = /-(\d+)$/.exec(id);
        if (m) counters[internal.resourceType] = Math.max(counters[internal.resourceType] || 0, parseInt(m[1], 10));
        n++;
      });
      sync.loadedCount += n;
      return n;
    },

    /* 精确按 id 读回本系统自己的资源（不依赖搜索索引）。
     * 公共演示服务器上 _tag 检索会整片返回空（索引滞后或被限流），此时按 id 逐个
     * GET 是唯一可靠的读回方式；镜像里的 id 就是本系统写入时用的语义化 id。 */
    refreshByIds: function (types) {
      var self = this;
      var base = Conf.baseUrl();
      var list = types || REMOTE_TYPES;
      var loaded = 0, missing = 0, failed = 0, foreign = 0;
      loadedKeys = {};
      return list.reduce(function (chain, type) {
        return chain.then(function () {
          var ids = Object.keys(db[type] || {});
          return ids.reduce(function (c, id) {
            return c.then(function () {
              return Client.get(base, type, id, { timeout: 15000 }).then(function (wire) {
                if (!wire || !wire.resourceType) return;
                // 服务端确实有这个 id，但它属于别的作用域（公共实例上别人写的、
                // 或本系统另一次演示留下的）—— 不能当成自己的数据读进镜像。
                if (!ownedByScope(wire)) { foreign++; return; }
                self.absorb([wire]); loaded++;
              }).catch(function (err) {
                if (err.status === 404 || err.status === 410) missing++;
                else { failed++; console.warn('[FHIR] 按 id 读回失败', type + '/' + id, err.message); }
              });
            });
          }, Promise.resolve());
        });
      }, Promise.resolve()).then(function () {
        return { loaded: loaded, missing: missing, failed: failed, foreign: foreign };
      });
    },

    /* 等待写队列排空（保存后 await，可确认是否真的落到了服务端） */
    flush: function () {
      var self = this;
      return new Promise(function (resolve) {
        (function tick() {
          if (sync.mode !== 'remote' || (sync.queued === 0 && sync.inflight === 0)) return resolve(self.stats());
          setTimeout(tick, 120);
        })();
      });
    },

    /* 连通性测试：确认服务端可达且为 FHIR R4 */
    ping: function (base) {
      var url = base || Conf.baseUrl();
      return Client.capabilities(url, { timeout: 15000 }).then(function (md) {
        return { server: url, fhirVersion: md.fhirVersion, software: (md.software || {}).name || '' };
      });
    },

    /* 判断服务端是否已初始化过本系统数据。
     * 不能只看搜索结果的条数：HAPI 的搜索索引是异步构建的，刚写入后立刻搜索
     * 很可能返回 0 条，据此判定「服务端为空」会导致重复灌入初始数据。
     * 改为直接按 id 读一个本系统必然存在、且业务上永不删除的锚点资源。 */
    probeAnchor: function () {
      var base = Conf.baseUrl();
      var anchors = ['Basic/Basic-catalog-version', 'Organization/Organization-pharmacy'];
      function tryOne(i) {
        if (i >= anchors.length) return Promise.resolve(false);
        return Client.get(base, anchors[i].split('/')[0], anchors[i].split('/')[1], { timeout: 10000 })
          .then(function (r) {
            // 共享实例上别人也可能建了同名 id 的资源，只有带本作用域标签的才算「已初始化」
            if (r && r.id && ownedByScope(r)) return true;
            return tryOne(i + 1);
          })
          .catch(function () { return tryOne(i + 1); });
      }
      return tryOne(0);
    },

    /* 启动装载：读配置 → 探活 → 预取各类型 → 返回统计。
     * 失败交由调用方（app.js）决定回退策略，这里不静默降级成本地模式。 */
    bootstrap: function () {
      var self = this;
      return Conf.load().then(function () {
        if (!Conf.isRemote()) {
          sync.mode = 'local'; sync.status = 'local'; sync.server = '';
          emitSync();
          return self.stats();
        }
        sync.mode = 'remote'; sync.server = Conf.baseUrl(); sync.status = 'connecting';
        emitSync();
        return Client.capabilities(sync.server, { timeout: 15000 })
          .then(function (md) {
            sync.fhirVersion = md.fhirVersion;
            capabilities = md.supported || Client.summarizeSupport(md);
            sync.status = 'loading';
            emitSync();
            return self.loadAll();
          })
          .then(function () {
            if (sync.loadedCount === 0) {
              // 搜索还没建好索引时会读到 0 条，稍等再试一次
              return self.probeAnchor().then(function (seen) {
                if (!seen) return 0;
                return new Promise(function (res) {
                  setTimeout(function () { self.loadAll().then(res); }, 2500);
                });
              });
            }
            return sync.loadedCount;
          })
          .then(function () {
            if (sync.loadedCount > 0) {
              sync.reconciled = self.reconcile();
            } else {
              return self.probeAnchor().then(function (exists) {
                if (exists) {
                  // 服务端有数据但搜索读不到（公共实例的索引滞后/限流）：
                  // 改成语义化 id 逐个精确读回，既恢复数据也顺带对账，
                  // 不重复灌库、也不会把界面留在与服务端不一致的状态。
                  sync.seedSkipped = true;
                  console.warn('[FHIR] 服务端已有本系统数据但搜索返回空，改按 id 精确读回');
                  return self.refreshByIds().then(function (r) {
                    sync.loadedCount = r.loaded;
                    sync.loadedByIds = r;
                    console.log('[FHIR] 按 id 读回 ' + r.loaded + ' 条，服务端不存在 ' + r.missing + ' 条'
                      + (r.foreign ? '，另有 ' + r.foreign + ' 条同名资源属于其它作用域（不读取）' : ''));
                  });
                } else if (Conf.get('autoSeed')) {
                  sync.pushed = self.pushAll();   // 全新服务端：写入初始基础数据
                }
              });
            }
          })
          .then(function () {
            sync.status = 'ready'; sync.bootstrappedAt = nowISO();
            emitSync();
            return self.stats();
          });
      });
    },

    /* 预取全部远端类型；单个类型失败不阻断启动（服务端可能关闭了该类型搜索） */
    loadAll: function () {
      var base = Conf.baseUrl();
      sync.loadedCount = 0; sync.loadedTypes = 0;
      loadedKeys = {};   // 本轮预取的键集，供 reconcile 判定「服务端有没有」
      return REMOTE_TYPES.reduce(function (chain, type) {
        return chain.then(function () {
          return fetchType(base, type).then(function (list) {
            FHIR.absorb(list);
            emitSync();
          }).catch(function (err) {
            console.warn('[FHIR] 预取失败', type, err.message);
          }).then(function () {
            sync.loadedTypes++;
            emitSync();
          });
        });
      }, Promise.resolve()).then(function () { return sync.loadedCount; });
    },

    /* 服务端为空时，把本地镜像整体推送过去（初始化基础数据）。
     * 按引用依赖顺序入队，被引用方先落服务端。 */
    pushAll: function () {
      var ordered = REMOTE_TYPES.concat(Object.keys(db).filter(function (t) {
        return REMOTE_TYPES.indexOf(t) < 0;
      }));
      var n = 0;
      ordered.forEach(function (t) {
        // 不排序：镜像里的插入顺序就是种子的写入顺序（被引用方先 seed），
        // 按 id 排序会让「呼吸内科（演示）」排到「演示医院」前面，
        // Organization.partOf 因此指向还不存在的父组织而被服务端拒收。
        Object.keys(db[t] || {}).forEach(function (id) {
          if (localOnly[keyOf(t, id)]) return;
          enqueue({ action: 'create', type: t, id: id, canonical: deepClone(db[t][id]) });
          n++;
        });
      });
      return n;
    },

    /* 服务端已有数据时，丢弃「启动时预置但服务端没有」的本地残留，
     * 避免界面读到已被其他使用者删掉的旧数据。本地专用数据集不受影响。 */
    reconcile: function () {
      var removed = 0;
      Object.keys(db).forEach(function (t) {
        Object.keys(db[t]).forEach(function (id) {
          var k = keyOf(t, id);
          if (loadedKeys[k] || localOnly[k]) return;
          delete db[t][id];
          removed++;
        });
      });
      return removed;
    },

    /* 增量刷新：重新从服务端读取指定类型，替换本地镜像中的对应条目。
     * SRS FR-009.8 明确本演示的跨用户更新靠「HAPI FHIR 数据查询刷新」实现
     * （公共服务器不提供医院级消息推送），审批人员点一下刷新即可看到新待办。
     * 只覆盖服务端返回的资源；本地专用数据集（localOnly）保持不变。 */
    refreshTypes: function (types) {
      var self = this;
      if (sync.mode !== 'remote') return Promise.resolve({ refreshed: 0, mode: sync.mode });
      var base = Conf.baseUrl();
      var list = (types || REMOTE_TYPES).filter(function (t) { return REMOTE_TYPES.indexOf(t) >= 0; });
      var refreshed = 0, failed = [];
      return list.reduce(function (chain, type) {
        return chain.then(function () {
          return fetchType(base, type).then(function (wireList) {
            // 先清掉该类型中「来自服务端」的旧条目，再吸收新读到的
            Object.keys(db[type] || {}).forEach(function (id) {
              if (!localOnly[keyOf(type, id)]) delete db[type][id];
            });
            loadedKeys = {};
            refreshed += self.absorb(wireList);
          }).catch(function (err) {
            failed.push({ type: type, message: err.message });
            console.warn('[FHIR] 刷新失败', type, err.message);
          });
        });
      }, Promise.resolve()).then(function () {
        sync.status = 'ready';
        emitSync();
        emit({ action: 'refresh', refreshed: refreshed });
        return { refreshed: refreshed, failed: failed, mode: sync.mode };
      });
    },

    /* SRS §10.2：启动时读取 CapabilityStatement，逐类型/逐交互检查支持性。
     * 不支持的项必须在「演示数据管理」页面显式列出，不得假装写入成功。 */
    capabilities: function (force) {
      if (capabilities && !force) return Promise.resolve(capabilities);
      if (sync.mode !== 'remote' && !Conf.isRemote()) {
        return Promise.resolve({ local: true, fhirVersion: '', types: {}, system: [] });
      }
      return Client.capabilities(Conf.baseUrl(), { timeout: 20000 }).then(function (md) {
        capabilities = md.supported || Client.summarizeSupport(md);
        capabilities.fhirVersion = md.fhirVersion;
        capabilities.software = ((md.software) || {}).name || '';
        sync.fhirVersion = md.fhirVersion;
        return capabilities;
      });
    },
    capabilitiesCached: function () { return capabilities; },

    /* 服务端「属于本系统」的各类型条数（演示数据管理页自检用）。
     * 按 demo-scope 标签统计，而不是该类型在全服务器上的总量。 */
    serverCounts: function (types) {
      if (sync.mode !== 'remote') return Promise.resolve({ local: true, counts: {} });
      var base = Conf.baseUrl();
      var out = {};
      return (types || REMOTE_TYPES).reduce(function (chain, type) {
        return chain.then(function () {
          return Client.fetchAllByTag(base, type, R4.SCOPE_SYSTEM, R4.scopeCode())
            .then(function (list) { out[type] = list.length; },
              function (err) { out[type] = -1; out.__error = out.__error || {}; out.__error[type] = err.message; });
        });
      }, Promise.resolve()).then(function () { return { counts: out, scope: R4.scopeCode() }; });
    },

    /* 切换读写模式。remote 下若传 base 则覆盖配置中的地址（测试与手工指定用）。 */
    setMode: function (mode, base) {
      sync.mode = mode === 'remote' ? 'remote' : 'local';
      sync.server = base || (sync.mode === 'remote' ? Conf.baseUrl() : '');
      sync.status = sync.mode === 'local' ? 'local' : 'ready';
      if (sync.mode === 'local') { ops = []; busy = {}; busyPhase = {}; sync.queued = 0; sync.inflight = 0; }
      emitSync();
      return FHIR.stats();
    },

    /* 服务端不可达时退回本地演示：保留当前镜像，丢弃未完成的写队列。
     * 界面据此继续可操作，不会因为后端故障变成白屏。 */
    goLocal: function () {
      sync.mode = 'local'; sync.status = 'local'; sync.server = '';
      ops = []; busy = {}; busyPhase = {}; sync.queued = 0; sync.inflight = 0;
      emitSync();
      return FHIR.stats();
    },

    remoteTypes: function () { return REMOTE_TYPES.slice(); }
  };

  global.FHIR = FHIR;
})(window);
