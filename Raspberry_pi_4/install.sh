#!/bin/sh
# Run INSIDE overlayroot-chroot, with the complete release staged under /run.
set -eu
release=${1:?Usage: install.sh /run/student-attention-release}
trap 'result=$?; printf "%s\n" "$result" > "$release/install.exit"' EXIT
target=/home/pi/StudentAttention/Raspberry_pi_4
test -f "$release/agent.py"
test -f "$release/mediamtx"  # /run may be mounted noexec; execute only after installing.
test -f "$release/.env"
test -f "$release/mediamtx.local.yml"
backup=/home/pi/StudentAttention/backups/$(date +%Y%m%d-%H%M%S)
mkdir -p "$backup" "$target"
if [ -d /home/pi/StudentAttention/rashberry_pi_4 ]; then
  cp -a /home/pi/StudentAttention/rashberry_pi_4 "$backup/legacy"
fi
if [ -f "$target/agent.py" ]; then
  cp -a "$target" "$backup/current"
fi
cp -a "$release/." "$target/"
chown -R pi:pi "$target" "$backup"
chmod 600 "$target/.env" "$target/mediamtx.local.yml"
chmod 755 "$target/mediamtx"
install -m 644 "$release/systemd/"*.service /etc/systemd/system/
install -m 755 "$release/student-attention-poweroff" /usr/local/sbin/student-attention-poweroff
printf '%s\n' 'pi ALL=(root) NOPASSWD: /usr/local/sbin/student-attention-poweroff' > /etc/sudoers.d/student-attention
chmod 440 /etc/sudoers.d/student-attention
visudo -cf /etc/sudoers.d/student-attention
mkdir -p /etc/systemd/journald.conf.d
printf '%s\n' '[Journal]' 'Storage=volatile' 'RuntimeMaxUse=24M' 'RateLimitIntervalSec=30s' 'RateLimitBurst=200' > /etc/systemd/journald.conf.d/student-attention.conf
systemctl --root=/ disable classlens-camera.service classlens-media.service 2>/dev/null || true
systemctl --root=/ enable student-attention-media.service student-attention-camera.service
if [ "${2:-preserve}" = headless ]; then
  systemctl --root=/ set-default multi-user.target
fi
printf '%s\n' 'Installed persistent release. Exit chroot, verify root/boot are read-only, then reboot.'
