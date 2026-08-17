'use strict';

/**
 * dsh-host.js
 * dsh 进程托管模块：启动 / 停止 / 重启 / 日志捕获
 *
 * 通过系统 Node 运行内核中的 dsh CLI（lib/bin.js），
 * 以 DSH_HOME 环境变量隔离 dsh 数据目录到客户端 userData 下。
 *
 * 停止时保证整棵进程树被终止（Windows: taskkill /T /F；macOS/Linux: 进程组 kill），
 * 确保应用退出后 dsh 及其 worker 不会残留。
 */

const { spawn, exec } = require('child_process');
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
    // 触发状态变化（启动中）
    this.events.onStateChange?.(this.status);

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
        // macOS/Linux 下让 dsh 进入独立进程组，便于整树终止
        detached: process.platform !== 'win32',
      });
    } catch (err) {
      this.logger.error(`启动失败: ${err.message}`);
      this.events.onError?.(`启动 dsh 失败: ${err.message}`);
      return { ok: false, reason: 'spawn-error', error: err.message };
    }

    this.running = true;
    this.stopping = false;
    this._startPortProbe(portNum);

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
      this.events.onStateChange?.(this.status);
    });

    return { ok: true };
  }

  /**
   * 端口探活：轮询 dsh Web 端口，探测到 HTTP 200 即触发 onReady
   * （解决"进程已启动但 UI 尚未就绪"的状态脱节）
   */
  _startPortProbe(port, maxAttempts = 60, interval = 1000) {
    let attempts = 0;
    const probeTimer = setInterval(async () => {
      // 进程已退出或已停止，终止探测
      if (!this.running || this.stopping || !this.child) {
        clearInterval(probeTimer);
        return;
      }
      attempts++;
      if (attempts > maxAttempts) {
        clearInterval(probeTimer);
        this.logger.warn(`端口探测超时（${maxAttempts * interval / 1000}s 未就绪）`);
        return;
      }
      try {
        const res = await fetch(`http://127.0.0.1:${port}`, {
          signal: AbortSignal.timeout(2000),
        });
        if (res.status >= 200 && res.status < 500) {
          clearInterval(probeTimer);
          this.logger.info(`dsh Web UI 就绪（端口 ${port}）`);
          this.events.onReady?.(port);
        }
      } catch {
        // 端口未就绪，继续探测
      }
    }, interval);
  }

  /**
   * 停止 dsh 进程（含整棵进程树）
   * @param {object} [options]
   * @param {boolean} [options.force=false] 强制结束（跳过优雅退出）
   * @param {number} [options.timeout=4000] 等待进程退出的超时（ms）
   * @returns {Promise<{ ok: boolean, alreadyStopped?: boolean }>}
   */
  stop({ force = false, timeout = 4000 } = {}) {
    if (!this.child) {
      this.running = false;
      return Promise.resolve({ ok: true, alreadyStopped: true });
    }
    this.stopping = true;
    const pid = this.child.pid;

    return new Promise((resolve) => {
      const done = () => {
        this.running = false;
        this.child = null;
        resolve({ ok: true });
      };

      // 进程已自然退出
      if (this.child.exitCode !== null || this.child.signalCode !== null) {
        done();
        return;
      }

      const killTimer = setTimeout(() => {
        this.logger.warn('等待 dsh 退出超时，强制执行');
        this._killTree(pid);
        setTimeout(done, 500);
      }, timeout);

      this.child.once('exit', () => {
        clearTimeout(killTimer);
        done();
      });

      // 先优雅退出，超时后再整树强制终止
      this._killTree(pid, { force });
      if (!force && process.platform !== 'win32') {
        // 非 Windows：先 SIGTERM 整个进程组，给 dsh 优雅退出机会
        try {
          process.kill(-pid, 'SIGTERM');
        } catch {}
      }
      if (force || process.platform === 'win32') {
        // 立即强制整树终止（Windows SIGTERM 语义不可靠）
        setTimeout(() => this._killTree(pid, { force: true }), 500);
      }
    });
  }

  /**
   * 终止整棵进程树
   * - Windows: taskkill /pid <pid> /T /F（含子进程）
   * - macOS/Linux: 向进程组发送信号（负 pid）
   */
  _killTree(pid, { force = true } = {}) {
    try {
      if (process.platform === 'win32') {
        const flags = force ? '/T /F' : '/T';
        exec(`taskkill /pid ${pid} ${flags}`, { windowsHide: true }, () => {});
      } else {
        process.kill(-pid, force ? 'SIGKILL' : 'SIGTERM');
      }
    } catch (err) {
      // 进程可能已退出（ESRCH），忽略
      if (err.code !== 'ESRCH') {
        this.logger.warn(`终止 dsh 进程树失败: ${err.message}`);
      }
    }
  }

  /** 重启 dsh */
  async restart(options) {
    await this.stop({ force: true });
    return this.start(options);
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
