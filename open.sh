#!/usr/bin/env bash
set -euo pipefail
systemctl --user start ohif-local.service
for attempt in {1..50}; do
  if curl --silent --fail --output /dev/null http://127.0.0.1:3000/localbasic; then
    exec omarchy launch webapp http://127.0.0.1:3000/localbasic
  fi
  sleep 0.1
done
echo 'OHIF не запустился. Подробности: journalctl --user -u ohif-local.service -n 30' >&2
exit 1
