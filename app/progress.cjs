const crypto=require('node:crypto');
const stagesTemplate=['客户样品需求数量确认','生产排期确认','原料到厂时间','上机试模完成','三坐标测试完成','胶带物料到厂时间','产品后道工序（胶）','样品寄出'];
const statuses=['待更新','待开始','进行中','待确认','已完成'];
const dateOK=v=>typeof v==='string'&&(!v||(/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v));
const textOK=(v,max,required=false)=>typeof v==='string'&&v.length<=max&&(!required||v.trim().length>0);
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
function createProgressController({state,save,changed,managedDirectory,getFiles,body,json}){
 if(!Array.isArray(state.progressProjects))state.progressProjects=[];
 function event(project,type,target,changes,reason=''){
  project.history.push({id:crypto.randomUUID(),at:new Date().toISOString(),type,target,changes,reason});
  project.updated=new Date().toISOString();
 }
 function linksOK(ids,directory,old=[]){return Array.isArray(ids)&&ids.length<=20&&ids.every(id=>typeof id==='string'&&((getFiles().has(id)&&(!directory||getFiles().get(id).rel.startsWith(directory+'/')))||old.includes(id)));}
 const find=id=>state.progressProjects.find(p=>p.id===id);
 function syncTask(project,stage){
  const status={'待更新':'todo','待开始':'todo','进行中':'doing','待确认':'waiting','已完成':'done'}[stage.status];
  for(const todo of state.todos.filter(t=>t.progressProjectId===project.id&&t.progressStageId===stage.id))Object.assign(todo,{title:stage.title,project:project.directory,due:stage.plannedDate,status,fileIds:[...stage.fileIds],updated:new Date().toISOString()});
 }
 // Todo updates and schedule updates share the same dates, title, files and status.
 function syncFromTodo(todo){
  if(!todo.progressProjectId)return;
  const project=find(todo.progressProjectId),stage=project?.stages.find(s=>s.id===todo.progressStageId);if(!stage)return fail('关联节点不存在，请刷新',409);
  if(todo.project!==project.directory)return fail('请在项目进度中修改关联目录');
  const previous=state.todos.find(t=>t.id===todo.id),patch={title:todo.title,plannedDate:todo.due,status:previous?.status===todo.status?stage.status:{todo:'待开始',doing:'进行中',waiting:'待确认',done:'已完成'}[todo.status],fileIds:todo.fileIds},changes={};
  for(const [key,value] of Object.entries(patch)){if(JSON.stringify(stage[key])!==JSON.stringify(value))changes[key]={from:stage[key],to:value};}
  if(!Object.keys(changes).length)return;
  Object.assign(stage,patch);if(!stage.baselineDate&&stage.plannedDate)stage.baselineDate=stage.plannedDate;
  event(project,'更新节点',stage.title,changes,'来自全部待办');
 }
 async function commit(res,value,code=200){await save();changed();return json(res,code,{ok:true,...value});}
 async function handle(req,res,url){
  if(req.method!=='POST')return json(res,405,{error:'请使用保存操作'});
  const input=await body(req);if(!input||typeof input!=='object'||Array.isArray(input))return fail('无效请求');
  if(url.pathname==='/api/progress/order'){
   const active=state.progressProjects.filter(p=>!p.archivedAt),activeIds=active.map(p=>p.id);
   if(Object.keys(input).some(key=>key!=='ids')||!Array.isArray(input.ids)||input.ids.length!==active.length||input.ids.some(id=>typeof id!=='string'||!activeIds.includes(id))||new Set(input.ids).size!==input.ids.length)return fail('项目顺序已变化，请刷新后重新排列');
   if(input.ids.every((id,index)=>id===activeIds[index]))return json(res,200,{ok:true,ids:activeIds});
   const ordered=input.ids.map(id=>active.find(p=>p.id===id));
   for(let i=0;i<ordered.length;i++){const previous=activeIds.indexOf(ordered[i].id);if(previous!==i)event(ordered[i],'调整项目顺序',ordered[i].name,{order:{from:previous+1,to:i+1}});}
   state.progressProjects=[...ordered,...state.progressProjects.filter(p=>p.archivedAt)];return commit(res,{ids:input.ids});
  }
  if(url.pathname==='/api/progress/archive'){
   if(Object.keys(input).some(key=>!['id','archived'].includes(key))||!textOK(input.id,200,true)||typeof input.archived!=='boolean')return fail('请选择项目以及关闭或恢复操作');
   const project=find(input.id);if(!project)return fail('项目不存在',404);
   if(Boolean(project.archivedAt)===input.archived)return json(res,200,{ok:true,project});
   const before=project.archivedAt||'';project.archivedAt=input.archived?new Date().toISOString():'';
   event(project,input.archived?'关闭项目':'恢复项目',project.name,{archivedAt:{from:before,to:project.archivedAt}});
   const others=state.progressProjects.filter(p=>p.id!==project.id),active=others.filter(p=>!p.archivedAt),archived=others.filter(p=>p.archivedAt);
   state.progressProjects=input.archived?[...active,...archived,project]:[...active,project,...archived];return commit(res,{project});
  }
  if(url.pathname==='/api/progress/project'){
   const existing=input.id?find(input.id):null;if(input.id&&!existing)return fail('项目不存在',404);
   if(!textOK(input.name,160,true)||!textOK(input.directory,2000)||(!managedDirectory(input.directory)&&input.directory!==existing?.directory)||!textOK(input.unit,12,true)||!textOK(input.demandNote,1000))return fail('请检查项目名称、目录和单位');
   if(input.directory&&state.progressProjects.some(p=>p.id!==existing?.id&&p.directory===input.directory))return fail('这个目录已有项目计划，请直接打开该项目',409);
   if(existing){
    const patch={name:input.name.trim(),directory:input.directory,unit:input.unit.trim(),demandNote:input.demandNote},changes={};
    if(input.directory!==existing.directory&&existing.stages.some(s=>!linksOK(s.fileIds,input.directory)))return fail('请先解除不属于新目录的资料关联');
    for(const [key,value] of Object.entries(patch))if(existing[key]!==value)changes[key]={from:existing[key],to:value};
    if(Object.keys(changes).length){Object.assign(existing,patch);event(existing,'更新项目',existing.name,changes);for(const stage of existing.stages)syncTask(existing,stage);}
    return commit(res,{project:existing});
   }
   if(!['blank','sample'].includes(input.template))return fail('请选择空白或样品交付模板');
   const now=new Date().toISOString(),project={id:crypto.randomUUID(),name:input.name.trim(),directory:input.directory,unit:input.unit.trim(),demandNote:input.demandNote,archivedAt:'',stages:[],demands:[],history:[],created:now,updated:now};
   if(input.template==='sample')project.stages=stagesTemplate.map(title=>({id:crypto.randomUUID(),title,baselineDate:'',plannedDate:'',actualDate:'',status:'待更新',note:'',fileIds:[]}));
   event(project,'新建项目',project.name,{template:{from:'',to:input.template==='sample'?'样品交付':'空白'}});state.progressProjects=[...state.progressProjects.filter(p=>!p.archivedAt),project,...state.progressProjects.filter(p=>p.archivedAt)];return commit(res,{project},201);
  }
  const project=find(input.projectId);if(!project)return fail('项目不存在',404);
  if(url.pathname==='/api/progress/stage'){
   const existing=input.id?project.stages.find(s=>s.id===input.id):null;if(input.id&&!existing)return fail('节点不存在',404);
   const old=existing||{id:crypto.randomUUID(),title:'',baselineDate:'',plannedDate:'',actualDate:'',status:'待更新',note:'',fileIds:[]};
   const stage={...old};for(const key of ['title','plannedDate','actualDate','status','note','fileIds'])if(Object.hasOwn(input,key))stage[key]=input[key];
   if(!textOK(stage.title,200,true)||!textOK(stage.note,3000)||!dateOK(stage.plannedDate)||!dateOK(stage.actualDate)||!statuses.includes(stage.status)||!linksOK(stage.fileIds,project.directory,old.fileIds)||!textOK(input.reason??'',500))return fail('请检查节点名称、日期、状态及关联资料');
   stage.title=stage.title.trim();stage.fileIds=[...new Set(stage.fileIds)];
   if(!stage.baselineDate&&stage.plannedDate)stage.baselineDate=stage.plannedDate;
   const changes={};for(const key of ['title','plannedDate','actualDate','status','note','fileIds'])if(JSON.stringify(old[key])!==JSON.stringify(stage[key]))changes[key]={from:old[key],to:stage[key]};
   if(existing)project.stages=project.stages.map(s=>s.id===stage.id?stage:s);else{if(project.stages.length>=300)return fail('每个项目最多 300 个节点');project.stages.push(stage);}
   if(Object.keys(changes).length||!existing)event(project,existing?'更新节点':'新增节点',stage.title,changes,input.reason||'');syncTask(project,stage);return commit(res,{stage},existing?200:201);
  }
  if(url.pathname==='/api/progress/stage-order'){
   if(!Array.isArray(input.ids)||input.ids.length!==project.stages.length||new Set(input.ids).size!==input.ids.length||input.ids.some(id=>!project.stages.some(s=>s.id===id)))return fail('节点顺序不完整');
   const before=project.stages.map(s=>s.title);project.stages=input.ids.map(id=>project.stages.find(s=>s.id===id));event(project,'调整顺序',project.name,{order:{from:before,to:project.stages.map(s=>s.title)}});return commit(res,{});
  }
  if(url.pathname==='/api/progress/stage-delete'){
   const stage=project.stages.find(s=>s.id===input.id);if(!stage)return fail('节点不存在',404);
   if(state.todos.some(t=>t.progressProjectId===project.id&&t.progressStageId===stage.id))return fail('节点已关联待办，请先删除对应待办');
   project.stages=project.stages.filter(s=>s.id!==stage.id);event(project,'删除节点',stage.title,{stage:{from:stage,to:null}});return commit(res,{});
  }
  if(url.pathname==='/api/progress/demand'){
   const existing=input.id?project.demands.find(d=>d.id===input.id):null;if(input.id&&!existing)return fail('需求不存在',404);
   const old=existing||{id:crypto.randomUUID(),party:'',quantity:null,note:''},demand={...old};for(const key of ['party','quantity','note'])if(Object.hasOwn(input,key))demand[key]=input[key];
   if(!textOK(demand.party,120,true)||!textOK(demand.note,2000)||(demand.quantity!==null&&(!Number.isSafeInteger(demand.quantity)||demand.quantity<0||demand.quantity>100000000)))return fail('需求方不能为空，数量请填非负整数');
   demand.party=demand.party.trim();if(existing)project.demands=project.demands.map(d=>d.id===demand.id?demand:d);else{if(project.demands.length>=200)return fail('每个项目最多 200 条需求');project.demands.push(demand);}
   const changes={};for(const key of ['party','quantity','note'])if(old[key]!==demand[key])changes[key]={from:old[key],to:demand[key]};if(Object.keys(changes).length)event(project,existing?'更新需求':'新增需求',demand.party,changes);return commit(res,{demand},existing?200:201);
  }
  if(url.pathname==='/api/progress/demand-delete'){
   const demand=project.demands.find(d=>d.id===input.id);if(!demand)return fail('需求不存在',404);project.demands=project.demands.filter(d=>d.id!==demand.id);event(project,'删除需求',demand.party,{demand:{from:demand,to:null}});return commit(res,{});
  }
  if(url.pathname==='/api/progress/stage-todo'){
   const stage=project.stages.find(s=>s.id===input.id);if(!stage)return fail('节点不存在',404);
   let todo=state.todos.find(t=>t.progressProjectId===project.id&&t.progressStageId===stage.id);if(todo)return json(res,200,{ok:true,todo});
   const now=new Date().toISOString();todo={id:crypto.randomUUID(),title:stage.title,project:project.directory,due:stage.plannedDate,status:{'待更新':'todo','待开始':'todo','进行中':'doing','待确认':'waiting','已完成':'done'}[stage.status],note:'',today:false,plannedDate:'',priority:false,fileIds:[...stage.fileIds],progressProjectId:project.id,progressStageId:stage.id,created:now,updated:now};state.todos.push(todo);event(project,'加入待办',stage.title,{});return commit(res,{todo},201);
  }
  return json(res,404,{error:'不存在的项目操作'});
 }
 return {handle,syncFromTodo};
}
module.exports={createProgressController,stagesTemplate};
