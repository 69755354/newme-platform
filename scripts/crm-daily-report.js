#!/usr/bin/env node
"use strict";

process.stderr.write(
  "retired utility: use the reviewed application and observability control plane; legacy environment files are not an authorized credential source\n",
);
process.exitCode = 64;
