'use strict';
const fs=require('node:fs');
const fsp=fs.promises;
const path=require('node:path');
const crypto=require('node:crypto');
const {execFile}=require('node:child_process');
const {DatabaseSync}=require('node:sqlite');
const supportedExtensions=['.txt','.md','.markdown','.csv','.tsv','.docx','.xlsx','.xlsm','.pptx','.pptm','.pdf','.doc','.xls','.ppt'];
const eligible=new Set(supportedExtensions);
const normalize=value=>String(value||'').normalize('NFKC').toLowerCase().replace(/\s+/g,' ').trim();
const stamp=file=>`${Number(file.size)}:${Math.trunc(Number(file.mtime))}`;
const failure=(message,status=400)=>Object.assign(new Error(message),{status});

function createDocumentSearch({dataDir,rootKey,python,getFiles,checkedFile,timeout=35000}){
 const cacheDir=path.join(dataDir,'document-search');fs.mkdirSync(cacheDir,{recursive:true});
 const key=crypto.createHash('sha256').update(String(rootKey||'default')).digest('hex').slice(0,24);
 const db=new DatabaseSync(path.join(cacheDir,key+'.sqlite'));
 db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA cache_size=-2048; PRAGMA busy_timeout=3000; CREATE TABLE IF NOT EXISTS documents(id TEXT PRIMARY KEY, stamp TEXT NOT NULL, name TEXT NOT NULL, rel TEXT NOT NULL, status TEXT NOT NULL, reason TEXT NOT NULL DEFAULT \'\', characters INTEGER NOT NULL DEFAULT 0, warnings TEXT NOT NULL DEFAULT \'[]\'); CREATE TABLE IF NOT EXISTS chunks(doc TEXT NOT NULL, seq INTEGER NOT NULL, locator TEXT NOT NULL, text TEXT NOT NULL, normalized TEXT NOT NULL, PRIMARY KEY(doc,seq)); CREATE INDEX IF NOT EXISTS chunks_doc ON chunks(doc);');
 if(!db.prepare('PRAGMA table_info(documents)').all().some(column=>column.name==='searchmeta'))db.exec("ALTER TABLE documents ADD COLUMN searchmeta TEXT NOT NULL DEFAULT ''");
 // Interrupted workers are retried; a partial extraction is never committed.
 db.exec("UPDATE documents SET status='pending' WHERE status='indexing'");
 let enabled=false,stopped=false,running=false,worker=null,workerPromise=null,pumpTimer=null,closing=null,lastError='';
 let queue=[],queued=new Set();
 const listFiles=()=>{const value=getFiles();return value instanceof Map?[...value.values()]:Array.isArray(value)?value:[];};
 const currentMap=()=>new Map(listFiles().filter(file=>eligible.has(String(file.ext||path.extname(file.name||'')).toLowerCase())).map(file=>[file.id,file]));
 const putDoc=db.prepare('INSERT INTO documents(id,stamp,name,rel,status,reason,characters,warnings,searchmeta) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET stamp=excluded.stamp,name=excluded.name,rel=excluded.rel,status=excluded.status,reason=excluded.reason,characters=excluded.characters,warnings=excluded.warnings,searchmeta=excluded.searchmeta');
 const deleteChunks=db.prepare('DELETE FROM chunks WHERE doc=?');
 const deleteDoc=db.prepare('DELETE FROM documents WHERE id=?');
 const putChunk=db.prepare('INSERT INTO chunks(doc,seq,locator,text,normalized) VALUES(?,?,?,?,?)');
 function transaction(action){db.exec('BEGIN');try{action();db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}}
 function reconcile(){
  if(stopped)return;
  const current=currentMap(),old=new Map(db.prepare('SELECT * FROM documents').all().map(row=>[row.id,row]));
  transaction(()=>{
   for(const row of old.values())if(!current.has(row.id)){deleteChunks.run(row.id);deleteDoc.run(row.id);}
   for(const file of current.values()){
    const row=old.get(file.id),changed=!row||row.stamp!==stamp(file);
    const searchmeta=normalize(file.name+' '+file.rel);
    if(changed){deleteChunks.run(file.id);putDoc.run(file.id,stamp(file),file.name,file.rel,'pending','',0,'[]',searchmeta);}
    else if(row.rel!==file.rel||row.name!==file.name||row.searchmeta!==searchmeta)db.prepare('UPDATE documents SET rel=?,name=?,searchmeta=? WHERE id=?').run(file.rel,file.name,searchmeta,file.id);
   }
  });
  if(enabled){for(const row of db.prepare("SELECT id FROM documents WHERE status='pending'").all())if(!queued.has(row.id)){queue.push(row.id);queued.add(row.id);}schedule();}
 }
 function schedule(){if(stopped||running||pumpTimer||!queue.length)return;pumpTimer=setTimeout(()=>{pumpTimer=null;pump().catch(error=>{lastError=error.message;});},10);}
 function run(file){
  if(stopped)return Promise.reject(failure('正文检索已停止',503));
  if(!python)return Promise.resolve({status:'unsupported',reason:'没有配置本地文档读取运行环境',chunks:[],characters:0,warnings:[]});
  return new Promise((resolve,reject)=>{
   worker=execFile(python,[path.join(__dirname,'document_extract.py'),file.actual],{windowsHide:true,timeout,maxBuffer:8_000_000,encoding:'utf8'},(error,stdout)=>{
    worker=null;if(stopped)return reject(failure('正文检索已停止',503));
    if(error)return resolve({status:'failed',reason:error.killed?'读取超时，已停止该文件的解析':'文档读取进程失败',chunks:[],characters:0,warnings:[]});
    try{const value=JSON.parse(stdout);if(!Array.isArray(value.chunks)||!['ready','empty','failed','unsupported','truncated'].includes(value.status))throw new Error('格式异常');resolve(value);}catch{return resolve({status:'failed',reason:'正文读取结果无效',chunks:[],characters:0,warnings:[]});}
   });
  });
 }
 async function pump(){
  if(stopped||running)return;running=true;
  try{while(!stopped&&queue.length){
   const id=queue.shift();queued.delete(id);const snapshot=currentMap().get(id),entry=db.prepare('SELECT * FROM documents WHERE id=?').get(id);
   if(!snapshot||!entry||entry.status!=='pending')continue;
   const expected=stamp(snapshot);db.prepare("UPDATE documents SET status='indexing' WHERE id=?").run(id);
   let result;
   try{
    const file=await checkedFile(id),before=await fsp.stat(file.actual);
    if(stopped)break;
    if(`${before.size}:${Math.trunc(before.mtimeMs)}`!==expected){db.prepare("UPDATE documents SET status='pending' WHERE id=?").run(id);continue;}
    workerPromise=run(file);result=await workerPromise;workerPromise=null;
    if(stopped)break;
    const after=await fsp.stat(file.actual),latest=currentMap().get(id),latestRow=db.prepare('SELECT stamp FROM documents WHERE id=?').get(id);
    if(!latest||!latestRow||latestRow.stamp!==expected||stamp(latest)!==expected||`${after.size}:${Math.trunc(after.mtimeMs)}`!==expected){if(latestRow)db.prepare("UPDATE documents SET status='pending' WHERE id=?").run(id);continue;}
   }catch(error){if(stopped)break;result={status:'failed',reason:error.status===404?'来源已移动或不可访问':'无法读取文件',chunks:[],characters:0,warnings:[]};}
   if(stopped)break;
   transaction(()=>{
    deleteChunks.run(id);putDoc.run(id,expected,snapshot.name,snapshot.rel,result.status,String(result.reason||'').slice(0,500),Number(result.characters)||0,JSON.stringify(result.warnings||[]),normalize(snapshot.name+' '+snapshot.rel));
    for(let i=0;i<Math.min(result.chunks.length,8000);i++){const c=result.chunks[i],text=String(c.text||'').slice(0,4000),locator=String(c.locator||'').slice(0,240);putChunk.run(id,i,locator,text,normalize(locator+' '+text));}
   });
   // Yield to HTTP handlers and file watcher updates between documents.
   await new Promise(resolve=>setTimeout(resolve,15));
  }}finally{running=false;workerPromise=null;schedule();}
 }
 function status(){
  if(stopped)return {enabled,stopped:true,running:false,total:0,indexed:0,pending:0,failed:0,unsupported:0,truncated:0,noText:0,partial:0,complete:false,supportedExtensions,details:{failed:[],unsupported:[],noText:[],truncated:[],partial:[]}};
  const counts={total:0,indexed:0,pending:0,failed:0,unsupported:0,truncated:0,noText:0};
  for(const row of db.prepare('SELECT status,COUNT(*) AS count FROM documents GROUP BY status').all()){
   counts.total+=row.count;if(['ready','truncated','empty'].includes(row.status))counts.indexed+=row.count;
   if(['pending','indexing'].includes(row.status))counts.pending+=row.count;
   if(row.status==='failed')counts.failed+=row.count;if(row.status==='unsupported')counts.unsupported+=row.count;if(row.status==='truncated')counts.truncated+=row.count;if(row.status==='empty')counts.noText+=row.count;
  }
  const details={failed:[],unsupported:[],noText:[],truncated:[],partial:[]};
  for(const row of db.prepare("SELECT id,name,rel,status,reason,warnings FROM documents WHERE status IN ('failed','unsupported','empty','truncated') ORDER BY rel").all()){
   const field=row.status==='empty'?'noText':row.status;if(details[field].length<50)details[field].push({id:row.id,name:row.name,rel:row.rel,reason:row.reason,warnings:JSON.parse(row.warnings)});
  }
  const partialRows=db.prepare("SELECT id,name,rel,warnings FROM documents WHERE status='ready' AND warnings<>'[]'").all();
  for(const row of partialRows.slice(0,50))details.partial.push({id:row.id,name:row.name,rel:row.rel,reason:JSON.parse(row.warnings).join('；'),warnings:JSON.parse(row.warnings)});
  return {enabled,running,total:counts.total,...counts,partial:partialRows.length,complete:enabled&&counts.pending===0,supportedExtensions,details,message:lastError||(!enabled?'输入关键字后建立正文索引':counts.pending?'正在建立正文索引，当前结果会继续补充':'正文索引已更新'),limits:{maxFileMB:100,maxCharacters:600000,maxChunks:8000,timeoutSeconds:timeout/1000},legacy:'旧版 doc/xls/ppt 使用本机 Windows 文档筛选器，缺失时会列明',ocr:false};
 }
 function start(){if(stopped)throw failure('正文检索已停止',503);enabled=true;reconcile();return status();}
 function refresh(){if(stopped)return status();reconcile();return status();}
 function snippet(text,tokens){const lower=normalize(text);let position=-1;for(const token of tokens){const found=lower.indexOf(token);if(found>=0&&(position<0||found<position))position=found;}position=Math.max(0,position);const start=Math.max(0,position-75),end=Math.min(text.length,start+300);return (start?'…':'')+text.slice(start,end)+(end<text.length?'…':'');}
 async function search({query,scope='',limit=50,offset=0}={}){
  if(stopped)throw failure('正文检索已停止',503);
  if(typeof query!=='string'||query.length>160||typeof scope!=='string')throw failure('检索关键字过长或范围无效');
  const tokens=[...new Set(normalize(query).split(' ').filter(Boolean))];if(tokens.length>12)throw failure('请减少检索关键词');
  if(!tokens.length)return {results:[],total:0,index:status()};
  start();limit=Math.max(1,Math.min(200,Math.trunc(Number(limit)||50)));offset=Math.max(0,Math.min(30000,Math.trunc(Number(offset)||0)));
  if(scope){const current=currentMap(),inScope=id=>{const f=current.get(id);return f&&(f.rel===scope||f.rel.startsWith(scope+'/'));};queue=[...queue.filter(inScope),...queue.filter(id=>!inScope(id))];}
  // Tokens can mix filename/path and body matches, or different pages/cells.
  // At least one body hit is required; the ordinary browser already lists metadata-only matches.
  const conditions=tokens.map(()=>"(instr(d.searchmeta,?)>0 OR EXISTS(SELECT 1 FROM chunks c WHERE c.doc=d.id AND instr(c.normalized,?)>0))");
  conditions.push('EXISTS(SELECT 1 FROM chunks c WHERE c.doc=d.id AND ('+tokens.map(()=> 'instr(c.normalized,?)>0').join(' OR ')+'))');
  const params=[...tokens.flatMap(token=>[token,token]),...tokens];if(scope){conditions.push('(d.rel=? OR substr(d.rel,1,?)=?)');params.push(scope,scope.length+1,scope+'/');}
  const where="d.status IN ('ready','truncated') AND "+conditions.join(' AND ');
  const total=db.prepare('SELECT COUNT(*) AS count FROM documents d WHERE '+where).get(...params).count;
  const rows=db.prepare('SELECT d.id,d.status,d.reason,d.warnings FROM documents d WHERE '+where+' ORDER BY d.rel LIMIT ? OFFSET ?').all(...params,limit,offset);
  const matches=db.prepare('SELECT locator,text FROM chunks WHERE doc=? AND ('+tokens.map(()=> 'instr(normalized,?)>0').join(' OR ')+') ORDER BY ('+tokens.map(()=> 'CASE WHEN instr(normalized,?)>0 THEN 1 ELSE 0 END').join('+')+') DESC,seq LIMIT 3');
  const results=[];
  for(const row of rows){
   try{await checkedFile(row.id);}catch{continue;}
   const parts=matches.all(row.id,...tokens,...tokens).map(part=>({locator:part.locator,snippet:snippet(part.text,tokens)}));
   results.push({id:row.id,snippet:parts[0]?.snippet||'',locator:parts[0]?.locator||'',matches:parts,truncated:row.status==='truncated',warnings:JSON.parse(row.warnings)});
  }
  return {results,total,index:status()};
 }
 function close(){
  if(closing)return closing;stopped=true;clearTimeout(pumpTimer);queue=[];queued.clear();if(worker)worker.kill('SIGKILL');
  closing=(async()=>{if(workerPromise)await workerPromise.catch(()=>{});while(running)await new Promise(resolve=>setTimeout(resolve,10));db.close();})();return closing;
 }
 reconcile();
 return {start,refresh,search,status,close,supportedExtensions};
}
module.exports={createDocumentSearch,supportedExtensions};
