'use strict';
const $=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const query=new URLSearchParams(location.search);
let timelineBasis=localStorage.getItem('desk-date-basis')==='mtime'?'mtime':'birthtime';
let timelineOrder=localStorage.getItem('desk-timeline-order')==='asc'?'asc':'desc';
const timelineDayLimits=new Map();
const dayFormat=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'});
let data=null,project=query.get('project')||localStorage.getItem('desk-project')||null,view=['files','timeline','board','progress','folders','notes'].includes(query.get('view'))?query.get('view'):'progress',selected=null,editing=null,linked=new Set(),expanded=new Set(),toastTimer,loading=null,events,retryTimer;
let focusDir=query.get('folder')||project||'',navOpen=new Set(),navReady=false,editingScope='';
try{navOpen=new Set(JSON.parse(localStorage.getItem('desk-nav-open')||'[]'));}catch{}
const formatSize=n=>n<1024?n+' B':n<1048576?(n/1024).toFixed(0)+' KB':(n/1048576).toFixed(1)+' MB';
const time=n=>new Date(n).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});
const projectFiles=()=>data?data.files.filter(f=>f.project===project&&(focusDir===project||f.rel.startsWith(focusDir+'/'))):[];
const annotation=id=>data.state.files[id]||{tags:[],note:'',pinned:false};
function toast(s){$('toast').textContent=s;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').textContent='',4500);}
async function request(url,options={}){const res=await fetch(url,options);const result=await res.json();if(!res.ok)throw new Error(result.error||'请求失败');return result;}
const post=async(url,body)=>{if(serviceMode!=='running'||serviceStopFlight)throw new Error('后台正在停止，请重新启动后再保存');servicePendingWrites++;try{return await request(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});}finally{servicePendingWrites--;}};
function error(e){$('error').hidden=false;$('error').textContent=e.message||String(e);}
function setURL(){const globalView=['home','files','board','progress','notes'].includes(view),params=new URLSearchParams(globalView?{view}:{project:project||'',view});if(view==='progress'&&progressSelected)params.set('progress',progressSelected);if(['files','folders'].includes(view)){if(resourceQuery)params.set('q',resourceQuery);if(resourceMode!=='daily')params.set('mode',resourceMode);if(view==='files'&&resourceScope)params.set('scope',resourceScope);}if(!globalView&&focusDir&&focusDir!==project)params.set('folder',focusDir);history.replaceState(null,'','/?'+params);localStorage.setItem('desk-project',project||'');localStorage.setItem('desk-view',view);}
async function load(){if(serviceMode!=='running')return;if(loading)return loading;loading=(async()=>{try{const incoming=await request('/api/snapshot');if(serviceMode!=='running')return;data=incoming;if(focusDir&&!data.directories.includes(focusDir)){focusDir=resolveDirectoryAlias(focusDir);if(data.directories.includes(focusDir))project=focusDir.split('/')[0];}if(!data.projects.some(p=>p.key===project))project=data.projects[0]?.key??'';render();if(selected)renderFileFollowups(selected);$('error').hidden=!data.error;if(data.error)$('error').textContent='目录读取提示：'+data.error+'。保留上一次索引，原资料和标注不变。';$('connection').textContent=data.watchStatus+' · '+data.files.length+' 个文件';$('scan-status').textContent='目录更新于 '+(data.lastScan?new Date(data.lastScan).toLocaleTimeString('zh-CN',{timeZone:'Asia/Shanghai'}):'尚未完成');setURL();}catch(e){if(serviceMode==='running'){$('connection').textContent='本机服务未连接';error(e);}}finally{loading=null;}})();return loading;}
function matches(f){const a=annotation(f.id),q=$('search').value.trim().toLowerCase();return `${f.name} ${f.folder} ${a.tags.join(' ')} ${a.note}`.toLowerCase().includes(q);}
function row(f){const a=annotation(f.id);return `<button class="file" data-file="${f.id}">${fileVisual(f,true)}<span class="file-text"><span class="filename">${esc(f.name)}</span><span class="meta">${f.folder?esc(f.folder)+' · ':''}${formatSize(f.size)} · ${time(f.mtime)}${a.pinned?' · 常用':''}</span>${a.tags.length?`<span class="tags">${a.tags.map(t=>`<span class="tag">${esc(t)}</span>`).join('')}</span>`:''}${a.note?`<span class="excerpt">${esc(a.note.slice(0,75))}${a.note.length>75?'…':''}</span>`:''}</span></button>`;}
const collapsedFolders=new Set();
function renderNavigation(){if(typeof renderSidebarUtilities==='function')renderSidebarUtilities();if(['files','folders','timeline'].includes(view))renderDirectoryNavigation();}
function selectDirectory(rel){rel=resolveDirectoryAlias(rel);if(!rel){openWorkspaceFiles();return;}resourceQuery='';resourceMode='daily';resourcePurpose='';resourceLimit=36;rememberDirectory(rel);view='folders';focusDir=rel;project=rel.split('/')[0];const parts=rel.split('/');for(let i=1;i<=parts.length;i++)navOpen.add(parts.slice(0,i).join('/'));$('search').value='';$('global-file-search').value='';expanded.clear();$('node-form').hidden=true;editing=null;render();setURL();localStorage.setItem('desk-nav-open',JSON.stringify([...navOpen]));window.scrollTo(0,0);}
function renderFolders(){renderWorkspaceResources();}
function renderLegacyFolders(){
 const searching=Boolean($('search').value.trim());
 const tree={name:'项目文件',rel:'',children:new Map(),files:[]};
 function ensure(rel){let node=tree,prefix=[];for(const name of rel.split('/').filter(Boolean)){prefix.push(name);if(!node.children.has(name))node.children.set(name,{name,rel:prefix.join('/'),children:new Map(),files:[]});node=node.children.get(name);}return node;}
 const base=focusDir||project;
 for(const dir of data.directories){if(base&&dir.startsWith(base+'/'))ensure(dir.slice(base.length+1));}
 for(const file of projectFiles()){const relative=file.rel.slice(base?base.length+1:0);ensure(relative.split('/').slice(0,-1).join('/')).files.push(file);}
 function tally(node){node.total=node.files.length;node.hits=node.files.filter(matches).length;for(const child of node.children.values()){tally(child);node.total+=child.total;node.hits+=child.hits;}}
 tally(tree);
 function directFiles(node,isRoot=false){const files=node.files.filter(matches).sort((a,b)=>Number(annotation(b.id).pinned)-Number(annotation(a.id).pinned)||b.mtime-a.mtime);if(!files.length)return '';const key='dir:'+node.rel,open=expanded.has(key),visible=files.slice(0,open?500:6);return `<div class="directory-files ${isRoot?'root-files':''}"><div class="direct-label">${isRoot?'直属文件':'直属文件'} <span>${files.length}</span></div><div class="files">${visible.map(row).join('')}</div>${files.length>6?`<button class="more" data-expand="${esc(key)}">${open?'收起文件':'展开其余 '+(files.length-6)+' 份直属文件'}</button>`:''}</div>`;}
 function folder(node,depth){if(searching&&!node.hits)return '';const full=[base,node.rel].filter(Boolean).join('/'),isOpen=searching||!collapsedFolders.has(full);const children=[...node.children.values()].sort((a,b)=>a.name.localeCompare(b.name,'zh-CN'));return `<details class="directory-branch depth-${Math.min(depth,4)}" data-tree="${esc(full)}" ${isOpen?'open':''}><summary><span class="folder-symbol" aria-hidden="true"></span><span class="folder-title">${esc(node.name)}</span><span class="folder-count">${node.total} 份${children.length?' · '+children.length+' 个下级目录':''}${searching?' · 匹配 '+node.hits+' 份':''}</span></summary><button class="directory-open" data-directory="${esc(full)}" aria-label="在电脑中打开文件夹：${esc(node.name)}">打开目录 ↗</button><div class="directory-contents">${directFiles(node)}${children.length?`<div class="directory-children">${children.map(c=>folder(c,depth+1)).join('')}</div>`:''}${!node.total&&!children.length?'<div class="directory-empty">空文件夹</div>':''}</div></details>`;}
 const children=[...tree.children.values()].sort((a,b)=>a.name.localeCompare(b.name,'zh-CN'));
 $('folder-groups').innerHTML=`<section class="directory-root"><div class="directory-root-head"><span class="root-symbol" aria-hidden="true">▣</span><h2>项目文件</h2><span>${children.length} 个一级文件夹 · ${tree.total} 份资料</span><button class="directory-root-open" data-directory="${esc(project)}">打开目录 ↗</button></div><div class="directory-root-body">${directFiles(tree,true)}<div class="directory-tree">${children.map(c=>folder(c,1)).join('')}</div>${searching&&!tree.hits?'<div class="empty">无搜索结果</div>':''}${!tree.total&&!children.length?'<div class="empty">暂无文件</div>':''}</div></section>`;
 const root=$('folder-groups').querySelector('.directory-root');root.dataset.dropDirectory=base;root.querySelector('[data-directory]').dataset.directory=base;
 if(base!==project){root.querySelector('.directory-root-head h2').textContent='当前目录';root.querySelector('.directory-root-open').textContent='打开目录 ↗';root.querySelector('.directory-root-head > span:not(.root-symbol)').textContent=children.length+' 个下级文件夹 · '+tree.total+' 份资料';const label=root.querySelector('.root-files .direct-label');if(label)label.firstChild.textContent='直属文件 ';}
 for(const branch of root.querySelectorAll('.directory-branch'))branch.dataset.dropDirectory=branch.dataset.tree;observeFileVisuals();
}
document.addEventListener('toggle',event=>{const details=event.target;if(details.isConnected&&details instanceof HTMLDetailsElement&&details.dataset.tree&&!$('search').value.trim()){details.open?collapsedFolders.delete(details.dataset.tree):collapsedFolders.add(details.dataset.tree);}},true);
function renderTimeline(){
 renderFileTimeline();
 const q=$('search').value.trim().toLowerCase();
 const scope=focusDir||project,scopeIds=new Set(projectFiles().map(f=>f.id));
 const nodes=data.state.nodes.filter(n=>n.project===scope||n.fileIds.some(id=>scopeIds.has(id))).filter(n=>`${n.title} ${n.note} ${n.fileIds.map(id=>data.files.find(f=>f.id===id)?.name||'').join(' ')}`.toLowerCase().includes(q)).sort((a,b)=>(a.date||'9999').localeCompare(b.date||'9999')||a.created.localeCompare(b.created));
 $('manual-count').textContent=nodes.length?' · '+nodes.length+' 个':'';
 $('timeline-list').innerHTML=nodes.map(n=>`<article class="node"><header class="node-heading"><time>${n.date||'未设日期'}</time><h2>${esc(n.title)}</h2><span class="tag">${esc(n.status)}</span><button data-edit-node="${esc(n.id)}">编辑</button></header>${n.note?`<p class="excerpt">${esc(n.note)}</p>`:''}<div class="node-files">${n.fileIds.map(id=>{const f=data.files.find(f=>f.id===id);return f?`<button data-file="${id}">${esc(f.name)} <span class="muted">${esc(f.folder||'项目根目录')}</span></button>`:'<span class="muted">关联文件暂不可用</span>';}).join('')||'<span class="muted">尚未关联文件</span>'}</div></article>`).join('')||'<div class="empty">暂无节点</div>';
}
function renderFileTimeline(){
 $('timeline-basis').value=timelineBasis;if($('timeline-order'))$('timeline-order').value=timelineOrder;
 const stamp=f=>Number.isFinite(f[timelineBasis])&&f[timelineBasis]>0?f[timelineBasis]:null;
 const direction=timelineOrder==='asc'?1:-1,rows=projectFiles().filter(matches).sort((a,b)=>{const left=stamp(a),right=stamp(b);if(left===null)return right===null?a.rel.localeCompare(b.rel,'zh-CN'):1;if(right===null)return -1;return direction*(left-right||a.rel.localeCompare(b.rel,'zh-CN'));});
 if(!rows.length){$('file-timeline').innerHTML='<div class="empty">当前没有匹配的资料。</div>';observeFileVisuals();return;}
 const dated=rows.filter(f=>stamp(f)!==null),unknown=rows.length-dated.length,earlier=rows.filter(f=>f.birthtime&&f.mtime<f.birthtime-60000).length;
 let earliest=Infinity,latest=-Infinity;for(const file of dated){const value=stamp(file);earliest=Math.min(earliest,value);latest=Math.max(latest,value);}
 const period=dated.length?dayFormat.format(earliest)+' 至 '+dayFormat.format(latest):'日期不可用';
 const months=new Map();for(const f of rows){const day=stamp(f)!==null?dayFormat.format(stamp(f)):'日期不可用',month=day==='日期不可用'?'日期不可用':day.slice(0,7);if(!months.has(month))months.set(month,new Map());const days=months.get(month);if(!days.has(day))days.set(day,[]);days.get(day).push(f);}
 const item=f=>{const a=annotation(f.id);return `<button class="history-file" data-file="${esc(f.id)}" data-history-stamp="${stamp(f)??''}" title="${esc(f.rel)}">${fileVisual(f,true)}<span class="history-file-content"><span class="history-file-name">${esc(f.name)}</span><span class="history-file-meta">${esc(f.folder||'项目根目录')} · ${stamp(f)!==null?new Date(stamp(f)).toLocaleTimeString('zh-CN',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit'}):'无日期'} · ${formatSize(f.size)}</span>${a.tags.length?`<span class="tags">${a.tags.map(t=>`<span class="tag">${esc(t)}</span>`).join('')}</span>`:''}${a.note?`<span class="excerpt">${esc(a.note.slice(0,100))}</span>`:''}</span></button>`;};
 const content=[...months].map(([month,days])=>`<section class="history-month" data-month="${esc(month)}"><h3>${month==='日期不可用'?month:month.slice(0,4)+' 年 '+Number(month.slice(5))+' 月'}</h3><div class="history-line">${[...days].map(([day,files])=>{const key=JSON.stringify([focusDir||project,timelineBasis,timelineOrder,day]),limit=timelineDayLimits.get(key)||5,visible=files.slice(0,limit),remaining=files.length-visible.length;return `<section class="history-day" data-day="${esc(day)}"><div class="history-date"><time>${day==='日期不可用'?day:day.slice(5).replace('-',' / ')}</time><span>${files.length} 份资料</span></div><div class="history-files">${visible.map(item).join('')}${files.length>5?`<div class="history-day-actions"><span class="history-shown">已显示 ${visible.length} / ${files.length}</span>${remaining?`<button class="more" data-history-expand="${esc(key)}">再显示 ${Math.min(50,remaining)} 份 <span>· 剩余 ${remaining} 份</span></button>`:''}${visible.length>5?`<button class="more" data-history-collapse="${esc(key)}">收起</button>`:''}</div>`:''}</div></section>`;}).join('')}</div></section>`).join('');
 $('file-timeline').innerHTML=`<div class="history-summary"><span>${period}</span><span>${rows.length} 份资料${unknown?' · '+unknown+' 份无日期':''}</span></div>${timelineBasis==='birthtime'&&earlier?`<p class="history-date-note" title="创建日期晚于修改日期，可切换修改日期核对">${earlier} 份日期需核对</p>`:''}${content}`;
 observeFileVisuals();
}
function render(){
 if(view==='home')view='progress';
 if(!['files','folders'].includes(view)&&typeof documentSearchReset==='function')documentSearchReset();
 document.body.dataset.view=view;
 const libraryVisible=['files','folders','timeline'].includes(view);$('library-panel').hidden=!libraryVisible;document.querySelector('.workarea').classList.toggle('with-library',libraryVisible);
 $('library-all').setAttribute('aria-pressed',(view==='files'&&!resourceScope)||(view==='folders'&&!focusDir));
 document.querySelector('.folder-tip').hidden=view!=='folders';
 if(view!=='folders')$('folder-groups').replaceChildren();if(view!=='files')$('resource-global-content').replaceChildren();
 if(!focusDir||focusDir.split('/')[0]!==project||!data.directories.includes(focusDir))focusDir=project;
 $('root-path').textContent=data.root;
 renderNavigation();
 document.querySelectorAll('.nav-selected').forEach(el=>{if(['board','progress','notes'].includes(view)){el.classList.remove('nav-selected');el.querySelector('[aria-current]')?.removeAttribute('aria-current');}});
 $('board-tab').setAttribute('aria-pressed',view==='board');$('board-count').textContent=(data.state.todos||[]).filter(t=>t.status!=='done').length||'';
 $('progress-tab').setAttribute('aria-pressed',view==='progress');$('progress-count').textContent=(data.state.progressProjects||[]).filter(p=>!p.archivedAt).length||'';
 $('files-tab').setAttribute('aria-pressed',libraryVisible);$('resource-global-view').hidden=view!=='files';$('progress-view').hidden=view!=='progress';$('board-view').hidden=view!=='board';document.querySelector('.next-line').hidden=['home','files','board','progress','notes'].includes(view);document.querySelector('.toolbar').hidden=['home','files','board','progress','notes'].includes(view);
 $('notes-view').hidden=view!=='notes';$('notes-tab').setAttribute('aria-pressed',view==='notes');
 if(view==='notes'){$('project-title').textContent='记录库';$('project-path').textContent='';$('folder-view').hidden=true;$('timeline-view').hidden=true;renderNotes();return;}
 if(view==='files'){$('folder-view').hidden=true;$('timeline-view').hidden=true;$('project-title').textContent='找资料';$('project-path').textContent='';renderWorkspaceResources();return;}if(view==='progress'){$('folder-view').hidden=true;$('timeline-view').hidden=true;renderProgress();return;}
 if(view==='board'){$('project-title').textContent='全部待办';$('project-path').textContent='';$('folder-view').hidden=true;$('timeline-view').hidden=true;renderTodoBoard();return;}
 $('project-title').textContent=!focusDir?'本地资料':focusDir!==project?focusDir.split('/').pop():data.projects.find(p=>p.key===project)?.name||'目录资料';
 $('project-path').title=data.root+(focusDir?'\\'+focusDir.replaceAll('/','\\'):'');
 $('project-path').textContent=focusDir.replaceAll('/',' / ');
 document.querySelector('.next-line > span:first-child').textContent=focusDir!==project?'下一步':'下一步';
 if(document.activeElement!==$('project-next'))$('project-next').value=data.state.projects[focusDir||project]?.next||'';
 if(!focusDir)document.querySelector('.next-line').hidden=true;
 $('folder-view').hidden=view!=='folders';$('timeline-view').hidden=view!=='timeline';$('folder-tab').setAttribute('aria-pressed',view==='folders');$('timeline-tab').setAttribute('aria-pressed',view==='timeline');if(view==='folders')renderFolders();else renderTimeline();
}
function switchView(value){view=value;render();setURL();window.scrollTo(0,0);}
function fileDirty(){if(!selected||!data)return false;const a=annotation(selected);return $('file-note').value!==a.note||$('file-tags').value!==a.tags.join('，')||$('file-pin').checked!==a.pinned;}
async function saveAnnotation(){if(!selected)return;const id=selected,tags=[...new Set($('file-tags').value.split(/[,，;；\n]/).map(s=>s.trim()).filter(Boolean))];$('save-file').disabled=true;try{await post('/api/annotation',{id,note:$('file-note').value,tags,pinned:$('file-pin').checked});$('file-saved').textContent='已保存';await load();}catch(e){$('file-saved').textContent='保存失败';toast(e.message);throw e;}finally{$('save-file').disabled=false;}}
async function closeFile(){try{if(fileDirty())await saveAnnotation();disposeSpreadsheetPreview();disposeWordPreview();$('file-dialog').close();$('preview').replaceChildren();selected=null;}catch{}}
async function openFile(id){
 if(serviceMode!=='running')return toast('后台已停止，请先重新启动');
 const f=data.files.find(f=>f.id===id);if(!f)return toast('文件当前不可访问，请刷新目录');
 if(selected&&selected!==id&&fileDirty()){try{await saveAnnotation();}catch{return;}}
 disposeSpreadsheetPreview();disposeWordPreview();preparePreviewNavigation(id);
 selected=id;$('file-dialog').scrollTop=0;recordWorkspaceFile(id);const a=annotation(id);$('file-title').textContent=f.name;$('file-path').textContent=f.rel;$('file-tags').value=a.tags.join('，');$('file-note').value=a.note;$('file-pin').checked=a.pinned;$('file-saved').textContent='';
 const nodes=data.state.nodes.filter(n=>n.fileIds.includes(id));$('file-links').textContent=nodes.length?'节点：'+nodes.map(n=>n.title).join('、'):'';
 renderFileFollowups(id);$('preview').replaceChildren();if(!$('file-dialog').open)$('file-dialog').showModal();
 const source='/file/'+id;const host=$('preview');
 if(['.jpg','.jpeg','.png','.gif','.webp','.bmp'].includes(f.ext)){const img=document.createElement('img');img.alt=f.name;img.src=source;img.onerror=()=>{if(selected===id)host.textContent='图片无法读取，请用本机软件打开。';};host.append(img);}
 else if(['.mp4','.webm','.mp3','.wav'].includes(f.ext)){const media=document.createElement(['.mp3','.wav'].includes(f.ext)?'audio':'video');media.controls=true;media.preload='metadata';media.src=source;host.append(media);}
 else if(f.ext==='.pdf'){const frame=document.createElement('iframe');frame.title=f.name;frame.src=source;host.append(frame);}
 else if(['.txt','.md','.markdown','.csv','.json'].includes(f.ext)){
  if(f.size>1500000){host.textContent='文本较大，请用本机软件打开。';return;}
  host.textContent='读取文本中…';try{const res=await fetch(source);if(!res.ok)throw new Error('读取失败');const text=await res.text();if(serviceMode!=='running'||selected!==id)return;host.replaceChildren();const pre=document.createElement('pre');pre.textContent=text;host.append(pre);}catch(e){if(selected===id)host.textContent=e.message;}
 }else if(f.ext==='.docx'){
  await renderWordPreview(host,id);
 }else if(['.xlsx','.xlsm'].includes(f.ext)){
  host.textContent='读取文档内容中…';try{const result=await request('/api/office/'+id);if(serviceMode!=='running'||selected!==id)return;
   renderSpreadsheetPreview(result,host,id);
  }catch(e){if(selected===id)host.textContent='无法生成内容预览：'+e.message+'。可以用本机软件打开。';}
 }else host.innerHTML=`<div class="empty">${['.stp','.step'].includes(f.ext)?'STP 暂不支持内嵌预览':'暂不支持内嵌预览'}</div>`;
}
function nodeEditor(node=null){editing=node?.id||null;editingScope=node?.project||(focusDir||project);linked=new Set(node?.fileIds||[]);$('node-form-title').textContent=node?'编辑节点':'新建节点';$('node-title').value=node?.title||'';$('node-date').value=node?.date||'';$('node-note').value=node?.note||'';$('node-status').value=node?.status||'待开始';$('node-form').hidden=false;$('manual-nodes').open=true;$('link-search').value='';renderNodeFiles();$('node-title').focus();}
function renderNodeFiles(){const q=$('link-search').value.trim().toLowerCase();const matches=projectFiles().filter(f=>f.rel.toLowerCase().includes(q));$('node-files').innerHTML=matches.slice(0,120).map(f=>`<label><input type="checkbox" data-link-id="${f.id}" ${linked.has(f.id)?'checked':''}><span>${esc(f.name)} <span class="muted">${esc(f.folder||'项目根目录')}</span></span></label>`).join('')+(matches.length>120?'<p class="hint">搜索更多文件</p>':'');}
document.addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;
 if(b.dataset.navToggle){const rel=b.dataset.navToggle;navOpen.has(rel)?navOpen.delete(rel):navOpen.add(rel);renderNavigation();localStorage.setItem('desk-nav-open',JSON.stringify([...navOpen]));}
 if(b.dataset.navFolder)selectDirectory(b.dataset.navFolder);
 if(b.dataset.project!==undefined){project=b.dataset.project;$('search').value='';expanded.clear();$('node-form').hidden=true;editing=null;render();setURL();}
 if(b.dataset.file)openFile(b.dataset.file);
 if(b.dataset.directory!==undefined)post('/api/open-directory',{rel:b.dataset.directory}).catch(e=>toast(e.message));
 if(b.dataset.expand){const key=b.dataset.expand;expanded.has(key)?expanded.delete(key):expanded.add(key);renderFolders();}
 if(b.dataset.historyExpand){const key=b.dataset.historyExpand;timelineDayLimits.set(key,(timelineDayLimits.get(key)||5)+50);renderFileTimeline();}
 if(b.dataset.historyCollapse){timelineDayLimits.delete(b.dataset.historyCollapse);renderFileTimeline();}
 if(b.dataset.editNode){const node=data.state.nodes.find(n=>n.id===b.dataset.editNode);if(node)nodeEditor(node);}
});
$('folder-tab').onclick=()=>switchView('folders');$('timeline-tab').onclick=()=>switchView('timeline');
$('board-tab').onclick=()=>switchView('board');
$('progress-tab').onclick=()=>{if(data){progressSelected=null;progressCollection='active';switchView('progress');}};
$('board-directory-toggle').onclick=()=>{const opened=$('library-panel').classList.toggle('directories-open');$('board-directory-toggle').setAttribute('aria-expanded',opened);};
$('library-all').onclick=()=>openWorkspaceFiles();
$('timeline-basis').onchange=()=>{timelineBasis=$('timeline-basis').value;timelineDayLimits.clear();localStorage.setItem('desk-date-basis',timelineBasis);renderFileTimeline();};
if($('timeline-order'))$('timeline-order').onchange=()=>{timelineOrder=$('timeline-order').value==='asc'?'asc':'desc';timelineDayLimits.clear();localStorage.setItem('desk-timeline-order',timelineOrder);renderFileTimeline();};
$('search').oninput=()=>{if(!data)return;resourceQuery=$('search').value;resourceLimit=36;if(resourceQuery)resourceMode='all';if(view==='folders')renderFolders();else renderTimeline();setURL();};
$('refresh').onclick=async()=>{try{$('refresh').disabled=true;await post('/api/refresh',{});await load();toast('已刷新');}catch(e){error(e);}finally{$('refresh').disabled=false;}};
$('copy-link').onclick=async()=>{try{await navigator.clipboard.writeText(location.href);toast('已复制本机实时链接；可收藏，其他设备暂不能访问此地址。');}catch{toast('当前链接：'+location.href);}};
$('project-next').onchange=async()=>{try{await post('/api/project',{project:focusDir||project,next:$('project-next').value});$('next-saved').textContent='已保存';setTimeout(()=>$('next-saved').textContent='',2200);}catch(e){error(e);}};
$('close-file').onclick=closeFile;$('file-dialog').addEventListener('cancel',e=>{e.preventDefault();closeFile();});
$('save-file').onclick=()=>saveAnnotation().catch(()=>{});
for(const [button,folder] of [['open-file',false],['open-folder',true]])$(button).onclick=async()=>{try{if(selected)await post('/api/open',{id:selected,folder});}catch(e){toast(e.message);}};
$('add-node').onclick=()=>nodeEditor();$('cancel-node').onclick=()=>$('node-form').hidden=true;
$('link-search').oninput=renderNodeFiles;
$('node-files').addEventListener('change',e=>{const id=e.target.dataset.linkId;if(id)e.target.checked?linked.add(id):linked.delete(id);});
$('node-form').onsubmit=async e=>{e.preventDefault();try{await post('/api/node',{id:editing,project:editingScope||focusDir||project,title:$('node-title').value,date:$('node-date').value,status:$('node-status').value,note:$('node-note').value,fileIds:[...linked]});$('node-form').hidden=true;await load();toast('已保存');}catch(e){error(e);}};
resourceQuery=query.get('q')||'';resourceMode=['all','cad'].includes(query.get('mode'))?query.get('mode'):(resourceQuery?'all':'daily');resourceScope=query.get('scope')||'';$('search').value=resourceQuery;$('global-file-search').value=view==='files'?resourceQuery:'';initWorkspace();initFollowup();
initNotes();initDocumentSearch();
initNavigation();
initFileVisuals();
initTodos();
initProgress();
window.addEventListener('beforeunload',e=>{if(serviceHasDrafts()||serviceBusy()){e.preventDefault();e.returnValue='';}});
(async()=>{await load();if(serviceMode==='running')connectServiceEvents();const initialFile=query.get('file');if(initialFile&&data)openFile(initialFile);})().catch(error);

let importQueue=[],importDirectory='',importBusy=false,pickerDirectory='',dropHover=null,hoverTimer;
function clearDropHighlight(){document.querySelectorAll('.is-drop-target').forEach(node=>node.classList.remove('is-drop-target'));}
function prepareImport(files,rel){
 if(!data)return toast('目录尚未就绪，请稍后重试。');
 if(!files.length)return toast('没有收到可读取的文件。请先在微信完成下载或另存为，再拖入；也可使用“存入当前目录”。');
 if(files.length>30)return toast('一次最多保存 30 个文件，请分批拖入。');
 if(files.some(file=>file.size>1073741824))return toast('有文件超过 1 GB，请改用本地文件夹保存。');
 if(rel!==''&&!data.directories.includes(rel))return toast('目标目录当前不可访问，请刷新后重试。');
 if(importBusy)return toast('正在保存上一批资料，请稍后。');
 importDirectory=rel;importQueue=files.map(file=>({file,state:'pending',message:file.size===0?'空文件（0 B），请确认文件已经下载。':'等待保存'}));
 $('import-target').textContent=data.root+(rel?'\\'+rel.replaceAll('/','\\'):'');
 $('import-list').innerHTML=importQueue.map((item,index)=>`<div class="import-row" data-import-index="${index}"><span>${esc(item.file.name)}</span><span class="muted">${formatSize(item.file.size)}</span><small>${esc(item.message)}</small></div>`).join('');
 $('import-status').textContent='';$('confirm-import').hidden=false;$('confirm-import').disabled=false;$('confirm-import').textContent='保存';$('cancel-import').textContent='取消';
 if(!$('import-dialog').open)$('import-dialog').showModal();
}
document.addEventListener('dragover',event=>{
 const types=[...(event.dataTransfer?.types||[])];if(!types.includes('Files'))return;
 event.preventDefault();event.dataTransfer.dropEffect='copy';
 const target=event.target.closest?.('[data-drop-directory]');clearDropHighlight();if(target)target.classList.add('is-drop-target');
 const rel=target?.dataset.dropDirectory;if(rel!==dropHover){clearTimeout(hoverTimer);dropHover=rel;if(target?.classList.contains('nav-row')&&!navOpen.has(rel))hoverTimer=setTimeout(()=>{navOpen.add(rel);renderNavigation();},700);}
});
document.addEventListener('dragleave',event=>{if(!event.relatedTarget){clearDropHighlight();clearTimeout(hoverTimer);dropHover=null;}});
document.addEventListener('drop',event=>{
 if(![...(event.dataTransfer?.types||[])].includes('Files'))return;
 event.preventDefault();clearDropHighlight();clearTimeout(hoverTimer);dropHover=null;
 const target=event.target.closest?.('[data-drop-directory]');if(!target)return toast('请把文件拖到左侧目录名称或右侧文件夹分区。');
 const items=[...(event.dataTransfer?.items||[])];if(items.some(item=>item.webkitGetAsEntry?.()?.isDirectory))return toast('请展开来源文件夹，再选择其中的文件拖入。');
 const files=[...(event.dataTransfer?.files||[])];prepareImport(files,target.dataset.dropDirectory);
});
$('choose-files').onclick=()=>{pickerDirectory=focusDir||project;$('file-picker').value='';$('file-picker').click();};
$('file-picker').onchange=()=>prepareImport([...$('file-picker').files],pickerDirectory);
$('cancel-import').onclick=()=>{if(!importBusy)$('import-dialog').close();};
$('import-dialog').addEventListener('cancel',event=>{if(importBusy)event.preventDefault();});
$('confirm-import').onclick=async()=>{
 if(importBusy)return;importBusy=true;$('confirm-import').disabled=true;$('cancel-import').disabled=true;
 for(let index=0;index<importQueue.length;index++){
  const item=importQueue[index];if(item.state==='done')continue;const row=$('import-list').querySelector(`[data-import-index="${index}"]`),status=row.querySelector('small');status.textContent='正在保存…';
  try{
   const params=new URLSearchParams({dir:importDirectory,name:item.file.name});
   const response=await fetch('/api/import?'+params,{method:'POST',headers:{'Content-Type':'application/octet-stream','X-File-Modified':String(item.file.lastModified||'')},body:item.file});
   const result=await response.json();if(!response.ok)throw new Error(result.error||'保存失败');
   item.state='done';item.message='已保存：'+result.rel+(result.renamed?'（同名已另存）':'');row.classList.add('is-saved');
  }catch(error){item.state='error';item.message='未保存：'+error.message+'。若来自微信，请确认已下载后重试。';}
  status.textContent=item.message;
 }
 importBusy=false;$('cancel-import').disabled=false;$('cancel-import').textContent='完成';
 const done=importQueue.filter(item=>item.state==='done').length,failed=importQueue.length-done;
 $('import-status').textContent=`已保存 ${done} / ${importQueue.length} 份${failed?'，'+failed+' 份未保存，可重试。':''}`;
 $('confirm-import').disabled=false;$('confirm-import').hidden=!failed;$('confirm-import').textContent='重试未保存的文件';await load();
};
