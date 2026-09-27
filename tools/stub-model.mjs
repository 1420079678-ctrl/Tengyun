/**
 * Local OpenAI-compatible model stub. Speaks SSE so the kernel's streaming path is exercised for real.
 * Scripted turn sequence: plan -> write file -> run command -> read file -> final answer.
 * Usage: node tools/stub-model.mjs [port]
 */
import { createServer } from 'node:http'

const port = Number(process.argv[2] || 13500)
const mode = process.argv.includes('--mode') ? process.argv[process.argv.indexOf('--mode') + 1] : 'default'
const transcript = []

function frame(delta, finish = null) {
  return JSON.stringify({ id: 'stub', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] })
}
function toolFrame(index, id, name, args) {
  return frame({ tool_calls: [{ index, id, type: 'function', function: { name, arguments: args } }] })
}

const SCRIPTS = {
  // Rollback fixture: one file modified, one file created, so both undo paths get exercised.
  revert: [
    {
      reason: '先读 NOTES.md 看现有内容。',
      calls: [{ name: 'file_read', args: JSON.stringify({ path: 'NOTES.md', maxLines: 40 }) }],
    },
    {
      say: '改写现有文件。',
      calls: [{ name: 'file_write', args: JSON.stringify({ path: 'NOTES.md', content: '# 改写后的文档\n\n这次的内容和原来完全不同。\n' }) }],
    },
    {
      say: '再新建一个文件。',
      calls: [{ name: 'file_write', args: JSON.stringify({ path: 'CREATED.md', content: '# 新建的文件\n\n这个文件是本次任务创建的。\n' }) }],
    },
    { say: '完成：已改写 NOTES.md 并创建 CREATED.md。' },
  ],
}

const SCRIPT = SCRIPTS[mode] ?? [
  {
    // Turn 0 goes straight to a read: no plan gate may stand in the way of a direct action.
    reason: '用户要我读文件并改写。先看看现在有什么内容，不需要提前建计划。',
    calls: [{ name: 'file_read', args: JSON.stringify({ path: 'NOTES.md', maxLines: 40 }) }],
  },
  {
    say: '已读到现有内容，现在写入改动。',
    calls: [{ name: 'file_write', args: JSON.stringify({ path: 'NOTES.md', content: '# Tengyun 演示\n\n第一行：原始内容。\n第二行：将被替换。\n第三行：保持不变。\n' }) }],
  },
  {
    say: '现在跑一条真实命令验证写入结果。',
    calls: [{ name: 'run_command', args: JSON.stringify({ command: 'Get-Content NOTES.md | Select-Object -First 2', timeoutMs: 20000 }) }],
  },
  { say: '完成。已写入 NOTES.md，并用 PowerShell 读取确认了前两行内容。' },
]

let turn = 0
const evidence = []

const server = createServer((request, response) => {
  let body = ''
  request.on('data', chunk => { body += chunk })
  request.on('end', () => {
    if (!request.url.includes('/chat/completions')) { response.writeHead(404).end('{}'); return }
    const payload = JSON.parse(body || '{}')
    transcript.push({ turn, stream: payload.stream, messages: payload.messages?.length })
    const step = SCRIPT[Math.min(turn, SCRIPT.length - 1)]
    const isLast = turn >= SCRIPT.length - 1
    turn++

    // The engine mints real evidence ids; read them back out of the tool replies it sent us
    // so the plan cites genuine evidence instead of ids it made up.
    for (const message of payload.messages ?? []) {
      if (message?.role !== 'tool' || typeof message.content !== 'string') continue
      try {
        const id = JSON.parse(message.content)?.evidenceId
        if (typeof id === 'string' && !evidence.includes(id)) evidence.push(id)
      } catch (error) { /* truncated or non-JSON tool reply */ }
    }
    const args = step.calls ? step.calls.map(call => {
      let index = 0
      const patched = call.args.replace(/__E\d__/g, () => evidence[index++] ?? 'missing')
      return { ...call, args: patched }
    }) : []

    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })
    const write = text => response.write(`data: ${text}\n\n`)

    if (step.say) {
      const chunks = step.say.match(/.{1,7}/gs) || []
      for (const piece of chunks) write(frame({ content: piece }))
    }
    // Reasoning models stream their thinking first; the UI must show it and then drop it.
    if (step.reason) {
      for (const piece of (step.reason.match(/.{1,9}/gs) || [])) write(frame({ reasoning_content: piece }))
    }
    args.forEach((call, index) => write(toolFrame(index, `call_${turn}_${index}`, call.name, call.args)))
    if (!step.say && !args.length) write(frame({ content: '完成。' }))

    // Report what the harness put in front of the model, once per run.
    if (turn === 1) {
      const messages = payload.messages ?? []
      const system = messages.find(message => message.role === 'system')?.content ?? ''
      const planned = messages.some(message => message.role === 'assistant'
        && (message.tool_calls ?? []).some(call => call.function?.name === 'plan_update'))
      const toolNames = (payload.tools ?? []).map(item => item.function?.name)
      console.log(`[stub] system prompt ${system.length} chars`)
      console.log(`[stub] AGENTS.md injected: ${system.includes('所有文档使用简体中文')}`)
      console.log(`[stub] memory injected: ${system.includes('NOTES.md 是演示用的临时文档')}`)
      console.log(`[stub] tools offered: ${toolNames.length} (${toolNames.join(',')})`)
      console.log(`[stub] a plan_update call happened before this turn: ${planned}`)
    }
    write(frame({}, isLast ? 'stop' : 'tool_calls'))
    write(JSON.stringify({ id: 'stub', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 1200 + turn * 40, completion_tokens: 180, total_tokens: 1380 + turn * 40 } }))
    response.write('data: [DONE]\n\n')
    response.end()
  })
})
server.listen(port, '127.0.0.1', () => console.log(`stub model on http://127.0.0.1:${port}/v1`))
