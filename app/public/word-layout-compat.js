'use strict';
// Corrections are applied to the temporary preview DOM; source DOCX is read-only.
function wordLayoutTextKey(text){
 const normalized=String(text||'').replace(/\s/g,'');let hash=2166136261;
 for(let i=0;i<normalized.length;i++)hash=Math.imul(hash^normalized.charCodeAt(i),16777619)>>>0;
 return hash.toString(16).padStart(8,'0')+':'+normalized.length;
}
function wordApplyLayoutHints(doc,hints){
 if(hints?.version!==1||!Array.isArray(hints.paragraphs))return;
 const groups=new Map();for(const hint of hints.paragraphs){if(!hint.key)continue;if(!groups.has(hint.key))groups.set(hint.key,[]);groups.get(hint.key).push(hint);}
 const usage=new Map(),view=doc.defaultView;let adjusted=0;
 for(const paragraph of doc.querySelectorAll('section.docx > article p')){
  const key=wordLayoutTextKey(paragraph.textContent),items=groups.get(key),at=usage.get(key)||0;if(!items||!items[at])continue;
  const hint=items[at];usage.set(key,at+1);let changed=false;
  if(Number.isFinite(hint.fontSizePx)&&hint.fontSizePx>=4&&hint.fontSizePx<=200){paragraph.style.fontSize=hint.fontSizePx+'px';changed=true;}
  let style=view.getComputedStyle(paragraph);
  // Only rescue a conflicting list indent when it consumes most of the usable
  // line, and the paragraph style supplies a smaller explicit indent. A direct
  // indent, a modest list indent, tables and intentional sidebar text stay intact.
  if(hint.numbered&&!hint.directIndent&&!paragraph.closest('td,th')&&Number.isFinite(hint.styleIndentPx)&&Number.isFinite(hint.numberIndentPx)){
   const left=parseFloat(style.marginInlineStart)||0,width=parseFloat(style.width)||paragraph.clientWidth;
   if(left>Math.max(160,width)&&hint.numberIndentPx>hint.styleIndentPx+120&&hint.styleIndentPx>=0&&hint.styleIndentPx<left){paragraph.style.marginInlineStart=hint.styleIndentPx+'px';changed=true;}
  }
  style=view.getComputedStyle(paragraph);
  if(hint.snapToGrid!==false&&hint.lineRule!=='exact'&&Number.isFinite(hint.gridLinePx)&&hint.gridLinePx>0&&hint.gridLinePx<=300){
   const font=parseFloat(style.fontSize)||16,line=parseFloat(style.lineHeight)||font*1.2;
   // Word's document grid supplies a line pitch even when an imported document
   // stores fractional auto spacing. Preserve larger spacing in grid multiples.
   const height=Math.ceil((Math.max(font,line)-.01)/hint.gridLinePx)*hint.gridLinePx;
   paragraph.style.lineHeight=Math.max(hint.gridLinePx,height)+'px';changed=true;
  }
  if(changed){paragraph.dataset.wordLayoutAdjusted='true';adjusted++;}
 }
 doc.body.dataset.wordLayoutAdjusted=String(adjusted);
}

async function wordApplyImageFallbacks(doc,fallbacks){
 if(!Array.isArray(fallbacks?.images)||!fallbacks.images.length||!crypto.subtle)return;
 const replacements=new Map(fallbacks.images.filter(image=>/^[a-f0-9]{64}$/.test(image.sha256)&&/^data:image\/png;base64,[a-z0-9+/=]+$/i.test(image.src)).map(image=>[image.sha256,image.src]));
 const cache=new Map();
 for(const image of doc.images){
  const original=image.getAttribute('src')||'';if(!/^data:image\/(?:x-)?(?:emf|wmf);base64,/i.test(original))continue;
  try{
   if(!cache.has(original)){
    const bytes=Uint8Array.from(atob(original.slice(original.indexOf(',')+1)),character=>character.charCodeAt(0));
    const digest=await crypto.subtle.digest('SHA-256',bytes),key=[...new Uint8Array(digest)].map(value=>value.toString(16).padStart(2,'0')).join('');cache.set(original,replacements.get(key)||null);
   }
   if(cache.get(original)){image.src=cache.get(original);image.dataset.wordImageConverted='true';await image.decode().catch(()=>{});}
  }catch{/* Leave unsupported graphics to the existing open-original action. */}
 }
}
