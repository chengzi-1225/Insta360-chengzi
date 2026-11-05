// ==UserScript==
// @name         Insta360 预览条帧范围
// @namespace    insta360.frame-range
// @version      1.0.0
// @description  在视频原生预览条上方限定帧范围、放大缩小与横向平移；预览条自动适应面板宽度
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
lfrStyle.textContent=".lfr-host{max-width:100%!important;min-width:0!important}\n.lfr-host>.resizable-box{width:100%!important;min-width:0!important;max-width:100%!important}\n.lfr-host>.resizable-box>.handle.right,.lfr-host>.resizable-box>.handle.bottom-right{display:none!important}\n.lfr-host .pro-timeline-wrap{width:100%!important;min-width:0!important}\n.lfr-host .timeline-stage{min-width:80px!important;position:relative!important}\n.lfr-host .timeline-wrap-left{max-width:100px!important}\n.lfr-controls{box-sizing:border-box!important;display:flex!important;align-items:center!important;flex-wrap:wrap!important;gap:6px 10px!important;padding:7px 8px!important;border:1px solid #dce5f0!important;border-radius:5px!important;margin:5px 0 6px!important;background:#f6f9fd!important;color:#4b617c!important;font:12px/1.5 -apple-system,BlinkMacSystemFont,\"Segoe UI\",\"PingFang SC\",sans-serif!important;max-width:100%!important;min-width:0!important}\n.lfr-controls *{box-sizing:border-box!important}\n.lfr-controls .lfr-group{display:flex!important;align-items:center!important;gap:5px!important;flex-wrap:wrap!important;min-width:0!important}\n.lfr-controls .lfr-label{color:#70849c!important;white-space:nowrap!important}\n.lfr-controls label{display:inline-flex!important;align-items:center!important;gap:4px!important;margin:0!important;font:inherit!important}\n.lfr-controls input[type=number]{width:63px!important;min-width:0!important;height:27px!important;padding:2px 5px!important;background:#fff!important;border:1px solid #ced9e7!important;border-radius:4px!important;color:#334e70!important;font:12px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace!important}\n.lfr-controls button{display:inline-flex!important;align-items:center!important;justify-content:center!important;min-width:0!important;height:27px!important;margin:0!important;padding:2px 8px!important;border:1px solid #ced9e7!important;border-radius:4px!important;background:#fff!important;color:#435f81!important;cursor:pointer!important;font:inherit!important;line-height:1.5!important;white-space:nowrap!important}\n.lfr-controls button:hover{background:#eaf3ff!important;border-color:#93b8e5!important}\n.lfr-controls button:disabled{opacity:.35!important;cursor:default!important}\n.lfr-controls button.lfr-apply{background:#287ddd!important;border-color:#287ddd!important;color:#fff!important}\n.lfr-controls .lfr-zoom{width:27px!important;padding:0!important;font-size:18px!important}\n.lfr-controls output{font:11px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace!important;min-width:38px!important;text-align:center!important;color:#537294!important}\n.lfr-controls .lfr-status{flex:1 1 130px!important;min-width:0!important;color:#7f91a8!important;font-size:11px!important;overflow-wrap:anywhere!important}\n.lfr-controls .lfr-status[data-error=true]{color:#c64b45!important}\n.lfr-controls :focus-visible{outline:2px solid #78b6ff!important;outline-offset:2px!important}\n.lfr-controls input[aria-invalid=true]{border-color:#d85a51!important}\n.lfr-ruler{position:absolute!important;top:0!important;left:0!important;height:52px!important;width:100%!important;pointer-events:none!important;z-index:2!important;background:#1a1a1a!important}\n.lfr-pan-wrap{display:flex!important;align-items:center!important;gap:8px!important;padding:2px 8px!important;background:#f6f9fd!important;border:1px solid #e0e8f1!important;border-top:0!important;border-radius:0 0 4px 4px!important;color:#8294aa!important;font:10px/1.5 -apple-system,BlinkMacSystemFont,\"PingFang SC\",sans-serif!important}\n.lfr-pan-wrap[hidden],.lfr-ruler[hidden]{display:none!important}\n.lfr-pan-wrap input{flex:1!important;min-width:30px!important;height:16px!important;accent-color:#4188da!important;cursor:ew-resize!important;margin:0!important;padding:0!important}\n.lfr-pan-wrap span{white-space:nowrap!important}\n";
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
  const rangeGroup=lfrNode('div',{class:'lfr-group'}),zoomGroup=lfrNode('div',{class:'lfr-group'});
  const start=lfrNode('input',{type:'number',min:'1',max:String(total),step:'1','aria-label':'起始帧'});
  const end=lfrNode('input',{type:'number',min:'1',max:String(total),step:'1','aria-label':'结束帧'});
  start.value=String(model.start);end.value=String(model.end);
  for(const [text,input] of [['起',start],['止',end]]) {
    const label=lfrNode('label',{},text);label.append(input);rangeGroup.append(label);
  }
  const button=(text,label,cls='')=>lfrNode('button',{type:'button','aria-label':label,class:cls,title:label},text);
  const apply=button('只看这段','只显示指定帧范围','lfr-apply');rangeGroup.append(apply);
  const minus=button('−','缩小预览条','lfr-zoom'),plus=button('＋','放大预览条','lfr-zoom');
  const scale=lfrNode('output',{'aria-label':'预览条缩放倍数'},'1×');
  const fit=button('适应区间','完整显示当前帧区间'),all=button('全部','恢复全部帧');
  zoomGroup.append(minus,scale,plus,fit,all);
  const status=lfrNode('span',{class:'lfr-status',role:'status','aria-live':'polite'});
  controls.append(rangeGroup,zoomGroup,status);
  const panWrap=lfrNode('div',{class:'lfr-pan-wrap',hidden:''});
  const pan=lfrNode('input',{type:'range',min:'0',max:'1000',step:'1',value:'0','aria-label':'平移预览条'});
  panWrap.append(lfrNode('span',{},'平移'),pan,lfrNode('span',{},'限于所选区间'));
  const ruler=lfrNode('canvas',{class:'lfr-ruler',hidden:'',role:'img','aria-label':'预览帧号尺'});
  box.before(controls);box.after(panWrap);stage.append(ruler);host.classList.add('lfr-host');
  let active=false,error='',frame=initial.frame,width=0,lastDraw='',lastExpected=null,closed=false;
  const identity=lfrIdentity();

  function message(text,isError=false) {
    if(status.textContent!==text)status.textContent=text;
    status.dataset.error=String(isError);
  }
  function showError(e) {
    error=e.message||String(e);
    start.setAttribute('aria-invalid','true');end.setAttribute('aria-invalid','true');
    message(error,true);
  }
  function clearError() {error='';start.removeAttribute('aria-invalid');end.removeAttribute('aria-invalid');}
  function draw(force=false) {
    ruler.hidden=!active;panWrap.hidden=!active||model.zoom<=1;
    minus.disabled=!active||model.zoom<=1;plus.disabled=active&&model.zoom>=model.maxZoom;fit.disabled=!active;
    scale.textContent=active?`${Number(model.zoom.toFixed(2))}×`:'1×';
    if(!active) {if(!error)message(`全部 ${total} 帧 · 输入起止帧后应用`);return;}
    const visible=model.visibleFrames();
    if(document.activeElement!==pan)pan.value=String(Math.round(model.offset/Math.max(1e-10,model.count-model.span)*1000));
    if(!error)message(`${visible[0]}–${visible[1]} / ${model.start}–${model.end} · 当前 ${frame}`);
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
      const a=Number(start.value),b=Number(end.value);
      model.setRange(a,b);clearError();
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
    on(input,'keydown',e=>{e.stopPropagation();if(e.key==='Enter'){e.preventDefault();activate();}});
  }
  on(pan,'input',()=>{model.offset=Number(pan.value)/1000*(model.count-model.span);syncView();});
  on(host,'keydown',e=>{
    if(e.target.closest('input,textarea,select,[contenteditable=true]')||e.ctrlKey||e.metaKey||e.altKey)return;
    if(!['+','=','-'].includes(e.key))return;
    e.preventDefault();e.stopImmediatePropagation();zoomBy(e.key==='-'?.5:2);
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
      if(state.props.playing&&frame>=model.start&&frame<=model.end)model.select(frame);
      model.current=frame;
      syncView();
    } else draw();
  }
  draw();
  return {stage,host,total,identity,tick,
    valid:()=>stage.isConnected&&controls.isConnected&&identity===lfrIdentity()&&bridge.read().total===total,
    status:()=>({ready:true,active,start:model.start,end:model.end,zoom:model.zoom,visible:model.visibleFrames(),current:frame,total,width,error}),
    destroy(){closed=true;events.abort();resize.disconnect();if(stage.isConnected)try{bridge.restore();}catch{}controls.remove();panWrap.remove();ruler.remove();host.classList.remove('lfr-host');}
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
