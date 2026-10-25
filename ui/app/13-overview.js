// 总览页（V1.1.0）
// 只读展示：数据来自 /api/status、/api/overview、/api/skills。
// 不写入配置、不触发机器人动作；离开页签自动停止轮询。
(function () {
  'use strict';

  const REFRESH_MS = 10000;
  let timer = null;
  let loading = false;

  const $id = (id) => document.getElementById(id);
  const setText = (id, text) => { const el = $id(id); if (el) el.textContent = text; };

  function fmtBytes(n) {
    if (!Number.isFinite(n) || n <= 0) return '-';
    const units = ['B', 'KB', 'MB', 'GB'];
    let v = n, i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
    return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
  }

  function fmtDuration(sec) {
    if (!Number.isFinite(sec) || sec < 0) return '-';
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    if (d > 0) return `${d} 天 ${h} 小时`;
    if (h > 0) return `${h} 小时 ${m} 分`;
    return `${m} 分钟`;
  }

  function render(status, ov, sk) {
    // 机器人服务
    setText('ov-service', ov ? '运行中' : '未知');
    setText('ov-uptime', ov
      ? `已运行 ${fmtDuration(ov.uptimeSec)} · PID ${ov.pid} · Node ${ov.node}`
      : '无法读取进程指标');

    // QQ 连接
    const ob = status && status.onebot;
    if (ob) {
      setText('ov-qq', ob.connected ? '已连接' : '未连接');
      setText('ov-qq-sub', ob.connected
        ? `${ob.self?.nickname || ''} ${ob.self?.userId || ''}`.trim() || '账号在线'
        : (ob.diagnosis || ob.error || '等待连接'));
    } else {
      setText('ov-qq', '未知');
      setText('ov-qq-sub', '无法读取 OneBot 状态');
    }

    // 模型
    setText('ov-model', (ov && ov.model) || '-');
    setText('ov-model-sub', 'OpenAI 兼容接口 · 设置页可切换');

    // 内存
    if (ov && ov.memory) {
      setText('ov-mem', fmtBytes(ov.memory.rss));
      setText('ov-mem-sub', `堆 ${fmtBytes(ov.memory.heapUsed)} / ${fmtBytes(ov.memory.heapTotal)}`);
    }

    // 系统负载
    if (ov && ov.system) {
      const s = ov.system;
      setText('ov-load', `${s.load1.toFixed(2)} / ${s.load5.toFixed(2)} / ${s.load15.toFixed(2)}`);
      setText('ov-load-sub', `${s.cpus} 核 · 系统可用 ${fmtBytes(s.freemem)} / ${fmtBytes(s.totalmem)}`);
    }

    // 技能 / 插件
    const list = (sk && sk.skills) || [];
    if (sk && sk.summary) {
      const sum = sk.summary;
      const plugins = list.filter((s) => s.kind === 'plugin').length;
      const skills = list.filter((s) => s.kind !== 'plugin').length;
      setText('ov-skills', `${sum.active ?? 0} / ${sum.total ?? list.length} 生效`);
      setText('ov-skills-sub', `技能 ${skills} · 插件 ${plugins} · 停用 ${sum.disabled ?? 0} · 异常 ${sum.broken ?? 0}`);
    } else {
      setText('ov-skills', '-');
      setText('ov-skills-sub', '无法读取模块列表');
    }

    // 今日用量
    const usage = (status && status.usage) || null;
    if (usage) {
      setText('ov-usage', `${usage.totalTokens ?? 0} tokens`);
      setText('ov-usage-sub', `输入 ${usage.promptTokens ?? 0} · 输出 ${usage.completionTokens ?? 0} · 运行 ${usage.runs ?? 0} 次`);
    } else {
      setText('ov-usage', '-');
      setText('ov-usage-sub', '今日暂无数据');
    }

    const now = new Date();
    setText('ov-updated', `更新于 ${now.toLocaleTimeString('zh-CN', { hour12: false })}`);
  }

  async function loadOverview() {
    if (loading) return;
    loading = true;
    try {
      const [status, ov, sk] = await Promise.all([
        api('/api/status').catch(() => null),
        api('/api/overview').catch(() => null),
        api('/api/skills').catch(() => null)
      ]);
      render(status, ov, sk);
    } finally {
      loading = false;
    }
  }

  function startTimer() {
    stopTimer();
    timer = setInterval(() => {
      if (document.visibilityState === 'visible') loadOverview();
    }, REFRESH_MS);
  }

  function stopTimer() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  function init() {
    const overviewTab = document.querySelector('.tab[data-tab="overview"]');
    if (!overviewTab) return;

    overviewTab.addEventListener('click', () => {
      loadOverview();
      startTimer();
    });
    document.querySelectorAll('.tab').forEach((t) => {
      if (t.dataset.tab !== 'overview') t.addEventListener('click', stopTimer);
    });
    $id('ov-refresh')?.addEventListener('click', loadOverview);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') stopTimer();
      else if (document.querySelector('.tab.active')?.dataset.tab === 'overview') {
        loadOverview();
        startTimer();
      }
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
