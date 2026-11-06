#!/usr/bin/env python3
"""Check public Git/npm file sets without reading or changing private evidence."""
from pathlib import Path
import argparse
import json
import os
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--npm-list', type=Path, help='JSON output from npm pack --dry-run --json')
args = parser.parse_args()
policy = json.loads((ROOT / 'public-files.json').read_text())
allowed = set(policy['files'])
for pattern in policy['patterns']:
    allowed.update(p.relative_to(ROOT).as_posix() for p in ROOT.glob(pattern) if p.is_file())
errors = []
for name in allowed:
    p = ROOT / name
    if not p.is_file() or p.is_symlink():
        errors.append({'path': name, 'reason': 'missing or symlinked public input'})
    elif subprocess.run(['git', 'check-ignore', '-q', '--no-index', name], cwd=ROOT).returncode == 0:
        errors.append({'path': name, 'reason': 'public input unexpectedly ignored'})
raw = subprocess.check_output(['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], cwd=ROOT)
candidates = set(raw.decode().strip('\0').split('\0')) - {''}
for name in sorted(candidates - allowed):
    errors.append({'path': name, 'reason': 'Git candidate outside public allowlist'})
patterns = {
    'private network address': r'\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})\b',
    'personal absolute directory': r'/(?:home|Users)/[\w.-]+|' + '/' + r'Volumes/[^\s\"\x27]+',
    'private key': r'-----BEGIN (?:OPENSSH |RSA |EC |DSA |ENCRYPTED )?PRIVATE KEY-----',
    'provider key': r'\b(?:sk-[A-Za-z0-9_-]{24,}|gh[pousr]_[A-Za-z0-9]{25,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[0-9A-Z]{16})\b',
    'credential in URL': r'\b[a-z][a-z0-9+.-]*://[^\s/:@]+:[^\s/@]+@',
    'JWT': r'\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}',
}
for name in sorted(allowed):
    p = ROOT / name
    if not p.is_file() or p.is_symlink():
        continue
    text = p.read_text()
    for kind, pattern in patterns.items():
        for match in re.finditer(pattern, text):
            errors.append({'path': name, 'line': text.count('\n', 0, match.start()) + 1, 'reason': kind})
    literal = r"""(?i)\b(?:password|passwd|adminToken|api[_-]?key|client_secret|access_token|refresh_token)\b["']?\s*[:=]\s*["']([^"'\r\n]{8,})["']"""
    for match in re.finditer(literal, text):
        value = match.group(1)
        if not re.fullmatch(r'(?:<.*>|PRIVATE|REDACTED|CHANGE_ME|EXAMPLE_.*)', value, re.I):
            errors.append({'path': name, 'line': text.count('\n', 0, match.start()) + 1,
                           'reason': 'literal credential candidate'})
    if p.suffix == '.md':
        for target in re.findall(r'\]\(([^)]+)\)', text):
            if '://' in target or target.startswith('#'):
                continue
            normalized = os.path.normpath(str(Path(name).parent / target.split('#')[0]))
            if normalized not in allowed:
                errors.append({'path': name, 'reason': 'link outside public scope', 'target': normalized})
if args.npm_list:
    packages = json.loads(args.npm_list.read_text())
    for package in packages:
        for item in package['files']:
            if item['path'] not in allowed:
                errors.append({'path': item['path'], 'reason': 'npm file outside public allowlist'})
print(json.dumps({'status': 'FAIL' if errors else 'PASS', 'public_files': len(allowed),
                  'git_candidates': len(candidates), 'npm_checked': bool(args.npm_list), 'errors': errors}, indent=2))
sys.exit(bool(errors))
