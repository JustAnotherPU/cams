#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Robert Nisipeanu
"""ABI checks against the head unit's libvsomeip3.so.3.1.34. Needs binutils
(readelf); runs in ../docker.

    abi.py dump LIB > abi/libvsomeip3.so.3.symbols
        exported symbols of LIB as "name TYPE size" lines
    abi.py stub SYMBOLS OUT.S
        assembly for a link-only stub exporting the same symbols
    abi.py vtable LIB HEADER
        the virtual methods of vsomeip::application in HEADER, in declaration
        order, against the slots of LIB's application_impl vtable
    abi.py check BINARY SYMBOLS
        a build for the unit: loader /lib/ld-linux-x86-64.so.2 (the unit has
        no /lib64), every vsomeip_v3 import exported by the unit's library,
        no glibc newer than 2.27, no libstdc++ newer than the unit's 6.0.24
"""
import hashlib
import re
import subprocess
import sys

INTERP = '/lib/ld-linux-x86-64.so.2'
# Newest symbol versions the unit's glibc 2.27 and libstdc++.so.6.0.24 define.
MAX_VERSION = {'GLIBC': (2, 27), 'GLIBCXX': (3, 4, 24), 'CXXABI': (1, 3, 11)}


def run(*args):
    return subprocess.run(args, check=True, stdout=subprocess.PIPE,
                          universal_newlines=True).stdout


def dyn_symbols(path):
    """(name, type, size, defined, version) for each .dynsym entry."""
    out = []
    for line in run('readelf', '--dyn-syms', '-W', path).splitlines():
        p = line.split()
        if len(p) < 8 or not p[0].endswith(':') or p[0] == 'Num:':
            continue
        name = p[7]
        version = ''
        if '@' in name:
            name, version = name.split('@', 1)
            version = version.lstrip('@')
        out.append((name, p[3], int(p[2], 0), p[6] != 'UND', version))
    return out


def load_symbols(path):
    syms = {}
    for line in open(path):
        line = line.split('#', 1)[0].strip()
        if line:
            name, kind, size = line.split()
            syms[name] = (kind, int(size))
    return syms


def cmd_dump(lib):
    digest = hashlib.sha256(open(lib, 'rb').read()).hexdigest()
    print('# SPDX-License-Identifier: MPL-2.0')
    print('# Copyright (C) 2026 Robert Nisipeanu')
    print('# Exported symbols of the head unit\'s /usr/lib/libvsomeip3.so.3.1.34')
    print('# (sha256 %s):' % digest)
    print('# vsomeip (https://github.com/COVESA/vsomeip), COVESA, MPL-2.0.')
    print('# Regenerate: tools/abi.py dump <lib>')
    for name, kind, size, defined, _ in sorted(dyn_symbols(lib)):
        if defined and kind in ('FUNC', 'OBJECT'):
            print('%s %s %d' % (name, kind, size))


def cmd_stub(symbols, out):
    with open(out, 'w') as f:
        for name, (kind, size) in sorted(load_symbols(symbols).items()):
            if kind == 'FUNC':
                f.write('.text\n.globl %s\n.type %s, @function\n%s:\n\tret\n' % (name, name, name))
            else:
                f.write('.data\n.globl %s\n.type %s, @object\n.size %s, %d\n%s:\n\t.zero %d\n'
                        % (name, name, name, size, name, max(size, 1)))
        f.write('.section .note.GNU-stack,"",@progbits\n')


def header_virtuals(header):
    src = open(header).read()
    src = re.sub(r'/\*.*?\*/', '', src, flags=re.S)
    src = re.sub(r'//[^\n]*', '', src)
    return re.findall(r'virtual\s+[^;{(]*?(~?\w+)\s*\(', src)


def cmd_vtable(lib, header):
    by_addr = {}
    vtable = None
    for line in run('readelf', '--dyn-syms', '-W', lib).splitlines():
        p = line.split()
        if len(p) >= 8 and p[0].endswith(':') and p[6] != 'UND' and p[0] != 'Num:':
            by_addr.setdefault(int(p[1], 16), p[7].split('@')[0])
            if p[7] == '_ZTVN10vsomeip_v316application_implE':
                vtable = int(p[1], 16)
    if vtable is None:
        sys.exit('no application_impl vtable in %s' % lib)
    slots = {}
    for line in run('readelf', '-rW', lib).splitlines():
        p = line.split()
        if len(p) >= 4 and re.fullmatch(r'[0-9a-f]{16}', p[0]):
            off = int(p[0], 16)
            if 'RELATIVE' in p[2]:
                slots[off] = by_addr.get(int(p[3], 16), hex(int(p[3], 16)))
            elif len(p) >= 5:
                slots[off] = p[4]
    names = header_virtuals(header)
    # Slot 0/1 are the complete and deleting destructors, then one slot per
    # remaining virtual, after the offset-to-top and typeinfo words.
    want = ['~application', '~application'] + names[1:]
    problems = []
    for i, n in enumerate(want):
        got = slots.get(vtable + 16 + 8 * i, '?')
        method = 'D' if n.startswith('~') else str(len(n)) + n
        if method not in got:
            problems.append('slot %d: header %s, library %s' % (i, n, got))
    for p in problems:
        print(p)
    print('%d vtable slots checked, %d mismatches' % (len(want), len(problems)))
    return 1 if problems else 0


def version_tuple(v):
    return tuple(int(x) for x in v.split('.'))


def cmd_check(binary, symbols):
    problems = []
    unit = load_symbols(symbols)
    hdr = run('readelf', '-hlW', binary)
    if 'X86-64' not in hdr or 'ELF64' not in hdr:
        problems.append('not an ELF64 x86-64 binary')
    interp = re.findall(r'Requesting program interpreter: ([^\]]+)\]', hdr)
    if interp and interp != [INTERP]:
        problems.append('interpreter %s, need %s' % (interp, INTERP))
    for name, _, _, defined, version in dyn_symbols(binary):
        if not defined and 'vsomeip_v3' in name and name not in unit:
            problems.append('imports %s, which the unit\'s libvsomeip3 does not export' % name)
        m = re.match(r'(GLIBC|GLIBCXX|CXXABI)_([0-9.]+)$', version)
        if m and version_tuple(m.group(2)) > MAX_VERSION[m.group(1)]:
            problems.append('%s needs %s' % (name, version))
    for p in problems:
        print(p)
    print('%s: %s' % (binary, 'ok' if not problems else '%d problems' % len(problems)))
    return 1 if problems else 0


def main(argv):
    cmds = {'dump': (cmd_dump, 1), 'stub': (cmd_stub, 2), 'vtable': (cmd_vtable, 2),
            'check': (cmd_check, 2)}
    if len(argv) < 2 or argv[1] not in cmds or len(argv) - 2 != cmds[argv[1]][1]:
        sys.exit(__doc__)
    fn, _ = cmds[argv[1]]
    return fn(*argv[2:]) or 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
