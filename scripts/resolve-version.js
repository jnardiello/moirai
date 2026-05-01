#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

function parseVersion(version) {
  const match = String(version || '').trim().match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!match) {
    throw new Error(`Invalid package version: ${version}`);
  }
  return match.slice(1).map((part) => Number(part));
}

function resolveVersion(currentVersion, requestedVersion) {
  const request = String(requestedVersion || '').trim();
  const [major, minor, patch] = parseVersion(currentVersion);

  if (/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(request)) {
    return request;
  }
  if (request === 'major') {
    return `${major + 1}.0.0`;
  }
  if (request === 'minor') {
    return `${major}.${minor + 1}.0`;
  }
  if (request === 'patch') {
    return `${major}.${minor}.${patch + 1}`;
  }

  throw new Error(`Unsupported VERSION value: ${request || '(empty)'}`);
}

function main() {
  const packageJsonPath = path.resolve(__dirname, '..', 'package.json');
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
  const requestedVersion = process.argv[2];
  console.log(resolveVersion(packageJson.version, requestedVersion));
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  resolveVersion,
};
