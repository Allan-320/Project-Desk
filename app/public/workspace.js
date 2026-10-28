'use strict';
const cadExtensions=new Set(['.prt','.stp','.step','.stpz','.x_t','.x_b','.catpart','.catproduct','.dwg','.dxf','.igs','.iges','.stl','.3dm','.3dxml','.sldprt','.sldasm']);
const resourcePurposes=[['plan','排期 / 问题',/排期|计划|进度|问题|评审|整改|会议|开发/],['check','试模 / 检验',/试模|三坐标|检验|检测|测量|质量|检具|SPTT/i],['business','商务 / 准入',/报价|合同|采购|供应商|准入|协议|订单|发票/]];
let resourceMode='daily',resourceLayout=localStorage.getItem('desk-resource-layout')==='list'?'list':'grid',resourcePurpose='',resourceLimit=36,resourceQuery='',resourceScope='';
const inResourceScope=(f,scope)=>!scope||f.rel.startsWith(scope+'/');
const resourceDirectory=f=>f.rel.split('/').slice(0,-1).join('/');
function resolveDirectoryAlias(rel){let value=rel;if(data?.directories.includes(value))return value;for(let i=0;i<12;i++){const entry=Object.entries(data?.state.directoryAliases||{}).filter(([old])=>value===old||value.startsWith(old+'/')).sort((a,b)=>b[0].length-a[0].length)[0];if(!entry)break;const next=entry[1]+value.slice(entry[0].length);if(next===value)break;value=next;if(data?.directories.includes(value))break;}return value;}
function workspacePlans(scope){return (data.state.progressProjects||[]).filter(p=>p.directory&&(scope===p.directory||scope.startsWith(p.directory+'/'))).sort((a,b)=>b.directory.length-a.directory.length);}
function workspaceTasks(scope){return (data.state.todos||[]).filter(t=>t.status!=='done'&&(scope?(t.project===scope||t.project.startsWith(scope+'/')):true));}
function openWorkspaceFiles(scope='',q=''){
 resourceScope=scope;resourceQuery=q;resourcePurpose='';resourceMode=q?'all':'daily';resourceLimit=36;
 if(scope){focusDir=scope;project=scope.split('/')[0];rememberDirectory(scope);for(let i=1;i<=scope.split('/').length;i++)navOpen.add(scope.split('/').slice(0,i+1).join('/'));view='folders';}else view='files';
 $('search').value=q;$('global-file-search').value=q;render();setURL();window.scrollTo(0,0);
}
function resourceCard(f,counts){const note=annotation(f.id);return `<article class="resource-card file"><button class="resource-preview" data-file="${esc(f.id)}" aria-label="预览 ${esc(f.name)}">${fileVisual(f)}</button><button class="resource-name" data-file="${esc(f.id)}" title="${esc(f.name)}">${esc(f.name)}</button><button class="resource-location" data-resource-locate="${esc(resourceDirectory(f))}" title="${esc(f.rel)}">${esc(resourceDirectory(f).replaceAll('/',' / ')||'根目录资料')}</button><span class="resource-meta">${esc(f.ext.slice(1).toUpperCase()||'FILE')} · ${formatSize(f.size)} · ${dayFormat.format(f.mtime)}${note.pinned?' · ★':''}${counts?.get(f.name)>1?' · 同名 '+counts.get(f.name):''}</span>${note.tags.length?`<span class="tags">${note.tags.slice(0,4).map(t=>`<span class="tag">${esc(t)}</span>`).join('')}</span>`:''}${note.note?`<p class="resource-note" title="${esc(note.note)}">${esc(note.note.slice(0,100))}</p>`:''}${documentSearchSnippet(f)}</article>`;}
function renderWorkspaceResources(){
 const global=view==='files',scope=global?resourceScope:(focusDir||''),all=data.files.filter(f=>inResourceScope(f,scope)),tokens=resourceQuery.trim().toLowerCase().split(/\s+/).filter(Boolean),counts=new Map();
 documentSearchSync(resourceQuery,scope);
 for(const f of all)counts.set(f.name,(counts.get(f.name)||0)+1);
 const match=f=>{const a=annotation(f.id);return tokens.every(q=>`${f.name} ${f.rel} ${a.tags.join(' ')} ${a.note}`.toLowerCase().includes(q));};
 let filtered=all.filter(f=>match(f)||Boolean(documentSearchHit(f.id)));if(resourcePurpose){const purpose=resourcePurposes.find(([key])=>key===resourcePurpose);filtered=filtered.filter(f=>purpose[2].test(f.rel));}
 const daily=filtered.filter(f=>!cadExtensions.has(f.ext)),models=filtered.filter(f=>cadExtensions.has(f.ext));
 let files=(resourceMode==='daily'?daily:resourceMode==='cad'?models:filtered).sort((a,b)=>Number(annotation(b.id).pinned)-Number(annotation(a.id).pinned)||b.mtime-a.mtime||a.rel.localeCompare(b.rel,'zh-CN'));
 const childFolders=data.directories.filter(d=>scope?d.startsWith(scope+'/')&&!d.slice(scope.length+1).includes('/'):!d.includes('/'));
 const plans=workspacePlans(scope),tasks=workspaceTasks(scope),showPackages=!tokens.length&&resourceMode==='cad',packages=new Map();if(showPackages)for(const f of models){const key=resourceDirectory(f);if(!packages.has(key))packages.set(key,[]);packages.get(key).push(f);}
 const host=global?$('resource-global-content'):$('folder-groups');
 const crumbs=[`<button data-resource-folder="">全部本地资料</button>`];if(scope){const parts=scope.split('/');for(let i=0;i<parts.length;i++)crumbs.push(`<span>›</span><button data-resource-folder="${esc(parts.slice(0,i+1).join('/'))}">${esc(parts[i])}</button>`);}
 host.innerHTML=`<div class="resource-context" ${!scope?'hidden':''}>${crumbs.join('')}<div class="resource-context-actions">${plans[0]?`<button data-workspace-plan="${esc(plans[0].id)}">${plans[0].archivedAt?'已关闭计划':'项目计划'}</button>`:scope?'<button id="workspace-new-plan">建项目计划</button>':''}${tasks.length?`<button data-workspace-tasks="${esc(scope)}">待办 ${tasks.length}</button>`:''}</div></div>
 <div class="resource-controls"><div class="tabs resource-modes" aria-label="资料范围">${[['daily','日常资料',daily.length],['cad','CAD 资料包',models.length],['all','全部',filtered.length]].map(([key,name,count])=>`<button data-resource-mode="${key}" aria-pressed="${resourceMode===key}">${name} <span>${count}</span></button>`).join('')}</div><select id="resource-purpose" aria-label="按文件名称和路径筛选用途"><option value="">所有用途</option>${resourcePurposes.map(([key,label])=>`<option value="${key}" ${resourcePurpose===key?'selected':''}>${label}</option>`).join('')}</select><div class="tabs resource-layout" aria-label="显示方式">${[['grid','缩略图'],['list','列表']].map(([key,name])=>`<button data-resource-layout="${key}" aria-pressed="${resourceLayout===key}" aria-label="${name}" title="${name}">${deskIcon(key)}</button>`).join('')}</div></div>
 ${!tokens.length&&!resourcePurpose&&childFolders.length?`<details class="resource-folders" ${all.length<100?'open':''}><summary>本地文件夹 · ${childFolders.length}</summary><div class="resource-folder-grid">${childFolders.map(dir=>`<button class="resource-folder" data-resource-folder="${esc(dir)}" data-drop-directory="${esc(dir)}"><span class="folder-symbol"></span><span>${esc(dir.split('/').pop())}</span></button>`).join('')}</div></details>`:''}
 ${documentSearchStatusHTML()}
 <section class="resource-results directory-root" data-drop-directory="${esc(scope)}"><div class="resource-result-header"><h2>${resourceMode==='cad'&&!tokens.length?'模型资料包':resourceQuery?'搜索结果':resourceMode==='daily'?'日常资料':'全部资料'}</h2><span>${files.length} 份${showPackages?' · '+packages.size+' 个资料包':''}</span>${!global?`<button data-directory="${esc(scope)}">打开目录 ↗</button>`:''}</div>
 ${showPackages?`<div class="cad-packages">${[...packages].sort((a,b)=>b[1].length-a[1].length).map(([dir,items])=>`<button class="cad-package" data-cad-package="${esc(dir)}"><span class="cad-package-icon">${deskIcon('cube')}</span><span><strong>${esc(dir.split('/').pop()||'根目录')}</strong><small>${esc(dir)}</small><span>${items.length} 个模型文件 · ${esc([...new Set(items.map(f=>f.ext.slice(1).toUpperCase()))].join(' / '))}</span></span></button>`).join('')}</div>`:`<div class="resource-file-grid resource-${resourceLayout} root-files">${files.slice(0,resourceLimit).map(f=>resourceCard(f,counts)).join('')||'<div class="empty">没有匹配的资料</div>'}</div>${files.length>resourceLimit||documentSearchMoreAvailable()?`<button id="resource-more">显示更多${files.length>resourceLimit?'（剩余 '+(files.length-resourceLimit)+' 份）':''}</button>`:''}`}</section>`;
 host.querySelector('#resource-purpose').onchange=e=>{resourcePurpose=e.target.value;resourceLimit=36;renderWorkspaceResources();};
 observeFileVisuals();
}
function recordWorkspaceFile(id){const visited=sidebarRecentIds();try{localStorage.setItem('desk-file-visits:'+data.root,JSON.stringify([id,...visited.filter(x=>x!==id)].slice(0,12)));}catch{}renderSidebarUtilities();}
function initWorkspace(){
 $('files-tab').onclick=()=>openWorkspaceFiles();
 $('global-file-search').onkeydown=e=>{if(e.key==='Enter')openWorkspaceFiles('',$('global-file-search').value);};$('global-find-button').onclick=()=>openWorkspaceFiles('',$('global-file-search').value);
 document.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k'&&!document.querySelector('dialog[open]')){e.preventDefault();$('global-file-search').focus();}});
 document.addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;
  if(b.dataset.resourceFolder!==undefined){resourceQuery='';resourceMode='daily';resourcePurpose='';resourceLimit=36;selectDirectory(b.dataset.resourceFolder);}
  if(b.dataset.resourceLocate!==undefined){resourceQuery='';resourceMode='daily';selectDirectory(b.dataset.resourceLocate);}
  if(b.dataset.resourceMode){resourceMode=b.dataset.resourceMode;resourceLimit=36;renderWorkspaceResources();setURL();}
  if(b.dataset.resourceLayout){resourceLayout=b.dataset.resourceLayout;localStorage.setItem('desk-resource-layout',resourceLayout);renderWorkspaceResources();}
  if(b.dataset.cadPackage!==undefined){selectDirectory(b.dataset.cadPackage);resourceMode='all';resourceLimit=36;renderWorkspaceResources();}
  if(b.id==='resource-more'){resourceLimit+=36;renderWorkspaceResources();if(documentSearchMoreAvailable())documentSearchMore();}
  if(b.dataset.workspacePlan){progressSelected=b.dataset.workspacePlan;progressSubview='schedule';switchView('progress');}
  if(b.dataset.workspaceTasks!==undefined){switchView('board');$('todo-project-filter').value=b.dataset.workspaceTasks;renderTodoBoard();}
  if(b.id==='workspace-new-plan'){const directory=focusDir||'';switchView('progress');openProgressProject();$('progress-directory').value=directory;$('progress-name').value=directory.split('/').pop()||'';}
 });
}
