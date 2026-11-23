#!/bin/sh
# Обёртка запуска OHIF: пути Python и каталога с кодом подставляет nix при сборке.
#
# OHIF_SITE — каталог с собранным вьюером (см. install-viewer.py).
# По умолчанию — рабочий каталог разработки, а не /nix/store: сборка вьюера
# в git не хранится и создаётся локально.
: "${OHIF_SITE:=$HOME/Work/ohif/www}"
export OHIF_SITE
exec @python@ @site@/server.py "$@"
