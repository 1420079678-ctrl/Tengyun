import test from 'node:test'
import assert from 'node:assert/strict'
import { fetchModels, fetchBalance, parseBalance, providerUrl, summarizeUsage } from './provider-info.mjs'
const reply = body => ({ ok: true, text: async () => JSON.stringify(body) })
test('model discovery retains nested base path and filters incompatible endpoints', async () => {
  const result = await fetchModels('https://example.test/provider/v1/', 'test-key', async (url, options) => {
    assert.equal(url, 'https://example.test/provider/v1/models')
    assert.equal(options.redirect, 'error')
    assert.equal(options.headers.Authorization, 'Bearer test-key')
    return reply({ data: [{ id: 'b' }, { id: 'a' }, { id: 'a' }, { id: 'responses-only', supported_endpoints: ['/responses'] }, { id: 'chat', supported_endpoints: ['/chat/completions'] }] })
  })
  assert.deepEqual(result.models, ['a', 'b', 'chat'])
  await assert.rejects(fetchModels('https://example.test/v1', '', async () => reply({ data: [] })), /没有获取/)
  assert.throws(() => providerUrl('https://user:secret@example.test/v1'))
})
test('balances preserve zero, currency, quota units and failures without estimating money', async () => {
  assert.deepEqual(parseBalance({ balance_infos: [{ currency: 'CNY', total_balance: '0.00' }] }, 'deepseek'), { kind: 'balance', amount: 0, currency: 'CNY' })
  assert.deepEqual(parseBalance({ data: { total_available: 300 } }, 'newapi'), { kind: 'quota', amount: 300, currency: null })
  assert.equal(parseBalance({ data: { total_available: null } }, 'newapi'), null)
  assert.equal((await fetchBalance('https://api.deepseek.com/v1', 'key', async url => { assert.equal(url, 'https://api.deepseek.com/user/balance'); return reply({ balance_infos: [{ currency: 'USD', total_balance: '2.5' }] }) })).amount, 2.5)
  assert.equal((await fetchBalance('https://example.test/v1', 'key', async () => ({ ok: false, status: 401 }))).status, 'unauthorized')
  assert.equal((await fetchBalance('https://example.test/v1', 'key', async () => ({ ok: false, status: 404 }))).status, 'unsupported')
})
test('token summaries include children once and distinguish missing usage from zero', () => {
  const usage = { id: 'u1', type: 'run:usage', promptTokens: 10, completionTokens: 5 }
  assert.deepEqual(summarizeUsage([usage, usage, { type: 'agent:complete', metrics: { usageReported: true, promptTokens: 2, completionTokens: 1 } }]), { input: 12, output: 6, total: 18, reports: 2, partial: false })
  assert.equal(summarizeUsage([{ type: 'run:usage', promptTokens: null, completionTokens: null }]).partial, true)
  assert.equal(summarizeUsage([{ type: 'run:usage', promptTokens: 0, completionTokens: 0 }]).reports, 1)
})
