// ==UserScript==
// @name         Insta360 审核与评论帧工具箱
// @namespace    insta360-review-comment-tools
// @version      1.0.5
// @description  右键提交/更新/通过，侧键更新，Tab驳回/取消、Enter提交、Esc取消、左右切换；驳回历史；评论帧号跳转/标注引用；常用理由；截图附图和图片标注；自定义快捷键。
// @author       橙子 / chengzi
// @match        *://label.insta360.com/*
// @match        *://*.labelstud.io/*
// @run-at       document-start
// @grant        none
// @sandbox      raw
// @inject-into  page
// @homepageURL  https://github.com/chengzi-1225/Insta360-chengzi
// @downloadURL  https://raw.githubusercontent.com/chengzi-1225/Insta360-chengzi/main/insta360-review-comment-tools.user.js
// @updateURL    https://raw.githubusercontent.com/chengzi-1225/Insta360-chengzi/main/insta360-review-comment-tools.user.js
// ==/UserScript==

// 安装合并版后，请停用原来的两份脚本，避免独立脚本重复监听。
// 来源：右键提交/更新/通过 + 审核快捷键 v3.0.0；Insta360 评论帧号跳转 v3.1.7。
// @grant none 保留页面上下文能力：全景画布截取、时间轴插件和原生表单事件。
// 配置/常用理由沿用原 localStorage 键；新脚本的最近五条驳回历史也存于当前站点。
(function () {
  'use strict';
  const KEY = '__INSTA_REVIEW_ASSISTANT__';
  if (window[KEY]) return;
  const api = { version: '1.0.5', destroy() {
    if (window[KEY] !== api) return;
    window._fcMergedApi?.destroy?.();
    window.__INSTA_COMMENT_FRAME_LINKS__?.destroy?.();
    delete window[KEY];
  } };
  window[KEY] = api;

(() => {
  'use strict';
  const KEY = '__INSTA_COMMENT_FRAME_LINKS__';
  window[KEY]?.destroy?.();
  const ROOT = '.lsf-comments-list,.lsf-history-item__comment-content';
  const FORM = '.lsf-comment-form__input-container';
  const REJECT_TEXTAREA = 'textarea[placeholder*="驳回理由"]';
  const TEXTAREA = `textarea[name="comment"],textarea[placeholder="请输入评论"],${REJECT_TEXTAREA}`;
  // 审核页的驳回框不在普通评论表单内。只匹配明确的驳回理由框。
  const inputHost = textarea => textarea.closest(FORM)
    || (textarea.matches(REJECT_TEXTAREA) ? textarea.parentElement : null);
  const CONTROL = '.lsf-frames-control,[class*="frames-control"]';
  const LINK = 'i360-comment-frame-link';
  const FRAME_TEXT_OVERLAY = 'i360-frame-text-overlay';
  const INSERT = 'i360-comment-current-frame';
  const INLINE_REFERENCE = '[data-i360-inline-frame],[data-i360-inline-id]';
  const SKIP = `.${LINK},button,a,input,textarea,select,script,style,code,pre,[contenteditable]:not([contenteditable="false"])`;
  // 普通标签使用明确的引用格式，避免把理由里的比例、人物名等普通文字变成链接。
  // 引号内按 JSON 字符串转义，标签本身包含「」、换行或反斜杠时也能完整还原。
  const REFERENCE_SOURCE = String.raw`\b(?:(\d+)\s*f\b|id-(\d+)(?![\w-]))|标注#([1-9]\d*)「((?:\\.|[^\\」\r\n])+)」`;
  const TOKEN_TEST = new RegExp(REFERENCE_SOURCE, 'i'); // 非全局正则：test() 不保留 lastIndex。
  const referencePattern = () => new RegExp(REFERENCE_SOURCE, 'gi');
  const roots = new Map();
  const composing = new WeakSet();
  const listeners = [];
  let dead = false;
  let renderId = 0;
  let centerId = 0;
  let seekId = 0;
  let frameTextOverlay = null;
  let frameTextHost = null;
  let frameTextHostPosition = null;
  let frameTextState = null;

  // 图片全景只按需重绘。必须在首次创建上下文时保留画面，静止后再截图也可读取。
  // 仅处理页面的全景画布，保留其余上下文选项及普通 2D / WebGL 画布的行为。
  const restorePanoramaContext = (() => {
    if (typeof HTMLCanvasElement === 'undefined') return () => {};
    const prototype = HTMLCanvasElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'getContext');
    const original = prototype.getContext;
    const wrapped = function (type, options, ...rest) {
      if (!dead && ['webgl', 'webgl2', 'experimental-webgl'].includes(type)
        && (this.matches('[class*="panorama-canvas"]') || this.closest('[class*="panorama-container"]'))) {
        const attributes = Object.create(options ?? null, { preserveDrawingBuffer: { value: true } });
        return Reflect.apply(original, this, [type, attributes, ...rest]);
      }
      return Reflect.apply(original, this, arguments);
    };
    Object.defineProperty(prototype, 'getContext', { ...descriptor, value: wrapped });
    return () => {
      if (prototype.getContext === wrapped) Object.defineProperty(prototype, 'getContext', descriptor);
    };
  })();

  const warn = message => console.warn(`[评论跳帧] ${message}`);
  const validFrame = value => Number.isSafeInteger(value) && value >= 0;
  const videoTask = () => !!document.querySelector('.lsf-video__main');
  const visible = node => node.isConnected && node.getClientRects().length > 0;
  const currentReferenceLabel = () => videoTask() ? '当前帧' : '当前标注';
  const missingReferenceMessage = () => videoTask() ? '无法读取当前帧号' : '请先在左侧标注列表中只选中一个选项（支持任意标签）';
  const referenceHeading = value => typeof value === 'string' ? value : `第 ${value} 帧`;
  const screenshotHeading = value => value === null ? '当前图片' : referenceHeading(value);
  const screenshotTag = value => value === null ? 'image' : typeof value === 'number' ? `${value}f` : value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 120);
  const captureTaskIdentity = () => JSON.stringify([window.location?.href || '', videoTask(),
    [...(frameTextDisplayHost()?.querySelectorAll('img[alt="LS"],video') || [])].map(node => node.getAttribute('src') || ''),
  ]);
  const matchReference = match => match[3] !== undefined ? (parseLabelReference(match[0]) ? match[0] : null)
    : match[2] !== undefined ? `id-${match[2]}` : validFrame(Number(match[1])) ? Number(match[1]) : null;

  function labelReference(index, label) {
    const encoded = JSON.stringify(label).slice(1, -1).replace(/[「」]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
    return `标注#${index}「${encoded}」`;
  }

  function parseLabelReference(value) {
    const match = /^标注#([1-9]\d*)「((?:\\.|[^\\」\r\n])+)」$/u.exec(value);
    if (!match || !Number.isSafeInteger(Number(match[1]))) return null;
    try {
      const label = JSON.parse(`"${match[2]}"`);
      return label ? { index: Number(match[1]), label } : null;
    } catch { return null; }
  }

  function markReference(node, reference, inline = false) {
    if (typeof reference === 'string') node.dataset[inline ? 'i360InlineId' : 'regionId'] = reference;
    else node.dataset[inline ? 'i360InlineFrame' : 'frame'] = String(reference);
    node.title = (typeof reference === 'number' && videoTask()) || (typeof reference === 'string' && !videoTask())
      ? `跳转到${referenceHeading(reference)}并显示后续文本` : `显示${referenceHeading(reference)}的后续文本`;
    node.setAttribute('aria-label', node.title);
  }

  function extractTrailingFrameText(source, start, length) {
    if (typeof source !== 'string' || !Number.isInteger(start) || !Number.isInteger(length) || start < 0 || length <= 0 || start + length > source.length) return '';
    const after = source.slice(start + length);
    const next = new RegExp(String.raw`(?:跳转(?:帧|ID|标注)\s*[:：\-—]?\s*)?[（(\[【]?\s*(?:${REFERENCE_SOURCE})`, 'iu').exec(after);
    return (next ? after.slice(0, next.index) : after).replace(/^[\s）)\]】:：,，、;；\-—>]+/u, '').trim();
  }

  function frameTextForLink(link) {
    const host = link.closest('.i360-rich-reason,.lsf-history-item__comment-content,.lsf-comment__content,.lsf-comment__text,[class*="comment-content"]')
      || link.closest('p,li,article') || link.parentElement;
    if (!host) return '';
    // Use the clicked node's actual position: comments can contain the same
    // frame twice, and React may update sibling text after links were created.
    const before = document.createRange();
    before.selectNodeContents(host); before.setEndBefore(link);
    return extractTrailingFrameText(host.textContent || '', before.toString().length, link.textContent.length);
  }

  function frameTextDisplayHost() {
    const candidates = [
      ...document.querySelectorAll('.lsf-object'),
      ...document.querySelectorAll('.lsf-video__main'),
    ];
    return candidates.find(node => visible(node) && (
      node.matches?.('.lsf-video__main')
      || node.querySelector?.('img[alt="LS"],[class*="image-element--"],[class*="panorama-container--"],.lsf-video__main')
    ));
  }

  function clearFrameText() {
    frameTextOverlay?.overlay.remove();
    if (frameTextHost && frameTextHostPosition !== null && frameTextHost.style.position === 'relative') frameTextHost.style.position = frameTextHostPosition;
    frameTextOverlay = null;
    frameTextHost = null;
    frameTextHostPosition = null;
    frameTextState = null;
  }

  function showFrameText(frame, text) {
    if (dead || !text) { clearFrameText(); return; }
    const host = frameTextDisplayHost();
    if (!host) { clearFrameText(); warn('没有找到可显示帧文本的图像区域'); return; }
    if (host !== frameTextHost) {
      clearFrameText();
      frameTextHost = host;
      const position = typeof getComputedStyle === 'function' ? getComputedStyle(host).position : host.style.position;
      if (!position || position === 'static') { frameTextHostPosition = host.style.position; host.style.position = 'relative'; }
    }
    if (!frameTextOverlay) {
      const overlay = element('div', FRAME_TEXT_OVERLAY);
      overlay.setAttribute('role', 'status');
      const heading = element('strong', 'i360-frame-text-heading');
      const body = element('div', 'i360-frame-text-body');
      const close = button('×', '关闭帧文本', 'i360-frame-text-close');
      close.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); clearFrameText(); });
      overlay.append(heading, body, close); host.append(overlay);
      frameTextOverlay = { overlay, heading, body };
    }
    frameTextOverlay.heading.textContent = referenceHeading(frame);
    frameTextOverlay.body.textContent = text;
    frameTextOverlay.overlay.hidden = false;
    if (frameTextOverlay.overlay.parentElement !== host) host.append(frameTextOverlay.overlay);
    frameTextState = { frame, text, href: window.location?.href || '', image: host.querySelector('img[alt="LS"]')?.getAttribute('src') || '' };
  }

  function refreshFrameText() {
    if (!frameTextState) return;
    const state = frameTextState, host = frameTextDisplayHost();
    if (!host || state.href !== (window.location?.href || '') || state.image !== (host.querySelector('img[alt="LS"]')?.getAttribute('src') || '')) { clearFrameText(); return; }
    if (host !== frameTextHost || !frameTextOverlay?.overlay.isConnected) showFrameText(state.frame, state.text);
  }

  function activateFrameLink(link) {
    const id = link.dataset.regionId ?? link.dataset.i360InlineId;
    if (id !== undefined) {
      if (dead || (!/^id-\d+$/i.test(id) && !parseLabelReference(id))) return;
      showFrameText(id, frameTextForLink(link));
      if (!videoTask()) jumpToImageId(id);
      return;
    }
    const frame = Number(link.dataset.frame ?? link.dataset.i360InlineFrame);
    if (dead || !validFrame(frame)) return;
    showFrameText(frame, frameTextForLink(link));
    // Image tasks have no video timeline. Showing a reason must also work when
    // the optional video seek fails or is still waiting for the native input.
    if (videoTask()) void jump(frame);
  }
  const controls = () => [...document.querySelectorAll(CONTROL)].filter(visible);
  const frameInput = () => {
    for (const control of controls()) {
      const input = control.querySelector('input:not([type="range"]):not([type="hidden"]),[contenteditable="true"]');
      if (input && visible(input) && !input.disabled && !input.readOnly) return input;
    }
    return null;
  };

  function listen(target, type, handler, options) {
    target.addEventListener(type, handler, options);
    listeners.push(() => target.removeEventListener(type, handler, options));
  }

  function setNativeValue(element, value) {
    const view = element.ownerDocument.defaultView;
    const prototype = element.tagName === 'TEXTAREA'
      ? view.HTMLTextAreaElement.prototype : view.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    if (setter) setter.call(element, value);
    else element.value = value;
  }

  function inputEvent(element, data) {
    element.dispatchEvent(new InputEvent('input', {
      bubbles: true, inputType: 'insertText', data,
    }));
  }

  function currentFrame() {
    if (!videoTask()) return null;
    try {
      const snapshot = window.__insta360TimelineCenter?.snapshot?.();
      const state = Array.isArray(snapshot)
        ? snapshot.find(item => item?.supported && Number.isFinite(item.frame) && item.frame >= 0)
        : null;
      if (state && validFrame(Math.round(state.frame))) return Math.round(state.frame);
    } catch { /* 可选的时间轴插件不可用时，读取页面控件。 */ }
    for (const control of controls()) {
      // 编辑框里的值可能还未确认，优先读取已显示的帧计数。
      const match = control.textContent.match(/^\s*(\d+)\s*of\s*\d+/i);
      if (match && validFrame(Number(match[1]))) return Number(match[1]);
    }
    return null;
  }

  function imageRows() {
    // 从标题反查行，role=treeitem 与 treenode 分层嵌套时也只计算一次。
    return [...new Set([...document.querySelectorAll('.lsf-outliner-tree .lsf-outliner-item__title')]
      .map(title => title.closest('.lsf-tree-treenode,[role="treeitem"]')).filter(Boolean))];
  }

  function imageLabelForRow(row) {
    const title = row.querySelector('.lsf-outliner-item__title .lsf-labels-list')
      || row.querySelector('.lsf-outliner-item__title');
    if (!title) return '';
    const copy = title.cloneNode(true);
    copy.querySelectorAll('.lsf-label__hotkey,[class*="hotkey"],button,svg').forEach(node => node.remove());
    return (copy.textContent || '').replace(/\s+/gu, ' ').trim();
  }

  function imageIdForRow(row, rows = imageRows()) {
    const label = imageLabelForRow(row);
    if (!label) return null;
    const id = label.match(/^id-(\d+)(?![\w-])/i);
    if (id) return `id-${id[1]}`;
    const displayed = row.querySelector('.lsf-outliner-item__index')?.textContent?.trim();
    const index = /^[1-9]\d*$/.test(displayed || '') ? Number(displayed) : rows.indexOf(row) + 1;
    return Number.isSafeInteger(index) && index > 0 ? labelReference(index, label) : null;
  }

  function jumpToImageId(id) {
    const rows = imageRows();
    const reference = /^id-\d+$/i.test(id) ? id.toLowerCase() : id;
    const matches = rows.filter(row => visible(row) && imageIdForRow(row, rows) === reference);
    const record = activeReason();
    if (matches.length !== 1) {
      const message = matches.length ? `存在多个 ${id} 标注，请在列表中选择` : `未找到 ${id} 对应的标注`;
      status(record, message, 'error'); warn(message); return false;
    }
    const row = matches[0];
    // Click the label itself so the page performs its normal selection and
    // canvas focus. Avoid the row's lock, visibility, and delete controls.
    const target = row.querySelector('.lsf-outliner-item__title .lsf-labels-list')
      || row.querySelector('.lsf-outliner-item__title');
    try {
      row.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      if (currentImageId() !== reference) target.click();
      status(record, currentImageId() === reference ? `已跳转到 ${id}` : `已请求跳转到 ${id}`, 'success');
      return true;
    } catch (error) {
      const message = `跳转 ${id} 失败：${error.message}`;
      status(record, message, 'error'); warn(message); return false;
    }
  }

  function currentImageId() {
    const selected = [...document.querySelectorAll('.lsf-outliner-tree .lsf-tree-treenode-selected,.lsf-outliner-tree .lsf-tree-node-selected,.lsf-outliner-tree [role="treeitem"][aria-selected="true"]')];
    const allRows = imageRows();
    const markers = selected.filter(visible);
    const rows = allRows.filter(row => visible(row) && markers.some(node => row === node || row.contains(node) || node.contains(row)));
    // 旧 ID 保留原格式；普通标签使用“行号 + 完整标签”，区分重复比例。
    // 每次读取页面当前选择，无选择或多选时不复用之前的引用。
    if (rows.length !== 1) return null;
    return imageIdForRow(rows[0], allRows);
  }

  const currentReference = () => videoTask() ? currentFrame() : currentImageId();

  function centerOnce() {
    cancelAnimationFrame(centerId);
    centerId = requestAnimationFrame(() => {
      centerId = 0;
      if (dead) return;
      try { window.__insta360TimelineCenter?.centerOnce?.(); }
      catch { /* 居中失败不影响跳帧。 */ }
    });
  }

  async function jump(frame) {
    if (dead || !videoTask() || !validFrame(frame)) return false;
    const ticket = ++seekId;
    const active = () => !dead && ticket === seekId;
    const api = window.__insta360TimelineCenter;
    if (typeof api?.seekTo === 'function') {
      try {
        // undefined、0 均不能判为失败；仅显式 false 或异常启用备用路径。
        const result = await api.seekTo(frame);
        if (!active()) return false;
        if (result !== false) { centerOnce(); return true; }
      } catch { if (!active()) return false; }
    }

    const previousFocus = document.activeElement;
    let input = frameInput();
    try {
      if (!input) {
        const control = controls()[0];
        if (!control) throw new Error('没有找到可见的帧号控件');
        // 当前站点平时显示纯文本，点击后才挂载编辑框。
        control.click();
        for (let attempt = 0; attempt < 20 && active(); attempt++) {
          input = frameInput();
          if (input) break;
          await new Promise(resolve => setTimeout(resolve, 30));
        }
      }
      if (!active()) return false;
      if (!input) throw new Error('帧号编辑框未出现，请确认时间轴插件或页面版本');
      const value = String(frame);
      input.focus({ preventScroll: true });
      if (input.isContentEditable) input.textContent = value;
      else setNativeValue(input, value);
      inputEvent(input, value);
      input.dispatchEvent(new Event('change', { bubbles: true }));
      // 受控输入更新后可能替换 DOM；重新取得当前编辑框再提交。
      input = frameInput() || input;
      for (const type of ['keydown', 'keyup']) {
        input.dispatchEvent(new KeyboardEvent(type, {
          key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true,
        }));
      }
      centerOnce();
      return true; // 表示已提交跳帧请求，最终边界校验由站点完成。
    } catch (error) {
      if (active()) warn(`跳帧失败：${error.message}`);
      return false;
    } finally {
      // 不抢回用户在异步等待期间已转移的焦点。
      if (active() && previousFocus?.isConnected && document.activeElement === input) {
        previousFocus.focus({ preventScroll: true });
      }
    }
  }

  function insertCurrentFrame(textarea) {
    if (dead || composing.has(textarea)) return null;
    const reference = currentReference(), record = ui.get(textarea);
    if (reference === null) { status(record, missingReferenceMessage(), 'error'); return null; }
    insertReasonText(textarea, `（${typeof reference === 'string' ? reference : `${reference}f`}）`);
    status(record, `已填入${referenceHeading(reference)}`, 'success');
    return reference;
  }

  function wrapText(textNode) {
    if (!textNode.isConnected || textNode.parentElement?.closest(SKIP)) return;
    const text = textNode.nodeValue || '';
    if (!TOKEN_TEST.test(text)) return;
    const pattern = referencePattern();
    const fragment = document.createDocumentFragment();
    let last = 0;
    for (const match of text.matchAll(pattern)) {
      const reference = matchReference(match);
      if (reference === null) continue;
      fragment.append(document.createTextNode(text.slice(last, match.index)));
      const link = document.createElement('button');
      link.type = 'button';
      link.className = LINK;
      link.textContent = match[0];
      markReference(link, reference);
      fragment.append(link);
      last = match.index + match[0].length;
    }
    if (!last) return;
    fragment.append(document.createTextNode(text.slice(last)));
    textNode.replaceWith(fragment);
  }

  function wrapNode(node) {
    if (node.nodeType === Node.TEXT_NODE) { wrapText(node); return; }
    if (node.nodeType !== Node.ELEMENT_NODE || node.closest(SKIP)) return;
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(child) {
        if (child.nodeType === Node.ELEMENT_NODE) {
          return child.matches(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP;
        }
        return TOKEN_TEST.test(child.nodeValue || '') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });
    const texts = [];
    while (walker.nextNode()) texts.push(walker.currentNode);
    texts.forEach(wrapText);
  }

  function collect(state, records) {
    for (const record of records) {
      if (record.type === 'characterData') state.pending.add(record.target);
      else for (const node of record.addedNodes) state.pending.add(node);
    }
  }

  function schedule() {
    if (dead || renderId) return;
    renderId = requestAnimationFrame(() => {
      renderId = 0;
      for (const [root, state] of roots) {
        collect(state, state.observer.takeRecords());
        if (!root.isConnected) {
          state.observer.disconnect(); roots.delete(root); continue;
        }
        if (!state.pending.size) continue;
        // 暂停自身监听，避免插入链接又触发一次扫描。
        state.observer.disconnect();
        try {
          for (const node of state.pending) {
            if (!root.contains(node)) continue;
            let parent = node.parentNode;
            while (parent && parent !== root && !state.pending.has(parent)) parent = parent.parentNode;
            if (node !== root && (state.pending.has(root) || (parent && parent !== root))) continue;
            wrapNode(node);
          }
        } finally {
          state.pending.clear();
          if (!dead) state.observer.observe(root, { childList: true, characterData: true, subtree: true });
        }
      }
    });
  }

  const PANORAMA = '[class*="panorama-container"]';
  const PANORAMA_CANVAS = 'canvas[class*="panorama-canvas"],canvas[data-engine^="three.js"]';

  function captureLayerVisible(node, main) {
    if (!visible(node)) return false;
    for (let parent = node; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      if (style.display === 'none' || ['hidden', 'collapse'].includes(style.visibility) || style.opacity === '0') return false;
      if (parent === main) break;
    }
    return true;
  }

  function imageCaptureAreas() {
    const host = frameTextDisplayHost();
    if (!host) return { main: null, roots: [], previews: [] };
    // 原图与预览可能分属不同面板；从同一编辑器找预览，不依赖父级层数。
    // 只读取明确的画面区域，公共父级里的评论、附件和 Regions 不参与截图。
    let scope = host.closest('.lsf-editor,#label-studio,#label-studio-dm,#review-studio-dm');
    if (!scope) {
      scope = host;
      while (scope.parentElement && scope.parentElement !== document.body) scope = scope.parentElement;
    }
    const candidates = new Set(scope.querySelectorAll(PANORAMA));
    for (const canvas of scope.querySelectorAll(PANORAMA_CANVAS)) {
      if (canvas.closest(PANORAMA)) continue;
      const parent = canvas.parentElement;
      candidates.add(parent && !parent.querySelector('img[alt="LS"]') ? parent : canvas);
    }
    // 普通矩形框的成片预览也可能由项目配置渲染在独立 object 中，
    // 使用普通 2D canvas / img，没有全景组件的类名。
    for (const media of scope.querySelectorAll('canvas,img')) {
      if (host.contains(media) || media.closest(PANORAMA)) continue;
      const preview = media.closest('.lsf-object,[class*="preview"],[id*="preview"],[class*="crop"],[id*="crop"]');
      if (preview && preview !== scope && scope.contains(preview)) candidates.add(preview);
    }
    let previews = [...candidates].filter(node => {
      if (!captureLayerVisible(node, scope) || node.closest('.lsf-comments-list,.lsf-comments,.lsf-history-item__comment-content,.lsf-comment-form__input-container,.lsf-outliner-tree,.lsf-topbar,.i360-dialog,[role="dialog"],[contenteditable="true"]')) return false;
      const owner = node.closest('.lsf-object');
      if (owner && owner !== host && owner.querySelector('img[alt="LS"]')) return false;
      return !owner || owner === host || host.contains(owner)
        || ![...owner.querySelectorAll('img[alt="LS"]')].some(image => !node.contains(image));
    });
    const inside = previews.filter(node => host.contains(node));
    if (inside.length) previews = inside;
    else {
      // 多个独立图像对象共存时，优先选择与原图共享最近父级的预览。
      for (let parent = host.parentElement; parent; parent = parent.parentElement) {
        const nearby = previews.filter(node => parent.contains(node));
        if (nearby.length) { previews = nearby; break; }
        if (parent === scope) break;
      }
    }
    const roots = [host, ...previews.filter(node => !host.contains(node))];
    let main = host;
    while (main.parentElement && roots.some(node => !main.contains(node))) main = main.parentElement;
    return { main, roots, previews };
  }

  function imageLayerClip(layer, main) {
    let { left, top, right, bottom } = main.getBoundingClientRect();
    for (let parent = layer.parentElement; parent && parent !== main; parent = parent.parentElement) {
      const style = getComputedStyle(parent), rect = parent.getBoundingClientRect();
      if (/(hidden|clip|scroll|auto)/.test(style.overflowX || style.overflow)) { left = Math.max(left, rect.left); right = Math.min(right, rect.right); }
      if (/(hidden|clip|scroll|auto)/.test(style.overflowY || style.overflow)) { top = Math.max(top, rect.top); bottom = Math.min(bottom, rect.bottom); }
    }
    return { left, top, right, bottom, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
  }

  function captureImageScene() {
    const { main, roots, previews } = imageCaptureAreas();
    const queryAreas = selector => [...new Set(roots.flatMap(root => [...(root.matches(selector) ? [root] : []), ...root.querySelectorAll(selector)]))];
    const image = queryAreas('img[alt="LS"]').find(node => captureLayerVisible(node, main));
    if (!image || !image.complete || !image.naturalWidth) throw new Error('图片尚未加载完成');
    const media = queryAreas('img,canvas').filter(layer => {
      if (layer.tagName === 'IMG' && !layer.matches('img[alt="LS"]') && !previews.some(preview => preview === layer || preview.contains(layer))) return false;
      const rect = layer.getBoundingClientRect();
      return captureLayerVisible(layer, main) && rect.width > 0 && rect.height > 0;
    });
    for (const layer of media) {
      if (layer.tagName === 'IMG' && (!layer.complete || !layer.naturalWidth)) throw new Error('裁切预览尚未加载完成，请稍后截图');
    }
    const layers = media.filter(layer => layer.tagName === 'IMG' || layer.width && layer.height);
    for (const preview of previews) {
      const rect = preview.getBoundingClientRect();
      if (captureLayerVisible(preview, main) && rect.width > 0 && rect.height > 0 && !layers.some(layer => preview.contains(layer))) throw new Error('裁切预览尚未加载完成，请稍后截图');
    }
    const clips = new Map(layers.map(layer => [layer, imageLayerClip(layer, main)]));
    const rectangles = layers.map(layer => {
      const rect = layer.getBoundingClientRect(), clip = clips.get(layer);
      return { left: Math.max(rect.left, clip.left), top: Math.max(rect.top, clip.top), right: Math.min(rect.right, clip.right), bottom: Math.min(rect.bottom, clip.bottom) };
    }).filter(rect => rect.right > rect.left && rect.bottom > rect.top);
    if (!rectangles.length) throw new Error('图片画面当前不可见');
    const left = Math.min(...rectangles.map(rect => rect.left)), top = Math.min(...rectangles.map(rect => rect.top));
    const rect = { left, top, width: Math.max(...rectangles.map(rect => rect.right)) - left, height: Math.max(...rectangles.map(rect => rect.bottom)) - top };
    const scale = Math.min(Math.max(1, ...layers.map(layer => (layer.naturalWidth || layer.width) / layer.getBoundingClientRect().width)), 2560 / rect.width, 1440 / rect.height);
    // 原生九宫格、十等分线和安全框是 DOM 边框，不在图片或标注画布中。
    const guides = queryAreas('div').filter(node => {
      if (!captureLayerVisible(node, main)) return false;
      const style = getComputedStyle(node);
      return style.pointerEvents === 'none' && ['Top', 'Right', 'Bottom', 'Left'].some(side => Number.parseFloat(style[`border${side}Width`]) > 0 && !['none', 'hidden'].includes(style[`border${side}Style`]));
    });
    for (const guide of guides) clips.set(guide, imageLayerClip(guide, main));
    const stackingOrder = node => {
      let z = 0;
      for (let parent = node; parent && parent !== main; parent = parent.parentElement) z = Math.max(z, Number.parseInt(getComputedStyle(parent).zIndex, 10) || 0);
      return z;
    };
    return { main, rect, clips, layers: [...layers, ...guides].sort((a, b) => stackingOrder(a) - stackingOrder(b)), width: Math.max(1, Math.round(rect.width * scale)), height: Math.max(1, Math.round(rect.height * scale)) };
  }

  function captureScene() {
    if (!videoTask()) return captureImageScene();
    const main = [...document.querySelectorAll('.lsf-video__main')].find(visible);
    const base = main?.querySelector('.lsf-video-canvas__view canvas');
    if (!main || !base || !base.width || !base.height) throw new Error('没有找到已加载的视频画面');
    // 站点的遮罩画布与原始视频等大，其显示范围正好排除了左右留白。
    const overlays = [...main.children].filter(node => node.tagName === 'CANVAS' && visible(node) && node.width && node.height);
    const frameCanvas = overlays[0];
    const rect = (frameCanvas || base).getBoundingClientRect();
    if (!rect.width || !rect.height) throw new Error('视频画面当前不可见');
    const candidates = [...main.querySelectorAll('canvas')].filter(node => node !== base && visible(node) && node.width && node.height);
    const stackingOrder = node => {
      let z = 0;
      for (let parent = node; parent && parent !== main; parent = parent.parentElement) {
        const value = Number.parseInt(getComputedStyle(parent).zIndex, 10);
        if (Number.isFinite(value)) z = Math.max(z, value);
      }
      return z;
    };
    candidates.sort((a, b) => stackingOrder(a) - stackingOrder(b));
    const naturalScale = frameCanvas ? frameCanvas.width / rect.width : base.width / base.getBoundingClientRect().width;
    const scale = Math.min(naturalScale, 2560 / rect.width, 1440 / rect.height);
    return { main, rect, layers: [base, ...candidates], width: Math.max(1, Math.round(rect.width * scale)), height: Math.max(1, Math.round(rect.height * scale)) };
  }

  const pendingCanvasCaptures = new Map();

  function redrawNativePanorama(canvas, gl) {
    // 原生图片预览在 React hooks 中持有 Three.js 场景、相机和 renderer。
    // 已创建的 WebGL 上下文无法补开 preserveDrawingBuffer；用同一场景和相机
    // 重绘一次，立即复制画面，不触碰取景参数、选中标注或保存操作。
    const key = Object.keys(canvas).find(name => name.startsWith('__reactFiber$') || name.startsWith('__reactInternalInstance$'));
    for (let fiber = canvas[key], depth = 0; fiber && depth < 12; fiber = fiber.return, depth++) {
      const refs = [];
      for (let hook = fiber.memoizedState, index = 0; hook && index < 80; hook = hook.next, index++) {
        const value = hook.memoizedState?.current;
        if (value) refs.push(value);
      }
      const renderer = refs.find(value => value.isWebGLRenderer && value.domElement === canvas && value.getContext?.() === gl);
      if (!renderer) continue;
      const scene = refs.find(value => value.isScene), camera = refs.find(value => value.isCamera);
      if (!scene || !camera) continue;
      if (!scene.children?.length) throw new Error('裁切预览尚未加载完成，请稍后截图');
      renderer.render(scene, camera);
      return true;
    }
    return false;
  }

  function captureWebGLCanvas(canvas, gl, signal) {
    if (pendingCanvasCaptures.has(canvas)) throw new Error('全景截图正在生成，请稍候');
    return new Promise((resolve, reject) => {
      let finished = false, queued = false, timeout;
      const restore = [];
      const finish = (error, snapshot) => {
        if (finished) return;
        finished = true; clearTimeout(timeout);
        signal?.removeEventListener('abort', abort);
        canvas.removeEventListener('webglcontextlost', lost);
        for (const undo of restore.reverse()) undo();
        pendingCanvasCaptures.delete(canvas);
        if (error) reject(error); else resolve(snapshot);
      };
      const abort = () => finish(new DOMException('截图已停止', 'AbortError'));
      const lost = () => finish(new Error('全景画面暂不可用，请等待重新加载后截图'));
      const afterDraw = () => {
        if (finished || queued) return;
        queued = true;
        // 等当前渲染调用栈内的全部绘制结束，再于浏览器展示并清空 WebGL 缓冲区前复制。
        queueMicrotask(() => {
          queued = false;
          if (finished) return;
          if (dead || signal?.aborted) { abort(); return; }
          if (!canvas.isConnected || gl.isContextLost()) { lost(); return; }
          try {
            const snapshot = document.createElement('canvas'); snapshot.width = canvas.width; snapshot.height = canvas.height;
            const context = snapshot.getContext('2d');
            if (!context) throw new Error('浏览器无法创建全景截图');
            context.drawImage(canvas, 0, 0); finish(null, snapshot);
          } catch (error) { finish(error); }
        });
      };
      pendingCanvasCaptures.set(canvas, abort);
      if (dead || signal?.aborted) { abort(); return; }
      canvas.addEventListener('webglcontextlost', lost, { once: true });
      signal?.addEventListener('abort', abort, { once: true });
      try {
        for (const name of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced', 'clear', 'blitFramebuffer']) {
          const original = gl[name]; if (typeof original !== 'function') continue;
          const descriptor = Object.getOwnPropertyDescriptor(gl, name);
          const wrapped = function (...args) { const result = Reflect.apply(original, this, args); afterDraw(); return result; };
          Object.defineProperty(gl, name, { configurable: true, writable: true, value: wrapped });
          restore.push(() => {
            if (gl[name] !== wrapped) return;
            if (descriptor) Object.defineProperty(gl, name, descriptor); else delete gl[name];
          });
        }
        timeout = setTimeout(() => finish(new Error('无法读取当前裁切预览，请刷新标注页面后重试')), 2500);
        if (redrawNativePanorama(canvas, gl)) afterDraw();
      } catch (error) { finish(error); }
    });
  }

  function snapshotSceneLayer(layer, signal) {
    if (layer.tagName === 'CANVAS' && (layer.matches('[data-engine],[class*="panorama-canvas"]') || layer.closest('[class*="panorama-container"]'))) {
      const gl = layer.getContext('webgl2') || layer.getContext('webgl') || layer.getContext('experimental-webgl');
      if (gl?.isContextLost()) throw new Error('全景画面暂不可用，请等待重新加载后截图');
      if (gl && !gl.getContextAttributes()?.preserveDrawingBuffer) return captureWebGLCanvas(layer, gl, signal);
    }
    const snapshot = document.createElement('canvas');
    snapshot.width = layer.naturalWidth || layer.width; snapshot.height = layer.naturalHeight || layer.height;
    const context = snapshot.getContext('2d');
    if (!context) throw new Error('浏览器无法创建截图');
    context.drawImage(layer, 0, 0); return snapshot;
  }

  async function renderFrameScreenshot(scene, reference, signal) {
      // 在开始等待全景绘制前固定其余图层、布局和样式，避免异步等待时混入另一个画面。
      const layers = scene.layers.map(layer => {
        const style = getComputedStyle(layer);
        const guide = !['IMG', 'CANVAS'].includes(layer.tagName);
        const borders = guide ? ['Top', 'Right', 'Bottom', 'Left'].map(side => ({ side, width: Number.parseFloat(style[`border${side}Width`]) || 0, color: style[`border${side}Color`], style: style[`border${side}Style`] })) : [];
        return { image: layer.tagName === 'IMG', rect: layer.getBoundingClientRect(),
          filter: style.filter || 'none', fit: style.objectFit, position: style.objectPosition,
          clip: scene.clips?.get(layer), borders, guide,
          source: guide ? null : snapshotSceneLayer(layer, signal) };
      });
      const sources = await Promise.all(layers.map(layer => layer.source));
      if (dead || signal?.aborted) throw new DOMException('截图已停止', 'AbortError');
      const footer = Math.max(32, Math.round(scene.width / 32));
      const canvas = document.createElement('canvas');
      canvas.width = scene.width; canvas.height = scene.height + footer;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('浏览器无法创建截图');
      ctx.fillStyle = '#efefef'; ctx.fillRect(0, 0, scene.width, scene.height);
      ctx.save(); ctx.beginPath(); ctx.rect(0, 0, scene.width, scene.height); ctx.clip();
      for (const [index, layer] of layers.entries()) {
        const rect = layer.rect, source = sources[index];
        const x = (rect.left - scene.rect.left) * scene.width / scene.rect.width, y = (rect.top - scene.rect.top) * scene.height / scene.rect.height;
        const width = rect.width * scene.width / scene.rect.width, height = rect.height * scene.height / scene.rect.height;
        ctx.save(); ctx.filter = layer.filter;
        if (layer.clip) {
          const clip = layer.clip;
          ctx.beginPath(); ctx.rect((clip.left - scene.rect.left) * scene.width / scene.rect.width, (clip.top - scene.rect.top) * scene.height / scene.rect.height, clip.width * scene.width / scene.rect.width, clip.height * scene.height / scene.rect.height); ctx.clip();
        }
        if (layer.guide) {
          for (const border of layer.borders) {
            if (!border.width || ['none', 'hidden'].includes(border.style)) continue;
            const horizontal = ['Top', 'Bottom'].includes(border.side), thickness = border.width * (horizontal ? scene.height / scene.rect.height : scene.width / scene.rect.width);
            ctx.fillStyle = border.color;
            ctx.fillRect(x + (border.side === 'Right' ? width - thickness : 0), y + (border.side === 'Bottom' ? height - thickness : 0), horizontal ? width : thickness, horizontal ? thickness : height);
          }
        } else if (layer.image && ['contain', 'cover'].includes(layer.fit)) {
          const scale = (layer.fit === 'cover' ? Math.max : Math.min)(width / source.width, height / source.height);
          const drawnWidth = source.width * scale, drawnHeight = source.height * scale;
          const position = layer.position.split(/\s+/).map(value => value.endsWith('%') ? Number.parseFloat(value) / 100 : .5);
          ctx.beginPath(); ctx.rect(x, y, width, height); ctx.clip();
          ctx.drawImage(source, x + (width - drawnWidth) * position[0], y + (height - drawnHeight) * (position[1] ?? .5), drawnWidth, drawnHeight);
        } else ctx.drawImage(source, x, y, width, height);
        ctx.restore();
      }
      ctx.restore();
      ctx.fillStyle = '#17202e'; ctx.fillRect(0, scene.height, scene.width, footer);
      ctx.fillStyle = '#fff'; ctx.textBaseline = 'middle';
      ctx.font = `${Math.max(16, Math.round(footer * .5))}px system-ui, sans-serif`;
      ctx.fillText(`Insta360  |  ${reference === null ? '当前图片' : screenshotTag(reference)}`, 14, scene.height + footer / 2);
      return canvas;
  }

  function canvasPNG(canvas) {
    return new Promise((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('截图导出失败')), 'image/png'));
  }

  function nativeImageSources(host) {
    return new Set([...host.querySelectorAll('img[src]')].map(image => image.getAttribute('src')).filter(Boolean));
  }

  function watchNativeAttachment(textarea, before, signal) {
    const host = inputHost(textarea);
    return new Promise((resolve, reject) => {
      let observer, poll, timeout, finished = false;
      const finish = (error, image) => {
        if (finished) return;
        finished = true;
        observer?.disconnect(); clearInterval(poll); clearTimeout(timeout);
        signal.removeEventListener('abort', abort);
        if (error) reject(error); else resolve(image);
      };
      const abort = () => finish(new DOMException('附图操作已停止', 'AbortError'));
      const check = () => {
        if (signal.aborted || dead) { abort(); return; }
        if (!textarea.isConnected || !host?.isConnected) { finish(new Error('驳回理由框已关闭')); return; }
        const image = [...host.querySelectorAll('img[src]')].find(node => !before.has(node.getAttribute('src')));
        if (image) finish(null, image);
      };
      observer = new MutationObserver(check);
      observer.observe(host, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
      poll = setInterval(check, 250);
      timeout = setTimeout(() => finish(new Error('尚未确认附图，请检查网络及理由框中的图片')), 45000);
      signal.addEventListener('abort', abort, { once: true });
      check();
    });
  }


  const ui = new Map();
  const jobs = new Map();
  const STORAGE = 'i360-review-tools-v3';
  const defaults = { shortcuts: { frame: null, capture: null, annotate: null }, reasons: [], panel: { x: null, y: null }, drawing: { color: '#ff3b30', width: 3, font: 28, background: true } };
  let config;
  try { const saved = JSON.parse(localStorage.getItem(STORAGE) || '{}'); config = { ...defaults, ...saved, shortcuts: { ...defaults.shortcuts, ...saved.shortcuts }, drawing: { ...defaults.drawing, ...saved.drawing } }; }
  catch { config = structuredClone(defaults); }
  if (!Array.isArray(config.reasons)) config.reasons = [];
  config.reasons = config.reasons.filter(r => r && typeof r.id === 'string' && typeof r.text === 'string').slice(0, 200);
  let lastReason = null, settingsDialog = null, snippetsPanel = null, imageEditor = null;

  function saveConfig() {
    try { localStorage.setItem(STORAGE, JSON.stringify(config)); return true; }
    catch { return false; }
  }
  function element(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; }
  function button(text, label = text, className = '') { const node = element('button', className, text); node.type = 'button'; node.setAttribute('aria-label', label); return node; }
  function status(record, text, state = '') { if (record?.status) { record.status.textContent = text; record.status.dataset.state = state; } }
  function activeReason() {
    if (lastReason?.native.isConnected && visible(lastReason.proxy || lastReason.native)) return lastReason;
    return [...ui.values()].find(r => r.native.isConnected && visible(r.proxy || r.native)) || null;
  }
  function selectionOffsets(root, fallback = { start: 0, end: 0 }) {
    const selection = getSelection();
    if (!selection?.rangeCount || !root.contains(selection.anchorNode) || !root.contains(selection.focusNode)) return fallback;
    const range = selection.getRangeAt(0), before = range.cloneRange(); before.selectNodeContents(root); before.setEnd(range.startContainer, range.startOffset);
    const start = before.toString().length; return { start, end: start + range.toString().length };
  }
  function selectionPoint(root, offset) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node, remaining = Math.max(0, offset);
    while ((node = walker.nextNode())) {
      if (remaining <= node.length) {
        const token = node.parentElement?.closest(INLINE_REFERENCE);
        if (token) return { node: token.parentNode, offset: [...token.parentNode.childNodes].indexOf(token) + (remaining > 0 ? 1 : 0) };
        return { node, offset: remaining };
      }
      remaining -= node.length;
    }
    return { node: root, offset: root.childNodes.length };
  }
  function restoreSelection(record, start, end = start, focus = true) {
    record.selection = { start, end }; record.native.setSelectionRange(start, end);
    if (!record.proxy) { if (focus) record.native.focus({ preventScroll: true }); return; }
    if (focus) record.proxy.focus({ preventScroll: true });
    const a = selectionPoint(record.proxy, start), b = selectionPoint(record.proxy, end), range = document.createRange();
    range.setStart(a.node, a.offset); range.setEnd(b.node, b.offset);
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
  }
  function renderReason(record, text, selection, focus = false) {
    if (!record.proxy) return;
    const scroll = record.proxy.scrollTop, fragment = document.createDocumentFragment();
    let last = 0;
    for (const match of text.matchAll(referencePattern())) {
      const reference = matchReference(match);
      if (reference === null) continue;
      fragment.append(document.createTextNode(text.slice(last, match.index)));
      const token = element('span', 'i360-inline-frame', match[0]);
      token.contentEditable = 'false'; token.tabIndex = 0; markReference(token, reference, true);
      token.setAttribute('role', 'link');
      fragment.append(token); last = match.index + match[0].length;
    }
    fragment.append(document.createTextNode(text.slice(last)));
    // A terminal newline needs a trailing line box or Chromium moves the next
    // typed character back onto the preceding line. BR adds no textContent.
    if (text.endsWith('\n')) fragment.append(document.createElement('br'));
    record.proxy.replaceChildren(fragment); record.value = text;
    if (selection) restoreSelection(record, Math.min(text.length, selection.start), Math.min(text.length, selection.end), focus);
    record.proxy.scrollTop = scroll;
  }
  function rememberReason(record) {
    if (record.proxy && !record.composing) record.selection = selectionOffsets(record.proxy, record.selection);
    else if (!record.proxy) record.selection = { start: record.native.selectionStart ?? record.value.length, end: record.native.selectionEnd ?? record.value.length };
    if (record.native.selectionStart !== record.selection.start || record.native.selectionEnd !== record.selection.end) record.native.setSelectionRange(record.selection.start, record.selection.end);
    lastReason = record;
  }
  function pushReasonHistory(record) {
    record.undo.push({ text: record.value, ...record.selection }); if (record.undo.length > 100) record.undo.shift(); record.redo.length = 0;
  }
  function commitReason(record, text, selection, { history = true, focus = true } = {}) {
    if (!record.native.isConnected || record.native.disabled || record.native.readOnly) return;
    if (record.native.maxLength >= 0 && text.length > record.native.maxLength) { status(record, '理由超过长度限制', 'error'); return; }
    if (history && text !== record.value) pushReasonHistory(record);
    record.value = text; record.selection = selection;
    record.syncing = true;
    setNativeValue(record.native, text); inputEvent(record.native, text);
    record.syncing = false;
    if (record.proxy) renderReason(record, text, selection, focus);
    else restoreSelection(record, selection.start, selection.end, focus);
  }
  function insertReasonText(native, text, paragraph = false) {
    const record = ui.get(native);
    const value = native.value;
    const selection = record ? record.selection : { start: native.selectionStart ?? value.length, end: native.selectionEnd ?? value.length };
    let content = text;
    if (paragraph && selection.start > 0 && !/\s$/.test(value.slice(0, selection.start))) content = '\n' + content;
    if (paragraph && selection.end < value.length && !/^\s/.test(value.slice(selection.end))) content += '\n';
    const next = value.slice(0, selection.start) + content + value.slice(selection.end), caret = selection.start + content.length;
    if (record) commitReason(record, next, { start: caret, end: caret });
    else { setNativeValue(native, next); inputEvent(native, content); native.focus({ preventScroll: true }); native.setSelectionRange(caret, caret); }
  }
  function reasonUndo(record, redo = false) {
    const from = redo ? record.redo : record.undo, to = redo ? record.undo : record.redo;
    if (!from.length) return;
    to.push({ text: record.value, ...record.selection }); const previous = from.pop();
    commitReason(record, previous.text, { start: previous.start, end: previous.end }, { history: false });
  }
  function nativePaste(record, clipboardData) {
    record.native.setSelectionRange(record.selection.start, record.selection.end);
    const event = new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true, composed: true });
    record.native.dispatchEvent(event); return event.defaultPrevented;
  }
  function mountRichReason(record) {
    const native = record.native;
    const proxy = element('div', 'i360-rich-reason'); proxy.contentEditable = 'true'; proxy.setAttribute('role', 'textbox');
    proxy.setAttribute('aria-label', '驳回理由'); proxy.setAttribute('aria-multiline', 'true'); proxy.dataset.placeholder = videoTask() ? '填写驳回理由；点击帧号跳转并显示后续文本，支持粘贴图片' : '填写驳回理由；点击标注引用跳转并显示后续文本，支持粘贴图片'; proxy.spellcheck = false;
    record.proxy = proxy; record.originalTabIndex = native.getAttribute('tabindex'); record.originalAriaHidden = native.getAttribute('aria-hidden');
    native.classList.add('i360-native-hidden'); native.tabIndex = -1; native.setAttribute('aria-hidden', 'true'); native.insertAdjacentElement('beforebegin', proxy);
    renderReason(record, native.value);
    proxy.addEventListener('focus', () => { lastReason = record; });
    proxy.addEventListener('beforeinput', event => {
      if (event.inputType === 'insertParagraph' || event.inputType === 'insertLineBreak') { event.preventDefault(); rememberReason(record); insertReasonText(native, '\n'); }
      else if (event.inputType === 'historyUndo' || event.inputType === 'historyRedo') { event.preventDefault(); reasonUndo(record, event.inputType === 'historyRedo'); }
      else if (!record.composing) rememberReason(record);
    });
    proxy.addEventListener('input', () => {
      const text = proxy.textContent, selection = selectionOffsets(proxy, record.selection);
      if (text !== record.value) pushReasonHistory(record);
      record.value = text; record.selection = selection; record.syncing = true; setNativeValue(native, text); inputEvent(native, text); record.syncing = false;
      if (!record.composing) renderReason(record, text, selection, false);
    });
    proxy.addEventListener('compositionstart', () => { record.composing = true; composing.add(native); });
    proxy.addEventListener('compositionend', () => { record.composing = false; composing.delete(native); record.selection = selectionOffsets(proxy, record.selection); renderReason(record, native.value, record.selection, false); });
    proxy.addEventListener('paste', event => {
      event.preventDefault(); event.stopPropagation(); rememberReason(record);
      if ([...event.clipboardData.items].some(item => item.kind === 'file' && item.type.startsWith('image/'))) nativePaste(record, event.clipboardData);
      else insertReasonText(native, event.clipboardData.getData('text/plain').replace(/\r\n?/g, '\n'));
    });
    proxy.addEventListener('pointerdown', event => { if (event.target.closest(INLINE_REFERENCE)) event.preventDefault(); });
    proxy.addEventListener('click', event => {
      const token = event.target.closest(INLINE_REFERENCE);
      if (token) { event.preventDefault(); event.stopPropagation(); rememberReason(record); activateFrameLink(token); }
      else rememberReason(record);
    });
    proxy.addEventListener('keyup', () => rememberReason(record)); proxy.addEventListener('mouseup', () => rememberReason(record));
  }
  const actions = { frame: { get label() { return currentReferenceLabel(); }, run: r => insertCurrentFrame(r.native) }, capture: { label: '一键截图', run: r => captureAndAttach(r.native) }, annotate: { label: '在图片中输入理由', run: r => openImageEditor(r) } };
  function shortcutLabel(action) { return config.shortcuts[action]?.label || '未设置快捷键'; }
  function updateShortcutLabels() {
    for (const record of ui.values()) for (const [key, card] of Object.entries(record.cards)) { card.key.textContent = shortcutLabel(key); card.gear.title = `设置${actions[key].label}快捷键：${shortcutLabel(key)}`; }
  }
  function makeAction(record, key) {
    const action = actions[key], card = element('div', 'i360-action-card');
    const main = button('', action.label, `i360-action-main i360-action-${key}`), label = element('span', 'i360-action-label', action.label), hint = element('kbd', '', shortcutLabel(key));
    main.append(label, hint); main.addEventListener('pointerdown', event => { event.preventDefault(); rememberReason(record); });
    main.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); lastReason = record; action.run(record); });
    const gear = button('⚙', `设置${action.label}快捷键`, 'i360-shortcut-gear'); gear.title = `设置${action.label}快捷键`;
    gear.addEventListener('click', event => { event.stopPropagation(); openShortcutSettings(key); });
    card.append(main, gear); record.cards[key] = { main, label, key: hint, gear }; return card;
  }
  // 原生画面及项目预览可能在 document 捕获阶段处理“点击外部”。
  // 工具按钮只操作理由/截图，按下与松开不能清空当前裁切预览。
  // 提前在 window 隔离这几个事件；click 仍到达按钮并执行原动作。
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
    listen(window, type, event => {
      const target = event.target.closest?.('.i360-action-card,.i360-common-trigger');
      if (!target) return;
      const record = [...ui.values()].find(record => record.toolbar.contains(target) || record.common === target);
      if (!record) return;
      event.stopPropagation();
      if (type.endsWith('down')) { event.preventDefault(); rememberReason(record); }
    }, true);
  }
  function mountUI(native) {
    const host = inputHost(native); if (!host) return;
    const record = { native, host, video: videoTask(), proxy: null, value: native.value, selection: { start: native.selectionStart ?? native.value.length, end: native.selectionEnd ?? native.value.length }, undo: [], redo: [], cards: {}, syncing: false, composing: false };
    ui.set(native, record);
    if (native.matches(REJECT_TEXTAREA)) {
      const common = button('常用驳回理由', '常用驳回理由', 'i360-common-trigger'); common.addEventListener('pointerdown', event => { event.preventDefault(); rememberReason(record); }); common.addEventListener('click', () => openSnippets(record));
      native.insertAdjacentElement('beforebegin', common); record.common = common; mountRichReason(record);
    }
    const toolbar = element('div', 'i360-toolbar'); record.toolbar = toolbar;
    toolbar.append(makeAction(record, 'frame'));
    if (native.matches(REJECT_TEXTAREA)) toolbar.append(makeAction(record, 'capture'), makeAction(record, 'annotate'));
    const output = element('div', 'i360-status'); output.setAttribute('role', 'status'); record.status = output;
    native.insertAdjacentElement('afterend', toolbar); toolbar.insertAdjacentElement('afterend', output);
  }
  function unmountUI(record) {
    jobs.get(record.native)?.abort(); record.proxy?.remove(); record.common?.remove(); record.toolbar.remove(); record.status.remove();
    record.native.classList.remove('i360-native-hidden');
    if (record.originalTabIndex === null) record.native.removeAttribute('tabindex'); else if (record.originalTabIndex !== undefined) record.native.setAttribute('tabindex', record.originalTabIndex);
    if (record.originalAriaHidden === null) record.native.removeAttribute('aria-hidden'); else if (record.originalAriaHidden !== undefined) record.native.setAttribute('aria-hidden', record.originalAriaHidden);
    ui.delete(record.native);
  }
  function scanUI() {
    const supportedTask = videoTask() || !!frameTextDisplayHost();
    for (const record of ui.values()) {
      if (!record.native.isConnected || !record.toolbar.isConnected || !supportedTask || record.video !== videoTask()) { unmountUI(record); continue; }
      if (!record.composing && record.native.value !== record.value) {
        pushReasonHistory(record); record.value = record.native.value;
        renderReason(record, record.native.value, document.activeElement === record.proxy ? record.selection : null, false);
      }
    }
    if (supportedTask) for (const native of document.querySelectorAll(TEXTAREA)) if (!ui.has(native)) mountUI(native);
    if (imageEditor && (!imageEditor.record.native.isConnected || imageEditor.identity !== captureTaskIdentity())) closeImageEditor();
  }
  listen(document, 'selectionchange', () => {
    const record = [...ui.values()].find(r => r.proxy && r.proxy.contains(getSelection()?.anchorNode)); if (record) rememberReason(record);
  });
  listen(document, 'input', event => {
    const record = ui.get(event.target);
    if (record && !record.syncing && !record.composing && record.native.value !== record.value) { pushReasonHistory(record); record.value = record.native.value; renderReason(record, record.value, null); }
  });

  function chord(event) {
    if (['Control', 'Alt', 'Shift', 'Meta', 'AltGraph'].includes(event.key)) return null;
    const key = event.key.length === 1 ? event.key.toUpperCase() : event.key;
    const parts = [event.ctrlKey && 'Ctrl', event.altKey && 'Alt', event.shiftKey && 'Shift', event.metaKey && 'Meta', key].filter(Boolean);
    return { code: event.code, key, ctrl: event.ctrlKey, alt: event.altKey, shift: event.shiftKey, meta: event.metaKey, label: parts.join('+') };
  }
  function sameChord(a, b) { return !!a && !!b && a.code === b.code && a.ctrl === b.ctrl && a.alt === b.alt && a.shift === b.shift && a.meta === b.meta; }
  function closeShortcutSettings() { if (settingsDialog) { settingsDialog.dialog.close(); settingsDialog.dialog.remove(); settingsDialog = null; } }
  function openShortcutSettings(action) {
    closeShortcutSettings();
    const dialog = element('dialog', 'i360-dialog i360-shortcut-dialog'); dialog.setAttribute('aria-label', `设置${actions[action].label}快捷键`);
    const title = element('strong', '', `设置“${actions[action].label}”快捷键`);
    const hint = element('p', '', '点击输入框后按下组合键，建议使用 Ctrl+Alt+字母。');
    const input = element('input'); input.readOnly = true; input.setAttribute('aria-label', '按下新的快捷键'); input.value = shortcutLabel(action);
    const message = element('div', 'i360-status'); message.setAttribute('role', 'status');
    const row = element('div', 'i360-dialog-actions');
    const save = button('保存快捷键'), clear = button('清除快捷键'), cancel = button('取消', '取消快捷键设置');
    const state = { dialog, action, input, message, candidate: config.shortcuts[action], valid: true };
    save.addEventListener('click', () => {
      if (!state.valid) return;
      config.shortcuts[action] = state.candidate;
      if (!saveConfig()) { message.textContent = '浏览器存储不可用，当前设置无法保存'; return; }
      updateShortcutLabels(); closeShortcutSettings();
    });
    clear.addEventListener('click', () => { state.candidate = null; state.valid = true; input.value = '未设置快捷键'; message.textContent = '点击“保存快捷键”后清除'; });
    cancel.addEventListener('click', closeShortcutSettings); dialog.addEventListener('cancel', event => { event.preventDefault(); closeShortcutSettings(); });
    row.append(save, clear, cancel); dialog.append(title, hint, input, message, row); document.body.append(dialog); settingsDialog = state; dialog.showModal(); input.focus();
  }
  function recordShortcut(event) {
    const state = settingsDialog;
    if (!state || document.activeElement !== state.input) return false;
    if (event.key === 'Tab' || event.key === 'Escape') return false;
    event.preventDefault(); event.stopImmediatePropagation();
    const candidate = chord(event); if (!candidate) return true;
    state.valid = false;
    if ((!candidate.ctrl && !candidate.alt && !candidate.meta && !/^F(?:[2-9]|1[0-2])$/.test(candidate.code)) || ['Enter', 'NumpadEnter'].includes(candidate.code)) {
      state.message.textContent = '请使用 Ctrl / Alt / Meta 组合键，或 F2–F12；回车组合键保留给提交操作。'; return true;
    }
    if (((candidate.ctrl || candidate.meta) && ['KeyW', 'KeyT', 'KeyN', 'KeyR', 'KeyL', 'KeyQ'].includes(candidate.code)) || (candidate.alt && candidate.code === 'F4')) {
      state.message.textContent = '该组合键由浏览器使用，请换一个。'; return true;
    }
    const conflict = Object.keys(actions).find(key => key !== state.action && sameChord(config.shortcuts[key], candidate));
    if (conflict) { state.message.textContent = `已被“${actions[conflict].label}”使用，请换一个组合键。`; return true; }
    state.candidate = candidate; state.valid = true; state.input.value = candidate.label; state.message.textContent = '点击“保存快捷键”生效'; return true;
  }

  function closeSnippets() { if (snippetsPanel) { snippetsPanel.resizeObserver?.disconnect(); snippetsPanel.root.remove(); snippetsPanel = null; } }
  function clampPanel(root, x, y) {
    root.style.left = `${Math.max(0, Math.min(x, innerWidth - Math.min(root.offsetWidth, innerWidth)))}px`;
    root.style.top = `${Math.max(0, Math.min(y, innerHeight - Math.min(root.offsetHeight, innerHeight)))}px`;
  }
  function openSnippets(record) {
    if (snippetsPanel) { snippetsPanel.record = record; snippetsPanel.root.focus({ preventScroll: true }); return; }
    const root = element('section', 'i360-snippets'); root.tabIndex = -1; root.setAttribute('role', 'dialog'); root.setAttribute('aria-label', '常用驳回理由');
    const header = element('header', 'i360-snippets-header');
    const title = element('strong', '', '常用驳回理由'), close = button('×', '关闭常用驳回理由'); close.addEventListener('click', closeSnippets); header.append(title, close);
    const hint = element('p', 'i360-panel-hint', '拖动标题栏可移动；点击一条理由即可填入。');
    const add = button('＋ 新增', '新增常用理由', 'i360-primary');
    const quickActions = element('div', 'i360-snippets-actions');
    const frameButton = button(currentReferenceLabel()), captureButton = button('一键截图');
    captureButton.disabled = !record.cards.capture;
    frameButton.title = videoTask() ? '将当前帧号填入驳回理由' : '将左侧当前选中的任意标注填入驳回理由'; captureButton.title = '将当前画面截图附到驳回理由';
    quickActions.append(add, frameButton, captureButton);
    const list = element('div', 'i360-snippets-list'), message = element('div', 'i360-status'); message.setAttribute('role', 'status');
    root.append(header, hint, quickActions, list, message); document.body.append(root);
    const panel = { root, record, list, message, deleted: null, drafts: new Map(), editors: new WeakMap() };
    const targetReason = () => panel.record?.native.isConnected ? panel.record : activeReason();
    for (const control of [frameButton, captureButton]) control.addEventListener('pointerdown', event => {
      event.preventDefault(); const target = targetReason(); if (target) rememberReason(target);
    });
    frameButton.addEventListener('click', () => {
      const target = targetReason(); if (!target) { message.textContent = '请先打开驳回理由输入框'; return; }
      const reference = insertCurrentFrame(target.native);
      message.textContent = reference === null ? missingReferenceMessage() : `已填入${referenceHeading(reference)}`;
    });
    captureButton.addEventListener('click', async () => {
      const target = targetReason(); if (!target) { message.textContent = '请先打开驳回理由输入框'; return; }
      if (jobs.has(target.native)) { message.textContent = '正在附图，请稍候'; return; }
      captureButton.disabled = true; captureButton.textContent = '正在附图…'; message.textContent = '正在生成截图…';
      try { await captureAndAttach(target.native); message.textContent = target.status.textContent; }
      finally { captureButton.disabled = false; captureButton.textContent = '一键截图'; }
    });
    let editorWidth = -1;
    panel.resizeObserver = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width === editorWidth) return; editorWidth = entry.contentRect.width;
      for (const input of panel.list.querySelectorAll('.i360-snippet-edit-input')) panel.editors.get(input)?.resize();
    }); panel.resizeObserver.observe(list);
    snippetsPanel = panel; add.addEventListener('click', () => editSnippet(panel));
    let drag = null;
    header.addEventListener('pointerdown', event => {
      if (event.button !== 0 || event.target.closest('button')) return;
      event.preventDefault(); const rect = root.getBoundingClientRect(); drag = { x: event.clientX - rect.x, y: event.clientY - rect.y }; header.setPointerCapture(event.pointerId);
    });
    header.addEventListener('pointermove', event => { if (drag) clampPanel(root, event.clientX - drag.x, event.clientY - drag.y); });
    const finishDrag = () => { if (!drag) return; drag = null; const rect = root.getBoundingClientRect(); config.panel = { x: rect.x, y: rect.y }; saveConfig(); };
    header.addEventListener('pointerup', finishDrag); header.addEventListener('pointercancel', finishDrag);
    root.addEventListener('keydown', event => event.stopPropagation());
    renderSnippets(panel);
    const anchor = record.common.getBoundingClientRect();
    clampPanel(root, config.panel?.x ?? anchor.left - root.offsetWidth - 20, config.panel?.y ?? anchor.top);
    root.focus({ preventScroll: true });
  }
  function snippetIcon(kind) {
    const ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg');
    for (const [name, value] of Object.entries({ viewBox: '0 0 24 24', width: '14', height: '14', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' })) svg.setAttribute(name, value);
    const path = document.createElementNS(ns, 'path');
    const paths = { edit: 'M14 5l5 5M4 20l5-1L20 8a3.5 3.5 0 0 0-5-5L4 14z', delete: 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7', save: 'M5 12l4 4L19 6', cancel: 'M6 6l12 12M18 6L6 18' };
    path.setAttribute('d', paths[kind]);
    svg.append(path); return svg;
  }
  function renderSnippets(panel) {
    panel.list.replaceChildren();
    if (!config.reasons.length && !panel.drafts.size) panel.list.append(element('p', 'i360-empty', '还没有常用理由，点击“新增”添加。'));
    for (const reason of config.reasons) {
      const draft = panel.drafts.get(reason.id);
      if (draft) { renderSnippetEditor(panel, draft); continue; }
      const row = element('div', 'i360-snippet-item');
      row.dataset.snippetId = reason.id;
      const insert = button(reason.text, `填入常用理由：${reason.text}`, 'i360-snippet-insert'); insert.title = reason.text;
      insert.addEventListener('pointerdown', event => event.preventDefault());
      insert.addEventListener('click', () => {
        const record = panel.record?.native.isConnected ? panel.record : activeReason();
        if (!record) { panel.message.textContent = '请先打开驳回理由输入框'; return; }
        insertReasonText(record.native, reason.text, true); panel.message.textContent = '已填入理由';
      });
      const edit = button('', `编辑常用理由：${reason.text}`), remove = button('', `删除常用理由：${reason.text}`);
      edit.title = '编辑'; remove.title = '删除'; remove.className = 'i360-snippet-delete';
      edit.append(snippetIcon('edit')); remove.append(snippetIcon('delete'));
      edit.addEventListener('click', () => editSnippet(panel, reason));
      remove.addEventListener('click', () => {
        const index = config.reasons.findIndex(r => r.id === reason.id); if (index < 0) return;
        panel.deleted = { reason, index }; config.reasons.splice(index, 1); saveConfig(); renderSnippets(panel);
        panel.message.replaceChildren(document.createTextNode('已删除 ')); const undo = button('撤销', '撤销删除常用理由');
        undo.addEventListener('click', () => { if (!panel.deleted) return; config.reasons.splice(panel.deleted.index, 0, panel.deleted.reason); panel.deleted = null; saveConfig(); renderSnippets(panel); panel.message.textContent = '已恢复'; }); panel.message.append(undo);
      });
      const controls = element('div', 'i360-snippet-controls'); controls.append(edit, remove); row.append(insert, controls); panel.list.append(row);
    }
    for (const draft of panel.drafts.values()) if (!draft.reasonId) renderSnippetEditor(panel, draft);
  }
  function editSnippet(panel, reason = null) {
    if (!reason && config.reasons.length + [...panel.drafts.values()].filter(d => !d.reasonId).length >= 200) { panel.message.textContent = '最多保存 200 条常用理由'; return; }
    const id = reason?.id || crypto.randomUUID();
    if (!panel.drafts.has(id)) panel.drafts.set(id, { id, reasonId: reason?.id || null, text: reason?.text || '' });
    renderSnippets(panel);
    const input = [...panel.list.querySelectorAll('.i360-snippet-edit-input')].find(e => e.closest('[data-snippet-id]').dataset.snippetId === id);
    if (input) {
      input.focus({ preventScroll: true }); input.setSelectionRange(input.value.length, input.value.length);
      const rowRect = input.closest('.i360-snippet-item').getBoundingClientRect(), listRect = panel.list.getBoundingClientRect();
      if (rowRect.bottom > listRect.bottom) panel.list.scrollTop += rowRect.bottom - listRect.bottom;
      else if (rowRect.top < listRect.top) panel.list.scrollTop -= listRect.top - rowRect.top;
    }
  }
  function renderSnippetEditor(panel, draft) {
    const row = element('div', 'i360-snippet-item i360-snippet-editing'); row.dataset.snippetId = draft.id;
    const input = element('textarea', 'i360-snippet-edit-input'); input.rows = 1; input.maxLength = 2000; input.value = draft.text;
    input.setAttribute('aria-label', draft.reasonId ? '编辑常用理由内容' : '新增常用理由内容');
    input.placeholder = '输入常用理由…'; input.title = 'Enter 保存，Shift+Enter 换行，Esc 取消';
    const resize = () => { input.style.height = '0px'; input.style.height = `${Math.max(22, input.scrollHeight)}px`; };
    input.addEventListener('input', () => { draft.text = input.value; resize(); });
    const controls = element('div', 'i360-snippet-controls'), save = button('', '保存常用理由'), cancel = button('', '取消编辑常用理由');
    save.title = '保存（Enter）'; cancel.title = '取消（Esc）'; save.append(snippetIcon('save')); cancel.append(snippetIcon('cancel'));
    const finish = () => { panel.drafts.delete(draft.id); renderSnippets(panel); };
    const saveDraft = () => {
      const text = input.value.trim(); if (!text) { panel.message.textContent = '请输入理由内容'; input.focus(); return; }
      if (draft.reasonId) { const index = config.reasons.findIndex(r => r.id === draft.reasonId); if (index < 0) return; config.reasons[index] = { ...config.reasons[index], text }; }
      else { if (config.reasons.length >= 200) { panel.message.textContent = '最多保存 200 条常用理由'; return; } config.reasons.push({ id: draft.id, text }); }
      panel.message.textContent = saveConfig() ? '已保存' : '存储不可用，刷新后可能丢失'; finish();
    };
    const cancelDraft = () => { panel.message.textContent = ''; finish(); };
    panel.editors.set(input, { save: saveDraft, cancel: cancelDraft, resize });
    save.addEventListener('click', saveDraft); cancel.addEventListener('click', cancelDraft);
    controls.append(save, cancel); row.append(input, controls); panel.list.append(row); resize();
  }
  listen(window, 'resize', () => { if (snippetsPanel) { const r = snippetsPanel.root.getBoundingClientRect(); clampPanel(snippetsPanel.root, r.x, r.y); } });
  listen(window, 'keydown', event => {
    if (dead) return;
    const ownInput = event.target.closest?.('.i360-rich-reason,.i360-snippets,.i360-dialog');
    if (event.isComposing || event.keyCode === 229) { if (ownInput) event.stopImmediatePropagation(); return; }
    if (settingsDialog) { const handled = recordShortcut(event); if (!handled) event.stopImmediatePropagation(); return; }
    if (imageEditor) { imageEditorKey(event); return; }
    const token = event.target.closest?.(INLINE_REFERENCE);
    if (token && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); event.stopImmediatePropagation(); activateFrameLink(token); return; }
    const record = [...ui.values()].find(r => r.proxy && (event.target === r.proxy || r.proxy.contains(event.target)));
    if (record && (event.ctrlKey || event.metaKey) && ['z', 'y'].includes(event.key.toLowerCase())) { event.preventDefault(); event.stopImmediatePropagation(); rememberReason(record); reasonUndo(record, event.key.toLowerCase() === 'y' || event.shiftKey); return; }
    if (event.target.closest?.('.i360-snippets,.i360-dialog')) {
      const editor = snippetsPanel?.editors.get(event.target);
      if (editor && ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Escape')) { event.preventDefault(); if (event.key === 'Escape') editor.cancel(); else editor.save(); }
      event.stopImmediatePropagation(); return;
    }
    if (event.target.closest?.('input,textarea,[contenteditable="true"]') && !record && !ui.has(event.target)) return;
    const incoming = chord(event), key = Object.keys(actions).find(action => sameChord(config.shortcuts[action], incoming));
    // 普通审核流程键交给后面的统一处理；其余编辑键留在富文本输入框中。
    if (!key) {
      const outerReviewKey = record && ['Tab', 'Enter', 'Escape'].includes(event.key)
        && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && !event.repeat;
      if (record && !outerReviewKey) event.stopImmediatePropagation();
      return;
    }
    const target = activeReason(); if (!target?.cards[key] || target.cards[key].main.disabled) return;
    event.preventDefault(); event.stopImmediatePropagation(); if (record) rememberReason(record); actions[key].run(target);
  }, true);
  // Keep the host player's keyboard shortcuts out of our editors, including
  // shortcuts registered on keypress/keyup rather than keydown.
  for (const type of ['keypress', 'keyup']) listen(window, type, event => {
    if (event.target.closest?.('.i360-rich-reason,.i360-snippets,.i360-dialog')) event.stopImmediatePropagation();
  }, true);

  function wrapTextLines(ctx, text, width) {
    const lines = [];
    for (const paragraph of text.replace(/\r\n?/g, '\n').split('\n')) {
      let line = '';
      for (const character of paragraph) { if (line && ctx.measureText(line + character).width > width) { lines.push(line); line = ''; } line += character; }
      lines.push(line);
    }
    return lines;
  }
  function textMetrics(ctx, object, width) {
    ctx.font = `500 ${object.font}px system-ui,sans-serif`;
    const lines = wrapTextLines(ctx, object.text, Math.max(80, Math.min(460, width - object.x - 20)));
    const padding = object.background ? 10 : 0;
    return { lines, padding, lineHeight: Math.ceil(object.font * 1.45), width: Math.max(20, ...lines.map(line => ctx.measureText(line).width)) + padding * 2, height: lines.length * Math.ceil(object.font * 1.45) + padding * 2 };
  }
  function objectBounds(editor, object) {
    if (object.type === 'text') { const m = textMetrics(editor.ctx, object, editor.canvas.width); return { x: object.x, y: object.y, width: m.width, height: m.height }; }
    const points = object.type === 'pen' ? object.points : [{ x: object.x1, y: object.y1 }, { x: object.x2, y: object.y2 }];
    const xs = points.map(p => p.x), ys = points.map(p => p.y);
    return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
  }
  function drawObject(ctx, object, imageWidth) {
    ctx.save(); ctx.strokeStyle = object.color; ctx.fillStyle = object.color; ctx.lineWidth = object.width || 3; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.beginPath();
    if (object.type === 'pen') {
      object.points.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
      if (object.points.length === 1) { const p = object.points[0]; ctx.arc(p.x, p.y, ctx.lineWidth / 2, 0, Math.PI * 2); ctx.fill(); } else ctx.stroke();
    } else if (object.type === 'text') {
      const m = textMetrics(ctx, object, imageWidth);
      if (object.background) { ctx.fillStyle = '#0f172ae6'; ctx.beginPath(); ctx.roundRect(object.x, object.y, m.width, m.height, 6); ctx.fill(); }
      ctx.fillStyle = object.color; ctx.textBaseline = 'top';
      m.lines.forEach((line, i) => ctx.fillText(line, object.x + m.padding, object.y + m.padding + i * m.lineHeight));
    } else if (object.type === 'rect') { ctx.strokeRect(object.x1, object.y1, object.x2 - object.x1, object.y2 - object.y1); }
    else if (object.type === 'ellipse') { ctx.ellipse((object.x1 + object.x2) / 2, (object.y1 + object.y2) / 2, Math.max(.5, Math.abs(object.x2 - object.x1) / 2), Math.max(.5, Math.abs(object.y2 - object.y1) / 2), 0, 0, Math.PI * 2); ctx.stroke(); }
    else {
      ctx.moveTo(object.x1, object.y1); ctx.lineTo(object.x2, object.y2); ctx.stroke();
      if (object.type === 'arrow') {
        const angle = Math.atan2(object.y2 - object.y1, object.x2 - object.x1), size = Math.max(14, object.width * 4);
        ctx.beginPath(); ctx.moveTo(object.x2 - size * Math.cos(angle - Math.PI / 6), object.y2 - size * Math.sin(angle - Math.PI / 6)); ctx.lineTo(object.x2, object.y2); ctx.lineTo(object.x2 - size * Math.cos(angle + Math.PI / 6), object.y2 - size * Math.sin(angle + Math.PI / 6)); ctx.stroke();
      }
    }
    ctx.restore();
  }
  function drawEditor(editor, clean = false, target = editor.ctx) {
    target.clearRect(0, 0, editor.canvas.width, editor.canvas.height); target.drawImage(editor.snapshot, 0, 0);
    target.save(); target.beginPath(); target.rect(0, 0, editor.canvas.width, editor.imageHeight); target.clip();
    for (const object of editor.objects) drawObject(target, object, editor.canvas.width);
    if (editor.pending && !clean) drawObject(target, editor.pending, editor.canvas.width);
    if (!clean && editor.selected) {
      const object = editor.objects.find(o => o.id === editor.selected);
      if (object) { const b = objectBounds(editor, object); target.save(); target.strokeStyle = '#1677ff'; target.lineWidth = 2; target.setLineDash([6, 4]); target.strokeRect(b.x - 5, b.y - 5, b.width + 10, b.height + 10); target.restore(); }
    }
    target.restore();
    editor.undoButton.disabled = !editor.undo.length; editor.redoButton.disabled = !editor.redo.length; editor.deleteButton.disabled = !editor.selected;
    editor.message.textContent = `${screenshotHeading(editor.reference)} · ${editor.objects.length} 个标记 · ${editor.tool === 'select' ? '拖动标记可移动；双击文字可修改' : editor.tool === 'text' ? '点击图片放置文字' : '按住鼠标拖动画线'}`;
  }
  function editorHistory(editor, before = editor.objects) { editor.undo.push(structuredClone(before)); if (editor.undo.length > 50) editor.undo.shift(); editor.redo.length = 0; }
  function editorUndo(editor, redo = false) {
    const from = redo ? editor.redo : editor.undo, to = redo ? editor.undo : editor.redo;
    if (!from.length) return; to.push(structuredClone(editor.objects)); editor.objects = from.pop(); editor.selected = null; drawEditor(editor);
  }
  function editorPoint(editor, event) { const r = editor.canvas.getBoundingClientRect(); return { x: Math.max(0, Math.min(editor.canvas.width, (event.clientX - r.left) * editor.canvas.width / r.width)), y: Math.max(0, Math.min(editor.imageHeight, (event.clientY - r.top) * editor.canvas.height / r.height)) }; }
  function segmentDistance(p, a, b) { const dx = b.x - a.x, dy = b.y - a.y, t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1))); return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy); }
  function hitObject(editor, point) {
    return [...editor.objects].reverse().find(object => {
      if (object.type === 'pen') return object.points.some((p, i, points) => segmentDistance(point, points[Math.max(0, i - 1)], p) < Math.max(10, object.width + 5));
      if (['line', 'arrow'].includes(object.type)) return segmentDistance(point, { x: object.x1, y: object.y1 }, { x: object.x2, y: object.y2 }) < Math.max(10, object.width + 5);
      const b = objectBounds(editor, object); return point.x >= b.x - 6 && point.x <= b.x + b.width + 6 && point.y >= b.y - 6 && point.y <= b.y + b.height + 6;
    });
  }
  function translateObject(object, dx, dy) {
    if (object.type === 'pen') object.points.forEach(p => { p.x += dx; p.y += dy; });
    else if (object.type === 'text') { object.x += dx; object.y += dy; }
    else { object.x1 += dx; object.x2 += dx; object.y1 += dy; object.y2 += dy; }
  }
  function closeTextEntry(editor) { editor.textEntry?.root.remove(); editor.textEntry = null; }
  function commitTextEntry(editor, allowEmpty = false) {
    const entry = editor.textEntry; if (!entry) return true;
    const text = entry.input.value.trim(); if (!text && !allowEmpty) { entry.input.focus(); return false; }
    if (text) {
      editorHistory(editor);
      const object = { id: entry.id || crypto.randomUUID(), type: 'text', x: entry.point.x, y: entry.point.y, text, color: editor.color.value, font: Number(editor.font.value), background: editor.background.checked };
      object.x = Math.max(5, Math.min(object.x, editor.canvas.width - Math.min(460, editor.canvas.width * .5) - 20));
      let m = textMetrics(editor.ctx, object, editor.canvas.width);
      while (m.height > editor.imageHeight - 20 && object.font > 12) { object.font--; m = textMetrics(editor.ctx, object, editor.canvas.width); }
      object.x = Math.max(5, Math.min(object.x, editor.canvas.width - m.width - 5)); object.y = Math.max(5, Math.min(object.y, editor.imageHeight - m.height - 5));
      const index = editor.objects.findIndex(o => o.id === object.id); if (index >= 0) editor.objects[index] = object; else editor.objects.push(object); editor.selected = object.id;
    }
    closeTextEntry(editor); drawEditor(editor); return true;
  }
  function openTextEntry(editor, point, object = null) {
    if (editor.textEntry && !commitTextEntry(editor, true)) return;
    const root = element('div', 'i360-canvas-text-entry'), input = element('textarea'); input.rows = 3; input.maxLength = 400; input.setAttribute('aria-label', '标注文字'); input.placeholder = '输入文字，支持换行…'; input.value = object?.text || '';
    const row = element('div', 'i360-dialog-actions'), save = button('保存文字'), cancel = button('取消', '取消标注文字');
    save.addEventListener('click', () => commitTextEntry(editor)); cancel.addEventListener('click', () => { closeTextEntry(editor); editor.canvas.focus(); });
    row.append(save, cancel); root.append(input, row); editor.stage.append(root); editor.textEntry = { root, input, point, id: object?.id };
    if (object) { editor.color.value = object.color; editor.font.value = String(object.font); editor.background.checked = object.background; }
    positionTextEntry(editor); input.focus();
  }
  function positionTextEntry(editor) {
    if (!editor.textEntry) return;
    const c = editor.canvas.getBoundingClientRect(), stage = editor.stage.getBoundingClientRect(), entry = editor.textEntry;
    const x = c.left - stage.left + entry.point.x * c.width / editor.canvas.width, y = c.top - stage.top + entry.point.y * c.height / editor.canvas.height;
    entry.root.style.left = `${Math.max(0, Math.min(x, editor.stage.clientWidth - entry.root.offsetWidth))}px`; entry.root.style.top = `${Math.max(0, Math.min(y, editor.stage.clientHeight - entry.root.offsetHeight))}px`;
  }
  function selectEditorTool(editor, key) {
    if (editor.textEntry) commitTextEntry(editor, true);
    editor.tool = key; editor.pending = null;
    for (const [tool, btn] of Object.entries(editor.tools)) { btn.setAttribute('aria-pressed', String(tool === key)); }
    editor.canvas.style.cursor = key === 'select' ? 'move' : key === 'text' ? 'text' : 'crosshair'; drawEditor(editor);
  }
  function closeImageEditor() { if (!imageEditor) return; const editor = imageEditor; imageEditor = null; editor.dialog.close(); editor.dialog.remove(); if (editor.record.proxy?.isConnected) editor.record.proxy.focus({ preventScroll: true }); }
  function attachEditorImage() {
    const editor = imageEditor; if (!editor || jobs.has(editor.record.native)) return;
    commitTextEntry(editor, true);
    const canvas = document.createElement('canvas'); canvas.width = editor.canvas.width; canvas.height = editor.canvas.height; drawEditor(editor, true, canvas.getContext('2d'));
    const prepared = { canvas, reference: editor.reference, identity: editor.identity }, native = editor.record.native; closeImageEditor(); void captureAndAttach(native, prepared);
  }
  async function openImageEditor(record) {
    if (jobs.has(record.native)) { status(record, '请等待当前附图完成'); return; }
    closeImageEditor();
    const controller = new AbortController(), identity = captureTaskIdentity(); jobs.set(record.native, controller);
    record.cards.capture.main.disabled = true; record.cards.annotate.main.disabled = true;
    status(record, '正在截取画面…');
    try {
      const scene = captureScene(), reference = currentReference(); if (videoTask() && !validFrame(reference)) throw new Error('无法读取当前帧号');
      const snapshot = await renderFrameScreenshot(scene, reference, controller.signal);
      if (dead || controller.signal.aborted) return;
      if (identity !== captureTaskIdentity()) throw new Error('任务或图像已切换，请重新截图');
      if (!record.native.isConnected || record.native.parentElement !== record.host) throw new Error('驳回理由框已切换，请重试');
      const dialog = element('dialog', 'i360-dialog i360-image-dialog'); dialog.setAttribute('aria-label', '图片标注');
      const heading = element('div', 'i360-editor-heading'), title = element('strong', '', `图片标注 · 已固定${screenshotHeading(reference)}`), close = button('关闭', '关闭图片标注'); close.addEventListener('click', closeImageEditor); heading.append(title, close);
      const toolbar = element('div', 'i360-editor-tools'), stage = element('div', 'i360-editor-stage'), canvas = element('canvas', 'i360-editor-canvas'); canvas.tabIndex = 0; canvas.setAttribute('aria-label', '图片标注画布'); canvas.width = snapshot.width; canvas.height = snapshot.height; stage.append(canvas);
      const message = element('div', 'i360-status'); message.setAttribute('role', 'status');
      const editor = { dialog, record, snapshot, reference, identity, imageHeight: scene.height, canvas, ctx: canvas.getContext('2d'), stage, tools: {}, objects: [], undo: [], redo: [], selected: null, pending: null, drag: null, textEntry: null, message, tool: 'text' };
      for (const [key, label] of Object.entries({ select: '选择/移动', text: '文字', pen: '画笔', line: '直线', arrow: '箭头', rect: '矩形', ellipse: '圆形' })) { const btn = button(label, label, 'i360-tool'); btn.addEventListener('click', () => selectEditorTool(editor, key)); editor.tools[key] = btn; toolbar.append(btn); }
      const color = element('input'); color.type = 'color'; color.value = config.drawing.color; color.setAttribute('aria-label', '标注颜色'); editor.color = color;
      const width = element('select'); width.setAttribute('aria-label', '线宽'); for (const value of [2, 3, 5, 8, 12]) { const o = element('option', '', `${value}px`); o.value = value; width.append(o); } width.value = String(config.drawing.width); editor.width = width;
      const font = element('select'); font.setAttribute('aria-label', '字号'); for (const value of [18, 24, 28, 32, 40, 48]) { const o = element('option', '', `${value}号`); o.value = value; font.append(o); } font.value = String(config.drawing.font); editor.font = font;
      const background = element('input'); background.type = 'checkbox'; background.checked = config.drawing.background; background.setAttribute('aria-label', '文字底色'); editor.background = background; const bgLabel = element('label', 'i360-checkbox'); bgLabel.append(background, document.createTextNode('文字底色'));
      for (const node of [color, width, font, background]) node.addEventListener('change', () => { config.drawing = { color: color.value, width: Number(width.value), font: Number(font.value), background: background.checked }; saveConfig(); });
      toolbar.append(color, width, font, bgLabel);
      const undo = button('撤销', '撤销图片标记'), redo = button('重做', '重做图片标记'), remove = button('删除选中'), clear = button('清空标记'); editor.undoButton = undo; editor.redoButton = redo; editor.deleteButton = remove;
      undo.addEventListener('click', () => editorUndo(editor)); redo.addEventListener('click', () => editorUndo(editor, true)); remove.addEventListener('click', () => { if (!editor.selected) return; editorHistory(editor); editor.objects = editor.objects.filter(o => o.id !== editor.selected); editor.selected = null; drawEditor(editor); }); clear.addEventListener('click', () => { if (!editor.objects.length) return; editorHistory(editor); editor.objects = []; editor.selected = null; drawEditor(editor); });
      const footer = element('div', 'i360-editor-footer'), editActions = element('div', 'i360-dialog-actions'), attach = button('截图并附到理由', '截图并附到理由', 'i360-primary'); attach.addEventListener('click', attachEditorImage); editActions.append(undo, redo, remove, clear, attach); footer.append(message, editActions);
      dialog.append(heading, toolbar, stage, footer); dialog.addEventListener('cancel', event => { event.preventDefault(); closeImageEditor(); });
      canvas.addEventListener('pointerdown', event => {
        if (event.button !== 0) return; event.preventDefault(); canvas.focus(); const p = editorPoint(editor, event);
        if (editor.tool === 'text') { openTextEntry(editor, p); return; }
        if (editor.textEntry) commitTextEntry(editor, true);
        canvas.setPointerCapture(event.pointerId);
        if (editor.tool === 'select') { const object = hitObject(editor, p); editor.selected = object?.id || null; editor.drag = object ? { id: object.id, last: p, before: structuredClone(editor.objects), moved: false } : null; }
        else editor.pending = { id: crypto.randomUUID(), type: editor.tool, color: color.value, width: Number(width.value), x1: p.x, y1: p.y, x2: p.x, y2: p.y, points: [p] };
        drawEditor(editor);
      });
      canvas.addEventListener('pointermove', event => {
        if (!editor.pending && !editor.drag) return; event.preventDefault(); const p = editorPoint(editor, event);
        if (editor.pending) { if (editor.pending.type === 'pen') editor.pending.points.push(p); else { editor.pending.x2 = p.x; editor.pending.y2 = p.y; } }
        else { const object = editor.objects.find(o => o.id === editor.drag.id), b = objectBounds(editor, object); const dx = Math.max(-b.x, Math.min(p.x - editor.drag.last.x, canvas.width - b.x - b.width)), dy = Math.max(-b.y, Math.min(p.y - editor.drag.last.y, editor.imageHeight - b.y - b.height)); translateObject(object, dx, dy); editor.drag.last = p; editor.drag.moved ||= Math.abs(dx) + Math.abs(dy) > 0; }
        drawEditor(editor);
      });
      canvas.addEventListener('pointerup', event => {
        if (editor.pending) { const object = editor.pending; if (object.type === 'pen' || Math.hypot(object.x2 - object.x1, object.y2 - object.y1) > 2) { editorHistory(editor); editor.objects.push(object); editor.selected = object.id; } editor.pending = null; }
        if (editor.drag?.moved) editorHistory(editor, editor.drag.before); editor.drag = null; if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId); drawEditor(editor);
      });
      canvas.addEventListener('pointercancel', () => { if (editor.drag) editor.objects = editor.drag.before; editor.drag = null; editor.pending = null; drawEditor(editor); });
      canvas.addEventListener('dblclick', event => { if (editor.tool !== 'select') return; const object = hitObject(editor, editorPoint(editor, event)); if (object?.type === 'text') openTextEntry(editor, { x: object.x, y: object.y }, object); });
      document.body.append(dialog); imageEditor = editor; dialog.showModal(); selectEditorTool(editor, 'text'); openTextEntry(editor, { x: canvas.width * .5, y: editor.imageHeight * .12 });
      status(record, '');
    } catch (error) { if (!dead && !controller.signal.aborted) status(record, `无法打开图片标注：${error.message}`, 'error'); }
    finally {
      controller.abort(); if (jobs.get(record.native) === controller) jobs.delete(record.native);
      if (record.toolbar.isConnected) { record.cards.capture.main.disabled = false; record.cards.annotate.main.disabled = false; }
    }
  }
  function imageEditorKey(event) {
    const editor = imageEditor; if (!editor) return;
    event.stopImmediatePropagation();
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape') { event.preventDefault(); if (editor.textEntry) closeTextEntry(editor); else closeImageEditor(); }
    else if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); if (editor.textEntry) commitTextEntry(editor); else attachEditorImage(); }
    else if (!event.target.closest('textarea,input,select') && (event.ctrlKey || event.metaKey) && ['z', 'y'].includes(event.key.toLowerCase())) { event.preventDefault(); editorUndo(editor, event.key.toLowerCase() === 'y' || event.shiftKey); }
    else if (!event.target.closest('textarea,input,select') && ['Delete', 'Backspace'].includes(event.key) && editor.selected) { event.preventDefault(); editor.deleteButton.click(); }
  }
  listen(window, 'resize', () => { if (imageEditor) positionTextEntry(imageEditor); });

  function nativeUploading(record) { return !!record.host.querySelector('.ant-upload-list-item-uploading,[aria-busy="true"]') || [...record.host.children].some(node => !node.className?.toString().startsWith('i360-') && /^\s*图片上传中/.test(node.textContent)); }
  async function captureAndAttach(native, prepared = null) {
    const record = ui.get(native);
    if (dead || !record?.cards.capture || jobs.has(native) || !native.isConnected || native.disabled || native.readOnly || !native.matches(REJECT_TEXTAREA)) return;
    if (nativeUploading(record)) { status(record, '请等待当前图片上传完成'); return; }
    const controller = new AbortController(); jobs.set(native, controller);
    record.cards.capture.main.disabled = true; record.cards.annotate.main.disabled = true; record.cards.capture.label.textContent = '正在附图…'; status(record, '正在生成截图…');
    let waiter;
    try {
      const identity = prepared?.identity ?? captureTaskIdentity();
      if (identity !== captureTaskIdentity()) throw new Error('任务或图像已切换，请重新截图');
      const reference = prepared ? prepared.reference : currentReference(); if (videoTask() && !validFrame(reference)) throw new Error('无法读取当前帧号');
      const canvas = prepared?.canvas || await renderFrameScreenshot(captureScene(), reference, controller.signal), blob = await canvasPNG(canvas);
      if (dead || controller.signal.aborted) return;
      if (identity !== captureTaskIdentity()) throw new Error('任务或图像已切换，请重新截图');
      if (!native.isConnected || native.parentElement !== record.host) throw new Error('驳回理由框已切换，请重试');
      const file = new File([blob], `Insta360_${screenshotTag(reference)}_${Date.now()}.png`, { type: 'image/png', lastModified: Date.now() });
      const clipboardData = new DataTransfer(); clipboardData.items.add(file);
      waiter = watchNativeAttachment(native, nativeImageSources(record.host), controller.signal); waiter.catch(() => {});
      status(record, `正在附上${screenshotHeading(reference)}截图…`);
      if (!nativePaste(record, clipboardData)) throw new Error('页面未接收图片，请刷新后重试');
      await waiter; if (!dead && !controller.signal.aborted) status(record, `已附上${screenshotHeading(reference)}截图`, 'success');
    } catch (error) {
      if (!dead && !controller.signal.aborted) status(record, `附图失败：${error.name === 'SecurityError' ? '当前画面不允许导出' : error.message}`, 'error');
    } finally {
      controller.abort(); if (waiter) await waiter.catch(() => {}); if (jobs.get(native) === controller) jobs.delete(native);
      if (record.toolbar.isConnected) { record.cards.capture.main.disabled = false; record.cards.annotate.main.disabled = false; record.cards.capture.label.textContent = '一键截图'; }
    }
  }

  listen(document, 'click', event => {
    const link = event.target.closest?.(`button.${LINK}`);
    if (!link || !link.closest(ROOT)) return;
    event.preventDefault(); event.stopPropagation();
    activateFrameLink(link);
  }, true);
  function discover(force = false) {
    if (dead) return;
    scanUI();
    refreshFrameText();
    for (const [root,state] of roots) if (!root.isConnected) { state.observer.disconnect(); roots.delete(root); }
    for (const root of document.querySelectorAll(ROOT)) {
      let state = roots.get(root);
      if (!state) { state = { pending:new Set(), observer:null }; state.observer = new MutationObserver(records => { collect(state,records); schedule(); }); state.observer.observe(root,{childList:true,characterData:true,subtree:true}); roots.set(root,state); state.pending.add(root); }
      else if (force) state.pending.add(root);
    }
    if ([...roots.values()].some(state => state.pending.size)) schedule();
  }
  const style = document.createElement('style'); style.dataset.instaCommentFrameLinks = '3.1.7';
  style.textContent = ".i360-native-hidden{display:none!important}\n.i360-rich-reason{box-sizing:border-box;display:block;min-height:112px;max-height:320px;overflow:auto;resize:vertical;white-space:pre-wrap;overflow-wrap:anywhere;width:100%;padding:12px;border:1px solid #d9d9d9;border-radius:5px;background:#fff;color:#17202e;font:14px/1.65 system-ui,sans-serif;outline:none;cursor:text}\n.i360-rich-reason:focus{border-color:#1677ff;box-shadow:0 0 0 2px #1677ff18}\n.i360-rich-reason:empty:before{content:attr(data-placeholder);color:#8a94a3;pointer-events:none}\n.i360-inline-frame{display:inline;color:#1677ff;text-decoration:underline;text-underline-offset:2px;cursor:pointer;border-radius:3px;background:#1677ff0a}\n.i360-inline-frame:hover{background:#1677ff20}\n.i360-inline-frame:focus-visible{outline:2px solid #1677ff}\n.i360-common-trigger{display:block;box-sizing:border-box;width:100%;padding:8px 12px;margin:0 0 9px;border:1px solid #cbdcf5;border-radius:6px;background:#f3f7fd;color:#17467c;text-align:left;cursor:pointer;font:600 13px/1.5 system-ui,sans-serif}\n.i360-toolbar{display:flex;flex-wrap:wrap;gap:7px;margin-top:9px;align-items:stretch}\n.i360-action-card{position:relative;flex:1 0 auto;min-width:76px}\n.i360-action-main{box-sizing:border-box;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;width:100%;height:50px;padding:6px 20px 5px 9px;border:1px solid #c9d7eb;border-radius:6px;background:#fff;color:#17467c;font:13px/1.3 system-ui,sans-serif;cursor:pointer}\n.i360-action-main kbd{font:10px/1.2 system-ui,sans-serif;color:#7a879b}\n.i360-action-capture{background:#1677ff;border-color:#1677ff;color:#fff}\n.i360-action-capture kbd{color:#dbeafe}\n.i360-action-annotate{border-color:#e1c17b;background:#fffbeb;color:#92400e}\n.i360-action-main:disabled{opacity:.55;cursor:wait}\n.i360-shortcut-gear{position:absolute;right:3px;top:3px;display:flex;align-items:center;justify-content:center;width:18px;height:18px;padding:0;border:0;border-radius:3px;background:#fff9;color:#536176;font:13px/1 system-ui,sans-serif;cursor:pointer}\n.i360-shortcut-gear:hover{background:#dbeafe;color:#0958d9}\n.i360-status{font:12px/1.5 system-ui,sans-serif;color:#536176;margin:7px 0 0;overflow-wrap:anywhere}\n.i360-status:empty{display:none}\n.i360-status[data-state=success]{color:#237804}\n.i360-status[data-state=error]{color:#cf1322}\n.i360-dialog{box-sizing:border-box;position:fixed;inset:0;margin:auto;padding:18px;border:1px solid #dce2ec;border-radius:12px;background:#fff;color:#17202e;font:14px/1.5 system-ui,sans-serif;box-shadow:0 14px 70px #0005;max-width:95vw;max-height:94vh;overflow:auto}\n.i360-dialog::backdrop{background:#0b122b80}\n.i360-dialog button,.i360-snippets button{padding:6px 10px;border:1px solid #cbd5e1;border-radius:5px;background:#fff;color:#17202e;font:13px/1.4 system-ui,sans-serif;cursor:pointer}\n.i360-dialog button:hover,.i360-snippets button:hover{background:#eff6ff;border-color:#1677ff}\n.i360-dialog button:disabled{opacity:.4;cursor:default}\n.i360-dialog input:not([type=color]):not([type=checkbox]),.i360-dialog textarea,.i360-snippets textarea{box-sizing:border-box;width:100%;padding:10px;border:1px solid #cbd5e1;border-radius:5px;color:#17202e;background:#fff;font:14px/1.6 system-ui,sans-serif}\n.i360-dialog-actions{display:flex;flex-wrap:wrap;gap:7px;margin-top:9px}\n.i360-primary{background:#1677ff!important;color:#fff!important;border-color:#1677ff!important}\n.i360-shortcut-dialog{width:420px}\n.i360-shortcut-dialog p{font-size:13px;color:#536176}\n.i360-snippets{position:fixed;z-index:2147482000;box-sizing:border-box;width:320px;min-width:220px;max-width:94vw;max-height:84vh;overflow:auto;resize:both;padding:12px;border:1px solid #cbd5e1;border-radius:10px;background:#fff;color:#17202e;box-shadow:0 8px 36px #0003;font:13px/1.5 system-ui,sans-serif;outline:none}\n.i360-snippets-header{display:flex;align-items:center;justify-content:space-between;gap:8px;cursor:move;touch-action:none;user-select:none}\n.i360-snippets-header button{padding:0 7px;font-size:20px}\n.i360-panel-hint,.i360-empty{font-size:12px;color:#7b8799;margin:7px 0}\n.i360-snippets-actions{display:flex;align-items:center;flex-wrap:wrap;gap:6px}.i360-snippets-actions button{white-space:nowrap}.i360-snippets-actions button:disabled{opacity:.55;cursor:wait}\n.i360-snippets-list{display:flex;flex-direction:column;gap:5px;margin-top:8px;max-height:42vh;overflow:auto}\n.i360-snippet-item{display:flex;align-items:flex-start;gap:5px;flex:0 0 auto;box-sizing:border-box;min-width:0;border:1px solid #e0e7f0;border-radius:5px;padding:4px 5px;background:#f9fbfe}\n.i360-snippets button.i360-snippet-insert{display:block;flex:1 1 0;min-width:0;width:auto;height:auto;min-height:22px;box-sizing:border-box;border:0;background:transparent;text-align:left;white-space:pre-wrap;overflow-wrap:anywhere;padding:1px 2px;color:#17467c;line-height:20px}\n.i360-snippet-controls{display:flex;flex:0 0 auto;align-items:center;gap:2px;margin:0}\n.i360-snippet-controls button{display:flex;align-items:center;justify-content:center;box-sizing:border-box;width:22px;height:22px;padding:0;border-color:transparent;background:transparent;color:#738197}.i360-snippet-controls button svg{display:block;pointer-events:none}.i360-snippet-controls button:hover{background:#e6efff;color:#1677ff}.i360-snippet-controls button.i360-snippet-delete:hover{background:#fff1f0;border-color:#ffccc7;color:#cf1322}.i360-snippet-controls button:focus-visible{outline:2px solid #1677ff;outline-offset:1px}\n.i360-snippet-editing{border-color:#91baff;background:#fff}.i360-snippets textarea.i360-snippet-edit-input{flex:1 1 0;min-width:0;width:0;min-height:22px;box-sizing:border-box;margin:0;padding:1px 2px;border:0;border-radius:2px;background:transparent;font:13px/20px system-ui,sans-serif;color:#17467c;resize:none;overflow:hidden;outline:none}.i360-snippet-editing:focus-within{box-shadow:0 0 0 2px #1677ff15}.i360-snippet-editing .i360-snippet-controls button:first-child{color:#1677ff}\n.i360-image-dialog{width:1120px;padding:14px}\n.i360-editor-heading{display:flex;justify-content:space-between;align-items:center;margin-bottom:9px}\n.i360-editor-tools{display:flex;flex-wrap:wrap;align-items:center;gap:5px;padding:8px;border:1px solid #e1e8f0;border-radius:6px;background:#f6f8fc;margin-bottom:8px}\n.i360-editor-tools button{padding:5px 8px}\n.i360-editor-tools button[aria-pressed=true]{background:#1677ff;color:#fff;border-color:#1677ff}\n.i360-editor-tools input[type=color]{box-sizing:border-box;width:32px;height:29px;padding:2px;border:1px solid #cbd5e1;border-radius:4px}\n.i360-editor-tools select{height:29px;border:1px solid #cbd5e1;border-radius:4px;background:#fff;color:#17202e;font:12px system-ui,sans-serif}\n.i360-checkbox{display:inline-flex;align-items:center;gap:4px;font-size:12px}\n.i360-editor-stage{position:relative;display:flex;justify-content:center;align-items:center;overflow:hidden;background:#e8edf3;min-height:100px;border-radius:6px}\n.i360-editor-canvas{display:block;max-width:100%;max-height:62vh;width:auto;height:auto;touch-action:none;outline:none}\n.i360-editor-footer{display:flex;flex-wrap:wrap;justify-content:space-between;gap:8px;align-items:center}\n.i360-editor-footer .i360-dialog-actions{margin-top:6px}\n.i360-canvas-text-entry{position:absolute;box-sizing:border-box;width:min(290px,90%);padding:8px;border:1px solid #fbbf24;border-radius:7px;background:#17202ef5;box-shadow:0 5px 25px #0005}\n.i360-canvas-text-entry textarea{font-size:16px!important;resize:vertical;max-height:25vh}\n.i360-comment-frame-link{display:inline;border:0;background:transparent;color:#1677ff;text-decoration:underline;cursor:pointer;font:inherit;padding:0}\n.i360-frame-text-overlay{position:absolute;z-index:2147481000;left:12px;right:12px;bottom:12px;box-sizing:border-box;display:grid;grid-template-columns:1fr auto;gap:3px 10px;max-height:38%;overflow:auto;padding:10px 12px;border:1px solid #8ab4ff;border-radius:8px;background:#17202eed;color:#fff;box-shadow:0 6px 24px #0005;font:14px/1.6 system-ui,sans-serif;white-space:pre-wrap;overflow-wrap:anywhere}\n.i360-frame-text-overlay[hidden]{display:none}\n.i360-frame-text-heading{grid-column:1;color:#bfdbfe;font-size:12px}\n.i360-frame-text-body{grid-column:1 / -1;min-width:0}\n.i360-frame-text-close{grid-column:2;grid-row:1;align-self:start;padding:0 5px!important;border:0!important;background:transparent!important;color:#dbeafe!important;font-size:18px!important;line-height:1!important}\n.i360-frame-text-close:hover{color:#fff!important;background:#ffffff20!important}\n";
  let discovery;
  function startUI() {
    if (dead) return;
    (document.head || document.documentElement).append(style);
    discovery = setInterval(() => discover(), 1000);
    discover();
  }
  // 审核快捷键通过此接口访问可见编辑框，避免操作被隐藏的原生 textarea。
  const reviewBridge = {
    hasActiveDialog: () => !!settingsDialog || !!imageEditor,
    editorFor: native => ui.get(native)?.proxy || native,
    focusReason(native, selectAll = false) {
      discover();
      const record = ui.get(native);
      if (!record) { native.focus(); if (selectAll) native.select(); return; }
      lastReason = record;
      restoreSelection(record, selectAll ? 0 : record.selection.start, selectAll ? record.value.length : record.selection.end);
    },
    setReason(native, text) {
      const record = ui.get(native);
      if (!record) return false;
      commitReason(record, text, { start: text.length, end: text.length });
      return true;
    },
    canSubmitReason(native) {
      const record = ui.get(native);
      if (native.disabled || native.readOnly || record?.composing) return false;
      if (record && (jobs.has(native) || nativeUploading(record))) {
        status(record, '请等待当前图片上传完成'); return false;
      }
      if (record?.proxy && record.proxy.textContent !== native.value) {
        commitReason(record, record.proxy.textContent, selectionOffsets(record.proxy, record.selection), { focus: false });
      }
      return true;
    },
  };
  const api = { version:'3.1.7', review: reviewBridge, extractTrailingFrameText, scan:()=>discover(true), destroy() {
    if (dead) return; dead = true; ++seekId; clearInterval(discovery); cancelAnimationFrame(renderId); cancelAnimationFrame(centerId);
    restorePanoramaContext();
    closeImageEditor(); closeShortcutSettings(); closeSnippets(); jobs.forEach(controller=>controller.abort()); jobs.clear();
    pendingCanvasCaptures.forEach(abort=>abort()); pendingCanvasCaptures.clear();
    listeners.splice(0).forEach(remove=>remove()); roots.forEach(state=>state.observer.disconnect()); roots.clear(); clearFrameText();
    for (const record of [...ui.values()]) unmountUI(record);
    document.querySelectorAll(`.${LINK}`).forEach(link=>link.replaceWith(document.createTextNode(link.textContent || ''))); style.remove(); if(window[KEY]===api)delete window[KEY];
  }};
  window[KEY] = api;
  if (document.readyState === 'loading') listen(document, 'DOMContentLoaded', startUI, { once: true });
  else startUI();
})();

(function () {
    'use strict';
    if (window.__fcMerged) return;
    window.__fcMerged = true;
    const listeners = [], timers = new Set(), intervals = new Set();
    let destroyed = false, mountObserver = null;
    function listen(target, type, handler, options) {
        target.addEventListener(type, handler, options);
        listeners.push(() => target.removeEventListener(type, handler, options));
    }
    function later(fn, ms) {
        const id = window.setTimeout(() => { timers.delete(id); if (!destroyed) fn(); }, ms);
        timers.add(id); return id;
    }
    function every(fn, ms) {
        const id = window.setInterval(() => { if (!destroyed) fn(); }, ms);
        intervals.add(id); return id;
    }
    const commentTools = () => window.__INSTA_COMMENT_FRAME_LINKS__;
    const textOf = node => trimAllSpace(node?.innerText || node?.textContent);
    const editorFor = native => commentTools()?.review?.editorFor(native) || native;
    const ownPanel = target => target?.closest?.('.i360-dialog,.i360-snippets,#reject-history-dropdown');
    const hasToolDialog = () => commentTools()?.review?.hasActiveDialog() || !!document.querySelector('.i360-dialog[open]');
    const editing = target => !!target?.closest?.('input,textarea,select,[contenteditable]:not([contenteditable="false"])');

    /* ============================================================
     * 0. 共享状态
     * ============================================================ */
    const STORAGE_KEY = 'fc-mini-rightclick-enabled';
    const TOGGLE_ID = 'fc-mini-rightclick-toggle';
    let rightClickEnabled = readRightClickEnabled();

    let lastMouseDownButton = -1;
    let lastMouseDownTime = 0;

    listen(document, 'mousedown', e => {
        lastMouseDownButton = e.button;
        lastMouseDownTime = performance.now();
    }, true);
    listen(document, 'pointerdown', e => {
        lastMouseDownButton = e.button;
        lastMouseDownTime = performance.now();
    }, true);

    /* ============================================================
     * 1. 通用工具
     * ============================================================ */
    function readRightClickEnabled() {
        try {
            const v = localStorage.getItem(STORAGE_KEY);
            return v === null ? true : v === 'true';
        } catch (e) { return true; }
    }
    function saveRightClickEnabled(v) {
        rightClickEnabled = v;
        try { localStorage.setItem(STORAGE_KEY, String(v)); } catch (e) {}
        syncToggleState();
    }
    function isVisible(el) {
        if (!el) return false;
        const r = el.getClientRects();
        return r.length > 0 && r[0].width > 0 && r[0].height > 0;
    }
    function isEnabledButton(btn) {
        return !btn.disabled && btn.getAttribute('aria-disabled') !== 'true';
    }
    function trimAllSpace(str) {
        return (str || '').replace(/\s+/g, '');
    }
    function simulateFullClick(el) {
        if (!el) return;
        const opts = { bubbles: true, cancelable: true, button: 0 };
        el.dispatchEvent(new MouseEvent('mousedown', opts));
        el.dispatchEvent(new MouseEvent('mouseup', opts));
        el.dispatchEvent(new MouseEvent('click', { ...opts, detail: 1 }));
    }

    /* ============================================================
     * 2. 按钮查找（精确选择器 → 文本精确匹配 → 模糊兜底）
     * ============================================================ */
    const PRECISE_SELECTORS = {
        submit: [
            '[data-testid="submit-annotation"]',
            '[data-qa="submit-annotation"]',
            'button[type="submit"][aria-label*="Submit" i]',
            'button[type="submit"][aria-label*="提交"]'
        ],
        update: [
            '[data-testid="update-annotation"]',
            '[data-qa="update-annotation"]',
            'button[aria-label*="Update" i]',
            'button[aria-label*="更新"]'
        ],
        pass: [
            '[data-testid="approve-annotation"]',
            '[data-qa="approve-annotation"]',
            '[data-testid="pass-annotation"]',
            'button[aria-label*="Approve" i]',
            'button[aria-label*="通过"]'
        ]
    };

    function getAllEnabledButtons() {
        return Array.from(document.querySelectorAll('button'))
            .filter(b => isVisible(b) && isEnabledButton(b));
    }

    function matchByText(action, buttons) {
        for (const b of buttons) {
            const t = trimAllSpace(b.innerText);
            if (action === 'submit') {
                if (t === '提交' || t === '提交标注' || t === 'Submit') return b;
                if (t.includes('提交') && !t.includes('驳回') && !t.includes('草稿') && !t.includes('Draft')) return b;
            } else if (action === 'update') {
                if (t === '更新' || t === 'Update') return b;
            } else if (action === 'pass') {
                if (t === '修复并通过' || t === '通过' || t === 'Approve') return b;
            }
        }
        return null;
    }

    const FUZZY = {
        submit: { kw: ['submit', '提交'], ex: ['draft', '草稿', 'save', '保存草稿', '驳回'] },
        update: { kw: ['update', '更新'], ex: ['draft', '草稿', 'save', '保存草稿'] },
        pass:   { kw: ['pass', 'approve', '通过', '批准'], ex: ['reject', '拒绝', '驳回'] }
    };

    function findActionButton(action) {
        // 1. 精确选择器
        for (const sel of (PRECISE_SELECTORS[action] || [])) {
            try {
                for (const b of document.querySelectorAll(sel)) {
                    if (isVisible(b) && isEnabledButton(b)) return b;
                }
            } catch (e) {}
        }
        // 2. 文本精确匹配（最可靠，LabelStudio 实际使用）
        const all = getAllEnabledButtons();
        const byText = matchByText(action, all);
        if (byText) return byText;
        // 3. 模糊兜底
        const f = FUZZY[action];
        if (!f) return null;
        for (const b of all) {
            const combined = [
                b.getAttribute('aria-label'),
                b.textContent,
                b.getAttribute('title'),
                b.getAttribute('data-testid'),
                b.getAttribute('data-qa')
            ].map(x => String(x || '').replace(/\s+/g, '').toLowerCase()).join(' ');
            if (!f.kw.some(kw => combined.includes(kw.toLowerCase()))) continue;
            if (f.ex.some(kw => combined.includes(kw.toLowerCase()))) continue;
            return b;
        }
        return null;
    }

    /* 审核相关按钮（含修复并通过优先） */
    function getBtn(type) {
        const all = getAllEnabledButtons();
        if (type === 'autoPass' || type === 'pass') {
            let b = all.find(x => trimAllSpace(x.innerText).includes('修复并通过'));
            if (b) return b;
            b = all.find(x => trimAllSpace(x.innerText) === '通过');
            if (b) return b;
            return findActionButton('pass');
        }
        if (type === 'reject')      return all.find(x => trimAllSpace(x.innerText) === '驳回');
        if (type === 'cancel')      return all.find(x => trimAllSpace(x.innerText) === '取消');
        if (type === 'submitReject')return all.find(x => trimAllSpace(x.innerText) === '提交驳回');
        if (type === 'update')      return findActionButton('update');
        return null;
    }

    /* 是否处于审核模式（有驳回按钮 = 审核页） */
    function isReviewMode() {
        return getAllEnabledButtons().some(b => {
            const t = trimAllSpace(b.innerText);
            return t === '驳回' || t === '拒绝' || t === 'Reject';
        });
    }

    /* ============================================================
     * 3. 驳回历史持久化
     * ============================================================ */
    const HISTORY_STORE_KEY = 'reject_reason_history_list';
    const MAX_HISTORY_COUNT = 5;
    const DROPDOWN_MAX_HEIGHT = 160;
    let historyDropdownEl = null;
    let historySummaryEl = null, historyListEl = null, historySignature = null;
    let currentTextarea = null;

    function getRejectHistory() {
        try {
            // 与评论工具一样使用页面本地存储，保持页面注入模式以支持全景截图。
            const raw = localStorage.getItem(HISTORY_STORE_KEY) || '[]';
            const arr = JSON.parse(raw);
            return Array.isArray(arr) ? arr.filter(x => typeof x === 'string').slice(0, MAX_HISTORY_COUNT) : [];
        } catch (e) { return []; }
    }
    function saveRejectHistory(list) {
        try { localStorage.setItem(HISTORY_STORE_KEY, JSON.stringify(list)); } catch (e) {}
    }
    function addRejectHistory(text) {
        const val = (text || '').trim();
        if (!val) return;
        let list = getRejectHistory().filter(x => x !== val);
        list.unshift(val);
        if (list.length > MAX_HISTORY_COUNT) list = list.slice(0, MAX_HISTORY_COUNT);
        saveRejectHistory(list);
    }
    function removeSingleHistory(text) {
        try {
            saveRejectHistory(getRejectHistory().filter(x => x !== text));
            renderHistoryDropdown();
        } catch (e) {}
    }
    function clearAllHistory() {
        try { saveRejectHistory([]); renderHistoryDropdown(); } catch (e) {}
    }

    function createDropdownElement() {
        if (!document.body || historyDropdownEl) return;
        const wrap = document.createElement('details');
        wrap.id = 'reject-history-dropdown';
        wrap.style.cssText = `
            position: static; box-sizing: border-box; width: 100%; min-width: 0;
            margin-top: 9px; border-top: 1px solid #e5eaf1; clear: both;
            grid-column: 1 / -1; flex: 0 0 100%; color: #536176;
        `;
        const summary = document.createElement('summary');
        summary.style.cssText = 'padding:7px 2px;cursor:pointer;font:12px/1.6 system-ui,sans-serif;user-select:none;';
        const list = document.createElement('div');
        list.style.cssText = `box-sizing:border-box;max-height:${DROPDOWN_MAX_HEIGHT}px;overflow-y:auto;overflow-x:hidden;padding:5px;border:1px solid #e1e8f0;border-radius:6px;background:#f8fafc;`;
        wrap.append(summary, list);
        historyDropdownEl = wrap;
        historySummaryEl = summary; historyListEl = list;
        listen(summary, 'click', () => renderHistoryDropdown());
    }

    function setReactTextareaValue(el, value) {
        if (!el) return;
        if (commentTools()?.review?.setReason(el, value)) return;
        el.focus();
        const oldVal = el.value;
        const proto = Object.getPrototypeOf(el);
        const desc = Object.getOwnPropertyDescriptor(proto, 'value');
        if (desc && desc.set) desc.set.call(el, value);
        else el.value = value;
        if (el._valueTracker && typeof el._valueTracker.setValue === 'function') {
            el._valueTracker.setValue(oldVal);
        }
        el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
        el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
    }

    function renderHistoryDropdown() {
        if (!document.body) return;
        if (!historyDropdownEl) createDropdownElement();
        const wrap = historyListEl;
        if (!wrap) return;
        const list = getRejectHistory();
        const signature = JSON.stringify(list);
        if (historySignature === signature) return;
        historySignature = signature;
        historySummaryEl.textContent = `历史记录（${list.length}）`;
        wrap.replaceChildren();
        if (!list.length) {
            wrap.innerHTML = '<div style="padding:10px 6px;color:#999;text-align:center">暂无驳回历史</div>';
            return;
        }
        list.forEach(text => {
            const item = document.createElement('div');
            item.style.cssText = `
                display: flex; justify-content: space-between; align-items: center;
                gap: 5px; padding: 3px 4px; border-radius: 4px;
                margin-bottom: 4px; min-width: 0; font-size: 13px;
            `;
            item.onmouseover = () => item.style.background = '#f0f7ff';
            item.onmouseout = () => item.style.background = 'transparent';
            const ts = document.createElement('button');
            ts.type = 'button'; ts.className = 'i360-history-insert';
            ts.textContent = text;
            ts.style.cssText = 'flex:1;min-width:0;padding:4px;border:0;background:transparent;color:#354b63;text-align:left;white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.6 system-ui,sans-serif;cursor:pointer;';
            const del = document.createElement('button');
            del.type = 'button'; del.setAttribute('aria-label', `删除历史记录：${text}`);
            del.textContent = '×';
            del.style.cssText = 'flex:none;color:#d14c50;padding:2px 6px;border:0;background:transparent;font:16px/1.4 system-ui,sans-serif;cursor:pointer;';
            del.onclick = ev => { ev.stopPropagation(); removeSingleHistory(text); };
            item.appendChild(ts);
            item.appendChild(del);
            ts.onclick = () => {
                if (!currentTextarea) return;
                hideHistory();
                setReactTextareaValue(currentTextarea, text);
            };
            wrap.appendChild(item);
        });
        const clear = document.createElement('button');
        clear.type = 'button'; clear.setAttribute('aria-label', '清空全部历史');
        clear.textContent = '清空全部历史';
        clear.style.cssText = `
            display:block;width:100%;margin-top:4px;text-align:center;color:#497caf;
            font:12px/1.6 system-ui,sans-serif;padding:5px;cursor:pointer;border:0;border-top:1px solid #e5eaf1;background:transparent;
        `;
        clear.onclick = clearAllHistory;
        wrap.appendChild(clear);
    }

    function mountHistory(targetTa = findRejectModal()?.textarea) {
        if (!targetTa?.isConnected) { hideHistory(); return; }
        if (!historyDropdownEl) createDropdownElement();
        const wrap = historyDropdownEl;
        if (!wrap) return;
        if (currentTextarea !== targetTa) { hideHistory(); currentTextarea = targetTa; }
        const host = targetTa.parentElement;
        const anchor = [...host.children].find(node => node.matches('.i360-status')) || editorFor(targetTa);
        if (wrap.parentElement !== host || wrap.previousElementSibling !== anchor) anchor.insertAdjacentElement('afterend', wrap);
        renderHistoryDropdown();
    }

    /* ============================================================
     * 4. 审核流程
     * ============================================================ */
    // 仅依据真实驳回输入框及其所属提交区判断弹窗，避免把任意“取消”按钮当成驳回。
    function findRejectModal() {
        for (const textarea of document.querySelectorAll('textarea[placeholder*="驳回理由"]')) {
            if (!isVisible(editorFor(textarea))) continue;
            for (let root = textarea.parentElement; root; root = root.parentElement) {
                const buttons = [...root.querySelectorAll('button')].filter(b => isVisible(b) && !ownPanel(b));
                const submit = buttons.find(b => ['提交驳回', '确认驳回'].includes(textOf(b)));
                if (submit) return { textarea, root, submit, cancel: buttons.find(b => ['取消', 'Cancel'].includes(textOf(b))) };
                if (root.matches('[role="dialog"],.ant-modal-content,.lsf-modal')) break;
            }
        }
        return null;
    }
    function isRejectModalOpen() { return !!findRejectModal(); }
    function hideHistory() { if (historyDropdownEl) historyDropdownEl.open = false; }
    function manualEnterSubmit(modal = findRejectModal()) {
        if (!modal) return;
        const { submit: submitBtn, textarea: ta } = modal;
        if (ta.disabled || ta.readOnly || commentTools()?.review?.canSubmitReason(ta) === false) return;
        const content = ta.value.trim();
        // 始终尊重原生表单校验和上传状态，不强制启用按钮。
        if (!content || !isEnabledButton(submitBtn)) return;
        addRejectHistory(content);
        hideHistory();
        simulateFullClick(submitBtn);
    }
    function focusRejectInput(attempt = 0) {
        later(() => {
            commentTools()?.scan();
            const modal = findRejectModal();
            if (!modal) { if (attempt < 10) focusRejectInput(attempt + 1); return; }
            const ta = modal.textarea;
            if (commentTools()?.review) commentTools().review.focusReason(ta, true);
            else { ta.focus(); ta.select(); }
            mountHistory(ta); hideHistory();
        }, attempt ? 100 : 250);
    }
    listen(document, 'click', e => {
        const modal = findRejectModal();
        if (modal) {
            mountHistory(modal.textarea);
            if (editorFor(modal.textarea).contains(e.target)) hideHistory();
        } else hideHistory();
    });

    /* ============================================================
     * 5. 右键接管（开关控制 + 审核模式智能识别）
     * ============================================================ */
    listen(document, 'contextmenu', e => {
        if (!rightClickEnabled || e.defaultPrevented || hasToolDialog() || isRejectModalOpen() || ownPanel(e.target) || editing(e.target)) return;
        // 排除 macOS Ctrl+左键被识别为右键
        if (e.ctrlKey || e.metaKey) return;
        const dt = performance.now() - lastMouseDownTime;
        if (dt < 500 && lastMouseDownButton === 0) return;
        if (lastMouseDownButton !== 2 && dt < 500) return;

        // 审核模式：右键 = 通过 / 修复并通过
        // 其他模式：右键 = 提交 > 更新 > 通过（原优先级）
        let btn;
        if (isReviewMode()) {
            btn = getBtn('autoPass');
        } else {
            btn = findActionButton('submit') || findActionButton('update') || findActionButton('pass');
        }
        if (!btn) return;

        e.preventDefault();
        e.stopImmediatePropagation();
        simulateFullClick(btn);
        try { console.log('[右键] 执行:', (btn.innerText || '').trim()); } catch (err) {}
    }, true);

    /* ============================================================
     * 6. 鼠标侧键 → 更新（只监听 mousedown + 节流，避免双触发）
     * ============================================================ */
    let lastSideTrigger = -Infinity;
    function handleSideButton(e) {
        if (![3, 4].includes(e.button) || e.defaultPrevented || hasToolDialog() || isRejectModalOpen() || ownPanel(e.target) || editing(e.target)) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        const now = performance.now();
        if (now - lastSideTrigger < 300) return;
        lastSideTrigger = now;
        const btn = getBtn('update');
        if (btn) simulateFullClick(btn);
    }
    listen(document, 'mousedown', handleSideButton, true);

    /* ============================================================
     * 7. 键盘快捷键（Tab驳回 / Enter提交驳回 / Esc取消 / 左右箭头）
     * ============================================================ */
    listen(window, 'keydown', e => {
        if (e.defaultPrevented || e.repeat || e.isComposing || e.keyCode === 229 || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
        if (hasToolDialog() || ownPanel(e.target)) return;
        const modal = findRejectModal();
        const inReason = modal && (e.target === modal.textarea || editorFor(modal.textarea).contains(e.target));
        if (editing(e.target) && !inReason) return;
        const take = () => { e.preventDefault(); e.stopImmediatePropagation(); };
        if (e.key === 'Tab') {
            if (modal) {
                if (!modal.cancel || !isEnabledButton(modal.cancel)) return;
                take(); hideHistory(); simulateFullClick(modal.cancel);
            } else {
                const rejectBtn = getBtn('reject');
                if (!rejectBtn) return;
                take(); simulateFullClick(rejectBtn); focusRejectInput();
            }
            return;
        }
        if (modal && e.key === 'Enter') { take(); manualEnterSubmit(modal); return; }
        if (modal && e.key === 'Escape') {
            if (!modal.cancel || !isEnabledButton(modal.cancel)) return;
            take(); hideHistory(); simulateFullClick(modal.cancel); return;
        }
        if (modal) return;
        const selector = e.key === 'ArrowLeft' ? '[aria-label*="prev" i],[aria-label*="上一"],[class*="prev"]'
            : e.key === 'ArrowRight' ? '[aria-label*="next" i],[aria-label*="下一"],[class*="next"]' : null;
        if (!selector) return;
        const control = [...document.querySelectorAll(selector)].find(node => isVisible(node) && isEnabledButton(node) && !ownPanel(node));
        if (control) { take(); simulateFullClick(control); }
    }, true);

    /* ============================================================
     * 8. 路由切换清理
     * ============================================================ */
    const origPush = history.pushState;
    const wrappedPush = function (...args) {
        const result = origPush.apply(history, args); hideHistory(); return result;
    };
    history.pushState = wrappedPush;
    listen(window, 'popstate', hideHistory);

    /* ============================================================
     * 9. 开关 UI
     * ============================================================ */
    function syncToggleState() {
        const cb = document.getElementById(TOGGLE_ID);
        if (cb) cb.checked = rightClickEnabled;
    }

    function mountToggle() {
        if (document.getElementById(TOGGLE_ID)) { syncToggleState(); return; }
        const containers = [
            '.lsf-topbar__group_slot_right',
            '.lsf-topbar__group_slot_left',
            '.lsf-topbar__group',
            '[data-testid="topbar-actions"]',
            '.ant-layout-header .ant-space',
            '.lsf-annotation-header-actions'
        ];
        let target = null;
        for (const sel of containers) {
            const el = document.querySelector(sel);
            if (el) { target = el; break; }
        }
        if (!target) return;
        if (target.querySelector(`#${TOGGLE_ID}`)) return;

        const wrap = document.createElement('div');
        wrap.dataset.instaReviewToggle = '';
        wrap.title = '右键提交/更新/通过；输入框和弹窗内保留正常右键菜单';
        wrap.style.cssText = 'display:inline-flex;align-items:center;height:32px;margin:0 8px;flex:0 0 auto;white-space:nowrap';
        const label = document.createElement('label');
        label.style.cssText = 'display:inline-flex;align-items:center;gap:6px;font:12px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;color:#222;cursor:pointer;user-select:none';
        const cb = document.createElement('input');
        cb.id = TOGGLE_ID;
        cb.type = 'checkbox';
        cb.checked = rightClickEnabled;
        cb.addEventListener('change', e => saveRightClickEnabled(e.target.checked));
        const text = document.createElement('span');
        text.textContent = '右键接管';
        label.appendChild(cb);
        label.appendChild(text);
        wrap.appendChild(label);
        target.insertBefore(wrap, target.firstChild);
    }

    function observeMount() {
        if (!document.body) {
            listen(document, 'DOMContentLoaded', () => observeMount(), { once: true });
            return;
        }
        mountObserver = new MutationObserver(() => {
            if (!document.getElementById(TOGGLE_ID)) mountToggle();
            mountHistory();
        });
        mountObserver.observe(document.body, { childList: true, subtree: true });
        mountToggle(); mountHistory();
    }

    observeMount();
    every(() => {
        if (!document.getElementById(TOGGLE_ID)) mountToggle();
        else syncToggleState();
        mountHistory();
    }, 2000);

    /* ============================================================
     * 10. 调试入口
     * ============================================================ */
    window._fcMergedApi = {
        version: '1.0.0',
        destroy() {
            if (destroyed) return; destroyed = true;
            listeners.splice(0).forEach(remove => remove());
            timers.forEach(id => window.clearTimeout(id)); intervals.forEach(id => window.clearInterval(id));
            mountObserver?.disconnect(); historyDropdownEl?.remove();
            document.getElementById(TOGGLE_ID)?.closest('[data-insta-review-toggle]')?.remove();
            if (history.pushState === wrappedPush) history.pushState = origPush;
            delete window.__fcMerged; delete window._fcMergedApi;
        },
        toggleRightClick: v => saveRightClickEnabled(!!v),
        isReviewMode,
        findButton: findActionButton,
        getBtn,
        testRightClick: () => {
            let btn;
            if (isReviewMode()) btn = getBtn('autoPass');
            else btn = findActionButton('submit') || findActionButton('update') || findActionButton('pass');
            if (btn) { simulateFullClick(btn); console.log('[test] 点击:', (btn.innerText || '').trim()); return true; }
            console.log('[test] 未找到按钮');
            return false;
        },
        history: getRejectHistory,
        clearHistory: clearAllHistory,
    };

    // 右键提交/更新/通过与评论帧号跳转共用同一份安装脚本。
})();

})();
