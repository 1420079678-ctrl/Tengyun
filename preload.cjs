const { contextBridge, ipcRenderer } = require('electron')
const invoke = (name, value) => ipcRenderer.invoke('tengyun:' + name, value)
contextBridge.exposeInMainWorld('tengyun', {
  info: () => invoke('info'),
  setTheme: value => invoke('setTheme', value),
  chooseWallpaper: () => invoke('chooseWallpaper'),
  clearWallpaper: () => invoke('clearWallpaper'),
  chooseWorkspace: () => invoke('chooseWorkspace'),
  saveSettings: value => invoke('saveSettings', value),
  listRuns: () => invoke('listRuns'),
  getRun: id => invoke('getRun', id),
  run: value => invoke('run', value),
  cancel: id => invoke('cancel', id),
  approve: value => invoke('approve', value),
  onEvent: listener => {
    const handle = (_event, value) => listener(value)
    ipcRenderer.on('tengyun:event', handle)
    return () => ipcRenderer.removeListener('tengyun:event', handle)
  },
})
