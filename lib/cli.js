const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { detectProject, doctorProject, resolveProjectRoot } = require('./project');

const USAGE = `Moirai

Usage:
  moirai [--root <path>] [--port <port>] [--host <host>] [--no-open]
  moirai init [--root <path>] [--port <port>] [--host <host>] [--no-open]
  moirai doctor [--root <path>]
  moirai --help
  moirai --version
`;

function parseCliArgs(argv = []) {
  const args = [...argv];
  const options = {
    command: 'start',
    root: process.cwd(),
    host: null,
    port: null,
    open: true,
    help: false,
    version: false,
  };

  if (args[0] && !args[0].startsWith('-')) {
    options.command = args.shift();
  }

  while (args.length > 0) {
    const arg = args.shift();
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--version' || arg === '-v') {
      options.version = true;
    } else if (arg === '--no-open') {
      options.open = false;
    } else if (arg === '--root') {
      options.root = args.shift();
    } else if (arg.startsWith('--root=')) {
      options.root = arg.slice('--root='.length);
    } else if (arg === '--host') {
      options.host = args.shift();
    } else if (arg.startsWith('--host=')) {
      options.host = arg.slice('--host='.length);
    } else if (arg === '--port') {
      options.port = Number(args.shift());
    } else if (arg.startsWith('--port=')) {
      options.port = Number(arg.slice('--port='.length));
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.root) {
    throw new Error('--root requires a path');
  }
  if (options.port !== null && (!Number.isInteger(options.port) || options.port <= 0)) {
    throw new Error('--port requires a positive integer');
  }
  if (!['start', 'init', 'doctor'].includes(options.command)) {
    throw new Error(`Unknown command: ${options.command}`);
  }

  options.root = resolveProjectRoot(options.root);
  return options;
}

function packageVersion() {
  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8'));
  return packageJson.version;
}

function browserCommand(url) {
  if (process.platform === 'darwin') {
    return ['open', [url]];
  }
  if (process.platform === 'win32') {
    return ['cmd', ['/c', 'start', '', url]];
  }
  return ['xdg-open', [url]];
}

function openBrowser(url) {
  const [command, args] = browserCommand(url);
  const child = spawn(command, args, {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

function formatDoctor(result) {
  const lines = [];
  lines.push(result.ok ? 'Moirai doctor: ok' : 'Moirai doctor: issues found');
  lines.push(`Root: ${result.detection.projectRoot}`);
  lines.push(`Config: ${result.detection.hasConfig ? result.detection.configPath : 'missing'}`);
  lines.push(`Structure: ${result.detection.structure.status}`);

  if (result.issues.length) {
    lines.push('');
    lines.push('Issues:');
    for (const issue of result.issues) {
      lines.push(`- ${issue}`);
    }
  }

  if (result.warnings.length) {
    lines.push('');
    lines.push('Warnings:');
    for (const warning of result.warnings) {
      lines.push(`- ${warning}`);
    }
  }

  return lines.join('\n');
}

async function runCli(argv = process.argv.slice(2), io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  let options;

  try {
    options = parseCliArgs(argv);
  } catch (error) {
    stderr.write(`${error.message}\n\n${USAGE}`);
    return 1;
  }

  if (options.help) {
    stdout.write(USAGE);
    return 0;
  }
  if (options.version) {
    stdout.write(`${packageVersion()}\n`);
    return 0;
  }

  if (options.command === 'doctor') {
    const result = doctorProject(options.root);
    stdout.write(`${formatDoctor(result)}\n`);
    return result.ok ? 0 : 1;
  }

  const detection = detectProject(options.root);
  const setupMode = options.command === 'init' || detection.recommendedAction !== 'open';
  process.env.MOIRAI_PROJECT_ROOT = options.root;
  process.env.MOIRAI_SETUP_MODE = setupMode ? '1' : '0';
  if (options.port) process.env.PORT = String(options.port);
  if (options.host) process.env.HOST = options.host;

  const { startServer } = require('../server');
  startServer({
    port: options.port || undefined,
    host: options.host || undefined,
    onListen: ({ url }) => {
      stdout.write(`${setupMode ? 'Moirai setup wizard' : 'Moirai board'}: ${url}\n`);
      if (options.open) {
        try {
          openBrowser(url);
        } catch (error) {
          stderr.write(`Could not open browser: ${error.message}\n`);
        }
      }
    },
  });
  return 0;
}

module.exports = {
  USAGE,
  formatDoctor,
  parseCliArgs,
  runCli,
};
