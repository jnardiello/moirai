#!/usr/bin/env node

const { runCli } = require('../lib/cli');

runCli().then((exitCode) => {
  if (exitCode !== 0) {
    process.exitCode = exitCode;
  }
}).catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
