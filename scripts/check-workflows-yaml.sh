#!/usr/bin/env bash
set -euo pipefail
ruby -e 'require "yaml"; ARGV.each { |f| YAML.load_file(f); puts "PASS #{f}" }' .github/workflows/*.yml
