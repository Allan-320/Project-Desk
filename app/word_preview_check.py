"""Bounded, read-only DOCX preflight for the local browser layout preview."""
import argparse
import json
from pathlib import Path
import re
from urllib.parse import unquote
import xml.etree.ElementTree as ET
import zipfile
import zlib
import sys

# Also works in the portable runtime whose ._pth omits the application folder.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from word_layout_hints import build_layout_hints
from word_image_fallbacks import build_image_fallbacks

LIMITS = {'fileBytes': 40 * 1024 * 1024, 'uncompressedBytes': 80 * 1024 * 1024,
          'parts': 2000, 'documentXmlBytes': 16 * 1024 * 1024,
          'otherXmlBytes': 8 * 1024 * 1024}
WORD_NS = {'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
           'http://purl.oclc.org/ooxml/wordprocessingml/main'}
IMAGE_EXTENSIONS = {'.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.svg', '.tif', '.tiff', '.emf', '.wmf'}


def local_name(tag):
    return tag.rsplit('}', 1)[-1]


def safe_member(name):
    decoded = name
    for _ in range(3):
        next_name = unquote(decoded)
        if next_name == decoded:
            break
        decoded = next_name
    if not decoded or decoded.startswith('/') or '\\' in decoded or ':' in decoded or '\x00' in decoded:
        raise ValueError('文档包含异常内部路径，无法安全预览')
    parts = decoded.rstrip('/').split('/')
    if any(part in ('', '.', '..') for part in parts):
        raise ValueError('文档包含异常内部路径，无法安全预览')
    return '/'.join(parts).casefold()


def parse_xml(content):
    # Removing NUL also covers UTF-16/32 ASCII markup before ElementTree parses it.
    marker = content.replace(b'\x00', b'').lower()
    if re.search(br'<!\s*(doctype|entity)\b', marker):
        raise ValueError('文档包含不支持的 XML 声明，请用原软件打开')
    try:
        return ET.fromstring(content)
    except ET.ParseError as exc:
        raise ValueError('文档内部格式损坏，请用原软件检查') from exc


def inspect_docx(filename, limits=None):
    limits = dict(LIMITS if limits is None else limits)
    source = Path(filename)
    if source.suffix.lower() != '.docx':
        raise ValueError('此预览仅支持 DOCX，请用原软件打开')
    file_bytes = source.stat().st_size
    if file_bytes > limits['fileBytes']:
        raise ValueError('文档较大，请用原软件打开')
    if not zipfile.is_zipfile(source):
        raise ValueError('文档损坏或已加密，请用原软件打开')
    with zipfile.ZipFile(source) as archive:
        members = archive.infolist()
        if len(members) > limits['parts']:
            raise ValueError('文档内部内容过多，请用原软件打开')
        names, total, xml_members = set(), 0, []
        for member in members:
            normalized = safe_member(member.orig_filename)
            if normalized in names:
                raise ValueError('文档包含重复内部文件，无法安全预览')
            names.add(normalized)
            if member.flag_bits & 1:
                raise ValueError('文档已加密，请用原软件打开')
            if member.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
                raise ValueError('文档压缩格式不受支持，请用原软件打开')
            total += member.file_size
            if total > limits['uncompressedBytes']:
                raise ValueError('文档展开后较大，请用原软件打开')
            if member.filename.lower().endswith(('.xml', '.rels')):
                cap = limits['documentXmlBytes'] if member.filename == 'word/document.xml' else limits['otherXmlBytes']
                if member.file_size > cap:
                    raise ValueError('文档内容过于复杂，请用原软件打开')
                xml_members.append(member.filename)
        required = {'[Content_Types].xml', '_rels/.rels', 'word/document.xml'}
        if not required.issubset(set(archive.namelist())):
            raise ValueError('文档缺少必要内容，请用原软件检查')

        # Validate CRC and actual expanded sizes in bounded chunks before a browser
        # allocates the package. No member is extracted to the filesystem.
        expanded, roots = 0, {}
        for member in members:
            if member.is_dir():
                continue
            count, chunks = 0, []
            is_xml = member.filename in xml_members
            with archive.open(member) as stream:
                while True:
                    chunk = stream.read(64 * 1024)
                    if not chunk:
                        break
                    count += len(chunk)
                    expanded += len(chunk)
                    if expanded > limits['uncompressedBytes'] or count > member.file_size:
                        raise ValueError('文档展开后较大或格式异常，请用原软件打开')
                    if is_xml:
                        chunks.append(chunk)
            if count != member.file_size:
                raise ValueError('文档内部文件不完整，请用原软件检查')
            if is_xml:
                roots[member.filename] = parse_xml(b''.join(chunks))

        document = roots['word/document.xml']
        namespace = document.tag[1:].split('}', 1)[0] if document.tag.startswith('{') else ''
        if namespace not in WORD_NS or local_name(document.tag) != 'document':
            raise ValueError('不是可识别的 Word 文档内容')
        tables = sum(local_name(element.tag) == 'tbl' for element in document.iter())
        alt_chunks = any(local_name(element.tag) == 'altChunk' for root in roots.values() for element in root.iter())
        external, external_images = 0, 0
        macros = any('vbaproject' in name or name.endswith('vbadata.xml') for name in names)
        for name, root in roots.items():
            if not name.lower().endswith('.rels'):
                continue
            if local_name(root.tag) != 'Relationships':
                raise ValueError('文档的资源关联格式异常')
            for relationship in root:
                target = relationship.get('Target', '')
                relation_type = relationship.get('Type', '').lower()
                is_external = (relationship.get('TargetMode', '').lower() == 'external' or
                               bool(re.match(r'^[a-z][a-z0-9+.-]*:', target, re.I)) or target.startswith('//'))
                if is_external:
                    external += 1
                    external_images += relation_type.endswith('/image')
                if '/afchunk' in relation_type:
                    alt_chunks = True
                if 'vbaproject' in relation_type:
                    macros = True
        warnings = []
        if external_images:
            warnings.append('外部链接图片不载入')
        if alt_chunks:
            warnings.append('嵌入网页不载入')
        if macros:
            warnings.append('宏和嵌入程序不运行')
        images = sum(name.startswith('word/media/') and Path(name).suffix.lower() in IMAGE_EXTENSIONS for name in names)
        return {'kind': 'docx-layout', 'bytes': file_bytes, 'uncompressedBytes': expanded,
                'parts': len(members), 'images': images, 'tables': tables,
                'externalRelationships': external, 'externalImages': external_images,
                'hasAltChunks': alt_chunks, 'hasMacros': macros,
                'warnings': warnings, 'limits': limits, 'layoutHints': build_layout_hints(roots),
                'imageFallbacks': build_image_fallbacks(archive)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('file')
    args = parser.parse_args()
    try:
        result = inspect_docx(args.file)
    except (zipfile.BadZipFile, RuntimeError, NotImplementedError, zlib.error, EOFError):
        result = {'error': '文档损坏或压缩格式异常，请用原软件打开'}
    except OSError:
        result = {'error': '文档当前无法读取，请刷新后重试'}
    except ValueError as exc:
        result = {'error': str(exc)}
    print(json.dumps(result, ensure_ascii=True, separators=(',', ':')))


if __name__ == '__main__':
    main()
