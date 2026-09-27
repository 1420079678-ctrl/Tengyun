'use strict';

/**
 * Tengyun renderer. Codex-style transcript: user turns as quoted blocks, assistant text set flush,
 * tool calls collapsed to one mono line, file changes rendered as real diffs.
 * IPC contract is fixed by preload.cjs; every event type emitted by the kernel is handled here.
 */
(() => {
  const api = window.tengyun;
  const $ = id => document.getElementById(id);
  const state = {
    info: null, workspace: '', runs: [], events: new Map(), selected: null, active: null,
    submitting: false, approvals: [], toastTimer: null, streaming: new Map(), steps: 0, wallpaper: null,
  };

  const RUN_LABELS = {
    running: '执行中', started: '执行中', completed: '已完成', complete: '已完成',
    incomplete: '有未完成步骤', interrupted: '已中断', failed: '失败', error: '失败',
    cancelled: '已停止', canceled: '已停止', awaiting_approval: '等待确认', waiting_approval: '等待确认',
    pending: '准备中', stopped: '已停止', max_steps: '达到轮数上限',
  };
  const TERMINAL = new Set(['run:complete', 'run:error', 'run:cancelled', 'run:cancel']);
  const TOOL_LABELS = {
    file_read: '读取文件', read_file: '读取文件', file_write: '写入文件', write_file: '写入文件',
    list_files: '浏览目录', list_directory: '浏览目录', search_files: '搜索', run_command: '执行命令',
    command_execute: '执行命令', plan_update: '更新计划', update_plan: '更新计划',
    memory_save: '保存记忆', memory_search: '检索记忆', git_diff: '查看改动', git_commit: '提交改动',
    apply_patch: '应用补丁', read_many: '批量读取', web_fetch: '抓取网页',
  };
  const APPROVAL_MODES = { always: '每次确认', session: '信任同类操作', never: '全部自动' };

  // ── helpers ──────────────────────────────────────────────────────────────────
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }
  function svgIcon(name, className) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    if (className) svg.setAttribute('class', className);
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#i-' + name);
    svg.append(use);
    return svg;
  }
  function stringify(value) {
    if (value === undefined || value === null) return '';
    if (typeof value === 'string') return value;
    try { return JSON.stringify(value, null, 2); } catch { return String(value); }
  }
  function plainText(value) {
    if (Array.isArray(value)) return value.map(item => (typeof item === 'string' ? item : item?.text || '')).join('\n');
    return stringify(value);
  }
  function brief(value, limit = 160) {
    const text = stringify(value);
    return text.length > limit ? text.slice(0, limit) + '…' : text;
  }
  function clock(value) {
    if (!value) return '';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  }
  function dayLabel(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const today = new Date();
    const sameDay = date.toDateString() === today.toDateString();
    return sameDay ? clock(value) : date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
  }
  function basename(path) {
    const parts = String(path || '').split(/[\\/]/).filter(Boolean);
    return parts.at(-1) || '';
  }
  function eventsFor(id = state.selected) { return state.events.get(id) || []; }
  function runById(id = state.selected) { return state.runs.find(item => item.id === id); }
  function titleFor(run) { return run?.title || run?.input || '未命名任务'; }
  function toolName(event) { return event.name || event.tool || event.toolName || 'tool'; }
  function toolLabel(event) { const name = toolName(event); return TOOL_LABELS[name] || name; }
  function configured() {
    const settings = state.info?.settings;
    if (!settings?.baseUrl || !settings.model) return false;
    try { return settings.hasApiKey || ['localhost', '127.0.0.1', '[::1]'].includes(new URL(settings.baseUrl).hostname); }
    catch { return false; }
  }
  function toast(message, isError = false) {
    clearTimeout(state.toastTimer);
    $('toast').textContent = message;
    $('toast').classList.toggle('error', isError);
    $('toast').hidden = false;
    state.toastTimer = setTimeout(() => { $('toast').hidden = true; }, isError ? 8000 : 3200);
  }
  function fieldError(id, message) { $(id).textContent = message || ''; $(id).hidden = !message; }

  // ── markdown-lite ────────────────────────────────────────────────────────────
  function renderRichText(parent, text) {
    const lines = String(text).split('\n');
    let list = null;
    const closeList = () => { if (list) { parent.append(list); list = null; } };
    const line_ = (text2) => { const node = el('p'); node.append(inlineText(text2)); return node; };
    for (const line of lines) {
      const heading = /^(#{1,4})\s+(.*)$/.exec(line);
      const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
      const ordered = /^\s*(\d+)[.)]\s+(.*)$/.exec(line);
      const quote = /^>\s?(.*)$/.exec(line);
      if (heading) {
        closeList();
        const node = el(['h1', 'h2', 'h3', 'h4'][heading[1].length - 1]);
        node.append(inlineText(heading[2]));
        parent.append(node);
      } else if (bullet) {
        if (!list || list.tagName !== 'UL') { closeList(); list = el('ul'); }
        const item = el('li');
        item.append(inlineText(bullet[1]));
        list.append(item);
      } else if (ordered) {
        if (!list || list.tagName !== 'OL') { closeList(); list = el('ol'); }
        const item = el('li');
        item.append(inlineText(ordered[2]));
        list.append(item);
      } else if (quote) {
        closeList();
        const quoted = el('blockquote', 'quoted');
        quoted.append(inlineText(quote[1]));
        parent.append(quoted);
      } else if (!line.trim()) {
        closeList();
      } else {
        closeList();
        parent.append(line_(line));
      }
    }
    closeList();
  }
  function inlineText(raw) {
    const span = el('span');
    const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\n]+\*)/g;
    let cursor = 0;
    for (const match of String(raw).matchAll(pattern)) {
      if (match.index > cursor) span.append(document.createTextNode(raw.slice(cursor, match.index)));
      const token = match[0];
      if (token.startsWith('`')) span.append(el('code', '', token.slice(1, -1)));
      else if (token.startsWith('**')) span.append(el('strong', '', token.slice(2, -2)));
      else span.append(el('em', '', token.slice(1, -1)));
      cursor = match.index + token.length;
    }
    if (cursor < raw.length) span.append(document.createTextNode(raw.slice(cursor)));
    return span;
  }
  function renderBody(parent, text) {
    const fence = /```([^\n`]*)\n([\s\S]*?)```/g;
    let cursor = 0;
    for (const match of String(text).matchAll(fence)) {
      if (match.index > cursor) renderRichText(parent, text.slice(cursor, match.index));
      const pre = el('pre');
      if (match[1].trim()) pre.append(el('span', 'code-lang', match[1].trim()));
      pre.append(el('code', '', match[2].replace(/\n$/, '')));
      parent.append(pre);
      cursor = match.index + match[0].length;
    }
    if (cursor < text.length) renderRichText(parent, text.slice(cursor));
  }

  // ── diff rendering ───────────────────────────────────────────────────────────
  function diffStats(text) {
    let add = 0, del = 0;
    for (const line of String(text).split('\n')) {
      if (line.startsWith('+') && !line.startsWith('+++')) add++;
      else if (line.startsWith('-') && !line.startsWith('---')) del++;
    }
    return { add, del };
  }
  function renderDiff(text) {
    const box = el('div', 'diff');
    let oldLine = 0, newLine = 0;
    for (const line of String(text).split('\n')) {
      if (line.startsWith('@@')) {
        const match = /@@\s*-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s*@@/.exec(line);
        oldLine = match ? Number(match[1]) : oldLine;
        newLine = match ? Number(match[2]) : newLine;
        box.append(el('span', 'diff-hunk', line));
        continue;
      }
      if (line.startsWith('--- ') || line.startsWith('+++ ') || line.startsWith('diff ') || line.startsWith('index ')) continue;
      const kind = line[0] === '+' ? 'add' : line[0] === '-' ? 'del' : ' ';
      if (kind === 'add') { newLine += 1; } else if (kind === 'del') { oldLine += 1; } else { oldLine += 1; newLine += 1; }
      const row = el('div', 'diff-line' + (kind === ' ' ? '' : ' ' + kind));
      row.append(el('span', 'ln', kind === 'add' ? String(newLine) : String(oldLine)));
      row.append(el('span', 'ln', kind === 'del' ? String(oldLine) : String(newLine)));
      row.append(el('span', 'code', line.slice(1) || ' '));
      box.append(row);
    }
    return box;
  }

  // ── thread rendering ─────────────────────────────────────────────────────────
  function toolArgument(event) {
    const args = event.args || {};
    if (typeof args === 'string') return brief(args, 90);
    if (args.path) return basename(args.path) || args.path;
    if (args.filePath) return basename(args.filePath);
    if (args.query) return String(args.query).slice(0, 60);
    if (args.command) return String(args.command).split('\n')[0].slice(0, 90);
    if (args.url) return String(args.url).slice(0, 70);
    return '';
  }
  function resultOf(event) {
    if (event.result === undefined || event.result === null) return event.data ?? null;
    return event.result;
  }
  function failedResult(result) {
    if (!result || typeof result !== 'object') return false;
    return result.ok === false || Boolean(result.error) || result.success === false
      || result.timedOut === true || result.cancelled === true
      || (typeof result.exitCode === 'number' && result.exitCode !== 0);
  }
  function resultBody(result) {
    if (result === undefined || result === null) return '（工具尚未返回结果）';
    if (typeof result === 'string') return result;
    if (result.error) return typeof result.error === 'string' ? result.error : stringify(result.error);
    if (result.stdout !== undefined || result.stderr !== undefined) {
      const out = String(result.stdout ?? '');
      const err = String(result.stderr ?? '');
      const head = `exit=${result.exitCode ?? 0}${result.timedOut ? ' timedOut' : ''}${result.truncated ? ' truncated' : ''}`;
      return [head, out && `\n${out}`, err && `\n${err}`].filter(Boolean).join('');
    }
    return stringify(result);
  }
  function appendToolRow(container, event, result) {
    const failed = failedResult(result);
    const row = el('details', 'tool-row' + (failed ? ' failed' : '') + (result ? '' : ' running'));
    const summary = el('summary', 'tool-line');
    summary.append(svgIcon('chevron-right', 'caret'));
    const main = el('span', 'tool-main');
    main.append(el('span', 'tool-name', toolLabel(event)));
    const arg = toolArgument(event);
    if (arg) main.append(el('span', 'tool-arg', arg));
    summary.append(main, el('span', 'tool-state', result ? (failed ? '失败' : '完成') : '运行中…'));
    const body = el('div', 'tool-output');
    const pre = el('pre');
    pre.append(el('span', failed ? 'err' : '', resultBody(result)));
    body.append(pre);
    if (result && typeof result === 'object' && typeof result.diff === 'string' && result.diff.trim()) {
      const wrap = el('div', 'inline-diff');
      const stats = diffStats(result.diff);
      const head = el('div', 'inline-diff-head');
      head.append(el('span', '', result.path || basename(event.args?.path) || 'file'));
      head.append(el('span', 'stat-add', '+' + stats.add), el('span', 'stat-del', '−' + stats.del));
      wrap.append(head, renderDiff(result.diff));
      body.append(wrap);
    }
    row.append(summary, body);
    container.append(row);
  }
  function appendMessage(container, event) {
    const role = event.role || event.message?.role || 'assistant';
    const text = plainText(event.content ?? event.message?.content ?? event.text);
    if (!text) return;
    const turn = el('article', 'turn ' + (role === 'user' ? 'user-turn' : 'assistant-turn'));
    const body = el('div', 'turn-body');
    if (role === 'user') {
      body.textContent = text;
    } else {
      renderBody(body, text);
      if (event.streaming) body.append(el('span', 'stream-cursor'));
    }
    turn.append(body);
    container.append(turn);
  }
  function systemNote(kind, text) {
    const note = el('div', 'system-note' + (kind ? ' ' + kind : ''));
    note.append(svgIcon(kind === 'error' ? 'alert' : kind === 'warn' ? 'alert' : 'check'));
    note.append(el('span', '', text));
    return note;
  }
  function renderTranscript() {
    const scroll = $('conversation-scroll');
    const stick = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 140;
    const transcript = $('transcript');
    transcript.replaceChildren();
    const raw = eventsFor();
    $('welcome').hidden = Boolean(state.selected || raw.length);
    const run = runById();
    const results = raw.filter(item => item.type === 'tool:result');
    const hasUser = raw.some(item => item.type === 'run:message' && (item.role || item.message?.role) === 'user');
    if (run?.input && !hasUser) appendMessage(transcript, { role: 'user', content: run.input });

    for (const event of raw) {
      if (event.type === 'run:message' || event.type === 'message') appendMessage(transcript, event);
      if (event.type === 'tool:request') {
        const result = results.find(item => event.toolCallId
          ? item.toolCallId === event.toolCallId
          : item.name === event.name && raw.indexOf(item) > raw.indexOf(event));
        appendToolRow(transcript, event, result);
      }
      if (event.type === 'run:complete') {
        if (event.status === 'cancelled') transcript.append(systemNote('', '执行已停止，已完成的操作保留在记录中。'));
        else if (event.status === 'max_steps') transcript.append(systemNote('warn', '已达到本次任务的轮数上限。可在设置里提高上限，或缩小任务范围。'));
        else if (event.status === 'incomplete') transcript.append(systemNote('warn', '本次执行结束，但计划中仍有未完成步骤——展开工具输出核对实际结果。'));
        else transcript.append(systemNote('', '执行结束。结论请结合工具实际返回核对。'));
      }
      if (event.type === 'run:error') {
        const message = plainText(event.error?.message || event.error || event.message || '未知错误');
        transcript.append(systemNote(event.status === 'cancelled' ? '' : 'error', event.status === 'cancelled' ? '执行已停止。' : '执行中断：' + message));
      }
    }
    const tail = $('task-title');
    tail.textContent = run ? brief(titleFor(run), 52) : '新建任务';
    if (stick) scroll.scrollTop = scroll.scrollHeight;
  }

  // ── review panel ─────────────────────────────────────────────────────────────
  function planSteps() {
    const events = eventsFor();
    const update = [...events].reverse().find(item => ['plan:update', 'run:plan'].includes(item.type));
    const plan = update?.tasks || update?.steps || update?.plan?.steps || update?.plan || [];
    if (Array.isArray(plan)) return plan;
    return typeof plan === 'string' ? plan.split('\n').filter(Boolean) : [];
  }
  function renderPlan() {
    const plan = planSteps();
    const list = $('plan-list');
    list.replaceChildren();
    $('plan-count').textContent = String(plan.length);
    $('plan-empty').hidden = plan.length > 0;
    plan.forEach((step, index) => {
      const raw = typeof step === 'object' ? step.status || 'pending' : 'pending';
      const status = { done: 'completed', complete: 'completed', running: 'in_progress', active: 'in_progress' }[raw] || raw;
      const li = el('li', 'plan-step ' + (['pending', 'in_progress', 'completed', 'failed'].includes(status) ? status : 'pending'));
      li.append(el('span', 'step-index', status === 'completed' ? '✓' : String(index + 1)));
      const text = el('span');
      text.append(document.createTextNode(typeof step === 'string' ? step : step.title || step.text || step.description || step.step || '执行步骤'));
      if (typeof step === 'object' && (step.dependsOn?.length || step.evidence?.length)) {
        text.append(el('small', 'step-detail', [step.dependsOn?.length ? '依赖 ' + step.dependsOn.join(' ') : '', step.evidence?.length ? step.evidence.length + ' 条证据' : ''].filter(Boolean).join(' · ')));
      }
      li.append(text);
      list.append(li);
    });

    const evidence = eventsFor().filter(item => item.type === 'tool:result' && item.evidenceId);
    $('evidence-count').textContent = String(evidence.length);
    const box = $('evidence-list');
    box.replaceChildren();
    for (const item of evidence) {
      const failed = failedResult(resultOf(item));
      const card = el('div', 'evidence-item' + (failed ? ' failed' : ''));
      const head = el('div', 'evidence-header');
      head.append(el('span', '', toolLabel(item)), el('span', 'evidence-status', failed ? '失败' : '已记录'));
      card.append(head, el('p', '', brief(resultOf(item)?.path || resultOf(item)?.summary || item.result?.stdout || resultOf(item), 110)));
      const details = el('details');
      const summary = el('summary', '', '原始返回');
      summary.style.cursor = 'pointer';
      details.append(summary, el('pre', '', item.evidenceId + '\n\n' + resultBody(resultOf(item))));
      card.append(details);
      box.append(card);
    }
  }
  function renderChanges() {
    const results = eventsFor().filter(item => item.type === 'tool:result' && typeof resultOf(item)?.diff === 'string' && resultOf(item).diff.trim());
    $('change-count').textContent = String(results.length);
    $('changes-empty').hidden = results.length > 0;
    const list = $('change-list');
    list.replaceChildren();
    for (const item of results) {
      const result = resultOf(item);
      const stats = diffStats(result.diff);
      const card = el('div', 'change');
      const head = el('button', 'change-head');
      head.type = 'button';
      head.append(svgIcon('diff'), el('span', 'change-path', result.path || basename(item.args?.path) || 'file'));
      head.append(el('span', 'change-stat', ''));
      head.lastChild.append(el('span', 'add', '+' + stats.add), document.createTextNode(' '), el('span', 'del', '−' + stats.del));
      const body = el('div', 'change-body');
      body.append(renderDiff(result.diff));
      body.hidden = true;
      head.addEventListener('click', () => { body.hidden = !body.hidden; });
      card.append(head, body);
      list.append(card);
    }
  }
  const TRACE_LABELS = {
    'run:start': '任务开始', 'run:model': '请求模型', 'run:usage': '用量', 'run:retry': '重试',
    'run:settled': '已释放', 'run:context': '载入历史上下文', 'plan:update': '计划更新',
    'run:plan': '计划更新', 'tool:request': '请求工具', 'tool:result': '工具返回',
    'tool:output': '输出', 'tool:approval': '操作确认', 'approval:request': '等待确认',
    'approval:response': '已确认', 'run:complete': '执行结束', 'run:error': '执行出错',
    'run:cancelled': '已停止', 'run:delta': '流式输出',
  };
  function renderTrace() {
    const rows = eventsFor().filter(item => !['run:message', 'message', 'run:delta', 'tool:output'].includes(item.type));
    $('trace-count').textContent = String(rows.length);
    const list = $('trace-list');
    list.replaceChildren();
    if (!rows.length) { list.append(el('div', 'empty-note', '还没有执行记录。')); return; }
    for (const event of rows) {
      const failed = event.type === 'run:error' || failedResult(resultOf(event));
      const row = el('div', 'trace-row' + (failed ? ' error' : event.type === 'tool:result' ? ' ok' : ''));
      const text = el('div', 'trace-text');
      text.append(el('span', '', TRACE_LABELS[event.type] || event.type));
      const detail = event.type === 'tool:result' ? brief(resultOf(event), 120) : (event.args ? brief(event.args, 120) : event.message || '');
      if (detail) text.append(el('p', '', detail));
      row.append(el('span', 'trace-marker'), text, el('span', 'trace-time', clock(event.time || event.createdAt || event.at)));
      list.append(row);
    }
  }
  function renderReview() {
    renderPlan();
    renderChanges();
    renderTrace();
    const run = runById();
    const waiting = state.approvals.some(item => item.runId === state.selected);
    const pill = $('run-state');
    pill.textContent = waiting ? '等待确认' : (RUN_LABELS[run?.status] || '待命');
    pill.classList.toggle('running', run?.id === state.active);
    pill.classList.toggle('error', ['failed', 'error'].includes(run?.status));
  }

  // ── history + chrome ─────────────────────────────────────────────────────────
  function renderHistory() {
    const box = $('task-history');
    box.replaceChildren();
    $('run-count').textContent = String(state.runs.length);
    if (!state.runs.length) { box.append(el('p', 'history-empty', '还没有任务。')); return; }
    const sorted = [...state.runs].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    for (const run of sorted) {
      const active = run.id === state.active;
      const item = el('button', 'history-item' + (run.id === state.selected ? ' active' : '') + (active ? ' running' : ''));
      item.type = 'button';
      item.title = titleFor(run);
      item.append(svgIcon(active ? 'activity' : 'terminal'));
      const content = el('span', 'history-item-content');
      content.append(el('span', 'history-item-title', titleFor(run)));
      content.append(el('span', 'history-item-meta', [dayLabel(run.createdAt), RUN_LABELS[run.status] || run.status].filter(Boolean).join(' · ')));
      item.append(content);
      item.addEventListener('click', () => selectRun(run.id));
      box.append(item);
    }
  }
  function renderChrome() {
    const settings = state.info?.settings || {};
    const model = settings.model || '选择模型';
    $('sidebar-model').textContent = model;
    $('composer-model').textContent = model;
    $('composer-model-chip-text').textContent = model;
    $('version').textContent = 'v' + (state.info?.version || '0.1.0');
    $('perm-label').textContent = APPROVAL_MODES[settings.approval] || APPROVAL_MODES.always;
    const ready = configured();
    document.querySelector('.pill-dot').classList.toggle('off', !ready);
    $('composer-model-chip').querySelector('.chip-dot').classList.toggle('off', !ready);
    const ws = state.workspace;
    $('workspace-label').textContent = ws ? (basename(ws) || ws) : '选择工作目录';
    $('topbar-workspace').textContent = ws ? (basename(ws) || ws) : '—';
    $('footer-workspace').textContent = ws || '未选择工作目录';
  }
  function renderUsage() {
    const usage = eventsFor().filter(item => item.type === 'run:usage');
    if (!usage.length) { $('footer-usage').textContent = '—'; return; }
    const total = usage.reduce((sum, item) => sum + (item.totalTokens || item.usage?.total_tokens || 0), 0);
    const last = usage.at(-1);
    const perCall = last?.totalTokens || last?.usage?.total_tokens || 0;
    $('footer-usage').textContent = `${state.steps} 轮 · ${perCall} tok/轮 · 共 ${total} tok`;
  }
  function renderBusy() {
    const busy = Boolean(state.active || state.submitting);
    $('run-progress').hidden = !busy;
    $('run-progress-text').textContent = state.approvals.length ? '等待你确认操作'
      : state.submitting ? '正在启动' : '正在执行';
    $('run-steps').textContent = busy && state.steps ? `第 ${state.steps} 轮` : '';
    $('send-task').disabled = busy || !api;
    $('cancel-run').disabled = !state.active;
    $('choose-workspace').disabled = busy || !api;
    $('footer-status').textContent = busy ? (state.approvals.length ? '等待确认' : '执行中') : '就绪';
    document.querySelector('.status-dot').classList.toggle('live', busy);
    $('composer-hint').textContent = state.active ? 'Esc 停止 · Shift+Enter 换行' : 'Enter 发送 · Shift+Enter 换行';
  }
  function renderAll() { renderHistory(); renderTranscript(); renderReview(); renderChrome(); renderUsage(); renderBusy(); }

  // ── appearance ───────────────────────────────────────────────────────────────
  const APPEARANCE_LABELS = { light: '浅色', dark: '深色', wallpaper: '壁纸' };

  /**
   * Apply an appearance. The wallpaper image is referenced by its short custom-scheme URL as a
   * CSS custom property, never as an inline style attribute (the page CSP is `style-src 'self'`)
   * and never as a data URL (a multi-megabyte custom-property value is dropped by the engine).
   */
  function applyAppearance(mode, wallpaper = state.wallpaper) {
    const root = document.documentElement;
    const resolved = ['light', 'dark', 'wallpaper'].includes(mode) ? mode : 'light';
    root.dataset.theme = resolved;
    const usable = resolved === 'wallpaper' && wallpaper?.url;
    document.body.classList.toggle('has-wallpaper', Boolean(usable));
    root.style.setProperty('--wallpaper-image', usable ? `url("${wallpaper.url}")` : 'none');
    localStorage.setItem('tengyun-theme', resolved);
    return resolved;
  }
  function cycleAppearance() {
    const order = ['light', 'dark', 'wallpaper'];
    const current = document.documentElement.dataset.theme || 'light';
    const next = order[(order.indexOf(current) + 1) % order.length];
    if (next === 'wallpaper' && !state.wallpaper?.url) {
      toast('还没有选择壁纸图片，先在设置里选一张。');
      openSettings();
      return;
    }
    applyAppearance(next);
    $('toggle-theme').title = '当前：' + APPEARANCE_LABELS[next] + '（点击切换）';
    api?.setTheme?.(next).catch(() => {});
  }
  function renderAppearanceControls() {
    const current = document.documentElement.dataset.theme || 'light';
    for (const button of document.querySelectorAll('.segment')) {
      const active = button.dataset.appearance === current;
      button.classList.toggle('active', active);
      button.setAttribute('aria-checked', String(active));
    }
    const name = state.wallpaper?.name;
    $('wallpaper-hint').textContent = name ? `${name} · ${Math.round((state.wallpaper.bytes || 0) / 1024)} KB` : '未选择';
    $('remove-wallpaper').disabled = !name;
    $('appearance-hint').textContent = current === 'wallpaper' ? '图片背景' : '默认浅色';
  }
  async function pickWallpaper() {
    if (!api?.chooseWallpaper) return;
    try {
      const result = await api.chooseWallpaper();
      if (!result) return;
      state.wallpaper = result.wallpaper;
      state.info = { ...state.info, settings: result.settings };
      applyAppearance('wallpaper', state.wallpaper);
      renderAppearanceControls();
      toast('壁纸已应用。');
    } catch (error) { fieldError('settings-error', error.message); }
  }
  async function removeWallpaper() {
    if (!api?.clearWallpaper) return;
    try {
      const result = await api.clearWallpaper();
      state.wallpaper = null;
      state.info = { ...state.info, settings: result.settings };
      applyAppearance(result.settings?.appearance || 'light', null);
      renderAppearanceControls();
      toast('壁纸已移除。');
    } catch (error) { fieldError('settings-error', error.message); }
  }

  // ── data flow ────────────────────────────────────────────────────────────────
  async function refreshRuns() {
    if (!api) return;
    const result = await api.listRuns();
    state.runs = Array.isArray(result) ? result : result?.runs || [];
    renderHistory();
  }
  async function selectRun(id) {
    state.selected = id;
    state.steps = 0;
    renderAll();
    if (!api || id === state.active) return;
    try {
      const run = await api.getRun(id);
      if (!run) return;
      state.events.set(id, Array.isArray(run.events) ? run.events : []);
      const index = state.runs.findIndex(item => item.id === id);
      if (index >= 0) state.runs[index] = { ...state.runs[index], ...run, events: undefined };
      renderAll();
      const scroll = $('conversation-scroll');
      scroll.scrollTop = scroll.scrollHeight;
    } catch (error) { toast('读取任务失败：' + error.message, true); }
  }
  function newTask() {
    state.selected = null;
    state.steps = 0;
    $('task-input').value = '';
    autoGrow();
    renderAll();
    $('conversation-scroll').scrollTop = 0;
    $('task-input').focus();
  }
  function autoGrow() {
    const input = $('task-input');
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 320) + 'px';
  }
  async function submitTask(event) {
    event?.preventDefault();
    const input = $('task-input').value.trim();
    if (!input || state.active || state.submitting) return;
    if (!api) { toast('请通过 Tengyun 桌面应用打开此界面。', true); return; }
    if (!configured()) { openSettings(); toast('先连接一个模型。'); return; }
    if (!state.workspace) { await chooseWorkspace(); if (!state.workspace) return; }
    state.submitting = true;
    state.steps = 0;
    renderBusy();
    try {
      const parentId = state.selected;
      const result = await api.run({ input, parentId: parentId || undefined });
      const id = typeof result === 'string' ? result : result?.id || result?.runId;
      if (!id) throw new Error('应用未返回任务编号');
      state.selected = id;
      if (!eventsFor(id).some(item => TERMINAL.has(item.type))) state.active = id;
      if (!state.runs.some(run => run.id === id)) {
        state.runs.unshift({ id, input, title: input, status: 'running', createdAt: new Date().toISOString() });
      }
      $('task-input').value = '';
      autoGrow();
      renderAll();
      $('conversation-scroll').scrollTop = $('conversation-scroll').scrollHeight;
    } catch (error) { toast('无法开始任务：' + error.message, true); }
    finally { state.submitting = false; renderBusy(); }
  }
  async function chooseWorkspace() {
    if (!api || state.active) return;
    try {
      const result = await api.chooseWorkspace();
      if (result) {
        state.workspace = typeof result === 'string' ? result : result.path || result.workspace || '';
        state.info = await api.info();
        renderChrome();
      }
    } catch (error) { toast('选择目录失败：' + error.message, true); }
  }
  function openSettings() {
    const settings = state.info?.settings || {};
    $('setting-base-url').value = settings.baseUrl || '';
    $('setting-model').value = settings.model || '';
    $('setting-max-steps').value = settings.maxSteps || 60;
    $('setting-approval').value = settings.approval || 'always';
    updateApprovalHelp();
    $('setting-api-key').value = '';
    $('setting-api-key').placeholder = settings.hasApiKey ? '已保存密钥，留空保留' : '输入 API Key（本地模型可留空）';
    $('key-hint').textContent = settings.hasApiKey ? '已保存' : '仅用于连接模型';
    fieldError('settings-error', '');
    renderAppearanceControls();
    if (!$('settings-dialog').open) $('settings-dialog').showModal();
  }
  function updateApprovalHelp() {
    $('approval-help').textContent = {
      always: '每次写入文件或执行命令都询问你。',
      session: '同类操作在本次任务里只问一次，其余自动放行。',
      never: '全部自动执行。仅在你完全信任当前任务时使用。',
    }[$('setting-approval').value] || '';
  }
  async function saveSettings(event) {
    event.preventDefault();
    if (!api) { fieldError('settings-error', '请通过桌面应用保存配置。'); return; }
    const payload = {
      baseUrl: $('setting-base-url').value.trim(),
      model: $('setting-model').value.trim(),
      maxSteps: Number($('setting-max-steps').value),
      approval: $('setting-approval').value,
      appearance: document.documentElement.dataset.theme || 'light',
    };
    const apiKey = $('setting-api-key').value.trim();
    if (apiKey) payload.apiKey = apiKey;
    $('save-settings').disabled = true;
    try {
      await api.saveSettings(payload);
      state.info = await api.info();
      $('setting-api-key').value = '';
      renderChrome();
      $('settings-dialog').close();
      toast('已保存。');
    } catch (error) { fieldError('settings-error', error.message); }
    finally { $('save-settings').disabled = false; }
  }
  function showNextApproval() {
    const approval = state.approvals[0];
    const dialog = $('approval-dialog');
    if (!approval) { if (dialog.open) dialog.close(); renderBusy(); return; }
    const name = toolName(approval);
    $('approval-tool').textContent = `${toolLabel(approval)} · ${name}`;
    $('approval-details').textContent = '工作目录：' + (runById(approval.runId)?.workspace || state.workspace)
      + '\n\n' + stringify(approval.args || approval.details || {});
    $('approval-description').textContent = /command|shell|exec|commit/i.test(name)
      ? 'Tengyun 请求执行命令或提交，命令可能读写工作区外的内容，请检查。'
      : 'Tengyun 请求修改本地内容，请检查目标与具体改动。';
    fieldError('approval-error', '');
    $('allow-approval').disabled = false;
    $('deny-approval').disabled = false;
    if (!dialog.open) dialog.showModal();
    $('deny-approval').focus();
    renderBusy();
  }
  async function decideApproval(approved) {
    const approval = state.approvals[0];
    if (!approval || !api) return;
    $('allow-approval').disabled = true;
    $('deny-approval').disabled = true;
    try {
      await api.approve({ approvalId: approval.approvalId || approval.id, approved });
      state.approvals.shift();
      showNextApproval();
      renderReview();
    } catch (error) {
      fieldError('approval-error', error.message);
      $('allow-approval').disabled = false;
      $('deny-approval').disabled = false;
    }
  }

  // ── event intake ─────────────────────────────────────────────────────────────
  function receiveEvent(raw) {
    if (!raw || typeof raw !== 'object') return;
    const id = raw.runId || state.active || state.selected;
    if (!id) return;
    const list = state.events.get(id) || [];

    if (raw.type === 'run:delta') {
      // Streaming assistant text: accumulate onto the open assistant turn.
      const last = list.at(-1);
      const chunk = raw.text || raw.delta || '';
      if (last && last.type === 'run:delta') last.text = (last.text || '') + chunk;
      else list.push({ ...raw, runId: id, text: chunk });
      state.events.set(id, list);
      streamRender(id);
      return;
    }
    if (raw.type === 'tool:output') {
      const target = list.find(item => item.toolCallId && item.toolCallId === raw.toolCallId && item.type === 'tool:result');
      if (target) { target.output = (target.output || '') + (raw.text || ''); target.streaming = true; }
      state.events.set(id, list);
      if (id === state.selected) renderTranscript();
      return;
    }

    list.push({ ...raw, runId: id });
    state.events.set(id, list);
    const steps = raw.steps;
    if (typeof steps === 'number') state.steps = steps;

    let run = state.runs.find(item => item.id === id);
    if (!run) {
      run = { id, input: raw.input || '', title: raw.input || '新任务', status: 'running', createdAt: raw.time || new Date().toISOString() };
      state.runs.unshift(run);
    }
    if (raw.type === 'run:start') { state.active = id; state.selected = id; run.status = 'running'; if (raw.input) { run.input = raw.input; run.title = raw.input; } }
    if (raw.workspace) run.workspace = raw.workspace;
    if (raw.type === 'run:message' && raw.role === 'user') { run.input = plainText(raw.content); run.title = run.input; }
    if (raw.type === 'run:message' && raw.role === 'assistant') state.streaming.delete(id);
    if (raw.type === 'approval:request' && !state.approvals.some(item => item.approvalId === raw.approvalId)) {
      state.approvals.push({ ...raw, runId: id });
      showNextApproval();
    }
    if (TERMINAL.has(raw.type)) {
      run.status = raw.status || (raw.type === 'run:error' ? 'failed' : raw.type.startsWith('run:cancel') ? 'cancelled' : 'completed');
      state.approvals = state.approvals.filter(item => item.runId !== id);
      showNextApproval();
    }
    if (raw.type === 'run:settled') {
      if (state.active === id) state.active = null;
      state.approvals = state.approvals.filter(item => item.runId !== id);
      showNextApproval();
    }
    renderHistory();
    renderBusy();
    if (id === state.selected) { renderTranscript(); renderReview(); renderUsage(); }
  }
  /** Cheap in-place update of the streaming assistant bubble — no full re-render per token. */
  function streamRender(id) {
    if (id !== state.selected) return;
    const scroll = $('conversation-scroll');
    const stick = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 140;
    const raw = eventsFor(id);
    const tailIndex = raw.findIndex(item => item.type === 'run:delta');
    if (tailIndex < 0) return;
    let node = $('transcript').lastElementChild;
    // Rebuild only the tail: everything before the streaming chunk is stable.
    const stable = raw.slice(0, tailIndex);
    const transcript = $('transcript');
    if (transcript.childElementCount < stable.filter(item => item.type === 'run:message' || item.type === 'tool:request').length) {
      renderTranscript();
      return;
    }
    if (!node || !node.classList.contains('assistant-turn')) {
      const turn = el('article', 'turn assistant-turn');
      turn.append(el('div', 'turn-body'));
      transcript.append(turn);
      node = turn;
    }
    const body = node.querySelector('.turn-body');
    body.replaceChildren();
    renderBody(body, raw.slice(tailIndex).map(item => item.text || '').join(''));
    body.append(el('span', 'stream-cursor'));
    if (stick) scroll.scrollTop = scroll.scrollHeight;
  }

  // ── tabs / theme / shortcuts ────────────────────────────────────────────────
  function setTab(name) {
    for (const tab of ['changes', 'plan', 'trace']) {
      const active = name === tab;
      $('tab-' + tab).classList.toggle('active', active);
      $('tab-' + tab).setAttribute('aria-selected', String(active));
      $('panel-' + tab).hidden = !active;
    }
  }
  function toggleSidebar() {
    const hidden = document.body.classList.toggle('sidebar-hidden');
    $('expand-sidebar').hidden = !hidden;
    localStorage.setItem('tengyun-sidebar', hidden ? 'off' : 'on');
  }

  function bind() {
    const saved = localStorage.getItem('tengyun-theme') || 'light';
    document.documentElement.dataset.theme = saved;
    if (localStorage.getItem('tengyun-sidebar') === 'off') { document.body.classList.add('sidebar-hidden'); $('expand-sidebar').hidden = false; }
    if (localStorage.getItem('tengyun-review') === 'off') { document.body.classList.add('review-hidden'); $('toggle-inspector').setAttribute('aria-expanded', 'false'); }

    $('task-form').addEventListener('submit', submitTask);
    $('task-input').addEventListener('input', autoGrow);
    $('task-input').addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.isComposing) {
        event.preventDefault();
        submitTask();
      }
    });
    $('new-task').addEventListener('click', newTask);
    $('collapse-sidebar').addEventListener('click', toggleSidebar);
    $('expand-sidebar').addEventListener('click', toggleSidebar);
    $('toggle-inspector').addEventListener('click', () => {
      const hidden = document.body.classList.toggle('review-hidden');
      $('toggle-inspector').setAttribute('aria-expanded', String(!hidden));
      localStorage.setItem('tengyun-review', hidden ? 'off' : 'on');
    });
    $('toggle-theme').addEventListener('click', cycleAppearance);
    for (const button of document.querySelectorAll('.segment')) {
      button.addEventListener('click', () => {
        const mode = button.dataset.appearance;
        if (mode === 'wallpaper' && !state.wallpaper?.url) { openSettings(); toast('先选择一张壁纸图片。'); return; }
        applyAppearance(mode);
        renderAppearanceControls();
        api?.setTheme?.(mode).catch(() => {});
      });
    }
    $('pick-wallpaper').addEventListener('click', pickWallpaper);
    $('remove-wallpaper').addEventListener('click', removeWallpaper);
    $('choose-workspace').addEventListener('click', chooseWorkspace);
    for (const id of ['open-settings', 'composer-settings', 'composer-model-chip']) $(id).addEventListener('click', openSettings);
    $('close-settings').addEventListener('click', () => $('settings-dialog').close());
    $('close-settings-2').addEventListener('click', () => $('settings-dialog').close());
    $('settings-dialog').addEventListener('close', () => { $('setting-api-key').value = ''; });
    $('settings-form').addEventListener('submit', saveSettings);
    $('setting-approval').addEventListener('change', updateApprovalHelp);
    $('allow-approval').addEventListener('click', () => decideApproval(true));
    $('deny-approval').addEventListener('click', () => decideApproval(false));
    $('approval-dialog').addEventListener('cancel', event => { event.preventDefault(); decideApproval(false); });
    $('cancel-run').addEventListener('click', async () => {
      if (!state.active || !api) return;
      $('cancel-run').disabled = true;
      $('run-progress-text').textContent = '正在停止…';
      try { await api.cancel(state.active); } catch (error) { toast('停止失败：' + error.message, true); renderBusy(); }
    });
    for (const button of document.querySelectorAll('.starter')) {
      button.addEventListener('click', () => {
        $('task-input').value = button.dataset.prompt;
        autoGrow();
        $('task-input').focus();
      });
    }
    for (const tab of ['changes', 'plan', 'trace']) $('tab-' + tab).addEventListener('click', () => setTab(tab));
    document.addEventListener('keydown', event => {
      const typing = ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName);
      if (event.key === 'Escape' && state.active) { event.preventDefault(); $('cancel-run').click(); return; }
      if (event.key.toLowerCase() === 'n' && !event.ctrlKey && !event.metaKey && !event.altKey && !typing && !document.querySelector('dialog[open]')) {
        event.preventDefault();
        newTask();
      }
      if (event.key.toLowerCase() === 'b' && !event.ctrlKey && !event.metaKey && !typing && !document.querySelector('dialog[open]')) {
        event.preventDefault();
        toggleSidebar();
      }
    });
  }

  async function init() {
    bind();
    setTab('changes');
    if (!api) {
      $('connection-banner').textContent = '当前是界面预览，请在 Tengyun 桌面应用中打开。';
      $('connection-banner').hidden = false;
      renderAll();
      return;
    }
    api.onEvent(receiveEvent);
    try {
      state.info = await api.info();
      state.workspace = state.info.workspace || '';
      state.wallpaper = state.info.wallpaper || null;
      // The stored appearance wins over whatever the last local session cached.
      applyAppearance(state.info.settings?.appearance || 'light', state.wallpaper);
      renderChrome();
      renderAppearanceControls();
      await refreshRuns();
      renderAll();
    } catch (error) {
      $('connection-banner').textContent = '初始化失败：' + error.message;
      $('connection-banner').hidden = false;
      toast('初始化未完成，请检查应用日志。', true);
    }
  }
  init();
})();
