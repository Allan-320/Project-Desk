"""Small on-demand previews. Reads source files and writes only the supplied cache path."""
import os, sys, zipfile, re, textwrap
from pathlib import Path
from PIL import Image, ImageOps, ImageDraw, ImageFont
import xml.etree.ElementTree as ET

W,H=384,256
FONT=Path(os.environ.get('SystemRoot','C:/Windows'))/'Fonts'/'msyh.ttc'
def font(size):
    return ImageFont.truetype(str(FONT),size) if FONT.exists() else ImageFont.load_default()
def thumbnail(source,target):
    source=Path(source); ext=source.suffix.lower()
    if ext in {'.jpg','.jpeg','.png','.webp','.gif','.bmp'}:
        with Image.open(source) as original:
            if original.width*original.height>30_000_000:raise ValueError('image too large for lightweight preview')
            original.draft('RGB',(W*2,H*2))
            original.thumbnail((W*2,H*2))
            im=ImageOps.exif_transpose(original).convert('RGBA')
            base=Image.new('RGB',im.size,'white');base.paste(im,mask=im.getchannel('A'));im=base
    elif ext=='.pdf':
        import pypdfium2 as pdfium
        with pdfium.PdfDocument(str(source)) as pdf:
            if not len(pdf):raise ValueError('empty PDF')
            page=pdf[0]; scale=min(W/page.get_width(),H/page.get_height())
            bitmap=page.render(scale=scale); im=bitmap.to_pil().convert('RGB');bitmap.close();page.close()
    else:
        lines=[]; cells=None
        if ext in {'.docx','.xlsx','.xlsm'}:
            with zipfile.ZipFile(source) as z:
                thumbs=[n for n in z.namelist() if n.lower() in {'docprops/thumbnail.jpeg','docprops/thumbnail.jpg','docprops/thumbnail.png'}]
                if thumbs and z.getinfo(thumbs[0]).file_size<4_000_000:
                    import io
                    with Image.open(io.BytesIO(z.read(thumbs[0]))) as embedded:
                        im=embedded.convert('RGB');im.thumbnail((W,H));im.save(target,'JPEG',quality=78)
                    return
                def xml(name):
                    if z.getinfo(name).file_size>25_000_000:raise ValueError('large XML')
                    return ET.fromstring(z.read(name))
                if ext=='.docx':
                    ns={'w':'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
                    doc=xml('word/document.xml')
                    for p in doc.findall('.//w:p',ns)[:60]:
                        value=''.join(t.text or '' for t in p.findall('.//w:t',ns))
                        if value.strip():lines.extend(textwrap.wrap(value,25)[:4])
                        if len(lines)>10:break
                else:
                    ns={'s':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
                    strings=[]
                    if 'xl/sharedStrings.xml' in z.namelist():strings=[''.join(t.text or '' for t in si.findall('.//s:t',ns)) for si in xml('xl/sharedStrings.xml').findall('s:si',ns)]
                    wb=xml('xl/workbook.xml');sheet=wb.find('s:sheets',ns)[0]
                    rid=sheet.get('{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id')
                    rels={r.get('Id'):r.get('Target') for r in xml('xl/_rels/workbook.xml.rels')}
                    member=rels[rid].lstrip('/') if rels[rid].startswith('/') else 'xl/'+rels[rid]
                    if '..' in member.split('/'):raise ValueError('invalid sheet path')
                    cells=[]
                    for row in xml(member).findall('.//s:sheetData/s:row',ns)[:9]:
                        values=['']*5
                        for c in list(row)[:20]:
                            match=re.match(r'([A-Z]+)',c.get('r','A'));col=0
                            for char in match[1] if match else 'A':col=col*26+ord(char)-64
                            if col>5:continue
                            value=c.find('s:v',ns);value=value.text if value is not None else ''
                            if c.get('t')=='s':value=strings[int(value)] if value and value.isdigit() and int(value)<len(strings) else value
                            if c.get('t')=='inlineStr':value=''.join(t.text or '' for t in c.findall('.//s:t',ns))
                            values[col-1]=value or ''
                        cells.append(values)
        elif ext in {'.txt','.md','.csv'}:
            with source.open('rb') as f:text=f.read(8000).decode('utf-8',errors='replace')
            for line in text.splitlines()[:30]:lines.extend(textwrap.wrap(line,27) or [''])
        else:raise ValueError('unsupported preview')
        im=Image.new('RGB',(W,H),'#fff');d=ImageDraw.Draw(im)
        d.rectangle((0,0,W,29),fill='#edf2ed');d.text((12,5),ext[1:].upper()+(' · 单元格预览' if cells is not None else ' · 内容预览'),font=font(12),fill='#42644d')
        if cells is not None:
            for r,row in enumerate(cells[:8]):
                for c,value in enumerate(row):
                    x,y=8+c*74,39+r*25;d.rectangle((x,y,x+74,y+25),outline='#dfe5df');d.text((x+4,y+4),value[:6],font=font(11),fill='#3a433c')
        else:
            for i,line in enumerate(lines[:10]):d.text((12,38+i*20),line,font=font(13),fill='#3c433e')
    im.thumbnail((W,H));im.save(target,'JPEG',quality=78,optimize=True)
if __name__=='__main__':thumbnail(sys.argv[1],sys.argv[2])
