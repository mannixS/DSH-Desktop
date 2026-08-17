'use strict';

/**
 * dsh-host.js
 * dsh 进程托管模块：启动 / 停止 / 重启 / 日志捕获
 *
 * 通过系统 Node 运行内核中的 dsh CLI（lib/bin.js），
 * 以 DSH_HOME 环境变量隔离 dsh 数据目录到客户端 userData 下。
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

class DshHost {
  /**
   * @param {object} options
   * @param {string} options.kernelDir 内核目录（userData/kernel）
   * @param {string} options.dshHome DSH_HOME 数据目录（userData/dsh-home）
   * @param {number} [options.port=3080] dsh Web UI 端口
   * @param {object} [options.logger]
   */
  constructor({ kernelDir, dshHome, port = 3080, logger }) {
    this.kernelDir = kernelDir;
    this.dshHome = dshHome;
    this.port = port;
    this.logger = logger || {
      info: (...a) => console.log('[dsh]', ...a),
      warn: (...a) => console.warn('[dsh]', ...a),
      error: (...a) => console.error('[dsh]', ...a),
    };
    this.child = null;
    this.running = false;
    this.stopping = false;
    /** 日志回调：{ onLog?: (line: string) => void, onExit?: (code: number|null) => void } */
    this.events = {};
  }

  /** dsh CLI 入口路径 */
  get dshBinPath() {
    return path.join(this.kernelDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  }

  /**
   * 启动 dsh 进程
   * @param {object} [options]
   * @param {string} [options.mode='web'] 运行模式：web / tui / headless
   * @param {string[]} [options.args] 附加参数（headless 时传入任务描述）
   * @param {number} [options.port] 覆盖默认端口
   */
  start({ mode = 'web', args = [], port } = {}) {
    if (this.running) {
      this.logger.warn('dsh 已在运行，忽略重复启动');
      return { ok: false, reason: 'already-running' };
    }

    const portNum = port || this.port;
    const binPath = this.dshBinPath;
    if (!fs.existsSync(binPath)) {
      this.logger.error('内核未安装，无法启动 dsh');
      this.events.onError?.('内核未安装，请先安装 DeepSeek Harness 内核。');
      return { ok: false, reason: 'kernel-not-installed' };
    }

    // dsh web 模式端口参数（部分版本支持 --port，失败时回退默认 3080）
    const cliArgs = [binPath];
    if (mode === 'web') {
      cliArgs.push('web');
      if (portNum) {
        cliArgs.push('--port', String(portNum));
      }
    } else if (mode === 'tui') {
      cliArgs.push('--profile', 'tui');
    } else if (mode === 'headless') {
      cliArgs.push('--profile', 'headless', ...args);
    } else {
      cliArgs.push(mode);
    }

    const env = {
      ...process.env,
      DSH_HOME: this.dshHome,
      NO_COLOR: '1',
    };

    const nodeCmd = process.platform === 'win32' ? 'node.exe' : 'node';
    this.logger.info(`启动 dsh: ${nodeCmd} ${cliArgs.join(' ')}`);

    try {
      this.child = spawn(nodeCmd, cliArgs, {
        shell: process.platform === 'win32',
        windowsHide: true,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      this.logger.error(`启动失败: ${err.message}`);
      this.events.onError?.(`启动 dsh 失败: ${err.message}`);
      return { ok: false, reason: 'spawn-error', error: err.message };
    }

    this.running = true;
    this.stopping = false;

    this.child.stdout.on('data', (d) => {
      const lines = d.toString().split(/\r?\n/).filter(Boolean);
      for (const line of lines) {
        this.logger.info(line);
        this.events.onLog?.(line);
      }
    });

    this.child.stderr.on('data', (d) => {
      const lines = d.toString().split(/\r?\n/).filter(Boolean);
      for (const line of lines) {
        this.logger.warn(line);
        this.events.onLog?.(line);
      }
    });

    this.child.on('error', (err) => {
      this.logger.error(`dsh 进程错误: ${err.message}`);
      this.running = false;
      this.events.onError?.(`dsh 进程错误: ${err.message}`);
    });

    this.child.on('exit', (code, signal) => {
      this.logger.info(`dsh 进程退出 (code=${code}, signal=${signal})`);
      this.running = false;
      this.child = null;
      this.events.onExit?.(code);
    });

    return { ok: true };
  }

  /**
   * 停止 dsh 进程
   * @param {object} [options]
   * @param {boolean} [options.force=false] 强制结束
   */
  stop({ force = false } = {}) {
    if (!this.child) {
      this.running = false;
      return { ok: true, alreadyStopped: true };
    }
    this.stopping = true;
    try {
      if (force) {
        this.child.kill('SIGKILL');
      } else {
        // 先发 SIGTERM，等待退出
        this.child.kill('SIGTERM');
      }
    } catch (err) {
      this.logger.warn(`停止 dsh 失败: ${err.message}`);
    }
    // Windows 下 SIGTERM 可能无效，兜底强制结束
    if (process.platform === 'win32') {
      setTimeout(() => {
        if (this.child) {
          try {
            this.child.kill();
          } catch {}
        }
      }, 2000);
    }
    return { ok: true };
  }

  /** 重启 dsh */
  restart(options) {
    this.stop({ force: true });
    // 等待进程完全退出后重新启动
    return new Promise((resolve) => {
      const waitExit = setInterval(() => {
        if (!this.running && !this.child) {
          clearInterval(waitExit);
          const result = this.start(options);
          resolve(result);
        }
      }, 200);
      setTimeout(() => {
        clearInterval(waitExit);
        if (!this.running && !this.child) {
          const result = this.start(options);
          resolve(result);
        }
      }, 3000);
    });
  }

  get status() {
    return {
      running: this.running,
      pid: this.child ? this.child.pid : null,
      port: this.port,
      dshHome: this.dshHome,
    };
  }
}

module.exports = { DshHost };
