import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const deployScript = path.join(repoRoot, "scripts/deploy-production-image.sh");
const deploySha = "37fe1d7956b51c41fe5475b131c725ef9e969f9a";
const oldSha = "8eff3e0493c77bf8cd5c7fab6c366e953fe86a77";

async function writeExecutable(filePath, body) {
  await writeFile(filePath, body);
  await chmod(filePath, 0o755);
}

async function runDeploy({ healthy }) {
  const fixture = await mkdtemp(path.join(tmpdir(), "paperclip-deploy-test-"));
  const binDir = path.join(fixture, "bin");
  const logPath = path.join(fixture, "docker.log");
  const composeDir = path.join(fixture, "compose");
  const backupDir = path.join(fixture, "backups");
  await import("node:fs/promises").then(({ mkdir }) =>
    Promise.all([mkdir(binDir), mkdir(composeDir)]),
  );

  await writeExecutable(
    path.join(binDir, "docker"),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$DOCKER_LOG"
case "$1" in
  login) read -r _token ;;
  pull|tag|compose) ;;
  exec) printf 'mock database backup' ;;
  image)
    target="\${@: -1}"
    if [[ "$*" == *'{{.Id}}'* ]]; then
      printf 'sha256:old-image-id'
    elif [[ "$target" == *':sha-'* ]]; then
      printf '%s' "$DEPLOY_SHA"
    else
      printf '%s' "$OLD_SHA"
    fi
    ;;
  *) exit 2 ;;
esac
`,
  );

  await writeExecutable(
    path.join(binDir, "curl"),
    `#!/usr/bin/env bash
printf '{"status":"ok","commit":"%s"}\\n' "$HEALTH_SHA"
`,
  );
  await writeExecutable(path.join(binDir, "sleep"), "#!/usr/bin/env bash\nexit 0\n");

  const child = spawn(deployScript, ["deploy", deploySha], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      DEPLOY_SHA: deploySha,
      OLD_SHA: oldSha,
      HEALTH_SHA: healthy ? deploySha : oldSha,
      DOCKER_LOG: logPath,
      PAPERCLIP_COMPOSE_DIR: composeDir,
      PAPERCLIP_DEPLOY_BACKUP_DIR: backupDir,
      PAPERCLIP_DEPLOY_LOCK_FILE: path.join(fixture, "deploy.lock"),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end("temporary-token\n");

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const exitCode = await new Promise((resolve) => child.on("close", resolve));
  const dockerLog = await readFile(logPath, "utf8");
  return { exitCode, stdout, stderr, dockerLog };
}

test("deploys and verifies an immutable commit image", async () => {
  const result = await runDeploy({ healthy: true });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`deployment healthy at ${deploySha}`));
  assert.match(result.dockerLog, /pull ghcr\.io\/comcap-holdings-llc\/paperclip:sha-37fe1d7/);
  assert.match(result.dockerLog, /compose up -d --no-deps --force-recreate server/);
});

test("restores the previous image when health verification fails", async () => {
  const result = await runDeploy({ healthy: false });
  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, new RegExp(`deployment rolled back to ${oldSha}`));
  assert.match(
    result.dockerLog,
    /tag sha256:old-image-id ghcr\.io\/paperclipai\/paperclip:latest/,
  );
  assert.equal(
    result.dockerLog.match(/compose up -d --no-deps --force-recreate server/g)?.length,
    2,
  );
});
