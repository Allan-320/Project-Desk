"""Read-only OOXML layout hints for gaps in the browser Word renderer.

No document text or source files are changed. Measurements are CSS pixels.
"""
import copy
import math
import re

MAX_PARAGRAPHS = 5000
WORD_NAMESPACES = ('http://schemas.openxmlformats.org/wordprocessingml/2006/main',
                   'http://purl.oclc.org/ooxml/wordprocessingml/main')
# ECMAScript WhiteSpace + LineTerminator: keep this in sync with JS /\s/gu.
JS_WHITESPACE = re.compile('[\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]')


def local(tag):
    return tag.rsplit('}', 1)[-1]


def is_word(element, name):
    return element.tag in ('{' + namespace + '}' + name for namespace in WORD_NAMESPACES)


def attrs(element):
    return {local(key): value for key, value in element.attrib.items()} if element is not None else {}


def child(element, name):
    return next((item for item in element if local(item.tag) == name), None) if element is not None else None


def val(element, default=None):
    return attrs(element).get('val', default)


def numeric(value):
    try:
        result = float(value)
        return result if math.isfinite(result) else None
    except (TypeError, ValueError):
        return None


def pixels(value, units=15):
    number = numeric(value)
    return round(number / units, 4) if number is not None else None


def toggle(value):
    return str(value).lower() not in ('0', 'false', 'off', 'no')


def paragraph_key(text):
    units = JS_WHITESPACE.sub('', text).encode('utf-16-le', 'surrogatepass')
    code = 2166136261
    for offset in range(0, len(units), 2):
        code = ((code ^ (units[offset] | units[offset + 1] << 8)) * 16777619) & 0xffffffff
    return f'{code:08x}:{len(units) // 2}'


def paragraph_text(paragraph):
    # Text boxes contain nested paragraphs; do not count them twice in the parent.
    def collect(element):
        for item in element:
            if is_word(item, 'p'):
                continue
            if is_word(item, 't'):
                yield item.text or ''
            else:
                yield from collect(item)
    return ''.join(collect(paragraph))


def paragraph_props(element):
    result = {}
    for name in ('ind', 'spacing'):
        found = child(element, name)
        if found is not None:
            result[name] = attrs(found)
    snap = child(element, 'snapToGrid')
    if snap is not None:
        result['snapToGrid'] = toggle(val(snap, '1'))
    num = child(element, 'numPr')
    if num is not None:
        result['numPr'] = {local(item.tag): val(item) for item in num if local(item.tag) in ('numId', 'ilvl')}
    return result


def run_props(element):
    result = {}
    size = val(child(element, 'sz'))
    if numeric(size) is not None:
        result['fontSizePx'] = pixels(size, 1.5)
    return result


def merge(base, extra):
    result = copy.deepcopy(base)
    for name, value in extra.items():
        if isinstance(value, dict):
            result[name] = {**result.get(name, {}), **value}
        else:
            result[name] = value
    return result


def indent_px(properties):
    indentation = properties.get('ind', {})
    # Character-unit indents need a font-dependent calculation; expose them below.
    if 'startChars' in indentation or 'leftChars' in indentation:
        return None
    return pixels(indentation.get('start', indentation.get('left')))


def hanging_px(properties):
    indentation = properties.get('ind', {})
    return None if 'hangingChars' in indentation else pixels(indentation.get('hanging'))


def build_layout_hints(roots):
    document = roots.get('word/document.xml')
    body = child(document, 'body')
    if body is None:
        return {'version': 1, 'paragraphs': [], 'truncated': False}
    styles_root = roots.get('word/styles.xml')
    defaults = child(styles_root, 'docDefaults')
    default_p = paragraph_props(child(child(defaults, 'pPrDefault'), 'pPr'))
    default_r = run_props(child(child(defaults, 'rPrDefault'), 'rPr'))
    styles = {attrs(style).get('styleId'): style for style in (styles_root if styles_root is not None else []) if local(style.tag) == 'style'}
    default_style = next((identifier for identifier, style in styles.items() if attrs(style).get('type') == 'paragraph' and toggle(attrs(style).get('default', '0'))), None)
    cache = {}

    def resolve_style(identifier, visiting=()):
        if not identifier or identifier not in styles or identifier in visiting or len(visiting) > 64:
            return {'p': default_p, 'r': default_r}
        if identifier in cache:
            return cache[identifier]
        style = styles[identifier]
        base = resolve_style(val(child(style, 'basedOn')), visiting + (identifier,))
        properties = child(style, 'pPr')
        result = {'p': merge(base['p'], paragraph_props(properties)),
                  'r': merge(merge(base['r'], run_props(child(properties, 'rPr'))), run_props(child(style, 'rPr')))}
        cache[identifier] = result
        return result

    numbering = roots.get('word/numbering.xml')
    numbers, abstracts = {}, {}
    for element in numbering if numbering is not None else []:
        if local(element.tag) == 'num':
            numbers[attrs(element).get('numId')] = element
        elif local(element.tag) == 'abstractNum':
            abstracts[attrs(element).get('abstractNumId')] = element

    def resolve_number(num_id, level, visiting=()):
        if not num_id or num_id == '0' or num_id in visiting or len(visiting) > 32:
            return None
        number = numbers.get(num_id)
        abstract = abstracts.get(val(child(number, 'abstractNumId')))
        linked = val(child(abstract, 'numStyleLink'))
        if linked:
            linked_id = resolve_style(linked)['p'].get('numPr', {}).get('numId')
            if linked_id and linked_id != num_id:
                return resolve_number(linked_id, level, visiting + (num_id,))
        base = next((item for item in (abstract if abstract is not None else []) if local(item.tag) == 'lvl' and attrs(item).get('ilvl') == level), None)
        override = next((item for item in (number if number is not None else []) if local(item.tag) == 'lvlOverride' and attrs(item).get('ilvl') == level), None)
        custom = child(override, 'lvl')
        return custom if custom is not None else base

    # Historical sectPr inside sectPrChange must not end a current section.
    sections = {item for item in body if is_word(item, 'sectPr')}
    sections.update(section for paragraph in body.iter() if is_word(paragraph, 'p')
                    for section in [child(child(paragraph, 'pPr'), 'sectPr')] if section is not None)
    output, pending = [], []
    seen = 0

    def apply_section(section):
        grid = attrs(child(section, 'docGrid'))
        grid_line = pixels(grid.get('linePitch')) if grid.get('type') in ('lines', 'linesAndChars') else None
        for hint in pending:
            hint['gridLinePx'] = grid_line if grid_line and grid_line > 0 else None
        pending.clear()

    for element in body.iter():
        if element in sections:
            apply_section(element)
            continue
        if not is_word(element, 'p'):
            continue
        text = paragraph_text(element)
        if not JS_WHITESPACE.sub('', text):
            continue
        seen += 1
        if len(output) >= MAX_PARAGRAPHS:
            continue
        direct = child(element, 'pPr')
        style_id = val(child(direct, 'pStyle'), default_style)
        style = resolve_style(style_id)
        direct_p = paragraph_props(direct)
        properties = merge(style['p'], direct_p)
        run = merge(style['r'], run_props(child(direct, 'rPr')))
        number = properties.get('numPr', {})
        num_id, level = number.get('numId'), number.get('ilvl', '0')
        numbered = bool(num_id and num_id != '0')
        numbering_level = resolve_number(num_id, level)
        numbering_p = paragraph_props(child(numbering_level, 'pPr'))
        numbering_r = run_props(child(numbering_level, 'rPr'))
        properties = merge(merge(style['p'], numbering_p), direct_p)
        spacing = properties.get('spacing', {})
        direct_ind = attrs(child(direct, 'ind'))
        style_ind = style['p'].get('ind', {})
        hint = {'key': paragraph_key(text), 'fontSizePx': run.get('fontSizePx'),
                'gridLinePx': None, 'snapToGrid': properties.get('snapToGrid', True),
                'lineRule': spacing.get('lineRule', 'auto'), 'lineValue': numeric(spacing.get('line')),
                'numbered': numbered, 'styleIndentPx': indent_px(style['p']),
                'numberIndentPx': indent_px(numbering_p), 'directIndent': bool(direct_ind),
                'numberHangingPx': hanging_px(numbering_p)}
        if direct_ind:
            hint['directIndentPx'] = indent_px(direct_p)
        if style_ind:
            hint['styleHangingPx'] = hanging_px(style['p'])
        if any(key.endswith('Chars') for key in style_ind):
            hint['styleIndentChars'] = {key: numeric(value) for key, value in style_ind.items() if key.endswith('Chars')}
        if numbering_r.get('fontSizePx') is not None:
            hint['markerFontSizePx'] = numbering_r['fontSizePx']
        output.append(hint)
        pending.append(hint)
    # A malformed document lacking final sectPr gets no assumed document grid.
    apply_section(None)
    return {'version': 1, 'paragraphs': output, 'truncated': seen > MAX_PARAGRAPHS}
