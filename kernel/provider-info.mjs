export function providerUrl(value) {
  const url = new URL(value)
  if (!(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) || url.username || url.password || url.search || url.hash) throw new Error('接口地址需要 HTTPS；本地接口可以使用 localhost HTTP')
  return url.href.replace(/\/+$/, '')
}
async function getJson(url, apiKey, fetchImpl) {
  const response = await fetchImpl(url, { headers: { Accept: 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) }, redirect: 'error', signal: AbortSignal.timeout(12000) })
  if (!response.ok) { const error = new Error(`HTTP ${response.status}`); error.status = response.status; throw error }
  const text = await response.text()
  if (text.length > 2000000) throw new Error('接口响应过大')
  return JSON.parse(text)
}
export async function fetchModels(baseUrl, apiKey, fetchImpl = fetch) {
  const body = await getJson(providerUrl(baseUrl) + '/models', apiKey, fetchImpl)
  if (!Array.isArray(body.data)) throw new Error('接口未返回标准模型列表，可手动填写模型名称')
  const models = [...new Set(body.data.filter(item => !Array.isArray(item.supported_endpoints) || item.supported_endpoints.some(p => /chat\/completions/.test(p))).map(item => item.id).filter(id => typeof id === 'string' && id.trim() && id.length <= 256))].sort()
  if (!models.length) throw new Error('没有获取到可用于 Chat Completions 的模型')
  return { models: models.slice(0, 2000), fetchedAt: Date.now() }
}
const numeric = value => (typeof value === 'number' || (typeof value === 'string' && value.trim())) && Number.isFinite(Number(value)) ? Number(value) : null
export function parseBalance(body, scheme) {
  if (body?.success === false || body?.status === false) return null
  if (scheme === 'deepseek') {
    const entry = body?.balance_infos?.find(e => e.currency === 'CNY') || body?.balance_infos?.[0]
    const amount = numeric(entry?.total_balance)
    return amount === null ? null : { kind: 'balance', amount, currency: entry.currency || null }
  }
  if (scheme === 'siliconflow') {
    const amount = numeric(body?.data?.totalBalance)
    return amount === null ? null : { kind: 'balance', amount, currency: body.data.currency || null }
  }
  const data = body?.data
  if (!data || (!Object.hasOwn(data, 'total_available') && data.object !== 'token_usage')) return null
  if (data.unlimited_quota === true) return { kind: 'quota', unlimited: true }
  const amount = numeric(data.total_available)
  return amount === null ? null : { kind: 'quota', amount, currency: typeof data.currency === 'string' ? data.currency : null }
}
export async function fetchBalance(baseUrl, apiKey, fetchImpl = fetch) {
  const base = providerUrl(baseUrl), url = new URL(base)
  const host = url.hostname
  const scheme = host === 'api.deepseek.com' ? 'deepseek' : ['api.siliconflow.cn', 'api.siliconflow.com'].includes(host) ? 'siliconflow' : 'newapi'
  if (!apiKey && !['localhost', '127.0.0.1', '[::1]'].includes(host)) return { status: 'not-configured', checkedAt: Date.now() }
  const target = scheme === 'deepseek' ? new URL('/user/balance', base).href : scheme === 'siliconflow' ? base + '/user/info' : new URL('/api/usage/token', base).href
  try {
    const data = parseBalance(await getJson(target, apiKey, fetchImpl), scheme)
    return { ...(data ? { status: 'ok', ...data } : { status: 'unsupported' }), checkedAt: Date.now() }
  } catch (error) {
    return { status: [401, 403].includes(error.status) ? 'unauthorized' : error.status === 429 ? 'rate-limited' : [404, 405].includes(error.status) ? 'unsupported' : 'unavailable', checkedAt: Date.now() }
  }
}

/** Parent events include completed child metrics once, never both child usage and its summary. */
export function summarizeUsage(events) {
  let input = 0, output = 0, total = 0, reports = 0
  let partial = false
  const seen = new Set()
  for (const event of events) {
    if (event.id && seen.has(event.id)) continue
    if (event.id) seen.add(event.id)
    if (event.type === 'run:usage') {
      const i = numeric(event.promptTokens), o = numeric(event.completionTokens), t = numeric(event.totalTokens)
      if (i === null && o === null && t === null) { partial = true; continue }
      reports++; input += i ?? 0; output += o ?? 0; total += t ?? ((i ?? 0) + (o ?? 0)); partial ||= i === null || o === null
    }
    if (event.type === 'agent:complete' && event.metrics) {
      const m = event.metrics
      if (m.usageReported) { reports++; input += m.promptTokens || 0; output += m.completionTokens || 0; total += (m.promptTokens || 0) + (m.completionTokens || 0) }
      else if (m.modelRequests) partial = true
    }
  }
  return { input, output, total, reports, partial }
}
