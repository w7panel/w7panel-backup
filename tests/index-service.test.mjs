import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { gzipSync } from 'node:zlib'

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
const close = server => new Promise(resolve => server.close(resolve))

test('index discovers AppGroup items, Helm resources, release history, and workload references', async () => {
  const release = { name: 'shop', namespace: 'default', version: 1, info: { status: 'deployed' }, manifest: [
    'apiVersion: apps/v1', 'kind: Deployment', 'metadata:', '  name: web', '---',
    'apiVersion: rbac.authorization.k8s.io/v1', 'kind: ClusterRole', 'metadata:', '  name: shop-reader', '---',
    'apiVersion: microapp.w7.cc/v1alpha1', 'kind: MicroApp', 'metadata:', '  name: shop', '---',
    'apiVersion: w7panel.w7.com/v1alpha1', 'kind: PrivateDNS', 'metadata:', '  name: api-w7-cc',
  ].join('\n') }
  const secret = { apiVersion: 'v1', kind: 'Secret', type: 'helm.sh/release.v1', metadata: { namespace: 'default', name: 'sh.helm.release.v1.shop.v1', labels: { owner: 'helm', name: 'shop' } }, data: { release: Buffer.from(gzipSync(JSON.stringify(release)).toString('base64')).toString('base64') } }
  const app = { apiVersion: 'w7panel.w7.com/v1alpha1', kind: 'AppGroup', metadata: { namespace: 'default', name: 'shop' }, spec: { isHelm: true }, status: { items: [{ apiVersion: 'networking.k8s.io/v1', kind: 'Ingress', name: 'web' }], deployInfo: [] } }
  const discovery = {
    '/apis/w7panel.w7.com/v1alpha1': [['AppGroup', 'appgroups', true], ['MicroApp', 'microapps', true], ['PrivateDNS', 'privatedns', false]],
    '/apis/microapp.w7.cc/v1alpha1': [['MicroApp', 'microapps', true]],
    '/apis/apps/v1': [['Deployment', 'deployments', true]],
    '/apis/networking.k8s.io/v1': [['Ingress', 'ingresses', true]],
    '/apis/rbac.authorization.k8s.io/v1': [['ClusterRole', 'clusterroles', false]],
    '/api/v1': [['Secret', 'secrets', true], ['ConfigMap', 'configmaps', true]],
  }
  let missingIngress = false
  const kube = http.createServer((req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname
    if (path.endsWith('/privatedns/api-w7-cc') || (path.startsWith('/apis/microapp.w7.cc/') && path.endsWith('/microapps/shop')) || (missingIngress && path.endsWith('/ingresses/web'))) { res.writeHead(404).end(); return }
    const body = discovery[path] ? { resources: discovery[path].map(([kind, name, namespaced]) => ({ kind, name, namespaced, verbs: ['patch'] })) }
      : path.endsWith('/schedules') || path.endsWith('/restores') || path.endsWith('/appgroups') ? { items: [] }
      : path.endsWith('/secrets') ? { items: [secret] }
      : path.endsWith('/appgroups/shop') ? app
      : path.endsWith('/deployments/web') ? { metadata: { namespace: 'default' }, spec: { template: { spec: { volumes: [{ configMap: { name: 'settings' } }] } } } }
      : path.endsWith('/secrets/' + secret.metadata.name) ? secret
      : { metadata: { namespace: 'default' } }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(body))
  })
  const kubePort = await listen(kube)
  const indexPort = await new Promise(resolve => { const server = http.createServer(); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)) }) })
  const child = spawn(process.execPath, ['charts/w7panel-backup/controller/server.mjs'], { cwd: process.cwd(), env: { ...process.env, LOCAL_TEST: '1', POD_NAMESPACE: 'default', KUBE_PROXY_PORT: String(kubePort), INDEX_PORT: String(indexPort) }, stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += chunk })
  try {
    let response
    for (let attempt = 0; attempt < 40; attempt++) {
      try { response = await fetch(`http://127.0.0.1:${indexPort}/v1/apps/default/shop/objects`); break } catch { await new Promise(resolve => setTimeout(resolve, 50)) }
    }
    assert.ok(response?.ok, stderr)
    const items = (await response.json()).items
    const names = items.map(item => `${item.kind}/${item.namespace}/${item.name}`)
    assert.deepEqual(names, [
      'AppGroup/default/shop', 'Ingress/default/web', 'Secret/default/sh.helm.release.v1.shop.v1',
      'Deployment/default/web', 'ClusterRole//shop-reader', 'MicroApp/default/shop', 'ConfigMap/default/settings',
    ])
    assert.equal(items.find(item => item.kind === 'MicroApp').apiVersion, 'w7panel.w7.com/v1alpha1')
    missingIngress = true
    const missing = await fetch(`http://127.0.0.1:${indexPort}/v1/apps/default/shop/objects`)
    assert.equal(missing.status, 502)
    assert.match((await missing.json()).message, /Resource missing: Ingress default\/web/)
  } finally {
    child.kill()
    await close(kube)
  }
})
