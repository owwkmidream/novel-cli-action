const axios = require('axios');
const tar = require('tar');
const { execa } = require('execa');
const fs = require('fs-extra');
const path = require('path');

// --- 配置区 ---
const CRATE_NAME = process.env.CRATE_NAME || 'novel-cli';
const GH_USER = process.env.GH_USER;
const REPO_NAME = process.env.REPO_NAME;
const GH_PAT = process.env.GH_PAT;

// 目录配置
const WORK_DIR = path.resolve(__dirname, 'work');
// 目标仓库的本地路径
const REPO_DIR = path.resolve(WORK_DIR, 'repo'); 
// 临时解压路径
const EXTRACT_DIR = path.resolve(WORK_DIR, 'temp_extract');

// --- 配置区结束 ---

async function getLatestCrateVersion(crateName) {
  console.log(`[1/5] Fetching latest version for crate: ${crateName}...`);
  try {
    const response = await axios.get(`https://crates.io/api/v1/crates/${crateName}`);
    const version = response.data?.crate?.max_stable_version || response.data?.crate?.max_version;
    if (!version) throw new Error('Could not find version in crates.io API response.');
    console.log(`Found latest version: ${version}`);
    return version;
  } catch (error) {
    console.error(`Error fetching crate version: ${error.message}`);
    process.exit(1);
  }
}

async function prepareRepo() {
  console.log(`[2/5] Preparing target repository...`);
  
  if (!GH_USER || !REPO_NAME || !GH_PAT) {
    console.error('Missing env vars.');
    process.exit(1);
  }

  // 这里的 URL 包含 Token，用于操作
  const remoteUrl = `https://x-access-token:${GH_PAT}@github.com/${GH_USER}/${REPO_NAME}.git`;
  
  // 确保目录存在且为空
  fs.emptyDirSync(WORK_DIR);
  
  try {
    console.log(`Cloning ${GH_USER}/${REPO_NAME}...`);
    // 克隆仓库到 REPO_DIR
    await execa('git', ['clone', remoteUrl, REPO_DIR]);
    
    // 设置 Git 用户信息
    const gitOptions = { cwd: REPO_DIR };
    await execa('git', ['config', 'user.name', 'GitHub Action'], gitOptions);
    await execa('git', ['config', 'user.email', 'action@github.com'], gitOptions);
    
    console.log('Repository cloned.');
  } catch (error) {
    console.error('Git clone failed. If repo is empty, script might need adjustment for first init.', error.message);
    process.exit(1);
  }
}

async function downloadAndApply(crateName, version) {
  console.log(`[3/5] Downloading and applying source code...`);
  
  const downloadUrl = `https://static.crates.io/crates/${crateName}/${crateName}-${version}.crate`;
  const crateFile = path.resolve(WORK_DIR, `${crateName}.crate`);

  // 1. 下载
  const response = await axios({ method: 'get', url: downloadUrl, responseType: 'stream' });
  const writer = fs.createWriteStream(crateFile);
  response.data.pipe(writer);
  await new Promise((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', reject);
  });

  // 2. 清理仓库目录 (保留 .git 文件夹)
  // 获取 REPO_DIR 下所有文件/文件夹
  const files = await fs.readdir(REPO_DIR);
  for (const file of files) {
    if (file === '.git') continue; // 跳过 .git
    await fs.remove(path.join(REPO_DIR, file));
  }
  
  // 3. 解压到临时目录
  fs.ensureDirSync(EXTRACT_DIR);
  await tar.x({
    file: crateFile,
    cwd: EXTRACT_DIR,
    strip: 1, // 去除顶层文件夹
  });

  // 4. 将代码移动到仓库目录
  await fs.copy(EXTRACT_DIR, REPO_DIR);
  
  console.log('Source code applied to repository folder.');
}

async function commitAndPush(version) {
  console.log(`[4/5] Checking for changes...`);
  const gitOptions = { cwd: REPO_DIR };

  try {
    // 添加所有变更
    await execa('git', ['add', '.'], gitOptions);
    
    // 检查是否有变更
    const status = await execa('git', ['status', '--porcelain'], gitOptions);
    
    if (status.stdout === '') {
      console.log('No changes detected. Repository is already up to date.');
      return;
    }

    console.log(`Changes detected. Committing version ${version}...`);
    
    // 提交
    await execa('git', ['commit', '-m', `Update to version ${version}`], gitOptions);
    
    // 打标签 (如果标签已存在，先删除本地标签以免冲突，或者加 -f)
    // 这里简单处理：尝试打标签，如果失败(比如重复跑)不阻断流程，但通常版本号变了才会有 commit
    try {
        await execa('git', ['tag', `v${version}`], gitOptions);
        console.log(`Tag v${version} created.`);
    } catch (e) {
        console.warn('Tag creation failed (maybe exists):', e.message);
    }

    console.log('[5/5] Pushing changes and tags...');
    // 推送代码和标签
    await execa('git', ['push', 'origin', 'main'], gitOptions);
    await execa('git', ['push', 'origin', '--tags'], gitOptions);

    console.log('Sync completed successfully!');
  } catch (error) {
    console.error('Git operation failed:', error.message);
    process.exit(1);
  }
}

async function main() {
  const version = await getLatestCrateVersion(CRATE_NAME);
  
  await prepareRepo(); // 克隆
  await downloadAndApply(CRATE_NAME, version); // 替换文件
  await commitAndPush(version); // 提交
}

main();
