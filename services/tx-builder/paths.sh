# Code paths for the newest version of each zx package (Hakuzaru, Sophia and their
# dependencies) that GajuDesk installs. Sourced by run.sh and test.sh.
zx_paths() {
  lib="${ZOMP_DIR:-$HOME/.zx/zomp}/lib/otpr"
  for app in "$lib"/*; do
    printf ' -pa %s/%s/ebin' "$app" "$(ls -1 "$app" | sort -V | tail -1)"
  done
}
