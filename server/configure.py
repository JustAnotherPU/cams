#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 JustAnotherPU
"""jap-cams setup: writes /opt/jap-cams/cams.json (0600, owned by the service user) from what Protect says.

    sudo python3 /opt/jap-cams/configure.py                    asks for Protect and the cameras' roles (again: Enter
                                                               keeps each answer; new cameras are found)
    sudo python3 /opt/jap-cams/configure.py --add-car CODE     lets a car in (the code its app shows)
    sudo python3 /opt/jap-cams/configure.py --remove-car CODE
    sudo python3 /opt/jap-cams/configure.py --cars             lists the cars' codes

Protect: its address (the console, e.g. 192.0.2.1) and a local user with the View Only role (Protect, Settings,
Admins and Users). The cameras and their RTSPS channels come from Protect's camera list; a channel with RTSP off is
named so that it can be turned on in Protect (a View Only user cannot), then this is run again.
Roles (all optional), for the car's choice of the big picture: door (a ring or a person there takes over), garage
(left out while the car is at home), day and night (the default picture).
"""
import getpass, json, os, pwd, re, sys, tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import serve  # noqa: E402

CONF = os.environ.get('JAP_CAMS_CONF', '/opt/jap-cams/cams.json')
USER = 'japcams'
CODE = re.compile(r'[A-Z0-9]{4}(-[A-Z0-9]{4}){3}')


def load():
    try:
        return json.load(open(CONF))
    except FileNotFoundError:
        return {}


def write(conf, path=None, user=USER):
    """atomically, 0600, owned by the service user (when it exists)"""
    path = path or CONF
    d = os.path.dirname(path) or '.'
    fd, tmp = tempfile.mkstemp(dir=d, prefix='.cams-')
    with os.fdopen(fd, 'w') as f:
        json.dump(conf, f, indent=1, ensure_ascii=False)
        f.write('\n')
    os.chmod(tmp, 0o600)
    try:
        pw = pwd.getpwnam(user)
        os.chown(tmp, pw.pw_uid, pw.pw_gid)
    except (KeyError, PermissionError):
        pass
    os.replace(tmp, path)


def merge(old, found, roles):
    """the new cams.json: the discovered cameras in Protect's order, each keeping its old label and hand-set channel
    urls; roles {role: camera name}; the cars, the Protect login and every other key kept"""
    before = {c.get('name'): c for c in old.get('cams', [])}
    cams = []
    for c in found:
        c = json.loads(json.dumps(c))                  # the discovered list stays as it is
        c.pop('doorbell', None)
        o = before.get(c['name'], {})
        c['label'] = o.get('label', c['name'])
        urls = {ch.get('id'): ch['url'] for ch in o.get('channels', []) if ch.get('url')}
        for ch in c['channels']:
            if ch['id'] in urls:
                ch['url'] = urls[ch['id']]
        c['roles'] = [r for r in serve.ROLES if roles.get(r) == c['name']]
        cams.append(c)
    return dict(old, cams=cams)


def ask(q, default=''):
    a = input('%s%s: ' % (q, ' [%s]' % default if default else '')).strip()
    return a or default


def setup():
    conf = load()
    p = dict(conf.get('protect') or {})
    print('UniFi Protect: the console\'s address and a local user with the View Only role.')
    p['host'] = ask('Protect address', p.get('host', ''))
    p['username'] = ask('User', p.get('username', ''))
    pw = getpass.getpass('Password%s: ' % (' [Enter keeps it]' if p.get('password') else ''))
    if pw:
        p['password'] = pw
    conf['protect'] = p
    with tempfile.TemporaryDirectory(prefix='jap-cams-setup-') as tmp:   # no root-owned Protect session left behind
        os.environ['JAP_CAMS_STATE'] = serve.STATE = tmp
        try:
            found, off = serve.discover(conf)
        except serve.ProtectError as e:
            sys.exit('Protect: %s (%s)' % (e.args[0], e.args[1]))
    if off:
        print('\nRTSPS is off on these channels (turn it on in Protect, in each camera\'s Advanced settings, then run this again):')
        for x in off:
            print('  ' + x)
    if not found:
        sys.exit('\nNo camera with an RTSPS channel: nothing to show.')
    print('\nCameras:')
    for k, c in enumerate(found):
        print('  %2d  %s%s (%s)' % (k + 1, c['name'], ' [doorbell]' if c['doorbell'] else '',
                                    ', '.join('%dx%d' % (ch['w'], ch['h']) for ch in c['channels'])))
    old = {r: c['name'] for c in conf.get('cams', []) for r in c.get('roles', [])}
    bell = next((c['name'] for c in found if c['doorbell']), '')
    roles = {}
    for r, q in (('door', 'Door camera (a ring or a person there takes the big picture)'),
                 ('garage', 'Garage camera (left out while the car is at home)'),
                 ('day', 'Default camera by day'), ('night', 'Default camera at night')):
        cur = old.get(r, bell if r == 'door' else '')
        k = next((str(i + 1) for i, c in enumerate(found) if c['name'] == cur), '')
        while True:
            a = ask('%s: number, or - for none' % q, k)
            if a in ('', '-'):
                break
            if a.isdigit() and 1 <= int(a) <= len(found):
                roles[r] = found[int(a) - 1]['name']
                break
    conf = merge(conf, found, roles)
    conf.setdefault('cars', [])
    write(conf)
    print('\nWrote %s (%d cameras). Cars allowed: %d.' % (CONF, len(conf['cams']), len(conf['cars'])))


def cars(cmd, code=None):
    conf = load()
    if not conf:
        sys.exit('%s does not exist yet: run this without arguments first' % CONF)
    have = list(conf.get('cars') or [])
    if cmd == '--cars':
        print('\n'.join(have) or '(none)'); return
    code = (code or '').strip().upper()
    if not CODE.fullmatch(code):
        sys.exit('a car code looks like ABCD-EFGH-JKLM-NPQR (the Cameras app shows it)')
    if cmd == '--add-car' and code not in have:
        have.append(code)
    if cmd == '--remove-car':
        have = [c for c in have if c != code]
    conf['cars'] = have
    write(conf)
    print('cars: %d' % len(have))


def selftest():
    d = tempfile.mkdtemp()
    path = os.path.join(d, 'cams.json')
    old = {'cars': ['AAAA-BBBB-CCCC-DDDD'], 'protect': {'host': 'h', 'username': 'u', 'password': 'p'}, 'maxrate_k': 6000,
           'cams': [{'name': 'Door', 'label': 'Front door', 'roles': ['door'], 'channels': [{'id': 1, 'url': 'rtsp://127.0.0.1:1/x'}]},
                    {'name': 'Gone', 'channels': []}]}
    found = [{'name': 'Door', 'label': 'Door', 'protectId': 'c0', 'doorbell': True, 'channels': [{'id': 1, 'w': 1600, 'h': 1200, 'fps': 30, 'alias': 'a1'}]},
             {'name': 'Garage', 'label': 'Garage', 'protectId': 'c1', 'doorbell': False, 'channels': [{'id': 0, 'w': 1920, 'h': 1080, 'fps': 30, 'alias': 'g0'}]}]
    new = merge(old, found, {'door': 'Door', 'night': 'Door', 'day': 'Garage'})
    assert new['cars'] == old['cars'] and new['protect'] == old['protect'] and new['maxrate_k'] == 6000
    assert [c['name'] for c in new['cams']] == ['Door', 'Garage'], 'a camera gone from Protect goes'
    door, garage = new['cams']
    assert door['label'] == 'Front door' and door['roles'] == ['door', 'night'] and 'doorbell' not in door
    assert door['channels'][0]['url'] == 'rtsp://127.0.0.1:1/x' and door['channels'][0]['alias'] == 'a1', 'a hand-set url stays'
    assert garage['label'] == 'Garage' and garage['roles'] == ['day'] and 'url' not in garage['channels'][0]
    assert found[0]['doorbell'] is True and 'url' not in found[0]['channels'][0], 'the discovered list is not changed'
    write(new, path, user='no-such-user-here')
    assert os.stat(path).st_mode & 0o777 == 0o600 and json.load(open(path)) == new
    assert CODE.fullmatch('ABCD-EFGH-JKLM-NPQR') and not CODE.fullmatch('ABCD-EFGH') and not CODE.fullmatch('abcd-efgh-jklm-npqr')
    import shutil
    shutil.rmtree(d)
    print('selftest ok')


if __name__ == '__main__':
    a = sys.argv[1:]
    if a == ['--selftest']:
        selftest()
    elif a and a[0] in ('--add-car', '--remove-car') and len(a) == 2 or a == ['--cars']:
        cars(*a)
    elif not a:
        setup()
    else:
        sys.exit(__doc__)
