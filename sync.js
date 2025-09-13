const axios = require('axios');
const tar = require('tar');
const { execa } = require('execa');
const fs = require('fs-extra');
const path = require('path');

// --- 配置区 ---
// 这些值将从环境变量读取，方便在 GitHub Action 中设置
const CRATE_NAME = process.env.CRATE_NAME || 'novel-cli';
const GH_USER = process.env.GH_USER;
const REPO_NAME = process.env.REPO_NAME;
const GH_PAT = process.env.GH_PAT;

// 脚本工作目录
const WORK_DIR = path.resolve(__dirname, 'work');
const SOURCE_DIR = path.resolve(WORK_DIR, 'source_code');
// --- 配置区结束 ---

async function getLatestCrateVersion(crateName) {
  console.log(`Fetching latest version for crate: ${crateName}...`);
  try {
    const response = await axios.get(`https://crates.io/api/v1/crates/${crateName}`);
    const version = response.data?.crate?.max_stable_version || response.data?.crate?.max_version;
    if (!version) {
      throw new Error('Could not find version in crates.io API response.');
    }
    console.log(`Found latest version: ${version}`);
    return version;
  } catch (error) {
    console.error(`Error fetching crate version: ${error.message}`);
    process.exit(1);
  }
}

async function downloadAndExtract(crateName, version) {
  const downloadUrl = `https://static.crates.io/crates/${crateName}/${crateName}-${version}.crate`;
  const crateFile = path.resolve(WORK_DIR, `${crateName}.crate`);

  console.log(`Downloading from ${downloadUrl}...`);
  const response = await axios({
    method: 'get',
    url: downloadUrl,
    responseType: 'stream',
  });

  const writer = fs.createWriteStream(crateFile);
  response.data.pipe(writer);

  await new Promise((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', reject);
  });

  console.log('Download complete. Extracting...');
  await tar.x({
    file: crateFile,
    cwd: SOURCE_DIR,
    strip: 1, // 移除压缩包内的第一层目录
  });
  console.log('Extraction complete.');
}

async function pushToGitHub(version) {
  if (!GH_USER || !REPO_NAME || !GH_PAT) {
    console.error('Missing required environment variables: GH_USER, REPO_NAME, GH_PAT.');
    if (!GH_USER) console.error('Missing GH_USER');
    if (!REPO_NAME) console.error('Missing REPO_NAME');
    if (!GH_PAT) console.error('Missing GH_PAT');
    process.exit(1);
  }
  
  const repoUrl = `https://github.com/${GH_USER}/${REPO_NAME}.git`;
  const remoteUrl = `https://x-access-token:${GH_PAT}@github.com/${GH_USER}/${REPO_NAME}.git`;

  console.log(`Pushing to repository: ${repoUrl}`);
  
  const gitOptions = { cwd: SOURCE_DIR };

  try {
    await execa('git', ['config', '--global', 'user.name', 'GitHub Action'], gitOptions);
    await execa('git', ['config', '--global', 'user.email', 'action@github.com'], gitOptions);
    await execa('git', ['init'], gitOptions);
    await execa('git', ['add', '.'], gitOptions);
    await execa('git', ['commit', '-m', `Mirror of ${CRATE_NAME} version ${version} from crates.io`], gitOptions);
    await execa('git', ['remote', 'add', 'origin', remoteUrl], gitOptions);
    
    console.log('Force pushing to main branch...');
    await execa('git', ['push', '--force', 'origin', 'HEAD:main'], gitOptions);

    console.log('Sync completed successfully!');
  } catch (error) {
    console.error('Git operation failed:', error.stdout || error.stderr || error.message);
    process.exit(1);
  }
}

async function main() {
  console.log('Starting crate source sync...');
  
  // 准备工作目录
  fs.emptyDirSync(WORK_DIR);
  fs.mkdirSync(SOURCE_DIR, { recursive: true });

  const version = await getLatestCrateVersion(CRATE_NAME);
  await downloadAndExtract(CRATE_NAME, version);
  await pushToGitHub(version);
}

main();