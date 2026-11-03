/* =====================================================================
 * clock.js —— 演示时钟（window.Clock）
 * ---------------------------------------------------------------------
 * SRS FR-008 要求「24 小时内补审核」并「超过 24 小时显示补审核超时，
 * 不得自动伪造完成状态」。真实等 24 小时无法演示，因此全系统时间统一取自
 * 本时钟：截止时间 = 发起时间 + 24h（写进 Task.restriction.period），
 * 剩余时间与超时状态由「截止 − 当前时钟」计算得出，不写库。
 *
 * 时钟本身持久化在 FHIR Basic/Basic-demo-clock 里，写穿透到服务端，
 * 换浏览器/刷新页面仍是同一个演示时钟。
 *
 * 全系统日期一律用「本地墙上时间」字符串（无时区）：
 *   展示 'YYYY-MM-DD HH:mm'，写入 FHIR 前由 fhir-r4.toInstant 规范为 instant。
 * ===================================================================== */
(function (global) {
  'use strict';

  var BASIC_ID = 'Basic-demo-clock';
  var cache = null;      // 读镜像有克隆开销，渲染循环里高频调用，故缓存

  function blank() {
    return { mode: 'live', offsetMinutes: 0, frozenAt: '', setBy: '', setAt: '' };
  }
  function pad(n) { return String(n).padStart(2, '0'); }

  /* 'YYYY-MM-DD[ T]HH:mm[:ss]' / 'YYYY-MM-DD' → 本地 Date。
   * 不能直接 new Date(s)：跨浏览器对无时区字符串的解释不一致（有的按 UTC）。 */
  function parse(s) {
    if (s instanceof Date) return new Date(s.getTime());
    if (typeof s === 'number') return new Date(s);
    var m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(String(s || ''));
    if (!m) return null;
    return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  }
  function stamp(d, withSeconds) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
      + (withSeconds ? 'T' : ' ') + pad(d.getHours()) + ':' + pad(d.getMinutes())
      + (withSeconds ? ':' + pad(d.getSeconds()) : '');
  }

  function fromMirror() {
    var F = global.FHIR;
    if (!F || !F.read) return blank();
    var b = F.read('Basic', BASIC_ID);
    var e = b && b.ext;
    if (!e) return blank();
    return {
      mode: e.mode || 'live',
      offsetMinutes: typeof e.offsetMinutes === 'number' ? e.offsetMinutes : 0,
      frozenAt: e.frozenAt || '',
      setBy: e.setBy || '', setAt: e.setAt || ''
    };
  }

  function persist(patch, operator) {
    var F = global.FHIR;
    if (!F || !F.read) return;
    var b = F.read('Basic', BASIC_ID);
    var next = Object.assign(blank(), (b && b.ext) || {}, patch);
    next.setBy = operator || (global.App && global.App.currentUser ? global.App.currentUser().display : '系统');
    next.setAt = stamp(rawNow(next), true);
    if (!b) F.create({ resourceType: 'Basic', id: BASIC_ID, code: { text: 'demo-clock' }, ext: next });
    else { b.ext = next; F.update(b); }
    cache = next;
    return next;
  }

  /* 纯函数版「现在」：便于 set 时用未偏移的时间写 setAt，也避免递归 */
  function rawNow(st) {
    st = st || blank();
    if (st.mode === 'frozen' && st.frozenAt) { var f = parse(st.frozenAt); if (f) return f; }
    var d = new Date();
    if (st.mode !== 'frozen') d.setMinutes(d.getMinutes() + (st.offsetMinutes || 0));
    return d;
  }

  var Clock = {
    BASIC_ID: BASIC_ID,

    /* 状态可能因服务端刷新而变，FHIR 每次变更后作废缓存 */
    reload: function () { cache = null; },
    state: function () { if (!cache) cache = fromMirror(); return cache; },

    /** 当前时钟时刻（Date） */
    now: function () { return rawNow(Clock.state()); },
    /** 'YYYY-MM-DD HH:mm' 展示用 */
    text: function () { return stamp(Clock.now(), false); },
    /** 'YYYY-MM-DDTHH:mm:ss' 写 FHIR 用 */
    instant: function () { return stamp(Clock.now(), true); },
    /** 今天 'YYYY-MM-DD' */
    date: function () { return stamp(Clock.now(), false).slice(0, 10); },
    parse: parse,
    stamp: stamp,

    /** 某时刻 + hours 小时，返回 instant 字符串；输入不可解析时返回 '' */
    deadline: function (fromInstant, hours) {
      var d = parse(fromInstant);
      if (!d) return '';
      return stamp(new Date(d.getTime() + Number(hours || 0) * 36e5), true);
    },
    /** 截止时间还剩多少毫秒（负数=已超时）；无截止时间返回 null */
    remaining: function (deadlineInstant) {
      var d = parse(deadlineInstant);
      return d ? d.getTime() - Clock.now().getTime() : null;
    },
    isTimeout: function (deadlineInstant) {
      var r = Clock.remaining(deadlineInstant);
      return r !== null && r < 0;
    },
    /** 剩余时间可读化：'剩余 6 小时 12 分' / '已超时 1 小时 5 分' */
    humanRemaining: function (deadlineInstant) {
      var r = Clock.remaining(deadlineInstant);
      if (r === null) return { text: '—', timeout: false, ms: null };
      var abs = Math.abs(r), h = Math.floor(abs / 36e5), m = Math.floor(abs % 36e5 / 6e4);
      var span = h > 0 ? h + ' 小时 ' + m + ' 分' : m + ' 分';
      return { text: r >= 0 ? '剩余 ' + span : '已超时 ' + span, timeout: r < 0, ms: r };
    },

    /** 把时钟推进 minutes 分钟（演示超时场景用） */
    advance: function (minutes, operator) {
      var st = Clock.state();
      var base = st.mode === 'frozen'
        ? Math.round((parse(st.frozenAt).getTime() - Date.now()) / 6e4)
        : (st.offsetMinutes || 0);
      return persist({ mode: 'offset', offsetMinutes: base + Number(minutes || 0), frozenAt: '' }, operator);
    },
    setOffset: function (minutes, operator) {
      return persist({ mode: 'offset', offsetMinutes: Number(minutes || 0), frozenAt: '' }, operator);
    },
    freezeAt: function (instantStr, operator) {
      return persist({ mode: 'frozen', frozenAt: instantStr || Clock.instant() }, operator);
    },
    reset: function (operator) { return persist(blank(), operator); }
  };

  if (global.FHIR && global.FHIR.subscribe) {
    global.FHIR.subscribe(function (evt) {
      // 只有真正涉及资源读回/重写时才作废，sync 心跳不重置
      if (evt && evt.action === 'sync') return;
      Clock.reload();
    });
  }

  global.Clock = Clock;
})(window);
