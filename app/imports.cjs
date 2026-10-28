const fs=require('node:fs');
const fsp=fs.promises;
const path=require('node:path');
const crypto=require('node:crypto');
const {Transform}=require('node:stream');
const {pipeline}=require('node:stream/promises');
function validName(name){return typeof name==='string'&&name.length>0&&name.length<=180&&!name.startsWith('.project-desk-import-')&&!/[\\/:*?"<>|\x00-\x1f]/.test(name)&&!/[. ]$/.test(name)&&!/^\.{1,2}$/.test(name)&&!/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(name);}
async function saveIncoming(req,{root,rel,name,dataDir,maxBytes=1073741824,lastModified}){
 if(!validName(name))throw Object.assign(new Error('文件名含有不支持的字符或过长'),{status:400});
 const inside=file=>{const r=path.relative(root,file);return r===''||(!r.startsWith('..'+path.sep)&&r!=='..'&&!path.isAbsolute(r));};
 const target=await fsp.realpath(path.join(root,...rel.split('/')));if(!inside(target))throw Object.assign(new Error('保存位置超出接入目录'),{status:403});
 if(!(await fsp.stat(target)).isDirectory())throw Object.assign(new Error('目标不是文件夹'),{status:400});
 const expected=req.headers['content-length']===undefined?null:Number(req.headers['content-length']);
 if(expected!==null&&(!Number.isSafeInteger(expected)||expected<0||expected>maxBytes))throw Object.assign(new Error('单个文件最多支持 1 GB'),{status:413});
 const stagingDir=path.join(dataDir,'incoming');await fsp.mkdir(stagingDir,{recursive:true});const uid=crypto.randomUUID();const staging=path.join(stagingDir,uid+'.part'),localTemp=path.join(target,'.project-desk-import-'+uid+'.part');
 let received=0,finalPath=null;
 try{
  const limit=new Transform({transform(chunk,encoding,callback){received+=chunk.length;if(received>maxBytes)callback(Object.assign(new Error('文件超过大小限制'),{status:413}));else callback(null,chunk);}});
  await pipeline(req,limit,fs.createWriteStream(staging,{flags:'wx'}));
  if(expected!==null&&received!==expected)throw Object.assign(new Error('文件传输不完整，没有保存'),{status:400});
  const current=await fsp.realpath(target);if(!inside(current)||current.toLowerCase()!==target.toLowerCase())throw Object.assign(new Error('目标目录发生变化，请重新选择'),{status:403});
  await fsp.copyFile(staging,localTemp,fs.constants.COPYFILE_EXCL);
  const ext=path.extname(name),stem=ext?name.slice(0,-ext.length):name;
  for(let n=0;n<1000;n++){
   const candidate=path.join(target,n?`${stem} (${n+1})${ext}`:name);
   try{await fsp.link(localTemp,candidate);finalPath=candidate;break;}catch(e){if(e.code==='EEXIST')continue;throw e;}
  }
  if(!finalPath)throw new Error('同名文件过多，请换一个文件名');
  const modified=Number(lastModified);if(Number.isFinite(modified)&&modified>0&&modified<Date.now()+86400000){try{await fsp.utimes(finalPath,new Date(),new Date(modified));}catch{}}
  return {ok:true,name:path.basename(finalPath),rel:path.relative(root,finalPath).split(path.sep).join('/'),size:received,renamed:path.basename(finalPath)!==name};
 }finally{await fsp.unlink(staging).catch(()=>{});await fsp.unlink(localTemp).catch(()=>{});}
}
module.exports={saveIncoming,validName};
