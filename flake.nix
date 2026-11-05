{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs =
    { self, nixpkgs }:
    let
      system = "x86_64-linux";
      pkgs = import nixpkgs {
        inherit system;
        config = {
          allowUnfree = true;
        };
      };
      frontend = pkgs.stdenvNoCC.mkDerivation {
        pname = "cca-demo-frontend";
        version = "1.0.0";
        src = ./src/web;
        nativeBuildInputs = [ pkgs.nodejs_26 pkgs.pnpmConfigHook pkgs.pnpm ];
        pnpmDeps = pkgs.fetchPnpmDeps {
          pname = "cca-demo-frontend";
          version = "1.0.0";
          src = ./src/web;
          pnpm = pkgs.pnpm;
          fetcherVersion = 4;
          hash = "sha256-J4kNLYXUQZ3DwFptbe+ndn971DRmhPGj8pFU1pS6mQM=";
        };
        buildPhase = ''
          runHook preBuild
          pnpm run build
          runHook postBuild
        '';
        installPhase = ''
          mkdir -p $out
          cp -r dist/. $out/
        '';
      };
      app = pkgs.buildGoModule {
        pname = "cca-demo";
        version = "1.0.0";
        src = ./src;
        vendorHash = "sha256-uxHmikWz4yqDFKKjt5YEoBjsQL2pINTnN6lBpLKs4uw=";
        subPackages = [ "." ];
        nativeBuildInputs = [ pkgs.makeWrapper ];
        postInstall = ''
          mv $out/bin/src $out/bin/cca-demo
          mkdir -p $out/web
          cp -r ${frontend} $out/web/dist
          wrapProgram $out/bin/cca-demo --chdir "$out"
        '';
        preBuild = ''
          cp -r ${frontend} web/dist
        '';
      };
    in
    {
      packages.${system}.default = app;
      devShells.${system}.default = pkgs.mkShell {
        name = "cca-demo-shell";

        packages = with pkgs; [
          go
          pnpm
          nodejs_26

          postgresql

          opentofu

          scaleway-cli
          github-cli
          pkgs.nix
          pkgs.docker-client
          pkgs.docker-compose
        ];

        shellHook = ''
          echo "Run the app locally with: docker compose -f src/docker-compose.yaml up --build"
          export TF_VAR_project_id=906f9aec-92b5-4615-9a54-84d399de5231
          export AWS_ACCESS_KEY_ID=$(scw config get access-key)
          export AWS_SECRET_ACCESS_KEY=$(scw config get secret-key)
          export SCW_DEFAULT_PROJECT_ID=906f9aec-92b5-4615-9a54-84d399de5231

         export GRAFANA_URL="https://$TF_VAR_project_id.dashboard.cockpit.scaleway.com"
         export GRAFANA_EXTRA_HEADERS={"X-Auth-Token":"$AWS_SECRET_ACCESS_KEY"}

          export TF_VAR_image_api=rg.fr-par.scw.cloud/cr-cca-demo/api:$(git tag --sort=-v:refname | head -n1 | sed 's/^v//')
          export TF_VAR_image_migrations=rg.fr-par.scw.cloud/cr-cca-demo/migrations:$(git tag --sort=-v:refname | head -n1 | sed 's/^v//')
        '';
      };
    };
}
