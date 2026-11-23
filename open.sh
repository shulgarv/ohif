#!/usr/bin/env bash
# Запуск локального OHIF: поднять сервис пользователя, дождаться порта 3000,
# открыть адрес в браузере. Браузер можно переопределить: OHIF_BROWSER=...
set -euo pipefail
systemctl --user start ohif-local.service
for attempt in {1..50}; do
  if curl --silent --fail --output /dev/null http://127.0.0.1:3000/localbasic; then
    exec "${OHIF_BROWSER:-xdg-open}" http://127.0.0.1:3000/localbasic
  fi
  sleep 0.1
done
echo 'OHIF не запустился. Подробности: journalctl --user -u ohif-local.service -n 30' >&2
exit 1
