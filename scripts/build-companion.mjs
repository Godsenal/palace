import { build } from 'vite'
import react from '@vitejs/plugin-react'
import { builtinModules } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
await build({
  configFile: false,
  root,
  build: {
    target: 'node22',
    outDir: resolve(root, 'out/companion-server'),
    emptyOutDir: true,
    minify: false,
    lib: { entry: resolve(root, 'src/main/companion-service.ts'), formats: ['cjs'], fileName: () => 'companion-service.cjs' },
    rollupOptions: { external: [...builtinModules, ...builtinModules.map((name) => `node:${name}`), ...Object.keys(pkg.dependencies)] }
  }
})
await build({
  configFile: false,
  root: resolve(root, 'src/companion'),
  plugins: [react()],
  build: { outDir: resolve(root, 'out/companion'), emptyOutDir: true }
})
