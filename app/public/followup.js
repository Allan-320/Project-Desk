'use strict';
let followupFileId=null,followupBusy=false,followupInitialized=false;
const followupContains=(file,directory)=>Boolean(directory)&&file.rel.startsWith(directory+'/');
function followupFileDirectory(file){
 if(focusDir&&data.directories.includes(focusDir)&&followupContains(file,focusDir))return focusDir;
 return file.rel.split('/').slice(0,-1).join('/');
}
function followupPlans(file,snapshot=data){return (snapshot?.state.progressProjects||[]).filter(p=>followupContains(file,p.directory)&&snapshot.directories.includes(p.directory));}
function renderFileFollowups(id){
 if(!followupInitialized||!data)return;
 const file=data.files.find(f=>f.id===id);followupFileId=file?.id||null;
 $('file-followup-actions').hidden=!file;if(!file)return;
 $('file-add-todo').disabled=followupBusy;$('file-link-stage').disabled=followupBusy;
 const tasks=(data.state.todos||[]).filter(t=>t.fileIds.includes(id)),plans=(data.state.progressProjects||[]).flatMap(p=>p.stages.filter(s=>s.fileIds.includes(id)).map(s=>({p,s})));
 $('file-followup-links').hidden=!tasks.length&&!plans.length;
 $('file-followup-links').innerHTML=tasks.map(t=>`<button type="button" class="file-followup-link" data-file-followup-task="${esc(t.id)}"><span>待办 · ${esc(t.title)}</span><span class="muted">${esc(todoStatuses.find(([key])=>key===t.status)?.[1]||'待办')}</span></button>`).join('')+plans.map(({p,s})=>`<button type="button" class="file-followup-link" data-file-followup-project="${esc(p.id)}" data-file-followup-stage="${esc(s.id)}"><span>${esc(p.name)} · ${esc(s.title)}</span><span class="muted">${esc(s.status)}</span></button>`).join('');
}
async function followupLeaveFile(){
 await closeFile();if($('file-dialog').open)return false;
 if($('progress-stage-dialog').open){await closeProgressStage();if($('progress-stage-dialog').open)return false;}
 return true;
}
function openFileStagePicker(){
 const file=data?.files.find(f=>f.id===followupFileId);if(!file)return;
 const plans=followupPlans(file),count=plans.reduce((n,p)=>n+p.stages.length,0);
 $('file-stage-name').textContent=file.name;$('file-stage-error').textContent='';
 $('file-stage-select').innerHTML='<option value="">选择项目节点</option>'+plans.map(p=>`<optgroup label="${esc(p.name)}">${p.stages.map(s=>{const linked=s.fileIds.includes(file.id),full=s.fileIds.length>=20;return `<option value="${esc(p.id+':'+s.id)}" ${linked||full?'disabled':''}>${esc(s.title)}${linked?' · 已关联':full?' · 已满20份':''}</option>`;}).join('')}</optgroup>`).join('');
 $('file-stage-empty').hidden=Boolean(count);$('file-stage-empty').textContent='当前目录暂无项目节点';$('file-stage-select').disabled=!count;$('file-stage-save').disabled=!count;
 $('file-stage-dialog').showModal();if(count)$('file-stage-select').focus();
}
function initFollowup(){
 if(followupInitialized)return;const actions=document.querySelector('#file-dialog .preview-actions');if(!actions)return;followupInitialized=true;
 const host=document.createElement('div');host.id='file-followup-actions';host.className='file-followup-actions';host.hidden=true;host.innerHTML='<div class="file-followup-buttons"><button type="button" id="file-add-todo">记待办</button><button type="button" id="file-link-stage">关联节点</button></div><div id="file-followup-links" class="file-followup-links" hidden></div>';document.querySelector('#file-dialog .annotations').prepend(host);
 const dialog=document.createElement('dialog');dialog.id='file-stage-dialog';dialog.innerHTML='<form id="file-stage-form"><div class="dialog-head"><h2>关联节点</h2><button type="button" id="file-stage-cancel">取消</button></div><p id="file-stage-name" class="muted"></p><label>项目节点<select id="file-stage-select" required></select></label><p id="file-stage-empty" class="muted" hidden></p><p id="file-stage-error" role="alert"></p><div class="actions"><button type="submit" id="file-stage-save" class="primary">保存关联</button></div></form>';document.body.append(dialog);
 $('file-add-todo').onclick=async()=>{if(followupBusy)return;const file=data?.files.find(f=>f.id===followupFileId);if(!file)return;const directory=followupFileDirectory(file);followupBusy=true;try{if(await followupLeaveFile())newTodoDraft({title:('跟进：'+file.name).slice(0,500),project:directory,fileIds:[file.id]});}catch(e){toast(e.message);}finally{followupBusy=false;}};
 $('file-link-stage').onclick=openFileStagePicker;$('file-stage-cancel').onclick=()=>{if(!followupBusy)dialog.close();};dialog.addEventListener('cancel',event=>{if(followupBusy)event.preventDefault();});
 $('file-stage-form').onsubmit=async event=>{
  event.preventDefault();if(followupBusy)return;
  const id=followupFileId,choice=$('file-stage-select').value,[projectId,stageId]=choice.split(':');if(!projectId||!stageId)return;
  followupBusy=true;$('file-stage-save').disabled=true;$('file-stage-cancel').disabled=true;$('file-stage-error').textContent='';
  try{
   const latest=await request('/api/snapshot'),file=latest.files.find(f=>f.id===id),project=file&&followupPlans(file,latest).find(p=>p.id===projectId),stage=project?.stages.find(s=>s.id===stageId);
   if(!file||!stage)throw new Error('文件或节点已变化，请重新选择');
   const links=[...new Set([...stage.fileIds,id])];if(links.length>20)throw new Error('一个节点最多关联20份资料');
   if(!stage.fileIds.includes(id))await post('/api/progress/stage',{projectId,id:stageId,fileIds:links});
   if($('progress-stage-dialog').open&&progressSelected===projectId&&progressStageEditing===stageId)progressLinks.add(id);
   await load();renderFileFollowups(id);dialog.close();toast('已关联节点');
  }catch(e){$('file-stage-error').textContent=e.message;}finally{followupBusy=false;$('file-stage-save').disabled=false;$('file-stage-cancel').disabled=false;if($('file-dialog').open)renderFileFollowups(id);}
 };
 host.addEventListener('click',async event=>{
  const button=event.target.closest('button');if(!button||followupBusy)return;
  const taskId=button.dataset.fileFollowupTask,projectId=button.dataset.fileFollowupProject,stageId=button.dataset.fileFollowupStage;if(!taskId&&!projectId)return;
  followupBusy=true;try{
   if(!await followupLeaveFile())return;
   if(taskId){if(data.state.todos.some(t=>t.id===taskId))editTodo(taskId);else toast('待办已移除，请刷新');return;}
   const plan=progressPlans().find(p=>p.id===projectId);if(!plan?.stages.some(s=>s.id===stageId))return toast('节点已移除，请刷新');
   progressSelected=projectId;progressSubview='schedule';view='progress';render();setURL();openProgressStage(stageId);
  }catch(e){toast(e.message);}finally{followupBusy=false;}
 });
 $('file-dialog').addEventListener('close',()=>{followupFileId=null;});
}
