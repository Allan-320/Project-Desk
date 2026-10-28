"""Bounded, in-memory PNG fallbacks for Word's Windows metafile images.

The caller owns the validated, read-only ZipFile. No source or image is written
to disk, and missing native Pillow support simply leaves those images skipped.
"""
import base64
import hashlib
import io

try:
    from PIL import Image
except ImportError:
    Image = None


MAX_FILES = 16
MAX_INPUT_BYTES = 6 * 1024 * 1024
MAX_PIXELS = 8_000_000
MAX_SIDE = 4096
MAX_OUTPUT_BYTES = 600 * 1024
RETRY_MAX_SIDE = 1600


class _OutputLimitExceeded(Exception):
    pass


class _LimitedBuffer(io.BytesIO):
    def __init__(self, limit):
        super().__init__()
        self.limit = limit

    def write(self, value):
        if self.tell() + len(value) > self.limit:
            raise _OutputLimitExceeded()
        return super().write(value)


def _png_bytes(image, limit):
    with _LimitedBuffer(limit) as output:
        image.save(output, format='PNG')
        return output.getvalue()


def _render_png(raw, remaining):
    with Image.open(io.BytesIO(raw)) as source:
        width, height = source.size
        # Pillow identifies both EMF and WMF as WMF. Check dimensions before
        # invoking its Windows renderer so oversized canvases are never loaded.
        if (source.format not in ('WMF', 'EMF') or width <= 0 or height <= 0
                or max(width, height) > MAX_SIDE or width * height > MAX_PIXELS):
            return None
        source.load()
        image = source if source.mode in ('RGB', 'RGBA') else source.convert('RGBA')
        try:
            try:
                return _png_bytes(image, remaining)
            except _OutputLimitExceeded:
                if max(image.size) <= RETRY_MAX_SIDE:
                    return None
                # At most one bounded reduction; retain aspect ratio and let
                # Windows render the original fonts before resampling.
                image.thumbnail((RETRY_MAX_SIDE, RETRY_MAX_SIDE), Image.Resampling.LANCZOS)
                try:
                    return _png_bytes(image, remaining)
                except _OutputLimitExceeded:
                    return None
        finally:
            if image is not source:
                image.close()


def build_image_fallbacks(archive):
    """Return hash-keyed PNG data URLs for at most 16 Word EMF/WMF members.

    ``sha256`` hashes the original metafile bytes. ``skipped`` counts eligible
    image members that could not be converted within the shared budgets.
    """
    candidates = [item for item in archive.infolist()
                  if item.filename.startswith('word/media/')
                  and '/' not in item.filename[len('word/media/'):]
                  and item.filename.lower().endswith(('.emf', '.wmf'))
                  and not item.is_dir()]
    result = {'images': [], 'skipped': 0}
    if Image is None or not callable(getattr(getattr(Image, 'core', None), 'drawwmf', None)):
        result['skipped'] = len(candidates)
        return result

    input_bytes = 0
    output_bytes = 0
    for index, item in enumerate(candidates):
        remaining_input = MAX_INPUT_BYTES - input_bytes
        remaining_output = MAX_OUTPUT_BYTES - output_bytes
        if (index >= MAX_FILES or item.file_size <= 0
                or item.file_size > remaining_input or remaining_output <= 0):
            result['skipped'] += 1
            continue
        try:
            # A bounded read also protects against inconsistent declared sizes.
            with archive.open(item, 'r') as member:
                raw = member.read(remaining_input + 1)
            input_bytes += len(raw)
            if not raw or input_bytes > MAX_INPUT_BYTES:
                result['skipped'] += 1
                continue
            png = _render_png(raw, remaining_output)
            if not png:
                result['skipped'] += 1
                continue
            output_bytes += len(png)
            result['images'].append({
                'sha256': hashlib.sha256(raw).hexdigest(),
                'src': 'data:image/png;base64,' + base64.b64encode(png).decode('ascii'),
            })
        except Exception:
            # Corrupt or unsupported images must not prevent document preview.
            result['skipped'] += 1
    return result
