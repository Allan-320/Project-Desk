const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const {execFile}=require('node:child_process');
function createThumbnails({dataDir,python}){
 const cache=path.join(dataDir,'thumbnails'),jobs=new Map(),queue=[],children=new Set();let running=0,stopped=false,closing;
 const stoppedError=()=>Object.assign(new Error('Thumbnail service stopped'),{status:503});
 function pump(){while(!stopped&&running<2&&queue.length){const job=queue.shift();running++;job.run().then(job.resolve,job.reject).finally(()=>{running--;pump();});}}
 function schedule(fn){if(stopped)throw stoppedError();if(queue.length>=100)throw new Error('thumbnail queue full');return new Promise((resolve,reject)=>{queue.push({run:fn,resolve,reject});pump();});}
 function run(args){if(stopped)return Promise.reject(stoppedError());return new Promise((resolve,reject)=>{const child=execFile(python,args,{windowsHide:true,timeout:20000,maxBuffer:200000},(error,stdout)=>{children.delete(child);if(error)reject(error);else resolve(stdout);});children.add(child);});}
 async function get(file){
  if(stopped)throw stoppedError();
  if(!python)throw new Error('No thumbnail runtime');
  const stat=await fs.stat(file.actual),key=crypto.createHash('sha256').update(file.actual+stat.mtimeMs+':'+stat.size).digest('hex').slice(0,32),target=path.join(cache,key+'.jpg');
  try{return await fs.readFile(target);}catch(e){if(e.code!=='ENOENT')throw e;}
  if(!jobs.has(key)){
   const promise=schedule(async()=>{await fs.mkdir(cache,{recursive:true});const tmp=target+'.'+crypto.randomUUID()+'.tmp';try{await run([path.join(__dirname,'thumbnail.py'),file.actual,tmp]);if(stopped)throw stoppedError();await fs.rename(tmp,target);return await fs.readFile(target);}finally{await fs.unlink(tmp).catch(()=>{});}});
   jobs.set(key,promise);promise.finally(()=>jobs.delete(key)).catch(()=>{});
  }
  return jobs.get(key);
 }
 function close(){if(closing)return closing;stopped=true;for(const job of queue.splice(0))job.reject(stoppedError());for(const child of children)child.kill('SIGKILL');closing=Promise.allSettled([...jobs.values()]).then(()=>{});return closing;}
 return {get,close};
}
module.exports={createThumbnails};
