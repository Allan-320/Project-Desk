'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
const base=path.dirname(__dirname),runtimeFile=path.join(base,'data','service.json');
(async()=>{
 const settings=JSON.parse(await fs.readFile(path.join(base,'settings.json'),'utf8'));
 const workspace=settings.workspaces.find(w=>w.id===settings.activeWorkspace);
 if(!workspace)throw new Error('请先选择资料目录');
 const root=workspace.relative?path.resolve(base,workspace.root):workspace.root;
 const {start}=require('./server.cjs');
 const app=await start({root,port:0,stateKey:workspace.id,instanceId:settings.installationId,launcherPath:path.join(base,'启动项目资料台.cmd'),dataDir:path.join(base,'data','workspaces',workspace.id),python:path.join(base,'runtime','python','python.exe')});
 const marker={pid:process.pid,url:app.url,instanceId:settings.installationId,workspaceId:workspace.id};
 await fs.writeFile(runtimeFile,JSON.stringify(marker),'utf8');
 console.log(JSON.stringify({url:app.url,pid:process.pid}));
 const stop=()=>app.close().catch(e=>{console.error(e.message);process.exitCode=1;});
 process.once('SIGINT',stop);process.once('SIGTERM',stop);
 await app.closed;
 try{const saved=JSON.parse(await fs.readFile(runtimeFile,'utf8'));if(saved.pid===process.pid)await fs.unlink(runtimeFile);}catch(e){if(e.code!=='ENOENT')console.error(e.message);}
})().catch(e=>{console.error(e.message);process.exitCode=1;});
