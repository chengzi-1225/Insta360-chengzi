// ==UserScript==
// @name         Label Studio 自动构图（以主体为中心）
// @namespace    https://label.insta360.com/
// @version      2.6.0
// @description  按主体自动构图；无人场景按选中或已有比例框居中补齐，高亮新写入框，支持滚动、调整窗口及撤销
// @author       chengzi
// @match        https://label.insta360.com/*
// @grant        none
// @downloadURL  https://raw.githubusercontent.com/chengzi-1225/Insta360-chengzi/main/LabelStudio-auto-compose.user.js
// @updateURL    https://raw.githubusercontent.com/chengzi-1225/Insta360-chengzi/main/LabelStudio-auto-compose.user.js
// @run-at       document-idle
// ==/UserScript==

/* =====================================================================
 *  Label Studio 自动构图 v2.4
 *  ---------------------------------------------------------------------
 *  工作方式：读取当前标注中 subject_tool 的主体框 → 用 canvas 分析原图像素
 *  得到「哪一侧空旷 / 人物朝向 / 地平线 / 头部位置」→ compose-core.js 据此
 *  判断构图方式与各比例裁剪框 → 直接写回 Label Studio 的 annotation 数据模型
 *  （走官方 createResult，会产生正常的撤销历史，不自动提交/通过）。
 *
 *  v2 相对 v1 的关键变化：
 *   · 三分法必须有方向性依据（朝向 / 一侧空旷），没有依据就退回居中；
 *   · 允许「切人不切头」：装不下时优先切下半身，头部是硬保护区；
 *   · 新增「大特写」「低地平线」两种构图方式。
 *
 *  依赖：compose-core.js 与 scene-analyze.js 已内联在本文件下方。
 *  v2.4：主体单选/多选、按主体补充缺失比例、新增框高亮及独立撤销记录；
 *  自动构图统一比较标准/更紧/更松候选，优先保住完整主体并兼顾景物。
 *  v2.5.3：按当前主体检查缺失，原生列表精确高亮新写入框，多主体互不混算。
 *  v2.6.0：无人场景按选中比例框或已有框共同中心补齐，无框时整图居中。
 * ===================================================================== */

(function () {
  'use strict';

  /* ===================================================================
   *  0. 环境守卫
   * =================================================================== */

  if (window.__LS_AUTO_COMPOSE__) {
    try { window.__LS_AUTO_COMPOSE__.panel && window.__LS_AUTO_COMPOSE__.panel.remove(); } catch (e) {}
  }
  // 旧版「比例齐全度浮窗」还在跑的话它会重复渲染一套状态，提示一次即可
  const RATIO_PANEL_ALIVE = () => !!window.__LS_RATIO_COVERAGE_ACTIVE ||
    !!document.getElementById('__ls_ratio_coverage_panel');

  const ASPECT_DEFS = [
    { key: '16_9', label: '16:9', name: 'crop_16_9', value: '16:9', ratio: 16 / 9 },
    { key: '9_16', label: '9:16', name: 'crop_9_16', value: '9:16', ratio: 9 / 16 },
    { key: '4_3', label: '4:3', name: 'crop_4_3', value: '4:3', ratio: 4 / 3 },
    { key: '3_4', label: '3:4', name: 'crop_3_4', value: '3:4', ratio: 3 / 4 },
    { key: '1_1', label: '1:1', name: 'crop_1_1', value: '1:1', ratio: 1 }
  ];

  /**
   * 写入策略（取代 v2.4 里「补充缺失比例」按钮 + 「覆盖已有同比例框」开关的组合）
   *   fill    只补缺失，已有的框一律不动
   *   replace 同比例先写新框再删旧框（可撤销）
   *   append  同比例也再写一个（多方案并存）
   */
  const STRATEGIES = [
    { key: 'fill', label: '补齐缺失', hint: '只写缺失的比例，已有的框不动' },
    { key: 'replace', label: '覆盖同比例', hint: '替换当前主体独有的同比例框，其他主体及共用框保留，可撤销' },
    { key: 'append', label: '总是追加', hint: '同比例也再写一个，多个框并存' }
  ];

  /* ===================================================================
   *  1. Label Studio 适配层（所有 Htx 相关访问集中在这里）
   * =================================================================== */

  const LS = {
    /** 等待 Label Studio 就绪 */
    async ready(timeoutMs = 20000) {
      const t0 = Date.now();
      while (Date.now() - t0 < timeoutMs) {
        const ok = window.Htx && window.Htx.annotationStore &&
          window.Htx.annotationStore.annotations &&
          window.Htx.annotationStore.annotations.length > 0;
        if (ok) return true;
        await sleep(200);
      }
      return false;
    },

    store() { return window.Htx.annotationStore; },

    annotation() {
      const s = this.store();
      return s && ((s.selected && s.selected.regionStore && s.selected) ||
        (s.selectedAnnotation && s.selectedAnnotation.regionStore && s.selectedAnnotation) ||
        (s.annotations && s.annotations[0])) || null;
    },

    /** 找到当前图片对象对应的控件名（默认 img1） */
    imageName() {
      const s = this.store();
      const first = ASPECT_DEFS.map(d => s.names.get(d.name)).find(Boolean);
      if (first && first.toname) return first.toname;
      return 'img1';
    },

    /** 读取原图尺寸 */
    imageSize() {
      const s = this.store();
      const name = this.imageName();
      const imgCtl = s.names.get(name);
      let nw = 0, nh = 0;

      if (imgCtl && typeof imgCtl.findImageEntity === 'function') {
        try {
          const ent = imgCtl.findImageEntity(0);
          nw = ent.naturalWidth; nh = ent.naturalHeight;
        } catch (e) { /* ignore */ }
      }
      if (!(nw > 0 && nh > 0)) {
        // 兜底：从页面上可见的图片元素取
        const cands = [...document.querySelectorAll('img')]
          .filter(i => (i.naturalWidth || 0) > 200)
          .sort((a, b) => b.naturalWidth * b.naturalHeight - a.naturalWidth * a.naturalHeight);
        if (cands[0]) { nw = cands[0].naturalWidth; nh = cands[0].naturalHeight; }
      }
      if (!(nw > 0 && nh > 0)) throw new Error('取不到原图尺寸');
      return { width: nw, height: nh };
    },

    /** 标注里的全部区域（兼容 areas / regionStore 两种存在形式） */
    regionList(annot) {
      const an = annot || this.annotation();
      if (!an) return [];
      const src = an.areas || (an.regionStore && an.regionStore.regions);
      if (!src) return [];
      try {
        if (typeof src.values === 'function') return [...src.values()];
        return [...src];
      } catch (e) { return []; }
    },

    /** 区域上的标签值（rectanglelabels / labels …） */
    regionLabelsOf(region) {
      const base = region && region.results && region.results[0];
      const v = (base && base.value) || {};
      const labels = [];
      Object.keys(v).forEach(k => {
        if (/labels$/i.test(k) && Array.isArray(v[k])) labels.push(...v[k]);
      });
      return { base, labels };
    },

    aspectOf(region) {
      const { base, labels } = this.regionLabelsOf(region);
      const from = nameOf(base && base.from_name) || '';
      if (from === 'subject_tool') return null;
      const known = ASPECT_DEFS.find(a => a.name === from);
      if (known) return known;
      const key = labels.map(label => this.matchAspect(this.parseRatioText(label))).find(Boolean) ||
        this.matchAspect(this.parseRatioText(from.replace(/_/g, ':')));
      return ASPECT_DEFS.find(a => a.key === key) || null;
    },

    /** 读取某个控件已存在的区域，转换成百分比框 */
    readRegions(controlName, annot) {
      const out = [];
      const aspect = ASPECT_DEFS.find(a => a.name === controlName);
      this.regionList(annot).forEach(r => {
        const res = r.results && r.results[0];
        const from = nameOf(res && res.from_name);
        if (from !== controlName && (!aspect || this.aspectOf(r)?.key !== aspect.key)) return;
        out.push({
          x: num(r.x), y: num(r.y), w: num(r.width), h: num(r.height),
          region: r,
          labels: (res.value && (res.value.rectanglelabels || res.value.labels)) || []
        });
      });
      return out;
    },

    /** 从任意文本里解析宽高比（"16:9" / "4/3" / "9x16" 都认） */
    parseRatioText(text) {
      const m = String(text == null ? '' : text)
        .match(/(\d+(?:\.\d+)?)\s*[:：/xX×*]\s*(\d+(?:\.\d+)?)/);
      if (!m) return null;
      const w = parseFloat(m[1]), h = parseFloat(m[2]);
      return w > 0 && h > 0 ? w / h : null;
    },

    /** 宽高比是否命中某个预设比例（容差 0.6%） */
    matchAspect(value, tol = 0.006) {
      if (!(value > 0)) return null;
      let best = null, bestDiff = Infinity;
      ASPECT_DEFS.forEach(a => {
        const diff = Math.abs(value - a.ratio) / a.ratio;
        if (diff < bestDiff) { best = a.key; bestDiff = diff; }
      });
      return bestDiff <= tol ? best : null;
    },

    /** outliner 里的行文本（控件名不是 crop_16_9 时的兜底来源） */
    outlinerTexts() {
      const isGhost = node => !!node.closest('.lsf-panel-tabs__ghost-tab');
      // 没有布局的环境（jsdom / 隐藏标签页）里 getClientRects 恒为空，
      // 这种情况按「可见」处理，否则兜底扫描会永远扫不到东西。
      const laidOut = document.body && document.body.getClientRects().length > 0;
      const visible = n => !laidOut || n.getClientRects().length > 0;
      const root = [...document.querySelectorAll('.lsf-outliner')]
        .find(n => !isGhost(n) && visible(n));
      if (!root) return null;
      const rows = [...root.querySelectorAll('.lsf-outliner-item')]
        .filter(item => !isGhost(item) && visible(item))
        .map(item => {
          const t = item.querySelector('.lsf-outliner-item__title');
          return ((t && t.textContent) || item.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60);
        })
        .filter(Boolean);
      return rows.length ? rows : null;
    },

    /**
     * 比例齐全度：每个比例已有几个框、还缺哪些。
     * 先按控件名精确统计（最稳）；一个都没有时才回退到 outliner 文本解析
     * （控件命名不是 crop_16_9 时也能给出结论）。
     */
    completeness(annot) {
      const an = annot || this.annotation();
      const byName = {}, byKey = {};
      ASPECT_DEFS.forEach(a => { byName[a.name] = 0; byKey[a.key] = 0; });
      let total = 0;
      ASPECT_DEFS.forEach(a => {
        const n = this.readRegions(a.name, an).length;
        byName[a.name] = n;
        byKey[a.key] = n;
        total += n;
      });
      let source = total > 0 ? 'store' : null;
      if (!total) {
        const texts = this.outlinerTexts();
        if (texts) {
          source = 'outliner';
          texts.forEach(text => {
            const key = this.matchAspect(this.parseRatioText(text));
            if (!key) return;
            const def = ASPECT_DEFS.find(a => a.key === key);
            byKey[key]++;
            byName[def.name]++;
            total++;
          });
        }
      }
      const missing = ASPECT_DEFS.filter(a => !byKey[a.key]).map(a => a.key);
      return {
        byName, byKey, total, missing, source,
        covered: ASPECT_DEFS.length - missing.length,
        subjects: this.subjectEntries(an).length
      };
    },

    /** 某个比例对应的标签控件：先从已有区域学，再按命名猜 */
    controlFor(controlName, annot) {
      const s = this.store();
      const an = annot || this.annotation();
      const names = (an && an.names) || (s && s.names);
      const get = n => {
        try { return names && typeof names.get === 'function' && n ? names.get(n) : null; } catch (e) { return null; }
      };
      const known = get(controlName);
      if (known) return known;

      const aspect = ASPECT_DEFS.find(a => a.name === controlName) ||
        ASPECT_DEFS.find(a => this.matchAspect(this.parseRatioText(controlName)) === a.key);

      if (aspect) {
        // 已有区域里的 from_name 才是真正写得进去的控件名
        const hit = this.regionList(an).find(r => {
          const { base, labels } = this.regionLabelsOf(r);
          return base && labels.some(l => this.matchAspect(this.parseRatioText(l)) === aspect.key);
        });
        if (hit) {
          const raw = hit.results[0].from_name;
          const n = nameOf(raw);
          if (get(n)) return get(n);
          if (n) return { name: n, type: 'rectanglelabels', resultType: 'rectanglelabels', isLabeling: false };
        }
        // 控件名里带比例数字的模糊匹配
        const tokens = [aspect.key, aspect.key.replace('_', ':'), aspect.key.replace('_', '')];
        let keys = [];
        try {
          if (names && typeof names.forEach === 'function') names.forEach((v, k) => keys.push(String(k)));
          else if (names && typeof names.keys === 'function') keys = [...names.keys()].map(String);
        } catch (e) { /* ignore */ }
        const found = keys.find(k => tokens.some(t => k.toLowerCase().includes(String(t).toLowerCase())) && get(k));
        if (found) return get(found);
        // 兜底：按约定命名直接构造一个控件描述
        if (aspect.name) return { name: aspect.name, type: 'rectanglelabels', resultType: 'rectanglelabels', isLabeling: false };
      }
      return null;
    },

    /**
     * 记录平台自己创建框时传给 createResult 的参数形状。
     * 用户手动画过一次框之后，这条模板就是最可靠的创建方式。
     */
    ensureCreateHook(annot) {
      const an = annot || this.annotation();
      if (!an || typeof an.createResult !== 'function' || an.__lsacHooked) return;
      const orig = an.createResult;
      const self = this;
      const wrapper = function (...args) {
        try {
          if (!self._suppressTemplate) {
            const area = args[0], v = args[1];
            if (area && typeof area === 'object' && v && typeof v === 'object' &&
                (v.rectanglelabels || v.labels)) {
              self._template = { areaValue: area, resultValue: v, control: args[2], object: args[3], annotation: an };
            }
          }
        } catch (e) { /* 记模板失败不影响创建 */ }
        return orig.apply(this, args);
      };
      try {
        an.createResult = wrapper;
        an.__lsacHooked = true;
      } catch (e) {
        try {
          Object.defineProperty(an, 'createResult', { configurable: true, writable: true, value: wrapper });
          an.__lsacHooked = true;
        } catch (e2) { /* 挂不上就走主路径 */ }
      }
    },

    /** 照着手动画框时记下的参数复制一个新框 */
    writeFromTemplate(area, labelValue, annot, controlName) {
      const t = this._template;
      if (!t) throw new Error('还没有可用的创建模板');
      const s = this.store();
      const an = annot || this.annotation();
      const areaValue = Object.assign({}, t.areaValue, area);
      const resultValue = Object.assign({}, t.resultValue, area);
      // 只留目标比例的标签；其它 *labels 字段清空，否则新框会带着旧比例的标签
      setLabelValue(resultValue, labelValue);

      const names = (an && an.names) || (s && s.names);
      const get = n => { try { return names && n ? names.get(n) : null; } catch (e) { return null; } };
      const found = get(controlName);
      const control = found || { name: controlName, type: 'rectanglelabels', resultType: 'rectanglelabels', isLabeling: false };

      // 换图后 object（img1/img2…）会变，必须用当前标注里的那个，不能照抄模板
      const cur = this.regionList(an).find(r => r && r.results && r.results[0]);
      const objName = nameOf(cur && cur.results[0].to_name) || this.imageName();
      const object = get(objName) || objName;
      areaValue.object = objName;

      if (typeof an.createResult !== 'function') throw new Error('无 createResult');
      return an.createResult(areaValue, resultValue, control, object);
    },

    /** 建完读回真实尺寸；像素比例偏差 >6% 就顺手修正一次 */
    fixRegionRatio(region, area, keyOrName) {
      const aspect = ASPECT_DEFS.find(a => a.key === keyOrName || a.name === keyOrName);
      if (!aspect || !region) return false;
      let size;
      try { size = this.imageSize(); } catch (e) { return false; }
      const A = size.width / size.height;
      const w = Number(region.width), h = Number(region.height);
      if (!(w > 0 && h > 0)) return false;
      const real = (w / h) * A;
      if (Math.abs(real - aspect.ratio) / aspect.ratio <= 0.06) return true;
      try {
        if (typeof region.setValue === 'function') {
          region.setValue(area);
          const w2 = Number(region.width), h2 = Number(region.height);
          return w2 > 0 && h2 > 0 && Math.abs((w2 / h2) * A - aspect.ratio) / aspect.ratio <= 0.06;
        }
      } catch (e) { /* ignore */ }
      return false;
    },

    /**
     * 写入一个裁剪框。依次尝试：模板复制 → createResult(区域值, 结果值) →
     * createResult(旧签名) → appendResults，每次用区域数是否 +1 判定。
     */
    writeCrop(controlName, labelValue, box, annot, aspectKey) {
      const s = this.store();
      const an = annot || this.annotation();
      if (!an) throw new Error('没有打开的标注');
      if (an.readonly === true) throw new Error('当前任务只读，无法写入');
      this.ensureCreateHook(an);

      const ctl = this.controlFor(controlName, an) || (s.names && s.names.get(controlName));
      if (!ctl) throw new Error('找不到控件 ' + controlName);
      const actualControlName = nameOf(ctl) || controlName;
      const obj = (s.names && s.names.get(this.imageName())) || this.imageName();

      const area = { x: box.x, y: box.y, width: box.w, height: box.h, rotation: 0 };
      const value = { ...area, coordstype: 'perc', rectanglelabels: [labelValue] };
      const before = this.regionList(an).length;
      const created = () => {
        const list = this.regionList(an);
        return list.length > before ? list[list.length - 1] : null;
      };

      const errors = [];
      const tries = [
        ['模板复制', () => this.writeFromTemplate(area, labelValue, an, actualControlName)],
        ['createResult', () => an.createResult(area, value, ctl, obj)],
        ['createResult(旧)', () => an.createResult(this.imageName(),
          { from_name: (ctl && ctl.name) || controlName, to_name: this.imageName(), type: 'rectanglelabels', value })],
        ['appendResults', () => {
          if (typeof an.appendResults !== 'function') throw new Error('无 appendResults');
          an.appendResults([{
            id: 'lsac-' + Date.now(), from_name: (ctl && ctl.name) || controlName,
            to_name: this.imageName(), type: 'rectanglelabels', value
          }]);
        }]
      ];

      this._suppressTemplate = true;
      try {
        for (const [label, fn] of tries) {
          if (created()) break;
          try { fn(); } catch (e) { errors.push(label + '：' + String((e && e.message) || e)); }
        }
      } finally {
        this._suppressTemplate = false;
      }

      const region = created();
      if (!region) {
        throw new Error('创建「' + labelValue + '」裁剪框失败' +
          (errors.length ? '（' + errors.join(' / ') + '）' : ''));
      }
      this.fixRegionRatio(region, area, aspectKey || controlName);
      return region;
    },

    /** 读取主体框 */
    readSubjects(annot) {
      return this.readRegions('subject_tool', annot).map(r => ({ x: r.x, y: r.y, w: r.w, h: r.h }));
    },

    subjectEntries(annot) {
      return this.readRegions('subject_tool', annot).map((r, i) => ({
        ...r, id: String(r.region.id == null ? 'subject:' + i : r.region.id), index: i + 1
      }));
    },

    selectedRegionIds(annot) {
      const an = annot || this.annotation();
      if (!an) return [];
      const rs = an.regionStore || {};
      const ids = new Set();
      const add = value => {
        if (value == null) return;
        if (typeof value === 'string' || typeof value === 'number') ids.add(String(value));
        else if (value.id != null) ids.add(String(value.id));
      };
      const sources = [an.selectedRegions, rs.selectedRegions, rs.selection];
      sources.forEach(source => {
        if (!source) return;
        if (Array.isArray(source)) source.forEach(add);
        else if (typeof source.forEach === 'function') source.forEach((v, k) => { add(v); if (v === true) add(k); });
        else if (source.id != null) add(source);
        else if (typeof source === 'object') Object.keys(source).forEach(k => { if (source[k]) { add(k); add(source[k]); } });
      });
      if (!ids.size) add(an.highlightedNode);
      return [...ids];
    },

    selectedSubjectIds(annot) {
      const ids = new Set(this.selectedRegionIds(annot));
      return this.subjectEntries(annot).filter(s => ids.has(s.id)).map(s => s.id);
    },

    /** 删除一个区域 */
    removeRegion(region) {
      try { region.deleteRegion(); return true; } catch (e) { return false; }
    },

    /**
     * 取原图像素做画面分析。
     * 优先用已加载的 <img>（页面带 crossOrigin=anonymous，canvas 不会被污染），
     * 失败则用 new Image + crossOrigin 重新拉一次。
     * 分析分辨率降到长边 320，够用且很快。
     */
    async imageData(maxSide = 320) {
      const size = this.imageSize();
      const scale = Math.min(1, maxSide / Math.max(size.width, size.height));
      const w = Math.max(1, Math.round(size.width * scale));
      const h = Math.max(1, Math.round(size.height * scale));

      let img = this._imgEl();
      if (!img) {
        // 从控件里拿 src 重新加载
        const src = this.imageSrc();
        if (!src) return null;
        img = await loadImage(src);
      }
      const cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      const ctx = cv.getContext('2d', { willReadFrequently: true });
      if (!ctx) return null;
      ctx.drawImage(img, 0, 0, w, h);
      const data = ctx.getImageData(0, 0, w, h);
      return { width: w, height: h, data: data.data };
    },

    /** 舞台上那张主图 <img>（面积最大且够大） */
    _imgEl() {
      const cands = [...document.querySelectorAll('img')].filter(i => {
        const r = i.getBoundingClientRect();
        return r.width > 120 && r.height > 120 && (i.naturalWidth || 0) > 200 && i.complete;
      });
      if (!cands.length) return null;
      cands.sort((a, b) => {
        const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
        return rb.width * rb.height - ra.width * ra.height;
      });
      return cands[0];
    },

    /** 原图 URL */
    imageSrc() {
      const s = this.store();
      const ctl = s && s.names.get(this.imageName());
      if (ctl) {
        try {
          const ent = ctl.findImageEntity(0);
          if (ent && ent.src) return ent.src;
        } catch (e) { /* ignore */ }
      }
      const el = this._imgEl();
      return el ? el.src : null;
    }
  };

  function loadImage(src) {
    return new Promise(resolve => {
      const im = new Image();
      im.crossOrigin = 'anonymous';
      im.onload = () => resolve(im);
      im.onerror = () => resolve(null);
      im.src = src;
    });
  }

  function num(v) { const n = Number(v); return isFinite(n) ? n : 0; }
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  /** MST 的 reference 字段读出来是模型实例，取字符串要过一层 name */
  function nameOf(v) {
    if (typeof v === 'string') return v;
    return (v && typeof v.name === 'string') ? v.name : null;
  }

  /**
   * value 里可能有 rectanglelabels / labels / htmllabels / keypointlabels…，
   * 只改矩形标签、把其它标签字段清空，否则新框会带着旧比例的标签。
   */
  function setLabelValue(value, label) {
    const key = Array.isArray(value.rectanglelabels) ? 'rectanglelabels'
      : Object.keys(value).find(k => /labels$/i.test(k) && Array.isArray(value[k]) && value[k].length) ||
        'rectanglelabels';
    Object.keys(value).forEach(k => {
      if (/labels$/i.test(k) && k !== key && Array.isArray(value[k]) && value[k].length) value[k] = null;
    });
    value[key] = [label];
    return key;
  }

  /* ===================================================================
   *  2. 构图算法（与 compose-core.js / scene-analyze.js 同源，见文件末尾 CORE 段）
   * =================================================================== */

  /* ===== BEGIN CORE (auto-generated, do not edit) ===== */
/*!
 * compose-core.js — 与页面无关的「以主体为中心」的自动构图算法内核
 * 纯函数，不依赖 DOM / Label Studio / 浏览器 API，可在 Node 中单测。
 *
 * 坐标约定：所有输入输出框均为「百分比 0..100，相对原图左上角」，
 *          与 Label Studio 的 rectanglelabels value 完全一致。
 *
 * v2 的核心变化（回应「三分法必须有依据」「可以适当切人」）：
 *   1. 构图方式不再只看主体占比/偏离，而是要有**方向性证据**：
 *      主体朝向（头部相对躯干偏移）、画面哪一侧更空旷（负空间）、地平线。
 *      拿不到证据就不硬套三分法，退回居中。
 *   2. 新增 tight（大特写满框）与 sky（低地平线大留白）两种构图。
 *   3. 允许**有理由地切人**：切腿保头。头部（或主体上部 30%）是硬保护区，
 *      任何比例下都不允许裁到头部；竖向装不下时优先切下半身。
 *
 * 主要导出：
 *   ASPECTS                5 个构图比例的配置
 *   mergeSubjects(list)    多主体合并为一个构图主体
 *   decideComposition(i)   自动判断构图方式（需要 scene 才能给出三分法的依据）
 *   planCrops(i)           一次算出所选比例的全部裁剪框
 *   planOne(i)             单个比例
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ComposeCore = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ---------------------------------------------------------------- 常量 */

  var ASPECTS = [
    { key: '16_9', name: 'crop_16_9', label: '16:9', ratio: [16, 9] },
    { key: '9_16', name: 'crop_9_16', label: '9:16', ratio: [9, 16] },
    { key: '4_3', name: 'crop_4_3', label: '4:3', ratio: [4, 3] },
    { key: '3_4', name: 'crop_3_4', label: '3:4', ratio: [3, 4] },
    { key: '1_1', name: 'crop_1_1', label: '1:1', ratio: [1, 1] }
  ];

  var MODES = ['center', 'thirds', 'golden', 'tight', 'sky', 'road'];

  var MODE_LABEL = {
    center: '居中', thirds: '三分法', golden: '黄金分割', tight: '大特写', sky: '低地平线', road: '道路引导'
  };

  // 构图中主体在裁剪框内的目标占比（按高度）
  // v3: 普遍调紧一档。v2 的 golden=0.42 配合「hc = sh/fill」会让主体本来就大的照片
  //     直接算到整幅高度，五个比例最后全是「原图框一遍」，等于没有构图。
  var FILL = { center: 0.68, thirds: 0.60, golden: 0.56, tight: 0.88, sky: 0.42, road: 0.58 };
  // 头顶留白（占裁剪框高度）。center/tight 取 (1-fill)/2，让主体在框内上下对称。
  var HEADROOM = { center: 0.16, thirds: 0.13, golden: 0.17, tight: 0.06, sky: 0.10, road: 0.10 };
  // 主体左右最小边距（占裁剪框宽度）
  var SIDE_MARGIN = 0.05;
  // 任何裁剪框最多占画幅的这一比例：只防退化成「整幅原图」，正常构图不该被它限制
  var MAX_SPAN = 0.98;
  // 主体在裁剪框内的最小宽度占比。低于它就说明框宽得离谱（16:9 里人小成一个点），
  // 改为以宽度为约束重新收紧。
  var FILL_W_MIN = 0.24;
  // 宽高比修正：同一个「填满度」在横构图里显得太挤、在竖构图里显得太空。
  // 真实审核员的标法就是「宽比例留环境，窄比例收紧到人」。
  // 从一张 1920×1080 的实拍（雪山合影）反推出的填充率，按比例列出：
  //   16:9 → 43%   4:3 → 46%   1:1 → 50%   3:4 → 66%   9:16 → 53%
  // 注意它不是单调的：3:4 是竖版人像的标尺，填充最高；9:16 手机全屏反而要留环境。
  // 以 golden 的 base 0.56 除之得到修正系数，再在 log(ar) 上线性插值。
  var ASPECT_FILL_KNOTS = [
    { ar: 0.5625, k: 0.95 },   // 9:16
    { ar: 0.75, k: 1.18 },     // 3:4
    { ar: 1.0, k: 0.90 },      // 1:1
    { ar: 1.3333, k: 0.82 },   // 4:3
    { ar: 1.7778, k: 0.78 }    // 16:9
  ];

  function aspectFillK(ar) {
    var k = ASPECT_FILL_KNOTS;
    if (!(ar > 0)) return 1;
    if (ar <= k[0].ar) return k[0].k;
    if (ar >= k[k.length - 1].ar) return k[k.length - 1].k;
    for (var i = 1; i < k.length; i++) {
      if (ar <= k[i].ar) {
        var t = (Math.log(ar) - Math.log(k[i - 1].ar)) /
                (Math.log(k[i].ar) - Math.log(k[i - 1].ar));
        return k[i - 1].k + t * (k[i].k - k[i - 1].k);
      }
    }
    return k[k.length - 1].k;
  }

  function fillForMode(mode, ar, opts) {
    var base = (opts && opts.fill != null) ? opts.fill
      : (FILL[mode] != null ? FILL[mode] : 0.56);
    // fillScale 是「在算好宽高比修正之后」再做的一次缩放（多构图方案用）。
    // 注意不能把缩放后的值塞进 opts.fill —— 那会被 aspectFillK 再乘一次，
    // 16:9 的 k=0.78 会把它压到 0.34，裁剪框直接顶到画幅上限，
    // 多个方案全变成同一个「整幅原图」框（这个坑踩过）。
    var scale = (opts && opts.fillScale != null) ? opts.fillScale : 1;
    return clamp(base * aspectFillK(ar) * scale, 0.30, 0.92);
  }

  var GOLDEN = 0.382;

  // 头部保护区的最小高度占比（防止极小主体时保护区退化成一条线）
  var HEAD_MIN_RATIO = 0.12;

  /* ---------------------------------------------------------------- 工具 */

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function round3(v) { return Math.round(v * 1000) / 1000; }
  function cropRectToTarget(box, rect) {
    return {
      left: rect.left + rect.width * box.x / 100,
      top: rect.top + rect.height * box.y / 100,
      width: rect.width * box.w / 100,
      height: rect.height * box.h / 100
    };
  }
  function pct0(v) { return (v * 100).toFixed(1) + '%'; }
  function sideName(s) { return s === 'left' ? '左' : s === 'right' ? '右' : '无'; }

  function ratioOf(a) {
    if (Array.isArray(a.ratio)) return a.ratio[0] / a.ratio[1];
    var n = Number(a.ratio);
    if (n > 0) return n;
    throw new Error('aspect.ratio 无效: ' + JSON.stringify(a.ratio));
  }

  /* ------------------------------------------------------------ 主体合并 */

  /**
   * 多个主体框（多人合影/主次主体）合并成一个构图主体。
   * @param {Array<{x,y,w,h,label?}>} boxes 百分比框
   * @returns {{x,y,w,h,count,boxes}|null}  百分比框
   */
  function mergeSubjects(boxes) {
    var list = (boxes || []).filter(function (b) {
      return b && isFinite(b.x) && isFinite(b.y) && isFinite(b.w) && isFinite(b.h) && b.w > 0 && b.h > 0;
    });
    if (!list.length) return null;
    var x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    list.forEach(function (b) {
      x1 = Math.min(x1, b.x);
      y1 = Math.min(y1, b.y);
      x2 = Math.max(x2, b.x + b.w);
      y2 = Math.max(y2, b.y + b.h);
    });
    return { x: x1, y: y1, w: x2 - x1, h: y2 - y1, count: list.length, boxes: list };
  }

  /* ---------------------------------------------------------- 方向性证据 */

  /** 百分比头部框 → 归一化框 */
  function normHead(head) {
    if (!head || !isFinite(head.x) || !isFinite(head.w) || head.w <= 0 || head.h <= 0) return null;
    return { x: head.x / 100, y: head.y / 100, w: head.w / 100, h: head.h / 100 };
  }

  /**
   * 主体朝向：侧面/半侧面时，头部（肤色块）会明显偏向身体前方。
   * offset > 0 表示头在躯干右侧 → 朝右。
   * 阈值取 6% 的主体宽度：真实照片里侧脸的头部偏移通常只有几个百分点，
   * 太严会让三分法永远触发不了，太松会把正脸误判成侧脸。
   */
  function facingOf(subject, headF, headConf) {
    if (!headF) return { side: 'none', offset: 0, conf: 0 };
    var sc = subject.x + subject.w / 2;
    var hc = headF.x + headF.w / 2;
    var off = (hc - sc) / (subject.w || 1);
    var side = 'none';
    if (Math.abs(off) >= 0.06 && (headConf || 0) >= 0.30) side = off > 0 ? 'right' : 'left';
    return { side: side, offset: off, conf: headConf || 0 };
  }

  /** 两侧边界、路面和主体位置同时成立，才把汇聚点用于道路构图。 */
  function guidingPath(scene, subject) {
    var vp = scene && scene.vanishing, path = vp && vp.path;
    if (!path || !scene.ok || !(scene.quality >= 0.15) ||
        !(vp.confidence >= 0.60) || !(vp.strength >= 0.32) ||
        !(path.confidence >= 0.60) || !(path.continuity >= 0.65) || !(path.surface >= 0.65)) return null;
    if (![vp.x, vp.y, path.left, path.right, path.bottom].every(Number.isFinite) ||
        vp.x < 0 || vp.x > 1 || vp.y < 0 || vp.y > 0.58 ||
        path.left < 0 || path.right > 1 || path.right - path.left < 0.12 ||
        path.bottom < 0.85 || path.bottom > 1 || path.bottom - vp.y < 0.30) return null;
    var feet = (subject.y + subject.h) / 100;
    if (feet <= vp.y + 0.12) return null;
    var t = clamp((feet - vp.y) / (path.bottom - vp.y), 0, 1);
    var left = vp.x + (path.left - vp.x) * t;
    var right = vp.x + (path.right - vp.x) * t;
    var center = (subject.x + subject.w / 2) / 100;
    // 容许人在路边；远离道路的另一主体不能借用背景道路。
    var margin = Math.min(0.06, Math.max(0.025, (right - left) * 0.15));
    return center >= left - margin && center <= right + margin ? vp : null;
  }

  /* ---------------------------------------------------------- 构图方式判断 */

  /**
   * 自动判断构图方式。
   * @param {{imageWidth:number, imageHeight:number, subject:{x,y,w,h}, scene?:object}} input
   *        scene 可选，来自 SceneAnalyze.analyze()；没有也能跑，但三分法会失去依据。
   * @returns {{mode, confidence, reasons:string[], evidence:object}}
   */
  function decideComposition(input) {
    var W = input.imageWidth, H = input.imageHeight;
    var s = input.subject;
    var scene = input.scene || null;

    var sw = s.w / 100, sh = s.h / 100;
    var sx = s.x / 100, sy = s.y / 100;
    var cx = sx + sw / 2, cy = sy + sh / 2;
    var area = sw * sh;                                   // 主体面积占画幅
    var pixAR = (sw * W) / (sh * H);                      // 主体像素宽高比，>1 偏横
    var offX = Math.abs(cx - 0.5), offY = Math.abs(cy - 0.5);
    var off = Math.max(offX, offY);

    var headF = normHead(scene && scene.head);
    var headConf = (scene && scene.head && scene.head.conf) || 0;
    var facing = facingOf({ x: sx, y: sy, w: sw, h: sh }, headF, headConf);

    var leadSide = (scene && scene.lead && scene.lead.side) || 'none';
    var leadScore = (scene && scene.lead && scene.lead.score) || 0;
    var quality = (scene && isFinite(scene.quality)) ? scene.quality : 0;

    var horizonY = null;
    if (scene && scene.horizon && scene.horizon.strength >= 0.35) horizonY = scene.horizon.y;
    var skyRatio = (scene && scene.sky && scene.sky.ratio) || 0;
    var vanishing = guidingPath(scene, s);
    var features = (scene && Array.isArray(scene.features)) ? scene.features : [];
    var featureScore = features.length ? Math.max.apply(null, features.map(function (f) { return f.score || 0; })) : 0;
    var groundInterest = (scene && isFinite(scene.groundInterest)) ? scene.groundInterest : 0;
    if (!(groundInterest > 0) && vanishing) groundInterest = 1;
    if (!(groundInterest > 0) && features.length) {
      features.forEach(function (f) {
        var fy = (Number(f.y) + Number(f.h) / 2) / 100;
        var fa = (Number(f.w) * Number(f.h)) / 10000;
        var fx1 = Number(f.x), fx2 = fx1 + Number(f.w);
        var sx1 = sx * 100, sx2 = (sx + sw) * 100;
        var xGap = fx1 > sx2 ? fx1 - sx2 : sx1 > fx2 ? sx1 - fx2 : 0;
        // 大片连续地面纹理不算“地面看点”；保留紧凑、明确的前景景物。
        if (fy >= 0.58 && fa <= 0.15 && xGap <= 30 && (f.score || 0) >= 0.68) {
          groundInterest = Math.max(groundInterest, Math.min(1, f.score || 0));
        }
      });
    }

    // ---- 留白侧（视线/运动方向那一侧留空）
    var roomSide = 'none';
    var roomWhy = '';
    if (facing.side !== 'none') {
      roomSide = facing.side;
      roomWhy = '主体朝向' + sideName(facing.side) + '（头部偏离躯干中心 ' +
        (Math.abs(facing.offset) * 100).toFixed(0) + '%）';
    } else if (leadSide !== 'none' && leadScore >= 0.22) {
      roomSide = leadSide;
      roomWhy = '画面' + sideName(leadSide) + '侧更空旷（空度差 ' + leadScore.toFixed(2) + '）';
    }

    var evidence = {
      area: area, cx: cx, cy: cy, off: off,
      pixAspect: pixAR, vertical: sh > sw * (H / W) * 1.15,
      facing: facing.side, facingOffset: facing.offset, headConf: headConf,
      leadSide: leadSide, leadScore: leadScore,
      horizonY: horizonY, skyRatio: skyRatio, quality: quality,
      vanishing: vanishing, features: features, featureScore: featureScore,
      groundInterest: groundInterest,
      roomSide: roomSide, roomWhy: roomWhy,
      openness: (scene && scene.openness) || null,
      subjectBusy: (scene && scene.subjectBusy) || 0,
      backgroundBusy: (scene && scene.backgroundBusy) || 0
    };
    var reasons = [];

    function ret(mode, conf, why) {
      if (why) reasons.push(why);
      return { mode: mode, confidence: clamp(conf, 0, 0.96), reasons: reasons, evidence: evidence };
    }

    // 1) 主体几乎占满画幅 —— 大特写/满框
    if (area >= 0.45) {
      return ret('tight', 0.62 + (area - 0.45) * 1.4,
        '主体占画幅 ' + pct0(area) + '，属大特写，收紧满框');
    }

    // 2) 横向宽主体（多人合影 / 横向物体）—— 对称居中
    if (pixAR >= 1.25 && area >= 0.15) {
      return ret('center', 0.72,
        '主体像素宽高比 ' + pixAR.toFixed(2) + '，属横向宽主体/合影，对称居中');
    }

    // 3) 地平线清晰 + 上部大面积空旷 —— 低地平线大留白
    var landscape = (W / H) >= 1.15;
    if (horizonY != null && skyRatio >= 0.20 && landscape && cy > 0.30 && area <= 0.42) {
      return ret('sky', 0.56 + Math.min(0.3, skyRatio * 0.9),
        '地平线 y=' + (horizonY * 100).toFixed(0) + '%，上部空旷占 ' + pct0(skyRatio) +
        '，采用低地平线大留白');
    }

    // 4) 已验证连续道路/小径及主体位置，才保留「灭点 → 主体 → 前景」。
    if (vanishing && vanishing.strength >= 0.32 && area <= 0.52) {
      return ret('road', 0.62 + Math.min(0.30, vanishing.confidence * 0.30),
        '检测到连续路面和两侧引导边界，主体位于道路范围内；灭点 x=' +
        (vanishing.x * 100).toFixed(0) + '%、y=' + (vanishing.y * 100).toFixed(0) + '%，采用道路引导构图');
    }

    // 5) 方向证据强（有明确朝向或一侧明显更空）—— 不管主体多小都用三分法
    //    这是用户最核心的意见：三分法必须有方向性依据，反过来只要有依据就该用。
    var dirStrong = facing.side !== 'none' || (leadSide !== 'none' && leadScore >= 0.45);
    if (roomSide !== 'none' && dirStrong && area <= 0.45) {
      var strength0 = facing.side !== 'none'
        ? Math.min(1, Math.abs(facing.offset) * 2.2)
        : Math.min(1, leadScore * 1.6);
      return ret('thirds', 0.58 + strength0 * 0.32,
        '三分法：' + roomWhy + '，在' + sideName(roomSide) + '侧留出呼吸空间');
    }

    // 5) 主体很小且明显偏离中心时才使用黄金分割。
    // 小主体但已经接近画面中心时，继续平移会制造无依据的偏置，改为居中。
    if (area <= 0.10 && off >= 0.12) {
      return ret('golden', 0.60 + Math.min(0.28, (0.10 - area) * 2.2),
        '主体仅占画幅 ' + pct0(area) + ' 且偏离中心，采用黄金分割留白');
    }

    // 6) 有方向性证据 —— 三分法
    //    面积上限放宽到 0.45：横向构图里「人 + 大片环境」的面积常常到 0.3~0.4，
    //    只要方向证据成立就仍然该用三分法而不是居中。
    if (roomSide !== 'none' && area > 0.10 && area <= 0.45) {
      var strength = facing.side !== 'none'
        ? Math.min(1, Math.abs(facing.offset) * 2.2)
        : Math.min(1, leadScore * 1.6);
      return ret('thirds', 0.55 + strength * 0.33,
        '三分法：' + roomWhy + '，在' + sideName(roomSide) + '侧留出呼吸空间');
    }

    // 6) 没有方向性证据 —— 不硬套三分法，居中
    if (roomSide === 'none') {
      return ret('center', 0.54 + Math.min(0.24, (1 - off) * 0.3),
        '无明确朝向/空旷侧证据，三分法缺乏依据，采用居中构图');
    }
    return ret('center', 0.56, '主体占画幅 ' + pct0(area) + '，居中构图');
  }

  /* -------------------------------------------------------------- 单比例 */

  /**
   * 生成某一个比例的裁剪框。
   * @param {{W,H,bbox,aspect,mode,ctx?,opts?}} o
   *        ctx = { head:{x,y,w,h}|null, roomSide:'left'|'right'|'none', horizonY:number|null }
   */
  function planOne(o) {
    var W = o.W, H = o.H, bbox = o.bbox, aspect = o.aspect, mode = o.mode;
    var opts = o.opts || {};
    var ctx = o.ctx || {};

    var ar = ratioOf(aspect);
    var R = (ar * H) / W;                                  // 归一化空间下 wc/hc
    var imgAR = W / H;

    var sx = bbox.x / 100, sy = bbox.y / 100;
    var sw = bbox.w / 100, sh = bbox.h / 100;
    var cx = sx + sw / 2, cy = sy + sh / 2;

    var fill = fillForMode(mode, ar, opts);
    var headroom = opts.headroom != null ? opts.headroom : (HEADROOM[mode] != null ? HEADROOM[mode] : 0.10);
    var sideMargin = opts.sideMargin != null ? opts.sideMargin : SIDE_MARGIN;

    var warnings = [];

    // --- 0. 头部保护区：优先用真实头部框，否则取主体上部 30%
    var hz, headReal = false;
    if (ctx.head) {
      hz = { x: ctx.head.x / 100, y: ctx.head.y / 100, w: ctx.head.w / 100, h: ctx.head.h / 100 };
      headReal = true;
      // 真实检测框可能过小（只框到脸），向上扩到头顶。
      // 注意不能夹到主体上沿：主体框往往略低于头顶（头发/帽子在框外），
      // 一旦夹住就会把头顶那一条裁掉。
      hz.y = Math.max(0, hz.y - hz.h * 0.30);
      hz.h = hz.h * 1.30;
    } else {
      hz = { x: sx, y: sy, w: sw, h: Math.max(sh * 0.30, sh * 0.22) };
    }
    // 保护区不会比主体更宽/更高，也不会退化成一条线
    hz.w = clamp(hz.w, sw * HEAD_MIN_RATIO, sw);
    hz.h = clamp(hz.h, Math.min(sh, Math.max(sh * 0.10, 0.012)), sh);
    hz.x = clamp(hz.x, sx, sx + sw - hz.w);
    // 纵向只约束下沿：允许头部保护区向上超出主体框（真实头顶常高于主体框上沿）
    hz.y = clamp(hz.y, 0, Math.max(0, sy + sh - hz.h));

    // --- 1. 目标尺寸
    // v3 关键修正：v2 用 hc = sh/fill 且 fill 很小（golden 0.42），于是一张主体占高 41%
    // 的照片算出 hc = 0.41/0.42 = 0.976 —— 裁剪框几乎等于整幅，五个比例全变成
    // 「把原图框一遍」，没有任何构图行为。这正是「推荐的这么烂」的根因。
    var maxHc = Math.min(1, 1 / R);
    var maxWc = Math.min(1, R);
    var spanCap = opts.maxSpan != null ? opts.maxSpan : MAX_SPAN;   // 最多占画幅的比例
    if (spanCap > 0) {
      maxHc = Math.min(maxHc, spanCap);
      maxWc = Math.min(maxWc, spanCap);
    }

    var hc = sh / fill;
    var wc = hc * R;

    // 主体左右至少留边距
    var minW = sw / (1 - 2 * sideMargin);
    if (wc < minW) { wc = minW; hc = wc / R; }
    // 头部不能被放大到顶满：头高最多占裁剪框 72%
    var needH = hz.h / 0.72;
    if (hc < needH && needH <= maxHc) { hc = needH; wc = hc * R; }
    if (wc < minW) { wc = minW; hc = wc / R; }

    var sizeClamped = false;
    if (hc > maxHc) { hc = maxHc; wc = hc * R; sizeClamped = true; }
    if (wc > maxWc) { wc = maxWc; hc = wc / R; sizeClamped = true; }

    // 没有方向依据且主体靠近原图边缘时，优先缩小到能真正居中的范围，
    // 避免裁剪框被边界夹住后仍显示成“偏左/偏右”的假三分构图。
    if (sh <= hc + 1e-9 && ctx.roomSide === 'none' &&
        (mode === 'center' || mode === 'golden') && !(ctx.features && ctx.features.length) &&
        opts.forceX0 == null && (opts.forceAnchorX == null || opts.forceAnchorX === 0.5)) {
      var centeredW = 2 * Math.min(cx, 1 - cx);
      var centeredH = centeredW / R;
      if (centeredW >= minW && centeredW < wc && centeredH >= sh && centeredH >= needH && centeredH <= maxHc && centeredW <= maxWc) {
        wc = centeredW;
        hc = centeredH;
      }
    }

    // --- 2. 装得下吗
    var cutV = sh > hc + 1e-9;                             // 竖向装不下 → 切下半身
    var cutH = sw > wc + 1e-9;                             // 横向装不下 → 切两侧
    var headCantFit = hz.h > hc + 1e-9;

    // --- 3. 竖向定位
    var y0;
    if (opts.forceY0 != null && !cutV) {
      // 景物优先候选可以在不切主体的情况下微调纵向位置，例如把雪山/摩天轮
      // 的上部轮廓纳入画面；之后仍统一经过头部保护和画幅边界校正。
      y0 = clamp(opts.forceY0, 0, 1 - hc);
    } else if (mode === 'road' && ctx.vanishing) {
      // 让灭点位于上方约 1/3，主体保留在中下部，形成道路纵深。
      var roadVp = ctx.vanishing.y;
      var roadY = roadVp - hc * 0.30;
      var subjectY = cy - hc * 0.62;
      y0 = roadY * 0.64 + subjectY * 0.36;
    } else if (mode === 'sky' && ctx.horizonY != null) {
      // 地平线压在下 1/3 线上：让主体沉到下方，上方留大空
      y0 = ctx.horizonY - hc / 3;
    } else if (cutV) {
      // 切人时以头部为锚点：保住头和肩，切下面
      y0 = hz.y - Math.min(headroom, 0.05) * hc;
    } else {
      var m = (sh / 2) / hc;                              // 主体半高占裁剪框的比例
      var fy;
      if (mode === 'thirds') fy = clamp(m + headroom, m, 1 - m);   // 头贴在上三分线附近
      else if (mode === 'tight') fy = clamp(m + 0.03, m, 1 - m);
      else if (mode === 'golden') fy = clamp(0.45, m, 1 - m);
      else fy = clamp(0.5, m, 1 - m);
      y0 = cy - fy * hc;
    }
    // 普通场景保留约两三成脚下地面，让人物不至于像“贴”在画面底边。
    // 道路、前景景物或景物优先候选继续沿用各自的纵深/纳景策略。
    if (opts.forceY0 == null && mode !== 'road' && !cutV && !(ctx.groundInterest >= 0.45)) {
      var targetGround = 0.25;
      var subjectBottom = sy + sh;
      var targetY0 = subjectBottom - hc * (1 - targetGround);
      // 先保证主体完整，再让目标地面比例尽量落在 20%~30% 区间；
      // 画幅边界和头部保护是硬约束，极端特写时允许自然偏离目标。
      var minY0 = Math.max(0, subjectBottom - hc);
      var minTopRoom = mode === 'tight' ? 0.015 : 0.04;
      var maxY0 = Math.min(1 - hc, sy - minTopRoom * hc, hz.y - 0.004);
      if (maxY0 >= minY0) y0 = clamp(targetY0, minY0, maxY0);
    }
    // 上移只能压缩脚下留白，不能把原本装得下的主体切掉。
    if (!cutV && y0 + hc < sy + sh) {
      y0 = sy + sh - hc;
    }
    // 任何模式都不许切到头顶
    if (y0 > hz.y - 0.004) y0 = hz.y - 0.004;
    y0 = clamp(y0, 0, 1 - hc);

    // --- 4. 横向定位（三分法/黄金分割的落点就在这里）
    var room = ctx.roomSide || 'none';
    var x0, fxUsed = 0.5;

    if (opts.forceX0 != null && !cutH) {
      // 景物优先候选直接传入裁剪框左边界。这样可以在主体仍保有最低覆盖率的
      // 前提下，把雪山/摩天轮/建筑等显著景物纳入画面，不再被固定三分点卡住。
      x0 = clamp(opts.forceX0, 0, 1 - wc);
      fxUsed = clamp((cx - x0) / Math.max(wc, 1e-9), 0, 1);
    } else if (cutH) {
      x0 = cx - wc / 2;                                   // 横向装不下：只求主体居中
    } else {
      var mx = (sw / 2) / wc;                             // 主体半宽占裁剪框的比例
      var fx = 0.5;
      if (opts.forceAnchorX != null) {
        // 候选/多构图可以改变实际落点；评分仍按构图方式的统一目标比较。
        fx = opts.forceAnchorX;
      } else if (mode === 'road' && ctx.vanishing) {
        fx = 0.5;
      } else if (mode === 'thirds') {
        if (room === 'right') fx = 1 / 3;                 // 主体偏左，右侧留出视线空间
        else if (room === 'left') fx = 2 / 3;
        else fx = cx < 0.5 ? 1 / 3 : 2 / 3;
      } else if (mode === 'golden') {
        // golden 在自动模式下也是「以小主体留白」的选择，它本身不携带方向证据。
        // 没有方向证据时若还硬套 0.382，框会整体平移、与人类标注明显错开
        // （实测 1920×1080 雪山图：居中后 IoU 从 0.70~0.75 升到 0.76~0.79）。
        if (room === 'right') fx = GOLDEN;
        else if (room === 'left') fx = 1 - GOLDEN;
        else fx = 0.5;
      }
      fx = clamp(fx, Math.min(mx, 1 - mx), Math.max(mx, 1 - mx));
      fxUsed = fx;
      if (mode === 'road' && ctx.vanishing) {
        x0 = ctx.vanishing.x - 0.5 * wc;
      } else {
        x0 = cx - fx * wc;
      }
    }
    x0 = clamp(x0, 0, 1 - wc);

    // --- 5. 转百分比 + 像素级比例校正
    var box = fixRatio(x0, y0, wc, hc, W, H, ar);

    // --- 6. 评分（v4）：每一项都必须有真实变化，否则分数无法区分好坏
    // v3 的旧公式 0.50*headScore + 0.28*fillScore + 0.22*roomScore 有两个致命问题：
    //   · fillScore 拿 sh/hc 和构造它时用的 fill 比 —— 恒等于 1，纯粹是自我循环；
    //   · 无方向证据时 roomScore 恒为 0.82，于是所有比例都落在 0.94~0.96，
    //     全部标记「推荐」，用户看到的就是「推荐的这么烂」。
    // 现在改成测真实结果：头安全 / 主体完整度 / 充盈偏离 / 落点 / 边距。
    // 注意单位：box 是百分比 0..100，hz 是归一化 0..1，比较前必须统一。
    var bn = { x: box.x / 100, y: box.y / 100, w: box.w / 100, h: box.h / 100 };

    // a) 头部安全（硬指标）
    var headScore = 1;
    if (headCantFit) headScore = 0.12;
    else if (bn.y > hz.y + 0.002) headScore = 0.15;                    // 头顶被切
    else if (bn.y + bn.h < hz.y + hz.h - 0.002) headScore = 0.35;      // 下巴/头部下半被切
    if (bn.x > hz.x + 0.002 || bn.x + bn.w < hz.x + hz.w - 0.002) {
      headScore = Math.min(headScore, 0.30);
    }

    // b) 主体完整度：框内保住了多少主体面积（切腿/切侧都会真实下降）
    var coverScore = coverage(box, bbox);

    // c) 充盈偏离：主体高占框高，与该构图方式目标值的距离
    // 多构图方案的 fill 是被故意改过的，拿它自己当基准又会变成自我循环
    // （越紧的方案 fitScore 越高，最后排到标准方案前面），
    // 所以变体要拿「标准方案的 fill」当基准：偏离标准就要扣分。
    var fillActual = bn.h > 0 ? sh / bn.h : 0;
    var refFill = (opts.refFill != null) ? opts.refFill : fill;
    var fitScore = clamp(1 - Math.abs(fillActual - refFill) / Math.max(0.10, refFill) * 1.2, 0, 1);

    // d) 落点：主体中心是否真的落在该构图方式的理想位置上
    var ax = bn.w > 0 ? (cx - bn.x) / bn.w : 0.5;
    var ay = bn.h > 0 ? (cy - bn.y) / bn.h : 0.5;
    var wantX;
    if (opts.featureAnchorX != null) {
      wantX = opts.featureAnchorX;
    } else if (mode === 'thirds') {
      wantX = room === 'right' ? 1 / 3 : room === 'left' ? 2 / 3 : (cx < 0.5 ? 1 / 3 : 2 / 3);
    } else if (mode === 'golden') {
      wantX = room === 'right' ? GOLDEN : room === 'left' ? 1 - GOLDEN : (cx < 0.5 ? GOLDEN : 1 - GOLDEN);
    } else {
      wantX = 0.5;
    }
    var wantY = opts.featureAnchorY != null ? opts.featureAnchorY : 0.5;
    var placeScore = clamp(
      1 - (Math.abs(ax - wantX) / 0.22 + Math.abs(ay - wantY) / 0.30) / 2, 0, 1);

    // e) 边距：贴边（<2%）看起来像被硬切掉一块
    var gapMin = Math.min(bn.x, 1 - (bn.x + bn.w), bn.y, 1 - (bn.y + bn.h));
    var marginScore = clamp(gapMin / 0.02, 0, 1);

    // e2) 显著景物保留：雪山、摩天轮、建筑等作为背景兴趣区域参与评分。
    var featureScore = 1;
    var featureMiss = false;
    if (ctx.features && ctx.features.length) {
      var fSum = 0, fWeight = 0;
      ctx.features.forEach(function (f) {
        var fs = Math.max(0.1, f.score || 0.1);
        fSum += fs * coverage(box, f);
        fWeight += fs;
      });
      featureScore = fWeight > 0 ? clamp(fSum / fWeight, 0, 1) : 1;
      featureMiss = featureScore < 0.45;
    }

    // f) 留白质量：有方向要求时，视线前方必须真的留出空间
    var roomScore = 0.82;
    if (room !== 'none' && !cutH) {
      var gap = room === 'right' ? (bn.x + bn.w) - (bbox.x + bbox.w) / 100 : (bbox.x / 100) - bn.x;
      roomScore = clamp(gap / (0.42 * bn.w), 0, 1);
    }

    // 普通场景的脚下空间要自然；有显著背景景物时只轻微参考，避免
    // 为了凑地面比例把雪山、摩天轮或特色建筑挤出画面。
    var groundScore = 1;
    if (!cutV && mode !== 'road' && !(ctx.groundInterest >= 0.45)) {
      var subjectBottomN = (bbox.y + bbox.h) / 100;
      var groundRatio = (bn.y + bn.h - subjectBottomN) / Math.max(bn.h, 1e-9);
      groundScore = clamp(1 - Math.abs(groundRatio - 0.25) / 0.28, 0, 1);
    }

    var featurePriority = !!opts.featurePriority;
    var groundWeight = featurePriority ? 0 : ((ctx.features && ctx.features.length) ? 0.025 : 0.09);
    var score = clamp(
      0.26 * headScore + 0.22 * coverScore + 0.16 * fitScore +
      (featurePriority ? 0.08 : 0.14) * placeScore +
      (featurePriority ? 0.05 : 0.06) * marginScore +
      (featurePriority ? 0.03 : 0.06) * roomScore +
      (featurePriority ? 0.20 : 0.10) * featureScore +
      groundWeight * groundScore, 0, 1 + groundWeight) / (1 + groundWeight);

    // 受画幅限制被夹过尺寸，说明构图自由度被压缩了
    if (sizeClamped) score *= 0.95;
    score = clamp(score, 0, 1);

    // --- 7. 面向前端的提示文案
    if (headCantFit) {
      warnings.push('「' + aspect.label + '」裁剪框高度连头部都装不下，会切到头，不建议使用');
    } else if (cutV) {
      warnings.push('「' + aspect.label + '」画幅高度装不下全身，切去下半身（保留头部与上身）');
    }
    if (cutH) {
      warnings.push('「' + aspect.label + '」横向装不下，主体左右会被裁切');
    }
    if (sizeClamped && !cutV && !cutH) {
      warnings.push('受画幅限制，「' + aspect.label + '」只能取到最大可用尺寸');
    }
    if (featureMiss && mode !== 'tight') warnings.push('显著景物未完整纳入，建议切换多构图或手动框选景物');

    return {
      key: aspect.key,
      fromName: aspect.name,
      label: aspect.label,
      ratio: ar,
      box: box,
      pixel: {
        width: round3((box.w / 100) * W),
        height: round3((box.h / 100) * H),
        aspect: 0
      },
      mode: mode,
      modeLabel: MODE_LABEL[mode] || mode,
      roomSide: room,
      anchorX: round3(fxUsed),
      featureScore: round3(featureScore),
      groundScore: round3(groundScore),
      head: { x: round3(hz.x * 100), y: round3(hz.y * 100), w: round3(hz.w * 100), h: round3(hz.h * 100) },
      score: round3(score),
      recommended: headScore >= 0.9 && score >= 0.68,
      warnings: warnings,
      cut: { vertical: cutV, horizontal: cutH, head: headCantFit || headScore < 0.9 }
    };
  }

  /** 局部覆盖率：裁剪框内包含的主体面积 / 主体总面积 */
  function coverage(box, subject) {
    var iw = Math.min(box.x + box.w, subject.x + subject.w) - Math.max(box.x, subject.x);
    var ih = Math.min(box.y + box.h, subject.y + subject.h) - Math.max(box.y, subject.y);
    if (iw <= 0 || ih <= 0) return 0;
    return (iw * ih) / (subject.w * subject.h);
  }

  /**
   * 把百分比框四舍五入到 3 位小数（Label Studio 精度），并把像素宽高比校正到目标值。
   */
  function fixRatio(x0, y0, wc, hc, W, H, ar) {
    var x = round3(x0 * 100);
    var y = round3(y0 * 100);
    var w = round3(wc * 100);
    var h = round3(hc * 100);

    for (var i = 0; i < 4; i++) {
      var px = (w / 100) * W;
      var py = (h / 100) * H;
      if (py <= 0) break;
      var err = Math.abs(px / py - ar) / ar;
      if (err <= 1e-4) break;                       // 误差 < 0.01%，收工
      var targetPy = px / ar;
      var nh = round3((targetPy / H) * 100);
      if (nh === h) break;
      h = nh;
    }

    if (h > 100) { h = 100; w = round3(((h / 100) * H * ar / W) * 100); }
    if (w > 100) { w = 100; h = round3(((w / 100) * W / ar / H) * 100); }
    if (x + w > 100) x = round3(100 - w);
    if (y + h > 100) y = round3(100 - h);
    if (x < 0) x = 0;
    if (y < 0) y = 0;

    return { x: x, y: y, w: w, h: h };
  }

  /* ---------------------------------------------------------- 候选过滤 */

  function candidateAnchors(mode, roomSide, cx) {
    var center = 0.5;
    // 没有朝向、引导线或空旷侧证据时，不凭空把主体推向三分点。
    if (roomSide === 'none') return [center];
    var direction = center;
    if (mode === 'thirds') {
      direction = roomSide === 'right' ? 1 / 3 : roomSide === 'left' ? 2 / 3 : center;
    } else if (mode === 'golden') {
      direction = roomSide === 'right' ? GOLDEN : roomSide === 'left' ? 1 - GOLDEN : center;
    }
    var reverse = direction < 0.5 ? 2 / 3 : 1 / 3;
    var out = [direction, center, reverse];
    var seen = {};
    return out.filter(function (v) {
      var key = String(Math.round(v * 1000));
      if (seen[key]) return false;
      seen[key] = true;
      return true;
    });
  }

  /**
   * 为强显著景物寻找额外的横向裁剪位置。
   *
   * 固定的 1/3、居中、反向三分点适合人物方向，但雪山/摩天轮/特色建筑
   * 往往位于主体的另一侧，必须在“主体仍保留至少 62%”的范围内再向景物
   * 平移。这里直接扫描可用的 x0，比用单一经验锚点更能适应不同景物大小、
   * 主体距离和画幅比例。
   */
  function featureFocusCandidates(seed, bbox, features) {
    if (!seed || !seed.box || !Array.isArray(features) || !features.length) return [];
    var wc = seed.box.w / 100;
    var hc = seed.box.h / 100;
    if (!(wc > 0 && hc > 0 && wc < 1.001)) return [];

    var out = [];
    features.forEach(function (f) {
      var fs = Number(f && f.score);
      var fw = Number(f && f.w), fh = Number(f && f.h);
      if (!f || !isFinite(fs) || fs < 0.50 || !(fw > 0) || !(fh > 0)) return;
      // 太小的噪点和几乎铺满画面的背景纹理不作为“拍照意图景物”。
      var fa = (fw * fh) / 10000;
      if (fa < 0.004 || fa > 0.55) return;

      var best = null;
      for (var xi = 0; xi <= 60; xi++) {
        var x0 = (1 - wc) * xi / 60;
        for (var yi = 0; yi <= 60; yi++) {
          var y0 = (1 - hc) * yi / 60;
          var candidateBox = { x: x0 * 100, y: y0 * 100, w: seed.box.w, h: seed.box.h };
          var subjectCoverage = coverage(candidateBox, bbox);
          // 景物优先只在主体几乎完整时启用；这样“把景物带进来”不会以切掉
          // 头部或明显切身为代价。极少量像素的四舍五入误差留出 0.5% 容差。
          if (subjectCoverage < 0.995) continue;
          var featureCoverage = coverage(candidateBox, f);
          var featureCenterX = (f.x + f.w / 2) / 100;
          var featureCenterY = (f.y + f.h / 2) / 100;
          var subjectCenterX = (bbox.x + bbox.w / 2) / 100;
          var subjectCenterY = (bbox.y + bbox.h / 2) / 100;
          var xCenter = x0 + wc / 2;
          var yCenter = y0 + hc / 2;
          var xDirection = featureCenterX < subjectCenterX
            ? clamp((subjectCenterX - xCenter) / Math.max(wc, 1e-9), 0, 1)
            : clamp((xCenter - subjectCenterX) / Math.max(wc, 1e-9), 0, 1);
          var yDirection = featureCenterY < subjectCenterY
            ? clamp((subjectCenterY - yCenter) / Math.max(hc, 1e-9), 0, 1)
            : clamp((yCenter - subjectCenterY) / Math.max(hc, 1e-9), 0, 1);
          var directionBonus = 0.55 * xDirection + 0.45 * yDirection;
          // 景物在主体上方时，不需要把裁剪框一直顶到原图上沿；在景物
          // 仍完整、主体不被切的前提下，优先保留少量自然脚下空间。
          var subjectBottom = (bbox.y + bbox.h) / 100;
          var groundRatio = (y0 + hc - subjectBottom) / Math.max(hc, 1e-9);
          var groundBonus = clamp(1 - Math.abs(groundRatio - 0.25) / 0.28, 0, 1);
          var score = 0.62 * featureCoverage + 0.23 * subjectCoverage +
            0.07 * directionBonus + 0.08 * groundBonus;
          if (!best || score > best.score) {
            best = { x0: x0, y0: y0, score: score, feature: f };
          }
        }
      }
      if (best && best.score >= 0.42) out.push(best);
    });
    return out;
  }

  function validCropCandidate(candidate, bbox, mode) {
    if (!candidate || !candidate.box) return false;
    if (candidate.cut && candidate.cut.head) return false;
    var subjectArea = (bbox.w * bbox.h) / 10000;
    var minCoverage = mode === 'tight' ? 0.82 : 0.62;
    if (coverage(candidate.box, bbox) < minCoverage) return false;
    // 只有主体确实占满画面时才允许退化成接近整幅原图。
    if (Math.max(candidate.box.w, candidate.box.h) >= 97 && subjectArea < 0.45 && mode !== 'sky') return false;
    // 判断主体在裁剪框内的空间；裁剪框碰原图边缘不等于切人。
    var box = candidate.box;
    var edge = Math.min((bbox.x - box.x) / box.w, (bbox.y - box.y) / box.h,
      (box.x + box.w - bbox.x - bbox.w) / box.w,
      (box.y + box.h - bbox.y - bbox.h) / box.h);
    if (edge < -0.005) return false;
    return true;
  }

  function pickBestCandidate(candidates, bbox, mode) {
    var valid = candidates.filter(function (c) { return validCropCandidate(c, bbox, mode); });
    if (!valid.length) return candidates.slice().sort(function (a, b) { return b.score - a.score; })[0];
    // 能完整容纳主体时，不为微小得分提升牺牲手脚。
    var full = valid.filter(function (c) { return coverage(c.box, bbox) >= 0.995; });
    if (full.length) valid = full;
    valid.sort(function (a, b) { return b.score - a.score; });
    return valid[0];
  }

  /* ---------------------------------------------------------------- 主入口 */

  /**
   * @param {{
   *   imageWidth:number, imageHeight:number,
   *   subjects:Array<{x,y,w,h}>,
   *   aspects?:Array, mode?:'auto'|'center'|'thirds'|'golden'|'tight'|'sky',
   *   scene?:object, options?:object
   * }} input
   */
  function planCrops(input) {
    var W = input.imageWidth, H = input.imageHeight;
    if (!(W > 0 && H > 0)) throw new Error('imageWidth / imageHeight 无效');
    var bbox = mergeSubjects(input.subjects);
    if (!bbox) throw new Error('没有可用的主体框');

    var scene = input.scene || null;
    var dec = decideComposition({ imageWidth: W, imageHeight: H, subject: bbox, scene: scene });
    var mode = input.mode && input.mode !== 'auto' ? input.mode : dec.mode;
    if (MODES.indexOf(mode) < 0) throw new Error('未知构图方式: ' + mode);

    var ev = dec.evidence;
    var ctx = {
      head: (scene && scene.head) || null,
      roomSide: ev.roomSide,
      horizonY: ev.horizonY,
      vanishing: ev.vanishing,
      features: ev.features || [],
      groundInterest: ev.groundInterest || 0
    };

    var aspects = input.aspects && input.aspects.length ? input.aspects : ASPECTS;
    var vn = input.variants != null ? input.variants : 1;   // 每个比例最多给几个构图方案
    var isAuto = !input.mode || input.mode === 'auto';
    var crops = aspects.map(function (a) {
      var base = planOne({ W: W, H: H, bbox: bbox, aspect: a, mode: mode, ctx: ctx, opts: input.options || {} });
      var one = base;
      // 自动模式按画幅分别比较方向、居中和反向锚点；手动模式保留用户指定方式。
      if (isAuto) {
        var candidates = [];
        var anchors = candidateAnchors(mode, ev.roomSide, bbox.x + bbox.w / 2);
        var baseOptions = input.options || {};
        var referenceFill = fillForMode(mode, ratioOf(a), baseOptions);
        // 每个画幅同时比较构图位置与松紧，避免标准尺寸挡住景物轮廓。
        var scales = mode === 'tight' ? [1] : [1, 1.16, 1.32, 0.86, 0.74];
        scales.forEach(function (scale) {
          var candidateOptions = Object.assign({}, baseOptions, {
            fillScale: (baseOptions.fillScale || 1) * scale, refFill: referenceFill
          });
          var seed = planOne({ W: W, H: H, bbox: bbox, aspect: a, mode: mode, ctx: ctx, opts: candidateOptions });
          anchors.forEach(function (anchor) {
            candidates.push(planOne({ W: W, H: H, bbox: bbox, aspect: a, mode: mode, ctx: ctx,
              opts: Object.assign({}, candidateOptions, { forceAnchorX: anchor }) }));
          });
          if (ctx.features.length && mode !== 'tight' && mode !== 'road') {
            featureFocusCandidates(seed, bbox, ctx.features).forEach(function (fc) {
              candidates.push(planOne({ W: W, H: H, bbox: bbox, aspect: a, mode: mode, ctx: ctx,
                opts: Object.assign({}, candidateOptions, {
                  forceX0: fc.x0, forceY0: fc.y0,
                  featureAnchorX: clamp((bbox.x / 100 + bbox.w / 200 - fc.x0) / (seed.box.w / 100), 0, 1),
                  featureAnchorY: clamp((bbox.y / 100 + bbox.h / 200 - fc.y0) / (seed.box.h / 100), 0, 1),
                  featurePriority: true
                }) }));
            });
          }
        });
        one = pickBestCandidate(candidates, bbox, mode);
      }
      if (vn > 1) {
        one.variants = planVariants({
          W: W, H: H, bbox: bbox, aspect: a, mode: mode, ctx: ctx, base: one,
          opts: input.options || {}, n: vn
        });
      }
      return one;
    });

    crops.forEach(function (c) { c.pixel.aspect = round3(c.pixel.width / c.pixel.height); });

    return {
      mode: mode,
      modeLabel: MODE_LABEL[mode] || mode,
      autoMode: dec.mode,
      overridden: mode !== dec.mode,
      confidence: dec.confidence,
      reasons: dec.reasons,
      evidence: ev,
      facing: ev.facing,
      roomSide: ev.roomSide,
      horizonY: ev.horizonY,
      skyRatio: ev.skyRatio,
      subject: bbox,
      image: { width: W, height: H },
      sceneOk: !!(scene && scene.ok),
      crops: crops
    };
  }

  /** 无主体时沿参考比例框的共同中心补齐，保持比例并限制在参考范围内。 */
  function planReferenceCrops(input) {
    var W = input.imageWidth, H = input.imageHeight;
    if (!(W > 0 && H > 0)) throw new Error('imageWidth / imageHeight 无效');
    var refs = (input.references || []).filter(function (r) {
      return r && [r.x, r.y, r.w, r.h].every(Number.isFinite) && r.w > 0 && r.h > 0 &&
        r.x >= 0 && r.y >= 0 && r.x + r.w <= 100.001 && r.y + r.h <= 100.001;
    });
    function median(values) {
      values.sort(function (a, b) { return a - b; });
      var mid = Math.floor(values.length / 2);
      return values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
    }
    var cx = refs.length ? median(refs.map(function (r) { return r.x + r.w / 2; })) : 50;
    var cy = refs.length ? median(refs.map(function (r) { return r.y + r.h / 2; })) : 50;
    var rw = Math.min(refs.length ? median(refs.map(function (r) { return r.w; })) : 100, 2 * Math.min(cx, 100 - cx));
    var rh = Math.min(refs.length ? median(refs.map(function (r) { return r.h; })) : 100, 2 * Math.min(cy, 100 - cy));
    var reference = { x: cx - rw / 2, y: cy - rh / 2, w: rw, h: rh, count: refs.length };
    var aspects = input.aspects && input.aspects.length ? input.aspects : ASPECTS;
    var crops = aspects.map(function (a) {
      var ratio = ratioOf(a);
      var width = Math.min(rw * W / 100, rh * H / 100 * ratio);
      var height = width / ratio;
      return {
        key: a.key, fromName: a.name, label: a.label, ratio: ratio,
        box: { x: cx - width / W * 50, y: cy - height / H * 50, w: width / W * 100, h: height / H * 100 },
        pixel: { width: width, height: height, aspect: ratio },
        cut: { head: false }, warnings: [], score: 0, recommended: false
      };
    });
    return {
      mode: 'center', modeLabel: '居中', autoMode: 'center', overridden: false, confidence: 0,
      reasons: [refs.length ? '按参考比例框的共同中心补齐，保持参考范围，不移动旧框。' : '没有主体框和可用比例框，按整张图片居中生成。'],
      evidence: {}, facing: 'none', roomSide: 'none', horizonY: null, skyRatio: 0,
      subject: null, reference: reference, image: { width: W, height: H }, sceneOk: false, crops: crops
    };
  }

  /* ---------------------------------------------------------------- 多构图 */

  // 同一比例可以给出多个构图方案（Label Studio 允许一个比例画多个框）。
  // 每个方案换一个「落点/充盈度」参数，而不是换构图方式 ——
  // 换方式会得到完全不同的照片含义，换落点才是真正的「多构图」。
  // n: 方案数上限（1 = 旧行为，只给最推荐的那个）
  var VARIANT_TARGETS = {
    // 主体横向落点（相对裁剪框宽度）。0.5 = 居中
    anchorX: [null, 0.5, 1 / 3, 2 / 3],
    // 充盈度缩放：1 = 标准；<1 = 更松（留更多环境）；>1 = 更紧（更近的特写）
    fillScale: [1, 0.82, 1.18]
  };

  /**
   * 为主体的某个比例规划多个互不相同的构图候选。
   * 返回按 score 降序排列的数组，第一个永远与 planCrops 里的那个完全一致。
   *
   * @param {Object} o {W,H,bbox,aspect,mode,ctx,opts,n}
   *        n 最多返回几个方案（默认 3）
   */
  function planVariants(o) {
    var n = o.n != null ? o.n : 3;
    if (n < 1) n = 1;

    var opts = o.opts || {};
    var base = o.base || planOne(o);
    base.variantTag = '标准';
    base.variantFillScale = 1;
    var out = [base];
    if (n === 1) return out;

    // 变体评分要拿「标准方案的充盈度」当基准，否则越紧的方案 fitScore 越高、
    // 会排到标准方案前面（自我循环）。
    var baseFill = opts.fill != null ? opts.fill : fillForMode(o.mode, ratioOf(o.aspect), opts);

    // 候选组合：先换充盈度（松/紧），再换落点（偏左/偏右）
    var combos = [
      { anchorX: 0.5, fillScale: 0.82, tag: '居中留白' },
      { anchorX: 0.5, fillScale: 1.18, tag: '居中特写' },
      { anchorX: 1 / 3, fillScale: 0.90, tag: '主体偏左' },
      { anchorX: 2 / 3, fillScale: 0.90, tag: '主体偏右' }
    ];

    combos.forEach(function (cb) {
      if (out.length >= n) return;

      var v = planOne({
        W: o.W, H: o.H, bbox: o.bbox, aspect: o.aspect, mode: o.mode,
        ctx: o.ctx,
        opts: {
          fillScale: cb.fillScale,         // 在 aspectFillK 之后再缩放，避免被乘两次
          refFill: baseFill,               // 以标准方案的充盈度为基准评分，避免自我循环
          headroom: opts.headroom,
          sideMargin: opts.sideMargin,
          maxSpan: opts.maxSpan,
          forceAnchorX: cb.anchorX
        }
      });
      v.variantTag = cb.tag;
      v.variantFillScale = cb.fillScale;

      // 会切到头 / 明显不如已有的，直接丢掉（多给方案不能降低质量下限）
      if (v.cut.head) return;
      if (v.score < base.score - 0.12) return;

      // 变体必须真的朝目标方向变化：更松要真的更大、更紧要真的更小。
      // 否则（例如已经顶到画幅上限时再放宽）会得到一个和标准方案差不多的框，
      // 既浪费一个方案位，又让人以为「多构图」只是重复。
      var dh = v.box.h - base.box.h;
      if (cb.fillScale < 1 && !(dh > base.box.h * 0.02)) return;
      if (cb.fillScale > 1 && !(dh < -base.box.h * 0.02)) return;

      // 放宽后如果已经顶到画幅上限（框≈整幅原图），那不算一种「构图」，
      // 只是把原图重新框了一遍 —— 这正是用户说的「推荐的这么烂」的那种框。
      if (cb.fillScale < 1 && (v.box.w >= 97 || v.box.h >= 97) &&
          (base.box.w < 96 && base.box.h < 96)) return;

      // 与已产出方案的实际框高度重合（IoU > 0.96）就没有「多构图」的意义
      var tooClose = out.some(function (p) { return boxIoU(p.box, v.box) > 0.96; });
      if (tooClose) return;

      out.push(v);
    });

    // 第一个永远是标准方案（与 planCrops 完全一致），其余按分数排序
    var rest = out.slice(1).sort(function (a, b) { return b.score - a.score; });
    return [base].concat(rest);
  }

  /** 两个百分比框的交并比，用于判断方案是否几乎重合 */
  function boxIoU(a, b) {
    var iw = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
    var ih = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
    if (iw <= 0 || ih <= 0) return 0;
    var inter = iw * ih;
    var union = a.w * a.h + b.w * b.h - inter;
    return union > 0 ? inter / union : 0;
  }

  /* ---------------------------------------------------------------- 导出 */

  return {
    ASPECTS: ASPECTS,
    MODES: MODES,
    MODE_LABEL: MODE_LABEL,
    FILL: FILL,
    HEADROOM: HEADROOM,
    mergeSubjects: mergeSubjects,
    decideComposition: decideComposition,
    facingOf: facingOf,
    planCrops: planCrops,
    planReferenceCrops: planReferenceCrops,
    planOne: planOne,
    planVariants: planVariants,
    cropRectToTarget: cropRectToTarget,
    boxIoU: boxIoU,
    fixRatio: fixRatio,
    coverage: coverage,
    _internals: { clamp: clamp, round3: round3, normHead: normHead }
  };
});
/* ===== END CORE ===== */

  /* ===================================================================
   *  2b. 画面证据层（与 scene-analyze.js 同源，见文件末尾 SCENE 段）
   * =================================================================== */

  /* ===== BEGIN SCENE (auto-generated, do not edit) ===== */
/*!
 * scene-analyze.js — 从原始像素算出的「画面内容证据」（自动构图的证据层）
 * 纯函数，零依赖：不碰 DOM / canvas / 网络 / 文件。输入是 RGBA 像素数组
 * （典型来自 canvas getImageData），因此可以在 Node 里用合成图做单测。
 *
 * 坐标约定：所有百分比坐标 0..100，相对整幅原图左上角，与 Label Studio
 *           rectanglelabels 的 value 完全一致。
 *
 * 唯一导出：analyze(image, subject, opts)
 *   image   = { width, height, data }   data 长度 = width*height*4（RGBA）
 *   subject = { x, y, w, h } 百分比框，或 null
 *   opts    见 DEFAULTS
 *
 * 返回字段（字段名固定，调用方据此读取）：
 *   ok, quality, cols, rows, busy, openness, lead, horizon, sky, head,
 *   subjectBusy, backgroundBusy
 *
 * 尺度说明：亮度统一用 0..1；busy 用「每格平均亮度斜率」度量（|dx|+|dy| 的
 * 中心差分后再做 3x3 盒式平滑），因此阈值与图像像素尺寸无关，只与降采样
 * 网格有关。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SceneAnalyze = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var VERSION = '1.0.0';

  /* ---------------------------------------------------------------- 默认值 */

  var DEFAULTS = {
    cols: 32,               // 目标列数，行数按宽高比换算，行/列都夹在 8..48
    rows: 0,                // 0 = 按宽高比自动换算
    skinThreshold: 0.5,     // 肤色判据严格度 0(宽)..1(严)，0.5 = 教科书窗口
    headGrid: 32,           // 头部检测用的肤色网格列数
    minHeadRatio: 0.015,    // 肤色连通域面积 / 主体面积 下限
    horizonMinRatio: 1.6,   // 候选行能量 / 行能量中位数 下限
    horizonMinStep: 0.045,  // 地平线两侧平均亮度差下限
    leadMinGap: 0.12,       // 左右空旷度差 < 0.12 → none
    leadRawFloor: 0.06,     // 拉伸前的原始差下限（避免把噪点放大成结论）
    leadMinQuality: 0.15,   // 低对比图不给 lead 结论（不可靠）
    roadMinScore: 0.18,
    roadMinBalance: 0.34,
    featureMinScore: 0.24,
    featureMaxCount: 3,
    skyBusyMax: 0.25,       // 天空行：低细节格子判定阈值
    skyRowFrac: 0.7,        // 天空行：低细节格子占比需 > 该值
    skyMinLum: 0.22,        // 天空行：整行平均亮度需 > 该值（拒绝纯黑）
    stretchGainMax: 3       // 左右/上下对比拉伸的最大增益
  };

  /* ---------------------------------------------------------------- 工具 */

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function round3(v) { return Math.round(v * 1000) / 1000; }
  function num(v, d) { var n = Number(v); return isFinite(n) ? n : d; }

  function options(opts) {
    var o = {}, k;
    for (k in DEFAULTS) if (DEFAULTS.hasOwnProperty(k)) o[k] = DEFAULTS[k];
    if (opts) {
      for (k in opts) {
        if (opts.hasOwnProperty(k) && opts[k] !== undefined && opts[k] !== null) o[k] = opts[k];
      }
    }
    o.cols = clamp(Math.round(num(o.cols, 32)), 8, 48);
    o.headGrid = clamp(Math.round(num(o.headGrid, 32)), 8, 64);
    o.skinThreshold = clamp(num(o.skinThreshold, 0.5), 0, 1);
    return o;
  }

  function emptyResult() {
    return {
      ok: false,
      quality: 0,
      cols: 0,
      rows: 0,
      busy: [],
      openness: { left: 0, right: 0, top: 0, bottom: 0, center: 0 },
      lead: { side: 'none', score: 0 },
      horizon: null,
      vanishing: null,
      features: [],
      sky: { ratio: 0 },
      head: null,
      subjectBusy: 0,
      backgroundBusy: 0
    };
  }

  function normalizeBox(subject) {
    if (!subject) return null;
    var x = Number(subject.x), y = Number(subject.y);
    var w = Number(subject.w), h = Number(subject.h);
    if (!isFinite(x) || !isFinite(y) || !isFinite(w) || !isFinite(h)) return null;
    if (!(w > 0) || !(h > 0)) return null;
    var x1 = clamp(x, 0, 100), y1 = clamp(y, 0, 100);
    var x2 = clamp(x + w, 0, 100), y2 = clamp(y + h, 0, 100);
    if (!(x2 - x1 > 0) || !(y2 - y1 > 0)) return null;
    return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  }

  /* -------------------------------------------------- 降采样：亮度网格 */

  function buildLum(image, cols, rows) {
    var W = image.width, H = image.height, data = image.data;
    var n = cols * rows;
    var sum = new Float64Array(n), cnt = new Float64Array(n);
    var colOf = new Int32Array(W), rowOf = new Int32Array(H);
    var i, x, y, p, L, base, idx;
    for (i = 0; i < W; i++) colOf[i] = Math.min(cols - 1, (i * cols / W) | 0);
    for (i = 0; i < H; i++) rowOf[i] = Math.min(rows - 1, (i * rows / H) | 0);
    // 超大图按步长抽样（保持分块均值无偏，且把耗时压在十几毫秒）
    var stride = 1;
    if (W * H > 1200000) stride = Math.max(1, Math.floor(Math.sqrt(W * H / 1200000)));
    var step = stride * 4;
    for (y = 0; y < H; y += stride) {
      base = rowOf[y] * cols;
      p = y * W * 4;
      for (x = 0; x < W; x += stride) {
        // 0.299R + 0.587G + 0.114B，归一到 0..1
        L = (0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2]) / 255;
        idx = base + colOf[x];
        sum[idx] += L; cnt[idx]++;
        p += step;
      }
    }
    var lum = new Float64Array(n);
    for (i = 0; i < n; i++) lum[i] = cnt[i] > 0 ? sum[i] / cnt[i] : 0;
    return lum;
  }

  /* -------------------------------------------------------- 梯度 / busy */

  function gradientMap(lum, cols, rows) {
    var n = cols * rows, g = new Float64Array(n);
    var r, c, i, cL, cR, rU, rD, s, k, v;
    for (r = 0; r < rows; r++) {
      for (c = 0; c < cols; c++) {
        i = r * cols + c;
        // 用「前后向差分的平均」而不是中心差分：中心差分对周期 2 格的交替纹理
        // 恒为 0（奈奎斯特盲区），会让棋盘类高频纹理被判成空旷。
        cL = c > 0 ? c - 1 : c; cR = c + 1 < cols ? c + 1 : c;
        rU = r > 0 ? r - 1 : r; rD = r + 1 < rows ? r + 1 : r;
        s = 0; k = 0;
        if (cR > c) { s += Math.abs(lum[r * cols + cR] - lum[i]); k++; }
        if (cL < c) { s += Math.abs(lum[i] - lum[r * cols + cL]); k++; }
        var dx = k > 0 ? s / k : 0;
        s = 0; k = 0;
        if (rD > r) { s += Math.abs(lum[rD * cols + c] - lum[i]); k++; }
        if (rU < r) { s += Math.abs(lum[i] - lum[rU * cols + c]); k++; }
        var dy = k > 0 ? s / k : 0;
        v = 0.5 * (dx + dy);
        g[i] = v;
      }
    }
    return g;
  }

  function boxBlur3(src, cols, rows) {
    var tmp = new Float64Array(cols * rows);
    var out = new Float64Array(cols * rows);
    var r, c, k, i, sum;
    for (r = 0; r < rows; r++) {
      for (c = 0; c < cols; c++) {
        sum = 0;
        for (k = -1; k <= 1; k++) {
          sum += src[r * cols + clamp(c + k, 0, cols - 1)];
        }
        tmp[r * cols + c] = sum / 3;
      }
    }
    for (r = 0; r < rows; r++) {
      for (c = 0; c < cols; c++) {
        sum = 0;
        for (k = -1; k <= 1; k++) {
          sum += tmp[clamp(r + k, 0, rows - 1) * cols + c];
        }
        out[r * cols + c] = sum / 3;
      }
    }
    return out;
  }

  function percentileOf(arr, p) {
    var n = arr.length;
    if (!n) return 0;
    var a = Array.prototype.slice.call(arr);
    a.sort(function (x, y) { return x - y; });
    var idx = Math.round(p * (n - 1));
    return a[clamp(idx, 0, n - 1)];
  }

  function medianOf(arr) { return percentileOf(arr, 0.5); }

  function meanOf(arr) {
    var n = arr.length;
    if (!n) return 0;
    var s = 0, i;
    for (i = 0; i < n; i++) s += arr[i];
    return s / n;
  }

  /* ------------------------------------------------------------ 区域统计 */

  // 半开区间（格子坐标）内的平均 busy；空区域返回 null
  function meanBusy(busy, cols, rows, c0, c1, r0, r1) {
    var sum = 0, n = 0, r, c;
    for (r = r0; r < r1; r++) {
      for (c = c0; c < c1; c++) { sum += busy[r * cols + c]; n++; }
    }
    return n > 0 ? sum / n : null;
  }

  /**
   * 把两个区域的「空旷度」互相对比做拉伸。
   * gain 随原始差距平滑上升：差距小（≈噪点）时几乎不放大，差距大时放开到
   * stretchGainMax；中心取两者中点，保证「两边都空 / 两边都满」不会被人为拉开。
   */
  function stretchPair(a, b, gainMax) {
    var lo = Math.min(a, b), hi = Math.max(a, b);
    var mid = (lo + hi) / 2;
    var rawGap = hi - lo;
    var gain = 1 + (gainMax - 1) * clamp(rawGap / 0.25, 0, 1);
    return [clamp(mid + (a - mid) * gain, 0, 1), clamp(mid + (b - mid) * gain, 0, 1)];
  }

  /* -------------------------------------------------------------- 地平线 */

  /**
   * 主要水平分界线。
   *   rowEdge[r] = 相邻两行同列亮度差的均值（横向边缘的能量，行均值）
   *   候选行在 rowEdge 之外再用「上下平均亮度差」加权：纯噪点区域的行能量
   *   是均匀的（argmax 会飘到画面边缘），而有真实分界的行两侧亮度差最大，
   *   所以用 step 作为主排序量、rowEdge 作为次要权重。
   * 门槛：该行 rowEdge 需 > horizonMinRatio × 中位数，且两侧亮度差够大。
   */
  function detectHorizon(lum, cols, rows, o) {
    if (rows < 4) return null;
    var n = cols * rows;
    var rowLum = new Float64Array(rows);
    var cum = new Float64Array(rows + 1);
    var rowEdge = new Float64Array(rows);
    var r, c, i, s;
    for (r = 0; r < rows; r++) {
      s = 0;
      for (c = 0; c < cols; c++) s += lum[r * cols + c];
      rowLum[r] = s / cols;
      cum[r + 1] = cum[r] + rowLum[r];
    }
    var edgeMax = 0;
    for (r = 1; r < rows; r++) {
      s = 0;
      for (c = 0; c < cols; c++) s += Math.abs(lum[r * cols + c] - lum[(r - 1) * cols + c]);
      rowEdge[r] = s / cols;
      if (rowEdge[r] > edgeMax) edgeMax = rowEdge[r];
    }
    if (!(edgeMax > 0.004)) return null;

    var total = cum[rows];
    var best = -1, bestScore = -1, bestStep = 0;
    for (r = 1; r < rows; r++) {
      var above = cum[r] / r;
      var below = (total - cum[r]) / (rows - r);
      var step = Math.abs(above - below);
      var score = step * (0.55 + 0.45 * (rowEdge[r] / edgeMax));
      if (score > bestScore) { bestScore = score; best = r; bestStep = step; }
    }
    if (best < 1) return null;

    var edgeArr = new Float64Array(rows - 1);
    for (r = 1; r < rows; r++) edgeArr[r - 1] = rowEdge[r];
    var med = medianOf(edgeArr);
    var energy = rowEdge[best];
    if (!(energy > o.horizonMinRatio * med)) return null;
    if (!(bestStep > o.horizonMinStep)) return null;

    var strength = clamp(energy / (energy + med + 1e-6), 0, 1);
    return { y: round3((best + 0.5) / rows), strength: round3(strength) };
  }

  /* -------------------------------------------------------------- 道路灭点 */

  function sampleRayScore(busy, cols, rows, vx, vy, ex, ey) {
    var sum = 0, lower = 0, n = 0, i;
    for (i = 0; i <= 22; i++) {
      var t = 0.12 + 0.88 * (i / 22);
      var x = clamp(Math.round(vx * (cols - 1) + (ex * (cols - 1) - vx * (cols - 1)) * t), 0, cols - 1);
      var y = clamp(Math.round(vy * (rows - 1) + (ey * (rows - 1) - vy * (rows - 1)) * t), 0, rows - 1);
      var v = busy[y * cols + x] || 0;
      sum += v;
      if (t >= 0.55) lower += v;
      n++;
    }
    if (!n) return 0;
    return 0.55 * (sum / n) + 0.45 * (lower / (n * 0.45));
  }

  /** 路面需要两条连续边界夹着可辨认的表面，不能只沿杂乱纹理猜一组射线。 */
  function roadColorGrid(image, cols, rows) {
    var colors = new Array(cols * rows);
    for (var r = 0; r < rows; r++) {
      for (var c = 0; c < cols; c++) {
        var rgb = [0, 0, 0];
        for (var dy = 0; dy < 3; dy++) {
          for (var dx = 0; dx < 3; dx++) {
            var x = Math.min(image.width - 1, Math.floor((c + (dx + 0.5) / 3) * image.width / cols));
            var y = Math.min(image.height - 1, Math.floor((r + (dy + 0.5) / 3) * image.height / rows));
            var p = (y * image.width + x) * 4;
            for (var k = 0; k < 3; k++) rgb[k] += image.data[p + k] / (255 * 9);
          }
        }
        colors[r * cols + c] = rgb;
      }
    }
    return colors;
  }

  function pathEvidence(colors, cols, rows, vx, vy, leftEnd, rightEnd, subject) {
    if (rightEnd - leftEnd < 0.12) return null;
    function color(x, y) {
      return colors[clamp(Math.floor(y * rows), 0, rows - 1) * cols + clamp(Math.floor(x * cols), 0, cols - 1)];
    }
    function distance(a, b) {
      return (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2])) / 3;
    }
    function occluded(x, y) {
      return subject && x * 100 >= subject.x && x * 100 <= subject.x + subject.w &&
        y * 100 >= subject.y && y * 100 <= subject.y + subject.h;
    }
    function isGreen(rgb) {
      return rgb[1] > rgb[0] * 1.10 && rgb[1] > rgb[2] * 1.06 && rgb[1] - rgb[0] > 0.025;
    }
    // 先看前景是否仍是连续草地，避免对树叶、衣服和草坡的每条假射线做完整检查。
    var foregroundN = 0, foregroundGreen = 0;
    for (var fy = 0.84; fy <= 0.96; fy += 0.04) {
      var ft = (fy - vy) / (0.98 - vy);
      var fl = vx + (leftEnd - vx) * ft, fr = vx + (rightEnd - vx) * ft;
      for (var fx = 1; fx <= 3; fx++) {
        var sampleX = fl + (fr - fl) * fx / 4;
        if (occluded(sampleX, fy)) continue;
        foregroundN++;
        if (isGreen(color(sampleX, fy))) foregroundGreen++;
      }
    }
    if (foregroundN >= 4 && foregroundGreen / foregroundN > 0.50) return null;
    var hits = [0, 0], visible = [0, 0], lowerHits = [0, 0], lowerN = [0, 0];
    var edgeVectors = [[0, 0, 0], [0, 0, 0]], edgeLengths = [0, 0];
    var rowsN = 0, smoothN = 0, greenN = 0, samples = 0, lowerGreen = 0, lowerSamples = 0, contrast = 0;
    for (var step = 0; step < 12; step++) {
      var y = Math.max(0.40, vy + 0.14) + (0.95 - Math.max(0.40, vy + 0.14)) * step / 11;
      var t = (y - vy) / (0.98 - vy);
      var left = vx + (leftEnd - vx) * t, right = vx + (rightEnd - vx) * t;
      if ((right - left) * cols < 2.5) continue;
      var surface = [];
      for (var f = 1; f <= 3; f++) {
        var x = left + (right - left) * f / 4;
        if (occluded(x, y)) continue;
        var rgb = color(x, y);
        surface.push(rgb); samples++;
        var green = isGreen(rgb);
        if (green) greenN++;
        if (y >= 0.82) { lowerSamples++; if (green) lowerGreen++; }
      }
      if (surface.length >= 2) {
        rowsN++;
        var spread = 0;
        for (var a = 0; a < surface.length; a++) {
          for (var b = a + 1; b < surface.length; b++) spread = Math.max(spread, distance(surface[a], surface[b]));
        }
        if (spread <= 0.12) smoothN++;
      }
      var delta = Math.max(1 / cols, (right - left) * 0.08);
      for (var side = 0; side < 2; side++) {
        var edge = side ? right : left;
        if (occluded(edge, y)) continue;
        var edgeContrast = 0, edgeVector = null;
        // 网格和候选角度有量化误差，只在边界一格以内找相邻内外色差。
        for (var offset = -1; offset <= 1; offset++) {
          var ex = edge + offset * 0.75 / cols;
          if (ex - delta < 0 || ex + delta > 1) continue;
          var aColor = color(ex - delta, y), bColor = color(ex + delta, y);
          var edgeValue = distance(aColor, bColor);
          if (edgeValue > edgeContrast) {
            edgeContrast = edgeValue;
            edgeVector = aColor.map(function (v, k) { return (bColor[k] - v) * (side ? -1 : 1); });
          }
        }
        visible[side]++;
        if (y >= 0.72) lowerN[side]++;
        if (edgeContrast >= 0.065) {
          hits[side]++; contrast += edgeContrast;
          var length = 0;
          for (var component = 0; component < 3; component++) {
            edgeVectors[side][component] += edgeVector[component];
            length += edgeVector[component] * edgeVector[component];
          }
          edgeLengths[side] += Math.sqrt(length);
          if (y >= 0.72) lowerHits[side]++;
        }
      }
    }
    if (rowsN < 5 || samples < 12 || greenN / samples > 0.50 ||
        lowerSamples >= 4 && lowerGreen / lowerSamples > 0.50) return null;
    var continuity = Math.min(hits[0] / Math.max(1, visible[0]), hits[1] / Math.max(1, visible[1]));
    var lower = Math.min(lowerHits[0] / Math.max(1, lowerN[0]), lowerHits[1] / Math.max(1, lowerN[1]));
    var surfaceScore = smoothN / rowsN;
    if (visible[0] < 5 || visible[1] < 5 || continuity < 0.65 || lower < 0.60 || surfaceScore < 0.65) return null;
    // 路内与路外的材质变化应沿边界保持一致，地砖和草纹的交替明暗不能算路沿。
    var coherence = Math.min.apply(null, edgeVectors.map(function (v, side) {
      return Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]) / Math.max(1e-6, edgeLengths[side]);
    }));
    if (coherence < 0.65) return null;
    var confidence = 0.45 * continuity + 0.35 * surfaceScore +
      0.20 * clamp(contrast / Math.max(1, hits[0] + hits[1]) / 0.14, 0, 1);
    return { confidence: round3(confidence), continuity: round3(continuity), surface: round3(surfaceScore), coherence: round3(coherence),
      left: leftEnd, right: rightEnd, bottom: 0.98 };
  }

  function detectVanishingPoint(busy, image, cols, rows, subject, o) {
    if (cols < 8 || rows < 8) return null;
    var best = null, colors = roadColorGrid(image, cols, rows);
    var leftEnds = [0.03, 0.16, 0.29, 0.40, 0.47], rightEnds = [0.53, 0.60, 0.71, 0.84, 0.97];
    var vx, vy, i, j;
    for (vy = 0.12; vy <= 0.58; vy += 0.045) {
      for (vx = 0.20; vx <= 0.80; vx += 0.045) {
        var left = [], right = [];
        for (i = 0; i < 5; i++) {
          left.push(sampleRayScore(busy, cols, rows, vx, vy, leftEnds[i], 0.98));
          right.push(sampleRayScore(busy, cols, rows, vx, vy, rightEnds[i], 0.98));
        }
        for (i = 0; i < left.length; i++) {
          for (j = 0; j < right.length; j++) {
            var ls = left[i], rs = right[j];
            var balance = Math.min(ls, rs) / (Math.max(ls, rs) + 1e-6);
            var score = ((ls + rs) / 2) * (0.55 + 0.45 * balance);
            if (score < o.roadMinScore || balance < o.roadMinBalance) continue;
            var path = pathEvidence(colors, cols, rows, vx, vy, leftEnds[i], rightEnds[j], subject);
            if (!path) continue;
            var confidence = 0.45 * path.confidence + 0.35 * clamp(score / 0.50, 0, 1) + 0.20 * balance;
            var rank = confidence * (0.65 + 0.35 * score);
            if (confidence >= 0.60 && (!best || rank > best.rank)) {
              best = { x: vx, y: vy, score: score, left: ls, right: rs, balance: balance,
                confidence: confidence, rank: rank, path: path };
            }
          }
        }
      }
    }
    if (!best) return null;
    return {
      x: round3(best.x), y: round3(best.y),
      strength: round3(clamp(best.score / 0.60, 0, 1)),
      confidence: round3(best.confidence),
      left: round3(best.left), right: round3(best.right),
      balance: round3(best.balance), path: best.path
    };
  }

  /* ------------------------------------------------------------ 显著景物 */

  function detectFeatures(busy, lum, cols, rows, subject, o) {
    if (cols < 8 || rows < 8) return [];
    var n = cols * rows, interest = new Float64Array(n), vals = [], r, c, i;
    for (r = 0; r < rows; r++) {
      for (c = 0; c < cols; c++) {
        i = r * cols + c;
        var local = 0, count = 0;
        if (c > 0) { local += Math.abs(lum[i] - lum[i - 1]); count++; }
        if (c + 1 < cols) { local += Math.abs(lum[i] - lum[i + 1]); count++; }
        if (r > 0) { local += Math.abs(lum[i] - lum[i - cols]); count++; }
        if (r + 1 < rows) { local += Math.abs(lum[i] - lum[i + cols]); count++; }
        var v = 0.62 * (busy[i] || 0) + 0.38 * (count ? local / count : 0);
        if (subject) {
          var px = (c + 0.5) / cols * 100, py = (r + 0.5) / rows * 100;
          if (px >= subject.x && px <= subject.x + subject.w && py >= subject.y && py <= subject.y + subject.h) v *= 0.22;
        }
        interest[i] = v;
        vals.push(v);
      }
    }
    var threshold = Math.max(o.featureMinScore, percentileOf(vals, 0.84));
    var mask = new Uint8Array(n);
    for (i = 0; i < n; i++) mask[i] = interest[i] >= threshold ? 1 : 0;
    var seen = new Uint8Array(n), out = [];
    for (i = 0; i < n; i++) {
      if (!mask[i] || seen[i]) continue;
      var stack = [i], count = 0, c0 = cols, c1 = -1, r0 = rows, r1 = -1, score = 0;
      seen[i] = 1;
      while (stack.length) {
        var q = stack.pop(), qr = (q / cols) | 0, qc = q - qr * cols;
        count++; score += interest[q]; c0 = Math.min(c0, qc); c1 = Math.max(c1, qc); r0 = Math.min(r0, qr); r1 = Math.max(r1, qr);
        var ns = [];
        if (qc > 0) ns.push(q - 1); if (qc + 1 < cols) ns.push(q + 1);
        if (qr > 0) ns.push(q - cols); if (qr + 1 < rows) ns.push(q + cols);
        ns.forEach(function (nx) { if (mask[nx] && !seen[nx]) { seen[nx] = 1; stack.push(nx); } });
      }
      if (count < 2) continue;
      var padX = 1, padY = 1;
      var x = Math.max(0, (c0 - padX) / cols * 100);
      var y = Math.max(0, (r0 - padY) / rows * 100);
      var w = Math.min(100 - x, (c1 - c0 + 1 + padX * 2) / cols * 100);
      var h = Math.min(100 - y, (r1 - r0 + 1 + padY * 2) / rows * 100);
      out.push({ x: round3(x), y: round3(y), w: round3(w), h: round3(h), score: round3(clamp(score / count, 0, 1)), type: 'landmark' });
    }
    out.sort(function (a, b) { return b.score - a.score || (b.w * b.h - a.w * a.h); });
    return out.slice(0, o.featureMaxCount);
  }

  /* ---------------------------------------------------------------- 天空 */

  /** 从顶部起连续「低细节 + 不太黑」的行占整幅高度的比例 */
  function detectSky(busy, lum, cols, rows, o) {
    var r, c, low, rowLum, s, skyRows = 0;
    for (r = 0; r < rows; r++) {
      low = 0; s = 0;
      for (c = 0; c < cols; c++) {
        if (busy[r * cols + c] < o.skyBusyMax) low++;
        s += lum[r * cols + c];
      }
      rowLum = s / cols;
      if (low / cols > o.skyRowFrac && rowLum > o.skyMinLum) skyRows++;
      else break;
    }
    return { ratio: round3(skyRows / rows) };
  }

  /* ---------------------------------------------------------------- 头部 */

  /**
   * 肤色连通域 → 头部框。
   * 在「主体框上部 60%（subject 为 null 时整幅图的上部 60%）」上单独建一个
   * 小网格（约 headGrid 列），按格子平均色做 YCbCr 肤色判据，再 4 邻接
   * flood fill 取最大连通域。只在网格上做，不在原图上做。
   */
  function detectHead(image, box, o, W, H) {
    var rx, ry, rw, rh;
    if (box) {
      rx = box.x / 100 * W; ry = box.y / 100 * H;
      rw = box.w / 100 * W; rh = box.h / 100 * H * 0.6;
    } else {
      rx = 0; ry = 0; rw = W; rh = H * 0.6;
    }
    var rx0 = Math.floor(clamp(rx, 0, W - 1));
    var ry0 = Math.floor(clamp(ry, 0, H - 1));
    rw = Math.min(rw, W - rx0);
    rh = Math.min(rh, H - ry0);
    if (!(rw >= 6) || !(rh >= 6)) return null;

    var gw = o.headGrid;
    var gh = clamp(Math.round(gw * rh / rw), 8, 48);
    var cellW = rw / gw, cellH = rh / gh;
    var nCells = gw * gh;

    var sr = new Float64Array(nCells), sg = new Float64Array(nCells);
    var sb = new Float64Array(nCells), sc = new Float64Array(nCells);
    var stepX = Math.max(1, Math.floor(cellW / 4));
    var stepY = Math.max(1, Math.floor(cellH / 4));
    var x, y, px, py, p, cc, rr, i;

    for (y = 0; y < rh; y += stepY) {
      rr = Math.min(gh - 1, Math.floor(y / cellH));
      py = Math.min(H - 1, ry0 + y);
      for (x = 0; x < rw; x += stepX) {
        cc = Math.min(gw - 1, Math.floor(x / cellW));
        px = Math.min(W - 1, rx0 + x);
        p = (py * W + px) * 4;
        i = rr * gw + cc;
        sr[i] += image.data[p];
        sg[i] += image.data[p + 1];
        sb[i] += image.data[p + 2];
        sc[i]++;
      }
    }

    // 肤色窗口：严格度 0.5 时正好是 Cb 77..127 / Cr 133..173 / Y > 60
    var t = o.skinThreshold;
    var slack = 1.2 - 0.4 * t;
    var cbLo = 102 - 25 * slack, cbHi = 102 + 25 * slack;
    var crLo = 153 - 20 * slack, crHi = 153 + 20 * slack;

    var mask = new Uint8Array(nCells);
    for (i = 0; i < nCells; i++) {
      if (!(sc[i] > 0)) continue;
      var R = sr[i] / sc[i], G = sg[i] / sc[i], B = sb[i] / sc[i];
      var Y = 0.299 * R + 0.587 * G + 0.114 * B;
      var Cb = 128 - 0.168736 * R - 0.331264 * G + 0.5 * B;
      var Cr = 128 + 0.5 * R - 0.418688 * G - 0.081312 * B;
      if (Cb < cbLo || Cb > cbHi || Cr < crLo || Cr > crHi) continue;
      if (!(Y > 60)) continue;
      if (!(R >= G - 2 && G >= B - 6 && R - B > 6)) continue;   // 弱约束：拒绝灰/蓝绿
      mask[i] = 1;
    }

    // 4 邻接 flood fill，取面积最大的连通域
    var seen = new Uint8Array(nCells);
    var stack = new Int32Array(nCells);
    var best = null;
    var idx, sp, q, qr, qc, area, c0, c1, r0, r1;
    for (idx = 0; idx < nCells; idx++) {
      if (!mask[idx] || seen[idx]) continue;
      sp = 0; area = 0; c0 = gw; c1 = -1; r0 = gh; r1 = -1;
      stack[sp++] = idx; seen[idx] = 1;
      while (sp > 0) {
        q = stack[--sp];
        qr = (q / gw) | 0; qc = q - qr * gw;
        area++;
        if (qc < c0) c0 = qc;
        if (qc > c1) c1 = qc;
        if (qr < r0) r0 = qr;
        if (qr > r1) r1 = qr;
        if (qc > 0 && mask[q - 1] && !seen[q - 1]) { seen[q - 1] = 1; stack[sp++] = q - 1; }
        if (qc + 1 < gw && mask[q + 1] && !seen[q + 1]) { seen[q + 1] = 1; stack[sp++] = q + 1; }
        if (qr > 0 && mask[q - gw] && !seen[q - gw]) { seen[q - gw] = 1; stack[sp++] = q - gw; }
        if (qr + 1 < gh && mask[q + gw] && !seen[q + gw]) { seen[q + gw] = 1; stack[sp++] = q + gw; }
      }
      if (!best || area > best.area) best = { area: area, c0: c0, c1: c1, r0: r0, r1: r1 };
    }
    if (!best || best.area <= 0) return null;

    var cellPx = cellW * cellH;
    var compPx = best.area * cellPx;
    var refPx = box ? (box.w / 100 * W) * (box.h / 100 * H) : W * H;
    if (!(refPx > 0)) refPx = W * H;
    if (compPx < o.minHeadRatio * refPx) return null;

    var conf = clamp(compPx / (0.12 * refPx), 0, 1);
    var hx = (rx0 + best.c0 * cellW) / W * 100;
    var hy = (ry0 + best.r0 * cellH) / H * 100;
    var hw = (best.c1 - best.c0 + 1) * cellW / W * 100;
    var hh = (best.r1 - best.r0 + 1) * cellH / H * 100;

    // 肤色块通常只盖住脸，头顶往上延 30% 高度（「头顶」才是真顶点）
    var ext = hh * 0.3;
    var top = Math.max(0, hy - ext);
    var bottom = Math.min(100, hy + hh);
    return {
      x: round3(clamp(hx, 0, 100)),
      y: round3(top),
      w: round3(clamp(hw, 0, 100)),
      h: round3(Math.max(0, bottom - top)),
      conf: round3(conf)
    };
  }

  /* ------------------------------------------------------------- 主入口 */

  /**
   * @param {{width:number,height:number,data:ArrayLike<number>}} image RGBA 像素
   * @param {{x,y,w,h}|null} subject 百分比主体框
   * @param {object} [opts] 见 DEFAULTS
   * @returns {object} 见文件头
   */
  function analyze(image, subject, opts) {
    var o = options(opts);
    var out = emptyResult();

    if (!image || typeof image !== 'object') return out;
    var W = Math.floor(num(image.width, 0));
    var H = Math.floor(num(image.height, 0));
    if (!(W > 0) || !(H > 0)) return out;
    var data = image.data;
    if (!data || typeof data.length !== 'number' || data.length < W * H * 4) return out;

    var cols = o.cols;
    var rows = Math.round(num(o.rows, 0));
    rows = rows > 0 ? clamp(rows, 8, 48) : clamp(Math.round(cols * H / W), 8, 48);

    var box = normalizeBox(subject);
    var n = cols * rows;
    var lum = buildLum(image, cols, rows);
    var grad = boxBlur3(gradientMap(lum, cols, rows), cols, rows);

    /* --- 质量 + busy 归一化 ------------------------------------------- */
    var i, r, c;
    var gSum = 0, lSum = 0, lSq = 0;
    for (i = 0; i < n; i++) { gSum += grad[i]; lSum += lum[i]; lSq += lum[i] * lum[i]; }
    var gradMean = gSum / n;
    var lMean = lSum / n;
    var lStd = Math.sqrt(Math.max(0, lSq / n - lMean * lMean));
    var p95 = percentileOf(grad, 0.95);

    // 用 95 分位归一化；基准太小（纯色/几乎无细节）就整体归零，绝不放大噪点
    var norm = p95 > 0.004 ? p95 : 0;
    var busy = new Array(n);
    for (i = 0; i < n; i++) busy[i] = norm > 0 ? clamp(grad[i] / norm, 0, 1) : 0;

    // quality：细节量 + 对比度，再用「是否有可见梯度」软门控
    var qDetail = clamp((gradMean - 0.005) / 0.045, 0, 1);
    var qContrast = clamp(lStd / 0.07, 0, 1);
    var qGate = clamp((gradMean - 0.004) / 0.02, 0, 1);
    var quality = clamp((0.62 * qDetail + 0.38 * qContrast) * qGate, 0, 1);

    var busyOut = new Array(rows);
    for (r = 0; r < rows; r++) {
      var row = new Array(cols);
      for (c = 0; c < cols; c++) row[c] = round3(busy[r * cols + c]);
      busyOut[r] = row;
    }

    /* --- openness ----------------------------------------------------- */
    var tc = Math.max(1, Math.round(cols / 3));
    var tr = Math.max(1, Math.round(rows / 3));
    var mL = meanBusy(busy, cols, rows, 0, tc, 0, rows);
    var mR = meanBusy(busy, cols, rows, cols - tc, cols, 0, rows);
    var mT = meanBusy(busy, cols, rows, 0, cols, 0, tr);
    var mB = meanBusy(busy, cols, rows, 0, cols, rows - tr, rows);
    var mC = meanBusy(busy, cols, rows,
      Math.floor(cols / 3), Math.ceil(cols * 2 / 3),
      Math.floor(rows / 3), Math.ceil(rows * 2 / 3));
    mL = mL === null ? 1 : mL; mR = mR === null ? 1 : mR;
    mT = mT === null ? 1 : mT; mB = mB === null ? 1 : mB;
    mC = mC === null ? 1 : mC;

    var lr = stretchPair(1 - mL, 1 - mR, o.stretchGainMax);
    var tb = stretchPair(1 - mT, 1 - mB, o.stretchGainMax);

    /* --- 主体内外的细节量 + 左右侧带 ---------------------------------- */
    var allMean = meanOf(busy);
    var subjectBusy = allMean, backgroundBusy = allMean;
    var bandL = { sum: 0, n: 0 }, bandR = { sum: 0, n: 0 };
    if (box) {
      var inSum = 0, inN = 0, outSum = 0, outN = 0;
      for (r = 0; r < rows; r++) {
        var cyp = (r + 0.5) / rows * 100;
        var rowIn = cyp >= box.y && cyp <= box.y + box.h;
        for (c = 0; c < cols; c++) {
          i = r * cols + c;
          var cxp = (c + 0.5) / cols * 100;
          if (rowIn && cxp >= box.x && cxp <= box.x + box.w) { inSum += busy[i]; inN++; }
          else { outSum += busy[i]; outN++; }
          if (cxp < box.x) { bandL.sum += busy[i]; bandL.n++; }
          else if (cxp > box.x + box.w) { bandR.sum += busy[i]; bandR.n++; }
        }
      }
      if (inN > 0) subjectBusy = inSum / inN;
      if (outN > 0) backgroundBusy = outSum / outN;
    }

    /* --- lead --------------------------------------------------------- */
    var rawL = 1 - mL, rawR = 1 - mR;
    var minBand = Math.max(3, Math.round(rows / 4));
    if (box && bandL.n >= minBand && bandR.n >= minBand) {
      // 主体本身通常很 busy，会污染判断：只看主体水平范围之外的左/右带
      rawL = 1 - bandL.sum / bandL.n;
      rawR = 1 - bandR.sum / bandR.n;
    }
    var leadPair = stretchPair(rawL, rawR, o.stretchGainMax);
    var gap = Math.abs(leadPair[0] - leadPair[1]);
    var rawGap = Math.abs(rawL - rawR);
    var lead = { side: 'none', score: 0 };
    if (gap >= o.leadMinGap && rawGap >= o.leadRawFloor) {
      lead.side = leadPair[1] > leadPair[0] ? 'right' : 'left';
      lead.score = round3(clamp(gap / 0.6, 0, 1));
    }

    /* --- 组装 --------------------------------------------------------- */
    out.ok = true;
    out.quality = round3(quality);
    out.cols = cols;
    out.rows = rows;
    out.busy = busyOut;
    out.openness = {
      left: round3(lr[0]), right: round3(lr[1]),
      top: round3(tb[0]), bottom: round3(tb[1]),
      center: round3(clamp(1 - mC, 0, 1))
    };
    out.lead = lead;
    out.horizon = quality > 0.02 ? detectHorizon(lum, cols, rows, o) : null;
    out.vanishing = quality >= 0.15 ? detectVanishingPoint(busy, image, cols, rows, box, o) : null;
    out.features = detectFeatures(busy, lum, cols, rows, box, o);
    out.sky = detectSky(busy, lum, cols, rows, o);
    out.subjectBusy = round3(subjectBusy);
    out.backgroundBusy = round3(backgroundBusy);
    out.head = detectHead(image, box, o, W, H);
    return out;
  }

  /* ---------------------------------------------------------------- 导出 */

  return {
    VERSION: VERSION,
    DEFAULTS: DEFAULTS,
    analyze: analyze,
    _internals: {
      clamp: clamp,
      round3: round3,
      stretchPair: stretchPair,
      normalizeBox: normalizeBox,
      percentileOf: percentileOf
    }
  };
});
/* ===== END SCENE ===== */

  /* ===================================================================
   *  3. UI 面板
   * =================================================================== */

  const PREF_KEY = 'lsac.prefs.v3';
  const LEGACY_PREF_KEY = 'lsac.prefs.v2';
  const MODES = ['auto', 'center', 'thirds', 'golden', 'tight', 'sky', 'road'];

  const STATE = {
    aspects: new Set(ASPECT_DEFS.map(a => a.key)),
    mode: 'auto',
    strategy: 'fill',  // fill / replace / append，见 STRATEGIES
    panelSize: { width: 276, height: 360 }, // 固定窗口尺寸，右下角拖动调整并记住
    replace: false,    // 兼容旧状态：为 true 时等价于 strategy='replace'
    collapsed: false,
    hidden: false,
    scene: true,      // 是否用画面像素分析（关掉=纯几何，更快但没有方向依据）
    multi: false,     // 多构图：同一比例给多个方案
    autoPreview: true,// 改任何设置后自动重算预览
    pick: {},         // 每个比例当前选中的方案序号 {crop_16_9: 0, ...}
    pos: null,        // 面板位置（拖动后记住）
    last: null,       // 当前预览或应用的构图计划
    undoStack: [],    // 最近 5 次写入，可连续撤销
    undo: null,       // = undoStack 栈顶（兼容旧代码）
    added: [],        // 本次补充创建的框，用于比例角标
    written: [],      // 最近一次成功写入的框，用于原生标注列表高亮
    writtenObserver: null,
    writtenRaf: 0,
    subjectBindings: new Map(), // 本任务内自动生成框与主体的关联；切换主体时保留
    addedSignature: '',
    completeness: null, // 比例齐全度快照 {byName,byKey,missing,total,...}
    subjectIds: new Set(),
    subjectKnown: new Set(),
    subjectSignature: null,
    referenceContext: null, // 无主体时锁定参考 ID；几何坐标每次从标注中读取
    referenceGeneratedIds: new Set(), // 自动补出的框不反过来缩小共同参考范围
    annotation: null,
    taskId: null,
    previewTimer: 0,
    previewRevision: 0, // 关闭实时预览时让尚未完成的旧预览失效
    previewLayer: null,
    previewBar: null,
    previewTargets: [],
    previewCrops: [],
    previewAdded: false,
    previewObserver: null,
    previewMutationObserver: null,
    previewRaf: 0,
    previewOnResize: null,
    previewOnScroll: null,
    busy: false,
  };

  loadPrefs();

  /** 从 localStorage 恢复上次的设置（v3 优先，读不到就读旧的 v2） */
  function loadPrefs() {
    let p = {};
    try {
      const raw = localStorage.getItem(PREF_KEY) || localStorage.getItem(LEGACY_PREF_KEY);
      p = raw ? (JSON.parse(raw) || {}) : {};
    } catch (e) { p = {}; }
    try {
      if (Array.isArray(p.aspects) && p.aspects.length) {
        const keep = p.aspects.filter(k => ASPECT_DEFS.some(a => a.key === k));
        if (keep.length) STATE.aspects = new Set(keep);
      }
      if (MODES.indexOf(p.mode) >= 0) STATE.mode = p.mode;
      if (STRATEGIES.some(s => s.key === p.strategy)) STATE.strategy = p.strategy;
      if (typeof p.replace === 'boolean') {
        STATE.replace = p.replace;
        if (p.replace) STATE.strategy = 'replace';
      }
      if (typeof p.scene === 'boolean') STATE.scene = p.scene;
      if (typeof p.multi === 'boolean') STATE.multi = p.multi;
      if (typeof p.autoPreview === 'boolean') STATE.autoPreview = p.autoPreview;
      // 旧版 scale 不再恢复，避免升级后仍按比例放大成长面板。
      if (p.panelSize && Number.isFinite(+p.panelSize.width) && Number.isFinite(+p.panelSize.height) &&
        +p.panelSize.width > 0 && +p.panelSize.height > 0) {
        STATE.panelSize = { width: +p.panelSize.width, height: +p.panelSize.height };
      }
      if (p.collapsed) STATE.collapsed = true;
      if (p.pos && isFinite(p.pos.left) && isFinite(p.pos.top)) {
        STATE.pos = { left: +p.pos.left, top: +p.pos.top };
      }
    } catch (e) { /* 隐私模式等场景忽略 */ }

    // 没记录过位置就继承旧「比例齐全度浮窗」的位置，避免两个工具各占一角
    if (!STATE.pos) {
      try {
        const legacy = JSON.parse(localStorage.getItem('ls_ratio_coverage_pos') || 'null');
        if (legacy && isFinite(legacy.left) && isFinite(legacy.top)) {
          STATE.pos = { left: +legacy.left, top: +legacy.top };
        }
      } catch (e) { /* ignore */ }
    }
  }

  function savePrefs() {
    try {
      localStorage.setItem(PREF_KEY, JSON.stringify({
        aspects: [...STATE.aspects],
        mode: STATE.mode,
        strategy: STATE.strategy,
        replace: STATE.replace,
        scene: STATE.scene,
        multi: STATE.multi,
        autoPreview: STATE.autoPreview,
        panelSize: STATE.panelSize,
        collapsed: STATE.collapsed,
        pos: STATE.pos,
      }));
    } catch (e) { /* ignore */ }
  }

  const CSS = `
  .lsac-panel{position:fixed;top:110px;right:18px;z-index:2147483000;width:276px;height:360px;
    font:12px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
    color:#1f2328;background:#fff;border:1px solid #d8dee4;border-radius:11px;
    box-shadow:0 10px 30px rgba(0,0,0,.16);user-select:none;overflow:hidden;
    display:flex;flex-direction:column;box-sizing:border-box;min-height:0;
    max-width:calc(100vw - 12px);max-height:calc(100vh - 12px)}
  .lsac-head{display:flex;flex-shrink:0;align-items:center;gap:6px;padding:7px 8px 7px 11px;cursor:move;touch-action:none;
    background:linear-gradient(180deg,#f7f9fb,#eef1f4);border-bottom:1px solid #d8dee4}
  .lsac-title{flex:1;min-width:0;font-weight:600;font-size:12.5px;letter-spacing:.2px;display:flex;align-items:center;gap:6px;
    white-space:nowrap;overflow:hidden}
  .lsac-dot{width:7px;height:7px;border-radius:50%;background:#2da44e;box-shadow:0 0 0 3px rgba(45,164,78,.15);flex:none}
  .lsac-dot.warn{background:#d29922;box-shadow:0 0 0 3px rgba(210,153,34,.15)}
  .lsac-dot.err{background:#cf222e;box-shadow:0 0 0 3px rgba(207,34,46,.15)}
  .lsac-ico{cursor:pointer;border:0;background:transparent;color:#6e7781;padding:1px 5px;border-radius:5px;
    font:inherit;font-size:13px;line-height:1.25;flex:none}
  .lsac-ico:hover{background:#dfe3e8;color:#1f2328}
  /* 外层负责限高，内容区负责滚动；子区块不挤压，避免按钮和结果重叠。 */
  .lsac-scroll{display:flex;flex:1 1 auto;min-height:0;overflow:hidden}
  .lsac-body{flex:1 1 auto;min-width:0;min-height:0;padding:9px 8px 11px 11px;
    overflow-y:auto;overflow-x:hidden;display:flex;flex-direction:column;gap:9px;
    overscroll-behavior:contain;touch-action:pan-y;scroll-behavior:auto;
    scrollbar-width:none!important}
  .lsac-body::-webkit-scrollbar{display:none!important;width:0!important;height:0!important}
  .lsac-body>*{flex-shrink:0}
  /* 独立滚动轴不受 macOS 自动隐藏滚动条或宿主页面样式影响。 */
  .lsac-scrollbar{position:relative;flex:0 0 10px;margin:9px 5px 11px 0;
    min-height:0;border-radius:6px;background:#e6eaee;cursor:pointer;touch-action:none}
  .lsac-scroll-thumb{position:absolute;left:1px;right:1px;top:0;height:28px;
    border-radius:5px;background:#98a3af;cursor:grab;touch-action:none}
  .lsac-scrollbar:hover .lsac-scroll-thumb{background:#7f8c9b}
  .lsac-scrollbar.dragging .lsac-scroll-thumb{background:#637387;cursor:grabbing}
  .lsac-scrollbar.disabled{cursor:default}
  .lsac-scrollbar.disabled .lsac-scroll-thumb{background:#cdd4dc;cursor:default}
  .lsac-scrollbar:focus-visible{outline:2px solid #0969da;outline-offset:1px}
  .lsac-panel.collapsed .lsac-scroll,.lsac-panel.collapsed .lsac-actions{display:none}
  .lsac-subjects,.lsac-info{min-height:0}
  .lsac-subjects::-webkit-scrollbar,.lsac-info::-webkit-scrollbar{width:9px;height:9px}
  .lsac-subjects::-webkit-scrollbar-track,.lsac-info::-webkit-scrollbar-track{background:transparent;border-radius:4px}
  .lsac-subjects::-webkit-scrollbar-thumb,.lsac-info::-webkit-scrollbar-thumb{
    background:#c9d1d9;border-radius:4px;border:2px solid transparent;background-clip:padding-box}
  .lsac-subjects::-webkit-scrollbar-thumb:hover,.lsac-info::-webkit-scrollbar-thumb:hover{
    background:#a8b1bb;background-clip:padding-box}
  .lsac-panel.collapsed .lsac-body{display:none}
  .lsac-sec{display:flex;flex-direction:column;gap:4px}
  .lsac-lbl{display:flex;align-items:center;justify-content:space-between;gap:8px;
    font-size:10.5px;font-weight:600;color:#6e7781;letter-spacing:.3px}
  .lsac-lbl .r{font-weight:500;color:#0969da;cursor:pointer;font-size:10px}
  .lsac-lbl .r:hover{text-decoration:underline}
  .lsac-added-summary{display:block;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
    padding:3px 6px;border:1px solid #f2c36b;border-radius:5px;background:#fff7d6;color:#9a6700;
    font-size:10px;font-weight:600;line-height:1.3;box-sizing:border-box}
  .lsac-added-summary:empty{display:none}
  .lsac-subject-scope{font-size:10px;color:#57606a;line-height:1.4}
  /* 标记具体区域，不能按标签文字高亮：多个主体会有同名比例。 */
  .lsf-outliner-item.lsac-written-row{
    background:#fff1c2!important;box-shadow:inset 3px 0 #e67700!important;border-radius:4px}
  .lsf-outliner-item.lsac-written-row:hover{background:#ffe6a3!important}
  .lsf-outliner-item.lsac-written-row .lsf-outliner-item__title{color:#874500!important;font-weight:700}
  .lsf-outliner-item.lsac-written-row .lsf-outliner-item__title::after{
    content:"新写入";display:inline-block;margin-left:6px;padding:1px 4px;border-radius:3px;
    background:#bc4c00;color:#fff;font:600 9px/1.4 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;
    vertical-align:1px;pointer-events:none}
  .lsac-chips{display:grid;gap:4px}
  .lsac-chips.modes{grid-template-columns:repeat(3,1fr)}
  .lsac-chips.aspects{grid-template-columns:repeat(5,1fr)}
  .lsac-chip{border:1px solid #d0d7de;background:#fff;border-radius:6px;
    font:inherit;font-size:11px;cursor:pointer;color:#24292f;transition:border-color .12s,background .12s;padding:0}
  .lsac-chip:hover{border-color:#8c959f;background:#f6f8fa}
  .lsac-chip.on{background:#0969da;border-color:#0969da;color:#fff}
  .lsac-chip.on:hover{background:#0860c4}
  .lsac-chips.modes .lsac-chip{padding:4px 2px;font-size:11px}
  .lsac-chip.mode.on{background:#8250df;border-color:#8250df}
  .lsac-chip.mode.on:hover{background:#7443d1}
  .lsac-chips.aspects .lsac-chip{display:flex;flex-direction:column;align-items:center;
    gap:1px;padding:4px 0 3px;line-height:1.1}
  .lsac-chip .lb{font-size:11px;font-weight:600;letter-spacing:-.2px}
  .lsac-chip .n{font-size:8.5px;height:10px;opacity:.62;font-weight:500;white-space:nowrap}
  .lsac-chip.on .n{opacity:.9}
  .lsac-chip.aspect{position:relative}
  /* 三态：绿=已有 / 红=缺失（点一下补这一个）/ 灰=本次不写 */
  .lsac-chip.aspect.has{background:#e8f7ee;border-color:#b7e3c8;color:#15803d}
  .lsac-chip.aspect.has:hover{background:#d9f2e2}
  .lsac-chip.aspect.miss{background:#fdecec;border-color:#f5b5b5;color:#b91c1c}
  .lsac-chip.aspect.miss:hover{background:#fbdcdc;box-shadow:0 0 0 2px #fecaca}
  .lsac-chip.aspect.off{background:#f6f7f9;border-color:#e6e9ef;color:#94a3b8;text-decoration:line-through}
  .lsac-chip.aspect.off .lb{font-weight:500}
  .lsac-chip.aspect.has.on{box-shadow:inset 0 0 0 1px #15803d}
  .lsac-chip.aspect.miss.on{box-shadow:inset 0 0 0 1px #b91c1c}
  /* 本次新写入的比例：用暖色底、粗边框和短暂脉冲，与普通「已有」绿格拉开差异。 */
  .lsac-chip.aspect.lsac-added{
    background:linear-gradient(135deg,#fff8dc 0%,#ffe39a 100%);
    border-color:#e67700;color:#7a3e00;
    box-shadow:0 0 0 2px rgba(230,119,0,.28),0 3px 8px rgba(188,76,0,.18);
    animation:lsac-added-pulse 1.6s ease-in-out 2
  }
  .lsac-chip.aspect.lsac-added:hover{
    background:linear-gradient(135deg,#fff3bf 0%,#ffd66d 100%);
    border-color:#bc4c00;box-shadow:0 0 0 2px rgba(188,76,0,.36),0 4px 10px rgba(188,76,0,.22)
  }
  .lsac-chip.aspect.lsac-added::after{content:"新增";position:absolute;right:-3px;top:-6px;
    background:#bc4c00;color:white;border:1px solid #8f3b00;border-radius:4px;padding:0 4px;
    font-size:8px;font-weight:700;line-height:12px;letter-spacing:.2px;box-shadow:0 1px 3px rgba(0,0,0,.18)}
  @keyframes lsac-added-pulse{0%,100%{transform:scale(1)}50%{transform:scale(1.045)}}
  @media (prefers-reduced-motion:reduce){.lsac-chip.aspect.lsac-added{animation:none}}
  .lsac-seg{display:grid;grid-template-columns:repeat(3,1fr);border:1px solid #d0d7de;
    border-radius:7px;overflow:hidden;background:#fff}
  .lsac-seg button{border:0;border-right:1px solid #eaeef2;background:#fff;font:inherit;
    font-size:11px;padding:5px 2px;cursor:pointer;color:#57606a}
  .lsac-seg button:last-child{border-right:0}
  .lsac-seg button:hover{background:#f6f8fa}
  .lsac-seg button.on{background:#0969da;color:#fff;font-weight:600}
  .lsac-sum{font-weight:500;color:#57606a;letter-spacing:0}
  .lsac-badge{font-size:10px;padding:0 5px;border-radius:9px;background:#fdecec;color:#b91c1c;
    font-weight:600;flex:none}
  .lsac-badge.ok{background:#e8f7ee;color:#15803d}
  .lsac-mini{display:none;align-items:center;gap:6px;min-width:0}
  .lsac-mini .k{font-size:10.5px;color:#57606a;white-space:nowrap;overflow:hidden;
    text-overflow:ellipsis;max-width:92px}
  .lsac-mini button{border:1px solid #1a7f37;background:#1f883d;color:#fff;border-radius:6px;
    font:inherit;font-size:10.5px;font-weight:600;padding:2px 7px;cursor:pointer;flex:none}
  .lsac-mini button.ghost{background:#fff;color:#57606a;border-color:#d0d7de}
  .lsac-grip{position:absolute;right:0;bottom:0;width:24px;height:30px;cursor:nwse-resize;
    touch-action:none;border-bottom-right-radius:11px;background:transparent;z-index:2}
  .lsac-grip::after{content:"";position:absolute;right:3px;bottom:3px;width:7px;height:7px;
    border-right:2px solid #b9c0c8;border-bottom:2px solid #b9c0c8;border-radius:0 0 2px 0}
  .lsac-grip:hover::after{border-color:#0969da}
  .lsac-panel.collapsed .lsac-grip{display:none}
  .lsac-panel.collapsed{width:236px;height:auto}
  .lsac-panel.collapsed .lsac-title{overflow:visible}
  .lsac-panel.collapsed .lsac-badge{display:none}
  .lsac-panel.collapsed .lsac-mini{display:flex}
  .lsac-more{margin-top:3px}
  .lsac-more>summary{cursor:pointer;font-size:10px;color:#0969da;list-style:none;outline:none}
  .lsac-more>summary::-webkit-details-marker{display:none}
  .lsac-more>summary::before{content:"▸ "}
  .lsac-more[open]>summary::before{content:"▾ "}
  .lsac-check{display:flex;align-items:center;gap:6px;font-size:11px;color:#57606a;cursor:pointer}
  .lsac-check input{margin:0;cursor:pointer;accent-color:#0969da}
  .lsac-subjects{display:flex;flex-direction:column;gap:5px;max-height:100px;overflow:auto}
  .lsac-subject-actions{display:flex;gap:5px}
  .lsac-subject-actions[hidden]{display:none}
  .lsac-subject-actions button{font:inherit;font-size:10px;cursor:pointer;background:#fff;
    border:1px solid #d0d7de;border-radius:5px;padding:3px 6px;color:#0969da}
  .lsac-hint{font-size:10px;color:#6e7781}
  .lsac-row{display:flex;gap:6px;align-items:stretch}
  .lsac-actions{flex-shrink:0;padding:7px 29px 8px 10px;border-top:1px solid #eaeef2;background:#fff}
  .lsac-btn{flex:1;border:1px solid #d0d7de;background:#f6f8fa;border-radius:7px;padding:6px 8px;
    font:inherit;font-size:12px;font-weight:600;cursor:pointer;color:#24292f;transition:.12s;white-space:nowrap}
  .lsac-btn:hover{border-color:#8c959f}
  .lsac-btn:disabled{opacity:.45;cursor:not-allowed}
  .lsac-btn.primary{background:#1f883d;border-color:#1a7f37;color:#fff}
  .lsac-btn.primary:hover:not(:disabled){background:#1a7f37}
  .lsac-btn.mini{flex:0 0 auto;padding:6px 9px;font-size:11px;font-weight:500;color:#57606a}
  .lsac-btn.danger{color:#cf222e;border-color:#f0b5b9;background:#fff}
  .lsac-btn.danger:hover{border-color:#cf222e}
  .lsac-info{background:#f6f8fa;border:1px solid #e1e6eb;border-radius:7px;padding:6px 8px;
    font-size:11px;line-height:1.5;color:#24292f;max-height:none;overflow:visible}
  .lsac-info:empty{display:none}
  .lsac-info b{color:#0969da;font-weight:600}
  .lsac-info .m{display:inline-block;padding:0 5px;border-radius:4px;background:#8250df;color:#fff;
    font-size:10px;font-weight:600;vertical-align:1px}
  .lsac-line{display:flex;justify-content:space-between;gap:6px;font-variant-numeric:tabular-nums;margin-top:2px}
  .lsac-sub{display:flex;flex-direction:column;gap:1px;font-size:10.5px;color:#24292f;
    font-variant-numeric:tabular-nums;margin-top:2px;padding:4px 6px;border-radius:5px;
    background:#eaf7ee;border:1px solid #cfe9d8}
  .lsac-sub .r1{display:flex;align-items:center;gap:5px}
  .lsac-subk{font-size:9.5px;font-weight:600;color:#fff;background:#1f883d;border-radius:3px;padding:0 4px}
  .lsac-subm{color:#6e7781;font-size:10px;line-height:1.4}
  .lsac-sep{height:1px;background:#eaeef2;margin:1px 0}
  .lsac-toggles{display:flex;flex-direction:column;gap:5px}
  .lsac-ev{font-size:10px;color:#0969da;background:#ddf4ff;border:1px solid #b6e3ff;
    border-radius:5px;padding:2px 6px;margin-top:3px;line-height:1.4}
  .lsac-warn{color:#9a6700}
  .lsac-bad{color:#cf222e}
  .lsac-ok{color:#1a7f37}
  .lsac-sc{display:inline-flex;align-items:center;gap:3px;font-size:9.5px;color:#6e7781;
    font-variant-numeric:tabular-nums}
  .lsac-scb{display:inline-block;width:26px;height:4px;border-radius:2px;background:#eaeef2;
    overflow:hidden}
  .lsac-scb>i{display:block;height:100%;background:linear-gradient(90deg,#7c9cff,#0969da)}
  .lsac-vars{display:flex;gap:4px;margin:3px 0 1px;flex-wrap:wrap}
  .lsac-var{border:1px solid #d0d7de;background:#fff;border-radius:5px;font:inherit;font-size:10px;
    padding:1px 6px;cursor:pointer;color:#57606a;white-space:nowrap}
  .lsac-var:hover{border-color:#8c959f;background:#f6f8fa}
  .lsac-var.on{background:#0969da;border-color:#0969da;color:#fff;font-weight:600}
  .lsac-toggle{position:fixed;top:110px;right:18px;z-index:2147483000;width:36px;height:36px;
    border-radius:10px;border:1px solid #d8dee4;background:#fff;cursor:pointer;font-size:15px;
    color:#57606a;box-shadow:0 4px 14px rgba(0,0,0,.14);
    display:none;align-items:center;justify-content:center}
  .lsac-toggle.show{display:flex}
  .lsac-toggle:hover{color:#1f2328;border-color:#8c959f}
  `;

  function buildPanel() {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    const el = document.createElement('div');
    el.className = 'lsac-panel';
    el.innerHTML = `
      <div class="lsac-head">
        <div class="lsac-title"><span class="lsac-dot"></span>自动构图<span class="lsac-badge" data-badge>缺 3</span>
          <span class="lsac-mini"><span class="k" data-mini>缺 3 · 三分法</span>
            <button data-act="write-mini">写入</button>
            <button class="ghost" data-act="expand">展开</button></span>
        </div>
        <button class="lsac-ico" data-act="refresh" title="刷新比例齐全度">⟳</button>
        <button class="lsac-ico" data-act="collapse" title="收起成小条 / 展开">−</button>
        <button class="lsac-ico" data-act="hide" title="隐藏（Ctrl+Shift+L 召回）">✕</button>
      </div>
      <div class="lsac-scroll">
      <div class="lsac-body" id="__ls_auto_compose_body" tabindex="0" aria-label="构图设置与结果">
        <div class="lsac-sec">
          <span class="lsac-lbl">构图主体 <span class="lsac-subject-count"></span></span>
          <div class="lsac-subjects"></div>
          <div class="lsac-subject-actions">
            <button data-act="selected-subjects">用画布选中的主体</button>
            <button data-act="all-subjects">全选主体</button>
          </div>
          <div class="lsac-hint" data-subject-hint>点标注列表的主体可切换；多选按一组构图。</div>
        </div>
        <div class="lsac-sec">
          <span class="lsac-lbl">构图方式<span class="r" data-act="mode-auto" title="回到自动判断">自动判断</span></span>
          <div class="lsac-chips modes">
            <button class="lsac-chip mode" data-mode="auto" title="根据画面证据自动判断">自动</button>
            <button class="lsac-chip mode" data-mode="center" title="主体居中，对称稳定">居中</button>
            <button class="lsac-chip mode" data-mode="thirds" title="主体贴三分之一线，留白侧呼吸">三分法</button>
            <button class="lsac-chip mode" data-mode="golden" title="主体贴 0.382 黄金分割线">黄金</button>
            <button class="lsac-chip mode" data-mode="tight" title="大特写，主体满框">特写</button>
            <button class="lsac-chip mode" data-mode="sky" title="地平线压在下 1/3，上方大留白">低地平线</button>
            <button class="lsac-chip mode" data-mode="road" title="保留道路灭点与前景纵深">道路引导</button>
          </div>
        </div>
        <div class="lsac-sec">
          <span class="lsac-lbl"><span>比例齐全度 <span class="lsac-sum" data-sum>—</span></span>
            <span class="r" data-act="all-aspect">全选</span></span>
          <span class="lsac-subject-scope" data-subject-scope></span>
          <span class="lsac-added-summary" data-added-summary aria-live="polite"></span>
          <div class="lsac-chips aspects">
            ${ASPECT_DEFS.map(a => `<button class="lsac-chip aspect" data-aspect="${a.key}"
              title="左键：点红格补这一个 / 其它格切换是否写入；右键只选它"><span class="lb">${a.label}</span><span class="n" data-count="${a.name}"></span></button>`).join('')}
          </div>
          <div class="lsac-hint">绿=已有 · 红=缺（点一下补这一个）· 灰=本次不写</div>
        </div>
        <div class="lsac-sec">
          <span class="lsac-lbl">写入方式</span>
          <div class="lsac-seg">
            ${STRATEGIES.map(s => `<button data-strategy="${s.key}" title="${s.hint}">${s.label}</button>`).join('')}
          </div>
        </div>
        <div class="lsac-sec lsac-toggles">
          <label class="lsac-check" title="用 canvas 分析原图像素，判断哪一侧空旷 / 朝向 / 地平线 / 头部位置">
            <input type="checkbox" class="lsac-scene"> 分析画面（决定三分法是否有依据）</label>
          <label class="lsac-check" title="同一比例给出最多 3 个不同内缩/落点的构图方案">
            <input type="checkbox" class="lsac-multi"> 多构图（同比例最多 3 个方案）</label>
          <label class="lsac-check" title="改任何设置后自动重算预览，不用再点预览">
            <input type="checkbox" class="lsac-auto"> 实时预览</label>
        </div>
        <div class="lsac-info"></div>
      </div>
      <div class="lsac-scrollbar" role="scrollbar" tabindex="0" aria-label="面板滚动条"
        aria-orientation="vertical" aria-controls="__ls_auto_compose_body" aria-valuemin="0" aria-valuemax="0" aria-valuenow="0">
        <div class="lsac-scroll-thumb"></div>
      </div>
      </div>
      <div class="lsac-row lsac-actions">
          <button class="lsac-btn primary" data-act="apply" title="回车键写入">写入</button>
          <button class="lsac-btn mini" data-act="preview" title="P 键预览">预览</button>
          <button class="lsac-btn mini danger" data-act="undo" title="Z 键撤销，可连续退 5 步">撤销</button>
        </div>
      <div class="lsac-grip" title="拖动右下角调整面板宽高"></div>
    `;
    document.body.appendChild(el);

    // 立即挂到模块变量，后续 sync*/refresh* 才能读到
    panel = el;

    // 隐藏后的召回按钮
    const toggle = document.createElement('button');
    toggle.className = 'lsac-toggle';
    toggle.textContent = '◱';
    toggle.title = '显示自动构图面板（Ctrl+Shift+L）';
    toggle.addEventListener('click', () => setHidden(false));
    document.body.appendChild(toggle);

    // ---- 头部按钮
    el.querySelector('[data-act="collapse"]').addEventListener('click', () => setCollapsed(!STATE.collapsed));
    el.querySelector('[data-act="hide"]').addEventListener('click', () => setHidden(true));
    el.querySelector('[data-act="refresh"]').addEventListener('click', () => {
      refreshCounts(true);
      scheduleAutoPreview(0);
    });
    el.querySelector('[data-act="expand"]').addEventListener('click', () => setCollapsed(false));
    el.querySelector('[data-act="write-mini"]').addEventListener('click', () => run('apply'));

    // ---- 构图方式
    el.querySelectorAll('.lsac-chip.mode').forEach(btn => {
      btn.addEventListener('click', () => {
        STATE.mode = btn.dataset.mode;
        syncMode();
        savePrefs();
        scheduleAutoPreview();
      });
    });
    el.querySelector('[data-act="mode-auto"]').addEventListener('click', () => {
      STATE.mode = 'auto';
      syncMode();
      savePrefs();
      scheduleAutoPreview();
    });

    // ---- 画幅比例：红格=直接补这一个；其它格=切换是否写入；右键=只选它
    panel.querySelectorAll('.lsac-chip.aspect').forEach(btn => {
      const key = btn.dataset.aspect;
      btn.addEventListener('contextmenu', e => {
        e.preventDefault();
        soloAspect(key);
      });
      btn.addEventListener('click', e => {
        if (STATE.busy) return;
        // 灰（本次不写）→ 先选中；红（缺且要写）→ 一点就补；绿 → 取消写入
        if (STATE.aspects.has(key) && isMissing(key) && !e.shiftKey) {
          fillOne(key);
          return;
        }
        toggleAspect(key);
      });
    });

    // ---- 全选/全不选
    panel.querySelector('[data-act="all-aspect"]').addEventListener('click', () => toggleAllAspects());

    // ---- 写入方式
    panel.querySelectorAll('[data-strategy]').forEach(btn => {
      btn.addEventListener('click', () => setStrategy(btn.dataset.strategy));
    });

    // ---- 画面分析开关
    panel.querySelector('.lsac-scene').addEventListener('change', (e) => {
      STATE.scene = e.target.checked;
      savePrefs();
      info(STATE.scene
        ? '<span style="color:#57606a">已开启画面分析：会读原图像素判断空旷侧 / 朝向 / 地平线。</span>'
        : '<span class="lsac-warn">已关闭画面分析：三分法将失去方向依据，多数情况会退回居中。</span>', true);
      scheduleAutoPreview();
    });

    // ---- 多构图开关
    panel.querySelector('.lsac-multi').addEventListener('change', (e) => {
      STATE.multi = e.target.checked;
      STATE.pick = {};
      savePrefs();
      info(STATE.multi
        ? '<span style="color:#57606a">已开启多构图：每个比例给出最多 3 个方案，挑一个再写入。</span>'
        : '<span style="color:#57606a">已关闭多构图：每个比例只给 1 个最推荐的框。</span>', true);
      scheduleAutoPreview();
    });

    // ---- 实时预览开关
    panel.querySelector('.lsac-auto').addEventListener('change', (e) => {
      STATE.autoPreview = e.target.checked;
      savePrefs();
      if (STATE.autoPreview) {
        scheduleAutoPreview(0);
      } else {
        if (STATE.previewTimer) clearTimeout(STATE.previewTimer);
        STATE.previewTimer = 0;
        STATE.previewRevision++;
        clearPreview();
      }
    });

    panel.querySelector('[data-act="preview"]').addEventListener('click', () => run('preview'));
    panel.querySelector('[data-act="apply"]').addEventListener('click', () => run('apply'));
    panel.querySelector('[data-act="undo"]').addEventListener('click', doUndo);
    panel.querySelector('[data-act="selected-subjects"]').addEventListener('click', () => {
      refreshSubjects();
      const ids = LS.selectedSubjectIds();
      if (!ids.length) return info('<span class="lsac-warn">请先在画布选中主体框，再点此按钮。</span>', false);
      STATE.subjectIds = new Set(ids);
      subjectSelectionChanged();
    });
    panel.querySelector('[data-act="all-subjects"]').addEventListener('click', () => {
      refreshSubjects();
      STATE.subjectIds = new Set(LS.subjectEntries().map(s => s.id));
      subjectSelectionChanged();
    });
    panel.querySelector('.lsac-subjects').addEventListener('change', e => {
      const id = e.target.dataset.subjectId;
      if (id == null) return;
      if (e.target.checked) STATE.subjectIds.add(id);
      else STATE.subjectIds.delete(id);
      subjectSelectionChanged();
    });

    // ---- 多构图方案切换（事件委托：方案按钮是动态渲染的）
    panel.addEventListener('click', (e) => {
      const btn = e.target.closest && e.target.closest('.lsac-var');
      if (!btn || !panel.contains(btn)) return;
      if (STATE.busy) return;
      e.preventDefault();
      e.stopPropagation();
      const name = btn.dataset.var;
      const idx = parseInt(btn.dataset.idx, 10) || 0;
      STATE.pick[name] = idx;
      // 只切当前方案：重新渲染 + 只更新预览层，不写标注
      const last = STATE.last;
      if (!last || !last.plan) return;
      last.plan.crops.forEach(c => {
        if (c.fromName !== name) return;
        const vs = c.variants || [];
        if (vs[idx]) c.chosen = vs[idx];
      });
      last.willWrite = last.plan.crops.filter(c => !c.skipped);
      renderPlan(last.plan, last.willWrite, true);
      highlightPreview(last.willWrite);
    });

    // ---- 拖动 / 调整窗口大小
    enableDrag(panel);
    enableResize(panel);
    enableScroll(panel);

    // ---- 恢复上次状态
    panel.querySelector('.lsac-scene').checked = STATE.scene;
    panel.querySelector('.lsac-multi').checked = STATE.multi;
    panel.querySelector('.lsac-auto').checked = STATE.autoPreview;
    syncStrategy();
    syncMode();
    syncAspects();
    setCollapsed(STATE.collapsed, true);
    applyPos();
    applyPanelSize(STATE.panelSize, true);
    const resizeViewport = () => {
      if (STATE.hidden) return;
      applyPanelSize(STATE.panelSize, true);
      rememberPanelPos();
      savePrefs();
    };
    window.addEventListener('resize', resizeViewport, { passive: true });
    if (window.visualViewport) window.visualViewport.addEventListener('resize', resizeViewport, { passive: true });

    // ---- 快捷键（输入框内不触发）
    document.addEventListener('keydown', handleHotkey, true);

    return panel;
  }

  /** 输入框 / 富文本里打字时不抢键 */
  function isTyping(el) {
    if (!el) return false;
    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
    if (el.isContentEditable) return true;
    return !!(el.closest && el.closest('[contenteditable="true"],.lsf-textarea,input,textarea'));
  }

  function handleHotkey(e) {
    if (!panel || STATE.hidden) return;
    if (e.ctrlKey && e.shiftKey && (e.key === 'L' || e.key === 'l')) {
      e.preventDefault();
      setHidden(!STATE.hidden);
      return;
    }
    if (isTyping(e.target) || (e.target.closest && e.target.closest('[role="scrollbar"]'))) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    const key = String(e.key || '');
    if (key === 'Escape') {
      if (STATE.previewLayer) {
        clearPreview();
        info('<span style="color:#57606a">已清除预览</span>', true);
      }
      return;
    }
    if (key === 'Enter') {
      e.preventDefault();
      run('apply');
      return;
    }
    if (key === 'z' || key === 'Z') { e.preventDefault(); doUndo(); return; }
    if (key === 'p' || key === 'P') { e.preventDefault(); run('preview'); return; }
    if (key === 'a' || key === 'A') { e.preventDefault(); toggleAllAspects(); return; }
    if (key === 'm' || key === 'M') {
      e.preventDefault();
      STATE.multi = !STATE.multi;
      const box = panel.querySelector('.lsac-multi');
      if (box) box.checked = STATE.multi;
      savePrefs();
      scheduleAutoPreview();
      return;
    }
    if (/^[1-5]$/.test(key)) {
      const def = ASPECT_DEFS[Number(key) - 1];
      if (!def) return;
      e.preventDefault();
      if (STATE.aspects.has(def.key) && isMissing(def.key)) fillOne(def.key);
      else toggleAspect(def.key);
    }
  }

  let panel = null;
  let syncPanelScroll = () => {};

  /** 同步构图方式按钮的选中态 */
  function syncMode() {
    if (!panel) return;
    panel.querySelectorAll('.lsac-chip.mode').forEach(b => {
      b.classList.toggle('on', b.dataset.mode === STATE.mode);
    });
  }

  /** 同步比例按钮的三态：绿=已有、红=缺（可点补）、灰=本次不写 */
  function syncAspects() {
    if (!panel) return;
    const comp = STATE.completeness || { byKey: {}, byName: {}, missing: ASPECT_DEFS.map(a => a.key) };
    const byKey = comp.byKey || {};
    const missing = new Set(comp.missing || []);
    panel.querySelectorAll('.lsac-chip.aspect').forEach(btn => {
      const key = btn.dataset.aspect;
      const isMiss = missing.has(key);
      const has = (byKey[key] | 0) > 0;
      btn.classList.toggle('has', has && !isMiss);
      btn.classList.toggle('miss', isMiss);
      btn.classList.toggle('off', !STATE.aspects.has(key));
      btn.classList.toggle('on', STATE.aspects.has(key) && !isMiss);
      const def = ASPECT_DEFS.find(a => a.key === key);
      const n = def ? ((comp.byName || {})[def.name] | 0) : 0;
      const cnt = btn.querySelector('.n');
      if (cnt) cnt.textContent = n > 1 ? n + '个' : '';
      const scope = LS.subjectEntries().length ? '当前主体' : '当前图片';
      btn.title = isMiss
        ? ((comp.otherByKey || {})[key] ? '其他主体已有此比例，当前主体仍缺 · 点一下补一个' : scope + '缺这个比例 · 点一下补一个')
        : scope + '已到位 · 点一下切换是否写入';
    });
    syncCompletenessUI(comp);
    const all = STATE.aspects.size === ASPECT_DEFS.length;
    const r = panel.querySelector('[data-act="all-aspect"]');
    if (r) r.textContent = all ? '全不选' : '全选';
  }

  /** 标题行的齐全度摘要 / 徽标 / 折叠条文案 */
  function syncCompletenessUI(comp) {
    if (!panel) return;
    const c = comp || STATE.completeness;
    const missingKeys = c ? (c.missing || []) : ASPECT_DEFS.map(a => a.key);
    const total = ASPECT_DEFS.length;
    const covered = c ? (c.covered | 0) : 0;
    const sum = missingKeys.length ? `缺 ${missingKeys.length} · 已齐 ${covered}/${total}` : `已齐 ${total}/${total}`;
    const sumEl = panel.querySelector('[data-sum]');
    if (sumEl) sumEl.textContent = sum;
    const scope = panel.querySelector('[data-subject-scope]');
    const entries = LS.subjectEntries();
    if (scope) {
      const subjects = entries.filter(s => STATE.subjectIds.has(s.id));
      scope.textContent = subjects.length > 1
        ? `当前：主体 ${subjects.map(s => s.index).join('、')}（按一组检查）`
        : subjects.length ? `当前：主体 ${subjects[0].index} · 只统计此主体的比例`
        : entries.length ? '请先选择构图主体' : referenceLabel(referenceContext().source);
    }
    const badge = panel.querySelector('[data-badge]');
    if (badge) {
      badge.textContent = missingKeys.length ? `缺 ${missingKeys.length}` : '齐';
      badge.classList.toggle('ok', !missingKeys.length);
      badge.title = missingKeys.length
        ? '缺 ' + missingKeys.map(k => (ASPECT_DEFS.find(a => a.key === k) || {}).label).join(' ')
        : (entries.length ? '当前主体' : '当前图片') + '的五个比例都已存在';
    }
    const mini = panel.querySelector('[data-mini]');
    if (mini) {
      const plan = STATE.last && STATE.last.plan;
      const modeKey = !entries.length ? 'center' : STATE.mode === 'auto' ? ((plan && plan.autoMode) || 'auto') : STATE.mode;
      mini.textContent = `${missingKeys.length ? '缺 ' + missingKeys.length : '已齐'} · ${modeName(modeKey)}`;
    }
  }

  function isMissing(key) {
    const c = STATE.completeness;
    if (!c) return true;
    return (c.missing || []).indexOf(key) >= 0;
  }

  function toggleAspect(key) {
    if (STATE.aspects.has(key)) {
      STATE.aspects.delete(key);
    } else {
      STATE.aspects.add(key);
    }
    syncAspects();
    savePrefs();
    scheduleAutoPreview();
  }

  /** 右键：只写这一个比例 */
  function soloAspect(key) {
    STATE.aspects = new Set([key]);
    syncAspects();
    savePrefs();
    scheduleAutoPreview(0);
  }

  function toggleAllAspects() {
    const all = STATE.aspects.size === ASPECT_DEFS.length;
    // 「全不选」就是真的一个都不写：想补哪个比例直接点那个格子即可
    STATE.aspects = new Set(all ? [] : ASPECT_DEFS.map(a => a.key));
    syncAspects();
    savePrefs();
    scheduleAutoPreview(0);
  }

  function setStrategy(key) {
    if (!STRATEGIES.some(s => s.key === key)) return;
    STATE.strategy = key;
    STATE.replace = key === 'replace';
    STATE.last = null;          // 换了写入方式，旧预览的结论作废
    syncStrategy();
    savePrefs();
    scheduleAutoPreview();
  }

  function syncStrategy() {
    if (!panel) return;
    const cur = STATE.replace ? 'replace' : STATE.strategy;
    panel.querySelectorAll('[data-strategy]').forEach(b => b.classList.toggle('on', b.dataset.strategy === cur));
  }

  /** 改任何设置后自动重算预览（关掉实时预览就什么都不做） */
  function scheduleAutoPreview(delay) {
    if (!STATE.autoPreview || STATE.hidden) return;
    if (STATE.previewTimer) clearTimeout(STATE.previewTimer);
    STATE.previewTimer = setTimeout(() => {
      STATE.previewTimer = 0;
      if (!STATE.autoPreview || STATE.busy) return;
      run('preview', { auto: true });
    }, delay == null ? 320 : delay);
  }

  /** 点红色比例格 = 只补这一个比例，立刻写入 */
  async function fillOne(key) {
    if (!ASPECT_DEFS.some(a => a.key === key)) return;
    const entries = refreshSubjects();
    if (entries.length && !STATE.subjectIds.size) {
      info('<span class="lsac-warn">先在上面的「构图主体」里勾选主体，才能补比例</span>', false);
      return;
    }
    await run('apply', { only: key, strategy: 'fill' });
  }

  /** 刷新比例齐全度 + 每个比例已有的框数 */
  function refreshCounts(manual) {
    if (!panel) return;
    refreshSubjects();
    const an = LS.annotation();
    if (!an) return;
    if (!LS.subjectEntries(an).length) referenceContext(an);
    STATE.added = STATE.added.filter(item => {
      try { return LS.regionList(an).indexOf(item.region) >= 0; } catch (e) { return false; }
    });
    const addedSignature = STATE.added.map(({ region: r }) => [r.id, r.x, r.y, r.width, r.height].join(':')).join('|');
    if (STATE.previewAdded && STATE.addedSignature !== addedSignature) {
      highlightPreview(STATE.added.map(({ crop, region: r }) => ({
        label: crop.label, fromName: crop.fromName,
        box: { x: num(r.x), y: num(r.y), w: num(r.width), h: num(r.height) }
      })), { added: true });
    }
    STATE.addedSignature = addedSignature;
    const addedNames = new Set(STATE.added.map(item => item.crop.fromName));

    const comp = assessCompleteness(an);
    STATE.completeness = comp;
    syncAspects();

    ASPECT_DEFS.forEach(a => {
      const chip = panel.querySelector(`[data-aspect="${a.key}"]`);
      if (chip) chip.classList.toggle('lsac-added', addedNames.has(a.name));
    });
    syncAddedSummary(addedNames);
    syncWrittenRows();

    if (manual) {
      const scope = LS.subjectEntries(an).length ? '当前主体' : '当前图片';
      info('<span style="color:#57606a">已刷新：' +
        (comp.missing.length ? scope + '缺 ' + comp.missing.length + ' 个比例' : scope + '的五个比例都已存在') +
        (comp.source === 'outliner' ? '（按右侧列表的标签读的）' : '') + '</span>', true);
    }
    return comp.total > 0;
  }

  function syncAddedSummary(addedNames) {
    if (!panel) return;
    const summary = panel.querySelector('[data-added-summary]');
    if (!summary) return;
    const labels = ASPECT_DEFS.filter(a => addedNames && addedNames.has(a.name)).map(a => a.label);
    summary.textContent = labels.length ? `本次新增：${labels.join('、')}` : '';
    summary.title = labels.length ? `本次新写入：${labels.join('、')}` : '';
  }

  function taskId() {
    return window.Htx && window.Htx.task && window.Htx.task.id;
  }

  function subjectSignature(annot) {
    return LS.subjectEntries(annot).map(s => [s.id, s.x, s.y, s.w, s.h].join(':')).join('|');
  }

  function referenceLabel(source) {
    return source === 'selected' ? '按已选中的比例框居中'
      : source === 'existing' ? '按已有比例框共同中心补齐' : '整图居中';
  }

  function nativeReferenceSelection(annot) {
    return LS.selectedRegionIds(annot).sort().join('|');
  }

  /** 锁定参考区域的身份，移动时读新坐标；自动选中新框不改变用户的原参考。 */
  function referenceContext(annot) {
    const an = annot || LS.annotation();
    const seen = new Set();
    const crops = ASPECT_DEFS.flatMap(a => LS.readRegions(a.name, an)).filter(r => {
      if (!r.region || seen.has(r.region) || ![r.x, r.y, r.w, r.h].every(Number.isFinite) ||
          !(r.w > 0 && r.h > 0) || r.x < 0 || r.y < 0 || r.x + r.w > 100.001 || r.y + r.h > 100.001) return false;
      seen.add(r.region);
      return true;
    });
    const idOf = r => String(r.region.id);
    const native = nativeReferenceSelection(an);
    const selectedIds = new Set(LS.selectedRegionIds(an));
    const selected = crops.filter(r => selectedIds.has(idOf(r)));
    const manual = crops.filter(r => !STATE.referenceGeneratedIds.has(idOf(r)));
    const previous = STATE.referenceContext;
    let source = previous ? previous.source : 'image';
    let refs = previous ? crops.filter(r => previous.ids.has(idOf(r))) : [];
    if ((!previous || previous.native !== native) && selected.length) {
      source = 'selected'; refs = selected;
    } else if (!previous || previous.native !== native || source !== 'selected' || !refs.length) {
      refs = manual;
      source = refs.length ? 'existing' : 'image';
    }
    const signature = source + ':' + refs.map(r => [idOf(r), r.x, r.y, r.w, r.h].join(':')).sort().join('|');
    const current = { ids: new Set(refs.map(idOf)), source, native, signature, references: refs };
    STATE.referenceContext = current;
    if (previous && previous.signature !== signature && !STATE.busy) {
      STATE.last = null;
      STATE.pick = {};
      clearPreview();
      scheduleAutoPreview(120);
    }
    return current;
  }

  function resetReference() {
    STATE.referenceContext = null;
    STATE.referenceGeneratedIds.clear();
  }

  function refreshSubjects() {
    const an = LS.annotation();
    if (STATE.annotation !== an || STATE.taskId !== taskId()) {
      STATE.annotation = an;
      STATE.taskId = taskId();
      STATE.subjectSignature = null;
      STATE.subjectIds.clear();
      STATE.subjectKnown.clear();
      STATE.last = null;
      STATE.undo = null;
      STATE.undoStack = [];
      clearAddedHighlights();
      STATE.subjectBindings.clear();
      resetReference();
      STATE.pick = {};
      clearPreview();
    }
    const entries = LS.subjectEntries(an);
    const signature = subjectSignature(an);
    if (STATE.subjectSignature !== signature) {
      resetReference();
      const initial = STATE.subjectSignature === null;
      if (STATE.subjectSignature !== null) { clearPreview(); STATE.last = null; }
      const available = new Set(entries.map(s => s.id));
      STATE.subjectIds = new Set([...STATE.subjectIds].filter(id => available.has(id)));
      entries.forEach(s => { if (!STATE.subjectKnown.has(s.id)) STATE.subjectIds.add(s.id); });
      if (initial) {
        const selected = LS.selectedSubjectIds(an);
        if (selected.length) STATE.subjectIds = new Set(selected);
      }
      STATE.subjectKnown = available;
      STATE.subjectSignature = signature;
      renderSubjects(entries);
    }
    return entries;
  }

  function renderSubjects(entries = LS.subjectEntries()) {
    if (!panel) return;
    panel.querySelector('.lsac-subjects').innerHTML = entries.length ? entries.map(s =>
      `<label class="lsac-check"><input type="checkbox" data-subject-id="${esc(s.id)}"` +
      `${STATE.subjectIds.has(s.id) ? ' checked' : ''}${STATE.busy ? ' disabled' : ''}>` +
      `主体 ${s.index} · ${s.x + s.w / 2 < 33 ? '左侧' : s.x + s.w / 2 > 67 ? '右侧' : '中间'}` +
      ` · 中心 ${Math.round(s.x + s.w / 2)}% / ${Math.round(s.y + s.h / 2)}%</label>`
    ).join('') : '<span class="lsac-hint">无主体框：参考比例框补齐；没有框时整图居中。</span>';
    panel.querySelector('.lsac-subject-count').textContent = entries.length ? `${STATE.subjectIds.size}/${entries.length} 已选` : '参考框居中';
    panel.querySelector('.lsac-subject-actions').hidden = !entries.length;
    panel.querySelector('[data-subject-hint]').textContent = entries.length
      ? '点标注列表的主体可切换；多选按一组构图。'
      : '可先选中一个比例框，再点红色缺失比例补齐。';
  }

  function subjectSelectionChanged() {
    STATE.pick = {};
    STATE.last = null;
    clearPreview();
    clearAddedHighlights();
    // 保留输入节点，便于连续勾选和键盘操作。
    panel.querySelectorAll('[data-subject-id]').forEach(input => { input.checked = STATE.subjectIds.has(input.dataset.subjectId); });
    panel.querySelector('.lsac-subject-count').textContent = `${STATE.subjectIds.size}/${LS.subjectEntries().length} 已选`;
    refreshCounts();
    info('<span class="lsac-hint">主体选择已更新。</span>', true);
    scheduleAutoPreview(120);
  }

  function clearAddedHighlights() {
    STATE.added = [];
    STATE.addedSignature = '';
    if (panel) panel.querySelectorAll('.lsac-added').forEach(el => el.classList.remove('lsac-added'));
    syncAddedSummary(new Set());
    clearWrittenHighlights();
  }

  function selectedSubjects(annot) {
    return LS.subjectEntries(annot).filter(s => STATE.subjectIds.has(s.id));
  }

  /** 按主体归属判断，不要求全身完整入框；正常横幅和特写也应算已有。 */
  function matchesSubjects(crop, subjects) {
    if (!(crop.w > 0 && crop.h > 0) || !subjects.length) return false;
    const binding = crop.region && STATE.subjectBindings.get(String(crop.region.id));
    // 自动生成的极窄组图可能装不下两人，按真实写入时的主体关联去重。
    // 框或主体被手动移动后，关联失效，重新按当前位置判断。
    if (binding && sameFraming(crop, binding.box) &&
        binding.subjects.every(s => {
          const current = LS.subjectEntries().find(entry => entry.id === s.id);
          return current && sameFraming(current, s);
        })) {
      return subjects.every(s => binding.subjects.some(bound => bound.id === s.id));
    }
    return subjects.every(s => {
      if (!(s.w > 0 && s.h > 0)) return false;
      const w = Math.max(0, Math.min(crop.x + crop.w, s.x + s.w) - Math.max(crop.x, s.x));
      const h = Math.max(0, Math.min(crop.y + crop.h, s.y + s.h) - Math.max(crop.y, s.y));
      if (w < Math.min(crop.w, s.w) * 0.5 || h < Math.min(crop.h, s.h) * 0.35) return false;
      return w * h / (s.w * s.h) >= 0.25 || w * h / (crop.w * crop.h) >= 0.5;
    });
  }

  /** 缺失展示、补齐去重和覆盖范围共同使用这个主体筛选，避免彼此矛盾。 */
  function regionsForSubjects(controlName, annot) {
    if (!LS.subjectEntries(annot).length) return LS.readRegions(controlName, annot);
    const subjects = selectedSubjects(annot);
    return LS.readRegions(controlName, annot).filter(crop => matchesSubjects(crop, subjects));
  }

  /** 有主体时只统计当前所选主体；无主体时保留原生列表的整体计数兜底。 */
  function assessCompleteness(annot) {
    const an = annot || LS.annotation();
    const base = LS.completeness(an);
    if (!an) return base;

    const subjects = selectedSubjects(an);
    if (!subjects.length) return { ...base, subjectAware: false };
    const byKey = {}, byName = {}, otherByKey = {}, missing = [], uncovered = [];
    ASPECT_DEFS.forEach(a => {
      const regions = LS.readRegions(a.name, an);
      const matches = regionsForSubjects(a.name, an);
      byKey[a.key] = byName[a.name] = matches.length;
      otherByKey[a.key] = regions.length - matches.length;
      if (!byKey[a.key]) missing.push(a.key);
      if (regions.length && !matches.length) uncovered.push(a.key);
    });

    return {
      ...base, byKey, byName, otherByKey, missing, uncovered,
      covered: ASPECT_DEFS.length - missing.length,
      total: ASPECT_DEFS.reduce((n, a) => n + byKey[a.key], 0),
      subjectAware: true
    };
  }

  // 极窄画幅或特写可能装不下完整主体，也不能重复追加同一个构图。
  function sameFraming(a, b) {
    return ['x', 'y', 'w', 'h'].every(k => Math.abs(a[k] - b[k]) <= 0.15);
  }

  function setCollapsed(v, silent) {
    STATE.collapsed = !!v;
    if (!panel) return;
    panel.classList.toggle('collapsed', STATE.collapsed);
    const btn = panel.querySelector('[data-act="collapse"]');
    if (btn) btn.textContent = STATE.collapsed ? '+' : '−';
    syncCompletenessUI();
    applyPanelSize(STATE.panelSize, true);
    if (!silent) { rememberPanelPos(); savePrefs(); }
  }

  function setHidden(v) {
    STATE.hidden = !!v;
    if (!panel) return;
    panel.style.display = STATE.hidden ? 'none' : 'flex';
    const t = document.querySelector('.lsac-toggle');
    if (t) t.classList.toggle('show', STATE.hidden);
    if (!STATE.hidden) {
      applyPanelSize(STATE.panelSize, true);
      refreshCounts();
      scheduleAutoPreview(150);
    }
  }

  function applyPos() {
    if (!panel) return;
    if (STATE.pos) {
      panel.style.left = STATE.pos.left + 'px';
      panel.style.top = STATE.pos.top + 'px';
      panel.style.right = 'auto';
    }
    clampPanelIntoView();
  }

  /** 可用视口：浏览器改窗口大小或缩放后都重新读取。 */
  function panelViewport() {
    const vv = window.visualViewport;
    const left = ((vv && vv.offsetLeft) || 0) + 6;
    const top = ((vv && vv.offsetTop) || 0) + 6;
    return { left, top, width: Math.max(1, ((vv && vv.width) || innerWidth) - 12),
      height: Math.max(1, ((vv && vv.height) || innerHeight) - 12) };
  }

  function rememberPanelPos() {
    if (!panel || STATE.hidden) return;
    const r = panel.getBoundingClientRect();
    STATE.pos = { left: Math.round(r.left), top: Math.round(r.top) };
  }

  /** 按整个面板的实际尺寸夹回屏幕，底部按钮和滚动轴也必须可见。 */
  function clampPanelIntoView() {
    if (!panel || STATE.hidden) return;
    const r = panel.getBoundingClientRect(), view = panelViewport();
    const left = Math.max(view.left, Math.min(r.left, view.left + view.width - r.width));
    const top = Math.max(view.top, Math.min(r.top, view.top + view.height - r.height));
    panel.style.right = 'auto';
    panel.style.left = left + 'px';
    panel.style.top = top + 'px';
  }

  /** 窗口尺寸与文字大小分离；屏幕临时缩小时保留用户原来的尺寸偏好。 */
  function applyPanelSize(size, silent) {
    const width = Number(size && size.width), height = Number(size && size.height);
    STATE.panelSize = {
      width: Math.max(240, Math.round(Number.isFinite(width) && width > 0 ? width : 276)),
      height: Math.max(220, Math.round(Number.isFinite(height) && height > 0 ? height : 360))
    };
    if (!panel) return;
    const view = panelViewport();
    panel.style.width = Math.min(view.width, STATE.collapsed ? 236 : STATE.panelSize.width) + 'px';
    panel.style.height = STATE.collapsed ? 'auto' : Math.min(view.height, STATE.panelSize.height) + 'px';
    panel.style.maxWidth = view.width + 'px';
    panel.style.maxHeight = view.height + 'px';
    clampPanelIntoView();
    syncPanelScroll();
    if (!silent) { rememberPanelPos(); savePrefs(); }
  }

  /** 常显滚动轴：窗口改变尺寸后同步滑块，内容增多时不撑高窗口。 */
  function enableScroll(el) {
    const body = el.querySelector('.lsac-body');
    const rail = el.querySelector('.lsac-scrollbar');
    const thumb = el.querySelector('.lsac-scroll-thumb');
    let thumbHeight = 0, frame = 0, drag = null;
    function sync() {
      const max = Math.max(0, body.scrollHeight - body.clientHeight);
      const height = rail.clientHeight;
      thumbHeight = Math.min(height, Math.max(28, height * body.clientHeight / Math.max(1, body.scrollHeight)));
      thumb.style.height = thumbHeight + 'px';
      thumb.style.transform = 'translateY(' + (max ? body.scrollTop / max * (height - thumbHeight) : 0) + 'px)';
      rail.classList.toggle('disabled', max < 1);
      rail.setAttribute('aria-disabled', String(max < 1));
      rail.setAttribute('aria-valuemax', String(Math.round(max)));
      rail.setAttribute('aria-valuenow', String(Math.round(body.scrollTop)));
      rail.tabIndex = max < 1 ? -1 : 0;
    }
    function schedule() {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        // 预览结果或主体列表变高时，面板也需要重新贴合视口。
        clampPanelIntoView();
        sync();
      });
    }
    syncPanelScroll = sync;
    body.addEventListener('scroll', sync, { passive: true });
    body.addEventListener('toggle', schedule, true);
    el.addEventListener('wheel', e => {
      e.stopPropagation();
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        return;
      }
      if (!body.contains(e.target)) {
        e.preventDefault();
        const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? body.clientHeight : 1;
        body.scrollTop += e.deltaY * unit;
      }
    }, { passive: false });
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(schedule);
      observer.observe(body);
      observer.observe(rail);
    }
    new MutationObserver(schedule).observe(body, { childList: true, subtree: true, characterData: true });
    rail.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      sync();
      const max = Math.max(0, body.scrollHeight - body.clientHeight);
      const rect = rail.getBoundingClientRect();
      const travel = rail.clientHeight - thumbHeight;
      if (max < 1 || travel <= 0 || rect.height <= 0) return;
      const unit = rail.clientHeight / rect.height;
      if (!thumb.contains(e.target)) {
        body.scrollTop = ((e.clientY - rect.top) * unit - thumbHeight / 2) / travel * max;
      }
      drag = { id: e.pointerId, y: e.clientY, scroll: body.scrollTop, ratio: unit * max / travel };
      rail.classList.add('dragging');
      rail.setPointerCapture(e.pointerId);
    });
    rail.addEventListener('pointermove', e => {
      if (!drag || e.pointerId !== drag.id) return;
      e.preventDefault();
      body.scrollTop = drag.scroll + (e.clientY - drag.y) * drag.ratio;
    });
    const stop = () => { drag = null; rail.classList.remove('dragging'); };
    rail.addEventListener('pointerup', stop);
    rail.addEventListener('pointercancel', stop);
    rail.addEventListener('lostpointercapture', stop);
    rail.addEventListener('keydown', e => {
      let value = body.scrollTop;
      if (e.key === 'ArrowDown') value += 40;
      else if (e.key === 'ArrowUp') value -= 40;
      else if (e.key === 'PageDown') value += body.clientHeight * 0.9;
      else if (e.key === 'PageUp') value -= body.clientHeight * 0.9;
      else if (e.key === 'Home') value = 0;
      else if (e.key === 'End') value = body.scrollHeight;
      else return;
      e.preventDefault();
      e.stopPropagation();
      body.scrollTop = value;
    });
    schedule();
  }

  function enableResize(el) {
    const grip = el.querySelector('.lsac-grip');
    let drag = null;
    grip.addEventListener('pointerdown', e => {
      if (e.button !== 0 || STATE.collapsed) return;
      const r = el.getBoundingClientRect();
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY,
        left: r.left, top: r.top, width: r.width, height: r.height };
      el.style.left = r.left + 'px';
      el.style.top = r.top + 'px';
      el.style.right = 'auto';
      grip.setPointerCapture(e.pointerId);
      e.preventDefault();
      e.stopPropagation();
    });
    grip.addEventListener('pointermove', e => {
      if (!drag || drag.id !== e.pointerId) return;
      const view = panelViewport();
      const maxWidth = Math.max(1, view.left + view.width - drag.left);
      const maxHeight = Math.max(1, view.top + view.height - drag.top);
      // 两个方向独立变化：只往上拖就变矮，字号和按钮不会跟着变大或变小。
      applyPanelSize({
        width: Math.min(maxWidth, Math.max(240, drag.width + e.clientX - drag.x)),
        height: Math.min(maxHeight, Math.max(220, drag.height + e.clientY - drag.y))
      }, true);
    });
    const stop = () => {
      if (!drag) return;
      drag = null;
      rememberPanelPos();
      savePrefs();
    };
    grip.addEventListener('pointerup', stop);
    grip.addEventListener('pointercancel', stop);
    grip.addEventListener('lostpointercapture', stop);
  }

  function enableDrag(el) {
    const head = el.querySelector('.lsac-head');
    let drag = null;
    head.addEventListener('pointerdown', e => {
      if (e.button !== 0 || e.target.closest('button,input,select,a')) return;
      const r = el.getBoundingClientRect();
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, left: r.left, top: r.top };
      el.style.left = r.left + 'px';
      el.style.top = r.top + 'px';
      el.style.right = 'auto';
      head.setPointerCapture(e.pointerId);
      e.preventDefault();
      e.stopPropagation();
    });
    head.addEventListener('pointermove', e => {
      if (!drag || drag.id !== e.pointerId) return;
      el.style.left = drag.left + e.clientX - drag.x + 'px';
      el.style.top = drag.top + e.clientY - drag.y + 'px';
      clampPanelIntoView();
    });
    const stop = () => {
      if (!drag) return;
      drag = null;
      const r = el.getBoundingClientRect(), view = panelViewport(), snap = 28;
      if (r.left - view.left < snap) el.style.left = view.left + 'px';
      else if (view.left + view.width - r.right < snap) el.style.left = view.left + view.width - r.width + 'px';
      if (r.top - view.top < snap) el.style.top = view.top + 'px';
      else if (view.top + view.height - r.bottom < snap) el.style.top = view.top + view.height - r.height + 'px';
      clampPanelIntoView();
      rememberPanelPos();
      savePrefs();
    };
    head.addEventListener('pointerup', stop);
    head.addEventListener('pointercancel', stop);
    head.addEventListener('lostpointercapture', stop);
  }


  function setBusy(b) {
    STATE.busy = b;
    if (!panel) return;
    panel.querySelectorAll('button, input').forEach(btn => {
      if (['hide', 'collapse'].includes(btn.dataset.act) || btn.classList.contains('lsac-auto')) return;
      btn.disabled = b;
    });
  }

  function info(html, ok) {
    if (!panel) return;
    const box = panel.querySelector('.lsac-info');
    box.innerHTML = html || '';
    const dot = panel.querySelector('.lsac-dot');
    dot.className = 'lsac-dot' + (ok === false ? ' err' : ok === true ? '' : ' warn');
    // 报错时自动展开，免得用户以为没反应
    if (ok === false && STATE.collapsed) setCollapsed(false, true);
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function modeName(m) {
    return (ComposeCore.MODE_LABEL && ComposeCore.MODE_LABEL[m]) ||
      ({ center: '居中', thirds: '三分法', golden: '黄金分割', tight: '大特写', sky: '低地平线', road: '道路引导' })[m] || m;
  }

  /* ===================================================================
   *  4. 主流程
   * =================================================================== */

  async function run(action, opts) {
    if (STATE.busy) return;
    const options = opts || {};
    // 写入方式：显式传入 > 上一次预览时用的 > 当前设置。
    // 关键点：预览里显示「覆盖同比例」，回车写入就必须也是覆盖，
    // 否则用户看到的和真正发生的不是一回事。
    let strategy = options.strategy;
    if (!strategy && action !== 'supplement' && STATE.last && STATE.last.plan) {
      strategy = STATE.last.plan.strategy;
    }
    if (!strategy) {
      strategy = action === 'supplement' ? 'fill' : (STATE.replace ? 'replace' : STATE.strategy);
    }
    if (!strategy) strategy = 'fill';
    const only = options.only || null;
    const auto = !!options.auto;
    const previewRevision = STATE.previewRevision;
    setBusy(true);
    try {
      const entries = refreshSubjects();
      const annot = LS.annotation();
      if (!annot) throw new Error('没有找到当前标注');
      const originalTaskId = taskId();
      const signature = subjectSignature(annot);
      const selection = [...STATE.subjectIds].sort().join('|');
      const isPreview = action !== 'apply';

      // 原图尺寸
      const size = LS.imageSize();

      // 主体框
      const subjects = entries.filter(s => STATE.subjectIds.has(s.id)).map(s => ({ x: s.x, y: s.y, w: s.w, h: s.h }));
      if (entries.length && !subjects.length) throw new Error('请至少选择一个主体，再预览或写入');
      const reference = entries.length ? null : referenceContext(annot);

      // 勾选的比例（only 时只算那一个）
      // only（点红格补一个）优先于勾选：那个比例没被勾也能补
      const aspects = only
        ? ASPECT_DEFS.filter(a => a.key === only)
        : ASPECT_DEFS.filter(a => STATE.aspects.has(a.key));
      if (!aspects.length) throw new Error('还没有选要写的比例：点一下红色格子就能补这一个');

      // 画面证据（像素分析）：决定三分法是否有方向依据、头部位置、地平线
      let scene = null;
      let sceneErr = null;
      if (STATE.scene && !reference) {
        if (!auto) info('<span style="color:#57606a">正在分析画面…</span>');
        try {
          const img = await LS.imageData(320);
          if (img && window.SceneAnalyze) {
            const bbox = ComposeCore.mergeSubjects(subjects);
            scene = SceneAnalyze.analyze(img, bbox);
            if (!scene.ok) sceneErr = '画面分析无有效结果';
            else if (scene.quality < 0.12) sceneErr = '画面细节太少（空景/纯色），方向证据不可靠';
          } else {
            sceneErr = window.SceneAnalyze ? '取不到原图像素' : '画面分析模块未加载';
          }
        } catch (e) {
          sceneErr = '画面分析失败：' + (e && e.message || e);
        }
      }

      // 计算中关闭过实时预览，旧结果不能再把刚清掉的框画回来。
      // 新发起的手动预览仍可在实时预览关闭时使用。
      if (isPreview && previewRevision !== STATE.previewRevision) return;

      if (LS.annotation() !== annot || taskId() !== originalTaskId) {
        refreshCounts();
        throw new Error('图片或标注已切换，本次操作已停止，请重新预览');
      }
      if (signature !== subjectSignature(annot) || selection !== [...STATE.subjectIds].sort().join('|')) {
        refreshCounts();
        throw new Error('主体框或主体选择已变化，请重新预览');
      }

      // 计算
      const plan = reference ? ComposeCore.planReferenceCrops({
        imageWidth: size.width, imageHeight: size.height,
        references: reference.references, aspects
      }) : ComposeCore.planCrops({
        imageWidth: size.width,
        imageHeight: size.height,
        subjects,
        aspects,
        mode: STATE.mode,
        scene,
        variants: STATE.multi ? 3 : 1,
      });
      if (reference) plan.referenceSource = reference.source;
      plan.sceneErr = sceneErr;
      plan.sceneUsed = !!scene;
      plan.scene = scene;
      plan.strategy = strategy;
      plan.supplement = strategy === 'fill';
      plan.subjectCount = subjects.length;
      plan.only = only;

      // 多构图：每个比例按 STATE.pick 选中的方案生效（默认第 0 个＝标准方案）
      if (STATE.multi) {
        plan.crops.forEach(c => {
          const vs = c.variants || [c];
          let idx = STATE.pick[c.fromName] | 0;
          if (idx < 0 || idx >= vs.length) idx = 0;
          STATE.pick[c.fromName] = idx;
          c.chosen = vs[idx];
          c.variantCount = vs.length;
        });
      } else {
        plan.crops.forEach(c => { c.chosen = c; c.variantCount = 1; });
      }

      // 当前已有的同比例框
      const existing = {};
      ASPECT_DEFS.forEach(a => { existing[a.name] = regionsForSubjects(a.name, annot); });

      // 去重与齐全度使用同一套主体归属判据，正常横幅和特写不要求完整覆盖。
      const willWrite = [];
      plan.crops.forEach(c => {
        const list = existing[c.fromName] || [];
        // 仅当前主体对应的框可以阻止补写；其他主体的同名比例保持原样。
        const dup = list.length > 0;
        c.duplicate = dup;
        // 只有「补齐缺失」才跳已有；「覆盖同比例」必须重写，「总是追加」照加不误
        if (strategy === 'fill' && dup) {
          c.skipped = true;
          c.skipReason = '';   // 状态列已经写「已有」，这里不再重复一遍
        } else {
          willWrite.push(c);
        }
      });

      STATE.last = { plan, willWrite, imageSize: size, annotationId: annot.id };

      // ---- 预览：渲染信息面板
      renderPlan(plan, willWrite, isPreview);

      if (isPreview) {
        highlightPreview(willWrite);
        return;
      }

      // ---- 写入
      if (!willWrite.length) {
        const scope = reference ? '当前图片' : '当前主体';
        clearPreview();
        renderPlan(plan, willWrite, false);
        info(panel.querySelector('.lsac-info').innerHTML +
          `<div class="lsac-ok" style="margin-top:6px">${only
            ? scope + '的这个比例已经有了，不需要再补'
            : scope + '的所列比例都已有框；要重写就切到「覆盖同比例」或「总是追加」'}</div>`, true);
        return;
      }

      // 写入前先清掉预览，避免和真实框重影
      clearPreview();

      const removed = [];
      const created = [];
      const otherSubjects = entries.filter(s => !STATE.subjectIds.has(s.id));
      willWrite.forEach(c => {
        try {
          const box = (c.chosen || c).box;
          const area = LS.writeCrop(c.fromName, c.label, box, annot, c.key);
          created.push({ crop: c, region: area });
          if (reference && area && area.id != null) STATE.referenceGeneratedIds.add(String(area.id));
          if (!reference && area && area.id != null) STATE.subjectBindings.set(String(area.id), {
            box: { x: num(area.x), y: num(area.y), w: num(area.width), h: num(area.height) },
            subjects: selectedSubjects(annot).map(s => ({ id: s.id, x: s.x, y: s.y, w: s.w, h: s.h }))
          });
          if (strategy === 'replace') {
            (existing[c.fromName] || []).forEach(r => {
              if (otherSubjects.some(s => matchesSubjects(r, [s]))) return;
              if (LS.removeRegion(r.region)) {
                removed.push({
                  fromName: c.fromName, label: (r.labels && r.labels[0]) || c.label,
                  box: { x: r.x, y: r.y, w: r.w, h: r.h }
                });
              }
            });
          }
        } catch (e) {
          c.writeError = String(e && e.message || e);
        }
      });

      if (created.length || removed.length) {
        const rec = { created, removed, annotation: annot, taskId: originalTaskId };
        STATE.undo = rec;
        STATE.undoStack.push(rec);
        if (STATE.undoStack.length > 5) STATE.undoStack.shift();
      }

      const failed = willWrite.filter(c => c.writeError);
      renderPlan(plan, willWrite, false, created.length, failed);
      clearAddedHighlights();
      // 只有「补齐缺失」才打橙色「新增」标记，覆盖写入不该伪装成新增
      if (strategy === 'fill') STATE.added = created;
      STATE.written = created;
      watchWrittenRows();
      if (reference) reference.native = nativeReferenceSelection(annot);
      refreshCounts();
      // 写入完把预览叠层收掉：框已经真的在标注里了，再罩一层虚线只会挡住看图。
      // 「新增」这件事由比例格上的橙色角标继续标着，不靠叠层。
      clearPreview();
      // 顺手把新框选中、右侧列表滚过去，省得用户在长列表里自己翻
      focusNewRegions(created);
      if (reference && STATE.referenceContext) STATE.referenceContext.native = nativeReferenceSelection(annot);
      // 写入后同步已有比例的跳过状态。
      syncSkippedAfterWrite(plan, created, failed);
    } catch (e) {
      if (auto) return;          // 自动预览失败不弹错，免得打字时一直闪红
      info('<span class="lsac-bad">' + esc(e && e.message || e) + '</span>', false);
    } finally {
      setBusy(false);
    }
  }

  /** 写入后按标注的真实状态回填「跳过」标记。 */
  function syncSkippedAfterWrite(plan, created, failed) {
    const an = LS.annotation();
    if (!an || !plan || !Array.isArray(plan.crops)) return;
    const strategy = plan.strategy || STATE.strategy || 'fill';
    if (strategy === 'append') return;      // 追加模式本来就每次都写，不存在跳过
    plan.crops.forEach(c => {
      if (!c || c.writeError) return;
      const has = regionsForSubjects(c.fromName, an).length > 0;
      if (strategy === 'fill' && has) {
        c.skipped = true;
        c.skipReason = '';
      }
    });
    const btn = panel && panel.querySelector('[data-act="apply"]');
    if (btn) btn.textContent = '写入';
    // 状态列也重画一次（这次「写 N 个」要按剩下的算，不是按刚写掉的算）
    const last = STATE.last;
    if (last && last.plan === plan) {
      const remaining = plan.crops.filter(c => !c.skipped && !c.writeError);
      last.willWrite = remaining;
      renderPlan(plan, remaining, false, (created || []).length, failed);
    }
  }

  function renderPlan(plan, willWrite, isPreview, createdCount, failed) {
    const lines = [];
    const strategy = plan.strategy || STATE.strategy || 'fill';
    const strategyLabel = (STRATEGIES.find(s => s.key === strategy) || {}).label || '';
    const conf = Math.round(plan.confidence * 100);
    const reference = plan.reference;
    const willWriteCount = (willWrite || []).length;

    // 第一行就是结论：构图方式 · 写入方式 · 这次会写几个
    lines.push(
      `<div class="lsac-line" style="margin-top:0">` +
      `<span><span class="m">${esc(reference ? referenceLabel(plan.referenceSource) : modeName(plan.mode))}</span>` +
      `<span style="color:#6e7781;font-size:10.5px"> · ${esc(strategyLabel)}</span></span>` +
      `<span style="color:#6e7781;font-size:10.5px">${reference ? '' : (plan.overridden ? '手动指定' : '置信度 ' + conf + '%') + ' · '}写 ${willWriteCount} 个</span></div>`
    );

    plan.crops.forEach(c => {
      const ch = c.chosen || c;
      const px = `${Math.round(ch.pixel.width)}×${Math.round(ch.pixel.height)}`;
      let status, cls;
      if (c.skipped) { status = '已有'; cls = 'lsac-ok'; }
      else if (c.writeError) { status = '失败'; cls = 'lsac-bad'; }
      else if (createdCount != null) { status = '✓'; cls = 'lsac-ok'; }
      else { status = ch.recommended ? '推荐' : '可用'; cls = ch.recommended ? 'lsac-ok' : 'lsac-warn'; }
      // 分数条：让「推荐」不再是个黑盒，能看出这个框到底比别的差在哪
      const sc = Math.round(ch.score * 100);
      const bar = reference || c.skipped || c.writeError ? '' :
        `<span class="lsac-sc" title="综合得分：头安全/主体完整度/充盈度/落点/边距">` +
        `<span class="lsac-scb"><i style="width:${sc}%"></i></span>${sc}</span>`;
      lines.push(
        `<div class="lsac-line">` +
        `<span><b>${c.label}</b> <span style="color:#6e7781">${px}</span>` +
        (c.skipped && c.skipReason ? ` <span style="color:#8c959f;font-size:10px">${esc(c.skipReason)}</span>` : '') +
        `</span>` +
        `<span style="display:flex;align-items:center;gap:5px">${bar}<span class="${cls}">${status}</span></span>` +
        `</div>`
      );

      // 多构图：每个比例给一排方案按钮，点了只切当前显示的方案（不写入）
      if (c.variantCount > 1 && !c.skipped) {
        const vs = c.variants || [];
        const cur = STATE.pick[c.fromName] | 0;
        const btns = vs.map((v, i) =>
          `<button class="lsac-var${i === cur ? ' on' : ''}" data-var="${c.fromName}" data-idx="${i}"
            title="score ${Math.round(v.score * 100)} · ${esc(v.variantTag || '')}">${
            esc(v.variantTag || ('方案 ' + (i + 1)))}</button>`).join('');
        lines.push(`<div class="lsac-vars">${btns}</div>`);
      }

      // 已经「已有」的比例不再堆警告：那是上一条框的说明，不是这次要处理的问题
      const warns = c.skipped ? [] :
        ((ch.warnings && ch.warnings.length ? ch.warnings : c.warnings) || []);
      if (warns.length) {
        lines.push(`<div style="color:#9a6700;font-size:10px;padding-left:2px">⚠ ${esc(warns.join('；'))}</div>`);
      }
    });

    // 主体与画面证据折叠起来：默认只占两行，需要核对时再展开
    const more = [];
    const s = plan.subject;
    if (s) {
      const cxPct = s.x + s.w / 2, cyPct = s.y + s.h / 2;
      const areaPct = (s.w * s.h) / 100;
      more.push(
        `<div class="lsac-sub">` +
        `<div class="r1"><span class="lsac-subk">主体</span>` +
        `${Math.round(s.w * plan.image.width / 100)}×${Math.round(s.h * plan.image.height / 100)}px</div>` +
        `<div class="lsac-subm">中心 ${cxPct.toFixed(1)}% / ${cyPct.toFixed(1)}%` +
        `　占画幅 ${areaPct.toFixed(1)}%</div></div>`
      );
    }
    if (reference) {
      more.push(`<div class="lsac-hint">参考中心 ${(reference.x + reference.w / 2).toFixed(1)}% / ${(reference.y + reference.h / 2).toFixed(1)}%` +
        ` · ${reference.count ? reference.count + ' 个参考框' : '整张图片'}</div>`);
    }
    const why = plan.reasons.join('；');
    if (why) {
      more.push(`<div style="color:#6e7781;font-size:10.5px">` +
        (plan.overridden ? `自动判断依据：${esc(why)}` : esc(why)) + `</div>`);
    }
    const ev = plan.evidence || {};
    const evParts = [];
    if (plan.roomSide === 'left') evParts.push('留白在左');
    if (plan.roomSide === 'right') evParts.push('留白在右');
    if (ev.facing && ev.facing.side && ev.facing.side !== 'none') {
      evParts.push('朝向' + (ev.facing.side === 'right' ? '右' : '左'));
    }
    if (plan.horizonY != null && plan.skyRatio >= 0.15) {
      evParts.push('地平线 ' + Math.round(plan.horizonY * 100) + '%');
    }
    if (ev.vanishing) {
      evParts.push('道路灭点 ' + Math.round(ev.vanishing.x * 100) + '%/' + Math.round(ev.vanishing.y * 100) + '%');
    }
    if (ev.featureScore > 0.35) evParts.push('显著景物 ' + Math.round(ev.featureScore * 100) + '%');
    if (ev.headConf > 0.3) evParts.push('已定位头部 ' + Math.round(ev.headConf * 100) + '%');
    if (plan.sceneUsed) evParts.push('画质证据 ' + Math.round((plan.scene.quality || 0) * 100) + '%');
    if (evParts.length) more.push(`<div class="lsac-ev">证据：${esc(evParts.join(' · '))}</div>`);
    if (plan.sceneErr) {
      more.push(`<div class="lsac-warn" style="font-size:10px">${esc(plan.sceneErr)}</div>`);
    } else if (!reference && !plan.sceneUsed && STATE.mode === 'auto') {
      more.push(`<div class="lsac-warn" style="font-size:10px">未做画面分析，三分法没有方向依据</div>`);
    }
    if (more.length) {
      lines.push(`<details class="lsac-more"><summary>${reference ? '参考范围' : '判断依据 / 主体'}</summary>${more.join('')}</details>`);
    }

    if (failed && failed.length) {
      lines.push(`<div class="lsac-bad" style="margin-top:5px">${failed.length} 个写入失败：` +
        esc(failed.map(f => f.label + '(' + f.writeError + ')').join('，')) + `</div>`);
    }
    if (createdCount != null && createdCount > 0) {
      lines.push(`<div class="lsac-ok" style="margin-top:4px">✓ 已写入 ${createdCount} 个框，` +
        `确认位置后手动点「通过」提交</div>`);
    }

    info(lines.join(''), !(failed && failed.length));

    if (panel) {
      const btn = panel.querySelector('[data-act="apply"]');
      if (btn) btn.textContent = '写入';
    }
  }

  /** 将百分比裁剪框转换成目标元素上的屏幕矩形。 */
  function cropRectToTarget(box, rect) {
    return {
      left: rect.left + rect.width * box.x / 100,
      top: rect.top + rect.height * box.y / 100,
      width: rect.width * box.w / 100,
      height: rect.height * box.h / 100
    };
  }

  function mediaRect(node) {
    if (!node || !node.isConnected) return null;
    const r = node.getBoundingClientRect();
    if (!(r.width > 120 && r.height > 120)) return null;
    const style = getComputedStyle(node);
    if (node.hidden || style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return null;
    if (node.tagName === 'IMG' && !(node.complete && (node.naturalWidth || 0) > 200)) return null;
    if (node.tagName === 'CANVAS' && !(node.width > 0 && node.height > 0)) return null;
    return { left: r.left, top: r.top, width: r.width, height: r.height,
      right: r.right, bottom: r.bottom };
  }

  /**
   * 元素里图片真正占的那块矩形。
   * 预览区常是 260×180 的框里塞一张 16:9 图（object-fit: contain），
   * 直接用元素 rect 摆百分比框会整体偏移；这里按 natural 宽高比反算 letterbox。
   */
  function contentRect(node, rect) {
    if (!node || !rect) return rect;
    let nw = 0, nh = 0;
    if (node.tagName === 'IMG') {
      nw = node.naturalWidth || 0;
      nh = node.naturalHeight || 0;
    } else if (node.tagName === 'VIDEO') {
      nw = node.videoWidth || 0;
      nh = node.videoHeight || 0;
    }
    if (!(nw > 0 && nh > 0)) {
      // canvas / 无尺寸信息：它自己就是内容区
      return rect;
    }
    const style = getComputedStyle(node);
    const fit = style.objectFit || 'fill';
    if (fit === 'fill' || fit === 'none') return rect;
    const boxAR = rect.width / rect.height;
    const imgAR = nw / nh;
    let w = rect.width, h = rect.height;
    if (fit === 'cover') {
      // cover 是「铺满 + 裁切」，可见内容仍是整个元素框；只有 contain 才留黑边
      return rect;
    }
    // contain / scale-down：等比缩进元素框并居中
    if (imgAR > boxAR) h = w / imgAR;
    else w = h * imgAR;
    const left = rect.left + (rect.width - w) / 2;
    const top = rect.top + (rect.height - h) / 2;
    return { left, top, width: w, height: h, right: left + w, bottom: top + h };
  }

  /** 找到主画布与同一编辑区内右侧的成片预览目标。 */
  function previewTargets() {
    const panelEl = panel;
    const all = [...document.querySelectorAll('img,canvas,video')].filter(node => {
      if (panelEl && (node === panelEl || panelEl.contains(node))) return false;
      if (node.closest('.lsac-panel,.lsac-overlay,.lsac-overlay-bar,.lsf-comments,.lsf-outliner-tree,[role=dialog]')) return false;
      return !!mediaRect(node);
    });
    if (!all.length) return [];
    const konvaMain = all.find(node => {
      const object = node.closest('.lsf-object');
      return object && object.querySelector('.konvajs-content');
    });
    const main = konvaMain || LS._imgEl() || all.slice().sort((a, b) => {
      const ra = mediaRect(a), rb = mediaRect(b);
      return rb.width * rb.height - ra.width * ra.height;
    })[0];
    const mainRect = mediaRect(main);
    if (!mainRect) return [];
    const targets = [{ kind: 'canvas', element: main, rect: mainRect, content: contentRect(main, mainRect) }];
    const editor = main.closest('.lsf-editor,.lsf-object,#label-studio,#label-studio-dm,#review-studio-dm') || document.body;
    const right = all.filter(node => node !== main).map(node => {
      const rect = mediaRect(node);
      const gap = rect.left - mainRect.right;
      const overlapY = Math.min(mainRect.bottom, rect.bottom) - Math.max(mainRect.top, rect.top);
      const sameScope = editor === document.body || editor.contains(node);
      return { node, rect, gap, overlapY, sameScope };
    }).filter(x => x.sameScope && x.gap >= -8 && x.gap <= Math.max(360, mainRect.width * 1.2) &&
      x.overlapY >= Math.min(mainRect.height, x.rect.height) * 0.20);
    right.sort((a, b) => a.gap - b.gap || (b.rect.width * b.rect.height - a.rect.width * a.rect.height));
    if (right[0]) {
      targets.push({
        kind: 'preview', element: right[0].node, rect: right[0].rect,
        content: contentRect(right[0].node, right[0].rect)
      });
    }
    return targets;
  }

  function schedulePreviewLayout() {
    if (!STATE.previewCrops.length || STATE.previewRaf) return;
    STATE.previewRaf = requestAnimationFrame(() => {
      STATE.previewRaf = 0;
      layoutPreview();
    });
  }

  function layoutPreview() {
    if (!STATE.previewLayer || !STATE.previewCrops.length) return;
    const targets = previewTargets();
    STATE.previewTargets = targets;
    const groups = [...STATE.previewLayer.querySelectorAll('[data-preview-target]')];
    groups.forEach((group, index) => {
      const target = targets[index];
      if (!target) { group.style.display = 'none'; return; }
      const geo = target.content || target.rect;
      group.style.display = 'block';
      group.style.left = geo.left + 'px';
      group.style.top = geo.top + 'px';
      group.style.width = geo.width + 'px';
      group.style.height = geo.height + 'px';
    });
    if (STATE.previewBar) {
      const main = targets[0] && targets[0].rect;
      if (main) {
        STATE.previewBar.style.left = Math.max(4, main.left) + 'px';
        STATE.previewBar.style.top = Math.max(4, main.top - 24) + 'px';
        STATE.previewBar.style.bottom = 'auto';
      }
    }
  }

  /** 预览高亮：主画布与右侧成片预览同步显示同一批裁剪框。 */
  function highlightPreview(crops, options = {}) {
    clearPreview();
    if (!crops || !crops.length) return;
    const targets = previewTargets();
    if (!targets.length) return;

    const root = document.createElement('div');
    root.className = 'lsac-overlay-root';
    root.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147482000;overflow:hidden';
    targets.forEach((target, targetIndex) => {
      const geo = target.content || target.rect;
      const layer = document.createElement('div');
      layer.dataset.previewTarget = String(targetIndex);
      layer.style.cssText = `position:fixed;left:${geo.left}px;top:${geo.top}px;` +
        `width:${geo.width}px;height:${geo.height}px;pointer-events:none;`;
      crops.forEach(c => {
        const box = (c.chosen || c).box;
        const color = options.added ? '#bc4c00' : target.kind === 'preview' ? '#f0883e' : '#0969da';
        const d = document.createElement('div');
        d.style.cssText = `position:absolute;left:${box.x}%;top:${box.y}%;width:${box.w}%;` +
          `height:${box.h}%;border:${options.added ? '3px solid' : '2px dashed'} ${color};box-sizing:border-box;` +
          `box-shadow:0 0 0 1px rgba(255,255,255,.7) inset;background:${options.added ? 'rgba(240,136,62,.10)' : 'rgba(9,105,218,.07)'}`;
        const tag = document.createElement('span');
        tag.textContent = (options.added ? '新增 ' : '') + c.label + (c.variantCount > 1 ? ' · ' + ((c.chosen || c).variantTag || '') : '');
        tag.style.cssText = `position:absolute;left:0;top:0;transform:${options.added ? 'none' : 'translateY(-100%)'};` +
          `background:${color};color:#fff;font:600 10px/1.5 sans-serif;padding:0 4px;border-radius:3px 3px 3px 0`;
        d.appendChild(tag);
        layer.appendChild(d);
      });
      root.appendChild(layer);
    });
    document.body.appendChild(root);
    STATE.previewLayer = root;
    STATE.previewTargets = targets;
    STATE.previewCrops = crops;
    STATE.previewAdded = !!options.added;

    const bar = document.createElement('div');
    bar.className = 'lsac-overlay-bar';
    bar.textContent = `${options.added ? '本次补充' : '预览'} ${crops.length} 个框 · ${targets.length > 1 ? '主画布 + 右侧预览' : '未找到右侧预览'} · 按 Esc 清除`;
    bar.style.cssText = 'position:fixed;left:4px;top:4px;z-index:2147482001;pointer-events:none;' +
      'background:rgba(9,105,218,.92);color:#fff;font:500 11px/1.6 sans-serif;padding:2px 8px;border-radius:5px';
    document.body.appendChild(bar);
    STATE.previewBar = bar;

    STATE.previewOnResize = schedulePreviewLayout;
    STATE.previewOnScroll = schedulePreviewLayout;
    window.addEventListener('resize', STATE.previewOnResize, true);
    window.addEventListener('scroll', STATE.previewOnScroll, true);
    const observeRoot = targets[0].element.closest('.lsf-editor,.lsf-object,#label-studio,#label-studio-dm,#review-studio-dm') || document.body;
    if (window.ResizeObserver) {
      STATE.previewObserver = new ResizeObserver(schedulePreviewLayout);
      targets.forEach(t => STATE.previewObserver.observe(t.element));
      STATE.previewObserver.observe(observeRoot);
    }
    if (window.MutationObserver && observeRoot !== document.body) {
      STATE.previewMutationObserver = new MutationObserver(schedulePreviewLayout);
      STATE.previewMutationObserver.observe(observeRoot, { subtree: true, attributes: true, attributeFilter: ['class', 'style'] });
    }
    layoutPreview();
  }

  function clearPreview() {
    if (STATE.previewRaf) { cancelAnimationFrame(STATE.previewRaf); STATE.previewRaf = 0; }
    if (STATE.previewObserver) { STATE.previewObserver.disconnect(); STATE.previewObserver = null; }
    if (STATE.previewMutationObserver) { STATE.previewMutationObserver.disconnect(); STATE.previewMutationObserver = null; }
    if (STATE.previewOnResize) { window.removeEventListener('resize', STATE.previewOnResize, true); STATE.previewOnResize = null; }
    if (STATE.previewOnScroll) { window.removeEventListener('scroll', STATE.previewOnScroll, true); STATE.previewOnScroll = null; }
    if (STATE.previewLayer) { STATE.previewLayer.remove(); STATE.previewLayer = null; }
    if (STATE.previewBar) { STATE.previewBar.remove(); STATE.previewBar = null; }
    STATE.previewTargets = [];
    STATE.previewCrops = [];
    STATE.previewAdded = false;
  }

  /** 原生列表行与区域一一对应；同名比例、排序变化均不按文字猜测。 */
  function outlinerRegionRows() {
    const regions = LS.regionList();
    const byId = new Map(regions.filter(r => r.id != null).map(r => [String(r.id), r]));
    return [...document.querySelectorAll('.lsf-outliner-item')].map(row => {
      if (row.closest('.lsf-panel-tabs__ghost-tab')) return { row, region: null };
      const nodes = [row, row.querySelector('.lsf-outliner-item__content'),
        row.querySelector('.lsf-outliner-item__title')].filter(Boolean);
      for (let parent = row.parentElement, depth = 0; parent && depth < 5 &&
          !parent.matches('.lsf-outliner'); depth++, parent = parent.parentElement) nodes.push(parent);
      // 正常 Label Studio 的 React 属性含有区域模型；用区域 ID 兼容模型对象重建。
      for (const node of nodes) {
        const fiberKey = Object.keys(node).find(k => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
        let fiber = fiberKey && node[fiberKey];
        for (let depth = 0; fiber && depth < 24; depth++, fiber = fiber.return) {
          const props = fiber.memoizedProps || fiber.pendingProps;
          const item = props && (props.item || props.region);
          const region = item && (regions.includes(item) ? item :
            item.id != null && byId.get(String(item.id)));
          if (region) return { row, region };
        }
      }
      for (const node of nodes) {
        for (const attr of ['data-region-id', 'data-key', 'data-id']) {
          const id = node.getAttribute(attr);
          if (id != null && byId.has(id)) return { row, region: byId.get(id) };
        }
      }
      return { row, region: null };
    });
  }

  function clearWrittenHighlights() {
    STATE.written = [];
    if (STATE.writtenObserver) { STATE.writtenObserver.disconnect(); STATE.writtenObserver = null; }
    if (STATE.writtenRaf) { cancelAnimationFrame(STATE.writtenRaf); STATE.writtenRaf = 0; }
    document.querySelectorAll('.lsac-written-row').forEach(row => row.classList.remove('lsac-written-row'));
  }

  function selectOutlinerSubject(event) {
    const target = event.target;
    if (!target || !target.closest || target.closest('button,.lsf-outliner-item__controls,.lsf-panel-tabs__ghost-tab')) return;
    const row = target.closest('.lsf-outliner-item');
    if (!row) return;
    const match = outlinerRegionRows().find(entry => entry.row === row);
    const entries = LS.subjectEntries();
    if (!entries.length && match && LS.aspectOf(match.region)) {
      if (STATE.busy) return;
      refreshSubjects();
      const context = referenceContext();
      const id = String(match.region.id);
      let ids = new Set(context.source === 'selected' ? context.ids : []);
      if (event.ctrlKey || event.metaKey || event.shiftKey) {
        if (ids.has(id)) ids.delete(id); else ids.add(id);
      } else ids = new Set([id]);
      STATE.referenceContext = { ...context, ids, source: ids.size ? 'selected' : 'existing', native: nativeReferenceSelection() };
      STATE.last = null;
      clearPreview();
      clearAddedHighlights();
      refreshCounts();
      info('<span class="lsac-hint">' + referenceLabel(STATE.referenceContext.source) + '，点缺失比例即可补齐。</span>', true);
      scheduleAutoPreview(120);
      return;
    }
    const subject = match && entries.find(s => s.region === match.region);
    if (!subject) return;
    refreshSubjects();
    if (event.ctrlKey || event.metaKey || event.shiftKey) {
      if (STATE.subjectIds.has(subject.id)) STATE.subjectIds.delete(subject.id);
      else STATE.subjectIds.add(subject.id);
    } else {
      STATE.subjectIds = new Set([subject.id]);
    }
    subjectSelectionChanged();
  }

  function syncWrittenRows() {
    if (!STATE.written.length) return;
    if (STATE.annotation !== LS.annotation() || STATE.taskId !== taskId()) {
      clearWrittenHighlights();
      return;
    }
    const alive = new Set(LS.regionList());
    STATE.written = STATE.written.filter(({ region }) => alive.has(region));
    if (!STATE.written.length) { clearWrittenHighlights(); return; }
    const written = new Set(STATE.written.map(({ region }) => region));
    outlinerRegionRows().forEach(({ row, region }) => {
      const highlight = written.has(region);
      if (row.classList.contains('lsac-written-row') !== highlight) row.classList.toggle('lsac-written-row', highlight);
    });
  }

  /** 平台通常晚一帧才渲染新行；列表重绘、排序后重新绑定，不反复点击用户的选择。 */
  function watchWrittenRows() {
    if (!STATE.written.length || STATE.writtenObserver) return;
    STATE.writtenObserver = new MutationObserver(() => {
      if (STATE.writtenRaf) return;
      STATE.writtenRaf = requestAnimationFrame(() => {
        STATE.writtenRaf = 0;
        syncWrittenRows();
      });
    });
    STATE.writtenObserver.observe(document.body, { subtree: true, childList: true,
      attributes: true, attributeFilter: ['class', 'data-key', 'data-region-id', 'data-id'] });
  }

  /**
   * 写入后把新框选中、右侧列表滚过去 —— 用户不用在长列表里自己翻找刚写的那一个。
   *
   * 选中要三路兜底，因为 LSF 各版本暴露的 API 完全不同：
   *   1) region 自己带 setSelected / selected（老版本）；
   *   2) regionStore.selectRegion / setSelection（新版本走 store）；
   *   3) 直接点列表项（最可靠 —— 这就是用户手点的那一下，平台自己会把画布跳过去）。
   */
  function focusNewRegions(created) {
    const createdList = created || [];
    const areas = createdList.map(item => item && item.region).filter(Boolean);
    if (!areas.length) return false;

    const an = LS.annotation();
    const store = an && an.regionStore;
    let selected = 0;
    areas.forEach(area => {
      try {
        if (typeof area.setSelected === 'function') { area.setSelected(true); selected++; return; }
        if (store && typeof store.selectRegion === 'function') { store.selectRegion(area, true); selected++; return; }
        if (an && typeof an.selectArea === 'function') { an.selectArea(area); selected++; return; }
        if (store && typeof store.setSelection === 'function') { store.setSelection(areas); selected++; return; }
      } catch (e) { /* 选中失败不影响写入，继续往下兜底 */ }
    });

    const wanted = new Set(areas);
    const rows = outlinerRegionRows().filter(({ region }) => wanted.has(region)).map(({ row }) => row);

    rows.forEach((row, index) => {
      try { row.scrollIntoView({ block: 'nearest' }); } catch (e) { /* ignore */ }
      // 第一行让平台自己响应普通点击（这会顺带把画布跳到该框）；其余带修饰键做多选
      try {
        row.dispatchEvent(new MouseEvent('click', {
          bubbles: true, cancelable: true, view: window,
          ctrlKey: index > 0, metaKey: index > 0
        }));
      } catch (e) { /* ignore */ }
    });

    return selected > 0 || rows.length > 0;
  }

  function doUndo() {
    if (STATE.busy) return;
    refreshSubjects();
    const an = LS.annotation();
    if (!an) return;

    const usable = rec => rec && rec.annotation === an && rec.taskId === taskId() &&
      ((rec.created && rec.created.length) || (rec.removed && rec.removed.length));

    // 换图后旧记录无法撤销：先清掉，再取最近一条有效记录
    while (STATE.undoStack.length && !usable(STATE.undoStack[STATE.undoStack.length - 1])) {
      STATE.undoStack.pop();
    }
    const last = STATE.undoStack.pop();
    if (!last) {
      STATE.undo = null;
      info('<span class="lsac-warn">没有可撤销的记录了（只记录本面板写入的框，最多退 5 步）</span>', false);
      return;
    }

    const alive = new Set(LS.regionList(an));
    let del = 0, restore = 0;

    // 1. 删掉这次生成的框（被别处删掉的跳过）
    (last.created || []).forEach(({ region }) => {
      if (alive.has(region) && LS.removeRegion(region)) del++;
    });

    // 2. 覆盖模式下被删掉的旧框原样补回，否则会丢数据
    (last.removed || []).forEach(r => {
      try {
        const def = ASPECT_DEFS.find(a => a.name === r.fromName);
        LS.writeCrop(r.fromName, r.label, r.box, an, def && def.key);
        restore++;
      } catch (e) { /* 单个失败不影响其它 */ }
    });

    STATE.undo = STATE.undoStack[STATE.undoStack.length - 1] || null;
    STATE.last = null;
    clearAddedHighlights();
    clearPreview();
    refreshCounts();

    let msg = `已撤销 ${del} 个裁剪框`;
    if (restore) msg += `，并还原 ${restore} 个被覆盖的旧框`;
    if (STATE.undoStack.length) msg += `（还能再退 ${STATE.undoStack.length} 步）`;
    info(`<span class="lsac-ok">${msg}</span>`, true);
  }

  /* ===================================================================
   *  5. 启动
   * =================================================================== */

  async function boot() {
    const ok = await LS.ready(30000);
    if (!ok) { console.warn('[自动构图] Label Studio 未就绪'); return; }
    if (panel) return;
    panel = buildPanel();
    window.__LS_AUTO_COMPOSE__ = {
      panel, run, fillOne, focusNewRegions, doUndo, setStrategy, setCollapsed, clearPreview,
      applyPanelSize, refreshCounts, assessCompleteness,
      LS, STATE, ComposeCore, SceneAnalyze: window.SceneAnalyze,
      ASPECT_DEFS, STRATEGIES, cropRectToTarget, previewTargets, contentRect
    };
    info('<span style="color:#57606a">红格=缺的比例，点一下直接补；回车写入、Z 撤销、Esc 清预览。</span>', true);
    refreshCounts();
    if (RATIO_PANEL_ALIVE()) {
      info('<span class="lsac-warn">检测到旧版「比例齐全度浮窗」仍开着，两边会同时改标注，建议关掉它。</span>', false);
    }
    watchAnnotation();
    document.addEventListener('click', selectOutlinerSubject, true);
    window.addEventListener('pagehide', clearWrittenHighlights);
  }

  /** SPA 内切换任务时，标注会整个换掉 —— 轮询 region 签名，变了就刷新角标 */
  function watchAnnotation() {
    let lastSig = '';
    let lastAnnot = null;
    setInterval(() => {
      if (!panel || document.hidden) return;
      refreshSubjects();
      const an = LS.annotation();
      if (!an) return;
      // 切图/切任务后先自己算一遍，省得面板空着等用户碰任何一个控件
      if (an !== lastAnnot) {
        lastAnnot = an;
        scheduleAutoPreview(500);
      }
      const list = LS.regionList(an);
      const sig = list
        .map(r => {
          const res = r.results && r.results[0];
          return [res && res.from_name && (res.from_name.name || res.from_name), r.id, r.x, r.y, r.width, r.height].join(':');
        }).join('|') + (!LS.subjectEntries(an).length ? '#' + nativeReferenceSelection(an) : '');
      if (sig !== lastSig) {
        lastSig = sig;
        // 手画/删除框之后，撤销栈里的记录可能已经失效，只剪枝不整体清空
        STATE.undoStack.forEach(rec => {
          if (!rec.created) return;
          const alive = new Set(list);
          rec.created = rec.created.filter(({ region }) => alive.has(region));
        });
        refreshCounts();
      }
    }, 1200);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
