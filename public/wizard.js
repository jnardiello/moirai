const summary = document.getElementById('wizard-summary');
const rootNode = document.getElementById('wizard-root');
const dirsNode = document.getElementById('wizard-dirs');
const repositoriesNode = document.getElementById('wizard-repositories');
const outputNode = document.getElementById('wizard-output');
const createButton = document.getElementById('wizard-create');
const refreshButton = document.getElementById('wizard-refresh');

let lastStatus = null;

function print(message) {
  outputNode.textContent = message || '';
}

function formatAction(action) {
  if (action === 'open') return 'This folder is ready.';
  if (action === 'adopt') return 'Existing markdown board found. Moirai can adopt it.';
  if (action === 'repair') return 'Partial board found. Moirai can create the missing folders.';
  if (action === 'repair_config') return 'Config needs repair before the board can open.';
  return 'No board found yet. Moirai can create one here.';
}

function renderStatus(status) {
  lastStatus = status;
  const detection = status.detection;
  rootNode.textContent = detection.projectRoot;
  summary.textContent = formatAction(detection.recommendedAction);
  dirsNode.innerHTML = '';

  for (const dir of detection.structure.requiredDirs) {
    const item = document.createElement('li');
    const exists = !detection.structure.missingDirs.includes(dir);
    item.textContent = `${exists ? 'ok' : 'missing'}  ${dir}/`;
    item.className = exists ? 'wizard-ok' : 'wizard-missing';
    dirsNode.appendChild(item);
  }

  repositoriesNode.value = JSON.stringify(status.suggestedRepositories || { backlog: '.' }, null, 2);
  print(detection.configError ? `Config error: ${detection.configError}` : '');
}

async function loadStatus() {
  print('Checking project...');
  const response = await fetch('/api/setup/status');
  if (!response.ok) {
    throw new Error('Could not load setup status');
  }
  renderStatus(await response.json());
}

async function initialize() {
  createButton.disabled = true;
  try {
    let repositories = null;
    try {
      repositories = JSON.parse(repositoriesNode.value || '{}');
    } catch {
      throw new Error('Repository map must be valid JSON.');
    }

    print('Writing Moirai config and folder structure...');
    const response = await fetch('/api/setup/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repositories,
        overwriteConfig: lastStatus?.detection?.recommendedAction === 'repair_config',
      }),
    });
    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.error || 'Setup failed');
    }
    print('Board ready. Opening...');
    window.location.assign('/');
  } catch (error) {
    print(error.message);
  } finally {
    createButton.disabled = false;
  }
}

createButton.addEventListener('click', initialize);
refreshButton.addEventListener('click', () => {
  loadStatus().catch((error) => print(error.message));
});

loadStatus().catch((error) => print(error.message));
