"""Build an offline Windows x64 release from the clean source repository.

No download, personal data, config, cache or running service is used by this tool.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import zipfile

APP_FILES = ['server.cjs', 'imports.cjs', 'progress.cjs', 'directory-links.cjs',
             'thumbnails.cjs', 'office_preview.py', 'word_preview_check.py',
             'word_layout_hints.py', 'word_image_fallbacks.py', 'thumbnail.py',
             'notes.cjs', 'document-search.cjs', 'document_extract.py',
             'portable-runner.cjs', 'FolderPicker.cs']
ROOT_FILES = ['start.ps1', '启动项目资料台.cmd', '切换资料目录.cmd',
              '直接建立空白工作区.cmd', '使用说明.txt', 'README.md',
              'RELEASE_NOTES.md', 'release.json']


def copy_file(source, target):
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target)


def build(source, output, node, python_home):
    release = json.loads((source / 'release.json').read_text(encoding='utf-8'))
    version = release['version']
    if output.exists():
        raise SystemExit('Output already exists. Choose a new empty release path.')
    environment = dict(os.environ)
    for key in ('NODE_OPTIONS', 'PYTHONHOME', 'PYTHONPATH'):
        environment.pop(key, None)
    node_info = json.loads(subprocess.check_output(
        [str(node), '-p', 'JSON.stringify({version:process.versions.node,arch:process.arch})'],
        env=environment, text=True, creationflags=0x08000000))
    python_info = json.loads(subprocess.check_output(
        [str(python_home / 'python.exe'), '-I', '-c',
         'import json,sys,struct; from importlib.metadata import version; '
         'print(json.dumps({"version":list(sys.version_info[:2]),"bits":struct.calcsize("P")*8,'
         '"pillow":version("Pillow"),"pypdfium2":version("pypdfium2")}))'],
        env=environment, text=True, creationflags=0x08000000))
    if node_info['arch'] != 'x64' or node_info['version'].split('.')[0] != '24':
        raise SystemExit('Use Node.js 24 x64 (node:sqlite is required).')
    if python_info['version'] != [3, 12] or python_info['bits'] != 64:
        raise SystemExit('Use a complete CPython 3.12 x64 installation.')
    if python_info['pillow'] != '12.3.0' or python_info['pypdfium2'] != '5.14.0':
        raise SystemExit('Install the pinned packages from requirements-build.txt first.')
    output.mkdir(parents=True)
    for name in ROOT_FILES:
        copy_file(source / name, output / name)
    for name in APP_FILES:
        copy_file(source / 'app' / name, output / 'app' / name)
    for file in sorted((source / 'app' / 'public').rglob('*')):
        if file.is_file() and file.suffix in {'.js', '.css', '.html', '.svg', '.txt'}:
            copy_file(file, output / 'app' / 'public' / file.relative_to(source / 'app' / 'public'))
    compiler = Path(os.environ.get('SystemRoot', r'C:\Windows')) / 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
    subprocess.run([str(compiler), '/nologo', '/target:winexe', '/optimize+',
                    f'/out:{output / "app" / "folder-picker.exe"}',
                    '/reference:System.Windows.Forms.dll', '/reference:System.Drawing.dll',
                    str(source / 'app' / 'FolderPicker.cs')],
                   check=True, creationflags=0x08000000)
    copy_file(node, output / 'runtime/node/node.exe')
    # This file contains Node's bundled third-party notices as well as its license.
    for file in (source / 'licenses').rglob('*'):
        if file.is_file():
            copy_file(file, output / 'licenses' / file.relative_to(source / 'licenses'))
    runtime = output / 'runtime/python'
    for name in ['python.exe', 'python3.dll', 'python312.dll', 'vcruntime140.dll',
                 'vcruntime140_1.dll', 'LICENSE.txt']:
        copy_file(python_home / name, runtime / name)
    ignore = shutil.ignore_patterns('__pycache__', '*.pyc', '*.pyo', 'test', 'tests')
    shutil.copytree(python_home / 'DLLs', runtime / 'DLLs', ignore=ignore)
    shutil.copytree(python_home / 'Lib', runtime / 'Lib', ignore=shutil.ignore_patterns(
        'site-packages', '__pycache__', '*.pyc', '*.pyo', 'test', 'tests', 'idlelib',
        'tkinter', 'turtledemo', 'ensurepip', 'venv', '__phello__'))
    for name in ['PIL', 'pillow-12.3.0.dist-info', 'pypdfium2', 'pypdfium2_raw',
                 'pypdfium2_cfg', 'pypdfium2-5.14.0.dist-info']:
        shutil.copytree(python_home / 'Lib/site-packages' / name,
                        runtime / 'Lib/site-packages' / name, ignore=ignore)
    (runtime / 'python312._pth').write_text('DLLs\nLib\nLib/site-packages\n', encoding='ascii')
    copy_file(python_home / 'LICENSE.txt', output / 'licenses/Python-LICENSE.txt')
    (output / 'runtime-versions.json').write_text(json.dumps(
        {'node': node_info, 'python': python_info}, indent=2), encoding='utf-8')
    (output / '版本信息.txt').write_text(
        f'项目资料台 {version} Windows x64 便携体验版\n发行日：{release["date"]}\n'
        '首次使用数据为空；包含离线运行时。\n', encoding='utf-8')
    files = [p for p in sorted(output.rglob('*')) if p.is_file()]
    manifest = {p.relative_to(output).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
                for p in files}
    manifest_path = output / '文件校验.json'
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
    archive = output.parent / f'project-desk-{version}-windows-x64.zip'
    if archive.exists():
        raise SystemExit('Archive already exists. Move it or choose a new output parent.')
    with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as package:
        for file in files + [manifest_path]:
            package.write(file, Path(f'项目资料台-{version}') / file.relative_to(output))
    with zipfile.ZipFile(archive) as package:
        if package.testzip() is not None:
            raise SystemExit('Archive integrity check failed.')
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    archive.with_suffix('.zip.sha256.txt').write_text(f'{digest}  {archive.name}\n', encoding='ascii')
    print(json.dumps({'zip': str(archive), 'bytes': archive.stat().st_size,
                      'files': len(files) + 1, 'sha256': digest}, ensure_ascii=False))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--node', type=Path, required=True, help='Node.js 24 x64 node.exe')
    parser.add_argument('--python-home', type=Path, required=True, help='CPython 3.12 x64 directory')
    parser.add_argument('--output', type=Path, required=True, help='A new output directory')
    args = parser.parse_args()
    build(Path(__file__).resolve().parent.parent, args.output.resolve(),
          args.node.resolve(), args.python_home.resolve())
