#!/usr/bin/env node
/**
 * Hard-kill every claude-mem process, then optionally restart.
 *
 * When the worker wedges (hooks stuck, port 37777 unreachable, graceful
 * shutdown timing out), use this instead of `npm run worker:restart`.
 *
 * Targets processes whose command line contains any of:
 *   - worker-service.cjs   (the worker daemon)
 *   - mcp-server.cjs       (claude-mem MCP server)
 *   - chroma-mcp           (ChromaDB MCP subprocess)
 *
 * Usage:
 *   node scripts/worker-nuke.cjs            # kill only
 *   node scripts/worker-nuke.cjs --restart  # kill then start fresh worker
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PATTERNS = ['worker-service.cjs', 'mcp-server.cjs', 'chroma-mcp'];
const DATA_DIR = path.join(os.homedir(), '.claude-mem');
const PID_FILE = path.join(DATA_DIR, 'worker.pid');
// Windows spawn cooldown marker: if present and <2 minutes old, future spawn
// attempts silently no-op. Must be cleared as part of a hard reset.
const SPAWN_COOLDOWN_MARKER = path.join(DATA_DIR, '.worker-start-attempted');
// Stale PID references here will cause `assertCanSpawn` to reject new spawns.
const SUPERVISOR_FILE = path.join(DATA_DIR, 'supervisor.json');
const INSTALLED_WORKER = path.join(
  os.homedir(),
  '.claude', 'plugins', 'marketplaces', 'thedotmack',
  'plugin', 'scripts', 'worker-service.cjs'
);

function killWindows() {
  // PowerShell: find CIM processes whose CommandLine contains any pattern,
  // then taskkill /T /F each one (tree kill).
  const psPatterns = PATTERNS.map(p => `'${p}'`).join(',');
  // Exclude our own powershell process (and its parent chain up to npm/node)
  // because the patterns appear as string literals in this very script's
  // command line, which would otherwise cause it to kill itself.
  const script = `
    $self = $PID
    $ancestors = @($self)
    $current = Get-CimInstance Win32_Process -Filter "ProcessId = $self"
    while ($current -and $current.ParentProcessId) {
      $ancestors += $current.ParentProcessId
      $current = Get-CimInstance Win32_Process -Filter ("ProcessId = " + $current.ParentProcessId)
    }
    $patterns = @(${psPatterns})
    $procs = Get-CimInstance Win32_Process | Where-Object {
      if ($ancestors -contains $_.ProcessId) { return $false }
      if ($_.Name -eq 'powershell.exe' -or $_.Name -eq 'pwsh.exe') { return $false }
      $cl = $_.CommandLine
      if (-not $cl) { return $false }
      foreach ($p in $patterns) { if ($cl -like "*$p*") { return $true } }
      return $false
    }
    if (-not $procs) { Write-Host 'No claude-mem processes found.'; exit 0 }
    foreach ($proc in $procs) {
      Write-Host ("Killing PID {0}: {1}" -f $proc.ProcessId, $proc.Name)
      & taskkill /T /F /PID $proc.ProcessId 2>&1 | Out-Null
    }
  `;
  const result = spawnSync('powershell', ['-NoProfile', '-Command', script], {
    stdio: 'inherit'
  });
  return result.status === 0;
}

function killUnix() {
  let anyKilled = false;
  for (const pattern of PATTERNS) {
    const r = spawnSync('pkill', ['-f', pattern], { stdio: 'inherit' });
    // pkill exits 0 if something was killed, 1 if no matches — treat both as ok
    if (r.status === 0) anyKilled = true;
  }
  if (!anyKilled) console.log('No claude-mem processes found.');
  return true;
}

function tryUnlink(filePath, label) {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      console.log(`Removed ${label}: ${filePath}`);
    }
  } catch (e) {
    console.warn(`Could not remove ${label}: ${e.message}`);
  }
}

function cleanupState() {
  tryUnlink(PID_FILE, 'stale PID file');
  tryUnlink(SPAWN_COOLDOWN_MARKER, 'Windows spawn cooldown marker');
  // supervisor.json tracks PIDs; wipe it rather than delete so the worker can
  // rewrite a clean one on next start.
  try {
    if (fs.existsSync(SUPERVISOR_FILE)) {
      fs.writeFileSync(SUPERVISOR_FILE, JSON.stringify({ processes: {} }, null, 2));
      console.log(`Reset supervisor registry: ${SUPERVISOR_FILE}`);
    }
  } catch (e) {
    console.warn(`Could not reset supervisor registry: ${e.message}`);
  }
}

function isPluginDisabled() {
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
  try {
    if (!fs.existsSync(settingsPath)) return false;
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    const entry = settings && settings.enabledPlugins && settings.enabledPlugins['claude-mem@thedotmack'];
    return entry === false;
  } catch {
    return false;
  }
}

function startWorker() {
  if (isPluginDisabled()) {
    console.error('\x1b[31m%s\x1b[0m', 'claude-mem plugin is disabled in ~/.claude/settings.json.');
    console.error('The worker will silently refuse to start while disabled (by design).');
    console.error('Re-enable with `/plugin` in Claude Code, then `/reload-plugins`, then retry.');
    return 1;
  }
  if (!fs.existsSync(INSTALLED_WORKER)) {
    console.warn(`Worker script not found: ${INSTALLED_WORKER}`);
    console.warn('Run `npm run sync-marketplace` first, then retry.');
    return 1;
  }
  console.log(`Starting fresh worker: ${INSTALLED_WORKER}`);

  if (process.platform === 'win32') {
    // Mirror the codebase's own detached spawn: PowerShell Start-Process with
    // -WindowStyle Hidden, invoked via -EncodedCommand so paths with spaces or
    // quotes don't trip CMD quoting. The worker launches with --daemon (the
    // same entry point hooks use) and writes its own PID file once HTTP is up.
    const psScript = `Start-Process -FilePath 'bun' -ArgumentList @('${INSTALLED_WORKER.replace(/'/g, "''")}','--daemon') -WindowStyle Hidden`;
    const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
    const r = spawnSync('powershell', ['-NoProfile', '-EncodedCommand', encoded], {
      stdio: 'inherit',
      windowsHide: true
    });
    if (r.status !== 0) {
      console.error('Failed to spawn worker daemon via PowerShell.');
      return r.status ?? 1;
    }
    console.log('Worker daemon spawned (detached). Poll `npm run worker:status` or http://localhost:37777/health to confirm.');
    return 0;
  }

  // Unix: spawn detached, don't wait
  const child = require('child_process').spawn('bun', [INSTALLED_WORKER, '--daemon'], {
    cwd: path.dirname(INSTALLED_WORKER),
    detached: true,
    stdio: 'ignore'
  });
  child.unref();
  console.log('Worker daemon spawned (detached).');
  return 0;
}

const isWin = process.platform === 'win32';
console.log(`Nuking claude-mem processes (platform: ${process.platform})...`);

const killed = isWin ? killWindows() : killUnix();
if (!killed) {
  console.error('Kill step failed.');
  process.exit(1);
}

cleanupState();

if (process.argv.includes('--restart')) {
  process.exit(startWorker());
}
console.log('\x1b[32m%s\x1b[0m', '✓ Done. Run with --restart to also start a fresh worker.');
