'use strict';
let navPreferenceRoot='',navPins=[],navRecent=[],navFilterTimer;
let sidebarUtilityTab='recent',sidebarUtilityLimit=5;
try{if(localStorage.getItem('desk-utility-tab')==='pinned')sidebarUtilityTab='pinned';}catch{}
function sidebarRecentIds(){
 if(!data)return [];
 try{const ids=JSON.parse(localStorage.getItem('desk-file-visits:'+data.root)||'[]');return Array.isArray(ids)?[...new Set(ids.filter(id=>typeof id==='string'))].slice(0,12):[];}catch{return [];}
}
function renderSidebarUtilities(){
 if(!data||!$('sidebar-utility-list'))return;
 const filesById=new Map(data.files.map(f=>[f.id,f]));
 const files=sidebarUtilityTab==='pinned'?data.files.filter(f=>annotation(f.id).pinned).sort((a,b)=>a.name.localeCompare(b.name,'zh-CN')||a.rel.localeCompare(b.rel,'zh-CN')):sidebarRecentIds().map(id=>filesById.get(id)).filter(Boolean);
 document.querySelectorAll('[data-utility-tab]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.utilityTab===sidebarUtilityTab)));
 $('sidebar-utility-list').innerHTML=files.length?files.slice(0,sidebarUtilityLimit).map(f=>{const kind=fileKind(f),folder=f.rel.split('/').slice(0,-1).join(' / ')||'根目录资料';return `<button class="utility-file" data-file="${esc(f.id)}" title="${esc(f.rel)}"><span class="utility-file-type" aria-hidden="true">${deskIcon(kind==='model'?'cube':kind==='video'?'video':'file')}<small>${esc(f.ext.slice(1).toUpperCase()||'FILE')}</small></span><span class="utility-file-copy"><span>${esc(f.name)}</span><small>${esc(folder)}</small></span></button>`;}).join(''):`<div class="utility-empty">${deskIcon(sidebarUtilityTab==='pinned'?'star':'clock')}<p>${sidebarUtilityTab==='pinned'?'在文件详情勾选「常用」':'查看过的资料会留在这里'}</p><button id="utility-browse">去找资料 ${deskIcon('arrow')}</button></div>`;
 $('sidebar-utility-more').hidden=files.length<=sidebarUtilityLimit;
}
function readNavPreferences(){if(navPreferenceRoot===data.root)return;navPreferenceRoot=data.root;try{navPins=JSON.parse(localStorage.getItem('desk-pins:'+data.root)||'[]');navRecent=JSON.parse(localStorage.getItem('desk-recent:'+data.root)||'[]');}catch{navPins=[];navRecent=[];}if(!Array.isArray(navPins))navPins=[];if(!Array.isArray(navRecent))navRecent=[];navPins=[...new Set(navPins.map(resolveDirectoryAlias))];navRecent=[...new Set(navRecent.map(resolveDirectoryAlias))];}
function rememberDirectory(rel){if(!data)return;readNavPreferences();navRecent=[rel,...navRecent.filter(x=>x!==rel)].slice(0,5);localStorage.setItem('desk-recent:'+data.root,JSON.stringify(navRecent));if($('directory-search'))$('directory-search').value='';}
function renderDirectoryNavigation(){
 if(!data)return;
 readNavPreferences();navPins=[...new Set(navPins.map(resolveDirectoryAlias))];navRecent=[...new Set(navRecent.map(resolveDirectoryAlias))];const q=$('directory-search').value.trim().toLowerCase(),counts=new Map();
 for(const f of data.files){const parts=f.rel.split('/').slice(0,-1);for(let i=1;i<=parts.length;i++){const rel=parts.slice(0,i).join('/');counts.set(rel,(counts.get(rel)||0)+1);}}
 const valid=rel=>data.directories.includes(rel),shortcuts=[...navPins.filter(valid).map(rel=>({rel,pin:true})),...navRecent.filter(rel=>valid(rel)&&!navPins.includes(rel)).slice(0,3).map(rel=>({rel,pin:false}))];
 $('nav-shortcuts').hidden=!shortcuts.length||Boolean(q);$('nav-shortcuts').innerHTML=`<p class="caption">快捷访问</p>${shortcuts.map(({rel,pin})=>`<div class="nav-shortcut" data-drop-directory="${esc(rel)}"><button data-nav-shortcut="${esc(rel)}" title="${esc(rel)}"><span aria-hidden="true">${pin?'★':'◷'}</span><span>${esc(rel.split('/').pop())}</span></button>${pin?`<button class="shortcut-unpin" data-nav-pin="${esc(rel)}" title="取消固定" aria-label="取消固定 ${esc(rel)}">×</button>`:''}</div>`).join('')}`;
 const active=rel=>(view==='files'?resourceScope:['folders','timeline'].includes(view)?focusDir:null)===rel;
 function row(rel,hasChildren,open){return `<div class="nav-row ${active(rel)?'nav-selected':''}" data-drop-directory="${esc(rel)}">${hasChildren?`<button class="nav-toggle" data-nav-toggle="${esc(rel)}" aria-expanded="${open}" aria-label="${open?'收起':'展开'} ${esc(rel.split('/').pop())}">${open?'⌄':'›'}</button>`:'<span class="nav-leaf"></span>'}<button class="nav-folder" data-nav-folder="${esc(rel)}" ${active(rel)?'aria-current="page"':''} title="${esc(rel)}"><span class="nav-folder-symbol" aria-hidden="true"></span><span class="nav-name">${esc(rel.split('/').pop())}</span><span class="nav-count">${counts.get(rel)||0}</span></button><button class="nav-pin ${navPins.includes(rel)?'is-pinned':''}" data-nav-pin="${esc(rel)}" aria-label="${navPins.includes(rel)?'取消固定':'固定目录'} ${esc(rel)}" title="${navPins.includes(rel)?'取消固定':'固定到快捷访问'}">${navPins.includes(rel)?'★':'☆'}</button></div>`;}
 if(q){const matches=data.directories.filter(dir=>dir.toLowerCase().includes(q)).sort((a,b)=>a.length-b.length).slice(0,60);$('projects').innerHTML=`<div class="nav-search-summary">${matches.length}${matches.length===60?'+':''} 个目录</div>${matches.map(rel=>`<div class="nav-search-result">${row(rel,false,false)}<span class="nav-search-path">${esc(rel)}</span></div>`).join('')||'<div class="nav-search-summary">无匹配目录</div>'}`;return;}
 const tree={children:new Map()};for(const dir of data.directories){let node=tree,parts=[];for(const name of dir.split('/')){parts.push(name);if(!node.children.has(name))node.children.set(name,{name,rel:parts.join('/'),children:new Map()});node=node.children.get(name);}}
 if(!navReady){const parts=focusDir.split('/');for(let i=1;i<=parts.length;i++)navOpen.add(parts.slice(0,i).join('/'));navReady=true;}
 function branch(node,depth){const hasChildren=node.children.size>0,open=navOpen.has(node.rel);return `<li class="nav-node nav-depth-${Math.min(depth,4)}">${row(node.rel,hasChildren,open)}${hasChildren&&open?`<ul class="nav-level">${[...node.children.values()].sort((a,b)=>a.name.localeCompare(b.name,'zh-CN')).map(n=>branch(n,depth+1)).join('')}</ul>`:''}</li>`;}
 $('projects').innerHTML=`<div class="nav-mount" title="${esc(data.root)}"><span class="folder-symbol" aria-hidden="true"></span>${esc(data.root.split(/[\\/]/).pop())}<span class="nav-count">${data.files.length}</span></div><ul class="nav-level nav-top">${[...tree.children.values()].sort((a,b)=>a.name.localeCompare(b.name,'zh-CN')).map(n=>branch(n,1)).join('')}</ul>`;
}
function initNavigation(){
 document.querySelectorAll('[data-utility-tab]').forEach(button=>button.onclick=()=>{sidebarUtilityTab=button.dataset.utilityTab;sidebarUtilityLimit=5;try{localStorage.setItem('desk-utility-tab',sidebarUtilityTab);}catch{}renderSidebarUtilities();});
 $('sidebar-utility-list').addEventListener('click',event=>{if(event.target.closest('#utility-browse'))openWorkspaceFiles();});
 $('sidebar-utility-more').onclick=()=>{sidebarUtilityLimit+=5;renderSidebarUtilities();};
 $('directory-search').oninput=()=>{clearTimeout(navFilterTimer);navFilterTimer=setTimeout(renderNavigation,70);};
 $('nav-collapse').onclick=()=>{navOpen.clear();localStorage.setItem('desk-nav-open','[]');renderNavigation();};
 document.addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;if(b.dataset.navPin){const rel=b.dataset.navPin;navPins=navPins.includes(rel)?navPins.filter(x=>x!==rel):[...navPins,rel].slice(-12);localStorage.setItem('desk-pins:'+data.root,JSON.stringify(navPins));renderNavigation();}if(b.dataset.navShortcut)selectDirectory(b.dataset.navShortcut);});
}
