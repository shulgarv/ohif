# OHIF: продолжение работы

Перед продолжением настройки OHIF прочитай [HANDOFF.md](HANDOFF.md): там статус
подтверждённых пользователем правок и команды проверок. Подробности установки
и прежних адаптаций находятся в [README.md](README.md).

Основная конфигурация — `app-config.js`. После её изменения синхронизируй
`www/app-config.js` и `www/app-config.js.gz`. Для браузерных проверок используй
искусственные серии из `verification/make-import-fixtures.py`; сохраняй исходные
исследования пользователя без изменений.

Браузерные проверки: `/usr/bin/chromium` в этой системе нет — задай
`OHIF_CHROMIUM_PATH=/run/current-system/sw/bin/brave`; для настоящего GPU
добавь `OHIF_BROWSER_GL=1` (иначе SwiftShader и нет `EXT_texture_norm16`), а
Playwright установи во временную папку и укажи `OHIF_PLAYWRIGHT_PATH`, например
`/tmp/ohif-browser-check/node_modules/playwright`.
