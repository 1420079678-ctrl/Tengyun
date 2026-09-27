const { contextBridge, ipcRenderer } = require('electron')
const invoke = (name, value) => ipcRenderer.invoke('tengyun:' + name, value)
contextBridge.exposeInMainWorld('tengyun', {
  listSkills: () => invoke('skills:list'),
  getSkill: id => invoke('skills:get', id),
  readSkillResource: value => invoke('skills:resource', value),
  saveSkill: value => invoke('skills:save', value),
  enableSkill: value => invoke('skills:enable', value),
  removeSkill: value => invoke('skills:remove', value),
  importSkill: () => invoke('skills:import'),
  info: () => invoke('info'),
  setTheme: value => invoke('setTheme', value),
  chooseWallpaper: () => invoke('chooseWallpaper'),
  clearWallpaper: () => invoke('clearWallpaper'),
  chooseWorkspace: () => invoke('chooseWorkspace'),
  saveSettings: value => invoke('saveSettings', value),
  listRuns: () => invoke('listRuns'),
  getRun: id => invoke('getRun', id),
  deleteRun: id => invoke('deleteRun', id),
  runChanges: id => invoke('runChanges', id),
  revertRun: value => invoke('revertRun', value),
  chooseFiles: options => invoke('chooseFiles', options),
  run: value => invoke('run', value),
  cancel: id => invoke('cancel', id),
  approve: value => invoke('approve', value),
  // Multi-Project management APIs
  listProjects: () => invoke('projects:list'),
  addProject: value => invoke('projects:add', value),
  switchProject: id => invoke('projects:switch', id),
  removeProject: id => invoke('projects:remove', id),
  currentProject: () => invoke('projects:current'),
  // Multi-Provider & Cognitive APIs
  fetchModels: value => invoke('providers:models', value),
  providerBalance: value => invoke('providers:balance', value),
  listProviders: () => invoke('providers:list'),
  saveProvider: value => invoke('providers:save', value),
  setActiveProvider: value => invoke('providers:setActive', value),
  removeProvider: id => invoke('providers:remove', id),
  testProvider: id => invoke('providers:test', id),
  saveCognitiveRoles: value => invoke('providers:setCognitiveRoles', value),
  onEvent: listener => {
    const handle = (_event, value) => listener(value)
    ipcRenderer.on('tengyun:event', handle)
    return () => ipcRenderer.removeListener('tengyun:event', handle)
  },
})
