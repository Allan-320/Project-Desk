'use strict';
// The document is rendered inside a script-free frame, isolated from app styles.
let wordPreviewContext=null,wordPreviewLibraries=null;
function wordElement(tag,className,text){const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node;}
function wordCurrent(context){return !context.disposed&&wordPreviewContext===context&&context.host.isConnected;}
function wordNotify(message){if(typeof toast==='function')toast(message);}
function wordLoadScript(src,ready){if(ready())return Promise.resolve();return new Promise((resolve,reject)=>{const script=document.createElement('script');script.src=src;script.async=true;script.onload=()=>ready()?resolve():reject(new Error('文档预览组件未能加载'));script.onerror=()=>{script.remove();reject(new Error('文档预览组件读取失败'));};document.head.append(script);});}
function wordLoadLibraries(){if(!wordPreviewLibraries)wordPreviewLibraries=wordLoadScript('/vendor/jszip.min.js',()=>Boolean(window.JSZip)).then(()=>wordLoadScript('/vendor/docx-preview.min.js',()=>Boolean(window.docx?.renderAsync))).catch(error=>{wordPreviewLibraries=null;throw error;});return wordPreviewLibraries;}

function disposeWordPreview(){
 const context=wordPreviewContext;if(!context)return;
 context.disposed=true;context.controller.abort();context.observer?.disconnect();context.selection='';
 if(context.frameDocument){context.frameDocument.removeEventListener('selectionchange',context.selectionListener);context.frameDocument.removeEventListener('click',context.preventLink,true);}
 context.frame?.remove();context.frameDocument=null;context.wrapper=null;context.rendered=null;
 context.host.classList.remove('word-host');context.dialog?.classList.remove('word-active','word-notes-open');wordPreviewContext=null;
}

function wordWaitFrame(context){
 return new Promise((resolve,reject)=>{
  const cleanup=()=>{clearTimeout(timer);context.frame.removeEventListener('load',loaded);context.controller.signal.removeEventListener('abort',aborted);};
  const loaded=()=>{cleanup();if(!wordCurrent(context))return reject(new DOMException('Closed','AbortError'));const doc=context.frame.contentDocument;if(!doc?.body)return reject(new Error('文档窗口无法读取'));resolve(doc);};
  const aborted=()=>{cleanup();reject(new DOMException('Closed','AbortError'));};
  const timer=setTimeout(()=>{cleanup();reject(new Error('文档窗口加载超时'));},15000);
  context.frame.addEventListener('load',loaded,{once:true});context.controller.signal.addEventListener('abort',aborted,{once:true});context.frame.src='/word-preview-frame';
 });
}

async function renderWordPreview(host,fileId){
 disposeWordPreview();
 const context={host,fileId,dialog:host.closest('#file-dialog'),controller:new AbortController(),zoom:'fit',selection:'',disposed:false};wordPreviewContext=context;
 host.classList.add('word-host');context.dialog?.classList.add('word-active');host.replaceChildren();
 const root=wordElement('section','word-preview');root.setAttribute('aria-label','Word 文档预览');host.append(root);context.root=root;
 const toolbar=wordElement('div','word-toolbar');root.append(toolbar);
 const zoomLabel=wordElement('label','word-zoom-label','缩放'),zoom=wordElement('select','word-zoom');zoom.setAttribute('aria-label','文档缩放');
 for(const [value,label] of [['fit','适合宽度'],['0.5','50%'],['0.75','75%'],['1','100%'],['1.25','125%'],['1.5','150%']]){const option=wordElement('option','',label);option.value=value;zoom.append(option);}zoom.value='fit';zoom.disabled=true;zoomLabel.append(zoom);toolbar.append(zoomLabel);context.zoomSelect=zoom;
 const status=wordElement('span','word-status','正在读取文档…');status.setAttribute('role','status');toolbar.append(status);context.status=status;
 const capture=wordElement('button','word-capture primary','记入笔记');capture.type='button';capture.disabled=true;capture.title='选中文字后记入笔记';toolbar.append(capture);context.capture=capture;
 if(context.dialog){const notes=wordElement('button','word-annotations-toggle','备注');notes.type='button';notes.setAttribute('aria-expanded','false');notes.title='展开文件标签与备注';toolbar.append(notes);notes.addEventListener('click',()=>{const open=context.dialog.classList.toggle('word-notes-open');notes.setAttribute('aria-expanded',String(open));notes.textContent=open?'收起备注':'备注';});}
 const viewport=wordElement('div','word-viewport');root.append(viewport);context.viewport=viewport;
 zoom.addEventListener('change',()=>{context.zoom=zoom.value==='fit'?'fit':Number(zoom.value);wordApplyZoom(context);});
 capture.addEventListener('pointerdown',()=>wordReadSelection(context));capture.addEventListener('click',()=>{const excerpt=getWordPreviewCapture();if(excerpt?.error)return wordNotify(excerpt.error);if(excerpt&&typeof openNoteCapture==='function')openNoteCapture(fileId,excerpt);});
 context.observer=new ResizeObserver(()=>wordApplyZoom(context));context.observer.observe(viewport);
 try{
  const response=await fetch('/api/office/'+encodeURIComponent(fileId)+'?layout=1',{signal:context.controller.signal}),info=await response.json();if(!response.ok)throw new Error(info.error||'文档无法读取');if(info.kind!=='docx-layout')throw new Error('文档预览服务需要更新，请重新启动资料台');if(!wordCurrent(context))return;
  const [fileResponse]=await Promise.all([fetch('/file/'+encodeURIComponent(fileId),{signal:context.controller.signal}),wordLoadLibraries()]);if(!fileResponse.ok)throw new Error('文档文件无法读取');
  const buffer=await fileResponse.arrayBuffer();if(!wordCurrent(context))return;
  const frame=wordElement('iframe','word-document-frame');frame.title='Word 文档内容';frame.setAttribute('sandbox','allow-same-origin');frame.setAttribute('referrerpolicy','no-referrer');context.frame=frame;const frameReady=wordWaitFrame(context);viewport.append(frame);const frameDocument=await frameReady;context.frameDocument=frameDocument;if(!wordCurrent(context))return;
  const styles=frameDocument.createElement('style');styles.textContent='html{margin:0;background:#edf0f5;color:#111;color-scheme:light}body{margin:0;overflow:auto}body .docx-wrapper{padding:16px;background:#edf0f5;box-sizing:border-box;align-items:center;min-width:100%}body section.docx{height:auto!important;overflow:visible!important;flex-shrink:0;box-shadow:0 2px 10px #18263814;margin-bottom:16px}body section.docx:last-child{margin-bottom:0}body section.docx article{overflow:visible}a{color:inherit;text-decoration:none;cursor:text}::selection{background:#b7c8fb}';
  await window.docx.renderAsync(buffer,frameDocument.body,frameDocument.head,{className:'docx',inWrapper:true,ignoreWidth:false,ignoreHeight:false,ignoreFonts:true,breakPages:true,ignoreLastRenderedPageBreak:false,experimental:false,useBase64URL:true,renderChanges:false,renderHeaders:true,renderFooters:true,renderFootnotes:true,renderEndnotes:true,renderComments:false,renderAltChunks:false,debug:false});
  if(!wordCurrent(context)){frame.remove();return;}frameDocument.head.append(styles);wordApplyLayoutHints(frameDocument,info.layoutHints);await wordApplyImageFallbacks(frameDocument,info.imageFallbacks);if(!wordCurrent(context)){frame.remove();return;}
  for(const anchor of frameDocument.querySelectorAll('a')){anchor.removeAttribute('href');anchor.removeAttribute('target');}
  context.preventLink=event=>{if(event.target.closest?.('a'))event.preventDefault();};frameDocument.addEventListener('click',context.preventLink,true);
  context.wrapper=frameDocument.body.querySelector('.docx-wrapper')||frameDocument.body;context.sections=[...frameDocument.querySelectorAll('section.docx')];
  context.pageWidth=Math.max(1,...context.sections.map(section=>parseFloat(frame.contentWindow.getComputedStyle(section).width)||section.getBoundingClientRect().width));
  context.selectionListener=()=>wordReadSelection(context);frameDocument.addEventListener('selectionchange',context.selectionListener);
  context.status.textContent='选择文字可记入笔记';zoom.disabled=false;frame.classList.add('is-ready');root.dataset.ready='true';wordApplyZoom(context);
 }catch(error){if(!wordCurrent(context)||error.name==='AbortError')return;context.frame?.remove();context.frameDocument=null;context.wrapper=null;context.status.textContent='预览未完成';const errorBox=wordElement('div','word-preview-error');errorBox.setAttribute('role','alert');errorBox.append(wordElement('p','',error.message||'无法生成文档预览'));const retry=wordElement('button','','重试');retry.type='button';retry.addEventListener('click',()=>renderWordPreview(host,fileId));errorBox.append(retry);viewport.replaceChildren(errorBox);}
}

function wordApplyZoom(context){
 if(!wordCurrent(context)||!context.wrapper||!context.pageWidth)return;
 const available=context.frame.clientWidth-20,fit=Math.min(1,Math.max(.25,available/(context.pageWidth+32))),zoom=context.zoom==='fit'?fit:context.zoom;
 context.wrapper.style.zoom=String(zoom);context.wrapper.style.width=Math.max(context.pageWidth+32,available/zoom)+'px';context.root.dataset.zoom=String(zoom);context.zoomSelect.title=context.zoom==='fit'?'适合宽度 · '+Math.round(zoom*100)+'%':'文档比例';
}
function wordReadSelection(context){
 if(!wordCurrent(context)||!context.frameDocument)return;
 const selection=context.frame.contentWindow.getSelection();if(selection&&!selection.isCollapsed&&context.frameDocument.body.contains(selection.anchorNode)&&context.frameDocument.body.contains(selection.focusNode))context.selection=selection.toString().trim();
 else if(context.frameDocument.hasFocus())context.selection='';
 context.capture.disabled=!context.selection;context.status.textContent=context.selection?'已选 '+context.selection.length+' 字':'选择文字可记入笔记';
}
function getWordPreviewCapture(){
 const context=wordPreviewContext;if(!context||!wordCurrent(context))return null;wordReadSelection(context);if(!context.selection)return null;
 if(context.selection.length>5000)return {error:'所选文字超过 5000 字，请分段记入笔记。'};
 return {excerpt:context.selection,locator:'文档选段'};
}
