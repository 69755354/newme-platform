#!/usr/bin/env bash
set -euo pipefail
python3 -c "
import yaml, sys
for f in sys.argv[1:]:
    with open(f) as fh:
        yaml.safe_load(fh)
    print(f'PASS {f}')
" .github/workflows/*.yml
