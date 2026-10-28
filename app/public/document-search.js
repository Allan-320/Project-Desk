'use strict';
let documentSearchState={key:'',query:'',scope:'',hits:new Map(),total:0,index:null,busy:false,error:'',offset:0,version:-1},documentSearchTimer=null,documentSearchFlight=null,documentSearchSerial=0;
function documentSearchReset(){clearTimeout(documentSearchTimer);documentSearchFlight?.abort();documentSearchFlight=null;documentSearchSerial++;documentSearchState={key:'',query:'',scope:'',hits:new Map(),total:0,index:null,busy:false,error:'',offset:0,version:-1};}
function documentSearchSync(text,scope){
 const q=text.trim();if(!q){if(documentSearchState.key)documentSearchReset();return;}
 const key=JSON.stringify([data.root,q,scope]);
 if(key!==documentSearchState.key){documentSearchReset();documentSearchState={...documentSearchState,key,query:q,scope,busy:true,version:data.version};documentSearchTimer=setTimeout(()=>documentSearchFetch(false),180);}
 else if(documentSearchState.version!==data.version&&!documentSearchState.busy){documentSearchState.version=data.version;clearTimeout(documentSearchTimer);documentSearchTimer=setTimeout(()=>documentSearchFetch(false),300);}
}
function documentSearchVisible(){return serviceMode==='running'&&['files','folders'].includes(view)&&documentSearchState.key&&resourceQuery.trim()===documentSearchState.query&&(view==='files'?resourceScope:focusDir||'')===documentSearchState.scope;}
async function documentSearchFetch(append=false){
 if(!documentSearchVisible()||documentSearchFlight)return;
 const serial=documentSearchSerial,context=documentSearchState,controller=new AbortController();documentSearchFlight=controller;context.busy=true;context.error='';
 try{
  const params=new URLSearchParams({q:context.query,scope:context.scope,limit:'100',offset:String(append?context.offset:0)});
  const response=await fetch('/api/document-search?'+params,{signal:controller.signal}),result=await response.json();if(!response.ok)throw new Error(result.error||'正文搜索暂不可用');
  if(serial!==documentSearchSerial)return;
  if(!append)context.hits=new Map();for(const hit of result.results||[])context.hits.set(hit.id,hit);
  context.offset=(append?context.offset:0)+(result.results||[]).length;context.total=result.total||0;context.index=result.index;
 }catch(e){if(e.name!=='AbortError'&&serial===documentSearchSerial)context.error=e.message;}
 finally{
  if(documentSearchFlight===controller)documentSearchFlight=null;
  if(serial===documentSearchSerial){context.busy=false;if(documentSearchVisible())renderWorkspaceResources();
   clearTimeout(documentSearchTimer);if(documentSearchVisible()&&!context.error&&(context.index?.pending||context.index?.running))documentSearchTimer=setTimeout(()=>documentSearchFetch(false),1800);
  }
 }
}
function documentSearchHit(id){return documentSearchState.hits.get(id);}
function documentSearchMoreAvailable(){return documentSearchState.total>documentSearchState.offset;}
async function documentSearchMore(){if(documentSearchMoreAvailable()&&!documentSearchState.busy){clearTimeout(documentSearchTimer);await documentSearchFetch(true);}}
function documentSearchDisplayText(text){return String(text||'').normalize('NFKC').replace(/\s+/g,' ').trim();}
function documentSearchTerms(){return [...new Set(documentSearchDisplayText(documentSearchState.query).toLowerCase().split(' ').filter(Boolean))];}
function documentSearchRanges(text,terms){
 const lower=text.toLowerCase(),ranges=[];
 for(const term of terms){let from=0,index;while((index=lower.indexOf(term,from))!==-1){ranges.push({start:index,end:index+term.length,term});from=index+Math.max(1,term.length);}}
 return ranges.sort((a,b)=>a.start-b.start||b.end-a.end);
}
function documentSearchMarkedRange(text,ranges,start=0,end=text.length){
 let cursor=start,html='';
 for(const range of ranges){const a=Math.max(start,range.start,cursor),b=Math.min(end,range.end);if(b<=a)continue;html+=esc(text.slice(cursor,a))+'<mark>'+esc(text.slice(a,b))+'</mark>';cursor=b;}
 return html+esc(text.slice(cursor,end));
}
function documentSearchMark(text){const clean=documentSearchDisplayText(text);return documentSearchMarkedRange(clean,documentSearchRanges(clean,documentSearchTerms()));}
function documentSearchCompact(text,terms=documentSearchTerms()){
 const clean=documentSearchDisplayText(text),ranges=documentSearchRanges(clean,terms);if(!ranges.length)return null;
 let best=null;
 for(const range of ranges){
  let start=Math.max(0,range.start-18),end=Math.min(clean.length,start+72);
  // Never cut through a surrogate pair when a filename or excerpt contains emoji.
  if(start&&/[\uDC00-\uDFFF]/.test(clean[start]))start--;
  if(end<clean.length&&/[\uDC00-\uDFFF]/.test(clean[end]))end--;
  const visible=ranges.filter(r=>r.start<end&&r.end>start),score=new Set(visible.map(r=>r.term)).size;
  end=Math.min(end,Math.max(...visible.map(r=>r.end))+18);
  const candidate={start,end,score};if(!best||score>best.score)best=candidate;
 }
 const {start,end,score}=best,prefix=start?'…':'',suffix=end<clean.length?'…':'';
 return {score,text:prefix+clean.slice(start,end)+suffix,html:prefix+documentSearchMarkedRange(clean,ranges,start,end)+suffix};
}
function documentSearchSnippet(file){
 const hit=documentSearchHit(file.id);if(!hit)return '';
 const terms=documentSearchTerms(),parts=hit.matches?.length?hit.matches:[hit];
 const candidates=parts.map((part,index)=>({part,index,compact:documentSearchCompact(part.snippet,terms),locationScore:documentSearchRanges(documentSearchDisplayText(part.locator),terms).length}));
 candidates.sort((a,b)=>(b.compact?.score||0)-(a.compact?.score||0)||b.locationScore-a.locationScore||a.index-b.index);
 const {part,index,compact}=candidates[0],locator=part.locator||'文档内容';
 // Keep the source match index: capturing a note must retain the unabridged excerpt.
 return `<div class="document-hit"><div class="document-hit-part"><span class="document-hit-location" title="${esc(locator)}">${compact?'':'命中位置：'}${esc(locator)}</span>${compact?`<p>${compact.html}</p>`:''}<button data-document-capture="${esc(file.id)}" data-document-match="${index}">记下来</button></div></div>`;
}
function documentSearchStatusHTML(){
 const s=documentSearchState;if(!s.key)return '';const index=s.index;
 const pending=index&&(index.pending||index.running),truncated=index?.truncated||0,failed=index?.failed||0,unread=index?.noText||0,unsupported=index?.unsupported||0,incomplete=index?.partial||0;
 const status=s.error?s.error:!index?'正在查找文档内容…':pending?`正文索引 ${index.indexed||0} / ${index.total||0} · 结果持续补齐`:`正文检索已完成${s.total?' · '+s.total+' 份命中':''}`;
 const partial=failed||unread||truncated||unsupported||incomplete;
 return `<div class="document-search-status" role="status"><span${s.error?' class="document-search-error"':''}>${esc(status)}</span>${s.busy?'<span class="document-search-working" aria-label="正在查询"></span>':''}${partial?`<button id="document-search-details">检索提示</button>`:''}${s.error?'<button id="document-search-retry">重试</button>':''}</div>`;
}
async function showDocumentSearchDetails(){
 let dialog=$('document-search-dialog');if(!dialog){dialog=document.createElement('dialog');dialog.id='document-search-dialog';document.body.append(dialog);}
 dialog.innerHTML='<div class="dialog-head"><h2>文档检索情况</h2><button id="document-search-close">关闭</button></div><div id="document-search-details-body">读取中…</div>';
 dialog.querySelector('#document-search-close').onclick=()=>dialog.close();dialog.showModal();
 try{const index=await request('/api/document-search/status');const details=index.details||{};
  const rows=[];for(const [key,label] of [['failed','读取失败'],['unsupported','暂不支持'],['noText','未读到文字'],['truncated','仅检索了部分内容'],['partial','部分页面或内容未能读取']]){
   const items=Array.isArray(details[key])?details[key]:[];if(items.length)rows.push(`<h3>${label} · ${index[key]||items.length}</h3>`+items.map(item=>`<div class="document-search-issue"><strong>${esc(item.rel||item.name||item.id||'文档')}</strong><p>${esc(item.reason||item.message||label)}</p></div>`).join(''));else if(index[key])rows.push(`<p>${label}：${index[key]} 份</p>`);
  }
  $('document-search-details-body').innerHTML=`<p class="muted">已索引 ${index.indexed||0} / ${index.total||0}。扫描件图片需要先识别文字；未读取的内容不会算作“没有命中”。</p>${rows.join('')||'<p>暂无异常。</p>'}`;
 }catch(e){$('document-search-details-body').textContent=e.message;}
}
function initDocumentSearch(){
 $('global-file-search').maxLength=160;$('search').maxLength=160;
 $('global-file-search').placeholder='搜索文件名、标签或文档关键词…';$('global-file-search').setAttribute('aria-label','搜索文件名、标签或文档关键词');
 document.addEventListener('click',event=>{const b=event.target.closest('button');if(!b)return;
  if(b.dataset.documentCapture){const hit=documentSearchHit(b.dataset.documentCapture);if(!hit)return;const part=hit.matches?.[Number(b.dataset.documentMatch)||0]||hit;openNoteCapture(b.dataset.documentCapture,{excerpt:part.snippet||'',locator:part.locator||''});}
  if(b.id==='document-search-details')showDocumentSearchDetails();
  if(b.id==='document-search-retry')documentSearchFetch(false);
 });
 document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'&&documentSearchVisible()&&!documentSearchState.busy)documentSearchFetch(false);});
}
