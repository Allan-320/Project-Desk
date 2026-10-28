const http=require('node:http');
const fs=require('node:fs');
const fsp=fs.promises;
const path=require('node:path');
const crypto=require('node:crypto');
const {execFile}=require('node:child_process');
const {saveIncoming}=require('./imports.cjs');
const {createProgressController}=require('./progress.cjs');
const {createThumbnails}=require('./thumbnails.cjs');
const {reconcileDirectoryLinks}=require('./directory-links.cjs');
const {createDocumentSearch}=require('./document-search.cjs');
const {createNotesController}=require('./notes.cjs');
const hash=x=>crypto.createHash('sha256').update(x).digest('hex').slice(0,24);
const inside=(root,file)=>{const rel=path.relative(root,file);return rel===''||(!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel));};
const extension=f=>path.extname(f).toLowerCase();
const mime={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif','.bmp':'image/bmp','.pdf':'application/pdf','.mp4':'video/mp4','.webm':'video/webm','.mp3':'audio/mpeg','.wav':'audio/wav','.txt':'text/plain; charset=utf-8','.csv':'text/plain; charset=utf-8','.md':'text/plain; charset=utf-8','.json':'text/plain; charset=utf-8'};
async function start(config){
 const root=await fsp.realpath(config.root),dataDir=config.dataDir||path.join(__dirname,'data');
 await fsp.mkdir(dataDir,{recursive:true});
 const stateFile=path.join(dataDir,hash(config.stateKey||root.toLowerCase())+'.json');
 let state={files:{},projects:{},nodes:[],todos:[]};
 try{const saved=JSON.parse(await fsp.readFile(stateFile,'utf8'));if(saved&&saved.files&&saved.projects&&Array.isArray(saved.nodes))state=saved;}catch(e){if(e.code!=='ENOENT')throw new Error('标注文件无法读取，已停止启动以保留数据：'+e.message);}
 if(!Array.isArray(state.todos))state.todos=[];
 let writes=Promise.resolve();
 let documentSearch=null,notes=null;
 const session=crypto.randomBytes(32).toString('hex'),clients=new Set(),sockets=new Set(),streams=new Set(),children=new Set(),childJobs=new Set(),mutationWaiters=new Set();
 let records=[],directories=[],byId=new Map(),version=0,scanning=false,again=false,scanError='',lastScan=null,watchStatus='启动中',debounce,rescan,stopping=false,closePromise=null,activeMutations=0,scanIdle=Promise.resolve(),finishScan;
 let resolveClosed,rejectClosed;const closed=new Promise((resolve,reject)=>{resolveClosed=resolve;rejectClosed=reject;});closed.catch(()=>{});
 const skip=name=>name.startsWith('~$')||name.startsWith('.project-desk-import-')||['.git','node_modules','$RECYCLE.BIN','System Volume Information'].includes(name);
 async function scan(){
  if(stopping)return;
  if(scanning){again=true;return;}scanning=true;scanIdle=new Promise(resolve=>{finishScan=resolve;});
  try{
   const next=[],dirs=[],directoryIdentities=[];let truncated=false;
   async function walk(dir,depth=0){
    if(depth>40||next.length>=30000){truncated=true;return;}
    let entries;try{entries=await fsp.readdir(dir,{withFileTypes:true});}catch(e){throw new Error('无法读取 '+path.relative(root,dir)+'：'+e.message);}
    for(const ent of entries){if(skip(ent.name)||ent.isSymbolicLink())continue;const abs=path.join(dir,ent.name);const rel=path.relative(root,abs).split(path.sep).join('/');
     if(ent.isDirectory()){dirs.push(rel);const ds=await fsp.stat(abs,{bigint:true});directoryIdentities.push({id:ds.ino!==0n?hash(`${ds.dev}:${ds.ino}`):'',rel});await walk(abs,depth+1);}
     else if(ent.isFile()){
      if(next.length>=30000){truncated=true;break;}
      let stat;try{stat=await fsp.stat(abs,{bigint:true});}catch(e){if(['ENOENT','EACCES','EPERM','EBUSY'].includes(e.code))continue;throw e;}
      const parts=rel.split('/'),project=parts.length>1?parts[0]:'',folder=parts.slice(1,-1).join('/');
      const id=hash(stat.ino!==0n?`${stat.dev}:${stat.ino}`:rel.toLowerCase());
      next.push({id,name:ent.name,rel,project,folder,group:folder.split('/')[0]||'项目根目录',ext:extension(ent.name),size:Number(stat.size),mtime:Number(stat.mtimeMs),birthtime:Number(stat.birthtimeMs)>0?Number(stat.birthtimeMs):null,abs});
     }
    }
   }
   await walk(root);next.sort((a,b)=>b.mtime-a.mtime||a.rel.localeCompare(b.rel,'zh-CN'));
   const fingerprint=hash(JSON.stringify(next.map(f=>[f.id,f.rel,f.birthtime,f.mtime,f.size]))+JSON.stringify(dirs));
   const changed=fingerprint!==scan.fingerprint||Boolean(scanError);
   const linkResult=truncated?{changed:false}:reconcileDirectoryLinks(state,directoryIdentities,next);if(linkResult.changed)await save();
   records=next;directories=dirs;byId=new Map(next.map(f=>[f.id,f]));scan.fingerprint=fingerprint;scanError=truncated?'目录过大，已显示前 30000 个文件，请缩小接入范围。':'';lastScan=new Date().toISOString();
   if(changed||linkResult.changed){version++;broadcast();documentSearch?.refresh();}
  }catch(e){scanError=e.message;version++;broadcast();}
  finally{scanning=false;finishScan();if(again&&!stopping){again=false;clearTimeout(rescan);rescan=setTimeout(scan,100);}}
 }
 function broadcast(){for(const res of clients)res.write(`data: ${JSON.stringify({version,error:scanError})}\n\n`);}
 await scan();
 let watcher;
 if(config.watch!==false){try{watcher=fs.watch(root,{recursive:true},()=>{if(stopping)return;clearTimeout(debounce);debounce=setTimeout(scan,650);});watcher.on('error',()=>{watchStatus='定时校验';});watchStatus='实时监听';}catch{watchStatus='定时校验';}}
 else watchStatus='手动刷新';
 const fallback=config.watch!==false?setInterval(scan,60000):null;
 const heartbeat=setInterval(()=>{for(const res of clients)res.write(': heartbeat\n\n');},25000);
 const json=(res,code,value)=>{res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value));};
 let address;
 async function body(req){let length=0,chunks=[];for await(const chunk of req){length+=chunk.length;if(length>200000)throw Object.assign(new Error('请求过大'),{status:413});chunks.push(chunk);}try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw Object.assign(new Error('无效请求'),{status:400});}}
 async function save(){const content=JSON.stringify(state,null,2);writes=writes.catch(()=>{}).then(async()=>{const tmp=stateFile+'.tmp';await fsp.writeFile(tmp,content,'utf8');await fsp.rename(tmp,stateFile);});return writes;}
 async function checkedFile(id){const f=byId.get(id);if(!f)throw Object.assign(new Error('文件不在当前索引中，请刷新'),{status:404});let actual;try{actual=await fsp.realpath(f.abs);}catch{throw Object.assign(new Error('原文件已移动或不可访问'),{status:404});}if(!inside(root,actual))throw Object.assign(new Error('文件超出接入目录'),{status:403});return {...f,actual};}
 const managedDirectory=key=>typeof key==='string'&&(key===''||directories.includes(key));
 const inDirectory=(file,key)=>key===''||file.rel.startsWith(key+'/');
 const progress=createProgressController({state,save,changed:()=>{version++;broadcast();},managedDirectory,getFiles:()=>byId,body,json});
 const rootKey=path.basename(stateFile,'.json');
 try{
  notes=await createNotesController({dataDir,rootKey,getFiles:()=>byId,checkedFile,body,json,changed:()=>{version++;broadcast();}});
  documentSearch=createDocumentSearch({dataDir,rootKey,python:config.python,getFiles:()=>records,checkedFile});
 }catch(error){
  stopping=true;clearInterval(fallback);clearInterval(heartbeat);clearTimeout(debounce);clearTimeout(rescan);watcher?.close();await notes?.close();await documentSearch?.close();throw error;
 }
 const thumbnails=createThumbnails({dataDir,python:config.python});
 function runHelper(command,args,options){
  if(stopping)return Promise.reject(Object.assign(new Error('资料台正在停止'),{status:503}));
  let child;const job=new Promise((resolve,reject)=>{child=execFile(command,args,options,(error,stdout,stderr)=>{if(error)reject(error);else resolve({stdout,stderr});});children.add(child);});
  childJobs.add(job);job.finally(()=>{children.delete(child);childJobs.delete(job);}).catch(()=>{});return job;
 }
 function pipeFile(res,file,options){
  if(stopping){res.destroy();return;}
  const stream=fs.createReadStream(file,options);streams.add(stream);stream.once('close',()=>streams.delete(stream));stream.once('error',()=>res.destroy());res.once('close',()=>stream.destroy());return stream.pipe(res);
 }
 function snapshot(){
  const projects=new Map();for(const dir of directories){const top=dir.split('/')[0];if(!projects.has(top))projects.set(top,{key:top,name:top,count:0,mtime:0});}
  for(const f of records){const key=f.project;if(!projects.has(key))projects.set(key,{key,name:'目录直属文件',count:0,mtime:0});const p=projects.get(key);p.count++;p.mtime=Math.max(p.mtime,f.mtime);}
  return {root,launcherPath:config.launcherPath||path.join(__dirname,'启动项目资料台.cmd'),version,lastScan,watchStatus,error:scanError,projects:[...projects.values()].sort((a,b)=>b.mtime-a.mtime),directories,files:records.map(({abs,...f})=>f),state};
 }
 const server=http.createServer(async(req,res)=>{
  let mutation=false;
  try{
   const expectedHost=`127.0.0.1:${address?.port||config.port}`;
   if(req.headers.host!==expectedHost&&req.headers.host!==`localhost:${address?.port||config.port}`)return json(res,403,{error:'仅允许本机访问'});
   const url=new URL(req.url,'http://'+expectedHost);
   const origin=req.headers.origin;if(origin&&!['http://'+expectedHost,`http://localhost:${address?.port||config.port}`].includes(origin))return json(res,403,{error:'来源不允许'});
   if(req.headers['sec-fetch-site']==='cross-site')return json(res,403,{error:'不允许跨站访问'});
   if(stopping)return json(res,503,{error:'资料台正在停止',stopping:true});
   const authenticated=(req.headers.cookie||'').split(';').some(x=>x.trim()==='desk_session='+session);
   if(req.method==='GET'&&url.pathname==='/'){
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Set-Cookie':`desk_session=${session}; HttpOnly; SameSite=Strict; Path=/`,'Cache-Control':'no-store','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; media-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'",'X-Content-Type-Options':'nosniff'});return pipeFile(res,path.join(__dirname,'public','index.html'));
   }
   if(['GET','HEAD'].includes(req.method)&&['/app.js','/todos.js','/progress.js','/files-ui.js','/navigation.js','/workspace.js','/followup.js','/lifecycle.js','/lifecycle.css','/design.js','/design.css','/home-design.css','/navigation-design.css','/progress-management.css','/timeline-design.css','/workspace.css','/app.css','/favicon.svg','/notes.js','/notes.css','/document-search.js','/document-search.css','/spreadsheet-preview.js','/spreadsheet-preview.css','/word-preview.js','/word-preview.css','/word-layout-compat.js','/vendor/jszip.min.js','/vendor/docx-preview.min.js'].includes(url.pathname)){
    res.writeHead(200,{'Content-Type':url.pathname.endsWith('.js')?'text/javascript; charset=utf-8':url.pathname.endsWith('.svg')?'image/svg+xml':'text/css; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});return pipeFile(res,path.join(__dirname,'public',url.pathname.slice(1)));
   }
   if(!authenticated)return json(res,401,{error:'请先打开工作台首页'});
   if(req.method==='GET'&&url.pathname==='/word-preview-frame'){
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data: blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'"});
    return res.end('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Word 文档预览</title></head><body></body></html>');
   }
   if(req.method==='GET'&&url.pathname==='/api/identity')return json(res,200,{instanceId:config.instanceId,workspaceId:config.stateKey});
   if(url.pathname==='/api/shutdown'){
    if(req.method!=='POST')return json(res,405,{error:'请使用停止操作'});
    const input=await body(req);if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length)return json(res,400,{error:'停止请求应为空对象'});
    if(stopping)return json(res,503,{error:'资料台正在停止',stopping:true});
    if(activeMutations||scanning)return json(res,409,{error:'正在保存或更新资料，请稍后重试',busy:true});
    stopping=true;let scheduled=false;const finishShutdown=()=>{if(scheduled)return;scheduled=true;close().catch(error=>{console.error('停止资料台失败：'+error.message);process.exitCode=1;});};res.once('finish',finishShutdown);res.once('close',finishShutdown);return json(res,200,{ok:true,stopping:true});
   }
   if(req.method==='POST'){activeMutations++;mutation=true;}
   if(url.pathname==='/api/notes'||url.pathname.startsWith('/api/notes/'))return await notes.handle(req,res,url);
   if(req.method==='GET'&&url.pathname==='/api/document-search/status')return json(res,200,documentSearch.status());
   if(req.method==='GET'&&url.pathname==='/api/document-search'){
    const query=(url.searchParams.get('q')||'').trim(),scope=url.searchParams.get('scope')||'';
    if(!query||query.length>160)return json(res,400,{error:'请输入 1 至 160 个字的关键词'});
    if(!managedDirectory(scope))return json(res,400,{error:'搜索目录不存在，请刷新目录'});
    return json(res,200,await documentSearch.search({query,scope,limit:Number(url.searchParams.get('limit'))||100,offset:Number(url.searchParams.get('offset'))||0}));
   }
   if(req.method==='GET'&&url.pathname.startsWith('/api/thumbnail/')){
    const file=await checkedFile(decodeURIComponent(url.pathname.slice('/api/thumbnail/'.length)));
    try{const bytes=await thumbnails.get(file);res.writeHead(200,{'Content-Type':'image/jpeg','Cache-Control':'private, max-age=3600','X-Content-Type-Options':'nosniff'});return res.end(bytes);}
    catch{res.writeHead(200,{'Content-Type':'image/svg+xml','Cache-Control':'private, max-age=60','X-Content-Type-Options':'nosniff'});return res.end('<svg xmlns="http://www.w3.org/2000/svg" width="384" height="256"><rect width="384" height="256" fill="#f0f3f0"/><path d="M162 65h42l22 22v90h-64zM204 65v25h22" fill="none" stroke="#809183" stroke-width="4"/><path d="M176 112h34m-34 17h34m-34 17h24" stroke="#809183" stroke-width="3"/></svg>');}
   }
   if(url.pathname.startsWith('/api/progress/'))return await progress.handle(req,res,url);
   if(req.method==='GET'&&url.pathname==='/api/snapshot')return json(res,200,snapshot());
   if(req.method==='GET'&&url.pathname==='/api/events'){
    res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive'});res.write(`data: ${JSON.stringify({version})}\n\n`);clients.add(res);req.on('close',()=>clients.delete(res));return;
   }
   if(req.method==='POST'&&url.pathname==='/api/refresh'){await scan();return json(res,200,{version,error:scanError});}
   if(req.method==='POST'&&url.pathname==='/api/import'){
    const rel=url.searchParams.get('dir'),name=url.searchParams.get('name');if(typeof rel!=='string'||(rel!==''&&!directories.includes(rel)))return json(res,403,{error:'请投放到已接入的实际文件夹'});
    const saved=await saveIncoming(req,{root,rel,name,dataDir,lastModified:req.headers['x-file-modified']});await scan();return json(res,201,saved);
   }
   if(req.method==='POST'&&url.pathname==='/api/annotation'){
    const data=await body(req);const f=await checkedFile(data.id);
    if(typeof data.note!=='string'||data.note.length>3000||!Array.isArray(data.tags)||data.tags.length>12||data.tags.some(t=>typeof t!=='string'||t.length>40))return json(res,400,{error:'备注或标签不符合要求'});
    state.files[f.id]={note:data.note,tags:[...new Set(data.tags)],pinned:Boolean(data.pinned)};await save();version++;broadcast();return json(res,200,{ok:true,version});
   }
   if(req.method==='POST'&&url.pathname==='/api/project'){
    const data=await body(req);if(!managedDirectory(data.project)||typeof data.next!=='string'||data.next.length>500)return json(res,400,{error:'目录不存在或内容过长'});
    state.projects[data.project]={next:data.next};await save();version++;broadcast();return json(res,200,{ok:true,version});
   }
   if(req.method==='POST'&&url.pathname==='/api/todos/from-next'){
    const input=await body(req),next=state.projects[input.project]?.next?.trim();
    if(!managedDirectory(input.project)||!next)return json(res,400,{error:'当前目录没有下一步'});
    const sourceKey='next:'+input.project,existing=state.todos.find(t=>t.sourceKey===sourceKey&&t.sourceText===next);
    if(existing)return json(res,200,{ok:true,todo:existing,version});
    const now=new Date().toISOString(),todo={id:crypto.randomUUID(),title:next,project:input.project,note:'',status:'todo',due:'',today:false,priority:false,fileIds:[],sourceKey,sourceText:next,created:now,updated:now};
    state.todos.push(todo);await save();version++;broadcast();return json(res,201,{ok:true,todo,version});
   }
   if(req.method==='POST'&&url.pathname==='/api/todos'){
    const input=await body(req),existing=input.id?state.todos.find(t=>t.id===input.id):null;
    if(input.id&&!existing)return json(res,404,{error:'待办不存在'});
    const validDate=typeof input.due==='string'&&(!input.due||(/^\d{4}-\d{2}-\d{2}$/.test(input.due)&&Number.isFinite(Date.parse(input.due))&&new Date(input.due).toISOString().slice(0,10)===input.due));
    if(typeof input.title!=='string'||!input.title.trim()||input.title.length>500||typeof input.note!=='string'||input.note.length>3000||typeof input.project!=='string'||(!managedDirectory(input.project)&&input.project!==existing?.project)||!['todo','doing','waiting','done'].includes(input.status)||!validDate||typeof input.today!=='boolean'||typeof input.priority!=='boolean'||!Array.isArray(input.fileIds)||input.fileIds.length>20||input.fileIds.some(id=>typeof id!=='string'||((!byId.has(id)||(input.project&&!inDirectory(byId.get(id),input.project)))&&!existing?.fileIds.includes(id))))return json(res,400,{error:'请检查待办内容、日期及关联目录'});
    const now=new Date().toISOString(),plannedDate=input.today?new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()):'',todo={...existing,id:existing?.id||crypto.randomUUID(),title:input.title.trim(),project:input.project,note:input.note,status:input.status,due:input.due,today:input.today,plannedDate,priority:input.priority,fileIds:[...new Set(input.fileIds)],created:existing?.created||now,updated:now};
    progress.syncFromTodo(todo);
    if(existing)state.todos=state.todos.map(t=>t.id===todo.id?todo:t);else state.todos.push(todo);
    await save();version++;broadcast();return json(res,existing?200:201,{ok:true,todo,version});
   }
   if(req.method==='POST'&&url.pathname==='/api/todos/delete'){
    const input=await body(req);if(!state.todos.some(t=>t.id===input.id))return json(res,404,{error:'待办不存在'});
    state.todos=state.todos.filter(t=>t.id!==input.id);await save();version++;broadcast();return json(res,200,{ok:true,version});
   }
   if(req.method==='POST'&&url.pathname==='/api/node'){
    const data=await body(req);if(!managedDirectory(data.project)||typeof data.title!=='string'||!data.title.trim()||data.title.length>100||typeof data.note!=='string'||data.note.length>1000||!['待开始','进行中','待确认','已完成'].includes(data.status)||typeof data.date!=='string'||(data.date&&!/^\d{4}-\d{2}-\d{2}$/.test(data.date))||!Array.isArray(data.fileIds)||data.fileIds.length>100)return json(res,400,{error:'时间线内容不符合要求'});
    const existing=data.id?state.nodes.find(n=>n.id===data.id&&n.project===data.project):null;if(data.id&&!existing)return json(res,404,{error:'节点不存在'});
    if(data.fileIds.some(id=>(!byId.has(id)||!inDirectory(byId.get(id),data.project))&&!existing?.fileIds.includes(id)))return json(res,400,{error:'只能新增关联当前目录范围内可访问的文件'});
    const node={id:existing?.id||crypto.randomUUID(),project:data.project,title:data.title.trim(),note:data.note,date:data.date,status:data.status,fileIds:[...new Set(data.fileIds)],created:existing?.created||new Date().toISOString()};
    if(existing)state.nodes=state.nodes.map(n=>n.id===node.id?node:n);else state.nodes.push(node);
    await save();version++;broadcast();return json(res,200,{ok:true,node,version});
   }
   if(req.method==='POST'&&url.pathname==='/api/open'){
    const data=await body(req),f=await checkedFile(data.id);const target=data.folder?path.dirname(f.actual):f.actual;
    if(!data.folder&&['.exe','.cmd','.bat','.ps1','.vbs','.js','.msi','.scr','.lnk'].includes(f.ext))return json(res,415,{error:'此入口只打开项目资料，请在资源管理器中处理程序文件'});
    const script='Start-Process -FilePath '+"'"+target.replace(/'/g,"''")+"'";
    await runHelper('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,timeout:12000});return json(res,200,{ok:true});
   }
   if(req.method==='POST'&&url.pathname==='/api/open-directory'){
    const data=await body(req);if(typeof data.rel!=='string'||(data.rel!==''&&!directories.includes(data.rel)))return json(res,403,{error:'只能打开接入目录中的实际文件夹'});
    const actual=await fsp.realpath(path.join(root,...data.rel.split('/')));if(!inside(root,actual))return json(res,403,{error:'目录超出接入范围'});
    const script='Start-Process -FilePath '+"'"+actual.replace(/'/g,"''")+"'";
    await runHelper('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,timeout:12000});return json(res,200,{ok:true});
   }
   if(req.method==='GET'&&url.pathname.startsWith('/api/office/')){
    const f=await checkedFile(decodeURIComponent(url.pathname.slice('/api/office/'.length)));if(!['.xlsx','.xlsm','.docx'].includes(f.ext))return json(res,415,{error:'此格式请用本机软件打开'});
    if(!config.python)return json(res,503,{error:'未配置内容预览运行环境'});
    if(url.searchParams.has('layout')){
     if(f.ext!=='.docx'||url.searchParams.get('layout')!=='1')return json(res,400,{error:'文档预览参数无效'});
     const output=await runHelper(config.python,[path.join(__dirname,'word_preview_check.py'),f.actual],{windowsHide:true,timeout:15000,maxBuffer:4000000});const preview=JSON.parse(output.stdout);return json(res,preview.error?422:200,preview);
    }
    const args=[path.join(__dirname,'office_preview.py'),f.actual];
    for(const [key,flag,min,max] of [['sheet','--sheet-index',0,100000],['rowStart','--row-start',1,1048576],['colStart','--col-start',1,16384]]){
     if(!url.searchParams.has(key))continue;const value=url.searchParams.get(key);if(!/^\d{1,7}$/.test(value)||Number(value)<min||Number(value)>max)return json(res,400,{error:'表格位置参数无效'});args.push(flag,value);
    }
    const output=await runHelper(config.python,args,{windowsHide:true,timeout:20000,maxBuffer:8000000});const preview=JSON.parse(output.stdout);return json(res,preview.error?422:200,preview);
   }
   if(['GET','HEAD'].includes(req.method)&&url.pathname.startsWith('/file/')){
    const f=await checkedFile(decodeURIComponent(url.pathname.slice(6))),stat=await fsp.stat(f.actual);if(!stat.isFile())return json(res,404,{error:'不是文件'});
    const type=mime[f.ext]||'application/octet-stream';const headers={'Content-Type':type,'X-Content-Type-Options':'nosniff','Cache-Control':'no-store','Accept-Ranges':'bytes','Content-Disposition':(mime[f.ext]?'inline':'attachment')+"; filename*=UTF-8''"+encodeURIComponent(f.name),'Content-Security-Policy':"default-src 'none'"};
    let start=0,end=stat.size-1,status=200;
    if(req.headers.range){const m=/^bytes=(\d*)-(\d*)$/.exec(req.headers.range);if(!m||(!m[1]&&!m[2])){res.writeHead(416,{'Content-Range':`bytes */${stat.size}`});return res.end();}if(!m[1])start=Math.max(0,stat.size-Number(m[2]));else start=Number(m[1]);if(m[1]&&m[2])end=Math.min(end,Number(m[2]));if(start>end||start>=stat.size){res.writeHead(416,{'Content-Range':`bytes */${stat.size}`});return res.end();}status=206;headers['Content-Range']=`bytes ${start}-${end}/${stat.size}`;}
    headers['Content-Length']=Math.max(0,end-start+1);res.writeHead(status,headers);if(req.method==='HEAD'||!stat.size)return res.end();return pipeFile(res,f.actual,{start,end});
   }
   json(res,404,{error:'不存在的入口'});
  }catch(e){if(!res.destroyed){if(!res.headersSent)json(res,e.status||500,{error:e.message});else res.destroy();}}
  finally{if(mutation&&--activeMutations===0){for(const resolve of mutationWaiters)resolve();mutationWaiters.clear();}}
 });
 server.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});
 try{await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(config.port??18764,'127.0.0.1',resolve);});}catch(error){await close();throw error;}address=server.address();
 function close(){
  if(closePromise)return closePromise;
  stopping=true;again=false;clearInterval(fallback);clearInterval(heartbeat);clearTimeout(debounce);clearTimeout(rescan);watcher?.close();
  const serverClosed=new Promise(resolve=>server.close(resolve));
  closePromise=(async()=>{
   await scanIdle;if(activeMutations)await new Promise(resolve=>mutationWaiters.add(resolve));await writes;
   for(const child of children)child.kill('SIGKILL');
   await Promise.allSettled([...childJobs,thumbnails.close(),documentSearch?.close(),notes?.close()]);
   for(const res of clients){if(!res.destroyed)res.end('event: shutdown\ndata: {}\n\n');}clients.clear();
   // Give completed shutdown and SSE responses one local event-loop turn to flush.
   await new Promise(resolve=>setTimeout(resolve,25));
   for(const stream of streams)stream.destroy();server.closeAllConnections();for(const socket of sockets)socket.destroy();
   await serverClosed;
  })();closePromise.then(resolveClosed,rejectClosed);return closePromise;
 }
 return {server,url:`http://127.0.0.1:${address.port}/`,scan,snapshot,close,closed};
}
module.exports={start,inside};
if(require.main===module){(async()=>{const config=JSON.parse(await fsp.readFile(process.argv[2]||path.join(__dirname,'config.json'),'utf8'));const app=await start(config);console.log(JSON.stringify({url:app.url,root:app.snapshot().root,files:app.snapshot().files.length,watch:app.snapshot().watchStatus,pid:process.pid}));for(const sig of ['SIGINT','SIGTERM'])process.once(sig,()=>{app.close().catch(error=>{console.error(error.message);process.exitCode=1;});});})().catch(e=>{console.error(e.message);process.exitCode=1;});}
