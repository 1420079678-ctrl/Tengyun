/** Package Tengyun's own code with a standard Electron runtime. No Harness modules are shipped. */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const source = dirname(fileURLToPath(import.meta.url))
const localRequire = createRequire(join(source, 'package.json'))
const output = resolve(process.argv[2] ?? join(source, 'dist', 'Tengyun'))
if (existsSync(output)) throw new Error(`Destination already exists: ${output}. Select a new release directory.`)
function dependency(name) {
  try { return localRequire(name) } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error
    // Initial bootstrap uses the existing machine's package cache; exported source uses npm install.
    const store = join(source, '../app/node_modules/.pnpm')
    const match = existsSync(store) && readdirSync(store).find(entry => entry.startsWith(name.replace('/', '+') + '@'))
    if (!match) throw new Error(`Run npm install in the Tengyun source directory: missing ${name}`)
    return createRequire(join(store, match, 'node_modules', name, 'package.json'))(name)
  }
}
const asar = dependency('@electron/asar')
const sharp = dependency('sharp')
const resedit = dependency('resedit')
const electronExe = process.env.TENGYUN_ELECTRON_DIST
  ? join(resolve(process.env.TENGYUN_ELECTRON_DIST), 'electron.exe')
  : dependency('electron')
const electronDist = dirname(electronExe)
if (!existsSync(electronExe)) throw new Error('Electron runtime is missing')
const stage = join(source, '.build', `package-${Date.now()}`)
mkdirSync(stage, { recursive: true })
const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))
const runtimeManifest = { name: manifest.name, version: manifest.version, description: manifest.description,
  main: manifest.main, type: manifest.type, license: manifest.license, private: true }
writeFileSync(join(stage, 'package.json'), JSON.stringify(runtimeManifest, null, 2) + '\n')
for (const file of ['main.mjs', 'preload.cjs', 'product.json']) cpSync(join(source, file), join(stage, file))
for (const directory of ['kernel', 'ui']) cpSync(join(source, directory), join(stage, directory), {
  recursive: true, filter: file => !file.endsWith('.test.mjs'),
})
mkdirSync(output, { recursive: true })
console.log('Copying standard Electron runtime...')
for (const entry of readdirSync(electronDist, { withFileTypes: true })) {
  if (['resources', 'electron.exe'].includes(entry.name)) continue
  cpSync(join(electronDist, entry.name), join(output, entry.name), { recursive: true })
}
const resources = join(output, 'resources')
mkdirSync(resources)
const svg = readFileSync(join(source, 'resources/icon.svg'))
const png = await sharp(svg).resize(256, 256).png().toBuffer()
writeFileSync(join(resources, 'icon.png'), png)
const sizes = [16, 32, 48, 64, 128, 256]
const parts = await Promise.all(sizes.map(size => sharp(svg).resize(size, size).png().toBuffer()))
const header = Buffer.alloc(6 + parts.length * 16)
header.writeUInt16LE(1, 2); header.writeUInt16LE(parts.length, 4)
let offset = header.length
for (const [index, part] of parts.entries()) {
  const at = 6 + index * 16
  header[at] = sizes[index] % 256; header[at + 1] = sizes[index] % 256
  header.writeUInt16LE(1, at + 4); header.writeUInt16LE(32, at + 6)
  header.writeUInt32LE(part.length, at + 8); header.writeUInt32LE(offset, at + 12)
  offset += part.length
}
const ico = Buffer.concat([header, ...parts])
writeFileSync(join(resources, 'icon.ico'), ico)
const executable = resedit.NtExecutable.from(readFileSync(electronExe), { ignoreCert: true })
const exeResources = resedit.NtExecutableResource.from(executable)
for (const version of resedit.Resource.VersionInfo.fromEntries(exeResources.entries)) {
  for (const language of version.getAllLanguagesForStringValues()) version.setStringValues(language, {
    ProductName: 'Tengyun', FileDescription: 'Tengyun AI Agent', CompanyName: 'Tengyun', InternalName: 'Tengyun',
    OriginalFilename: 'Tengyun.exe', ProductVersion: manifest.version, FileVersion: manifest.version + '.0',
    LegalCopyright: 'Tengyun contributors. Electron and Chromium licenses included.',
  })
  version.setFileVersion(0, 1, 0, 0); version.setProductVersion(0, 1, 0, 0)
  version.outputToResourceEntries(exeResources.entries)
}
const icons = resedit.Data.IconFile.from(ico).icons.map(entry => entry.data)
for (const group of resedit.Resource.IconGroupEntry.fromEntries(exeResources.entries)) {
  resedit.Resource.IconGroupEntry.replaceIconsForResource(exeResources.entries, group.id, group.lang, icons)
}
exeResources.outputResource(executable)
writeFileSync(join(output, 'Tengyun.exe'), Buffer.from(executable.generate()))
await asar.createPackage(stage, join(resources, 'app.asar'))
cpSync(join(source, 'README.md'), join(output, 'Tengyun-README.md'))
cpSync(join(source, 'LICENSE'), join(output, 'LICENSE.Tengyun.txt'))
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex')
const receipt = { name: 'Tengyun', version: manifest.version, builtAt: new Date().toISOString(),
  architecture: 'independent-kernel', upstreamAgentRuntimeIncluded: false,
  executableSha256: hash(join(output, 'Tengyun.exe')), asarSha256: hash(join(resources, 'app.asar')),
  electronVersion: readFileSync(join(electronDist, 'version'), 'utf8').trim(), updates: 'manual' }
writeFileSync(join(output, 'build-receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
console.log(`Built ${join(output, 'Tengyun.exe')}`)
