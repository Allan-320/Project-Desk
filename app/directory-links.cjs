'use strict';

// Directory links are app metadata only. This module never reads or moves source files.
const own=(value,key)=>Object.prototype.hasOwnProperty.call(value,key);
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const relative=value=>typeof value==='string'&&value.length>0&&!value.includes('\\')&&!value.startsWith('/')&&!/^[a-z]:/i.test(value)&&value.split('/').every(part=>part&&part!=='.'&&part!=='..');
const within=(value,dir)=>value===dir||value.startsWith(dir+'/');
const entries=map=>object(map)?Object.entries(map):[];
const currentPaths=directories=>new Set((Array.isArray(directories)?directories:[]).map(item=>typeof item==='string'?item:item?.rel).filter(relative));
const order=mappings=>Object.entries(mappings).sort((a,b)=>b[0].length-a[0].length);
function matchMapping(value,ordered){return typeof value==='string'?ordered.find(([from])=>within(value,from)):undefined;}
function replacePath(value,ordered){const match=matchMapping(value,ordered);return match?match[1]+value.slice(match[0].length):value;}

function collisionSources(state,mappings){
 const ordered=order(mappings),blocked=new Set();
 function inspect(values){
  const targets=new Map();
  for(const value of values){
   if(!relative(value))continue;
   const target=replacePath(value,ordered),mapping=matchMapping(value,ordered);
   if(!targets.has(target)){targets.set(target,{value,mapping});continue;}
   const previous=targets.get(target);
   // Existing duplicate records remain untouched; only newly collapsed scopes conflict.
   if(previous.value===value)continue;
   if(mapping)blocked.add(mapping[0]);
   if(previous.mapping)blocked.add(previous.mapping[0]);
  }
 }
 inspect(Object.keys(object(state.projects)?state.projects:{}));
 inspect((Array.isArray(state.progressProjects)?state.progressProjects:[]).map(project=>project?.directory));
 return blocked;
}

/** Apply an explicitly reviewed relative-directory map, without overwriting metadata. */
function applyDirectoryAliases(state,aliases,directories){
 const paths=currentPaths(directories),approved={};
 for(const [from,to] of entries(aliases)){
  // A recreated old path is a real directory again, so it must not inherit an old link.
  if(relative(from)&&relative(to)&&from!==to&&!paths.has(from)&&paths.has(to))Object.defineProperty(approved,from,{value:to,enumerable:true,configurable:true});
 }
 // Remove a whole mapping on conflict, then recheck the remaining prefix mappings.
 while(true){const conflicts=collisionSources(state,approved);if(!conflicts.size)break;for(const from of conflicts)delete approved[from];}
 const ordered=order(approved);let changed=false;
 if(ordered.length){
  if(object(state.projects)){
   const migrated={};
   for(const [key,value] of Object.entries(state.projects)){
    const target=replacePath(key,ordered);if(target!==key)changed=true;
    Object.defineProperty(migrated,target,{value,enumerable:true,configurable:true,writable:true});
   }
   if(changed)state.projects=migrated;
  }
  for(const records of [state.nodes,state.todos])for(const record of Array.isArray(records)?records:[]){
   if(!object(record))continue;const target=replacePath(record.project,ordered);
   if(target!==record.project){record.project=target;changed=true;}
  }
  for(const project of Array.isArray(state.progressProjects)?state.progressProjects:[]){
   if(!object(project))continue;const target=replacePath(project.directory,ordered);
   if(target!==project.directory){project.directory=target;changed=true;}
  }
 }
 const cumulative={};
 for(const [from,to] of entries(state.directoryAliases))if(relative(from)&&relative(to)&&from!==to)Object.defineProperty(cumulative,from,{value:replacePath(to,ordered),enumerable:true,configurable:true,writable:true});
 for(const [from,to] of ordered)Object.defineProperty(cumulative,from,{value:to,enumerable:true,configurable:true,writable:true});
 if(JSON.stringify(state.directoryAliases||{})!==JSON.stringify(cumulative)){state.directoryAliases=cumulative;changed=true;}
 return {changed,aliases:approved};
}

// Stable directory IDs take precedence over business-name fallback. Duplicate IDs
// cannot prove identity and are deliberately excluded on both sides.
function uniqueIdentityMap(identities){
 const result=new Map(),duplicates=new Set();
 for(const item of Array.isArray(identities)?identities:[]){
  if(!item||typeof item.id!=='string'||!item.id||!relative(item.rel))continue;
  if(result.has(item.id)){duplicates.add(item.id);continue;}result.set(item.id,item.rel);
 }
 for(const id of duplicates)result.delete(id);return result;
}
function businessKeys(rel){
 const name=rel.split('/').at(-1);
 // Model codes with >=2 digits are stronger than words; e.g. A123, B456.
 // Tonnage (650T), year/date numbers, F0 and ordinary format names are not IDs.
 const codes=[...name.matchAll(/(?<![a-z0-9])([a-z]{1,8}[0-9]{2,6}[a-z]?)(?![a-z0-9])/ig)].map(match=>match[1].toLowerCase());
 if(codes.length)return [...new Set(codes)];
 const generic=new Set(['project','projects','files','file','folder','archive','backup','model','models','step','xlsx','docx','design','drawing','drawings','data','sample','samples','test','total','temp','copy']);
 return [...new Set((name.match(/[a-z]{4,}/ig)||[]).map(word=>word.toLowerCase()).filter(word=>!generic.has(word)))];
}
function directoryScopes(state){
 const scopes=new Set(Object.keys(object(state.projects)?state.projects:{}));
 for(const records of [state.nodes,state.todos])for(const record of Array.isArray(records)?records:[])if(relative(record?.project))scopes.add(record.project);
 for(const project of Array.isArray(state.progressProjects)?state.progressProjects:[])if(relative(project?.directory))scopes.add(project.directory);
 return [...scopes].filter(relative).sort((a,b)=>a.length-b.length);
}
function referencedIds(state,scope){
 const ids=new Set();
 function add(record){for(const id of Array.isArray(record?.fileIds)?record.fileIds:[])if(typeof id==='string')ids.add(id);}
 for(const records of [state.nodes,state.todos])for(const record of Array.isArray(records)?records:[])if(relative(record?.project)&&within(record.project,scope))add(record);
 for(const project of Array.isArray(state.progressProjects)?state.progressProjects:[])if(relative(project?.directory)&&within(project.directory,scope))for(const stage of Array.isArray(project.stages)?project.stages:[])add(stage);
 return ids;
}

/** Reconcile saved relative scopes with a completed filesystem scan. */
function reconcileDirectoryLinks(state,directoryIdentities,files){
 const paths=currentPaths(directoryIdentities),previous=uniqueIdentityMap(state.directoryIdentities),current=uniqueIdentityMap(directoryIdentities),proposed={};
 for(const [id,from] of previous){const to=current.get(id);if(to&&from!==to&&!paths.has(from))Object.defineProperty(proposed,from,{value:to,enumerable:true,configurable:true});}
 const fileMap=new Map(),duplicateFiles=new Set();
 for(const file of Array.isArray(files)?files:[]){if(!file||typeof file.id!=='string'||!relative(file.rel))continue;if(fileMap.has(file.id))duplicateFiles.add(file.id);else fileMap.set(file.id,file);}
 const keyedPaths=[...paths].map(rel=>({rel,keys:businessKeys(rel)}));
 for(const from of directoryScopes(state)){
  if(paths.has(from)||matchMapping(from,order(proposed)))continue;
  // Fallback is only for first adoption, when this old path has no recorded ID.
  if([...previous.values()].includes(from))continue;
  const keys=businessKeys(from);if(!keys.length)continue;
  const candidates=keyedPaths.filter(item=>item.keys.some(key=>keys.includes(key)));
  if(candidates.length!==1)continue;
  const ids=referencedIds(state,from);if(!ids.size||[...ids].some(id=>duplicateFiles.has(id)))continue;
  const known=[...ids].map(id=>fileMap.get(id)).filter(Boolean),to=candidates[0].rel;
  if(!known.length||known.some(file=>!within(file.rel,to)))continue;
  Object.defineProperty(proposed,from,{value:to,enumerable:true,configurable:true});
 }
 const result=applyDirectoryAliases(state,proposed,directoryIdentities);
 const latest=(Array.isArray(directoryIdentities)?directoryIdentities:[]).filter(item=>item&&typeof item.id==='string'&&item.id&&relative(item.rel)).map(({id,rel})=>({id,rel})).sort((a,b)=>a.rel.localeCompare(b.rel)||a.id.localeCompare(b.id));
 if(JSON.stringify(state.directoryIdentities)!==JSON.stringify(latest)){state.directoryIdentities=latest;result.changed=true;}
 return result;
}

module.exports={reconcileDirectoryLinks,applyDirectoryAliases};
