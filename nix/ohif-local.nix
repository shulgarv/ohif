# Пакет приложения: Python-сервер, который отдаёт собранный вьюер OHIF.
#
# Что здесь упаковывается: только код из git. Каталог www/ (226 МБ готовых
# бандлов) получается из официального образа ohif/app скриптом install-viewer.py
# и в git не хранится — поэтому он передаётся серверу во время запуска через
# переменную OHIF_SITE, а не вшивается в /nix/store.
{ lib
, stdenv
, python3
}:

let
  # pydicom — единственная внешняя зависимость Python (см. requirements-conversion.txt)
  pythonEnv = python3.withPackages (ps: [ ps.pydicom ]);
in
stdenv.mkDerivation {
  pname = "ohif-local";
  version = "3.13.12";

  # src указывает на корень flake: в сборку попадают только файлы из git
  src = lib.cleanSource ./..;

  # Компиляции нет: это скрипты. Сборка = раскладка файлов по $out.
  dontBuild = true;
  doCheck = false; # test-*.py требуют фикстур и внешних файлов, гоняются в devShell

  installPhase = ''
    runHook preInstall
    install -d "$out/share/ohif" "$out/bin"
    install -m 0644 server.py local_metadata.py viewer_ui.py installed-version.json \
      "$out/share/ohif/"
    install -m 0644 README.md HANDOFF.md "$out/share/ohif/"

    sed -e "s|@python@|${pythonEnv.interpreter}|" \
        -e "s|@site@|$out/share/ohif|" \
        ${./ohif-local.sh} > "$out/bin/ohif-local"
    chmod 0755 "$out/bin/ohif-local"

    runHook postInstall
  '';

  meta = {
    description = "OHIF local DICOM viewer: loopback HTTP server for the patched 3.13.12 build";
    homepage = "https://github.com/shulgarv/ohif";
    mainProgram = "ohif-local";
    license = lib.licenses.mit;
    platforms = lib.platforms.linux;
  };
}
