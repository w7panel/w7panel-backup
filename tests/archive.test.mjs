import test from 'node:test'
import assert from 'node:assert/strict'
import { gzipSync } from 'node:zlib'
import { archiveObjects } from '../charts/w7panel-backup/controller/archive.mjs'

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
  assert.deepEqual(await archiveObjects(url, 'appid'), [{ apiVersion: 'apps/v1', kind: 'Deployment', namespace: 'default', name: 'web', id: 'objectid', appId: 'appid' }])
})
