'use strict';
// Local SVGs keep navigation consistent without loading an icon/font service.
function deskIcon(name){
 const paths={home:'<path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z"/>',search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',folder:'<path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',file:'<path d="M5 3h9l5 5v13H5Z M14 3v6h5 M8 13h8 M8 17h5"/>',clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',arrow:'<path d="M5 12h14m-6-6 6 6-6 6"/>',plus:'<path d="M12 5v14M5 12h14"/>',check:'<path d="m5 12 4 4L19 6"/>',grid:'<rect x="3" y="3" width="7" height="7" rx="1.4"/><rect x="14" y="3" width="7" height="7" rx="1.4"/><rect x="3" y="14" width="7" height="7" rx="1.4"/><rect x="14" y="14" width="7" height="7" rx="1.4"/>',list:'<path d="M8 6h13M8 12h13M8 18h13M3 6h.1M3 12h.1M3 18h.1"/>',chevron:'<path d="m9 5 7 7-7 7"/>',calendar:'<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4M17 3v4M3 11h18M7 15h2M13 15h2"/>',star:'<path d="m12 3 2.8 5.8 6.4.9-4.6 4.5 1.1 6.4-5.7-3-5.7 3 1.1-6.4-4.6-4.5 6.4-.9Z"/>',board:'<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16M15 4v16M6 8v4M12 8v7M18 8v2"/>',panel:'<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',moon:'<path d="M20 15.5A9 9 0 0 1 8.5 4 9 9 0 1 0 20 15.5Z"/>',sun:'<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.4 1.4M17.6 17.6 19 19M5 19l1.4-1.4M17.6 6.4 19 5"/>',refresh:'<path d="M20 7v5h-5M4 17v-5h5M20 12a8 8 0 0 0-13-6M4 12a8 8 0 0 0 13 6"/>',link:'<path d="m10 13 4-4M8 16l-1 1a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0M16 8l1-1a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0" transform="translate(1 1) scale(.9)"/>',cube:'<path d="m12 2 9 5v10l-9 5-9-5V7Zm0 10L3 7m9 5 9-5m-9 5v10M7.5 4.5l9 5"/>',video:'<rect x="3" y="4" width="18" height="16" rx="3"/><path d="m10 8 6 4-6 4Z"/>',close:'<path d="m6 6 12 12M6 18 18 6"/>'};
 return `<svg class="desk-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]||paths.file}</svg>`;
}
try{document.documentElement.dataset.theme=localStorage.getItem('desk-theme')==='dark'?'dark':'light';}catch{}
let previewSequence=[],previewMoving=false;
function preparePreviewNavigation(id){
 if(!document.getElementById('file-dialog').open){
  const source=[...document.querySelectorAll('dialog[open]')].at(-1)||document.activeElement?.closest('#sidebar-utility-list')||document.querySelector('main');
  previewSequence=[...new Set([...source.querySelectorAll('[data-file]')].filter(el=>el.getClientRects().length).map(el=>el.dataset.file))];
  if(!previewSequence.includes(id))previewSequence=[id];
 }
 renderPreviewNavigation(id);
}
function renderPreviewNavigation(id){
 const prev=document.getElementById('file-prev'),next=document.getElementById('file-next'),counter=document.getElementById('file-position');if(!prev)return;
 const at=previewSequence.indexOf(id);prev.disabled=previewMoving||at<=0;next.disabled=previewMoving||at<0||at>=previewSequence.length-1;counter.textContent=at<0?'':`${at+1} / ${previewSequence.length}`;
}
async function navigatePreview(direction){
 if(previewMoving)return;const at=previewSequence.indexOf(selected),next=previewSequence[at+direction];if(at<0||!next)return;
 previewMoving=true;renderPreviewNavigation(selected);try{await openFile(next);}finally{previewMoving=false;renderPreviewNavigation(selected);}
}
document.addEventListener('DOMContentLoaded',()=>{
 const byId=id=>document.getElementById(id);
 for(const [id,icon] of [['files-tab','folder'],['board-tab','board'],['progress-tab','calendar']]){const b=byId(id);b.querySelector('span').innerHTML=deskIcon(icon);b.title=b.textContent.trim();}
 byId('library-all').querySelector('span').innerHTML=deskIcon('grid');
 byId('global-find-button').innerHTML=deskIcon('search');byId('refresh').innerHTML=deskIcon('refresh');byId('refresh').setAttribute('aria-label','刷新目录');byId('refresh').title='刷新目录';
 byId('copy-link').innerHTML=deskIcon('link')+'<span>复制链接</span>';byId('copy-link').setAttribute('aria-label','复制链接');
 const projectHead=document.querySelector('.project-head'),projectActions=document.createElement('div');projectActions.className='project-actions';projectActions.append(document.querySelector('.folder-tip'),byId('copy-link'));projectHead.append(projectActions);projectHead.firstElementChild.append(document.querySelector('.next-line'));
 byId('open-file').textContent='打开原文件';byId('open-file').classList.add('primary');
 byId('close-file').innerHTML=deskIcon('close');byId('close-file').title='关闭 · Esc';
 const previewNav=document.createElement('div');previewNav.className='preview-navigation';previewNav.innerHTML='<button id="file-prev" class="icon-button" aria-label="上一个文件" title="上一个 · ←">'+deskIcon('chevron')+'</button><span id="file-position" aria-live="polite"></span><button id="file-next" class="icon-button" aria-label="下一个文件" title="下一个 · →">'+deskIcon('chevron')+'</button>';document.querySelector('.preview-actions').append(previewNav);byId('file-prev').onclick=()=>navigatePreview(-1);byId('file-next').onclick=()=>navigatePreview(1);
 document.addEventListener('keydown',e=>{if(!byId('file-dialog').open||!["ArrowLeft","ArrowRight"].includes(e.key)||e.altKey||e.ctrlKey||e.metaKey||e.shiftKey||e.target.closest('input,textarea,select,[contenteditable="true"],video,audio,iframe')||document.querySelector('#file-stage-dialog[open]'))return;e.preventDefault();navigatePreview(e.key==='ArrowLeft'?-1:1);});
 const theme=byId('theme-toggle'),updateTheme=()=>{const dark=document.documentElement.dataset.theme==='dark';theme.innerHTML=deskIcon(dark?'sun':'moon');theme.title=dark?'切换浅色':'切换深色';theme.setAttribute('aria-label',theme.title);};
 theme.onclick=()=>{const value=document.documentElement.dataset.theme==='dark'?'light':'dark';document.documentElement.dataset.theme=value;localStorage.setItem('desk-theme',value);updateTheme();};updateTheme();
 const toggle=byId('sidebar-toggle');toggle.innerHTML=deskIcon('panel');
 const setSidebar=collapsed=>{document.body.classList.toggle('sidebar-collapsed',collapsed);toggle.setAttribute('aria-expanded',String(!collapsed));toggle.title=collapsed?'展开侧栏':'收起侧栏';toggle.setAttribute('aria-label',toggle.title);};
 setSidebar(localStorage.getItem('desk-sidebar-collapsed')==='true');toggle.onclick=()=>{const collapsed=!document.body.classList.contains('sidebar-collapsed');setSidebar(collapsed);localStorage.setItem('desk-sidebar-collapsed',String(collapsed));};
});
