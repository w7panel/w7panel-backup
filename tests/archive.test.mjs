import test from 'node:test'
import assert from 'node:assert/strict'
import { gzipSync } from 'node:zlib'
import { randomBytes } from 'node:crypto'
import { archiveAppGroups, archiveInventory, archiveObjects } from '../charts/w7panel-backup/controller/archive.mjs'

function entry(name, value) {
  const data = Buffer.from(JSON.stringify(value))
  const header = Buffer.alloc(512)
  header.write(name)
  header.write(data.length.toString(8).padStart(11, '0'), 124)
  return Buffer.concat([header, data, Buffer.alloc((512 - data.length % 512) % 512)])
}

test('archive index returns only tagged objects for the selected app and deduplicates paths', async () => {
  const app = { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { namespace: 'default', name: 'web', labels: { 'backup.w7panel.io/app-appid': 'true', 'backup.w7panel.io/object-id': 'objectid' } } }
  const other = { ...app, metadata: { ...app.metadata, name: 'other', labels: { 'backup.w7panel.io/app-other': 'true', 'backup.w7panel.io/object-id': 'otherid' } } }
  const tar = Buffer.concat([entry('resources/apps/deployments/default/web.json', app), entry('resources/apps/deployments/default/web-copy.json', app), entry('resources/apps/deployments/default/other.json', other), Buffer.alloc(1024)])
  const url = `data:application/gzip;base64,${gzipSync(tar).toString('base64')}`
  assert.deepEqual(await archiveObjects(url, ['appid']), [{ apiVersion: 'apps/v1', kind: 'Deployment', namespace: 'default', name: 'web', id: 'objectid', appId: 'appid' }])
})

test('archive index reports shared resources for each selected app without duplicate archive paths', async () => {
  const shared = { apiVersion: 'v1', kind: 'Service', metadata: { namespace: 'default', name: 'web', labels: { 'backup.w7panel.io/app-a': 'true', 'backup.w7panel.io/app-b': 'true', 'backup.w7panel.io/object-id': 'shared' } } }
  const tar = Buffer.concat([entry('resources/services/default/web.json', shared), entry('resources/services/default/web-copy.json', shared), Buffer.alloc(1024)])
  const url = `data:application/gzip;base64,${gzipSync(tar).toString('base64')}`
  assert.deepEqual((await archiveObjects(url, ['a', 'b'])).map(item => item.appId), ['a', 'b'])
})

test('archive inventory lists objects without exposing Secret data and retains AppGroup status for hydration', async () => {
  const labels = { 'backup.w7panel.io/app-appid': 'true', 'backup.w7panel.io/object-id': 'groupid' }
  const group = { apiVersion: 'w7panel.w7.com/v1alpha1', kind: 'AppGroup', metadata: { namespace: 'default', name: 'shop', labels }, status: { deployInfo: [{ resourcesList: [] }] } }
  const secret = { apiVersion: 'v1', kind: 'Secret', type: 'helm.sh/release.v1', metadata: { namespace: 'default', name: 'helm', labels: { ...labels, 'backup.w7panel.io/object-id': 'secretid' } }, data: { release: 'sensitive' } }
  const tar = Buffer.concat([entry('resources/groups/shop.json', group), entry('resources/groups/shop-copy.json', group), entry('resources/secrets/helm.json', secret), Buffer.alloc(1024)])
  const url = `data:application/gzip;base64,${gzipSync(tar).toString('base64')}`
  assert.deepEqual((await archiveInventory(url)).map(item => item.kind), ['AppGroup', 'Secret'])
  assert.equal((await archiveAppGroups(url, ['groupid']))[0].status.deployInfo.length, 1)
  assert.equal((await archiveObjects(url, ['appid'])).find(item => item.kind === 'Secret').helmRelease, true)
})

test('streamed backup archive retains a Helm Secret when its JSON spans chunks', async () => {
  const secret = { apiVersion: 'v1', kind: 'Secret', type: 'helm.sh/release.v1', metadata: { namespace: 'default', name: 'sh.helm.release.v1.shop.v1', labels: { 'backup.w7panel.io/app-appid': 'true', 'backup.w7panel.io/object-id': 'secretid' } }, data: { release: randomBytes(32768).toString('base64') } }
  const archive = gzipSync(Buffer.concat([entry('resources/secrets/namespaces/default/sh.helm.release.v1.shop.v1.json', secret), Buffer.alloc(1024)]))
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(new ReadableStream({ start(controller) { for (let offset = 0; offset < archive.length; offset += 97) controller.enqueue(archive.subarray(offset, offset + 97)); controller.close() } }))
  try {
    assert.deepEqual(await archiveObjects('http://example.invalid/backup', ['appid']), [{ apiVersion: 'v1', kind: 'Secret', namespace: 'default', name: secret.metadata.name, id: 'secretid', appId: 'appid', helmRelease: true }])
  } finally { globalThis.fetch = originalFetch }
})
