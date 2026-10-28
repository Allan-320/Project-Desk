'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');

const MAX_NOTES=2000,MAX_BYTES=32*1024*1024;
const text=(value,max)=>typeof value==='string'&&value.length<=max;
const plain=value=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value);
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const idOK=value=>text(value,200)&&value.length>0;
const dateOK=value=>text(value,40)&&Number.isFinite(Date.parse(value));
const sourceOK=s=>plain(s)&&idOK(s.sourceId)&&idOK(s.fileId)&&text(s.name,1000)&&text(s.rel,10000)&&text(s.project,1000)&&text(s.locator,500)&&text(s.excerpt,5000)&&Number.isFinite(s.mtime)&&Number.isFinite(s.size)&&s.size>=0&&dateOK(s.capturedAt);
function noteOK(n){
 return plain(n)&&idOK(n.id)&&text(n.title,200)&&text(n.body,50000)&&Array.isArray(n.tags)&&n.tags.length<=20&&n.tags.every(t=>text(t,50))&&Array.isArray(n.sources)&&n.sources.length<=30&&n.sources.every(sourceOK)&&new Set(n.sources.map(s=>s.sourceId)).size===n.sources.length&&typeof n.pinned==='boolean'&&dateOK(n.createdAt)&&dateOK(n.updatedAt);
}
function documentOK(value){
 return plain(value)&&value.format===1&&Number.isSafeInteger(value.revision)&&value.revision>=0&&Array.isArray(value.notes)&&value.notes.length<=MAX_NOTES&&value.notes.every(noteOK)&&new Set(value.notes.map(n=>n.id)).size===value.notes.length;
}

async function createNotesController({dataDir,rootKey,getFiles,checkedFile,body,json,changed}){
 if(typeof rootKey!=='string'||!rootKey.match(/^[a-zA-Z0-9_-]{1,120}$/))throw new Error('无效的笔记库标识');
 const filePath=path.join(dataDir,rootKey+'-notes.json');
 await fs.mkdir(dataDir,{recursive:true});
 let document={format:1,revision:0,notes:[]},queue=Promise.resolve(),closed=false;
 try{
  const stat=await fs.stat(filePath);if(stat.size>MAX_BYTES)throw new Error('笔记库超过读取上限');
  const saved=JSON.parse(await fs.readFile(filePath,'utf8'));if(!documentOK(saved))throw new Error('笔记库格式无效');document=saved;
 }catch(error){if(error.code!=='ENOENT')throw new Error('笔记库无法读取，已保留原文件：'+error.message);}

 function snapshot(){
  const files=getFiles();
  return {revision:document.revision,notes:document.notes.map(note=>({...structuredClone(note),sources:note.sources.map(source=>{
   const f=files.get(source.fileId),current=f?{fileId:f.id,name:f.name,rel:f.rel,project:f.project||'',mtime:f.mtime,size:f.size}:null;
   return {...structuredClone(source),current,status:!current?'missing':current.mtime!==source.mtime||current.size!==source.size?'changed':'available'};
  })}))};
 }
 function revisionOK(input){
  if(!Number.isSafeInteger(input.revision)||input.revision<0)return fail('请刷新笔记库后再保存');
  if(input.revision!==document.revision)return fail('笔记库已在其他页面更新，请刷新后重试；当前编辑内容请保留。',409);
 }
 async function write(next){
  const content=JSON.stringify(next,null,2);if(Buffer.byteLength(content)>MAX_BYTES)return fail('笔记库容量已达上限，请先导出备份并整理记录',413);
  const temporary=filePath+'.'+crypto.randomUUID()+'.tmp';let handle;
  try{
   handle=await fs.open(temporary,'wx');await handle.writeFile(content,'utf8');await handle.sync();await handle.close();handle=null;
   await fs.rename(temporary,filePath);
  }catch(error){if(handle)await handle.close().catch(()=>{});await fs.unlink(temporary).catch(()=>{});throw Object.assign(new Error('笔记未保存，请重试（'+(error.code||'写入失败')+'）'),{status:500});}
  document=next;
  try{changed?.();}catch{/* Saving is already committed; notification failure must not imply data loss. */}
 }
 async function normalizeSources(values,old){
  if(!Array.isArray(values)||values.length>30)return fail('每条笔记最多关联 30 个来源');
  const result=[],seen=new Set();
  for(const value of values){
   if(!plain(value)||!idOK(value.fileId))return fail('来源文件无效');
   const locator=value.locator??'',excerpt=value.excerpt??'';
   if(!text(locator,500)||!text(excerpt,5000))return fail('来源定位或摘录过长');
   // Existing snapshots are immutable, including when a source has changed or disappeared.
   const previous=value.sourceId?old.find(s=>s.sourceId===value.sourceId):old.find(s=>s.fileId===value.fileId&&s.locator===locator&&s.excerpt===excerpt);
   if(value.sourceId&&!previous)return fail('来源记录不存在，请刷新后重试',409);
   if(previous){
    if(previous.fileId!==value.fileId)return fail('不能更改已有来源的文件标识');
    if(!seen.has(previous.sourceId)){result.push(structuredClone(previous));seen.add(previous.sourceId);}continue;
   }
   if(!getFiles().has(value.fileId))return fail('只能关联当前资料库内的文件',403);
   const f=await checkedFile(value.fileId);
   const item={sourceId:crypto.randomUUID(),fileId:f.id,name:f.name,rel:f.rel,project:f.project||'',locator,excerpt,mtime:f.mtime,size:f.size,capturedAt:new Date().toISOString()};
   // Never accept client-supplied paths, names, timestamps, or availability flags.
   result.push(item);seen.add(item.sourceId);
  }
  return result;
 }
 function ordered(notes){return [...notes.filter(n=>n.pinned),...notes.filter(n=>!n.pinned)];}
 async function mutate(route,input){
  if(!plain(input))return fail('无效请求');revisionOK(input);
  const now=new Date().toISOString(),next=structuredClone(document);let code=200;
  if(route==='/api/notes/save'){
   const old=input.id?next.notes.find(n=>n.id===input.id):null;
   if(input.id&&!old)return fail('笔记不存在',404);
   if(input.id&&input.copyFromId)return fail('请分别使用编辑或另存为新笔记');
   const copy=input.copyFromId?next.notes.find(n=>n.id===input.copyFromId):null;
   if(input.copyFromId&&!copy)return fail('原笔记已不存在，当前编辑内容请保留',404);
   if(!text(input.title,200)||!text(input.body,50000)||!Array.isArray(input.tags)||input.tags.length>20||input.tags.some(t=>!text(t,50)))return fail('请检查笔记标题、正文或标签长度');
   const sources=await normalizeSources(input.sources,old?.sources||copy?.sources||[]);
   const title=input.title.trim(),bodyText=input.body;
   if(!title&&!bodyText.trim()&&!sources.length)return fail('写一点内容或关联一个来源后再保存');
   const tags=[...new Set(input.tags.map(t=>t.trim()).filter(Boolean))];
   const note={id:old?.id||crypto.randomUUID(),title,body:bodyText,tags,sources,pinned:old?.pinned||false,createdAt:old?.createdAt||now,updatedAt:now};
   if(old){
    if(JSON.stringify({...note,updatedAt:old.updatedAt})===JSON.stringify(old))return {code:200,result:snapshot()};
    next.notes=next.notes.map(n=>n.id===note.id?note:n);
   }else{
    if(next.notes.length>=MAX_NOTES)return fail('笔记数量已达上限，请先导出备份并整理记录',413);
    next.notes=[...next.notes.filter(n=>n.pinned),note,...next.notes.filter(n=>!n.pinned)];code=201;
   }
  }else if(route==='/api/notes/pin'){
   const note=next.notes.find(n=>n.id===input.id);if(!note)return fail('笔记不存在',404);
   if(typeof input.pinned!=='boolean')return fail('请选择置顶或取消置顶');
   if(note.pinned===input.pinned)return {code:200,result:snapshot()};
   note.pinned=input.pinned;note.updatedAt=now;
   const rest=next.notes.filter(n=>n.id!==note.id);
   next.notes=input.pinned?[note,...ordered(rest)]:[...rest.filter(n=>n.pinned),note,...rest.filter(n=>!n.pinned)];
  }else if(route==='/api/notes/reorder'){
   if(!['before','after'].includes(input.position))return fail('请选择有效的排列位置');
   const note=next.notes.find(n=>n.id===input.id),target=next.notes.find(n=>n.id===input.targetId);
   if(!note||!target)return fail('笔记位置已变化，请刷新后重试',404);
   if(note.pinned!==target.pinned)return fail('请在同一分组内排列，或先置顶 / 取消置顶');
   if(note.id===target.id)return {code:200,result:snapshot()};
   const rest=next.notes.filter(n=>n.id!==note.id),at=rest.findIndex(n=>n.id===target.id)+(input.position==='after'?1:0);rest.splice(at,0,note);
   if(rest.every((n,i)=>n.id===next.notes[i].id))return {code:200,result:snapshot()};
   next.notes=rest;
  }else if(route==='/api/notes/delete'){
   if(!next.notes.some(n=>n.id===input.id))return fail('笔记不存在',404);
   next.notes=next.notes.filter(n=>n.id!==input.id);
  }else return fail('不存在的笔记操作',404);
  next.revision++;await write(next);return {code,result:snapshot()};
 }
 async function handle(req,res,url){
  try{
   if(closed)return fail('资料台正在停止',503);
   if(req.method==='GET'&&url.pathname==='/api/notes'){
    await queue;return json(res,200,snapshot());
   }
   if(req.method==='GET'&&url.pathname==='/api/notes/export'){
    await queue;
    res.setHeader('Content-Disposition','attachment; filename="project-notes.json"');
    return json(res,200,{...structuredClone(document),exportedAt:new Date().toISOString()});
   }
   if(req.method!=='POST')return fail('请使用笔记保存操作',405);
   const input=await body(req);
   if(closed)return fail('资料台正在停止',503);
   const task=queue.then(()=>mutate(url.pathname,input));queue=task.then(()=>{},()=>{});
   const {code,result}=await task;return json(res,code,result);
  }catch(error){return json(res,error.status||500,{error:error.message,...(error.status===409?snapshot():{})});}
 }
 async function close(){closed=true;await queue;}
 return {handle,close};
}
module.exports={createNotesController};
