"""Read-only, bounded OOXML preview using the distribution's Python stdlib."""

import argparse
import datetime as dt
from decimal import Decimal, ROUND_HALF_UP, localcontext
import json
import math
import posixpath
import re
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

NS = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
      's': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
      'a': 'http://schemas.openxmlformats.org/drawingml/2006/main'}
REL_ID = '{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id'
MAX_XML = 30_000_000
MAX_ROWS, MAX_COLS, MAX_CELLS, MAX_TEXT = 500, 100, 16000, 4000
BUILTIN_FORMATS = {
    0: 'General', 1: '0', 2: '0.00', 3: '#,##0', 4: '#,##0.00',
    9: '0%', 10: '0.00%', 11: '0.00E+00', 12: '# ?/?', 13: '# ??/??',
    14: 'yyyy-mm-dd', 15: 'd-mmm-yy', 16: 'd-mmm', 17: 'mmm-yy',
    18: 'h:mm AM/PM', 19: 'h:mm:ss AM/PM', 20: 'h:mm', 21: 'h:mm:ss',
    22: 'yyyy-mm-dd h:mm', 37: '#,##0;(#,##0)', 38: '#,##0;[Red](#,##0)',
    39: '#,##0.00;(#,##0.00)', 40: '#,##0.00;[Red](#,##0.00)',
    45: 'mm:ss', 46: '[h]:mm:ss', 47: 'mmss.0', 48: '##0.0E+0', 49: '@',
}
INDEXED_COLORS = ['000000', 'FFFFFF', 'FF0000', '00FF00', '0000FF', 'FFFF00',
                  'FF00FF', '00FFFF', '000000', 'FFFFFF', 'FF0000', '00FF00',
                  '0000FF', 'FFFF00', 'FF00FF', '00FFFF', '800000', '008000',
                  '000080', '808000', '800080', '008080', 'C0C0C0', '808080']


def read_xml(z, name):
    if z.getinfo(name).file_size > MAX_XML:
        raise ValueError('文档内容过大，请使用本机软件打开')
    return ET.fromstring(z.read(name))


def number(value, default=0):
    try:
        value = float(value)
        return value if math.isfinite(value) else default
    except (TypeError, ValueError):
        return default


def integer(value, default=0):
    return int(number(value, default))


def truth(value):
    return str(value).lower() in ('1', 'true')


def col_label(index):
    result = ''
    while index > 0:
        index, digit = divmod(index - 1, 26)
        result = chr(65 + digit) + result
    return result


def coordinates(ref):
    match = re.fullmatch(r'\$?([A-Za-z]{1,3})\$?([1-9][0-9]{0,6})', ref or '')
    if not match:
        return None
    column = 0
    for char in match[1].upper():
        column = column * 26 + ord(char) - 64
    row = int(match[2])
    return (row, column) if column <= 16384 and row <= 1048576 else None


def merged_range(ref):
    ends = (ref or '').split(':')
    first, last = coordinates(ends[0]), coordinates(ends[-1])
    if not first or not last or first[0] > last[0] or first[1] > last[1]:
        return None
    return {'ref': ref, 'startRow': first[0], 'startCol': first[1],
            'endRow': last[0], 'endCol': last[1]}


def column_pixels(width):
    # OOXML widths use maximum-digit character units; browser fonts can differ.
    return round(max(0, min(255, width)) * 7 + (5 if width >= 1 else 0), 2)


def theme_colors(z):
    if 'xl/theme/theme1.xml' not in z.namelist():
        return []
    scheme = read_xml(z, 'xl/theme/theme1.xml').find('.//a:clrScheme', NS)
    if scheme is None:
        return []
    colors = []
    for item in scheme:
        value = next(iter(item), None)
        colors.append(value.get('lastClr', value.get('val', '')) if value is not None else '')
    if len(colors) >= 4:
        colors[:4] = [colors[1], colors[0], colors[3], colors[2]]
    return colors


def color(element, theme):
    if element is None:
        return None
    value = element.get('rgb', '')[-6:]
    if not value and 'theme' in element.attrib:
        index = integer(element.get('theme'), -1)
        value = theme[index] if 0 <= index < len(theme) else ''
    if not value and 'indexed' in element.attrib:
        index = integer(element.get('indexed'), -1)
        value = INDEXED_COLORS[index] if 0 <= index < len(INDEXED_COLORS) else ''
    if not re.fullmatch('[0-9a-fA-F]{6}', value):
        return None
    tint = max(-1, min(1, number(element.get('tint'))))
    if tint:
        channels = [int(value[i:i + 2], 16) for i in (0, 2, 4)]
        channels = [round(c * (1 + tint) if tint < 0 else c * (1 - tint) + 255 * tint) for c in channels]
        value = ''.join(f'{c:02X}' for c in channels)
    return '#' + value.upper()


def child_value(element, tag, default=None):
    item = element.find('s:' + tag, NS) if element is not None else None
    return item.get('val', default) if item is not None else default


def has_flag(element, tag):
    item = element.find('s:' + tag, NS)
    return item is not None and item.get('val', '1') not in ('0', 'false')


def read_styles(z):
    default = {'font': {'name': 'Calibri', 'size': 14.67, 'bold': False, 'italic': False},
               'alignment': {'horizontal': 'general', 'vertical': 'bottom', 'wrapText': False, 'textRotation': 0},
               'fill': None, 'numberFormat': 'General'}
    if 'xl/styles.xml' not in z.namelist():
        return [default]
    root, theme = read_xml(z, 'xl/styles.xml'), theme_colors(z)
    formats = dict(BUILTIN_FORMATS)
    for item in root.findall('s:numFmts/s:numFmt', NS):
        formats[integer(item.get('numFmtId'))] = item.get('formatCode', 'General')[:500]
    fonts = []
    for item in root.findall('s:fonts/s:font', NS):
        fonts.append({'name': child_value(item, 'name', 'Calibri'),
                      'size': round(number(child_value(item, 'sz'), 11) * 96 / 72, 2),
                      'bold': has_flag(item, 'b'), 'italic': has_flag(item, 'i'),
                      'underline': has_flag(item, 'u'), 'strike': has_flag(item, 'strike'),
                      'color': color(item.find('s:color', NS), theme)})
    fills = []
    for item in root.findall('s:fills/s:fill', NS):
        pattern = item.find('s:patternFill', NS)
        fills.append(color(pattern.find('s:fgColor', NS), theme)
                     if pattern is not None and pattern.get('patternType') == 'solid' else None)
    styles = []
    base_xfs = root.findall('s:cellStyleXfs/s:xf', NS)
    for item in root.findall('s:cellXfs/s:xf', NS):
        base_index = integer(item.get('xfId'))
        base = base_xfs[base_index] if 0 <= base_index < len(base_xfs) else None
        attrs = dict(base.attrib) if base is not None else {}
        attrs.update(item.attrib)
        font_index, fill_index = integer(attrs.get('fontId')), integer(attrs.get('fillId'))
        align = item.find('s:alignment', NS)
        if align is None and base is not None:
            align = base.find('s:alignment', NS)
        align = align.attrib if align is not None else {}
        num_id = integer(attrs.get('numFmtId'))
        styles.append({'font': fonts[font_index] if 0 <= font_index < len(fonts) else default['font'],
                       'alignment': {'horizontal': align.get('horizontal', 'general'),
                                     'vertical': align.get('vertical', 'bottom'),
                                     'wrapText': truth(align.get('wrapText')),
                                     'textRotation': integer(align.get('textRotation')),
                                     'shrinkToFit': truth(align.get('shrinkToFit')),
                                     'indent': integer(align.get('indent'))},
                       'fill': fills[fill_index] if 0 <= fill_index < len(fills) else None,
                       'numberFormat': formats.get(num_id, 'General'), 'numberFormatId': num_id})
    return styles or [default]


def date_value(value, fmt, date1904):
    clean = re.sub(r'"[^"]*"|\\.', '', fmt).lower()
    clean = re.sub(r'\[(?!h+\]|m+\]|s+\])[^\]]*\]', '', clean)
    if not re.search(r'[ydhs]|m[/-]|[/-]m', clean):
        return None
    try:
        epoch = dt.datetime(1904, 1, 1) if date1904 else dt.datetime(1899, 12, 30)
        serial = value + (1 if not date1904 and 0 < value < 60 else 0)
        date = epoch + dt.timedelta(days=serial)
        has_date = bool(re.search(r'[yd]', clean) or re.search(r'm[/-]|[/-]m', clean))
        has_time = bool(re.search(r'[hs]', clean))
        if '[h]' in clean:
            return f'{int(value * 24)}:{date.minute:02}:{date.second:02}'
        if has_date and has_time:
            return date.strftime('%Y-%m-%d %H:%M:%S' if 's' in clean else '%Y-%m-%d %H:%M')
        if has_date:
            return date.strftime('%Y-%m-%d')
        return date.strftime('%H:%M:%S' if 's' in clean else '%H:%M')
    except (ValueError, OverflowError):
        return None


def format_number(raw, fmt, date1904):
    """Common stored number formats only; never evaluate workbook formulas."""
    try:
        value = float(raw)
    except (ValueError, TypeError):
        return raw
    if not math.isfinite(value):
        return raw
    date = date_value(value, fmt, date1904)
    if date is not None:
        return date
    general = format(value, '.15g')
    if fmt in ('General', '@', ''):
        return general
    sections = fmt.split(';')
    chosen = sections[1] if value < 0 and len(sections) > 1 else sections[2] if value == 0 and len(sections) > 2 else sections[0]
    if re.search(r'\[(?:[<>=]|\$)|\?|[/]|\*|_', chosen):
        return general
    chosen = re.sub(r'\[[^\]]*\]', '', chosen)
    percent = '%' in chosen
    pattern = re.search(r'[#0,]+(?:\.([#0]+))?(?:[Ee][+-]0+)?', chosen)
    if not pattern:
        return general
    decimals = min(15, len(pattern[1] or ''))
    numeric = Decimal(general) * (100 if percent else 1)
    if value < 0 and len(sections) > 1:
        numeric = abs(numeric)
    if re.search('[Ee][+-]0+', pattern[0]):
        rendered = f'{numeric:.{decimals}E}'
    else:
        with localcontext() as context:
            context.prec = 350
            numeric = numeric.quantize(Decimal(1).scaleb(-decimals), rounding=ROUND_HALF_UP)
        rendered = format(numeric, (',' if ',' in pattern[0] else '') + f'.{decimals}f')
        if pattern[1] and '#' in pattern[1]:
            optional = len(pattern[1]) - len(pattern[1].rstrip('#'))
            for _ in range(optional):
                if rendered.endswith('0'):
                    rendered = rendered[:-1]
            rendered = rendered.rstrip('.')
        if not pattern[1] and re.fullmatch('0+', pattern[0]):
            rendered = rendered.zfill(len(pattern[0]))
    prefix, suffix = chosen[:pattern.start()], chosen[pattern.end():]
    return re.sub(r'"([^\"]*)"', r'\1', (prefix + rendered + suffix).replace('\\', ''))


def workbook_metadata(z):
    workbook = read_xml(z, 'xl/workbook.xml')
    relationships = read_xml(z, 'xl/_rels/workbook.xml.rels')
    targets = {item.get('Id'): item for item in relationships}
    sheets = []
    for index, item in enumerate(workbook.findall('s:sheets/s:sheet', NS)):
        rel = targets.get(item.get(REL_ID))
        target = rel.get('Target', '') if rel is not None else ''
        member = posixpath.normpath(target.lstrip('/') if target.startswith('/') else 'xl/' + target)
        if not member.startswith('xl/') or (rel is not None and rel.get('TargetMode') == 'External'):
            member = ''
        sheets.append({'index': index, 'name': item.get('name', '工作表'),
                       'hidden': item.get('state', 'visible') != 'visible', '_member': member})
    properties = workbook.find('s:workbookPr', NS)
    return sheets, truth(properties.get('date1904')) if properties is not None else False


def preview_xlsx(z, sheet_index=None, row_start=1, col_start=1):
    sheet_names, date1904 = workbook_metadata(z)
    if not sheet_names:
        raise ValueError('工作簿没有可预览的工作表')
    if sheet_index is None:
        sheet_index = next((s['index'] for s in sheet_names if not s['hidden']), 0)
    if not 0 <= sheet_index < len(sheet_names):
        raise ValueError('工作表不存在')
    if not 1 <= row_start <= 1048576 or not 1 <= col_start <= 16384:
        raise ValueError('预览范围无效')
    selected = sheet_names[sheet_index]
    member = selected['_member']
    if not member or member not in z.namelist():
        raise ValueError('工作表内容不可用')
    if z.getinfo(member).file_size > MAX_XML:
        raise ValueError('工作表内容过大，请使用本机软件打开')
    all_styles = read_styles(z)
    strings = []
    if 'xl/sharedStrings.xml' in z.namelist():
        ss = read_xml(z, 'xl/sharedStrings.xml')
        strings = [''.join(t.text or '' for t in si.findall('.//s:t', NS)) for si in ss.findall('s:si', NS)]
    end_row, end_col = min(1048576, row_start + MAX_ROWS - 1), min(16384, col_start + MAX_COLS - 1)
    rows, row_heights, hidden_rows, col_defs, merges = [], {}, [], [], []
    styles, style_map = [all_styles[0]], {0: 0}
    default_row_height, default_col_width = 20, column_pixels(8.43)
    max_row, max_col, cell_count, text_count = 1, 1, 0, 0
    text_truncated, cells_truncated, missing_formula_cache = False, False, False
    unsupported = set()
    row_counter = 0

    def style_id(raw_id):
        source_id = integer(raw_id)
        if not 0 <= source_id < len(all_styles):
            source_id = 0
        if source_id not in style_map:
            style_map[source_id] = len(styles)
            styles.append(all_styles[source_id])
        return style_map[source_id]

    with z.open(member) as source:
        for event, element in ET.iterparse(source, events=('end',)):
            tag = element.tag.rsplit('}', 1)[-1]
            if tag == 'sheetFormatPr':
                default_row_height = round(number(element.get('defaultRowHeight'), 15) * 96 / 72, 2)
                default_col_width = column_pixels(number(element.get('defaultColWidth'), 8.43))
            elif tag == 'col':
                col_defs.append(dict(element.attrib))
            elif tag == 'row':
                row_counter = integer(element.get('r'), row_counter + 1)
                row_number = row_counter
                max_row = max(max_row, row_number)
                in_rows = row_start <= row_number <= end_row
                if in_rows:
                    if 'ht' in element.attrib:
                        row_heights[str(row_number)] = round(number(element.get('ht'), 15) * 96 / 72, 2)
                    if truth(element.get('hidden')):
                        hidden_rows.append(row_number)
                cells, previous_col = [], 0
                for cell in element.findall('s:c', NS):
                    rc = coordinates(cell.get('r')) or (row_number, previous_col + 1)
                    actual_row, column = rc
                    previous_col = column
                    max_row, max_col = max(max_row, actual_row), max(max_col, column)
                    if not row_start <= actual_row <= end_row or not col_start <= column <= end_col:
                        continue
                    if cell_count >= MAX_CELLS or text_count >= 650_000:
                        cells_truncated = True
                        continue
                    raw = cell.findtext('s:v', '', NS)
                    value = raw
                    cell_type = cell.get('t', 'n')
                    if cell_type == 's':
                        index = integer(raw, -1)
                        value = strings[index] if 0 <= index < len(strings) else raw
                    elif cell_type == 'inlineStr':
                        value = ''.join(t.text or '' for t in cell.findall('.//s:t', NS))
                    elif cell_type == 'b':
                        value = 'TRUE' if raw == '1' else 'FALSE'
                    selected_style = cell.get('s', element.get('s'))
                    if selected_style is None:
                        for definition in col_defs:
                            if integer(definition.get('min')) <= column <= integer(definition.get('max')):
                                selected_style = definition.get('style', '0')
                    sid = style_id(selected_style)
                    formula = cell.find('s:f', NS)
                    if cell_type == 'n' and value:
                        value = format_number(value, styles[sid]['numberFormat'], date1904)
                    if formula is not None and not raw:
                        value = '=' + (formula.text or '')
                        missing_formula_cache = True
                    text_truncated = text_truncated or len(value) > MAX_TEXT or len(raw) > MAX_TEXT
                    result = {'ref': col_label(column) + str(actual_row), 'row': actual_row,
                              'column': column, 'value': value[:MAX_TEXT], 'raw': raw[:MAX_TEXT],
                              'styleId': sid, 'type': cell_type}
                    if formula is not None:
                        result['formula'] = (formula.text or '')[:MAX_TEXT]
                        result['cachedValueAvailable'] = bool(raw)
                    if len(value) > MAX_TEXT:
                        result['truncated'] = True
                    cells.append(result)
                    cell_count += 1
                    text_count += len(result['value']) + len(result['raw']) + len(result.get('formula', ''))
                if in_rows:
                    rows.append(cells)
                element.clear()
            elif tag == 'mergeCell':
                merged = merged_range(element.get('ref'))
                if merged:
                    max_row, max_col = max(max_row, merged['endRow']), max(max_col, merged['endCol'])
                    if merged['endRow'] >= row_start and merged['startRow'] <= end_row and merged['endCol'] >= col_start and merged['startCol'] <= end_col:
                        merges.append(merged)
            elif tag in ('drawing', 'legacyDrawing', 'conditionalFormatting'):
                unsupported.add(tag)
    columns = []
    for column in range(col_start, min(end_col, max_col) + 1):
        definition = {'index': column, 'label': col_label(column), 'width': default_col_width, 'hidden': False}
        for item in col_defs:
            if integer(item.get('min')) <= column <= integer(item.get('max')):
                if 'width' in item:
                    definition['width'] = column_pixels(number(item['width'], 8.43))
                definition['hidden'] = truth(item.get('hidden'))
                if 'style' in item:
                    definition['styleId'] = style_id(item['style'])
        columns.append(definition)
    truncation = {'rows': max_row > end_row or row_start > 1, 'columns': max_col > end_col or col_start > 1,
                  'cells': cells_truncated, 'cellText': text_truncated}
    sheet = {'index': sheet_index, 'name': selected['name'], 'rows': rows,
             'columns': columns, 'rowHeights': row_heights, 'hiddenRows': hidden_rows,
             'merges': merges, 'styles': styles, 'defaultRowHeight': default_row_height,
             'defaultColumnWidth': default_col_width, 'maxRow': max_row, 'maxCol': max_col,
             'range': {'startRow': row_start, 'endRow': min(end_row, max_row),
                       'startCol': col_start, 'endCol': min(end_col, max_col)},
             'truncated': any(truncation.values()), 'truncation': truncation,
             'missingFormulaCache': missing_formula_cache}
    return {'kind': 'xlsx', 'version': 2, 'activeSheet': sheet_index,
            'sheetNames': [{k: v for k, v in s.items() if not k.startswith('_')} for s in sheet_names],
            'sheets': [sheet], 'truncated': sheet['truncated'],
            'limits': {'rows': MAX_ROWS, 'columns': MAX_COLS, 'cells': MAX_CELLS},
            'limitations': ['保留行列尺寸、合并及常用格式；字体尺寸换算和复杂数字格式可能与 Excel 略有差异。',
                            '公式显示文件已保存的结果，不重新计算；图表、嵌入图片及条件格式请打开原文件查看。'],
            'unsupportedFeatures': sorted(unsupported)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('file')
    parser.add_argument('--sheet-index', type=int)
    parser.add_argument('--row-start', type=int, default=1)
    parser.add_argument('--col-start', type=int, default=1)
    args = parser.parse_args()
    file = Path(args.file)
    with zipfile.ZipFile(file) as z:
        if file.suffix.lower() == '.docx':
            root = read_xml(z, 'word/document.xml')
            paragraphs = [''.join(t.text or '' for t in p.findall('.//w:t', NS)) for p in root.findall('.//w:p', NS)]
            result = {'kind': 'docx', 'paragraphs': paragraphs[:400], 'truncated': len(paragraphs) > 400}
        else:
            result = preview_xlsx(z, args.sheet_index, args.row_start, args.col_start)
    encoded = json.dumps(result, ensure_ascii=True, separators=(',', ':'))
    if len(encoded) > 7_000_000:
        raise ValueError('此范围的复杂格式或文本过多，请打开原文件查看')
    print(encoded)


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print(json.dumps({'error': str(exc)}, ensure_ascii=True))
