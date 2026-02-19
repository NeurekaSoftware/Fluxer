#!/usr/bin/env sh
set -eu

REGISTRY="ghcr.io/neurekasoftware/fluxer"

DEFAULT_BUILD_SHA="local"
DEFAULT_BUILD_NUMBER="local"
DEFAULT_BUILD_TIMESTAMP="0"
DEFAULT_RELEASE_CHANNEL="local"

BUILD_SHA="${BUILD_SHA:-$DEFAULT_BUILD_SHA}"
BUILD_NUMBER="${BUILD_NUMBER:-$DEFAULT_BUILD_NUMBER}"
BUILD_TIMESTAMP="${BUILD_TIMESTAMP:-$DEFAULT_BUILD_TIMESTAMP}"
RELEASE_CHANNEL="${RELEASE_CHANNEL:-$DEFAULT_RELEASE_CHANNEL}"

PUSH=0
DRY_RUN=0
BUILD_ALL=0
LIST_ONLY=0
TARGETS=""

case "$0" in
  */*) SCRIPT_DIR=${0%/*} ;;
  *) SCRIPT_DIR=. ;;
esac
cd "$SCRIPT_DIR"

usage() {
  printf '%s\n' "Usage: ./build.sh [--push] [--dry-run] [--all] [target ...]"
  printf '%s\n' ""
  printf '%s\n' "Targets:"
  printf '%s\n' "  server           Build Fluxer monolith server image"
  printf '%s\n' "  relay            Build Fluxer relay image (optional federation)"
  printf '%s\n' "  relay-directory  Build Fluxer relay directory image (optional federation)"
  printf '%s\n' ""
  printf '%s\n' "Options:"
  printf '%s\n' "  --all       Build all targets"
  printf '%s\n' "  --push      Push built images to $REGISTRY"
  printf '%s\n' "  --dry-run   Print docker commands without executing"
  printf '%s\n' "  --list      Show supported targets and Docker mappings"
  printf '%s\n' "  --help      Show this help message"
}

print_targets() {
  printf '%s\n' "Supported targets:"
  printf '%s\n' "  server -> context=. dockerfile=fluxer_server/Dockerfile tag=$REGISTRY:server"
  printf '%s\n' "  relay -> context=fluxer_relay dockerfile=fluxer_relay/Dockerfile tag=$REGISTRY:relay"
  printf '%s\n' "  relay-directory -> context=. dockerfile=fluxer_relay_directory/Dockerfile tag=$REGISTRY:relay-directory"
}

is_valid_target() {
  case "$1" in
    server|relay|relay-directory) return 0 ;;
    *) return 1 ;;
  esac
}

add_target() {
  target="$1"
  if ! is_valid_target "$target"; then
    printf '%s\n' "Error: Unsupported target '$target'" >&2
    printf '%s\n' "" >&2
    print_targets >&2
    exit 1
  fi

  case " $TARGETS " in
    *" $target "*) ;;
    *) TARGETS="$TARGETS $target" ;;
  esac
}

run_docker() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '%s' "+ docker"
    for arg in "$@"; do
      printf ' %s' "$arg"
    done
    printf '\n'
    return 0
  fi

  docker "$@"
}

target_context() {
  case "$1" in
    server) printf '%s\n' "." ;;
    relay) printf '%s\n' "fluxer_relay" ;;
    relay-directory) printf '%s\n' "." ;;
  esac
}

target_dockerfile() {
  case "$1" in
    server) printf '%s\n' "fluxer_server/Dockerfile" ;;
    relay) printf '%s\n' "fluxer_relay/Dockerfile" ;;
    relay-directory) printf '%s\n' "fluxer_relay_directory/Dockerfile" ;;
  esac
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --push)
      PUSH=1
      ;;
    --dry-run)
      DRY_RUN=1
      ;;
    --all)
      BUILD_ALL=1
      ;;
    --list)
      LIST_ONLY=1
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    --)
      shift
      while [ "$#" -gt 0 ]; do
        add_target "$1"
        shift
      done
      break
      ;;
    -*)
      printf '%s\n' "Error: Unknown option '$1'" >&2
      usage >&2
      exit 1
      ;;
    *)
      add_target "$1"
      ;;
  esac
  shift
done

if [ "$LIST_ONLY" -eq 1 ]; then
  print_targets
  exit 0
fi

if [ "$BUILD_ALL" -eq 1 ]; then
  add_target "server"
  add_target "relay"
  add_target "relay-directory"
fi

if [ -z "$TARGETS" ]; then
  add_target "server"
fi

for target in $TARGETS; do
  image="$REGISTRY:$target"
  context="$(target_context "$target")"
  dockerfile="$(target_dockerfile "$target")"

  printf '%s\n' ""
  printf '%s\n' "[build] $target -> $image"
  run_docker build \
    -f "$dockerfile" \
    --build-arg "BUILD_SHA=$BUILD_SHA" \
    --build-arg "BUILD_NUMBER=$BUILD_NUMBER" \
    --build-arg "BUILD_TIMESTAMP=$BUILD_TIMESTAMP" \
    --build-arg "RELEASE_CHANNEL=$RELEASE_CHANNEL" \
    -t "$image" \
    "$context"

  if [ "$PUSH" -eq 1 ]; then
    printf '%s\n' "[push] $image"
    run_docker push "$image"
  fi
done

printf '%s\n' ""
printf '%s\n' "Completed image targets:"
for target in $TARGETS; do
  printf '%s\n' "  - $REGISTRY:$target"
done

if [ "$DRY_RUN" -eq 1 ]; then
  printf '%s\n' ""
  printf '%s\n' "Dry run completed. No docker commands were executed."
fi
