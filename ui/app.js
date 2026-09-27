'use strict';

/**
 * Tengyun renderer. Codex-style transcript: user turns as quoted blocks, assistant text set flush,
 * tool calls collapsed to one mono line, file changes rendered as real diffs.
 * IPC contract is fixed by preload.cjs; every event type emitted by the kernel is handled here.
 */
(async () => {
  const { summarizeUsage } = await import('../kernel/provider-info.mjs');
  const api = window.tengyun;
  const $ = id => document.getElementById(id);
  const state = {
    info: null, workspace: '', runs: [], events: new Map(), selected: null, active: null, activeRuns: new Set(),
    revertTarget: null,
    submitting: false, approvals: [], toastTimer: null, streaming: new Map(), steps: 0, stepCap: 0, wallpaper: null,
    reasoningByStep: new Map(), projects: [], providers: [], activeProviderId: '', selectedProviderId: null,
    modelFetchCache: new Map(), balanceProvider: null,
    attachments: [], skills: [], currentSkill: null, skillBusy: false,
  };

  function syncActiveState() {
    state.active = (state.selected && state.activeRuns.has(state.selected))
      ? state.selected
      : (state.activeRuns.values().next().value || null);
  }

  const RUN_LABELS = {
    running: '执行中', started: '执行中', completed: '已完成', complete: '已完成',
    incomplete: '有未完成步骤', interrupted: '已中断', failed: '失败', error: '失败',
    cancelled: '已停止', canceled: '已停止', awaiting_approval: '等待确认', waiting_approval: '等待确认',
    pending: '准备中', stopped: '已停止', max_steps: '达到轮数上限',
  };
  const TERMINAL = new Set(['run:complete', 'run:error', 'run:cancelled', 'run:cancel']);
  const TOOL_LABELS = {
    skill_list: '查找技能', skill_read: '读取技能', skill_draft: '保存技能草稿', agent_delegate: '分派子智能体', progress_update: '进度',
    file_read: '读取文件', read_file: '读取文件', file_write: '写入文件', write_file: '写入文件',
    list_files: '浏览目录', list_directory: '浏览目录', search_files: '搜索', run_command: '执行命令',
    command_execute: '执行命令', plan_update: '更新计划', update_plan: '更新计划',
    memory_save: '保存记忆', memory_search: '检索记忆', git_diff: '查看改动', git_commit: '提交改动',
    apply_patch: '应用补丁', read_many: '批量读取', web_fetch: '抓取网页', code_symbols: '检索代码符号',
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

  // ── markdown-lite & GFM tables ───────────────────────────────────────────────
  function splitTableRow(rowStr) {
    let s = String(rowStr || '').trim();
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|')) s = s.slice(0, -1);
    const cells = [];
    let current = '';
    let inCode = false;
    for (let idx = 0; idx < s.length; idx++) {
      const ch = s[idx];
      if (ch === '`') inCode = !inCode;
      if (ch === '|' && !inCode && (idx === 0 || s[idx - 1] !== '\\')) {
        cells.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
    cells.push(current.trim());
    return cells;
  }

  function isTableSeparator(line) {
    if (!line || !line.includes('-')) return false;
    const cells = splitTableRow(line);
    if (!cells.length) return false;
    return cells.every(c => /^:?-{2,}:?$/.test(c));
  }

  function parseAlignments(sepLine) {
    const cells = splitTableRow(sepLine);
    return cells.map(c => {
      const left = c.startsWith(':');
      const right = c.endsWith(':');
      if (left && right) return 'center';
      if (right) return 'right';
      return 'left';
    });
  }

  function renderRichText(parent, text) {
    const lines = String(text).split('\n');
    let list = null;
    const closeList = () => { if (list) { parent.append(list); list = null; } };
    const line_ = (text2) => { const node = el('p'); node.append(inlineText(text2)); return node; };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // GFM Table detection: line has '|' and next line is a separator row
      if (line.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
        closeList();
        const headerCells = splitTableRow(line);
        const aligns = parseAlignments(lines[i + 1]);
        const wrap = el('div', 'table-wrap');
        const table = el('table', 'markdown-table');
        const thead = el('thead');
        const trHead = el('tr');
        for (let c = 0; c < headerCells.length; c++) {
          const th = el('th');
          if (aligns[c]) th.style.textAlign = aligns[c];
          th.append(inlineText(headerCells[c]));
          trHead.append(th);
        }
        thead.append(trHead);
        table.append(thead);

        const tbody = el('tbody');
        i += 2; // skip header row and separator row
        while (i < lines.length) {
          const rowLine = lines[i];
          if (!rowLine.trim() || !rowLine.includes('|')) break;
          if (isTableSeparator(rowLine)) { i++; continue; }
          const cells = splitTableRow(rowLine);
          const tr = el('tr');
          for (let c = 0; c < headerCells.length; c++) {
            const td = el('td');
            if (aligns[c]) td.style.textAlign = aligns[c];
            td.append(inlineText(cells[c] || ''));
            tr.append(td);
          }
          tbody.append(tr);
          i++;
        }
        table.append(tbody);
        wrap.append(table);
        parent.append(wrap);
        i--; // compensate loop increment
        continue;
      }

      const heading = /^(#{1,4})\s+(.*)$/.exec(line);
      const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
      const ordered = /^\s*(\d+)[.)]\s+(.*)$/.exec(line);
      const quote = /^>\s?(.*)$/.exec(line);
      const hr = /^\s*([-*_]){3,}\s*$/.test(line);

      if (heading) {
        closeList();
        const node = el(['h1', 'h2', 'h3', 'h4'][heading[1].length - 1]);
        node.append(inlineText(heading[2]));
        parent.append(node);
      } else if (hr) {
        closeList();
        parent.append(el('hr'));
      } else if (bullet) {
        if (!list || list.tagName !== 'UL') { closeList(); list = el('ul'); }
        const item = el('li');
        const taskMatch = /^\s*\[([ xX])\]\s*(.*)$/.exec(bullet[1]);
        if (taskMatch) {
          item.className = 'task-item';
          const chk = el('input');
          chk.type = 'checkbox';
          chk.disabled = true;
          chk.checked = taskMatch[1].toLowerCase() === 'x';
          item.append(chk, inlineText(taskMatch[2]));
        } else {
          item.append(inlineText(bullet[1]));
        }
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
    const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\n]+\*)|(\[(?:PASS|通过|完成|OK|SUCCESS|已完成)\])|(\[(?:WARN|警告|注意|WARNING)\])|(\[(?:FAIL|失败|错误|ERROR)\])|(\[(?:INFO|提示|信息|NOTE)\])|(\[([^\]]+)\]\(([^)]+)\))/gi;
    let cursor = 0;
    const str = String(raw || '');
    for (const match of str.matchAll(pattern)) {
      if (match.index > cursor) span.append(document.createTextNode(str.slice(cursor, match.index)));
      const token = match[0];
      if (token.startsWith('`')) {
        span.append(el('code', '', token.slice(1, -1)));
      } else if (token.startsWith('**')) {
        span.append(el('strong', '', token.slice(2, -2)));
      } else if (token.startsWith('*') && !token.startsWith('**')) {
        span.append(el('em', '', token.slice(1, -1)));
      } else if (/^\[(?:PASS|通过|完成|OK|SUCCESS|已完成)\]$/i.test(token)) {
        span.append(el('span', 'badge badge-pass', token.slice(1, -1).toUpperCase()));
      } else if (/^\[(?:WARN|警告|注意|WARNING)\]$/i.test(token)) {
        span.append(el('span', 'badge badge-warn', token.slice(1, -1).toUpperCase()));
      } else if (/^\[(?:FAIL|失败|错误|ERROR)\]$/i.test(token)) {
        span.append(el('span', 'badge badge-fail', token.slice(1, -1).toUpperCase()));
      } else if (/^\[(?:INFO|提示|信息|NOTE)\]$/i.test(token)) {
        span.append(el('span', 'badge badge-info', token.slice(1, -1).toUpperCase()));
      } else if (match[9] && match[10]) {
        const a = el('a', 'markdown-link', match[9]);
        a.href = match[10];
        a.target = '_blank';
        a.rel = 'noreferrer noopener';
        span.append(a);
      }
      cursor = match.index + token.length;
    }
    if (cursor < str.length) span.append(document.createTextNode(str.slice(cursor)));
    return span;
  }

  function renderBody(parent, text) {
    let workingText = String(text || '');
    // Parse thinking blocks if present in assistant response (e.g. <think>...</think>)
    const thinkMatch = /<think>([\s\S]*?)(?:<\/think>|$)/i.exec(workingText);
    if (thinkMatch) {
      const thinkingText = thinkMatch[1].trim();
      if (thinkingText) {
        const isSealed = workingText.includes('</think>');
        const details = el('details', 'thinking');
        details.open = !isSealed;
        if (isSealed) details.dataset.sealed = '1';
        else details.dataset.live = '1';
        details.append(
          el('summary', 'thinking-label', isSealed ? `深度思考推演 · ${thinkingText.length} 字（点击展开）` : `深度思考推演 · ${thinkingText.length} 字`),
          el('div', 'thinking-text', thinkingText)
        );
        parent.append(details);
      }
      workingText = workingText.replace(/<think>[\s\S]*?(?:<\/think>|$)/i, '').trim();
    }
    if (!workingText) return;

    const fence = /```([^\n`]*)\n([\s\S]*?)```/g;
    let cursor = 0;
    for (const match of workingText.matchAll(fence)) {
      if (match.index > cursor) renderRichText(parent, workingText.slice(cursor, match.index));
      const preWrap = el('div', 'code-block-wrap');
      const codeHead = el('div', 'code-head');
      const lang = match[1].trim() || 'code';
      codeHead.append(el('span', 'code-lang', lang));
      const copyBtn = el('button', 'copy-btn', '复制');
      copyBtn.type = 'button';
      const codeContent = match[2].replace(/\n$/, '');
      copyBtn.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(codeContent);
          copyBtn.textContent = '已复制!';
          copyBtn.classList.add('copied');
          setTimeout(() => {
            copyBtn.textContent = '复制';
            copyBtn.classList.remove('copied');
          }, 1800);
        } catch (err) {
          toast('复制失败：' + err.message, true);
        }
      });
      codeHead.append(copyBtn);
      const pre = el('pre');
      pre.append(el('code', '', codeContent));
      preWrap.append(codeHead, pre);
      parent.append(preWrap);
      cursor = match.index + match[0].length;
    }
    if (cursor < workingText.length) renderRichText(parent, workingText.slice(cursor));
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
  /**
   * Unified diff in the shape the harness uses: old number, new number, sign column, text —
   * a 4-column grid at a fixed 22px line so added and removed lines stay aligned with context.
   */
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
      if (kind === 'add') newLine += 1;
      else if (kind === 'del') oldLine += 1;
      else { oldLine += 1; newLine += 1; }
      const row = el('div', 'diff-line' + (kind === ' ' ? '' : ' ' + kind));
      row.append(el('span', 'ln', kind === 'add' ? '' : String(oldLine)));
      row.append(el('span', 'ln', kind === 'del' ? '' : String(newLine)));
      row.append(el('span', 'sign', kind === ' ' ? '' : kind === 'add' ? '+' : '-'));
      row.append(el('span', 'code', line.slice(1) || ''));
      box.append(row);
    }
    return box;
  }

  // ── thread rendering ─────────────────────────────────────────────────────────
  function toolArgument(event) {
    const args = event.args || {};
    if (typeof args === 'string') return brief(args, 90);
    if (args.id) return args.id + (args.path ? ' / ' + args.path : '');
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
    const attachments = event.attachments || event.message?.attachments || [];
    if (!text && !attachments.length) return;
    const turn = el('article', 'turn ' + (role === 'user' ? 'user-turn' : 'assistant-turn'));
    if (role === 'user') {
      const header = el('div', 'turn-header');
      const badge = el('span', 'user-badge');
      badge.append(svgIcon('terminal', 'turn-icon'), document.createTextNode('指令'));
      const timeStr = clock(event.time || event.createdAt || Date.now());
      header.append(badge, el('span', 'turn-time', timeStr));
      turn.append(header);

      if (attachments.length > 0) {
        const attachWrap = el('div', 'turn-attachments');
        for (const item of attachments) {
          if (item.isImage && item.dataUrl) {
            const card = el('div', 'attachment-image-card');
            const img = document.createElement('img');
            img.src = item.dataUrl;
            img.alt = item.name || '图片';
            img.className = 'attachment-thumb';
            img.title = '点击查看大图';
            img.addEventListener('click', () => { window.open(item.dataUrl); });
            const caption = el('span', 'attachment-caption', item.name || '图片');
            card.append(img, caption);
            attachWrap.append(card);
          } else {
            const card = el('div', 'attachment-file-card');
            card.append(svgIcon('file', 'attachment-file-icon'));
            const info = el('span', 'attachment-file-info');
            info.append(
              el('span', 'attachment-file-name', item.name || '文件'),
              el('span', 'attachment-file-size', `${Math.round((item.size || 0) / 1024)} KB`)
            );
            card.append(info);
            attachWrap.append(card);
          }
        }
        turn.append(attachWrap);
      }
    }
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
    if (run?.input && !hasUser) appendMessage(transcript, { role: 'user', content: run.input, time: run.createdAt, attachments: run.attachments });

    // Reasoning traces are kept per step so they survive a re-render and stay reviewable.
    const placed = new Set();

    for (const event of raw) {
      if (event.type === 'run:message' || event.type === 'message') {
        const key = `${state.selected}:${event.step}`;
        if (event.role === 'assistant' && state.reasoningByStep.has(key) && !placed.has(event.step)) { transcript.append(thinkingBlock(state.reasoningByStep.get(key), true)); placed.add(event.step); }
        appendMessage(transcript, event);
      }
      if (event.type === 'run:skill-loaded') transcript.append(el('p', 'progress-note', '已载入技能：' + event.skillId));
      if (event.type === 'run:progress') transcript.append(el('p', 'progress-note', event.text));
      if (event.type === 'agent:start') appendAgentCard(transcript, event, raw);
      if (event.type === 'tool:request' && event.name !== 'progress_update') {
        const step = typeof event.steps === 'number' ? event.steps : null;
        if (step !== null && state.reasoningByStep.has(`${state.selected}:${step}`) && !placed.has(step)) {
          transcript.append(thinkingBlock(state.reasoningByStep.get(`${state.selected}:${step}`), true));
          placed.add(step);
        }
        const result = results.find(item => event.toolCallId
          ? item.toolCallId === event.toolCallId
          : item.name === event.name && raw.indexOf(item) > raw.indexOf(event));
        appendToolRow(transcript, event, result);
      }
      if (event.type === 'run:complete') {
        if (event.status === 'cancelled') transcript.append(systemNote('', '执行已停止，已完成的操作保留在记录中。'));
        else if (event.status === 'max_steps') transcript.append(systemNote('warn', '已达到本次任务的轮数上限。可在设置里提高上限，或缩小任务范围。'));
        else if (event.status === 'incomplete') transcript.append(systemNote('warn', '本次执行结束，但计划中仍有未完成步骤——展开工具输出核对实际结果。'));
        // Successful completion is represented by the final answer itself.
      }
      if (event.type === 'run:error') {
        const message = plainText(event.error?.message || event.error || event.message || '未知错误');
        transcript.append(systemNote(event.status === 'cancelled' ? '' : 'error', event.status === 'cancelled' ? '执行已停止。' : '执行中断：' + message));
      }
    }
    const tail = $('task-title');
    tail.textContent = run ? brief(titleFor(run), 52) : '新建任务';
    $('delete-current-task').hidden = !state.selected;
    // The step in progress has no tool row yet, so its trace goes at the tail and stays open.
    const current = raw.filter(e => e.type === 'run:step').at(-1)?.steps;
    if (current && state.reasoningByStep.has(`${state.selected}:${current}`) && !placed.has(current) && state.activeRuns.has(run?.id)) {
      transcript.append(thinkingBlock(state.reasoningByStep.get(`${state.selected}:${current}`), false));
    }
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
    $('changes-card').hidden = results.length === 0;

    // Undo is offered only for a finished run that actually changed something on disk.
    const selected = runById();
    const revertable = results.filter(item => resultOf(item).path && (resultOf(item).replaced === false || resultOf(item).backupPath));
    const canRevert = Boolean(selected) && revertable.length > 0 && !state.activeRuns?.has(selected.id);
    $('change-actions').hidden = !canRevert;
    if (canRevert) {
      state.revertTarget = { runId: selected.id, files: [...new Set(revertable.map(item => resultOf(item).path))] };
      $('revert-note').textContent = `${state.revertTarget.files.length} 个文件留有备份`;
    } else {
      state.revertTarget = null;
    }

    // Summary card: one filled header with aggregate counts, then code-font rows (DSH shape).
    let added = 0, deleted = 0;
    const list = $('change-list');
    list.replaceChildren();
    const diffs = $('change-diffs');
    diffs.replaceChildren();

    for (const [index, item] of results.entries()) {
      const result = resultOf(item);
      const path = result.path || basename(item.args?.path) || 'file';
      const stats = diffStats(result.diff);
      added += stats.add; deleted += stats.del;

      const row = el('li');
      const button = el('button', 'changes-row');
      button.type = 'button';
      button.append(el('span', 'path', path));
      const counts = el('span', 'counts');
      counts.append(el('span', 'added', '+' + stats.add), el('span', 'deleted', '−' + stats.del));
      button.append(counts);

      // Each file's diff sits below the card; clicking its row toggles it, the first one opens.
      const block = el('div', 'change-diff');
      block.append(el('div', 'change-diff-path', path), renderDiff(result.diff));
      block.hidden = index !== 0;
      button.addEventListener('click', () => { block.hidden = !block.hidden; });
      row.append(button);
      list.append(row);
      diffs.append(block);
    }
    $('changes-added').textContent = '+' + added;
    $('changes-deleted').textContent = '−' + deleted;
    $('changes-title').textContent = results.length === 1 ? '1 个文件改动' : `${results.length} 个文件改动`;
  }

  /**
   * Undo every file change a run made. Uses the earliest backup per file, so repeated edits to the
   * same file unwind to the state before the run touched it.
   */
  async function revertRunChanges() {
    const target = state.revertTarget;
    if (!target || !api?.revertRun) return;
    const confirmed = window.confirm(
      `回滚这个任务的 ${target.files.length} 个文件改动？\n\n· 被本次任务修改的文件恢复到改动前的备份\n· 本次任务新建的文件会被删除\n· 任务记录保留，只有磁盘上的文件被还原`,
    );
    if (!confirmed) return;
    const button = $('revert-run');
    button.disabled = true;
    button.textContent = '正在回滚…';
    try {
      const result = await api.revertRun({ id: target.runId });
      const failed = result.files.filter(item => !item.ok);
      toast(failed.length
        ? `已回滚 ${result.reverted} 个文件，${failed.length} 个失败：${failed[0].error}`
        : `已回滚 ${result.reverted} 个文件改动。`,
      failed.length > 0);
      if (state.selected) await selectRun(state.selected);
    } catch (error) {
      toast('回滚失败：' + error.message, true);
    } finally {
      button.disabled = false;
      button.textContent = '回滚本次全部改动';
    }
  }
  const TRACE_LABELS = {
    'run:start': '任务开始', 'run:model': '请求模型', 'run:usage': '用量', 'run:retry': '重试',
    'run:settled': '已释放', 'run:context': '载入历史上下文', 'plan:update': '计划更新',
    'run:plan': '计划更新', 'tool:request': '请求工具', 'tool:result': '工具返回',
    'tool:output': '输出', 'tool:approval': '操作确认', 'approval:request': '等待确认',
    'approval:response': '已确认', 'run:complete': '执行结束', 'run:error': '执行出错',
    'run:skill-loaded': '加载技能', 'run:skills': '技能版本', 'run:progress': '进度', 'agent:start': '子智能体启动', 'agent:complete': '子智能体结束', 'agent:activity': '子智能体活动',
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
      const detail = event.type === 'tool:result' ? brief(resultOf(event), 120) : (event.args ? brief(event.args, 120) : event.text || (event.type === 'run:skills' ? (event.skills || []).map(s => s.id + '@' + s.revision.slice(0, 8)).join(', ') : event.role || event.message || ''));
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
    pill.classList.toggle('running', state.activeRuns.has(run?.id));
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
      const active = state.activeRuns.has(run.id);
      const item = el('div', 'history-item' + (run.id === state.selected ? ' active' : '') + (active ? ' running' : ''));
      item.setAttribute('role', 'button');
      item.setAttribute('tabindex', '0');
      item.title = titleFor(run);
      // Harness session row: a 16px status slot, then the title, then the time.
      const slot = el('span', 'history-slot');
      slot.append(svgIcon(active ? 'spark' : 'terminal'));
      item.append(slot);
      item.append(el('span', 'history-item-title', titleFor(run)));
      item.append(el('span', 'history-item-meta', [dayLabel(run.createdAt), RUN_LABELS[run.status] || run.status].filter(Boolean).join(' · ')));

      const delBtn = el('button', 'history-item-del');
      delBtn.type = 'button';
      delBtn.title = '删除此任务';
      delBtn.append(svgIcon('trash'));
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteTask(run.id);
      });
      item.append(delBtn);

      item.addEventListener('click', (e) => {
        if (!e.target.closest('.history-item-del')) {
          selectRun(run.id);
        }
      });
      item.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          selectRun(run.id);
        }
      });
      box.append(item);
    }
  }
  function renderChrome() {
    const settings = state.info?.settings || {};
    const model = settings.model || '选择模型';
    $('sidebar-model').textContent = state.info?.localAccount || '本机账户';
    $('local-account-name').textContent = state.info?.localAccount || '本机用户';
    $('composer-model').textContent = model;
    $('composer-model-chip-text').textContent = model;
    $('version').textContent = '本机账户 · 设置';
    $('perm-label').textContent = APPROVAL_MODES[settings.approval] || APPROVAL_MODES.always;
    const ready = configured();
    document.querySelector('.pill-dot').classList.toggle('off', !ready);
    $('composer-model-chip').querySelector('.chip-dot').classList.toggle('off', !ready);
    const ws = state.workspace;
    const activeProjectName = basename(ws) || ws || '项目管理';
    $('workspace-label').textContent = activeProjectName;
    const projs = state.info?.settings?.projects || state.projects || [];
    const count = projs.length || (ws ? 1 : 0);
    if ($('workspace-sub')) $('workspace-sub').textContent = `${count} 个项目 · 点击管理`;
    $('topbar-workspace').textContent = ws ? (basename(ws) || ws) : '—';
    $('footer-workspace').textContent = ws || '未选择工作目录';
    const balanceKey = settings.activeProviderId + '|' + settings.baseUrl + '|' + settings.hasApiKey;
    if (state.balanceProvider !== balanceKey) { state.balanceProvider = balanceKey; void refreshBalance(); }
  }
  function renderUsage() {
    const usage = summarizeUsage(eventsFor());
    const text = usage.reports ? `本对话 Token ${usage.total.toLocaleString()}${usage.partial ? '（部分）' : ''} · 输入 ${usage.input.toLocaleString()} / 输出 ${usage.output.toLocaleString()}` : 'Token · 暂无用量数据';
    $('footer-usage').textContent = text;
    $('token-summary').textContent = text;
    $('token-summary').title = '当前对话累计，包含已返回的子智能体用量；仅统计提供商报告的数据';
  }

  function renderBusy() {
    const isCurrentActive = Boolean(state.selected && state.activeRuns.has(state.selected));
    const totalActive = state.activeRuns.size;
    const busy = Boolean(isCurrentActive || state.submitting);
    // Codex-style composer: no floating status bar. The send button becomes a stop button while
    // work is running, and progress goes to the status line at the bottom of the window.
    $('send-task').hidden = busy;
    $('send-task').disabled = busy || !api;
    $('cancel-run').hidden = !busy;
    $('cancel-run').disabled = totalActive === 0 && !state.submitting;
    $('choose-workspace').disabled = totalActive > 0 || !api;
    const stepNote = isCurrentActive && state.steps
      ? (state.stepCap ? `第 ${state.steps} / ${state.stepCap} 轮` : `第 ${state.steps} 轮`)
      : (totalActive > 0 && !isCurrentActive ? `并行 ${totalActive} 个任务` : '');
    $('footer-status').textContent = state.approvals.length ? '等待确认'
      : state.submitting ? '正在启动'
      : isCurrentActive ? (stepNote ? `执行中 · ${stepNote}` : '执行中')
      : (totalActive > 0 ? `后台执行 · ${totalActive} 个任务` : '就绪');
    document.querySelector('.status-dot').classList.toggle('live', totalActive > 0 || state.submitting);
    $('composer-hint').textContent = isCurrentActive
      ? 'Esc 停止当前任务 · Shift+Enter 换行'
      : (totalActive > 0 ? 'Esc 停止后台 · Enter 发送继续 · Shift+Enter 换行' : 'Enter 发送 · Shift+Enter 换行');
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
    for (const r of state.runs) {
      if (['running', 'started', 'pending'].includes(r.status)) {
        state.activeRuns.add(r.id);
      }
    }
    syncActiveState();
    renderHistory();
  }
  async function selectRun(id) {
    state.selected = id;
    state.steps = eventsFor(id).filter(e => e.type === 'run:step').at(-1)?.steps || 0;
    syncActiveState();
    renderAll();
    if (!api || state.activeRuns.has(id)) return;
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
  async function deleteTask(id) {
    if (!id || !api?.deleteRun) return;
    const run = state.runs.find(r => r.id === id);
    const title = run ? titleFor(run) : id;
    const isRunning = state.activeRuns.has(id);
    if (isRunning) {
      const confirmKill = confirm(`任务 "${title}" 正在运行中，确定要终止并删除该任务吗？`);
      if (!confirmKill) return;
    }
    try {
      await api.deleteRun(id);
      state.runs = state.runs.filter(r => r.id !== id);
      state.activeRuns.delete(id);
      state.events.delete(id);
      if (state.selected === id) {
        state.selected = state.runs[0]?.id || null;
        if (state.selected) {
          await selectRun(state.selected);
        } else {
          newTask();
        }
      } else {
        renderAll();
      }
      toast('任务已删除');
    } catch (err) {
      toast('删除任务失败：' + (err.message || err), true);
    }
  }

  function formatSize(bytes) {
    if (!bytes || bytes <= 0) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function renderAttachments() {
    const box = $('composer-attachments');
    if (!box) return;
    if (!state.attachments || !state.attachments.length) {
      box.hidden = true;
      box.replaceChildren();
      return;
    }
    box.hidden = false;
    box.replaceChildren();
    state.attachments.forEach((att, idx) => {
      const chip = el('div', 'attachment-chip');
      if (att.isImage) {
        if (att.dataUrl) {
          const img = el('img', 'attachment-chip-thumb');
          img.src = att.dataUrl;
          chip.append(img);
        } else {
          chip.append(svgIcon('image', 'attachment-chip-icon'));
        }
      } else {
        chip.append(svgIcon('paperclip', 'attachment-chip-icon'));
      }
      chip.append(el('span', 'attachment-chip-name', att.name || '附件'));
      if (att.size) {
        chip.append(el('span', 'attachment-chip-size', formatSize(att.size)));
      }
      const removeBtn = el('button', 'attachment-chip-remove');
      removeBtn.type = 'button';
      removeBtn.title = '移除';
      removeBtn.textContent = '×';
      removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        state.attachments.splice(idx, 1);
        renderAttachments();
      });
      chip.append(removeBtn);
      box.append(chip);
    });
  }

  async function handleDomFiles(fileList) {
    if (!fileList || !fileList.length) return;
    for (const file of fileList) {
      const isImage = file.type ? file.type.startsWith('image/') : /\.(png|jpe?g|webp|gif|svg)$/i.test(file.name);
      const name = file.name || (isImage ? `screenshot-${Date.now()}.png` : 'file.txt');
      const ext = name.split('.').pop().toLowerCase();
      const item = {
        name,
        size: file.size,
        type: file.type || (isImage ? 'image/png' : 'text/plain'),
        ext,
        isImage,
        path: file.path || '',
      };
      if (isImage) {
        try {
          const dataUrl = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(file);
          });
          item.dataUrl = dataUrl;
        } catch (e) {
          console.error('Failed reading image file as dataUrl:', e);
        }
      } else if (file.size < 2 * 1024 * 1024) {
        try {
          const text = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsText(file);
          });
          item.textContent = text;
          item.text = text;
        } catch (e) {
          console.error('Failed reading text file:', e);
        }
      }
      state.attachments.push(item);
    }
    renderAttachments();
  }

  async function triggerAttachFiles() {
    if (api?.chooseFiles) {
      try {
        const files = await api.chooseFiles();
        if (Array.isArray(files) && files.length) {
          state.attachments.push(...files);
          renderAttachments();
          return;
        }
      } catch (err) {
        console.warn('Native chooseFiles failed, falling back to input', err);
      }
    }
    $('file-picker-input')?.click();
  }

  function newTask() {
    state.selected = null;
    state.steps = 0;
    state.attachments = [];
    renderAttachments();
    syncActiveState();
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
    const attachments = [...state.attachments];
    if ((!input && !attachments.length) || state.submitting) return;
    if (state.selected && state.activeRuns.has(state.selected)) {
      toast('当前对话正在执行中，请等待完成或点击停止。');
      return;
    }
    if (!api) { toast('请通过 Tengyun 桌面应用打开此界面。', true); return; }
    if (!configured()) { openSettings(); toast('先连接一个模型。'); return; }
    if (!state.workspace) { await chooseWorkspace(); if (!state.workspace) return; }
    state.submitting = true;
    state.steps = 0;
    renderBusy();
    try {
      const isContinuation = Boolean(state.selected);
      const conversationId = state.selected || undefined;
      const effectiveInput = input || (attachments.length ? '请分析上传的附件并给出处理意见。' : '');
      const result = await api.run({ input: effectiveInput, conversationId, parentId: conversationId, attachments });
      const id = typeof result === 'string' ? result : result?.id || result?.runId;
      if (!id) throw new Error('应用未返回任务编号');
      state.selected = id;
      state.activeRuns.add(id);
      syncActiveState();

      const userEvent = {
        type: 'run:message',
        role: 'user',
        optimistic: true,
        content: effectiveInput,
        attachments: attachments.length ? attachments : undefined,
        runId: id,
        time: new Date().toISOString(),
      };

      if (isContinuation) {
        const existingRun = state.runs.find(run => run.id === id);
        if (existingRun) {
          existingRun.status = 'running';
          existingRun.updatedAt = new Date().toISOString();
        }
        const list = state.events.get(id) || [];
        list.push(userEvent);
        state.events.set(id, list);
      } else {
        state.runs.unshift({
          id,
          input: effectiveInput,
          title: effectiveInput,
          attachments,
          status: 'running',
          createdAt: new Date().toISOString(),
        });
        state.events.set(id, [userEvent]);
      }
      $('task-input').value = '';
      state.attachments = [];
      renderAttachments();
      autoGrow();
      renderAll();
      $('conversation-scroll').scrollTop = $('conversation-scroll').scrollHeight;
    } catch (error) { toast('无法开始任务：' + error.message, true); }
    finally { state.submitting = false; syncActiveState(); renderBusy(); }
  }
  async function chooseWorkspace() {
    await openProjectDialog();
  }

  async function openProjectDialog() {
    if (!api) return;
    try {
      const res = await api.listProjects();
      const projects = res.projects || [];
      state.projects = projects;
      const activeWorkspace = res.activeWorkspace || state.workspace;

      const currentProj = projects.find(p => p.path === activeWorkspace || p.active) || {
        name: basename(activeWorkspace) || '默认工作区',
        path: activeWorkspace,
        branch: 'main',
      };

      $('current-project-name').textContent = currentProj.name || basename(currentProj.path);
      $('current-project-path').textContent = currentProj.path;
      $('current-project-branch').textContent = currentProj.branch || 'main';
      $('project-count').textContent = String(projects.length);

      const listNode = $('project-list');
      listNode.replaceChildren();

      if (!projects.length) {
        listNode.append(el('div', 'empty-note', '尚未挂载其他项目，点击下方添加。'));
      } else {
        for (const proj of projects) {
          const isCurrent = proj.path === activeWorkspace || proj.active;
          const card = el('div', 'project-item' + (isCurrent ? ' active' : ''));
          const info = el('div', 'project-item-info');
          const titleRow = el('div', 'project-item-title');
          titleRow.append(el('span', 'project-name', proj.name || basename(proj.path)));
          if (isCurrent) titleRow.append(el('span', 'badge badge-pass', '主工作区'));
          if (proj.branch) titleRow.append(el('span', 'project-branch-tag', proj.branch));
          const pathText = el('p', 'crumb-path', proj.path);
          info.append(titleRow, pathText);
          card.append(info);

          const actions = el('div', 'project-actions');
          if (!isCurrent) {
            const switchBtn = el('button', 'button subtle', '切换');
            switchBtn.type = 'button';
            switchBtn.addEventListener('click', async () => {
              try {
                await api.switchProject(proj.id || proj.path);
                state.workspace = proj.path;
                state.info = await api.info();
                renderChrome();
                await refreshRuns();
                renderAll();
                await openProjectDialog();
                toast(`已切换至项目：${proj.name || basename(proj.path)}`);
              } catch (err) {
                toast('切换失败：' + err.message, true);
              }
            });
            actions.append(switchBtn);

            const removeBtn = el('button', 'icon-button subtle', '');
            removeBtn.title = '从列表中移除';
            removeBtn.append(svgIcon('trash'));
            removeBtn.addEventListener('click', async () => {
              try {
                await api.removeProject(proj.id);
                state.info = await api.info();
                await openProjectDialog();
                renderChrome();
                toast('已从列表中移除');
              } catch (err) {
                toast('移除失败：' + err.message, true);
              }
            });
            actions.append(removeBtn);
          }
          card.append(actions);
          listNode.append(card);
        }
      }

      if (!$('project-dialog').open) $('project-dialog').showModal();
    } catch (err) {
      toast('读取项目列表失败：' + err.message, true);
    }
  }

  async function addNewProject() {
    if (!api || state.activeRuns.size > 0) return;
    try {
      const res = await api.addProject();
      if (res && res.workspace) {
        state.workspace = res.workspace;
        state.info = await api.info();
        renderChrome();
        await refreshRuns();
        renderAll();
        await openProjectDialog();
        toast('新项目已挂载并就绪！');
      }
    } catch (err) {
      toast('添加项目失败：' + err.message, true);
    }
  }

  async function skillAction(action) {
    if (state.skillBusy) return;
    state.skillBusy = true;
    fieldError('skill-error', '');
    try { await action(); } catch (error) { fieldError('skill-error', error.message); }
    finally { state.skillBusy = false; }
  }
  async function refreshSkills() {
    try {
      const result = await api.listSkills();
      state.skills = result.skills;
      const list = $('skill-list'); list.replaceChildren();
      if (!state.skills.length) list.append(el('p', 'field-help', '还没有技能。导入现有技能，或新建一个。'));
      for (const skill of state.skills) {
        const button = el('button', 'skill-list-item'); button.type = 'button';
        button.append(el('strong', '', skill.name), el('span', 'field-hint', skill.enabled ? '已启用' : '草稿 / 停用'), el('p', '', skill.description));
        button.addEventListener('click', () => skillAction(() => loadSkill(skill.id)));
        list.append(button);
      }
      if (result.errors.length) fieldError('skill-error', result.errors.map(e => e.file + ': ' + e.error).join('；'));
    } catch (error) { fieldError('skill-error', error.message); }
  }
  async function loadSkill(id) {
    const skill = await api.getSkill(id);
    state.currentSkill = skill;
    $('skill-editor-panel').hidden = false;
    $('skill-editor-title').textContent = skill.name;
    $('skill-status').textContent = (skill.enabled ? '已启用 · ' : '停用 · ') + skill.revision.slice(0, 8);
    $('skill-content').value = skill.content;
    $('skill-toggle').hidden = false;
    $('skill-toggle').textContent = skill.enabled ? '停用' : '启用';
    $('skill-use').hidden = !skill.enabled;
    $('skill-remove').hidden = false;
    const select = $('skill-resource-select'); select.replaceChildren();
    for (const resource of skill.resources) { const option = el('option', '', resource); option.value = resource; select.append(option); }
    $('skill-resources-panel').hidden = false;
    $('skill-resource-preview').textContent = skill.content;
  }
  function newSkill() {
    state.currentSkill = null;
    $('skill-editor-panel').hidden = false;
    $('skill-editor-title').textContent = '新建技能';
    $('skill-status').textContent = '尚未保存';
    $('skill-content').value = '---\nname: my-skill\ndescription: 描述什么任务需要使用这个技能\n---\n\n# 操作步骤\n1. 先确认输入和相关文件。\n2. 按具体步骤完成任务。\n3. 检查结果，报告实际完成的内容与限制。\n\n# 验证方式\n填写可重复执行的检查，以及通过标准。\n';
    for (const id of ['skill-toggle', 'skill-use', 'skill-remove', 'skill-resources-panel']) $(id).hidden = true;
  }
  function bindSkillControls() {
    $('skill-refresh').addEventListener('click', () => skillAction(refreshSkills));
    $('skill-new').addEventListener('click', newSkill);
    $('skill-import').addEventListener('click', () => skillAction(async () => {
      const imported = await api.importSkill(); if (!imported) return;
      await refreshSkills(); await loadSkill(imported.id); toast('已导入为停用草稿');
    }));
    $('skill-save').addEventListener('click', () => skillAction(async () => {
      const saved = await api.saveSkill({ id: state.currentSkill?.id, expectedRevision: state.currentSkill?.revision, content: $('skill-content').value });
      await refreshSkills(); await loadSkill(saved.id); toast('草稿已保存，检查后可启用');
    }));
    $('skill-toggle').addEventListener('click', () => skillAction(async () => {
      const skill = state.currentSkill; if (!skill) return;
      if ($('skill-content').value !== skill.content) throw new Error('请先保存编辑内容，再启用技能');
      await api.enableSkill({ id: skill.id, expectedRevision: skill.revision, enabled: !skill.enabled });
      await refreshSkills(); await loadSkill(skill.id);
    }));
    $('skill-use').addEventListener('click', () => {
      if (!state.currentSkill?.enabled) return;
      $('task-input').value = '/' + state.currentSkill.id + ' ' + $('task-input').value;
      $('settings-dialog').close(); $('task-input').focus(); autoGrow();
    });
    $('skill-remove').addEventListener('click', () => skillAction(async () => {
      const skill = state.currentSkill; if (!skill || !confirm('移除技能 ' + skill.name + '？本地保留备份。')) return;
      await api.removeSkill({ id: skill.id, expectedRevision: skill.revision });
      state.currentSkill = null; $('skill-editor-panel').hidden = true; await refreshSkills();
    }));
    $('skill-resource-select').addEventListener('change', () => skillAction(async () => {
      $('skill-resource-preview').textContent = await api.readSkillResource({ id: state.currentSkill.id, path: $('skill-resource-select').value });
    }));
  }
  function appendAgentCard(container, start, events) {
    const finish = events.find(e => e.type === 'agent:complete' && e.agentId === start.agentId);
    const activities = events.filter(e => e.type === 'agent:activity' && e.agentId === start.agentId);
    const card = el('details', 'agent-card');
    const roles = { explore: '探查', plan: '规划', review: '审查' };
    card.append(el('summary', '', (roles[start.role] || start.role) + ' · ' + (finish ? (RUN_LABELS[finish.status] || finish.status) : '运行中')));
    card.append(el('p', 'field-help', start.task));
    for (const activity of activities.slice(-8)) card.append(el('p', 'agent-activity', activity.text || ((TOOL_LABELS[activity.tool] || activity.tool || '') + (activity.activity === 'tool:result' ? (activity.ok ? ' · 完成' : ' · 失败') : ''))));
    if (finish) { const body = el('div', 'turn-body'); renderBody(body, finish.output || String(finish.error || '未返回结论')); card.append(body); }
    container.append(card);
  }
  function sealThinking(id) {
    if (id !== state.selected) return;
    const node = $('transcript').querySelector('.thinking[data-live]');
    if (node) { delete node.dataset.live; node.dataset.sealed = '1'; node.open = false; }
  }

  function setSettingsTab(targetTabId) {
    $('close-settings-2').textContent = targetTabId === 'tab-skills' ? '完成' : '取消';
    for (const btn of document.querySelectorAll('.settings-tab')) {
      btn.classList.toggle('active', btn.dataset.tab === targetTabId);
    }
    for (const panel of document.querySelectorAll('.settings-tab-content')) {
      const active = panel.id === targetTabId;
      panel.hidden = !active;
      panel.classList.toggle('active', active);
    }
  }

  async function openSettings(initialTab = 'tab-general') {
    setSettingsTab(initialTab);
    void refreshSkills();
    const settings = state.info?.settings || {};
    $('setting-reasoning-effort').value = settings.reasoningEffort || 'default';
    $('setting-agents-enabled').checked = settings.agentsEnabled === true;
    $('setting-show-reasoning').checked = settings.showReasoning !== false;

    // Load runtime & policy
    $('setting-max-steps').value = settings.maxSteps ?? 0;
    $('setting-approval').value = settings.approval || 'always';
    if ($('setting-streaming')) $('setting-streaming').checked = settings.streaming !== false;
    updateApprovalHelp();

    // Load providers from API
    try {
      const providers = await api.listProviders();
      state.providers = providers;
      state.activeProviderId = settings.activeProviderId || providers.find(p => p.active)?.id || providers[0]?.id;
      if (!state.selectedProviderId) state.selectedProviderId = state.activeProviderId;
      renderProviderList();
      populateCognitiveSelects();
    } catch {
      $('setting-base-url').value = settings.baseUrl || '';
      $('setting-model').value = settings.model || '';
    }

    renderAppearanceControls();
    fieldError('settings-error', '');
    $('test-result-pill').hidden = true;
    if (!$('settings-dialog').open) $('settings-dialog').showModal();
  }

  const PRESET_PROVIDER_IDS = ['deepseek-official', 'siliconflow', 'openai', 'gemini', 'ollama', 'custom']

  async function refreshProviders() {
    if (api?.listProviders) state.providers = await api.listProviders()
  }

  function renderProviderList() {
    const grid = $('provider-selector-grid');
    grid.replaceChildren();
    for (const prov of state.providers) {
      const isSelected = prov.id === state.selectedProviderId;
      const isActive = prov.id === state.activeProviderId;
      const card = el('div', 'provider-card' + (isSelected ? ' selected' : '') + (isActive ? ' active-provider' : ''));
      const header = el('div', 'provider-card-header');
      header.append(el('strong', 'provider-name', prov.name));
      if (isActive) header.append(el('span', 'badge badge-pass', '使用中'));
      card.append(header);

      const meta = el('div', 'provider-card-meta');
      meta.append(el('span', 'mono', prov.model || '未设模型'));
      meta.append(el('span', 'provider-url-hint', prov.baseUrl));
      card.append(meta);

      card.addEventListener('click', () => {
        state.selectedProviderId = prov.id;
        renderProviderList();
        loadSelectedProviderIntoForm();
      });
      grid.append(card);
    }
    loadSelectedProviderIntoForm();
  }

  function loadSelectedProviderIntoForm() {
    const prov = state.providers.find(p => p.id === state.selectedProviderId) || state.providers[0];
    if (!prov) return;
    $('setting-provider-name').value = prov.name || '';
    $('setting-base-url').value = prov.baseUrl || '';
    $('setting-model').value = prov.model || '';
    $('setting-api-key').value = '';
    const deleteBtn = $('delete-provider-btn');
    const isPreset = PRESET_PROVIDER_IDS.includes(prov.id);
    if (deleteBtn) {
      deleteBtn.disabled = isPreset;
      deleteBtn.title = isPreset ? '预设服务商不可删除' : '删除当前服务商';
    }
    $('setting-api-key').placeholder = prov.hasApiKey ? '已安全加密保存，留空保持不变' : '输入 API Key（本地模型可留空）';
    $('key-hint').textContent = prov.hasApiKey ? '已加密保存' : 'Windows DPAPI 加密存储';

    $('models-fetch-status').textContent = '';
    $('fetch-models').disabled = false;
    if (prov.hasApiKey || /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(?=[:/])/.test(prov.baseUrl)) void discoverModels(false);
    // Model presets dropdown
    const select = $('setting-model-presets');
    select.replaceChildren();
    select.append(el('option', '', '选择常用模型预设…'));
    const models = Array.isArray(prov.models) && prov.models.length ? prov.models : [prov.model].filter(Boolean);
    for (const m of models) {
      const opt = el('option', '', m);
      opt.value = m;
      select.append(opt);
    }
    select.onchange = () => {
      if (select.value && select.value !== '选择常用模型预设…') {
        $('setting-model').value = select.value;
      }
    };
  }

  async function discoverModels(force = true) {
    const id = state.selectedProviderId;
    const baseUrl = $('setting-base-url').value.trim();
    const apiKey = $('setting-api-key').value.trim();
    const cacheKey = id + '|' + baseUrl;
    const cached = state.modelFetchCache.get(cacheKey);

    $('fetch-models').disabled = true;
    $('models-fetch-status').textContent = '正在获取模型列表…';
    try {
      const result = !force && cached && Date.now() - cached.time < 300000 ? cached.result : await api.fetchModels({ id, baseUrl, ...(apiKey ? { apiKey } : {}) });
      state.modelFetchCache.set(cacheKey, { time: Date.now(), result });
      if (id !== state.selectedProviderId || baseUrl !== $('setting-base-url').value.trim() || apiKey !== $('setting-api-key').value.trim()) return;
      const provider = state.providers.find(p => p.id === id);
      if (provider) provider.models = result.models;
      const select = $('setting-model-presets'); select.replaceChildren();
      const empty = el('option', '', '选择模型…'); empty.value = ''; select.append(empty);
      for (const model of result.models) { const opt = el('option', '', model); opt.value = model; select.append(opt); }
      $('models-fetch-status').textContent = `已获取 ${result.models.length} 个模型，可选择或手动输入`;
    } catch (error) {
      if (id === state.selectedProviderId && baseUrl === $('setting-base-url').value.trim()) $('models-fetch-status').textContent = '获取失败：' + error.message + '。仍可手动填写。';
    } finally { if (id === state.selectedProviderId) $('fetch-models').disabled = false; }
  }
  async function refreshBalance(force = false) {
    const settings = state.info?.settings;
    if (!settings?.activeProviderId) return;
    const identity = state.balanceProvider;
    const button = $('balance-summary');
    button.textContent = '余额 · 查询中…';
    try {
      const value = await api.providerBalance({ id: settings.activeProviderId, force });
      if (identity !== state.balanceProvider) return;
      const labels = { unsupported: '暂不支持', unauthorized: '无查询权限', 'rate-limited': '请求受限', unavailable: '查询失败', 'not-configured': '未配置密钥' };
      button.textContent = value.status === 'ok' ? (value.kind === 'quota' ? '额度 · ' : '余额 · ') + (value.unlimited ? '不限额' : `${value.amount.toLocaleString(undefined, { maximumFractionDigits: 4 })}${value.currency ? ' ' + value.currency : '（接口原始单位）'}`) : '余额 · ' + (labels[value.status] || '暂不可用');
      button.title = `${settings.providers?.find(p => p.id === settings.activeProviderId)?.name || ''} · ${new Date(value.checkedAt).toLocaleTimeString()} 查询；点击刷新。余额与 Token 用量独立统计。`;
    } catch { if (identity === state.balanceProvider) button.textContent = '余额 · 查询失败，点击重试'; }
  }

  function populateCognitiveSelects() {
    const plannerSelect = $('setting-planner-provider');
    const fallbackSelect = $('setting-fallback-provider');
    const settings = state.info?.settings || {};

    plannerSelect.replaceChildren();
    plannerSelect.append(el('option', '', '跟随主服务商（推荐）'));
    fallbackSelect.replaceChildren();
    const noFallback = el('option', '', '不启用自动故障降级');
    noFallback.value = '';
    fallbackSelect.append(noFallback);

    for (const prov of state.providers) {
      const optPlanner = el('option', '', `${prov.name} (${prov.model})`);
      optPlanner.value = prov.id;
      if (settings.plannerProviderId === prov.id) optPlanner.selected = true;
      plannerSelect.append(optPlanner);

      const optFallback = el('option', '', `${prov.name} (${prov.model})`);
      optFallback.value = prov.id;
      if (settings.fallbackProviderId === prov.id) optFallback.selected = true;
      fallbackSelect.append(optFallback);
    }
  }

  async function testProviderConnection() {
    const provId = state.selectedProviderId || state.activeProviderId;
    const pill = $('test-result-pill');
    pill.hidden = false;
    pill.className = 'test-result-pill';
    pill.textContent = '正在测试端点连通性…';
    $('test-provider-btn').disabled = true;
    try {
      const res = await api.testProvider(provId);
      pill.className = 'test-result-pill pass';
      pill.textContent = `连通成功！延迟 ${res.latencyMs || 0}ms，响应正常`;
    } catch (err) {
      pill.className = 'test-result-pill fail';
      pill.textContent = '测试失败：' + err.message;
    } finally {
      $('test-provider-btn').disabled = false;
    }
  }

  function newProviderId() {
    const stamp = Date.now().toString(36)
    let id = `custom-${stamp}`
    let n = 0
    while (state.providers.some(p => p.id === id)) id = `custom-${stamp}-${++n}`
    return id
  }

  async function addProvider() {
    if (!api) { toast('请通过桌面应用添加服务商。', true); return }
    const btn = $('add-provider-btn')
    btn.disabled = true
    try {
      const id = newProviderId()
      await api.saveProvider({ id, name: '新服务商', type: 'custom', baseUrl: 'https://api.openai.com/v1' })
      await refreshProviders()
      state.info = await api.info()
      state.selectedProviderId = id
      renderProviderList()
      populateCognitiveSelects()
      fieldError('settings-error', '')
      $('setting-model').value = ''
      $('setting-provider-name').focus()
      $('setting-provider-name').select()
      toast('已添加服务商，填好信息后点“保存并应用”生效。')
    } catch (err) {
      fieldError('settings-error', err.message)
    } finally {
      btn.disabled = false
    }
  }

  async function removeSelectedProvider() {
    if (!api) return
    const prov = state.providers.find(p => p.id === state.selectedProviderId)
    if (!prov) return
    try {
      await api.removeProvider(prov.id)
      state.info = await api.info()
      state.activeProviderId = state.info.settings.activeProviderId
      await refreshProviders()
      state.selectedProviderId = state.activeProviderId
      renderProviderList()
      populateCognitiveSelects()
      toast('已删除服务商：' + prov.name)
    } catch (err) {
      fieldError('settings-error', err.message)
    }
  }

  function updateApprovalHelp() {
    $('approval-help').textContent = {
      always: '每次写入文件或执行命令都询问你。',
      session: '同类操作在本次任务里只问一次，其余自动放行。',
      never: '全部自动执行。仅在你完全信任当前任务时使用。',
    }[$('setting-approval').value] || '';
  }

  async function toggleModelQuickMenu(event) {
    event?.stopPropagation();
    const menu = $('model-quick-menu');
    if (!menu) return;
    const isHidden = menu.hidden;
    if ($('perm-quick-menu')) $('perm-quick-menu').hidden = true;
    if (!isHidden) {
      menu.hidden = true;
      $('composer-settings')?.setAttribute('aria-expanded', 'false');
      return;
    }
    try {
      if (api.listProviders) state.providers = await api.listProviders();
    } catch {}
    renderModelQuickList();
    menu.hidden = false;
    $('composer-settings')?.setAttribute('aria-expanded', 'true');
  }

  function renderModelQuickList() {
    const listNode = $('model-quick-list');
    if (!listNode) return;
    listNode.replaceChildren();
    const providers = state.providers || [];
    if ($('model-quick-provider-count')) $('model-quick-provider-count').textContent = `${providers.length} 个服务商`;

    if (!providers.length) {
      listNode.append(el('div', 'empty-note', '尚未配置服务商，点击下方添加。'));
      return;
    }

    for (const prov of providers.flatMap(p => [...new Set([p.model, ...(p.models || [])].filter(Boolean))].map(model => ({ ...p, model })))) {
      const isProvActive = (prov.id === state.activeProviderId || prov.active) && prov.model === state.info?.settings?.model;
      const item = el('button', 'popover-item' + (isProvActive ? ' active' : ''));
      item.type = 'button';
      const info = el('div', 'popover-item-info');
      const titleRow = el('div', 'popover-item-title-row');
      titleRow.append(el('span', 'popover-item-name', prov.name));
      if (isProvActive) titleRow.append(el('span', 'badge badge-pass', '使用中'));
      info.append(titleRow, el('span', 'popover-item-model', prov.model || prov.baseUrl));
      item.append(info);

      item.addEventListener('click', async (e) => {
        e.stopPropagation();
        try {
          await api.setActiveProvider({ id: prov.id, model: prov.model });
          state.activeProviderId = prov.id;
          state.info = await api.info();
          renderChrome();
          $('model-quick-menu').hidden = true;
          $('composer-settings')?.setAttribute('aria-expanded', 'false');
          toast(`已平滑切换至模型：${prov.model || prov.name}`);
        } catch (err) {
          toast('切换失败：' + err.message, true);
        }
      });
      listNode.append(item);
    }
  }

  function togglePermQuickMenu(event) {
    event?.stopPropagation();
    const menu = $('perm-quick-menu');
    if (!menu) return;
    const isHidden = menu.hidden;
    if ($('model-quick-menu')) $('model-quick-menu').hidden = true;
    if (!isHidden) {
      menu.hidden = true;
      $('perm-pill')?.setAttribute('aria-expanded', 'false');
      return;
    }
    const currentPerm = state.info?.settings?.approval || 'always';
    for (const opt of menu.querySelectorAll('.popover-option')) {
      opt.classList.toggle('active', opt.dataset.perm === currentPerm);
    }
    menu.hidden = false;
    $('perm-pill')?.setAttribute('aria-expanded', 'true');
  }

  async function selectPermMode(mode) {
    try {
      await api.saveSettings({ approval: mode });
      state.info = await api.info();
      renderChrome();
      const menu = $('perm-quick-menu');
      if (menu) menu.hidden = true;
      $('perm-pill')?.setAttribute('aria-expanded', 'false');
      const label = APPROVAL_MODES[mode] || mode;
      toast(`安全控制已切换为：${label}`);
    } catch (err) {
      toast('更新权限模式失败：' + err.message, true);
    }
  }

  async function saveSettings(event) {
    event.preventDefault();
    if (!api) { fieldError('settings-error', '请通过桌面应用保存配置。'); return; }
    $('save-settings').disabled = true;
    try {
      const selectedId = state.selectedProviderId || state.activeProviderId;
      const apiKey = $('setting-api-key').value.trim();

      // 1. Save currently edited provider
      await api.saveProvider({
        id: selectedId,
        name: $('setting-provider-name').value.trim() || undefined,
        baseUrl: $('setting-base-url').value.trim(),
        model: $('setting-model').value.trim(),
        apiKey: apiKey || undefined,
        models: state.providers.find(p => p.id === selectedId)?.models,
      });

      // 2. Set this provider as active
      await api.setActiveProvider(selectedId);

      // 3. Save Cognitive Roles
      const plannerProviderId = $('setting-planner-provider').value;
      const fallbackProviderId = $('setting-fallback-provider').value;
      await api.saveCognitiveRoles({ plannerProviderId, fallbackProviderId });

      // 4. Save policy and runtime
      await api.saveSettings({
        baseUrl: $('setting-base-url').value.trim(),
        model: $('setting-model').value.trim(),
        maxSteps: Number($('setting-max-steps').value),
        approval: $('setting-approval').value,
        streaming: $('setting-streaming')?.checked !== false,
        reasoningEffort: $('setting-reasoning-effort').value,
        agentsEnabled: $('setting-agents-enabled').checked,
        showReasoning: $('setting-show-reasoning').checked,
        appearance: document.documentElement.dataset.theme || 'light',
        ...(apiKey ? { apiKey } : {}),
      });

      state.info = await api.info();
      state.activeProviderId = selectedId;
      $('setting-api-key').value = '';
      renderChrome();
      $('settings-dialog').close();
      toast('设置已保存');
    } catch (error) {
      fieldError('settings-error', error.message);
    } finally {
      $('save-settings').disabled = false;
    }
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
    const id = raw.runId || (state.selected && state.activeRuns.has(state.selected) ? state.selected : null) || state.active || state.selected;
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
    if (raw.type === 'run:reasoning') {
      // Working trace from a reasoning model, kept per step so a re-render does not lose it.
      // Shown by default: watching the model think is how a user tells a stuck run from a working one.
      if (state.info?.settings?.showReasoning === false) return;
      const step = raw.step || 1;
      const key = `${id}:${step}`;
      state.reasoningByStep.set(key, ((state.reasoningByStep.get(key) || '') + (raw.text || '')).slice(-16000));
      if (id === state.selected) renderThinking();
      return;
    }
    if (raw.type === 'tool:output') {
      const target = list.find(item => item.toolCallId && item.toolCallId === raw.toolCallId && item.type === 'tool:result');
      if (target) { target.output = (target.output || '') + (raw.text || ''); target.streaming = true; }
      state.events.set(id, list);
      if (id === state.selected) renderTranscript();
      return;
    }

    if (raw.type === 'run:message' && raw.role === 'user') {
      const pending = list.findIndex(e => e.optimistic && e.role === 'user');
      if (pending >= 0) list.splice(pending, 1);
    }
    list.push({ ...raw, runId: id });
    state.events.set(id, list);
    const steps = raw.steps;
    if (typeof steps === 'number' && id === state.selected) state.steps = steps;
    if (typeof raw.maxSteps === 'number' && raw.maxSteps > 0 && id === state.selected) state.stepCap = raw.maxSteps;

    let run = state.runs.find(item => item.id === id);
    if (!run) {
      run = { id, input: raw.input || '', title: raw.input || '新任务', status: 'running', createdAt: raw.time || new Date().toISOString() };
      state.runs.unshift(run);
    }
    if (raw.type === 'run:start') {
      state.activeRuns.add(id);
      syncActiveState();
      if (id === state.selected) {
        state.steps = 0;
        state.stepCap = 0;
      }
      run.status = 'running';
      if (raw.input && !run.input) { run.input = raw.input; run.title = raw.input; }
    }
    if (raw.workspace) run.workspace = raw.workspace;
    if (raw.type === 'run:message' && raw.role === 'user') {
      if (!run.input) { run.input = plainText(raw.content); run.title = run.input; }
    }
    if (raw.type === 'run:message' && raw.role === 'assistant') { state.streaming.delete(id); sealThinking(id); }
    // The model moved on to acting, so its thinking trace is sealed rather than discarded.
    if (raw.type === 'tool:request' || TERMINAL.has(raw.type)) sealThinking(id);
    if (raw.type === 'approval:request' && !state.approvals.some(item => item.approvalId === raw.approvalId)) {
      state.approvals.push({ ...raw, runId: id });
      showNextApproval();
    }
    if (TERMINAL.has(raw.type)) {
      state.activeRuns.delete(id);
      syncActiveState();
      state.submitting = false;
      run.status = raw.status || (raw.type === 'run:error' ? 'failed' : raw.type.startsWith('run:cancel') ? 'cancelled' : 'completed');
      state.approvals = state.approvals.filter(item => item.runId !== id);
      showNextApproval();
    }
    if (raw.type === 'run:settled') {
      void refreshBalance(true);
      state.activeRuns.delete(id);
      syncActiveState();
      state.submitting = false;
      state.approvals = state.approvals.filter(item => item.runId !== id);
      showNextApproval();
    }
    renderHistory();
    renderBusy();
    if (id === state.selected) { renderTranscript(); renderReview(); renderUsage(); }
  }
  function thinkingBlock(text, sealed = true) {
    const node = el('details', 'thinking');
    node.open = false;
    if (sealed) node.dataset.sealed = '1';
    else node.dataset.live = '1';
    node.append(
      el('summary', 'thinking-label', sealed ? '模型思考（提供商返回）' : '模型正在思考…'),
      el('div', 'thinking-text', text),
    );
    return node;
  }
  /** Cheap in-place update of the live reasoning block; falls back to a full render on the first chunk. */
  function renderThinking() {
    const step = eventsFor().filter(e => e.type === 'run:step').at(-1)?.steps || 1;
    const text = state.reasoningByStep.get(`${state.selected}:${step}`) || '';
    if (!text) return;
    const node = $('transcript').querySelector('.thinking[data-live]');
    if (!node) { renderTranscript(); return; }
    node.querySelector('.thinking-text').textContent = text;
    node.querySelector('.thinking-label').textContent = '模型正在思考…';
    const scroll = $('conversation-scroll');
    if (scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 140) scroll.scrollTop = scroll.scrollHeight;
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
  // The harness pane header: the active pane's glyph and name on the left, its count beside
  // them, and the pane switches as round icon tools on the right.
  const PANE_META = { changes: ['变更', 'diff', 'change-count'], plan: ['计划', 'list', 'plan-count'], trace: ['终端', 'terminal', 'trace-count'] };
  function setTab(name) {
    for (const tab of ['changes', 'plan', 'trace']) {
      const active = name === tab;
      $('tab-' + tab).classList.toggle('active', active);
      $('tab-' + tab).setAttribute('aria-selected', String(active));
      $('panel-' + tab).hidden = !active;
    }
    const meta = PANE_META[name];
    if (meta) {
      $('review-head-label').textContent = meta[0];
      $('review-head-icon').firstElementChild.firstElementChild.setAttribute('href', '#i-' + meta[1]);
      for (const id of ['change-count', 'plan-count', 'trace-count']) $(id).hidden = id !== meta[2];
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
    // The change panel is part of the workspace, not an opt-in extra: it opens unless the user closed it.
    if (localStorage.getItem('tengyun-review') === 'off') { document.body.classList.add('review-hidden'); $('toggle-inspector').setAttribute('aria-expanded', 'false'); }

    $('task-form').addEventListener('submit', submitTask);
    $('revert-run').addEventListener('click', revertRunChanges);
    $('task-input').addEventListener('input', autoGrow);
    $('task-input').addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.isComposing) {
        event.preventDefault();
        submitTask();
      }
    });
    $('task-input').addEventListener('paste', async event => {
      const items = event.clipboardData?.items;
      if (!items) return;
      const files = [];
      for (const item of items) {
        if (item.kind === 'file') {
          const file = item.getAsFile();
          if (file) files.push(file);
        }
      }
      if (files.length) {
        if (files.some(f => f.type.startsWith('image/'))) {
          event.preventDefault();
        }
        await handleDomFiles(files);
      }
    });

    const form = $('task-form');
    form.addEventListener('dragenter', e => { e.preventDefault(); form.classList.add('drag-over'); });
    form.addEventListener('dragover', e => { e.preventDefault(); form.classList.add('drag-over'); });
    form.addEventListener('dragleave', e => {
      if (!form.contains(e.relatedTarget)) form.classList.remove('drag-over');
    });
    form.addEventListener('drop', async e => {
      e.preventDefault();
      form.classList.remove('drag-over');
      if (e.dataTransfer?.files?.length) {
        await handleDomFiles(e.dataTransfer.files);
      }
    });

    $('attach-button')?.addEventListener('click', triggerAttachFiles);
    $('file-picker-input')?.addEventListener('change', async () => {
      await handleDomFiles($('file-picker-input').files);
      $('file-picker-input').value = '';
    });
    $('delete-current-task')?.addEventListener('click', () => {
      if (state.selected) deleteTask(state.selected);
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
    $('crumb-project-btn')?.addEventListener('click', openProjectDialog);
    $('close-projects')?.addEventListener('click', () => $('project-dialog').close());
    $('close-projects-btn')?.addEventListener('click', () => $('project-dialog').close());
    $('add-project-btn')?.addEventListener('click', addNewProject);
    for (const tabBtn of document.querySelectorAll('.settings-tab')) {
      tabBtn.addEventListener('click', () => setSettingsTab(tabBtn.dataset.tab));
    }
    $('fetch-models').addEventListener('click', () => discoverModels(true));
    $('setting-api-key').addEventListener('change', () => discoverModels(true));
    $('balance-summary').addEventListener('click', () => refreshBalance(true));
    $('test-provider-btn')?.addEventListener('click', testProviderConnection);
    $('add-provider-btn')?.addEventListener('click', addProvider);
    $('delete-provider-btn')?.addEventListener('click', removeSelectedProvider);
    bindSkillControls();
    $('composer-skills').addEventListener('click', () => openSettings('tab-skills'));
    $('open-settings').addEventListener('click', () => openSettings());
    $('composer-settings')?.addEventListener('click', toggleModelQuickMenu);
    $('composer-model-chip')?.addEventListener('click', toggleModelQuickMenu);
    $('perm-pill')?.addEventListener('click', togglePermQuickMenu);
    $('quick-open-settings')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const menu = $('model-quick-menu');
      if (menu) menu.hidden = true;
      openSettings('tab-providers');
    });
    for (const opt of document.querySelectorAll('.popover-option[data-perm]')) {
      opt.addEventListener('click', () => selectPermMode(opt.dataset.perm));
    }
    document.addEventListener('click', event => {
      if (!event.target.closest('#model-dropdown-wrap')) {
        const m = $('model-quick-menu');
        if (m) m.hidden = true;
        $('composer-settings')?.setAttribute('aria-expanded', 'false');
      }
      if (!event.target.closest('#perm-dropdown-wrap')) {
        const p = $('perm-quick-menu');
        if (p) p.hidden = true;
        $('perm-pill')?.setAttribute('aria-expanded', 'false');
      }
    });
    $('close-settings').addEventListener('click', () => $('settings-dialog').close());
    $('close-settings-2').addEventListener('click', () => $('settings-dialog').close());
    $('settings-dialog').addEventListener('close', () => { $('setting-api-key').value = ''; });
    $('settings-form').addEventListener('submit', saveSettings);
    $('setting-approval').addEventListener('change', updateApprovalHelp);
    $('allow-approval').addEventListener('click', () => decideApproval(true));
    $('deny-approval').addEventListener('click', () => decideApproval(false));
    $('approval-dialog').addEventListener('cancel', event => { event.preventDefault(); decideApproval(false); });
    $('cancel-run').addEventListener('click', async () => {
      if (state.activeRuns.size === 0 || !api) return;
      $('cancel-run').disabled = true;
      $('footer-status').textContent = '正在停止…';
      const targetId = (state.selected && state.activeRuns.has(state.selected)) ? state.selected : undefined;
      try { await api.cancel(targetId); } catch (error) { toast('停止失败：' + error.message, true); renderBusy(); }
    });
    for (const button of document.querySelectorAll('.starter')) {
      button.addEventListener('click', () => {
        $('task-input').value = button.dataset.prompt;
        autoGrow();
        $('task-input').focus();
      });
    }
    for (const tab of ['changes', 'plan', 'trace']) $('tab-' + tab).addEventListener('click', () => setTab(tab));
    // The pane guides are launchers: each capsule opens another pane, as the harness guide does.
    for (const entry of document.querySelectorAll('.entry[data-pane]')) {
      entry.addEventListener('click', () => setTab(entry.dataset.pane));
    }
    document.addEventListener('keydown', event => {
      const typing = ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName);
      if (event.key === 'Escape' && state.activeRuns.size > 0) { event.preventDefault(); $('cancel-run').click(); return; }
      if (event.key.toLowerCase() === 'n' && !event.ctrlKey && !event.metaKey && !event.altKey && !typing && !document.querySelector('dialog[open]')) {
        event.preventDefault();
        newTask();
      }
      if (event.key.toLowerCase() === 'b' && !event.ctrlKey && !event.metaKey && !typing && !document.querySelector('dialog[open]')) {
        event.preventDefault();
        toggleSidebar();
      }
      if (event.altKey && ['1', '2', '3'].includes(event.key) && !document.querySelector('dialog[open]')) {
        event.preventDefault();
        const starters = document.querySelectorAll('.starter');
        const idx = parseInt(event.key, 10) - 1;
        if (starters[idx]) starters[idx].click();
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
      if (api.listProjects) {
        try {
          const projs = await api.listProjects();
          state.projects = projs.projects || [];
        } catch {}
      }
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
