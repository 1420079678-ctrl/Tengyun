/**
 * Shared e2e settings builder. Tengyun configures models through a provider registry, so the
 * test harness must seed a provider instead of a bare baseUrl — keep all e2e scripts on this.
 */
export function buildE2eSettings({ stubPort, workspace, appearance = 'light', approval = 'always', maxSteps = 0 }) {
  return {
    providers: [{
      id: 'stub',
      name: 'Stub（本地测试模型）',
      type: 'openai-compatible',
      baseUrl: `http://127.0.0.1:${stubPort}/v1`,
      model: 'stub-model',
      models: ['stub-model'],
      description: 'local test double',
    }],
    activeProviderId: 'stub',
    maxSteps,
    approval,
    streaming: true,
    appearance,
    workspace,
  }
}
