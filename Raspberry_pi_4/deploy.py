"""Deploy from this workspace through SSH; no SSH password is stored in files.

Windows: set FACEPI_SSH_PASSWORD in the invoking process, or use a PuTTY key.
Linux: ssh keys/agent. Persistent writes use the Pi's existing overlayroot-chroot.
"""
import argparse
import io
import os
import secrets
import shlex
import subprocess
import tarfile
import time
from pathlib import Path
from urllib.parse import quote, urlparse

MEDIA_SHA256 = 'a1621ba39c0aa58430809df28263865e37a75bb4d2f1c87e642ddf5f3f67b19d'
HOST_KEY = 'SHA256:5I/Lt6HEODLCmyGXRgKTjNm4iWs/3o0VQNg0fXefVJ8'
ROOT = Path(__file__).resolve().parent


def ssh_command(host):
    if os.name == 'nt':
        command = [r'C:\Program Files\PuTTY\plink.exe', '-batch', '-ssh', '-T', '-hostkey', HOST_KEY, '-l', 'pi']
        if os.environ.get('FACEPI_SSH_PASSWORD'):
            command += ['-noagent', '-pw', os.environ['FACEPI_SSH_PASSWORD']]
        return command + [host]
    return ['ssh', '-o', 'BatchMode=yes', 'pi@' + host]


def run(command, data=None):
    result = subprocess.run(command, input=data if data is not None else b'', stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=180)
    if result.returncode:
        # Never include argv: it may contain an SSH password.
        raise RuntimeError('SSH/deployment failed: ' + result.stderr.decode(errors='replace')[-2000:])
    if result.stderr:
        print(result.stderr.decode(errors='replace'), end='', flush=True)
    return result.stdout.decode(errors='replace')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--host', default='facepi.local')
    parser.add_argument('--ssh-host', help='Optional verified IP for SSH when mDNS is unavailable; service URLs still use --host.')
    parser.add_argument('--reboot', action='store_true')
    parser.add_argument('--headless', action='store_true', help='Boot to console without the desktop; keep web, SSH and Wi-Fi.')
    args = parser.parse_args()
    connection = ssh_command(args.ssh_host or args.host)
    old_boot = run(connection + ['cat /proc/sys/kernel/random/boot_id']).strip()
    env_path = ROOT.parent / 'backend' / '.env'
    previous = env_path.read_text(encoding='utf-8') if env_path.exists() else ''
    values = dict(line.split('=', 1) for line in previous.splitlines() if '=' in line and not line.lstrip().startswith('#'))
    token = values.get('PI_TOKEN') or secrets.token_hex(32)
    old_rtsp = urlparse(values.get('PI_RTSP_URL', ''))
    media_password = old_rtsp.password or secrets.token_hex(32)
    private_env = ('PI_TOKEN=' + token + '\nCAMERA_DEVICE=/dev/v4l/by-id/usb-Jieli_Technology_USB_Composite_Device-video-index0\n'
                   'CAMERA_STATE_FILE=/run/student-attention/state.json\n')
    media = (ROOT / 'mediamtx.example.yml').read_text().replace('REPLACE_WITH_PRIVATE_PASSWORD', media_password)
    archive = io.BytesIO()
    with tarfile.open(fileobj=archive, mode='w:gz') as tar:
        for name in ['agent.py', 'install.sh', 'student-attention-poweroff', 'systemd', 'test']:
            tar.add(ROOT / name, arcname=name, filter=lambda info: None if '__pycache__' in info.name else info)
        for name, contents in [('.env', private_env), ('mediamtx.local.yml', media)]:
            payload = contents.encode()
            info = tarfile.TarInfo(name)
            info.size, info.mode = len(payload), 0o600
            tar.addfile(info, io.BytesIO(payload))
    stage = '/run/student-attention-release'
    print('Staging source and private configuration in Pi RAM...', flush=True)
    run(connection + ['sudo install -d -m 700 -o pi -g pi ' + stage])
    run(connection + ['tar -xzf - -C ' + stage], archive.getvalue())
    script = '''set -eu
stage=/run/student-attention-release
media=/home/pi/StudentAttention/Raspberry_pi_4/mediamtx
test -x "$media" || media=/home/pi/StudentAttention/rashberry_pi_4/mediamtx
test "$(sha256sum "$media" | cut -d ' ' -f 1)" = MEDIA_CHECKSUM
cp "$media" "$stage/mediamtx"
chmod 755 "$stage/mediamtx"
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s "$stage/test" -v
sudo -n systemctl stop classlens-camera.service classlens-media.service </dev/null 2>/dev/null || true
sudo -n systemctl stop student-attention-camera.service student-attention-media.service </dev/null 2>/dev/null || true
: > "$stage/install.exit"
sudo -n /usr/sbin/overlayroot-chroot /bin/sh "$stage/install.sh" "$stage" BOOT_PROFILE </dev/null || true
test "$(cat "$stage/install.exit")" = 0
sync
sudo -n mount -o remount,ro /media/root-ro </dev/null || true
findmnt -T /media/root-ro
findmnt -T /boot/firmware
test "$(findmnt -n -o VFS-OPTIONS -T /boot/firmware | cut -d , -f 1)" = ro
if [ "$(findmnt -n -o VFS-OPTIONS -T /media/root-ro | cut -d , -f 1)" != ro ]; then
  printf '%s\n' 'Root remount is busy; a clean reboot is required immediately to restore read-only protection.'
  test REBOOT_ALLOWED = yes
fi
'''.replace('MEDIA_CHECKSUM', MEDIA_SHA256).replace('REBOOT_ALLOWED', 'yes' if args.reboot else 'no').replace('BOOT_PROFILE', 'headless' if args.headless else 'preserve')
    print(run(connection + ['bash -s'], script.encode()), flush=True)
    replacements = {'PI_CONTROL_URL': 'http://' + args.host + ':8765', 'PI_TOKEN': token,
                    'PI_RTSP_URL': 'rtsp://studentattention:' + quote(media_password, safe='') + '@' + args.host + ':8554/camera'}
    lines = [line for line in previous.splitlines() if line.split('=', 1)[0] not in replacements]
    lines += [key + '=' + value for key, value in replacements.items()]
    env_path.write_text('\n'.join(lines) + '\n', encoding='utf-8')
    print('Private backend/.env configured; secrets omitted.', flush=True)
    if args.reboot:
        print(run(connection + ['sudo systemd-run --unit=student-attention-deploy-reboot --on-active=3s /usr/bin/systemctl reboot']), flush=True)
        print('Pi reboot scheduled. Camera defaults to OFF on the next boot.', flush=True)
        verify = '''set -eu
test "$(cat /proc/sys/kernel/random/boot_id)" != OLD_BOOT
systemctl is-active --quiet student-attention-camera.service
systemctl is-active --quiet student-attention-media.service
test "$(findmnt -n -o VFS-OPTIONS -T /media/root-ro | cut -d , -f 1)" = ro
test "$(findmnt -n -o VFS-OPTIONS -T /boot/firmware | cut -d , -f 1)" = ro
printf '%s\n' 'Persistent services active after reboot; root and boot are read-only.'
'''.replace('OLD_BOOT', shlex.quote(old_boot))
        for attempt in range(30):
            time.sleep(3)
            try:
                print(run(connection + ['bash -s'], verify.encode()), flush=True)
                break
            except RuntimeError:
                if attempt == 29:
                    raise RuntimeError('Post-reboot verification failed; inspect Pi via SSH before use.') from None


if __name__ == '__main__':
    main()
