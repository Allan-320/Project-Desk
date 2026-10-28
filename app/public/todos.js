'use strict';
const todoStatuses=[['todo','待办'],['doing','进行中'],['waiting','等待中'],['done','已完成']];
let todoFilter='all',todoEditId=null,todoDraft=false,todoLinks=new Set(),todoBaseline='',todoSaving=false,todoDragging=null,todoMutating=new Set();
const todoDay=()=>dayFormat.format(new Date());
const todoPlanned=t=>t.today&&t.plannedDate===todoDay();
const todoIsToday=t=>todoPlanned(t)||t.due===todoDay();
const todoOverdue=t=>t.status!=='done'&&Boolean(t.due)&&t.due<todoDay();
const todoScopeLabel=rel=>rel?rel.split('/').join(' / '):'未关联项目';
function todoProjectOptions(selected='',filter=false){
 const options=[`<option value="">${filter?'所有项目':'未关联项目'}</option>`];
 for(const dir of [...data.directories].sort((a,b)=>a.localeCompare(b,'zh-CN'))){const depth=dir.split('/').length-1;options.push(`<option value="${esc(dir)}">${esc('　'.repeat(Math.min(depth,8))+(depth?'↳ ':'')+dir.split('/').pop())}</option>`);}
 if(selected&&!data.directories.includes(selected))options.push(`<option value="${esc(selected)}">${esc(selected)}（目录暂不可用）</option>`);
 return options.join('');
}
function renderTodoBoard(){
 const all=data.state.todos||[],today=todoDay(),pending=all.filter(t=>t.status!=='done');
 $('board-date').textContent=new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'long',day:'numeric',weekday:'long'}).format(new Date());
 $('board-summary').textContent=`${pending.filter(todoIsToday).length} 件今天 · ${pending.filter(todoOverdue).length} 件逾期 · ${pending.length} 件未完成`;
 const selector=$('todo-project-filter'),scope=selector.value;selector.innerHTML=todoProjectOptions(scope,true);selector.value=scope;
 document.querySelectorAll('[data-todo-filter]').forEach(b=>b.setAttribute('aria-pressed',b.dataset.todoFilter===todoFilter));
 const q=$('todo-search').value.trim().toLowerCase();
 const matches=all.filter(t=>(!scope||t.project===scope||t.project.startsWith(scope+'/'))&&(todoFilter==='all'||(todoFilter==='today'?todoIsToday(t):todoOverdue(t)))&&`${t.title} ${t.note} ${t.project}`.toLowerCase().includes(q));
 const sort=(a,b)=>Number(b.priority)-Number(a.priority)||Number(todoOverdue(b))-Number(todoOverdue(a))||(a.due||'9999').localeCompare(b.due||'9999')||b.updated.localeCompare(a.updated);
 const card=t=>`<article class="todo-card ${t.status==='done'?'todo-done':''}" draggable="true" data-todo-card="${esc(t.id)}"><div class="todo-card-top"><button class="todo-check" data-todo-complete="${esc(t.id)}" aria-label="${t.status==='done'?'重新打开':'完成'}：${esc(t.title)}">${t.status==='done'?'✓':'○'}</button><button class="todo-card-title" data-todo-edit="${esc(t.id)}">${esc(t.title)}</button></div><div class="todo-meta">${t.priority?'<span class="todo-priority">优先</span>':''}${t.due?`<time class="${todoOverdue(t)?'todo-overdue':''}" datetime="${esc(t.due)}">${t.due===today?'今天到期':esc(t.due.slice(5).replace('-','/'))}${todoOverdue(t)?' 逾期':''}</time>`:''}<button class="todo-day ${todoPlanned(t)?'is-planned':''}" data-todo-today="${esc(t.id)}" aria-pressed="${Boolean(todoPlanned(t))}">今天做</button></div>${t.project?`<button class="todo-scope" data-todo-directory="${esc(t.project)}" title="${esc(todoScopeLabel(t.project))}">${esc(todoScopeLabel(t.project))}</button>`:''}${t.note?`<p class="todo-excerpt">${esc(t.note.slice(0,100))}</p>`:''}${t.fileIds.length?`<div class="todo-attachments">${t.fileIds.map(id=>{const f=data.files.find(f=>f.id===id);return f?`<button data-file="${esc(id)}">▤ ${esc(f.name)}</button>`:'<span class="muted">文件暂不可用</span>';}).join('')}</div>`:''}</article>`;
 $('todo-lanes').innerHTML=todoStatuses.map(([key,label])=>{const rows=matches.filter(t=>t.status===key).sort(sort);return `<section class="todo-lane" data-todo-lane="${key}" aria-label="${label}"><header><h2>${label}</h2><span>${rows.length}</span></header><div class="todo-lane-body">${rows.map(card).join('')||'<div class="todo-lane-empty">暂无待办</div>'}</div></section>`;}).join('');
 const next=Object.entries(data.state.projects).filter(([dir,p])=>p.next?.trim()&&data.directories.includes(dir)&&!all.some(t=>t.sourceKey==='next:'+dir&&t.sourceText===p.next.trim())).filter(([dir,p])=>(!scope||dir===scope||dir.startsWith(scope+'/'))&&`${dir} ${p.next}`.toLowerCase().includes(q));
 $('next-inbox').hidden=!next.length;$('next-count').textContent=next.length||'';
 $('next-inbox-list').innerHTML=next.map(([dir,p])=>`<div class="next-inbox-row"><div><span>${esc(p.next)}</span><button data-todo-directory="${esc(dir)}">${esc(todoScopeLabel(dir))}</button></div><button data-next-add="${esc(dir)}">加入待办</button></div>`).join('');
}
async function updateTodo(id,patch){
 if(todoMutating.has(id))return;const task=data.state.todos.find(t=>t.id===id);if(!task)return toast('待办已移除，请刷新');todoMutating.add(id);
 try{await post('/api/todos',{...task,today:Boolean(todoPlanned(task)),...patch});await load();}catch(e){toast(e.message);}finally{todoMutating.delete(id);}
}
function todoFormValue(){return {id:todoEditId,title:$('todo-title').value,project:$('todo-project').value,status:$('todo-status').value,due:$('todo-due').value,today:$('todo-today').checked,priority:$('todo-priority').checked,note:$('todo-note').value,fileIds:[...todoLinks].sort()};}
function todoDirty(){return $('todo-dialog').open&&todoBaseline!==JSON.stringify(todoFormValue());}
function renderTodoFiles(){
 const scope=$('todo-project').value,q=$('todo-file-search').value.trim().toLowerCase();
 const pool=data.files.filter(f=>(!scope||f.rel.startsWith(scope+'/'))&&(!q||f.rel.toLowerCase().includes(q))).sort((a,b)=>Number(todoLinks.has(b.id))-Number(todoLinks.has(a.id))||b.mtime-a.mtime).slice(0,80);
 const unavailable=[...todoLinks].filter(id=>!data.files.some(f=>f.id===id));
 $('todo-link-count').textContent=todoLinks.size?'· '+todoLinks.size:'';
 $('todo-file-list').innerHTML=pool.map(f=>`<label><input type="checkbox" data-todo-link="${esc(f.id)}" ${todoLinks.has(f.id)?'checked':''}><span>${esc(f.name)} <span class="muted">${esc(f.rel.split('/').slice(0,-1).join(' / '))}</span></span></label>`).join('')+unavailable.map(id=>`<label><input type="checkbox" data-todo-link="${esc(id)}" checked><span>文件暂不可用</span></label>`).join('')+(pool.length===80?'<span class="muted">搜索更多文件</span>':'');
}
function editTodo(id){
 const t=data.state.todos.find(t=>t.id===id);if(!t)return;
 todoDraft=false;$('todo-delete').hidden=false;$('todo-dialog').querySelector('h2').textContent='编辑待办';
 todoEditId=t.id;$('todo-project').disabled=Boolean(t.progressProjectId);$('todo-go-progress').hidden=!t.progressProjectId;todoLinks=new Set(t.fileIds);$('todo-title').value=t.title;$('todo-project').innerHTML=todoProjectOptions(t.project);$('todo-project').value=t.project;$('todo-status').value=t.status;$('todo-due').value=t.due;$('todo-today').checked=Boolean(todoPlanned(t));$('todo-priority').checked=t.priority;$('todo-note').value=t.note;$('todo-file-search').value='';$('todo-form-error').textContent='';$('todo-delete').textContent='删除';$('todo-delete').dataset.confirm='';$('todo-dialog').querySelector('.todo-related').open=t.fileIds.length>0;renderTodoFiles();todoBaseline=JSON.stringify(todoFormValue());$('todo-dialog').showModal();$('todo-title').focus();
}
function newTodoDraft(initial={}){
 if(!data)return;
 todoEditId=null;todoDraft=true;todoLinks=new Set(initial.fileIds||[]);
 $('todo-dialog').querySelector('h2').textContent='新建待办';$('todo-delete').hidden=true;$('todo-delete').dataset.confirm='';$('todo-go-progress').hidden=true;$('todo-project').disabled=false;
 $('todo-title').value=initial.title||'';$('todo-project').innerHTML=todoProjectOptions(initial.project||'');$('todo-project').value=initial.project||'';$('todo-status').value=initial.status||'todo';$('todo-due').value=initial.due||'';$('todo-today').checked=Boolean(initial.today);$('todo-priority').checked=Boolean(initial.priority);$('todo-note').value=initial.note||'';$('todo-file-search').value='';$('todo-form-error').textContent='';$('todo-dialog').querySelector('.todo-related').open=todoLinks.size>0;
 renderTodoFiles();todoBaseline=JSON.stringify(todoFormValue());$('todo-dialog').showModal();$('todo-title').focus();$('todo-title').select();
}
async function saveTodoForm(){
 if(todoSaving)return false;todoSaving=true;$('todo-save').disabled=true;
 try{const result=await post('/api/todos',todoFormValue());if(todoDraft){todoEditId=result.todo.id;todoDraft=false;$('todo-delete').hidden=false;}todoBaseline=JSON.stringify(todoFormValue());await load();return true;}catch(e){$('todo-form-error').textContent=e.message;return false;}finally{todoSaving=false;$('todo-save').disabled=false;}
}
async function closeTodo(){if(todoSaving)return;if(!todoDraft&&todoDirty()&&!await saveTodoForm())return;$('todo-dialog').close();todoDraft=false;}
function initTodos(){
 $('todo-quick').onsubmit=async event=>{event.preventDefault();const input=$('todo-quick-title'),title=input.value.trim(),button=event.submitter;if(!title)return;if(button)button.disabled=true;try{await post('/api/todos',{title,project:$('todo-project-filter').value,note:'',status:'todo',due:todoFilter==='overdue'?todoDay():'',today:todoFilter==='today',priority:false,fileIds:[]});input.value='';if(todoFilter==='overdue')todoFilter='today';await load();input.focus();}catch(e){toast(e.message);}finally{if(button)button.disabled=false;}};
 $('todo-project-filter').onchange=renderTodoBoard;$('todo-search').oninput=renderTodoBoard;
 $('todo-form').onsubmit=async e=>{e.preventDefault();if(await saveTodoForm())$('todo-dialog').close();};
 $('todo-close').onclick=closeTodo;$('todo-dialog').addEventListener('cancel',e=>{e.preventDefault();closeTodo();});
 $('todo-project').onchange=()=>{const scope=$('todo-project').value;todoLinks=new Set([...todoLinks].filter(id=>{const f=data.files.find(f=>f.id===id);return !f||!scope||f.rel.startsWith(scope+'/');}));renderTodoFiles();};
 $('todo-file-search').oninput=renderTodoFiles;$('todo-file-list').onchange=e=>{const id=e.target.dataset.todoLink;if(id){e.target.checked?todoLinks.add(id):todoLinks.delete(id);$('todo-link-count').textContent=todoLinks.size?'· '+todoLinks.size:'';}};
 $('todo-delete').onclick=async()=>{if(todoSaving)return;const button=$('todo-delete');if(button.dataset.confirm!==todoEditId){button.dataset.confirm=todoEditId;button.textContent='确认删除';return;}todoSaving=true;button.disabled=true;try{await post('/api/todos/delete',{id:todoEditId});$('todo-dialog').close();await load();}catch(e){$('todo-form-error').textContent=e.message;}finally{todoSaving=false;button.disabled=false;}};
 document.addEventListener('click',async e=>{const b=e.target.closest('button');if(!b)return;
  if(b.dataset.todoFilter){todoFilter=b.dataset.todoFilter;renderTodoBoard();}
  if(b.dataset.todoEdit)editTodo(b.dataset.todoEdit);
  if(b.dataset.todoComplete){const t=data.state.todos.find(t=>t.id===b.dataset.todoComplete);if(t)await updateTodo(t.id,{status:t.status==='done'?'todo':'done'});}
  if(b.dataset.todoToday){const t=data.state.todos.find(t=>t.id===b.dataset.todoToday);if(t)await updateTodo(t.id,{today:!todoPlanned(t)});}
  if(b.dataset.todoDirectory){if(data.directories.includes(b.dataset.todoDirectory))selectDirectory(b.dataset.todoDirectory);else toast('目录暂不可用');}
  if(b.dataset.nextAdd){b.disabled=true;try{await post('/api/todos/from-next',{project:b.dataset.nextAdd});await load();}catch(e){toast(e.message);b.disabled=false;}}
 });
 $('todo-lanes').addEventListener('dragstart',e=>{const card=e.target.closest('[data-todo-card]');if(!card)return;todoDragging=card.dataset.todoCard;e.dataTransfer.setData('application/x-project-desk-todo',todoDragging);e.dataTransfer.effectAllowed='move';});
 document.addEventListener('dragover',e=>{if(!todoDragging)return;e.preventDefault();e.stopImmediatePropagation();document.querySelectorAll('.todo-lane.is-dragover').forEach(n=>n.classList.remove('is-dragover'));e.target.closest('[data-todo-lane]')?.classList.add('is-dragover');},true);
 document.addEventListener('drop',e=>{if(!todoDragging)return;e.preventDefault();e.stopImmediatePropagation();const id=todoDragging,lane=e.target.closest('[data-todo-lane]');todoDragging=null;document.querySelectorAll('.todo-lane.is-dragover').forEach(n=>n.classList.remove('is-dragover'));if(lane)updateTodo(id,{status:lane.dataset.todoLane});},true);
 document.addEventListener('dragend',()=>{todoDragging=null;document.querySelectorAll('.todo-lane.is-dragover').forEach(n=>n.classList.remove('is-dragover'));});
 let date=todoDay();setInterval(()=>{if(date!==todoDay()){date=todoDay();if(data&&view==='board')renderTodoBoard();}},30000);
}
