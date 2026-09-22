const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const { execSync } = require('child_process');
const tar = require('tar');

// 统一添加 User-Agent 避免 crates.io 报 403
axios.defaults.headers.common['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

// 环境变量
const GH_USER = process.env.GH_USER || 'owwkmidream';
const GH_PAT = process.env.GH_PAT;
// 统一的目标备份仓库名（也可以通过环境变量覆盖）
const TARGET_REPO = process.env.TARGET_REPO || 'novel-cli-backup';

// 需要同步的 crate 列表（branchName 即存放该包的 git 分支）
const SYNC_TARGETS = [
  { crateName: 'novel-cli', branchName: 'novel-cli' },
  { crateName: 'novel-api', branchName: 'novel-api' }
];

function runCommand(command, cwd) {
  try {
    return execSync(command, { cwd, stdio: 'pipe' }).toString().trim();
  } catch (error) {
    const stderr = error.stderr ? error.stderr.toString() : error.message;
    throw new Error(`Command failed: ${command}\n${stderr}`);
  }
}

async function getLatestCrateVersion(crateName) {
  console.log(`[1/5] Fetching latest version for crate: ${crateName}...`);
  const response = await axios.get(`https://crates.io/api/v1/crates/${crateName}`);
  const version = response.data?.crate?.max_stable_version || response.data?.crate?.max_version;
  if (!version) throw new Error(`Could not find version for ${crateName} in crates.io response.`);
  console.log(`Found latest version: ${version}`);
  return version;
}

async function prepareRepoBranch(targetRepoPath, fullTargetRepo, branchName) {
  console.log(`[2/5] Preparing branch [${branchName}] in ${fullTargetRepo}...`);
  await fs.remove(targetRepoPath);
  await fs.ensureDir(targetRepoPath);

  const cloneUrl = `https://x-access-token:${GH_PAT}@github.com/${fullTargetRepo}.git`;

  try {
    // 尝试直接克隆目标分支
    console.log(`Trying to clone branch ${branchName}...`);
    runCommand(`git clone --branch ${branchName} "${cloneUrl}" "${targetRepoPath}"`);
  } catch (error) {
    // 分支不存在或是全新仓库，初始化并创建孤儿分支 (orphan branch)
    console.log(`Branch ${branchName} not found remotely. Creating fresh orphan branch...`);
    runCommand('git init', targetRepoPath);
    runCommand(`git remote add origin "${cloneUrl}"`, targetRepoPath);
    runCommand(`git checkout --orphan ${branchName}`, targetRepoPath);
  }

  runCommand(`git config user.name "${GH_USER}"`, targetRepoPath);
  runCommand(`git config user.email "${GH_USER}@users.noreply.github.com"`, targetRepoPath);
}

function checkVersionExists(targetRepoPath, crateName, version) {
  const tagName = `${crateName}-v${version}`;
  console.log(`[3/5] Checking if tag ${tagName} exists...`);
  try {
    const tags = runCommand('git tag', targetRepoPath).split('\n');
    if (tags.includes(tagName)) {
      console.log(`Version ${tagName} already synced.`);
      return true;
    }
  } catch (e) {
    // 仓库为空没有 commit 时查询 tag 可能会报错，直接忽略
  }
  return false;
}

async function downloadAndExtract(crateName, version, targetRepoPath, workDir) {
  console.log(`[4/5] Downloading and extracting ${crateName} v${version}...`);
  const downloadUrl = `https://static.crates.io/crates/${crateName}/${crateName}-${version}.crate`;
  const tarballPath = path.join(workDir, `${crateName}-${version}.crate`);
  const extractDir = path.join(workDir, 'extracted');

  await fs.remove(extractDir);
  await fs.ensureDir(extractDir);

  const response = await axios({
    method: 'get',
    url: downloadUrl,
    responseType: 'arraybuffer'
  });
  await fs.writeFile(tarballPath, response.data);

  await tar.x({
    file: tarballPath,
    cwd: extractDir
  });

  // 保留 .git 文件夹，清理其余旧文件
  const items = await fs.readdir(targetRepoPath);
  for (const item of items) {
    if (item !== '.git') {
      await fs.remove(path.join(targetRepoPath, item));
    }
  }

  // 解压目录通常为 crateName-version
  const extractedSubDir = path.join(extractDir, `${crateName}-${version}`);
  await fs.copy(extractedSubDir, targetRepoPath);

  // 清理临时文件
  await fs.remove(tarballPath);
  await fs.remove(extractDir);
}

function commitAndPush(targetRepoPath, crateName, version, branchName) {
  console.log(`[5/5] Committing, tagging, and pushing changes...`);
  runCommand('git add .', targetRepoPath);
  
  const status = runCommand('git status --porcelain', targetRepoPath);
  if (!status) {
    console.log('No changes detected to commit.');
  } else {
    runCommand(`git commit -m "chore(sync): update ${crateName} to v${version}"`, targetRepoPath);
  }

  const tagName = `${crateName}-v${version}`;
  runCommand(`git tag -a "${tagName}" -m "Release ${tagName}"`, targetRepoPath);
  runCommand(`git push origin ${branchName} --tags`, targetRepoPath);
  console.log(`Successfully synced and pushed to branch: ${branchName}, tag: ${tagName}`);
}

async function syncSingleCrate(crateName, branchName) {
  console.log(`\n========================================`);
  console.log(`>>> Starting Task: ${crateName} -> Branch: [${branchName}]`);
  console.log(`========================================`);

  const workDir = path.join(__dirname, 'work', crateName);
  const targetRepoPath = path.join(workDir, 'repo');
  const fullTargetRepo = `${GH_USER}/${TARGET_REPO}`;

  const version = await getLatestCrateVersion(crateName);
  await prepareRepoBranch(targetRepoPath, fullTargetRepo, branchName);

  if (checkVersionExists(targetRepoPath, crateName, version)) {
    console.log(`Task skipped: ${crateName} v${version} is up to date.`);
    return;
  }

  await downloadAndExtract(crateName, version, targetRepoPath, workDir);
  commitAndPush(targetRepoPath, crateName, version, branchName);
}

async function main() {
  if (!GH_PAT) {
    console.error('CRITICAL: GH_PAT is missing. Check your Action Secrets.');
    process.exit(1);
  }

  for (const target of SYNC_TARGETS) {
    try {
      await syncSingleCrate(target.crateName, target.branchName);
    } catch (err) {
      console.error(`Error during syncing ${target.crateName}:`, err.message);
      process.exit(1);
    }
  }
  console.log('\nAll sync tasks finished successfully.');
}

main();
