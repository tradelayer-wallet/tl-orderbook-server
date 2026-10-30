#!/usr/bin/env bash
# Usage: ob-bench.sh <mode> <count> [seed] [skip-legacy]
set -euo pipefail
export PATH="$HOME/.cargo/bin:/usr/local/bin:/usr/bin:/bin"
C=/mnt/c/Users/patri/Documents/Codex/2026-10-30/new-chat/work/repos/tl-orderbook-server/rust/tl-orderbook
B=$HOME/work/ob-bench; mkdir -p $B
mode=$1; n=$2; seed=${3:-20261030}
export CARGO_TARGET_DIR=$HOME/work/tl17-targets/ob-bench
(cd $C && cargo +1.90.0 build -q --release --locked --offline --example throughput)
node $C/scripts/gen-workload.cjs $mode $n $seed > $B/w-$mode-$n.tsv
echo "workload $mode n=$n sha256=$(sha256sum $B/w-$mode-$n.tsv | cut -c1-16) host=$(nproc)cpu $(uname -r)"
$CARGO_TARGET_DIR/release/examples/throughput $B/w-$mode-$n.tsv $B/t-rust-$mode-$n.txt
if [ "${4:-}" != skip-legacy ]; then
  node --max-old-space-size=8192 $C/scripts/bench-legacy.cjs $B/w-$mode-$n.tsv $B/t-js-$mode-$n.txt
  a=$(sha256sum < $B/t-rust-$mode-$n.txt | cut -c1-16); b=$(sha256sum < $B/t-js-$mode-$n.txt | cut -c1-16)
  echo "trace rust=$a js=$b lines=$(wc -l < $B/t-rust-$mode-$n.txt) $([ $a = $b ] && echo IDENTICAL || echo DIFFERENT)"
  [ $a = $b ] || diff <(head -c 2000000 $B/t-rust-$mode-$n.txt) <(head -c 2000000 $B/t-js-$mode-$n.txt) | head -6
fi
