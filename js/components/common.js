/* =====================================================================
 * common.js —— 通用 UI 组件（弹框 / 分页 / 标签 / 图表 / 空状态）
 * ===================================================================== */
(function (global) {
  'use strict';
  var AMS = global.AMS = global.AMS || { components: {}, pages: {} };
  var C = AMS.components;

  /* 弹框 */
  C['ui-modal'] = {
    props: { title: String, width: { type: String, default: '' } },
    emits: ['close'],
    template: `
      <div class="modal-mask" @click.self="$emit('close')">
        <div class="modal" :class="width">
          <div class="modal-head">
            <h3>{{ title }}</h3>
            <button class="x" @click="$emit('close')">✕</button>
          </div>
          <div class="modal-body"><slot></slot></div>
          <div class="modal-foot" v-if="$slots.foot"><slot name="foot"></slot></div>
        </div>
      </div>`
  };

  /* 分页 */
  C['ui-pager'] = {
    props: { total: Number, page: Number, size: { type: Number, default: 10 } },
    emits: ['update:page'],
    computed: {
      pages: function () { return Math.max(1, Math.ceil(this.total / this.size)); },
      list: function () {
        var n = this.pages, p = this.page, arr = [];
        for (var i = 1; i <= n; i++) {
          if (i === 1 || i === n || Math.abs(i - p) <= 1) arr.push(i);
          else if (arr[arr.length - 1] !== '…') arr.push('…');
        }
        return arr;
      }
    },
    methods: { go: function (p) { if (p !== '…' && p >= 1 && p <= this.pages) this.$emit('update:page', p); } },
    template: `
      <div class="pager">
        <div class="pages">
          <button class="pg" :disabled="page<=1" @click="go(page-1)">上一页</button>
          <button v-for="p in list" class="pg" :class="{active:p===page}" @click="go(p)">{{ p }}</button>
          <button class="pg" :disabled="page>=pages" @click="go(page+1)">下一页</button>
        </div>
        <div>共 {{ total }} 条，每页 {{ size }} 条</div>
      </div>`
  };

  /* 分级标签 */
  C['level-tag'] = {
    props: { level: String },
    computed: {
      cls: function () { return { unrestricted: 'green', restricted: 'orange', special: 'red' }[this.level] || 'gray'; },
      name: function () { return global.Domain.levelName(this.level); }
    },
    template: `<span class="tag" :class="cls">{{ name }}</span>`
  };

  /* 审批状态标签 */
  C['status-tag'] = {
    props: { status: String },
    computed: {
      map: function () {
        return {
          'completed': { c: 'green', t: '✅ 已通过' },
          'in-progress': { c: 'orange', t: '⏳ 审批中' },
          'requested': { c: 'orange', t: '⏳ 待审批' },
          'rejected': { c: 'red', t: '❌ 已驳回' },
          'cancelled': { c: 'gray', t: '↩ 已撤回' }
        }[this.status] || { c: 'gray', t: this.status };
      }
    },
    template: `<span class="tag" :class="map.c">{{ map.t }}</span>`
  };

  /* 空状态 */
  C['empty-state'] = {
    props: { text: { type: String, default: '暂无数据' }, icon: { type: String, default: '📭' } },
    template: `<div class="empty"><div class="ico">{{ icon }}</div><p>{{ text }}</p><slot></slot></div>`
  };

  /* 柱状图 */
  C['bar-chart'] = {
    props: { data: Array }, // [{label, value}]
    computed: { max: function () { return Math.max.apply(null, this.data.map(function (d) { return d.value; }).concat([1])); } },
    template: `
      <div class="bar-chart">
        <div class="bc" v-for="d in data">
          <div class="bar" :style="{height: (d.value/max*100)+'%'}"><span>{{ d.value }}</span></div>
          <div class="x">{{ d.label }}</div>
        </div>
      </div>`
  };

  /* 折线图（SVG） */
  C['line-chart'] = {
    props: { values: Array, color: { type: String, default: '#1769c0' }, height: { type: Number, default: 170 } },
    computed: {
      pts: function () {
        var v = this.values, n = v.length; if (!n) return '';
        var max = Math.max.apply(null, v), min = Math.min.apply(null, v), rng = (max - min) || 1;
        var w = 600, h = this.height - 24;
        return v.map(function (y, i) { return (i / (n - 1) * w).toFixed(1) + ',' + (h - (y - min) / rng * h + 8).toFixed(1); }).join(' ');
      },
      area: function () {
        if (!this.pts) return ''; var w = 600, h = this.height - 24 + 8;
        return '0,' + h + ' ' + this.pts + ' ' + w + ',' + h;
      }
    },
    template: `
      <svg :viewBox="'0 0 600 '+height" preserveAspectRatio="none" style="width:100%;height:auto">
        <polygon :points="area" :fill="color" opacity="0.08"></polygon>
        <polyline :points="pts" fill="none" :stroke="color" stroke-width="2.5" stroke-linejoin="round"></polyline>
      </svg>`
  };

  /* 饼图（SVG） */
  C['pie-chart'] = {
    props: { data: Array }, // [{label, value, color}]
    computed: {
      arcs: function () {
        var total = this.data.reduce(function (s, d) { return s + d.value; }, 0) || 1;
        var acc = 0, R = 80, cx = 100, cy = 100;
        return this.data.map(function (d) {
          var a0 = acc / total * Math.PI * 2 - Math.PI / 2;
          acc += d.value;
          var a1 = acc / total * Math.PI * 2 - Math.PI / 2;
          var large = (a1 - a0) > Math.PI ? 1 : 0;
          var x0 = cx + R * Math.cos(a0), y0 = cy + R * Math.sin(a0);
          var x1 = cx + R * Math.cos(a1), y1 = cy + R * Math.sin(a1);
          return { d: 'M' + cx + ',' + cy + ' L' + x0.toFixed(1) + ',' + y0.toFixed(1) + ' A' + R + ',' + R + ' 0 ' + large + ' 1 ' + x1.toFixed(1) + ',' + y1.toFixed(1) + ' Z', color: d.color, pct: (d.value / total * 100).toFixed(1) };
        });
      }
    },
    template: `
      <div style="display:flex;align-items:center;gap:18px;flex-wrap:wrap">
        <svg viewBox="0 0 200 200" style="width:170px;height:170px">
          <path v-for="a in arcs" :d="a.d" :fill="a.color" stroke="#fff" stroke-width="1.5"></path>
        </svg>
        <div class="pie-legend">
          <div class="pl" v-for="(d,i) in data"><span class="sw" :style="{background:d.color}"></span>{{ d.label }} <b>{{ arcs[i].pct }}%</b></div>
        </div>
      </div>`
  };

})(window);
