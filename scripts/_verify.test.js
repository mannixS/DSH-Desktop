'use strict';

/**
 * _verify.test.js
 * 核心逻辑单元验证（支持异步断言）
 * 用法：node scripts/_verify.test.js
 */

const assert = require('assert');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { KernelManager, DSH_PACKAGE } = require('../src/main/kernel-manager');

let passed = 0;
let failed = 0;
const failures = [];

async function t(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (err) {
    failed++;
    failures.push({ name, err });
    console.log('  ✗ ' + name + ' -> ' + err.message);
  }
}

async function main() {
  console.log('=== 1. semver 比较（正常路径） ===');
  const km = new KernelManager({ kernelDir: path.join(os.tmpdir(), '__dsh_verify_nonexist__') });
  await t('0.1.0-rc.6 < 0.1.0（预发布低于正式版）', () => assert.strictEqual(km.compareVersions('0.1.0-rc.6', '0.1.0'), -1));
  await t('0.1.0 > 0.0.9', () => assert.strictEqual(km.compareVersions('0.1.0', '0.0.9'), 1));
  await t('1.2.3 == 1.2.3', () => assert.strictEqual(km.compareVersions('1.2.3', '1.2.3'), 0));
  await t('0.2.0 < 0.10.0（数字比较非字典序）', () => assert.strictEqual(km.compareVersions('0.2.0', '0.10.0'), -1));

  console.log('=== 2. semver 比较（边界路径） ===');
  await t('v1.2.3 == 1.2.3（v 前缀）', () => assert.strictEqual(km.compareVersions('v1.2.3', '1.2.3'), 0));
  await t('1.0.0-rc.10 > 1.0.0-rc.9（预发布数字）', () => assert.strictEqual(km.compareVersions('1.0.0-rc.10', '1.0.0-rc.9'), 1));
  await t('1.0.0-beta > 1.0.0-alpha（字母）', () => assert.strictEqual(km.compareVersions('1.0.0-beta', '1.0.0-alpha'), 1));
  await t('garbage < 1.0.0（非法版本按最小）', () => assert.strictEqual(km.compareVersions('garbage', '1.0.0'), -1));
  await t('isStableVersion(1.0.0) === true', () => assert.strictEqual(km.isStableVersion('1.0.0'), true));
  await t('isStableVersion(1.0.0-rc.1) === false', () => assert.strictEqual(km.isStableVersion('1.0.0-rc.1'), false));

  console.log('=== 3. 本地内核信息（未安装场景） ===');
  await t('getLocalKernelInfo 返回未安装（不抛异常）', async () => {
    const info = await km.getLocalKernelInfo();
    assert.strictEqual(info.installed, false);
    assert.strictEqual(info.version, null);
  });
  await t('isKernelRunnable 返回 false（不抛异常）', async () => {
    assert.strictEqual(await km.isKernelRunnable(), false);
  });

  console.log('=== 4. Node 环境检测 ===');
  await t('detectNodeEnvironment 字段齐全', async () => {
    const env = await km.detectNodeEnvironment();
    assert.strictEqual(typeof env.nodeAvailable, 'boolean');
    assert.strictEqual(typeof env.npmAvailable, 'boolean');
    assert.ok('nodeVersion' in env && 'npmVersion' in env);
    assert.strictEqual(typeof env.meetsRequirement, 'boolean');
    assert.ok(env.minimum >= 18);
  });
  await t('当前环境满足要求（Node v18+）', async () => {
    const env = await km.detectNodeEnvironment();
    assert.strictEqual(env.meetsRequirement, true);
  });

  console.log('=== 5. 远端版本检查（网络） ===');
  await t('fetchRemoteVersion(latest) 返回版本字段', async () => {
    try {
      const r = await km.fetchRemoteVersion('latest');
      assert.ok(r.channel === 'latest');
      assert.ok(r.version === null || typeof r.version === 'string');
    } catch (err) {
      // 网络不通时跳过（不视为失败）
      console.log('  ~ 网络不可用，跳过远端检查: ' + err.message);
    }
  });

  console.log('=== 6. 内置内核导入（首次启动场景） ===');
  const osTmp = os.tmpdir();
  const bundledDir = path.join(osTmp, '__dsh_verify_bundled__');
  const userKernelDir = path.join(osTmp, '__dsh_verify_import_target__');

  // 构造 fake 内置内核目录
  fs.rmSync(bundledDir, { recursive: true, force: true });
  fs.rmSync(userKernelDir, { recursive: true, force: true });
  const dshPkgDir = path.join(bundledDir, 'node_modules', '@deepseek-ai', 'dsh');
  fs.mkdirSync(path.join(dshPkgDir, 'lib'), { recursive: true });
  fs.writeFileSync(
    path.join(dshPkgDir, 'package.json'),
    JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.9.9-test' }),
    'utf8'
  );
  fs.writeFileSync(path.join(dshPkgDir, 'lib', 'bin.js'), 'console.log("dsh")', 'utf8');
  fs.writeFileSync(
    path.join(bundledDir, 'bundle-info.json'),
    JSON.stringify({ package: '@deepseek-ai/dsh', version: '0.9.9-test' }),
    'utf8'
  );

  const km2 = new KernelManager({ kernelDir: userKernelDir });

  await t('getBundledKernelInfo 读取内置版本', async () => {
    const info = await km2.getBundledKernelInfo(bundledDir);
    assert.strictEqual(info.bundled, true);
    assert.strictEqual(info.version, '0.9.9-test');
  });

  await t('importBundledKernel 复制到用户目录并校验', async () => {
    const r = await km2.importBundledKernel(bundledDir);
    assert.strictEqual(r.imported, true);
    assert.strictEqual(r.version, '0.9.9-test');
    const local = await km2.getLocalKernelInfo();
    assert.strictEqual(local.installed, true);
    assert.strictEqual(local.version, '0.9.9-test');
  });

  await t('importBundledKernel 已安装时跳过（不覆盖）', async () => {
    const r = await km2.importBundledKernel(bundledDir);
    assert.strictEqual(r.imported, false);
    assert.strictEqual(r.reason, 'already-installed');
  });

  // 清理
  fs.rmSync(bundledDir, { recursive: true, force: true });
  fs.rmSync(userKernelDir, { recursive: true, force: true });

  console.log('=== 7. 客户端程序更新版本比较（AppUpdater._compareAppVersions） ===');
  const { AppUpdater } = require('../src/main/app-updater');
  const fakeSettings = { get: () => '' };
  const au = new AppUpdater({ settings: fakeSettings, logger: { info() {}, warn() {}, error() {} } });
  await t('1.2.0 > 1.1.9', () => assert.strictEqual(au._compareAppVersions('1.2.0', '1.1.9'), 1));
  await t('1.0.0 < 1.0.1', () => assert.strictEqual(au._compareAppVersions('1.0.0', '1.0.1'), -1));
  await t('2.0.0 == 2.0.0', () => assert.strictEqual(au._compareAppVersions('2.0.0', '2.0.0'), 0));
  await t('1.10.0 > 1.9.0（数字比较）', () => assert.strictEqual(au._compareAppVersions('1.10.0', '1.9.0'), 1));
  await t('_normalizeTag 去掉 v 前缀', () => assert.strictEqual(au._normalizeTag('v1.2.3'), '1.2.3'));
  await t('_normalizeTag 保留预发布', () => assert.strictEqual(au._normalizeTag('1.2.3-beta.1'), '1.2.3-beta.1'));
  await t('isConfigured false（未配置更新源）', () => assert.strictEqual(au.isConfigured(), false));
  await t('isConfigured true（配置 owner/repo）', () => {
    const au2 = new AppUpdater({
      settings: {
        get: (k) => (k === 'appUpdateOwner' ? 'me' : k === 'appUpdateRepo' ? 'dsh-desktop' : ''),
      },
      logger: { info() {}, warn() {}, error() {} },
    });
    assert.strictEqual(au2.isConfigured(), true);
  });

  console.log('');
  console.log('===== 结果 =====');
  console.log(`通过: ${passed}  失败: ${failed}`);
  if (failed > 0) {
    for (const f of failures) {
      console.log(`\n[失败] ${f.name}\n  ${f.err.stack || f.err.message}`);
    }
    process.exit(1);
  } else {
    console.log('全部通过');
  }
}

main().catch((err) => {
  console.error('测试执行异常:', err);
  process.exit(1);
});
