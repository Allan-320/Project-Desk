'use strict';
let serviceMode='running',servicePendingWrites=0,serviceStopFlight=false,serviceDraftInputs=null,serviceStopTimer=null,serviceStopChecks=0,serviceCheckingStop=false;
function serviceHasDrafts(){
 if(fileDirty()||todoDirty()||progressUnsaved()||(typeof notesUnsaved==='function'&&notesUnsaved()))return true;
 if($('todo-dialog').open&&todoDraft)return true;
 if($('progress-project-dialog').open||$('progress-stage-dialog').open||$('file-stage-dialog')?.open)return true;
 if(!$('node-form').hidden)return true;
 if(['todo-quick-title','progress-stage-title','progress-demand-party'].some(id=>$(id)?.value.trim()))return true;
 if(data&&$('project-next').value!==(data.state.projects[focusDir||project]?.next||'')&&!document.querySelector('.next-line').hidden)return true;
 return Boolean($('import-dialog').open&&importQueue.some(item=>item.state!=='done'));
}
function serviceBusy(){return (typeof notesBusy==='function'&&notesBusy())||servicePendingWrites>0||importBusy||todoSaving||todoMutating.size>0||progressPending>0||followupBusy;}
function rememberServiceInputs(){
 if(serviceDraftInputs)return;
 serviceDraftInputs=[...document.querySelectorAll('input[id],textarea[id],select[id]')].filter(el=>el.type!=='file').map(el=>({id:el.id,value:el.value,checked:el.checked}));
}
function restoreServiceInputs(){for(const item of serviceDraftInputs||[]){const el=$(item.id);if(el){el.value=item.value;if(typeof item.checked==='boolean')el.checked=item.checked;}}serviceDraftInputs=null;}
function releaseServicePreviews(){
 if(typeof documentSearchReset==='function')documentSearchReset();
 if(typeof disposeSpreadsheetPreview==='function')disposeSpreadsheetPreview();
 if(typeof disposeWordPreview==='function')disposeWordPreview();
 if(typeof stopFileVisuals==='function')stopFileVisuals();
 document.querySelectorAll('video,audio').forEach(el=>{el.pause();el.removeAttribute('src');el.load();});
 document.querySelectorAll('#preview iframe').forEach(el=>el.remove());
 document.querySelectorAll('img[src^="/api/thumbnail/"],img[src^="/file/"]').forEach(el=>el.remove());
 if(selected){$('preview').replaceChildren();const p=document.createElement('p');p.className='muted';p.textContent='预览已释放，重新连接后可继续查看。';$('preview').append(p);}
}
function showServicePanel(stopped){
 $('service-stop-title').textContent=stopped?'已停止运行':'正在停止后台服务…';
 $('service-stop-message').textContent=stopped?'文件夹监听和后台预览已关闭。下次双击启动文件即可恢复。':'正在释放目录监听和预览资源。';
 $('service-draft-notice').hidden=!serviceHasDrafts();
 $('launcher-path').textContent=data?.launcherPath||'启动项目资料台.cmd';
 $('copy-launcher-path').disabled=!data?.launcherPath;
 $('reconnect-service').disabled=!stopped;
 $('reconnect-service').textContent=stopped?'重新连接':'检查状态';
 if(!$('service-stopped').open)$('service-stopped').showModal();
}
function markServiceStopped(){
 if(serviceMode==='stopped')return;
 rememberServiceInputs();serviceMode='stopped';serviceStopFlight=false;clearTimeout(serviceStopTimer);clearTimeout(retryTimer);events?.close();
 releaseServicePreviews();$('connection').textContent='后台已停止';$('scan-status').textContent='后台已停止';$('stop-service').disabled=true;
 showServicePanel(true);
}
async function verifyServiceStopped(){
 if(serviceMode!=='stopping'||serviceCheckingStop)return;
 clearTimeout(serviceStopTimer);serviceCheckingStop=true;serviceStopChecks++;$('reconnect-service').disabled=true;
 try{await fetch('/',{cache:'no-store',signal:AbortSignal.timeout(1500)});}
 catch(e){if(e.name!=='TimeoutError'&&e.name!=='AbortError')markServiceStopped();}
 finally{serviceCheckingStop=false;}
 if(serviceMode!=='stopping')return;
 if(serviceStopChecks<4){$('service-stop-message').textContent='正在等待后台结束当前工作…';serviceStopTimer=setTimeout(verifyServiceStopped,1500);}
 else{$('service-stop-title').textContent='停止状态待确认';$('service-stop-message').textContent='未能确认后台状态，点“检查状态”重试。';$('reconnect-service').disabled=false;}
}
async function stopDeskService(){
 if(serviceStopFlight||serviceMode!=='running')return;
 if(!data)return toast('请等待资料台连接完成');
 if(serviceBusy())return toast('正在保存或导入，请完成后再停止');
 if(serviceHasDrafts())return toast('还有未保存的内容，请先保存或取消后再停止');
 serviceStopFlight=true;$('stop-service').disabled=true;
 try{
  const response=await fetch('/api/shutdown',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}),result=await response.json();
  if(!response.ok)throw new Error(result.error||'停止失败，请重试');
  if(!result.ok||!result.stopping)throw new Error('未收到停止确认，请重试');
  if(serviceMode!=='stopped'){rememberServiceInputs();serviceMode='stopping';serviceStopChecks=0;clearTimeout(retryTimer);showServicePanel(false);serviceStopTimer=setTimeout(verifyServiceStopped,3000);}
 }catch(e){if(serviceMode==='stopped')return;toast(e.message||'停止失败，后台可能仍在运行');}
 finally{serviceStopFlight=false;if(serviceMode==='running')$('stop-service').disabled=false;}
}
function connectServiceEvents(){
 events?.close();events=new EventSource('/api/events');
 events.addEventListener('shutdown',markServiceStopped);
 events.onmessage=event=>{if(serviceMode!=='running')return;const value=JSON.parse(event.data);if(data&&value.version!==data.version)load();};
 events.onopen=()=>{if(serviceMode!=='running')return;clearTimeout(retryTimer);if(data)$('connection').textContent=data.watchStatus+' · '+data.files.length+' 个文件';};
 events.onerror=()=>{if(serviceMode==='stopping'){events.close();verifyServiceStopped();return;}if(serviceMode!=='running')return;$('connection').textContent='连接重试中，已显示资料仍可查看';clearTimeout(retryTimer);retryTimer=setTimeout(load,4000);};
}
async function reconnectDeskService(){
 const button=$('reconnect-service');button.disabled=true;$('service-stop-message').textContent='正在连接…';
 try{
  const response=await fetch('/',{cache:'no-store',signal:AbortSignal.timeout(2500)}),html=await response.text();
  if(!response.ok||!html.includes('id="progress-view"'))throw new Error('资料台尚未启动');
  const snapshotResponse=await fetch('/api/snapshot',{cache:'no-store',signal:AbortSignal.timeout(2500)});
  if(!snapshotResponse.ok)throw new Error('资料台尚未就绪');
  const snapshot=await snapshotResponse.json();if(!Array.isArray(snapshot.files)||!snapshot.state)throw new Error('资料台尚未就绪');
  if(data&&snapshot.root!==data.root)throw new Error('启动的是另一资料目录，请恢复原目录后再连接');
  serviceMode='running';data=snapshot;render();restoreServiceInputs();if(selected)renderFileFollowups(selected);
  if(typeof resumeFileVisuals==='function')resumeFileVisuals();
  if(selected){const resume=document.createElement('button');resume.textContent='重新预览';resume.onclick=async()=>{const draft={note:$('file-note').value,tags:$('file-tags').value,pinned:$('file-pin').checked};const previewTask=openFile(selected);$('file-note').value=draft.note;$('file-tags').value=draft.tags;$('file-pin').checked=draft.pinned;await previewTask;};$('preview').replaceChildren(resume);}
  $('service-stopped').close();$('stop-service').disabled=false;$('connection').textContent=data.watchStatus+' · '+data.files.length+' 个文件';$('scan-status').textContent='后台已重新连接';$('error').hidden=true;connectServiceEvents();toast('已重新连接');
 }catch(e){serviceMode='stopped';$('service-stop-message').textContent=e.message==='启动的是另一资料目录，请恢复原目录后再连接'?e.message:'尚未连接。请先双击启动文件，再点“重新连接”。';}
 finally{button.disabled=false;}
}
document.addEventListener('DOMContentLoaded',()=>{
 $('stop-service').onclick=stopDeskService;
 $('service-stopped').addEventListener('cancel',event=>event.preventDefault());
 $('copy-launcher-path').onclick=async()=>{try{await navigator.clipboard.writeText(data.launcherPath);$('service-stop-message').textContent='已复制启动路径，可粘贴到资源管理器地址栏。';}catch{$('service-stop-message').textContent='请选中上面的启动路径复制。';}};
 $('reconnect-service').onclick=()=>{if(serviceMode==='stopping'){serviceStopChecks=0;verifyServiceStopped();}else reconnectDeskService();};
});
