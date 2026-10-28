'use strict';
// Workbook layout is read-only. Captures live only in the separate notes store.
let spreadsheetPreviewContext = null;
const sheetNumber = (value, fallback, min, max) => Number.isFinite(Number(value)) ? Math.max(min, Math.min(max, Number(value))) : fallback;
const sheetColumnName = value => { let label=''; for(let n=value;n>0;n=Math.floor((n-1)/26))label=String.fromCharCode(65+(n-1)%26)+label; return label; };
const sheetRefParts = ref => {const match=/^([A-Z]+)(\d+)$/i.exec(String(ref||''));if(!match)return null;return {row:Number(match[2]),column:[...match[1].toUpperCase()].reduce((v,c)=>v*26+c.charCodeAt(0)-64,0)};};
const sheetColor = value => typeof value==='string'&&/^#[\da-f]{6}(?:[\da-f]{2})?$/i.test(value)?value:null;
function sheetElement(tag,className,text){const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node;}
function sheetNotify(message){if(typeof toast==='function')toast(message);}

function disposeSpreadsheetPreview(){
 const context=spreadsheetPreviewContext;if(!context)return;
 context.disposed=true;context.controller?.abort();context.observer?.disconnect();context.touchCleanup?.();
 document.removeEventListener('pointerup',context.endDrag);document.removeEventListener('pointercancel',context.endDrag);
 context.dialog?.classList.remove('spreadsheet-active','spreadsheet-notes-open');
 context.host.classList.remove('spreadsheet-host');spreadsheetPreviewContext=null;
}

function renderSpreadsheetPreview(result,host,fileId){
 disposeSpreadsheetPreview();
 const sheets=Array.isArray(result.sheets)?result.sheets:[];
 const names=Array.isArray(result.sheetNames)&&result.sheetNames.length?result.sheetNames:sheets.map((sheet,index)=>({index:sheet.index??index,name:sheet.name,hidden:false}));
 const context={fileId,host,dialog:host.closest('#file-dialog'),names,cache:new Map(),selected:new Map(),activeSheet:result.activeSheet??sheets[0]?.index??0,zoom:'fit',multi:false,anchor:null,disposed:false,requestId:0};
 for(const [index,sheet] of sheets.entries())context.cache.set(sheet.index??index,{...sheet,index:sheet.index??index});
 spreadsheetPreviewContext=context;host.classList.add('spreadsheet-host');context.dialog?.classList.add('spreadsheet-active');
 host.replaceChildren();const root=sheetElement('section','sheet-preview');root.setAttribute('aria-label','表格预览');host.append(root);context.root=root;
 const toolbar=sheetElement('div','sheet-toolbar');root.append(toolbar);
 const zoomLabel=sheetElement('label','sheet-zoom-label','缩放');const zoom=sheetElement('select','sheet-zoom');zoom.setAttribute('aria-label','表格缩放');
 for(const [value,label] of [['0.5','50%'],['0.75','75%'],['1','100%'],['1.25','125%'],['1.5','150%'],['fit','适合宽度']]){const option=sheetElement('option','',label);option.value=value;zoom.append(option);}zoom.value='fit';zoomLabel.append(zoom);toolbar.append(zoomLabel);context.zoomSelect=zoom;
 const multi=sheetElement('button','sheet-multi','多选');multi.type='button';multi.setAttribute('aria-pressed','false');multi.title='开启后逐个点击可累加；也可按 Ctrl / ⌘ 多选，Shift 连选或鼠标拖选';toolbar.append(multi);
 const count=sheetElement('span','sheet-selection-count','点击或拖选单元格');count.setAttribute('role','status');toolbar.append(count);context.count=count;
 const clear=sheetElement('button','sheet-clear','清空');clear.type='button';clear.hidden=true;toolbar.append(clear);context.clear=clear;
 const capture=sheetElement('button','sheet-capture primary','记入笔记');capture.type='button';capture.disabled=true;toolbar.append(capture);context.capture=capture;
 if(context.dialog){const notes=sheetElement('button','sheet-annotations-toggle','备注');notes.type='button';notes.setAttribute('aria-expanded','false');notes.title='展开文件标签与备注';toolbar.append(notes);notes.addEventListener('click',()=>{const open=context.dialog.classList.toggle('spreadsheet-notes-open');notes.setAttribute('aria-expanded',String(open));notes.textContent=open?'收起备注':'备注';});}
 const formula=sheetElement('div','sheet-formula');const ref=sheetElement('span','sheet-formula-ref','—'),value=sheetElement('span','sheet-formula-value','');formula.append(ref,value);root.append(formula);context.formulaRef=ref;context.formulaValue=value;
 const viewport=sheetElement('div','sheet-scroll');viewport.tabIndex=0;viewport.setAttribute('aria-label','工作表，可横向滚动');root.append(viewport);context.viewport=viewport;
 const tabs=sheetElement('div','sheet-tabs');tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label','工作表');root.append(tabs);context.tabs=tabs;
 const notice=sheetElement('div','sheet-notice');notice.hidden=true;notice.setAttribute('role','status');root.append(notice);context.notice=notice;
 zoom.addEventListener('change',()=>{context.zoom=zoom.value==='fit'?'fit':Number(zoom.value);sheetApplyZoom(context);});
 multi.addEventListener('click',()=>{context.multi=!context.multi;multi.setAttribute('aria-pressed',String(context.multi));});
 clear.addEventListener('click',()=>{context.selected.clear();context.anchor=null;sheetRefreshSelection(context);});
 capture.addEventListener('click',()=>{const selection=getSpreadsheetCapture();if(selection?.error)return sheetNotify(selection.error);if(selection&&typeof openNoteCapture==='function')openNoteCapture(context.fileId,selection);});
 context.endDrag=()=>{if(!context.drag)return;context.drag=null;context.root.classList.remove('is-selecting');};
 document.addEventListener('pointerup',context.endDrag);document.addEventListener('pointercancel',context.endDrag);
 viewport.addEventListener('pointerdown',event=>sheetPointerDown(context,event));
 viewport.addEventListener('pointermove',event=>sheetPointerMove(context,event));
 viewport.addEventListener('keydown',event=>sheetKeyDown(context,event));
 context.observer=new ResizeObserver(()=>{if(context.zoom==='fit')sheetApplyZoom(context);});context.observer.observe(viewport);
 sheetRenderTabs(context);sheetShowCurrent(context);return root;
}

function sheetRenderTabs(context){
 context.tabs.replaceChildren();
 for(const info of context.names){if(info.hidden&&info.index!==context.activeSheet)continue;const button=sheetElement('button','sheet-tab',info.name||'工作表 '+(info.index+1));button.type='button';button.setAttribute('role','tab');button.setAttribute('aria-selected',String(info.index===context.activeSheet));button.dataset.sheetIndex=String(info.index);button.addEventListener('click',()=>sheetSwitch(context,info.index));context.tabs.append(button);}
}

async function sheetSwitch(context,index){
 if(context.disposed||index===context.activeSheet)return;
 context.controller?.abort();context.touchCleanup?.();context.activeSheet=index;context.anchor=null;context.drag=null;sheetRenderTabs(context);
 if(context.cache.has(index)){sheetShowCurrent(context);return;}
 context.viewport.replaceChildren(sheetElement('p','sheet-loading','正在读取工作表…'));context.viewport.setAttribute('aria-busy','true');const requestId=++context.requestId;context.controller=new AbortController();
 try{const response=await fetch('/api/office/'+encodeURIComponent(context.fileId)+'?sheet='+index,{signal:context.controller.signal});const result=await response.json();if(!response.ok)throw new Error(result.error||'工作表读取失败');if(context.disposed||requestId!==context.requestId||index!==context.activeSheet)return;for(const sheet of result.sheets||[])context.cache.set(sheet.index??index,{...sheet,index:sheet.index??index});if(!context.cache.has(index))throw new Error('未能读取这张工作表');sheetShowCurrent(context);}
 catch(error){if(error.name==='AbortError'||context.disposed||requestId!==context.requestId||index!==context.activeSheet)return;context.viewport.replaceChildren(sheetElement('p','sheet-loading',error.message||'工作表读取失败'));const retry=sheetElement('button','','重试');retry.type='button';retry.addEventListener('click',()=>{context.activeSheet=-1;sheetSwitch(context,index);});context.viewport.append(retry);}
 finally{if(!context.disposed&&requestId===context.requestId&&index===context.activeSheet)context.viewport.removeAttribute('aria-busy');}
}

function sheetApplyCellStyle(content,style){
 const font=style?.font||{},alignment=style?.alignment||{};
 content.style.fontSize=sheetNumber(font.size,14.67,8,96)+'px';
 if(typeof font.name==='string'&&/^[\p{L}\p{N} ,_-]{1,100}$/u.test(font.name))content.style.fontFamily=font.name+', sans-serif';
 content.style.fontWeight=font.bold?'700':'400';content.style.fontStyle=font.italic?'italic':'normal';
 if(sheetColor(font.color))content.style.color=font.color;
 if(sheetColor(style?.fill))content.parentElement.style.backgroundColor=style.fill;
 content.style.textAlign=({center:'center',right:'right',left:'left',justify:'justify'}[alignment.horizontal]||'left');
 content.parentElement.style.verticalAlign=({top:'top',center:'middle',bottom:'bottom'}[alignment.vertical]||'middle');
 content.style.whiteSpace=alignment.wrapText?'pre-wrap':'pre';
 // Explicit Excel vertical text remains vertical; ordinary narrow cells never break every character.
 if(alignment.textRotation===255){content.style.writingMode='vertical-rl';content.style.textOrientation='upright';}
}

function sheetShowCurrent(context){
 const sheet=context.cache.get(context.activeSheet);context.sheet=sheet;context.cells=new Map();context.elements=new Map();context.bounds=new Map();context.drag=null;
 if(!sheet){context.viewport.replaceChildren(sheetElement('p','sheet-loading','没有可预览的工作表'));return;}
 const startRow=Math.max(1,Number(sheet.range?.startRow)||1),startCol=Math.max(1,Number(sheet.range?.startCol)||1);
 const endRow=Math.min(startRow+499,Number(sheet.range?.endRow)||Number(sheet.maxRow)||Math.max(1,...(sheet.rows||[]).flatMap(row=>row.map(cell=>sheetRefParts(cell.ref)?.row||1))));
 const endCol=Math.min(startCol+99,Number(sheet.range?.endCol)||Number(sheet.maxCol)||Math.max(1,...(sheet.rows||[]).flatMap(row=>row.map(cell=>sheetRefParts(cell.ref)?.column||1))));
 const hiddenRows=new Set(sheet.hiddenRows||[]),columns=new Map((sheet.columns||[]).map(column=>[Number(column.index),column]));
 const visibleCols=[],visibleRows=[];for(let col=startCol;col<=endCol;col++)if(!columns.get(col)?.hidden)visibleCols.push(col);for(let row=startRow;row<=endRow;row++)if(!hiddenRows.has(row))visibleRows.push(row);
 const widths=new Map(visibleCols.map(col=>[col,sheetNumber(columns.get(col)?.width,sheetNumber(sheet.defaultColumnWidth,90,12,1500),12,1500)]));
 const heights=new Map(visibleRows.map(row=>[row,sheetNumber(sheet.rowHeights?.[row],sheetNumber(sheet.defaultRowHeight,24,12,800),12,800)]));
 for(const row of sheet.rows||[])for(const raw of row){const position=sheetRefParts(raw.ref)||{row:raw.row,column:raw.column};if(position.row<startRow||position.row>endRow||position.column<startCol||position.column>endCol)continue;const cell={...raw,row:position.row,column:position.column,ref:sheetColumnName(position.column)+position.row,value:String(raw.value??''),sheetIndex:context.activeSheet,sheetName:sheet.name};context.cells.set(cell.row+':'+cell.column,cell);}
 const covered=new Set(),merges=new Map();
 for(const merge of sheet.merges||[]){const rows=visibleRows.filter(row=>row>=merge.startRow&&row<=merge.endRow),cols=visibleCols.filter(col=>col>=merge.startCol&&col<=merge.endCol);if(!rows.length||!cols.length)continue;const key=rows[0]+':'+cols[0];merges.set(key,{...merge,rows,cols});for(const row of rows)for(const col of cols)if(row+':'+col!==key)covered.add(row+':'+col);}
 const table=sheetElement('table','sheet-table');table.setAttribute('aria-label',sheet.name||'工作表');context.table=table;const totalWidth=46+visibleCols.reduce((sum,col)=>sum+widths.get(col),0);context.totalWidth=totalWidth;table.style.width=totalWidth+'px';table.style.minWidth=totalWidth+'px';
 const colgroup=document.createElement('colgroup'),rowHeadCol=document.createElement('col');rowHeadCol.style.width='46px';colgroup.append(rowHeadCol);for(const col of visibleCols){const el=document.createElement('col');el.style.width=widths.get(col)+'px';colgroup.append(el);}table.append(colgroup);
 const head=document.createElement('thead'),headrow=document.createElement('tr');headrow.append(sheetElement('th','sheet-corner',''));for(const col of visibleCols){const el=sheetElement('th','sheet-column-heading',sheetColumnName(col));el.scope='col';headrow.append(el);}head.append(headrow);table.append(head);
 const body=document.createElement('tbody');table.append(body);
 for(const row of visibleRows){const tr=document.createElement('tr');tr.style.height=heights.get(row)+'px';const rowHeading=sheetElement('th','sheet-row-heading',String(row));rowHeading.scope='row';tr.append(rowHeading);
  for(const col of visibleCols){const key=row+':'+col;if(covered.has(key))continue;const merge=merges.get(key),cell=(merge&&context.cells.get(merge.startRow+':'+merge.startCol))||context.cells.get(key)||{row,column:col,ref:sheetColumnName(col)+row,value:'',sheetIndex:context.activeSheet,sheetName:sheet.name};const td=sheetElement('td','sheet-cell');td.dataset.ref=cell.ref;td.dataset.row=String(row);td.dataset.col=String(col);td.tabIndex=context.elements.size?-1:0;td.setAttribute('aria-selected','false');td.setAttribute('aria-label',cell.ref+' '+cell.value);const height=merge?merge.rows.reduce((sum,r)=>sum+heights.get(r),0):heights.get(row);td.style.height=height+'px';if(merge){td.rowSpan=merge.rows.length;td.colSpan=merge.cols.length;}
   const content=sheetElement('div','sheet-cell-content',cell.value);content.style.maxHeight=Math.max(1,height-2)+'px';td.append(content);sheetApplyCellStyle(content,sheet.styles?.[cell.styleId]||cell.style);td.title=cell.ref+(cell.value?' · '+cell.value:'');tr.append(td);context.elements.set(key,td);context.cells.set(key,cell);context.bounds.set(key,{startRow:merge?.startRow??row,endRow:merge?.endRow??row,startCol:merge?.startCol??col,endCol:merge?.endCol??col});
  }body.append(tr);
 }
 context.viewport.replaceChildren(table);context.viewport.scrollLeft=0;context.viewport.scrollTop=0;context.viewport.removeAttribute('aria-busy');
 const truncation=sheet.truncated?'仅预览 '+sheetColumnName(startCol)+startRow+'–'+sheetColumnName(endCol)+endRow+(sheet.truncation?.cellText?' · 部分长文本已省略':'')+'，其余内容请打开原文件':'';
 context.notice.textContent=truncation;context.notice.hidden=!truncation;
 sheetApplyZoom(context);sheetRefreshSelection(context);context.formulaRef.textContent='—';context.formulaValue.textContent='';
}

function sheetApplyZoom(context){
 if(!context.table)return;const fit=Math.min(1,Math.max(.5,(context.viewport.clientWidth-2)/context.totalWidth)),zoom=context.zoom==='fit'?fit:context.zoom;context.table.style.zoom=String(zoom);context.root.dataset.zoom=String(zoom);context.zoomSelect.title=context.zoom==='fit'?'适合宽度 · '+Math.round(zoom*100)+'%（最低 50%，保留横向滚动）':'原表比例';
}

function sheetKey(context,cell){return cell.sheetIndex+':'+cell.ref;}
function sheetSetRange(context,from,to,base){
 context.selected=new Map(base);const minRow=Math.min(from.row,to.row),maxRow=Math.max(from.row,to.row),minCol=Math.min(from.column,to.column),maxCol=Math.max(from.column,to.column);
 for(const [key,bounds] of context.bounds){if(bounds.endRow<minRow||bounds.startRow>maxRow||bounds.endCol<minCol||bounds.startCol>maxCol)continue;const cell=context.cells.get(key);if(cell.value.trim())context.selected.set(sheetKey(context,cell),cell);}
 sheetRefreshSelection(context);
}
function sheetPointerDown(context,event){
 const td=event.target.closest('.sheet-cell');if(!td||!context.viewport.contains(td)||event.button!==0)return;
 // Touch keeps native horizontal/vertical scrolling; tap selection is handled on pointerup.
 if(event.pointerType==='touch'){context.touchCleanup?.();const start={x:event.clientX,y:event.clientY,sheet:context.activeSheet,pointer:event.pointerId};const cleanup=()=>{context.viewport.removeEventListener('pointerup',tap);context.viewport.removeEventListener('pointercancel',cleanup);context.touchCleanup=null;};const tap=up=>{cleanup();if(context.disposed||!td.isConnected||context.activeSheet!==start.sheet||up.pointerId!==start.pointer||Math.abs(up.clientX-start.x)>8||Math.abs(up.clientY-start.y)>8)return;sheetClickCell(context,td,event);};context.touchCleanup=cleanup;context.viewport.addEventListener('pointerup',tap,{once:true});context.viewport.addEventListener('pointercancel',cleanup,{once:true});return;}
 event.preventDefault();sheetClickCell(context,td,event);td.focus({preventScroll:true});
 const cell=context.cells.get(td.dataset.row+':'+td.dataset.col),additive=event.ctrlKey||event.metaKey||context.multi;
 context.drag={start:event.shiftKey&&context.anchor?context.anchor:cell,base:additive?new Map(context.selected):new Map([...context.selected].filter(([,item])=>item.sheetIndex!==context.activeSheet)),origin:cell,moved:false};context.root.classList.add('is-selecting');
}
function sheetClickCell(context,td,event){
 const cell=context.cells.get(td.dataset.row+':'+td.dataset.col);if(!cell)return;const key=sheetKey(context,cell),additive=event.ctrlKey||event.metaKey||context.multi;
 const otherSheets=new Map([...context.selected].filter(([,item])=>item.sheetIndex!==context.activeSheet));
 if(event.shiftKey&&context.anchor){sheetSetRange(context,context.anchor,cell,additive?context.selected:otherSheets);}
 else{if(!additive)context.selected=otherSheets;if(cell.value.trim()){if(additive&&context.selected.has(key))context.selected.delete(key);else context.selected.set(key,cell);}context.anchor=cell;sheetRefreshSelection(context);}
 context.formulaRef.textContent=cell.ref;context.formulaValue.textContent=cell.value;context.formulaValue.title=cell.value;
}
function sheetPointerMove(context,event){
 if(!context.drag||context.disposed)return;const td=event.target.closest('.sheet-cell');if(!td||!context.viewport.contains(td))return;const cell=context.cells.get(td.dataset.row+':'+td.dataset.col);if(!cell||cell.ref===context.drag.origin.ref&&!context.drag.moved)return;context.drag.moved=true;sheetSetRange(context,context.drag.start,cell,context.drag.base);context.formulaRef.textContent=cell.ref;context.formulaValue.textContent=cell.value;
 const rect=context.viewport.getBoundingClientRect();if(event.clientX>rect.right-30)context.viewport.scrollLeft+=22;if(event.clientX<rect.left+46)context.viewport.scrollLeft-=22;if(event.clientY>rect.bottom-26)context.viewport.scrollTop+=18;if(event.clientY<rect.top+26)context.viewport.scrollTop-=18;
}
function sheetKeyDown(context,event){
 const td=event.target.closest('.sheet-cell');if(!td)return;
 if(event.key===' '||event.key==='Enter'){event.preventDefault();sheetClickCell(context,td,event);return;}
 const direction={ArrowLeft:[0,-1],ArrowRight:[0,1],ArrowUp:[-1,0],ArrowDown:[1,0]}[event.key];if(!direction)return;event.preventDefault();let row=Number(td.dataset.row),col=Number(td.dataset.col),next;
 for(let i=0;i<500&&!next;i++){row+=direction[0];col+=direction[1];if(row<1||col<1)break;next=context.elements.get(row+':'+col);}if(next){next.focus();sheetClickCell(context,next,event);}
}
function sheetRefreshSelection(context){
 for(const [key,element] of context.elements||[]){const cell=context.cells.get(key),selected=context.selected.has(sheetKey(context,cell));element.classList.toggle('is-selected',selected);element.setAttribute('aria-selected',String(selected));}
 const total=context.selected.size,sheets=new Set([...context.selected.values()].map(cell=>cell.sheetIndex)).size;
 context.count.textContent=total?'已选 '+total+' 个单元格'+(sheets>1?' · '+sheets+' 张表':''):'点击或拖选单元格';context.capture.disabled=!total;context.clear.hidden=!total;
}

function getSpreadsheetCapture(){
 const context=spreadsheetPreviewContext;if(!context||!context.selected.size)return null;
 const cells=[...context.selected.values()].sort((a,b)=>a.sheetIndex-b.sheetIndex||a.row-b.row||a.column-b.column),groups=new Map();
 if(cells.some(cell=>cell.truncated))return {error:'所选单元格含超长文本，预览未完整载入。请打开原文件后分段摘录。'};
 for(const cell of cells){const key=cell.sheetIndex+':'+cell.row;if(!groups.has(key))groups.set(key,{name:cell.sheetName,cells:[]});groups.get(key).cells.push(cell);}
 const excerpt=[...groups.values()].map(group=>group.name+' / '+group.cells.map(cell=>cell.ref+'：'+cell.value).join('；')).join('\n');
 const locations=new Map();for(const cell of cells){if(!locations.has(cell.sheetIndex))locations.set(cell.sheetIndex,{name:cell.sheetName,refs:[]});locations.get(cell.sheetIndex).refs.push(cell.ref);}
 const locator=[...locations.values()].map(group=>group.name+'!'+group.refs.join(', ')).join('；');
 if(excerpt.length>5000||locator.length>500)return {error:'所选内容较多，请分批记入笔记（每次最多 5000 字，单元格位置最多 500 字）。'};
 return {excerpt,locator};
}
