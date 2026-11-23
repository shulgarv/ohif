{
  description = "OHIF 3.13.12 — локальный DICOM-просмотрщик: Python-сервер и локальные патчи вьюера";

  # Единственный источник версии пакетов. Ветка пинится в flake.lock —
  # см. `nix flake update` и `git diff flake.lock`.
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" ];
      # Одинаковые наборы outputs для каждой поддерживаемой архитектуры.
      forAllSystems = f: nixpkgs.lib.genAttrs systems
        (system: f self system nixpkgs.legacyPackages.${system});
    in
    {
      # packages.<system>.default → то, что заберёт NixOS-конфиг.
      packages = forAllSystems (_self: _system: pkgs: {
        default = self.packages.${pkgs.stdenv.hostPlatform.system}.ohif-local;
        ohif-local = pkgs.callPackage ./nix/ohif-local.nix { };
      });

      # apps.<system>.default → `nix run` / `nix run .#`
      apps = forAllSystems (_self: _system: pkgs: {
        default = {
          type = "app";
          program = "${self.packages.${pkgs.stdenv.hostPlatform.system}.ohif-local}/bin/ohif-local";
          meta.description = "Запустить локальный OHIF на http://127.0.0.1:3000/localbasic";
        };
      });

      # `nix develop` → окружение для правки скриптов и проверок из verification/
      devShells = forAllSystems (_self: _system: pkgs: {
        default = pkgs.mkShell {
          packages = (with pkgs; [
            nodejs_22      # verification/*.cjs
            curl
            unzip
            jq
          ]) ++ [
            # pydicom той же версии, что в requirements-conversion.txt
            (pkgs.python3.withPackages (ps: [ ps.pydicom ]))
          ];
          shellHook = ''
            echo "OHIF dev shell: python $(python3 -V 2>&1 | cut -d' ' -f2), node $(node -v)"
            echo "  python3 server.py            # поднять локальный сервер"
            echo "  OHIF_SITE=\$PWD/www nix run .  # запустить пакет из flake"
            echo "  node verification/test-missing-position.cjs"
          '';
        };
      });

      formatter = forAllSystems (_self: _system: pkgs: pkgs.nixfmt);
    };
}
