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
    /** dsh 自身输出的最近 stderr 缓冲（用于异常退出诊断） */
    this._stderrBuf = [];
    /** 日志回调：{ onLog?: (line: string) => void, onExit?: (code: number|null) => void } */
    this.events = {};
  }

  /** dsh CLI 入口路径 */
  get dshBinPath() {
    return path.join(this.kernelDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  }

  /**
   * 解析 node 命令：优先用安装包内置 Node（process.resourcesPath/node），
   * 无则回退系统 PATH 中的 node。
   * @returns {string}
   */
  _resolveNodeCmd() {
    try {
      const bundled = process.platform === 'win32'
        ? path.join(process.resourcesPath, 'node', 'node.exe')
        : path.join(process.resourcesPath, 'node', 'bin', 'node');
      if (fs.existsSync(bundled)) return bundled;
    } catch {}
    return process.platform === 'win32' ? 'node.exe' : 'node';
  }

  /**
   * 启动 dsh 进程
   * @param {object} [options]
   * @param {string} [options.mode='web'] 运行模式：web / tui / headless
   * @param {string[]} [options.args] 附加参数（headless 时传入任务描述）
   * @param {number} [options.port] 覆盖默认端口
   * @returns {Promise<{ok: boolean, reason?: string}>}
   */
  async start({ mode = 'web', args = [], port } = {}) {
    if (this.running) {
      this.logger.warn('dsh 已在运行，忽略重复启动');
      return { ok: false, reason: 'already-running' };
    }
    // 每次启动重新解析端口，避免残留上次会话的 resolvedPort
    this.resolvedPort = null;

    const portNum = port || this.port;
    const binPath = this.dshBinPath;
    if (!fs.existsSync(binPath)) {
      this.logger.error('内核未安装，无法启动 dsh');
      this.events.onError?.('内核未安装，请先安装 DeepSeek Harness 内核。');
      return { ok: false, reason: 'kernel-not-installed' };
    }
    // 注意：此处不要推送 onStateChange——此时 running 仍为 false，
    // 推送会被渲染层当作"已停止"处理（重新启用启动按钮、回到空态），
    // 撤销用户点击瞬间的反馈。等 spawn 成功、running=true 后再推送"启动中"。

    // 端口占用检测：若目标端口被其他进程占用（非本客户端管理的 dsh），
    // 不杀掉外部进程（危险），而是自动更换可用端口，避免 dsh 启动失败（EADDRINUSE）。
    if (mode === 'web') {
      const resolvedPort = await this._resolveAvailablePort(portNum);
      if (resolvedPort !== portNum) {
        this.logger.warn(`端口 ${portNum} 被占用，已自动改用可用端口 ${resolvedPort}`);
      }
      // 用解析出的端口覆盖，后续启动 dsh 与端口探活都用它
      Object.assign(this, { resolvedPort });
    }
    const cliArgs = [binPath];
    if (mode === 'web') {
      cliArgs.push('web');
      const usePort = this.resolvedPort || portNum;
      if (usePort) {
        cliArgs.push('--port', String(usePort));
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

    // 优先使用安装包内置 Node（process.resourcesPath/node），系统无 Node 时也能运行
    const nodeCmd = this._resolveNodeCmd();
    // 将内置 Node 的 bin 目录加入 PATH，确保 dsh 的插件/子进程能解析到 node
    if (nodeCmd !== 'node' && nodeCmd !== 'node.exe') {
      const bundledBin = process.platform === 'win32'
        ? path.dirname(nodeCmd)
        : path.join(path.dirname(path.dirname(nodeCmd)), 'bin');
      const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
      env[pathKey] = bundledBin + path.delimiter + (env[pathKey] || '');
    }
    this.logger.info(`启动 dsh: ${nodeCmd} ${cliArgs.join(' ')}`);

    try {
      this.child = spawn(nodeCmd, cliArgs, {
        // 绝对路径可能含空格，必须 shell:false + 数组传参
        shell: false,
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
    this.port = this.resolvedPort || portNum;
    this._startPortProbe(this.port);
    // 进程已拉起：立即推送 running=true，渲染层马上显示"启动中"并禁用启动按钮
    this.events.onStateChange?.(this.status);

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
        // 记录最近 60 行 stderr（用于异常退出时展示 dsh 自身报错）
        this._stderrBuf.push(line);
        if (this._stderrBuf.length > 60) this._stderrBuf.shift();
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
      this.resolvedPort = null;
      this.events.onExit?.(code);
      this.events.onStateChange?.(this.status);
      // 诊断：非主动停止的意外退出，把 dsh 自身 stderr 报错附带到 reason，便于用户定位
      if (!this.stopping) {
        const stderrTail = this._stderrBuf.slice(-10).join(' | ').slice(0, 500);
        const reason = code === 0
          ? 'dsh 正常退出（可能因无任务/配置主动退出）'
          : `dsh 异常退出（code=${code}${signal ? ', signal=' + signal : ''}）。${stderrTail ? 'dsh 报错：' + stderrTail : '常见原因：端口被占用、API Key 未配置、工作目录无效。'}`;
        this.logger.warn(reason);
        this.events.onUnexpectedExit?.({ code, signal, reason, stderrTail });
      }
    });

    return { ok: true };
  }

  /**
   * 端口探活：轮询 dsh Web 端口，探测到 HTTP 200 即触发 onReady
   * （解决"进程已启动但 UI 尚未就绪"的状态脱节）
   */
  _startPortProbe(port, maxAttempts = 180, interval = 1000) {
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
        // 端口有响应 + 我们启动的 dsh 进程仍存活，才算真正就绪
        // （防止残留进程占用端口时误判；残留进程会在 start 预检时被清理）
        if (res.status >= 200 && res.status < 500 && this.running && this.child && this.child.exitCode === null) {
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
      this.stopping = false;
      this.resolvedPort = null;
      return Promise.resolve({ ok: true, alreadyStopped: true });
    }
    this.stopping = true;
    const pid = this.child.pid;

    return new Promise((resolve) => {
      const done = () => {
        this.running = false;
        this.child = null;
        this.stopping = false;
        this.resolvedPort = null;
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

  /**
   * 解析可用端口：目标端口被占用时自动顺延（+1），最多尝试 20 个。
   * 只探测端口是否空闲，绝不杀掉占用进程（避免影响其他应用）。
   * @param {number} port 期望端口
   * @returns {Promise<number>} 可用端口
   */
  async _resolveAvailablePort(port) {
    for (let p = port || 3080; p < (port || 3080) + 20; p++) {
      try {
        const res = await fetch(`http://127.0.0.1:${p}`, { signal: AbortSignal.timeout(800) });
        if (res.status >= 200 && res.status < 600) {
          // 端口有服务响应，占用中，试下一个
          continue;
        }
        return p;
      } catch {
        // 端口无响应（连接被拒），视为空闲，可用
        return p;
      }
    }
    return port || 3080; // 兜底返回原端口
  }

  /** 终止指定进程（含子进程树） */
  _killProcess(pid) {
    try {
      if (process.platform === 'win32') {
        exec(`taskkill /pid ${pid} /T /F`, { windowsHide: true }, () => {});
      } else {
        process.kill(pid, 'SIGKILL');
      }
    } catch (err) {
      if (err.code !== 'ESRCH') {
        this.logger.warn(`清理端口占用进程失败: ${err.message}`);
      }
    }
  }

  /** 重启 dsh */
  async restart(options) {
    await this.stop({ force: true });
    return await this.start(options);
  }

  /**
   * 清理本客户端启动但已脱离管理的残留 dsh 进程（安全策略）：
   * - 仅清理命令行包含本客户端 kernel 目录路径的 node 进程（即本客户端启动的 dsh）；
   * - 绝不杀其他应用占用的进程（用户明确要求）。
   * 用于应用退出时兜底，防止端口残留。
   */
  cleanupResidual() {
    try {
      const { execSync } = require('child_process');
      // 匹配用的标记：统一为正斜杠，并剔除引号/反引号，避免注入命令行
      const kernelMarker = this.kernelDir.replace(/\\/g, '/').replace(/['"`]/g, '');
      const isWin = process.platform === 'win32';
      if (isWin) {
        // wmic 已弃用，用 powershell Get-CimInstance 查询进程命令行。
        // 注意：Windows 进程命令行是反斜杠路径，必须先把 CommandLine 归一化成
        // 正斜杠再与 kernelMarker 匹配，否则永远匹配不到。
        // 限定 node.exe 缩小范围，避免误杀其他进程。
        const ps = execSync(
          `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and (($_.CommandLine -replace '\\\\','/') -like '*${kernelMarker}*') } | ForEach-Object { $_.ProcessId }"`,
          { encoding: 'utf8', windowsHide: true }
        );
        for (const line of ps.split(/\r?\n/)) {
          const pid = parseInt(line.trim(), 10);
          if (pid && pid !== process.pid) {
            this.logger.info(`清理残留 dsh 进程 PID ${pid}`);
            this._killProcess(pid);
          }
        }
      } else {
        // macOS/Linux: ps + grep 命令行
        const ps = execSync(`ps -eo pid,command | grep -F -- '${kernelMarker}' | grep -v grep`, { encoding: 'utf8' });
        for (const line of ps.split(/\n/)) {
          const m = line.trim().match(/^\s*(\d+)/);
          if (m && m[1]) {
            const pid = parseInt(m[1], 10);
            if (pid && pid !== process.pid) {
              this.logger.info(`清理残留 dsh 进程 PID ${pid}`);
              this._killProcess(pid);
            }
          }
        }
      }
    } catch {
      // 无残留或查询失败，忽略
    }
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
