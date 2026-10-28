"""Bounded, read-only document text extraction. A short-lived worker, never OCR/CAD."""
import ctypes
import codecs
import json
import os
import posixpath
import re
import sys
import unicodedata
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

MAX_CHARS = 600_000
MAX_CHUNKS = 8_000
MAX_PART = 60_000_000
MAX_SOURCE = 100_000_000
TEXT_EXTENSIONS = {'.txt', '.md', '.markdown', '.csv', '.tsv'}
W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
S = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
A = '{http://schemas.openxmlformats.org/drawingml/2006/main}'
R = '{http://schemas.openxmlformats.org/officeDocument/2006/relationships}'


class LimitReached(Exception):
    pass


class Unsupported(Exception):
    pass


class Collector:
    def __init__(self):
        self.chunks = []
        self.characters = 0
        self.warnings = []
        self.truncated = False

    def add(self, locator, value):
        text = str(value or '').replace('\x00', '').strip()
        if not text:
            return
        # Overlap permits phrase matching across long-paragraph boundaries.
        for start in range(0, len(text), 3880):
            if self.characters >= MAX_CHARS or len(self.chunks) >= MAX_CHUNKS:
                self.truncated = True
                raise LimitReached()
            piece = text[start:start + 4000]
            remaining = MAX_CHARS - self.characters
            if len(piece) > remaining:
                piece = piece[:remaining]
                self.truncated = True
            self.chunks.append({'locator': str(locator)[:240], 'text': piece})
            self.characters += len(piece)
            if self.truncated:
                raise LimitReached()
            if start + 4000 >= len(text):
                break


def xml_part(z, member):
    item = z.getinfo(member)
    if item.file_size > MAX_PART:
        raise ValueError('文档 XML 过大，超过轻量检索上限')
    if item.flag_bits & 1:
        raise ValueError('加密文档暂不能检索正文')
    return z.open(member)


def parse_part(z, member):
    with xml_part(z, member) as stream:
        return ET.parse(stream).getroot()


def read_text(file, output):
    with file.open('rb') as stream:
        raw = stream.read(MAX_CHARS * 4 + 8)
        shortened = bool(stream.read(1))
    encodings = ['utf-8-sig', 'gb18030']
    if raw.startswith((b'\xff\xfe', b'\xfe\xff')):
        encodings = ['utf-16']
    elif raw[:1000].count(b'\x00') > max(2, len(raw[:1000]) // 6):
        encodings = ['utf-16-le', 'utf-16-be']
    value = None
    for encoding in encodings:
        try:
            value = codecs.getincrementaldecoder(encoding)(errors='strict').decode(raw, final=not shortened)
            break
        except UnicodeError:
            pass
    if value is None:
        raise ValueError('文字编码无法识别，请另存为 UTF-8 或 GB18030')
    lines = value.splitlines()
    # Bounded groups retain adjacent line context, rather than cutting at keywords.
    for offset in range(0, len(lines), 8):
        end = min(offset + 8, len(lines))
        output.add('第 %d–%d 行' % (offset + 1, end), '\n'.join(lines[offset:end]))
    if shortened:
        output.truncated = True


def read_docx(z, output):
    members = ['word/document.xml']
    members += sorted(n for n in z.namelist() if re.fullmatch(r'word/(header\d+|footer\d+|footnotes|endnotes)\.xml', n))
    for member in members:
        label = '正文' if member == 'word/document.xml' else Path(member).stem
        count = 0
        with xml_part(z, member) as stream:
            for event, element in ET.iterparse(stream, events=('end',)):
                if element.tag == W + 'p':
                    count += 1
                    text = ''.join((e.text or '') if e.tag == W + 't' else ('\t' if e.tag == W + 'tab' else '\n') for e in element.iter() if e.tag in {W + 't', W + 'tab', W + 'br'})
                    output.add('%s · 第 %d 段' % (label, count), text)
                    element.clear()


def resolve_member(base, target):
    member = posixpath.normpath(target.lstrip('/') if target.startswith('/') else posixpath.join(base, target))
    if member.startswith('../') or member == '..':
        raise ValueError('文档内部路径异常')
    return member


def read_workbook(z, output):
    strings = []
    if 'xl/sharedStrings.xml' in z.namelist():
        with xml_part(z, 'xl/sharedStrings.xml') as stream:
            total = 0
            for _, element in ET.iterparse(stream, events=('end',)):
                if element.tag == S + 'si':
                    text = ''.join(t.text or '' for t in element.iter(S + 't'))
                    total += len(text)
                    if total > 8_000_000:
                        raise ValueError('表格共享文本过大，超过轻量检索上限')
                    strings.append(text)
                    element.clear()
    workbook = parse_part(z, 'xl/workbook.xml')
    rels = {r.get('Id'): r.get('Target') for r in parse_part(z, 'xl/_rels/workbook.xml.rels') if r.get('TargetMode') != 'External'}
    sheets = workbook.find(S + 'sheets')
    if sheets is None:
        return
    for sheet in sheets:
        target = rels.get(sheet.get(R + 'id'))
        if not target:
            continue
        member = resolve_member('xl', target)
        if member not in z.namelist():
            continue
        name = sheet.get('name', '工作表')
        with xml_part(z, member) as stream:
            for _, row in ET.iterparse(stream, events=('end',)):
                if row.tag != S + 'row':
                    continue
                values, refs = [], []
                for cell in row:
                    if cell.tag != S + 'c':
                        continue
                    ref = cell.get('r', '')
                    value = cell.find(S + 'v')
                    text = value.text if value is not None and value.text else ''
                    if cell.get('t') == 's' and text.isdigit():
                        text = strings[int(text)] if int(text) < len(strings) else text
                    elif cell.get('t') == 'inlineStr':
                        text = ''.join(t.text or '' for t in cell.iter(S + 't'))
                    formula = cell.find(S + 'f')
                    if formula is not None and formula.text:
                        # Preserve cached values and formula text; never calculate workbooks.
                        text += (' ' if text else '') + '=' + formula.text
                    if text:
                        values.append('%s: %s' % (ref, text))
                        refs.append(ref)
                if values:
                    location = '%s · %s%s' % (name, refs[0], (':' + refs[-1]) if len(refs) > 1 else '')
                    output.add(location, '\n'.join(values))
                row.clear()


def read_presentation(z, output):
    presentation = parse_part(z, 'ppt/presentation.xml')
    rels = {r.get('Id'): r.get('Target') for r in parse_part(z, 'ppt/_rels/presentation.xml.rels') if r.get('TargetMode') != 'External'}
    P = '{http://schemas.openxmlformats.org/presentationml/2006/main}'
    slides = presentation.find(P + 'sldIdLst')
    if slides is None:
        return
    for index, slide in enumerate(slides, 1):
        target = rels.get(slide.get(R + 'id'))
        if not target:
            continue
        member = resolve_member('ppt', target)
        doc = parse_part(z, member)
        text = '\n'.join(''.join(t.text or '' for t in para.iter(A + 't')) for para in doc.iter(A + 'p'))
        output.add('第 %d 张幻灯片' % index, text)
        relfile = posixpath.join(posixpath.dirname(member), '_rels', posixpath.basename(member) + '.rels')
        if relfile in z.namelist():
            for relation in parse_part(z, relfile):
                if relation.get('TargetMode') != 'External' and relation.get('Type', '').endswith('/notesSlide'):
                    notes = parse_part(z, resolve_member(posixpath.dirname(member), relation.get('Target', '')))
                    output.add('第 %d 张幻灯片 · 备注' % index, '\n'.join(''.join(t.text or '' for t in p.iter(A + 't')) for p in notes.iter(A + 'p')))


def read_pdf(file, output):
    try:
        import pypdfium2 as pdfium
    except ImportError:
        raise Unsupported('缺少本地 PDF 文字读取组件')
    blank = 0
    with pdfium.PdfDocument(str(file)) as pdf:
        for index in range(len(pdf)):
            page = pdf[index]
            try:
                textpage = page.get_textpage()
                try:
                    count = textpage.count_chars()
                    # Avoid allocating an unbounded page text buffer.
                    truncated_page = count > MAX_CHARS - output.characters
                    if truncated_page:
                        count = max(0, MAX_CHARS - output.characters)
                    text = textpage.get_text_range(0, count) if count else ''
                    if not text.strip():
                        blank += 1
                    output.add('第 %d 页' % (index + 1), text)
                    if truncated_page:
                        output.truncated = True
                        raise LimitReached()
                finally:
                    textpage.close()
            finally:
                page.close()
    if blank:
        output.warnings.append('%d 页未发现可读取文字；扫描图片不包含 OCR' % blank)


def read_legacy(file, output):
    """Use Windows' installed IFilter, in this isolated, time-limited process."""
    if os.name != 'nt':
        raise Unsupported('旧版 Office 格式需要 Windows 文档筛选器，请另存为新版格式')
    ULONG, HRESULT = ctypes.c_uint32, ctypes.c_int32
    class GUID(ctypes.Structure):
        _fields_ = [('a', ctypes.c_uint32), ('b', ctypes.c_uint16), ('c', ctypes.c_uint16), ('d', ctypes.c_ubyte * 8)]
    class PropUnion(ctypes.Union):
        _fields_ = [('id', ULONG), ('name', ctypes.c_void_p)]
    class PropSpec(ctypes.Structure):
        _fields_ = [('kind', ULONG), ('value', PropUnion)]
    class FullProp(ctypes.Structure):
        _fields_ = [('set', GUID), ('prop', PropSpec)]
    class Chunk(ctypes.Structure):
        _fields_ = [('id', ULONG), ('breakType', ULONG), ('flags', ULONG), ('locale', ULONG), ('attribute', FullProp), ('source', ULONG), ('start', ULONG), ('length', ULONG)]
    ole = ctypes.OleDLL('ole32')
    initialized = ole.CoInitializeEx(None, 2)
    query = ctypes.WinDLL('query.dll')
    load = query.LoadIFilter
    load.argtypes = [ctypes.c_wchar_p, ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p)]
    load.restype = HRESULT
    pointer = ctypes.c_void_p()
    result = load(str(file), None, ctypes.byref(pointer))
    if result < 0 or not pointer.value:
        if initialized in (0, 1):
            ole.CoUninitialize()
        raise Unsupported('系统没有可用的 %s 文档筛选器，或该旧格式无法读取（0x%08X）；可另存为新版格式' % (file.suffix, result & 0xffffffff))
    vtable = ctypes.cast(pointer, ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p))).contents
    def method(index, *args):
        return ctypes.WINFUNCTYPE(HRESULT, ctypes.c_void_p, *args)(vtable[index])
    release = method(2)
    init = method(3, ULONG, ULONG, ctypes.c_void_p, ctypes.POINTER(ULONG))
    getchunk = method(4, ctypes.POINTER(Chunk))
    gettext = method(5, ctypes.POINTER(ULONG), ctypes.c_void_p)
    try:
        flags = ULONG()
        result = init(pointer, 0x1f, 0, None, ctypes.byref(flags))
        if result < 0:
            raise ValueError('系统文档筛选器初始化失败（0x%08X）' % (result & 0xffffffff))
        count = 0
        while True:
            chunk = Chunk()
            result = getchunk(pointer, ctypes.byref(chunk))
            if (result & 0xffffffff) == 0x80041700:
                break
            if result < 0:
                raise ValueError('文档筛选器读取失败（0x%08X）' % (result & 0xffffffff))
            count += 1
            if not chunk.flags & 1:
                continue
            pieces = []
            char_count = 0
            while True:
                size = ULONG(4096)
                buffer = ctypes.create_unicode_buffer(4096)
                result = gettext(pointer, ctypes.byref(size), buffer)
                code = result & 0xffffffff
                if result >= 0:
                    piece = ''.join(buffer[:min(size.value, 4096)])
                    pieces.append(piece)
                    char_count += len(piece)
                    if char_count + output.characters > MAX_CHARS:
                        output.add('正文片段 %d · 系统筛选器' % count, ''.join(pieces))
                        output.truncated = True
                        raise LimitReached()
                if code in (0x00041709, 0x80041701, 0x80041705):
                    break
                if result < 0:
                    raise ValueError('文档文字读取失败（0x%08X）' % code)
                if size.value == 0:
                    break
            output.add('正文片段 %d · 系统筛选器' % count, ''.join(pieces))
    finally:
        release(pointer)
        if initialized in (0, 1):
            ole.CoUninitialize()


def extract(file):
    output = Collector()
    try:
        if file.stat().st_size > MAX_SOURCE:
            raise Unsupported('文件超过 100 MB，暂不建立正文索引')
        ext = file.suffix.lower()
        if ext in TEXT_EXTENSIONS:
            read_text(file, output)
        elif ext == '.pdf':
            read_pdf(file, output)
        elif ext in {'.doc', '.xls', '.ppt'}:
            read_legacy(file, output)
        elif ext in {'.docx', '.xlsx', '.xlsm', '.pptx', '.pptm'}:
            with zipfile.ZipFile(file) as z:
                xml_size = sum(i.file_size for i in z.infolist() if i.filename.endswith('.xml'))
                if xml_size > 200_000_000:
                    raise Unsupported('文档文字结构超过 200 MB，暂不建立正文索引')
                if ext == '.docx':
                    read_docx(z, output)
                elif ext in {'.xlsx', '.xlsm'}:
                    read_workbook(z, output)
                else:
                    read_presentation(z, output)
        else:
            raise Unsupported('暂不支持此格式的正文检索')
    except LimitReached:
        output.truncated = True
    except Unsupported as error:
        return {'status': 'unsupported', 'reason': str(error), 'chunks': [], 'characters': 0, 'warnings': []}
    except Exception as error:
        # Never expose absolute local paths through an extractor exception.
        return {'status': 'failed', 'reason': ('读取失败：' + str(error)).replace(str(file), file.name)[:500], 'chunks': [], 'characters': 0, 'warnings': []}
    status = 'truncated' if output.truncated else ('ready' if output.chunks else 'empty')
    reason = '正文超过 60 万字或 8000 个片段，已索引的部分仍可检索' if output.truncated else ('未提取到文字；扫描件或图片需另外进行 OCR' if not output.chunks else '')
    return {'status': status, 'reason': reason, 'chunks': output.chunks, 'characters': output.characters, 'warnings': output.warnings}


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    if len(sys.argv) != 2:
        print(json.dumps({'status': 'failed', 'reason': '文件参数缺失', 'chunks': []}, ensure_ascii=False))
    else:
        print(json.dumps(extract(Path(sys.argv[1])), ensure_ascii=False, separators=(',', ':')))
