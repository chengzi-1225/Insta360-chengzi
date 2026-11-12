const fs=require('node:fs');
const path=require('node:path');
let source=fs.readFileSync(path.join(__dirname,'../Insta360我的工作台.user.js'),'utf8');
// 只在独立测试页适配 file:// 路由与模拟跳转，生产脚本保持真实路由和接口。
source=source.replace("var path = location.pathname;","var path = window.__demoRoute;")
 .replace("new URL(center.getAttribute('href'), location.origin)","new URL(center.getAttribute('href'), 'https://demo.local')")
 .replace("url.origin !== location.origin","url.origin !== 'https://demo.local'")
 .replace("new URL(path, location.origin)","new URL(path, 'https://demo.local')")
 .replace("location.assign(workUrl(project, mode));","window.__demoGo(workUrl(project, mode));");
const html=fs.readFileSync(path.join(__dirname,'demo.template.html'),'utf8').replace('/*__WORKBENCH_SCRIPT__*/',()=>source.replace(/<\/script/gi,'<\\/script'));
fs.writeFileSync(path.join(__dirname,'../docs/demos/insta360-workbench.html'),html);
console.log('已生成自包含测试页面');
