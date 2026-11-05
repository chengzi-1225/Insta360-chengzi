// ==UserScript==
// @name         Insta360 预览条帧范围
// @namespace    insta360.frame-range
// @version      1.2.1
// @description  限定预览帧范围、键盘加减缩放；框选后原生按钮或右键标记区间、取消关键帧或连线
// @updateURL    https://raw.githubusercontent.com/chengzi-1225/Insta360-chengzi/refs/heads/main/Insta360-TimelineFrameRange.user.js
// @downloadURL  https://raw.githubusercontent.com/chengzi-1225/Insta360-chengzi/refs/heads/main/Insta360-TimelineFrameRange.user.js
// @match        https://label.insta360.com/*
// @run-at       document-idle
// @grant        none
// @sandbox      raw
// @noframes
// ==/UserScript==

(function(){
'use strict';
if(location.hostname!=='label.insta360.com'||window.top!==window.self)return;
const scope={};
(() => {
  'use strict';
  const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
  class FrameRangeModel {
    constructor(total, start = 1, end = total) {
      if (!Number.isSafeInteger(total) || total < 1) throw new RangeError('总帧数必须是正整数');
      this.total = total;
      this.current = start;
      this.setRange(start, end);
    }
    get count() { return this.end - this.start + 1; }
    get span() { return this.count / this.zoom; }
    get maxZoom() { return Math.min(32, this.count); }
    setRange(start, end) {
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) throw new RangeError('请输入整数帧号');
      if (start < 1 || end > this.total) throw new RangeError(`帧号范围为 1–${this.total}`);
      if (start > end) throw new RangeError('起始帧不能大于结束帧');
      this.start = start;
      this.end = end;
      this.zoom = 1;
      this.offset = 0;
      this.current = clamp(this.current, start, end);
    }
    visibleFrames() {
      return [
        clamp(this.start + Math.floor(this.offset + 1e-9), this.start, this.end),
        clamp(this.start + Math.ceil(this.offset + this.span - 1e-9) - 1, this.start, this.end),
      ];
    }
    setZoom(value, anchor) {
      if (!Number.isFinite(value)) throw new RangeError('缩放值必须是有限数字');
      const position = this.current - this.start + 0.5;
      const ratio = anchor ?? (position >= this.offset && position <= this.offset + this.span ? (position - this.offset) / this.span : 0.5);
      const point = this.offset + clamp(ratio, 0, 1) * this.span;
      this.zoom = clamp(value, 1, this.maxZoom);
      this.offset = clamp(point - clamp(ratio, 0, 1) * this.span, 0, this.count - this.span);
    }
    pan(frames) {
      if (!Number.isFinite(frames)) return;
      this.offset = clamp(this.offset + frames, 0, this.count - this.span);
    }
    select(frame) {
      if (!Number.isFinite(frame)) return;
      this.current = clamp(Math.round(frame), this.start, this.end);
      const cell = this.current - this.start;
      if (cell < this.offset) this.offset = cell;
      if (cell + 1 > this.offset + this.span) this.offset = cell + 1 - this.span;
      this.offset = clamp(this.offset, 0, this.count - this.span);
    }
    step(delta) { this.select(this.current + delta); }
    follow(frame) {
      if (!Number.isSafeInteger(frame)) return;
      if (frame !== this.current && frame >= this.start && frame <= this.end) this.select(frame);
      this.current = frame;
    }
    frameAt(x, width) {
      if (!Number.isFinite(x) || !Number.isFinite(width) || width <= 0) return this.current;
      return clamp(this.start + Math.floor(this.offset + clamp(x / width, 0, 1) * this.span), this.start, this.end);
    }
    xAt(frame, width) { return ((frame - this.start + 0.5 - this.offset) / this.span) * width; }
  }
  scope.Model = FrameRangeModel;
})();

(() => {
  'use strict';
  const normalize=value=>String(value).normalize('NFKC').trim();
  function integer(value) {
    const text=normalize(value),number=Number(text);
    if(!/^\d+$/.test(text)||!Number.isSafeInteger(number))throw new RangeError('请输入整数帧号');
    return number;
  }
  scope.Input={
    parse(start,end) {
      if(!normalize(start)||!normalize(end))throw new RangeError('请填写起始帧和结束帧');
      return [integer(start),integer(end)];
    },
    pair(text) {
      const match=normalize(text).match(/^(?:第\s*)?(\d+)\s*[-–—~至到]\s*(\d+)\s*帧?$/u);
      if(!match)return null;
      try{return [integer(match[1]),integer(match[2])];}catch{return null;}
    }
  };
})();

(() => {
  'use strict';
  class FrameRangeActions {
    constructor(getContext,total,fps){this.getContext=getContext;this.total=total;this.fps=fps;}
    static selection(text){
      const match=String(text||'').match(/已选中\s*(\d+)\s*[-–—]\s*(\d+)/u);
      if(!match)return null;
      const start=Number(match[1]),end=Number(match[2]);
      return Number.isSafeInteger(start)&&Number.isSafeInteger(end)&&start<=end?{start,end}:null;
    }
    static zoomKey(event){
      if(event.defaultPrevented||event.ctrlKey||event.metaKey||event.altKey||event.isComposing)return null;
      if(event.target?.isContentEditable||event.target?.closest?.('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"],[role="combobox"],[role="spinbutton"]'))return null;
      if(event.key==='+'||event.key==='='||event.code==='NumpadAdd')return 2;
      if(event.key==='-'||event.code==='NumpadSubtract')return .5;
      return null;
    }
    context(range){
      if(!range||!Number.isSafeInteger(range.start)||!Number.isSafeInteger(range.end)||range.start<0||range.end>=this.total||range.start>range.end)throw new RangeError('框选帧范围无效，请重新框选');
      const context=this.getContext();
      if(!context?.selectedRegion)throw new Error('请先点击选中一条轨迹，再框选帧段');
      return context;
    }
    keys(region,range){
      if(!Array.isArray(region.sequence))throw new Error('当前轨迹不支持关键帧批量操作');
      return region.sequence.filter(k=>k.frame>=range.start&&k.frame<=range.end);
    }
    mark(range){
      const context=this.context(range),region=context.selectedRegion;
      if(range.start===range.end)throw new RangeError('区间标记需要至少两个不同的帧');
      if(!Array.isArray(region.rangeList)||!['onCreateClip','onUpdateClip','onRemoveClip'].every(key=>typeof context[key]==='function'))throw new Error('当前轨迹不支持区间标记');
      const before=new Set(region.rangeList.map(r=>r.id)),previous=region.selectedRange?.id;
      try{
        context.onCreateClip();
        const created=region.rangeList.filter(r=>!before.has(r.id));
        if(created.length!==1)throw new Error('未能创建区间标记');
        const id=created[0].id;
        context.onUpdateClip(id,{start:range.start,end:range.end,startTime:range.start/this.fps,endTime:range.end/this.fps});
        const saved=region.rangeList.find(r=>r.id===id);
        if(saved?.start!==range.start||saved?.end!==range.end)throw new Error('区间标记范围未生效');
        return id;
      }catch(error){
        for(const added of region.rangeList.filter(r=>!before.has(r.id)))context.onRemoveClip(added.id);
        context.onSelectClip?.(previous||'',region.id);
        throw error;
      }
    }
    remove(range){
      const context=this.context(range),keys=this.keys(context.selectedRegion,range);
      if(!keys.length)return 0;
      if(typeof context.onRemoveFrames!=='function')throw new Error('当前轨迹不支持取消关键帧');
      context.onRemoveFrames(range);
      if(this.keys(context.selectedRegion,range).length)throw new Error('取消关键帧未完成，请检查当前轨迹是否支持该操作');
      return keys.length;
    }
    connect(range,enabled){
      const context=this.context(range),region=context.selectedRegion,keys=this.keys(region,range);
      if(typeof region.batchAddKeyframes!=='function'||typeof context.onToggleLifespan!=='function')throw new Error('当前轨迹不支持批量连线');
      const changes=keys.filter(k=>(k.enabled!==false)!==enabled).map(k=>({frame:k.frame,enabled}));
      if(changes.length)region.batchAddKeyframes(changes);
      return changes.length;
    }
  }
  scope.Actions=FrameRangeActions;
})();

(() => {
  'use strict';
  function committedFiber(stage) {
    const key=Object.keys(stage).find(k=>k.startsWith('__reactFiber$')||k.startsWith('__reactInternalInstance$'));
    let fiber=key?stage[key]:null;
    if(!fiber)return null;
    let root=fiber;
    for(let i=0;root.return&&i<150;i++)root=root.return;
    if(root.stateNode?.current&&root.stateNode.current!==root)fiber=fiber.alternate||fiber;
    return fiber;
  }
  function inspect(stage) {
    let fiber=committedFiber(stage);
    for(let depth=0;fiber&&depth<40;depth++,fiber=fiber.return) {
      const p=fiber.memoizedProps;
      if(!p||!Number.isFinite(p.duration)||!(p.framerate>0)||typeof p.onPositionChange!=='function')continue;
      const hooks=[];let hook=fiber.memoizedState;
      for(let i=0;hook&&i<6;i++,hook=hook.next)hooks.push(hook);
      if(hooks.length<6||hooks.slice(0,5).some(h=>typeof h.queue?.dispatch!=='function'))continue;
      const [width,zoom,levels,scroll,top]=hooks.map(h=>h.memoizedState);
      if(!Number.isFinite(width)||!Number.isInteger(zoom)||!Number.isFinite(scroll)||!Number.isFinite(top)||!Array.isArray(levels)||!levels.length||!levels.every(l=>l.fpt>0&&l.tickWidth>0&&l.interval>0))continue;
      let pause=null,parent=fiber;
      for(let n=0;parent&&n<25;n++,parent=parent.return)if(typeof parent.memoizedProps?.onPause==='function'){pause=parent.memoizedProps.onPause;break;}
      const text=stage.closest('.lsf-timeline')?.querySelector('.lsf-frames-control')?.textContent||'';
      const total=Number(text.match(/(?:of|\/|共)\s*(\d+)/i)?.[1])||Math.max(1,Math.ceil(p.duration*p.framerate-1e-6));
      return {props:p,hooks,levels,zoom,scroll,frame:Number(p.frame)||0,total,pause,frameWidth:hooks[5].memoizedState?.current};
    }
    return null;
  }
  class LSFrameRangeNative {
    constructor(stage) {this.stage=stage;this.original=null;this.custom=null;this.scale=0;}
    static find(stage) {return stage&&inspect(stage)?new LSFrameRangeNative(stage):null;}
    read() {const state=inspect(this.stage);if(!state)throw new Error('当前页面的时间轴结构不兼容');return state;}
    actions() {
      let fiber=committedFiber(this.stage);
      for(let depth=0;fiber&&depth<40;depth++,fiber=fiber.return){
        const props=fiber.memoizedProps;
        if(typeof props?.onCreateClip==='function'&&typeof props?.onUpdateClip==='function'&&'selectedRegion' in props)return props;
      }
      return null;
    }
    apply(view,width) {
      if(!(width>0))throw new Error('预览条尚未显示');
      const state=this.read();
      if(!this.original)this.original={levels:state.levels,zoom:state.zoom,scroll:state.scroll};
      const frameWidth=width/((view.end-view.start+1)/view.zoom);
      const scrollLeft=Math.max(0,(view.start-0.5+view.offset)*frameWidth);
      if(state.levels!==this.custom||Math.abs(this.scale-frameWidth)>1e-7) {
        const tickWidth=Math.max(...this.original.levels.map(l=>l.tickWidth));
        const fpt=tickWidth/frameWidth;
        this.custom=[{interval:fpt/state.props.framerate,fpt,tickWidth,zoom:1}];
        this.scale=frameWidth;
        state.hooks[2].queue.dispatch(this.custom);
      }
      if(state.zoom!==1)state.hooks[1].queue.dispatch(1);
      if(Math.abs(state.scroll-scrollLeft)>0.05)state.hooks[3].queue.dispatch(scrollLeft);
      return {frameWidth,scrollLeft};
    }
    restore() {
      if(!this.original)return;
      try {
        const state=this.read(),original=this.original;
        state.hooks[2].queue.dispatch(original.levels);
        state.hooks[1].queue.dispatch(original.zoom);
        state.hooks[3].queue.dispatch(original.scroll);
      } finally {this.original=null;this.custom=null;this.scale=0;}
    }
    seek(frame) {this.read().props.onPositionChange(frame);}
    pause() {this.read().pause?.();}
  }
  scope.Native=LSFrameRangeNative;
})();

window.__LS_FRAME_RANGE?.destroy?.();
const lfrStyle=document.createElement('style');
lfrStyle.textContent=".lfr-host{max-width:100%!important;min-width:0!important}\n.lfr-host>.resizable-box{width:100%!important;min-width:0!important;max-width:100%!important}\n.lfr-host>.resizable-box>.handle.right,.lfr-host>.resizable-box>.handle.bottom-right{display:none!important}\n.lfr-host .pro-timeline-wrap{width:100%!important;min-width:0!important}\n.lfr-host .timeline-stage{min-width:80px!important;position:relative!important}\n.lfr-host .timeline-wrap-left{max-width:100px!important}\n.lfr-controls{box-sizing:border-box!important;display:flex!important;align-items:center!important;flex-wrap:wrap!important;gap:6px 10px!important;padding:7px 8px!important;border:1px solid #d9e2ee!important;border-radius:6px!important;margin:5px 0 6px!important;background:#f6f8fc!important;color:#4b617c!important;font:13px/1.5 -apple-system,BlinkMacSystemFont,\"Segoe UI\",\"PingFang SC\",sans-serif!important;max-width:100%!important;min-width:0!important}\n.lfr-controls *{box-sizing:border-box!important}\n.lfr-controls .lfr-range{display:grid!important;grid-template-columns:minmax(84px,1fr) minmax(84px,1fr) auto!important;align-items:center!important;gap:6px!important;flex:1 1 300px!important;max-width:420px!important;min-width:0!important}\n.lfr-controls .lfr-field{display:flex!important;align-items:center!important;gap:3px!important;height:34px!important;margin:0!important;padding:0 0 0 9px!important;border:1px solid #c8d4e3!important;border-radius:5px!important;background:#fff!important;overflow:hidden!important;font:inherit!important;min-width:0!important}\n.lfr-controls .lfr-field>span{flex:none!important;white-space:nowrap!important;color:#75869b!important;font-size:11px!important}\n.lfr-controls .lfr-field:focus-within{border-color:#3989e9!important;box-shadow:0 0 0 2px #3989e91f!important}\n.lfr-controls .lfr-field:has(input[aria-invalid=true]){border-color:#cf5046!important}\n.lfr-controls input[type=text]{appearance:none!important;display:block!important;flex:1!important;width:100%!important;min-width:0!important;height:32px!important;margin:0!important;padding:3px 6px 3px 3px!important;background:transparent!important;border:0!important;border-radius:0!important;outline:0!important;box-shadow:none!important;color:#263e5c!important;font:14px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace!important;font-variant-numeric:tabular-nums!important}\n.lfr-controls .lfr-tools{display:flex!important;align-items:center!important;gap:6px!important;flex:0 0 auto!important;min-width:0!important}\n.lfr-controls button{appearance:none!important;display:inline-flex!important;align-items:center!important;justify-content:center!important;flex:none!important;min-width:0!important;height:34px!important;margin:0!important;padding:3px 11px!important;border:1px solid #c8d4e3!important;border-radius:5px!important;background:#fff!important;color:#435f81!important;cursor:pointer!important;font:inherit!important;line-height:1.5!important;white-space:nowrap!important}\n.lfr-controls button:hover{background:#eaf3ff!important;border-color:#93b8e5!important}\n.lfr-controls button:disabled{opacity:.35!important;cursor:default!important}\n.lfr-controls button.lfr-apply{background:#287ddd!important;border-color:#287ddd!important;color:#fff!important}\n.lfr-controls[data-draft=true] button.lfr-apply{box-shadow:0 0 0 2px #287ddd24!important}\n.lfr-controls .lfr-zoom-buttons{display:flex!important;align-items:center!important;height:34px!important;border:1px solid #c8d4e3!important;border-radius:5px!important;background:#fff!important;overflow:hidden!important}\n.lfr-controls button.lfr-zoom{width:34px!important;height:32px!important;padding:0!important;border:0!important;border-radius:0!important;font-size:21px!important}\n.lfr-controls output{font:12px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace!important;min-width:38px!important;text-align:center!important;color:#537294!important}\n.lfr-controls .lfr-status{flex:1 1 155px!important;min-width:0!important;color:#75869b!important;font-size:11px!important;overflow-wrap:anywhere!important}\n.lfr-controls[data-details=false] .lfr-status[data-mode=ready]{display:none!important}\n.lfr-controls .lfr-status[data-mode=error]{flex-basis:100%!important;color:#c64b45!important}\n.lfr-controls .lfr-status[data-mode=draft]{flex-basis:100%!important;color:#a16a21!important}\n.lfr-controls .lfr-status[data-mode=notice]{flex-basis:100%!important;color:#24785a!important}\n.lfr-controls .lfr-status[data-mode=action-error]{flex-basis:100%!important;color:#c64b45!important}\n.lfr-controls button:focus-visible{outline:2px solid #78b6ff!important;outline-offset:2px!important}\n.lfr-controls[data-compact=true] .lfr-range{flex-basis:100%!important;max-width:none!important}\n.lfr-controls[data-compact=true] .lfr-tools{flex:1 1 100%!important}\n.lfr-controls[data-compact=true] .lfr-tools>button{flex:1!important}\n.lfr-ruler{position:absolute!important;top:0!important;left:0!important;height:52px!important;width:100%!important;pointer-events:none!important;z-index:2!important;background:#1a1a1a!important}\n.lfr-pan-wrap{display:flex!important;align-items:center!important;gap:8px!important;padding:3px 8px!important;background:#f6f8fc!important;border:1px solid #e0e8f1!important;border-top:0!important;border-radius:0 0 4px 4px!important;color:#8294aa!important;font:11px/1.5 -apple-system,BlinkMacSystemFont,\"PingFang SC\",sans-serif!important}\n.lfr-pan-wrap[hidden],.lfr-ruler[hidden]{display:none!important}\n.lfr-pan-wrap input{flex:1!important;min-width:30px!important;height:18px!important;accent-color:#4188da!important;cursor:ew-resize!important;margin:0!important;padding:0!important}\n.lfr-pan-wrap span{white-space:nowrap!important}\n.lfr-context-open .frame-selection-menu{visibility:hidden!important;pointer-events:none!important}\n.lfr-selection-menu{box-sizing:border-box!important;position:fixed!important;z-index:2147483000!important;width:236px!important;max-width:calc(100vw - 16px)!important;padding:7px!important;background:#fff!important;border:1px solid #cad7e6!important;border-radius:7px!important;box-shadow:0 7px 28px #18345026!important;color:#344d6c!important;font:13px/1.5 -apple-system,BlinkMacSystemFont,\"Segoe UI\",\"PingFang SC\",sans-serif!important}\n.lfr-selection-menu[hidden]{display:none!important}\n.lfr-selection-heading{padding:4px 7px 0!important;color:#263e5c!important;font-weight:600!important;font-variant-numeric:tabular-nums!important}\n.lfr-selection-hint{padding:1px 7px 7px!important;color:#8a99ac!important;font-size:11px!important;border-bottom:1px solid #e7edf4!important;margin-bottom:4px!important}\n.lfr-selection-menu button{box-sizing:border-box!important;display:block!important;width:100%!important;height:34px!important;margin:0!important;padding:5px 9px!important;text-align:left!important;border:0!important;border-radius:4px!important;background:#fff!important;color:inherit!important;font:inherit!important;cursor:pointer!important}\n.lfr-selection-menu button:hover,.lfr-selection-menu button:focus-visible{background:#eaf3ff!important;outline:0!important}\n.lfr-selection-menu button.lfr-remove-keys{color:#bb5047!important}\n.lfr-selection-menu button:disabled{opacity:.4!important;cursor:default!important}\n.lfr-selection-menu button:last-child{margin-top:4px!important;border-top:1px solid #e7edf4!important;border-radius:0!important;color:#8a99ac!important;font-size:12px!important}\n";
lfrStyle.dataset.lfr='style';
document.head.append(lfrStyle);
let lfrMount=null,lfrDestroyed=false,lfrLastScan=0,lfrError='正在等待视频预览条';

function lfrNode(tag,attributes={},text='') {
  const element=document.createElement(tag);
  for(const [key,value] of Object.entries(attributes))element.setAttribute(key,value);
  element.textContent=text;
  return element;
}
function lfrIdentity() {
  const url=new URL(location.href);
  return url.pathname+'?task='+url.searchParams.get('task');
}
function lfrCreate(stage,bridge) {
  const host=stage.closest('.lsf-timeline'),box=stage.closest('.resizable-box');
  if(!host||!box||!host.contains(box))return null;
  const initial=bridge.read(),total=initial.total;
  const model=new scope.Model(total,Math.min(100,total),Math.min(200,total));
  const events=new AbortController(),on=(node,name,fn,options={})=>node.addEventListener(name,fn,{...options,signal:events.signal});
  const controls=lfrNode('div',{class:'lfr-controls',role:'toolbar','aria-label':'预览条帧范围'});
  const rangeGroup=lfrNode('div',{class:'lfr-range'}),zoomGroup=lfrNode('div',{class:'lfr-tools'});
  const inputAttributes={type:'text',inputmode:'numeric',autocomplete:'off',spellcheck:'false',maxlength:'24',title:`输入 1–${total} 的整数；可粘贴 100-200；Enter 应用，Esc 撤销`};
  const start=lfrNode('input',{...inputAttributes,'aria-label':'起始帧'});
  const end=lfrNode('input',{...inputAttributes,'aria-label':'结束帧'});
  start.value=String(model.start);end.value=String(model.end);
  for(const [text,input] of [['起始',start],['结束',end]]) {
    const label=lfrNode('label',{class:'lfr-field'});label.append(lfrNode('span',{},text),input);rangeGroup.append(label);
  }
  const button=(text,label,cls='')=>lfrNode('button',{type:'button','aria-label':label,class:cls,title:label},text);
  const apply=button('只看这段','只显示指定帧范围','lfr-apply');apply.title='应用输入范围（Enter）';rangeGroup.append(apply);
  const minus=button('−','缩小预览条','lfr-zoom'),plus=button('＋','放大预览条','lfr-zoom');
  minus.title='缩小预览条（-）';plus.title='放大预览条（+ / =）';
  const scale=lfrNode('output',{'aria-label':'预览条缩放倍数'},'1×');
  const fit=button('适应','完整显示当前帧区间'),all=button('全部','恢复全部帧');
  const zoomButtons=lfrNode('div',{class:'lfr-zoom-buttons',role:'group','aria-label':'预览条缩放'});
  zoomButtons.append(minus,scale,plus);zoomGroup.append(zoomButtons,fit,all);
  const status=lfrNode('span',{class:'lfr-status',role:'status','aria-live':'polite'});
  controls.append(rangeGroup,zoomGroup,status);
  const panWrap=lfrNode('div',{class:'lfr-pan-wrap',hidden:''});
  const pan=lfrNode('input',{type:'range',min:'0',max:'1000',step:'1',value:'0','aria-label':'平移预览条'});
  panWrap.append(lfrNode('span',{},'平移'),pan,lfrNode('span',{},'限于所选区间'));
  const ruler=lfrNode('canvas',{class:'lfr-ruler',hidden:'',role:'img','aria-label':'预览帧号尺'});
  const menu=lfrNode('div',{class:'lfr-selection-menu',role:'menu','aria-label':'框选帧段操作',hidden:''});
  const menuHeading=lfrNode('div',{class:'lfr-selection-heading'}),menuHint=lfrNode('div',{class:'lfr-selection-hint'});
  const mark=button('标记区间','标记选中帧段'),remove=button('取消关键帧','取消选中帧段的关键帧','lfr-remove-keys');
  const connect=button('连线','连接选中帧段'),disconnect=button('断开连线','断开选中帧段的连线');
  const dismiss=button('取消框选 · Esc','取消框选');
  for(const item of [mark,remove,connect,disconnect,dismiss])item.setAttribute('role','menuitem');
  menu.append(menuHeading,menuHint,mark,remove,connect,disconnect,dismiss);document.body.append(menu);
  const actions=new scope.Actions(()=>bridge.actions(),total,initial.props.framerate);
  box.before(controls);box.after(panWrap);stage.append(ruler);host.classList.add('lfr-host');
  let active=false,error='',frame=initial.frame,width=0,lastDraw='',lastExpected=null,closed=false;
  let notice='',noticeMode='notice',noticeUntil=0,menuRange=null,menuRegionId=null;
  const identity=lfrIdentity();

  function message(text,mode='ready') {
    if(status.textContent!==text)status.textContent=text;
    status.dataset.mode=mode;
    controls.title=text;
  }
  function showError(e) {
    error=e.message||String(e);
    start.setAttribute('aria-invalid','true');end.setAttribute('aria-invalid','true');
    message(error,'error');
  }
  function clearError() {error='';noticeUntil=0;start.removeAttribute('aria-invalid');end.removeAttribute('aria-invalid');}
  function viewMessage(text,mode='ready') {
    if(!error)message(performance.now()<noticeUntil?notice:text,performance.now()<noticeUntil?noticeMode:mode);
  }
  function announce(text,isError=false) {notice=text;noticeMode=isError?'action-error':'notice';noticeUntil=performance.now()+3000;message(notice,noticeMode);}
  function nativeSelection() {return scope.Actions.selection(host.querySelector('.frame-selection-menu__count')?.textContent);}
  function closeMenu() {menu.hidden=true;menuRange=null;host.classList.remove('lfr-context-open');}
  function clearSelection() {host.querySelector('.frame-selection-menu__btn--close')?.click();closeMenu();}
  function openMenu(event,range) {
    bridge.pause();menuRange=range;
    const region=bridge.actions()?.selectedRegion;menuRegionId=region?.id;
    menuHeading.textContent=`${range.start}–${range.end} 帧 · 共 ${range.end-range.start+1} 帧`;
    menuHint.textContent=region?'应用到当前选中轨迹':'请先点击选中一条轨迹';
    for(const item of [mark,remove,connect,disconnect])item.disabled=!region;
    mark.disabled=!region||range.start===range.end;
    menu.hidden=false;menu.style.left='0px';menu.style.top='0px';host.classList.add('lfr-context-open');
    const rect=menu.getBoundingClientRect();
    menu.style.left=`${Math.max(8,Math.min(event.clientX+6,window.innerWidth-rect.width-8))}px`;
    menu.style.top=`${Math.max(8,Math.min(event.clientY+6,window.innerHeight-rect.height-8))}px`;
    menu.querySelector('button:not(:disabled)')?.focus();
  }
  function runAction(operation,expectedRange=menuRange,expectedRegionId=menuRegionId) {
    try {
      const current=nativeSelection();
      if(!expectedRange||!current||current.start!==expectedRange.start||current.end!==expectedRange.end)throw new Error('框选范围已改变，请重新框选');
      if((bridge.actions()?.selectedRegion?.id??null)!==(expectedRegionId??null))throw new Error('轨迹已切换，请重新框选');
      const range={...expectedRange};
      bridge.pause();
      let text;
      if(operation==='mark'){actions.mark(range);text=`已标记 ${range.start}–${range.end} 帧`;}
      if(operation==='remove'){const count=actions.remove(range);text=count?`已取消 ${count} 个关键帧`:'选区内没有关键帧';}
      if(operation==='connect'||operation==='disconnect'){
        const count=actions.connect(range,operation==='connect');
        text=operation==='connect'?`连线已更新 · 修改 ${count} 个关键帧`:`连线已断开 · 修改 ${count} 个关键帧`;
      }
      clearSelection();announce(text);
    }catch(e){closeMenu();announce(e.message||String(e),true);}
  }
  function isDraft() {return start.value.trim()!==String(model.start)||end.value.trim()!==String(model.end);}
  function draw(force=false) {
    if(!menu.hidden&&!nativeSelection())closeMenu();
    const hostWidth=host.getBoundingClientRect().width;
    controls.dataset.compact=String(hostWidth<620);controls.dataset.details=String(hostWidth>=900);
    controls.dataset.draft=String(isDraft());
    ruler.hidden=!active;panWrap.hidden=!active||model.zoom<=1;
    minus.disabled=!active||model.zoom<=1;plus.disabled=active&&model.zoom>=model.maxZoom;fit.disabled=!active;
    scale.textContent=active?`${Number(model.zoom.toFixed(2))}×`:'1×';
    if(!active) {viewMessage(isDraft()?'待应用 · Enter 确认 / Esc 撤销':`1–${total} 帧 · Enter 应用范围`,isDraft()?'draft':'ready');return;}
    const visible=model.visibleFrames();
    if(document.activeElement!==pan)pan.value=String(Math.round(model.offset/Math.max(1e-10,model.count-model.span)*1000));
    viewMessage(isDraft()?'待应用 · Enter 确认 / Esc 撤销':`显示 ${visible[0]}–${visible[1]} · 当前 ${frame} / ${total}`,isDraft()?'draft':'ready');
    ruler.dataset.visibleStart=String(visible[0]);ruler.dataset.visibleEnd=String(visible[1]);
    ruler.dataset.current=String(frame);
    ruler.setAttribute('aria-label',`帧号尺：显示第 ${visible[0]} 至 ${visible[1]} 帧，当前第 ${frame} 帧`);
    const dpr=window.devicePixelRatio||1,key=[width,dpr,model.start,model.end,model.zoom,model.offset,frame].join(':');
    if(!force&&lastDraw===key)return;
    lastDraw=key;
    ruler.width=Math.round(width*dpr);ruler.height=Math.round(52*dpr);
    const ctx=ruler.getContext('2d');ctx.scale(dpr,dpr);ctx.fillStyle='#1a1a1a';ctx.fillRect(0,0,width,52);
    const px=width/model.span,wanted=60/px,power=10**Math.floor(Math.log10(Math.max(1,wanted)));
    const step=[1,2,5,10].map(n=>n*power).find(n=>n>=wanted)||power*10;
    const minor=Math.max(1,step/5),left=model.start-0.5+model.offset,right=left+model.span;
    ctx.lineWidth=1;ctx.font='11px ui-monospace,SFMono-Regular,Consolas,monospace';ctx.textBaseline='middle';
    ctx.strokeStyle='#3e4146';ctx.fillStyle='#c3c9d1';
    ctx.beginPath();
    for(let f=Math.ceil(left/minor)*minor;f<=right;f+=minor) {
      const x=model.xAt(f,width);ctx.moveTo(x+.5,0);ctx.lineTo(x+.5,f%step===0?17:8);
    }
    ctx.stroke();
    const labels=new Set([visible[0],visible[1]]);
    for(let f=Math.ceil(left/step)*step;f<=right;f+=step)if(f>=visible[0]&&f<=visible[1])labels.add(f);
    const placed=[];
    for(const f of [...labels].sort((a,b)=>(a===visible[0]?-1:b===visible[0]?1:a===visible[1]?-1:b===visible[1]?1:a-b))) {
      const text=String(Math.round(f)),tw=ctx.measureText(text).width;
      const x=Math.max(3,Math.min(width-tw-3,model.xAt(f,width)-tw/2));
      if(placed.some(([a,b])=>x<b+9&&x+tw>a-9))continue;
      ctx.fillText(text,x,31);placed.push([x,x+tw]);
    }
    ctx.strokeStyle='#34383e';ctx.beginPath();ctx.moveTo(0,51.5);ctx.lineTo(width,51.5);ctx.stroke();
    const currentX=model.xAt(frame,width);
    if(currentX>=0&&currentX<=width) {
      ctx.fillStyle='#398fff';ctx.beginPath();ctx.moveTo(currentX-5,0);ctx.lineTo(currentX+5,0);ctx.lineTo(currentX+5,9);ctx.lineTo(currentX,15);ctx.lineTo(currentX-5,9);ctx.closePath();ctx.fill();
      ctx.strokeStyle='#398fff';ctx.beginPath();ctx.moveTo(currentX+.5,15);ctx.lineTo(currentX+.5,52);ctx.stroke();
    }
  }
  function syncView() {
    width=stage.getBoundingClientRect().width;
    if(active&&width>0)lastExpected=bridge.apply(model,width);
    draw();
  }
  function activate() {
    try {
      const [a,b]=scope.Input.parse(start.value,end.value);
      model.setRange(a,b);clearError();
      start.value=String(a);end.value=String(b);
      bridge.pause();
      const current=bridge.read().frame;
      active=true;
      if(current<a||current>b) {bridge.seek(a);frame=a;}else frame=current;
      model.current=frame;
      syncView();
      return true;
    } catch(e) {showError(e);return false;}
  }
  function zoomBy(factor) {
    if(!active&&!activate())return;
    clearError();model.current=frame;model.setZoom(model.zoom*factor);syncView();
  }
  on(apply,'click',activate);on(minus,'click',()=>zoomBy(.5));on(plus,'click',()=>zoomBy(2));
  on(fit,'click',()=>{clearError();model.setZoom(1);syncView();});
  on(all,'click',()=>{
    start.value='1';end.value=String(total);activate();
  });
  for(const input of [start,end]) {
    on(input,'input',()=>{clearError();draw();});
    on(input,'paste',e=>{
      const pair=scope.Input.pair(e.clipboardData?.getData('text')||'');
      if(!pair)return;
      e.preventDefault();start.value=String(pair[0]);end.value=String(pair[1]);clearError();draw();
    });
    on(input,'keydown',e=>{
      e.stopPropagation();
      if(e.isComposing)return;
      if(e.key==='Enter'){e.preventDefault();activate();}
      if(e.key==='Escape'){e.preventDefault();start.value=String(model.start);end.value=String(model.end);clearError();draw();}
    });
    on(input,'keyup',e=>e.stopPropagation());
  }
  on(pan,'input',()=>{model.offset=Number(pan.value)/1000*(model.count-model.span);syncView();});
  on(host,'click',e=>{
    const trigger=e.target?.closest?.('.clip-control > button:first-child');
    const range=nativeSelection();
    if(!trigger||!host.contains(trigger)||!range)return;
    e.preventDefault();e.stopImmediatePropagation();
    runAction('mark',range,bridge.actions()?.selectedRegion?.id);
  },{capture:true});
  on(stage,'mousedown',e=>{
    if(e.button===2&&nativeSelection()){e.preventDefault();e.stopImmediatePropagation();}
  },{capture:true});
  on(stage,'contextmenu',e=>{
    const range=nativeSelection();if(!range)return;
    e.preventDefault();e.stopImmediatePropagation();openMenu(e,range);
  },{capture:true});
  on(mark,'click',()=>runAction('mark'));on(remove,'click',()=>runAction('remove'));
  on(connect,'click',()=>runAction('connect'));on(disconnect,'click',()=>runAction('disconnect'));on(dismiss,'click',clearSelection);
  on(document,'pointerdown',e=>{if(!menu.hidden&&!menu.contains(e.target))closeMenu();},{capture:true});
  on(window,'scroll',()=>{if(!menu.hidden)closeMenu();},{capture:true,passive:true});
  on(window,'resize',closeMenu);
  on(menu,'keydown',e=>{
    if(!['ArrowDown','ArrowUp','Home','End'].includes(e.key))return;
    e.preventDefault();e.stopPropagation();
    const items=[...menu.querySelectorAll('button:not(:disabled)')],index=items.indexOf(document.activeElement);
    const next=e.key==='Home'?0:e.key==='End'?items.length-1:(index+(e.key==='ArrowDown'?1:-1)+items.length)%items.length;
    items[next]?.focus();
  });
  on(window,'keydown',e=>{
    if(e.key==='Escape'&&!menu.hidden)closeMenu();
    const factor=scope.Actions.zoomKey(e);if(factor===null)return;
    e.preventDefault();e.stopImmediatePropagation();closeMenu();zoomBy(factor);
  },{capture:true});
  const resize=new ResizeObserver(()=>{if(!closed)try {syncView();}catch(e){showError(e);}});resize.observe(stage);
  function tick() {
    const state=bridge.read();
    frame=state.frame;
    if(active) {
      if(state.props.playing&&frame>=model.end) {
        bridge.pause();if(frame>model.end)bridge.seek(model.end);frame=model.end;
      } else if(state.props.playing&&frame<model.start) {bridge.seek(model.start);frame=model.start;}
      if(lastExpected&&Math.abs(state.scroll-lastExpected.scrollLeft)>1&&Math.abs(state.frameWidth-lastExpected.frameWidth)<.01) {
        const offset=state.scroll/lastExpected.frameWidth-model.start+.5;
        model.offset=Math.max(0,Math.min(model.count-model.span,offset));
      }
      model.follow(frame);
      syncView();
    } else draw();
  }
  draw();
  return {stage,host,total,identity,tick,
    valid:()=>stage.isConnected&&controls.isConnected&&identity===lfrIdentity()&&bridge.read().total===total,
    status:()=>({ready:true,active,start:model.start,end:model.end,zoom:model.zoom,visible:model.visibleFrames(),current:frame,total,width,error}),
    destroy(){closed=true;events.abort();resize.disconnect();if(stage.isConnected)try{bridge.restore();}catch{}controls.remove();panWrap.remove();ruler.remove();menu.remove();host.classList.remove('lfr-host','lfr-context-open');}
  };
}
function lfrTick() {
  if(lfrDestroyed)return;
  try {
    if(lfrMount&&!lfrMount.valid()){lfrMount.destroy();lfrMount=null;}
    if(!lfrMount&&performance.now()-lfrLastScan>400) {
      lfrLastScan=performance.now();
      const candidates=[...document.querySelectorAll('.lsf-timeline .timeline-stage')].filter(el=>el.clientWidth>0&&el.getClientRects().length);
      for(const stage of candidates) {
        const bridge=scope.Native.find(stage);
        if(bridge) {lfrMount=lfrCreate(stage,bridge);if(lfrMount)break;}
      }
      lfrError=candidates.length?'当前时间轴尚未就绪或版本不兼容':'正在等待视频预览条';
    }
    lfrMount?.tick();
  } catch(e) {
    lfrError=e.message;console.warn('[预览条帧范围]',e);
    lfrMount?.destroy();lfrMount=null;
  }
}
const lfrTimer=setInterval(lfrTick,80);
window.__LS_FRAME_RANGE={
  get status(){return lfrMount?.status()||{ready:false,error:lfrError};},
  destroy(){if(lfrDestroyed)return;lfrDestroyed=true;clearInterval(lfrTimer);lfrMount?.destroy();lfrMount=null;lfrStyle.remove();if(window.__LS_FRAME_RANGE===this)delete window.__LS_FRAME_RANGE;}
};
lfrTick();

})();
